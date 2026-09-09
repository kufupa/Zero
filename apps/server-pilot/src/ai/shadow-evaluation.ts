import {
  buildShadowAdmissionPopulation,
  buildShadowScorecard,
  type ShadowAdmissionPopulationRow,
  type ShadowAssessmentScorecardRow,
  type ShadowPredictionScorecardRow,
  type ShadowScorecard,
} from '../metrics/shadow-scorecard.js';
import {
  aiShadowAdmission,
  aiShadowAssessment,
  aiShadowPrediction,
} from '../db/schema/ai-shadow-evaluation.js';
import { matchShadowReference, type ShadowReferenceMatch } from './shadow-reference-matcher.js';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { LocalModelRouteEvidence } from './bedrock/local.js';
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
export const SHADOW_RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Proposed local predicate ceiling; this is not a live default. */
export const SHADOW_ADMISSION_CAP = 100;
export const SHADOW_REQUEST_GENERATION = 'shadow-request-v1';
const SHADOW_ADMISSION_CAP_ENV = 'AI_SHADOW_ADMISSION_CAP_PER_DAY';
const SHADOW_CAP_SCOPE_ENV = 'AI_SHADOW_CAP_SCOPE';
const SHADOW_TOKEN_CAP_ENV = 'AI_SHADOW_TOKEN_CAP_PER_DAY';
const SHADOW_SPEND_CAP_ENV = 'AI_SHADOW_SPEND_CAP_USD_PER_DAY';
const SHADOW_BROWSER_CAP_ENV = 'AI_SHADOW_BROWSER_CAP_PER_DAY';
const SHADOW_EXECUTION_MODE_ENV = 'AI_SHADOW_EXECUTION_MODE';
const SHADOW_LOCAL_SYNTHETIC_EXECUTION_MODE = 'local_synthetic';
const SHADOW_TOKEN_CAP_MAX = 1_000_000;
const SHADOW_SPEND_CAP_USD_MAX = 100_000;
const SHADOW_BROWSER_CAP_MAX = 100;
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
  /** Persisted availability clock; old callers fall back to createdAt. */
  availableAt?: Date | null;
  attachmentIds: readonly string[];
};

export type FrozenShadowInput = {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  /** Availability clock at which the frozen context became observable. */
  observedAt: string;
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
    observedAt: string;
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

function messageAvailableAt(message: ShadowMessageInput): Date | null {
  return asDate(message.availableAt ?? message.createdAt);
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
  const triggerAvailableAt = messageAvailableAt(trigger);
  if (!triggerAvailableAt || triggerAvailableAt.getTime() > asOf.getTime()) {
    throw new Error('shadow prediction trigger is not available at the as-of horizon');
  }

  const ordered = [...input.messages].sort((left, right) => {
    const leftAt = messageEventAt(left)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const rightAt = messageEventAt(right)?.getTime() ?? Number.NEGATIVE_INFINITY;
    return leftAt - rightAt || left.id.localeCompare(right.id);
  });
  const included = ordered.filter((message) => {
    const at = messageAvailableAt(message)?.getTime();
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
    const observedAt = messageAvailableAt(message);
    if (!observedAt) throw new Error(`shadow message ${message.id} has no availability clock`);
    return {
      id: message.id,
      direction: message.direction,
      subject: message.subject,
      text: normalizedText(message),
      eventAt: eventAt.toISOString(),
      observedAt: observedAt.toISOString(),
    };
  });
  const attachmentIds = [...new Set(included.flatMap((message) => message.attachmentIds))].sort();
  const inputDigest = digest({
    version: SHADOW_EVALUATION_VERSION,
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    observedAt: asOf.toISOString(),
    asOfAt: asOf.toISOString(),
    modelMessages,
    attachmentIds,
  });
  return {
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    observedAt: asOf.toISOString(),
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
  observedAt: string;
  asOfAt: string;
  sealedAt: string;
  observationEndsAt: string;
  retentionExpiresAt: string;
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
  const retentionExpiresAt = new Date(sealedAt.getTime() + SHADOW_RETENTION_WINDOW_MS);
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
    observedAt: input.frozen.observedAt,
    asOfAt: input.frozen.asOfAt,
    sealedAt: sealedAt.toISOString(),
    observationEndsAt: observationEndsAt.toISOString(),
    retentionExpiresAt: retentionExpiresAt.toISOString(),
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
  const retentionExpiresAt = new Date(sealedAt.getTime() + SHADOW_RETENTION_WINDOW_MS);
  return {
    predictionKey: input.predictionKey,
    evaluationMode: SHADOW_EVALUATION_MODE,
    evaluationVersion: SHADOW_EVALUATION_VERSION,
    admissionStatus: 'admitted',
    predictionStatus: 'unavailable',
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    observedAt: input.frozen.observedAt,
    asOfAt: input.frozen.asOfAt,
    sealedAt: sealedAt.toISOString(),
    observationEndsAt: observationEndsAt.toISOString(),
    retentionExpiresAt: retentionExpiresAt.toISOString(),
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

export function shadowAdmissionReleaseId(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  // Only the server-owned descriptor participates in identity. Resolving this
  // string never imports or initializes the configured route module.
  const descriptor = [
    env.AI_MODEL_ROUTE?.trim() || 'route-unconfigured',
    env.AI_APPROVED_LOCAL_SHADOW_CONFIG?.trim() || 'config-unconfigured',
  ].join('\u001f');
  return `${SHADOW_EVALUATION_VERSION}:${digest(descriptor).slice(0, 32)}`;
}

export function shadowAdmissionContextDigest(input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
}): string {
  return digest({
    contextVersion: 'shadow-context-v1',
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
  });
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function shadowPredictionKey(input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  experimentVersion?: string;
  releaseId?: string;
  contextDigest?: string;
  requestGeneration?: string;
}): string {
  const releaseId = input.releaseId ?? shadowAdmissionReleaseId();
  const contextDigest =
    input.contextDigest ??
    shadowAdmissionContextDigest({
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
    });
  const requestGeneration = input.requestGeneration ?? SHADOW_REQUEST_GENERATION;
  const canonical = [
    SHADOW_EVALUATION_VERSION,
    releaseId,
    contextDigest,
    requestGeneration,
    input.transportId,
    input.threadId,
    input.triggerMessageId,
    input.experimentVersion ?? 'default',
  ].join('\u001f');
  return `shadow-prediction:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function shouldAdmitShadowPrediction(input: {
  admittedCount: number;
  cap?: number;
}): boolean {
  const cap = Math.min(Math.max(input.cap ?? SHADOW_ADMISSION_CAP, 1), SHADOW_ADMISSION_CAP);
  return (
    Number.isInteger(input.admittedCount) && input.admittedCount >= 0 && input.admittedCount < cap
  );
}

export type ShadowAdmissionPolicy = {
  cap: number;
  scope: string;
  tokenCap: number;
  spendCapUsd: number;
  browserCap: number;
};

/**
 * Admission is fail-closed until the operator supplies every required bounded
 * per-property/day policy. The token, spend, and browser values are explicit
 * prerequisites for the local synthetic lane; this module does not claim to
 * meter live usage. The exported predicate above is still useful for local
 * deterministic tests, but it is never the runtime policy default.
 */
export function resolveShadowAdmissionPolicy(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ShadowAdmissionPolicy | null {
  const executionMode = env[SHADOW_EXECUTION_MODE_ENV]?.trim();
  // The local fixture is the only currently executable shadow lane. A missing
  // or costly/live mode is unavailable before queue/model construction; the
  // declarations below are not treated as live token, spend, or browser
  // metering merely because they are present.
  if (executionMode !== SHADOW_LOCAL_SYNTHETIC_EXECUTION_MODE) return null;
  const rawCap = env[SHADOW_ADMISSION_CAP_ENV]?.trim();
  const scope = env[SHADOW_CAP_SCOPE_ENV]?.trim();
  const rawTokenCap = env[SHADOW_TOKEN_CAP_ENV]?.trim();
  const rawSpendCapUsd = env[SHADOW_SPEND_CAP_ENV]?.trim();
  const rawBrowserCap = env[SHADOW_BROWSER_CAP_ENV]?.trim();
  if (!rawCap || !scope || !rawTokenCap || !rawSpendCapUsd || !rawBrowserCap) return null;
  const cap = Number(rawCap);
  if (!Number.isInteger(cap) || cap < 1 || cap > SHADOW_ADMISSION_CAP) return null;
  const tokenCap = Number(rawTokenCap);
  if (!Number.isInteger(tokenCap) || tokenCap < 1 || tokenCap > SHADOW_TOKEN_CAP_MAX) return null;
  const spendCapUsd = Number(rawSpendCapUsd);
  if (!Number.isFinite(spendCapUsd) || spendCapUsd <= 0 || spendCapUsd > SHADOW_SPEND_CAP_USD_MAX) {
    return null;
  }
  const browserCap = Number(rawBrowserCap);
  if (!Number.isInteger(browserCap) || browserCap < 1 || browserCap > SHADOW_BROWSER_CAP_MAX) {
    return null;
  }
  return { cap, scope, tokenCap, spendCapUsd, browserCap };
}

export async function enqueueShadowPrediction(input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  db?: DB;
}): Promise<Awaited<ReturnType<typeof enqueueAiRun>> | null> {
  const targetDb = input.db ?? getDb();
  const now = new Date();
  const releaseId = shadowAdmissionReleaseId();
  const contextDigest = shadowAdmissionContextDigest(input);
  const requestGeneration = SHADOW_REQUEST_GENERATION;
  const policy = resolveShadowAdmissionPolicy();
  const admissionKey = shadowPredictionKey({
    ...input,
    releaseId,
    contextDigest,
    requestGeneration,
  });
  const capBucketAt = utcDayStart(now);
  const retentionExpiresAt = new Date(now.getTime() + SHADOW_RETENTION_WINDOW_MS);

  const admit = async (tx: DB): Promise<Awaited<ReturnType<typeof enqueueAiRun>> | null> => {
    const [existing] = await tx
      .select()
      .from(aiShadowAdmission)
      .where(eq(aiShadowAdmission.admissionKey, admissionKey))
      .limit(1)
      .for('update');
    if (!policy) {
      if (!existing) {
        await tx.insert(aiShadowAdmission).values({
          id: randomUUID(),
          admissionKey,
          evaluationMode: SHADOW_EVALUATION_MODE,
          evaluationVersion: SHADOW_EVALUATION_VERSION,
          eligible: true,
          admissionStatus: 'skipped',
          reason:
            process.env[SHADOW_EXECUTION_MODE_ENV]?.trim() === SHADOW_LOCAL_SYNTHETIC_EXECUTION_MODE
              ? 'admission_cap_unconfigured'
              : 'admission_live_disabled',
          transportId: input.transportId,
          threadId: input.threadId,
          triggerMessageId: input.triggerMessageId,
          releaseId,
          contextDigest,
          requestGeneration,
          capBucketAt,
          retentionExpiresAt,
        });
      }
      return null;
    }
    if (existing?.admissionStatus === 'skipped' || existing?.admissionStatus === 'denied') {
      return null;
    }
    if (existing?.admissionStatus === 'admitted') {
      return enqueueAiRun(
        {
          transportId: input.transportId,
          threadId: input.threadId,
          triggerMessageId: input.triggerMessageId,
          runKind: 'shadow_prediction',
          idempotencyKey: admissionKey,
          modelId: 'approved-local',
          promptVersion: SHADOW_PROMPT_VERSION,
          executorLane: 'default',
        },
        tx as unknown as DB,
      );
    }

    // Serialize the configured property/day counter without introducing a
    // broad queue service. Release and mailbox are deliberately not counter
    // dimensions, so neither can reset the applicable cap.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`shadow-admission:${policy.scope}:${capBucketAt.toISOString()}`}))`,
    );
    const admitted = await tx
      .select({ id: aiShadowAdmission.id })
      .from(aiShadowAdmission)
      .where(
        and(
          eq(aiShadowAdmission.evaluationMode, SHADOW_EVALUATION_MODE),
          eq(aiShadowAdmission.capBucketAt, capBucketAt),
          eq(aiShadowAdmission.admissionStatus, 'admitted'),
        ),
      );
    const admittedWithinCap = shouldAdmitShadowPrediction({
      admittedCount: admitted.length,
      cap: policy.cap,
    });
    const admissionStatus = admittedWithinCap ? 'admitted' : 'skipped';
    const reason = admittedWithinCap
      ? 'admitted_within_daily_cap'
      : 'daily_admission_cap_exhausted';
    if (!existing) {
      await tx.insert(aiShadowAdmission).values({
        id: randomUUID(),
        admissionKey,
        evaluationMode: SHADOW_EVALUATION_MODE,
        evaluationVersion: SHADOW_EVALUATION_VERSION,
        eligible: true,
        admissionStatus,
        reason,
        transportId: input.transportId,
        threadId: input.threadId,
        triggerMessageId: input.triggerMessageId,
        releaseId,
        contextDigest,
        requestGeneration,
        capBucketAt,
        retentionExpiresAt,
      });
    }
    if (!admittedWithinCap) return null;
    return enqueueAiRun(
      {
        transportId: input.transportId,
        threadId: input.threadId,
        triggerMessageId: input.triggerMessageId,
        runKind: 'shadow_prediction',
        idempotencyKey: admissionKey,
        modelId: 'approved-local',
        promptVersion: SHADOW_PROMPT_VERSION,
        executorLane: 'default',
      },
      tx,
    );
  };
  // Normal ingest already owns the encompassing mail transaction. Avoid a
  // second connection/savepoint there so the admission and run are visible
  // to the same committed producer. A direct operational caller gets its own
  // transaction and retains the same lock/idempotency fence.
  return input.db ? admit(targetDb) : targetDb.transaction((tx) => admit(tx as unknown as DB));
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
    observedAt: new Date(seal.observedAt),
    asOfAt: new Date(seal.asOfAt),
    sealedAt: new Date(seal.sealedAt),
    observationEndsAt: new Date(seal.observationEndsAt),
    retentionExpiresAt: new Date(seal.retentionExpiresAt),
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
  db?: DB,
): Promise<{ row: typeof aiShadowPrediction.$inferSelect; inserted: boolean }> {
  const values = predictionInsertValues(seal);
  const targetDb = db ?? getDb();
  const persist = async (tx: DB) => {
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
    await ensurePendingAssessment(tx, values);
    return { row, inserted: inserted.length === 1 };
  };
  // Worker execution is already inside the claimed run's DB scope. Keep the
  // seal and its first pending revision in that same transaction when a DB
  // handle is supplied; standalone callers receive an atomic transaction.
  return db ? persist(targetDb) : targetDb.transaction((tx) => persist(tx as unknown as DB));
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
  options: { appendUnmatched?: boolean } = {},
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
  const rows = (await loadShadowMessages(db, prediction)).filter(
    (row) => row.createdAt.getTime() <= prediction.observationEndsAt.getTime(),
  );
  const match = matchShadowReference(
    toMatcherPrediction(prediction, trigger?.messageIdHeader ?? null),
    rows,
  );
  if (match.status !== 'unmatched' || options.appendUnmatched !== false) {
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
  }
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
  const outboundAvailableAt = outbound.createdAt;
  const rows = await db
    .select()
    .from(aiShadowPrediction)
    .where(
      and(
        eq(aiShadowPrediction.transportId, input.transportId),
        eq(aiShadowPrediction.threadId, input.threadId),
        eq(aiShadowPrediction.predictionStatus, 'sealed'),
        gt(aiShadowPrediction.observationEndsAt, outboundAvailableAt),
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
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(aiShadowPrediction)
      .where(
        and(
          eq(aiShadowPrediction.predictionStatus, 'sealed'),
          lte(aiShadowPrediction.observationEndsAt, now),
        ),
      )
      .orderBy(asc(aiShadowPrediction.observationEndsAt), asc(aiShadowPrediction.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    const matches: ShadowReferenceMatch[] = [];
    for (const prediction of rows) {
      const [latest] = await tx
        .select({ status: aiShadowAssessment.status })
        .from(aiShadowAssessment)
        .where(eq(aiShadowAssessment.predictionId, prediction.id))
        .orderBy(desc(aiShadowAssessment.revision))
        .limit(1);
      if (
        latest &&
        [
          'matched',
          'late',
          'ambiguous',
          'unobserved',
          'unknown_coverage',
          'changed_state',
          'unscorable',
        ].includes(latest.status)
      ) {
        continue;
      }
      const match = await rematchShadowPrediction(prediction.id, tx as unknown as DB, {
        appendUnmatched: false,
      });
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
          db: tx as unknown as DB,
        });
        matches.push(unobserved);
      } else {
        await appendShadowAssessmentRevision({
          predictionId: prediction.id,
          revisionKey: `${prediction.predictionKey}:${match.matchKey}`,
          evaluationMode: prediction.evaluationMode as ShadowEvaluationMode,
          status: match.status,
          referenceMessageId: match.referenceMessageId,
          linkStrength: match.linkStrength,
          reason: match.reason,
          db: tx as unknown as DB,
        });
        matches.push(match);
      }
    }
    return { processed: rows.length, matches };
  });
}

/** Delete only expired private U13 derivatives in bounded batches. */
export async function purgeExpiredShadowDerivatives(
  input: { now?: Date; limit?: number; db?: DB } = {},
): Promise<{ deletedPredictions: number; deletedAdmissions: number }> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: aiShadowPrediction.id, predictionKey: aiShadowPrediction.predictionKey })
      .from(aiShadowPrediction)
      .where(
        and(
          eq(aiShadowPrediction.evaluationMode, SHADOW_EVALUATION_MODE),
          lte(aiShadowPrediction.retentionExpiresAt, now),
        ),
      )
      .orderBy(asc(aiShadowPrediction.retentionExpiresAt), asc(aiShadowPrediction.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    const ids = rows.map((row) => row.id);
    const keys = rows.map((row) => row.predictionKey);
    let deletedPredictions = 0;
    let deletedAdmissions = 0;
    if (ids.length > 0) {
      // Assessment payloads are the body-bearing derivative; remove them before
      // their prediction parent, then remove the accounting receipt in scope.
      await tx.delete(aiShadowAssessment).where(inArray(aiShadowAssessment.predictionId, ids));
      const deletedPredictionRows = await tx
        .delete(aiShadowPrediction)
        .where(inArray(aiShadowPrediction.id, ids))
        .returning({ id: aiShadowPrediction.id });
      deletedPredictions = deletedPredictionRows.length;
      const deletedAdmissionRows = await tx
        .delete(aiShadowAdmission)
        .where(inArray(aiShadowAdmission.admissionKey, keys))
        .returning({ id: aiShadowAdmission.id });
      deletedAdmissions += deletedAdmissionRows.length;
    }

    // Admission receipts can expire before a prediction exists: skipped
    // receipts never queue, and policy-fenced queued work can dead-letter
    // without sealing. Select only true orphans so a receipt linked to an
    // unexpired prediction remains available for its retained derivative.
    const orphanRows = await tx
      .select({ id: aiShadowAdmission.id })
      .from(aiShadowAdmission)
      .where(
        and(
          eq(aiShadowAdmission.evaluationMode, SHADOW_EVALUATION_MODE),
          lte(aiShadowAdmission.retentionExpiresAt, now),
          sql`not exists (
            select 1
            from ${aiShadowPrediction}
            where ${aiShadowPrediction.predictionKey} = ${aiShadowAdmission.admissionKey}
          )`,
        ),
      )
      .orderBy(asc(aiShadowAdmission.retentionExpiresAt), asc(aiShadowAdmission.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (orphanRows.length > 0) {
      const orphanIds = orphanRows.map((row) => row.id);
      const deletedOrphanRows = await tx
        .delete(aiShadowAdmission)
        .where(inArray(aiShadowAdmission.id, orphanIds))
        .returning({ id: aiShadowAdmission.id });
      deletedAdmissions += deletedOrphanRows.length;
    }
    return {
      deletedPredictions,
      deletedAdmissions,
    };
  });
}

export async function loadShadowScorecard(
  input: {
    evaluationMode?: ShadowEvaluationMode;
    transportIds?: readonly string[];
    windowStart?: Date;
    windowEnd?: Date;
    observationCutoff?: Date;
    db?: DB;
  } = {},
): Promise<ShadowScorecard> {
  const db = input.db ?? getDb();
  const mode = input.evaluationMode ?? SHADOW_EVALUATION_MODE;
  const predicates = [eq(aiShadowPrediction.evaluationMode, mode)];
  if (input.transportIds?.length)
    predicates.push(inArray(aiShadowPrediction.transportId, [...input.transportIds]));
  if (input.windowStart) predicates.push(gte(aiShadowPrediction.sealedAt, input.windowStart));
  if (input.windowEnd) predicates.push(lt(aiShadowPrediction.sealedAt, input.windowEnd));
  if (input.observationCutoff)
    predicates.push(lte(aiShadowPrediction.sealedAt, input.observationCutoff));
  const predictions = await db
    .select()
    .from(aiShadowPrediction)
    .where(and(...predicates))
    .orderBy(asc(aiShadowPrediction.createdAt), asc(aiShadowPrediction.id));
  const predictionIds = predictions.map((row) => row.id);
  const admissionPredicates = [eq(aiShadowAdmission.evaluationMode, mode)];
  if (input.transportIds?.length)
    admissionPredicates.push(inArray(aiShadowAdmission.transportId, [...input.transportIds]));
  if (input.observationCutoff)
    admissionPredicates.push(lte(aiShadowAdmission.createdAt, input.observationCutoff));
  const admissions = await db
    .select()
    .from(aiShadowAdmission)
    .where(and(...admissionPredicates));
  const admissionKeys = admissions.map((row) => row.admissionKey);
  const observablePredictions = admissionKeys.length
    ? await db
        .select({ predictionKey: aiShadowPrediction.predictionKey })
        .from(aiShadowPrediction)
        .where(
          and(
            eq(aiShadowPrediction.evaluationMode, mode),
            eq(aiShadowPrediction.predictionStatus, 'sealed'),
            ...(input.transportIds?.length
              ? [inArray(aiShadowPrediction.transportId, [...input.transportIds])]
              : []),
            inArray(aiShadowPrediction.predictionKey, admissionKeys),
            ...(input.observationCutoff
              ? [lte(aiShadowPrediction.sealedAt, input.observationCutoff)]
              : []),
          ),
        )
    : [];
  const observablePredictionKeys = new Set(observablePredictions.map((row) => row.predictionKey));
  const admissionPopulationAdmissions = admissions.filter((row) => {
    const createdAt = row.createdAt.getTime();
    return (
      (!input.windowStart || createdAt >= input.windowStart.getTime()) &&
      (!input.windowEnd || createdAt < input.windowEnd.getTime())
    );
  });
  const admissionPopulationRows: ShadowAdmissionPopulationRow[] = admissionPopulationAdmissions.map(
    (row) => ({
      id: row.id,
      evaluationMode: row.evaluationMode as ShadowEvaluationMode,
      eligible: row.eligible,
      admissionStatus: row.admissionStatus as ShadowAdmissionPopulationRow['admissionStatus'],
      hasSealedPrediction: observablePredictionKeys.has(row.admissionKey),
    }),
  );
  const assessments = predictionIds.length
    ? await db
        .select()
        .from(aiShadowAssessment)
        .where(
          and(
            eq(aiShadowAssessment.evaluationMode, mode),
            inArray(aiShadowAssessment.predictionId, predictionIds),
            ...(input.observationCutoff
              ? [lte(aiShadowAssessment.createdAt, input.observationCutoff)]
              : []),
          ),
        )
        .orderBy(
          asc(aiShadowAssessment.predictionId),
          asc(aiShadowAssessment.revision),
          asc(aiShadowAssessment.id),
        )
    : [];
  const predictionsByKey = new Map(predictions.map((row) => [row.predictionKey, row]));
  const predictionRows: ShadowPredictionScorecardRow[] = [];
  const seenPredictionIds = new Set<string>();
  for (const admission of admissions) {
    const prediction = predictionsByKey.get(admission.admissionKey);
    // This scorecard's declared clock is sealed_at. Admission-only receipts
    // belong to a separate operational population and must not be relabelled
    // as pending sealed predictions when their seal falls outside the window.
    if (!prediction) continue;
    seenPredictionIds.add(prediction.id);
    predictionRows.push({
      id: admission.admissionKey,
      predictionId: prediction.id,
      evaluationMode: admission.evaluationMode as ShadowEvaluationMode,
      admissionStatus: admission.admissionStatus as ShadowPredictionScorecardRow['admissionStatus'],
      predictionStatus:
        prediction.predictionStatus as ShadowPredictionScorecardRow['predictionStatus'],
    });
  }
  // Preserve compatibility with additive migration deployments and older
  // private rows that predate the admission receipt table.
  for (const row of predictions) {
    if (seenPredictionIds.has(row.id)) continue;
    predictionRows.push({
      id: row.id,
      predictionId: row.id,
      evaluationMode: row.evaluationMode as ShadowEvaluationMode,
      admissionStatus: row.admissionStatus as ShadowPredictionScorecardRow['admissionStatus'],
      predictionStatus: row.predictionStatus as ShadowPredictionScorecardRow['predictionStatus'],
    });
  }
  const assessmentRows: ShadowAssessmentScorecardRow[] = assessments.map((row) => ({
    predictionId: row.predictionId,
    revision: row.revision,
    createdAt: row.createdAt,
    evaluationMode: row.evaluationMode as ShadowEvaluationMode,
    status: row.status as ShadowAssessmentScorecardRow['status'],
    labelProvenance: row.labelProvenance as ShadowAssessmentScorecardRow['labelProvenance'],
    verdict: (row.verdict as ShadowAssessmentScorecardRow['verdict']) ?? null,
  }));
  const scorecard = buildShadowScorecard({
    evaluationMode: mode,
    predictions: predictionRows,
    assessments: assessmentRows,
    admissionPopulation: buildShadowAdmissionPopulation({
      evaluationMode: mode,
      admissions: admissionPopulationRows,
      windowStart: input.windowStart?.toISOString() ?? null,
      windowEnd: input.windowEnd?.toISOString() ?? null,
      observationCutoff: input.observationCutoff?.toISOString() ?? null,
    }),
  });
  return {
    ...scorecard,
    provenance: {
      ...scorecard.provenance,
      selectionClock: 'sealed_at',
      windowStart: input.windowStart?.toISOString() ?? null,
      windowEnd: input.windowEnd?.toISOString() ?? null,
      observationCutoff: input.observationCutoff?.toISOString() ?? null,
    },
  };
}
