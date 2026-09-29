import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openTestDbSession, withTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';
import { __setDbForTests } from '../src/db/client.js';
import { user, session } from '../src/db/schema/auth.js';
import { mailboxAccess, mailboxTransport } from '../src/db/schema/mail.js';
import { outlookBridgeTicket, outlookMoveReceipt, outlookNavigation } from '../src/db/schema/outlook-authorization.js';
import { outlookDevice } from '../src/db/schema/outlook-device.js';
import { issueEnrollment, enrollDevice, issueChallenge, revokeDevice } from '../src/outlook-security/device.js';
import { createOutlookNativeHandler } from '../src/http/outlook-native.js';
import { workstationRouter } from '../src/trpc/routes/workstation.js';
import { issueBridgeTicket, provisionApprovedFolder } from '../src/outlook-security/authorization.js';

const key = randomBytes(32).toString('base64');
const secret = randomBytes(32).toString('base64');
const storeId = 'exact-store-id';
const path = '/api/outlook/native/authorize';
const op = (at = Date.now()) => `op_${at}_${randomUUID().replaceAll('-', '')}`;

async function fixture(db: Parameters<typeof issueEnrollment>[0]) {
  const userId = randomUUID(), transportId = randomUUID(), deviceId = randomUUID(), sessionId = randomUUID();
  await db.insert(user).values({ id: userId, name: 'Verified Staff', email: `${userId}@example.test`, emailVerified: true });
  await db.insert(mailboxTransport).values({ id: transportId, email: `${transportId}@example.test`, ownerHeaderValue: transportId });
  await db.insert(mailboxAccess).values({ id: randomUUID(), userId, transportId, role: 'member' });
  await db.insert(session).values({ id: sessionId, token: randomUUID(), userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const code = await issueEnrollment(db, { userId, transportId, storeId });
  await enrollDevice(db, { code, deviceId, storeId, version: '4', secret }, key);
  const handler = createOutlookNativeHandler(db, key);
  async function signed(route: string, payload: unknown, signingSecret = secret, signingDeviceId = deviceId) {
    const body = JSON.stringify(payload);
    const nonce = await issueChallenge(db, signingDeviceId, key);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', Buffer.from(signingSecret, 'base64'))
      .update(['nava-outlook-v4', 'POST', route, createHash('sha256').update(body).digest('hex'), signingDeviceId, timestamp, nonce].join('\n')).digest('hex');
    return handler(new Request(`https://localhost.test${route}`, { method: 'POST', body, headers: {
      'x-nava-device-id': signingDeviceId, 'x-nava-timestamp': timestamp, 'x-nava-nonce': nonce, 'x-nava-signature': signature,
    } }));
  }
  const paneChallenge = randomBytes(32).toString('base64url');
  await signed('/api/outlook/native/register-navigation', { paneChallenge });
  const auth = { api: { getSession: async () => ({ user: { id: userId, email: `${userId}@example.test` }, session: { id: sessionId } }) } };
  async function ticket(action = 'GET_ACTIVE_EMAIL', operationId?: string, declared?: { resources?: string[]; sourceFolderId?: string; destinationFolderId?: string }, otherDeviceId = deviceId, otherChallenge = paneChallenge) {
    return issueBridgeTicket(db, auth, new Headers(), { deviceId: otherDeviceId, paneChallenge: otherChallenge, action, storeId, operationId, transportId, ...declared });
  }
  return { db, userId, transportId, deviceId, sessionId, paneChallenge, auth, handler, signed, ticket };
}

describe.skipIf(!TEST_DB_AVAILABLE)('signed Outlook bridge authorization', () => {
  it('public bootstrap exposes only fresh navigation challenge and protocol, not Outlook data', async () => withTestDb(async (db) => {
    const handler = createOutlookNativeHandler(db, key);
    const response = await handler(new Request('https://localhost.test/api/outlook/native/bootstrap', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ protocol: 'nava-outlook-v4', status: 'ready',
      paneChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresInSeconds: 60 });
  }));
  it('requires a live actual session and approved device/mailbox, never an injected user', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    __setDbForTests({ db, conn: null as never });
    try {
      const injected = workstationRouter.createCaller({ auth: { api: { getSession: async () => null } } as never,
        reqHeaders: new Headers({ 'x-zero-active-transport': f.transportId }),
        sessionUser: { id: f.userId, email: `${f.userId}@example.test`, name: 'Staff' } } as never);
      await expect(injected.bridgeTicket({ deviceId: f.deviceId, paneChallenge: f.paneChallenge,
        action: 'GET_ACTIVE_EMAIL', storeId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(injected.bridgeTicket({ deviceId: f.deviceId, paneChallenge: f.paneChallenge,
        action: 'GET_ACTIVE_EMAIL' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally { __setDbForTests(null); }
    await expect(issueBridgeTicket(db, { api: { getSession: async () => null } }, new Headers(),
      { deviceId: f.deviceId, paneChallenge: f.paneChallenge, action: 'GET_ACTIVE_EMAIL', storeId, transportId: f.transportId })).rejects.toThrow();
    await expect(issueBridgeTicket(db, f.auth, new Headers(),
      { deviceId: f.deviceId, paneChallenge: f.paneChallenge, action: 'GET_ACTIVE_EMAIL', storeId, transportId: randomUUID() })).rejects.toThrow();
    const { ticket } = await f.ticket();
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const response = await f.signed(path, { ticket, storeId, transportId: f.transportId, action: 'GET_ACTIVE_EMAIL' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'read', storeId, transportId: f.transportId });
    expect((await f.signed(path, { ticket, storeId, transportId: f.transportId, action: 'GET_ACTIVE_EMAIL' })).status).toBe(403);
  }));

  it('resolves the exact enrolled store without trusting the first pane request', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    __setDbForTests({ db, conn: null as never });
    try {
      const caller = workstationRouter.createCaller({ auth: f.auth as never,
        reqHeaders: new Headers({ 'x-zero-active-transport': f.transportId }) } as never);
      const issued = await caller.bridgeTicket({ deviceId: f.deviceId, paneChallenge: f.paneChallenge,
        action: 'GET_ACTIVE_EMAIL' });
      expect(issued).toEqual({ ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), storeId, expiresInSeconds: 60 });
      expect((await f.signed(path, { ticket: issued.ticket, action: 'GET_ACTIVE_EMAIL', storeId,
        transportId: f.transportId })).status).toBe(200);
      await expect(caller.bridgeTicket({ deviceId: f.deviceId, paneChallenge: f.paneChallenge,
        action: 'GET_ACTIVE_EMAIL' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller.bridgeTicket({ deviceId: f.deviceId, paneChallenge: f.paneChallenge,
        action: 'GET_ACTIVE_EMAIL', storeId })).resolves.toHaveProperty('storeId', storeId);
      const renewedChallenge = randomBytes(32).toString('base64url');
      expect((await f.signed('/api/outlook/native/register-navigation',
        { paneChallenge: renewedChallenge })).status).toBe(200);
      await expect(caller.bridgeTicket({ deviceId: f.deviceId, paneChallenge: renewedChallenge,
        action: 'GET_ACTIVE_EMAIL' })).resolves.toHaveProperty('storeId', storeId);
      await expect(caller.bridgeTicket({ deviceId: f.deviceId, paneChallenge: f.paneChallenge,
        action: 'GET_ACTIVE_EMAIL', storeId: 'injected-store' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally { __setDbForTests(null); }
  }));

  it('denies untrusted, unapproved, expired-session, and revoked no-store ticket issuance', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    const input = { deviceId: f.deviceId, paneChallenge: f.paneChallenge,
      action: 'GET_ACTIVE_EMAIL', transportId: f.transportId };
    await expect(issueBridgeTicket(db, { api: { getSession: async () => null } }, new Headers(), input)).rejects.toThrow();
    await expect(issueBridgeTicket(db, f.auth, new Headers(), { ...input, transportId: randomUUID() })).rejects.toThrow();
    await db.update(session).set({ createdAt: new Date(Date.now() - 86_400_001) }).where(eq(session.id, f.sessionId));
    await expect(issueBridgeTicket(db, f.auth, new Headers(), input)).rejects.toThrow();
    await db.update(session).set({ createdAt: new Date() }).where(eq(session.id, f.sessionId));
    await db.update(outlookDevice).set({ revokedAt: new Date() }).where(eq(outlookDevice.deviceId, f.deviceId));
    await expect(issueBridgeTicket(db, f.auth, new Headers(), input)).rejects.toThrow();
  }));

  it('denies revoked/old sessions, stale navigation, wrong store and invalid signatures', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    expect((await f.signed(path, { ticket: (await f.ticket()).ticket, storeId, transportId: f.transportId, action: 'GET_ACTIVE_EMAIL' }, randomBytes(32).toString('base64'))).status).toBe(403);
    expect((await f.signed(path, { ticket: (await f.ticket()).ticket, storeId: 'other', transportId: f.transportId, action: 'GET_ACTIVE_EMAIL' })).status).toBe(403);
    await db.update(session).set({ createdAt: new Date(Date.now() - 86_400_001) }).where(eq(session.id, f.sessionId));
    await expect(f.ticket()).rejects.toThrow();
    await db.update(session).set({ createdAt: new Date() }).where(eq(session.id, f.sessionId));
    await f.signed('/api/outlook/native/register-navigation', { paneChallenge: randomBytes(32).toString('base64url') });
    await expect(f.ticket()).rejects.toThrow();
    await revokeDevice(db, f.deviceId);
    expect((await f.signed(path, { ticket: (await issueChallenge(db, f.deviceId, key)), storeId, transportId: f.transportId, action: 'GET_ACTIVE_EMAIL' })).status).toBe(403);
  }));

  it('denies unsupported native send/delete and non-approved or forbidden move destinations', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await expect(f.ticket('SEND_DRAFT', op())).rejects.toThrow();
    await expect(f.ticket('DELETE_EMAIL', op())).rejects.toThrow();
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'triage-folder', kind: 'triage' });
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'inbox-folder', kind: 'inbox' });
    const operationId = op();
    const declared = { resources: ['message-1'], sourceFolderId: 'inbox-folder', destinationFolderId: 'triage-folder' };
    const { ticket } = await f.ticket('MOVE_EMAIL', operationId, declared);
    expect((await f.signed(path, { ticket, action: 'MOVE_EMAIL', storeId, transportId: f.transportId, operationId,
      resources: ['message-1'], sourceFolderId: 'inbox-folder', destinationFolderId: 'deleted-folder', destinationKind: 'deleted' })).status).toBe(403);
    const allowed = await f.signed(path, { ticket, action: 'MOVE_EMAIL', storeId, transportId: f.transportId, operationId,
      resources: ['message-1'], sourceFolderId: 'inbox-folder', destinationFolderId: 'triage-folder', destinationKind: 'triage' });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ kind: 'mutation', operationId, destinationFolderId: 'triage-folder' });
    const draftOperation = op();
    const draft = await f.ticket('CREATE_DRAFT', draftOperation);
    expect((await f.signed(path, { ticket: draft.ticket, action: 'CREATE_DRAFT', storeId,
      transportId: f.transportId, operationId: draftOperation })).status).toBe(200);
    const mismatchOperation = op();
    const mismatch = await f.ticket('MOVE_EMAIL', mismatchOperation, declared);
    expect((await f.signed(path, { ticket: mismatch.ticket, action: 'MOVE_EMAIL', storeId, transportId: f.transportId,
      operationId: mismatchOperation, resources: ['different'], sourceFolderId: 'inbox-folder',
      destinationFolderId: 'triage-folder', destinationKind: 'triage' })).status).toBe(403);
  }));

  it('checks live session revocation and ticket expiry at native authorization time', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    const revoked = await f.ticket();
    await db.delete(session).where(eq(session.id, f.sessionId));
    expect((await f.signed(path, { ticket: revoked.ticket, action: 'GET_ACTIVE_EMAIL', storeId,
      transportId: f.transportId })).status).toBe(403);
    await db.insert(session).values({ id: f.sessionId, token: randomUUID(), userId: f.userId,
      expiresAt: new Date(Date.now() + 86_400_000) });
    const expired = await f.ticket();
    await db.update(outlookBridgeTicket).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(outlookBridgeTicket.ticketHash, createHash('sha256').update(expired.ticket).digest('hex')));
    expect((await f.signed(path, { ticket: expired.ticket, action: 'GET_ACTIVE_EMAIL', storeId,
      transportId: f.transportId })).status).toBe(403);
  }));
  it('expires navigation in one minute and supports signed renewal without reopening pane', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    const stale = await f.ticket();
    await db.update(outlookNavigation).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(outlookNavigation.deviceId, f.deviceId));
    await expect(f.ticket()).rejects.toThrow();
    expect((await f.signed('/api/outlook/native/register-navigation', { paneChallenge: f.paneChallenge })).status).toBe(403);
    expect((await f.signed(path, { ticket: stale.ticket, action: 'GET_ACTIVE_EMAIL', storeId,
      transportId: f.transportId })).status).toBe(403);
    const fresh = randomBytes(32).toString('base64url');
    expect((await f.signed('/api/outlook/native/register-navigation', { paneChallenge: fresh })).status).toBe(200);
    await expect(f.ticket()).rejects.toThrow();
    const renewed = await issueBridgeTicket(db, f.auth, new Headers(), { deviceId: f.deviceId,
      paneChallenge: fresh, action: 'GET_ACTIVE_EMAIL', storeId, transportId: f.transportId });
    expect((await f.signed(path, { ticket: renewed.ticket, action: 'GET_ACTIVE_EMAIL', storeId,
      transportId: f.transportId })).status).toBe(200);
  }));
  it('rejects a previously registered navigation challenge after another navigation replaces it', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    const old = f.paneChallenge;
    const next = randomBytes(32).toString('base64url');
    expect((await f.signed('/api/outlook/native/register-navigation', { paneChallenge: next })).status).toBe(200);
    expect((await f.signed('/api/outlook/native/register-navigation', { paneChallenge: old })).status).toBe(403);
    await expect(f.ticket()).rejects.toThrow();
    expect(await issueBridgeTicket(db, f.auth, new Headers(), { deviceId: f.deviceId, paneChallenge: next,
      action: 'GET_ACTIVE_EMAIL', storeId, transportId: f.transportId })).toHaveProperty('ticket');
  }));
  it('invalidates a registered navigation on logout even when staff signs in again immediately', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await f.ticket();
    await db.delete(session).where(eq(session.id, f.sessionId));
    const newSessionId = randomUUID();
    await db.insert(session).values({ id: newSessionId, token: randomUUID(), userId: f.userId,
      expiresAt: new Date(Date.now() + 86_400_000) });
    const newAuth = { api: { getSession: async () => ({ user: { id: f.userId }, session: { id: newSessionId } }) } };
    const input = { deviceId: f.deviceId, paneChallenge: f.paneChallenge, action: 'GET_ACTIVE_EMAIL',
      storeId, transportId: f.transportId };
    await expect(issueBridgeTicket(db, newAuth, new Headers(), input)).rejects.toThrow();
    const fresh = randomBytes(32).toString('base64url');
    expect((await f.signed('/api/outlook/native/register-navigation', { paneChallenge: fresh })).status).toBe(200);
    await expect(issueBridgeTicket(db, newAuth, new Headers(), { ...input, paneChallenge: fresh })).resolves.toHaveProperty('ticket');
  }));

  it('rejects unscoped message and folder reads and sessions from remote-admin auth profile', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await expect(f.ticket('GET_EMAIL_BY_ENTRY_ID')).rejects.toThrow();
    const { ticket } = await f.ticket('GET_EMAIL_BY_ENTRY_ID', undefined, { resources: ['mail-1'] });
    expect((await f.signed(path, { ticket, action: 'GET_EMAIL_BY_ENTRY_ID', storeId,
      transportId: f.transportId })).status).toBe(403);
    const folderTicket = await f.ticket('GET_FOLDER_EMAILS', undefined, { sourceFolderId: 'not-approved' });
    expect((await f.signed(path, { ticket: folderTicket.ticket, action: 'GET_FOLDER_EMAILS', storeId,
      transportId: f.transportId, sourceFolderId: 'not-approved' })).status).toBe(403);
    const original = process.env.NAVA_AUTH_SESSION_PROFILE;
    process.env.NAVA_AUTH_SESSION_PROFILE = 'remote';
    try { await expect(f.ticket()).rejects.toThrow(); }
    finally { if (original === undefined) delete process.env.NAVA_AUTH_SESSION_PROFILE;
      else process.env.NAVA_AUTH_SESSION_PROFILE = original; }
  }));
  it('requires exact browser-declared identities for targeted reads and mutations', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await expect(f.ticket('GET_EMAIL_BY_ENTRY_ID')).rejects.toThrow();
    await expect(f.ticket('READ_ATTACHMENT_BASE64')).rejects.toThrow();
    await expect(f.ticket('GET_ATTACHMENT_METADATA')).rejects.toThrow();
    await expect(f.ticket('GET_FOLDER_EMAILS')).rejects.toThrow();
    for (const action of ['UPDATE_DRAFT', 'CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT',
      'SET_EMAIL_CATEGORY', 'SET_FOLLOW_UP_FLAG', 'MARK_EMAIL_READ']) {
      await expect(f.ticket(action, op())).rejects.toThrow();
    }
    const itemRead = await f.ticket('GET_EMAIL_BY_ENTRY_ID', undefined, { resources: ['mail-1'] });
    expect((await f.signed(path, { ticket: itemRead.ticket, action: 'GET_EMAIL_BY_ENTRY_ID',
      storeId, transportId: f.transportId, resources: ['mail-2'] })).status).toBe(403);
    const mutationOp = op();
    const update = await f.ticket('UPDATE_DRAFT', mutationOp, { resources: ['draft-1'] });
    expect((await f.signed(path, { ticket: update.ticket, action: 'UPDATE_DRAFT', operationId: mutationOp,
      storeId, transportId: f.transportId, resources: ['draft-2'] })).status).toBe(403);
  }));
  it('allows creating a folder beneath an approved parent without an invented message resource', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'parent-id', kind: 'inbox' });
    await expect(f.ticket('CREATE_FOLDER', op())).rejects.toThrow();
    const operationId = op();
    const { ticket } = await f.ticket('CREATE_FOLDER', operationId, { sourceFolderId: 'parent-id' });
    const response = await f.signed(path, { ticket, action: 'CREATE_FOLDER', operationId, storeId,
      transportId: f.transportId, sourceFolderId: 'parent-id' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'mutation', sourceFolderId: 'parent-id' });
  }));
  it('allows exact approved Inbox recovery moves without permitting Deleted Items or Outbox', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'triage', kind: 'triage' });
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'inbox', kind: 'inbox' });
    const operationId = op();
    const declared = { resources: ['mail-1'], sourceFolderId: 'triage', destinationFolderId: 'inbox' };
    const { ticket } = await f.ticket('MOVE_EMAIL', operationId, declared);
    expect((await f.signed(path, { ticket, action: 'MOVE_EMAIL', operationId, storeId,
      transportId: f.transportId, ...declared, destinationKind: 'inbox' })).status).toBe(200);
    const forbiddenOperation = op();
    const forbidden = await f.ticket('MOVE_EMAIL', forbiddenOperation, { ...declared, destinationFolderId: 'deleted' });
    expect((await f.signed(path, { ticket: forbidden.ticket, action: 'MOVE_EMAIL',
      operationId: forbiddenOperation, storeId, transportId: f.transportId, resources: ['mail-1'],
      sourceFolderId: 'triage', destinationFolderId: 'deleted', destinationKind: 'deleted' })).status).toBe(403);
  }));
  it('never returns a native scope extending beyond the actual session absolute 24-hour cutoff', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    const cutoff = new Date(Date.now() + 5000);
    await db.update(session).set({ createdAt: new Date(cutoff.getTime() - 24 * 60 * 60_000),
      expiresAt: new Date(Date.now() + 60_000) }).where(eq(session.id, f.sessionId));
    const read = await f.ticket();
    const response = await f.signed(path, { ticket: read.ticket, action: 'GET_ACTIVE_EMAIL', storeId,
      transportId: f.transportId });
    expect(response.status).toBe(200);
    expect(new Date((await response.json()).expiresAt).getTime()).toBeLessThanOrEqual(cutoff.getTime());
    const mutationOp = op();
    const draft = await f.ticket('CREATE_DRAFT', mutationOp);
    const mutation = await f.signed(path, { ticket: draft.ticket, action: 'CREATE_DRAFT', operationId: mutationOp,
      storeId, transportId: f.transportId });
    expect(mutation.status).toBe(200);
    expect(new Date((await mutation.json()).expiresAt).getTime()).toBeLessThanOrEqual(cutoff.getTime());
    const sessionCutoff = new Date(Date.now() + 5000);
    await db.update(session).set({ createdAt: new Date(), expiresAt: sessionCutoff }).where(eq(session.id, f.sessionId));
    const finalRead = await f.ticket();
    const finalResponse = await f.signed(path, { ticket: finalRead.ticket, action: 'GET_ACTIVE_EMAIL',
      storeId, transportId: f.transportId });
    expect(finalResponse.status).toBe(200);
    expect(new Date((await finalResponse.json()).expiresAt).getTime()).toBeLessThanOrEqual(sessionCutoff.getTime());
  }));
  it('reports issuance infrastructure failures as server errors without exposing their detail to clients', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    __setDbForTests({ db, conn: null as never });
    try {
      const caller = workstationRouter.createCaller({ auth: { api: { getSession: async () => {
        throw new Error('private database connection detail');
      } } } as never, reqHeaders: new Headers({ 'x-zero-active-transport': f.transportId }) });
      await expect(caller.bridgeTicket({ deviceId: f.deviceId, paneChallenge: f.paneChallenge,
        action: 'GET_ACTIVE_EMAIL', storeId })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR',
        message: 'Bridge ticket unavailable', cause: undefined });
    } finally { __setDbForTests(null); }
  }));
  it('accepts existing pane operation IDs and rejects expired or future mutation IDs', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await expect(f.ticket('CREATE_DRAFT', op())).resolves.toHaveProperty('ticket');
    await expect(f.ticket('CREATE_DRAFT', op(Date.now() - 15 * 60_000 - 2000))).rejects.toThrow();
    await expect(f.ticket('CREATE_DRAFT', op(Date.now() + 6000))).rejects.toThrow();
  }));

  it('shares mailbox move budget across devices and accounts one exact idempotent retry', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'inbox', kind: 'inbox' });
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'triage', kind: 'triage' });
    const secondDevice = randomUUID(), secondSecret = randomBytes(32).toString('base64');
    const code = await issueEnrollment(db, { userId: f.userId, transportId: f.transportId, storeId });
    await enrollDevice(db, { code, deviceId: secondDevice, storeId, version: '4', secret: secondSecret }, key);
    const secondChallenge = randomBytes(32).toString('base64url');
    expect((await f.signed('/api/outlook/native/register-navigation', { paneChallenge: secondChallenge }, secondSecret, secondDevice)).status).toBe(200);
    const declared = { resources: Array.from({ length: 9 }, (_, index) => `message-${index}`), sourceFolderId: 'inbox', destinationFolderId: 'triage' };
    const authorizeMove = async (deviceId: string, challenge: string, signingSecret: string, operationId: string,
      resources: string[], consent = false) => {
      const scope = { ...declared, resources };
      const issued = await f.ticket('MOVE_EMAIL', operationId, scope, deviceId, challenge);
      const response = await f.signed(path, { ticket: issued.ticket, action: 'MOVE_EMAIL', storeId,
        transportId: f.transportId, operationId, ...scope, destinationKind: 'triage', nativeBatchConsent: consent }, signingSecret, deviceId);
      return { response, body: response.status === 200 ? await response.json() : null };
    };
    const firstOp = op();
    expect((await authorizeMove(f.deviceId, f.paneChallenge, secret, firstOp, declared.resources)).body?.retry).toBe(false);
    expect((await authorizeMove(f.deviceId, f.paneChallenge, secret, firstOp, declared.resources)).body?.retry).toBe(true);
    expect((await authorizeMove(secondDevice, secondChallenge, secondSecret, op(), declared.resources)).response.status).toBe(200);
    expect((await authorizeMove(f.deviceId, f.paneChallenge, secret, op(), declared.resources)).response.status).toBe(409);
    expect((await authorizeMove(f.deviceId, f.paneChallenge, secret, op(), declared.resources, true)).response.status).toBe(200);
    const rows = await db.select().from(outlookMoveReceipt).where(eq(outlookMoveReceipt.transportId, f.transportId));
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(27);
  }));
  it('returns 409 only for a fully valid signed 10-item move and retains the exact ticket for consent retry', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'inbox', kind: 'inbox' });
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'triage', kind: 'triage' });
    const operationId = op();
    const scope = { resources: Array.from({ length: 10 }, (_, index) => `mail-${index}`),
      sourceFolderId: 'inbox', destinationFolderId: 'triage' };
    const issued = await f.ticket('MOVE_EMAIL', operationId, scope);
    const payload = { ticket: issued.ticket, action: 'MOVE_EMAIL', operationId, storeId,
      transportId: f.transportId, ...scope, destinationKind: 'triage' };
    const unsigned = await f.signed(path, payload, randomBytes(32).toString('base64'));
    expect(unsigned.status).toBe(403);
    expect((await f.signed(path, { ...payload, resources: ['wrong-mail'], nativeBatchConsent: false })).status).toBe(403);
    expect((await f.signed(path, { ...payload, destinationFolderId: 'other' })).status).toBe(403);
    const denied = await f.signed(path, payload);
    expect(denied.status).toBe(409);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(await denied.json()).toEqual({ code: 'NATIVE_BATCH_CONSENT_REQUIRED' });
    expect(await db.select().from(outlookMoveReceipt).where(eq(outlookMoveReceipt.transportId, f.transportId))).toHaveLength(0);
    const [ticketRow] = await db.select().from(outlookBridgeTicket)
      .where(eq(outlookBridgeTicket.ticketHash, createHash('sha256').update(issued.ticket).digest('hex')));
    expect(ticketRow?.consumedAt).toBeNull();
    const permitted = await f.signed(path, { ...payload, nativeBatchConsent: true });
    expect(permitted.status).toBe(200);
    expect(await permitted.json()).toMatchObject({ kind: 'mutation', resources: scope.resources });
    expect((await f.signed(path, { ...payload, nativeBatchConsent: true })).status).toBe(403);
    expect(await db.select().from(outlookMoveReceipt).where(eq(outlookMoveReceipt.transportId, f.transportId))).toHaveLength(1);
  }));

  it.each(['ticket', 'original 24-hour session'])('never requests consent after a %s expires while waiting for the mailbox lock', async (expiry) => {
    const seeded = openTestDbSession(), locker = openTestDbSession(), observer = openTestDbSession();
    let releaseLock = () => undefined;
    let heldLock: Promise<void> | undefined;
    let pending: Promise<Response> | undefined;
    let cleanup: { userId: string; transportId: string } | undefined;
    try {
      const f = await fixture(seeded.db);
      cleanup = f;
      await provisionApprovedFolder(seeded.db, { storeId, transportId: f.transportId, folderId: 'inbox', kind: 'inbox' });
      await provisionApprovedFolder(seeded.db, { storeId, transportId: f.transportId, folderId: 'triage', kind: 'triage' });
      const operationId = op(), scope = { resources: Array.from({ length: 10 }, (_, index) => `mail-${index}`),
        sourceFolderId: 'inbox', destinationFolderId: 'triage' };
      const issued = await f.ticket('MOVE_EMAIL', operationId, scope);
      const cutoff = Date.now() + 2000;
      if (expiry === 'ticket') {
        await seeded.db.update(outlookBridgeTicket).set({ expiresAt: new Date(cutoff) })
          .where(eq(outlookBridgeTicket.ticketHash, createHash('sha256').update(issued.ticket).digest('hex')));
      } else {
        await seeded.db.update(session).set({ createdAt: new Date(cutoff - 86_400_000),
          expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(session.id, f.sessionId));
      }
      let locked!: (pid: number) => void;
      const acquired = new Promise<number>((resolve) => { locked = resolve; });
      const unlock = new Promise<void>((resolve) => { releaseLock = resolve; });
      heldLock = locker.db.transaction(async (tx) => {
        const [connection] = await tx.execute(sql<{ pid: number }>`select pg_backend_pid() as pid`);
        await tx.select({ id: mailboxTransport.id }).from(mailboxTransport)
          .where(eq(mailboxTransport.id, f.transportId)).for('update');
        locked(connection.pid);
        await unlock;
      });
      const holderPid = await acquired;
      const payload = { ticket: issued.ticket, action: 'MOVE_EMAIL', operationId, storeId,
        transportId: f.transportId, ...scope, destinationKind: 'triage' };
      pending = f.signed(path, payload);
      let blocked = false;
      for (let attempt = 0; attempt < 65; attempt++) {
        const [state] = await observer.db.execute(sql<{ blocked: boolean }>`select exists (
          select 1 from pg_stat_activity a where a.datname = current_database()
            and a.wait_event_type = 'Lock' and ${holderPid} = any(pg_blocking_pids(a.pid))
        ) as blocked`);
        if (state.blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, cutoff + 75 - Date.now())));
      releaseLock();
      await heldLock;
      const denied = await pending;
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe('');
      const [ticketRow] = await seeded.db.select({ consumedAt: outlookBridgeTicket.consumedAt }).from(outlookBridgeTicket)
        .where(eq(outlookBridgeTicket.ticketHash, createHash('sha256').update(issued.ticket).digest('hex')));
      expect(ticketRow?.consumedAt).toBeNull();
      expect(await seeded.db.select().from(outlookMoveReceipt)
        .where(eq(outlookMoveReceipt.transportId, f.transportId))).toHaveLength(0);
    } finally {
      releaseLock();
      if (heldLock) await heldLock;
      if (pending) await pending.catch(() => undefined);
      if (cleanup) {
        await seeded.db.delete(user).where(eq(user.id, cleanup.userId));
        await seeded.db.delete(mailboxTransport).where(eq(mailboxTransport.id, cleanup.transportId));
      }
      await Promise.all([seeded.close(), locker.close(), observer.close()]);
    }
  }, 12_000);

  it('never reveals a consent prompt for invalid or revoked tickets', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'inbox', kind: 'inbox' });
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'triage', kind: 'triage' });
    const operationId = op();
    const scope = { resources: Array.from({ length: 10 }, (_, index) => `mail-${index}`),
      sourceFolderId: 'inbox', destinationFolderId: 'triage' };
    const ticket = (await f.ticket('MOVE_EMAIL', operationId, scope)).ticket;
    const payload = { ticket, action: 'MOVE_EMAIL', operationId, storeId,
      transportId: f.transportId, ...scope, destinationKind: 'triage' };
    const assertGenericDenial = async (body: object) => {
      const denied = await f.signed(path, body);
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe('');
    };
    await assertGenericDenial({ ...payload, ticket: randomBytes(32).toString('base64url') });
    await db.update(outlookBridgeTicket).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(outlookBridgeTicket.ticketHash, createHash('sha256').update(ticket).digest('hex')));
    await assertGenericDenial(payload);
    const freshOperationId = op();
    const fresh = (await f.ticket('MOVE_EMAIL', freshOperationId, scope)).ticket;
    await db.update(outlookDevice).set({ revokedAt: new Date() }).where(eq(outlookDevice.deviceId, f.deviceId));
    await assertGenericDenial({ ...payload, ticket: fresh, operationId: freshOperationId });
  }));
  it('permits signed exact-consent 25-item Outlook EntryID batches larger than public enrollment limit', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'inbox', kind: 'inbox' });
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'triage', kind: 'triage' });
    const resources = Array.from({ length: 25 }, (_, index) => `${index}`.padEnd(256, 'A'));
    const operationId = op();
    const declared = { resources, sourceFolderId: 'inbox', destinationFolderId: 'triage' };
    const { ticket } = await f.ticket('MOVE_EMAIL', operationId, declared);
    const response = await f.signed(path, { ticket, action: 'MOVE_EMAIL', operationId, storeId,
      transportId: f.transportId, ...declared, destinationKind: 'triage', nativeBatchConsent: true });
    expect(response.status).toBe(200);
  }));
  it('rolls back a move receipt if the ticket expires during the authorization transaction', async () => withTestDb(async (db) => {
    const f = await fixture(db);
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'inbox', kind: 'inbox' });
    await provisionApprovedFolder(db, { storeId, transportId: f.transportId, folderId: 'triage', kind: 'triage' });
    const operationId = op(), resources = ['message-1'];
    const declared = { resources, sourceFolderId: 'inbox', destinationFolderId: 'triage' };
    const { ticket } = await f.ticket('MOVE_EMAIL', operationId, declared);
    await db.update(outlookBridgeTicket).set({ expiresAt: new Date(Date.now() + 500) })
      .where(eq(outlookBridgeTicket.ticketHash, createHash('sha256').update(ticket).digest('hex')));
    await db.execute(sql.raw(`CREATE FUNCTION outlook_task3_delay() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.9); RETURN NEW; END $$`));
    await db.execute(sql.raw('CREATE TRIGGER outlook_task3_delay BEFORE INSERT ON outlook_move_receipt FOR EACH ROW EXECUTE FUNCTION outlook_task3_delay()'));
    const response = await f.signed(path, { ticket, action: 'MOVE_EMAIL', operationId, storeId,
      transportId: f.transportId, ...declared, destinationKind: 'triage' });
    expect(response.status).toBe(403);
    expect(await db.select().from(outlookMoveReceipt).where(eq(outlookMoveReceipt.transportId, f.transportId))).toHaveLength(0);
  }));
});
