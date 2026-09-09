import {
  buildShadowScorecard,
  type ShadowAssessmentScorecardRow,
  type ShadowPredictionScorecardRow,
  type ShadowScorecard,
} from '../metrics/shadow-scorecard.js';
import { matchShadowReference, type ShadowReferenceMatch } from './shadow-reference-matcher.js';
import { aiShadowAssessment, aiShadowPrediction } from '../db/schema/ai-shadow-evaluation.js';
import type { LocalModelRouteEvidence } from './bedrock/local.js';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, type DB } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import { enqueueAiRun } from './run-ledger.js';
import { z } from 'zod';

export const SHADOW_EVALUATION_MODE = 'future_shadow' as const;
export const SHADOW_PURPOSE = 'shadow' as const;
export const SHADOW_EVALUATION_VERSION = 'shadow-evaluation-v1';
export const SHADOW_PROMPT_VERSION = 'shadow-mail/v1';
export const SHADOW_OBSERVATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export type ShadowEvaluationMode = 'current_state' | 'historical_replay' | 'future_shadow';

export type ShadowMessageInput = {
  id: string;
  direction: 'inbound' | 'outbound';
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  attachmentIds: readonly string[];
};

export type FrozenShadowInput = {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  asOfAt: string;
  messageIds: string[];
  attachmentIds: string[];
  excludedFutureMessageIds: string[];
  modelMessages: Array<{
    id: string;
    direction: ShadowMessageInput['direction'];
    subject: string | null;
    text: string;
    eventAt: string;
  }>;
  inputDigest: string;
};

const shadowPredictionOutputSchema = z
  .object({
    outcome: z.enum(['complete', 'partial', 'clarification', 'manual_review', 'unavailable']),
    textBody: z.string().max(20_000).optional(),
    asks: z.array(z.string().min(1).max(160)).max(32).optional(),
    facts: z.record(z.string(), z.unknown()).optional(),
    limitations: z.array(z.string().min(1).max(400)).max(32).optional(),
  })
  .strict();

export type ShadowPredictionOutput = z.infer<typeof shadowPredictionOutputSchema>;

export function validateShadowPredictionOutput(value: unknown): ShadowPredictionOutput {
  return shadowPredictionOutputSchema.parse(value);
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function messageEventAt(message: ShadowMessageInput): Date | null {
  return asDate(message.receivedAt ?? message.sentAt ?? message.createdAt);
}

function normalizedText(message: ShadowMessageInput): string {
  return (message.textBody ?? message.htmlBody ?? '').replaceAll('\u0000', '').trim();
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Freeze causal mail input before any current-state context builder runs.
 * Messages after the trigger horizon are retained only as exclusion counts/
 * ids; their body and attachments never enter the model-facing input.
 */
export function freezeShadowInput(input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  asOfAt: Date | string;
  messages: readonly ShadowMessageInput[];
}): FrozenShadowInput {
  const asOf = asDate(input.asOfAt);
  if (!asOf) throw new Error('shadow prediction as-of must be a valid instant');
  const trigger = input.messages.find((message) => message.id === input.triggerMessageId);
  if (!trigger) throw new Error('shadow prediction trigger message is missing');
  const triggerAt = messageEventAt(trigger);
  if (!triggerAt || triggerAt.getTime() > asOf.getTime()) {
    throw new Error('shadow prediction trigger is after the as-of horizon');
  }

  const ordered = [...input.messages].sort((left, right) => {
    const leftAt = messageEventAt(left)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const rightAt = messageEventAt(right)?.getTime() ?? Number.NEGATIVE_INFINITY;
    return leftAt - rightAt || left.id.localeCompare(right.id);
  });
  const included = ordered.filter((message) => {
    const at = messageEventAt(message)?.getTime();
    return at !== undefined && at !== null && at <= asOf.getTime();
  });
  if (!included.some((message) => message.id === input.triggerMessageId)) {
    throw new Error('shadow prediction trigger is outside the frozen horizon');
  }
  const excludedFutureMessageIds = ordered
    .filter((message) => !included.some((includedMessage) => includedMessage.id === message.id))
    .map((message) => message.id);
  const modelMessages = included.map((message) => {
    const eventAt = messageEventAt(message);
    if (!eventAt) throw new Error(`shadow message ${message.id} has no usable event clock`);
    return {
      id: message.id,
      direction: message.direction,
      subject: message.subject,
      text: normalizedText(message),
      eventAt: eventAt.toISOString(),
    };
  });
  const attachmentIds = [...new Set(included.flatMap((message) => message.attachmentIds))].sort();
  const inputDigest = digest({
    version: SHADOW_EVALUATION_VERSION,
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    asOfAt: asOf.toISOString(),
    modelMessages,
    attachmentIds,
  });
  return {
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    asOfAt: asOf.toISOString(),
    messageIds: included.map((message) => message.id),
    attachmentIds,
    excludedFutureMessageIds,
    modelMessages,
    inputDigest,
  };
}

export type ShadowModelUsage = {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type ShadowPredictionSeal = {
  predictionKey: string;
  evaluationMode: typeof SHADOW_EVALUATION_MODE;
  evaluationVersion: typeof SHADOW_EVALUATION_VERSION;
  admissionStatus: 'admitted' | 'skipped';
  predictionStatus: 'sealed' | 'unavailable' | 'failed';
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  asOfAt: string;
  sealedAt: string;
  observationEndsAt: string;
  sourceVintage: string;
  inputDigest: string;
  lineage: {
    messageIds: string[];
    attachmentIds: string[];
    excludedFutureMessageIds: string[];
  };
  modelId: string | null;
  promptVersion: string;
  route: Pick<
    LocalModelRouteEvidence,
    'routeId' | 'purpose' | 'protocol' | 'access' | 'egress' | 'retention' | 'usage' | 'modelId'
  > | null;
  modelUsage: ShadowModelUsage | null;
  prediction: ShadowPredictionOutput | null;
  unavailableReason?: string;
};

function assertUsage(usage: ShadowModelUsage): void {
  if (
    !Number.isInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    !Number.isFinite(usage.latencyMs) ||
    usage.latencyMs < 0
  ) {
    throw new Error('shadow model usage was not reported');
  }
}

function routeSummary(route: LocalModelRouteEvidence) {
  if (route.purpose !== SHADOW_PURPOSE) throw new Error('shadow route purpose mismatch');
  if (
    route.protocol !== 'in_process' ||
    route.access !== 'current_app' ||
    route.egress !== 'none' ||
    route.retention !== 'bounded' ||
    route.usage !== 'reported'
  ) {
    throw new Error('shadow route evidence is incomplete');
  }
  return {
    routeId: route.routeId,
    purpose: route.purpose,
    protocol: route.protocol,
    access: route.access,
    egress: route.egress,
    retention: route.retention,
    usage: route.usage,
    modelId: route.modelId,
  } as const;
}

export function createShadowPredictionSeal(input: {
  predictionKey: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  frozen: FrozenShadowInput;
  output: unknown;
  route: LocalModelRouteEvidence;
  modelUsage: ShadowModelUsage;
  sealedAt: Date | string;
  observationEndsAt?: Date | string;
}): ShadowPredictionSeal {
  const sealedAt = asDate(input.sealedAt);
  if (!sealedAt) throw new Error('shadow seal time must be a valid instant');
  const output = validateShadowPredictionOutput(input.output);
  assertUsage(input.modelUsage);
  const route = routeSummary(input.route);
  const observationEndsAt =
    asDate(input.observationEndsAt) ?? new Date(sealedAt.getTime() + SHADOW_OBSERVATION_WINDOW_MS);
  if (observationEndsAt.getTime() < sealedAt.getTime()) {
    throw new Error('shadow observation window cannot end before seal');
  }
  return {
    predictionKey: input.predictionKey,
    evaluationMode: SHADOW_EVALUATION_MODE,
    evaluationVersion: SHADOW_EVALUATION_VERSION,
    admissionStatus: 'admitted',
    predictionStatus: 'sealed',
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    asOfAt: input.frozen.asOfAt,
    sealedAt: sealedAt.toISOString(),
    observationEndsAt: observationEndsAt.toISOString(),
    sourceVintage: input.frozen.asOfAt,
    inputDigest: input.frozen.inputDigest,
    lineage: {
      messageIds: [...input.frozen.messageIds],
      attachmentIds: [...input.frozen.attachmentIds],
      excludedFutureMessageIds: [...input.frozen.excludedFutureMessageIds],
    },
    modelId: input.route.modelId,
    promptVersion: SHADOW_PROMPT_VERSION,
    route,
    modelUsage: { ...input.modelUsage },
    prediction: output,
  };
}

export function createUnavailableShadowPredictionSeal(input: {
  predictionKey: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  frozen: FrozenShadowInput;
  sealedAt: Date | string;
  reason: string;
  observationEndsAt?: Date | string;
}): ShadowPredictionSeal {
  const sealedAt = asDate(input.sealedAt);
  if (!sealedAt) throw new Error('shadow unavailable time must be a valid instant');
  const observationEndsAt =
    asDate(input.observationEndsAt) ?? new Date(sealedAt.getTime() + SHADOW_OBSERVATION_WINDOW_MS);
  return {
    predictionKey: input.predictionKey,
    evaluationMode: SHADOW_EVALUATION_MODE,
    evaluationVersion: SHADOW_EVALUATION_VERSION,
    admissionStatus: 'admitted',
    predictionStatus: 'unavailable',
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    asOfAt: input.frozen.asOfAt,
    sealedAt: sealedAt.toISOString(),
    observationEndsAt: observationEndsAt.toISOString(),
    sourceVintage: input.frozen.asOfAt,
    inputDigest: input.frozen.inputDigest,
    lineage: {
      messageIds: [...input.frozen.messageIds],
      attachmentIds: [...input.frozen.attachmentIds],
      excludedFutureMessageIds: [...input.frozen.excludedFutureMessageIds],
    },
    modelId: null,
    promptVersion: SHADOW_PROMPT_VERSION,
    route: null,
    modelUsage: null,
    prediction: null,
    unavailableReason: input.reason,
  };
}

export function createFailedShadowPredictionSeal(input: {
  predictionKey: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  frozen: FrozenShadowInput;
  sealedAt: Date | string;
  reason: string;
  observationEndsAt?: Date | string;
}): ShadowPredictionSeal {
  const unavailable = createUnavailableShadowPredictionSeal(input);
  return {
    ...unavailable,
    predictionStatus: 'failed',
    unavailableReason: input.reason,
  };
}

export function shadowPredictionPrompt(frozen: FrozenShadowInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  return {
    systemPrompt:
      'You are a private mail-evaluation shadow. Return only the strict structured output. Never send, create, edit, label, read, or close mail.',
    userPrompt: JSON.stringify({
      evaluationMode: SHADOW_EVALUATION_MODE,
      asOfAt: frozen.asOfAt,
      messages: frozen.modelMessages,
      attachments: frozen.attachmentIds,
      excludedFutureMessageCount: frozen.excludedFutureMessageIds.length,
    }),
  };
}

export function shadowPredictionKey(input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  experimentVersion?: string;
}): string {
  const canonical = [
    SHADOW_EVALUATION_VERSION,
    input.transportId,
    input.threadId,
    input.triggerMessageId,
    input.experimentVersion ?? 'default',
  ].join('\u001f');
  return `shadow-prediction:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export async function enqueueShadowPrediction(input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  db?: DB;
}): Promise<Awaited<ReturnType<typeof enqueueAiRun>>> {
  return enqueueAiRun(
    {
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
      runKind: 'shadow_prediction',
      idempotencyKey: shadowPredictionKey(input),
      modelId: 'approved-local',
      promptVersion: SHADOW_PROMPT_VERSION,
      executorLane: 'default',
    },
    input.db ?? getDb(),
  );
}

function predictionInsertValues(seal: ShadowPredictionSeal) {
  return {
    id: `shadow-prediction:${seal.predictionKey.replace(/^shadow-prediction:/, '')}`,
    predictionKey: seal.predictionKey,
    evaluationMode: seal.evaluationMode,
    evaluationVersion: seal.evaluationVersion,
    admissionStatus: seal.admissionStatus,
    predictionStatus: seal.predictionStatus,
    transportId: seal.transportId,
    threadId: seal.threadId,
    triggerMessageId: seal.triggerMessageId,
    asOfAt: new Date(seal.asOfAt),
    sealedAt: new Date(seal.sealedAt),
    observationEndsAt: new Date(seal.observationEndsAt),
    sourceVintage: seal.sourceVintage,
    inputDigest: seal.inputDigest,
    messageIds: seal.lineage.messageIds,
    attachmentIds: seal.lineage.attachmentIds,
    excludedFutureMessageIds: seal.lineage.excludedFutureMessageIds,
    modelId: seal.modelId,
    promptVersion: seal.promptVersion,
    route: seal.route,
    modelUsage: seal.modelUsage,
    prediction: seal.prediction,
    unavailableReason: seal.unavailableReason,
  };
}

type ShadowPredictionInsert = ReturnType<typeof predictionInsertValues>;

async function ensurePendingAssessment(db: DB, prediction: ShadowPredictionInsert): Promise<void> {
  await db
    .insert(aiShadowAssessment)
    .values({
      id: randomUUID(),
      predictionId: prediction.id,
      revision: 1,
      revisionKey: `${prediction.predictionKey}:pending`,
      evaluationMode: prediction.evaluationMode,
      status: 'pending',
      referenceMessageId: null,
      linkStrength: 'unknown',
      reason: 'awaiting_outbound_observation',
      labelProvenance: null,
      verdict: null,
      assessment: {},
    })
    .onConflictDoNothing({ target: aiShadowAssessment.revisionKey });
}

/** Insert a prediction once; retries return the original immutable row. */
export async function persistShadowPrediction(
  seal: ShadowPredictionSeal,
  db: DB = getDb(),
): Promise<{ row: typeof aiShadowPrediction.$inferSelect; inserted: boolean }> {
  const values = predictionInsertValues(seal);
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(aiShadowPrediction)
      .values(values)
      .onConflictDoNothing({ target: aiShadowPrediction.predictionKey })
      .returning();
    const row =
      inserted[0] ??
      (
        await tx
          .select()
          .from(aiShadowPrediction)
          .where(eq(aiShadowPrediction.predictionKey, seal.predictionKey))
          .limit(1)
      )[0];
    if (!row) throw new Error('shadow prediction insert did not return a row');
    await ensurePendingAssessment(tx as unknown as DB, values);
    return { row, inserted: inserted.length === 1 };
  });
}

export async function appendShadowAssessmentRevision(input: {
  predictionId: string;
  revisionKey: string;
  evaluationMode: ShadowEvaluationMode;
  status: ShadowReferenceMatch['status'] | 'unknown_coverage' | 'changed_state' | 'unscorable';
  referenceMessageId: string | null;
  linkStrength: 'header' | 'thread' | 'ambiguous' | 'unknown';
  reason: string;
  labelProvenance?: Record<string, unknown> | null;
  verdict?: 'correct' | 'partial' | 'incorrect' | null;
  assessment?: Record<string, unknown>;
  db?: DB;
}): Promise<{ row: typeof aiShadowAssessment.$inferSelect; inserted: boolean }> {
  const db = input.db ?? getDb();
  return db.transaction(async (tx) => {
    const [prediction] = await tx
      .select({ id: aiShadowPrediction.id, evaluationMode: aiShadowPrediction.evaluationMode })
      .from(aiShadowPrediction)
      .where(eq(aiShadowPrediction.id, input.predictionId))
      .limit(1)
      .for('update');
    if (!prediction) throw new Error('shadow prediction not found');
    if (prediction.evaluationMode !== input.evaluationMode) {
      throw new Error('shadow assessment evaluation mode mismatch');
    }
    const [existing] = await tx
      .select()
      .from(aiShadowAssessment)
      .where(eq(aiShadowAssessment.revisionKey, input.revisionKey))
      .limit(1);
    if (existing) return { row: existing, inserted: false };
    const [latest] = await tx
      .select({ revision: aiShadowAssessment.revision })
      .from(aiShadowAssessment)
      .where(eq(aiShadowAssessment.predictionId, input.predictionId))
      .orderBy(desc(aiShadowAssessment.revision))
      .limit(1);
    const [row] = await tx
      .insert(aiShadowAssessment)
      .values({
        id: randomUUID(),
        predictionId: input.predictionId,
        revision: (latest?.revision ?? 0) + 1,
        revisionKey: input.revisionKey,
        evaluationMode: input.evaluationMode,
        status: input.status,
        referenceMessageId: input.referenceMessageId,
        linkStrength: input.linkStrength,
        reason: input.reason,
        labelProvenance: input.labelProvenance ?? null,
        verdict: input.verdict ?? null,
        assessment: input.assessment ?? {},
      })
      .returning();
    if (!row) throw new Error('shadow assessment revision insert failed');
    return { row, inserted: true };
  });
}

function toMatcherPrediction(row: typeof aiShadowPrediction.$inferSelect, header: string | null) {
  return {
    id: row.id,
    transportId: row.transportId,
    threadId: row.threadId,
    triggerMessageId: row.triggerMessageId ?? '',
    triggerMessageIdHeader: header,
    asOfAt: row.asOfAt,
  };
}

async function loadShadowMessages(db: DB, prediction: typeof aiShadowPrediction.$inferSelect) {
  return db
    .select({
      id: message.id,
      transportId: message.transportId,
      threadId: message.threadId,
      direction: message.direction,
      createdAt: message.createdAt,
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      messageIdHeader: message.messageIdHeader,
      inReplyTo: message.inReplyTo,
      references: message.references,
    })
    .from(message)
    .where(
      and(
        eq(message.transportId, prediction.transportId),
        eq(message.threadId, prediction.threadId),
      ),
    )
    .orderBy(asc(message.createdAt), asc(message.id));
}

export async function rematchShadowPrediction(
  predictionId: string,
  db: DB = getDb(),
): Promise<ShadowReferenceMatch | null> {
  const [prediction] = await db
    .select()
    .from(aiShadowPrediction)
    .where(eq(aiShadowPrediction.id, predictionId))
    .limit(1);
  if (!prediction || prediction.predictionStatus !== 'sealed' || !prediction.triggerMessageId) {
    return null;
  }
  const [trigger] = await db
    .select({ messageIdHeader: message.messageIdHeader })
    .from(message)
    .where(eq(message.id, prediction.triggerMessageId))
    .limit(1);
  const rows = await loadShadowMessages(db, prediction);
  const match = matchShadowReference(
    toMatcherPrediction(prediction, trigger?.messageIdHeader ?? null),
    rows,
  );
  await appendShadowAssessmentRevision({
    predictionId,
    revisionKey: `${prediction.predictionKey}:${match.matchKey}`,
    evaluationMode: prediction.evaluationMode as ShadowEvaluationMode,
    status: match.status,
    referenceMessageId: match.referenceMessageId,
    linkStrength: match.linkStrength,
    reason: match.reason,
    db,
  });
  return match;
}

/** Re-evaluate only this committed outbound thread; no message state changes. */
export async function rematchShadowPredictions(input: {
  transportId: string;
  threadId: string;
  outboundMessageId: string;
  db?: DB;
}): Promise<number> {
  const db = input.db ?? getDb();
  const [outbound] = await db
    .select({
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.id, input.outboundMessageId),
        eq(message.transportId, input.transportId),
        eq(message.threadId, input.threadId),
        eq(message.direction, 'outbound'),
      ),
    )
    .limit(1);
  if (!outbound) return 0;
  const outboundAt = outbound.sentAt ?? outbound.receivedAt ?? outbound.createdAt;
  const rows = await db
    .select()
    .from(aiShadowPrediction)
    .where(
      and(
        eq(aiShadowPrediction.transportId, input.transportId),
        eq(aiShadowPrediction.threadId, input.threadId),
        eq(aiShadowPrediction.predictionStatus, 'sealed'),
        lte(aiShadowPrediction.asOfAt, outboundAt),
      ),
    )
    .orderBy(asc(aiShadowPrediction.asOfAt), asc(aiShadowPrediction.id));
  for (const prediction of rows) await rematchShadowPrediction(prediction.id, db);
  return rows.length;
}

/** Turn matured pending seals into explicit unobserved revisions in bounded batches. */
export async function assessDueShadowPredictions(
  input: {
    now?: Date;
    limit?: number;
    db?: DB;
  } = {},
): Promise<{ processed: number; matches: ShadowReferenceMatch[] }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await db
    .select()
    .from(aiShadowPrediction)
    .where(
      and(
        eq(aiShadowPrediction.predictionStatus, 'sealed'),
        lte(aiShadowPrediction.observationEndsAt, now),
      ),
    )
    .orderBy(asc(aiShadowPrediction.observationEndsAt), asc(aiShadowPrediction.id))
    .limit(limit);
  const matches: ShadowReferenceMatch[] = [];
  for (const prediction of rows) {
    const match = await rematchShadowPrediction(prediction.id, db);
    if (!match) continue;
    if (match.status === 'unmatched') {
      const unobserved: ShadowReferenceMatch = {
        ...match,
        status: 'unobserved',
        reason: 'observation_window_ended_without_verified_reference',
        matchKey: `${match.matchKey}:unobserved`,
      };
      await appendShadowAssessmentRevision({
        predictionId: prediction.id,
        revisionKey: `${prediction.predictionKey}:${unobserved.matchKey}`,
        evaluationMode: prediction.evaluationMode as ShadowEvaluationMode,
        status: unobserved.status,
        referenceMessageId: null,
        linkStrength: 'unknown',
        reason: unobserved.reason,
        db,
      });
      matches.push(unobserved);
    } else {
      matches.push(match);
    }
  }
  return { processed: rows.length, matches };
}

export async function loadShadowScorecard(
  input: {
    evaluationMode?: ShadowEvaluationMode;
    transportIds?: readonly string[];
    observationCutoff?: Date;
    db?: DB;
  } = {},
): Promise<ShadowScorecard> {
  const db = input.db ?? getDb();
  const mode = input.evaluationMode ?? SHADOW_EVALUATION_MODE;
  const predicates = [eq(aiShadowPrediction.evaluationMode, mode)];
  if (input.transportIds?.length)
    predicates.push(inArray(aiShadowPrediction.transportId, [...input.transportIds]));
  if (input.observationCutoff)
    predicates.push(lte(aiShadowPrediction.sealedAt, input.observationCutoff));
  const predictions = await db
    .select()
    .from(aiShadowPrediction)
    .where(and(...predicates))
    .orderBy(asc(aiShadowPrediction.createdAt), asc(aiShadowPrediction.id));
  const predictionIds = predictions.map((row) => row.id);
  const assessments = predictionIds.length
    ? await db
        .select()
        .from(aiShadowAssessment)
        .where(
          and(
            eq(aiShadowAssessment.evaluationMode, mode),
            inArray(aiShadowAssessment.predictionId, predictionIds),
          ),
        )
        .orderBy(asc(aiShadowAssessment.createdAt), asc(aiShadowAssessment.id))
    : [];
  const predictionRows: ShadowPredictionScorecardRow[] = predictions.map((row) => ({
    id: row.id,
    evaluationMode: row.evaluationMode as ShadowEvaluationMode,
    admissionStatus: row.admissionStatus as ShadowPredictionScorecardRow['admissionStatus'],
    predictionStatus: row.predictionStatus as ShadowPredictionScorecardRow['predictionStatus'],
  }));
  const assessmentRows: ShadowAssessmentScorecardRow[] = assessments.map((row) => ({
    predictionId: row.predictionId,
    evaluationMode: row.evaluationMode as ShadowEvaluationMode,
    status: row.status as ShadowAssessmentScorecardRow['status'],
    labelProvenance: row.labelProvenance as ShadowAssessmentScorecardRow['labelProvenance'],
    verdict: (row.verdict as ShadowAssessmentScorecardRow['verdict']) ?? null,
  }));
  return buildShadowScorecard({
    evaluationMode: mode,
    predictions: predictionRows,
    assessments: assessmentRows,
  });
}
