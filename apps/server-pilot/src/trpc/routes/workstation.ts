import { outlookSyncRouter } from './outlook-sync.js';
import {
  approvedStaySpan,
  combinedStayCurrencyProblem,
  staffQuoteInput,
  staffQuoteCurrencyProblem,
  staffQuoteSourceHash,
  prepareStaffQuote,
  executeStaffQuote,
  attestStaffQuote,
  buildStaffProposalFacts,
  partyContractReviewNote,
  partyNames,
  quoteWithPartyFallback,
  type StaffQuoteAttestation,
  type StaffQuoteInput,
  type StaffQuoteParties,
} from '../../ai/staff-quote-workflow.js';
import { otherBoardContractNotes, type RateOption } from '../../ai/rate-options.js';
import { quoteRateContextEnabled } from '../../ai/quote-rate-switch.js';
import { verifyPartyPick } from '../../ai/pane-party-lookup.js';
import { bookingCodeDefaults, type PartyClass } from '../../ai/booking-code-rules.js';
import { buildBookingDrafts, createRequestFieldOptions } from '../../ai/booking-draft.js';
import {
  collectThreadQuoteRevisions,
  priorStaffQuoteRequotePayload,
  proposalFactRefsForRevision,
  quotedTotalWithStoredExtras,
  resolvePriorQuoteForBooking,
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
  type AuthorizedProposalFacts,
} from '../../quote-proposal/quote-lines.js';
import {
  quoteWorkbookForStays,
  quoteWorkbookFileName,
  WorkbookRefusalError,
} from '../../quote-proposal/quote-workbook.js';
import {
  getInstalledStaffQuoteServices,
  readInstalledStaffQuoteConfiguration,
} from '../../ai/staff-quote-installation.js';
import {
  BridgeTicketDeniedError,
  issueBridgeTicket,
} from '../../outlook-security/authorization.js';
import { buildQuoteProposalPdf, ProposalInputError } from '../../quote-proposal/proposal-pdf.js';
import type { QuoteRevision, ImportedOffer } from '../../quote-proposal/quote-revision.js';
import { quoteDigest } from '../../quote-proposal/quote-revision.js';
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
  createPostgresPropertyReadLock,
  propertyReadLockKey,
} from '../../hms/property-read-lock.js';
import {
  beginQuoteRun,
  countOtherInFlightQuoteRuns,
  describeHmsQueueStatus,
  latestQuoteRunFor,
  readPropertyLockHolder,
  type HmsQueueStatus,
} from '../../hms/property-queue-state.js';
import {
  listQuoteRunScreenshots,
  quoteRunIdFromEvidenceDirectory,
  QUOTE_RUN_ID_PATTERN,
  QUOTE_SCREENSHOT_NAME_PATTERN,
  readQuoteRunScreenshot,
} from '../../ai/staff-quote-evidence.js';
import {
  awaitPendingStaffQuote,
  quoteTraceAsyncEnabled,
  registerPendingStaffQuote,
} from '../../ai/staff-quote-trace-async.js';
import { QUOTE_MEALS } from '../../quote-proposal/description.js';
import { emailsMatch } from '../../quote-proposal/identity.js';
import { and, eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { TRPCError } from '@trpc/server';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const HMS_NOT_RESPONDED_MESSAGE =
  "HMS didn't respond as expected. Try again; if it fails twice, quote in HMS directly.";
const HMS_UNPRICEABLE_COMBINATION_MESSAGE =
  "HMS couldn't price this exact combination of rooms, guests and meals. Try one room type or B&B first, or quote this one in HMS.";
const HMS_EXECUTION_CODES = new Set([
  'EXECUTION_FAILURE',
  'AUTHENTICATED_SHELL_TIMEOUT',
  'staff_quote_native_unavailable',
  'staff_quote_native_capture_unavailable',
  'native_quote_capture_unavailable',
  'native_quote_read_unavailable',
]);
const HMS_EXECUTION_PHASE = /^(login|hotel_availability|search|details|run|execution)$/;

// Identifiers only: free-text error messages can carry PMS or guest data, so they never reach logs.
/**
 * Prices the staff extras for one approved revision. Invalid or oversize extras are the caller's mistake,
 * so any failure here is a BAD_REQUEST, never an internal error.
 */
export function staffExtrasOrBadRequest(
  input: StaffQuoteInput,
  scope: Parameters<typeof buildStaffProposalFacts>[1],
  prepared: Parameters<typeof buildStaffProposalFacts>[2],
  revision: QuoteRevision,
): { proposal: ReturnType<typeof buildStaffProposalFacts>; extraTotal: number } {
  try {
    const proposal = buildStaffProposalFacts(input, scope, prepared, revision);
    const extraTotal = proposal.facts
      ? deriveAuthorizedExtraLines(revision, proposal.facts).reduce((sum, line) => sum + line.totalMinor, 0)
      : 0;
    return { proposal, extraTotal };
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The extras on this quote are not valid. Check the amounts and counts, then run the quote again.',
    });
  }
}

export function staffQuoteFailureCode(error: unknown): string {
  const raw = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const candidate = typeof raw === 'string' ? raw : error instanceof Error ? error.message : '';
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(candidate) ? candidate : 'unknown';
}

export function staffQuoteFailurePhase(error: unknown): string {
  const phase = error && typeof error === 'object' && 'phase' in error ? error.phase : undefined;
  return typeof phase === 'string' && /^[a-z_]{1,40}$/.test(phase) ? phase : 'unknown';
}

export function staffQuoteFailureLog(error: unknown): { code: string; phase: string } {
  return { code: staffQuoteFailureCode(error), phase: staffQuoteFailurePhase(error) };
}

function isHmsExecutionFailure(error: unknown, code: string, phase: string): boolean {
  if (HMS_EXECUTION_CODES.has(code) || HMS_EXECUTION_PHASE.test(phase)) return true;
  return error instanceof Error && (error.name === 'TimeoutError' || /timeout/i.test(error.message));
}

export const NATIVE_NO_MATCHING_RATE_PREFIX = 'HMS has no rate for this meal plan under ';

/** Clean HMS no-match: name the strategy, and offer the dinner fallback only when dinner was requested. */
export function nativeNoMatchingRateMessage(context: { salesStrategy?: string; dinnerRequested?: boolean }): string {
  const strategy = context.salesStrategy ?? 'the selected rate type';
  const next = context.dinnerRequested
    ? 'For dinner, quote Bed & Breakfast and add a dinner allowance (button below), or use the Government rate if the guest is entitled.'
    : 'Try another meal plan or rate type.';
  return `${NATIVE_NO_MATCHING_RATE_PREFIX}${strategy}. ${next}`;
}

export function staffQuoteFailureMessage(
  error: unknown,
  context: { salesStrategy?: string; dinnerRequested?: boolean } = {},
): string {
  const code = staffQuoteFailureCode(error);
  if (code === 'native_quote_no_matching_rate') return nativeNoMatchingRateMessage(context);
  const actions: Record<string, string> = {
    business_quote_policy_unavailable:
      'Verify VAT and tourism levy inclusion for the selected rate.',
    business_party_identity_unavailable:
      'Confirm the exact organisation or travel agency for this rate.',
    business_party_lookup_unavailable:
      'Organisation or agency lookup is unavailable; retry the quote.',
    staff_quote_party_unavailable: 'Organisation or agency lookup failed; retry the quote.',
    staff_quote_party_invalid:
      "Nava couldn't verify the company or agency rate from HMS. Try again, or quote at public rates.",
    staff_quote_party_changed:
      'The HMS company or agency result changed while Nava read it. Try again.',
    business_selected_joint_inventory_unavailable:
      'Verify combined availability for the requested rooms and dates.',
    business_selected_price_unavailable:
      'No qualified available rate covers every requested room-night; review the room and meal choices.',
    business_quote_source_expired: 'The price observation expired; rerun the quote.',
    native_quote_business_evidence_unavailable:
      'Verify rate eligibility and combined availability for these rooms.',
    native_quote_capture_scope_or_completeness_invalid: HMS_UNPRICEABLE_COMBINATION_MESSAGE,
    native_quote_capture_oversized: HMS_UNPRICEABLE_COMBINATION_MESSAGE,
    staff_quote_source_changed:
      'The selected email or approved inputs changed; rerun the current quote.',
  };
  const business = Object.prototype.hasOwnProperty.call(actions, code) ? actions[code] : undefined;
  if (business) return business;
  if (isHmsExecutionFailure(error, code, staffQuoteFailurePhase(error)))
    return HMS_NOT_RESPONDED_MESSAGE;
  return 'The requested allocation or rate could not be qualified; review stay inputs and party/rate evidence';
}

/** The review note when the rate lookup switch is off: picked parties are not checked and no party rate is sent. */
export const PARTY_LOOKUP_OFF_NOTE =
  'HMS rate lookup is turned off here, so company and agency rates are not checked. This quote uses public rates.';

const PARTY_VERIFY_COPY: Record<string, string> = {
  not_found: 'HMS did not confirm the picked company or agency. Search again and pick it.',
  unverified: "Nava couldn't check the picked company or agency in HMS. Try again.",
  refused_lock_busy: 'HMS is busy with another run. Try again in a minute.',
  refused_lock_unavailable: "Nava can't reach HMS right now. Tell the Nava team.",
  refused_flag_off: PARTY_LOOKUP_OFF_NOTE,
};

/**
 * Re-checks each picked party in HMS and returns the HMS id and name. A pick HMS does not confirm is refused before any
 * rate is bound, so an id the client made up never reaches a quote.
 */
export async function verifyStaffParties(parties: StaffQuoteParties): Promise<StaffQuoteParties> {
  const verified: StaffQuoteParties = {};
  const refuse = (reason: string): never => {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: PARTY_VERIFY_COPY[reason] ?? PARTY_VERIFY_COPY.unverified!,
    });
  };
  if (parties.company) {
    const result = await verifyPartyPick({
      kind: 'company',
      nativeId: parties.company.nativeId,
      name: parties.company.name,
    });
    if (!result.ok) refuse(result.reason);
    if (result.ok) verified.company = { kind: 'company', nativeId: result.party.nativeId, name: result.party.name };
  }
  if (parties.agency) {
    const result = await verifyPartyPick({
      kind: 'agency',
      nativeId: parties.agency.nativeId,
      name: parties.agency.name,
    });
    if (!result.ok) refuse(result.reason);
    if (result.ok) verified.agency = { kind: 'agency', nativeId: result.party.nativeId, name: result.party.name };
  }
  return verified;
}

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
    // Empty for one stay. A combined quote lists its other stays here; the first stay stays in the fields above.
    additionalStays: z.array(qualifiedStayInput).max(62).default([]),
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
  const staff = run.metrics?.staffQuoteAttestation as StaffQuoteAttestation | undefined;
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
  deriveQuoteLines(revision);
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
type ProposalStay = { revision: QuoteRevision; facts?: AuthorizedProposalFacts; staff?: StaffQuoteAttestation };

/** The dates an approval covers, read from the revision its run attested. Null when unknown. */
function attestedStaySpan(metrics: Record<string, unknown> | null | undefined): string | null {
  const staff = metrics?.staffQuoteAttestation as StaffQuoteAttestation | undefined;
  const result = metrics?.reservationistResult as { quoteRevisions?: QuoteRevision[] } | undefined;
  const revision = result?.quoteRevisions?.find((candidate) => candidate.id === staff?.revisionIds?.[0]);
  return revision ? approvedStaySpan(revision) : null;
}

/** Every staff approval for this message, newest first, with the stay dates each one covers. */
async function staffApprovalsFor(
  ctx: { activeTransportId: string; sessionUser: { id: string } },
  threadId: string,
  messageId: string,
) {
  const rows = await getDb()
    .select({ id: aiDraftGeneration.id, metrics: aiWorkflowRun.metrics })
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
  return rows.map((row) => ({ generationId: row.id, span: attestedStaySpan(row.metrics) }));
}

/**
 * Every stay of a proposal request, resolved to its approved revision. Each run must belong to this user, transport and
 * message. One stay keeps the message-wide currency rule. A combined quote needs every stay attested, and each stay is
 * current while no newer approval covers the same dates. Run again after a document is built, so nothing changes under it.
 */
async function proposalStaysFor(
  input: z.infer<typeof qualifiedProposalInput>,
  ctx: { activeTransportId: string; sessionUser: { id: string; email: string; name: string | null } },
  resolveFailure: string,
): Promise<ProposalStay[]> {
  const requests = [
    { workflowRunId: input.workflowRunId, revisionRef: input.revisionRef, factRefs: input.factRefs },
    ...input.additionalStays,
  ];
  if (new Set(requests.map((request) => request.workflowRunId)).size !== requests.length)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Each stay needs its own approved quote' });
  const db = getDb();
  const runs = await Promise.all(
    requests.map(async (request) => {
      await awaitPendingStaffQuote(request.workflowRunId);
      const [bound] = await db
        .select({ run: aiWorkflowRun })
        .from(aiWorkflowRun)
        .innerJoin(aiDraftGeneration, eq(aiWorkflowRun.generationId, aiDraftGeneration.id))
        .where(
          and(
            eq(aiDraftGeneration.requestedByUserId, ctx.sessionUser.id),
            eq(aiWorkflowRun.id, request.workflowRunId),
            eq(aiWorkflowRun.transportId, ctx.activeTransportId),
            eq(aiWorkflowRun.triggerMessageId, input.messageId),
          ),
        )
        .limit(1);
      if (!bound) throw new TRPCError({ code: 'NOT_FOUND', message: 'Proposal source not found' });
      return { run: bound.run, request };
    }),
  );
  const combined = runs.length > 1;
  const threadId = runs[0]!.run.threadId;
  const [current] = await db
    .select()
    .from(message)
    .where(and(eq(message.id, input.messageId), eq(message.transportId, ctx.activeTransportId)))
    .limit(1);
  const approvals = combined ? await staffApprovalsFor(ctx, threadId, input.messageId) : [];
  const latest = combined
    ? undefined
    : (
        await db
          .select({ id: aiDraftGeneration.id })
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
  for (const { run, request } of runs) {
    const staff = run.metrics?.staffQuoteAttestation as StaffQuoteAttestation | undefined;
    if (combined && !staff)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Every stay needs its own approved quote' });
    if (staff) {
      const party = { company: input.company, agency: input.agency };
      const problem = combined
        ? combinedStayCurrencyProblem({
            stay: { generationId: run.generationId, span: attestedStaySpan(run.metrics) },
            approvals,
          }) ??
          staffQuoteCurrencyProblem({
            staff,
            runGenerationId: run.generationId,
            latestGenerationId: run.generationId,
            currentMessage: current,
            userId: ctx.sessionUser.id,
            party,
          })
        : staffQuoteCurrencyProblem({
            staff,
            runGenerationId: run.generationId,
            latestGenerationId: latest?.id,
            currentMessage: current,
            userId: ctx.sessionUser.id,
            party,
          });
      if (problem) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: problem });
    }
    let resolved: ReturnType<typeof resolveLedgerProposal>;
    try {
      resolved = resolveLedgerProposal(run, {
        transportId: ctx.activeTransportId,
        messageId: input.messageId,
        revisionRef: request.revisionRef,
        factRefs: request.factRefs,
      });
    } catch {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: resolveFailure });
    }
    stays.push({ ...resolved, staff });
  }
  return stays;
}

/** The staff notes approved with each stay, each kept once and one per line. */
function stayNotes(stays: ProposalStay[]): string | undefined {
  const notes = [...new Set(stays.map((stay) => stay.staff?.notes).filter((note): note is string => !!note))];
  return notes.length ? notes.join('\n') : undefined;
}

export const quoteRunScreenshotInput = z
  .object({
    runId: z.string().regex(QUOTE_RUN_ID_PATTERN),
    name: z.string().regex(QUOTE_SCREENSHOT_NAME_PATTERN),
  })
  .strict();

type DeferredQuoteRevision = {
  promise: Promise<QuoteRevision>;
  resolve: (revision: QuoteRevision) => void;
  reject: (error: unknown) => void;
};

function deferredQuoteRevision(): DeferredQuoteRevision {
  let resolve!: (revision: QuoteRevision) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<QuoteRevision>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Provisional mode only. Resolves `captured` once the quote is captured, then keeps the caller's
 * property lock held until every capture child has exited, so its trace has finished first.
 */
async function awaitProvisionalCapture(
  quote: Promise<QuoteRevision>,
  finishes: readonly Promise<void>[],
  captured: DeferredQuoteRevision,
): Promise<QuoteRevision> {
  let revision: QuoteRevision;
  try {
    revision = await quote;
  } catch (error) {
    await Promise.allSettled(finishes);
    throw error;
  }
  if (finishes.length) captured.resolve(revision);
  await Promise.all(finishes);
  return revision;
}

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
        .select({ id: aiWorkflowRun.id })
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
      let outputDir: string;
      try {
        outputDir = readInstalledStaffQuoteConfiguration().outputDir;
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
    const db = getDb(),
      [mail] = await db
        .select()
        .from(message)
        .where(and(eq(message.id, input.messageId), eq(message.transportId, ctx.activeTransportId)))
        .limit(1);
    if (!mail || mail.direction !== 'inbound')
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Selected inbound email not found' });
    let config: ReturnType<typeof readInstalledStaffQuoteConfiguration>;
    try {
      config = readInstalledStaffQuoteConfiguration();
    } catch {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Staff quotation installation unavailable',
      });
    }
    const scope = {
      transportId: ctx.activeTransportId,
      userId: ctx.sessionUser.id,
      threadId: mail.threadId,
      messageId: mail.id,
      sourceHash: staffQuoteSourceHash(mail),
      messageAt: (mail.receivedAt ?? mail.sentAt ?? mail.createdAt).toISOString(),
      messageText: mail.textBody ?? '',
      propertyCode: config.owner.propertyCode,
    };
    const signal = AbortSignal.timeout(20 * 60000);
    const signer = { signerName: ctx.sessionUser.name ?? '', signerEmail: ctx.sessionUser.email };
    // A picked company or agency is re-checked in HMS before any rate is bound. The lookup runs before the quote lock,
    // which the same property lock would otherwise block. With the switch off no lookup runs and no party rate is sent.
    const notes: string[] = [];
    // The rate cards of the attempt that priced. Empty when the quote failed before they were built.
    let rateOptions: RateOption[] = [];
    let quoteInput: StaffQuoteInput = input;
    if (input.parties) {
      if (quoteRateContextEnabled()) {
        quoteInput = { ...input, parties: await verifyStaffParties(input.parties) };
      } else {
        quoteInput = { ...input, parties: undefined };
        notes.push(PARTY_LOOKUP_OFF_NOTE);
      }
    }
    let prepared: ReturnType<typeof prepareStaffQuote>;
    try {
      prepared = prepareStaffQuote(quoteInput, scope, signer, signal);
    } catch {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Selected email changed or stay inputs are incomplete; review and retry',
      });
    }
    const generationId = randomUUID(),
      workflowRunId = randomUUID();
    // Existing generation ledger is the approval token; a new approval revokes older outputs.
    await db.insert(aiDraftGeneration).values({
      id: generationId,
      transportId: scope.transportId,
      threadId: scope.threadId,
      requestedByUserId: scope.userId,
      contextMessageIds: [mail.id],
      model: 'staff-approved-native',
      promptVersion: 'staff-quote-v1',
      promptHash: prepared.inputDigest,
      status: 'running',
      createdAt: sql`clock_timestamp()`,
    });
    const stillCurrent = async () => {
      const [current] = await db
        .select()
        .from(message)
        .where(and(eq(message.id, mail.id), eq(message.transportId, ctx.activeTransportId)))
        .limit(1);
      const [latest] = await db
        .select({ id: aiDraftGeneration.id })
        .from(aiDraftGeneration)
        .where(
          and(
            eq(aiDraftGeneration.transportId, scope.transportId),
            eq(aiDraftGeneration.threadId, scope.threadId),
            eq(aiDraftGeneration.requestedByUserId, scope.userId),
            eq(aiDraftGeneration.model, 'staff-approved-native'),
            sql`${aiDraftGeneration.contextMessageIds} @> ${JSON.stringify([scope.messageId])}::jsonb`,
          ),
        )
        .orderBy(desc(aiDraftGeneration.createdAt))
        .limit(1);
      return (
        latest?.id === generationId &&
        !!current &&
        current.threadId === scope.threadId &&
        staffQuoteSourceHash(current) === input.sourceHash
      );
    };
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Staff quotation database unavailable',
      });
    const evidence: { directory?: string } = {};
    const queued = beginQuoteRun({
      generationId,
      transportId: scope.transportId,
      userId: scope.userId,
      lockKey: propertyReadLockKey(config.tenantId, scope.propertyCode),
    });
    // Provisional mode (QUOTE_TRACE_ASYNC=on): the quote is returned once captured, while the lock
    // and the run's record wait for the trace. Flag off, none of this changes the sequential flow.
    const traceAsync = quoteTraceAsyncEnabled();
    const traceFinishes: Promise<void>[] = [];
    let queueEndedLater = false;
    let lockRun: Promise<QuoteRevision> | undefined;
    try {
      const lock = createPostgresPropertyReadLock({
        tenantId: config.tenantId,
        propertyCode: scope.propertyCode,
        databaseUrl,
      });
      let revision: QuoteRevision;
      const captured = deferredQuoteRevision();
      try {
        lockRun = lock.withLock(
          async () => {
            queued.setPhase(1);
            // One attempt is one approval, with its own services and authorization. A party rate HMS cannot price is
            // quoted once more at public rates, and the review says so.
            const quoteAt = (attempt: ReturnType<typeof prepareStaffQuote>) => {
              const services = getInstalledStaffQuoteServices(
                {
                  authorizationId: attempt.authorizationId,
                  authorizeContext: async (c) => c === attempt.context && (await stillCurrent()),
                  signer,
                  onEvidenceDirectory: (directory) => {
                    evidence.directory = directory;
                  },
                  onTraceFinish: (finished) => {
                    traceFinishes.push(finished);
                  },
                },
                {
                  ...attempt.approval,
                  onRateOptions: (options: RateOption[]) => {
                    rateOptions = options;
                  },
                },
              );
              return executeStaffQuote(
                attempt,
                {
                  ...services,
                  resolveQuoteTask:
                    services.resolveQuoteTask &&
                    (async (quoteContext) => {
                      const resolved = await services.resolveQuoteTask!(quoteContext);
                      queued.setPhase(2);
                      return resolved;
                    }),
                },
                stillCurrent,
              );
            };
            const quote = quoteWithPartyFallback({
              input: quoteInput,
              first: prepared,
              retry: () => prepareStaffQuote(quoteInput, scope, signer, signal, 'public'),
              run: quoteAt,
            }).then((attempt) => {
              prepared = attempt.prepared;
              const contractNote = partyContractReviewNote(quoteInput.parties, attempt.result.groups);
              // A contract on another board only: the public quote says which contract it did not take, instead of "no contract".
              const elsewhere = quoteInput.parties ? otherBoardContractNotes(partyNames(quoteInput.parties), rateOptions) : [];
              if (attempt.note) notes.push(attempt.note);
              else if (elsewhere.length) notes.push(...elsewhere);
              else if (contractNote) notes.push(contractNote);
              return attempt.result;
            });
            return traceAsync ? awaitProvisionalCapture(quote, traceFinishes, captured) : quote;
          },
          { signal, deadlineAt: prepared.context.input.clock.deadlineAt },
        );
        if (traceAsync) {
          lockRun.then(
            (value) => captured.resolve(value),
            (error) => captured.reject(error),
          );
          revision = await captured.promise;
        } else {
          revision = await lockRun;
        }
      } catch (error) {
        console.warn('staff_quote_failed', staffQuoteFailureLog(error));
        await db
          .update(aiDraftGeneration)
          .set({ status: 'failed', errorMessage: 'staff_quote_not_qualified' })
          .where(eq(aiDraftGeneration.id, generationId));
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: staffQuoteFailureMessage(error, {
            salesStrategy: input.salesStrategy,
            dinnerRequested: input.groups.some((group) => group.board === 'dinner_bb'),
          }),
        });
      }
      queued.setPhase(3);
      // Any failure after pricing must not leave this generation 'running'.
      const markGenerationFailed = (code: string) =>
        Promise.resolve(
          db
            .update(aiDraftGeneration)
            .set({ status: 'failed', errorMessage: code })
            .where(eq(aiDraftGeneration.id, generationId)),
        ).catch(() => undefined);
      let attestation: StaffQuoteAttestation;
      let proposal: ReturnType<typeof buildStaffProposalFacts>;
      let extraTotal: number;
      try {
        attestation = attestStaffQuote(input, scope, prepared, revision);
        ({ proposal, extraTotal } = staffExtrasOrBadRequest(input, scope, prepared, revision));
        if (!(await stillCurrent()))
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Selected email changed while pricing',
          });
      } catch (error) {
        await markGenerationFailed('staff_quote_post_pricing_failed');
        throw error;
      }
      const runId = evidence.directory
        ? quoteRunIdFromEvidenceDirectory(config.outputDir, evidence.directory)
        : null;
      const persistRun = () =>
        db.transaction(async (tx) => {
          await tx
            .update(aiDraftGeneration)
            .set({ status: 'succeeded' })
            .where(eq(aiDraftGeneration.id, generationId));
          await tx.insert(aiWorkflowRun).values({
          id: workflowRunId,
          transportId: scope.transportId,
          threadId: scope.threadId,
          triggerMessageId: mail.id,
          runKind: 'candidate_draft',
          idempotencyKey: prepared.authorizationId,
          modelId: 'staff-approved-native',
          promptVersion: 'staff-quote-v1',
          state: 'succeeded',
          executorLane: 'hms',
          generationId,
          metrics: {
            staffQuoteAttestation: { ...attestation, salesStrategy: input.salesStrategy },
            reservationistResult: {
              readiness: 'ready_for_staff_review',
              quoteRevisionIds: [revision.id],
              quoteRevisions: [revision],
              proposalFacts: proposal.facts ? [{ ref: 'extras', facts: proposal.facts }] : [],
            },
            ...(runId ? { staffQuoteEvidence: { runId } } : {}),
          },
        });
        });
      const summary = async () => ({
        status: 'ready' as const,
        workflowRunId,
        revisionRef: revision.id,
        messageId: mail.id,
        threadId: mail.threadId,
        factRefs: proposal.factRefs,
        extrasReviewItems: [...notes, ...proposal.extrasReviewItems],
        rateOptions,
        selectionEpoch: input.selectionEpoch,
        inputRevision: input.inputRevision,
        inputDigest: prepared.inputDigest,
        totalMinor: revision.totalMinor + extraTotal,
        currency: revision.currency,
        arrivalDate: revision.groups[0].arrivalDate,
        departureDate: revision.groups.at(-1)!.departureDate,
        description: deriveQuoteLines(revision)
          .map((l) => l.description)
          .join('; '),
        runId,
        screenshots: runId ? await listQuoteRunScreenshots(config.outputDir, runId) : [],
      });
      if (traceAsync && traceFinishes.length > 0 && lockRun) {
        // The quote is shown now. The run is recorded, and the queue freed, only after the lock
        // has been released, which happens once the trace has finished.
        queueEndedLater = true;
        const pending = lockRun
          .then(async () => {
            // A newer approval may have superseded this generation while the trace finished.
            if (!(await stillCurrent())) throw new Error('staff_quote_superseded');
            await persistRun();
          })
          .catch(async (error: unknown) => {
            console.error(
              `[staff-quote] run ${workflowRunId} not recorded: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
            await Promise.resolve(
              db
                .update(aiDraftGeneration)
                .set({ status: 'failed', errorMessage: 'staff_quote_trace_finish_failed' })
                .where(eq(aiDraftGeneration.id, generationId)),
            ).catch(() => undefined);
          })
          .finally(() => queued.end());
        registerPendingStaffQuote([workflowRunId, mail.id, ...(runId ? [runId] : [])], pending);
        return summary();
      }
      try {
        await persistRun();
      } catch (error) {
        await markGenerationFailed('staff_quote_persist_failed');
        throw error;
      }
      return summary();
    } finally {
      if (!queueEndedLater) queued.end();
    }
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
        const cloned = structuredClone(revision);
        const extraTotalMinor = quotedTotalWithStoredExtras(cloned, bound.run) - cloned.totalMinor;
        const draft = await buildBookingDrafts({
          analysis: input.analysis,
          revision: cloned,
          defaults: bookingCodeDefaults(partyClassFromRevision(cloned, staff)),
          messageId: input.messageId,
          extraTotalMinor,
        });
        return {
          status: 'ready' as const,
          draft,
          options: createRequestFieldOptions(),
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
          state: aiWorkflowRun.state,
          createdAt: aiWorkflowRun.createdAt,
          finishedAt: aiWorkflowRun.finishedAt,
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
      const resolved = resolvePriorQuoteForBooking(run, {
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
        revisionRef: input.revisionRef,
        analysis: input.analysis,
      });
      if (resolved.status !== 'ready') return resolved;
      const staff = run.metrics?.staffQuoteAttestation as
        | (StaffQuoteAttestation & { salesStrategy?: 'BAR' | 'Government' })
        | undefined;
      const extraTotalMinor =
        quotedTotalWithStoredExtras(resolved.revision, run) - resolved.revision.totalMinor;
      const draft = await buildBookingDrafts({
        analysis: input.analysis,
        revision: structuredClone(resolved.revision),
        defaults: bookingCodeDefaults(partyClassFromRevision(resolved.revision, staff)),
        messageId: input.messageId,
        extraTotalMinor,
      });
      return {
        status: 'ready' as const,
        draft,
        options: createRequestFieldOptions(),
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
          storeId: z.string().min(1).max(512).optional(),
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
            choices.push({
              workflowRunId: run.id,
              messageId: mail.id,
              threadId: mail.threadId,
              revisionRef: revision.id,
              factRefs,
              totalMinor:
                revision.totalMinor +
                (facts
                  ? deriveAuthorizedExtraLines(revision, facts).reduce(
                      (sum, line) => sum + line.totalMinor,
                      0,
                    )
                  : 0),
              currency: revision.currency,
              arrivalDate: revision.groups[0].arrivalDate,
              departureDate: revision.groups.at(-1)!.departureDate,
              description: deriveQuoteLines(revision)
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
      const stays = await proposalStaysFor(input, ctx, 'Proposal evidence is not ready');
      const url = process.env.GOTENBERG_URL?.trim();
      if (!url)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GOTENBERG_URL missing' });
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
            // The note comes from the approved attestations, not from this request.
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
      return {
        revisionId: result.revisionId,
        pdfHash: result.pdfHash,
        fileName: result.fileName,
        totalMinor: result.totalMinor,
        pdfBase64: Buffer.from(result.pdf).toString('base64'),
      };
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
          // The note comes from the approved attestations, not from this request.
          note: stayNotes(stays),
        });
      } catch (error) {
        if (error instanceof WorkbookRefusalError)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Excel could not be built from this quote' });
      }
      await proposalStaysFor(input, ctx, 'Proposal evidence is not ready');
      // The file is named for the earliest arrival across the stays.
      const arrival = stays
        .map((stay) => stay.revision.groups[0]?.arrivalDate ?? stay.revision.authoredDate)
        .sort()[0]!;
      return {
        fileName: quoteWorkbookFileName(input.company, arrival),
        xlsxBase64: Buffer.from(workbook.bytes).toString('base64'),
        totalMinor: workbook.totalMinor,
        revisionId: documentIdFor(stays),
      };
    }),
  sourceQuoteProposalPdf: mailboxProcedure
    .input(
      qualifiedProposalInput
        .omit({ additionalStays: true })
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
      const gotenbergUrl = process.env.GOTENBERG_URL?.trim();
      if (!gotenbergUrl) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'GOTENBERG_URL missing',
        });
      }
      try {
        const { fileName, pdf } = await buildQuoteProposalPdf(
          input,
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
