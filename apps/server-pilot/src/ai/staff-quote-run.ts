import {
  attestStaffQuote,
  buildStaffProposalFacts,
  executeStaffQuote,
  partyContractReviewNote,
  partyNames,
  prepareStaffQuote,
  quoteWithPartyFallback,
  staffQuoteDinnerFallback,
  staffQuoteDinnerGroupIdsToRetryAsBb,
  staffQuoteSourceHash,
  type StaffQuoteAttestation,
  type StaffQuoteDinnerAddOn,
  type StaffQuoteInput,
  type StaffQuoteParties,
} from './staff-quote-workflow.js';
import {
  deriveQuoteLines,
  deriveAuthorizedExtraLines,
  pricedRoomTotal,
  rowRatesFor,
} from '../quote-proposal/quote-lines.js';
import {
  getInstalledStaffQuoteServices,
  readInstalledStaffQuoteConfiguration,
} from './staff-quote-installation.js';
import {
  listQuoteRunScreenshots,
  quoteRunIdFromEvidenceDirectory,
} from './staff-quote-evidence.js';
import {
  createPostgresPropertyReadLock,
  isPropertyReadLockDeadline,
  PROPERTY_READ_LOCK_DEADLINE_MESSAGE,
  propertyReadLockKey,
} from '../hms/property-read-lock.js';
import { quoteTraceAsyncEnabled, registerPendingStaffQuote } from './staff-quote-trace-async.js';
import type { NativeQuoteGapDetail } from './reservationist-evaluation-composition.js';
import { type QuoteRevision } from '../quote-proposal/quote-revision.js';
import { ReservationistTaskEvidenceUnavailable } from './reservationist-execution.js';
import { aiDraftGeneration, aiWorkflowRun, message } from '../db/schema/mail.js';
import { otherBoardContractNotes, type RateOption } from './rate-options.js';
import { quoteWorkItemIdFor, recordRateEvents } from './work-events.js';
import { quoteRateContextEnabled } from './quote-rate-switch.js';
import { beginQuoteRun } from '../hms/property-queue-state.js';
import { snapshotRowPrices } from '../trpc/routes/rates.js';
import { verifyPartyPick } from './pane-party-lookup.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';

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

/**
 * Prices the staff extras for one approved revision. Invalid or oversize extras are the caller's mistake,
 * so any failure here is a BAD_REQUEST, never an internal error.
 */
export function staffExtrasOrBadRequest(
  input: StaffQuoteInput,
  scope: Parameters<typeof buildStaffProposalFacts>[1],
  prepared: Parameters<typeof buildStaffProposalFacts>[2],
  revision: QuoteRevision,
  options: Parameters<typeof buildStaffProposalFacts>[4] = {},
): { proposal: ReturnType<typeof buildStaffProposalFacts>; extraTotal: number } {
  try {
    const proposal = buildStaffProposalFacts(input, scope, prepared, revision, options);
    const extraTotal = proposal.facts
      ? deriveAuthorizedExtraLines(revision, proposal.facts).reduce(
          (sum, line) => sum + line.totalMinor,
          0,
        )
      : 0;
    return { proposal, extraTotal };
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'The extras on this quote are not valid. Check the amounts and counts, then run the quote again.',
    });
  }
}

export type StaffQuoteRoomAlternative = {
  groupId: string;
  roomCode: string;
  roomLabel: string;
  quantity: number;
};

/** Safe read of HMS alternatives; malformed, duplicate or untrusted labels never reach the pane. */
export function staffQuoteRoomAlternatives(value: unknown): StaffQuoteRoomAlternative[] {
  if (!Array.isArray(value)) return [];
  const result: StaffQuoteRoomAlternative[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const alternative = raw as Record<string, unknown>;
    const { groupId, roomCode, roomLabel, quantity } = alternative;
    if (
      typeof groupId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(groupId) ||
      typeof roomCode !== 'string' || !/^[A-Z0-9_-]{1,16}$/.test(roomCode) ||
      typeof roomLabel !== 'string' || !roomLabel.trim() || roomLabel.length > 120 || /[<>\u0000-\u001f]/.test(roomLabel) ||
      !Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 100
    ) continue;
    const key = `${groupId}|${roomCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ groupId, roomCode, roomLabel: roomLabel.trim(), quantity: quantity as number });
  }
  return result;
}

export function staffQuoteFailureCode(error: unknown): string {
  const raw = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const candidate = typeof raw === 'string' ? raw : error instanceof Error ? error.message : '';
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(candidate) ? candidate : 'unknown';
}

const STAFF_QUOTE_CAUSE_TRANSIENT_CODES = new Set([
  'TRANSIENT_NETWORK',
  'EXECUTION_FAILURE',
  'AUTHENTICATED_SHELL_TIMEOUT',
  'staff_quote_native_unavailable',
  'staff_quote_native_capture_unavailable',
  'native_quote_capture_unavailable',
  'native_quote_read_unavailable',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'ETIMEDOUT',
  'TIMEOUT',
  'TARGET_CLOSED',
  '40001',
  '40P01',
]);

/** Cause metadata is safe for tRPC logging and retains only codes needed for queue classification. */
function staffQuoteCauseSummary(error: unknown): { name: string; code: string; message: string; alternatives?: StaffQuoteRoomAlternative[] } {
  if (isPropertyReadLockDeadline(error)) {
    return {
      name: 'Error',
      code: 'HMS_LOCK_BUSY',
      message: PROPERTY_READ_LOCK_DEADLINE_MESSAGE,
    };
  }

  let current: unknown = error;
  let leaf: unknown = error;
  let transientCode: string | undefined;
  let alternatives: StaffQuoteRoomAlternative[] = [];
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current !== 'object') break;
    leaf = current;
    const record = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const detail = (current as { detail?: unknown }).detail;
    if (!alternatives.length && detail && typeof detail === 'object') {
      alternatives = staffQuoteRoomAlternatives((detail as { alternatives?: unknown }).alternatives);
    }
    const code = typeof record.code === 'string' ? record.code : undefined;
    const message = typeof record.message === 'string' ? record.message : '';
    if (code && STAFF_QUOTE_CAUSE_TRANSIENT_CODES.has(code)) {
      transientCode = code;
    } else if (/socket hang up/i.test(message)) {
      transientCode = 'ECONNRESET';
    } else if (/Target\b.*\bclosed\b/i.test(message)) {
      transientCode = 'TARGET_CLOSED';
    } else if (/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|ETIMEDOUT)\b/i.test(message)) {
      const matched = message.match(/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|ETIMEDOUT)\b/i)?.[0];
      transientCode = matched?.toUpperCase();
    } else if (/timeout/i.test(message)) {
      transientCode = 'TIMEOUT';
    } else if (/network/i.test(message)) {
      transientCode = 'TRANSIENT_NETWORK';
    }
    current = record.cause ?? null;
  }

  const record = leaf && typeof leaf === 'object' ? (leaf as { name?: unknown; code?: unknown }) : {};
  const rawName = typeof record.name === 'string' ? record.name : 'Error';
  const rawCode = typeof record.code === 'string' ? record.code : staffQuoteFailureCode(leaf);
  return {
    name: /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(rawName) ? rawName : 'Error',
    code: transientCode ?? (/^[A-Za-z0-9_.:-]{1,120}$/.test(rawCode) ? rawCode : 'unknown'),
    message: 'Staff quote execution failed.',
    ...(alternatives.length ? { alternatives } : {}),
  };
}

function dinnerAddOnDetails(
  proposal: ReturnType<typeof buildStaffProposalFacts>,
  revision: QuoteRevision,
): {
  label: string;
  amountMinor: number;
  unit: StaffQuoteDinnerAddOn['unit'];
  totalMinor: number;
} | undefined {
  if (!proposal.facts) return undefined;
  const line = deriveAuthorizedExtraLines(revision, proposal.facts).find((item) => item.service === 'dinner_add_on');
  const extra = proposal.facts.extras.find((item) => item.service === 'dinner_add_on');
  if (!line || !extra) return undefined;
  const unit: StaffQuoteDinnerAddOn['unit'] =
    extra.chargeUnit === 'per_person_night'
      ? 'per_person_per_night'
      : extra.chargeUnit === 'per_person'
        ? 'per_person'
        : 'per_room_per_night';
  return { label: line.description, amountMinor: line.rateMinor, unit, totalMinor: line.totalMinor };
}

/**
 * Where the quote failed. HMS execution failures carry their own phase (login, hotel_availability, …). A missing-evidence
 * failure (ReservationistTaskEvidenceUnavailable) happens after HMS answered, while Nava qualifies the answer: 'qualification'.
 */
export function staffQuoteFailurePhase(error: unknown): string {
  const phase = error && typeof error === 'object' && 'phase' in error ? error.phase : undefined;
  if (typeof phase === 'string' && /^[a-z_]{1,40}$/.test(phase)) return phase;
  return error instanceof ReservationistTaskEvidenceUnavailable ? 'qualification' : 'unknown';
}

/** The native gap detail an evidence failure carries (statuses and HMS codes only), or undefined. */
function nativeQuoteGapOf(error: unknown): NativeQuoteGapDetail | undefined {
  if (!(error instanceof ReservationistTaskEvidenceUnavailable) || !error.detail) return undefined;
  const detail = error.detail as Partial<NativeQuoteGapDetail>;
  return Array.isArray(detail.rows) && typeof detail.allocationStatus === 'string'
    ? (detail as NativeQuoteGapDetail)
    : undefined;
}

export function staffQuoteFailureLog(error: unknown): {
  code: string;
  phase: string;
  detail?: NativeQuoteGapDetail;
} {
  const detail = nativeQuoteGapOf(error);
  return {
    code: staffQuoteFailureCode(error),
    phase: staffQuoteFailurePhase(error),
    ...(detail ? { detail } : {}),
  };
}

/** The staff message when HMS gave no building and the property room profile is missing or out of date, so rooms cannot be pooled. */
export const SHARED_INVENTORY_GAP_MESSAGE =
  'Room profile out of date or missing — check HMS room types. Quote each room type separately for now.';

/** The first short room-night the reader proved, from its detail. Anything malformed is not copied to staff. */
function insufficientShortfallOf(
  error: unknown,
): { roomLabel: string; date: string; supply: number } | undefined {
  if (!(error instanceof ReservationistTaskEvidenceUnavailable) || !error.detail) return undefined;
  const shortfall = error.detail.shortfall as
    | { roomLabel?: unknown; date?: unknown; supply?: unknown }
    | undefined;
  return typeof shortfall?.roomLabel === 'string' &&
    typeof shortfall.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(shortfall.date) &&
    Number.isInteger(shortfall.supply)
    ? { roomLabel: shortfall.roomLabel, date: shortfall.date, supply: shortfall.supply as number }
    : undefined;
}

/** Staff copy for a short room type: what is free on the short night, so staff quote fewer rooms or split the types. */
export function insufficientInventoryMessage(shortfall: {
  roomLabel: string;
  date: string;
  supply: number;
}): string {
  const night = new Date(`${shortfall.date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return `Only ${shortfall.supply} ${shortfall.roomLabel} free on ${night} — quote fewer or split`;
}

/** The restricted nights the reader proved, from its detail. Anything malformed is not copied to staff. */
function restrictedNightsDetailOf(
  error: unknown,
): { roomLabel: string; date: string }[] | undefined {
  if (!(error instanceof ReservationistTaskEvidenceUnavailable) || !error.detail) return undefined;
  const nights = error.detail.restrictedNights as
    | { roomLabel?: unknown; date?: unknown }[]
    | undefined;
  const valid =
    Array.isArray(nights) &&
    nights.length > 0 &&
    nights.every(
      (night) =>
        typeof night?.roomLabel === 'string' &&
        typeof night.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(night.date),
    );
  return valid ? (nights as { roomLabel: string; date: string }[]) : undefined;
}

/** Staff copy for a sell restriction: each night HMS closes, with the room types closed on it, so staff choose other dates or quote in HMS. */
export function restrictedNightsMessage(nights: { roomLabel: string; date: string }[]): string {
  const roomsByDate = new Map<string, string[]>();
  for (const { roomLabel, date } of nights)
    roomsByDate.set(date, [...new Set([...(roomsByDate.get(date) ?? []), roomLabel])]);
  const list = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' });
  const clauses = [...roomsByDate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, rooms]) => {
      const night = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
      return `${night} for ${list.format(rooms)}`;
    });
  return `HMS restricts sale on ${clauses.join('; ')}. Choose other dates or quote this in HMS.`;
}

function isHmsExecutionFailure(error: unknown, code: string, phase: string): boolean {
  if (HMS_EXECUTION_CODES.has(code) || HMS_EXECUTION_PHASE.test(phase)) return true;
  return (
    error instanceof Error && (error.name === 'TimeoutError' || /timeout/i.test(error.message))
  );
}

export const NATIVE_NO_MATCHING_RATE_PREFIX = 'HMS has no rate for this meal plan under ';

/** Clean HMS no-match: name the strategy and the automatic dinner fallback that was attempted. */
export function nativeNoMatchingRateMessage(context: {
  salesStrategy?: string;
  dinnerRequested?: boolean;
}): string {
  const strategy = context.salesStrategy ?? 'the selected rate type';
  const next = context.dinnerRequested
    ? 'Nava retries dinner requests on Bed & Breakfast with a separate dinner add-on. If no B&B rate is available, choose an available room option below or check the Government rate only if the guest is entitled.'
    : 'Try another meal plan or rate type.';
  return `${NATIVE_NO_MATCHING_RATE_PREFIX}${strategy}. ${next}`;
}

export function staffQuoteFailureMessage(
  error: unknown,
  context: { salesStrategy?: string; dinnerRequested?: boolean } = {},
): string {
  const code = staffQuoteFailureCode(error);
  if (code === 'native_quote_no_matching_rate') return nativeNoMatchingRateMessage(context);
  if (
    code === 'native_quote_business_evidence_unavailable' &&
    nativeQuoteGapOf(error)?.sharedInventoryPoolGap
  ) {
    return SHARED_INVENTORY_GAP_MESSAGE;
  }
  const shortfall =
    code === 'native_quote_insufficient_inventory' ? insufficientShortfallOf(error) : undefined;
  if (shortfall) return insufficientInventoryMessage(shortfall);
  const restricted =
    code === 'native_quote_restricted_nights' ? restrictedNightsDetailOf(error) : undefined;
  if (restricted) return restrictedNightsMessage(restricted);
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
      'HMS has no rate for every night of this stay in this room and meal plan. Try another room type or meal plan, or split the dates, then search again.',
    business_quote_source_expired: 'The price observation expired; rerun the quote.',
    native_quote_business_evidence_unavailable:
      'Verify rate eligibility and combined availability for these rooms.',
    native_quote_insufficient_inventory:
      'Verify combined availability for the requested rooms and dates.',
    native_quote_restricted_nights:
      'HMS restricts sale on some of these nights. Choose other dates or quote this in HMS.',
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
      ...(reason === 'refused_lock_busy'
        ? { cause: Object.assign(new Error('HMS party verification lock busy'), { code: 'HMS_LOCK_BUSY' }) }
        : {}),
    });
  };
  if (parties.company) {
    const result = await verifyPartyPick({
      kind: 'company',
      nativeId: parties.company.nativeId,
      name: parties.company.name,
    });
    if (!result.ok) refuse(result.reason);
    if (result.ok)
      verified.company = {
        kind: 'company',
        nativeId: result.party.nativeId,
        name: result.party.name,
      };
  }
  if (parties.agency) {
    const result = await verifyPartyPick({
      kind: 'agency',
      nativeId: parties.agency.nativeId,
      name: parties.agency.name,
    });
    if (!result.ok) refuse(result.reason);
    if (result.ok)
      verified.agency = {
        kind: 'agency',
        nativeId: result.party.nativeId,
        name: result.party.name,
      };
  }
  return verified;
}

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

export type StaffQuoteRunIdentity = {
  transportId: string;
  user: { id: string; name: string | null; email: string };
};

export type StaffQuoteRunOptions = {
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Commit a queued read result under the same claim fence and transaction as the quote artifacts. */
  commitQueuedResult?: (result: Record<string, unknown>, transaction: DB) => Promise<boolean>;
};

function withRunDeadline<T extends ReturnType<typeof prepareStaffQuote>>(
  prepared: T,
  deadlineAt?: number,
): T {
  if (deadlineAt === undefined || deadlineAt >= prepared.context.input.clock.deadlineAt)
    return prepared;
  const context = {
    ...prepared.context,
    input: {
      ...prepared.context.input,
      clock: { ...prepared.context.input.clock, deadlineAt },
    },
  };
  return {
    ...prepared,
    context,
    approval: { ...prepared.approval, context },
  };
}

/** Runs one staff-approved native quote. The caller supplies the actor and transport from its trusted context. */
export async function runStaffQuote(
  input: StaffQuoteInput,
  identity: StaffQuoteRunIdentity,
  db: DB,
  options: StaffQuoteRunOptions = {},
) {
  const [mail] = await db
    .select()
    .from(message)
    .where(and(eq(message.id, input.messageId), eq(message.transportId, identity.transportId)))
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
    transportId: identity.transportId,
    userId: identity.user.id,
    threadId: mail.threadId,
    messageId: mail.id,
    sourceHash: staffQuoteSourceHash(mail),
    messageAt: (mail.receivedAt ?? mail.sentAt ?? mail.createdAt).toISOString(),
    messageText: mail.textBody ?? '',
    propertyCode: config.owner.propertyCode,
  };
  const signal = options.signal ?? AbortSignal.timeout(20 * 60000);
  const signer = { signerName: identity.user.name ?? '', signerEmail: identity.user.email };
  // Saved rates are read before any HMS call or generation row, so an archived rate fails cleanly here.
  const rowPrices = await snapshotRowPrices(db, identity.transportId, input);
  // A picked company or agency is re-checked in HMS before any rate is bound. The lookup runs before the quote lock,
  // which the same property lock would otherwise block. With the switch off no lookup runs and no party rate is sent.
  const notes: string[] = [];
  // The rate cards of the attempt that priced. Empty when the quote failed before they were built.
  let rateOptions: RateOption[] = [];
  let quoteInput: StaffQuoteInput = input;
  let effectiveQuoteInput: StaffQuoteInput = input;
  let dinnerFallbackGroupIds: string[] = [];
  if (input.parties) {
    if (quoteRateContextEnabled()) {
      quoteInput = { ...input, parties: await verifyStaffParties(input.parties) };
    } else {
      quoteInput = { ...input, parties: undefined };
      notes.push(PARTY_LOOKUP_OFF_NOTE);
    }
  }
  const prepare = (rates?: 'party' | 'public', attemptInput: StaffQuoteInput = quoteInput) =>
    withRunDeadline(
      prepareStaffQuote(attemptInput, scope, signer, signal, rates),
      options.deadlineAt,
    );
  let prepared: ReturnType<typeof prepareStaffQuote>;
  try {
    prepared = prepare();
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
      .where(and(eq(message.id, mail.id), eq(message.transportId, identity.transportId)))
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
  const waitForTracePersistence = options.deadlineAt !== undefined;
  const traceFinishes: Promise<void>[] = [];
  let lockRun: Promise<QuoteRevision> | undefined;
  let queueEndedLater = false;
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
          const quoteOneInput = async (
            attemptInput: StaffQuoteInput,
            firstPrepared: ReturnType<typeof prepareStaffQuote>,
          ) => {
            const attempt = await quoteWithPartyFallback({
              input: attemptInput,
              first: firstPrepared,
              retry: () => prepare('public', attemptInput),
              run: quoteAt,
            });
            prepared = attempt.prepared;
            effectiveQuoteInput = attemptInput;
            const contractNote = partyContractReviewNote(attemptInput.parties, attempt.result.groups);
            // A contract on another board only: the public quote says which contract it did not take, instead of "no contract".
            const elsewhere = attemptInput.parties
              ? otherBoardContractNotes(partyNames(attemptInput.parties), rateOptions)
              : [];
            if (attempt.note) notes.push(attempt.note);
            else if (elsewhere.length) notes.push(...elsewhere);
            else if (contractNote) notes.push(contractNote);
            return attempt.result;
          };
          const quote = (async () => {
            const allDinnerFallback = staffQuoteDinnerFallback(quoteInput);
            const retryDinnerAsBb = (fallback = allDinnerFallback) => {
              if (!fallback) throw new Error('staff_quote_dinner_fallback_missing');
              // Retry only groups without a selected verified party contract; another group's contract stays pinned.
              dinnerFallbackGroupIds = fallback.groupIds;
              rateOptions = [];
              return quoteOneInput(fallback.input, prepare(undefined, fallback.input));
            };
            const retryAllDinnerAsBb = () => {
              if (!allDinnerFallback) throw new Error('staff_quote_dinner_fallback_missing');
              // A no-match result has no selected-rate evidence, so preserve the existing all-dinner retry behavior.
              dinnerFallbackGroupIds = allDinnerFallback.groupIds;
              rateOptions = [];
              return quoteOneInput(allDinnerFallback.input, prepare(undefined, allDinnerFallback.input));
            };
            const attemptNotesStart = notes.length;
            let result: Awaited<ReturnType<typeof quoteOneInput>>;
            try {
              result = await quoteOneInput(quoteInput, prepared);
            } catch (error) {
              if (staffQuoteFailureCode(error) !== 'native_quote_no_matching_rate' || !allDinnerFallback) throw error;
              // Preserve the same dates, room, occupancy, strategy and verified party context.
              return retryAllDinnerAsBb();
            }
            const fallbackGroupIds = staffQuoteDinnerGroupIdsToRetryAsBb(quoteInput, rateOptions);
            if (fallbackGroupIds.length) {
              const dinnerFallback = staffQuoteDinnerFallback(quoteInput, fallbackGroupIds);
              if (!dinnerFallback) throw new Error('staff_quote_dinner_fallback_missing');
              // A public DBB/HB result is not the staff quote: use B&B and list dinner separately. Discard notes/rate
              // cards from the superseded attempt; a selected, verified contract result is preserved group-by-group.
              notes.splice(attemptNotesStart);
              return retryDinnerAsBb(dinnerFallback);
            }
            return result;
          })();
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
        cause: staffQuoteCauseSummary(error),
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
      ({ proposal, extraTotal } = staffExtrasOrBadRequest(effectiveQuoteInput, scope, prepared, revision, {
        dinnerGroupIds: effectiveQuoteInput.dinnerAllowanceGroupIds ?? dinnerFallbackGroupIds,
        ...(config.dinnerAddOn ? { dinnerAddOn: config.dinnerAddOn } : {}),
      }));
      attestation = attestStaffQuote(input, scope, prepared, revision, rowPrices, {
        dinnerAddOnRequired: proposal.dinnerAddOnRequired,
      });
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
    const persistRun = (quoteResult: Record<string, unknown>) =>
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
        // ponytail: U4 creates the quote's work item. Until it does, the approval is recorded and no rate event is written.
        const workItemId = rowPrices.length
          ? await quoteWorkItemIdFor(tx, {
              transportId: scope.transportId,
              threadId: scope.threadId,
              messageId: mail.id,
            })
          : null;
        if (workItemId)
          await recordRateEvents(tx, {
            workItemId,
            actorUserId: scope.userId,
            workflowRunId,
            revision,
            rowPrices,
          });
        if (
          options.commitQueuedResult &&
          !(await options.commitQueuedResult(quoteResult, tx as unknown as DB))
        ) {
          throw Object.assign(new Error('staff_quote_claim_lost'), { code: 'HMS_JOB_CLAIM_LOST' });
        }
      });
    const summary = async () => ({
      status: 'ready' as const,
      workflowRunId,
      revisionRef: revision.id,
      messageId: mail.id,
      threadId: mail.threadId,
      factRefs: proposal.factRefs,
      extrasReviewItems: [...notes, ...proposal.extrasReviewItems],
      dinnerAddOnRequired: proposal.dinnerAddOnRequired,
      ...(proposal.dinnerGroupIds.length || dinnerFallbackGroupIds.length
        ? { dinnerFallbackGroupIds: proposal.dinnerGroupIds.length ? proposal.dinnerGroupIds : dinnerFallbackGroupIds }
        : {}),
      ...(dinnerAddOnDetails(proposal, revision) ? { dinnerAddOn: dinnerAddOnDetails(proposal, revision) } : {}),
      rateOptions,
      selectionEpoch: input.selectionEpoch,
      inputRevision: input.inputRevision,
      inputDigest: prepared.inputDigest,
      totalMinor: pricedRoomTotal(revision, rowPrices) + extraTotal,
      currency: revision.currency,
      arrivalDate: revision.groups[0].arrivalDate,
      departureDate: revision.groups.at(-1)!.departureDate,
      // The HMS evidence behind this price backs a PDF only until then; a queued result is not reused past it.
      freshUntil: revision.sourceFreshness?.expiresAt ?? null,
      description: deriveQuoteLines(revision, rowPrices)
        .map((line) => line.description)
        .join('; '),
      // Per row: the HMS rate, the rate charged, and for an override the code and note for "Copy for HMS comments".
      rowRates: rowRatesFor(revision, rowPrices),
      runId,
      screenshots: runId ? await listQuoteRunScreenshots(config.outputDir, runId) : [],
    });
    if (traceAsync && traceFinishes.length > 0 && lockRun) {
      // Inline callers may show the captured quote while its trace finishes. A queued worker must
      // wait here: its read_tool result can be observed by another process as soon as it is done.
      queueEndedLater = true;
      const pending = lockRun
        .then(async () => {
          // A newer approval may have superseded this generation while the trace finished.
          if (!(await stillCurrent())) throw new Error('staff_quote_superseded');
          await persistRun(await summary());
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
          if (waitForTracePersistence && !(error instanceof Error && error.message === 'staff_quote_superseded')) {
            const failure = new Error('staff_quote_native_unavailable');
            Object.assign(failure, {
              code: 'staff_quote_native_unavailable',
              cause: staffQuoteCauseSummary(error),
            });
            throw failure;
          }
          if (waitForTracePersistence) throw error;
        })
        .finally(() => queued.end());
      registerPendingStaffQuote([workflowRunId, mail.id, ...(runId ? [runId] : [])], pending);
      if (waitForTracePersistence) await pending;
      return summary();
    }
    try {
      const result = await summary();
      await persistRun(result);
      return result;
    } catch (error) {
      await markGenerationFailed('staff_quote_persist_failed');
      throw error;
    }
  } finally {
    if (!queueEndedLater) queued.end();
  }
}
