import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';
import { user, session } from '../src/db/schema/auth.js';
import { mailboxAccess, mailboxTransport } from '../src/db/schema/mail.js';
import { outlookBridgeTicket, outlookMoveReceipt, outlookNavigation } from '../src/db/schema/outlook-authorization.js';
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
    const injected = workstationRouter.createCaller({ auth: null as never,
      reqHeaders: new Headers({ 'x-zero-active-transport': f.transportId }),
      sessionUser: { id: f.userId, email: `${f.userId}@example.test`, name: 'Staff' } } as never);
    await expect(injected.bridgeTicket({ deviceId: f.deviceId, paneChallenge: f.paneChallenge,
      action: 'GET_ACTIVE_EMAIL', storeId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    const { ticket } = await f.ticket('GET_EMAIL_BY_ENTRY_ID');
    expect((await f.signed(path, { ticket, action: 'GET_EMAIL_BY_ENTRY_ID', storeId,
      transportId: f.transportId })).status).toBe(403);
    const folderTicket = await f.ticket('GET_FOLDER_EMAILS');
    expect((await f.signed(path, { ticket: folderTicket.ticket, action: 'GET_FOLDER_EMAILS', storeId,
      transportId: f.transportId, sourceFolderId: 'not-approved' })).status).toBe(403);
    const original = process.env.NAVA_AUTH_SESSION_PROFILE;
    process.env.NAVA_AUTH_SESSION_PROFILE = 'remote';
    try { await expect(f.ticket()).rejects.toThrow(); }
    finally { if (original === undefined) delete process.env.NAVA_AUTH_SESSION_PROFILE;
      else process.env.NAVA_AUTH_SESSION_PROFILE = original; }
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
    expect((await authorizeMove(f.deviceId, f.paneChallenge, secret, op(), declared.resources)).response.status).toBe(403);
    expect((await authorizeMove(f.deviceId, f.paneChallenge, secret, op(), declared.resources, true)).response.status).toBe(200);
    const rows = await db.select().from(outlookMoveReceipt).where(eq(outlookMoveReceipt.transportId, f.transportId));
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(27);
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
