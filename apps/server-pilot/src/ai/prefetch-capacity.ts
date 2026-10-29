import { and, eq, gt, ne, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { HMS_JOB_PROMPT_VERSION } from './run-ledger.js';
import { resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';

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
  batchSize?: number;
  now: Date;
  windowMs?: number;
  oldestCreatedAt?: Date | null;
}): PrefetchCapacityDecision {
  const used = asCount(input.used);
  const now = input.now;
  const batchSize = input.batchSize ?? 1;
  if (
    !Number.isInteger(input.perHour) ||
    input.perHour <= 0 ||
    !Number.isInteger(batchSize) ||
    batchSize <= 0
  ) {
    return { action: 'disable', used, nextRunAt: now };
  }
  // Let one profile-sized fan-out start as a unit; it may exceed the safety budget only in an empty window.
  if (used + batchSize <= input.perHour || (used === 0 && batchSize > input.perHour)) {
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

/** Active plus scheduled reservations in the rolling hour, excluding an optional waking job or batch. */
export async function countPrefetchReservations(
  db: DB,
  input: {
    transportId: string;
    kind: PrefetchKind;
    since: Date;
    excludeRunId?: string;
    excludeTriggerMessageId?: string;
    excludeQuoteBatch?: { triggerMessageId: string; sourceExtractionId: string | null };
  },
): Promise<PrefetchReservationCount> {
  const filters = and(
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
    ...(input.excludeTriggerMessageId
      ? [sql`${aiWorkflowRun.triggerMessageId} IS DISTINCT FROM ${input.excludeTriggerMessageId}`]
      : []),
    ...(input.excludeQuoteBatch
      ? [sql`(${aiWorkflowRun.triggerMessageId} IS DISTINCT FROM ${input.excludeQuoteBatch.triggerMessageId}
          OR ${aiWorkflowRun.readRequest}->'input'->>'sourceExtractionId' IS DISTINCT FROM ${input.excludeQuoteBatch.sourceExtractionId})`]
      : []),
  );

  if (input.kind === 'staff_quote') {
    // Each Centurion extraction reserves its own strategy fan-out; other hotels keep their existing mail key.
    const property = resolvePropertyTransport(input.transportId);
    const sourceKey = property.kind === 'property' && property.property.propertyCode === 'HRCEN'
      ? sql<string>`jsonb_build_array(
          coalesce(${aiWorkflowRun.triggerMessageId}, ${aiWorkflowRun.id}),
          ${aiWorkflowRun.readRequest}->'input'->>'sourceExtractionId'
        )::text`
      : sql<string>`coalesce(${aiWorkflowRun.triggerMessageId}, ${aiWorkflowRun.id})`;
    const batchSize = sql<number>`greatest(
      coalesce(max(
        case
          when ${aiWorkflowRun.metrics}->>'prefetchBatchSize' ~ '^[1-9][0-9]{0,8}$'
          then (${aiWorkflowRun.metrics}->>'prefetchBatchSize')::int
          else null
        end
      ), 0),
      count(*)::int
    )::int`;
    const rows = await db
      .select({
        used: batchSize,
        oldest: sql<Date | null>`min(${aiWorkflowRun.createdAt})`,
      })
      .from(aiWorkflowRun)
      .where(filters)
      .groupBy(sourceKey);
    const oldest = rows.reduce<Date | null>((value, row) => {
      if (!row.oldest) return value;
      const candidate = new Date(row.oldest);
      if (!Number.isFinite(candidate.getTime())) return value;
      return !value || candidate.getTime() < value.getTime() ? candidate : value;
    }, null);
    return {
      used: rows.reduce((total, row) => total + asCount(row.used), 0),
      oldestCreatedAt: oldest,
    };
  }

  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${aiWorkflowRun.createdAt})`,
    })
    .from(aiWorkflowRun)
    .where(filters);
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
    batchSize?: number;
    now?: Date;
    excludeRunId?: string;
    excludeTriggerMessageId?: string;
    excludeQuoteBatch?: { triggerMessageId: string; sourceExtractionId: string | null };
  },
): Promise<PrefetchCapacityDecision> {
  const now = input.now ?? new Date();
  const counted = await countPrefetchReservations(db, {
    transportId: input.transportId,
    kind: input.kind,
    since: new Date(now.getTime() - PREFETCH_CAPACITY_WINDOW_MS),
    excludeRunId: input.excludeRunId,
    excludeTriggerMessageId: input.excludeTriggerMessageId,
    excludeQuoteBatch: input.excludeQuoteBatch,
  });
  return decidePrefetchCapacity({
    used: counted.used,
    perHour: input.perHour,
    batchSize: input.batchSize,
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
      metrics: sql`coalesce(${aiWorkflowRun.metrics}, '{}'::jsonb) || ${JSON.stringify({
        prefetchAdmittedAt: admittedAt.toISOString(),
      })}::jsonb`,
    })
    .where(eq(aiWorkflowRun.id, runId));
  return { admittedAt, stamped };
}
