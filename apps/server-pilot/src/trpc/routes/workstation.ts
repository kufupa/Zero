import { outlookSyncRouter } from './outlook-sync.js';
import {
  approvedStaySpan,
  combinedStayCurrencyProblem,
  staffQuoteInput,
  staffQuoteCurrencyProblem,
  staffQuoteSourceHash,
  type StaffQuoteAttestation,
} from '../../ai/staff-quote-workflow.js';
import { bookingCodeDefaults, type PartyClass } from '../../ai/booking-code-rules.js';
import {
  bookingDraftFromPrefill, buildBookingDrafts, createRequestFieldOptions,
  isUnquotedSingleStayNewBooking, prefillBoardFromLuna, UNQUOTED_BOOKING_REVISION_REF,
} from '../../ai/booking-draft.js';
import { buildCreatePrefill } from '../../ai/aop/create-prefill.js';
import {
  collectThreadQuoteRevisions,
  priorStaffQuoteRequotePayload,
  proposalFactRefsForRevision,
  quotedTotalWithStoredExtras,
  resolvePriorQuoteForBooking,
  revisionCarriesOnceExtras,
  storedRowPrices,
} from '../../ai/prior-quote-booking.js';
import { lunaAnalysisSchema } from '../../ai/reservationist-decision.js';
// Outlook sends the raw Message-ID; ingest stores the canonical form, as analyseSelection already matches.
import { canonicalInternetMessageId } from '../../ai/quote-workflow-analyse-selection.js';
import {
  buildStaysProposalPdf,
  documentIdFor,
  ProposalPdfUnavailableError,
  renderImportedProposalHtml,
  renderApprovedOverrideHtml,
  convertProposalHtml,
} from '../../quote-proposal/proposal-pdf.js';
import {
  deriveQuoteLines,
  deriveAuthorizedExtraLines,
  pricedRoomTotal,
  type AuthorizedProposalFacts,
  type RowPrice,
} from '../../quote-proposal/quote-lines.js';
import {
  quoteWorkbookForStays,
  quoteWorkbookFileName,
  WorkbookRefusalError,
} from '../../quote-proposal/quote-workbook.js';
import { readInstalledStaffQuoteConfiguration } from '../../ai/staff-quote-installation.js';
import {
  BridgeTicketDeniedError,
  issueBridgeTicket,
} from '../../outlook-security/authorization.js';
import { buildQuoteProposalPdf, ProposalInputError } from '../../quote-proposal/proposal-pdf.js';
import type { ImportedOffer, QuoteRevision } from '../../quote-proposal/quote-revision.js';
import { PRICED_QUOTE_REUSE_MS, quoteDigest } from '../../quote-proposal/quote-revision.js';
import {
  classifyBookingDraft,
  classifyPdf,
  classifyStaffQuote,
  ledgerQuoteInput,
  recordToolOutcome,
} from '../../ai/hitl-tool-run.js';
import { mailboxProcedure, privateProcedure, publicProcedure, router } from '../trpc.js';
import { assertReservationistResultFreshForAction } from '../../ai/draft-approval.js';
import { aiWorkflowRun, aiDraftGeneration, message } from '../../db/schema/mail.js';
import {
  countOtherInFlightQuoteRuns,
  describeHmsQueueStatus,
  latestQuoteRunFor,
  readPropertyLockHolder,
  type HmsQueueStatus,
} from '../../hms/property-queue-state.js';
import {
  QUOTE_RUN_ID_PATTERN,
  QUOTE_SCREENSHOT_NAME_PATTERN,
  readQuoteRunScreenshot,
} from '../../ai/staff-quote-evidence.js';
import {
  awaitPendingStaffQuote,
} from '../../ai/staff-quote-trace-async.js';
import { QUOTE_MEALS } from '../../quote-proposal/description.js';
import { emailsMatch } from '../../quote-proposal/identity.js';
import {
  quotePdfPartyName,
  quotePdfSenderDisplayName,
  retargetQuotePdfFileName,
} from '../../quote-proposal/filename.js';
import { and, eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  assertHmsQuoteOriginAllowed,
  resolveHmsQuoteJobTarget,
} from '../../hms/hms-quote-target.js';
import { hmsReadTargetForTransport, hmsReadTargetJobMetrics } from '../../hms/hms-read-target.js';
import { TRPCError } from '@trpc/server';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runStaffQuote } from '../../ai/staff-quote-run.js';
import { occupancyFromRevision, singleStayOccupancyIsCurrent, isCenturionQuoteScope, isCenturionQuoteTransport, importedOfferOccupancyHold, draftQuoteOccupancyMessage,
  quoteSourceProofFromRun, quoteSourceProofIsCurrent, quoteSourceProofMatchesSingleStay, quoteSourceProofPredatesPolicy,
  quoteSourcePolicyChangedMessage } from '../../ai/child-occupancy.js';
import {
  enqueueHmsJob,
  queueAutoStaffQuoteHmsJob,
  hmsJobQueueEnabled,
  quotePreparationEnabled,
  HMS_JOB_PRIORITY_DEV,
  HMS_JOB_PRIORITY_USER,
  isSystemPreparedPriority,
  readHmsJobView,
  staffQuoteResultReusable,
} from '../../ai/hms-jobs.js';
import { HMS_JOB_PROMPT_VERSION } from '../../ai/run-ledger.js';
import {
  enqueueQuotePdfJob,
  persistQuotePdfResult,
  quotePdfJobIdentity,
  quotePdfRequestSchema,
  quotePdfResultOf,
  readQuotePdfJob,
  type QuotePdfRequest,
  type QuotePdfResult,
} from '../../ai/quote-pdf-jobs.js';

export {
  insufficientInventoryMessage,
  nativeNoMatchingRateMessage,
  NATIVE_NO_MATCHING_RATE_PREFIX,
  PARTY_LOOKUP_OFF_NOTE,
  restrictedNightsMessage,
  SHARED_INVENTORY_GAP_MESSAGE,
  staffExtrasOrBadRequest,
  staffQuoteFailureCode,
  staffQuoteFailureLog,
  staffQuoteFailureMessage,
  staffQuoteFailurePhase,
  verifyStaffParties,
} from '../../ai/staff-quote-run.js';

export const workstationPingInput = z.object({
  workstationUser: z.string().default('unknown'),
  outlookEmail: z.string().default('unknown'),
  outlookVersion: z.string().default('unknown'),
});

const quoteProposalLineInput = z.object({
  dateLabel: z.string().min(1),
  qty: z.number().int().positive(),
  roomCode: z.string().min(1),
  meal: z.enum(QUOTE_MEALS),
  nights: z.number().int().positive(),
  rate: z.number().nonnegative(),
});

export const quoteProposalPdfInput = z.object({
  outlookEmail: z.string().min(1),
  attention: z.string().default(''),
  company: z.string().default(''),
  clientEmail: z.string().default(''),
  clientTelephone: z.string().default(''),
  agency: z.string().min(1),
  dateLabel: z.string().min(1),
  lines: z.array(quoteProposalLineInput).min(1).max(6),
});

type rQualifiedChoice = {
  kind?: 'native' | 'imported_offer' | 'approved_override';
  workflowRunId: string;
  messageId: string;
  threadId: string;
  revisionRef: string;
  factRefs: string[];
  totalMinor: number;
  currency: string;
  arrivalDate: string;
  departureDate: string;
  description: string;
};
export const prepareBookingDraftInput = z
  .object({
    workflowRunId: z.string().min(1),
    revisionRef: z.string().min(1),
    messageId: z.string().min(1),
    selectionEpoch: z.number().int().nonnegative(),
    inputRevision: z.number().int().nonnegative(),
    analysis: lunaAnalysisSchema,
  })
  .strict();

export const prepareUnquotedBookingDraftInput = z.object({
  messageId: z.string().min(1),
  selectionEpoch: z.number().int().nonnegative(),
  inputRevision: z.number().int().nonnegative(),
  analysis: lunaAnalysisSchema,
  rateCode: z.string().trim().regex(/^[A-Z0-9]{2,10}$/).optional(),
}).strict();

export const listThreadQuoteRevisionsInput = z.object({ threadId: z.string().min(1) }).strict();

export const usePriorQuoteForBookingInput = z
  .object({
    workflowRunId: z.string().min(1),
    revisionRef: z.string().min(1),
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    selectionEpoch: z.number().int().nonnegative(),
    inputRevision: z.number().int().nonnegative(),
    analysis: lunaAnalysisSchema,
  })
  .strict();

export const getPriorStaffQuoteRequoteInput = z
  .object({
    workflowRunId: z.string().min(1),
    revisionRef: z.string().min(1),
    threadId: z.string().min(1),
  })
  .strict();

function partyClassFromRevision(
  revision: QuoteRevision,
  attestation: (StaffQuoteAttestation & { salesStrategy?: string }) | undefined,
): PartyClass {
  const context = revision.groups[0]?.context ?? {};
  if ('agency' in context) return 'agency';
  if ('organization' in context) {
    return attestation?.salesStrategy === 'Government' ? 'government' : 'organization';
  }
  return 'private';
}

/** A stay after the first in a combined quote: its own approved run, revision and authorised facts. */
const qualifiedStayInput = z
  .object({
    workflowRunId: z.string().min(1),
    revisionRef: z.string().min(1),
    factRefs: z.array(z.string().min(1)).max(32).default([]),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
export const qualifiedProposalInput = z
  .object({
    workflowRunId: z.string().min(1),
    revisionRef: z.string().min(1),
    messageId: z.string().min(1),
    outlookEmail: z.string().min(1),
    factRefs: z.array(z.string().min(1)).max(32).default([]),
    attention: z.string().max(256).default(''),
    company: z.string().max(256).default(''),
    clientEmail: z.string().max(256).default(''),
    clientTelephone: z.string().max(128).default(''),
    agency: z.string().max(256).default('Quote'),
    notes: z.string().trim().max(1000).optional(),
    // Empty for one stay. A combined quote lists its other stays here; the first stay stays in the fields above.
    additionalStays: z.array(qualifiedStayInput).max(62).default([]),
    workItemId: z.string().uuid().optional(),
  })
  .strict();
export function resolveLedgerProposal(
  run: {
    transportId: string;
    triggerMessageId: string;
    state: string;
    metrics: Record<string, unknown> | null;
  },
  scope: { transportId: string; messageId: string; revisionRef: string; factRefs: string[] },
): { revision: QuoteRevision; facts?: AuthorizedProposalFacts } {
  if (run.transportId !== scope.transportId || run.triggerMessageId !== scope.messageId)
    throw new Error('proposal_scope');
  const result = run.metrics?.reservationistResult as
    | {
        readiness?: string;
        superseded?: boolean;
        expired?: boolean;
        quoteRevisionIds?: string[];
        quoteRevisions?: QuoteRevision[];
        proposalFacts?: Array<{ ref: string; facts: AuthorizedProposalFacts }>;
      }
    | undefined;
  if (!result) throw new Error('proposal_not_ready');
  const staff = run.metrics?.staffQuoteAttestation as StaffQuoteAttestation | undefined;
  if (staff?.dinnerAddOnRequired === true) throw new Error('dinner_add_on_required');
  const qualifiedStaff =
    staff?.version === 1 &&
    staff.kind === 'staff_approved_quote' &&
    staff.transportId === scope.transportId &&
    staff.messageId === scope.messageId &&
    !!staff.inputDigest &&
    !!staff.sourceHash &&
    staff.revisionIds?.includes(scope.revisionRef) &&
    result?.quoteRevisions?.find((r) => r.id === scope.revisionRef)?.authorizationId ===
      staff.authorizationId;
  if (
    run.state !== 'succeeded' ||
    (!qualifiedStaff && result?.readiness !== 'ready_for_staff_review') ||
    result?.superseded === true ||
    result?.expired === true
  )
    throw new Error('proposal_not_ready');
  const matches = result.quoteRevisions?.filter((r) => r.id === scope.revisionRef) ?? [];
  if (matches.length !== 1 || !result.quoteRevisionIds?.includes(scope.revisionRef))
    throw new Error('revision_missing');
  const revision = matches[0];
  deriveQuoteLines(revision, storedRowPrices(run, revision.id));
  assertReservationistResultFreshForAction({ version: 1, quoteRevisions: [revision] }, new Date());
  const selectedBundles =
    result.proposalFacts?.filter((bundle) => bundle.facts?.revisionId === revision.id) ?? [];
  if (selectedBundles.length > 1) throw new Error('proposal_fact_bundle_required');
  if (
    new Set(scope.factRefs).size !== scope.factRefs.length ||
    scope.factRefs.length !== selectedBundles.length ||
    selectedBundles.some((bundle) => !scope.factRefs.includes(bundle.ref))
  )
    throw new Error('proposal_fact_selection_mismatch');
  const facts = scope.factRefs.map((ref) => {
    const matches = result.proposalFacts?.filter((f) => f.ref === ref) ?? [];
    if (matches.length !== 1) throw new Error('proposal_fact_missing');
    return matches[0].facts;
  });
  if (facts.length > 1) throw new Error('proposal_fact_bundle_required');
  if (facts[0]) deriveAuthorizedExtraLines(revision, facts[0]);
  return { revision, facts: facts[0] };
}

/** Resolve a fresh system-prepared price without manufacturing a staff approval or generation row. */
export function resolvePreparedLedgerProposal(
  run: {
    transportId: string;
    threadId: string;
    triggerMessageId: string;
    runKind: string;
    promptVersion: string;
    executorLane: string;
    priority: number;
    generationId: string | null;
    state: string;
    metrics: Record<string, unknown> | null;
    readRequest: unknown;
    readResult: Record<string, unknown> | null;
    readResultExpiresAt: Date | null;
  },
  scope: {
    transportId: string;
    messageId: string;
    revisionRef: string;
    factRefs: string[];
    sourceHash: string;
    party: { company: string; agency: string };
    now?: Date;
  },
): { revision: QuoteRevision; facts?: AuthorizedProposalFacts; rowPrices: RowPrice[] } {
  const now = scope.now ?? new Date();
  const metrics = run.metrics ?? {};
  const request = run.readRequest && typeof run.readRequest === 'object' && !Array.isArray(run.readRequest)
    ? run.readRequest as Record<string, unknown>
    : null;
  const parsedInput = staffQuoteInput.safeParse(request?.kind === 'staff_quote' ? request.input : null);
  const result = run.readResult;
  const prepared = result?.preparedProposal && typeof result.preparedProposal === 'object' && !Array.isArray(result.preparedProposal)
    ? result.preparedProposal as Record<string, unknown>
    : null;
  const revision = prepared?.revision as QuoteRevision | undefined;
  const rowPrices = Array.isArray(prepared?.rowPrices) ? prepared.rowPrices as RowPrice[] : [];
  const facts = prepared?.facts as AuthorizedProposalFacts | undefined;
  const factRefs = Array.isArray(result?.factRefs) ? result.factRefs : null;
  const resultFactRefs = factRefs?.every((ref) => typeof ref === 'string') ? factRefs as string[] : null;
  const parties = parsedInput.success ? parsedInput.data.parties : undefined;
  const samePartyName = (left: string, right: string) =>
    left.replace(/\s+/g, ' ').trim().toLowerCase() === right.replace(/\s+/g, ' ').trim().toLowerCase();
  const boundPartyHeaderMatches = parsedInput.success &&
    (parties?.company
      ? samePartyName(scope.party.company, parties.company.name)
      : true) &&
    (parties?.agency
      ? samePartyName(scope.party.agency, parties.agency.name)
      : true);
  const sourceStillCurrent = parsedInput.success &&
    parsedInput.data.messageId === scope.messageId &&
    parsedInput.data.sourceHash === scope.sourceHash &&
    prepared?.sourceHash === scope.sourceHash;
  const asOfMs = typeof result?.asOf === 'string' ? Date.parse(result.asOf) : Number.NaN;
  const freshResult = !!result &&
    staffQuoteResultReusable(result, now) &&
    Number.isFinite(asOfMs) &&
    asOfMs <= now.getTime() &&
    asOfMs + PRICED_QUOTE_REUSE_MS > now.getTime();
  if (
    run.transportId !== scope.transportId ||
    run.triggerMessageId !== scope.messageId ||
    run.runKind !== 'read_tool' ||
    run.promptVersion !== HMS_JOB_PROMPT_VERSION ||
    run.executorLane !== 'hms' ||
    !isSystemPreparedPriority(run.priority) ||
    run.generationId !== null ||
    run.state !== 'succeeded' ||
    metrics.quotePrepared !== true ||
    metrics.userId != null ||
    !sourceStillCurrent ||
    !boundPartyHeaderMatches ||
    !freshResult ||
    result?.status !== 'ready' ||
    result.dinnerAddOnRequired === true ||
    result.kind !== 'staff_quote' ||
    result.messageId !== scope.messageId ||
    result.threadId !== run.threadId ||
    result.revisionRef !== scope.revisionRef ||
    !prepared ||
    prepared.version !== 1 ||
    typeof prepared.inputDigest !== 'string' ||
    prepared.inputDigest !== result.inputDigest ||
    typeof prepared.authorizationId !== 'string' ||
    prepared.authorizationId !== revision?.authorizationId ||
    revision?.id !== scope.revisionRef ||
    !resultFactRefs ||
    new Set(resultFactRefs).size !== resultFactRefs.length ||
    new Set(scope.factRefs).size !== scope.factRefs.length ||
    [...resultFactRefs].sort().join('\n') !== [...scope.factRefs].sort().join('\n') ||
    Boolean(facts) !== (resultFactRefs.length > 0)
  ) {
    throw new Error('proposal_not_ready');
  }
  try {
    if (facts && facts.revisionId !== revision.id) throw new Error('proposal_fact_scope');
    deriveQuoteLines(revision, rowPrices);
    if (facts) deriveAuthorizedExtraLines(revision, facts);
    assertReservationistResultFreshForAction({ version: 1, quoteRevisions: [revision] }, now);
  } catch {
    throw new Error('proposal_not_ready');
  }
  return { revision, facts, rowPrices };
}

/** Select and revalidate only the exact persisted source packet; readiness is never a freshness proof. */
export function resolveLedgerSourceProposal(
  run: {
    transportId: string;
    triggerMessageId: string;
    state: string;
    metrics: Record<string, unknown> | null;
  },
  scope: {
    transportId: string;
    messageId: string;
    revisionRef: string;
    factRefs: string[];
    kind: 'imported_offer' | 'approved_override';
  },
):
  | ImportedOffer
  | Awaited<
      ReturnType<typeof import('../../quote-proposal/quote-revision.js').resolveApprovedOverride>
    > {
  if (run.transportId !== scope.transportId || run.triggerMessageId !== scope.messageId)
    throw new Error('proposal_scope');
  const result = run.metrics?.reservationistResult as
    | {
        readiness?: string;
        superseded?: boolean;
        expired?: boolean;
        importedOffers?: ImportedOffer[];
        approvedOverrides?: Awaited<
          ReturnType<
            typeof import('../../quote-proposal/quote-revision.js').resolveApprovedOverride
          >
        >[];
      }
    | undefined;
  if (
    run.state !== 'succeeded' ||
    result?.readiness !== 'ready_for_staff_review' ||
    result.superseded === true ||
    result.expired === true ||
    scope.factRefs.length
  )
    throw new Error('proposal_not_ready');
  const matches =
    (scope.kind === 'imported_offer' ? result.importedOffers : result.approvedOverrides)?.filter(
      (offer) => offer.id === scope.revisionRef,
    ) ?? [];
  if (matches.length !== 1) throw new Error('proposal_source_missing');
  const selected = matches[0];
  assertReservationistResultFreshForAction(
    {
      version: 1,
      ...(scope.kind === 'imported_offer'
        ? { importedOffers: [selected] }
        : { approvedOverrides: [selected] }),
    },
    new Date(),
  );
  return selected;
}

/** A stay of a proposal request, resolved to its approved revision and, when attested, its staff approval. */
type ProposalStay = {
  revision: QuoteRevision;
  facts?: AuthorizedProposalFacts;
  staff?: StaffQuoteAttestation;
  preparedNotes?: string;
  /** The row prices the approval recorded. The PDF and Excel price the rows with them, and the total agrees. */
  rowPrices?: RowPrice[];
};

/** The dates an approval covers, read from the revision its run attested. Null when unknown. */
function attestedStaySpan(metrics: Record<string, unknown> | null | undefined): string | null {
  const staff = metrics?.staffQuoteAttestation as StaffQuoteAttestation | undefined;
  const result = metrics?.reservationistResult as { quoteRevisions?: QuoteRevision[] } | undefined;
  const revision = result?.quoteRevisions?.find((candidate) => candidate.id === staff?.revisionIds?.[0]);
  return revision ? approvedStaySpan(revision) : null;
}

/** The stay a system-prepared quote covers, or null when its dates are unavailable. */
function preparedStaySpan(readResult: Record<string, unknown> | null | undefined): string | null {
  const prepared = readResult?.preparedProposal;
  const revision =
    prepared && typeof prepared === 'object' && !Array.isArray(prepared)
      ? (prepared as { revision?: QuoteRevision }).revision
      : undefined;
  return readResult?.status === 'ready' && revision ? approvedStaySpan(revision) : null;
}

/** Every staff approval for this message, newest first, with the stay dates each one covers. */
async function staffApprovalsFor(
  ctx: { activeTransportId: string; sessionUser: { id: string } },
  threadId: string,
  messageId: string,
) {
  const rows = await getDb()
    .select({
      id: aiDraftGeneration.id,
      createdAt: aiDraftGeneration.createdAt,
      metrics: aiWorkflowRun.metrics,
    })
    .from(aiDraftGeneration)
    .leftJoin(aiWorkflowRun, eq(aiWorkflowRun.generationId, aiDraftGeneration.id))
    .where(
      and(
        eq(aiDraftGeneration.transportId, ctx.activeTransportId),
        eq(aiDraftGeneration.threadId, threadId),
        eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id),
        eq(aiDraftGeneration.model, 'staff-approved-native'),
        sql`${aiDraftGeneration.contextMessageIds} @> ${JSON.stringify([messageId])}::jsonb`,
      ),
    )
    .orderBy(desc(aiDraftGeneration.createdAt));
  return rows.map((row) => ({
    generationId: row.id,
    createdAt: row.createdAt,
    span: attestedStaySpan(row.metrics),
  }));
}

/**
 * Every stay of a proposal request, resolved to its approved revision. User and prepared runs require the exact source.
 * One stay keeps the message-wide currency rule. Re-resolve after building.
 */
async function proposalStaysFor(
  input: z.infer<typeof qualifiedProposalInput>,
  ctx: { activeTransportId: string; sessionUser: { id: string; email: string; name: string | null } },
  resolveFailure: string,
): Promise<ProposalStay[]> {
  const requests = [
    {
      workflowRunId: input.workflowRunId,
      revisionRef: input.revisionRef,
      factRefs: input.factRefs,
      notes: input.notes,
    },
    ...input.additionalStays,
  ];
  if (new Set(requests.map((request) => request.workflowRunId)).size !== requests.length)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Each stay needs its own approved quote' });
  const db = getDb();
  await Promise.all(requests.map((request) => awaitPendingStaffQuote(request.workflowRunId)));
  const [current] = await db
    .select()
    .from(message)
    .where(and(eq(message.id, input.messageId), eq(message.transportId, ctx.activeTransportId)))
    .limit(1);
  const runs = await Promise.all(
    requests.map(async (request) => {
      const [run] = await db
        .select({ run: aiWorkflowRun })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.id, request.workflowRunId),
            eq(aiWorkflowRun.transportId, ctx.activeTransportId),
          ),
        )
        .limit(1);
      if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal source not found' });
      const systemPrepared = isSystemPreparedPriority(run.run.priority) &&
        run.run.metrics?.quotePrepared === true &&
        run.run.metrics.userId == null;
      const exactSource =
        run.run.transportId === ctx.activeTransportId &&
        run.run.triggerMessageId === input.messageId;
      if (!exactSource || !current)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal source not found' });
      if (systemPrepared && !quotePreparationEnabled())
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This quote is no longer ready. Run it again.',
        });
      if (!systemPrepared) {
        const [owner] = await db
          .select({ id: aiDraftGeneration.id })
          .from(aiDraftGeneration)
          .innerJoin(aiWorkflowRun, eq(aiWorkflowRun.generationId, aiDraftGeneration.id))
          .where(
            and(
              eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id),
              eq(aiWorkflowRun.id, request.workflowRunId),
              eq(aiWorkflowRun.transportId, ctx.activeTransportId),
              eq(aiWorkflowRun.triggerMessageId, input.messageId),
            ),
          )
          .limit(1);
        if (!owner) throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal source not found' });
      }
      return { run: run.run, request, systemPrepared };
    }),
  );
  const combined = runs.length > 1;
  const threadId = runs[0]!.run.threadId;
  const approvals = combined
    ? [
        ...(await staffApprovalsFor(ctx, threadId, input.messageId)),
        ...runs.flatMap(({ run, systemPrepared }) =>
          systemPrepared
            ? [{ generationId: run.id, createdAt: run.createdAt, span: preparedStaySpan(run.readResult) }]
            : [],
        ),
      ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    : [];
  const latest = combined
    ? undefined
    : (
        await db
          .select({ id: aiDraftGeneration.id, createdAt: aiDraftGeneration.createdAt })
          .from(aiDraftGeneration)
          .where(
            and(
              eq(aiDraftGeneration.transportId, ctx.activeTransportId),
              eq(aiDraftGeneration.threadId, threadId),
              eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id),
              eq(aiDraftGeneration.model, 'staff-approved-native'),
              sql`${aiDraftGeneration.contextMessageIds} @> ${JSON.stringify([input.messageId])}::jsonb`,
            ),
          )
          .orderBy(desc(aiDraftGeneration.createdAt))
          .limit(1)
      )[0];
  const stays: ProposalStay[] = [];
  for (const { run, request, systemPrepared } of runs) {
    const staff = run.metrics?.staffQuoteAttestation as StaffQuoteAttestation | undefined;
    if (combined && !staff && !systemPrepared)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Every stay needs its own approved quote' });
    if (combined) {
      const problem = combinedStayCurrencyProblem({
        stay: {
          generationId: systemPrepared ? run.id : run.generationId,
          span: systemPrepared ? preparedStaySpan(run.readResult) : attestedStaySpan(run.metrics),
        },
        approvals,
      });
      if (problem) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: problem });
    } else if (
      systemPrepared &&
      latest &&
      latest.createdAt.getTime() >= run.createdAt.getTime()
    ) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Newer stay inputs were approved; use the current quote',
      });
    }
    if (staff) {
      const party = { company: input.company, agency: input.agency };
      const problem = staffQuoteCurrencyProblem({
        staff,
        runGenerationId: run.generationId,
        latestGenerationId: combined ? run.generationId : latest?.id,
        currentMessage: current,
        userId: ctx.sessionUser.id,
        party,
      });
      if (problem) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: problem });
    }
    let resolved: ReturnType<typeof resolveLedgerProposal>;
    let rowPrices: RowPrice[];
    try {
      const proposalScope = {
        transportId: ctx.activeTransportId,
        messageId: input.messageId,
        revisionRef: request.revisionRef,
        factRefs: request.factRefs,
      };
      if (systemPrepared) {
        const prepared = resolvePreparedLedgerProposal(run, {
          ...proposalScope,
          sourceHash: current ? staffQuoteSourceHash(current) : '',
          party: { company: input.company, agency: input.agency },
        });
        resolved = { revision: prepared.revision, facts: prepared.facts };
        rowPrices = prepared.rowPrices;
      } else {
        resolved = resolveLedgerProposal(run, proposalScope);
        rowPrices = storedRowPrices(run, resolved.revision.id);
      }
    } catch {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: resolveFailure });
    }
    const proof = quoteSourceProofFromRun(run);
    if (!(await quoteSourceProofIsCurrent(db, occupancyFromRevision(resolved.revision), {
      transportId: ctx.activeTransportId, threadId: current.threadId, messageId: input.messageId,
      propertyCode: resolved.revision.propertyCode,
    }, proof))) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: quoteSourceProofPredatesPolicy(proof) ? quoteSourcePolicyChangedMessage : draftQuoteOccupancyMessage,
      });
    }
    stays.push({
      ...resolved,
      staff,
      rowPrices,
      ...(systemPrepared && request.notes ? { preparedNotes: request.notes } : {}),
    });
  }
  return stays;
}

/** The staff notes approved with each stay, each kept once and one per line. */
function stayNotes(stays: ProposalStay[]): string | undefined {
  const notes = [
    ...new Set(
      stays
        .map((stay) => (stay.staff ? stay.staff.notes : stay.preparedNotes))
        .filter((note): note is string => !!note),
    ),
  ];
  return notes.length ? notes.join('\n') : undefined;
}

async function buildQualifiedQuotePdf(
  input: z.infer<typeof qualifiedProposalInput>,
  ctx: { activeTransportId: string; sessionUser: { id: string; email: string; name: string | null } },
  fromAddress: string | null | undefined,
): Promise<QuotePdfResult> {
  const stays = await proposalStaysFor(input, ctx, 'Proposal evidence is not ready');
  const url = process.env.GOTENBERG_URL?.trim();
  if (!url) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GOTENBERG_URL missing' });
  let result: Awaited<ReturnType<typeof buildStaysProposalPdf>>;
  try {
    result = await buildStaysProposalPdf(
      stays,
      {
        attention: input.attention,
        company: input.company,
        clientEmail: input.clientEmail,
        clientTelephone: input.clientTelephone,
        agency: input.agency,
        signerName: ctx.sessionUser.name ?? '',
        signerEmail: ctx.sessionUser.email,
        notes: stayNotes(stays),
      },
      { url },
    );
  } catch (error) {
    if (error instanceof WorkbookRefusalError)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
    if (error instanceof ProposalPdfUnavailableError)
      throw new TRPCError({ code: 'BAD_GATEWAY', message: error.message, cause: error });
    throw error;
  }
  await proposalStaysFor(input, ctx, 'Proposal evidence expired during conversion');
  const party = quotePdfPartyName(
    input.agency,
    input.company,
    input.attention,
    quotePdfSenderDisplayName(fromAddress),
  );
  return {
    kind: 'quote_pdf',
    revisionId: result.revisionId,
    pdfHash: result.pdfHash,
    fileName: retargetQuotePdfFileName(
      result.fileName,
      party,
      quotePdfPartyName(input.agency, input.company),
    ),
    totalMinor: result.totalMinor,
    pdfBase64: Buffer.from(result.pdf).toString('base64'),
  };
}

/** Worker rebuild after HTTP disconnect. Missing payload fails closed. */
export async function generateQuotePdfFromLedger(request: QuotePdfRequest): Promise<QuotePdfResult> {
  if (!request.proposal || !request.transportId || !request.userId || request.signerEmail == null) {
    throw new Error('quote_pdf_proposal_missing');
  }
  const input = qualifiedProposalInput.parse(request.proposal);
  return buildQualifiedQuotePdf(
    input,
    {
      activeTransportId: request.transportId,
      sessionUser: {
        id: request.userId,
        email: request.signerEmail,
        name: request.signerName ?? null,
      },
    },
    undefined,
  );
}

export const quoteRunScreenshotInput = z
  .object({
    runId: z.string().regex(QUOTE_RUN_ID_PATTERN),
    name: z.string().regex(QUOTE_SCREENSHOT_NAME_PATTERN),
  })
  .strict();

const staffQuoteJobInput = z.union([
  z.object({ runId: z.string().uuid(), messageId: z.string().min(1).max(1024).optional() }).strict(),
  z.object({ input: staffQuoteInput }).strict(),
]);

export const workstationRouter = router({
  outlookSync: outlookSyncRouter,
  /** Own staff quote run status. HMS-free and cheap; the pane polls only while pending. */
  hmsQueueStatus: mailboxProcedure.query(async ({ ctx }): Promise<HmsQueueStatus> => {
    const run = latestQuoteRunFor({
      transportId: ctx.activeTransportId,
      userId: ctx.sessionUser.id,
    });
    const nowMs = Date.now();
    if (!run || run.phaseIndex > 0) return describeHmsQueueStatus({ run, nowMs });
    try {
      const db = getDb();
      const [holder, otherQuoteRuns] = await Promise.all([
        readPropertyLockHolder(db, run.lockKey),
        countOtherInFlightQuoteRuns(db, run.generationId),
      ]);
      return describeHmsQueueStatus({ run, nowMs, holder, otherQuoteRuns });
    } catch {
      return describeHmsQueueStatus({ nowMs });
    }
  }),
  /** Owner-scoped audit screenshot of a completed staff quote run, returned as a PNG data URL. */
  quoteRunScreenshot: mailboxProcedure
    .input(quoteRunScreenshotInput)
    .query(async ({ input, ctx }) => {
      await awaitPendingStaffQuote(input.runId);
      const [owned] = await getDb()
        .select({
          id: aiWorkflowRun.id,
          threadId: aiWorkflowRun.threadId,
          triggerMessageId: aiWorkflowRun.triggerMessageId,
        })
        .from(aiWorkflowRun)
        .innerJoin(aiDraftGeneration, eq(aiWorkflowRun.generationId, aiDraftGeneration.id))
        .where(
          and(
            eq(aiWorkflowRun.transportId, ctx.activeTransportId),
            eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id),
            sql`(${aiWorkflowRun.metrics} -> 'staffQuoteEvidence' ->> 'runId') = ${input.runId}`,
          ),
        )
        .limit(1);
      const unavailable = { status: 'unavailable' as const, reason: 'quote_run_unavailable' };
      if (!owned) return unavailable;
      const quoteTarget = await resolveHmsQuoteJobTarget({
        transportId: ctx.activeTransportId,
        threadId: owned.threadId,
        messageId: owned.triggerMessageId,
      });
      if (!quoteTarget.ok) return unavailable;
      let outputDir: string;
      try {
        const config = readInstalledStaffQuoteConfiguration(quoteTarget.target.propertyCode);
        if (config.owner.propertyCode !== quoteTarget.target.propertyCode) return unavailable;
        outputDir = config.outputDir;
      } catch {
        return unavailable;
      }
      return readQuoteRunScreenshot({ outputDir, runId: input.runId, name: input.name });
    }),
  staffQuoteSource: mailboxProcedure
    .input(z.object({ internetMessageId: z.string().min(1).max(1024) }).strict())
    .query(async ({ input, ctx }) => {
      const matches = await getDb()
        .select()
        .from(message)
        .where(
          and(
            eq(message.transportId, ctx.activeTransportId),
            eq(message.messageIdHeader, canonicalInternetMessageId(input.internetMessageId) ?? ''),
          ),
        )
        .limit(2);
      if (matches.length > 1)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Selected message identity is ambiguous' });
      const [mail] = matches;
      if (!mail) return { status: 'message_not_synced' as const };
      return {
        status: 'ready' as const,
        messageId: mail.id,
        threadId: mail.threadId,
        sourceHash: staffQuoteSourceHash(mail),
      };
    }),
  executeStaffQuote: mailboxProcedure
    .input(staffQuoteInput)
    .use(({ input, ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'quote',
          transportId: ctx.activeTransportId,
          messageId: input.messageId,
          userId: ctx.sessionUser.id,
          input: ledgerQuoteInput(input),
          inputDigest: quoteDigest(input),
        }),
        classifyStaffQuote,
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [mail] = await db
        .select({ threadId: message.threadId, direction: message.direction })
        .from(message)
        .where(and(eq(message.id, input.messageId), eq(message.transportId, ctx.activeTransportId)))
        .limit(1);
      if (!mail || mail.direction !== 'inbound')
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Selected inbound email not found' });
      await assertHmsQuoteOriginAllowed({
        transportId: ctx.activeTransportId,
        threadId: mail.threadId,
        messageId: input.messageId,
      });
      return runStaffQuote(
        input,
        {
          transportId: ctx.activeTransportId,
          user: {
            id: ctx.sessionUser.id,
            name: ctx.sessionUser.name ?? null,
            email: ctx.sessionUser.email,
          },
        },
        db,
      );
    }),
  queueStaffQuote: mailboxProcedure
    .input(staffQuoteInput.extend({ autoStart: z.literal(true).optional(), devEval: z.literal(true).optional() }))
    .mutation(async ({ input, ctx }) => {
      if (!hmsJobQueueEnabled()) return { runId: null };
      const { autoStart, devEval, ...quoteInput } = input;
      const db = getDb();
      const [mail] = await db
        .select()
        .from(message)
        .where(and(eq(message.id, input.messageId), eq(message.transportId, ctx.activeTransportId)))
        .limit(1);
      if (!mail || mail.direction !== 'inbound')
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Selected inbound email not found' });
      const quoteTarget = await assertHmsQuoteOriginAllowed({
        transportId: ctx.activeTransportId,
        threadId: mail.threadId,
        messageId: mail.id,
      });
      const staffQuoteUser = {
        id: ctx.sessionUser.id,
        name: ctx.sessionUser.name ?? null,
        email: ctx.sessionUser.email,
      };
      const request = {
        transportId: ctx.activeTransportId,
        threadId: mail.threadId,
        triggerMessageId: mail.id,
        workItemId: null,
        userId: staffQuoteUser.id,
        request: { kind: 'staff_quote' as const, input: quoteInput },
        priority: devEval ? HMS_JOB_PRIORITY_DEV : HMS_JOB_PRIORITY_USER,
        extraMetrics: {
          staffQuoteUser,
          ...(autoStart ? { autoStart: true } : {}),
          ...(devEval ? { devEval: true } : {}),
          ...hmsReadTargetJobMetrics(quoteTarget),
        },
      };
      const { run } = autoStart
        ? await queueAutoStaffQuoteHmsJob(request, db)
        : await enqueueHmsJob({ ...request, idempotencyKey: `hms-job:staff-quote:${randomUUID()}` }, db);
      return { runId: run.id };
    }),
  staffQuoteJob: mailboxProcedure.input(staffQuoteJobInput).query(({ input, ctx }) => {
    if (!hmsJobQueueEnabled()) return null;
    return readHmsJobView(
      'runId' in input
        ? {
            transportId: ctx.activeTransportId,
            userId: ctx.sessionUser.id,
            runId: input.runId,
            ...(input.messageId ? { messageId: input.messageId } : {}),
            staffQuoteOwnerId: ctx.sessionUser.id,
          }
        : {
            transportId: ctx.activeTransportId,
            userId: ctx.sessionUser.id,
            messageId: input.input.messageId,
            kind: 'staff_quote',
            input: input.input,
          },
      getDb(),
    );
  }),
  prepareBookingDraft: mailboxProcedure
    .input(prepareBookingDraftInput)
    .use(({ input, ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'booking_draft',
          transportId: ctx.activeTransportId,
          messageId: input.messageId,
          userId: ctx.sessionUser.id,
          workflowRunId: input.workflowRunId,
        }),
        classifyBookingDraft,
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
      await awaitPendingStaffQuote(input.workflowRunId);
      const [bound] = await getDb()
        .select({ run: aiWorkflowRun })
        .from(aiWorkflowRun)
        .innerJoin(aiDraftGeneration, eq(aiWorkflowRun.generationId, aiDraftGeneration.id))
        .where(
          and(
            eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id),
            eq(aiWorkflowRun.id, input.workflowRunId),
            eq(aiWorkflowRun.transportId, ctx.activeTransportId),
            eq(aiWorkflowRun.triggerMessageId, input.messageId),
          ),
        )
        .limit(1);
      if (!bound) return { status: 'unavailable' as const, reason: 'quote_revision_unavailable' };
      try {
        const staff = bound.run.metrics?.staffQuoteAttestation as
          | (StaffQuoteAttestation & { salesStrategy?: 'BAR' | 'Government' })
          | undefined;
        const { revision } = resolveLedgerProposal(bound.run, {
          transportId: ctx.activeTransportId,
          messageId: input.messageId,
          revisionRef: input.revisionRef,
          factRefs: proposalFactRefsForRevision(bound.run, input.revisionRef),
        });
        const occupancyScope = {
          transportId: ctx.activeTransportId, threadId: bound.run.threadId, messageId: input.messageId,
          propertyCode: revision.propertyCode,
        };
        if (!(await quoteSourceProofIsCurrent(getDb(), occupancyFromRevision(revision), occupancyScope, quoteSourceProofFromRun(bound.run)))) {
          return { status: 'unavailable' as const, reason: 'child_occupancy_incomplete' };
        }
        const cloned = structuredClone(revision);
        const rowPrices = storedRowPrices(bound.run, cloned.id);
        const extraTotalMinor =
          quotedTotalWithStoredExtras(cloned, bound.run) - pricedRoomTotal(cloned, rowPrices);
        const draft = await buildBookingDrafts({
          analysis: input.analysis,
          revision: cloned,
          defaults: bookingCodeDefaults(partyClassFromRevision(cloned, staff)),
          messageId: input.messageId,
          extraTotalMinor,
          rowPrices,
        });
        if (!(await quoteSourceProofIsCurrent(getDb(), occupancyFromRevision(revision), occupancyScope, quoteSourceProofFromRun(bound.run)))) {
          return { status: 'unavailable' as const, reason: 'child_occupancy_incomplete' };
        }
        return {
          status: 'ready' as const,
          draft,
          options: createRequestFieldOptions(hmsReadTargetForTransport(ctx.activeTransportId).propertyCode),
          messageId: input.messageId,
          selectionEpoch: input.selectionEpoch,
          inputRevision: input.inputRevision,
          revisionRef: input.revisionRef,
          workflowRunId: input.workflowRunId,
        };
      } catch (error) {
        return {
          status: 'unavailable' as const,
          reason: error instanceof Error ? error.message : 'quote_revision_unavailable',
        };
      }
    }),
  prepareUnquotedBookingDraft: mailboxProcedure
    .input(prepareUnquotedBookingDraftInput)
    .mutation(async ({ input, ctx }) => {
      const unavailable = { status: 'unavailable' as const, reason: 'prefill_unavailable' };
      if (!isUnquotedSingleStayNewBooking(input.analysis)) {
        return { status: 'unavailable' as const, reason: 'not_a_single_stay_new_booking' };
      }
      const groups = input.analysis.groups.filter((g) => g.arrival?.trim());
      const group = groups[0];
      if (
        !group?.arrival ||
        (isCenturionQuoteTransport(ctx.activeTransportId) && !group.departure) ||
        groups.length !== 1 ||
        groups.some((r) => !Number.isInteger(r.rooms) || (r.rooms ?? 0) < 1 || !Number.isInteger(r.adultsPerRoom) || (r.adultsPerRoom ?? 0) < 1)
      ) {
        return unavailable;
      }
      const [selected] = isCenturionQuoteTransport(ctx.activeTransportId) ? await getDb().select({ threadId: message.threadId }).from(message)
        .where(and(eq(message.id, input.messageId), eq(message.transportId, ctx.activeTransportId)))
        .limit(1) : [{ threadId: '' }];
      if (!selected) return unavailable;
      const occupancyScope = { transportId: ctx.activeTransportId, threadId: selected.threadId, messageId: input.messageId };
      const occupancy = { groups: [{
        arrivalDate: group.arrival, departureDate: group.departure ?? '',
        quantity: group.rooms ?? 0, adults: group.adultsPerRoom ?? 0,
        children: group.childAges.length, childAges: group.childAges,
      }] };
      if (isCenturionQuoteTransport(ctx.activeTransportId) && !(await singleStayOccupancyIsCurrent(getDb(), occupancy, occupancyScope))) {
        return { status: 'unavailable' as const, reason: 'child_occupancy_incomplete' };
      }
      const party = input.analysis.party;
      try {
        const propertyCode = hmsReadTargetForTransport(ctx.activeTransportId).propertyCode;
        const prefill = await buildCreatePrefill({
          arrival: group.arrival, departure: group.departure ?? null, nights: null,
          rooms: groups.flatMap((row) => Array.from({ length: row.rooms ?? 0 }, (_, i) => ({
            adults: row.adultsPerRoom ?? 0, childAges: [...row.childAges],
            roomTypeText: row.roomPreference ?? null, guestName: row.guestNames[i] ?? null,
          }))),
          boardText: group.board ?? null, rateText: input.rateCode ?? null,
          agencyName: party.kind === 'agency' ? party.name : null,
          organizationName: party.kind === 'organization' || party.kind === 'government' ? party.name : null,
          voucherNumber: null, bookerName: null, bookerEmail: null, billingReference: party.reference,
          paidBy: null, defaults: { track: null, sourceOfBusiness: null, guaranteeType: null },
          propertyCode,
        });
        if (!prefill.requests.length) return unavailable;
        if (isCenturionQuoteTransport(ctx.activeTransportId) && !(await singleStayOccupancyIsCurrent(getDb(), occupancy, occupancyScope))) {
          return { status: 'unavailable' as const, reason: 'child_occupancy_incomplete' };
        }
        return {
          status: 'ready' as const,
          draft: bookingDraftFromPrefill({
            requests: prefill.requests, missing: prefill.missing, schemaErrors: prefill.schemaErrors,
            board: prefillBoardFromLuna(group.board),
          }),
          options: createRequestFieldOptions(propertyCode),
          messageId: input.messageId, selectionEpoch: input.selectionEpoch, inputRevision: input.inputRevision,
          revisionRef: UNQUOTED_BOOKING_REVISION_REF,
        };
      } catch {
        return unavailable;
      }
    }),
  listThreadQuoteRevisions: mailboxProcedure
    .input(listThreadQuoteRevisionsInput)
    .query(async ({ input, ctx }) => {
      const rows = await getDb()
        .select({
          id: aiWorkflowRun.id,
          transportId: aiWorkflowRun.transportId,
          threadId: aiWorkflowRun.threadId,
          state: aiWorkflowRun.state,
          createdAt: aiWorkflowRun.createdAt,
          finishedAt: aiWorkflowRun.finishedAt,
          metrics: aiWorkflowRun.metrics,
          readResult: aiWorkflowRun.readResult,
        })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.transportId, ctx.activeTransportId),
            eq(aiWorkflowRun.threadId, input.threadId),
            eq(aiWorkflowRun.state, 'succeeded'),
          ),
        )
        .orderBy(desc(aiWorkflowRun.createdAt))
        .limit(20);
      return {
        revisions: collectThreadQuoteRevisions(rows, {
          transportId: ctx.activeTransportId,
          threadId: input.threadId,
        }),
      };
    }),
  getPriorStaffQuoteRequote: mailboxProcedure
    .input(getPriorStaffQuoteRequoteInput)
    .query(async ({ input, ctx }) => {
      await awaitPendingStaffQuote(input.workflowRunId);
      const [run] = await getDb()
        .select({
          id: aiWorkflowRun.id,
          transportId: aiWorkflowRun.transportId,
          threadId: aiWorkflowRun.threadId,
          state: aiWorkflowRun.state,
          metrics: aiWorkflowRun.metrics,
        })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.id, input.workflowRunId),
            eq(aiWorkflowRun.transportId, ctx.activeTransportId),
            eq(aiWorkflowRun.threadId, input.threadId),
          ),
        )
        .limit(1);
      if (!run) return { status: 'unavailable' as const, reason: 'not_found' as const };
      const payload = priorStaffQuoteRequotePayload(run, input.revisionRef);
      if (!payload) return { status: 'unavailable' as const, reason: 'not_found' as const };
      return { status: 'ready' as const, payload };
    }),
  usePriorQuoteForBooking: mailboxProcedure
    .input(usePriorQuoteForBookingInput)
    .mutation(async ({ input, ctx }) => {
      await awaitPendingStaffQuote(input.workflowRunId);
      const [run] = await getDb()
        .select({
          id: aiWorkflowRun.id,
          transportId: aiWorkflowRun.transportId,
          threadId: aiWorkflowRun.threadId,
          triggerMessageId: aiWorkflowRun.triggerMessageId,
          state: aiWorkflowRun.state,
          createdAt: aiWorkflowRun.createdAt,
          finishedAt: aiWorkflowRun.finishedAt,
          metrics: aiWorkflowRun.metrics,
          readResult: aiWorkflowRun.readResult,
        })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.id, input.workflowRunId),
            eq(aiWorkflowRun.transportId, ctx.activeTransportId),
            eq(aiWorkflowRun.threadId, input.threadId),
          ),
        )
        .limit(1);
      if (!run) return { status: 'unavailable' as const, reason: 'not_found' as const };
      const resolved = resolvePriorQuoteForBooking(run, {
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
        revisionRef: input.revisionRef,
        analysis: input.analysis,
      });
      if (resolved.status !== 'ready') return resolved;
      const occupancyScope = { transportId: ctx.activeTransportId, threadId: input.threadId,
        messageId: input.messageId, propertyCode: resolved.revision.propertyCode };
      const proof = quoteSourceProofFromRun(run);
      // The original source and the selected single-row follow-up must still match the same saved preferences.
      const occupancyCurrent = async () => await quoteSourceProofIsCurrent(getDb(), occupancyFromRevision(resolved.revision),
        { ...occupancyScope, messageId: run.triggerMessageId }, proof) &&
        (run.triggerMessageId === input.messageId ||
          await quoteSourceProofMatchesSingleStay(getDb(), resolved.revision, occupancyScope, proof));
      if (!(await occupancyCurrent())) return { status: 'unavailable' as const, reason: 'child_occupancy_incomplete' as const };
      const staff = run.metrics?.staffQuoteAttestation as
        | (StaffQuoteAttestation & { salesStrategy?: 'BAR' | 'Government' })
        | undefined;
      const rowPrices = storedRowPrices(run, resolved.revision.id);
      const extraTotalMinor =
        quotedTotalWithStoredExtras(resolved.revision, run) - pricedRoomTotal(resolved.revision, rowPrices);
      const draft = await buildBookingDrafts({
        analysis: input.analysis,
        revision: structuredClone(resolved.revision),
        defaults: bookingCodeDefaults(partyClassFromRevision(resolved.revision, staff)),
        messageId: input.messageId,
        extraTotalMinor,
        rowPrices,
      });
      if (!(await occupancyCurrent())) return { status: 'unavailable' as const, reason: 'child_occupancy_incomplete' as const };
      return {
        status: 'ready' as const,
        draft,
        options: createRequestFieldOptions(hmsReadTargetForTransport(ctx.activeTransportId).propertyCode),
        messageId: input.messageId,
        selectionEpoch: input.selectionEpoch,
        inputRevision: input.inputRevision,
        revisionRef: resolved.revision.id,
        workflowRunId: run.id,
        totalMinor: quotedTotalWithStoredExtras(resolved.revision, run),
        currency: resolved.revision.currency,
        arrivalDate: resolved.revision.groups[0]!.arrivalDate,
        departureDate: resolved.revision.groups.at(-1)!.departureDate,
        roomCode: resolved.revision.groups[0]!.roomCode,
        rateCode: resolved.revision.groups[0]!.rateCode,
        board: resolved.revision.groups[0]!.board,
        // Whether this quote's total already has the once-per-quote extras (the shuttle, a flat other charge).
        onceExtras: revisionCarriesOnceExtras(run, resolved.revision.id),
      };
    }),
  // Native refusals happen inside Outlook after the server grant; without this the server sees only
  // consumed tickets. Logs the add-in's own error text with EntryID-like tokens masked.
  reportBridgeFailure: mailboxProcedure
    .input(z.object({
      action: z.string().regex(/^[A-Z_]{1,64}$/),
      code: z.string().regex(/^[A-Z0-9_]{1,64}$/).optional(),
      message: z.string().max(300),
    }).strict())
    .mutation(({ input, ctx }) => {
      const mask = (text: string) => text.replace(/[A-Za-z0-9+/=_-]{24,}/g, '<id>').slice(0, 200);
      console.warn('outlook_bridge_native_failure', { transportId: ctx.activeTransportId, action: input.action,
        code: input.code ?? null, message: mask(input.message) });
      return { logged: true };
    }),
  bridgeTicket: publicProcedure
    .input(
      z
        .object({
          deviceId: z.string().uuid(),
          paneChallenge: z.string().length(43),
          action: z.string().min(1).max(64),
          storeId: z.string().min(1).max(2048).optional(),
          operationId: z.string().min(1).max(128).optional(),
          resources: z.array(z.string().min(1).max(512)).max(25).optional(),
          sourceFolderId: z.string().min(1).max(512).optional(),
          destinationFolderId: z.string().min(1).max(512).optional(),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      // Public procedure deliberately skips the test-only injected sessionUser shortcut.
      // A real Better Auth cookie and original live DB session are mandatory.
      const transportId = ctx.reqHeaders.get('x-zero-active-transport');
      if (!transportId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Bridge ticket denied' });
      try {
        return await issueBridgeTicket(getDb(), ctx.auth, ctx.reqHeaders, {
          ...input,
          transportId,
        });
      } catch (error) {
        if (error instanceof BridgeTicketDeniedError) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Bridge ticket denied' });
        }
        // Main's onError logger sees this category, not the underlying database
        // error (which may contain a connection string or request parameters).
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Bridge ticket unavailable',
        });
      }
    }),
  ping: privateProcedure.input(workstationPingInput).mutation(async ({ input }) => {
    return {
      status: 'ok' as const,
      receivedUser: input.workstationUser,
      receivedEmail: input.outlookEmail,
      serverTime: new Date().toISOString(),
    };
  }),
  qualifiedProposalChoices: mailboxProcedure
    .input(z.object({ internetMessageId: z.string().min(1).max(1024) }).strict())
    .query(async ({ input, ctx }) => {
      const matches = await getDb()
        .select()
        .from(message)
        .where(
          and(
            eq(message.transportId, ctx.activeTransportId),
            eq(message.messageIdHeader, canonicalInternetMessageId(input.internetMessageId) ?? ''),
          ),
        )
        .limit(2);
      if (matches.length > 1)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Selected message identity is ambiguous' });
      const [mail] = matches;
      if (!mail) return { status: 'message_not_synced' as const, choices: [] };
      await awaitPendingStaffQuote(mail.id);
      const runs = await getDb()
        .select({ run: aiWorkflowRun })
        .from(aiWorkflowRun)
        .innerJoin(aiDraftGeneration, eq(aiWorkflowRun.generationId, aiDraftGeneration.id))
        .where(
          and(
            eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id),
            eq(aiWorkflowRun.transportId, ctx.activeTransportId),
            eq(aiWorkflowRun.triggerMessageId, mail.id),
            eq(aiWorkflowRun.state, 'succeeded'),
          ),
        )
        .orderBy(desc(aiWorkflowRun.createdAt))
        .limit(10);
      const choices: rQualifiedChoice[] = [];
      let importedOfferHeld = false;
      const [latestStaff] = await getDb()
        .select({ id: aiDraftGeneration.id })
        .from(aiDraftGeneration)
        .where(
          and(
            eq(aiDraftGeneration.transportId, ctx.activeTransportId),
            eq(aiDraftGeneration.threadId, mail.threadId),
            eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id),
            eq(aiDraftGeneration.model, 'staff-approved-native'),
            sql`${aiDraftGeneration.contextMessageIds} @> ${JSON.stringify([mail.id])}::jsonb`,
          ),
        )
        .orderBy(desc(aiDraftGeneration.createdAt))
        .limit(1);
      for (const { run } of runs) {
        const staff = run.metrics?.staffQuoteAttestation as StaffQuoteAttestation | undefined;
        if (
          staff &&
          (run.generationId !== latestStaff?.id || staff.sourceHash !== staffQuoteSourceHash(mail))
        )
          continue;
        const result = run.metrics?.reservationistResult as
          | {
              quoteRevisionIds?: string[];
              proposalFacts?: Array<{ ref: string; facts: AuthorizedProposalFacts }>;
            }
          | undefined;
        for (const ref of result?.quoteRevisionIds ?? []) {
          try {
            const bundles = (result?.proposalFacts ?? []).filter((f) => f.facts.revisionId === ref);
            if (bundles.length > 1) continue;
            const factRefs = bundles.map((f) => f.ref);
            const { revision, facts } = resolveLedgerProposal(run, {
              transportId: ctx.activeTransportId,
              messageId: mail.id,
              revisionRef: ref,
              factRefs,
            });
            if (!(await quoteSourceProofIsCurrent(getDb(), occupancyFromRevision(revision), {
              transportId: ctx.activeTransportId, threadId: mail.threadId, messageId: mail.id,
              propertyCode: revision.propertyCode,
            }, quoteSourceProofFromRun(run)))) continue;
            choices.push({
              workflowRunId: run.id,
              messageId: mail.id,
              threadId: mail.threadId,
              revisionRef: revision.id,
              factRefs,
              totalMinor:
                pricedRoomTotal(revision, storedRowPrices(run, revision.id)) +
                (facts
                  ? deriveAuthorizedExtraLines(revision, facts).reduce(
                      (sum, line) => sum + line.totalMinor,
                      0,
                    )
                  : 0),
              currency: revision.currency,
              arrivalDate: revision.groups[0].arrivalDate,
              departureDate: revision.groups.at(-1)!.departureDate,
              description: deriveQuoteLines(revision, storedRowPrices(run, revision.id))
                .map((l) => l.description)
                .join('; '),
            });
          } catch {}
        }
      }
      for (const { run } of runs) {
        if (latestStaff && run.generationId !== latestStaff.id) continue;
        const result = run.metrics?.reservationistResult as
          | {
              readiness?: string;
              importedOffers?: ImportedOffer[];
              approvedOverrides?: Awaited<
                ReturnType<
                  typeof import('../../quote-proposal/quote-revision.js').resolveApprovedOverride
                >
              >[];
            }
          | undefined;
        if (result?.readiness !== 'ready_for_staff_review') continue;
        for (const offer of result.importedOffers ?? []) {
          if (isCenturionQuoteScope({ transportId: ctx.activeTransportId, propertyCode: offer.propertyCode })) {
            importedOfferHeld = true; continue;
          }
          try {
            resolveLedgerSourceProposal(run, {
              transportId: ctx.activeTransportId,
              messageId: mail.id,
              revisionRef: offer.id,
              factRefs: [],
              kind: 'imported_offer',
            });
            renderImportedProposalHtml(offer, {
              attention: '',
              company: '',
              clientEmail: '',
              clientTelephone: '',
              agency: '',
              signerName: '',
              signerEmail: '',
            });
            choices.push({
              kind: 'imported_offer',
              workflowRunId: run.id,
              messageId: mail.id,
              threadId: mail.threadId,
              revisionRef: offer.id,
              factRefs: [],
              totalMinor: offer.totalMinor,
              currency: offer.currency,
              arrivalDate: offer.printedDate,
              departureDate: offer.validUntil,
              description: 'Original agreed offer; availability unproven',
            });
          } catch {}
        }
        for (const offer of result.approvedOverrides ?? []) {
          try {
            resolveLedgerSourceProposal(run, {
              transportId: ctx.activeTransportId,
              messageId: mail.id,
              revisionRef: offer.id,
              factRefs: [],
              kind: 'approved_override',
            });
            if (!(await quoteSourceProofIsCurrent(getDb(), occupancyFromRevision(offer.sourceRevision), {
              transportId: ctx.activeTransportId, threadId: mail.threadId, messageId: mail.id,
              propertyCode: offer.sourceRevision.propertyCode,
            }, quoteSourceProofFromRun(run)))) continue;
            renderApprovedOverrideHtml(offer, {
              attention: '',
              company: '',
              clientEmail: '',
              clientTelephone: '',
              agency: '',
              signerName: '',
              signerEmail: '',
            });
            choices.push({
              kind: 'approved_override',
              workflowRunId: run.id,
              messageId: mail.id,
              threadId: mail.threadId,
              revisionRef: offer.id,
              factRefs: [],
              totalMinor: offer.approvedTotalMinor,
              currency: offer.currency,
              arrivalDate: offer.sourceRevision.groups[0].arrivalDate,
              departureDate: offer.sourceRevision.groups.at(-1)!.departureDate,
              description: 'Approved staff adjustment; ' + offer.reason,
            });
          } catch {}
        }
      }
      return {
        status: choices.length ? ('ready' as const) : ('awaiting_qualified_quote' as const),
        threadId: mail.threadId,
        messageId: mail.id,
        choices,
        ...(importedOfferHeld ? { reason: importedOfferOccupancyHold } : {}),
      };
    }),
  qualifiedQuoteProposalPdf: mailboxProcedure
    .input(qualifiedProposalInput)
    .use(({ input, ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'pdf',
          transportId: ctx.activeTransportId,
          messageId: input.messageId,
          userId: ctx.sessionUser.id,
          workflowRunId: input.workflowRunId,
        }),
        classifyPdf,
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
      await awaitPendingStaffQuote(input.workflowRunId);
      if (!emailsMatch(ctx.transportEmail, input.outlookEmail))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'OUTLOOK_EMAIL_MISMATCH' });
      const documentKey = quotePdfJobIdentity(input);
      const asPdf = (artifact: QuotePdfResult) => ({
        revisionId: artifact.revisionId,
        documentKey,
        pdfHash: artifact.pdfHash,
        fileName: artifact.fileName,
        totalMinor: artifact.totalMinor,
        pdfBase64: artifact.pdfBase64,
      });
      const [mail] = await getDb()
        .select({ fromAddress: message.fromAddress, threadId: message.threadId })
        .from(message)
        .where(and(eq(message.id, input.messageId), eq(message.transportId, ctx.activeTransportId)))
        .limit(1);
      let jobRun: Awaited<ReturnType<typeof enqueueQuotePdfJob>>['run'] | undefined;
      if (input.workItemId) {
        if (!mail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Selected inbound email not found' });
        const stays = await proposalStaysFor(input, ctx, 'Proposal evidence is not ready');
        const propertyCode = stays[0]!.revision.propertyCode;
        if (stays.some((stay) => stay.revision.propertyCode !== propertyCode))
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Quote stays must belong to the same hotel.' });
        const stored = await readQuotePdfJob({
          transportId: ctx.activeTransportId,
          workItemId: input.workItemId,
          revisionId: documentKey,
        });
        if (stored?.result) return asPdf(stored.result);
        const enqueued = await enqueueQuotePdfJob({
          transportId: ctx.activeTransportId,
          threadId: mail.threadId,
          triggerMessageId: input.messageId,
          workItemId: input.workItemId,
          revisionId: documentKey,
          propertyCode,
          userId: ctx.sessionUser.id,
          signerName: ctx.sessionUser.name ?? '',
          signerEmail: ctx.sessionUser.email,
          proposal: input,
        });
        jobRun = enqueued.run;
        const already = quotePdfResultOf(enqueued.run);
        if (already) return asPdf(already);
      }
      const artifact = await buildQualifiedQuotePdf(input, ctx, mail?.fromAddress);
      if (jobRun) return asPdf(await persistQuotePdfResult(jobRun.id, artifact));
      return asPdf(artifact);
    }),
  quotePdfJob: mailboxProcedure
    .input(
      z
        .object({
          workItemId: z.string().uuid(),
          revisionRef: z.string().min(1),
          additionalStays: z.array(qualifiedStayInput).max(62).default([]),
          attention: z.string().max(256).default(''),
          company: z.string().max(256).default(''),
          clientEmail: z.string().max(256).default(''),
          clientTelephone: z.string().max(128).default(''),
          agency: z.string().max(256).default('Quote'),
          notes: z.string().trim().max(1000).optional(),
        })
        .strict(),
    )
    .query(async ({ input, ctx }) => {
      const job = await readQuotePdfJob({
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        revisionId: quotePdfJobIdentity(input),
      });
      if (!job?.result || !isCenturionQuoteTransport(ctx.activeTransportId)) return job;
      const [stored] = await getDb().select({ request: aiWorkflowRun.readRequest, messageId: aiWorkflowRun.triggerMessageId })
        .from(aiWorkflowRun)
        .where(and(eq(aiWorkflowRun.id, job.runId), eq(aiWorkflowRun.transportId, ctx.activeTransportId)))
        .limit(1);
      const request = quotePdfRequestSchema.safeParse(stored?.request);
      const proposal = qualifiedProposalInput.safeParse(request.success ? request.data.proposal : null);
      if (!request.success || !proposal.success || request.data.workItemId !== input.workItemId ||
        request.data.transportId !== ctx.activeTransportId || proposal.data.workItemId !== input.workItemId ||
        proposal.data.messageId !== stored?.messageId) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This quote is no longer ready. Run it again.' });
      }
      if (request.data.propertyCode === 'HRDAV') return job;
      await proposalStaysFor(proposal.data, ctx, 'Proposal evidence is not ready');
      return job;
    }),
  /**
   * Excel twin of qualifiedQuoteProposalPdf: the same ownership, transport and currency checks, then every approved
   * stay's revision and authorised extras written into the staff quotation template.
   */
  quoteWorkbook: mailboxProcedure
    .input(qualifiedProposalInput)
    .mutation(async ({ input, ctx }) => {
      await awaitPendingStaffQuote(input.workflowRunId);
      if (!emailsMatch(ctx.transportEmail, input.outlookEmail))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'OUTLOOK_EMAIL_MISMATCH' });
      const stays = await proposalStaysFor(input, ctx, 'Proposal evidence is not ready');
      let workbook: ReturnType<typeof quoteWorkbookForStays>;
      try {
        workbook = quoteWorkbookForStays({
          stays,
          header: {
            attention: input.attention,
            company: input.company,
            clientEmail: input.clientEmail,
            clientTelephone: input.clientTelephone,
            signerName: ctx.sessionUser.name ?? '',
            signerEmail: ctx.sessionUser.email,
          },
          // Fresh staff runs use their attested note; prepared prices carry the pane's reviewed header note.
          note: stayNotes(stays),
        });
      } catch (error) {
        if (error instanceof WorkbookRefusalError)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Excel could not be built from this quote' });
      }
      await proposalStaysFor(input, ctx, 'Proposal evidence is not ready');
      const groups = stays.flatMap((stay) => stay.revision.groups);
      const arrival = groups.map((group) => group.arrivalDate).sort()[0] ?? stays[0]!.revision.authoredDate;
      const departure = groups.map((group) => group.departureDate).sort().at(-1) ?? arrival;
      return {
        fileName: quoteWorkbookFileName(input.agency.trim() || input.company, arrival, departure),
        xlsxBase64: Buffer.from(workbook.bytes).toString('base64'),
        totalMinor: workbook.totalMinor,
        revisionId: documentIdFor(stays),
      };
    }),
  sourceQuoteProposalPdf: mailboxProcedure
    .input(
      qualifiedProposalInput
        .omit({ additionalStays: true, notes: true })
        .extend({ kind: z.enum(['imported_offer', 'approved_override']) })
        .strict(),
    )
    .use(({ input, ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'source_pdf',
          transportId: ctx.activeTransportId,
          messageId: input.messageId,
          userId: ctx.sessionUser.id,
          workflowRunId: input.workflowRunId,
        }),
        classifyPdf,
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
      await awaitPendingStaffQuote(input.workflowRunId);
      if (!emailsMatch(ctx.transportEmail, input.outlookEmail))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'OUTLOOK_EMAIL_MISMATCH' });
      const [bound] = await getDb()
        .select({ run: aiWorkflowRun })
        .from(aiWorkflowRun)
        .innerJoin(aiDraftGeneration, eq(aiWorkflowRun.generationId, aiDraftGeneration.id))
        .where(
          and(
            eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id),
            eq(aiWorkflowRun.id, input.workflowRunId),
            eq(aiWorkflowRun.transportId, ctx.activeTransportId),
            eq(aiWorkflowRun.triggerMessageId, input.messageId),
          ),
        )
        .limit(1);
      if (!bound) throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal source not found' });
      let selected: ReturnType<typeof resolveLedgerSourceProposal>;
      const assertNoNewerApproval = async () => {
        const [latest] = await getDb().select({ id: aiDraftGeneration.id }).from(aiDraftGeneration)
          .where(and(eq(aiDraftGeneration.transportId, ctx.activeTransportId), eq(aiDraftGeneration.threadId, bound.run.threadId),
            eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id), eq(aiDraftGeneration.model, 'staff-approved-native'),
            sql`${aiDraftGeneration.contextMessageIds} @> ${JSON.stringify([input.messageId])}::jsonb`))
          .orderBy(desc(aiDraftGeneration.createdAt)).limit(1);
        if (latest && latest.id !== bound.run.generationId)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Newer stay inputs were approved; use the current quote' });
      };
      await assertNoNewerApproval();
      try {
        selected = resolveLedgerSourceProposal(bound.run, {
          transportId: ctx.activeTransportId,
          messageId: input.messageId,
          revisionRef: input.revisionRef,
          factRefs: input.factRefs,
          kind: input.kind,
        });
      } catch {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Proposal evidence is not ready',
        });
      }
      if (selected.kind === 'imported_offer' &&
        isCenturionQuoteScope({ transportId: ctx.activeTransportId, propertyCode: selected.propertyCode }))
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: importedOfferOccupancyHold });
      const assertSourceOccupancy = async () => {
        if (selected.kind === 'approved_override' &&
          !(await quoteSourceProofIsCurrent(getDb(), occupancyFromRevision(selected.sourceRevision), {
            transportId: ctx.activeTransportId, threadId: bound.run.threadId, messageId: input.messageId,
            propertyCode: selected.sourceRevision.propertyCode,
          }, quoteSourceProofFromRun(bound.run)))) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED',
            message: draftQuoteOccupancyMessage });
        }
      };
      await assertSourceOccupancy();
      const header = {
        ...input,
        signerName: ctx.sessionUser.name ?? '',
        signerEmail: ctx.sessionUser.email,
      };
      const html =
          selected.kind === 'imported_offer'
            ? renderImportedProposalHtml(selected, header)
            : renderApprovedOverrideHtml(selected, header),
        totalMinor =
          selected.kind === 'imported_offer' ? selected.totalMinor : selected.approvedTotalMinor;
      const url = process.env.GOTENBERG_URL?.trim();
      if (!url)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GOTENBERG_URL missing' });
      const pdf = await convertProposalHtml(html, { url });
      await assertNoNewerApproval();
      await assertSourceOccupancy();
      try {
        resolveLedgerSourceProposal(bound.run, {
          transportId: ctx.activeTransportId, messageId: input.messageId,
          revisionRef: input.revisionRef, factRefs: input.factRefs, kind: input.kind,
        });
      } catch {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Proposal evidence expired during conversion' });
      }
      return {
        revisionId: input.revisionRef,
        pdfHash: createHash('sha256').update(pdf).digest('hex'),
        totalMinor,
        fileName: 'Quote - Source offer.pdf',
        pdfBase64: Buffer.from(pdf).toString('base64'),
      };
    }),
  quoteProposalPdf: mailboxProcedure
    .input(quoteProposalPdfInput)
    .mutation(async ({ input, ctx }) => {
      // Resolve the selected transport through the same mailbox-access guard
      // as other mail routes. Access to a *different* shared mailbox must not
      // let a pane mix that address into the current quotation workflow.
      if (!emailsMatch(ctx.transportEmail, input.outlookEmail)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'OUTLOOK_EMAIL_MISMATCH',
        });
      }
      const propertyCode = hmsReadTargetForTransport(ctx.activeTransportId).propertyCode;
      const gotenbergUrl = process.env.GOTENBERG_URL?.trim();
      if (!gotenbergUrl) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'GOTENBERG_URL missing',
        });
      }
      try {
        const { fileName, pdf } = await buildQuoteProposalPdf(
          {
            ...input,
            propertyCode,
          },
          { name: ctx.sessionUser.name?.trim() || '', email: ctx.sessionUser.email },
          gotenbergUrl,
        );
        return { fileName, pdfBase64: Buffer.from(pdf).toString('base64') };
      } catch (err) {
        throw new TRPCError({
          code: err instanceof ProposalInputError ? 'BAD_REQUEST' : 'BAD_GATEWAY',
          message: err instanceof Error ? err.message : 'gotenberg convert failed',
        });
      }
    }),
});
