/** Durable transfer reservations. Accepted originals are never expired or deleted to reclaim capacity. */
import {
  outlookSyncSource as sourceTable,
  outlookSyncArtifact as artifactTable,
  outlookSyncObservation as observationTable,
} from '../db/schema/outlook-sync.js';
import { SyncDeniedError } from './authorization.js';
import type { DB } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
export const DEFAULT_PENDING_BYTE_LIMIT = 1024 ** 3;
export const MAX_SYNC_ARTIFACT_BYTES = 16 * 1024 ** 2 * 10000;
export async function reservePendingArtifacts(
  db: DB,
  source: typeof sourceTable.$inferSelect,
  artifacts: { sizeBytes: number }[],
): Promise<boolean> {
  const bytes = artifacts.reduce((n, a) => n + BigInt(a.sizeBytes), 0n),
    total = BigInt(source.pendingBytes) + bytes;
  if (!artifacts.length) return true;
  // One large original may exceed the normal queue cap while it is the sole pending artifact.
  const oneLarge =
    source.pendingArtifactCount === 0 &&
    artifacts.length === 1 &&
    artifacts[0].sizeBytes <= MAX_SYNC_ARTIFACT_BYTES;
  if (
    artifacts.some((a) => a.sizeBytes > MAX_SYNC_ARTIFACT_BYTES) ||
    total > BigInt(Number.MAX_SAFE_INTEGER) ||
    (total > BigInt(source.pendingByteLimit) && !oneLarge)
  ) {
    await db
      .update(sourceTable)
      .set({ resourcePauseReason: 'quota' })
      .where(eq(sourceTable.id, source.id));
    return false;
  }
  await db
    .update(sourceTable)
    .set({
      pendingBytes: Number(total),
      pendingArtifactCount: source.pendingArtifactCount + artifacts.length,
      resourcePauseReason:
        source.resourcePauseReason === 'quota' ? null : source.resourcePauseReason,
    })
    .where(eq(sourceTable.id, source.id));
  return true;
}
export async function releasePendingArtifact(
  db: DB,
  sourceId: string,
  artifact: typeof artifactTable.$inferSelect,
) {
  if (!artifact.quotaReserved) return;
  const [s] = await db.select().from(sourceTable).where(eq(sourceTable.id, sourceId)).for('update');
  if (!s || s.pendingBytes < artifact.expectedBytes || s.pendingArtifactCount < 1)
    throw new Error('Sync quota reservation integrity mismatch');
  const bytes = s.pendingBytes - artifact.expectedBytes;
  await db
    .update(sourceTable)
    .set({
      pendingBytes: bytes,
      pendingArtifactCount: s.pendingArtifactCount - 1,
      resourcePauseReason:
        s.resourcePauseReason === 'quota' && bytes < s.pendingByteLimit
          ? null
          : s.resourcePauseReason,
    })
    .where(eq(sourceTable.id, sourceId));
  await db
    .update(artifactTable)
    .set({ quotaReserved: false })
    .where(eq(artifactTable.id, artifact.id));
}
/** Restricted operator shell only; exact enrolled source ownership and a bounded safe limit are mandatory. */
export async function setSourcePendingByteLimit(
  db: DB,
  input: {
    sourceId: string;
    deviceId: string;
    userId: string;
    transportId: string;
    storeId: string;
    rootEntryId: string;
    limitBytes: number;
  },
) {
  if (
    !Number.isSafeInteger(input.limitBytes) ||
    input.limitBytes < DEFAULT_PENDING_BYTE_LIMIT ||
    input.limitBytes > MAX_SYNC_ARTIFACT_BYTES
  )
    throw new Error('Invalid scoped pending-byte limit');
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(sourceTable)
      .where(eq(sourceTable.id, input.sourceId))
      .for('update');
    if (
      !s ||
      s.deviceId !== input.deviceId ||
      s.userId !== input.userId ||
      s.transportId !== input.transportId ||
      s.storeId !== input.storeId ||
      s.rootEntryId !== input.rootEntryId
    )
      throw new SyncDeniedError();
    await tx
      .update(sourceTable)
      .set({
        pendingByteLimit: input.limitBytes,
        resourcePauseReason:
          s.resourcePauseReason === 'quota' && s.pendingBytes < input.limitBytes
            ? null
            : s.resourcePauseReason,
      })
      .where(eq(sourceTable.id, s.id));
    return { sourceId: s.id, pendingBytes: s.pendingBytes, pendingByteLimit: input.limitBytes };
  });
}

/** At most100 stale reservations reclaimed per pass. S3 staging expires separately; accepted originals never qualify. */
export async function reclaimExpiredReservations(db: DB, sourceId: string) {
  const rows = await db
    .select({ artifact: artifactTable })
    .from(artifactTable)
    .innerJoin(observationTable, eq(observationTable.id, artifactTable.observationId))
    .where(
      and(
        eq(observationTable.sourceId, sourceId),
        eq(artifactTable.quotaReserved, true),
        sql`${artifactTable.acceptedAt} IS NULL AND ${artifactTable.reservationExpiresAt} <= clock_timestamp()`,
      ),
    )
    .limit(100)
    .for('update', { of: artifactTable });
  for (const { artifact } of rows) await releasePendingArtifact(db, sourceId, artifact);
}
export async function renewArtifactReservation(
  db: DB,
  sourceId: string,
  artifactId: string,
): Promise<boolean> {
  await reclaimExpiredReservations(db, sourceId);
  const [source] = await db
    .select()
    .from(sourceTable)
    .where(eq(sourceTable.id, sourceId))
    .for('update');
  const [artifact] = await db
    .select()
    .from(artifactTable)
    .where(eq(artifactTable.id, artifactId))
    .for('update');
  if (!source || !artifact) throw new SyncDeniedError();
  if (artifact.acceptedAt) return true;
  if (
    !artifact.quotaReserved &&
    !(await reservePendingArtifacts(db, source, [{ sizeBytes: artifact.expectedBytes }]))
  )
    return false;
  await db
    .update(artifactTable)
    .set({ quotaReserved: true, reservationExpiresAt: sql`clock_timestamp()+interval '7 days'` })
    .where(eq(artifactTable.id, artifactId));
  return true;
}
