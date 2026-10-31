import {
  claimNextAiRun,
  CLEANUP_RESERVE_MS,
  countNonterminalAiRuns,
  heartbeatAiRun,
  isSupportedInboundTriagePromptVersion,
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunRunning,
  markAiRunSucceeded,
  readAiRunReceipt,
  remainingRunBudgetMs,
  reserveReadAttempt,
  resolveDeployedTriagePromptVersion,
  mailBaselineGenerationKey,
  RunDeadlineError,
  HMS_JOB_PROMPT_VERSION,
  HMS_WRITE_RUN_KIND,
  shouldRetryAiFailure,
  toAiRunFence,
  type AiFailureClass,
  type AiRunFence,
  type AiRunScopeFilter,
  type AiWorkflowRunKind,
  type CandidateReadPlanKind,
} from './run-ledger.js';
import { sweepLostHmsWriteLeases } from './hms-approval.js';
import {
  createFailedShadowPredictionSeal,
  createShadowPredictionSeal,
  createUnavailableShadowPredictionSeal,
  assessDueShadowPredictions,
  freezeShadowInput,
  persistShadowPrediction,
  purgeExpiredShadowDerivatives,
  resolveShadowAdmissionPolicy,
  shadowPredictionPrompt,
  SHADOW_EVALUATION_MODE,
  type ShadowMessageInput,
} from './shadow-evaluation.js';
import {
  existingDocumentRefForRecord,
  existingDocumentSha256FromRef,
  existingDocumentScopeRef,
  mailAttachmentRecord,
  createExistingDocumentService,
  type ExistingDocumentRecord,
} from '../mail/artifacts/existing-document-service.js';
import {
  executeReadToolRun,
  readRequestSchema,
  type ReadExecutionContext,
  executeTrustedSynchronousHmsFindReservation,
  type TrustedSynchronousHmsFindSessionFactory,
} from '../hms/read-service.js';
import {
  assertLinkedContextReference,
  linkedContextReferenceSchema,
  type LinkedContextReference,
  type LinkedContextReferenceKind,
} from '../hms/context-read-reference.js';
import {
  isInboundTriageClassifierEnabled,
  parseEnv,
  requireHmsEvidenceHmacChildKey,
  requireHmsReadRuntimeConfig,
  requireHmsWorkerRuntimeConfig,
  type AiExecutorLane,
  type EnvInput,
} from '../env.js';
import { readToolExpectedPropertyCode } from '../hms/hms-read-target.js';
import {
  companyAccountContextDataSchema,
  eventContextDataSchema,
  groupBlockContextDataSchema,
  notesTracesContextDataSchema,
} from '../hms/context-read-contracts.js';
import {
  aiWorkflowRun,
  attachment,
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailboxAccess,
  mailboxTransport,
  message,
} from '../db/schema/mail.js';
import { mailExtraction } from '../db/schema/work.js';
import { isSelfSentPreStayInformationMail } from './existing-stay-information.js';
import {
  isMailSourceClassification,
} from './mail-source.js';
import {
  mailSourceTriageOutput,
  validateWorkflowTriageOutput,
  triageOutputSemanticHints,
  TRIAGE_REVIEWER_VERSION,
  type ThreadSignals,
  type WorkflowTriageOutput,
} from './triage.js';
import {
  quoteRequestAuthorityIssues,
  unavailableQuoteReferenceAuthority,
  type QuoteReferenceAuthorityLoader,
} from '../hms/quote-request-normalization.js';
import {
  readResultSchema,
  readReservationBindingSchema,
  readReservationRef,
  unknownFact,
  type ReadResult,
} from '../hms/read-service-contracts.js';
import {
  readAuthorizedArtifact,
  readAuthorizedArtifactBytes,
  type ArtifactData,
  type AttachmentLocator,
} from '../mail/artifacts/read-artifact.js';
import {
  createApprovedLocalModelAdapter,
  createProductionShadowModelRouteFactory,
  type ShadowModelRouteFactory,
} from './bedrock/factory.js';
import {
  createProductionMailBaselineExtractionRouteFactory,
  type MailBaselineExtractionRouteFactory,
} from './mail-baseline-route-factory.js';
import {
  createProductionDraftModelRouteFactory,
  type DraftModelRouteConfig,
  type DraftModelRouteFactory,
} from './draft-route-factory.js';
import {
  assertCurrentAppAccessProof,
  issueCurrentAppAccessProof,
  type CurrentAppAccessProof,
} from '../hms/requester-authorization.js';
import {
  issueReadAdmissionFromMailbox,
  loadReadMailboxGrant,
  positiveFindEvidence,
} from '../hms/read-admission-issuer.js';
import {
  admitReadBranch,
  assertPersistedReadAdmissionIssuer,
  READ_BRANCH_WORST_CASE_MS,
} from '../hms/read-admission.js';
import {
  extractMailBaselineWithApprovedRoute,
  resolveMailBaselineExtractionRoute,
} from './mail-baseline-extraction.js';
import {
  buildCausalTriageMessages,
  resolveTriageEventClock,
  type TriageMessageRow,
} from './triage-input.js';
import {
  prepareDraftInput,
  serializePreparedDraftInput,
  type PreparedAsk,
} from './prepared-draft-input.js';
import {
  runPreparedReplyWorkflow,
  type PreparedReplyWorkflowResult,
} from './workflows/candidate-draft.js';
import type { ReservationLookupResult, ReservationRow } from '../hms/reservation-context-facade.js';
import { DOCUMENT_LIST_MAX_BYTES, DOCUMENT_LIST_MAX_ROWS } from '../hms/document-list-contract.js';
import { buildQuoteStayReadData, quoteStayReadDataSchema } from '../hms/quote-stay-contract.js';
import { persistAiCandidateDraft, loadLatestThreadAffectingDraftRevisionId } from './drafts.js';
import { scheduleInboundTriageAnalyseWarm } from './quote-workflow-warmer.js';
import {
  createHmsRecoveryGate,
  executeHmsJob,
  hmsJobQueueEnabled,
  scheduleAvailabilityPrefetch,
  scheduleQuotePreparationAfterPartyMatch,
  scheduleQuotePreparationForExtraction,
  schedulePrefetchForInbound,
  type HmsRecoveryGate,
} from './hms-jobs.js';
import { executeQuotePdfJob, isQuotePdfRun, quotePdfResultOf } from './quote-pdf-jobs.js';
import type { ExistingDocumentScope } from '../mail/artifacts/existing-document-contracts.js';
import { persistMailBaselineProjection } from '../metrics/mail-baseline-projection.js';
import type { LocalModelRouteEvidence, LocalModelTransport } from './bedrock/local.js';
import { parseMailboxMeasurementConfig } from '../metrics/mail-measurement-config.js';
import { reservationFindResultSchema } from '../hms/reservation-context-contract.js';
import { MAIL_BASELINE_INTERPRETATION_VERSION } from '../metrics/mail-baseline.js';
import { buildReplyPlaybook, type ReplyRequestKind } from './reply-playbooks.js';
import { quoteStayCandidateFromRequest } from '../hms/quote-stay-candidate.js';
import { aiShadowPrediction } from '../db/schema/ai-shadow-evaluation.js';
import type { GroupReadCandidate } from '../hms/group-read-candidate.js';
import type { EventReadCandidate } from '../hms/event-read-candidate.js';
import type { IndexableMessage } from '../mail/conversation-signals.js';
import { LocalModelRouteUnavailableError } from './bedrock/local.js';
import { AzureLunaModelAdapter } from './bedrock/luna.js';
import { folioReadDataSchema } from '../hms/folio-read-contract.js';
import { TRIAGE_PROMPT_VERSION } from './workflows/mail-triage.js';
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { extractDraftFeedbackLabels } from './feedback.js';
import type { ModelAdapter } from './bedrock/adapter.js';
import { normalizeEmailAddress } from './never-spam.js';
import type { ToolResult } from './draft-evidence.js';
import { createHash, randomUUID } from 'node:crypto';
import { isCliEntry } from '../lib/is-cli-entry.js';
import { assessReply } from './reply-assessment.js';
import { executeInboundExtractionRun } from './extraction/inbound-run.js';
import {
  BODY_HEAD_CHARS,
  classifyWorkflow,
  parseStoredClassifier,
} from './workflow-classifier/index.js';
import { executeQuoteFollowupRun } from './quote-followup.js';
import { executeReplyCheckRun } from './reply-check.js';
import { createMastraRuntime } from './mastra.js';
import { closeDb, getDb, type DB } from '../db/client.js';
import { getS3Storage } from '../storage/s3.js';

/** Code-owned asks derived from the bounded inbound request; no model chooses scope. */
export function deriveWorkerReplyAsks(requestText: string): PreparedAsk[] {
  const asks: PreparedAsk[] = [];
  const add = (code: string, label: string, acquisition: string) => {
    if (!asks.some((ask) => ask.code === code))
      asks.push({ code, label, required: true, acquisition });
  };
  if (/\b(?:reservation|booking|confirmation)\b/i.test(requestText)) {
    add('reservation_status', 'reservation status', 'approved reservation read');
  }
  if (/\b(?:price|rate|quote|cost|how much)\b/i.test(requestText)) {
    add('price', 'price or rate', 'approved quote read');
  }
  if (/\b(?:payment|deposit|receipt|folio)\b/i.test(requestText)) {
    add('payment_status', 'payment status', 'approved folio read');
  }
  if (/\b(?:document|invoice|attachment|attached)\b/i.test(requestText)) {
    add('document', 'document', 'authorized attachment read');
  }
  if (/\b(?:arrival|departure|check[- ]?in|check[- ]?out|stay dates?)\b/i.test(requestText)) {
    add('stay_dates', 'stay dates', 'approved reservation read');
  }
  return asks;
}

function workerReplyRequestKind(requestText: string): ReplyRequestKind {
  if (/\b(?:payment|deposit|receipt|folio)\b/i.test(requestText)) return 'finance';
  if (/\b(?:price|rate|quote|cost|how much)\b/i.test(requestText)) return 'quote';
  if (/\b(?:reservation|booking|confirmation|stay|arrival|departure)\b/i.test(requestText)) {
    return 'reservation';
  }
  if (/\b(?:document|invoice|attachment)\b/i.test(requestText)) return 'document';
  return 'general';
}

export type PreparedWorkerCandidateReplyInput = {
  requestId: string;
  threadId?: string;
  requestText: string;
  asks?: readonly PreparedAsk[];
  requestKind?: ReplyRequestKind;
  adapter?: ModelAdapter;
  /** Explicit purpose-bound route; absent remains unavailable. */
  route?: DraftModelRouteConfig;
  signal?: AbortSignal;
  deadlineAt?: number;
};

/**
 * Normal worker composition seam: bounded preparation precedes serialization
 * and approved adapter invocation. Missing route returns a manual-review
 * playbook before any client/network initialization.
 */
export async function runPreparedWorkerCandidateReply(
  input: PreparedWorkerCandidateReplyInput,
): Promise<PreparedReplyWorkflowResult> {
  const asks = input.asks ?? deriveWorkerReplyAsks(input.requestText);
  const prepared = prepareDraftInput({
    requestId: input.requestId,
    threadId: input.threadId,
    audience: 'guest',
    requestText: input.requestText,
    asks,
  });
  const serializedInput = serializePreparedDraftInput(prepared);
  let adapter: ModelAdapter;
  try {
    adapter =
      input.adapter ??
      (input.route?.route.protocol === 'azure-foundry-responses'
        ? new AzureLunaModelAdapter()
        : createApprovedLocalModelAdapter({
            purpose: 'draft',
            route: input.route?.route.protocol === 'in_process' ? input.route.route : undefined,
            transport: input.route?.transport,
          }));
  } catch (error) {
    if (!(error instanceof LocalModelRouteUnavailableError)) throw error;
    const fallback = buildReplyPlaybook({
      audience: prepared.audience,
      requestKind: input.requestKind ?? workerReplyRequestKind(prepared.requestText),
      asks: prepared.asks,
      facts: prepared.facts,
      releasedCapabilities: prepared.releasedCapabilities,
    });
    const assessment = assessReply({
      replyText: fallback.textBody,
      asks: prepared.asks,
      facts: prepared.facts,
      audience: prepared.audience,
    });
    return {
      outcome: fallback.outcome,
      textBody: fallback.textBody,
      htmlBody: fallback.htmlBody,
      assessment,
      serializedInput,
      metrics: {
        fallback: true,
        modelRouteUnavailable: true,
        modelRoutePurpose: 'draft',
        manualReview: true,
      },
    };
  }
  const result = await runPreparedReplyWorkflow({
    prepared,
    requestKind: input.requestKind ?? workerReplyRequestKind(prepared.requestText),
    adapter,
    signal: input.signal,
    deadlineAt: input.deadlineAt,
  });
  return {
    ...result,
    metrics: {
      ...result.metrics,
      ...(input.route?.route
        ? {
            routeBinding: {
              ...input.route.route,
              ...(input.route.release ? { release: input.route.release } : {}),
            },
          }
        : {}),
    },
  };
}

function resolveWorkerLane(): AiExecutorLane {
  return parseEnv(process.env as Record<string, string | undefined>).AI_WORKER_LANE;
}

/**
 * Fail-closed HMS shadow gate for hms-ai-worker. Default lane never invokes
 * requireHmsWorkerRuntimeConfig; mode=off on HMS lane stays secret-free.
 */
export function assertHmsLaneRuntimeReady(input: EnvInput = process.env as EnvInput): void {
  const env = parseEnv(input);
  if (env.AI_WORKER_LANE !== 'hms') return;
  if (env.HMS_DRAFT_ENRICHMENT_MODE !== 'shadow') return;
  requireHmsWorkerRuntimeConfig(input);
}

export function aiWorkerOwnerId(lane: AiExecutorLane = resolveWorkerLane()): string {
  return `${lane}-ai-worker-${process.pid}`;
}

/** @deprecated Prefer aiWorkerOwnerId(lane); kept for older call sites. */
export const AI_WORKER_OWNER = aiWorkerOwnerId('default');

/** Periodic lease renewal while a run executes (15–30s band). */
export const AI_LEASE_HEARTBEAT_INTERVAL_MS = 20_000;
export interface ExecuteAiRunResult {
  runId: string;
  state: 'succeeded' | 'retry_wait' | 'dead_letter';
}

export interface AiWorkerCliArgs {
  drainPrefix?: string;
  transportId?: string;
  promptVersion?: string;
  timeoutMs?: number;
  runKind: AiWorkflowRunKind;
}

export interface RunAiWorkerDrainInput extends AiRunScopeFilter {
  timeoutMs: number;
  pollIntervalMs?: number;
  ownerId?: string;
  /** Normal daemon composition for the purpose-bound extraction edge. */
  mailBaselineExtractionRouteFactory?: MailBaselineExtractionRouteFactory;
  shadowModelAdapter?: NonNullable<Parameters<typeof executeAiRun>[1]>['shadowModelAdapter'];
  shadowModelRoute?: NonNullable<Parameters<typeof executeAiRun>[1]>['shadowModelRoute'];
  shadowModelTransport?: NonNullable<Parameters<typeof executeAiRun>[1]>['shadowModelTransport'];
  shadowModelRouteFactory?: ShadowModelRouteFactory;
}

export interface RunAiWorkerDrainResult {
  ok: boolean;
  reason: 'drained' | 'timeout';
  remainingNonterminal: number;
  processed: number;
}

const RESERVE_CLOUD_PENNY_EMAIL = 'pmbobo@eu.mail.reservecloud.com';
const LEGACY_PENNY_EMAIL = 'pmbobo@legacyhotels.co.za';

function recipientAddresses(value: readonly string[] | null | undefined): string[] {
  return (value ?? []).map((address) => normalizeEmailAddress(address)).filter(Boolean);
}

type WorkerTriageMessage = {
  fromAddress: string | null;
  direction: string;
  toAddresses: string[] | null;
  ccAddresses: string[] | null;
  bccAddresses: string[] | null;
};

/** Derive R22/R23 metadata before Mastra; wrappers and noreply fail closed. */
function deriveThreadSignals(messages: readonly WorkerTriageMessage[]): ThreadSignals {
  const legacyHotelsOutboundResponse = messages.some((message) => {
    if (message.direction !== 'outbound') return false;
    const from = normalizeEmailAddress(message.fromAddress ?? '');
    const domain = from.slice(from.lastIndexOf('@') + 1);
    return domain === 'legacyhotels.co.za' || domain === 'mail.legacyhotels.com';
  });
  const rcStaff = messages.find((message) => {
    if (message.direction !== 'outbound') return false;
    const from = normalizeEmailAddress(message.fromAddress ?? '');
    if (from !== RESERVE_CLOUD_PENNY_EMAIL) return false;
    const recipients = [
      ...recipientAddresses(message.toAddresses),
      ...recipientAddresses(message.ccAddresses),
      ...recipientAddresses(message.bccAddresses),
    ];
    return recipients.some((recipient) => recipient !== LEGACY_PENNY_EMAIL);
  });
  if (!rcStaff) return { legacyHotelsOutboundResponse };
  return {
    legacyHotelsOutboundResponse,
    reserveCloudStaffOutbound: true,
    reserveCloudStaffOutboundFrom: RESERVE_CLOUD_PENNY_EMAIL,
    reserveCloudStaffOutboundRecipients: [
      ...recipientAddresses(rcStaff.toAddresses),
      ...recipientAddresses(rcStaff.ccAddresses),
      ...recipientAddresses(rcStaff.bccAddresses),
    ],
  };
}

type WorkerThreadMessageRow = {
  id: string;
  threadId: string;
  fromAddress: string | null;
  subject: string | null;
  direction: string;
  createdAt: Date;
  receivedAt: Date | null;
  sentAt: Date | null;
  toAddresses: string[] | null;
  ccAddresses: string[] | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[] | null;
};

/** Build the transport-wide, causal index used only by Layer B metrics. */
export function threadMessagesToTransportIndex(
  rows: readonly WorkerThreadMessageRow[],
): IndexableMessage[] {
  return rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
    from: row.fromAddress ?? '',
    to: (row.toAddresses ?? []).join(', '),
    cc: (row.ccAddresses ?? []).join(', '),
    subject: row.subject ?? '',
    receivedAt: (row.receivedAt ?? row.sentAt ?? row.createdAt).toISOString(),
    messageIdHeader: row.messageIdHeader,
    inReplyTo: row.inReplyTo,
    references: row.references,
  }));
}

function claimOwnerFor(run: typeof aiWorkflowRun.$inferSelect): string {
  return run.claimOwner ?? aiWorkerOwnerId(run.executorLane ?? resolveWorkerLane());
}

function classifyAiFailure(error: unknown): AiFailureClass {
  if (error instanceof RunDeadlineError) return 'RUN_DEADLINE';
  if (error && typeof error === 'object' && 'failureClass' in error) {
    return (error as { failureClass: AiFailureClass }).failureClass;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|ECONNRESET|ENOTFOUND|network/i.test(message)) return 'TRANSIENT_NETWORK';
  if (/bedrock|throttl|TooManyRequests|ServiceUnavailable/i.test(message)) {
    return 'BEDROCK_TRANSIENT';
  }
  if (/artifact|s3|NoSuchKey/i.test(message)) return 'ARTIFACT_TRANSIENT';
  if (/policy|guardrail/i.test(message)) return 'POLICY_BLOCK';
  if (/auth|unauthorized|forbidden/i.test(message)) return 'AUTH';
  return 'UNKNOWN';
}

function buildRunAbortSignal(input: {
  fence: AiRunFence;
  leaseAbort: AbortController;
  shutdownSignal: AbortSignal;
  now?: Date;
}): AbortSignal {
  const remaining = remainingRunBudgetMs(input.fence, input.now);
  if (remaining <= CLEANUP_RESERVE_MS) throw new RunDeadlineError();
  const budgetSignal = AbortSignal.timeout(remaining);
  return AbortSignal.any([budgetSignal, input.leaseAbort.signal, input.shutdownSignal]);
}

/** Renew a claimed-run lease and fail closed on a lost lease or rejected heartbeat. */
export async function renewAiRunLease(
  fence: AiRunFence,
  leaseAbort: AbortController,
  heartbeat: (fence: AiRunFence) => Promise<boolean> = (fence) => heartbeatAiRun(fence),
): Promise<void> {
  try {
    if (!(await heartbeat(fence))) leaseAbort.abort();
  } catch {
    // A rejected heartbeat is equivalent to an unknown/lost lease. Abort the
    // run so no further model or durable work proceeds under an unverified
    // claim, and consume the rejection instead of creating an unhandled one.
    leaseAbort.abort();
  }
}

export function parseAiWorkerCliArgs(argv: string[]): AiWorkerCliArgs {
  let drainPrefix: string | undefined;
  let transportId: string | undefined;
  let promptVersion: string | undefined;
  let timeoutMs: number | undefined;
  let runKind: AiWorkflowRunKind = 'inbound_triage';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--drain-prefix') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--drain-prefix requires a value');
      drainPrefix = value;
      continue;
    }
    if (arg === '--transport-id') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--transport-id requires a value');
      transportId = value;
      continue;
    }
    if (arg === '--prompt-version') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--prompt-version requires a value');
      promptVersion = value;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--timeout-ms requires a value');
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--timeout-ms must be a positive number, got: ${value}`);
      }
      timeoutMs = parsed;
      continue;
    }
    if (arg === '--run-kind') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--run-kind requires a value');
      if (value === HMS_WRITE_RUN_KIND) {
        throw new Error('hms_write runs are never drained: only the write runner claims them');
      }
      runKind = value as AiWorkflowRunKind;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return { drainPrefix, transportId, promptVersion, timeoutMs, runKind };
}

async function failAiRun(
  run: typeof aiWorkflowRun.$inferSelect,
  error: unknown,
  fence: AiRunFence | null,
): Promise<ExecuteAiRunResult> {
  const message = error instanceof Error ? error.message : String(error);
  const failureClass = classifyAiFailure(error);
  const attempts = run.attempts + 1;
  const owner = claimOwnerFor(run);
  const claimToken = fence?.claimToken ?? run.claimToken;
  if (!claimToken) {
    return { runId: run.id, state: 'dead_letter' };
  }

  // An hms_write run is never retried: a failed write may already have reached HMS (hms-approval.ts).
  const canRetry =
    fence !== null &&
    run.runKind !== HMS_WRITE_RUN_KIND &&
    shouldRetryAiFailure({
      failureClass,
      fence,
      attempts: run.attempts,
    });

  if (!canRetry) {
    await markAiRunDeadLetter({
      runId: run.id,
      claimOwner: owner,
      claimToken,
      expectedStates: ['running'],
      lastError: message,
      failureClass,
    });
    return { runId: run.id, state: 'dead_letter' };
  }

  await markAiRunRetry({
    runId: run.id,
    claimOwner: owner,
    claimToken,
    expectedStates: ['running'],
    attempts,
    nextRunAt: new Date(Date.now() + attempts * 60_000),
    lastError: message,
    failureClass,
  });
  return { runId: run.id, state: 'retry_wait' };
}

export type ReadAdmissionBinding = {
  releaseId: string;
  requestBranchId: string;
  /** Non-browser existing-document reads carry null; PMS reads carry a digest. */
  manifestSha256?: string | null;
  requesterAuthorizationId: string;
  inputDigest: string;
  captureRequired: boolean;
  captureBindingRef: string | null;
  reservationRef: string | null;
  reservationRefIssuedAt: string | null;
  reservationRefExpiresAt: string | null;
};

export function assertReadAdmissionPlanBinding(input: {
  readAdmission: ReadAdmissionBinding;
  requesterAuthorizationId: string;
}): void {
  if (input.readAdmission.requesterAuthorizationId !== input.requesterAuthorizationId) {
    throw Object.assign(
      new Error('read admission requester is not the trusted plan authorization'),
      {
        failureClass: 'AUTH' as const,
      },
    );
  }
}

export type CandidateSessionInput = {
  transportId: string;
  threadId: string;
  triggerMessageId?: string;
  /** Server-owned property scope bound by the normalized quote authority. */
  propertyCode?: string;
  lookupCandidates: readonly import('./thread-context.js').LookupCandidate[];
  signal: AbortSignal;
  /** AI run UUID — becomes HMS browser audit operationId when capture is enabled. */
  runId?: string;
  /** Private durable result reference bound into audited browser capture. */
  readResultRef?: string;
  /** Claimed-run lease; tools reserve durable read budget against it before I/O. */
  readFence?: AiRunFence;
  readPlanKind?: CandidateReadPlanKind;
  /** The independent read adapter wraps the complete dispatch in this lock. */
  readOnly?: boolean;
  /** Trusted release/input/capture admission for the production read path. */
  readAdmission?: ReadAdmissionBinding;
  /** Existing issued mapper proof; absence keeps normal claims fail-closed. */
  claimAuthorization?: import('../hms/claim-envelope.js').MapEnvelopeRequesterAuthorization | null;
  readToolId?:
    | import('../hms/read-tools.js').ReadToolId
    | 'hms_read_reservation'
    | 'hms_read_notes_traces';
  /** Resolved private source value for a server-owned linked context ref. */
  linkedContextSourceRef?: string;
  /** Closed finance section selection for the optional folio adapter. */
  folioSections?: readonly string[];
  /** Authored quote candidates when hms_quote_stay is active. */
  quoteCandidates?: ReadonlyMap<
    string,
    import('../hms/quote-stay-candidate.js').QuoteStayCandidate
  >;
};

export type CandidateSessionFactory = (
  input: CandidateSessionInput,
) => Promise<import('./candidate-draft-agent.js').CandidateToolSession>;

/**
 * Lower-edge substitution for normal runtime proof.  The active release set
 * remains loaded and validated by the real registry/handler path; tests may
 * replace only the browser/PMS runtime opened by the live drivers.
 */
export type LiveHmsCandidateSessionFactoryOptions = {
  runtime?: import('../hms/runtime.js').HmsRuntime;
  activeReadState?: import('../hms/active-read-runtime.js').ActiveReadRuntimeState;
};

/** Singleton production HMS runtime — one Chromium process per HMS worker. */
let productionHmsRuntime: import('../hms/runtime.js').HmsRuntime | null | undefined;

let productionActiveReadState:
  | import('../hms/active-read-runtime.js').ActiveReadRuntimeState
  | null
  | undefined;

function synchronousReadError(code: 'READ_ABORTED' | 'READ_SYNC_DEADLINE', message: string) {
  return Object.assign(new Error(message), {
    code,
    failureClass: 'RUN_DEADLINE' as const,
  });
}

function assertSynchronousReadActive(signal: AbortSignal, deadlineAt: Date): void {
  if (!Number.isFinite(deadlineAt.getTime()) || Date.now() >= deadlineAt.getTime()) {
    throw synchronousReadError('READ_SYNC_DEADLINE', 'synchronous read deadline is expired');
  }
  if (signal.aborted) throw synchronousReadError('READ_ABORTED', 'read was aborted');
}

function deadlineBoundSynchronousReadSignal(
  inputSignal: AbortSignal | undefined,
  deadlineAt: Date,
): AbortSignal {
  const remaining = Math.max(0, deadlineAt.getTime() - Date.now());
  const deadlineSignal = AbortSignal.timeout(remaining);
  return inputSignal ? AbortSignal.any([inputSignal, deadlineSignal]) : deadlineSignal;
}

function awaitSynchronousReadSetup<T>(input: {
  operation: () => Promise<T>;
  signal: AbortSignal;
  deadlineAt: Date;
  onLateResolution?: (value: T) => void | Promise<void>;
  onLateRejection?: (error: unknown) => void | Promise<void>;
}): Promise<T> {
  assertSynchronousReadActive(input.signal, input.deadlineAt);
  let pending: Promise<T>;
  try {
    pending = input.operation();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
    };
    const rejectForCurrentState = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        assertSynchronousReadActive(input.signal, input.deadlineAt);
        reject(synchronousReadError('READ_ABORTED', 'read was aborted'));
      } catch (error) {
        reject(error);
      }
    };
    const onAbort = () => rejectForCurrentState();
    const remaining = input.deadlineAt.getTime() - Date.now();
    if (remaining <= 0) {
      rejectForCurrentState();
      return;
    }
    timer = setTimeout(rejectForCurrentState, remaining);
    timer.unref?.();
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    pending.then(
      (value) => {
        if (settled) {
          if (input.onLateResolution) {
            void Promise.resolve(input.onLateResolution(value)).catch(() => undefined);
          }
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) {
          if (input.onLateRejection) {
            void Promise.resolve(input.onLateRejection(error)).catch(() => undefined);
          }
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function productionReadRuntimeFacts(
  config: ReturnType<typeof requireHmsReadRuntimeConfig>,
  signal?: AbortSignal,
  deadlineAt?: Date,
) {
  const { resolveHmsSourceRevision } = await import('../hms/production-runtime.js');
  const { runtimeFingerprintSha256 } = await import('../hms/evidence-runtime.js');
  const { loadWorkerActiveReadSet } = await import('../hms/active-read-runtime.js');
  const sourceRevision = resolveHmsSourceRevision();
  const runtimeFp = runtimeFingerprintSha256({
    sourceRevision,
    playwrightRevision: '1.63.0',
    chromiumRevision: '1243',
  });
  if (!productionActiveReadState) {
    const load = () =>
      loadWorkerActiveReadSet({
        registryPath: config.activeRegistryPath,
        releaseRoot: config.releaseRoot,
        runtimeFingerprintSha256: runtimeFp,
      });
    productionActiveReadState =
      signal && deadlineAt
        ? await awaitSynchronousReadSetup({ operation: load, signal, deadlineAt })
        : await load();
    if (signal && deadlineAt) assertSynchronousReadActive(signal, deadlineAt);
  }
  return { sourceRevision, runtimeFp, active: productionActiveReadState };
}

async function getOrCreateProductionHmsRuntime(
  signal?: AbortSignal,
  deadlineAt?: Date,
): Promise<import('../hms/runtime.js').HmsRuntime> {
  if (signal && deadlineAt) assertSynchronousReadActive(signal, deadlineAt);
  if (productionHmsRuntime) return productionHmsRuntime;
  const { createProductionHmsRuntime } = await import('../hms/production-runtime.js');
  // The read lane is independent from draft mode: `off` still permits a
  // model-free browser runtime when the read service is enabled.
  const config = requireHmsReadRuntimeConfig(process.env as Record<string, string | undefined>);
  const evidenceKey = requireHmsEvidenceHmacChildKey(
    process.env as Record<string, string | undefined>,
  );
  // Load active registry before browser start — fail closed if present+invalid.
  const { sourceRevision } = await productionReadRuntimeFacts(config, signal, deadlineAt);
  const create = () =>
    createProductionHmsRuntime(config, {
      evidenceHmac: {
        secretArn: config.evidenceHmacSecretArn,
        keyVersion: config.evidenceHmacKeyVersion,
        key: evidenceKey.key,
      },
      sourceRevision,
    });
  const runtime =
    signal && deadlineAt
      ? await awaitSynchronousReadSetup({
          operation: create,
          signal,
          deadlineAt,
          onLateResolution: (lateRuntime) => lateRuntime.close(),
        })
      : await create();
  let closeSequence = Promise.resolve();
  const closeOnFailure = async () => {
    // Never tear down a runtime that has become the shared worker singleton.
    if (productionHmsRuntime === runtime) return;
    const close = closeSequence.then(
      () => runtime.close(),
      () => runtime.close(),
    );
    closeSequence = close.catch(() => undefined);
    await close.catch(() => undefined);
  };
  try {
    const runtimeSignal = signal ?? AbortSignal.timeout(Math.min(60_000, config.runDeadlineMs));
    if (signal && deadlineAt) {
      await awaitSynchronousReadSetup({
        operation: () => runtime.start(runtimeSignal),
        signal,
        deadlineAt,
        onLateResolution: closeOnFailure,
        onLateRejection: closeOnFailure,
      });
      assertSynchronousReadActive(signal, deadlineAt);
    } else {
      await runtime.start(runtimeSignal);
    }
    productionHmsRuntime = runtime;
    return runtime;
  } catch (error) {
    await closeOnFailure();
    throw error;
  }
}

/** Test-only access to the normal runtime accessor for offline lifecycle tests. */
export async function __getOrCreateProductionHmsRuntimeForTests(
  signal?: AbortSignal,
  deadlineAt?: Date,
): Promise<import('../hms/runtime.js').HmsRuntime> {
  return getOrCreateProductionHmsRuntime(signal, deadlineAt);
}

/** Test / shutdown hook — closes singleton and clears handle. */
export async function closeProductionHmsRuntimeForTests(): Promise<void> {
  const rt = productionHmsRuntime;
  productionHmsRuntime = null;
  productionActiveReadState = null;
  const { clearCachedActiveReadRuntimeForTests } = await import('../hms/active-read-runtime.js');
  clearCachedActiveReadRuntimeForTests();
  if (rt) await rt.close();
}

export function createLiveHmsCandidateSessionFactory(
  options: LiveHmsCandidateSessionFactoryOptions = {},
): CandidateSessionFactory {
  return async (input) => {
    const config = requireHmsReadRuntimeConfig(process.env as Record<string, string | undefined>);
    const propertyCode = input.propertyCode ?? config.expectedPropertyCode;
    if (propertyCode !== config.expectedPropertyCode) {
      throw Object.assign(
        new Error('quote authority property does not match the configured live property'),
        { failureClass: 'AUTH' as const },
      );
    }
    const runtime = options.runtime ?? (await getOrCreateProductionHmsRuntime());
    const active =
      options.activeReadState ??
      productionActiveReadState ??
      (await import('../hms/active-read-runtime.js')).getCachedActiveReadRuntime() ??
      null;
    const { createLiveGuestStayDriver } = await import('../hms/live-guest-stay-driver.js');
    const { createReservationCandidateSession } = await import(
      '../hms/reservation-candidate-session.js'
    );
    const { filterExactReservationCandidates } = await import('./thread-context.js');
    type LookupCandidate = import('./thread-context.js').LookupCandidate;
    const {
      buildHmsFindSessionAuthorization,
      assertFindHandlerBound,
      buildHmsQuoteSessionAuthorization,
      assertQuoteHandlerBound,
      buildHmsFolioSessionAuthorization,
      placeholderDigest,
    } = await import('../hms/active-read-runtime.js');
    const {
      buildExactOsressSearchManifest,
      buildLiveGuestStayReadManifest,
      buildExactOsrravSearchManifest,
      buildLiveGroupBlockListManifest,
      liveNotFoundCanaryCandidate,
    } = await import('../hms/live-read-manifest.js');
    const { createLiveQuoteStayDriver } = await import('../hms/live-quote-stay-driver.js');
    const { createLiveFolioReadDriver, mergeFolioEvidence } = await import(
      '../hms/live-folio-read-driver.js'
    );
    const { createLiveCompanyAccountReadDriver } = await import(
      '../hms/live-company-account-read-driver.js'
    );
    const { createLiveGroupBlockDriver } = await import('../hms/live-group-block-driver.js');
    const { createLiveEventReadDriver } = await import('../hms/live-event-read-driver.js');
    const { observeNotesTraces } = await import('../hms/live-notes-traces-read-driver.js');
    const { mintReadCandidateChildren } = await import('../hms/candidate-graph.js');
    const { buildLiveFolioReadManifest, buildLiveDepositLedgerManifest } = await import(
      '../hms/live-read-manifest.js'
    );
    const { createReadToolHandler } = await import('../hms/read-handler-index.js');
    const { CENTURION_HMS_PRODUCTION_ORIGIN, resolveHmsSourceRevision } = await import(
      '../hms/production-runtime.js'
    );
    const { runtimeFingerprintSha256 } = await import('../hms/evidence-runtime.js');
    const { createPostgresPropertyReadLock } = await import('../hms/property-read-lock.js');
    const workerEnv = parseEnv(process.env as Record<string, string | undefined>);
    const propertyReadLock = createPostgresPropertyReadLock({
      tenantId: config.expectedTenant,
      propertyCode: config.expectedPropertyCode,
      databaseUrl: workerEnv.DATABASE_URL,
    });
    const sourceRevision = resolveHmsSourceRevision();
    const runtimeFp = runtimeFingerprintSha256({
      sourceRevision,
      playwrightRevision: '1.63.0',
      chromiumRevision: '1243',
    });
    const findReleaseRaw = active?.releases.get('hms_find_reservation') ?? null;
    const findRelease =
      findReleaseRaw && findReleaseRaw.evidenceKind === 'hms' ? findReleaseRaw : null;
    const quoteReleaseRaw = active?.releases.get('hms_quote_stay') ?? null;
    const quoteRelease =
      quoteReleaseRaw && quoteReleaseRaw.evidenceKind === 'hms' ? quoteReleaseRaw : null;
    const folioReleaseRaw = active?.releases.get('hms_read_folio') ?? null;
    const folioRelease =
      folioReleaseRaw && folioReleaseRaw.evidenceKind === 'hms' ? folioReleaseRaw : null;
    const companyReleaseRaw = active?.releases.get('hms_company_account_read') ?? null;
    const companyRelease =
      companyReleaseRaw && companyReleaseRaw.evidenceKind === 'hms' ? companyReleaseRaw : null;
    const groupReleaseRaw = active?.releases.get('hms_group_block_read') ?? null;
    const groupRelease =
      groupReleaseRaw && groupReleaseRaw.evidenceKind === 'hms' ? groupReleaseRaw : null;
    const eventReleaseRaw = active?.releases.get('hms_event_read') ?? null;
    const eventRelease =
      eventReleaseRaw && eventReleaseRaw.evidenceKind === 'hms' ? eventReleaseRaw : null;
    const notesReleaseRaw = active?.releases.get('hms_read_notes_traces' as never) ?? null;
    const notesRelease =
      notesReleaseRaw && notesReleaseRaw.evidenceKind === 'hms' ? notesReleaseRaw : null;
    const exact = filterExactReservationCandidates(input.lookupCandidates);
    const surnameDates = input.lookupCandidates.filter(
      (c): c is Extract<LookupCandidate, { kind: 'surname_dates' }> => c.kind === 'surname_dates',
    );
    const operationId = input.runId ?? `hms-live-${Date.now()}`;
    const { resolvePlanScopedDraftGate } = await import('../hms/candidate-read-plan.js');
    const candidates = new Map<
      string,
      import('../hms/live-read-manifest.js').ReservationSearchCandidate
    >(exact.map((c) => [c.id, c]));
    // Wave 0b: admit surname+dates only when no exact identity is present.
    if (exact.length === 0) {
      for (const c of surnameDates) {
        candidates.set(c.id, c);
      }
    }
    const planGate = input.readOnly
      ? null
      : resolvePlanScopedDraftGate({
          activeReleases: active?.releases,
          lookupCandidates: candidates,
          operationId,
        });
    if (input.readOnly) {
      const readAdmission = input.readAdmission;
      const admittedRelease =
        input.readToolId === 'hms_read_folio'
          ? folioRelease
          : input.readToolId === 'hms_quote_stay'
            ? quoteRelease
            : input.readToolId === 'hms_company_account_read'
              ? companyRelease
              : input.readToolId === 'hms_group_block_read'
                ? groupRelease
                : input.readToolId === 'hms_event_read'
                  ? eventRelease
                  : input.readToolId === 'hms_read_notes_traces'
                    ? notesRelease
                    : findRelease;
      if (!admittedRelease || active?.handlerPathActive !== true) {
        throw Object.assign(new Error('active read release is required for read admission'), {
          failureClass: 'AUTH' as const,
        });
      }
      if (!readAdmission || readAdmission.releaseId !== admittedRelease.releaseId) {
        throw Object.assign(new Error('read release admission does not match the active release'), {
          failureClass: 'AUTH' as const,
        });
      }
      if (
        !admittedRelease.requestBranches.some(
          (branch) => branch.id === readAdmission.requestBranchId,
        )
      ) {
        throw Object.assign(new Error('read request branch is not enabled on the active release'), {
          failureClass: 'AUTH' as const,
        });
      }
      const admittedBranch = admittedRelease.requestBranches.find(
        (branch) => branch.id === readAdmission.requestBranchId,
      );
      if (
        !readAdmission.manifestSha256 ||
        admittedBranch?.manifestSha256 !== readAdmission.manifestSha256
      ) {
        throw Object.assign(
          new Error('read branch manifest admission does not match the active release'),
          {
            failureClass: 'AUTH' as const,
          },
        );
      }
      if (
        readAdmission.captureRequired &&
        (!input.readResultRef || readAdmission.captureBindingRef !== input.readResultRef)
      ) {
        throw Object.assign(new Error('read capture admission does not match the run fence'), {
          failureClass: 'AUTH' as const,
        });
      }
    }
    const driver = createLiveGuestStayDriver({
      runtime,
      transportId: input.transportId,
      auditSpecFor: input.runId
        ? ({ inputClass }) => ({
            operationId: input.runId!,
            toolId: 'hms_find_reservation',
            toolVersion: '1.2.0',
            dependencyRevision: 'playwright-1.63.0-chromium-1243',
            executionClass: 'normal',
            inputClass,
          })
        : undefined,
      sessionAuthorizationFor: ({ candidate }) => {
        const origin = CENTURION_HMS_PRODUCTION_ORIGIN;
        const manifest = candidate
          ? buildExactOsressSearchManifest(origin, candidate)
          : buildLiveGuestStayReadManifest(origin);
        // Canary / login still get a find-scoped lease — never process-wide alone.
        void liveNotFoundCanaryCandidate;
        const auth = buildHmsFindSessionAuthorization({
          operationId,
          requestBranchId: input.readOnly
            ? input.readAdmission!.requestBranchId
            : 'guest_stay_search',
          manifest,
          roleProofPath: config.roleProofPath,
          roleProofSha256: findRelease?.roleProofSha256 ?? placeholderDigest('role-proof'),
          credentialVersionHmacSha256:
            findRelease?.credentialVersionHmacSha256 ?? placeholderDigest('credential'),
          runtimeFingerprintSha256: findRelease?.runtimeFingerprintSha256 ?? runtimeFp,
          privateDigestKeyVersion: findRelease?.privateDigestKeyVersion ?? 'v1',
          sourceRevision: findRelease?.sourceRevision ?? sourceRevision,
          release: findRelease,
        });
        if (findRelease) {
          assertFindHandlerBound(findRelease, auth);
        }
        return auth;
      },
      // Draft sessions keep their driver-level lock. The independent read
      // adapter instead owns this same dedicated lock around the full typed
      // dispatch, avoiding nested advisory locks on separate connections.
      propertyReadLock: input.readOnly ? undefined : propertyReadLock,
    });
    const quoteDriver = quoteRelease
      ? createLiveQuoteStayDriver({
          runtime,
          transportId: input.transportId,
          auditSpecFor: () => ({
            operationId,
            toolId: 'hms_quote_stay',
            toolVersion: '2.0.0',
            dependencyRevision: 'playwright-1.63.0-chromium-1243',
            executionClass: 'normal',
            inputClass: 'authorized_exact',
            requestBranchId: 'quote_availability_search',
          }),
        })
      : undefined;
    const folioRead =
      input.readOnly && folioRelease
        ? async (candidateId: string, signal: AbortSignal): Promise<ToolResult<unknown>> => {
            const readAdmission = input.readAdmission;
            const candidate = candidates.get(candidateId);
            if (!readAdmission || !candidate || candidate.kind !== 'confirmation') {
              throw Object.assign(new Error('folio read candidate is not an exact reservation'), {
                failureClass: 'AUTH' as const,
              });
            }
            const sections = (input.folioSections ?? ['balance', 'deposits']) as readonly (
              | 'balance'
              | 'deposits'
              | 'transactions'
              | 'authorization'
            )[];
            const operationId = input.runId ?? `hms-folio-${Date.now()}`;
            const scopeHash = createHash('sha256')
              .update(
                JSON.stringify([
                  input.transportId,
                  input.threadId,
                  input.runId ?? null,
                  candidateId,
                  readAdmission.reservationRef,
                ]),
              )
              .digest('hex');
            const sessionId = randomUUID();
            const parentEvidenceId = randomUUID();
            const expiresAt = input.readFence?.deadlineAt ?? new Date(Date.now() + 15 * 60_000);
            const folioDriver = createLiveFolioReadDriver({
              runtime,
              transportId: input.transportId,
              expectedConfirmationToken: candidate.value,
              expectedPropertyCode: propertyCode,
              detailDumpFor: async () => {
                const { dump } = await driver.searchExactThenDetailDump(candidate, signal);
                return dump;
              },
              auditSpecFor: ({ branchId }) => ({
                operationId,
                toolId: 'hms_read_folio',
                toolVersion: '1.0.0',
                dependencyRevision: 'playwright-1.63.0-chromium-1243',
                executionClass: 'normal',
                inputClass: 'authorized_exact',
                requestBranchId: branchId,
              }),
            });
            const steps: Array<
              | Awaited<ReturnType<typeof folioDriver.observeFolioBalance>>
              | Awaited<ReturnType<typeof folioDriver.observeDepositSummary>>
            > = [];

            const observe = async (branchId: 'folio_summary' | 'deposit_ledger_summary') => {
              const branch = folioRelease.requestBranches.find((item) => item.id === branchId);
              if (!branch) {
                throw Object.assign(
                  new Error(`active folio release has no ${branchId} request branch`),
                  { failureClass: 'AUTH' as const },
                );
              }
              const child = mintReadCandidateChildren({
                sessionId,
                parentEvidenceId,
                tools: [{ toolId: 'hms_read_folio', requestBranchId: branch.id }],
                propertyCode,
                scopeHash,
                expiresAt,
              })[0]!;
              const manifest =
                branchId === 'folio_summary'
                  ? buildLiveFolioReadManifest(CENTURION_HMS_PRODUCTION_ORIGIN)
                  : buildLiveDepositLedgerManifest(CENTURION_HMS_PRODUCTION_ORIGIN, propertyCode);
              const authorization = buildHmsFolioSessionAuthorization({
                operationId,
                requestBranchId: branchId,
                manifest,
                roleProofPath: config.roleProofPath,
                roleProofSha256: folioRelease.roleProofSha256 ?? placeholderDigest('folio-role'),
                credentialVersionHmacSha256:
                  folioRelease.credentialVersionHmacSha256 ?? placeholderDigest('folio-credential'),
                runtimeFingerprintSha256: folioRelease.runtimeFingerprintSha256 ?? runtimeFp,
                privateDigestKeyVersion: folioRelease.privateDigestKeyVersion ?? 'v1',
                sourceRevision: folioRelease.sourceRevision ?? sourceRevision,
                expiresAt: expiresAt.toISOString(),
                release: folioRelease,
              });
              createReadToolHandler(folioRelease, authorization);
              if (branchId === 'folio_summary') {
                return folioDriver.observeFolioBalance(authorization, child, signal);
              }
              return folioDriver.observeDepositSummary(authorization, child, signal);
            };

            if (sections.includes('balance')) steps.push(await observe('folio_summary'));
            if (sections.includes('deposits') || sections.includes('transactions')) {
              steps.push(await observe('deposit_ledger_summary'));
            }
            if (steps.length === 0) {
              return {
                status: 'partial',
                draftReady: false,
                data: null,
                unresolvedFields: sections.map((section) => `${section.toUpperCase()}_UNAVAILABLE`),
                evidence: {
                  kind: 'hms' as const,
                  id: randomUUID(),
                  toolId: 'hms_read_folio' as const,
                  toolVersion: '1.0.0',
                  propertyCode,
                  observedAt: new Date().toISOString(),
                  expiresAt: expiresAt.toISOString(),
                  claimKeys: [],
                  sourceHash: createHash('sha256').update('folio-empty').digest('hex'),
                },
              };
            }
            return mergeFolioEvidence(
              steps,
              {
                recipientClass: 'unknown',
                inquiryClass: 'other',
              },
              sections,
              {
                runId: operationId,
                readResultRef: input.readResultRef ?? '',
                transportId: input.transportId,
                threadId: input.threadId,
                triggerMessageId: input.triggerMessageId ?? '',
                candidateId,
                reservationRef: readAdmission.reservationRef ?? '',
                inputDigest: readAdmission.inputDigest,
                requesterAuthorizationId: readAdmission.requesterAuthorizationId,
                releaseId: readAdmission.releaseId,
                requestBranchIds:
                  sections.includes('balance') &&
                  (sections.includes('deposits') || sections.includes('transactions'))
                    ? ['folio_summary', 'deposit_ledger_summary']
                    : sections.includes('balance')
                      ? ['folio_summary']
                      : ['deposit_ledger_summary'],
                captureBindingRef: readAdmission.captureBindingRef ?? input.readResultRef ?? '',
                propertyCode,
                confirmationToken: candidate.value,
                manifestSha256ByBranch: Object.fromEntries(
                  folioRelease.requestBranches.map((item) => [item.id, item.manifestSha256]),
                ) as Partial<Record<'folio_summary' | 'deposit_ledger_summary', string>>,
                scopeHash,
              },
            );
          }
        : undefined;

    const contextAuthorization = (inputData: {
      toolId: 'hms_company_account_read' | 'hms_group_block_read' | 'hms_event_read';
      discoveryOperationId:
        | 'reservation_linked_company_billing'
        | 'group_block_list'
        | 'event_list';
      release: NonNullable<typeof companyRelease>;
      branchId: string;
    }) => {
      const branch = inputData.release.requestBranches.find(
        (candidate) => candidate.id === inputData.branchId,
      );
      if (!branch) {
        throw Object.assign(new Error('linked context release branch is unavailable'), {
          failureClass: 'AUTH' as const,
        });
      }
      return {
        operationId,
        toolId: inputData.toolId,
        discoveryOperationId: inputData.discoveryOperationId,
        releaseId: inputData.release.releaseId,
        requestBranchId: branch.id,
        manifest:
          inputData.toolId === 'hms_group_block_read'
            ? buildLiveGroupBlockListManifest(CENTURION_HMS_PRODUCTION_ORIGIN)
            : buildLiveGuestStayReadManifest(CENTURION_HMS_PRODUCTION_ORIGIN),
        manifestSha256: branch.manifestSha256,
        roleProofPath: config.roleProofPath,
        roleProofSha256: inputData.release.roleProofSha256 ?? placeholderDigest('u15-role'),
        credentialVersionHmacSha256:
          inputData.release.credentialVersionHmacSha256 ?? placeholderDigest('u15-credential'),
        runtimeFingerprintSha256: inputData.release.runtimeFingerprintSha256 ?? runtimeFp,
        privateDigestKeyVersion: inputData.release.privateDigestKeyVersion ?? 'v1',
        sourceRevision: inputData.release.sourceRevision ?? sourceRevision,
        expiresAt:
          input.readFence?.deadlineAt.toISOString() ?? new Date(Date.now() + 60_000).toISOString(),
      } as const;
    };

    const companyAccountRead =
      input.readOnly && companyRelease
        ? async (reservationRef: string, signal: AbortSignal): Promise<ReadResult<unknown>> => {
            const sourceReservationRef = input.linkedContextSourceRef ?? reservationRef;
            const branch = companyRelease.requestBranches.find(
              (candidate) => candidate.id === 'reservation_linked_company_billing',
            );
            if (!branch)
              return unavailableU15Result({
                toolId: 'hms_company_account_read',
                scopeRef: reservationRef,
                requestBranchId: 'reservation_linked_company_billing',
                observedAt: new Date(),
                expiresAt: input.readFence?.deadlineAt ?? new Date(Date.now() + 60_000),
              });
            const child = mintReadCandidateChildren({
              sessionId: randomUUID(),
              parentEvidenceId: randomUUID(),
              tools: [{ toolId: 'hms_company_account_read', requestBranchId: branch.id }],
              propertyCode,
              scopeHash: createHash('sha256').update(sourceReservationRef).digest('hex'),
              expiresAt: input.readFence?.deadlineAt ?? new Date(Date.now() + 60_000),
            })[0]!;
            const authorization = contextAuthorization({
              toolId: 'hms_company_account_read',
              discoveryOperationId: 'reservation_linked_company_billing',
              release: companyRelease,
              branchId: branch.id,
            });
            await createLiveCompanyAccountReadDriver().observeReservationLinkedBilling(
              authorization,
              child,
              signal,
            );
            return unavailableU15Result({
              toolId: 'hms_company_account_read',
              scopeRef: reservationRef,
              requestBranchId: branch.id,
              observedAt: new Date(),
              expiresAt: input.readFence?.deadlineAt ?? new Date(Date.now() + 60_000),
            });
          }
        : undefined;

    const groupBlockRead =
      input.readOnly && groupRelease
        ? async (
            groupRef: string,
            _sections: readonly string[],
            signal: AbortSignal,
          ): Promise<ReadResult<unknown>> => {
            const sourceGroupRef = input.linkedContextSourceRef ?? groupRef;
            const branch = groupRelease.requestBranches.find(
              (candidate) => candidate.id === 'group_block_list',
            );
            if (!branch)
              return unavailableU15Result({
                toolId: 'hms_group_block_read',
                scopeRef: groupRef,
                requestBranchId: 'group_block_list',
                observedAt: new Date(),
                expiresAt: input.readFence?.deadlineAt ?? new Date(Date.now() + 60_000),
              });
            const startDate = new Date();
            const endDate = new Date(startDate.getTime() + 31 * 86_400_000);
            const candidate: GroupReadCandidate = {
              id: createHash('sha256')
                .update(`u15-group:${sourceGroupRef}`)
                .digest('hex')
                .slice(0, 32),
              kind: 'group_block',
              exactGroupReference: sourceGroupRef,
              exactGroupReferenceHash: createHash('sha256')
                .update(`group_ref:${sourceGroupRef}`)
                .digest('hex'),
              startDate: startDate.toISOString().slice(0, 10),
              endDate: endDate.toISOString().slice(0, 10),
            };
            const authorization = contextAuthorization({
              toolId: 'hms_group_block_read',
              discoveryOperationId: 'group_block_list',
              release: groupRelease as NonNullable<typeof companyRelease>,
              branchId: branch.id,
            });
            createReadToolHandler(groupRelease, authorization);
            return createLiveGroupBlockDriver({
              runtime,
              transportId: input.transportId,
              auditSpec: input.runId
                ? {
                    operationId,
                    toolId: 'hms_group_block_read',
                    toolVersion: '1.0.0',
                    dependencyRevision: 'playwright-1.63.0-chromium-1243',
                    executionClass: 'normal',
                    inputClass: 'authorized_exact',
                    requestBranchId: branch.id,
                    sourceRevision: authorization.sourceRevision,
                    roleProofSha256: authorization.roleProofSha256,
                    roleProofExpiresAt: authorization.expiresAt,
                  }
                : undefined,
            }).observeGroupBlockContext(authorization, candidate, signal);
          }
        : undefined;

    const eventRead =
      input.readOnly && eventRelease
        ? async (eventRef: string, signal: AbortSignal): Promise<ReadResult<unknown>> => {
            const sourceEventRef = input.linkedContextSourceRef ?? eventRef;
            const branch = eventRelease.requestBranches.find(
              (candidate) => candidate.id === 'event_list',
            );
            if (!branch)
              return unavailableU15Result({
                toolId: 'hms_event_read',
                scopeRef: eventRef,
                requestBranchId: 'event_list',
                observedAt: new Date(),
                expiresAt: input.readFence?.deadlineAt ?? new Date(Date.now() + 60_000),
              });
            const candidate: EventReadCandidate = {
              id: createHash('sha256')
                .update(`u15-event:${sourceEventRef}`)
                .digest('hex')
                .slice(0, 32),
              kind: 'event_summary',
              exactEventReference: sourceEventRef,
              exactEventReferenceHash: createHash('sha256')
                .update(`event_ref:${sourceEventRef}`)
                .digest('hex'),
            };
            const authorization = contextAuthorization({
              toolId: 'hms_event_read',
              discoveryOperationId: 'event_list',
              release: eventRelease as NonNullable<typeof companyRelease>,
              branchId: branch.id,
            });
            await createLiveEventReadDriver().observeEventListSummary(
              authorization,
              candidate,
              signal,
            );
            return unavailableU15Result({
              toolId: 'hms_event_read',
              scopeRef: eventRef,
              requestBranchId: branch.id,
              observedAt: new Date(),
              expiresAt: input.readFence?.deadlineAt ?? new Date(Date.now() + 60_000),
            });
          }
        : undefined;

    const notesTracesRead =
      input.readOnly && notesRelease
        ? async (notesInput: {
            resourceRef: string;
            states: readonly string[];
            limit: number;
            cursor?: string;
            audience: 'staff' | 'customer';
            signal: AbortSignal;
          }): Promise<ReadResult<unknown>> => {
            const sourceResourceRef = input.linkedContextSourceRef ?? notesInput.resourceRef;
            const branch = notesRelease.requestBranches.find(
              (candidate) => candidate.id === 'notes_traces_list',
            );
            if (!branch)
              return unavailableU15Result({
                toolId: 'hms_read_notes_traces',
                scopeRef: notesInput.resourceRef,
                requestBranchId: 'notes_traces_list',
                observedAt: new Date(),
                expiresAt: input.readFence?.deadlineAt ?? new Date(Date.now() + 60_000),
              });
            const { signal: notesSignal, ...notesRequest } = notesInput;
            const exactCandidate = exact[0];
            return observeNotesTraces(
              {
                operationId,
                toolId: 'hms_read_notes_traces',
                discoveryOperationId: 'notes_traces_list',
                releaseId: notesRelease.releaseId,
                requestBranchId: branch.id,
                manifest: buildLiveGuestStayReadManifest(CENTURION_HMS_PRODUCTION_ORIGIN),
                manifestSha256: branch.manifestSha256,
                roleProofPath: config.roleProofPath,
                roleProofSha256: notesRelease.roleProofSha256 ?? placeholderDigest('notes-role'),
                credentialVersionHmacSha256:
                  notesRelease.credentialVersionHmacSha256 ?? placeholderDigest('notes-credential'),
                runtimeFingerprintSha256: notesRelease.runtimeFingerprintSha256 ?? runtimeFp,
                privateDigestKeyVersion: notesRelease.privateDigestKeyVersion ?? 'v1',
                sourceRevision: notesRelease.sourceRevision ?? sourceRevision,
                expiresAt:
                  input.readFence?.deadlineAt.toISOString() ??
                  new Date(Date.now() + 60_000).toISOString(),
              },
              {
                ...notesRequest,
                resourceRef: sourceResourceRef,
                states: [...notesInput.states] as ('open' | 'completed')[],
              },
              notesSignal,
              {
                detailDumpFor: async (_notes, signal) => {
                  if (!exactCandidate) return null;
                  const { dump } = await driver.searchExactThenDetailDump(exactCandidate, signal);
                  return dump;
                },
              },
            );
          }
        : undefined;
    // openReadSession already authenticates + verifies property; do not open a
    // second pre-tool login session (would create a second audited context).
    return createReservationCandidateSession({
      driver,
      candidates,
      close: async () => undefined,
      propertyCode,
      runId: input.runId,
      readFence: input.readFence,
      readPlanKind: input.readPlanKind ?? 'reservation',
      activeReleases: active?.releases,
      handlerPathActive: active?.handlerPathActive === true,
      candidateBindings: input.readOnly ? undefined : planGate?.candidateBindings,
      requesterAuthorization: input.readOnly ? undefined : planGate?.requesterAuthorization,
      claimAuthorization: input.claimAuthorization,
      quoteDriver,
      quoteCandidates: input.quoteCandidates,
      folioRead,
      companyAccountRead,
      groupBlockRead,
      eventRead,
      notesTracesRead,
      propertyReadLock: input.readOnly ? propertyReadLock : undefined,
      buildQuoteAuthorization: quoteRelease
        ? (quoteCand) => {
            const auth = buildHmsQuoteSessionAuthorization({
              operationId,
              manifest: buildExactOsrravSearchManifest(CENTURION_HMS_PRODUCTION_ORIGIN, quoteCand),
              roleProofPath: config.roleProofPath,
              roleProofSha256: quoteRelease.roleProofSha256 ?? placeholderDigest('quote-role'),
              credentialVersionHmacSha256:
                quoteRelease.credentialVersionHmacSha256 ?? placeholderDigest('quote-credential'),
              runtimeFingerprintSha256: quoteRelease.runtimeFingerprintSha256 ?? runtimeFp,
              privateDigestKeyVersion: quoteRelease.privateDigestKeyVersion ?? 'v1',
              sourceRevision: quoteRelease.sourceRevision ?? sourceRevision,
              release: quoteRelease,
            });
            assertQuoteHandlerBound(quoteRelease, auth);
            return auth;
          }
        : undefined,
    });
  };
}

export type SynchronousHmsFindInput = {
  /** Current authenticated application user; never a caller-authored identity. */
  userId: string;
  transportId: string;
  threadId: string;
  signal?: AbortSignal;
  runtime?: import('../hms/runtime.js').HmsRuntime;
  /** Test-only lower edge; admission and source checks remain production code. */
  sessionFactory?: TrustedSynchronousHmsFindSessionFactory;
};

/**
 * Current application read entry for the first exact reservation lookup.
 * Admission, candidate identity, current app access and active release facts
 * are derived from the real mailbox/database boundary before opening HMS.
 * There is intentionally no ai_workflow_run, claim token, queue, model, or
 * caller-selected reservation value on this path.
 */
export async function executeSynchronousHmsFindReservation(input: SynchronousHmsFindInput) {
  if (input.signal?.aborted) {
    throw synchronousReadError('READ_ABORTED', 'read was aborted');
  }
  const config = requireHmsReadRuntimeConfig(process.env as Record<string, string | undefined>);
  if (!input.userId.trim()) {
    throw Object.assign(new Error('synchronous read requires current application user access'), {
      failureClass: 'AUTH' as const,
    });
  }
  if (input.transportId !== config.expectedTransportId) {
    throw Object.assign(new Error('synchronous read transport does not match configuration'), {
      failureClass: 'AUTH' as const,
    });
  }
  if (!parseEnv(process.env as Record<string, string | undefined>).HMS_READ_SERVICE_ENABLED) {
    throw Object.assign(new Error('HMS_READ_SERVICE_DISABLED'), {
      failureClass: 'POLICY_BLOCK' as const,
    });
  }

  const now = new Date();
  const deadlineAt = new Date(now.getTime() + config.runDeadlineMs);
  const signal = deadlineBoundSynchronousReadSignal(input.signal, deadlineAt);
  assertSynchronousReadActive(signal, deadlineAt);
  const admissionWindow = admitReadBranch({
    now,
    deadlineAt,
    worstCaseMs: READ_BRANCH_WORST_CASE_MS,
  });
  if (!admissionWindow.ok) {
    throw Object.assign(new Error(admissionWindow.code), {
      failureClass: 'RUN_DEADLINE' as const,
    });
  }

  const runtimeFacts = await awaitSynchronousReadSetup({
    operation: () => productionReadRuntimeFacts(config, signal, deadlineAt),
    signal,
    deadlineAt,
  });
  assertSynchronousReadActive(signal, deadlineAt);
  const findReleaseRaw = runtimeFacts.active?.releases.get('hms_find_reservation') ?? null;
  const findRelease =
    findReleaseRaw && findReleaseRaw.evidenceKind === 'hms' ? findReleaseRaw : null;
  const branch = findRelease?.requestBranches.find(
    (candidate) => candidate.id === 'guest_stay_search',
  );
  if (!findRelease || !branch || runtimeFacts.active?.handlerPathActive !== true) {
    throw Object.assign(new Error('active reservation find release is required'), {
      failureClass: 'AUTH' as const,
    });
  }

  const db = getDb();
  const operationId = randomUUID();
  const readResultRef = `hms-sync-${randomUUID()}`;
  const issued = await awaitSynchronousReadSetup({
    operation: () =>
      issueReadAdmissionFromMailbox({
        db,
        userId: input.userId,
        transportId: input.transportId,
        threadId: input.threadId,
        toolId: 'hms_find_reservation',
        releaseId: findRelease.releaseId,
        requestBranchId: branch.id,
        manifestSha256: branch.manifestSha256,
        propertyCode: config.expectedPropertyCode,
        sourceRevision: findRelease.sourceRevision ?? runtimeFacts.sourceRevision,
        captureBindingRef: readResultRef,
      }),
    signal,
    deadlineAt,
  });
  assertSynchronousReadActive(signal, deadlineAt);
  const request = readRequestSchema.parse(issued.readRequest);
  if (request.toolId !== 'hms_find_reservation' || !issued.candidateId) {
    throw Object.assign(
      new Error('synchronous reservation admission did not issue one candidate'),
      {
        failureClass: 'AUTH' as const,
      },
    );
  }

  const [trigger] = await awaitSynchronousReadSetup({
    operation: () =>
      db
        .select({
          id: message.id,
          direction: message.direction,
          textBody: message.textBody,
          htmlBody: message.htmlBody,
          subject: message.subject,
        })
        .from(message)
        .where(
          and(
            eq(message.id, issued.triggerMessageId),
            eq(message.transportId, input.transportId),
            eq(message.threadId, input.threadId),
          ),
        )
        .limit(1),
    signal,
    deadlineAt,
  });
  assertSynchronousReadActive(signal, deadlineAt);
  if (!trigger || trigger.direction !== 'inbound') {
    throw Object.assign(new Error('synchronous read trigger is not current inbound mail'), {
      failureClass: 'AUTH' as const,
    });
  }
  const { extractLookupCandidates, filterExactReservationCandidates, normalizeMessageText } =
    await awaitSynchronousReadSetup({
      operation: () => import('./thread-context.js'),
      signal,
      deadlineAt,
    });
  assertSynchronousReadActive(signal, deadlineAt);
  const triggerText = [
    trigger.subject?.trim() ?? '',
    normalizeMessageText({ textBody: trigger.textBody, htmlBody: trigger.htmlBody }),
  ]
    .filter(Boolean)
    .join('\n');
  const candidate = filterExactReservationCandidates(extractLookupCandidates(triggerText)).find(
    (item) => item.id === issued.candidateId,
  );
  if (!candidate) {
    throw Object.assign(new Error('synchronous read candidate is not in current trigger source'), {
      failureClass: 'AUTH' as const,
    });
  }

  const grant = await awaitSynchronousReadSetup({
    operation: () =>
      loadReadMailboxGrant({
        db,
        userId: input.userId,
        transportId: input.transportId,
      }),
    signal,
    deadlineAt,
  });
  assertSynchronousReadActive(signal, deadlineAt);
  const currentAppAccessProof = issueCurrentAppAccessProof({
    userId: grant.userId,
    mailboxAccessId: grant.accessId,
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: issued.triggerMessageId,
    expiresAt: deadlineAt,
    now,
  });
  assertCurrentAppAccessProof({
    proof: currentAppAccessProof,
    requesterAuthorizationId: grant.accessId,
    context: {
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: issued.triggerMessageId,
    },
    now: new Date(),
  });
  const runtime = input.runtime ?? (await getOrCreateProductionHmsRuntime(signal, deadlineAt));
  assertSynchronousReadActive(signal, deadlineAt);
  const liveSessionFactory = createLiveHmsCandidateSessionFactory({
    runtime,
    activeReadState: runtimeFacts.active,
  });
  const sessionFactory: TrustedSynchronousHmsFindSessionFactory =
    input.sessionFactory ??
    (async (sessionInput) => {
      const session = await liveSessionFactory({
        transportId: sessionInput.transportId,
        threadId: sessionInput.threadId,
        triggerMessageId: sessionInput.triggerMessageId,
        propertyCode: sessionInput.propertyCode,
        lookupCandidates: sessionInput.lookupCandidates,
        signal: sessionInput.signal,
        runId: sessionInput.runId,
        readResultRef: sessionInput.readResultRef,
        readFence: undefined,
        readPlanKind: 'reservation',
        readOnly: true,
        readAdmission: sessionInput.readAdmission,
        readToolId: 'hms_find_reservation',
      });
      return {
        propertyReadLock: session.propertyReadLock,
        close: session.close,
        findReservation: async (lookup) => {
          const legacy = await session.findReservation(lookup.candidateId, sessionInput.signal);
          if (legacy.evidence.kind !== 'hms') {
            throw Object.assign(new Error('reservation read returned non-HMS evidence'), {
              failureClass: 'SCHEMA_DRIFT' as const,
            });
          }
          return mapProductionReservationRead({
            status: legacy.status,
            data: legacy.data
              ? { matches: legacy.data.matches as readonly ReservationRow[] }
              : null,
            evidence: {
              kind: 'hms',
              id: legacy.evidence.id,
              observedAt: legacy.evidence.observedAt,
              expiresAt: legacy.evidence.expiresAt,
            },
          });
        },
      };
    });

  return {
    operationId,
    candidateId: candidate.id,
    ...(await executeTrustedSynchronousHmsFindReservation({
      issued,
      candidate,
      currentAppAccessProof,
      operationId,
      readResultRef,
      sourceRevision: findRelease.sourceRevision ?? runtimeFacts.sourceRevision,
      propertyCode: config.expectedPropertyCode,
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: issued.triggerMessageId,
      deadlineAt,
      now,
      clock: () => new Date(),
      signal,
      sessionFactory,
    })),
  };
}

export type ProductionReservationRead = {
  status: 'ok' | 'partial' | 'not_found' | 'unverified_negative' | 'ambiguous' | 'manual_required';
  data: {
    matches: readonly ReservationRow[];
  } | null;
  evidence: {
    kind: 'hms';
    id: string;
    observedAt: string;
    expiresAt: string;
  };
};

/**
 * Convert the legacy driver result into the closed reservation lookup shape.
 * A negative without a reviewed canonical oracle is never promoted to
 * `not_found`, and an ambiguous result never selects its first row.
 */
export function mapProductionReservationRead(
  legacy: ProductionReservationRead,
): ReservationLookupResult {
  const evidence = {
    evidenceRef: legacy.evidence.id,
    observedAt: legacy.evidence.observedAt,
    expiresAt: legacy.evidence.expiresAt,
  };
  if (legacy.status === 'partial' || legacy.status === 'manual_required') {
    throw Object.assign(
      new Error(`unsupported non-terminal reservation read status: ${legacy.status}`),
      {
        failureClass: 'SCHEMA_DRIFT' as const,
      },
    );
  }

  if (
    legacy.status === 'not_found' ||
    legacy.status === 'unverified_negative' ||
    !legacy.data ||
    legacy.data.matches.length === 0
  ) {
    return { status: 'unverified_negative', ...evidence };
  }

  const rows = legacy.data.matches.map((row) => ({
    ...row,
    // Ambiguous rows are useful only for a bounded count/shape; never expose
    // a guest identity or let the facade mint a selectable reference.
    guestName:
      legacy.status === 'ambiguous' || legacy.data!.matches.length > 1 ? null : row.guestName,
  }));
  if (legacy.status === 'ambiguous' || rows.length !== 1) {
    return { status: 'ambiguous', rows, ...evidence };
  }
  return { status: 'matched', row: rows[0]!, ...evidence };
}

function readResultExpiry(result: ReadResult<unknown>, policyDeadline?: Date): Date {
  const expiries = result.evidence
    .map((evidence) => Date.parse(evidence.expiresAt))
    .filter((value) => Number.isFinite(value));
  if (expiries.length === 0) {
    throw Object.assign(new Error('read result has no valid evidence expiry'), {
      failureClass: 'SCHEMA_DRIFT' as const,
    });
  }
  if (policyDeadline && Number.isFinite(policyDeadline.getTime())) {
    expiries.push(policyDeadline.getTime());
  }
  return new Date(Math.min(...expiries));
}

function readAdmissionAuthError(messageText: string): Error & { failureClass: 'AUTH' } {
  return Object.assign(new Error(messageText), { failureClass: 'AUTH' as const });
}

type MailDocumentAuthority = {
  scope: ExistingDocumentScope;
  records: ExistingDocumentRecord[];
  locators: Map<string, AttachmentLocator>;
  authorizedAttachmentIds: ReadonlySet<string>;
  listHasMore: boolean;
  listBlocker: string | null;
  listWindowTruncated: boolean;
};

function readAdmissionAuthorizationId(request: Record<string, unknown>): string | null {
  const admission = request.admission;
  if (!admission || typeof admission !== 'object') return null;
  const value = (admission as { requesterAuthorizationId?: unknown }).requesterAuthorizationId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function currentMailAttachmentAuthority(input: {
  run: typeof aiWorkflowRun.$inferSelect;
  request: Record<string, unknown>;
  attachmentId: string;
  expectedLocator: AttachmentLocator;
}): Promise<boolean> {
  const authorizationId = readAdmissionAuthorizationId(input.request);
  if (!authorizationId) return false;
  const db = getDb();
  const [grant] = await db
    .select({ id: mailboxAccess.id })
    .from(mailboxAccess)
    .innerJoin(mailboxTransport, eq(mailboxAccess.transportId, mailboxTransport.id))
    .where(
      and(
        eq(mailboxAccess.id, authorizationId),
        eq(mailboxAccess.transportId, input.run.transportId),
        eq(mailboxTransport.isActive, true),
      ),
    )
    .limit(1);
  if (!grant) return false;

  const [trigger] = await db
    .select({
      id: message.id,
      receivedAt: message.receivedAt,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.id, input.run.triggerMessageId),
        eq(message.threadId, input.run.threadId),
        eq(message.transportId, input.run.transportId),
        eq(message.direction, 'inbound'),
      ),
    )
    .limit(1);
  if (!trigger) return false;

  const [row] = await db
    .select({
      id: attachment.id,
      messageId: attachment.messageId,
      s3Key: attachment.s3Key,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      direction: message.direction,
      receivedAt: message.receivedAt,
    })
    .from(attachment)
    .innerJoin(message, eq(message.id, attachment.messageId))
    .where(
      and(
        eq(attachment.id, input.attachmentId),
        eq(message.threadId, input.run.threadId),
        eq(message.transportId, input.run.transportId),
      ),
    )
    .limit(1);
  if (!row || row.direction !== 'inbound' || !row.receivedAt) return false;

  const triggerAt = trigger.receivedAt ?? trigger.createdAt;
  if (row.receivedAt > triggerAt) return false;
  return (
    row.messageId === input.expectedLocator.messageId &&
    row.s3Key === input.expectedLocator.s3Key &&
    row.mimeType === input.expectedLocator.mimeType &&
    row.sizeBytes === input.expectedLocator.sizeBytes
  );
}

/**
 * Resolve the mail source from current DB rows. The worker creates this for
 * every queued execution; no process-local document-ref map is authoritative.
 */
async function loadMailDocumentAuthority(input: {
  run: typeof aiWorkflowRun.$inferSelect;
  request: Record<string, unknown>;
  includeHashes: boolean;
  requestedKind?:
    | 'reservation_confirmation'
    | 'tax_invoice'
    | 'pro_forma'
    | 'folio'
    | 'statement'
    | 'contract'
    | 'supplier_compliance'
    | 'property_information'
    | 'other_existing';
  requestedPriceVisibility?: 'allowed' | 'forbidden' | 'unknown';
}): Promise<MailDocumentAuthority> {
  const db = getDb();
  const [trigger] = await db
    .select({
      id: message.id,
      receivedAt: message.receivedAt,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.id, input.run.triggerMessageId),
        eq(message.threadId, input.run.threadId),
        eq(message.transportId, input.run.transportId),
        eq(message.direction, 'inbound'),
      ),
    )
    .limit(1);
  if (!trigger) throw readAdmissionAuthError('document trigger is no longer in scope');

  const scope: ExistingDocumentScope = {
    scopeRef: existingDocumentScopeRef({
      transportId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
    }),
    // The mail schema has no independently-authoritative property/guest/stay
    // document identity. Keep these explicit as unknown instead of copying
    // message labels into the source scope.
    propertyRef: 'unknown',
    guestRef: null,
    stayStart: null,
    stayEnd: null,
    payerRef: null,
    requestedKind: input.requestedKind ?? null,
    requestedPriceVisibility: input.requestedPriceVisibility ?? 'allowed',
  };

  const requestedSource =
    input.request.source === 'mail_attachment' || input.request.source === 'hms_sent_attachment'
      ? input.request.source
      : null;
  const requestedLimit =
    typeof input.request.limit === 'number'
      ? Math.min(Math.max(Math.trunc(input.request.limit), 1), DOCUMENT_LIST_MAX_ROWS)
      : 20;
  const requestedCursor = typeof input.request.cursor === 'string' ? input.request.cursor : null;
  const listRequest = input.includeHashes && input.request.toolId === 'documents_list_existing';
  const sourcePredicate =
    requestedSource === 'mail_attachment'
      ? eq(message.direction, 'inbound')
      : requestedSource === 'hms_sent_attachment'
        ? eq(message.direction, 'outbound')
        : undefined;
  const causalHorizon = trigger.receivedAt
    ? or(
        and(eq(message.direction, 'inbound'), lte(message.receivedAt, trigger.receivedAt)),
        and(eq(message.direction, 'outbound'), lte(message.sentAt, trigger.receivedAt)),
      )
    : eq(message.id, trigger.id);
  const sourceQuery = db
    .select({
      id: attachment.id,
      messageId: attachment.messageId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      s3Key: attachment.s3Key,
      sha256: attachment.sha256,
      direction: message.direction,
      receivedAt: message.receivedAt,
      sentAt: message.sentAt,
      createdAt: message.createdAt,
    })
    .from(attachment)
    .innerJoin(message, eq(message.id, attachment.messageId))
    .where(
      and(
        eq(message.threadId, input.run.threadId),
        eq(message.transportId, input.run.transportId),
        causalHorizon,
        sourcePredicate,
      ),
    )
    .orderBy(
      asc(message.receivedAt),
      asc(message.sentAt),
      asc(message.createdAt),
      asc(attachment.id),
    );
  const rows = listRequest
    ? await sourceQuery.limit(requestedCursor ? DOCUMENT_LIST_MAX_ROWS + 1 : requestedLimit + 1)
    : await sourceQuery.limit(DOCUMENT_LIST_MAX_ROWS + 1);
  const listWindowTruncated = listRequest && rows.length > DOCUMENT_LIST_MAX_ROWS;
  const materializedRows = listRequest ? rows.slice(0, DOCUMENT_LIST_MAX_ROWS) : rows;
  const authorizedAttachmentIds = new Set(materializedRows.map((row) => row.id));
  const locators = new Map<string, AttachmentLocator>(
    materializedRows.map((row) => [
      row.id,
      {
        s3Key: row.s3Key,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        messageId: row.messageId,
        sha256: row.sha256,
      },
    ]),
  );
  const records = materializedRows.map((row) =>
    mailAttachmentRecord({
      scope,
      source: row.direction === 'outbound' ? 'hms_sent_attachment' : 'mail_attachment',
      attachmentId: row.id,
      authorizedAttachmentIds,
      messageId: row.messageId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      s3Key: row.s3Key,
      // Filename is a display/type hint only; message bodies are intentionally
      // not selected for this conservative unknown-metadata path.
      text: row.filename,
      observedAt:
        (row.direction === 'inbound' ? row.receivedAt : row.sentAt)?.toISOString() ?? null,
    }),
  );
  if (!input.includeHashes) {
    return {
      scope,
      records,
      locators,
      authorizedAttachmentIds,
      listHasMore: false,
      listBlocker: null,
      listWindowTruncated: false,
    };
  }

  const sourceIndices = records.reduce<number[]>((indices, record, index) => {
    if (requestedSource === null || record.source === requestedSource) indices.push(index);
    return indices;
  }, []);
  let aggregateBytes = 0;
  let listBlocker: string | null = null;

  const hashRecordAt = async (index: number): Promise<boolean> => {
    const record = records[index];
    if (!record || record.source !== 'mail_attachment' || !record.attachment || record.sha256) {
      return true;
    }
    const sizeBytes = record.attachment.locator.sizeBytes;
    if (aggregateBytes + sizeBytes > DOCUMENT_LIST_MAX_BYTES) {
      listBlocker ??= 'LIST_BYTE_LIMIT';
      return false;
    }
    const bytes = await readAuthorizedArtifactBytes({
      attachmentId: record.attachment.attachmentId,
      authorizedAttachmentIds,
      s3: getS3Storage(),
      signal: AbortSignal.timeout(30_000),
      resolveLocator: async (attachmentId) => locators.get(attachmentId) ?? null,
      expectedLocator: record.attachment.locator,
      revalidate: () =>
        currentMailAttachmentAuthority({
          run: input.run,
          request: input.request,
          attachmentId: record.attachment!.attachmentId,
          expectedLocator: record.attachment!.locator,
        }),
    });
    if (!bytes) {
      listBlocker ??= 'LIST_SOURCE_UNAVAILABLE';
      return false;
    }
    aggregateBytes += bytes.body.byteLength;
    records[index] = {
      ...record,
      sha256: bytes.sha256,
      attachment: { ...record.attachment, expectedSha256: bytes.sha256 },
    };
    return true;
  };

  let pageStart = 0;
  if (requestedCursor) {
    let cursorFound = false;
    const scanLimit = Math.min(sourceIndices.length, DOCUMENT_LIST_MAX_ROWS);
    for (let sourceIndex = 0; sourceIndex < scanLimit; sourceIndex += 1) {
      const recordIndex = sourceIndices[sourceIndex]!;
      if (!(await hashRecordAt(recordIndex))) break;
      if (existingDocumentRefForRecord(records[recordIndex]!) === requestedCursor) {
        pageStart = sourceIndex + 1;
        cursorFound = true;
        break;
      }
    }
    if (!cursorFound) listBlocker ??= 'LIST_CURSOR_UNRESOLVED';
  }

  if (!listBlocker) {
    const pageIndices = sourceIndices.slice(pageStart, pageStart + requestedLimit);
    for (const recordIndex of pageIndices) {
      if (!(await hashRecordAt(recordIndex))) break;
    }
  }

  const listHasMore =
    listBlocker !== null ||
    pageStart + requestedLimit < sourceIndices.length ||
    listWindowTruncated;
  return {
    scope,
    records,
    locators,
    authorizedAttachmentIds,
    listHasMore,
    listBlocker,
    listWindowTruncated,
  };
}

function createMailDocumentService(input: {
  run: typeof aiWorkflowRun.$inferSelect;
  signal: AbortSignal;
  request: Record<string, unknown>;
}) {
  const requestedKind =
    input.request.toolId === 'documents_list_existing' &&
    Array.isArray(input.request.kinds) &&
    input.request.kinds.length === 1
      ? (input.request.kinds[0] as Parameters<typeof loadMailDocumentAuthority>[0]['requestedKind'])
      : undefined;
  const requestedPriceVisibility =
    input.request.toolId === 'documents_list_existing'
      ? (input.request.requestedPriceVisibility as 'allowed' | 'forbidden' | 'unknown' | undefined)
      : 'allowed';
  let authorityPromise: Promise<MailDocumentAuthority> | undefined;
  const authority = () =>
    (authorityPromise ??= loadMailDocumentAuthority({
      run: input.run,
      request: input.request,
      includeHashes: input.request.toolId === 'documents_list_existing',
      requestedKind,
      requestedPriceVisibility,
    }));

  const resolveCurrentLocator = async (attachmentId: string): Promise<AttachmentLocator | null> => {
    const rows = await getDb()
      .select({
        id: attachment.id,
        messageId: attachment.messageId,
        s3Key: attachment.s3Key,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
      })
      .from(attachment)
      .innerJoin(message, eq(message.id, attachment.messageId))
      .where(
        and(
          eq(attachment.id, attachmentId),
          eq(message.threadId, input.run.threadId),
          eq(message.transportId, input.run.transportId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const locator = {
      s3Key: row.s3Key,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      messageId: row.messageId,
      sha256: row.sha256,
    } satisfies AttachmentLocator;
    return (await currentMailAttachmentAuthority({
      run: input.run,
      request: input.request,
      attachmentId,
      expectedLocator: locator,
    }))
      ? locator
      : null;
  };

  const source = (sourceId: 'mail_attachment' | 'hms_sent_attachment') => ({
    source: sourceId,
    async list({
      scope,
      limit,
      cursor,
    }: {
      scope: ExistingDocumentScope;
      limit: number;
      cursor?: string;
    }) {
      const current = await authority();
      if (current.scope.scopeRef !== scope.scopeRef) {
        return { records: [], inventoryComplete: true, blocker: 'SCOPE_DENIED' };
      }
      // Sent-log metadata is intentionally non-retrievable. Keep the source
      // outcome explicit even when the underlying thread has only inbound
      // attachment rows.
      const records =
        sourceId === 'mail_attachment'
          ? current.records.filter((record) => record.source === 'mail_attachment')
          : current.records.filter((record) => record.source === sourceId);
      if (current.listBlocker === 'LIST_CURSOR_UNRESOLVED') {
        return {
          records: [],
          inventoryComplete: false,
          hasMore: false,
          blocker: current.listBlocker,
        };
      }
      const pageLimit = Math.min(Math.max(Math.trunc(limit), 1), DOCUMENT_LIST_MAX_ROWS);
      let start = 0;
      let pageBlocker = current.listBlocker ?? undefined;
      if (cursor) {
        start = records.findIndex((record) => existingDocumentRefForRecord(record) === cursor);
        if (start < 0) {
          return {
            records: [],
            inventoryComplete: false,
            hasMore: false,
            blocker: 'LIST_CURSOR_UNRESOLVED',
          };
        }
        if (
          pageBlocker === undefined &&
          current.listWindowTruncated &&
          start + pageLimit >= records.length
        ) {
          pageBlocker = 'LIST_ROW_LIMIT';
        }
      }
      const pageRecords = records.slice(start, start + pageLimit + 1);
      const hasMore =
        pageBlocker === 'LIST_ROW_LIMIT'
          ? false
          : current.listHasMore || start + pageRecords.length < records.length;
      return {
        records: pageRecords,
        inventoryComplete: pageBlocker === undefined && !hasMore,
        hasMore,
        blocker: pageBlocker,
      };
    },
  });

  return createExistingDocumentService({
    now: () => new Date(),
    resolveScope: async (scopeRef) => {
      const current = await authority();
      return current.scope.scopeRef === scopeRef ? current.scope : null;
    },
    resolveDocument: async (documentRef) => {
      const current = await authority();
      const expectedSha256 = existingDocumentSha256FromRef(documentRef);
      for (const record of current.records) {
        const candidate = expectedSha256
          ? {
              ...record,
              sha256: expectedSha256,
              attachment: record.attachment ? { ...record.attachment, expectedSha256 } : undefined,
            }
          : record;
        if (existingDocumentRefForRecord(candidate) === documentRef) {
          return { record: candidate, scope: current.scope };
        }
      }
      return null;
    },
    sources: {
      mail_attachment: source('mail_attachment'),
      hms_sent_attachment: source('hms_sent_attachment'),
    },
    readArtifact: async (attachmentValue) =>
      readAuthorizedArtifact({
        attachmentId: attachmentValue.attachmentId,
        authorizedAttachmentIds: (await authority()).authorizedAttachmentIds,
        s3: getS3Storage(),
        signal: input.signal,
        resolveLocator: resolveCurrentLocator,
        expectedLocator: attachmentValue.locator,
        revalidate: () =>
          currentMailAttachmentAuthority({
            run: input.run,
            request: input.request,
            attachmentId: attachmentValue.attachmentId,
            expectedLocator: attachmentValue.locator,
          }),
      }),
    readBytes: async (attachmentValue) =>
      readAuthorizedArtifactBytes({
        attachmentId: attachmentValue.attachmentId,
        authorizedAttachmentIds: (await authority()).authorizedAttachmentIds,
        s3: getS3Storage(),
        signal: input.signal,
        resolveLocator: resolveCurrentLocator,
        expectedLocator: attachmentValue.locator,
        expectedSha256: attachmentValue.expectedSha256,
        revalidate: () =>
          currentMailAttachmentAuthority({
            run: input.run,
            request: input.request,
            attachmentId: attachmentValue.attachmentId,
            expectedLocator: attachmentValue.locator,
          }),
      }),
  });
}

/**
 * Revalidate the issuer's authority from current DB state before any session or
 * PMS boundary. The persisted JSON is evidence to check, never authority by
 * itself: the mailbox access row and (for context reads) the succeeded parent
 * receipt are looked up again here.
 */
async function assertCurrentReadAdmissionAuthority(input: {
  run: typeof aiWorkflowRun.$inferSelect;
  request: Record<string, unknown>;
  admission: ReadAdmissionBinding;
  now: Date;
  expectedPropertyCode: string;
  expectedSourceRevision: string;
}): Promise<CurrentAppAccessProof & { contextReference: LinkedContextReference | null }> {
  const metrics =
    input.run.metrics && typeof input.run.metrics === 'object'
      ? (input.run.metrics as Record<string, unknown>)
      : null;
  let issuerData: ReturnType<typeof assertPersistedReadAdmissionIssuer>;
  try {
    const expectedToolId = input.request.toolId;
    if (
      expectedToolId !== 'hms_find_reservation' &&
      expectedToolId !== 'hms_quote_stay' &&
      expectedToolId !== 'hms_read_reservation' &&
      expectedToolId !== 'hms_read_folio' &&
      expectedToolId !== 'hms_company_account_read' &&
      expectedToolId !== 'hms_group_block_read' &&
      expectedToolId !== 'hms_event_read' &&
      expectedToolId !== 'hms_read_notes_traces' &&
      expectedToolId !== 'documents_list_existing' &&
      expectedToolId !== 'documents_read_existing'
    ) {
      throw new Error('read admission request tool is not supported');
    }
    issuerData = assertPersistedReadAdmissionIssuer({
      issuer: metrics?.readAdmissionIssuer,
      request: input.request,
      run: input.run,
      expectedMailboxAccessId: input.admission.requesterAuthorizationId,
      expectedToolId,
    });
  } catch (error) {
    throw readAdmissionAuthError(
      error instanceof Error ? error.message : 'read admission issuer provenance is invalid',
    );
  }

  const [grant] = await getDb()
    .select({ id: mailboxAccess.id })
    .from(mailboxAccess)
    .innerJoin(mailboxTransport, eq(mailboxAccess.transportId, mailboxTransport.id))
    .where(
      and(
        eq(mailboxAccess.id, issuerData.mailboxAccessId),
        eq(mailboxAccess.userId, issuerData.userId),
        eq(mailboxAccess.transportId, input.run.transportId),
        eq(mailboxTransport.isActive, true),
      ),
    )
    .limit(1);
  if (!grant) throw readAdmissionAuthError('read admission mailbox grant is no longer active');

  const [trigger] = await getDb()
    .select({ id: message.id, direction: message.direction })
    .from(message)
    .where(
      and(
        eq(message.id, input.run.triggerMessageId),
        eq(message.threadId, input.run.threadId),
        eq(message.transportId, input.run.transportId),
      ),
    )
    .limit(1);
  if (!trigger || trigger.direction !== 'inbound') {
    throw readAdmissionAuthError(
      'read admission trigger is not the current scoped inbound message',
    );
  }

  const issueCurrentAccess = () =>
    issueCurrentAppAccessProof({
      userId: issuerData.userId,
      mailboxAccessId: issuerData.mailboxAccessId,
      transportId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      expiresAt: input.run.deadlineAt ?? new Date(input.now.getTime() + 5 * 60_000),
      now: input.now,
    });

  if (
    input.request.toolId !== 'hms_read_reservation' &&
    input.request.toolId !== 'hms_read_folio' &&
    input.request.toolId !== 'hms_company_account_read' &&
    input.request.toolId !== 'hms_group_block_read' &&
    input.request.toolId !== 'hms_event_read' &&
    input.request.toolId !== 'hms_read_notes_traces'
  ) {
    if (issuerData.parentReadResultRef !== null || issuerData.evidenceExpiresAt !== null) {
      throw readAdmissionAuthError('find admission unexpectedly carries a parent receipt');
    }
    return Object.assign(issueCurrentAccess(), { contextReference: null });
  }

  if (!issuerData.parentReadResultRef || !issuerData.evidenceExpiresAt) {
    throw readAdmissionAuthError('resolved read admission has no parent positive receipt');
  }
  const issuedAtMs = Date.parse(issuerData.reservationRefIssuedAt ?? '');
  const expiresAtMs = Date.parse(issuerData.reservationRefExpiresAt ?? '');
  if (
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    issuedAtMs > input.now.getTime() ||
    expiresAtMs <= input.now.getTime()
  ) {
    throw readAdmissionAuthError('resolved read admission reference is expired or not yet issued');
  }

  const [parent] = await getDb()
    .select()
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.readResultRef, issuerData.parentReadResultRef),
        eq(aiWorkflowRun.runKind, 'read_tool'),
        eq(aiWorkflowRun.transportId, input.run.transportId),
        eq(aiWorkflowRun.threadId, input.run.threadId),
        eq(aiWorkflowRun.triggerMessageId, input.run.triggerMessageId),
      ),
    )
    .limit(1);
  if (!parent)
    throw readAdmissionAuthError('resolved read admission parent receipt is out of scope');
  const parentRequest = readRequestSchema.safeParse(parent.readRequest);
  if (!parentRequest.success || parentRequest.data.toolId !== 'hms_find_reservation') {
    throw readAdmissionAuthError('resolved read admission parent is not a find receipt');
  }
  const parentAdmission = parentRequest.data.admission;
  if (!parentAdmission || parentAdmission.requesterAuthorizationId !== issuerData.mailboxAccessId) {
    throw readAdmissionAuthError('resolved read admission parent requester is not current');
  }
  const parentMetrics =
    parent.metrics && typeof parent.metrics === 'object'
      ? (parent.metrics as Record<string, unknown>)
      : null;
  try {
    assertPersistedReadAdmissionIssuer({
      issuer: parentMetrics?.readAdmissionIssuer,
      request: parentRequest.data as unknown as Record<string, unknown>,
      run: parent,
      expectedUserId: issuerData.userId,
      expectedMailboxAccessId: issuerData.mailboxAccessId,
      expectedToolId: 'hms_find_reservation',
    });
  } catch (error) {
    throw readAdmissionAuthError(
      error instanceof Error ? error.message : 'resolved read admission parent issuer is invalid',
    );
  }
  const parentReceipt = await readAiRunReceipt(
    {
      readResultRef: issuerData.parentReadResultRef,
      transportId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      requesterAuthorizationId: issuerData.mailboxAccessId,
      now: input.now,
    },
    getDb(),
  );
  if (!parentReceipt)
    throw readAdmissionAuthError(
      'resolved read admission parent receipt is expired or unavailable',
    );
  const parentResult = reservationFindResultSchema.safeParse(parentReceipt.result);
  if (!parentResult.success)
    throw readAdmissionAuthError('resolved read admission parent result is malformed');
  const evidenceExpiry = positiveFindEvidence({ result: parentResult.data, now: input.now });
  if (issuerData.evidenceExpiresAt !== evidenceExpiry) {
    throw readAdmissionAuthError(
      'resolved read admission evidence expiry was refreshed or tampered',
    );
  }
  if (
    (input.request.toolId === 'hms_read_reservation' ||
      input.request.toolId === 'hms_read_folio') &&
    parentRequest.data.candidateId !== input.request.candidateId
  ) {
    throw readAdmissionAuthError(
      'resolved read admission candidate is not bound to the parent receipt',
    );
  }
  let contextReference: LinkedContextReference | null = null;
  const contextKind: LinkedContextReferenceKind | null =
    input.request.toolId === 'hms_company_account_read'
      ? 'company'
      : input.request.toolId === 'hms_group_block_read'
        ? 'group'
        : input.request.toolId === 'hms_event_read'
          ? 'event'
          : input.request.toolId === 'hms_read_notes_traces'
            ? 'notes'
            : null;
  if (contextKind) {
    const parentBindings = Array.isArray(parentMetrics?.linkedContextReferences)
      ? parentMetrics.linkedContextReferences
          .map((value) => linkedContextReferenceSchema.safeParse(value))
          .filter(
            (value): value is { success: true; data: LinkedContextReference } => value.success,
          )
          .map((value) => value.data)
      : [];
    const requestedReference = input.admission.reservationRef;
    const candidateBinding = parentBindings.find(
      (binding) => binding.reference === requestedReference && binding.kind === contextKind,
    );
    if (!candidateBinding || !issuerData.contextReference) {
      throw readAdmissionAuthError(
        'resolved linked context reference is not bound to the parent source result',
      );
    }
    try {
      contextReference = assertLinkedContextReference({
        binding: candidateBinding,
        reference: requestedReference ?? '',
        kind: contextKind,
        parentReadResultRef: issuerData.parentReadResultRef,
        propertyCode: input.expectedPropertyCode,
        requestBranchId: parentRequest.data.admission?.requestBranchId ?? '',
        sourceRevision: input.expectedSourceRevision,
        now: input.now,
        maximumExpiry: evidenceExpiry,
      });
      if (
        issuerData.contextReference.reference !== contextReference.reference ||
        issuerData.contextReference.sourceRef !== contextReference.sourceRef
      ) {
        throw new Error('queued context binding differs from the current parent binding');
      }
    } catch (error) {
      throw readAdmissionAuthError(
        error instanceof Error
          ? error.message
          : 'resolved linked context reference is stale or mismatched',
      );
    }
  } else if (issuerData.contextReference !== null) {
    throw readAdmissionAuthError('reservation context binding is invalid for this read branch');
  }
  return Object.assign(issueCurrentAccess(), { contextReference });
}

function unavailableU15Result(input: {
  toolId:
    | 'hms_company_account_read'
    | 'hms_group_block_read'
    | 'hms_event_read'
    | 'hms_read_notes_traces';
  scopeRef: string;
  requestBranchId: string;
  observedAt: Date;
  expiresAt: Date;
}): ReadResult<unknown> {
  const evidenceRef = `u15-${input.toolId}-${input.observedAt.getTime()}`;
  const expiresAt = input.expiresAt.toISOString();
  const observedAt = input.observedAt.toISOString();
  const unknownField = () =>
    unknownFact({
      reasonCode: 'SOURCE_UNAVAILABLE',
      evidenceRef,
      observedAt,
      expiresAt,
    });
  const unavailableSection = (reasonCode: 'SOURCE_UNAVAILABLE' | 'SURFACE_UNPROVEN') => ({
    state: 'unavailable' as const,
    data: null,
    reasonCode,
    issues: [
      {
        code: reasonCode,
        retryable: false,
        safeNextAction: 'manual_review' as const,
      },
    ],
  });
  let data: unknown;
  let unavailableSections: Array<{
    section: string;
    reasonCode: 'SOURCE_UNAVAILABLE' | 'SURFACE_UNPROVEN';
  }>;
  if (input.toolId === 'hms_company_account_read') {
    data = {
      companyRef: unknownField(),
      billingMode: unknownField(),
      paymentTerms: unknownField(),
      requiredPaperwork: unknownField(),
      billingReference: unknownField(),
      arAccountRef: unknownField(),
      organizationRef: unknownField(),
      agencyRef: unknownField(),
      negotiatedRateRefs: unknownField(),
      restrictions: unknownField(),
      audience: unknownField(),
    };
    unavailableSections = [{ section: 'company', reasonCode: 'SOURCE_UNAVAILABLE' }];
    companyAccountContextDataSchema.parse(data);
  } else if (input.toolId === 'hms_group_block_read') {
    data = {
      summary: {
        state: 'available' as const,
        data: {
          groupRef: unknownField(),
          status: unknownField(),
          startDate: unknownField(),
          endDate: unknownField(),
          releasePolicy: unknownField(),
          billingRef: unknownField(),
        },
        completeness: 'unknown' as const,
        issues: [],
      },
      blocks: unavailableSection('SURFACE_UNPROVEN'),
      delegates: unavailableSection('SOURCE_UNAVAILABLE'),
    };
    unavailableSections = [
      { section: 'blocks', reasonCode: 'SURFACE_UNPROVEN' },
      { section: 'delegates', reasonCode: 'SOURCE_UNAVAILABLE' },
    ];
    groupBlockContextDataSchema.parse(data);
  } else if (input.toolId === 'hms_event_read') {
    data = {
      eventRef: unknownField(),
      source: unknownField(),
      masterRef: unknownField(),
      status: unknownField(),
      startAt: unknownField(),
      endAt: unknownField(),
      layout: unknownField(),
      persons: unknownField(),
      setup: unknownField(),
      lines: unavailableSection('SURFACE_UNPROVEN'),
      quotedAmount: unknownField(),
      contractedAmount: unknownField(),
      depositAmount: unknownField(),
      depositReceived: unknownField(),
      depositDueDate: unknownField(),
      linkedRefs: unknownField(),
    };
    unavailableSections = [{ section: 'event', reasonCode: 'SURFACE_UNPROVEN' }];
    eventContextDataSchema.parse(data);
  } else {
    data = { notes: unavailableSection('SOURCE_UNAVAILABLE') };
    unavailableSections = [{ section: 'notes', reasonCode: 'SOURCE_UNAVAILABLE' }];
    notesTracesContextDataSchema.parse(data);
  }
  return readResultSchema.parse({
    toolId: input.toolId,
    schemaVersion: 'hms-u15-context/1',
    status: 'manual_required',
    data,
    completeness: 'unknown',
    unavailableSections,
    scopeRef: input.scopeRef,
    evidence: [
      {
        evidenceRef,
        sourceSystem: 'hms' as const,
        sourceSurface: input.toolId,
        requestBranchId: input.requestBranchId,
        observedAt,
        sourceUpdatedAt: null,
        expiresAt,
        scopeVerified: true,
        artifactRef: null,
      },
    ],
    page: null,
    issues: [
      {
        code: 'SOURCE_UNAVAILABLE' as const,
        retryable: false,
        safeNextAction: 'manual_review' as const,
      },
    ],
  }) as ReadResult<unknown>;
}

/**
 * Normal worker read_tool executor.  The request contains only an opaque
 * candidate ID; this function re-derives the bounded candidate map from the
 * trigger thread before opening the audited, property-locked Guest Stay
 * session.  No model/workflow client is constructed on this path.
 */
async function executeProductionReadTool(input: {
  run: typeof aiWorkflowRun.$inferSelect;
  fence: AiRunFence;
  signal: AbortSignal;
  /** Tests may replace only the PMS/session boundary, not the executor. */
  sessionFactory?: CandidateSessionFactory;
  /** Lower browser/PMS edge substitution; registry and handler proof stay real. */
  runtime?: import('../hms/runtime.js').HmsRuntime;
  /** Internal server-owned source seam; absent production source fails closed. */
  quoteReferenceAuthorityLoader?: QuoteReferenceAuthorityLoader;
}): Promise<{
  result: ReadResult<unknown>;
  readResultRef: string;
  linkedContextReferences?: import('../hms/context-read-reference.js').LinkedContextReference[];
}> {
  const request = readRequestSchema.parse(input.run.readRequest);
  const { resolveHmsSourceRevision } = await import('../hms/production-runtime.js');
  // Existing-document reads are DB-backed mail-source reads, not HMS/PMS
  // browser reads. Keep their release revision applicable without requiring
  // an HMS build revision; every PMS branch still resolves a concrete HMS
  // source revision below.
  const sourceRevision =
    request.toolId === 'documents_list_existing' || request.toolId === 'documents_read_existing'
      ? 'mail-existing-documents-v1'
      : resolveHmsSourceRevision();
  const expectedPropertyCode =
    request.toolId === 'documents_list_existing' || request.toolId === 'documents_read_existing'
      ? ''
      : request.toolId === 'hms_quote_stay'
        ? request.quoteRequest.propertyCode
        : request.toolId === 'hms_read_folio'
          ? requireHmsReadRuntimeConfig(process.env as Record<string, string | undefined>)
              .expectedPropertyCode
          : readToolExpectedPropertyCode(process.env);
  const admission = 'admission' in request ? request.admission : undefined;
  if (!admission) {
    throw Object.assign(new Error('read_tool requires trusted release/input/capture admission'), {
      failureClass: 'AUTH' as const,
    });
  }
  if (
    (request.toolId === 'hms_quote_stay' ||
      request.toolId === 'hms_read_folio' ||
      request.toolId === 'hms_company_account_read' ||
      request.toolId === 'hms_group_block_read' ||
      request.toolId === 'hms_event_read' ||
      request.toolId === 'hms_read_notes_traces') &&
    !admission.manifestSha256
  ) {
    throw Object.assign(new Error('read branch manifest admission is missing'), {
      failureClass: 'AUTH' as const,
    });
  }
  if (
    admission.captureRequired &&
    (!input.run.readResultRef || admission.captureBindingRef !== input.run.readResultRef)
  ) {
    throw Object.assign(new Error('read capture admission does not match private result scope'), {
      failureClass: 'AUTH' as const,
    });
  }
  const currentAppAccessProof = await assertCurrentReadAdmissionAuthority({
    run: input.run,
    request: request as unknown as Record<string, unknown>,
    admission,
    now: new Date(),
    expectedPropertyCode,
    expectedSourceRevision: sourceRevision,
  });

  // Mail-document reads revalidate through the DB-backed source adapter and
  // never construct a PMS candidate/session. Reuse the accepted Postgres
  // property advisory lock so the full typed dispatch and final byte checks
  // share one real serialization boundary.
  if (
    request.toolId === 'documents_list_existing' ||
    request.toolId === 'documents_read_existing'
  ) {
    const service = createMailDocumentService({
      run: input.run,
      signal: input.signal,
      request: request as unknown as Record<string, unknown>,
    });
    const { createPostgresPropertyReadLock } = await import('../hms/property-read-lock.js');
    const workerEnv = parseEnv(process.env as Record<string, string | undefined>);
    const mailReadLock = createPostgresPropertyReadLock({
      tenantId: input.run.transportId,
      propertyCode: 'MAIL',
      databaseUrl: workerEnv.DATABASE_URL,
    });
    const readContext: ReadExecutionContext = {
      transportId: input.run.transportId,
      mailboxId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      propertyCode: 'MAIL',
      sourceRevision,
      parentRef: input.run.id,
      branchId: admission.requestBranchId,
      releaseId: admission.releaseId,
      requester: {
        authorizationId: admission.requesterAuthorizationId,
        transportId: input.run.transportId,
        threadId: input.run.threadId,
        triggerMessageId: input.run.triggerMessageId,
        allowedClaimKinds: ['document_metadata'],
        expiresAt: input.fence.deadlineAt.toISOString(),
      },
      signal: input.signal,
      budget: { total: 0, limit: 3 },
      now: () => new Date(),
      requireAdmissionBinding: true,
      propertyReadLock: mailReadLock,
      existingDocumentService: service,
      requireCurrentAppAccess: true,
      currentAppAccessProof,
    };
    const receipt = await mailReadLock.withLock(
      async (propertyReadLockConnection) =>
        executeReadToolRun({
          runKind: input.run.runKind,
          executorLane: input.run.executorLane,
          draftingEnabled: false,
          request,
          context: { ...readContext, propertyReadLockConnection },
          resultRef: input.run.readResultRef ?? `${input.run.id}:read-result`,
        }),
      { signal: input.signal, deadlineAt: input.fence.deadlineAt.getTime() },
    );
    return {
      result: receipt.result,
      readResultRef: receipt.readResultRef,
      ...(receipt.linkedContextReferences.length > 0
        ? { linkedContextReferences: receipt.linkedContextReferences }
        : {}),
    };
  }

  if (request.toolId === 'hms_quote_stay') {
    const authorityResult = await (
      input.quoteReferenceAuthorityLoader ?? unavailableQuoteReferenceAuthority
    )({
      now: new Date(),
      transportId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
    });
    if (authorityResult.status !== 'ready') {
      throw Object.assign(new Error(`quote reference authority is ${authorityResult.reason}`), {
        failureClass: 'AUTH' as const,
      });
    }
    const authorityIssues = quoteRequestAuthorityIssues(
      request.quoteRequest,
      authorityResult.authority,
      new Date(),
    );
    if (authorityIssues.length > 0) {
      throw Object.assign(
        new Error(`quote reference authority changed or is stale: ${authorityIssues.join(', ')}`),
        { failureClass: 'AUTH' as const },
      );
    }
    const quoteCandidate = quoteStayCandidateFromRequest(request.quoteRequest);
    const sessionFactory =
      input.sessionFactory ??
      createLiveHmsCandidateSessionFactory(input.runtime ? { runtime: input.runtime } : {});
    const session = await sessionFactory({
      transportId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      propertyCode: request.quoteRequest.propertyCode,
      lookupCandidates: [],
      signal: input.signal,
      runId: input.run.id,
      readResultRef: input.run.readResultRef ?? undefined,
      readFence: input.fence,
      readPlanKind: 'reservation',
      readOnly: true,
      readAdmission: admission,
      readToolId: 'hms_quote_stay',
      quoteCandidates: quoteCandidate
        ? new Map([[request.quoteRequestRef, quoteCandidate]])
        : new Map(),
    });
    const propertyReadLock = session.propertyReadLock;
    if (!propertyReadLock) {
      throw Object.assign(new Error('property read lock is required for quote dispatch'), {
        failureClass: 'POLICY_BLOCK' as const,
      });
    }
    const mapQuoteSessionResult = (legacy: ToolResult<unknown>): ReadResult<unknown> => {
      const parsedData =
        legacy.data == null
          ? null
          : (() => {
              const parsed = quoteStayReadDataSchema.safeParse(legacy.data);
              if (parsed.success) return parsed.data;
              if (legacy.status === 'ok' || legacy.status === 'partial') {
                throw Object.assign(new Error('quote read returned malformed typed data'), {
                  failureClass: 'SCHEMA_DRIFT' as const,
                });
              }
              return null;
            })();
      const unresolved = new Set([
        ...legacy.unresolvedFields,
        ...(parsedData?.unresolvedInputs ?? []),
      ]);
      const status = legacy.status === 'ok' && unresolved.size > 0 ? 'partial' : legacy.status;
      const reasonCode =
        status === 'unverified_negative'
          ? 'UNVERIFIED_NEGATIVE'
          : unresolved.size > 0 || status !== 'ok'
            ? 'INCOMPLETE_QUOTE'
            : null;
      const unavailableSections: Array<{
        section: string;
        reasonCode: 'PARTIAL_WINDOW' | 'INCOMPLETE_QUOTE' | 'UNVERIFIED_NEGATIVE';
      }> =
        parsedData && parsedData.missingNights && parsedData.missingNights.length > 0
          ? [{ section: 'nightly_coverage', reasonCode: 'PARTIAL_WINDOW' as const }]
          : [];
      if (reasonCode && unavailableSections.length === 0) {
        unavailableSections.push({ section: 'quote_pricing', reasonCode });
      }
      return readResultSchema.parse({
        toolId: 'hms_quote_stay',
        schemaVersion: 'hms-quote/1',
        status,
        data: parsedData,
        completeness:
          parsedData && unresolved.size === 0 && parsedData.stayTotal !== null
            ? 'complete'
            : parsedData
              ? 'partial'
              : 'unknown',
        unavailableSections,
        scopeRef: request.quoteRequestRef,
        evidence:
          legacy.evidence.kind === 'hms'
            ? [
                {
                  evidenceRef: legacy.evidence.id,
                  sourceSystem: 'hms' as const,
                  sourceSurface: 'room_type_rate_availability',
                  requestBranchId: admission.requestBranchId,
                  observedAt: legacy.evidence.observedAt,
                  sourceUpdatedAt: null,
                  expiresAt: legacy.evidence.expiresAt,
                  scopeVerified: legacy.evidence.scopeVerified ?? legacy.status === 'ok',
                  artifactRef: legacy.evidence.artifactRef ?? null,
                  ...(legacy.evidence.artifactRefs
                    ? { artifactRefs: legacy.evidence.artifactRefs }
                    : {}),
                  sourceHash: legacy.evidence.sourceHash,
                  manifestSha256: admission.manifestSha256,
                  manifestSha256ByBranch: {
                    [admission.requestBranchId]: admission.manifestSha256!,
                  },
                },
              ]
            : [],
        page: null,
        issues: reasonCode
          ? [
              {
                code: reasonCode,
                retryable: false,
                safeNextAction:
                  reasonCode === 'INCOMPLETE_QUOTE'
                    ? ('request_input' as const)
                    : ('manual_review' as const),
              },
            ]
          : [],
      }) as ReadResult<unknown>;
    };
    const fallbackResult = (): ReadResult<unknown> =>
      mapQuoteSessionResult({
        status: 'manual_required',
        draftReady: false,
        data: buildQuoteStayReadData({
          nightlyObservations: [],
          requestedRooms: request.quoteRequest.rooms.reduce((sum, room) => sum + room.quantity, 0),
          requestRef: request.quoteRequest.quoteRequestRef,
          arrival: request.quoteRequest.arrival,
          departure: request.quoteRequest.departure,
          rooms: request.quoteRequest.rooms,
          currency: request.quoteRequest.currency,
          roomMoveRequired: request.quoteRequest.roomMoveRequired,
          unresolvedInputs: ['room_or_rate_reference_required'],
        }),
        unresolvedFields: ['room_or_rate_reference_required'],
        evidence: {
          kind: 'hms',
          id: randomUUID(),
          toolId: 'hms_quote_stay',
          toolVersion: '2.0.0',
          propertyCode: request.quoteRequest.propertyCode,
          observedAt: new Date().toISOString(),
          expiresAt: input.fence.deadlineAt.toISOString(),
          claimKeys: [],
          sourceHash: createHash('sha256')
            .update(
              JSON.stringify({
                quoteRequest: request.quoteRequest,
                unresolved: ['room_or_rate_reference_required'],
              }),
            )
            .digest('hex'),
        },
      });
    const readContext: ReadExecutionContext = {
      transportId: input.run.transportId,
      mailboxId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      propertyCode: request.quoteRequest.propertyCode,
      sourceRevision,
      parentRef: input.run.id,
      branchId: admission.requestBranchId,
      releaseId: admission.releaseId,
      requester: {
        authorizationId: admission.requesterAuthorizationId,
        transportId: input.run.transportId,
        threadId: input.run.threadId,
        triggerMessageId: input.run.triggerMessageId,
        allowedClaimKinds: ['quote_stay_summary'],
        expiresAt: input.fence.deadlineAt.toISOString(),
      },
      signal: input.signal,
      budget: { total: 0, limit: 3 },
      now: () => new Date(),
      requireAdmissionBinding: true,
      readResultRef: input.run.readResultRef ?? '',
      requireCurrentAppAccess: true,
      currentAppAccessProof,
      propertyReadLock,
      handlers: {
        quoteStay: async () => {
          if (!quoteCandidate) return fallbackResult();
          const legacy = await session.quoteStay(request.quoteRequestRef, input.signal);
          if (legacy.evidence.kind !== 'hms') {
            throw Object.assign(new Error('quote read returned a non-HMS evidence kind'), {
              failureClass: 'SCHEMA_DRIFT' as const,
            });
          }
          return mapQuoteSessionResult(legacy);
        },
      },
    };
    try {
      const receipt = await propertyReadLock.withLock(
        async (propertyReadLockConnection) =>
          executeReadToolRun({
            runKind: input.run.runKind,
            executorLane: input.run.executorLane,
            draftingEnabled: false,
            request,
            context: { ...readContext, propertyReadLockConnection },
            resultRef: input.run.readResultRef ?? `${input.run.id}:read-result`,
          }),
        { signal: input.signal, deadlineAt: input.fence.deadlineAt.getTime() },
      );
      return { result: receipt.result, readResultRef: receipt.readResultRef };
    } finally {
      await session.close?.();
    }
  }

  if (
    request.toolId === 'hms_company_account_read' ||
    request.toolId === 'hms_group_block_read' ||
    request.toolId === 'hms_event_read' ||
    request.toolId === 'hms_read_notes_traces'
  ) {
    const sessionFactory =
      input.sessionFactory ??
      createLiveHmsCandidateSessionFactory(input.runtime ? { runtime: input.runtime } : {});
    const session = await sessionFactory({
      transportId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      lookupCandidates: [],
      signal: input.signal,
      runId: input.run.id,
      readResultRef: input.run.readResultRef ?? undefined,
      readFence: input.fence,
      readPlanKind: 'reservation',
      readOnly: true,
      readAdmission: admission,
      readToolId: request.toolId,
      linkedContextSourceRef: currentAppAccessProof.contextReference?.sourceRef,
    });
    const propertyReadLock = session.propertyReadLock;
    if (!propertyReadLock) {
      throw Object.assign(new Error('property read lock is required for linked context dispatch'), {
        failureClass: 'POLICY_BLOCK' as const,
      });
    }
    const fallback = () =>
      unavailableU15Result({
        toolId: request.toolId,
        scopeRef:
          request.toolId === 'hms_company_account_read'
            ? request.reservationRef
            : request.toolId === 'hms_group_block_read'
              ? request.groupRef
              : request.toolId === 'hms_event_read'
                ? request.eventRef
                : request.resourceRef,
        requestBranchId: admission.requestBranchId,
        observedAt: new Date(),
        expiresAt: input.fence.deadlineAt,
      });
    const readContext: ReadExecutionContext = {
      transportId: input.run.transportId,
      mailboxId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      propertyCode: expectedPropertyCode,
      sourceRevision,
      parentRef: input.run.id,
      branchId: admission.requestBranchId,
      releaseId: admission.releaseId,
      requester: {
        authorizationId: admission.requesterAuthorizationId,
        transportId: input.run.transportId,
        threadId: input.run.threadId,
        triggerMessageId: input.run.triggerMessageId,
        allowedClaimKinds:
          request.toolId === 'hms_company_account_read'
            ? ['company_billing_summary']
            : request.toolId === 'hms_group_block_read'
              ? ['group_status']
              : request.toolId === 'hms_event_read'
                ? ['event_status']
                : ['notes_trace_observation'],
        expiresAt: input.fence.deadlineAt.toISOString(),
      },
      signal: input.signal,
      budget: { total: 0, limit: 3 },
      now: () => new Date(),
      requireAdmissionBinding: true,
      readResultRef: input.run.readResultRef ?? '',
      requireCurrentAppAccess: true,
      currentAppAccessProof,
      propertyReadLock,
      handlers: {
        ...(request.toolId === 'hms_company_account_read'
          ? {
              readCompanyAccount: async ({ reservationRef }: { reservationRef: string }) =>
                session.readCompanyAccount
                  ? session.readCompanyAccount(
                      currentAppAccessProof.contextReference?.sourceRef ?? reservationRef,
                      input.signal,
                    )
                  : fallback(),
            }
          : {}),
        ...(request.toolId === 'hms_group_block_read'
          ? {
              readGroupBlock: async ({
                groupRef,
                sections,
              }: {
                groupRef: string;
                sections: readonly string[];
              }) =>
                session.readGroupBlock
                  ? session.readGroupBlock(
                      currentAppAccessProof.contextReference?.sourceRef ?? groupRef,
                      sections,
                      input.signal,
                    )
                  : fallback(),
            }
          : {}),
        ...(request.toolId === 'hms_event_read'
          ? {
              readEvent: async ({ eventRef }: { eventRef: string }) =>
                session.readEvent
                  ? session.readEvent(
                      currentAppAccessProof.contextReference?.sourceRef ?? eventRef,
                      input.signal,
                    )
                  : fallback(),
            }
          : {}),
        ...(request.toolId === 'hms_read_notes_traces'
          ? {
              readNotesTraces: async ({
                resourceRef,
                states,
                limit,
                cursor,
                audience,
              }: {
                resourceRef: string;
                states: readonly string[];
                limit: number;
                cursor: string | undefined;
                audience: 'staff' | 'customer';
              }) =>
                session.readNotesTraces
                  ? session.readNotesTraces({
                      resourceRef: currentAppAccessProof.contextReference?.sourceRef ?? resourceRef,
                      states,
                      limit,
                      cursor,
                      audience,
                      signal: input.signal,
                    })
                  : fallback(),
            }
          : {}),
      },
    };
    try {
      const receipt = await propertyReadLock.withLock(
        async (propertyReadLockConnection) =>
          executeReadToolRun({
            runKind: input.run.runKind,
            executorLane: input.run.executorLane,
            draftingEnabled: false,
            request,
            context: { ...readContext, propertyReadLockConnection },
            resultRef: input.run.readResultRef ?? `${input.run.id}:read-result`,
          }),
        { signal: input.signal, deadlineAt: input.fence.deadlineAt.getTime() },
      );
      return { result: receipt.result, readResultRef: receipt.readResultRef };
    } finally {
      await session.close?.();
    }
  }

  const candidateId = request.candidateId;
  if (!candidateId) {
    throw Object.assign(
      new Error('resolved reservation reads require a server-bound candidateId'),
      {
        failureClass: 'AUTH' as const,
      },
    );
  }
  if (request.toolId === 'hms_read_reservation' || request.toolId === 'hms_read_folio') {
    const reservationRef = admission.reservationRef;
    const reservationRefIssuedAt = admission.reservationRefIssuedAt;
    const reservationRefExpiresAt = admission.reservationRefExpiresAt;
    const metrics =
      input.run.metrics && typeof input.run.metrics === 'object'
        ? (input.run.metrics as Record<string, unknown>)
        : null;
    const persistedBinding = readReservationBindingSchema.safeParse(metrics?.readAdmissionBinding);
    if (
      !persistedBinding.success ||
      !reservationRef ||
      !reservationRefIssuedAt ||
      !reservationRefExpiresAt
    ) {
      throw Object.assign(new Error('resolved reservation reference issuance is not trusted'), {
        failureClass: 'AUTH' as const,
      });
    }
    const binding = persistedBinding.data;
    const expectedReservationRef = readReservationRef({
      transportId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      candidateId,
      reservationRefExpiresAt,
    });
    const bindingMatches =
      binding.transportId === input.run.transportId &&
      binding.threadId === input.run.threadId &&
      binding.triggerMessageId === input.run.triggerMessageId &&
      binding.candidateId === candidateId &&
      binding.reservationRef === reservationRef &&
      binding.reservationRefIssuedAt === reservationRefIssuedAt &&
      binding.reservationRefExpiresAt === reservationRefExpiresAt &&
      reservationRef === request.reservationRef &&
      reservationRef === expectedReservationRef;
    if (!bindingMatches) {
      throw Object.assign(
        new Error('resolved reservation reference issuance binding is stale or forged'),
        {
          failureClass: 'AUTH' as const,
        },
      );
    }
    const nowMs = Date.now();
    const issuedAtMs = Date.parse(reservationRefIssuedAt);
    const expiresAtMs = Date.parse(reservationRefExpiresAt);
    if (
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      issuedAtMs > nowMs ||
      expiresAtMs <= nowMs
    ) {
      throw Object.assign(
        new Error('resolved reservation reference is expired or not yet issued'),
        {
          failureClass: 'AUTH' as const,
        },
      );
    }
  }

  const threadRows = await getDb()
    .select({
      id: message.id,
      transportId: message.transportId,
      threadId: message.threadId,
      direction: message.direction,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      subject: message.subject,
      receivedAt: message.receivedAt,
      sentAt: message.sentAt,
    })
    .from(message)
    .where(
      and(eq(message.threadId, input.run.threadId), eq(message.transportId, input.run.transportId)),
    );
  const latestDraftRevisionId = await loadLatestThreadAffectingDraftRevisionId(getDb(), {
    transportId: input.run.transportId,
    threadId: input.run.threadId,
  });
  const { buildThreadContext } = await import('./thread-context.js');
  const context = await buildThreadContext({
    transportId: input.run.transportId,
    threadId: input.run.threadId,
    triggerMessageId: input.run.triggerMessageId,
    latestDraftRevisionId,
    messages: threadRows.map((row) => ({
      id: row.id,
      transportId: row.transportId,
      threadId: row.threadId,
      direction: (row.direction === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
      textBody: row.textBody,
      htmlBody: row.htmlBody,
      subject: row.subject,
      receivedAt: row.receivedAt,
      sentAt: row.sentAt,
      attachmentIds: [],
    })),
  });
  const candidate = context.lookupCandidates.find((item) => item.id === candidateId);
  if (
    !candidate ||
    (candidate.kind !== 'confirmation' && candidate.kind !== 'external_reference')
  ) {
    throw Object.assign(new Error('opaque read candidate is not present in the trigger thread'), {
      failureClass: 'AUTH' as const,
    });
  }
  const trustedReservationRef =
    request.toolId === 'hms_read_reservation' || request.toolId === 'hms_read_folio'
      ? admission.reservationRef
      : null;
  const expectedReservationRef =
    request.toolId === 'hms_read_reservation' || request.toolId === 'hms_read_folio'
      ? readReservationRef({
          transportId: input.run.transportId,
          threadId: input.run.threadId,
          triggerMessageId: input.run.triggerMessageId,
          candidateId,
          reservationRefExpiresAt: admission.reservationRefExpiresAt!,
        })
      : null;
  if (
    (request.toolId === 'hms_read_reservation' || request.toolId === 'hms_read_folio') &&
    (!trustedReservationRef ||
      trustedReservationRef !== request.reservationRef ||
      trustedReservationRef !== expectedReservationRef)
  ) {
    throw Object.assign(
      new Error('resolved reservation reference is not server-bound to the exact candidate'),
      {
        failureClass: 'AUTH' as const,
      },
    );
  }

  const sessionFactory =
    input.sessionFactory ??
    createLiveHmsCandidateSessionFactory(input.runtime ? { runtime: input.runtime } : {});
  const session = await sessionFactory({
    transportId: input.run.transportId,
    threadId: input.run.threadId,
    triggerMessageId: input.run.triggerMessageId,
    lookupCandidates: [candidate],
    signal: input.signal,
    runId: input.run.id,
    readResultRef: input.run.readResultRef ?? undefined,
    readFence: input.fence,
    readPlanKind: 'reservation',
    readOnly: true,
    readAdmission: admission,
    readToolId: request.toolId,
    ...(request.toolId === 'hms_read_folio' ? { folioSections: request.sections } : {}),
  });
  const propertyReadLock = session.propertyReadLock;
  if (!propertyReadLock) {
    throw Object.assign(new Error('property read lock is required for production read dispatch'), {
      failureClass: 'POLICY_BLOCK' as const,
    });
  }
  const toLookup = (
    candidateValue: string,
  ): import('../hms/reservation-context-facade.js').ReservationContextLookup => ({
    transportId: input.run.transportId,
    mailboxId: input.run.transportId,
    threadId: input.run.threadId,
    triggerMessageId: input.run.triggerMessageId,
    parentRef: input.run.id,
    branchId: admission.requestBranchId,
    propertyCode: expectedPropertyCode,
    candidateId: candidateValue,
    referenceKind: candidate?.kind === 'external_reference' ? 'external' : 'confirmation',
    value: candidate && 'value' in candidate ? candidate.value : candidateValue,
    observedAt: new Date(),
    expiresAt: input.fence.deadlineAt,
  });
  const mapSessionResult = async (
    lookup: import('../hms/reservation-context-facade.js').ReservationContextLookup,
  ) => {
    const legacy = await session.findReservation(lookup.candidateId, input.signal);
    if (legacy.evidence.kind !== 'hms') {
      throw Object.assign(new Error('reservation read returned a non-HMS evidence kind'), {
        failureClass: 'SCHEMA_DRIFT' as const,
      });
    }
    return mapProductionReservationRead({
      status: legacy.status,
      data: legacy.data ? { matches: legacy.data.matches as readonly ReservationRow[] } : null,
      evidence: {
        kind: 'hms',
        id: legacy.evidence.id,
        observedAt: legacy.evidence.observedAt,
        expiresAt: legacy.evidence.expiresAt,
      },
    });
  };
  const mapFolioSessionResult = async (): Promise<ReadResult<unknown>> => {
    if (request.toolId !== 'hms_read_folio') {
      throw Object.assign(new Error('folio result mapper called for a non-folio request'), {
        failureClass: 'SCHEMA_DRIFT' as const,
      });
    }
    const folioRequest = request;
    if (!session.readFolio) {
      throw Object.assign(new Error('active folio session handler is unavailable'), {
        failureClass: 'POLICY_BLOCK' as const,
      });
    }
    const legacy = await session.readFolio(candidateId, input.signal);
    if (legacy.evidence.kind !== 'hms') {
      throw Object.assign(new Error('folio read returned a non-HMS evidence kind'), {
        failureClass: 'SCHEMA_DRIFT' as const,
      });
    }
    const parsedData =
      legacy.data == null
        ? null
        : (() => {
            const parsed = folioReadDataSchema.safeParse(legacy.data);
            if (parsed.success) return parsed.data;
            if (legacy.status === 'ok' || legacy.status === 'partial') {
              throw Object.assign(new Error('folio read returned malformed typed data'), {
                failureClass: 'SCHEMA_DRIFT' as const,
              });
            }
            return null;
          })();
    const sectionValues = new Map<string, unknown>();
    for (const section of folioRequest.sections) {
      const sectionValue =
        parsedData && section === 'balance'
          ? parsedData.balance
          : parsedData && section === 'deposits'
            ? parsedData.deposits
            : parsedData && section === 'transactions'
              ? parsedData.transactions
              : parsedData && section === 'authorization'
                ? parsedData.authorization
                : null;
      sectionValues.set(section, sectionValue);
    }
    const unavailableSections = folioRequest.sections.flatMap((section) => {
      const sectionValue = sectionValues.get(section) as
        | { state?: string; reasonCode?: string }
        | null
        | undefined;
      const available =
        section === 'authorization'
          ? sectionValue?.state === 'known'
          : sectionValue?.state === 'available' || sectionValue?.state === 'partial';
      if (available) {
        return [];
      }
      const reasonCode = sectionValue?.reasonCode;
      return [
        {
          section,
          reasonCode: reasonCode ?? 'SOURCE_UNAVAILABLE',
        },
      ];
    });
    const hasPartialRequestedSection = folioRequest.sections.some((section) => {
      const value = sectionValues.get(section) as
        | { state?: string; completeness?: string }
        | null
        | undefined;
      return value?.state === 'partial' || value?.completeness === 'partial';
    });
    const requestedCompleteness =
      unavailableSections.length === 0 && !hasPartialRequestedSection
        ? ('complete' as const)
        : legacy.status === 'unverified_negative' &&
            folioRequest.sections.every((section) =>
              unavailableSections.some((item) => item.section === section),
            )
          ? ('unknown' as const)
          : ('partial' as const);
    const issueCode =
      legacy.status === 'partial'
        ? 'PARTIAL_WINDOW'
        : legacy.status === 'manual_required'
          ? 'SOURCE_UNAVAILABLE'
          : legacy.status === 'unverified_negative'
            ? 'UNVERIFIED_NEGATIVE'
            : null;
    const result = {
      toolId: 'hms_read_folio' as const,
      schemaVersion: 'hms-folio/1',
      status:
        legacy.status === 'ok' || legacy.status === 'partial'
          ? legacy.status
          : legacy.status === 'unverified_negative'
            ? 'unverified_negative'
            : 'manual_required',
      data: parsedData,
      completeness: requestedCompleteness,
      unavailableSections,
      scopeRef: folioRequest.reservationRef,
      evidence: [
        {
          evidenceRef: legacy.evidence.id,
          sourceSystem: 'hms' as const,
          sourceSurface: 'folio',
          requestBranchId: admission.requestBranchId,
          observedAt: legacy.evidence.observedAt,
          sourceUpdatedAt: null,
          expiresAt: legacy.evidence.expiresAt,
          scopeVerified: legacy.evidence.scopeVerified === true,
          artifactRef: legacy.evidence.artifactRef ?? null,
          ...(legacy.evidence.artifactRefs ? { artifactRefs: legacy.evidence.artifactRefs } : {}),
          sourceHash: legacy.evidence.sourceHash,
          manifestSha256: admission.manifestSha256,
          ...(legacy.evidence.manifestSha256ByBranch
            ? { manifestSha256ByBranch: legacy.evidence.manifestSha256ByBranch }
            : {
                manifestSha256ByBranch: {
                  [admission.requestBranchId]: admission.manifestSha256!,
                },
              }),
          ...(legacy.evidence.scopeHash ? { scopeHash: legacy.evidence.scopeHash } : {}),
        },
      ],
      page: null,
      issues: issueCode
        ? [
            {
              code: issueCode,
              retryable: false,
              safeNextAction: 'manual_review' as const,
            },
          ]
        : [],
    };
    return readResultSchema.parse(result) as ReadResult<unknown>;
  };
  const { createReservationContextFacade } = await import('../hms/reservation-context-facade.js');
  const { projectReservationDetailDump } = await import('../hms/reservation-detail-projection.js');
  const reservationFacade =
    request.toolId === 'hms_read_reservation'
      ? createReservationContextFacade({
          now: () => new Date(),
          reservationRefFor: () => trustedReservationRef!,
          lookup: mapSessionResult,
          readContext: async (lookup, row) => {
            const dump =
              session.readReservationDetailDump != null
                ? await session.readReservationDetailDump(lookup.candidateId, input.signal)
                : null;
            if (!dump) {
              return {
                core: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
                stay: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
                rates: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
                policies: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
                operations: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
              };
            }
            const projected = projectReservationDetailDump(dump);
            return {
              core: {
                status: projected.core.status,
                confirmation: projected.core.confirmation ?? row.confirmationNumber,
                externalReference: projected.core.externalReference ?? row.externalReference,
                reservationStatus: projected.core.reservationStatus ?? row.reservationStatus,
              },
              stay: {
                status: projected.stay.status,
                arrival: projected.stay.arrival ?? row.arrivalDate,
                departure: projected.stay.departure ?? row.departureDate,
                roomType: projected.stay.roomType ?? row.roomType,
                roomQuantity: projected.stay.roomQuantity,
                adults: projected.stay.adults,
              },
              rates: projected.rates,
              policies: projected.policies,
              operations: projected.operations,
            };
          },
        })
      : undefined;
  const readContext: ReadExecutionContext = {
    transportId: input.run.transportId,
    mailboxId: input.run.transportId,
    threadId: input.run.threadId,
    triggerMessageId: input.run.triggerMessageId,
    propertyCode: expectedPropertyCode,
    sourceRevision,
    parentRef: input.run.id,
    branchId: admission.requestBranchId,
    releaseId: admission.releaseId,
    requester: {
      authorizationId: admission.requesterAuthorizationId,
      transportId: input.run.transportId,
      threadId: input.run.threadId,
      triggerMessageId: input.run.triggerMessageId,
      allowedClaimKinds:
        request.toolId === 'hms_read_folio' ? ['folio_deposit_summary'] : ['reservation_summary'],
      expiresAt: input.fence.deadlineAt.toISOString(),
    },
    signal: input.signal,
    budget: { total: 0, limit: 3 },
    now: () => new Date(),
    requireAdmissionBinding: true,
    readResultRef: input.run.readResultRef ?? '',
    requireCurrentAppAccess: true,
    currentAppAccessProof,
    propertyReadLock,
    reservationFacade,
    handlers: {
      findReservation: async () => {
        const mapped = await mapSessionResult(toLookup(candidateId));
        return mapped;
      },
      ...(request.toolId === 'hms_read_folio'
        ? { readFolio: async () => mapFolioSessionResult() }
        : {}),
    },
  };
  try {
    const receipt = await propertyReadLock.withLock(
      async (propertyReadLockConnection) => {
        const lockedReadContext = { ...readContext, propertyReadLockConnection };
        if (reservationFacade) {
          const resolved = await reservationFacade.findReservation(toLookup(candidateId));
          if (resolved.status !== 'ok' || !resolved.data?.matches[0]?.reservationRef) {
            throw Object.assign(
              new Error('reservation context could not resolve an entitled exact match'),
              {
                failureClass: 'AUTH' as const,
              },
            );
          }
          const expiresAt = Date.parse(resolved.evidence[0]?.expiresAt ?? '');
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            throw Object.assign(new Error('reservation context reference is expired'), {
              failureClass: 'AUTH' as const,
            });
          }
        }
        return executeReadToolRun({
          runKind: input.run.runKind,
          executorLane: input.run.executorLane,
          draftingEnabled: false,
          request,
          context: lockedReadContext,
          resultRef: input.run.readResultRef ?? `${input.run.id}:read-result`,
        });
      },
      {
        signal: input.signal,
        deadlineAt: input.fence.deadlineAt.getTime(),
      },
    );
    return {
      result: receipt.result,
      readResultRef: receipt.readResultRef,
      ...(receipt.linkedContextReferences.length > 0
        ? { linkedContextReferences: receipt.linkedContextReferences }
        : {}),
    };
  } finally {
    await session.close?.();
  }
}

type ExecuteShadowPredictionInput = {
  run: typeof aiWorkflowRun.$inferSelect;
  fence: AiRunFence;
  signal: AbortSignal;
  shadowModelAdapter?: ModelAdapter;
  shadowModelRoute?: LocalModelRouteEvidence;
  shadowModelTransport?: LocalModelTransport;
};

/**
 * Normal default-lane shadow worker. It reads the committed inbound thread,
 * freezes the causal horizon, and writes only the private shadow store. The
 * approved purpose route is resolved after freeze; missing route is a durable
 * unavailable result and never falls through to Bedrock/fake initialization.
 */
async function executeShadowPredictionRun(
  input: ExecuteShadowPredictionInput,
): Promise<ExecuteAiRunResult> {
  const { run, fence, signal } = input;
  const db = getDb();
  const predictionKey = run.idempotencyKey;
  const [existing] = await db
    .select({ id: aiShadowPrediction.id, predictionStatus: aiShadowPrediction.predictionStatus })
    .from(aiShadowPrediction)
    .where(eq(aiShadowPrediction.predictionKey, predictionKey))
    .limit(1);
  if (existing) {
    const marked = await markAiRunSucceeded({
      runId: run.id,
      claimOwner: fence.claimOwner,
      claimToken: fence.claimToken,
      expectedStates: ['running'],
      metrics: {
        shadow: {
          evaluationMode: SHADOW_EVALUATION_MODE,
          predictionStatus: existing.predictionStatus,
          idempotentReuse: true,
        },
      },
    });
    return { runId: run.id, state: marked ? 'succeeded' : 'retry_wait' };
  }

  const { readAdmissionSnapshot } = await import('../mail/ingest/live-admission.js');
  const admissionSnapshot = run.admissionSnapshotId
    ? await readAdmissionSnapshot(
        db,
        run.admissionSnapshotId,
        run.admissionSnapshotHash ?? undefined,
      )
    : null;
  const fromSnapshot = (row: import('../mail/ingest/live-admission.js').AdmissionProjection) => ({
    ...row,
    createdAt: new Date(row.createdAt),
    receivedAt: row.receivedAt ? new Date(row.receivedAt) : null,
    sentAt: row.sentAt ? new Date(row.sentAt) : null,
  });
  const [trigger] = admissionSnapshot
    ? admissionSnapshot.threadMessages
        .filter((row) => row.id === run.triggerMessageId)
        .map(fromSnapshot)
    : await db
        .select()
        .from(message)
        .where(
          and(
            eq(message.id, run.triggerMessageId),
            eq(message.transportId, run.transportId),
            eq(message.threadId, run.threadId),
          ),
        )
        .limit(1);
  if (!trigger) throw new Error('shadow prediction trigger message not found');
  if (trigger.direction !== 'inbound') {
    throw new Error('shadow prediction trigger must be inbound');
  }

  const threadRows = admissionSnapshot
    ? admissionSnapshot.threadMessages.map(fromSnapshot)
    : await db
        .select({
          id: message.id,
          direction: message.direction,
          subject: message.subject,
          textBody: message.textBody,
          htmlBody: message.htmlBody,
          receivedAt: message.receivedAt,
          sentAt: message.sentAt,
          createdAt: message.createdAt,
        })
        .from(message)
        .where(and(eq(message.transportId, run.transportId), eq(message.threadId, run.threadId)))
        .orderBy(asc(message.createdAt), asc(message.id));
  const threadMessageIds = threadRows.map((row) => row.id);
  const attachmentRows = admissionSnapshot
    ? admissionSnapshot.artifacts
    : threadMessageIds.length
      ? await db
          .select({ id: attachment.id, messageId: attachment.messageId })
          .from(attachment)
          .where(inArray(attachment.messageId, threadMessageIds))
      : [];
  const attachmentIdsByMessage = new Map<string, string[]>();
  for (const row of attachmentRows) {
    const ids = attachmentIdsByMessage.get(row.messageId) ?? [];
    ids.push(row.id);
    attachmentIdsByMessage.set(row.messageId, ids);
  }
  // `createdAt` is the availability clock. RFC822 received/sent clocks remain
  // event evidence for matching and cannot pull a late-imported body into an
  // earlier frozen context.
  const asOfAt = admissionSnapshot?.admittedAt
    ? new Date(admissionSnapshot.admittedAt)
    : trigger.createdAt;
  const frozen = freezeShadowInput({
    transportId: run.transportId,
    threadId: run.threadId,
    triggerMessageId: trigger.id,
    asOfAt,
    snapshotMessageIds: admissionSnapshot?.threadMessages.map((row) => row.id),
    messages: threadRows.map(
      (row): ShadowMessageInput => ({
        ...row,
        availableAt: row.createdAt,
        attachmentIds: attachmentIdsByMessage.get(row.id) ?? [],
      }),
    ),
  });

  let adapter = input.shadowModelAdapter;
  const route = input.shadowModelRoute;
  if (!adapter || !route) {
    try {
      adapter = createApprovedLocalModelAdapter({
        purpose: 'shadow',
        route,
        transport: input.shadowModelTransport,
      });
    } catch (error) {
      if (!(error instanceof LocalModelRouteUnavailableError)) throw error;
      const seal = createUnavailableShadowPredictionSeal({
        predictionKey,
        transportId: run.transportId,
        threadId: run.threadId,
        triggerMessageId: run.triggerMessageId,
        frozen,
        sealedAt: new Date(),
        reason: 'approved_shadow_route_unavailable',
      });
      const persisted = await persistShadowPrediction(seal, db);
      const marked = await markAiRunSucceeded({
        runId: run.id,
        claimOwner: fence.claimOwner,
        claimToken: fence.claimToken,
        expectedStates: ['running'],
        metrics: {
          shadow: {
            evaluationMode: SHADOW_EVALUATION_MODE,
            predictionStatus: 'unavailable',
            routeStatus: 'unavailable',
            reason: 'approved_shadow_route_unavailable',
            predictionId: persisted.row.id,
          },
        },
      });
      return { runId: run.id, state: marked ? 'succeeded' : 'retry_wait' };
    }
  }

  if (!route || route.purpose !== 'shadow') {
    throw new LocalModelRouteUnavailableError('shadow route provenance is unavailable');
  }
  try {
    if (signal.aborted) throw new Error('shadow prediction aborted');
    const prompt = shadowPredictionPrompt(frozen);
    const result = await adapter.invoke({
      modelId: run.modelId === 'approved-local' ? 'approved-local' : run.modelId,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      responseSchema: {
        type: 'object',
        required: ['outcome'],
        additionalProperties: false,
      },
      signal,
      deadlineAt: fence.deadlineAt.getTime(),
    });
    if (
      result.provenance?.routeId !== route.routeId ||
      result.provenance.modelId !== route.modelId ||
      result.provenance.purpose !== 'shadow'
    ) {
      throw new Error('shadow model provenance mismatch');
    }
    const seal = createShadowPredictionSeal({
      predictionKey,
      transportId: run.transportId,
      threadId: run.threadId,
      triggerMessageId: run.triggerMessageId,
      frozen,
      output: result.output,
      route,
      modelUsage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs: result.usage.latencyMs,
      },
      sealedAt: new Date(),
    });
    const persisted = await persistShadowPrediction(seal, db);
    const marked = await markAiRunSucceeded({
      runId: run.id,
      claimOwner: fence.claimOwner,
      claimToken: fence.claimToken,
      expectedStates: ['running'],
      metrics: {
        shadow: {
          evaluationMode: SHADOW_EVALUATION_MODE,
          predictionStatus: 'sealed',
          routeStatus: 'available',
          routeId: route.routeId,
          modelId: route.modelId,
          predictionId: persisted.row.id,
          idempotentReuse: !persisted.inserted,
        },
      },
    });
    return { runId: run.id, state: marked ? 'succeeded' : 'retry_wait' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'shadow_prediction_failed';
    const seal = createFailedShadowPredictionSeal({
      predictionKey,
      transportId: run.transportId,
      threadId: run.threadId,
      triggerMessageId: run.triggerMessageId,
      frozen,
      sealedAt: new Date(),
      reason: 'shadow_prediction_failed',
    });
    await persistShadowPrediction(seal, db);
    // The run ledger receives only a fixed safe class; raw model/fixture errors
    // never enter metrics or logs. Outer failure handling applies fencing.
    throw Object.assign(new Error('shadow prediction failed'), {
      failureClass: /abort/i.test(reason) ? ('RUN_DEADLINE' as const) : ('UNKNOWN' as const),
    });
  }
}

/** Attempts after which an inbound read a worker shutdown keeps cutting off dead-letters instead of requeueing. */
export const MAX_WORKER_SHUTDOWN_ATTEMPTS = 3;

const CLASSIFIER_DEADLINE_MS = 8_000;

/** After a succeeded inbound extraction: store short-context {workflow, confidence} on usage.classifier. */
export async function storeWorkflowClassifierForInbound(
  db: DB,
  messageId: string,
  classify: typeof classifyWorkflow = classifyWorkflow,
): Promise<void> {
  try {
    const [row] = await db
      .select({
        id: mailExtraction.id,
        usage: mailExtraction.usage,
        attachments: mailExtraction.attachments,
      })
      .from(mailExtraction)
      .where(and(eq(mailExtraction.messageId, messageId), eq(mailExtraction.status, 'succeeded')))
      .orderBy(desc(mailExtraction.createdAt))
      .limit(1);
    if (!row || parseStoredClassifier(row.usage)) return;
    const [msg] = await db
      .select({ subject: message.subject, textBody: message.textBody })
      .from(message)
      .where(eq(message.id, messageId))
      .limit(1);
    if (!msg) return;
    const attachmentNames = Array.isArray(row.attachments)
      ? row.attachments
          .map((item) => (item && typeof item === 'object' && 'filename' in item ? String(item.filename ?? '') : ''))
          .filter(Boolean)
      : [];
    // Own deadline only: the run is already succeeded here, so its lease signal can abort under us.
    const result = await classify(
      {
        subject: msg.subject ?? '',
        attachmentNames,
        bodyHead: (msg.textBody ?? '').slice(0, BODY_HEAD_CHARS),
      },
      { signal: AbortSignal.timeout(CLASSIFIER_DEADLINE_MS) },
    );
    if (!result) {
      console.error('ingest_classifier_empty', messageId);
      return;
    }
    const patch = JSON.stringify({ classifier: result });
    await db
      .update(mailExtraction)
      .set({ usage: sql`coalesce(${mailExtraction.usage}, '{}'::jsonb) || ${patch}::jsonb` })
      .where(eq(mailExtraction.id, row.id));
  } catch (error) {
    // Extraction already succeeded; pane keeps WORKFLOW_BY_KIND.
    console.error('ingest_classifier_failed', messageId, error instanceof Error ? error.message : String(error));
  }
}

export async function executeAiRun(
  runId: string,
  options: {
    shutdownSignal?: AbortSignal;
    /** Injectable claim-safe tool session (tests / Task 7 mocks). */
    candidateSessionFactory?: CandidateSessionFactory;
    candidatePlanModel?: (prompt: {
      systemPrompt: string;
      userPrompt: string;
      signal?: AbortSignal;
      deadlineAt?: number;
    }) => Promise<unknown>;
    /** Approved local adapter seams for normal plan/reply composition. */
    candidateModelAdapter?: ModelAdapter;
    candidateReplyModelAdapter?: ModelAdapter;
    /** Explicit configured draft-purpose route; absent remains unavailable. */
    candidateDraftRoute?: DraftModelRouteConfig;
    /** Resolve inside the per-run try so a missing Azure config fails this claim. */
    candidateDraftRouteFactory?: DraftModelRouteFactory;
    candidateReplyAsks?: readonly PreparedAsk[];
    /** Explicit purpose-bound mail extraction route; absent means unavailable. */
    mailBaselineExtractionRoute?: {
      route: LocalModelRouteEvidence;
      transport: LocalModelTransport;
    };
    /** Explicit purpose-bound private shadow route; absent remains unavailable. */
    shadowModelAdapter?: ModelAdapter;
    shadowModelRoute?: LocalModelRouteEvidence;
    shadowModelTransport?: LocalModelTransport;
    /** Inbound extraction model seam. Absent uses the Azure quote route; null means no model is configured. */
    inboundExtractionAdapter?: ModelAdapter | null;
    /** Ingest workflow classifier. Tests inject; live uses Luna. */
    ingestClassify?: typeof classifyWorkflow;
    /** Injected only by the trusted HMS read runtime/tests; never a model callback. */
    readToolExecutor?: (input: {
      run: typeof aiWorkflowRun.$inferSelect;
      fence: AiRunFence;
      signal: AbortSignal;
    }) => Promise<{
      result: ReadResult<unknown>;
      readResultRef: string;
      linkedContextReferences?: import('../hms/context-read-reference.js').LinkedContextReference[];
    }>;
    /** Lower browser/PMS edge substitution for normal release-bound proof. */
    hmsRuntime?: import('../hms/runtime.js').HmsRuntime;
    /** Internal server-owned current quote authority; absent source fails closed. */
    quoteReferenceAuthorityLoader?: QuoteReferenceAuthorityLoader;
  } = {},
): Promise<ExecuteAiRunResult> {
  const db = getDb();
  const env = parseEnv(process.env as Record<string, string | undefined>);
  const [run] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId)).limit(1);
  if (!run) throw new Error(`AI run not found: ${runId}`);

  const owner = claimOwnerFor(run);
  const now = new Date();
  if (!run.claimToken) {
    return { runId: run.id, state: 'dead_letter' };
  }
  const claimToken = run.claimToken;
  const deadlineAt = run.deadlineAt ?? new Date(now.getTime() + env.HMS_RUN_DEADLINE_MS);
  const fence: AiRunFence = {
    runId: run.id,
    claimOwner: owner,
    claimToken,
    deadlineAt,
  };
  const leaseAbort = new AbortController();
  const shutdownSignal = options.shutdownSignal ?? new AbortController().signal;
  let signal: AbortSignal;
  try {
    signal = buildRunAbortSignal({ fence, leaseAbort, shutdownSignal, now });
  } catch (error) {
    // Too little deadline is left to run. Dead-letter the claim here: an error that escapes this function ends the worker process.
    if (!(error instanceof RunDeadlineError)) throw error;
    await markAiRunDeadLetter({
      runId: run.id,
      claimOwner: owner,
      claimToken,
      expectedStates: ['claimed'],
      lastError: 'RUN_DEADLINE',
      failureClass: 'RUN_DEADLINE',
    });
    return { runId: run.id, state: 'dead_letter' };
  }

  const flipped = await markAiRunRunning(fence);
  if (!flipped) {
    return { runId: run.id, state: 'dead_letter' };
  }

  if (
    run.runKind === 'inbound_triage' &&
    run.promptVersion !== TRIAGE_PROMPT_VERSION &&
    !isSupportedInboundTriagePromptVersion(run.promptVersion)
  ) {
    const deployed = resolveDeployedTriagePromptVersion();
    await markAiRunDeadLetter({
      runId: run.id,
      claimOwner: owner,
      claimToken,
      expectedStates: ['running'],
      lastError: `unsupported prompt version: ${run.promptVersion} (deployed ${deployed})`,
    });
    return { runId: run.id, state: 'dead_letter' };
  }

  if (run.runKind === 'shadow_prediction' && !resolveShadowAdmissionPolicy()) {
    await markAiRunDeadLetter({
      runId,
      claimOwner: owner,
      claimToken,
      expectedStates: ['running'],
      lastError: 'shadow admission cap policy unavailable',
      failureClass: 'POLICY_BLOCK',
    });
    return { runId, state: 'dead_letter' };
  }

  // Resolve the purpose-bound extraction edge before any inbound workflow
  // client is initialized.  Missing config stays unavailable; the worker
  // persists only the explicit source-observation boundary below.
  const baselineRoute = resolveMailBaselineExtractionRoute({
    approvedRoute: options.mailBaselineExtractionRoute
      ? 'approved-local'
      : process.env.AI_MODEL_ROUTE,
    route: options.mailBaselineExtractionRoute?.route,
    transport: options.mailBaselineExtractionRoute?.transport,
  });

  const runWithFence = { ...run, claimOwner: owner, claimToken, deadlineAt };

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  try {
    heartbeatTimer = setInterval(() => {
      void renewAiRunLease(fence, leaseAbort);
    }, AI_LEASE_HEARTBEAT_INTERVAL_MS);

    if (signal.aborted) throw new RunDeadlineError();

    if (isQuotePdfRun(run)) {
      const persisted = quotePdfResultOf(run);
      const { generateQuotePdfFromLedger } = await import('../trpc/routes/workstation.js');
      const state = await executeQuotePdfJob({
        run,
        fence,
        generate: persisted ? async () => persisted : generateQuotePdfFromLedger,
      });
      return { runId, state };
    }

    // Pane HMS jobs run through the CLI under the property lock, so they do not need the read service.
    if (run.runKind === 'read_tool' && run.promptVersion === HMS_JOB_PROMPT_VERSION) {
      const state = await executeHmsJob({ run, fence, signal });
      const request = run.readRequest as { kind?: unknown; matchVersion?: unknown } | null;
      if (
        request?.kind === 'party' &&
        request.matchVersion === 2 &&
        (state === 'succeeded' || state === 'dead_letter')
      ) {
        scheduleQuotePreparationAfterPartyMatch(run);
      }
      return { runId, state };
    }

    if (run.runKind === 'read_tool') {
      if (run.executorLane !== 'hms') {
        throw Object.assign(new Error('read_tool must execute on the HMS lane'), {
          failureClass: 'POLICY_BLOCK' as const,
        });
      }
      if (!env.HMS_READ_SERVICE_ENABLED) {
        throw Object.assign(new Error('HMS_READ_SERVICE_DISABLED'), {
          failureClass: 'POLICY_BLOCK' as const,
        });
      }
      if (!run.readRequest || typeof run.readRequest !== 'object') {
        throw Object.assign(new Error('read_tool request missing'), {
          failureClass: 'SCHEMA_DRIFT' as const,
        });
      }
      const executor =
        options.readToolExecutor ??
        ((args: {
          run: typeof aiWorkflowRun.$inferSelect;
          fence: AiRunFence;
          signal: AbortSignal;
        }) =>
          executeProductionReadTool({
            ...args,
            sessionFactory: options.candidateSessionFactory,
            runtime: options.hmsRuntime,
            quoteReferenceAuthorityLoader: options.quoteReferenceAuthorityLoader,
          }));
      const read = await executor({ run, fence, signal });
      const readResultRef = run.readResultRef ?? read.readResultRef;
      if (!readResultRef) throw new Error('read_tool result reference missing');
      const readResult: ReadResult<unknown> =
        read.result.toolId === 'hms_find_reservation' &&
        read.linkedContextReferences &&
        read.linkedContextReferences.length > 0
          ? (readResultSchema.parse({
              ...read.result,
              linkedContextRefs: read.linkedContextReferences.map((binding) => ({
                kind: binding.kind,
                reference: binding.reference,
                expiresAt: binding.expiresAt,
              })),
            }) as ReadResult<unknown>)
          : read.result;
      const marked = await markAiRunSucceeded({
        runId,
        claimOwner: owner,
        claimToken,
        expectedStates: ['running'],
        readResultRef,
        readResult,
        readResultExpiresAt: readResultExpiry(readResult, fence.deadlineAt),
        metrics: {
          readTool: true,
          status: read.result.status,
          schemaVersion: read.result.schemaVersion,
          modelId: 'not_applicable',
          promptVersion: run.promptVersion,
          ...(read.linkedContextReferences && read.linkedContextReferences.length > 0
            ? { linkedContextReferences: read.linkedContextReferences }
            : {}),
        },
      });
      return { runId, state: marked ? 'succeeded' : 'retry_wait' };
    }

    if (run.runKind === 'shadow_prediction') {
      return await executeShadowPredictionRun({
        run: runWithFence,
        fence,
        signal,
        shadowModelAdapter: options.shadowModelAdapter,
        shadowModelRoute: options.shadowModelRoute,
        shadowModelTransport: options.shadowModelTransport,
      });
    }

    if (run.runKind === 'inbound_triage') {
      const { readAdmissionSnapshot } = await import('../mail/ingest/live-admission.js');
      const admissionSnapshot = run.admissionSnapshotId
        ? await readAdmissionSnapshot(
            db,
            run.admissionSnapshotId,
            run.admissionSnapshotHash ?? undefined,
          )
        : null;
      const fromSnapshot = (
        row: import('../mail/ingest/live-admission.js').AdmissionProjection,
      ) => ({
        ...row,
        createdAt: new Date(row.createdAt),
        receivedAt: row.receivedAt ? new Date(row.receivedAt) : null,
        sentAt: row.sentAt ? new Date(row.sentAt) : null,
      });
      const [trigger] = admissionSnapshot
        ? admissionSnapshot.threadMessages
            .filter((row) => row.id === run.triggerMessageId)
            .map(fromSnapshot)
        : await db.select().from(message).where(eq(message.id, run.triggerMessageId)).limit(1);
      const [mailbox] = await db
        .select({ email: mailboxTransport.email })
        .from(mailboxTransport)
        .where(eq(mailboxTransport.id, run.transportId))
        .limit(1);
      const [storedExtraction] = trigger
        ? await db
            .select({ payload: mailExtraction.payload })
            .from(mailExtraction)
            .where(
              and(
                eq(mailExtraction.messageId, run.triggerMessageId),
                eq(mailExtraction.status, 'succeeded'),
              ),
            )
            .orderBy(desc(mailExtraction.createdAt))
            .limit(1)
        : [];
      const rawConfirmationNumbers = storedExtraction?.payload?.confirmationNumbers;
      const confirmationNumbers = Array.isArray(rawConfirmationNumbers)
        ? rawConfirmationNumbers.filter((value): value is string => typeof value === 'string')
        : [];
      const existingStayInformation = isSelfSentPreStayInformationMail({
        fromAddress: trigger?.fromAddress,
        mailboxAddress: mailbox?.email,
        subject: trigger?.subject,
        confirmationNumbers,
      });

      const threadMessages = admissionSnapshot
        ? admissionSnapshot.threadMessages.map(fromSnapshot)
        : await db
            .select({
              id: message.id,
              threadId: message.threadId,
              fromAddress: message.fromAddress,
              subject: message.subject,
              textBody: message.textBody,
              htmlBody: message.htmlBody,
              direction: message.direction,
              createdAt: message.createdAt,
              receivedAt: message.receivedAt,
              sentAt: message.sentAt,
              toAddresses: message.toAddresses,
              ccAddresses: message.ccAddresses,
              bccAddresses: message.bccAddresses,
              messageIdHeader: message.messageIdHeader,
              inReplyTo: message.inReplyTo,
              references: message.references,
            })
            .from(message)
            .where(
              and(eq(message.threadId, run.threadId), eq(message.transportId, run.transportId)),
            )
            .orderBy(asc(message.createdAt), asc(message.id));

      const transportMessages = admissionSnapshot
        ? admissionSnapshot.transportMessages.map(fromSnapshot)
        : await db
            .select({
              id: message.id,
              threadId: message.threadId,
              fromAddress: message.fromAddress,
              subject: message.subject,
              direction: message.direction,
              createdAt: message.createdAt,
              receivedAt: message.receivedAt,
              sentAt: message.sentAt,
              toAddresses: message.toAddresses,
              ccAddresses: message.ccAddresses,
              bccAddresses: message.bccAddresses,
              messageIdHeader: message.messageIdHeader,
              inReplyTo: message.inReplyTo,
              references: message.references,
            })
            .from(message)
            .where(
              and(
                eq(message.transportId, run.transportId),
                or(
                  lt(message.createdAt, trigger?.createdAt ?? run.createdAt),
                  and(
                    eq(message.createdAt, trigger?.createdAt ?? run.createdAt),
                    lte(message.id, trigger?.id ?? run.triggerMessageId),
                  ),
                ),
              ),
            )
            .orderBy(asc(message.createdAt), asc(message.id));

      const rows: (TriageMessageRow & {
        to?: string[];
        cc?: string[];
        bcc?: string[];
      })[] = threadMessages.map((m) => ({
        id: m.id,
        from: m.fromAddress ?? '',
        subject: m.subject ?? undefined,
        body: m.textBody ?? m.htmlBody ?? '',
        direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
        createdAt: m.createdAt,
        receivedAt: m.receivedAt ?? null,
        sentAt: m.sentAt ?? null,
        to: m.toAddresses ?? [],
        cc: m.ccAddresses ?? [],
        bcc: m.bccAddresses ?? [],
        messageIdHeader: m.messageIdHeader,
        inReplyTo: m.inReplyTo,
        references: m.references,
      }));
      const messages = buildCausalTriageMessages(
        rows,
        run.triggerMessageId,
        admissionSnapshot
          ? { snapshotMessageIds: admissionSnapshot.threadMessages.map((row) => row.id) }
          : undefined,
      );
      const threadSignals = deriveThreadSignals(
        messages.map((m) => ({
          fromAddress: m.from,
          direction: m.direction,
          toAddresses: (m as typeof m & { to?: string[] }).to ?? [],
          ccAddresses: (m as typeof m & { cc?: string[] }).cc ?? [],
          bccAddresses: (m as typeof m & { bcc?: string[] }).bcc ?? [],
        })),
      );

      const externalSentAnalyticsOnly = trigger?.direction === 'outbound';
      const initialRunMetrics =
        run.metrics && typeof run.metrics === 'object'
          ? (run.metrics as Record<string, unknown>)
          : {};
      const mailSourceDecision = isMailSourceClassification(
        initialRunMetrics.mailSourceDecision,
      )
        ? initialRunMetrics.mailSourceDecision
        : null;
      const routeAsAutomatedChannel =
        !existingStayInformation &&
        !externalSentAnalyticsOnly &&
        mailSourceDecision !== null &&
        mailSourceDecision.kind !== 'direct';

      if (routeAsAutomatedChannel && mailSourceDecision) {
        const output = mailSourceTriageOutput(mailSourceDecision);
        await db.transaction(async (tx) => {
          const applyResult = await applyDurableTriageFromWorker({
            db: tx as unknown as typeof db,
            transportId: run.transportId,
            threadId: run.threadId,
            output,
            writeGateEnabled: env.AI_WRITE_GATE_ENABLED,
            // Deterministic source routing must apply automated-channel even when model-based v6 triage is off.
            workflowTriageEnabled: true,
            mailSourceRouteTrusted: true,
            // A new source decision supersedes a previously settled automated folder for this thread. Manual spam
            // locks still win inside applyDurableTriageResult.
            forceUnsettle: true,
            threadSignals,
            from: trigger?.fromAddress ?? '',
            to: trigger?.toAddresses ?? [],
            cc: trigger?.ccAddresses ?? [],
            bcc: trigger?.bccAddresses ?? [],
          });
          const marked = await markAiRunSucceeded(
            {
              runId,
              claimOwner: owner,
              claimToken,
              expectedStates: ['running'],
              metrics: {
                mailSourceDecision,
                triageRationale: output.rationale,
                deterministicMailSourceRoute: true,
                durableWrite: env.AI_WRITE_GATE_ENABLED,
                workflowTriage: true,
                applyMode: applyResult.applyMode,
                mailBaseline: { status: 'skipped', reason: 'non_actionable_mail_source' },
              },
            },
            tx as unknown as typeof db,
          );
          if (!marked) {
            throw new Error(`failed to mark deterministic mail-source triage succeeded: ${runId}`);
          }
        });
        scheduleQuotePreparationForExtraction(runWithFence);
        return { runId, state: 'succeeded' };
      }

      if (!externalSentAnalyticsOnly && !isInboundTriageClassifierEnabled(process.env)) {
        // Classifier retired (INBOUND_TRIAGE_CLASSIFIER=off with INBOUND_EXTRACTION=on): no classifier call and no
        // folder, read or spam write. Spam, the baseline and the warmer come from inbound_extraction. A run queued
        // before the flag flipped ends here. With the classifier on, this run projects the inbound baseline as before.
        const retired = await markAiRunSucceeded({
          runId,
          claimOwner: owner,
          claimToken,
          expectedStates: ['running'],
          metrics: {
            triageRetired: true,
            ...(mailSourceDecision ? { mailSourceDecision } : {}),
          },
        });
        if (retired) {
          schedulePrefetchForInbound(runWithFence);
          scheduleQuotePreparationForExtraction(runWithFence);
        }
        return { runId, state: retired ? 'succeeded' : 'retry_wait' };
      }
      let output: WorkflowTriageOutput;
      let mastraTraceId: string | undefined;
      let workflowMetrics: Record<string, unknown> = {};
      if (externalSentAnalyticsOnly) {
        // Sent copies are analytics evidence, not a triage admission. Do not
        // initialize the triage workflow or apply folder/read/spam changes.
        output = validateWorkflowTriageOutput({
          primaryFolder: 'unknown-review',
          priority: 'P3',
          urgent: false,
          overlays: {},
          isSpam: false,
          suggestedTools: [],
          sourceScope: 'external',
          automationState: 'unknown',
          humanAction: 'review_required',
          confidence: 0,
          rationale: 'External Sent copy is analytics-only evidence.',
          policyFlags: ['analytics-only:external-sent'],
          abstainReason: 'analytics_only_external_sent',
        });
      } else {
        const mastra = createMastraRuntime(process.env.MASTRA_STORAGE_PATH);
        const workflow = mastra.getWorkflow('mailTriage');
        const workflowRun = await workflow.createRun();
        const result = await workflowRun.start({
          inputData: {
            transportId: run.transportId,
            threadId: run.threadId,
            triggerMessageId: run.triggerMessageId,
            mailboxAddress: mailbox?.email ?? undefined,
            confirmationNumbers,
            subject: trigger?.subject ?? undefined,
            from: trigger?.fromAddress ?? '',
            to: trigger?.toAddresses ?? [],
            cc: trigger?.ccAddresses ?? [],
            bcc: trigger?.bccAddresses ?? [],
            body: trigger?.textBody ?? trigger?.htmlBody ?? '',
            messages,
            threadSignals,
            transportIndexMessages: threadMessagesToTransportIndex(transportMessages),
            snapshotMessageIds: admissionSnapshot?.threadMessages.map((row) => row.id),
            asOf: run.createdAt.toISOString(),
            modelId: run.modelId,
            promptVersion: TRIAGE_PROMPT_VERSION,
          },
          // Budget/lease fence for Mastra + future Playwright/S3/subprocess callers.
          abortSignal: signal,
        } as Parameters<typeof workflowRun.start>[0] & { abortSignal: AbortSignal });
        if (result.status !== 'success') {
          throw new Error(`mail triage workflow failed: ${result.status}`);
        }
        output = validateWorkflowTriageOutput(result.result?.output);
        mastraTraceId = result.result?.traceId;
        workflowMetrics = (result.result?.metrics as Record<string, unknown>) ?? {};
      }

      const baselineHints = triageOutputSemanticHints(output);
      const baselineRow = trigger
        ? messages.find((candidate) => candidate.id === run.triggerMessageId)
        : undefined;
      let routedBaseline:
        | Awaited<ReturnType<typeof extractMailBaselineWithApprovedRoute>>
        | undefined;
      if (baselineRow) {
        const clock = resolveTriageEventClock(baselineRow);
        routedBaseline = await extractMailBaselineWithApprovedRoute(
          {
            sourceVintage: run.createdAt.toISOString(),
            observationCutoff: run.createdAt,
            interpretationVersion: MAIL_BASELINE_INTERPRETATION_VERSION,
            classifierVersion: baselineRoute.available
              ? 'mail-baseline-semantic-v1'
              : 'mail-baseline-observation-v1',
            reviewerVersion: TRIAGE_REVIEWER_VERSION,
            message: {
              id: baselineRow.id,
              transportId: run.transportId,
              threadId: run.threadId,
              direction: baselineRow.direction,
              fromAddress: baselineRow.from,
              toAddresses: baselineRow.to ?? [],
              ccAddresses: baselineRow.cc ?? [],
              bccAddresses: baselineRow.bcc ?? [],
              subject: baselineRow.subject ?? null,
              textBody: baselineRow.body,
              receivedAt: baselineRow.receivedAt,
              sentAt: baselineRow.sentAt,
              createdAt: baselineRow.createdAt,
              messageIdHeader: baselineRow.messageIdHeader,
              inReplyTo: baselineRow.inReplyTo,
              references: baselineRow.references,
              source: baselineRow.direction === 'outbound' ? 'external_sent' : 'mail_event',
              sourceBasis: clock.basis,
              ...(baselineRow.direction === 'outbound'
                ? { sendEvidence: { status: 'sent' as const } }
                : {}),
            },
          },
          baselineRoute,
          { signal, deadlineAt: deadlineAt.getTime() },
        );
      }

      await db.transaction(async (tx) => {
        let applyMode: string;
        if (externalSentAnalyticsOnly) {
          applyMode = 'analytics_only_external_sent';
        } else {
          const applyResult = await applyDurableTriageFromWorker({
            db: tx as unknown as typeof db,
            transportId: run.transportId,
            threadId: run.threadId,
            output,
            writeGateEnabled: env.AI_WRITE_GATE_ENABLED,
            workflowTriageEnabled: env.WORKFLOW_TRIAGE_V6,
            forceUnsettle: run.metrics?.retagPending === true,
            threadSignals,
            from: trigger?.fromAddress ?? '',
            to: trigger?.toAddresses ?? [],
            cc: trigger?.ccAddresses ?? [],
            bcc: trigger?.bccAddresses ?? [],
          });
          applyMode = applyResult.applyMode;
        }

        let baselineMetrics: Record<string, unknown> = {
          status:
            routedBaseline?.semanticRoute === 'approved_local_extraction'
              ? 'persisted_semantic_projection'
              : 'persisted_source_observation',
          routeStatus: baselineRoute.available ? 'available' : 'unavailable',
          routeId: baselineRoute.route,
          extraction: routedBaseline?.semanticRoute ?? 'none',
          triageClassifierVersion: baselineHints.classifierVersion,
          ...(baselineRoute.reason ? { reason: baselineRoute.reason } : {}),
        };
        if (routedBaseline && baselineRow) {
          const extraction = routedBaseline.extraction;
          const configuredMeasurement = parseMailboxMeasurementConfig(
            process.env.MAIL_MEASUREMENT_CONFIG_JSON,
          );
          const producerMeasurement =
            configuredMeasurement?.transportId === run.transportId ? configuredMeasurement : null;
          const generationId = mailBaselineGenerationKey({
            transportId: run.transportId,
            threadId: run.threadId,
            sourceMessageId: baselineRow.id,
            sourceVintage: run.createdAt.toISOString(),
            interpretationVersion: extraction.interpretationVersion,
          });
          const persisted = await persistMailBaselineProjection(tx as unknown as typeof db, {
            transportId: run.transportId,
            threadId: run.threadId,
            generationId,
            sourceVintage: extraction.sourceVintage,
            interpretationVersion: extraction.interpretationVersion,
            reviewerVersion: TRIAGE_REVIEWER_VERSION,
            observationCutoff: run.createdAt,
            measurementStartAt: producerMeasurement?.measurementStartAt ?? null,
            coverage: {
              configVersion: producerMeasurement ? String(producerMeasurement.version) : null,
              startAt: producerMeasurement?.measurementStartAt ?? null,
              endAt: run.createdAt.toISOString(),
              basis: producerMeasurement?.captureAssumptionBasis ?? 'coverage_unconfigured',
              complete:
                producerMeasurement !== null && producerMeasurement.measurementStartAt !== null,
              confirmedGapIntervals: producerMeasurement?.confirmedGapIntervals ?? [],
            },
            evidence: extraction.evidence,
          });
          baselineMetrics = {
            ...baselineMetrics,
            generationId,
            inserted: persisted.inserted,
            evidenceCount: extraction.evidence.length,
            ...(routedBaseline.modelUsage ? { modelUsage: routedBaseline.modelUsage } : {}),
          };
        }

        const marked = await markAiRunSucceeded(
          {
            runId,
            claimOwner: owner,
            claimToken,
            expectedStates: ['running'],
            mastraTraceId,
            metrics: {
              ...workflowMetrics,
              ...(mailSourceDecision ? { mailSourceDecision } : {}),
              triageRationale: output.rationale,
              durableWrite: env.AI_WRITE_GATE_ENABLED,
              workflowTriage: env.WORKFLOW_TRIAGE_V6,
              applyMode,
              mailBaseline: baselineMetrics,
            },
          },
          tx as unknown as typeof db,
        );
        if (!marked) {
          throw new Error(`failed to mark AI run succeeded with claim fencing: ${runId}`);
        }
      });

      schedulePrefetchForInbound(runWithFence);
      scheduleQuotePreparationForExtraction(runWithFence);
      return { runId, state: 'succeeded' };
    }

    if (run.runKind === 'candidate_draft') {
      // Adapter construction belongs in this try: a missing Azure env must
      // mark THIS claimed run failed (retry/dead-letter) instead of crashing
      // the worker loop and leaving the claim stale until timeout.
      const candidateDraftRoute =
        options.candidateDraftRoute ?? options.candidateDraftRouteFactory?.();
      const [trigger] = await db
        .select()
        .from(message)
        .where(eq(message.id, run.triggerMessageId))
        .limit(1);
      if (!trigger) throw new Error(`trigger message not found: ${run.triggerMessageId}`);

      const { deriveReplySubject, deriveReplyToAddress } = await import(
        './workflows/candidate-draft.js'
      );
      const replyTo = deriveReplyToAddress(trigger.fromAddress);
      if (!replyTo) {
        const marked = await markAiRunSucceeded({
          runId,
          claimOwner: owner,
          claimToken,
          expectedStates: ['running'],
          metrics: { skipped: true, reason: 'missing_reply_to_address' },
        });
        if (!marked) {
          return { runId, state: 'retry_wait' };
        }
        return { runId, state: 'succeeded' };
      }

      const generationId = run.generationId ?? `${run.id}-generation`;
      const [existingGeneration] = await db
        .select({ requestedByUserId: aiDraftGeneration.requestedByUserId })
        .from(aiDraftGeneration)
        .where(eq(aiDraftGeneration.id, generationId))
        .limit(1);
      const createdByUserId = existingGeneration?.requestedByUserId ?? 'user-navaai';
      const subject = deriveReplySubject(trigger.subject);
      const hmsMode = env.HMS_DRAFT_ENRICHMENT_MODE;

      // Off mode still uses the normal prepared-input/assessment boundary.
      // It must not enter the registered Mastra workflow with raw body text.
      if (hmsMode === 'off') {
        if (candidateDraftRoute?.reservationist) {
          const { runReservationistWorkerCandidate } = await import('./reservationist-worker.js');
          return await runReservationistWorkerCandidate({ db, run, fence, route: candidateDraftRoute, replyTo, subject, signal });
        }
        const requestText = trigger.textBody ?? trigger.htmlBody ?? '';
        const replyAsks = options.candidateReplyAsks ?? deriveWorkerReplyAsks(requestText);
        const preparedReply = await runPreparedWorkerCandidateReply({
          requestId: run.triggerMessageId,
          threadId: run.threadId,
          requestText,
          asks: replyAsks,
          adapter: options.candidateReplyModelAdapter ?? options.candidateModelAdapter,
          route: candidateDraftRoute,
          signal,
          deadlineAt: deadlineAt.getTime(),
        });
        const persistedOutcome =
          preparedReply.outcome === 'complete' || preparedReply.outcome === 'partial'
            ? 'candidate'
            : preparedReply.outcome === 'clarification'
              ? 'needs_clarification'
              : 'insufficient_evidence';

        const draft = await persistAiCandidateDraft({
          db,
          transportId: run.transportId,
          threadId: run.threadId,
          replyToMessageId: run.triggerMessageId,
          createdByUserId,
          generationId,
          model: run.modelId,
          promptVersion: run.promptVersion,
          contextMessageIds: [run.triggerMessageId],
          toAddresses: [replyTo],
          subject,
          textBody: preparedReply.textBody,
          htmlBody: preparedReply.htmlBody,
          outcome: persistedOutcome,
          ...(candidateDraftRoute?.release
            ? {
                routeBinding: {
                  ...candidateDraftRoute.route,
                  release: candidateDraftRoute.release,
                },
              }
            : {}),
          persistDraft: true,
        });
        const marked = await markAiRunSucceeded({
          runId,
          claimOwner: owner,
          claimToken,
          expectedStates: ['running'],
          generationId: draft.generationId ?? generationId,
          metrics: {
            draftId: draft.id,
            generationId: draft.generationId ?? generationId,
            modelId: run.modelId,
            hmsMode: 'off',
            ...(preparedReply.metrics as Record<string, unknown>),
            preparedReplyOutcome: preparedReply.outcome,
            preparedReplyAssessment: preparedReply.assessment.issues.map((issue) => issue.code),
            preparedInputSerializedBytes: Buffer.byteLength(preparedReply.serializedInput, 'utf8'),
          },
        });
        if (!marked) {
          return { runId, state: 'retry_wait' };
        }
        return { runId, state: 'succeeded' };
      }

      // HMS lane + shadow: strict terminal writer — never persistAiCandidateDraft.
      // Default lane never enters this branch (executorLane gate).
      if (run.executorLane === 'hms' && hmsMode === 'shadow') {
        const { runClaimSafeCandidateDraft } = await import('./candidate-draft-agent.js');
        const { finishHmsShadowRun, failHmsShadowRun, resolveHmsShadowPreBrowser } = await import(
          './hms-shadow.js'
        );
        const { readAuthorizedArtifact, recheckAuthorizedArtifactIdentity } = await import(
          '../mail/artifacts/read-artifact.js'
        );
        const { getS3Storage } = await import('../storage/s3.js');

        const loadThreadMessages = async () =>
          db
            .select({
              id: message.id,
              transportId: message.transportId,
              threadId: message.threadId,
              direction: message.direction,
              textBody: message.textBody,
              htmlBody: message.htmlBody,
              subject: message.subject,
              receivedAt: message.receivedAt,
              sentAt: message.sentAt,
            })
            .from(message)
            .where(
              and(eq(message.threadId, run.threadId), eq(message.transportId, run.transportId)),
            );

        const loadThreadAttachments = async () =>
          db
            .select({
              id: attachment.id,
              messageId: attachment.messageId,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              s3Key: attachment.s3Key,
              sha256: attachment.sha256,
              isInline: attachment.isInline,
              createdAt: attachment.createdAt,
              direction: message.direction,
            })
            .from(attachment)
            .innerJoin(message, eq(message.id, attachment.messageId))
            .where(
              and(eq(message.threadId, run.threadId), eq(message.transportId, run.transportId)),
            );

        const mapMessages = (
          threadMessages: Awaited<ReturnType<typeof loadThreadMessages>>,
          threadAttachments: Awaited<ReturnType<typeof loadThreadAttachments>>,
        ) => {
          const attachmentIds = new Map<string, string[]>();
          for (const row of threadAttachments) {
            const ids = attachmentIds.get(row.messageId) ?? [];
            ids.push(row.id);
            attachmentIds.set(row.messageId, ids);
          }
          return threadMessages.map((m) => ({
            id: m.id,
            transportId: m.transportId,
            threadId: m.threadId,
            direction: (m.direction === 'outbound' ? 'outbound' : 'inbound') as
              | 'inbound'
              | 'outbound',
            textBody: m.textBody,
            htmlBody: m.htmlBody,
            subject: m.subject,
            receivedAt: m.receivedAt,
            sentAt: m.sentAt,
            attachmentIds: attachmentIds.get(m.id) ?? [],
          }));
        };

        try {
          // Double freshness + exactly-one gate before browser context.
          // Pass 2 reloads latestDraftRevisionId (must not reuse pass-1 id).
          if (signal.aborted) throw new RunDeadlineError();
          const generationKey = run.generationId ?? `${run.id}-generation`;
          const [generationOwner] = await db
            .select({ requestedByUserId: aiDraftGeneration.requestedByUserId })
            .from(aiDraftGeneration)
            .where(eq(aiDraftGeneration.id, generationKey))
            .limit(1);
          const principalId =
            generationOwner?.requestedByUserId ?? process.env.HMS_SHADOW_SERVICE_USER_ID?.trim();
          if (!principalId) {
            throw Object.assign(new Error('artifact authorization unavailable'), {
              failureClass: 'AUTH' as const,
            });
          }

          type ArtifactLocator = import('../mail/artifacts/read-artifact.js').AttachmentLocator;
          let currentLocators = new Map<string, ArtifactLocator>();
          const initialLocators = new Map<string, ArtifactLocator>();
          let currentAuthorized = new Set<string>();
          let artifactSnapshotPass = 0;
          const loadArtifactSnapshot = async () => {
            const [threadMessages, threadAttachments, grant] = await Promise.all([
              loadThreadMessages(),
              loadThreadAttachments(),
              db
                .select({
                  id: mailboxAccess.id,
                  role: mailboxAccess.role,
                  updatedAt: mailboxAccess.updatedAt,
                })
                .from(mailboxAccess)
                .where(
                  and(
                    eq(mailboxAccess.userId, principalId),
                    eq(mailboxAccess.transportId, run.transportId),
                  ),
                )
                .limit(1),
            ]);
            const latestDraftRevisionId = await loadLatestThreadAffectingDraftRevisionId(db, {
              transportId: run.transportId,
              threadId: run.threadId,
            });
            const mapped = mapMessages(threadMessages, threadAttachments);
            const context = await import('./thread-context.js').then(({ buildThreadContext }) =>
              buildThreadContext({
                transportId: run.transportId,
                threadId: run.threadId,
                triggerMessageId: run.triggerMessageId,
                messages: mapped,
                latestDraftRevisionId,
              }),
            );
            const included = new Set(context.includedMessageIds);
            const eligible = threadAttachments.filter(
              (row) =>
                included.has(row.messageId) &&
                row.direction === 'inbound' &&
                !row.isInline &&
                row.mimeType === 'application/pdf',
            );
            currentLocators = new Map(
              eligible.map((row) => [
                row.id,
                {
                  s3Key: row.s3Key,
                  mimeType: row.mimeType,
                  sizeBytes: row.sizeBytes,
                  messageId: row.messageId,
                  sha256: row.sha256,
                },
              ]),
            );
            currentAuthorized = new Set(currentLocators.keys());
            artifactSnapshotPass += 1;
            if (artifactSnapshotPass === 1) {
              for (const [id, locator] of currentLocators) {
                initialLocators.set(id, locator);
              }
            }
            const digest = (value: unknown) =>
              createHash('sha256').update(JSON.stringify(value)).digest('hex');
            return {
              grantDigest: grant[0]
                ? digest({
                    id: grant[0].id,
                    role: grant[0].role,
                    updatedAt: grant[0].updatedAt.toISOString(),
                  })
                : null,
              attachmentStateVersion: digest(
                eligible
                  .map((row) => ({
                    id: row.id,
                    messageId: row.messageId,
                    mimeType: row.mimeType,
                    sizeBytes: row.sizeBytes,
                    inline: row.isInline,
                    createdAt: row.createdAt.toISOString(),
                    keyHash: digest(row.s3Key),
                  }))
                  .sort((a, b) => a.id.localeCompare(b.id)),
              ),
              context,
              pdfAttachmentIds: [...currentAuthorized].sort(),
            };
          };

          const pre = await resolveHmsShadowPreBrowser(
            {
              transportId: run.transportId,
              threadId: run.threadId,
              triggerMessageId: run.triggerMessageId,
              loadLatestDraftRevisionId: () =>
                loadLatestThreadAffectingDraftRevisionId(db, {
                  transportId: run.transportId,
                  threadId: run.threadId,
                }),
              loadMessages: async () =>
                mapMessages(await loadThreadMessages(), await loadThreadAttachments()),
              loadArtifactSnapshot,
              readArtifact: async (attachmentId, artifactSignal) => {
                const reserved = await reserveReadAttempt(
                  fence,
                  'artifact_reservation',
                  'mail_read_artifact',
                );
                if (!reserved) {
                  throw Object.assign(new Error('LEASE_LOST'), {
                    name: 'LeaseLostError',
                    failureClass: 'LEASE_LOST' as const,
                  });
                }
                const s3 = getS3Storage();
                if (s3.kind !== 'real') {
                  throw Object.assign(new Error('ARTIFACT_REAL_S3_REQUIRED'), {
                    failureClass: 'AUTH' as const,
                  });
                }
                return (await readAuthorizedArtifact({
                  attachmentId,
                  authorizedAttachmentIds: currentAuthorized,
                  s3,
                  signal: artifactSignal,
                  resolveLocator: async (id) => currentLocators.get(id) ?? null,
                })) as unknown as ToolResult<ArtifactData>;
              },
              recheckArtifactIdentity: async ({
                attachmentId,
                expectedSha256,
                signal: artifactSignal,
              }) => {
                const expectedLocator = initialLocators.get(attachmentId);
                if (!expectedLocator) return false;
                return recheckAuthorizedArtifactIdentity({
                  attachmentId,
                  authorizedAttachmentIds: currentAuthorized,
                  expectedLocator,
                  expectedSha256,
                  s3: getS3Storage(),
                  signal: artifactSignal,
                  resolveLocator: async (id) => currentLocators.get(id) ?? null,
                });
              },
            },
            { signal },
          );

          if (pre.kind === 'stale_thread') {
            const finished = await finishHmsShadowRun(fence, {
              outcome: 'stale_thread',
              toolCalls: 0,
              toolBudgetUsed: 0,
              claimCount: 0,
            });
            return {
              runId,
              state: finished ? 'succeeded' : 'retry_wait',
            };
          }

          if (pre.kind === 'authorization_denied') {
            throw Object.assign(new Error('artifact authorization denied'), {
              failureClass: 'AUTH' as const,
            });
          }

          if (pre.kind === 'insufficient_evidence') {
            const finished = await finishHmsShadowRun(fence, {
              outcome: 'insufficient_evidence',
              toolCalls: 0,
              toolBudgetUsed: 0,
              claimCount: 0,
            });
            return {
              runId,
              state: finished ? 'succeeded' : 'retry_wait',
            };
          }

          if (signal.aborted) throw new RunDeadlineError();

          const sessionFactory =
            options.candidateSessionFactory ?? createLiveHmsCandidateSessionFactory();
          // Production HMS lane refuses missing live factory (never mock).
          if (!sessionFactory) {
            throw new Error('HMS_LIVE_SESSION_FACTORY_REQUIRED');
          }

          // Exactly one exact candidate reaches the browser.
          const session = await sessionFactory({
            transportId: run.transportId,
            threadId: run.threadId,
            lookupCandidates: [pre.exact],
            signal,
            runId,
            readFence: toAiRunFence(runWithFence) ?? fence,
            readPlanKind:
              (pre.artifactMetrics?.attempted ?? 0) > 0 ? 'artifact_reservation' : 'reservation',
          });

          const { resolvePlanScopedDraftGate } = await import('../hms/candidate-read-plan.js');
          const planGate = resolvePlanScopedDraftGate({
            activeReleases: session.activeReleases,
            lookupCandidates: session.lookupCandidates,
            operationId: runId,
            authorizedAttachmentIds: session.authorizedAttachmentIds,
          });
          const claimSafe = await runClaimSafeCandidateDraft({
            session,
            normalizedThreadText: pre.context.normalizedText,
            signal,
            probeCandidateIds: [pre.exact.id],
            probeAttachmentIds: [],
            planMode: 'production',
            planModel: options.candidatePlanModel,
            modelAdapter: options.candidateModelAdapter,
            replyModelAdapter: options.candidateReplyModelAdapter ?? options.candidateModelAdapter,
            replyAsks:
              options.candidateReplyAsks ?? deriveWorkerReplyAsks(pre.context.normalizedText),
            deadlineAt: deadlineAt.getTime(),
            ...(planGate
              ? {
                  candidateBindings: planGate.candidateBindings,
                  requesterAuthorization: planGate.requesterAuthorization,
                }
              : {}),
          });

          // Discard draft bodies / evidence — counters only.
          const finished = await finishHmsShadowRun(fence, {
            outcome: claimSafe.outcome,
            toolCalls: Number(claimSafe.metrics.toolCalls ?? 0),
            toolBudgetUsed: Number(claimSafe.metrics.toolBudgetUsed ?? 0),
            claimCount: Number(claimSafe.metrics.claimCount ?? 0),
            artifactAttempted: pre.artifactMetrics?.attempted ?? 0,
            artifactReadable: pre.artifactMetrics?.readable ?? 0,
            artifactManualRequired: pre.artifactMetrics?.manualRequired ?? 0,
            hmsLookupCalls: 1,
          });
          return {
            runId,
            state: finished ? 'succeeded' : 'retry_wait',
          };
        } catch (error) {
          const state = await failHmsShadowRun(fence, error, {
            attempts: run.attempts,
          });
          return { runId, state };
        }
      }

      // Non-HMS claim-safe path (fixtures / default lane enrichment tests).
      // HMS shadow never reaches here. enabled rejected at env parse.
      const { runClaimSafeCandidateDraft, createMockCandidateSession } = await import(
        './candidate-draft-agent.js'
      );
      const { buildThreadContext } = await import('./thread-context.js');
      const threadMessages = await db
        .select({
          id: message.id,
          transportId: message.transportId,
          threadId: message.threadId,
          direction: message.direction,
          textBody: message.textBody,
          htmlBody: message.htmlBody,
          subject: message.subject,
          receivedAt: message.receivedAt,
          sentAt: message.sentAt,
        })
        .from(message)
        .where(and(eq(message.threadId, run.threadId), eq(message.transportId, run.transportId)));

      const latestDraftRevisionId = await loadLatestThreadAffectingDraftRevisionId(db, {
        transportId: run.transportId,
        threadId: run.threadId,
      });
      const context = await buildThreadContext({
        transportId: run.transportId,
        threadId: run.threadId,
        triggerMessageId: run.triggerMessageId,
        messages: threadMessages.map((m) => ({
          id: m.id,
          transportId: m.transportId,
          threadId: m.threadId,
          direction: (m.direction === 'outbound' ? 'outbound' : 'inbound') as
            | 'inbound'
            | 'outbound',
          textBody: m.textBody,
          htmlBody: m.htmlBody,
          subject: m.subject,
          receivedAt: m.receivedAt,
          sentAt: m.sentAt,
          attachmentIds: [],
        })),
        latestDraftRevisionId,
      });

      const session = options.candidateSessionFactory
        ? await options.candidateSessionFactory({
            transportId: run.transportId,
            threadId: run.threadId,
            lookupCandidates: context.lookupCandidates,
            signal,
            runId,
            // Only HMS-lane runs hold a durable read budget to reserve against.
            ...(run.executorLane === 'hms'
              ? {
                  readFence: toAiRunFence(runWithFence) ?? fence,
                  readPlanKind: 'reservation' as const,
                }
              : {}),
          })
        : createMockCandidateSession({
            lookupCandidates: new Map(context.lookupCandidates.map((c) => [c.id, c])),
            authorizedAttachmentIds: new Set(context.authorizedAttachmentIds),
          });

      const { resolvePlanScopedDraftGate } = await import('../hms/candidate-read-plan.js');
      const planGate = resolvePlanScopedDraftGate({
        activeReleases: session.activeReleases,
        lookupCandidates: session.lookupCandidates,
        operationId: runId,
        authorizedAttachmentIds: session.authorizedAttachmentIds,
      });
      const claimSafe = await runClaimSafeCandidateDraft({
        session,
        normalizedThreadText: context.normalizedText,
        signal,
        planModel: options.candidatePlanModel,
        modelAdapter: options.candidateModelAdapter,
        replyModelAdapter: options.candidateReplyModelAdapter ?? options.candidateModelAdapter,
        replyAsks: options.candidateReplyAsks ?? deriveWorkerReplyAsks(context.normalizedText),
        deadlineAt: deadlineAt.getTime(),
        ...(planGate
          ? {
              candidateBindings: planGate.candidateBindings,
              requesterAuthorization: planGate.requesterAuthorization,
            }
          : {}),
      });

      // HMS_DRAFT_ENRICHMENT_MODE=enabled is rejected at env parse; non-HMS
      // shadow-like paths still use persistDraft=false lifecycle fencing.
      const persistDraft = false;
      const { renderClarificationQuestions, textToSafeHtml } = await import('./draft-evidence.js');
      const clarificationText =
        claimSafe.outcome === 'candidate'
          ? null
          : renderClarificationQuestions(claimSafe.plan.questionCodes).join('\n\n') ||
            'Insufficient evidence for an automated candidate.';
      const textBody = claimSafe.outcome === 'candidate' ? claimSafe.textBody : clarificationText!;
      const htmlBody =
        claimSafe.outcome === 'candidate' ? claimSafe.htmlBody : textToSafeHtml(textBody);

      let claimFenceLost = false;
      try {
        await db.transaction(async (tx) => {
          const draft = await persistAiCandidateDraft({
            db: tx as unknown as typeof db,
            transportId: run.transportId,
            threadId: run.threadId,
            replyToMessageId: run.triggerMessageId,
            createdByUserId,
            generationId,
            model: run.modelId,
            promptVersion: run.promptVersion,
            contextMessageIds: context.includedMessageIds,
            toAddresses: [replyTo],
            subject,
            textBody,
            htmlBody,
            outcome: claimSafe.outcome,
            evidence: claimSafe.evidence.map((e) => e.evidence),
            threadStateVersion: context.threadStateVersion,
            latestDraftRevisionId,
            persistDraft,
          });

          const marked = await markAiRunSucceeded(
            {
              runId,
              claimOwner: owner,
              claimToken,
              expectedStates: ['running'],
              generationId: draft.generationId ?? generationId,
              metrics: {
                draftId: draft.id,
                generationId: draft.generationId ?? generationId,
                modelId: run.modelId,
                hmsMode,
                outcome: claimSafe.outcome,
                persistDraft,
                threadStateVersion: context.threadStateVersion,
                ...claimSafe.metrics,
              },
            },
            tx as unknown as typeof db,
          );
          if (!marked) {
            claimFenceLost = true;
            throw new Error(`failed to mark AI run succeeded with claim fencing: ${runId}`);
          }
        });
      } catch (error) {
        if (claimFenceLost) return { runId, state: 'retry_wait' };
        throw error;
      }
      return { runId, state: 'succeeded' };
    }

    if (run.runKind === 'inbound_extraction') {
      const extracted = await executeInboundExtractionRun({
        run: runWithFence,
        fence,
        signal,
        adapter: options.inboundExtractionAdapter,
        db,
        mailBaselineRoute: baselineRoute,
      });
      // Off unless HMS_JOB_QUEUE=on and HMS_AVAILABILITY_PREFETCH=on; quote mail only (U10).
      if (extracted.state === 'succeeded') {
        await storeWorkflowClassifierForInbound(db, runWithFence.triggerMessageId, options.ingestClassify);
        scheduleAvailabilityPrefetch(runWithFence);
        scheduleQuotePreparationForExtraction(runWithFence);
        // U3 reads the committed extraction; the scheduler waits for matching triage too when that run exists.
        schedulePrefetchForInbound(runWithFence);
      }
      return extracted;
    }

    if (run.runKind === 'quote_followup') {
      return await executeQuoteFollowupRun({ run: runWithFence, fence, db });
    }

    if (run.runKind === 'reply_check') {
      return await executeReplyCheckRun({ run: runWithFence, fence, db });
    }

    if (run.runKind === 'feedback_extraction') {
      const [draft] = await db
        .select()
        .from(mailDraft)
        .where(eq(mailDraft.sentMessageId, run.triggerMessageId))
        .limit(1);
      if (!draft) throw new Error('sent draft not found for feedback extraction');
      const revisions = await db
        .select()
        .from(mailDraftRevision)
        .where(eq(mailDraftRevision.draftId, draft.id));
      const aiGenerated = revisions.find((row) => row.kind === 'ai_generated');
      const sent = revisions.find((row) => row.kind === 'sent');
      if (!aiGenerated || !sent) {
        throw new Error('missing ai_generated or sent revision for feedback extraction');
      }
      const feedback = extractDraftFeedbackLabels({
        aiGenerated,
        sent,
      });
      const marked = await markAiRunSucceeded({
        runId,
        claimOwner: owner,
        claimToken,
        expectedStates: ['running'],
        metrics: {
          labels: feedback.labels,
          ...feedback.metrics,
        },
      });
      if (!marked) {
        return { runId, state: 'retry_wait' };
      }
      return { runId, state: 'succeeded' };
    }

    throw new Error(`unsupported AI run kind: ${run.runKind}`);
  } catch (error) {
    // A worker shutdown (a deploy restart) cut off an inbound read. Its writes commit only under the claim, and a
    // read stored before the cut is found again ('exists'), so it goes back on the queue now with a fresh deadline for
    // the next worker. The run's own deadline or a lost lease aborts with another reason and fails as before. The loop
    // claims nothing once shutdown starts, so each requeue takes one more shutdown. The first costs no attempt; a run
    // cut off again right after one spends an attempt each time and dead-letters at MAX_WORKER_SHUTDOWN_ATTEMPTS, so a
    // read that keeps its worker from stopping is not requeued forever.
    const cutAgain = run.failureClass === 'WORKER_SHUTDOWN';
    if (
      run.runKind === 'inbound_extraction' &&
      shutdownSignal.aborted &&
      signal.reason === shutdownSignal.reason &&
      !(cutAgain && run.attempts >= MAX_WORKER_SHUTDOWN_ATTEMPTS)
    ) {
      const requeued = await markAiRunRetry({
        runId,
        claimOwner: owner,
        claimToken,
        expectedStates: ['running'],
        attempts: cutAgain ? run.attempts + 1 : run.attempts,
        nextRunAt: new Date(),
        lastError: `worker shutdown: ${error instanceof Error ? error.message : String(error)}`,
        failureClass: 'WORKER_SHUTDOWN',
        resetDeadline: true,
      });
      if (requeued) return { runId, state: 'retry_wait' };
    }
    return failAiRun(runWithFence, error, toAiRunFence(runWithFence) ?? fence);
  } finally {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  }
}

async function applyDurableTriageFromWorker(input: {
  db: ReturnType<typeof getDb>;
  transportId: string;
  threadId: string;
  output: WorkflowTriageOutput;
  writeGateEnabled: boolean;
  workflowTriageEnabled: boolean;
  forceUnsettle?: boolean;
  mailSourceRouteTrusted?: boolean;
  threadSignals?: ThreadSignals;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
}) {
  const { applyDurableTriageResult } = await import('./triage.js');
  return applyDurableTriageResult(input);
}

function scopeFromCli(args: AiWorkerCliArgs): AiRunScopeFilter {
  return {
    transportId: args.transportId,
    runKind: args.runKind,
    promptVersion: args.promptVersion,
    idempotencyPrefix: args.drainPrefix,
  };
}

function maybeInitHmsRuntime(lane: AiExecutorLane): void {
  if (lane !== 'hms') return;
  // Shadow must fail closed on secret/chromium/role-proof before accepting jobs.
  assertHmsLaneRuntimeReady();
}

export type RunAiWorkerOnceOptions = {
  shutdownSignal?: AbortSignal;
  /** Lane hms claims wait on this until the restart sweep has succeeded. */
  hmsRecovery?: HmsRecoveryGate;
  readToolExecutor?: NonNullable<Parameters<typeof executeAiRun>[1]>['readToolExecutor'];
  mailBaselineExtractionRoute?: NonNullable<
    Parameters<typeof executeAiRun>[1]
  >['mailBaselineExtractionRoute'];
  mailBaselineExtractionRouteFactory?: MailBaselineExtractionRouteFactory;
  candidatePlanModel?: NonNullable<Parameters<typeof executeAiRun>[1]>['candidatePlanModel'];
  candidateModelAdapter?: NonNullable<Parameters<typeof executeAiRun>[1]>['candidateModelAdapter'];
  candidateReplyModelAdapter?: NonNullable<
    Parameters<typeof executeAiRun>[1]
  >['candidateReplyModelAdapter'];
  candidateDraftRouteFactory?: DraftModelRouteFactory;
  candidateReplyAsks?: NonNullable<Parameters<typeof executeAiRun>[1]>['candidateReplyAsks'];
  shadowModelAdapter?: NonNullable<Parameters<typeof executeAiRun>[1]>['shadowModelAdapter'];
  shadowModelRoute?: NonNullable<Parameters<typeof executeAiRun>[1]>['shadowModelRoute'];
  shadowModelTransport?: NonNullable<Parameters<typeof executeAiRun>[1]>['shadowModelTransport'];
  shadowModelRouteFactory?: ShadowModelRouteFactory;
} & AiRunScopeFilter;

export async function runAiWorkerOnce(options: RunAiWorkerOnceOptions = {}): Promise<boolean> {
  const env = parseEnv(process.env as Record<string, string | undefined>);
  const lane = env.AI_WORKER_LANE;
  const {
    shutdownSignal,
    hmsRecovery,
    readToolExecutor,
    mailBaselineExtractionRoute,
    mailBaselineExtractionRouteFactory,
    candidatePlanModel,
    candidateModelAdapter,
    candidateReplyModelAdapter,
    candidateDraftRouteFactory,
    candidateReplyAsks,
    shadowModelAdapter,
    shadowModelRoute,
    shadowModelTransport,
    shadowModelRouteFactory,
    ...scope
  } = options;
  // hms + off: drafting claims none. Read runs stay claimable without browser/model
  // initialization: all reads when the read service is on, else pane HMS jobs only (HMS_JOB_QUEUE=on).
  const hmsReadOnly = lane === 'hms' && env.HMS_DRAFT_ENRICHMENT_MODE === 'off';
  if (hmsReadOnly && !env.HMS_READ_SERVICE_ENABLED && !hmsJobQueueEnabled()) return false;
  const hmsJobsOnly = hmsReadOnly && !env.HMS_READ_SERVICE_ENABLED;
  maybeInitHmsRuntime(lane);
  // Eager singleton browser for HMS shadow (reuse across runs).
  if (lane === 'hms' && env.HMS_DRAFT_ENRICHMENT_MODE === 'shadow') {
    await getOrCreateProductionHmsRuntime();
  }
  const owner = aiWorkerOwnerId(lane);
  const claimScope = hmsReadOnly
    ? {
        ...scope,
        runKind: 'read_tool' as const,
        ...(hmsJobsOnly ? { promptVersion: HMS_JOB_PROMPT_VERSION } : {}),
      }
    : scope;
  // Lane hms also claims HMS reads (jobs-only and read-service modes), so it waits for the restart sweep first.
  if (lane === 'hms' && hmsRecovery && !(await hmsRecovery.mayClaim())) return false;
  const claimed = await claimNextAiRun({ ownerId: owner, lane, ...claimScope });
  if (!claimed) {
    // Jobs-only hms worker: no maintenance, as before this lane claimed jobs.
    if (hmsJobsOnly) return false;
    // Assessment and retention are private, bounded database lanes. They run
    // only after the claim check, so a normal queued prediction cannot be
    // hidden behind maintenance work; no route factory is initialized here.
    const purge = await purgeExpiredShadowDerivatives({ limit: 100 });
    const due = await assessDueShadowPredictions({ limit: 100 });
    return purge.deletedPredictions > 0 || purge.deletedAdmissions > 0 || due.processed > 0;
  }
  // A stale run admitted under a policy that has since been unset is fenced
  // through executeAiRun's policy-block path without constructing any route
  // factory or model transport.
  if (claimed.runKind === 'shadow_prediction' && !resolveShadowAdmissionPolicy()) {
    await executeAiRun(claimed.id, { shutdownSignal });
    return true;
  }
  const queuedMailSourceDecision =
    claimed.metrics && typeof claimed.metrics === 'object'
      ? (claimed.metrics as Record<string, unknown>).mailSourceDecision
      : undefined;
  if (
    claimed.runKind === 'inbound_triage' &&
    isMailSourceClassification(queuedMailSourceDecision) &&
    queuedMailSourceDecision.kind !== 'direct'
  ) {
    // Deterministic channel/system routing needs no model routes or cache warming.
    await executeAiRun(claimed.id, { shutdownSignal });
    return true;
  }
  const composedMailBaselineExtractionRoute =
    mailBaselineExtractionRoute ??
    mailBaselineExtractionRouteFactory?.() ??
    createProductionMailBaselineExtractionRouteFactory()();
  const composedShadowModelRoute =
    shadowModelRouteFactory?.() ?? createProductionShadowModelRouteFactory()();
  const executed = await executeAiRun(claimed.id, {
    shutdownSignal,
    readToolExecutor,
    mailBaselineExtractionRoute: composedMailBaselineExtractionRoute,
    candidatePlanModel,
    candidateModelAdapter,
    candidateReplyModelAdapter,
    candidateDraftRouteFactory:
      candidateDraftRouteFactory ??
      (claimed.runKind === 'candidate_draft'
        ? createProductionDraftModelRouteFactory()
        : undefined),
    candidateReplyAsks,
    shadowModelAdapter,
    shadowModelRoute: shadowModelRoute ?? composedShadowModelRoute?.route,
    shadowModelTransport: shadowModelTransport ?? composedShadowModelRoute?.transport,
    // HMS lane: live factory only — never createMockCandidateSession.
    ...(lane === 'hms' ? { candidateSessionFactory: createLiveHmsCandidateSessionFactory() } : {}),
  });
  // The live triage warmer follows the classifier run, or the extraction run once the classifier is retired.
  const inboundTriggerKind = isInboundTriageClassifierEnabled(process.env)
    ? 'inbound_triage'
    : 'inbound_extraction';
  if (executed.state === 'succeeded' && claimed.runKind === inboundTriggerKind) {
    // Fire-and-forget after the commit, never inside the admission
    // transaction. Off unless LUNA_ANALYSE_WARMER=on (see quote-workflow-warmer.ts).
    scheduleInboundTriageAnalyseWarm(claimed);
  }
  return true;
}

/**
 * Pane HMS job claimer, run by the default ai-worker when HMS_JOB_QUEUE=on. It claims only hms-lane read_tool runs of
 * the pane job kind (hms-job/1: pane finds, guest searches and prefetch), never drafting, read-service reads or writes.
 * Each job takes the property lock, and HMS_LANE_PAUSED=1 stops every claim (claimNextAiRun). The removed
 * hms-ai-worker (shadow drafting) is not needed for this and stays removed.
 */
export async function runHmsJobOnce(
  options: {
    shutdownSignal?: AbortSignal;
    db?: DB;
    /** Claims wait until the restart sweep has succeeded; the loop passes its gate. */
    recovery?: HmsRecoveryGate;
    /** Test seam. Production runs the claimed job through executeAiRun. */
    execute?: (runId: string) => Promise<unknown>;
  } = {},
): Promise<boolean> {
  if (!hmsJobQueueEnabled()) return false;
  if (options.recovery && !(await options.recovery.mayClaim())) return false;
  const claimed = await claimNextAiRun({
    ownerId: aiWorkerOwnerId('hms'),
    lane: 'hms',
    runKind: 'read_tool',
    promptVersion: HMS_JOB_PROMPT_VERSION,
    ...(options.db ? { db: options.db } : {}),
  });
  if (!claimed) return false;
  const execute =
    options.execute ?? ((runId: string) => executeAiRun(runId, { shutdownSignal: options.shutdownSignal }));
  await execute(claimed.id);
  return true;
}

const HMS_JOB_POLL_MS = 3_000;
const HMS_WRITE_SWEEP_MS = 5_000;

/** Turns hms_write leases lost to a dead worker into needs-check. Runs in the default worker, whatever the HMS flags. */
async function runHmsWriteSweepLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await sweepLostHmsWriteLeases().catch((error: unknown) => {
      console.error('hms_write_sweep_failed', error instanceof Error ? error.message : String(error));
      return 0;
    });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, HMS_WRITE_SWEEP_MS);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/** Claims pane HMS jobs one at a time until the signal aborts. Runs alongside the default loop, so triage never waits on HMS. */
async function runHmsJobLoop(signal: AbortSignal, recovery: HmsRecoveryGate): Promise<void> {
  while (!signal.aborted) {
    const worked = await runHmsJobOnce({ shutdownSignal: signal, recovery }).catch((error: unknown) => {
      console.error('hms_job_loop_failed', error instanceof Error ? error.message : String(error));
      return false;
    });
    if (!worked && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, HMS_JOB_POLL_MS));
  }
}

export async function runAiWorkerDrain(
  input: RunAiWorkerDrainInput,
): Promise<RunAiWorkerDrainResult> {
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const scope: AiRunScopeFilter = {
    transportId: input.transportId,
    runKind: input.runKind,
    promptVersion: input.promptVersion,
    idempotencyPrefix: input.idempotencyPrefix,
  };
  const mailBaselineExtractionRouteFactory =
    input.mailBaselineExtractionRouteFactory ??
    createProductionMailBaselineExtractionRouteFactory();
  const shadowModelRouteFactory =
    input.shadowModelRouteFactory ?? createProductionShadowModelRouteFactory();
  const deadline = Date.now() + input.timeoutMs;
  let processed = 0;

  while (true) {
    const remaining = await countNonterminalAiRuns(scope);
    if (remaining === 0) {
      return { ok: true, reason: 'drained', remainingNonterminal: 0, processed };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: 'timeout',
        remainingNonterminal: remaining,
        processed,
      };
    }

    const worked = await runAiWorkerOnce({
      ...scope,
      mailBaselineExtractionRouteFactory,
      shadowModelAdapter: input.shadowModelAdapter,
      shadowModelRoute: input.shadowModelRoute,
      shadowModelTransport: input.shadowModelTransport,
      shadowModelRouteFactory,
    });
    if (worked) {
      processed += 1;
      continue;
    }
    // No due claim — wait for retry-wait nextRunAt or timeout.
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (sleepMs <= 0) {
      const still = await countNonterminalAiRuns(scope);
      return {
        ok: still === 0,
        reason: still === 0 ? 'drained' : 'timeout',
        remainingNonterminal: still,
        processed,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

async function closeAiWorkerResources(): Promise<void> {
  let closeError: unknown;
  try {
    await closeProductionHmsRuntimeForTests();
  } catch (error) {
    closeError = error;
  }
  try {
    await closeDb();
  } catch (error) {
    closeError ??= error;
  }
  if (closeError) throw closeError;
}

export async function runAiWorkerLoop(
  pollIntervalMs = 5_000,
  scope: AiRunScopeFilter = {},
  mailBaselineExtractionRouteFactory: MailBaselineExtractionRouteFactory = createProductionMailBaselineExtractionRouteFactory(),
): Promise<void> {
  let stopping = false;
  const shutdown = new AbortController();
  const stop = () => {
    stopping = true;
    shutdown.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // Restart sweep for HMS reads: the first tick runs it, and no lane-hms claim happens until it succeeds.
  const hmsRecovery = createHmsRecoveryGate({ ownerId: aiWorkerOwnerId('hms') });
  // HMS_JOB_QUEUE=on: the default worker also claims pane HMS jobs. Scoped (proof) loops never do.
  const hmsJobs =
    resolveWorkerLane() === 'default' && hmsJobQueueEnabled() && !scope.idempotencyPrefix
      ? runHmsJobLoop(shutdown.signal, hmsRecovery)
      : null;
  // Lost hms_write leases become needs-check here, whatever the HMS flags. Scoped (proof) loops never run it.
  const hmsWriteSweep =
    resolveWorkerLane() === 'default' && !scope.idempotencyPrefix
      ? runHmsWriteSweepLoop(shutdown.signal)
      : null;

  try {
    while (!stopping) {
      const worked = await runAiWorkerOnce({
        ...scope,
        shutdownSignal: shutdown.signal,
        hmsRecovery,
        mailBaselineExtractionRouteFactory,
      });
      if (!worked) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    // Let a running HMS job settle its run row before the database closes.
    shutdown.abort();
    await hmsJobs;
    await hmsWriteSweep;
    await closeAiWorkerResources();
  }
}

async function main() {
  const env = parseEnv(process.env as Record<string, string | undefined>);
  maybeInitHmsRuntime(env.AI_WORKER_LANE);
  const args = parseAiWorkerCliArgs(process.argv.slice(2));
  const mailBaselineExtractionRouteFactory = createProductionMailBaselineExtractionRouteFactory();
  const scoped =
    args.drainPrefix !== undefined ||
    args.transportId !== undefined ||
    args.promptVersion !== undefined ||
    args.timeoutMs !== undefined;

  if (scoped) {
    if (args.timeoutMs === undefined) {
      throw new Error('scoped drain requires --timeout-ms');
    }
    let result: RunAiWorkerDrainResult;
    try {
      result = await runAiWorkerDrain({
        ...scopeFromCli(args),
        timeoutMs: args.timeoutMs,
        mailBaselineExtractionRouteFactory,
      });
    } finally {
      await closeAiWorkerResources();
    }
    if (!result.ok) {
      console.error(
        JSON.stringify({
          ok: false,
          reason: result.reason,
          remainingNonterminal: result.remainingNonterminal,
          processed: result.processed,
        }),
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify({
        ok: true,
        reason: result.reason,
        remainingNonterminal: 0,
        processed: result.processed,
      }),
    );
    return;
  }

  // Proof isolation: ops-hms-shadow start sets AI_WORKER_IDEMPOTENCY_PREFIX. The HMS restart sweep runs inside the
  // loop (createHmsRecoveryGate), so a failed sweep never stops the worker from starting.
  const idempotencyPrefix = process.env.AI_WORKER_IDEMPOTENCY_PREFIX?.trim();
  await runAiWorkerLoop(
    5_000,
    idempotencyPrefix ? { idempotencyPrefix } : {},
    mailBaselineExtractionRouteFactory,
  );
}

if (isCliEntry(import.meta.url, 'ai-worker')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
