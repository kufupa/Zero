import { and, eq, gt, ne, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { HMS_JOB_PROMPT_VERSION } from './run-ledger.js';

/** Prefetch kinds that share the hourly reservation helper. Unknown kinds are a type error. */
export type PrefetchKind = 'find' | 'search_guest' | 'party' | 'availability' | 'staff_quote';

/** Rolling window for the existing hourly cap. Keep aligned with PREFETCH_WINDOW_MS in hms-jobs.ts. */
export const PREFETCH_CAPACITY_WINDOW_MS = 60 * 60_000;

/** Prefetch jobs are priority 0. Keep aligned with HMS_JOB_PRIORITY_PREFETCH without importing hms-jobs. */
const PREFETCH_PRIORITY = 0;

/** Floor so a deferred job is never immediately claimable again. */
const DEFER_FLOOR_MS = 5 * 60_000;

export type PrefetchCapacityDecision = {
  action: 'disable' | 'admit' | 'defer';
  used: number;
  nextRunAt: Date;
};

export type PrefetchReservationCount = {
  used: number;
  oldestCreatedAt: Date | null;
};

function asCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Pure hourly-cap decision. Zero/invalid cap is a disable, not an infinite queue.
 * Overflow keeps the work: caller must persist nextRunAt instead of dropping.
 */
export function decidePrefetchCapacity(input: {
  used: number;
  perHour: number;
  now: Date;
  windowMs?: number;
  oldestCreatedAt?: Date | null;
}): PrefetchCapacityDecision {
  const used = asCount(input.used);
  const now = input.now;
  if (!Number.isInteger(input.perHour) || input.perHour <= 0) {
    return { action: 'disable', used, nextRunAt: now };
  }
  if (used < input.perHour) {
    return { action: 'admit', used, nextRunAt: now };
  }
  const windowMs = input.windowMs ?? PREFETCH_CAPACITY_WINDOW_MS;
  const fromOldest =
    input.oldestCreatedAt instanceof Date && Number.isFinite(input.oldestCreatedAt.getTime())
      ? new Date(input.oldestCreatedAt.getTime() + windowMs)
      : new Date(now.getTime() + windowMs);
  const floor = new Date(now.getTime() + DEFER_FLOOR_MS);
  return {
    action: 'defer',
    used,
    nextRunAt: fromOldest.getTime() > floor.getTime() ? fromOldest : floor,
  };
}

/** Active plus scheduled reservations in the rolling hour, excluding an optional waking job. */
export async function countPrefetchReservations(
  db: DB,
  input: {
    transportId: string;
    kind: PrefetchKind;
    since: Date;
    excludeRunId?: string;
  },
): Promise<PrefetchReservationCount> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${aiWorkflowRun.createdAt})`,
    })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, input.transportId),
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        eq(aiWorkflowRun.priority, PREFETCH_PRIORITY),
        sql`${aiWorkflowRun.metrics}->>'batchId' IS NULL`,
        ...(input.kind === 'staff_quote'
          ? [sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`]
          : []),
        sql`${aiWorkflowRun.readRequest}->>'kind' = ${input.kind}`,
        gt(aiWorkflowRun.createdAt, input.since),
        ...(input.excludeRunId ? [ne(aiWorkflowRun.id, input.excludeRunId)] : []),
      ),
    );
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return {
    used: asCount(row?.n),
    oldestCreatedAt: oldest && Number.isFinite(oldest.getTime()) ? oldest : null,
  };
}

/** Count then decide under the caller's existing advisory lock / transaction. */
export async function reservePrefetchCapacity(
  db: DB,
  input: {
    transportId: string;
    kind: PrefetchKind;
    perHour: number;
    now?: Date;
    excludeRunId?: string;
  },
): Promise<PrefetchCapacityDecision> {
  const now = input.now ?? new Date();
  const counted = await countPrefetchReservations(db, {
    transportId: input.transportId,
    kind: input.kind,
    since: new Date(now.getTime() - PREFETCH_CAPACITY_WINDOW_MS),
    excludeRunId: input.excludeRunId,
  });
  return decidePrefetchCapacity({
    used: counted.used,
    perHour: input.perHour,
    now,
    oldestCreatedAt: counted.oldestCreatedAt,
  });
}

export type OccupiedPrefetchReservation = {
  admittedAt: Date;
  stamped: boolean;
};

function metricsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function admittedAtFromMetrics(metrics: Record<string, unknown>, fallback: Date): Date {
  const raw = metrics.prefetchAdmittedAt;
  if (typeof raw !== 'string') return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed) : fallback;
}

/**
 * Stamp the waking job into the current hour once. Keep `createdAt` stable after the first
 * stamp so the prepared-quote busy-lock timeout can still give up.
 */
export async function occupyPrefetchReservation(
  db: DB,
  runId: string,
  now: Date = new Date(),
): Promise<OccupiedPrefetchReservation> {
  const [row] = await db
    .select({ createdAt: aiWorkflowRun.createdAt, metrics: aiWorkflowRun.metrics })
    .from(aiWorkflowRun)
    .where(eq(aiWorkflowRun.id, runId))
    .limit(1);
  if (!row) return { admittedAt: now, stamped: false };
  const metrics = metricsRecord(row.metrics);
  const admittedAt = admittedAtFromMetrics(metrics, now);
  const since = new Date(now.getTime() - PREFETCH_CAPACITY_WINDOW_MS);
  const stamped = row.createdAt.getTime() <= since.getTime();
  await db
    .update(aiWorkflowRun)
    .set({
      ...(stamped ? { createdAt: now } : {}),
      updatedAt: now,
      metrics: { ...metrics, prefetchAdmittedAt: admittedAt.toISOString() },
    })
    .where(eq(aiWorkflowRun.id, runId));
  return { admittedAt, stamped };
}
