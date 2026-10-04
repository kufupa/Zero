import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';
import { user, session } from '../src/db/schema/auth.js';
import { mailboxAccess, mailboxTransport } from '../src/db/schema/mail.js';
import * as devicePolicy from '../src/outlook-security/device.js';
import { authorizeNative, issueBridgeTicket, registerNavigation } from '../src/outlook-security/authorization.js';

if (process.env.OUTLOOK_SYNC_TEST_REQUIRED === '1' && !TEST_DB_AVAILABLE) throw new Error('Disposable DB required for Outlook sync authorization');
const key = randomBytes(32).toString('base64');
const storeId = 'approved-store';
async function fixture(db: Parameters<typeof devicePolicy.issueEnrollment>[0]) {
  const userId = randomUUID(), transportId = randomUUID(), deviceId = randomUUID(), sessionId = randomUUID();
  await db.insert(user).values({ id: userId, name: 'Synthetic Staff', email: `${userId}@example.test`, emailVerified: true });
  await db.insert(mailboxTransport).values({ id: transportId, email: `${transportId}@example.test`, ownerHeaderValue: transportId });
  await db.insert(mailboxAccess).values({ id: randomUUID(), userId, transportId, role: 'member' });
  await db.insert(session).values({ id: sessionId, token: randomUUID(), userId, expiresAt: new Date(Date.now() + 86400_000) });
  const code = await devicePolicy.issueEnrollment(db, { storeId, userId, transportId });
  await devicePolicy.enrollDevice(db, { code, deviceId, storeId, version: '4', secret: randomBytes(32).toString('base64') }, key);
  const paneChallenge = randomBytes(32).toString('base64url');
  await registerNavigation(db, deviceId, paneChallenge);
  const auth = { api: { getSession: async () => ({ user: { id: userId }, session: { id: sessionId } }) } };
  const approval = { deviceId, userId, transportId, storeId, rootEntryId: 'retained-root', policyVersion: 1 as const };
  async function read(sourceFolderId = 'new-descendant') {
    const input = { deviceId, paneChallenge, transportId, storeId, action: 'GET_EMAIL_BY_ENTRY_ID', resources: ['message'], sourceFolderId };
    const { ticket } = await issueBridgeTicket(db, auth, new Headers(), input);
    return authorizeNative(db, deviceId, { ...input, ticket });
  }
  return { approval, read, auth, paneChallenge, sessionId };
}

describe.skipIf(!TEST_DB_AVAILABLE)('approved root read policy', () => {
  it('adds root authority only to reads and returns a finite versioned native policy', async () => withTestDb(async db => {
    expect(typeof devicePolicy.approveReadRoot).toBe('function');
    const f = await fixture(db);
    expect(await f.read()).toBeNull();
    await devicePolicy.approveReadRoot(db, f.approval);
    expect(await f.read()).toMatchObject({ kind: 'read', approvedReadRoots: [{ storeId, rootEntryId: 'retained-root', policyVersion: 1, policyGeneration: 1 }] });
    const operationId = `op_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
    const input = { ...f.approval, paneChallenge: f.paneChallenge, action: 'MARK_EMAIL_READ', resources: ['message'], sourceFolderId: 'new-descendant', operationId };
    const { ticket } = await issueBridgeTicket(db, f.auth, new Headers(), input);
    expect(await authorizeNative(db, f.approval.deviceId, { ...input, ticket })).toBeNull();
  }));
  it('rejects foreign stores/staff/unknown policy and increments generation across revocation', async () => withTestDb(async db => {
    expect(typeof devicePolicy.approveReadRoot).toBe('function');
    const f = await fixture(db);
    await expect(devicePolicy.approveReadRoot(db, { ...f.approval, storeId: 'personal-store' })).rejects.toThrow();
    await expect(devicePolicy.approveReadRoot(db, { ...f.approval, userId: randomUUID() })).rejects.toThrow();
    await expect(devicePolicy.approveReadRoot(db, { ...f.approval, policyVersion: 2 as never })).rejects.toThrow();
    await devicePolicy.approveReadRoot(db, f.approval);
    await devicePolicy.revokeReadRoot(db, f.approval);
    expect(await f.read()).toBeNull();
    await devicePolicy.approveReadRoot(db, f.approval);
    expect(await devicePolicy.getApprovedReadRoots(db, f.approval.deviceId, f.approval.userId, f.approval.transportId, storeId)).toEqual([{ storeId, rootEntryId: 'retained-root', policyVersion: 1, policyGeneration: 3 }]);
    expect(await devicePolicy.getApprovedReadRoots(db, f.approval.deviceId, randomUUID(), f.approval.transportId, storeId)).toEqual([]);
  }));
  it('refuses a 26th root instead of silently truncating approved authority', async () => withTestDb(async db => {
    const f = await fixture(db);
    for (let i = 0; i < 25; i++) await devicePolicy.approveReadRoot(db, { ...f.approval, rootEntryId: `root-${i}` });
    await expect(devicePolicy.approveReadRoot(db, { ...f.approval, rootEntryId: 'root-26' })).rejects.toThrow('25');
    expect(await devicePolicy.getApprovedReadRoots(db, f.approval.deviceId, f.approval.userId, f.approval.transportId, storeId)).toHaveLength(25);
  }));
  it('root approval fails closed after logout, device revocation and mailbox revocation', async () => withTestDb(async db => {
    expect(typeof devicePolicy.approveReadRoot).toBe('function');
    const f = await fixture(db);
    await devicePolicy.approveReadRoot(db, f.approval);
    await db.delete(session).where(eq(session.id, f.sessionId));
    await expect(f.read()).rejects.toThrow();
    await devicePolicy.revokeDevice(db, f.approval.deviceId);
    expect(await devicePolicy.getApprovedReadRoots(db, f.approval.deviceId, f.approval.userId, f.approval.transportId, storeId)).toEqual([]);
  }));
});
