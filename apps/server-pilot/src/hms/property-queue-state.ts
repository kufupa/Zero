/**
 * Staff quote queue status for the pane.
 *
 * The property read lock is a non-FIFO advisory lock with no waiter record, so
 * this module reports only what is observable without touching HMS:
 *   - this process's own quote run (phase kept in memory; lost on restart);
 *   - whether any session holds the property key (pg_locks, one cheap query);
 *   - how many other staff quote runs are in flight (aiDraftGeneration rows).
 * It never changes lock acquisition.
 */
import { aiDraftGeneration } from '../db/schema/mail.js';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';

export const STAFF_QUOTE_GENERATION_MODEL = 'staff-approved-native';

/** Server-observable stages of a staff quote run holding the property lock, in order. */
export const QUOTE_RUN_PHASES = [
  'Searching rates',
  'Checking the quote rules',
  'Saving the quote',
] as const;

/** Typical staff quote run (4.7 min, user-measured). */
export const QUOTE_TYPICAL_MS = 282_000;
/** Running past 2x typical reads as HMS not responding. */
export const QUOTE_RUNNING_STALL_MS = 2 * QUOTE_TYPICAL_MS;
/** Waiting for the lock past this reads as HMS not responding. */
export const QUOTE_WAITING_STALL_MS = 15 * 60_000;

const MINUTE_MS = 60_000;
const HMS_NOT_RESPONDING = 'HMS is not responding. Try again in a few minutes.';

export type QuoteRunRecord = {
  generationId: string;
  transportId: string;
  userId: string;
  /** Decimal int32 from propertyReadLockKey(tenantId, propertyCode). */
  lockKey: string;
  startedAtMs: number;
  /** First moment this run held the property lock; undefined while still waiting. */
  runningSinceMs?: number;
  /** 0 while waiting for the lock; 1..QUOTE_RUN_PHASES.length while running. */
  phaseIndex: number;
};

export type QuoteRunHandle = {
  setPhase(index: number, nowMs?: number): void;
  end(): void;
};

const registry = new Map<string, QuoteRunRecord>();

/** Register a staff quote run in this process before it queues for the property lock. */
export function beginQuoteRun(input: {
  generationId: string;
  transportId: string;
  userId: string;
  lockKey: string;
  nowMs?: number;
}): QuoteRunHandle {
  const record: QuoteRunRecord = {
    generationId: input.generationId,
    transportId: input.transportId,
    userId: input.userId,
    lockKey: input.lockKey,
    startedAtMs: input.nowMs ?? Date.now(),
    phaseIndex: 0,
  };
  registry.set(record.generationId, record);
  return {
    setPhase(index, nowMs = Date.now()) {
      record.phaseIndex = Math.min(Math.max(0, index), QUOTE_RUN_PHASES.length);
      if (record.phaseIndex >= 1 && record.runningSinceMs === undefined)
        record.runningSinceMs = nowMs;
    },
    end() {
      if (registry.get(record.generationId) === record) registry.delete(record.generationId);
    },
  };
}

/** The caller's most recent run in this process, scoped to one mailbox and user. */
export function latestQuoteRunFor(input: {
  transportId: string;
  userId: string;
}): QuoteRunRecord | undefined {
  let latest: QuoteRunRecord | undefined;
  for (const run of registry.values()) {
    if (run.transportId !== input.transportId || run.userId !== input.userId) continue;
    if (!latest || run.startedAtMs >= latest.startedAtMs) latest = run;
  }
  return latest ? { ...latest } : undefined;
}

/**
 * pg_locks coordinates for `pg_try_advisory_lock(<int4 literal>)`. The literal
 * resolves to the bigint overload, so the 64-bit key is sign-extended: classid
 * is the high 32 bits and objid the low 32 bits, with objsubid 1.
 */
export function advisoryLockCoordinates(key: string): { classid: number; objid: number } {
  if (!/^-?\d+$/.test(key)) throw new Error('property_queue_lock_key_invalid');
  const value = BigInt(key);
  if (value < -2147483648n || value > 2147483647n)
    throw new Error('property_queue_lock_key_invalid');
  const bits = BigInt.asUintN(64, value);
  return { classid: Number(bits >> 32n), objid: Number(bits & 0xffffffffn) };
}

export type LockHolder = { present: boolean; elapsedMs?: number };

export type HmsQueueStatus = {
  state: 'idle' | 'running' | 'waiting' | 'unavailable';
  phase?: string;
  phaseIndex?: number;
  phaseCount?: number;
  runningForMs?: number;
  aheadCount?: number;
  etaMinutes?: number;
  message: string;
};

/**
 * Pure: turns this caller's run plus cheap observations into the pane payload.
 * `otherQuoteRuns` counts in-flight staff quote runs other than this one. When a
 * holder is present it is assumed to be one of them, so it is not counted as
 * "ahead" twice; its remaining time is added instead.
 */
export function describeHmsQueueStatus(input: {
  run?: Pick<QuoteRunRecord, 'phaseIndex' | 'startedAtMs' | 'runningSinceMs'>;
  nowMs: number;
  holder?: LockHolder;
  otherQuoteRuns?: number;
}): HmsQueueStatus {
  const { run } = input;
  if (!run) return { state: 'idle', message: '' };

  if (run.phaseIndex < 1) {
    const waitedMs = Math.max(0, input.nowMs - run.startedAtMs);
    if (waitedMs > QUOTE_WAITING_STALL_MS)
      return { state: 'unavailable', message: HMS_NOT_RESPONDING };
    const holderPresent = input.holder?.present === true;
    const holderRemainingMs = holderPresent
      ? Math.max(0, QUOTE_TYPICAL_MS - Math.max(0, input.holder?.elapsedMs ?? 0))
      : 0;
    const aheadCount = Math.max(0, (input.otherQuoteRuns ?? 0) - (holderPresent ? 1 : 0));
    if (aheadCount === 0 && !holderPresent)
      return { state: 'waiting', aheadCount: 0, message: 'Waiting for HMS to become free.' };
    const etaMinutes = Math.ceil((aheadCount * QUOTE_TYPICAL_MS + holderRemainingMs) / MINUTE_MS);
    const eta = `about ${etaMinutes <= 1 ? 'a minute' : `${etaMinutes} minutes`}`;
    return {
      state: 'waiting',
      aheadCount,
      etaMinutes,
      message:
        aheadCount > 0
          ? `${aheadCount} ${aheadCount === 1 ? 'quote' : 'quotes'} ahead of yours – ${eta}.`
          : `HMS is busy with another run – ${eta}.`,
    };
  }

  const phaseCount = QUOTE_RUN_PHASES.length;
  const phaseIndex = Math.min(run.phaseIndex, phaseCount);
  const phase = QUOTE_RUN_PHASES[phaseIndex - 1];
  const runningForMs = Math.max(0, input.nowMs - (run.runningSinceMs ?? run.startedAtMs));
  if (runningForMs > QUOTE_RUNNING_STALL_MS)
    return {
      state: 'unavailable',
      phase,
      phaseIndex,
      phaseCount,
      runningForMs,
      message: HMS_NOT_RESPONDING,
    };
  return {
    state: 'running',
    phase,
    phaseIndex,
    phaseCount,
    runningForMs,
    message: `Nava is working in HMS – step ${phaseIndex} of ${phaseCount}: ${phase}.`,
  };
}

/**
 * Who holds the property key right now, and for how long, from pg_locks and
 * pg_stat_activity. One read, no HMS call, no lock acquisition.
 */
export async function readPropertyLockHolder(db: DB, lockKey: string): Promise<LockHolder> {
  const { classid, objid } = advisoryLockCoordinates(lockKey);
  const rows = await db.execute<{ elapsed_ms: string | number | null }>(sql`
    SELECT (EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)) * 1000)::float8 AS elapsed_ms
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory'
      AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())
      AND l.classid = ${classid}::oid
      AND l.objid = ${objid}::oid
      AND l.objsubid = 1
      AND l.granted
    LIMIT 1`);
  const row = rows[0];
  if (!row) return { present: false };
  const elapsed = row.elapsed_ms === null ? Number.NaN : Number(row.elapsed_ms);
  return {
    present: true,
    ...(Number.isFinite(elapsed) ? { elapsedMs: Math.max(0, elapsed) } : {}),
  };
}

/** True while any staff quote run is in flight. Background HMS work yields to it. */
export async function staffQuoteInFlight(db: DB): Promise<boolean> {
  const [row] = await db
    .select({ id: aiDraftGeneration.id })
    .from(aiDraftGeneration)
    .where(
      and(
        eq(aiDraftGeneration.model, STAFF_QUOTE_GENERATION_MODEL),
        eq(aiDraftGeneration.status, 'running'),
        sql`${aiDraftGeneration.createdAt} > clock_timestamp() - interval '20 minutes'`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** In-flight staff quote runs across mailboxes, excluding one generation. Counts only. */
export async function countOtherInFlightQuoteRuns(
  db: DB,
  excludeGenerationId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiDraftGeneration)
    .where(
      and(
        eq(aiDraftGeneration.model, STAFF_QUOTE_GENERATION_MODEL),
        eq(aiDraftGeneration.status, 'running'),
        ne(aiDraftGeneration.id, excludeGenerationId),
        sql`${aiDraftGeneration.createdAt} > clock_timestamp() - interval '20 minutes'`,
      ),
    );
  return Number(row?.count ?? 0);
}
