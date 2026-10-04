import {
  outlookSyncObservation as observationTable,
  outlookSyncArtifact as artifactTable,
  outlookSyncSource as sourceTable,
} from '../db/schema/outlook-sync.js';
import {
  buildOutlookHistoryInput,
  requiredArtifacts,
  SyncIngestionGap,
  type SyncIngestionStorage,
} from './ingest.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import { markObservationIngested, refreshSourceSummary } from './ledger.js';
import { persistOutlookHistory } from '../mail/ingest/outlook-history.js';
import { admitLiveMessage } from '../mail/ingest/live-admission.js';
import { syncObservationV1 } from './contracts.js';
import { databaseNow } from './authorization.js';
import { reusableContent } from './content.js';
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { randomUUID } from 'node:crypto';

export type SyncDrainClaim = {
  observationId: string;
  sourceId: string;
  owner: string;
  fence: number;
};
export class SyncDrainClaimError extends Error {
  constructor() {
    super('Stale ingestion claim');
    this.name = 'SyncDrainClaimError';
  }
}
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]]),
        )
      : v,
  );
const matches = (claim: SyncDrainClaim) =>
  and(
    eq(observationTable.id, claim.observationId),
    eq(observationTable.drainOwner, claim.owner),
    eq(observationTable.drainFence, claim.fence),
  );
/** SKIP LOCKED allows another server process without double work; no customer auth is required after acceptance. */
export async function claimSyncIngestion(db: DB, owner: string): Promise<SyncDrainClaim | null> {
  if (!owner || owner.length > 128) throw new Error('Invalid drain owner');
  return db.transaction(async (tx) => {
    const t = tx as DB;
    const [observation] = await t
      .select()
      .from(observationTable)
      .where(
        and(
          eq(observationTable.exportState, 'retained'),
          sql`${observationTable.ingestionState} in ('pending','processing')`,
          sql`(${observationTable.drainExpiresAt} is null or ${observationTable.drainExpiresAt} <= clock_timestamp())`,
          sql`(${observationTable.drainNextAttemptAt} is null or ${observationTable.drainNextAttemptAt} <= clock_timestamp())`,
        ),
      )
      .orderBy(observationTable.createdAt, observationTable.id)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!observation) return null;
    const now = await databaseNow(t),
      fence = observation.drainFence + 1;
    await t
      .update(observationTable)
      .set({
        ingestionState: 'processing',
        drainOwner: owner,
        drainFence: fence,
        drainExpiresAt: new Date(now.getTime() + 300_000),
        drainNextAttemptAt: null,
      })
      .where(eq(observationTable.id, observation.id));
    return { observationId: observation.id, sourceId: observation.sourceId, owner, fence };
  });
}
async function ownedClaim(db: DB, claim: SyncDrainClaim, lock: boolean) {
  const query = db.select().from(observationTable).where(matches(claim));
  const [row] = lock ? await query.for('update') : await query;
  const now = await databaseNow(db);
  if (
    !row ||
    row.ingestionState !== 'processing' ||
    !row.drainExpiresAt ||
    row.drainExpiresAt <= now
  )
    throw new SyncDrainClaimError();
  return row;
}
async function heartbeat(db: DB, claim: SyncDrainClaim) {
  return db.transaction(async (tx) => {
    const t = tx as DB;
    await ownedClaim(t, claim, true);
    const now = await databaseNow(t);
    await t
      .update(observationTable)
      .set({ drainExpiresAt: new Date(now.getTime() + 300_000) })
      .where(matches(claim));
  });
}
async function artifactOrigin(
  db: DB,
  observation: typeof observationTable.$inferSelect,
  lock = false,
) {
  if (!observation.artifactOrigin) return undefined;
  const rows = db
    .select()
    .from(observationTable)
    .where(eq(observationTable.id, observation.artifactOrigin.observationId));
  const [origin] = await (lock ? rows.for('update') : rows);
  if (
    !origin ||
    origin.sourceId !== observation.sourceId ||
    observation.artifactOrigin.sourceId !== observation.sourceId ||
    origin.artifactOrigin ||
    origin.sourceObservationId !== observation.sourceObservationId ||
    origin.exportState !== 'retained' ||
    !reusableContent(observation.evidence, origin.evidence)
  )
    throw new SyncIngestionGap('ARTIFACT_ORIGIN_MISMATCH');
  return origin;
}
export async function ingestClaimedObservation(
  db: DB,
  storage: SyncIngestionStorage,
  claim: SyncDrainClaim,
): Promise<{ state: 'committed' | 'attention'; messageId: string }> {
  const observation = await ownedClaim(db, claim, false);
  const [source] = await db
    .select()
    .from(sourceTable)
    .where(eq(sourceTable.id, observation.sourceId));
  if (!source?.captureStartedAt) throw new SyncIngestionGap('SOURCE_CUTOVER_MISSING');
  const origin = await artifactOrigin(db, observation);
  const artifacts = await db
    .select()
    .from(artifactTable)
    .where(eq(artifactTable.observationId, origin?.id ?? observation.id));
  let leaseFailure: Error | undefined;
  const timer = setInterval(() => {
    void heartbeat(db, claim).catch((err) => {
      leaseFailure = err;
    });
  }, 30_000);
  timer.unref();
  let prepared: Awaited<ReturnType<typeof buildOutlookHistoryInput>>;
  try {
    prepared = await buildOutlookHistoryInput(storage, source, observation, artifacts, origin);
  } finally {
    clearInterval(timer);
  }
  if (leaseFailure) throw leaseFailure;
  return db.transaction(async (tx) => {
    const t = tx as DB;
    // Shared lock order is mailbox -> source -> observation -> artifact across canonical acceptance.
    await lockCanonicalMailbox(t, source.transportId);
    const [currentSource] = await t
      .select()
      .from(sourceTable)
      .where(eq(sourceTable.id, claim.sourceId))
      .for('update');
    if (
      !currentSource ||
      currentSource.transportId !== source.transportId ||
      currentSource.captureStartedAt?.getTime() !== source.captureStartedAt!.getTime()
    )
      throw new SyncIngestionGap('SOURCE_CHANGED');
    const current = await ownedClaim(t, claim, true);
    const currentOrigin = await artifactOrigin(t, current, true);
    if (
      stableJson(observation.artifactOrigin) !== stableJson(current.artifactOrigin) ||
      origin?.id !== currentOrigin?.id
    )
      throw new SyncIngestionGap('ARTIFACT_ORIGIN_CHANGED');
    // Refuse any artifact/version mutation while network verification was running.
    const fresh = await t
      .select()
      .from(artifactTable)
      .where(eq(artifactTable.observationId, currentOrigin?.id ?? current.id));
    const before = requiredArtifacts(observation, artifacts),
      after = requiredArtifacts(current, fresh);
    if (
      before.length !== after.length ||
      before.some(
        (a, i) =>
          a.id !== after[i].id ||
          a.sealedKey !== after[i].sealedKey ||
          a.sha256 !== after[i].sha256,
      )
    )
      throw new SyncIngestionGap('ARTIFACT_CHANGED');
    const currentEvidence = syncObservationV1.parse(current.evidence);
    const { event: _beforeEvent, ...beforeEvidence } = prepared.evidence;
    const { event: _currentEvent, ...currentBody } = currentEvidence;
    if (stableJson(beforeEvidence) !== stableJson(currentBody))
      throw new SyncIngestionGap('OBSERVATION_CHANGED');
    const result = await persistOutlookHistory(t, prepared.input);
    if (!result.attention)
      await admitLiveMessage(t, {
        transportId: source.transportId,
        canonicalMessageId: result.messageId,
        evidence: {
          kind: 'native',
          sourceReceiptId: current.id,
          cutover: source.captureStartedAt!,
          observation: {
            direction: currentEvidence.direction,
            receivedAt: currentEvidence.timestamps.receivedAt,
            sentAt: currentEvidence.timestamps.sentAt,
            event: currentEvidence.event,
          },
        },
      });
    await markObservationIngested(t, current.id, result.messageId, result.attention);
    await t
      .update(observationTable)
      .set({
        ingestionState: result.attention ? 'attention' : 'committed',
        drainOwner: null,
        drainExpiresAt: null,
        drainNextAttemptAt: null,
        errorCode: result.attention ? 'AMBIGUOUS_IDENTITY' : null,
      })
      .where(matches(claim));
    await refreshSourceSummary(t, current.sourceId, [current.id]);
    return { state: result.attention ? 'attention' : 'committed', messageId: result.messageId };
  });
}
async function recordFailure(db: DB, claim: SyncDrainClaim, error: unknown) {
  return db.transaction(async (tx) => {
    const t = tx as DB;
    await t.select().from(sourceTable).where(eq(sourceTable.id, claim.sourceId)).for('update');
    const [row] = await t.select().from(observationTable).where(matches(claim)).for('update');
    if (!row || row.ingestionState !== 'processing') return 'stale' as const;
    const attention =
      error instanceof SyncIngestionGap && error.code !== 'MISSING_REQUIRED_ARTIFACT';
    const now = await databaseNow(t),
      retries = row.retryCount + 1,
      delay = Math.min(60_000, 1000 * 2 ** Math.min(6, retries - 1));
    await t
      .update(observationTable)
      .set({
        ingestionState: attention ? 'attention' : 'pending',
        retryCount: retries,
        errorCode: attention ? error.code : 'INGESTION_RETRY',
        drainOwner: null,
        drainExpiresAt: null,
        drainNextAttemptAt: attention ? null : new Date(now.getTime() + delay),
      })
      .where(matches(claim));
    await refreshSourceSummary(t, row.sourceId, [row.id]);
    return attention ? ('attention' as const) : ('retried' as const);
  });
}
export async function runSyncDrainPass(
  db: DB,
  storage: SyncIngestionStorage,
  owner = randomUUID(),
  limit = 10,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid drain batch');
  const result = { committed: 0, retried: 0, attention: 0, stale: 0 };
  for (let i = 0; i < limit; i++) {
    const claim = await claimSyncIngestion(db, owner);
    if (!claim) break;
    try {
      const outcome = await ingestClaimedObservation(db, storage, claim);
      result[outcome.state]++;
    } catch (err) {
      if (err instanceof SyncDrainClaimError) result.stale++;
      else result[await recordFailure(db, claim, err)]++;
    }
  }
  return result;
}
/** One serial bounded drain in the existing HTTP process. Stop waits for accepted in-flight work. */
export function startOutlookSyncDrain(
  db: DB,
  storage: SyncIngestionStorage,
  intervalMs = 2000,
): () => Promise<void> {
  const owner = randomUUID();
  let stopped = false;
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (stopped || active) return;
    active = runSyncDrainPass(db, storage, owner)
      .catch(() => {
        console.error('Outlook sync ingestion unavailable');
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
