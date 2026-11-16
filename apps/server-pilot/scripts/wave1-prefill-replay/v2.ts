import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { message, aiWorkflowRun } from '../../src/db/schema/mail.js';
import type { DB } from '../../src/db/client.js';
import type { ModelAdapter, ModelInvokeInput } from '../../src/ai/bedrock/adapter.js';
import { MESSAGE_ARRIVED_AT } from '../../src/ai/message-arrival-time.js';
import { staffQuoteSourceHash } from '../../src/ai/staff-quote-workflow.js';
import { reservationArrivalEvidence } from '../../src/ai/reservation-workflow-v2-evidence.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../../src/ai/quote-workflow-synced-selection.js';
import {
  checkpointReservationWorkflowV2Extraction,
  claimReservationWorkflowV2Prefill,
  finishReservationWorkflowV2Prefill,
  getReservationWorkflowV2Draft,
  initializeReservationWorkflowV2Draft,
} from '../../src/ai/reservation-workflow-v2-state.js';
import {
  runReservationWorkflowV2Prefill,
  type ReservationWorkflowV2CandidateRead,
  type ReservationWorkflowV2ReadResult,
} from '../../src/ai/reservation-workflow-v2-prefill.js';
import { runReservationArrivalChecks } from '../../src/ai/reservation-workflow-v2-arrival-checks.js';
import { reservationWorkflowV2PreparationViews } from '../../src/ai/reservation-workflow-v2-tools.js';
import { createAzureExtractionAdapter } from '../../src/ai/extraction/extract.js';
import { createTrpcReservationWorkflowClient } from '../../../mail/lib/reservation-workflow/client.js';
import type { EvidenceGateway } from './cache.js';
import { assertReplayIsolation } from './runtime.js';

const PREFILL_TIMEOUT_MS = 9 * 60_000;
const NATIVE_CHECK_TIMEOUT_MS = 7 * 60_000;

export const SIMPLE_SYNTHESIS_FLAG_ENV = 'PREFILL_SIMPLE_SYNTHESIS';
/** Diagnostic flag shared by both arms; only an explicit on-value enables the medium-effort channel. */
export function simpleSynthesisDiagnosticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SIMPLE_SYNTHESIS_FLAG_ENV]?.trim();
  if (raw === undefined || raw === '' || raw === 'off' || raw === 'false' || raw === '0') return false;
  if (raw === 'on' || raw === 'true' || raw === '1') return true;
  throw new Error(`env ${SIMPLE_SYNTHESIS_FLAG_ENV} must be on|off|true|false|1|0, got: ${raw}`);
}

type CandidateTrace = {
  candidate: ReservationWorkflowV2CandidateRead;
  raw: ReservationWorkflowV2ReadResult | null;
  delivered: ReservationWorkflowV2ReadResult | null;
  observedAt: string;
  nativeReaderMode: 'production-default';
  reconstruction: 'admitted-production-observation';
  error?: string;
};

type ModelCall = {
  callNumber: number;
  startedAt: string;
  finishedAt?: string;
  /** Which harness-built adapter served the call; 'primary' covers extraction and baseline synthesis. */
  channel: 'primary' | 'simple_synthesis';
  /** Configured reasoning effort of that channel, not a property of the response. */
  reasoningEffort: 'high' | 'medium';
  /** Actual route copied from result provenance; absent on error. */
  routeId?: string;
  protocol?: string;
  input: unknown;
  result?: unknown;
  error?: string;
};

export type ReplayExecutionTrace = {
  source: { threadId: string; messageId: string; sourceHash: string; arrivedAt: string };
  sender: string | null;
  selection?: Awaited<ReturnType<typeof loadSyncedQuoteSelectionFromMailbox>>;
  evidenceHash?: string;
  modelCalls: ModelCall[];
  candidateReads: CandidateTrace[];
  nativeStatus: string;
  nativeReaderMode?: 'production-default';
  errors: string[];
};

export class ReplayExecutionError extends Error {
  constructor(cause: unknown, readonly trace: ReplayExecutionTrace) {
    super(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause), { cause });
    this.name = 'ReplayExecutionError';
  }
}

function describeModelInput(input: ModelInvokeInput) {
  const describeFile = (file: { filename: string; mediaType: string; data: Uint8Array }) => ({
    filename: file.filename,
    mediaType: file.mediaType,
    bytes: file.data.byteLength,
    sha256: createHash('sha256').update(file.data).digest('hex'),
  });
  return {
    modelId: input.modelId,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    responseSchema: input.responseSchema,
    maxOutputTokens: input.maxOutputTokens,
    maxInputBytes: input.maxInputBytes,
    deadlineAt: input.deadlineAt,
    files: (input.files ?? []).map(describeFile),
    images: (input.images ?? []).map(describeFile),
  };
}

function traceModel(adapter: ModelAdapter | null, calls: ModelCall[], channel: ModelCall['channel'],
  reasoningEffort: ModelCall['reasoningEffort']): ModelAdapter | null {
  if (!adapter) return null;
  return {
    ...(adapter.reserveCalls ? { reserveCalls: adapter.reserveCalls.bind(adapter) } : {}),
    async invoke(input) {
      const call: ModelCall = { callNumber: calls.length + 1, startedAt: new Date().toISOString(), channel,
        reasoningEffort, input: describeModelInput(input) };
      calls.push(call);
      try {
        const result = await adapter.invoke(input);
        call.result = result;
        call.routeId = result.provenance?.routeId;
        call.protocol = result.provenance?.protocol;
        return result;
      } catch (error) {
        call.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw error;
      } finally {
        call.finishedAt = new Date().toISOString();
      }
    },
  };
}

/** Runs the checked-out V2 prefill core and persists through its current state APIs. */
export async function runCurrentV2Case(input: {
  db: DB;
  sourceMessageId: string;
  expectedCutoff: string;
  mailboxAddress: string;
  gateway: EvidenceGateway;
  privateDir: string;
  signal: AbortSignal;
  simpleSynthesisDiagnostic: boolean;
}) {
  await assertReplayIsolation(input.db, input.privateDir);
  const [row] = await input.db.select({
    id: message.id,
    threadId: message.threadId,
    subject: message.subject,
    textBody: message.textBody,
    htmlBody: message.htmlBody,
    fromAddress: message.fromAddress,
    arrivedAt: MESSAGE_ARRIVED_AT,
  }).from(message).where(and(eq(message.id, input.sourceMessageId), eq(message.transportId, 'transport-centurion'))).limit(1);
  if (!row?.arrivedAt) throw new Error('REPLAY_SOURCE_MISSING_OR_ARRIVAL_UNKNOWN');
  const arrivedAt = row.arrivedAt.toISOString();
  if (arrivedAt !== input.expectedCutoff) throw new Error('REPLAY_SOURCE_CUTOFF_MISMATCH');

  const source = { threadId: row.threadId, messageId: row.id, sourceHash: staffQuoteSourceHash(row), arrivedAt };
  const scoped = { db: input.db, transportId: 'transport-centurion', propertyCode: 'HRCEN' };
  const trace: ReplayExecutionTrace = {
    source,
    sender: row.fromAddress,
    modelCalls: [],
    candidateReads: [],
    nativeStatus: 'not_applicable',
    errors: [],
  };

  try {
    const initialized = await initializeReservationWorkflowV2Draft(scoped, source);
    if (initialized.status !== 'ok') throw new Error(`REPLAY_DRAFT_INITIALIZATION_${initialized.status.toUpperCase()}`);
    if (initialized.draft.prefill?.status !== 'idle') throw new Error('REPLAY_SOURCE_ALREADY_HAS_PREFILL_ATTEMPT');

    const evidence = await reservationArrivalEvidence(input.db, row.id);
    trace.evidenceHash = evidence.hash;
    const runId = randomUUID();
    const claimOwner = `wave1-replay-${process.pid}`;
    const claimToken = randomUUID();
    const deadlineAt = new Date(Date.now() + 16 * 60_000);
    const fence = { runId, claimOwner, claimToken };
    await input.db.insert(aiWorkflowRun).values({
      id: runId,
      transportId: scoped.transportId,
      threadId: row.threadId,
      triggerMessageId: row.id,
      runKind: 'reservation_prefill',
      idempotencyKey: `wave1-replay:${runId}`,
      modelId: 'gpt-6-luna',
      promptVersion: 'current-v2-wave1',
      state: 'running',
      claimOwner,
      claimToken,
      claimedAt: new Date(),
      deadlineAt,
      metrics: { sourceHash: source.sourceHash, arrivedAt, evidenceHash: evidence.hash, sourceVersion: 'cdb59e4d10a7379dd26d5a648ebec6883c40a0ab' },
    });

    const item = {
      workItemId: initialized.draft.workItemId,
      source,
      expectedRevision: initialized.revision,
      expectedSeq: initialized.seq,
    };
    const claimed = await claimReservationWorkflowV2Prefill(scoped, { ...item, allowRetry: true, jobFence: fence });
    if (!claimed.claim) throw new Error(`REPLAY_PREFILL_CLAIM_${claimed.result.status.toUpperCase()}`);
    let activeClaim = claimed.claim;
    const operationSignal = AbortSignal.any([input.signal, AbortSignal.timeout(PREFILL_TIMEOUT_MS)]);
    const selection = await loadSyncedQuoteSelectionFromMailbox({
      db: input.db,
      transportId: scoped.transportId,
      messageId: row.id,
      includeThreadState: true,
      sourceCutoffOnly: true,
      includeVisionImages: true,
      trackVisionImages: true,
      signal: operationSignal,
    });
    trace.selection = selection;
    operationSignal.throwIfAborted();
    if (!selection) {
      const saved = await finishReservationWorkflowV2Prefill(scoped, { ...item, claim: activeClaim, failed: true, jobFence: fence });
      if (saved.status !== 'ok') throw new Error(`REPLAY_EMPTY_SELECTION_SAVE_${saved.status.toUpperCase()}`);
      throw new Error('REPLAY_SOURCE_SELECTION_UNAVAILABLE');
    }

    const modelEnv = { ...process.env, EXTRACTION_REASONING_EFFORT: 'high',
      ...(input.simpleSynthesisDiagnostic ? { [SIMPLE_SYNTHESIS_FLAG_ENV]: 'on' } : {}) };
    const model = traceModel(createAzureExtractionAdapter(modelEnv), trace.modelCalls, 'primary', 'high');
    // A second adapter instance on a separate trace channel; high and medium responses can never be shared.
    const simpleSynthesisAdapter = input.simpleSynthesisDiagnostic
      ? traceModel(createAzureExtractionAdapter({ ...modelEnv, EXTRACTION_REASONING_EFFORT: 'medium' }),
          trace.modelCalls, 'simple_synthesis', 'medium')
      : null;
    trace.nativeReaderMode = 'production-default';
    const generated = await runReservationWorkflowV2Prefill({
      db: input.db, transportId: scoped.transportId, propertyCode: scoped.propertyCode,
      source, selection, mailboxAddress: input.mailboxAddress, env: modelEnv,
      signal: operationSignal, adapter: model,
      // Optional on the candidate core, ignored by the baseline; spread keeps baseline TS compatible.
      ...(input.simpleSynthesisDiagnostic && simpleSynthesisAdapter ? { simpleSynthesisAdapter } : {}),
      // Omit readCandidate: production shares its reader across the bounded full plan.
      onValidatedExtraction: async (generationId, extraction) => {
        const checkpoint = await checkpointReservationWorkflowV2Extraction(scoped, { ...item,
          claim: activeClaim, generationId, extraction, jobFence: fence });
        if (!checkpoint.claim) return false;
        activeClaim = checkpoint.claim;
        return true;
      },
    });
    for (const observation of generated.observations) {
      if (observation.kind === 'source') continue;
      const result: ReservationWorkflowV2ReadResult = {
        status: observation.status, result: observation.result, coverage: observation.coverage,
      };
      trace.candidateReads.push({
        // This observational key is not a recovered internal candidate ID.
        candidate: { id: `observed:${observation.ref}`, ref: observation.ref, kind: observation.kind,
          propertyCode: observation.propertyCode, criteria: observation.criteria, sourceRefs: observation.sourceRefs },
        raw: result, delivered: result, observedAt: observation.observedAt, nativeReaderMode: 'production-default',
        reconstruction: 'admitted-production-observation',
      });
    }

    const missing = (await reservationArrivalEvidence(input.db, row.id)).missing;
    if (missing.length) {
      generated.status = 'partial';
      generated.errors = [...(generated.errors ?? []).slice(0, 99), { stage: 'lookup', code: 'missing_attachment',
        message: `Some attachments could not be copied: ${missing.map(entry => entry.fileName || entry.role).join(', ')}`.slice(0, 1000) }];
    }
    operationSignal.throwIfAborted();
    const failed = !generated.sourceBound || (generated.skippedReason !== undefined && generated.skippedReason !== 'self_prestay') ||
      (generated.errors ?? []).some(error => error.stage === 'extract' ||
        (error.stage === 'synthesis' && ['model_timeout', 'model_error'].includes(error.code)));
    const saved = await finishReservationWorkflowV2Prefill(scoped, { ...item, claim: activeClaim, failed, jobFence: fence,
      seed: generated.sourceBound && !generated.skippedReason ? { generationId: generated.generationId,
        status: generated.status, ...(generated.extraction ? { extraction: generated.extraction } : {}),
        proposal: generated.proposal, observations: generated.observations,
        fieldReviewRequirements: generated.fieldReviewRequirements, errors: generated.errors } : undefined });
    if (saved.status !== 'ok') throw new Error(`REPLAY_PREFILL_PERSIST_${saved.status.toUpperCase()}`);

    let nativeStatus: 'complete' | 'superseded' | 'not_applicable' = 'not_applicable';
    const freshItem = { ...item, expectedRevision: saved.revision, expectedSeq: saved.seq };
    if (saved.draft.prefill?.status === 'running' && saved.draft.prefill.phase === 'native_checks') {
      nativeStatus = await runReservationArrivalChecks({ scoped, item: freshItem, draft: saved.draft, fence,
        deadlineAt: new Date(Math.min(deadlineAt.getTime(), Date.now() + NATIVE_CHECK_TIMEOUT_MS)), signal: input.signal });
    }
    trace.nativeStatus = nativeStatus;
    const fresh = await getReservationWorkflowV2Draft(scoped, { workItemId: item.workItemId, source });
    if (fresh.status !== 'ok') throw new Error(`REPLAY_FRESH_DRAFT_${fresh.status.toUpperCase()}`);
    const checksIncomplete = nativeStatus === 'superseded' ||
      (fresh.draft.prefill?.status === 'running' && fresh.draft.prefill.phase === 'native_checks');
    const workflowFailed = fresh.draft.prefill?.status === 'failed' || checksIncomplete;
    await input.db.update(aiWorkflowRun).set({ state: workflowFailed ? 'dead_letter' : 'succeeded',
      ...(checksIncomplete ? { lastError: 'reservation native checks incomplete', failureClass: 'LEASE_LOST' } : {}),
      finishedAt: new Date(), updatedAt: new Date() }).where(eq(aiWorkflowRun.id, runId));
    const paneDraft = workflowFailed && fresh.draft.prefill && ['queued', 'running', 'failed'].includes(fresh.draft.prefill.status)
      ? { ...fresh.draft, prefill: { ...fresh.draft.prefill, status: 'failed' as const } } : fresh.draft;
    const wire = { status: 'ok', draft: paneDraft, revision: fresh.revision, revisionHead: fresh.revisionHead, seq: fresh.seq,
      preparationViews: reservationWorkflowV2PreparationViews(paneDraft, scoped.propertyCode) };
    const unavailable = { mutate: async () => { throw new Error('Replay transport supports pane projection only'); } };
    const client = createTrpcReservationWorkflowClient({ reservationWorkflowV2: {
      ensure: { mutate: async () => wire }, get: { query: async () => wire },
      prefill: unavailable, addAction: unavailable, changeRows: unavailable, selectNative: unavailable,
      verifyNativeLead: unavailable, reviewScope: unavailable, reconcileSource: unavailable, edit: unavailable,
      review: unavailable, undo: unavailable, redo: unavailable, lookup: unavailable,
      guestProfileOptions: unavailable, prepareGuestProfile: unavailable, createGuestProfile: unavailable,
      prepare: unavailable, execute: unavailable, reconcile: unavailable, configureFiling: unavailable,
      lookupServices: unavailable, prepareServices: unavailable, executeServices: unavailable, reconcileServices: unavailable,
    } });
    const pane = await client.ensure({ source: { mailboxId: scoped.transportId, propertyId: scoped.propertyCode,
      internetMessageId: null, messageId: source.messageId, threadId: source.threadId, sourceHash: source.sourceHash,
      arrivedAt: source.arrivedAt, selectionEpoch: 0, subject: row.subject ?? '', sender: row.fromAddress, attachments: [] } });
    return {
      source,
      sender: row.fromAddress,
      selection,
      evidenceHash: evidence.hash,
      generated,
      pane,
      paneSession: pane.session,
      persistedDraft: fresh.draft,
      nativeStatus,
      workflowFailed,
      checksIncomplete,
      currentNativeChecks: fresh.draft.prefill?.nativeChecks ?? [],
      currentNativeObservations: fresh.draft.observations,
      currentOperationResults: fresh.draft.operationResults,
      modelCalls: trace.modelCalls,
      modelChannelCalls: { primary: trace.modelCalls.filter(call => call.channel === 'primary').length,
        simpleSynthesis: trace.modelCalls.filter(call => call.channel === 'simple_synthesis').length },
      simpleSynthesisDiagnostic: input.simpleSynthesisDiagnostic,
      candidateReads: trace.candidateReads,
      nativeReaderMode: trace.nativeReaderMode,
      candidateReadTraceSemantics: 'Final production observations; counts are observations, not native calls. Raw/delivered copy the admitted observation, not recovered wire payloads.',
      errors: trace.errors,
    };
  } catch (cause) {
    trace.errors.push(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
    throw new ReplayExecutionError(cause, trace);
  }
}
