import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withTestDb, openTestDbSession, TEST_DB_AVAILABLE } from './helpers/test-db.js';
import { user, session } from '../src/db/schema/auth.js';
import { mailboxAccess, mailboxTransport } from '../src/db/schema/mail.js';
import { outlookDeviceGrant, outlookDeviceReadRoot } from '../src/db/schema/outlook-device.js';
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
    // A Deleted Items source is never auto-approved, so only a read root can grant this read.
    return authorizeNative(db, deviceId, { ...input, ticket, sourceKind: 'deleted' });
  }
  return { approval, read, auth, paneChallenge, sessionId, userId, transportId, deviceId };
}

async function withSecondTransportGrant(
  db: Parameters<typeof devicePolicy.issueEnrollment>[0],
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const transportB = randomUUID();
  await db.insert(mailboxTransport).values({
    id: transportB,
    email: `${transportB}@example.test`,
    ownerHeaderValue: transportB,
  });
  await db.insert(mailboxAccess).values({ id: randomUUID(), userId: f.userId, transportId: transportB, role: 'member' });
  await db.insert(outlookDeviceGrant).values({
    deviceId: f.deviceId,
    userId: f.userId,
    transportId: transportB,
  });
  return {
    transportB,
    approvalB: {
      ...f.approval,
      transportId: transportB,
      rootEntryId: 'root-transport-b',
    },
  };
}

async function countActiveRootsForStore(
  db: Parameters<typeof devicePolicy.approveReadRoot>[0],
  deviceId: string,
  storeId: string,
) {
  const rows = await db
    .select({ rootEntryId: outlookDeviceReadRoot.rootEntryId })
    .from(outlookDeviceReadRoot)
    .where(
      and(
        eq(outlookDeviceReadRoot.deviceId, deviceId),
        eq(outlookDeviceReadRoot.storeId, storeId),
        isNull(outlookDeviceReadRoot.revokedAt),
      ),
    );
  return rows.length;
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
  it('allows only one active read root per device store across root entry ids', async () =>
    withTestDb(async (db) => {
      const f = await fixture(db);
      await devicePolicy.approveReadRoot(db, f.approval);
      await expect(
        devicePolicy.approveReadRoot(db, { ...f.approval, rootEntryId: 'second-root' }),
      ).rejects.toThrow(/one active root/i);
      expect(await countActiveRootsForStore(db, f.deviceId, storeId)).toBe(1);
    }));
  it('rejects a second transport binding on the same device store', async () =>
    withTestDb(async (db) => {
      const f = await fixture(db);
      const { approvalB } = await withSecondTransportGrant(db, f);
      await devicePolicy.approveReadRoot(db, f.approval);
      await expect(devicePolicy.approveReadRoot(db, approvalB)).rejects.toThrow(/one active root/i);
      expect(await countActiveRootsForStore(db, f.deviceId, storeId)).toBe(1);
    }));
  it('allows at most one concurrent transport binding per device store', async () => {
    const setup = openTestDbSession();
    const left = openTestDbSession();
    const right = openTestDbSession();
    try {
      const f = await fixture(setup.db);
      const { approvalB } = await withSecondTransportGrant(setup.db, f);
      const outcomes = await Promise.allSettled([
        devicePolicy.approveReadRoot(left.db, f.approval),
        devicePolicy.approveReadRoot(right.db, approvalB),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
      expect(await countActiveRootsForStore(setup.db, f.deviceId, storeId)).toBe(1);
    } finally {
      await left.close();
      await right.close();
      await setup.close();
    }
  });
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
