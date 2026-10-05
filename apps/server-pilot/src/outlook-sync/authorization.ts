import { getApprovedReadRoots } from '../outlook-security/device.js';
import { resolveAuthSessionProfile } from '../lib/auth-profile.js';
import { outlookSyncSource } from '../db/schema/outlook-sync.js';
import type { NativeSyncScope } from './contracts.js';
import { session, user } from '../db/schema/auth.js';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { createHash } from 'node:crypto';

export const hashSyncSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export class SyncDeniedError extends Error {
  constructor() {
    super('Outlook sync denied');
  }
}
export class SyncClaimBusyError extends Error {
  constructor() {
    super('Outlook sync source claim is busy');
  }
}
export class SyncQuotaError extends Error {
  constructor() {
    super('Outlook sync pending-byte quota exceeded');
  }
}
export type SyncAuth = {
  api: {
    getSession(input: {
      headers: Headers;
    }): Promise<{ user: { id: string }; session: { id: string } } | null>;
  };
};
export async function databaseNow(db: DB): Promise<Date> {
  const rows = await db.execute(sql`select clock_timestamp() as now`);
  return new Date(rows[0].now as string);
}
export async function requireStaffSession(db: DB, sessionId: string, userId: string) {
  const [staff] = await db
    .select()
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(
      and(
        eq(session.id, sessionId),
        eq(session.userId, userId),
        eq(user.emailVerified, true),
        gt(session.expiresAt, sql`clock_timestamp()`),
        gt(sql`${session.createdAt} + interval '24 hours'`, sql`clock_timestamp()`),
        sql`${session.createdAt} <= clock_timestamp()`,
      ),
    )
    .for('share')
    .limit(1);
  if (!staff) throw new SyncDeniedError();
  return {
    sessionId,
    userId,
    expiresAt: new Date(
      Math.min(staff.session.expiresAt.getTime(), staff.session.createdAt.getTime() + 86_400_000),
    ),
  };
}
export async function authenticatedStaff(db: DB, auth: SyncAuth, headers: Headers) {
  if (resolveAuthSessionProfile() !== 'legacy') throw new SyncDeniedError();
  const actual = await auth.api.getSession({ headers });
  if (!actual?.user?.id || !actual?.session?.id) throw new SyncDeniedError();
  return requireStaffSession(db, actual.session.id, actual.user.id);
}
export async function requireRoot(
  db: DB,
  source: Pick<
    typeof outlookSyncSource.$inferSelect,
    'deviceId' | 'userId' | 'transportId' | 'storeId' | 'rootEntryId'
  >,
  generation?: number,
) {
  const roots = await getApprovedReadRoots(
    db,
    source.deviceId,
    source.userId,
    source.transportId,
    source.storeId,
    true,
  );
  const root = roots.find(
    (r) =>
      r.rootEntryId === source.rootEntryId &&
      (generation === undefined || r.policyGeneration === generation),
  );
  if (!root) throw new SyncDeniedError();
  return root;
}
/** Call only inside a short transaction. Source lock serializes Pause, takeover and grant finalization. */
export async function authorizedSource(
  db: DB,
  deviceId: string,
  scope: Omit<NativeSyncScope, 'claimFence'> & { claimFence?: number },
  options: { allowPaused?: boolean; allowQuota?: boolean; requireFence?: boolean } = {},
) {
  const [source] = await db
    .select()
    .from(outlookSyncSource)
    .where(eq(outlookSyncSource.id, scope.sourceId))
    .for('update')
    .limit(1);
  if (
    !source ||
    source.deviceId !== deviceId ||
    source.storeId !== scope.storeId ||
    source.rootEntryId !== scope.rootEntryId ||
    source.handleHash !== hashSyncSecret(scope.sourceHandle)
  )
    throw new SyncDeniedError();
  const now = await databaseNow(db);
  const staff = await requireStaffSession(db, source.sessionId, source.userId);
  await requireRoot(db, source, source.policyGeneration);
  if (
    source.authorityExpiresAt <= now ||
    (!options.allowPaused &&
      (source.userPaused ||
        (source.resourcePauseReason && source.resourcePauseReason !== 'quota'))) ||
    (options.requireFence &&
      (source.claimFence !== scope.claimFence ||
        !source.claimExpiresAt ||
        source.claimExpiresAt <= now))
  )
    throw new SyncDeniedError();
  if (source.resourcePauseReason === 'quota' && !options.allowPaused && !options.allowQuota)
    throw new SyncQuotaError();
  return { source, staff, now };
}
