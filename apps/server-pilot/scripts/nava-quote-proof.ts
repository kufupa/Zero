/**
 * Generic sequential /nava-preview quote proof. One browser serves each requested thread in order; the request guard
 * allows only quote reads and the pane's local work-item support, never HMS or mailbox writes.
 */
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Locator, Page, Request } from 'playwright';
import {
  Blocker,
  batchInput,
  latestOutcome,
  trpcProcedures,
  waitFor,
  type Captured,
  type TrpcOutcome,
} from './nava-ae4-override-proof';
import {
  DOC_MS,
  openProofPage,
  openThread,
  stayKeyOfRatesInput,
  type GuardDecision,
} from './nava-proof-kit';
import {
  ANALYSIS_PROCEDURES,
  fitPaneToContent,
  HMS_READ_PROCEDURES,
  KNOWN_WRITE_PROCEDURES,
  MARK_PII_JS,
  parseRunConfig,
  READ_PROCEDURES,
  redactText,
  safeSegment,
  type RunConfig,
} from './nava-preview-run';

const QUOTE_TIMEOUT_MS = 480_000;
const PARTY_SETTLE_MS = 240_000;
const PARTY_INDEX_START_GRACE_MS = 750;
const PARTY_INDEX_SETTLE_MS = 5_000;
const PARTY_SEARCH_START_GRACE_MS = 5_000;
const STEP_MS = 30_000;
const RATE_POLL_MS = 250;
const PARTY_SEARCH_LIMIT = 2;
const FIELD_EDIT_LIMIT = 4;
const MESSAGE_LIMIT = 220;

/** Page targets use accessible names; structural locators only scope a semantic rate card or labelled field. */
export const QUOTE_SELECTORS = {
  intent: 'Nava reads this as',
  contactRegion: 'Guest & contact',
  contactNameValue: '[data-contact-field="name"] dd > span',
  contactEmailValue: '[data-contact-field="email"] dd > span',
  stayRegion: 'Stay',
  stayArticle: /^Stay \d+ details$/,
  changeDates: 'Change dates',
  arrival: 'Arrival',
  departure: 'Departure',
  roomTable: 'Room types & occupancy',
  roomRow: /^.+ ×(?:\d+|\?)$/,
  roomType: 'Room type',
  roomCount: /^Rooms for stay \d+, room \d+$/,
  adultText: /^(?:\d+\s+adults?\s+per\s+room|Adults per room not set)$/i,
  mealPlan: 'Meal plan',
  mealMissingFlag: 'Missing',
  fieldAncestor: 'xpath=ancestor::div[1]',
  companyGroup: 'Company lookup in HMS',
  agencyGroup: 'Agency lookup in HMS',
  companyField: 'Company (end client)',
  agencyField: 'Agency (travel agent)',
  hmsListRegion: 'Matches from the HMS list',
  liveMatchLabels: ['Found in HMS:', 'Also in HMS:'] as const,
  liveMatchContainer: 'xpath=..',
  confirmParty: /^Confirm .+$/,
  emailSuggestion: /^.+\((?:Company|Agency)\), not confirmed in HMS$/,
  selectedParty: /✓\s*(.+?)\s+\(#([^)]+)\)(?:\s+— picked by Nava)?/,
  advanced: 'Advanced',
  ratePlan: 'Rate plan',
  ratesRegion: 'Rates',
  rateHeading: 'Availability for this date range',
  rateArticleAncestor: 'xpath=ancestor::article[1]',
  searchButton: /^(?:Search availability|Retry search|Search again)$/,
  getRatesButton: /^Get rates(?: from HMS)?$/,
  rateCardsGroup: 'Room rates from HMS',
  pricedCard: /avg\s*\/\s*room\s*\/\s*night/i,
  detailsButton: 'Details',
  pendingParty: /Searching HMS for|Queued(?:\s|\(|$)|Running(?:\s|\(|\.|$)|Retrying/i,
  pendingPartyReadBack: /Checking for a background HMS lookup/i,
  pendingRate: /Starting the HMS run|Getting rates from HMS|Queued(?:\s|\(|$)|Running(?:\s|\(|\.|$)|Retrying/i,
  docsRegion: 'Quote',
  prepareButton: /^Prepare (?:quote|PDF)$/,
  excelButton: 'Download Excel',
  screenshotMask: '[data-runner-mask], [data-pii]',
} as const;

const STAFF_QUOTE_PROCEDURE = 'workstation.executeStaffQuote';
const QUEUED_STAFF_QUOTE_PROCEDURE = 'workstation.queueStaffQuote';
const STAFF_QUOTE_JOB_PROCEDURE = 'workstation.staffQuoteJob';
const STAFF_QUOTE_PROCEDURES: ReadonlySet<string> = new Set([
  STAFF_QUOTE_PROCEDURE,
  QUEUED_STAFF_QUOTE_PROCEDURE,
]);
const PDF_PROCEDURE = 'workstation.qualifiedQuoteProposalPdf';
const WORKBOOK_PROCEDURE = 'workstation.quoteWorkbook';
const PARTY_LOOKUP_PROCEDURE = 'panePartyLookup.findParty';
const QUEUED_PARTY_LOOKUP_PROCEDURE = 'paneStayLookup.queueParty';
const QUEUED_JOB_READS: ReadonlySet<string> = new Set([
  'workstation.staffQuoteJob',
  'paneStayLookup.jobStatus',
  'paneStayLookup.jobQueueEnabled',
]);
const QUOTE_SUPPORT_WRITES: ReadonlySet<string> = new Set([
  'workItems.open',
  'workItems.recordActions',
  'workItems.acceptFields',
  'workItems.recordEvent',
  PDF_PROCEDURE,
  WORKBOOK_PROCEDURE,
]);

export type QuoteGuardReason =
  | 'unknown'
  | 'write'
  | 'rate_without_stay'
  | 'unexpected_stay'
  | 'duplicate_rate'
  | 'party_lookup_limit'
  | 'edits_disabled'
  | 'edit_limit'
  | 'second_document';

export type QuoteGuardState = {
  expectedRateKeys: Set<string>;
  ratedRateKeys: string[];
  partyLookups: number;
  partyLookupRoutes: Map<string, Set<string>>;
  fieldEdits: number;
  pdfs: number;
  workbooks: number;
  allowEdits: boolean;
};

export function newQuoteGuardState(
  expectedRateKeys: readonly string[] = [],
  allowEdits = false,
): QuoteGuardState {
  return {
    expectedRateKeys: new Set(expectedRateKeys),
    ratedRateKeys: [],
    partyLookups: 0,
    partyLookupRoutes: new Map(),
    fieldEdits: 0,
    pdfs: 0,
    workbooks: 0,
    allowEdits,
  };
}

/** A batch is allowed only when every route is safe; guard counts advance only for a fully allowed request. */
export function classifyQuoteRequest(
  url: string,
  postData: string | null,
  state: QuoteGuardState,
): GuardDecision<QuoteGuardReason> {
  let procedures: string[];
  try {
    procedures = trpcProcedures(url);
  } catch {
    procedures = [];
  }
  if (procedures.length === 0) {
    return { allowed: false, procedures, blocked: [{ procedure: '(none)', reason: 'unknown' }] };
  }
  const blocked: GuardDecision<QuoteGuardReason>['blocked'] = [];
  const pending = {
    rates: [] as string[],
    parties: 0,
    partyLookupRoutes: new Map<string, Set<string>>(),
    edits: 0,
    pdfs: 0,
    workbooks: 0,
  };
  procedures.forEach((procedure, index) => {
    const refuse = (reason: QuoteGuardReason) => blocked.push({ procedure, reason });
    if (READ_PROCEDURES.has(procedure) || ANALYSIS_PROCEDURES.has(procedure) || QUEUED_JOB_READS.has(procedure)) return;
    if (
      (procedure === PARTY_LOOKUP_PROCEDURE && HMS_READ_PROCEDURES.has(procedure)) ||
      procedure === QUEUED_PARTY_LOOKUP_PROCEDURE
    ) {
      const input = batchInput(postData, index) as
        | { name?: unknown; kind?: unknown; partyKind?: unknown }
        | undefined;
      const name = typeof input?.name === 'string' ? normalizedName(input.name) : '';
      const kind = procedure === PARTY_LOOKUP_PROCEDURE ? input?.kind : input?.partyKind;
      const key = name ? `${typeof kind === 'string' ? kind : ''}:${name}` : null;
      if (!key) {
        if (state.partyLookups + pending.parties >= PARTY_SEARCH_LIMIT) refuse('party_lookup_limit');
        else pending.parties += 1;
        return;
      }
      const used = state.partyLookupRoutes.get(key);
      const inBatch = pending.partyLookupRoutes.get(key);
      const alreadyCalled = used?.has(procedure) || inBatch?.has(procedure);
      const reversedFallback =
        procedure === QUEUED_PARTY_LOOKUP_PROCEDURE &&
        (used?.has(PARTY_LOOKUP_PROCEDURE) || inBatch?.has(PARTY_LOOKUP_PROCEDURE));
      if (alreadyCalled || reversedFallback) {
        refuse('party_lookup_limit');
        return;
      }
      const hasPreviousQueueCall = used?.has(QUEUED_PARTY_LOOKUP_PROCEDURE) || inBatch?.has(QUEUED_PARTY_LOOKUP_PROCEDURE);
      const hasPreviousCall = Boolean(used?.size || inBatch?.size);
      if (!hasPreviousCall) {
        if (state.partyLookups + pending.parties >= PARTY_SEARCH_LIMIT) {
          refuse('party_lookup_limit');
          return;
        }
        pending.parties += 1;
      } else if (!(procedure === PARTY_LOOKUP_PROCEDURE && hasPreviousQueueCall)) {
        refuse('party_lookup_limit');
        return;
      }
      const routes = inBatch ?? new Set<string>();
      routes.add(procedure);
      pending.partyLookupRoutes.set(key, routes);
      return;
    }
    if (STAFF_QUOTE_PROCEDURES.has(procedure)) {
      const key = stayKeyOfRatesInput(batchInput(postData, index));
      if (!key) refuse('rate_without_stay');
      else if (!state.expectedRateKeys.has(key)) refuse('unexpected_stay');
      else if (state.ratedRateKeys.includes(key) || pending.rates.includes(key)) refuse('duplicate_rate');
      else pending.rates.push(key);
      return;
    }
    if (!QUOTE_SUPPORT_WRITES.has(procedure)) {
      refuse(KNOWN_WRITE_PROCEDURES.has(procedure) ? 'write' : 'unknown');
      return;
    }
    if (procedure === 'workItems.recordEvent') {
      if (!state.allowEdits) refuse('edits_disabled');
      else if (state.fieldEdits + pending.edits >= FIELD_EDIT_LIMIT) refuse('edit_limit');
      else pending.edits += 1;
      return;
    }
    if (procedure === PDF_PROCEDURE) {
      if (state.pdfs + pending.pdfs >= 1) refuse('second_document');
      else pending.pdfs += 1;
      return;
    }
    if (procedure === WORKBOOK_PROCEDURE) {
      if (state.workbooks + pending.workbooks >= 1) refuse('second_document');
      else pending.workbooks += 1;
    }
  });
  const allowed = blocked.length === 0;
  if (allowed) {
    state.ratedRateKeys.push(...pending.rates);
    state.partyLookups += pending.parties;
    for (const [key, routes] of pending.partyLookupRoutes) {
      const priorRoutes = state.partyLookupRoutes.get(key) ?? new Set<string>();
      for (const procedure of routes) priorRoutes.add(procedure);
      state.partyLookupRoutes.set(key, priorRoutes);
    }
    state.fieldEdits += pending.edits;
    state.pdfs += pending.pdfs;
    state.workbooks += pending.workbooks;
  }
  return { allowed, procedures, blocked };
}

export type QuotePrefilledRoom = { room: number; type: string | null; rooms: number | null; adults: number | null };
export type QuotePrefilledStay = {
  stay: number;
  arrival: string | null;
  departure: string | null;
  rooms: QuotePrefilledRoom[];
  mealPlan: string | null;
  mealPlanMissing: boolean;
};
export type QuotePrefilled = {
  contact: { name: string | null; email: string | null };
  stays: QuotePrefilledStay[];
  ratePlan: string | null;
};
export type QuotePartyCandidate = {
  kind: 'company' | 'agency';
  name: string;
  source: 'hms_list' | 'live_hms' | 'email';
  nativeId?: string;
};
export type QuoteParty = {
  suggested: QuotePartyCandidate[];
  accepted: Array<{
    kind: 'company' | 'agency';
    name: string;
    source: 'hms_list' | 'live_hms' | 'prefilled';
    nativeId?: string;
  }>;
  /** True when a candidate came from the locally prebuilt HMS list; the pane exposes no persisted job id for it. */
  prefetched: boolean;
};
export type QuoteProofThread = {
  threadId: string;
  kind: string;
  prefilled: QuotePrefilled;
  party: QuoteParty;
  rates: { outcome: string | null; seconds: number | null; cards: number };
  docs: { pdfBytes: number | null; xlsxBytes: number | null };
  /** Values the driver set with NAVA_PROOF_ALLOW_EDITS=1, as staff would ("stay1.room1.type=STWN (suggested)"). */
  edits: string[];
  blocker: string | null;
};
type QuoteProofScore = Pick<QuoteProofThread, 'rates' | 'blocker'>;

export type PartyLookupReadiness = {
  pending: boolean;
  readBackPending: boolean;
  autoLookupExpected: boolean;
  autoLookupStarted: boolean;
  autoLookupComplete: boolean;
  autoStartGraceElapsed: boolean;
  indexLookupExpected: boolean;
  indexRequestStarted: boolean;
  indexResponseComplete: boolean;
  indexStartGraceElapsed: boolean;
};

export function partyLookupsReady(state: PartyLookupReadiness): boolean {
  return (
    !state.pending &&
    !state.readBackPending &&
    (!state.autoLookupExpected ||
      state.autoLookupComplete ||
      (!state.autoLookupStarted && state.autoStartGraceElapsed)) &&
    (!state.indexLookupExpected || state.indexResponseComplete || (!state.indexRequestStarted && state.indexStartGraceElapsed))
  );
}

export type PartyLookupActionState = {
  query: string | null;
  selected: boolean;
  pending: boolean;
  readBackPending: boolean;
  hasConfirm: boolean;
  hasResults: boolean;
  searchStarted: boolean;
  searchComplete: boolean;
  startGraceElapsed: boolean;
  attempted: boolean;
  findEnabled: boolean;
};

export function partyLookupAction(state: PartyLookupActionState): 'wait' | 'search' | 'ready' {
  if (state.pending || state.readBackPending) return 'wait';
  if (state.selected || !state.query || state.query.trim().length < 2) return 'ready';
  if (state.hasConfirm || state.hasResults || state.searchComplete) return 'ready';
  if (state.searchStarted) return 'wait';
  if (!state.startGraceElapsed) return 'wait';
  if (state.attempted) return 'ready';
  return state.findEnabled ? 'search' : 'ready';
}

export function rateWaitBudget(deadline: number, now = Date.now(), stepLimit = STEP_MS): number {
  return Math.max(0, Math.min(stepLimit, deadline - now));
}

export function rateKeysForDateRanges(
  stays: readonly Pick<QuotePrefilledStay, 'arrival' | 'departure'>[],
): Set<string> {
  const keys = new Set<string>();
  stays.forEach((stay) => {
    if (stay.arrival && stay.departure) keys.add(stay.arrival + ':' + stay.departure);
  });
  return keys;
}

export function rateSearchAction(key: string, requestedRateKeys: readonly string[]): 'observe' | 'search' {
  return requestedRateKeys.includes(key) ? 'observe' : 'search';
}

export async function withPiiMask<T>(markPii: () => Promise<unknown>, capture: () => Promise<T>): Promise<T> {
  try {
    await markPii();
  } catch {
    throw new Blocker('PII masking failed; screenshot skipped');
  }
  return capture();
}

export function choosePartyCandidate<T extends { name: string }>(candidates: readonly T[], query: string | null): T | null {
  if (!candidates.length) return null;
  const exact = query ? candidates.filter((candidate) => normalizedName(candidate.name) === normalizedName(query)) : [];
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  return candidates.length === 1 ? candidates[0]! : null;
}

export function liveHmsCandidateFromText(kind: PartyKind, text: string): QuotePartyCandidate | null {
  const match = /^(.+)\s+\(#([^)]+)\)$/.exec(text.trim());
  if (!match) return null;
  return { kind, name: match[1]!.trim(), source: 'live_hms', nativeId: match[2]!.trim() };
}

export function isNamedRefusal(outcome: string | null | undefined): boolean {
  const match = /^refused:\s*(.+)$/i.exec(outcome?.trim() ?? '');
  if (!match) return false;
  const reason = match[1]!.trim();
  return (
    reason.length >= 8 &&
    !/^(?:refused|failed|failure|error|unknown|unavailable|not available|timeout|timed out)\.?$/i.test(reason)
  );
}

export function quoteProofPass(threads: readonly QuoteProofScore[]): boolean {
  return (
    threads.length > 0 &&
    threads.every(
      (thread) =>
        thread.blocker === null &&
        (thread.rates.outcome === 'priced' || isNamedRefusal(thread.rates.outcome)),
    )
  );
}

export type QuoteProofConfig = RunConfig & {
  threadIds: string[];
  allowEdits: boolean;
};

/** Defaults to eight minutes and rejects every thread count outside the existing preview gate's 1–20 bound. */
export function parseQuoteProofConfig(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): QuoteProofConfig {
  const allowedFlags = new Set(['--threads', '--out', '--timeout-ms']);
  const seenFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!allowedFlags.has(flag)) throw new Error('quote proof has an unsupported option');
    if (seenFlags.has(flag)) throw new Error('quote proof options must not be repeated');
    if (!value || value.startsWith('--')) throw new Error(flag + ' needs a value');
    seenFlags.add(flag);
  }
  const threadsAt = argv.indexOf('--threads');
  const rawThreads = threadsAt >= 0 ? argv[threadsAt + 1] ?? '' : '';
  if (!rawThreads || rawThreads.split(',').some((id) => !id.trim())) {
    throw new Error('quote proof needs --threads with 1 to 20 thread ids');
  }
  const normalizedArgv = argv.includes('--timeout-ms') ? [...argv] : [...argv, '--timeout-ms', String(QUOTE_TIMEOUT_MS)];
  const base = parseRunConfig(normalizedArgv, env, cwd);
  if (base.selection.kind !== 'threads') throw new Error('quote proof runs on explicit --threads only');
  if (base.selection.ids.length > 20) throw new Error('quote proof accepts 1 to 20 thread ids');
  if (new Set(base.selection.ids).size !== base.selection.ids.length) throw new Error('quote proof thread ids must be unique');
  if (base.timeoutMs > QUOTE_TIMEOUT_MS) throw new Error('quote proof --timeout-ms must not exceed 480000');
  return {
    ...base,
    threadIds: base.selection.ids,
    allowEdits: env.NAVA_PROOF_ALLOW_EDITS?.trim() === '1',
  };
}

const emptyPrefilled = (): QuotePrefilled => ({
  contact: { name: null, email: null },
  stays: [],
  ratePlan: null,
});

const emptyParty = (): QuoteParty => ({ suggested: [], accepted: [], prefetched: false });

function emptyThread(threadId: string): QuoteProofThread {
  return {
    threadId,
    kind: 'unknown',
    prefilled: emptyPrefilled(),
    party: emptyParty(),
    rates: { outcome: null, seconds: null, cards: 0 },
    docs: { pdfBytes: null, xlsxBytes: null },
    edits: [],
    blocker: null,
  };
}

export function quoteThreadFailure(
  proof: QuoteProofThread,
  error: unknown,
  blocked: readonly string[] = [],
): QuoteProofThread {
  const uniqueBlocked = [...new Set(blocked)];
  const blocker = uniqueBlocked.length
    ? 'guard_blocked:' + uniqueBlocked.join(',')
    : error instanceof Blocker
      ? redactText(error.message).slice(0, MESSAGE_LIMIT)
      : 'crashed: ' + redactText(error instanceof Error ? error.message : 'unknown error').slice(0, MESSAGE_LIMIT);
  return { ...proof, blocker };
}

async function controlValue(locator: Locator): Promise<string | null> {
  const value = await locator.inputValue().catch(() => '');
  return value.trim() || null;
}

async function displayValue(locator: Locator): Promise<string | null> {
  const value = (await locator.innerText().catch(() => '')).trim();
  return value && value !== '—' ? value : null;
}

async function selectedOptionLabel(locator: Locator): Promise<string | null> {
  const option = locator.getByRole('option', { selected: true }).first();
  const label = await option.innerText().catch(() => '');
  return label.trim() || (await controlValue(locator));
}

function countFromText(text: string): number | null {
  const match = /\b(\d+)\b/.exec(text);
  return match ? Number(match[1]) : null;
}

function adultsFromText(text: string): number | null {
  const match = /^(\d+)\s+adults?\s+per\s+room$/i.exec(text.trim());
  return match ? Number(match[1]) : null;
}

export async function openStayDateInputs(stay: Locator): Promise<{ arrival: Locator; departure: Locator }> {
  const arrival = stay.getByLabel(QUOTE_SELECTORS.arrival, { exact: true });
  const departure = stay.getByLabel(QUOTE_SELECTORS.departure, { exact: true });
  if (!(await arrival.isVisible().catch(() => false))) {
    await stay.getByRole('button', { name: QUOTE_SELECTORS.changeDates, exact: true }).click();
  }
  await arrival.waitFor({ state: 'visible', timeout: STEP_MS });
  await departure.waitFor({ state: 'visible', timeout: STEP_MS });
  return { arrival, departure };
}

async function readPrefilled(page: Page): Promise<QuotePrefilled> {
  const contact = page.getByRole('region', { name: QUOTE_SELECTORS.contactRegion });
  const prefilled = emptyPrefilled();
  prefilled.contact.name = await displayValue(contact.locator(QUOTE_SELECTORS.contactNameValue));
  prefilled.contact.email = await displayValue(contact.locator(QUOTE_SELECTORS.contactEmailValue));

  const stays = page.getByRole('region', { name: QUOTE_SELECTORS.stayRegion }).getByRole('article', {
    name: QUOTE_SELECTORS.stayArticle,
  });
  for (let stayIndex = 0; stayIndex < (await stays.count()); stayIndex += 1) {
    const stay = stays.nth(stayIndex);
    const dateInputs = await openStayDateInputs(stay);
    const rooms: QuotePrefilledRoom[] = [];
    const rows = stay
      .getByRole('table', { name: QUOTE_SELECTORS.roomTable, exact: true })
      .getByRole('row', { name: QUOTE_SELECTORS.roomRow });
    for (let roomIndex = 0; roomIndex < (await rows.count()); roomIndex += 1) {
      const row = rows.nth(roomIndex);
      const typeSelect = row.getByRole('combobox', { name: QUOTE_SELECTORS.roomType, exact: true });
      const typeValue = await controlValue(typeSelect);
      const typeLabel = await selectedOptionLabel(typeSelect);
      const type =
        typeLabel === 'Email request'
          ? 'Email request' + (typeValue && typeValue !== 'Email request' ? ' (' + typeValue + ')' : '')
          : typeLabel === 'Choose room type'
            ? null
            : typeLabel;
      const countGroup = row.getByRole('group', {
        name: QUOTE_SELECTORS.roomCount,
      });
      const countText = await countGroup.innerText().catch(() => '');
      const adultText = await row.getByText(QUOTE_SELECTORS.adultText).innerText().catch(() => '');
      rooms.push({
        room: roomIndex + 1,
        type: type ?? null,
        rooms: countFromText(countText),
        adults: adultsFromText(adultText),
      });
    }
    const mealSelect = stay.getByRole('combobox', { name: QUOTE_SELECTORS.mealPlan, exact: true });
    const mealPlan = await selectedOptionLabel(mealSelect);
    const mealField = mealSelect.locator(QUOTE_SELECTORS.fieldAncestor);
    prefilled.stays.push({
      stay: stayIndex + 1,
      arrival: await controlValue(dateInputs.arrival),
      departure: await controlValue(dateInputs.departure),
      rooms,
      mealPlan,
      mealPlanMissing:
        mealPlan === 'unknown' ||
        (await mealField.getByText(QUOTE_SELECTORS.mealMissingFlag, { exact: true }).count()) > 0,
    });
  }

  const advanced = page.getByRole('button', { name: QUOTE_SELECTORS.advanced, exact: true });
  if (await advanced.count()) await advanced.first().click().catch(() => undefined);
  const ratePlan = page.getByRole('combobox', { name: QUOTE_SELECTORS.ratePlan, exact: true });
  prefilled.ratePlan = await selectedOptionLabel(ratePlan);
  return prefilled;
}

async function readPaneRateKeys(page: Page): Promise<Set<string>> {
  const stays = page.getByRole('region', { name: QUOTE_SELECTORS.stayRegion }).getByRole('article', {
    name: QUOTE_SELECTORS.stayArticle,
  });
  const dateRanges: Array<{ arrival: string | null; departure: string | null }> = [];
  for (let stayIndex = 0; stayIndex < (await stays.count()); stayIndex += 1) {
    const dateInputs = await openStayDateInputs(stays.nth(stayIndex));
    dateRanges.push({
      arrival: await controlValue(dateInputs.arrival),
      departure: await controlValue(dateInputs.departure),
    });
  }
  return rateKeysForDateRanges(dateRanges);
}

async function initializeExpectedRateKeysFromPane(page: Page, guard: QuoteGuardState): Promise<void> {
  if (guard.expectedRateKeys.size) return;
  const keys = await waitFor('stay dates for the queued rate read', STEP_MS, async () => {
    const shown = await readPaneRateKeys(page);
    return shown.size ? shown : null;
  }).catch(() => new Set<string>());
  if (keys.size) guard.expectedRateKeys = keys;
}

function validDate(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Required fields are named, never filled: the driver does not invent dates, rooms, occupancy, or meal plans. */
export function requiredQuoteEdits(prefilled: QuotePrefilled): string[] {
  const missing: string[] = [];
  prefilled.stays.forEach((stay) => {
    const prefix = 'stay' + stay.stay;
    if (!validDate(stay.arrival)) missing.push(prefix + '.arrival');
    if (!validDate(stay.departure) || (stay.arrival && stay.departure && stay.departure <= stay.arrival)) {
      missing.push(prefix + '.departure');
    }
    if (!stay.rooms.length) missing.push(prefix + '.rooms');
    stay.rooms.forEach((room) => {
      const roomPrefix = prefix + '.room' + room.room;
      if (!room.type || /^Email request/i.test(room.type)) missing.push(roomPrefix + '.type');
      if (room.rooms === null || room.rooms < 1) missing.push(roomPrefix + '.rooms');
      if (room.adults === null || room.adults < 1) missing.push(roomPrefix + '.adults');
    });
    if (stay.mealPlanMissing || !stay.mealPlan || /^(?:not stated in email|unknown)$/i.test(stay.mealPlan)) {
      missing.push(prefix + '.mealPlan');
    }
  });
  if (!prefilled.stays.length) missing.push('stays');
  return missing;
}

export type RoomTypeChoice = { value: string; how: 'suggested' | 'first_listed' };

/**
 * The room type staff would pick for a row the email left open: the pane's first suggestion for what the email asked
 * ("Single" → Standard Twin), else, when the email names no type, the first listed HMS type. Null when neither exists.
 */
export function chooseRoomType(
  asked: boolean,
  suggestions: readonly string[],
  options: readonly { value: string; label: string }[],
): RoomTypeChoice | null {
  if (suggestions[0]) return { value: suggestions[0], how: 'suggested' };
  if (asked) return null;
  const first = options.find((option) => /\([A-Z]{2,8}\)$/.test(option.label) && option.value);
  return first ? { value: first.value, how: 'first_listed' } : null;
}

/** With NAVA_PROOF_ALLOW_EDITS=1, sets each open room type the way staff would and names every value it set. */
async function fillOpenRoomTypes(page: Page, prefilled: QuotePrefilled): Promise<string[]> {
  const edits: string[] = [];
  const stays = page.getByRole('region', { name: QUOTE_SELECTORS.stayRegion }).getByRole('article', {
    name: QUOTE_SELECTORS.stayArticle,
  });
  for (const stay of prefilled.stays) {
    for (const room of stay.rooms) {
      const asked = Boolean(room.type && /^Email request/i.test(room.type));
      if (room.type && !asked) continue;
      const row = stays
        .nth(stay.stay - 1)
        .getByRole('table', { name: QUOTE_SELECTORS.roomTable, exact: true })
        .getByRole('row', { name: QUOTE_SELECTORS.roomRow })
        .nth(room.room - 1);
      const select = row.getByRole('combobox', { name: QUOTE_SELECTORS.roomType, exact: true });
      const options = await select
        .locator('option')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({ value: (node as HTMLOptionElement).value, label: (node.textContent ?? '').trim() })),
        );
      const chips = row.getByRole('group', { name: 'Room type suggestions', exact: true }).getByRole('button');
      const suggestions: string[] = [];
      for (let index = 0; index < (await chips.count()); index += 1) {
        const label = (await chips.nth(index).innerText()).trim();
        const option = options.find((item) => item.label.replace(/\s+\([A-Z]+\)$/, '') === label);
        if (option) suggestions.push(option.value);
      }
      const choice = chooseRoomType(asked, suggestions, options);
      if (!choice) continue;
      await select.selectOption(choice.value);
      edits.push(`stay${stay.stay}.room${room.room}.type=${choice.value} (${choice.how})`);
    }
  }
  return edits;
}

type PartyKind = 'company' | 'agency';

function partyGroup(page: Page, kind: PartyKind): Locator {
  return page.getByRole('group', {
    name: kind === 'company' ? QUOTE_SELECTORS.companyGroup : QUOTE_SELECTORS.agencyGroup,
    exact: true,
  });
}

function selectedParty(text: string): { name: string; nativeId: string; byNava: boolean } | null {
  const match = QUOTE_SELECTORS.selectedParty.exec(text);
  return match
    ? { name: match[1]!.trim(), nativeId: match[2]!.trim(), byNava: Boolean(/— picked by Nava/.test(match[0])) }
    : null;
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

type PartyIndexSignals = {
  requestedAt: Map<string, number>;
  inFlight: Map<string, number>;
  completed: Set<string>;
  partyRequestedAt: Map<string, number>;
  partyInFlight: Map<string, number>;
  partyCompleted: Set<string>;
};

function partyIndexQuery(request: Request): string | null {
  const procedures = trpcProcedures(request.url());
  for (const [index, procedure] of procedures.entries()) {
    if (procedure !== 'panePartyLookup.typeahead') continue;
    const input = batchInput(request.postData(), index) as { query?: unknown } | undefined;
    if (typeof input?.query === 'string' && input.query.trim()) return input.query.trim();
  }
  return null;
}

type PartySearchRequest = { key: string; completesSearch: boolean };

function partyLookupKey(kind: PartyKind, name: string): string {
  return kind + ':' + normalizedName(name);
}

function partySearchRequests(request: Request): PartySearchRequest[] {
  const procedures = trpcProcedures(request.url());
  const found: PartySearchRequest[] = [];
  for (const [index, procedure] of procedures.entries()) {
    if (procedure !== PARTY_LOOKUP_PROCEDURE && procedure !== QUEUED_PARTY_LOOKUP_PROCEDURE) continue;
    const input = batchInput(request.postData(), index) as
      | { name?: unknown; kind?: unknown; partyKind?: unknown }
      | undefined;
    if (typeof input?.name !== 'string' || !input.name.trim()) continue;
    const kind = procedure === PARTY_LOOKUP_PROCEDURE ? input.kind : input.partyKind;
    if (kind !== 'company' && kind !== 'agency') continue;
    found.push({
      key: partyLookupKey(kind, input.name),
      completesSearch: procedure === PARTY_LOOKUP_PROCEDURE,
    });
  }
  return found;
}

function watchPartyIndex(page: Page): { signals: PartyIndexSignals; stop: () => void; reset: () => void } {
  const signals: PartyIndexSignals = {
    requestedAt: new Map(),
    inFlight: new Map(),
    completed: new Set(),
    partyRequestedAt: new Map(),
    partyInFlight: new Map(),
    partyCompleted: new Set(),
  };
  const queries = new WeakMap<Request, { query: string; epoch: number }>();
  const partySearches = new WeakMap<Request, { searches: PartySearchRequest[]; epoch: number }>();
  let epoch = 0;
  const onRequest = (request: Request) => {
    const query = partyIndexQuery(request);
    if (query) {
      queries.set(request, { query, epoch });
      if (!signals.requestedAt.has(query)) signals.requestedAt.set(query, Date.now());
      signals.inFlight.set(query, (signals.inFlight.get(query) ?? 0) + 1);
      signals.completed.delete(query);
    }
    const searches = partySearchRequests(request);
    if (searches.length) {
      partySearches.set(request, { searches, epoch });
      for (const search of searches) {
        if (!signals.partyRequestedAt.has(search.key)) signals.partyRequestedAt.set(search.key, Date.now());
        signals.partyInFlight.set(search.key, (signals.partyInFlight.get(search.key) ?? 0) + 1);
        signals.partyCompleted.delete(search.key);
      }
    }
  };
  const onFinished = (request: Request) => {
    const requestState = queries.get(request);
    if (requestState?.epoch === epoch) {
      const { query } = requestState;
      const inFlight = Math.max(0, (signals.inFlight.get(query) ?? 1) - 1);
      signals.inFlight.set(query, inFlight);
      if (inFlight === 0) signals.completed.add(query);
    }
    const partyRequestState = partySearches.get(request);
    if (partyRequestState?.epoch === epoch) {
      for (const search of partyRequestState.searches) {
        const inFlight = Math.max(0, (signals.partyInFlight.get(search.key) ?? 1) - 1);
        signals.partyInFlight.set(search.key, inFlight);
        if (search.completesSearch) signals.partyCompleted.add(search.key);
      }
    }
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFinished);
  return {
    signals,
    stop: () => {
      page.off('request', onRequest);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFinished);
    },
    reset: () => {
      epoch += 1;
      signals.requestedAt.clear();
      signals.inFlight.clear();
      signals.completed.clear();
      signals.partyRequestedAt.clear();
      signals.partyInFlight.clear();
      signals.partyCompleted.clear();
    },
  };
}

async function settlePartyLookups(page: Page, signals: PartyIndexSignals): Promise<void> {
  const fieldStartedAt = new Map<PartyKind, number>();
  const manualSearchAttempted = new Set<PartyKind>();
  const manualSearchAttemptedAt = new Map<PartyKind, number>();
  await waitFor('company and agency lookups in HMS to settle', PARTY_SETTLE_MS, async () => {
    for (const kind of ['company', 'agency'] as const) {
      const group = partyGroup(page, kind);
      if (!(await group.count())) continue;
      if (!fieldStartedAt.has(kind)) fieldStartedAt.set(kind, Date.now());
      const fieldName = kind === 'company' ? QUOTE_SELECTORS.companyField : QUOTE_SELECTORS.agencyField;
      const query = await controlValue(page.getByRole('textbox', { name: fieldName, exact: true }));
      const selected = selectedParty(await group.innerText().catch(() => ''));
      const statuses = group.getByRole('status');
      let pending = false;
      let readBackPending = false;
      let completedStatus = false;
      for (let index = 0; index < (await statuses.count()); index += 1) {
        const text = await statuses.nth(index).innerText().catch(() => '');
        if (QUOTE_SELECTORS.pendingPartyReadBack.test(text)) readBackPending = true;
        else if (QUOTE_SELECTORS.pendingParty.test(text)) pending = true;
        else if (text.trim()) completedStatus = true;
      }

      let hasLiveRows = false;
      for (const label of QUOTE_SELECTORS.liveMatchLabels) {
        if ((await group.getByText(label, { exact: true }).count()) > 0) hasLiveRows = true;
      }
      const hasConfirm = (await group.getByRole('button', { name: QUOTE_SELECTORS.confirmParty }).count()) > 0;
      const queuedRows = group.getByRole('list', {
        name: 'Companies and agencies found in HMS',
        exact: true,
      });
      const hasQueuedResults =
        (await queuedRows.count()) > 0 && (await queuedRows.getByRole('button').count()) > 0;
      const hasResults = Boolean(selected?.byNava || hasLiveRows || hasConfirm || hasQueuedResults);
      const searchKey = query ? partyLookupKey(kind, query) : null;
      const searchRequested = Boolean(searchKey && signals.partyRequestedAt.has(searchKey));
      const searchInFlight = Boolean(searchKey && (signals.partyInFlight.get(searchKey) ?? 0) > 0);
      const searchComplete = Boolean(searchKey && signals.partyCompleted.has(searchKey));
      pending ||= searchInFlight;
      const autoLookupExpected = Boolean(query && query.length >= 3 && !selected);
      const autoLookupStarted = Boolean(searchRequested || pending || hasResults || completedStatus || searchComplete);
      const autoLookupComplete = Boolean(hasResults || completedStatus || searchComplete);
      const indexLookupExpected = Boolean(query && !selected);
      const requestedAt = query ? signals.requestedAt.get(query) : undefined;
      const indexRequestStarted = requestedAt !== undefined;
      const indexResponseComplete = query ? signals.completed.has(query) : false;
      if (requestedAt !== undefined && !indexResponseComplete && Date.now() - requestedAt > PARTY_INDEX_SETTLE_MS) {
        throw new Blocker('party_index_timeout');
      }
      const now = Date.now();
      const startGraceElapsed = now - fieldStartedAt.get(kind)! >= PARTY_INDEX_START_GRACE_MS;
      const manualSearchAttemptedForKind = manualSearchAttempted.has(kind);
      const manualSearchStartGraceElapsed =
        manualSearchAttemptedForKind &&
        now - (manualSearchAttemptedAt.get(kind) ?? now) >= PARTY_SEARCH_START_GRACE_MS;
      const indexStartGraceElapsed = startGraceElapsed;
      if (
        !partyLookupsReady({
          pending,
          readBackPending,
          autoLookupExpected,
          autoLookupStarted,
          autoLookupComplete,
          autoStartGraceElapsed: startGraceElapsed,
          indexLookupExpected,
          indexRequestStarted,
          indexResponseComplete,
          indexStartGraceElapsed,
        })
      ) {
        return null;
      }

      const findButton = group.getByRole('button', { name: 'Find in HMS', exact: true });
      const findEnabled =
        (await findButton.count()) > 0 && (await findButton.first().isEnabled().catch(() => false));
      const action = partyLookupAction({
        query,
        selected: Boolean(selected),
        pending,
        readBackPending,
        hasConfirm,
        hasResults,
        searchStarted: searchRequested,
        searchComplete: Boolean(searchComplete || completedStatus),
        startGraceElapsed: manualSearchAttemptedForKind ? manualSearchStartGraceElapsed : startGraceElapsed,
        attempted: manualSearchAttemptedForKind,
        findEnabled,
      });
      if (action === 'wait') return null;
      if (action === 'search') {
        manualSearchAttempted.add(kind);
        manualSearchAttemptedAt.set(kind, now);
        try {
          await findButton.first().click({ timeout: STEP_MS });
        } catch {
          throw new Blocker('Find in HMS could not be started');
        }
        return null;
      }
    }
    return true;
  });
}

async function readEmailSuggestions(group: Locator, kind: PartyKind): Promise<QuotePartyCandidate[]> {
  const suggestions = group.getByText(QUOTE_SELECTORS.emailSuggestion);
  const output: QuotePartyCandidate[] = [];
  for (let index = 0; index < (await suggestions.count()); index += 1) {
    const text = (await suggestions.nth(index).innerText().catch(() => '')).trim();
    const name = text.replace(/\s+\((?:Company|Agency)\), not confirmed in HMS$/i, '').trim();
    if (name) output.push({ kind, name, source: 'email' });
  }
  return output;
}

type PartyCandidateOption = QuotePartyCandidate & { button: Locator | null };

function recordPartySuggestion(party: QuoteParty, candidate: QuotePartyCandidate): void {
  const exists = party.suggested.some(
    (item) =>
      item.kind === candidate.kind &&
      item.name === candidate.name &&
      item.source === candidate.source &&
      item.nativeId === candidate.nativeId,
  );
  if (!exists) party.suggested.push(candidate);
}

async function readLiveHmsCandidates(group: Locator, kind: PartyKind): Promise<PartyCandidateOption[]> {
  const output: PartyCandidateOption[] = [];
  for (const label of QUOTE_SELECTORS.liveMatchLabels) {
    const labels = group.getByText(label, { exact: true });
    for (let labelIndex = 0; labelIndex < (await labels.count()); labelIndex += 1) {
      const buttons = labels.nth(labelIndex).locator(QUOTE_SELECTORS.liveMatchContainer).getByRole('button');
      for (let buttonIndex = 0; buttonIndex < (await buttons.count()); buttonIndex += 1) {
        const button = buttons.nth(buttonIndex);
        const text = (await button.innerText().catch(() => '')).trim();
        const candidate = liveHmsCandidateFromText(kind, text);
        if (candidate) output.push({ ...candidate, button });
      }
    }
  }
  return output;
}

async function readQueuedHmsCandidates(group: Locator, kind: PartyKind): Promise<PartyCandidateOption[]> {
  const output: PartyCandidateOption[] = [];
  const lists = group.getByRole('list', { name: 'Companies and agencies found in HMS', exact: true });
  for (let listIndex = 0; listIndex < (await lists.count()); listIndex += 1) {
    const buttons = lists.nth(listIndex).getByRole('button');
    for (let buttonIndex = 0; buttonIndex < (await buttons.count()); buttonIndex += 1) {
      const button = buttons.nth(buttonIndex);
      const name = (await button.innerText().catch(() => '')).trim();
      if (name) output.push({ kind, name, source: 'live_hms', button });
    }
  }
  return output;
}

async function readConfirmCandidates(group: Locator, kind: PartyKind): Promise<PartyCandidateOption[]> {
  const output: PartyCandidateOption[] = [];
  const buttons = group.getByRole('button', { name: QUOTE_SELECTORS.confirmParty });
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const button = buttons.nth(index);
    const label = (await button.innerText().catch(() => '')).trim();
    const name = /^Confirm\s+(.+)$/i.exec(label)?.[1]?.trim();
    if (name) output.push({ kind, name, source: 'live_hms', button });
  }
  return output;
}

async function acceptPartyMatches(
  page: Page,
  allowEdits: boolean,
  party: QuoteParty,
): Promise<{ missingEdits: string[] }> {
  const missingEdits: string[] = [];
  for (const kind of ['company', 'agency'] as const) {
    const group = partyGroup(page, kind);
    if (!(await group.count())) continue;
    for (const suggestion of await readEmailSuggestions(group, kind)) recordPartySuggestion(party, suggestion);
    const existing = selectedParty(await group.innerText().catch(() => ''));
    const list = group.getByRole('region', { name: QUOTE_SELECTORS.hmsListRegion, exact: true });
    const candidateButtons = list.getByRole('button');
    const listCandidates: PartyCandidateOption[] = [];
    for (let index = 0; index < (await candidateButtons.count()); index += 1) {
      const button = candidateButtons.nth(index);
      const name = (await button.innerText().catch(() => '')).trim();
      if (!name) continue;
      listCandidates.push({ kind, name, source: 'hms_list', button });
      recordPartySuggestion(party, { kind, name, source: 'hms_list' });
    }
    if (listCandidates.length) party.prefetched = true;

    const candidatesFromHms = [
      ...(await readConfirmCandidates(group, kind)),
      ...(await readQueuedHmsCandidates(group, kind)),
      ...(await readLiveHmsCandidates(group, kind)),
    ];
    for (const candidate of candidatesFromHms) {
      recordPartySuggestion(party, {
        kind,
        name: candidate.name,
        source: 'live_hms',
        ...(candidate.nativeId ? { nativeId: candidate.nativeId } : {}),
      });
    }

    if (existing && !existing.byNava) {
      party.accepted.push({ kind, name: existing.name, source: 'prefilled', nativeId: existing.nativeId });
      continue;
    }

    const candidates: PartyCandidateOption[] = [...candidatesFromHms, ...listCandidates];
    if (existing?.byNava) {
      const selected = { kind, name: existing.name, source: 'live_hms' as const, nativeId: existing.nativeId, button: null };
      recordPartySuggestion(party, {
        kind,
        name: selected.name,
        source: 'live_hms',
        nativeId: selected.nativeId,
      });
      candidates.unshift(selected);
    }
    if (!candidates.length) continue;

    const fieldName = kind === 'company' ? QUOTE_SELECTORS.companyField : QUOTE_SELECTORS.agencyField;
    const query = await controlValue(page.getByRole('textbox', { name: fieldName, exact: true }));
    const chosen = choosePartyCandidate(candidates, query);
    if (!chosen) {
      missingEdits.push('party.' + kind);
      continue;
    }
    if (!allowEdits) {
      missingEdits.push('party.' + kind);
      continue;
    }
    const selectedMatches = Boolean(
      existing?.byNava &&
        chosen.source === 'live_hms' &&
        normalizedName(existing.name) === normalizedName(chosen.name) &&
        (!chosen.nativeId || existing.nativeId === chosen.nativeId),
    );
    if (selectedMatches) {
      party.accepted.push({
        kind,
        name: chosen.name,
        source: chosen.source,
        ...(chosen.nativeId ? { nativeId: chosen.nativeId } : {}),
      });
      continue;
    }
    if (!chosen.button) {
      missingEdits.push('party.' + kind);
      continue;
    }
    await chosen.button.click();
    await waitFor(kind + ' HMS match acceptance', STEP_MS, async () => {
      const selected = selectedParty(await group.innerText().catch(() => ''));
      return selected && normalizedName(selected.name) === normalizedName(chosen.name) ? true : null;
    });
    const accepted = selectedParty(await group.innerText().catch(() => ''));
    party.accepted.push({
      kind,
      name: accepted?.name ?? chosen.name,
      source: chosen.source,
      ...(accepted?.nativeId ? { nativeId: accepted.nativeId } : chosen.nativeId ? { nativeId: chosen.nativeId } : {}),
    });
  }
  return { missingEdits };
}

function uniqueRateKeys(stays: readonly QuotePrefilledStay[]): Array<{ key: string; stayIndex: number }> {
  const seen = new Set<string>();
  const keys: Array<{ key: string; stayIndex: number }> = [];
  stays.forEach((stay, index) => {
    if (!stay.arrival || !stay.departure) return;
    const key = stay.arrival + ':' + stay.departure;
    if (seen.has(key)) return;
    seen.add(key);
    keys.push({ key, stayIndex: index });
  });
  return keys;
}

async function rateArticles(region: Locator): Promise<Locator[]> {
  const headings = region.getByRole('heading', { name: QUOTE_SELECTORS.rateHeading, exact: true });
  const articles: Locator[] = [];
  for (let index = 0; index < (await headings.count()); index += 1) {
    articles.push(headings.nth(index).locator(QUOTE_SELECTORS.rateArticleAncestor));
  }
  return articles;
}

async function pricedCardCount(scope: Locator): Promise<number> {
  const groups = scope.getByRole('group', { name: QUOTE_SELECTORS.rateCardsGroup, exact: true });
  let count = 0;
  for (let groupIndex = 0; groupIndex < (await groups.count()); groupIndex += 1) {
    const buttons = groups.nth(groupIndex).getByRole('button');
    const labels = await buttons.allInnerTexts();
    count += labels.filter((label) => QUOTE_SELECTORS.pricedCard.test(label)).length;
  }
  return count;
}

async function ratePending(region: Locator, deadline: number): Promise<boolean> {
  const groups = region.getByRole('group', { name: QUOTE_SELECTORS.rateCardsGroup, exact: true });
  for (let index = 0; index < (await groups.count()); index += 1) {
    const timeout = rateWaitBudget(deadline, Date.now(), Number.MAX_SAFE_INTEGER);
    if (!timeout) return true;
    if ((await groups.nth(index).getAttribute('aria-busy', { timeout }).catch(() => null)) === 'true') return true;
  }
  const statuses = region.getByRole('status');
  for (let index = 0; index < (await statuses.count()); index += 1) {
    const timeout = rateWaitBudget(deadline, Date.now(), Number.MAX_SAFE_INTEGER);
    if (!timeout) return true;
    if (QUOTE_SELECTORS.pendingRate.test(await statuses.nth(index).innerText({ timeout }).catch(() => ''))) return true;
  }
  return false;
}

export function namedRateRefusal(raw: string): string | null {
  const text = redactText(raw.replace(/\s+/g, ' ').trim()).slice(0, MESSAGE_LIMIT);
  if (!text || /\b(?:timed?\s*out|timeout|didn't answer in time|no response before the deadline)\b/i.test(text)) {
    return null;
  }
  const searchRefusal = /HMS refused the search:\s*(.+)$/i.exec(text);
  if (searchRefusal) return 'refused: ' + searchRefusal[1]!.trim();
  if (/^(?:only\s+\d+\b|HMS has only\s+\d+\b)/i.test(text)) {
    return 'refused: ' + text;
  }
  return null;
}

function refusalFromOutcome(outcome: TrpcOutcome | null): string | null {
  if (!outcome) return null;
  if (outcome.error?.message) return namedRateRefusal(outcome.error.message);
  if (!outcome.data || typeof outcome.data !== 'object') return null;
  const data = outcome.data as { status?: unknown; reason?: unknown; message?: unknown };
  const reason = typeof data.reason === 'string' ? data.reason : typeof data.message === 'string' ? data.message : '';
  if (!reason) return null;
  const refusal = namedRateRefusal(reason);
  if (refusal) return refusal;
  return null;
}

/** A queued staff quote HMS answered with a refusal ({ ok: false, message }); the pane shows that message as is. */
export function queuedJobRefusal(outcome: TrpcOutcome | null): string | null {
  if (!outcome || outcome.error || !outcome.data || typeof outcome.data !== 'object') return null;
  const result = (outcome.data as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== false) return null;
  const message = (result as { message?: unknown }).message;
  if (typeof message !== 'string' || !message.trim()) return null;
  return 'refused: ' + redactText(message.replace(/\s+/g, ' ').trim()).slice(0, MESSAGE_LIMIT);
}

type RateSignal =
  | { kind: 'priced'; cards: number }
  | { kind: 'refused'; outcome: string }
  | { kind: 'failed'; message: string };

async function waitForRate<T>(
  what: string,
  deadline: number,
  probe: (remaining: number) => Promise<T | null | undefined>,
  maxMs = Number.POSITIVE_INFINITY,
): Promise<T> {
  const localDeadline = Math.min(deadline, Date.now() + maxMs);
  while (true) {
    const remaining = Math.max(0, localDeadline - Date.now());
    if (!remaining) throw new Blocker(`timed out: ${what}`);
    const value = await probe(remaining).catch((error: unknown) => {
      if (error instanceof Blocker) throw error;
      return null;
    });
    if (value !== null && value !== undefined) return value;
    const pause = Math.min(RATE_POLL_MS, Math.max(0, localDeadline - Date.now()));
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

async function rateSignal(
  article: Locator | null,
  rates: Locator,
  captured: Captured,
  outcomeAfter: number,
  details: { opened: boolean },
  deadline: number,
): Promise<RateSignal | null> {
  const latest = latestOutcome(captured, STAFF_QUOTE_PROCEDURE, outcomeAfter);
  const responseRefusal = refusalFromOutcome(latest);
  if (responseRefusal) return { kind: 'refused', outcome: responseRefusal };
  for (const procedure of [STAFF_QUOTE_JOB_PROCEDURE, QUEUED_STAFF_QUOTE_PROCEDURE]) {
    const jobRefusal = queuedJobRefusal(latestOutcome(captured, procedure, outcomeAfter));
    if (jobRefusal) return { kind: 'refused', outcome: jobRefusal };
  }

  const alerts = rates.getByRole('alert');
  for (let index = 0; index < (await alerts.count()); index += 1) {
    const timeout = rateWaitBudget(deadline, Date.now(), Number.MAX_SAFE_INTEGER);
    if (!timeout) return null;
    const text = await alerts.nth(index).innerText({ timeout }).catch(() => '');
    const refusal = namedRateRefusal(text);
    if (refusal) return { kind: 'refused', outcome: refusal };
    if (text.trim()) {
      return { kind: 'failed', message: 'HMS queue returned an unnamed refusal.' };
    }
  }

  if (article) {
    const timeout = rateWaitBudget(deadline, Date.now(), Number.MAX_SAFE_INTEGER);
    if (!timeout) return null;
    const visible = await article.innerText({ timeout }).catch(() => '');
    const refusal = namedRateRefusal(visible);
    if (refusal) return { kind: 'refused', outcome: refusal };
    if (!details.opened && /\bFailed\b/i.test(visible)) {
      const detailsButton = article.getByRole('button', { name: QUOTE_SELECTORS.detailsButton, exact: true });
      if (await detailsButton.count()) {
        const clickTimeout = rateWaitBudget(deadline, Date.now(), Number.MAX_SAFE_INTEGER);
        if (!clickTimeout) return null;
        await detailsButton.first().click({ timeout: clickTimeout }).catch(() => undefined);
        details.opened = true;
      }
    }
    if (latest?.error?.message) {
      return { kind: 'failed', message: redactText(latest.error.message).slice(0, MESSAGE_LIMIT) };
    }
    const cards = await pricedCardCount(article);
    if (cards > 0 && !(await ratePending(rates, deadline))) return { kind: 'priced', cards };
  } else {
    const cards = await pricedCardCount(rates);
    if (cards > 0 && !(await ratePending(rates, deadline))) return { kind: 'priced', cards };
  }
  return null;
}

async function runRates(
  page: Page,
  captured: Captured,
  guard: QuoteGuardState,
  stays: readonly QuotePrefilledStay[],
  timeoutMs: number,
): Promise<{ outcome: string; seconds: number; cards: number; blocker: string | null }> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const rates = page.getByRole('region', { name: QUOTE_SELECTORS.ratesRegion, exact: true });
  const outcomes: RateSignal[] = [];
  const cardsSoFar = () => outcomes.reduce((total, item) => total + (item.kind === 'priced' ? item.cards : 0), 0);
  const timedOut = () => ({
    outcome: 'timeout',
    seconds: Math.round((Date.now() - started) / 1000),
    cards: cardsSoFar(),
    blocker: 'rates_timeout',
  });
  const initialWait = rateWaitBudget(deadline);
  if (!initialWait) return timedOut();
  try {
    await rates.waitFor({ state: 'visible', timeout: initialWait });
  } catch {
    if (Date.now() >= deadline) return timedOut();
    throw new Blocker('the Rates step is missing');
  }
  const articles = await rateArticles(rates);
  const keys = uniqueRateKeys(stays);
  if (!guard.expectedRateKeys.size) guard.expectedRateKeys = rateKeysForDateRanges(stays);
  if (!keys.length) throw new Blocker('needs_edits:stay_dates');

  for (const item of keys) {
    const article = articles[item.stayIndex] ?? null;
    let outcomeAfter = Number.MAX_SAFE_INTEGER;
    if (rateSearchAction(item.key, guard.ratedRateKeys) === 'search') {
      try {
        await waitForRate('the previous availability search to settle', deadline, async () =>
          (await ratePending(rates, deadline)) ? null : true,
        );
      } catch (error) {
        if (Date.now() >= deadline) return timedOut();
        throw error;
      }
      let button = article?.getByRole('button', { name: QUOTE_SELECTORS.searchButton });
      if (!button || !(await button.count())) button = rates.getByRole('button', { name: QUOTE_SELECTORS.getRatesButton });
      try {
        await waitForRate('the availability search to be enabled', deadline, async () => {
          return button && (await button.count()) > 0 && (await button.first().isEnabled()) ? true : null;
        }, STEP_MS);
      } catch {
        if (Date.now() >= deadline) return timedOut();
        throw new Blocker('needs_edits:rate_search');
      }
      outcomeAfter = captured.outcomes.length;
      const clickTimeout = rateWaitBudget(deadline);
      if (!clickTimeout) return timedOut();
      try {
        await button.first().click({ timeout: clickTimeout });
      } catch {
        if (Date.now() >= deadline) return timedOut();
        throw new Blocker('the availability search could not be clicked');
      }
      try {
        await waitForRate('the quote rates read to start', deadline, async () =>
          guard.ratedRateKeys.includes(item.key) ? true : null,
        STEP_MS);
      } catch {
        if (Date.now() >= deadline) return timedOut();
        throw new Blocker('the quote rates request did not start');
      }
    }

    const details = { opened: false };
    try {
      outcomes.push(
        await waitForRate('priced room-rate cards or a named refusal', deadline, () =>
          rateSignal(article, rates, captured, outcomeAfter, details, deadline),
        ),
      );
    } catch (error) {
      if (Date.now() >= deadline) return timedOut();
      throw error;
    }
    const latestSignal = outcomes[outcomes.length - 1]!;
    if (latestSignal.kind === 'failed') {
      return {
        outcome: 'error: ' + latestSignal.message,
        seconds: Math.round((Date.now() - started) / 1000),
        cards: cardsSoFar(),
        blocker: 'rates_failed',
      };
    }
  }

  const cards = cardsSoFar();
  const seconds = Math.round((Date.now() - started) / 1000);
  if (outcomes.every((item) => item.kind === 'priced') && cards > 0) {
    return { outcome: 'priced', seconds, cards, blocker: null };
  }
  if (outcomes.length > 0 && outcomes.every((item) => item.kind === 'refused')) {
    return {
      outcome: 'refused: ' + outcomes.map((item) => (item.kind === 'refused' ? item.outcome.slice('refused: '.length) : '')).join('; '),
      seconds,
      cards,
      blocker: null,
    };
  }
  return {
    outcome: 'partial: priced and refused stays',
    seconds,
    cards,
    blocker: 'partial_rate_refusal',
  };
}

async function captureRegion(page: Page, region: Locator, path: string): Promise<boolean> {
  await fitPaneToContent(page);
  const mask = [page.locator(QUOTE_SELECTORS.screenshotMask)];
  await withPiiMask(
    () => page.evaluate('(' + MARK_PII_JS + ')()'),
    async () => region.screenshot({ path, mask, timeout: 15_000 }).catch(() => undefined),
  );
  return (statSync(path, { throwIfNoEntry: false })?.size ?? 0) > 0;
}

function documentData(outcome: TrpcOutcome | null, key: 'pdfBase64' | 'xlsxBase64'): Buffer | null {
  if (!outcome || outcome.error || !outcome.data || typeof outcome.data !== 'object') return null;
  const encoded = (outcome.data as Record<string, unknown>)[key];
  return typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : null;
}

async function saveDocument(
  captured: Captured,
  region: Locator,
  procedure: string,
  name: string,
  key: 'pdfBase64' | 'xlsxBase64',
  outPath: string,
): Promise<number> {
  const button = region.getByRole('button', { name, exact: true });
  await waitFor(name + ' to be enabled', STEP_MS, async () =>
    (await button.count()) > 0 && (await button.first().isEnabled()) ? true : null,
  ).catch(() => {
    throw new Blocker(name + ' is not available for this quote');
  });
  const before = captured.outcomes.length;
  await button.first().click();
  const response = await waitFor(name + ' response', DOC_MS, async () => latestOutcome(captured, procedure, before));
  const bytes = documentData(response, key);
  if (!bytes || !bytes.length) {
    throw new Blocker(response?.error ? name + ' request failed' : name + ' response carried no file');
  }
  if (key === 'pdfBase64' && bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Blocker('the prepared PDF is invalid');
  }
  writeFileSync(outPath, bytes, { mode: 0o600 });
  return bytes.length;
}

async function proveThread(
  page: Page,
  captured: Captured,
  guard: QuoteGuardState,
  config: QuoteProofConfig,
  threadId: string,
  threadIndex: number,
  proof: QuoteProofThread,
  partyIndexSignals: PartyIndexSignals,
): Promise<void> {
  await openThread(page, config.baseUrl, threadId);
  const intent = page.getByRole('combobox', { name: QUOTE_SELECTORS.intent, exact: true });
  proof.kind = (await controlValue(intent)) ?? 'unknown';
  if (proof.kind !== 'quote') {
    proof.blocker = 'not_quote';
    return;
  }

  proof.prefilled = await readPrefilled(page);
  if (config.allowEdits) {
    proof.edits = await fillOpenRoomTypes(page, proof.prefilled);
    if (proof.edits.length) proof.prefilled = await readPrefilled(page);
  }
  if (!guard.expectedRateKeys.size) guard.expectedRateKeys = rateKeysForDateRanges(proof.prefilled.stays);
  const missing = requiredQuoteEdits(proof.prefilled);
  if (missing.length) {
    proof.blocker = 'needs_edits:' + missing.join(',');
    return;
  }

  try {
    await settlePartyLookups(page, partyIndexSignals);
  } catch (error) {
    if (error instanceof Blocker && /timed out: company and agency lookups/.test(error.message)) {
      throw new Blocker('party_lookup_timeout');
    }
    throw error;
  }
  const partyResult = await acceptPartyMatches(page, config.allowEdits, proof.party);
  if (partyResult.missingEdits.length) {
    proof.blocker = 'needs_edits:' + partyResult.missingEdits.join(',');
    return;
  }

  const rates = await runRates(page, captured, guard, proof.prefilled.stays, config.timeoutMs);
  proof.rates = { outcome: rates.outcome, seconds: rates.seconds, cards: rates.cards };
  proof.blocker = rates.blocker;

  const prefix = 'thread-' + String(threadIndex + 1).padStart(2, '0') + '-' + safeSegment(threadId);
  const ratesRegion = page.getByRole('region', { name: QUOTE_SELECTORS.ratesRegion, exact: true });
  if (rates.outcome !== 'priced') {
    // What staff would see when HMS did not price: kept so a timeout or refusal can be read without a rerun.
    await captureRegion(page, ratesRegion, join(config.outDir, prefix + '-rates-unpriced.png'));
    return;
  }
  const ratesShot = await captureRegion(page, ratesRegion, join(config.outDir, prefix + '-rates.png'));
  if (!ratesShot) {
    proof.rates.outcome = 'priced_evidence_failed';
    proof.blocker = 'rates_screenshot_missing';
    return;
  }

  const docsRegion = page.getByRole('region', { name: QUOTE_SELECTORS.docsRegion, exact: true });
  await docsRegion.waitFor({ state: 'visible', timeout: STEP_MS }).catch(() => {
    throw new Blocker('the Quote step is missing');
  });
  try {
    proof.docs.pdfBytes = await saveDocument(
      captured,
      docsRegion,
      PDF_PROCEDURE,
      (await docsRegion.getByRole('button', { name: QUOTE_SELECTORS.prepareButton }).first().innerText()).trim(),
      'pdfBase64',
      join(config.outDir, prefix + '-quote.pdf'),
    );
    proof.docs.xlsxBytes = await saveDocument(
      captured,
      docsRegion,
      WORKBOOK_PROCEDURE,
      QUOTE_SELECTORS.excelButton,
      'xlsxBase64',
      join(config.outDir, prefix + '-quote.xlsx'),
    );
  } catch (error) {
    proof.rates.outcome = 'priced_documents_failed';
    proof.blocker = error instanceof Error ? redactText(error.message).slice(0, MESSAGE_LIMIT) : 'documents_failed';
    return;
  }
  const docsShot = await captureRegion(page, docsRegion, join(config.outDir, prefix + '-documents.png'));
  if (!docsShot) {
    proof.rates.outcome = 'priced_evidence_failed';
    proof.blocker = 'documents_screenshot_missing';
  }
}

export type QuoteProofSummary = { threads: QuoteProofThread[]; pass: boolean };

export async function runQuoteProof(config: QuoteProofConfig, log: (line: string) => void): Promise<QuoteProofSummary> {
  mkdirSync(config.outDir, { recursive: true, mode: 0o700 });
  chmodSync(config.outDir, 0o700);
  const threads: QuoteProofThread[] = [];
  let guard = newQuoteGuardState([], config.allowEdits);
  let launchFailed = false;
  let browser: Awaited<ReturnType<typeof openProofPage>>['browser'] | null = null;
  let context: Awaited<ReturnType<typeof openProofPage>>['context'] | null = null;
  let page: Page | null = null;
  let partyIndexObserver: ReturnType<typeof watchPartyIndex> | null = null;
  let captured: Captured = { outcomes: [], blocked: [] };
  try {
    const proofPage = await openProofPage(config, async (url, postData) => {
      let procedures: string[] = [];
      try {
        procedures = trpcProcedures(url);
      } catch {
        // The request classifier below reports an unknown route.
      }
      if (page && !guard.expectedRateKeys.size && procedures.some((procedure) => STAFF_QUOTE_PROCEDURES.has(procedure))) {
        await initializeExpectedRateKeysFromPane(page, guard);
      }
      return classifyQuoteRequest(url, postData, guard);
    });
    browser = proofPage.browser;
    context = proofPage.context;
    page = proofPage.page;
    captured = proofPage.captured;
    partyIndexObserver = watchPartyIndex(page);
    for (const [index, threadId] of config.threadIds.entries()) {
      guard = newQuoteGuardState([], config.allowEdits);
      partyIndexObserver.reset();
      log('quote thread ' + (index + 1) + ' of ' + config.threadIds.length + ' started');
      const blockedAtStart = captured.blocked.length;
      const proof = emptyThread(threadId);
      try {
        await proveThread(page, captured, guard, config, threadId, index, proof, partyIndexObserver.signals);
        const blocked = [...new Set(captured.blocked.slice(blockedAtStart))];
        if (blocked.length) {
          proof.blocker = blocked.every((item) => item === 'workItems.recordEvent (edits_disabled)')
            ? 'needs_edits:party'
            : 'guard_blocked:' + blocked.join(',');
        }
        threads.push(proof);
      } catch (error) {
        const blocked = [...new Set(captured.blocked.slice(blockedAtStart))];
        threads.push(quoteThreadFailure(proof, error, blocked));
      }
    }
  } catch (error) {
    launchFailed = true;
    const message = redactText(error instanceof Error ? error.message : 'browser launch failed').slice(0, MESSAGE_LIMIT);
    for (const threadId of config.threadIds) {
      const proof = emptyThread(threadId);
      proof.blocker = 'crashed: ' + message;
      threads.push(proof);
    }
  } finally {
    partyIndexObserver?.stop();
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
  const summary = { threads, pass: quoteProofPass(threads) };
  writeFileSync(join(config.outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  log('out: ' + config.outDir);
  console.log(JSON.stringify(summary));
  if (launchFailed) process.exitCode = 2;
  else process.exitCode = summary.pass ? 0 : 1;
  return summary;
}

async function main(): Promise<void> {
  const config = parseQuoteProofConfig(process.argv.slice(2), process.env, process.cwd());
  await runQuoteProof(config, (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('nava-quote-proof: ' + redactText(error instanceof Error ? error.message : 'failed'));
    process.exitCode = 2;
  });
}
