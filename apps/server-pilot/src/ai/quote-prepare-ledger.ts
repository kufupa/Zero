import { and, desc, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { PropertyRefusalCause } from '../hms/property-refusal.js';
import type { AiFailureClass } from './run-ledger.js';

export type QuotePrepareDecisionOutcome = 'skipped' | 'queued' | 'error';

export type QuotePrepareDecision = {
  at: string;
  outcome: QuotePrepareDecisionOutcome;
  reason: string;
  queued?: number;
  errorClass?: AiFailureClass;
};

export type QuotePrepareDecisionInput = {
  at?: Date;
  outcome: QuotePrepareDecisionOutcome;
  reason: string;
  queued?: number;
  errorClass?: string;
};

export type QuotePrepareSourceRef = {
  id?: string | null;
  transportId: string;
  triggerMessageId: string;
};

const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const ALLOWED_REASONS = new Set([
  'disabled',
  'no_live_admission',
  'source_not_found',
  'extraction_not_succeeded',
  'not_quote',
  'not_inbound',
  'history_copy',
  'spam',
  'system_notice',
  'no_action',
  'channel_or_ota',
  'triage_pending',
  'missing_sender',
  'mailbox_sender',
  'staff_sender',
  'party_match_pending',
  'missing_rooms',
  'missing_dates',
  'invalid_dates',
  'past_dates',
  'stay_too_long',
  'too_many_room_types',
  'missing_occupancy',
  'invalid_extraction',
  'invalid_quote_input',
  'missing_stay',
  'empty_plan',
  'target_refused',
  'cap_exhausted',
  'not_queued',
  'queued',
  'error',
  'unknown',
]);

const ALLOWED_ERROR_CLASSES = new Set<AiFailureClass>([
  'RUN_DEADLINE',
  'LEASE_LOST',
  'NEEDS_CHECK',
  'POLICY_BLOCK',
  'AUTH',
  'PROPERTY_MISMATCH',
  'SCHEMA_DRIFT',
  'TRANSIENT_NETWORK',
  'BEDROCK_TRANSIENT',
  'ARTIFACT_TRANSIENT',
  'AUDIT_CAPTURE',
  'HMS_LOCK_BUSY',
  'STAFF_QUOTE_ACTIVE',
  'WORKER_SHUTDOWN',
  'UNKNOWN',
]);

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Closed skip/queue tokens only. Free-form text, mail, and guest fields become `unknown`. */
export function sanitizeQuotePrepareDecision(input: QuotePrepareDecisionInput): QuotePrepareDecision {
  const reason =
    typeof input.reason === 'string' &&
    REASON_PATTERN.test(input.reason) &&
    ALLOWED_REASONS.has(input.reason)
      ? input.reason
      : 'unknown';
  const outcome: QuotePrepareDecisionOutcome =
    input.outcome === 'queued' || input.outcome === 'error' || input.outcome === 'skipped'
      ? input.outcome
      : 'skipped';
  const at =
    input.at instanceof Date && Number.isFinite(input.at.getTime())
      ? input.at.toISOString()
      : new Date().toISOString();
  const decision: QuotePrepareDecision = { at, outcome, reason };
  if (outcome === 'queued' && Number.isInteger(input.queued) && (input.queued as number) >= 0) {
    decision.queued = input.queued;
  }
  if (
    outcome === 'error' &&
    typeof input.errorClass === 'string' &&
    ALLOWED_ERROR_CLASSES.has(input.errorClass as AiFailureClass)
  ) {
    decision.errorClass = input.errorClass as AiFailureClass;
  }
  return decision;
}

export function quotePrepareErrorClass(error: unknown): AiFailureClass {
  if (error instanceof PropertyRefusalCause) return 'POLICY_BLOCK';
  if (error instanceof TRPCError) {
    if (error.cause instanceof PropertyRefusalCause || error.code === 'PRECONDITION_FAILED') {
      return 'POLICY_BLOCK';
    }
  }
  if (error && typeof error === 'object' && 'failureClass' in error) {
    const cls = (error as { failureClass: unknown }).failureClass;
    if (typeof cls === 'string' && ALLOWED_ERROR_CLASSES.has(cls as AiFailureClass)) {
      return cls as AiFailureClass;
    }
  }
  return 'UNKNOWN';
}

export function quotePrepareDecisionsFromMetrics(metrics: unknown): QuotePrepareDecision[] {
  const raw = objectRecord(metrics).quotePrepareDecisions;
  return Array.isArray(raw) ? (raw as QuotePrepareDecision[]) : [];
}

/** Preserve sibling metrics keys. Refuse when an existing ledger value is not an array. */
export function appendQuotePrepareDecision(
  metrics: unknown,
  decision: QuotePrepareDecision,
): Record<string, unknown> | null {
  const base = objectRecord(metrics);
  const existing = base.quotePrepareDecisions;
  if (existing !== undefined && !Array.isArray(existing)) return null;
  return {
    ...base,
    quotePrepareDecisions: [...(Array.isArray(existing) ? existing : []), decision],
  };
}

/**
 * Append one prepare decision onto the source inbound_extraction row under FOR UPDATE.
 * Missing/mismatched rows and lock failures fail closed and leave metrics unchanged.
 */
export async function recordQuotePrepareDecision(
  db: DB,
  source: QuotePrepareSourceRef,
  input: QuotePrepareDecisionInput,
): Promise<boolean> {
  const decision = sanitizeQuotePrepareDecision(input);
  try {
    return await db.transaction(async (tx) => {
      const where = source.id
        ? eq(aiWorkflowRun.id, source.id)
        : and(
            eq(aiWorkflowRun.transportId, source.transportId),
            eq(aiWorkflowRun.triggerMessageId, source.triggerMessageId),
            eq(aiWorkflowRun.runKind, 'inbound_extraction'),
          );
      const [row] = await tx
        .select({
          id: aiWorkflowRun.id,
          runKind: aiWorkflowRun.runKind,
          transportId: aiWorkflowRun.transportId,
          triggerMessageId: aiWorkflowRun.triggerMessageId,
          metrics: aiWorkflowRun.metrics,
        })
        .from(aiWorkflowRun)
        .where(where)
        .orderBy(desc(aiWorkflowRun.createdAt))
        .limit(1)
        .for('update');
      if (
        !row ||
        row.runKind !== 'inbound_extraction' ||
        row.transportId !== source.transportId ||
        row.triggerMessageId !== source.triggerMessageId
      ) {
        return false;
      }
      const metrics = appendQuotePrepareDecision(row.metrics, decision);
      if (!metrics) return false;
      await tx
        .update(aiWorkflowRun)
        .set({ metrics, updatedAt: new Date() })
        .where(eq(aiWorkflowRun.id, row.id));
      return true;
    });
  } catch {
    return false;
  }
}

export async function loadQuotePrepareSourceRun(
  db: DB,
  source: QuotePrepareSourceRef,
): Promise<{
  id: string;
  runKind: 'inbound_extraction';
  transportId: string;
  triggerMessageId: string;
  admissionSnapshotId: string | null;
} | null> {
  try {
    const where = source.id
      ? eq(aiWorkflowRun.id, source.id)
      : and(
          eq(aiWorkflowRun.transportId, source.transportId),
          eq(aiWorkflowRun.triggerMessageId, source.triggerMessageId),
          eq(aiWorkflowRun.runKind, 'inbound_extraction'),
        );
    const [row] = await db
      .select({
        id: aiWorkflowRun.id,
        runKind: aiWorkflowRun.runKind,
        transportId: aiWorkflowRun.transportId,
        triggerMessageId: aiWorkflowRun.triggerMessageId,
        admissionSnapshotId: aiWorkflowRun.admissionSnapshotId,
      })
      .from(aiWorkflowRun)
      .where(where)
      .orderBy(desc(aiWorkflowRun.createdAt))
      .limit(1);
    if (
      !row ||
      row.runKind !== 'inbound_extraction' ||
      row.transportId !== source.transportId ||
      row.triggerMessageId !== source.triggerMessageId
    ) {
      return null;
    }
    return { ...row, runKind: 'inbound_extraction' };
  } catch {
    return null;
  }
}
