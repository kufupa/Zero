/**
 * Private, queue-free connected-case runner for deterministic HMS reads.
 *
 * This script is intentionally not an application worker and has no database
 * dependency.  It accepts only a paired incoming-message packet, derives
 * exact lookup candidates from that body, and invokes the canonical typed
 * Guest Stay driver.  With HMS_CONNECTED_ALL_TOOLS=1 it also dispatches every
 * included tool branch and records typed unavailable/input-missing outcomes.
 * It never accepts a caller-supplied PMS ID, URL, selector or expected answer.
 * Output is a redacted digest suitable for the private read-tool ledger.
 *
 * Required env:
 *   HMS_DISCOVERY_ALLOW_LIVE=1
 *   HMS_READ_SECRET_ARN
 *   HMS_CONNECTED_CASE_PATH (private JSON packet), or
 *   HMS_CONNECTED_SEQUENCE_CASE_PATHS (JSON array of exactly 3 private paths)
 *   HMS_CONNECTED_PROOF_BINDING_PATH (private proof-binding sidecar)
 * Optional:
 *   HMS_CHROMIUM_EXECUTABLE_PATH, HMS_CONNECTED_OUT, HMS_CONNECTED_REPEAT,
 *   HMS_CONNECTED_ALL_TOOLS, HMS_CONNECTED_NOTES_VARIANTS=1,
 *   HMS_CONNECTED_FOLIO_VARIANTS=1
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  createHmsRuntime,
  createPlaywrightBrowserFactory,
  hmsSecretSchema,
  type HmsSecret,
} from '../../../../../apps/server-pilot/src/hms/runtime.js';
import {
  buildExactOsressSearchThenDetailManifest,
  buildLiveGuestStayChromeGetRules,
  buildLiveHmsAuthenticationRules,
  buildLiveGuestStayReadManifest,
  buildLiveFolioReadManifest,
  buildLiveSentEmailListManifest,
  type ReservationSearchCandidate,
} from '../../../../../apps/server-pilot/src/hms/live-read-manifest.js';
import { requestPolicyManifestSchema } from '../../../../../apps/server-pilot/src/hms/contracts.js';
import { buildBoundFolioReadFields } from '../../../../../apps/server-pilot/src/hms/folio-read-facade.js';
import {
  buildBoundFolioAllDataRule,
  buildBoundFolioAllGridRule,
  buildFolioCacheReadRule,
} from '../src/hms/folio-manifest.js';
import { createConnectedNotesSourcePair } from '../src/hms/connected-notes-source-pair.js';
import { buildNotesInquiryReadRule, buildBoundNotesTracesReadRule } from '../src/hms/notes-traces-manifest.js';
import { createLiveGuestStayDriver } from '../../../../../apps/server-pilot/src/hms/live-guest-stay-driver.js';
import { createLiveReservationContextDriver } from '../../../../../apps/server-pilot/src/hms/live-reservation-context-driver.js';
import { createReservationContextFacade } from '../../../../../apps/server-pilot/src/hms/reservation-context-facade.js';
import { createLiveFolioReadDriver } from '../../../../../apps/server-pilot/src/hms/live-folio-read-driver.js';
import { observeNotesTraces } from '../../../../../apps/server-pilot/src/hms/live-notes-traces-read-driver.js';
import {
  runConnectedNotesVariants,
  type ConnectedNotesVariant,
} from '../src/hms/connected-notes-variants.js';
import {
  runConnectedFolioPagingVariant,
  type ConnectedFolioPagingVariant,
} from '../src/hms/connected-folio-variants.js';
import {
  createLiveSentEmailObserver,
  toSentEmailAudit,
} from '../../../../../apps/server-pilot/src/hms/live-sent-email-observer.js';
import { createAgentReadTools } from '../../../../../apps/server-pilot/src/hms/agent-read-tools.js';
import {
  executeReadToolRun,
  type ReadExecutionContext,
  type ReadRequest,
} from '../../../../../apps/server-pilot/src/hms/read-service.js';
import { selectConnectedProbeTools } from '../src/hms/connected-tool-selection.js';
import {
  extractLookupCandidates,
  filterExactReservationCandidates,
  selectConnectedLookupCandidate,
  type LookupCandidate,
} from '../../../../../apps/server-pilot/src/ai/thread-context.js';
import type { ReservationDetailDumpV1 } from '../../../../../apps/server-pilot/src/hms/reservation-detail-projection.js';
import { readRefSchema, readResultSchema } from '../../../../../apps/server-pilot/src/hms/read-service-contracts.js';
import { parseEventReadCandidateFromAuthoredSegment } from '../../../../../apps/server-pilot/src/hms/event-read-candidate.js';
import { parseGroupReadCandidateFromAuthoredSegment } from '../../../../../apps/server-pilot/src/hms/group-read-candidate.js';
import { parseQuoteStayCandidateFromAuthoredSegment } from '../../../../../apps/server-pilot/src/hms/quote-stay-candidate.js';
import { sha256Hex } from '../../../../../apps/server-pilot/src/hms/release-kernel.js';
import type { HmsSessionAuthorization } from '../../../../../apps/server-pilot/src/hms/release-kernel.js';
import { buildHmsFindSessionAuthorization, buildHmsFolioSessionAuthorization } from '../../../../../apps/server-pilot/src/hms/active-read-runtime.js';
import { readCandidateChildSchema } from '../../../../../apps/server-pilot/src/hms/candidate-graph.js';
import {
  connectedCasePairedReplyMessageIdSha256Input,
  connectedCaseSchema,
  connectedCaseTriggerMessageId,
  type ConnectedCase,
} from '../src/hms/connected-case-contract.js';
import {
  buildConnectedSequenceSummary,
  connectedSequenceIdentityPassed,
  hashConnectedMatchedIdentity,
  parseConnectedSequenceCasePaths,
  type ConnectedSequenceCaseResult,
} from '../src/hms/connected-sequence.js';
import {
  bindConnectedRunnerParent,
  connectedRunnerParentEvidenceId,
  isConnectedRunnerParentBound,
  type ConnectedRunnerParentBinding,
} from '../src/hms/connected-runner-binding.js';
import {
  assertConnectedBundleSourceFingerprint,
  assertConnectedRuntimeFingerprint,
  assertConnectedSecretBinding,
  loadConnectedProofBinding,
  loadConnectedRoleProof,
  validateConnectedSessionAuthorization,
  type ConnectedProofBindingSidecar,
} from '../src/hms/connected-proof-binding.js';
import { connectedCallTiming } from '../src/hms/connected-call-timing.js';
import { connectedRunDeadlineMs } from '../src/hms/connected-run-budget.js';

type HmsRuntime = ReturnType<typeof createHmsRuntime>;

type RunCaseInput = {
  runtime: HmsRuntime | null;
  secret: HmsSecret | null;
  proofBinding?: ConnectedProofBindingSidecar;
  connectedCase: ConnectedCase;
  requestedToolIds: string[];
  outputPath: string;
  quiet: boolean;
};

function candidateValue(candidate: LookupCandidate): string {
  return candidate.kind === 'surname_dates'
    ? `${candidate.surname}|${candidate.arrivalDate}|${candidate.departureDate}`
    : candidate.value;
}

function redactCandidate(candidate: LookupCandidate): {
  kind: LookupCandidate['kind'];
  valueTail: string;
  valueSha256: string;
  candidateId: string;
} {
  const value = candidateValue(candidate);
  return {
    kind: candidate.kind,
    valueTail: candidate.kind === 'surname_dates' ? 'dates' : value.slice(-4),
    valueSha256: sha256Hex(value),
    candidateId: candidate.id,
  };
}

type StandaloneAuthInput = {
  operationId: string;
  origin: string;
  candidate: ReservationSearchCandidate;
  proofBinding: ConnectedProofBindingSidecar;
  surface?: 'find' | 'notes';
};

type StandaloneNotesAuthorization = Omit<
  HmsSessionAuthorization,
  'toolId' | 'discoveryOperationId' | 'requestBranchId'
> & {
  toolId: 'hms_read_notes_traces';
  discoveryOperationId: 'notes_traces_list';
  requestBranchId: 'notes_traces_list';
};

function standaloneAuth(
  input: Omit<StandaloneAuthInput, 'surface'> & { surface?: 'find' },
): HmsSessionAuthorization;
function standaloneAuth(
  input: StandaloneAuthInput & { surface: 'notes' },
): StandaloneNotesAuthorization;
function standaloneAuth(
  input: StandaloneAuthInput,
): HmsSessionAuthorization | StandaloneNotesAuthorization {
  // The same guarded context performs find then an inert reservation-detail
  // read when a unique row is found; authorize both reviewed read surfaces up
  // front rather than falling back to a shell-only HDR rule mid-session.
  const manifest = buildExactOsressSearchThenDetailManifest(input.origin, input.candidate);
  const entry =
    input.surface === 'notes'
      ? input.proofBinding.notes ?? input.proofBinding.find
      : input.proofBinding.find;
  const release = entry.release?.evidenceKind === 'hms' ? entry.release : null;
  const findAuthorization = buildHmsFindSessionAuthorization({
    operationId: input.operationId,
    requestBranchId: 'guest_stay_search',
    manifest,
    roleProofPath: entry.roleProofPath,
    roleProofSha256: entry.roleProofSha256,
    credentialVersionHmacSha256: input.proofBinding.credentialVersionHmacSha256,
    runtimeFingerprintSha256: input.proofBinding.runtimeFingerprintSha256,
    privateDigestKeyVersion: input.proofBinding.privateDigestKeyVersion,
    sourceRevision: input.proofBinding.sourceRevision,
    prePromotionBindingId: input.proofBinding.bindingId,
    release,
  });
  const authorization = findAuthorization;
  if (input.surface !== 'notes') return authorization;
  return {
    ...authorization,
    toolId: 'hms_read_notes_traces' as const,
    discoveryOperationId: 'notes_traces_list' as const,
    requestBranchId: 'notes_traces_list',
  };
}

type LoadedStandaloneSecret = {
  secret: HmsSecret;
  version: {
    versionId: string;
    versionStages: readonly string[];
  };
};

async function loadSecret(arn: string): Promise<LoadedStandaloneSecret> {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'af-south-1' });
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error('HMS secret is empty');
  const versionId = result.VersionId?.trim();
  const versionStages = result.VersionStages ?? [];
  if (!versionId || !versionStages.includes('AWSCURRENT')) {
    throw new Error('HMS secret VersionId/AWSCURRENT metadata required');
  }
  return {
    secret: hmsSecretSchema.parse(JSON.parse(result.SecretString)),
    version: { versionId, versionStages },
  };
}

function standaloneErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code.slice(0, 80) : undefined;
}

/** Diagnostics only; never retain credentials, tokens, addresses, URLs or payloads. */
function standaloneErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message.trim();
  if (!message || /password|secret|arn:aws|cookie|authorization|token|bearer|https?:\/\//i.test(message)) {
    return message ? 'redacted_error' : undefined;
  }
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-address]')
    .replace(/\b\d{6,}\b/g, '[redacted-number]')
    .slice(0, 160);
}

function toSearchCandidate(candidate: LookupCandidate): ReservationSearchCandidate {
  if (candidate.kind === 'surname_dates') {
    return {
      id: candidate.id,
      kind: candidate.kind,
      surname: candidate.surname,
      arrivalDate: candidate.arrivalDate,
      departureDate: candidate.departureDate,
    };
  }
  return { id: candidate.id, kind: candidate.kind, value: candidate.value };
}

/**
 * Keep direct-read parsing on the sender-authored part of the supplied body.
 * A quoted history block is useful context for Luna, but must not silently
 * become a new PMS identity/ref for a connected acceptance call.
 */
function authoredSegment(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line) && !/^\s*(from|sent|to|subject):/i.test(line))
    .join('\n')
    .trim();
}

async function runCase(input: RunCaseInput): Promise<ConnectedSequenceCaseResult> {
  const {
    runtime,
    secret,
    proofBinding,
    connectedCase,
    requestedToolIds,
    outputPath,
    quiet,
  } = input;
  const triggerMessageId = connectedCaseTriggerMessageId(connectedCase);
  const pairedReplyMessageId = connectedCasePairedReplyMessageIdSha256Input(connectedCase);
  const shouldProbe = (toolId: string) => requestedToolIds.some((requested) => requested === toolId);
  const extracted = extractLookupCandidates(connectedCase.incoming.body);
  const selected = selectConnectedLookupCandidate(extracted);
  const authored = authoredSegment(connectedCase.incoming.body);
  const bodyScopeRef = `body:${sha256Hex(connectedCase.incoming.body)}`;
  const groupCandidate = parseGroupReadCandidateFromAuthoredSegment(authored);
  const eventCandidate = parseEventReadCandidateFromAuthoredSegment(authored);
  const quoteCandidate = parseQuoteStayCandidateFromAuthoredSegment(authored);
  const base = {
    schemaVersion: 'standalone-connected-read/v1',
    caseId: connectedCase.caseId,
    propertyCode: connectedCase.propertyCode,
    incomingBodySha256: sha256Hex(connectedCase.incoming.body),
    pairedReplyMessageIdSha256: pairedReplyMessageId ? sha256Hex(pairedReplyMessageId) : null,
    incomingMessageIdSha256: connectedCase.incoming.messageId
      ? sha256Hex(connectedCase.incoming.messageId)
      : null,
    // A legacy packet may only carry paired-reply metadata; label that
    // fallback explicitly so it cannot be mistaken for incoming provenance.
    triggerSource: connectedCase.incoming.messageId ? 'incoming' : 'paired_reply',
    incomingSenderSha256: sha256Hex(connectedCase.incoming.sender),
    incomingSubjectSha256: sha256Hex(connectedCase.incoming.subject),
    incomingTimestampSha256: sha256Hex(connectedCase.incoming.timestamp),
    extractedCandidateCount: extracted.length,
    extractedCandidates: extracted.map(redactCandidate),
      selectedCandidate: selected ? redactCandidate(selected) : null,
      directCandidates: {
        quote: quoteCandidate ? { id: quoteCandidate.id, source: 'incoming_body' } : null,
        group: groupCandidate
          ? { id: groupCandidate.id, source: 'incoming_body' }
          : null,
        event: eventCandidate ? { id: eventCandidate.id, source: 'incoming_body' } : null,
      },
    source: 'connected_incoming_body_only',
    goldAnswerUsed: false,
    manualIdUsed: false,
    fallbackRecordUsed: false,
  };

  if (!selected) {
    const output = {
      ...base,
      status: 'manual_required',
      reason:
        extracted.length === 0 ||
        (filterExactReservationCandidates(extracted).length === 0 &&
          !extracted.some((candidate) => candidate.kind === 'surname_dates'))
          ? 'INPUT_MISSING'
          : 'AMBIGUOUS_IDENTITY',
      calls: [],
      runtimeStats: null,
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(output, null, 2), { mode: 0o600 });
    if (!quiet) {
      console.log(JSON.stringify({ phase: 'done', status: output.status, reason: output.reason, out: outputPath }));
    }
    return {
      caseId: connectedCase.caseId,
      outputPath,
      status: output.status,
      runnerStatus: output.status,
      actualMatchedIdentitySha256: null,
    };
  }

  if (!runtime || !secret || !proofBinding) {
    throw new Error('selected connected case requires shared runtime, secret, and proof binding');
  }
  const origin = new URL(secret.loginUrl).origin;
  const allTools = requestedToolIds.length > 2;
  const notesVariantsEnabled = process.env.HMS_CONNECTED_NOTES_VARIANTS === '1';
  const folioVariantsEnabled = process.env.HMS_CONNECTED_FOLIO_VARIANTS === '1';
  // Baseline remains two minutes. Opt-in variant probes get eight minutes;
  // each source reader keeps its own byte/time bound and creates fresh
  // per-read authorization/child TTLs, so this does not extend a provider
  // reference or evidence lifetime.
  const signal = AbortSignal.timeout(
    connectedRunDeadlineMs({
      allTools,
      notesVariants: notesVariantsEnabled,
      folioVariants: folioVariantsEnabled,
    }),
  );
  const operationId = `standalone-${randomUUID()}`;
  const candidate = toSearchCandidate(selected);
  const driver = createLiveGuestStayDriver({
    runtime,
    transportId: secret.mailboxTransportId,
    sessionAuthorizationFor: () =>
      standaloneAuth({ operationId, origin, candidate, proofBinding }),
  });

  const emptyParentBinding = (): ConnectedRunnerParentBinding =>
    bindConnectedRunnerParent({
      reservationRef: null,
      detailResult: null,
      detailDump: null,
      reservationStayId: null,
      parentEvidenceId: null,
    });
  let latestParentBinding = emptyParentBinding();
  let pendingDetailDump: ReservationDetailDumpV1 | null = null;
  let pendingReservationStayId: string | null = null;
  let folioFallbackState: {
    attempted: boolean;
    outcome: string;
    errorCode?: string;
    errorMessage?: string;
    blocker?: string;
    rowsScanned?: number;
    bytesObserved?: number;
  } = {
    attempted: false,
    outcome: 'not_attempted',
  };
  let sentEmailState: {
    attempted: boolean;
    outcome: string;
    errorCode?: string;
    errorMessage?: string;
    rowsScanned?: number;
    bytesObserved?: number;
    durationMs?: number;
  } = {
    attempted: false,
    outcome: 'not_attempted',
  };
  const folioManifest = buildLiveFolioReadManifest(origin);
  const sentEmailManifest = buildLiveSentEmailListManifest(origin);
  const reservationDriver = createLiveReservationContextDriver({
    guestStay: driver,
    candidateFor: () => candidate,
    detailDumpFor: async (_input, _row) => {
      const detail = await driver.searchExactThenDetailDump(candidate, signal);
      pendingDetailDump = detail.dump;
      pendingReservationStayId = detail.reservationStayId ?? null;
      return detail.dump;
    },
  });
  const facade = createReservationContextFacade({
    now: () => new Date(),
    lookup: (input) => reservationDriver.findReservation(input, signal),
    readContext: reservationDriver.readContext,
  });
  const context: ReadExecutionContext = {
    transportId: secret.mailboxTransportId,
    mailboxId: 'standalone-mailbox',
    threadId: connectedCase.caseId,
    triggerMessageId,
    propertyCode: connectedCase.propertyCode,
    parentRef: `case:${connectedCase.caseId}`,
    branchId: 'guest_stay_search',
    releaseId: 'standalone-connected-read-v1',
    requester: {
      authorizationId: `standalone-auth:${connectedCase.caseId}`,
      transportId: secret.mailboxTransportId,
      threadId: connectedCase.caseId,
      triggerMessageId,
      allowedClaimKinds: [
        'reservation_summary',
        'folio_deposit_summary',
        'quote_stay_summary',
        'company_billing_summary',
        'group_status',
        'event_status',
        'notes_trace_observation',
        'document_metadata',
        'sent_email_audit',
        'document_bytes',
      ],
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    },
    signal,
    budget: { total: 0, limit: allTools ? 64 : 6 },
    now: () => new Date(),
    // Leave findReservation unset so read-service uses this same facade for
    // both find and follow-up detail; that preserves its in-process binding.
    // Balance and notes are projected only from the actual detail dump already
    // obtained by the preceding reservation read. Sent-email audit is the one
    // additional live provider attempted here: it binds to the incoming
    // sender and confirmation returned by that same find/detail chain.
    handlers: {
      readFolio: async ({ reservationRef, sections, limit, cursor }) => {
        const boundParent = latestParentBinding;
        const unavailable = (reasonCode: 'SCOPE_DENIED' | 'SOURCE_UNAVAILABLE') =>
          readResultSchema.parse({
            toolId: 'hms_read_folio',
            schemaVersion: 'hms-folio/1',
            status: 'manual_required',
            data: null,
            completeness: 'unknown',
            unavailableSections: sections.map((section) => ({ section, reasonCode })),
            scopeRef: readRefSchema.parse(reservationRef),
            evidence: [],
            page: null,
            issues: [{ code: reasonCode, retryable: false, safeNextAction: 'manual_review' }],
          });
        if (
          !isConnectedRunnerParentBound(boundParent, reservationRef) ||
          !boundParent.detailDump?.values
        ) return unavailable('SCOPE_DENIED');
        folioFallbackState = { attempted: true, outcome: 'started' };
        try {
          const boundFolioFields = buildBoundFolioReadFields({
            confirmationNumber: boundParent.confirmationToken!,
            reservationStayId: boundParent.reservationStayId!,
            expectedPropertyCode: connectedCase.propertyCode,
            detailValues: boundParent.detailDump.values,
          });
          const boundFolioRuleInput = {
            origin,
            confirmationNumber: boundParent.confirmationToken!,
            reservationStayId: boundParent.reservationStayId!,
            expectedPropertyCode: connectedCase.propertyCode,
            detailValues: boundParent.detailDump.values,
          };
          const folioTemplate = folioManifest.rules.find((rule) => rule.id === 'live-folio-osresv-fol');
          if (!folioTemplate) throw new Error('FOLIO_TEMPLATE_REQUIRED');
          const boundManifest = requestPolicyManifestSchema.parse({
            rules: [
              ...buildLiveGuestStayChromeGetRules(origin),
              ...buildLiveHmsAuthenticationRules(origin),
              { ...folioTemplate, fixedBody: boundFolioFields, variableBody: {} },
              // All Folios header/data and only the three captured cache
              // continuations are part of this exact parent fingerprint.
              buildBoundFolioAllGridRule(boundFolioRuleInput),
              buildBoundFolioAllDataRule(boundFolioRuleInput),
              ...[51, 101, 151].map((cursorPosition) =>
                buildFolioCacheReadRule({ origin, cursorPosition }),
              ),
            ],
          });
          const folioProof = proofBinding.folio;
          if (!folioProof) throw new Error('CONNECTED_FOLIO_PROOF_REQUIRED');
          const folioRelease = folioProof.release?.evidenceKind === 'hms'
            ? folioProof.release
            : null;
          const authorization = buildHmsFolioSessionAuthorization({
            operationId,
            requestBranchId: 'folio_summary',
            manifest: boundManifest,
            roleProofPath: folioProof.roleProofPath,
            roleProofSha256: folioProof.roleProofSha256,
            credentialVersionHmacSha256: proofBinding.credentialVersionHmacSha256,
            runtimeFingerprintSha256: proofBinding.runtimeFingerprintSha256,
            privateDigestKeyVersion: proofBinding.privateDigestKeyVersion,
            sourceRevision: proofBinding.sourceRevision,
            prePromotionBindingId: proofBinding.bindingId,
            release: folioRelease,
          });
          const boundAuthorization = authorization;
          const child = readCandidateChildSchema.parse({
            id: randomUUID(),
            sessionId: randomUUID(),
            parentEvidenceId: boundParent.parentEvidenceId!,
            toolId: 'hms_read_folio',
            requestBranchId: 'folio_summary',
            propertyCode: connectedCase.propertyCode,
            scopeHash: sha256Hex(reservationRef),
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          });
          const liveDriver = createLiveFolioReadDriver({
            runtime,
            transportId: secret.mailboxTransportId,
            expectedConfirmationToken: boundParent.confirmationToken!,
            reservationStayId: boundParent.reservationStayId!,
            expectedPropertyCode: connectedCase.propertyCode,
            detailDumpFor: async () => boundParent.detailDump,
          });
          // All requested sections run through the actual bound source. No
          // balance-only shortcut, guessed record, or alternate-client retry.
          const result = await liveDriver.observeBoundFolio(
            boundAuthorization,
            child,
            sections,
            signal,
            undefined,
            { limit, cursor },
          );
          folioFallbackState = {
            attempted: true,
            outcome: result.status,
            rowsScanned: result.data?.rowsScanned,
            bytesObserved: result.data?.bytesObserved,
          };
          return readResultSchema.parse({ ...result, scopeRef: readRefSchema.parse(reservationRef) });
        } catch (error) {
          folioFallbackState = {
            attempted: true,
            outcome: 'error',
            errorCode: standaloneErrorCode(error),
            errorMessage: standaloneErrorMessage(error),
          };
          return unavailable('SOURCE_UNAVAILABLE');
        }
      },
      readNotesTraces: async ({ resourceRef, states, limit, cursor, audience }) => {
        const boundParent = latestParentBinding;
        const baseNotesAuthorization = standaloneAuth({
          operationId,
          origin,
          candidate,
          proofBinding,
          surface: 'notes',
        });
        if (
          !isConnectedRunnerParentBound(boundParent, resourceRef) ||
          !boundParent.detailDump?.values
        ) {
          return observeNotesTraces(
            baseNotesAuthorization,
            {
              resourceRef,
              states: states as ('open' | 'completed')[],
              limit,
              cursor,
              audience,
            },
            signal,
            { detailDumpFor: async () => null },
          );
        }

        // Validate every reviewed HDR/FOL binding field before opening a new
        // session. No caller-supplied PMS id or fallback record can reach JSON.
        buildBoundFolioReadFields({
          confirmationNumber: boundParent.confirmationToken!,
          reservationStayId: boundParent.reservationStayId!,
          expectedPropertyCode: connectedCase.propertyCode,
          detailValues: boundParent.detailDump.values,
        });
        const notesManifest = requestPolicyManifestSchema.parse({
          rules: [
            ...buildLiveGuestStayChromeGetRules(origin),
            ...buildLiveHmsAuthenticationRules(origin),
            buildNotesInquiryReadRule(origin, boundParent.confirmationToken!),
            buildBoundNotesTracesReadRule({
              origin,
              confirmationNumber: boundParent.confirmationToken!,
              reservationStayId: boundParent.reservationStayId!,
              detailValues: boundParent.detailDump.values,
            }),
          ],
        });
        const notesAuthorization = {
          ...baseNotesAuthorization,
          toolId: 'hms_read_notes_traces' as const,
          discoveryOperationId: 'notes_traces_list' as const,
          requestBranchId: 'notes_traces_list',
          manifest: notesManifest,
          manifestSha256: sha256Hex(JSON.stringify(notesManifest)),
        };
        // Both source reads belong to this one tool invocation. Open one
        // fresh authenticated context, read JSON then TRC serially, and close
        // it once; the pair is recreated for every invocation/parent binding.
        const sourcePair = createConnectedNotesSourcePair({
          parentBinding: {
            propertyCode: connectedCase.propertyCode,
            confirmationNumber: boundParent.confirmationToken!,
            reservationStayId: boundParent.reservationStayId!,
            resourceRef: boundParent.reservationRef!,
          },
          detailValues: boundParent.detailDump.values,
          audience,
          openSession: (providerSignal) =>
            runtime.openReadSession({
              transportId: secret.mailboxTransportId,
              signal: providerSignal,
              allowUnstarted: true,
              sessionAuthorization: notesAuthorization,
            }),
        });
        return observeNotesTraces(
          notesAuthorization,
          {
            resourceRef,
            states: states as ('open' | 'completed')[],
            limit,
            cursor,
            audience,
          },
          signal,
          {
            expectedParentBinding: {
              propertyCode: connectedCase.propertyCode,
              confirmationNumber: boundParent.confirmationToken!,
              reservationStayId: boundParent.reservationStayId!,
              resourceRef: boundParent.reservationRef!,
            },
            notesTracesFor: async ({ resourceRef: requestedResourceRef }, providerSignal) => {
              try {
                return await sourcePair.notesTracesFor(
                  { resourceRef: requestedResourceRef },
                  providerSignal,
                );
              } catch (error) {
                if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
                  console.error(JSON.stringify({ type: 'HMS_PROOF_DIAGNOSTIC', stage: 'traces_provider', code: standaloneErrorCode(error) ?? 'UNKNOWN' }));
                }
                throw error;
              }
            },
            notesInquiryFor: async (
              { resourceRef: requestedResourceRef, audience: requestedAudience },
              providerSignal,
            ) => {
              try {
                return await sourcePair.notesInquiryFor(
                  { resourceRef: requestedResourceRef, audience: requestedAudience },
                  providerSignal,
                );
              } catch (error) {
                if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
                  console.error(JSON.stringify({ type: 'HMS_PROOF_DIAGNOSTIC', stage: 'notes_inquiry_provider', code: standaloneErrorCode(error) ?? 'UNKNOWN' }));
                }
                throw error;
              }
            },
          },
        );
      },
      readSentEmailAudit: async ({ candidateId }) => {
        const boundParent = latestParentBinding;
        const sourceRecipient = connectedCase.incoming.sender.trim();
        if (
          !sourceRecipient.includes('@') ||
          !isConnectedRunnerParentBound(boundParent, boundParent.reservationRef)
        ) {
          sentEmailState = { attempted: false, outcome: 'input_missing' };
          return readResultSchema.parse({
            toolId: 'hms_sent_email_audit',
            schemaVersion: 'hms-sent-email/1',
            status: 'manual_required',
            data: null,
            completeness: 'unknown',
            unavailableSections: [{ section: 'sent_email', reasonCode: 'INPUT_MISSING' }],
            scopeRef: readRefSchema.parse(candidateId),
            evidence: [],
            page: null,
            issues: [
              { code: 'INPUT_MISSING', retryable: false, safeNextAction: 'request_input' },
            ],
          });
        }

        sentEmailState = { attempted: true, outcome: 'started' };
        try {
          const sentProof = proofBinding.sent;
          if (!sentProof) throw new Error('CONNECTED_SENT_PROOF_REQUIRED');
          const sentRelease = sentProof.release?.evidenceKind === 'hms'
            ? sentProof.release
            : null;
          const authorization = {
            operationId,
            toolId: 'hms_sent_email_audit' as const,
            discoveryOperationId: 'sent_email_list' as const,
            releaseId: sentRelease?.releaseId ?? proofBinding.bindingId,
            requestBranchId: 'sent_email_audit',
            manifest: sentEmailManifest,
            manifestSha256: sha256Hex(JSON.stringify(sentEmailManifest)),
            roleProofPath: sentProof.roleProofPath,
            roleProofSha256: sentProof.roleProofSha256,
            credentialVersionHmacSha256: proofBinding.credentialVersionHmacSha256,
            runtimeFingerprintSha256: proofBinding.runtimeFingerprintSha256,
            privateDigestKeyVersion: proofBinding.privateDigestKeyVersion,
            sourceRevision: proofBinding.sourceRevision,
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          };
          const child = readCandidateChildSchema.parse({
            id: randomUUID(),
            sessionId: randomUUID(),
            parentEvidenceId: boundParent.parentEvidenceId!,
            toolId: 'hms_sent_email_audit',
            requestBranchId: 'sent_email_audit',
            propertyCode: connectedCase.propertyCode,
            scopeHash: sha256Hex(boundParent.confirmationToken!),
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          });
          const observer = createLiveSentEmailObserver({
            runtime,
            transportId: secret.mailboxTransportId,
            expectedRecipient: sourceRecipient,
            expectedAccountToken: boundParent.confirmationToken!,
            scopeClass: 'reservation',
          });
          const rows = await observer.observeSentEmailRows(authorization, child, signal);
          const audit = toSentEmailAudit(rows);
          sentEmailState = {
            attempted: true,
            outcome: audit.status,
            rowsScanned: rows.rowsScanned,
            bytesObserved: rows.bytesObserved,
            durationMs: rows.durationMs,
          };
          const reasonCode = audit.status === 'unverified_negative' ? 'UNVERIFIED_NEGATIVE' : 'SOURCE_UNAVAILABLE';
          const evidenceRef = readRefSchema.parse(audit.evidence.id);
          return readResultSchema.parse({
            toolId: 'hms_sent_email_audit',
            schemaVersion: 'hms-sent-email/1',
            status: audit.status === 'ok' ? 'ok' : audit.status === 'unverified_negative' ? 'unverified_negative' : 'manual_required',
            data: audit.status === 'manual_required' ? null : audit.data,
            completeness: audit.status === 'ok' ? 'complete' : 'unknown',
            unavailableSections: audit.status === 'ok' ? [] : [{ section: 'sent_email', reasonCode }],
            scopeRef: readRefSchema.parse(candidateId),
            evidence: [
              {
                evidenceRef,
                sourceSystem: 'hms',
                sourceSurface: 'pssnel-sent-email-list',
                requestBranchId: 'sent_email_audit',
                observedAt: audit.evidence.observedAt,
                sourceUpdatedAt: null,
                expiresAt: audit.evidence.expiresAt,
                scopeVerified: audit.status === 'ok',
                artifactRef: null,
                sourceHash: audit.evidence.sourceHash,
              },
            ],
            page: null,
            issues:
              audit.status === 'ok'
                ? []
                : [{ code: reasonCode, retryable: false, safeNextAction: audit.status === 'unverified_negative' ? 'manual_review' : 'manual_review' }],
          });
        } catch (error) {
          sentEmailState = {
            attempted: true,
            outcome: 'error',
            ...(standaloneErrorCode(error) ? { errorCode: standaloneErrorCode(error) } : {}),
            ...(standaloneErrorMessage(error)
              ? { errorMessage: standaloneErrorMessage(error) }
              : {}),
          };
          return readResultSchema.parse({
            toolId: 'hms_sent_email_audit',
            schemaVersion: 'hms-sent-email/1',
            status: 'manual_required',
            data: null,
            completeness: 'unknown',
            unavailableSections: [{ section: 'sent_email', reasonCode: 'SOURCE_UNAVAILABLE' }],
            scopeRef: readRefSchema.parse(candidateId),
            evidence: [],
            page: null,
            issues: [
              { code: 'SOURCE_UNAVAILABLE', retryable: false, safeNextAction: 'manual_review' },
            ],
          });
        }
      },
    },
    reservationFacade: facade,
    sourceRevision: proofBinding.sourceRevision,
  };

  const repeats = Math.max(1, Math.min(3, Number(process.env.HMS_CONNECTED_REPEAT ?? 1) || 1));
  const calls: Array<Record<string, unknown>> = [];
  let notesVariants: ConnectedNotesVariant[] | null = null;
  let folioVariants: ConnectedFolioPagingVariant | null = null;
  let detailInvoked = false;
  let actualMatchedIdentitySha256: string | null = null;
  // The tenant's COMMON request key is one-shot across contexts.  The
  // standalone owner therefore keeps login and the guarded proof page in
  // one runtime context; repeated tool calls remain serialized below.
  process.env.HMS_SINGLE_CONTEXT_LOGIN = '1';
  for (let index = 0; index < repeats; index += 1) {
      // Each find starts a new proof window. Never let a previous positive
      // match authorize follow-up reads after this iteration misses or fails.
      latestParentBinding = emptyParentBinding();
      pendingDetailDump = null;
      pendingReservationStayId = null;
      detailInvoked = false;
      const findStartedAt = Date.now();
      const findRun = await executeReadToolRun({
        runKind: 'read_tool',
        executorLane: 'hms',
        draftingEnabled: false,
        request: { toolId: 'hms_find_reservation', candidateId: candidate.id },
        context,
        resultRef: `read-find-${randomUUID()}`,
      });
      const result = findRun.result;
      const matches =
        result.data && typeof result.data === 'object' && 'matches' in result.data
          ? (result.data as { matches?: Array<{ reservationRef?: string | null }> }).matches ?? []
          : [];
      const exactFindCompleted =
        result.status === 'ok' && result.completeness === 'complete' && matches.length === 1;
      calls.push({
        index: index + 1,
        toolId: 'hms_find_reservation',
        ...connectedCallTiming(findStartedAt, Date.now()),
        status: result.status,
        result,
        matchCount: matches.length,
        linkedContextReferenceCount: findRun.linkedContextReferences.length,
        reservationRefIssued: Boolean(exactFindCompleted && matches[0]?.reservationRef),
        oneLoginRuntimeStats: runtime.stats(),
      });
      const reservationRef = exactFindCompleted ? matches[0]?.reservationRef ?? null : null;
      if (reservationRef) {
        detailInvoked = true;
        const detailStartedAt = Date.now();
        try {
          const detailRun = await executeReadToolRun({
            runKind: 'read_tool',
            executorLane: 'hms',
            draftingEnabled: false,
            request: {
              toolId: 'hms_read_reservation',
              reservationRef,
              candidateId: candidate.id,
              sections: ['core', 'stay'],
              detail: 'detail',
            },
            context,
            resultRef: `read-detail-${randomUUID()}`,
          });
          latestParentBinding = bindConnectedRunnerParent({
            reservationRef,
            detailResult: {
              status: detailRun.result.status,
              completeness: detailRun.result.completeness,
              scopeRef: detailRun.result.scopeRef,
              },
            detailDump: pendingDetailDump,
            reservationStayId: pendingReservationStayId,
            parentEvidenceId: connectedRunnerParentEvidenceId(detailRun.result),
          });
          // The sequence identity is usable only after both the unique find
          // and the exact, complete, scope-bound detail have committed.
          if (isConnectedRunnerParentBound(latestParentBinding, reservationRef)) {
            const detailIdentitySha256 = hashConnectedMatchedIdentity({
              match: matches[0],
              detailValues: pendingDetailDump?.values ?? null,
            });
            if (detailIdentitySha256) actualMatchedIdentitySha256 = detailIdentitySha256;
          }
          calls.push({
            index: index + 1,
            toolId: 'hms_read_reservation',
            ...connectedCallTiming(detailStartedAt, Date.now()),
            status: detailRun.result.status,
            completeness: detailRun.result.completeness,
            result: detailRun.result,
            scopeRefIssued: detailRun.result.scopeRef === reservationRef,
            linkedContextReferenceCount: detailRun.linkedContextReferences.length,
            oneLoginRuntimeStats: runtime.stats(),
          });
        } catch (error) {
          latestParentBinding = emptyParentBinding();
          pendingDetailDump = null;
          pendingReservationStayId = null;
          calls.push({
            index: index + 1,
            toolId: 'hms_read_reservation',
            ...connectedCallTiming(detailStartedAt, Date.now()),
            status: 'error',
            errorCode:
              error instanceof Error && 'code' in error
                ? String((error as { code: unknown }).code)
                : 'READ_DETAIL_ERROR',
            errorMessage: error instanceof Error ? error.message.slice(0, 160) : 'read detail failed',
            scopeRefIssued: false,
            oneLoginRuntimeStats: runtime.stats(),
          });
        }
      }
    }

    if (allTools) {
      // Exercise every included dispatcher branch from this same connected
      // packet.  A missing provider/input is recorded as a typed outcome; the
      // probe never manufactures a PMS record or promotes a fixture.
      const invoke = async (
        request: ReadRequest,
        invokeContext: ReadExecutionContext = context,
        metadata: Record<string, unknown> = {},
      ) => {
        if (!shouldProbe(request.toolId)) return null;
        const invokeStartedAt = Date.now();
        try {
          const run = await executeReadToolRun({
            runKind: 'read_tool',
            executorLane: 'hms',
            draftingEnabled: false,
            request,
            context: invokeContext,
            resultRef: `read-probe-${randomUUID()}`,
          });
          calls.push({
            ...metadata,
            toolId: request.toolId,
            ...connectedCallTiming(invokeStartedAt, Date.now()),
            status: run.result.status,
            completeness: run.result.completeness,
            scopeRef: run.result.scopeRef,
            unavailableSections: run.result.unavailableSections,
            issueCodes: run.result.issues.map((issue) => issue.code),
            dataPresent: run.result.data !== null,
            result: run.result,
            ...(request.toolId === 'hms_read_folio' ? { folioFallback: folioFallbackState } : {}),
            ...(request.toolId === 'hms_sent_email_audit' ? { sentEmailAudit: sentEmailState } : {}),
            invoked: true,
            probeOnly: true,
            linkedContextReferenceCount: run.linkedContextReferences.length,
            oneLoginRuntimeStats: runtime.stats(),
          });
          return run.result;
        } catch (error) {
          calls.push({
            ...metadata,
            toolId: request.toolId,
            ...connectedCallTiming(invokeStartedAt, Date.now()),
            status: 'error',
            invoked: true,
            probeOnly: true,
            errorCode: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'READ_PROBE_ERROR',
          });
          return null;
        }
      };

      // No reservation match means there is no reservation PMS ref. Use a
      // body-scoped provenance ref for typed unavailable probes, never the
      // candidate hash as if it were a PMS record identifier.
      const probeScope = latestParentBinding.reservationRef ?? bodyScopeRef;
      const unboundContext: ReadExecutionContext = {
        ...context,
        reservationFacade: undefined,
        budget: { total: context.budget.total, limit: 64 },
      };
      if (!detailInvoked) {
        await invoke(
          {
            toolId: 'hms_read_reservation',
            reservationRef: probeScope,
            sections: ['core', 'stay'],
            detail: 'summary',
          },
          unboundContext,
        );
      }
      // PSSNEL must run before the optional OSRESS retry: a failed OSRESS
      // session can tear down its proof context, which would otherwise make a
      // genuine sent-email provider error look like `page.content` on a closed
      // page. Both calls remain serialized under the same runtime lock.
      const sentEmailFirst = process.env.HMS_CONNECTED_SENT_FIRST !== '0';
      if (sentEmailFirst) {
        await invoke({
          toolId: 'hms_sent_email_audit',
          candidateId: candidate.id,
        });
      }
      await invoke({
        toolId: 'hms_read_folio',
        reservationRef: probeScope,
        candidateId: candidate.id,
        sections: ['balance', 'deposits', 'transactions'],
      });
      await invoke({
        toolId: 'hms_list_documents',
        candidateId: candidate.id,
        documentScope: 'tax_invoice',
      });
      await invoke({
        toolId: 'hms_read_document',
        candidateId: candidate.id,
        documentRef: `body:${candidate.id}`,
        format: 'bytes',
      });
      if (!sentEmailFirst) {
        await invoke({
          toolId: 'hms_sent_email_audit',
          candidateId: candidate.id,
        });
      }
      await invoke({
        toolId: 'hms_company_account_read',
        reservationRef: probeScope,
      });
      await invoke({
        toolId: 'hms_group_block_read',
        groupRef: groupCandidate?.exactGroupReference ?? bodyScopeRef,
        sections: ['summary'],
      });
      await invoke({
        toolId: 'hms_event_read',
        eventRef: eventCandidate?.exactEventReference ?? bodyScopeRef,
      });
      await invoke({
        toolId: 'hms_read_notes_traces',
        resourceRef: probeScope,
        states: ['open'],
        limit: 20,
        audience: 'staff',
      });

      // Keep the normal staff/open/20 probe above as the baseline. The
      // additional audience/state/paging variants are opt-in because each
      // continuation is a fresh bounded source read. They run only after the
      // exact HDR/LST detail parent is committed; no body-derived ref can
      // reach this branch.
      if (
        process.env.HMS_CONNECTED_NOTES_VARIANTS === '1' &&
        isConnectedRunnerParentBound(latestParentBinding, probeScope)
      ) {
        notesVariants = await runConnectedNotesVariants({
          resourceRef: probeScope,
          execute: async (request) => {
            const variant = request.audience === 'customer'
              ? 'customer_all_states'
              : request.limit === 1
                ? 'staff_limit1_paging'
                : request.states.length === 1 && request.states[0] === 'open'
                  ? 'staff_open_only'
                  : request.states.length === 1 && request.states[0] === 'completed'
                    ? 'staff_completed_only'
                    : 'staff_all_states';
            return invoke(
              {
                toolId: 'hms_read_notes_traces',
                resourceRef: request.resourceRef,
                states: request.states,
                limit: request.limit,
                ...(request.cursor ? { cursor: request.cursor } : {}),
                audience: request.audience,
              },
              context,
              {
                notesVariant: variant,
                notesVariantRequest: {
                  audience: request.audience,
                  states: [...request.states],
                  limit: request.limit,
                  cursorPresent: request.cursor !== undefined,
                },
              },
            );
          },
        });
      }

      // All Folios has a wider transaction set than the default page. Keep
      // continuation reads opt-in and on the same exact parent/session.
      if (
        process.env.HMS_CONNECTED_FOLIO_VARIANTS === '1' &&
        isConnectedRunnerParentBound(latestParentBinding, probeScope)
      ) {
        folioVariants = await runConnectedFolioPagingVariant({
          resourceRef: probeScope,
          execute: async (request) => {
            const result = await invoke(
              {
                toolId: 'hms_read_folio',
                reservationRef: request.resourceRef,
                candidateId: candidate.id,
                sections: request.sections,
                limit: request.limit,
                ...(request.cursor ? { cursor: request.cursor } : {}),
              },
              context,
              {
                folioVariant: 'transactions_limit50_paging',
                folioVariantRequest: {
                  sections: [...request.sections],
                  limit: request.limit,
                  cursorPresent: request.cursor !== undefined,
                },
              },
            );
            if (!result) return null;
            return {
              status: result.status,
              completeness: result.completeness,
              scopeRef: result.scopeRef,
              page: result.page,
              evidence: result.evidence,
              unavailableSections: result.unavailableSections,
              issues: result.issues,
            };
          },
        });
      }

      // Quote execution needs a producer-issued normalized request.  The
      // model-facing facade returns typed INPUT_MISSING when the connected
      // body did not supply one; it never invents dates, occupancy or rates.
      if (shouldProbe('hms_quote_stay')) {
      const quoteResult = await createAgentReadTools(context).hms_quote_stay.execute({
        quoteRequestRef: bodyScopeRef,
        detail: 'summary',
      });
      calls.push({
        toolId: 'hms_quote_stay',
        status: quoteResult.status,
        completeness: 'completeness' in quoteResult ? quoteResult.completeness : 'unknown',
        scopeRef: 'scopeRef' in quoteResult ? quoteResult.scopeRef : bodyScopeRef,
        invoked: true,
        probeOnly: true,
        inputSource: 'connected_incoming_body_only',
        quoteCandidateDerived: Boolean(quoteCandidate),
      });
      }

      if (shouldProbe('mail_parse_channel_payload')) {
      const channelResult = await createAgentReadTools(context).mail_parse_channel_payload.execute({
        body: connectedCase.incoming.body,
      });
      calls.push({
        toolId: 'mail_parse_channel_payload',
        status: channelResult.status,
        invoked: true,
        probeOnly: true,
        inputSource: 'connected_incoming_body_only',
      });
      }

      const invokedToolIds = new Set(calls.map((call) => call.toolId));
      calls.push({
        toolCoverageMissing: requestedToolIds.filter((toolId) => !invokedToolIds.has(toolId)),
        toolCoverageComplete: requestedToolIds.every((toolId) => invokedToolIds.has(toolId)),
        probeOnly: true,
      });
    }
    const toolStatuses = calls.map((call) => call.status).filter((value): value is string => typeof value === 'string');
    const allToolCallsSucceeded = toolStatuses.length > 0 && toolStatuses.every((value) => value === 'ok');
    const output = {
      ...base,
      // `runnerStatus` means the deterministic runner finished. `status` is
      // an aggregate of actual tool outcomes and never promotes not_found,
      // partial or manual_required to capability success.
      runnerStatus: 'completed',
      status: allToolCallsSucceeded ? 'ok' : 'completed_with_outcomes',
      allToolCallsSucceeded,
      unresolvedToolStatuses: toolStatuses.filter((value) => value !== 'ok'),
      runtime: {
        singleContextLogin: true, serializedDriverCalls: true,
        allIncludedToolProbe: process.env.HMS_CONNECTED_TOOLS === undefined && allTools,
        requestedToolIds,
      },
      calls,
      notesVariants,
      folioVariants,
      runtimeStats: runtime.stats(),
    };
    await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2), { mode: 0o600 });
  if (!quiet) {
    console.log(JSON.stringify({ phase: 'done', runnerStatus: output.runnerStatus, status: output.status, calls: calls.length, stats: output.runtimeStats, out: outputPath }));
  }
  return {
    caseId: connectedCase.caseId,
    outputPath,
    status: output.status,
    runnerStatus: output.runnerStatus,
    actualMatchedIdentitySha256,
  };
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  const requestedToolIds = selectConnectedProbeTools(
    process.env.HMS_CONNECTED_TOOLS,
    process.env.HMS_CONNECTED_ALL_TOOLS === '1',
  );
  const arn = process.env.HMS_READ_SECRET_ARN;
  const proofBindingPath = process.env.HMS_CONNECTED_PROOF_BINDING_PATH?.trim();
  const sequenceCasePaths = parseConnectedSequenceCasePaths(process.env.HMS_CONNECTED_SEQUENCE_CASE_PATHS);
  const casePath = process.env.HMS_CONNECTED_CASE_PATH;
  if (!arn || (!sequenceCasePaths && !casePath)) {
    throw new Error('HMS_READ_SECRET_ARN and HMS_CONNECTED_CASE_PATH or HMS_CONNECTED_SEQUENCE_CASE_PATHS are required');
  }
  if (sequenceCasePaths && casePath) {
    throw new Error('choose HMS_CONNECTED_CASE_PATH or HMS_CONNECTED_SEQUENCE_CASE_PATHS, not both');
  }

  const casePaths = sequenceCasePaths ? [...sequenceCasePaths] : [casePath as string];
  const connectedCases = await Promise.all(
    casePaths.map(async (path) =>
      connectedCaseSchema.parse(JSON.parse(await readFile(path, 'utf8'))),
    ),
  );
  const sequenceMode = sequenceCasePaths !== null;
  const baseOutputPath = process.env.HMS_CONNECTED_OUT ?? '/tmp/hms-connected-read.json';
  if (!sequenceMode && !selectConnectedLookupCandidate(extractLookupCandidates(connectedCases[0].incoming.body))) {
    await runCase({
      runtime: null,
      secret: null,
      connectedCase: connectedCases[0],
      requestedToolIds,
      outputPath: baseOutputPath,
      quiet: false,
    });
    return;
  }
  const loadedSecret = await loadSecret(arn);
  const secret = loadedSecret.secret;
  if (!proofBindingPath) {
    throw new Error('HMS_CONNECTED_PROOF_BINDING_PATH is required for selected connected cases');
  }
  const proofBinding = await loadConnectedProofBinding(proofBindingPath);
  const runtimeFingerprint = {
    sourceRevision: proofBinding.sourceRevision,
    playwrightRevision: '1.52.0',
    chromiumRevision: '1169',
  } as const;
  await assertConnectedBundleSourceFingerprint(proofBinding);
  assertConnectedRuntimeFingerprint(proofBinding, runtimeFingerprint);
  assertConnectedSecretBinding({
    binding: proofBinding,
    propertyCode: secret.expectedPropertyCode,
    secretVersion: loadedSecret.version,
  });
  const origin = new URL(secret.loginUrl).origin;
  // The standalone connected lane uses the tenant-proven read-only OSRESS
  // XHR from the authenticated COMMON shell.  A fresh proof context opened
  // directly at OSRESV can remain on Infor's locale bootstrap shell. Keep
  // authentication and each read invocation in the same fresh context; this
  // mode does not imply one login across the whole sequence.
  if (process.env.HMS_CONNECTED_DIRECT_COMMON !== '0') {
    process.env.HMS_SINGLE_CONTEXT_LOGIN = '1';
    process.env.HMS_SKIP_GUEST_STAY_NAV = '1';
  }
  const runtime = createHmsRuntime({
    manifest: buildLiveGuestStayReadManifest(origin),
    secretArn: arn,
    loadSecret: async () => loadedSecret,
    browserFactory: createPlaywrightBrowserFactory(),
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
    expectedOrigin: origin,
    requireViewOnly: true,
    runStartupCanary: false,
    requireSessionAuthorization: true,
    requireAuditCapture: false,
    reuseAuthenticatedStorageState: true,
    roleProofPath: proofBinding.find.roleProofPath,
    loadRoleProof: (path, now) => loadConnectedRoleProof(proofBinding, path, now),
    validateSessionAuthorization: (authorization) =>
      validateConnectedSessionAuthorization({
        binding: proofBinding,
        authorization,
        runtimeFingerprint,
        secretVersion: loadedSecret.version,
        propertyCode: secret.expectedPropertyCode,
        bundleManifestPath: join(process.cwd(), 'bundle-manifest.json'),
      }),
    sourceRevision: proofBinding.sourceRevision,
    playwrightRevision: runtimeFingerprint.playwrightRevision,
    chromiumRevision: runtimeFingerprint.chromiumRevision,
  });
  const startupSignal = AbortSignal.timeout(120_000);
  try {
    await runtime.start(startupSignal);
    const results: ConnectedSequenceCaseResult[] = [];
    for (const [index, connectedCase] of connectedCases.entries()) {
      const outputPath = sequenceMode
        ? `${baseOutputPath}.case-${index + 1}.json`
        : baseOutputPath;
      results.push(
        await runCase({
          runtime,
          secret,
          proofBinding,
          connectedCase,
          requestedToolIds,
          outputPath,
          quiet: sequenceMode,
        }),
      );
    }
    if (sequenceMode) {
      const summary = buildConnectedSequenceSummary({
        outputPath: baseOutputPath,
        cases: results,
        runtimeStats: runtime.stats(),
      });
      await mkdir(dirname(baseOutputPath), { recursive: true });
      await writeFile(baseOutputPath, JSON.stringify(summary, null, 2), { mode: 0o600 });
      const identityPassed = connectedSequenceIdentityPassed(summary);
      console.log(JSON.stringify({
        phase: identityPassed ? 'sequence_done' : 'sequence_failed',
        identityPassed,
        sequenceLength: summary.sequenceLength,
        identityCheck: summary.identityCheck,
        out: baseOutputPath,
      }));
      if (!identityPassed) process.exitCode = 1;
    }
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    phase: 'failed',
    errorCode: standaloneErrorCode(error) ?? 'UNKNOWN',
    error: standaloneErrorMessage(error) ?? 'unknown_error',
  }));
  process.exit(1);
});
