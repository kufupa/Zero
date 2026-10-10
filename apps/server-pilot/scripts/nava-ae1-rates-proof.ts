/**
 * AE1 live proof: a multi-stay quote rated once per stay, then one combined proposal (PDF and Excel), in the real pane.
 *
 * AE1 (docs/plans/2026-10-09-001-feat-nava-pane-weekend-v4-plan.md): the Tailormade/New Frontiers email asks for 26-27 Oct
 * and 17-18 Nov, 30 rooms, single and double/twin rates. PASS means:
 *   - Get rates ran exactly once per stay (one workstation.executeStaffQuote per date option);
 *   - the Excel has one line per stay x room and one total row; the PDF exists and covers every stay.
 *
 * The driver opens one thread in /nava-preview, waits for the pane to read it, and sets the type to Quote if needed. Where
 * a room row is missing what the rates run needs, it fills it the way staff would and records what it used (filledFields,
 * roomSplitUsed). It edits a real thread, so it does so only with NAVA_PROOF_ALLOW_EDITS=1; without it a run that needs
 * any fill (or the type change) stops with the blocker "needs_edits:<fields>" before touching the pane:
 *   - rooms: the deterministic split NAVA_AE1_ROOMS (default 15/15: room 1 of each stay gets 15, room 2 gets 15);
 *   - room type: where the select says "Email asked for X — pick a room type", the first listed HMS room type that
 *     matches X (Twin for "double/twin"; Queen, then King, for "single" or "double");
 *   - adults per room: 1 for a single, else 2 (NAVA_AE1_ADULTS overrides, e.g. "1/2");
 *   - meal plan: NAVA_AE1_BOARD (default bb) only where the pane has none.
 * A value the pane already has is kept, never overwritten. If the pane refuses a value (it does not take, or Get rates stays disabled), the
 * run stops with a blocker; it never works around a product rule.
 *
 * Then it runs each stay's own search ("Run Search availability <dates>" in the pane's HMS steps), waits for "k of N
 * stays rated", screenshots the rates step, prepares the combined quote PDF and downloads the Excel, and screenshots the
 * documents step. Guest details are masked in every screenshot.
 *
 * Mailbox: when NAVA_PREVIEW_TRANSPORT_ID is not the account's default mailbox, the driver makes it the default with
 * connections.setDefault before opening the pane (the pane's PDF/Excel identity check uses the default) and always puts the
 * previous default back afterwards (nava-proof-safety.ts withActiveMailbox). The summary records activeMailboxSwitched and
 * restored; a failed restore fails the run. Only the driver's own two setDefault calls pass the guard.
 *
 * Guard: every tRPC request is checked by procedure name. Reads and the analysis pass. Of the writes only these pass:
 * workItems.open and workItems.recordEvent (the pane logs the field edits), workstation.executeStaffQuote once per stay
 * (never a second run of a stay, never more runs than stays), panePartyLookup.findParty at most once (a read-only HMS
 * search the pane makes by itself for the company or agency), one qualifiedQuoteProposalPdf and one quoteWorkbook. Every
 * HMS write, mailbox write (save reply, insert draft) and unknown call is aborted.
 *
 * HMS calls: one rates read per stay, at most one party search, and one party check per picked company or agency inside
 * each rates run (workstation.ts verifyStaffParties). No HMS write.
 * Rows written: per rates run one ai_draft_generation and one ai_workflow_run (+ hitl_tool_run kind quote when the HITL
 * ledger is on); work_event field.edit rows for the edits (and a work_item if the stored read had none); the PDF adds a
 * hitl_tool_run kind pdf when the ledger is on. The Excel writes nothing.
 *
 * Environment (values are never printed): NAVA_PREVIEW_BASE_URL, NAVA_PREVIEW_STORAGE_STATE, NAVA_PREVIEW_RESOLVE_TO,
 * NAVA_PREVIEW_TRANSPORT_ID, NAVA_PREVIEW_CHROMIUM as nava-preview-run.ts; NAVA_AE1_ROOMS, NAVA_AE1_ADULTS, NAVA_AE1_BOARD;
 * NAVA_PROOF_ALLOW_EDITS=1 to let it fill missing room counts, adults, meal plans and room types (the AE1 email has no
 * counts, so AE1 needs it on).
 *
 * Usage: NAVA_PROOF_ALLOW_EDITS=1 nava-preview-gate.sh --ae1-rates <thread-id>   (signs in, then runs:)
 *   pnpm --dir apps/server-pilot exec tsx scripts/nava-ae1-rates-proof.ts --threads <id> --out <dir> --timeout-ms 600000
 *
 * Output: <out>/summary.json, rates.png, documents.png, pane.png, quote.pdf, quote.xlsx. The last stdout line is the
 * summary as one JSON line. Exit 0 pass, 1 AE1 failed, 2 blocked before the proof could finish.
 */
import type { Locator, Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  batchInput,
  Blocker,
  HMS_RATES_PROCEDURE,
  latestOutcome,
  storedWorkView,
  trpcProcedures,
  visibleText,
  waitFor,
  type Captured,
  type StoredWorkView,
} from './nava-ae4-override-proof';
import {
  allowEditsFrom,
  browserMailboxApi,
  captureShots,
  countWorkbookLines,
  DOC_MS,
  mailboxFailures,
  MailboxSwitchError,
  needsEditsMessage,
  newMailboxPermit,
  newMailboxSwitch,
  openProofPage,
  openThread,
  rateSegments,
  STEP_MS,
  SETTLE_MS,
  unexpectedBlocks,
  withActiveMailbox,
  withMailboxPermit,
  xlsxSheetRows,
  type GuardDecision,
  type MailboxRecord,
} from './nava-proof-kit';
import { ANALYSIS_PROCEDURES, KNOWN_WRITE_PROCEDURES, parseRunConfig, READ_PROCEDURES, redactText, type RunConfig } from './nava-preview-run';

export const PARTY_LOOKUP_PROCEDURE = 'panePartyLookup.findParty';
export const PDF_PROCEDURE = 'workstation.qualifiedQuoteProposalPdf';
export const WORKBOOK_PROCEDURE = 'workstation.quoteWorkbook';

/** The writes AE1 needs. None writes to HMS or the mailbox; the rates runs and the party search read HMS. */
export const AE1_WRITE_PROCEDURES: ReadonlySet<string> = new Set([
  'workItems.open',
  'workItems.recordEvent',
  HMS_RATES_PROCEDURE,
  PARTY_LOOKUP_PROCEDURE,
  PDF_PROCEDURE,
  WORKBOOK_PROCEDURE,
]);

// ---------------------------------------------------------------------------------------------------------------------
// Config

export type Board = 'room_only' | 'bb' | 'dinner_bb';
export type Ae1Inputs = {
  /** Rooms for room 1, room 2, … of each stay, used only where the pane has no count. */
  roomSplit: number[];
  /** Adults per room for room 1, room 2, …; empty derives them from the asked room type. */
  adultsSplit: number[];
  board: Board;
  /** NAVA_PROOF_ALLOW_EDITS=1: the driver may fill what the pane is missing. Off, a needed fill stops the run. */
  allowEdits: boolean;
};
export type Ae1Config = RunConfig & { threadId: string; inputs: Ae1Inputs };

const BOARDS: ReadonlySet<string> = new Set(['room_only', 'bb', 'dinner_bb']);

function parseSplit(raw: string, name: string, max: number): number[] {
  if (!/^\d{1,2}(\/\d{1,2}){0,8}$/.test(raw)) throw new Error(`${name} must be counts like 15/15`);
  const split = raw.split('/').map(Number);
  if (split.some((count) => count < 1 || count > max)) throw new Error(`${name} counts must be 1 to ${max}`);
  return split;
}

/** Reads the run settings (as nava-preview-run.ts, one thread) and the AE1 fill-ins. Messages never echo a value. */
export function parseAe1Config(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Ae1Config {
  const base = parseRunConfig(argv, env, cwd);
  if (base.selection.kind !== 'threads' || base.selection.ids.length !== 1) {
    throw new Error('AE1 runs on exactly one thread: --threads <id>');
  }
  const roomSplit = parseSplit(env.NAVA_AE1_ROOMS?.trim() || '15/15', 'NAVA_AE1_ROOMS', 99);
  const adultsRaw = env.NAVA_AE1_ADULTS?.trim() || '';
  const adultsSplit = adultsRaw ? parseSplit(adultsRaw, 'NAVA_AE1_ADULTS', 9) : [];
  const board = env.NAVA_AE1_BOARD?.trim() || 'bb';
  if (!BOARDS.has(board)) throw new Error('NAVA_AE1_BOARD must be room_only, bb or dinner_bb');
  return { ...base, threadId: base.selection.ids[0]!, inputs: { roomSplit, adultsSplit, board: board as Board, allowEdits: allowEditsFrom(env) } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Request guard

export type Ae1GuardState = {
  /** Date options to rate. Null until the driver has read the pane: no rates run passes before that. */
  expectedStays: number | null;
  /** Stay keys (arrival:departure) of the rates runs let through, in order. */
  ratedStayKeys: string[];
  partyLookups: number;
  /** Picked companies and agencies the rates runs carried. The server checks each in HMS before the rates read. */
  partyChecks: number;
  pdfs: number;
  workbooks: number;
  /** Stays the combined PDF and Excel requests cover (the primary run plus additionalStays). */
  pdfStays: number | null;
  workbookStays: number | null;
};

export type Ae1BlockReason =
  | 'write'
  | 'unknown'
  | 'stays_unknown'
  | 'rates_without_stay'
  | 'stay_already_rated'
  | 'extra_rates_run'
  | 'second_party_lookup'
  | 'second_document';

export function newAe1GuardState(): Ae1GuardState {
  return {
    expectedStays: null,
    ratedStayKeys: [],
    partyLookups: 0,
    partyChecks: 0,
    pdfs: 0,
    workbooks: 0,
    pdfStays: null,
    workbookStays: null,
  };
}

/** The stay a rates run is for: its groups' one arrival:departure. Null when the groups are missing or span dates. */
export function stayKeyOfRatesInput(input: unknown): string | null {
  const groups = (input as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const keys = new Set(
    groups.map((group) => {
      const row = (group ?? {}) as { arrivalDate?: unknown; departureDate?: unknown };
      return typeof row.arrivalDate === 'string' && typeof row.departureDate === 'string'
        ? `${row.arrivalDate}:${row.departureDate}`
        : '';
    }),
  );
  const [key] = keys;
  return keys.size === 1 && key ? key : null;
}

function partyCount(input: unknown): number {
  const parties = (input as { parties?: unknown } | null)?.parties;
  if (!parties || typeof parties !== 'object') return 0;
  return Object.values(parties as Record<string, unknown>).filter((value) => value !== null && value !== undefined).length;
}

/** Stays one combined document request covers: its own run plus each additional stay. */
export function documentStayCount(input: unknown): number | null {
  if (!input || typeof input !== 'object') return null;
  const extra = (input as { additionalStays?: unknown }).additionalStays;
  return 1 + (Array.isArray(extra) ? extra.length : 0);
}

/**
 * Whether one request may go. The state changes only when the whole request is let through, so a blocked batch never
 * counts as a rates run, a party search or a document.
 */
export function classifyAe1Request(
  url: string,
  postData: string | null,
  state: Ae1GuardState,
): GuardDecision<Ae1BlockReason> {
  const procedures = trpcProcedures(url);
  if (procedures.length === 0) {
    return { allowed: false, procedures, blocked: [{ procedure: '(none)', reason: 'unknown' }] };
  }
  const blocked: GuardDecision<Ae1BlockReason>['blocked'] = [];
  const pending = { stays: [] as string[], partyLookups: 0, partyChecks: 0, pdfs: 0, workbooks: 0 };
  let pdfStays: number | null = null;
  let workbookStays: number | null = null;
  procedures.forEach((procedure, index) => {
    const block = (reason: Ae1BlockReason) => blocked.push({ procedure, reason });
    if (READ_PROCEDURES.has(procedure) || ANALYSIS_PROCEDURES.has(procedure)) return;
    if (!AE1_WRITE_PROCEDURES.has(procedure)) {
      block(KNOWN_WRITE_PROCEDURES.has(procedure) ? 'write' : 'unknown');
      return;
    }
    const input = batchInput(postData, index);
    if (procedure === HMS_RATES_PROCEDURE) {
      const key = stayKeyOfRatesInput(input);
      if (state.expectedStays === null) block('stays_unknown');
      else if (!key) block('rates_without_stay');
      else if (state.ratedStayKeys.includes(key) || pending.stays.includes(key)) block('stay_already_rated');
      else if (state.ratedStayKeys.length + pending.stays.length >= state.expectedStays) block('extra_rates_run');
      else {
        pending.stays.push(key);
        pending.partyChecks += partyCount(input);
      }
    } else if (procedure === PARTY_LOOKUP_PROCEDURE) {
      if (state.partyLookups + pending.partyLookups >= 1) block('second_party_lookup');
      else pending.partyLookups += 1;
    } else if (procedure === PDF_PROCEDURE) {
      if (state.pdfs + pending.pdfs >= 1) block('second_document');
      else {
        pending.pdfs += 1;
        pdfStays = documentStayCount(input);
      }
    } else if (procedure === WORKBOOK_PROCEDURE) {
      if (state.workbooks + pending.workbooks >= 1) block('second_document');
      else {
        pending.workbooks += 1;
        workbookStays = documentStayCount(input);
      }
    }
  });
  const allowed = blocked.length === 0;
  if (allowed) {
    state.ratedStayKeys.push(...pending.stays);
    state.partyLookups += pending.partyLookups;
    state.partyChecks += pending.partyChecks;
    state.pdfs += pending.pdfs;
    state.workbooks += pending.workbooks;
    if (pending.pdfs) state.pdfStays = pdfStays;
    if (pending.workbooks) state.workbookStays = workbookStays;
  }
  return { allowed, procedures, blocked };
}

/** Blocks the pane may cause on its own that do not fail AE1: its second automatic company/agency search. */
export const AE1_EXPECTED_BLOCKS: readonly string[] = [`${PARTY_LOOKUP_PROCEDURE} (second_party_lookup)`];

// ---------------------------------------------------------------------------------------------------------------------
// Room rows

export type SelectOption = { value: string; label: string };
/** One room row of the Stay details step, as the page shows it. */
export type PaneRoomRow = {
  stay: number;
  room: number;
  roomValue: string;
  roomOptions: SelectOption[];
  rooms: number | null;
  adults: number | null;
  board: string;
};

/** What the driver used for one row. Filled flags say which values it typed; the rest were the pane's. */
export type RoomRowUsed = {
  stay: number;
  room: number;
  /** The room type the email asked for when HMS does not know it ("Single"), else null. */
  askedType: string | null;
  roomType: string;
  roomTypeFilled: boolean;
  rooms: number;
  roomsFilled: boolean;
  adults: number;
  adultsFilled: boolean;
  board: string;
  boardFilled: boolean;
};

export type RoomSplit = { rule: string; rows: RoomRowUsed[] };

const ASKED_PREFIX = /^Email asked for /;
const KNOWN_CODE = /\(([A-Z]{2,8})\)$/;
/** Words for a room type that HMS names differently. Twin is listed as such; a single or a double sleeps in one bed. */
const ROOM_WORDS: Record<string, string[]> = {
  single: ['queen', 'king'],
  sgl: ['queen', 'king'],
  double: ['queen', 'king'],
  dbl: ['queen', 'king'],
  twn: ['twin'],
  twin: ['twin'],
};
const GENERIC_WORDS = new Set(['room', 'rooms', 'or', 'and', 'standard', 'type', 'the', 'a']);

/** The HMS room types a select offers (label "Standard Twin (STWN)"), in listed order. */
export function knownRoomOptions(options: readonly SelectOption[]): SelectOption[] {
  return options.filter((option) => KNOWN_CODE.exec(option.label)?.[1] === option.value);
}

/**
 * The first listed HMS room type that matches what the email asked for: a word of the ask in the type's name ("twin" in
 * Standard Twin), else the ask's usual bed ("single" and "double" sleep in a Queen, then a King). Null when none matches.
 */
export function pickRoomOption(asked: string, options: readonly SelectOption[]): SelectOption | null {
  const known = knownRoomOptions(options);
  const words = asked
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word && !GENERIC_WORDS.has(word));
  const named = (option: SelectOption, word: string) => new RegExp(`\\b${word}\\b`, 'i').test(option.label);
  const direct = known.find((option) => words.some((word) => named(option, word)));
  if (direct) return direct;
  for (const word of words) {
    for (const bed of ROOM_WORDS[word] ?? []) {
      const option = known.find((item) => named(item, bed));
      if (option) return option;
    }
  }
  return null;
}

export type RowPlan = {
  index: number;
  roomType: string | null;
  rooms: number | null;
  adults: number | null;
  board: Board | null;
};

/**
 * What to type in each row, and what the run then used. Throws a Blocker message when a row needs a value the inputs do
 * not give (a room type the email does not name, a stay with more rooms than NAVA_AE1_ROOMS counts).
 */
export function planRoomRows(rows: readonly PaneRoomRow[], inputs: Ae1Inputs): { plans: RowPlan[]; split: RoomSplit } {
  const plans: RowPlan[] = [];
  const used: RoomRowUsed[] = [];
  rows.forEach((row, index) => {
    const where = `stay ${row.stay} room ${row.room}`;
    const known = knownRoomOptions(row.roomOptions);
    const current = row.roomOptions.find((option) => option.value === row.roomValue);
    let askedType: string | null = null;
    let roomType = row.roomValue;
    let roomTypeFilled = false;
    if (!known.some((option) => option.value === row.roomValue)) {
      if (!row.roomValue || !current || !ASKED_PREFIX.test(current.label)) {
        throw new Error(`${where} has no room type and the email names none`);
      }
      askedType = redactText(row.roomValue).slice(0, 40);
      const picked = pickRoomOption(row.roomValue, row.roomOptions);
      if (!picked) throw new Error(`no listed HMS room type matches "${askedType}" (${where})`);
      roomType = picked.value;
      roomTypeFilled = true;
    }
    const nth = (split: number[]) => split[row.room - 1] ?? null;
    let rooms = row.rooms;
    const roomsFilled = rooms === null;
    if (rooms === null) {
      rooms = nth(inputs.roomSplit);
      if (rooms === null) {
        throw new Error(`${where} has no room count and NAVA_AE1_ROOMS gives only ${inputs.roomSplit.length} counts`);
      }
    }
    let adults = row.adults;
    const adultsFilled = adults === null;
    if (adults === null) {
      adults = nth(inputs.adultsSplit) ?? (/\b(single|sgl)\b/i.test(askedType ?? '') ? 1 : 2);
    }
    const boardFilled = !BOARDS.has(row.board);
    const board = boardFilled ? inputs.board : row.board;
    plans.push({
      index,
      roomType: roomTypeFilled ? roomType : null,
      rooms: roomsFilled ? rooms : null,
      adults: adultsFilled ? adults : null,
      board: boardFilled ? inputs.board : null,
    });
    used.push({ stay: row.stay, room: row.room, askedType, roomType, roomTypeFilled, rooms, roomsFilled, adults, adultsFilled, board, boardFilled });
  });
  return { plans, split: { rule: `${inputs.roomSplit.join('/')} rooms per stay where the pane has none`, rows: used } };
}

/** The fields a plan fills, as "stay<n>.room<m>.<field>". Empty when the pane already has every value the run needs. */
export function filledFieldsOf(split: RoomSplit): string[] {
  return split.rows.flatMap((row) => {
    const where = `stay${row.stay}.room${row.room}`;
    return [
      row.roomTypeFilled ? `${where}.roomType` : null,
      row.roomsFilled ? `${where}.rooms` : null,
      row.adultsFilled ? `${where}.adults` : null,
      row.boardFilled ? `${where}.board` : null,
    ].filter((field): field is string => field !== null);
  });
}

/** Browser-side: the Stay details step's room rows, in page order. Plain JS, no DOM types. */
export const READ_ROWS_JS = `() => {
  const pane = document.querySelector('[data-preview-pane]');
  const section = pane ? pane.querySelector('section[aria-label="Stay details"]') : null;
  if (!section) return null;
  const all = (selector) => Array.from(section.querySelectorAll(selector));
  const groups = all('[role="group"][aria-label^="Rooms for stay "]');
  const selects = all('select[aria-label="Room type"]');
  const rooms = all('input[aria-label="Rooms"]');
  const adults = all('input[aria-label="Adults"]');
  const boards = all('select[aria-label="Meal plan"]');
  return {
    counts: [groups.length, selects.length, rooms.length, adults.length, boards.length],
    rows: groups.map((group, i) => {
      const match = /^Rooms for stay (\\d+), room (\\d+)$/.exec(group.getAttribute('aria-label') || '');
      const select = selects[i];
      return {
        stay: match ? Number(match[1]) : 0,
        room: match ? Number(match[2]) : 0,
        roomValue: select ? select.value : '',
        roomOptions: select ? Array.from(select.options).map((o) => ({ value: o.value, label: (o.textContent || '').trim() })) : [],
        rooms: rooms[i] ? rooms[i].value : '',
        adults: adults[i] ? adults[i].value : '',
        board: boards[i] ? boards[i].value : '',
      };
    }),
  };
}`;

type RawRows = { counts: number[]; rows: Array<Omit<PaneRoomRow, 'rooms' | 'adults'> & { rooms: string; adults: string }> };

const countOf = (raw: string): number | null => (/^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : null);

async function readRoomRows(page: Page): Promise<PaneRoomRow[]> {
  const raw = (await page.evaluate(`(${READ_ROWS_JS})()`).catch(() => null)) as RawRows | null;
  if (!raw) throw new Blocker('the Stay details step is missing');
  if (new Set(raw.counts).size !== 1) {
    throw new Blocker(`the Stay details rows do not line up (groups, room types, rooms, adults, meal plans: ${raw.counts.join('/')})`);
  }
  return raw.rows.map((row) => ({ ...row, rooms: countOf(row.rooms), adults: countOf(row.adults) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Summary

export type Ae1Summary = MailboxRecord & {
  ok: boolean;
  run: string;
  threadId: string;
  storedWorkflow: string | null;
  /** Date options (stays) the pane quotes. */
  stays: number;
  /** Stay x room rows on the pane. */
  paneRows: number;
  /** Stays whose rates run returned a quote. */
  staysRated: number;
  /** Rates runs (workstation.executeStaffQuote) let through. */
  ratesRuns: number;
  /** HMS reads: rates runs, the party search and the party checks inside the rates runs. */
  hmsReads: number;
  partyLookups: number;
  partyChecks: number;
  pdf: boolean;
  /** Stays the combined PDF request covered. */
  pdfStays: number | null;
  xlsx: boolean;
  xlsxStays: number | null;
  /** Excel room lines (stay x room). */
  xlsxRows: number | null;
  /** Room lines the rates runs make: one per stay x room, more where a room's nightly rate changes. */
  expectedXlsxRows: number | null;
  xlsxExtraRows: number | null;
  /** Exactly one total row, equal to the sum of the lines. */
  xlsxTotalRow: boolean | null;
  roomSplitUsed: RoomSplit;
  /** NAVA_PROOF_ALLOW_EDITS was on. */
  editsAllowed: boolean;
  /** What the driver typed into the thread: "type" for the treat-as change, "stay<n>.room<m>.<field>" per filled value. */
  filledFields: string[];
  screenshots: { rates: boolean; documents: boolean; pane: boolean };
  workflowRunIds: string[];
  blocked: string[];
  blocker: string | null;
  failures: string[];
};

/** What keeps the run from passing. Empty means AE1 passed. */
export function ae1Failures(summary: Omit<Ae1Summary, 'ok' | 'failures'>): string[] {
  const failures: string[] = [];
  if (summary.blocker) failures.push(`blocker: ${summary.blocker}`);
  if (summary.stays < 2) failures.push(`AE1 needs at least two stays; the pane shows ${summary.stays}`);
  if (summary.ratesRuns !== summary.stays) {
    failures.push(`expected one rates run per stay (${summary.stays}), saw ${summary.ratesRuns}`);
  }
  if (summary.staysRated !== summary.stays) failures.push(`${summary.staysRated} of ${summary.stays} stays rated`);
  if (!summary.pdf) failures.push('no PDF');
  else if (summary.pdfStays !== summary.stays) failures.push(`the PDF covers ${summary.pdfStays ?? 0} of ${summary.stays} stays`);
  if (!summary.xlsx) failures.push('no Excel');
  else {
    if (summary.xlsxStays !== summary.stays) failures.push(`the Excel covers ${summary.xlsxStays ?? 0} of ${summary.stays} stays`);
    if (summary.xlsxRows === null || summary.xlsxRows !== summary.expectedXlsxRows) {
      failures.push(`the Excel has ${summary.xlsxRows ?? 0} stay x room rows, expected ${summary.expectedXlsxRows ?? '?'}`);
    }
    if (summary.xlsxTotalRow !== true) failures.push('the Excel has no single total row that adds up');
  }
  failures.push(...mailboxFailures(summary));
  const unexpected = unexpectedBlocks(summary.blocked, AE1_EXPECTED_BLOCKS);
  if (unexpected.length) failures.push(`the guard blocked: ${unexpected.join(', ')}`);
  if (!summary.screenshots.rates || !summary.screenshots.documents) failures.push('a screenshot is missing');
  return failures;
}

// ---------------------------------------------------------------------------------------------------------------------
// Browser run

export const RATES_SECTION = '[data-preview-pane] section[aria-label="Rates from HMS"]';
export const DOCUMENTS_SECTION = '[data-preview-pane] section[aria-label="Quote documents"]';
export const RUN_STEP = /^Run Search availability /;

/** The step buttons, one per date option, with the stay key each runs ("2026-10-26 → 2026-10-27" -> "2026-10-26:2026-10-27"). */
async function stepButtons(rates: Locator): Promise<Array<{ key: string; button: Locator }>> {
  const buttons = rates.getByRole('button', { name: RUN_STEP });
  const count = await buttons.count();
  const out: Array<{ key: string; button: Locator }> = [];
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    const name = ((await button.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    out.push({ key: name.replace(RUN_STEP, '').replace(/^Search availability /, '').replace(' → ', ':'), button });
  }
  return out;
}

export async function runAe1(config: Ae1Config, log: (line: string) => void): Promise<Ae1Summary> {
  const { inputs, threadId } = config;
  const run = basename(config.outDir) || 'ae1-rates';
  mkdirSync(config.outDir, { recursive: true, mode: 0o700 });
  const state = newAe1GuardState();
  const summary: Omit<Ae1Summary, 'ok' | 'failures'> = {
    run,
    threadId,
    storedWorkflow: null,
    stays: 0,
    paneRows: 0,
    staysRated: 0,
    ratesRuns: 0,
    hmsReads: 0,
    partyLookups: 0,
    partyChecks: 0,
    pdf: false,
    pdfStays: null,
    xlsx: false,
    xlsxStays: null,
    xlsxRows: null,
    expectedXlsxRows: null,
    xlsxExtraRows: null,
    xlsxTotalRow: null,
    roomSplitUsed: { rule: `${inputs.roomSplit.join('/')} rooms per stay where the pane has none`, rows: [] },
    editsAllowed: inputs.allowEdits,
    filledFields: [],
    activeMailboxSwitched: false,
    restored: false,
    screenshots: { rates: false, documents: false, pane: false },
    workflowRunIds: [],
    blocked: [],
    blocker: null,
  };
  const steps = async (page: Page, captured: Captured): Promise<void> => {
    // 1. Open the thread and let the pane read it.
    await openThread(page, config.baseUrl, threadId);
    log('pane settled');
    const stored = await waitFor('the stored read', 15_000, async () => {
      const get = latestOutcome(captured, 'workItems.getByMessage');
      return get ? storedWorkView(get.data) : null;
    }).catch((): StoredWorkView | null => null);
    summary.storedWorkflow = stored?.status === 'ready' ? stored.workflow : null;

    // 2. Type: Quote, as staff would set it.
    const pane = page.locator('[data-preview-pane]');
    const type = pane.locator('select[aria-label="Nava reads this as"]');
    await type.waitFor({ state: 'visible', timeout: STEP_MS }).catch(() => {
      throw new Blocker('treat-as select ("Nava reads this as") is missing');
    });
    if ((await type.inputValue()) !== 'quote') {
      if (!inputs.allowEdits) throw new Blocker(needsEditsMessage(['type']));
      await type.selectOption('quote');
      summary.filledFields.push('type');
      log('type set to Quote');
    }
    await waitFor('the room rows', SETTLE_MS, async () =>
      (await pane.locator('section[aria-label="Stay details"] [role="group"][aria-label^="Rooms for stay "]').count()) > 0
        ? true
        : null,
    );

    // 3. Fill what each room row is missing. Every edit lands before the first rates run, so no run goes stale.
    const rows = await readRoomRows(page);
    summary.paneRows = rows.length;
    let planned: ReturnType<typeof planRoomRows>;
    try {
      planned = planRoomRows(rows, inputs);
    } catch (error) {
      throw new Blocker(error instanceof Error ? error.message : 'the room rows cannot be filled');
    }
    summary.roomSplitUsed = planned.split;
    // A real thread: nothing is typed without NAVA_PROOF_ALLOW_EDITS=1, and a present value is never overwritten.
    const fills = filledFieldsOf(planned.split);
    if (fills.length && !inputs.allowEdits) throw new Blocker(needsEditsMessage(fills));
    summary.filledFields.push(...fills);
    const details = pane.locator('section[aria-label="Stay details"]');
    for (const plan of planned.plans) {
      if (plan.roomType) await details.locator('select[aria-label="Room type"]').nth(plan.index).selectOption(plan.roomType);
      if (plan.rooms !== null) {
        await details.locator('input[aria-label="Rooms"]').nth(plan.index).fill(String(plan.rooms), { force: true });
      }
      if (plan.adults !== null) {
        await details.locator('input[aria-label="Adults"]').nth(plan.index).fill(String(plan.adults), { force: true });
      }
      if (plan.board) await details.locator('select[aria-label="Meal plan"]').nth(plan.index).selectOption(plan.board);
    }
    log(`rows filled: ${planned.split.rows.filter((row) => row.roomsFilled || row.roomTypeFilled).length} of ${rows.length}`);
    await waitFor('the edits to land', STEP_MS, async () => {
      const now = await readRoomRows(page);
      return planned.split.rows.every(
        (want, i) =>
          now[i]?.roomValue === want.roomType &&
          now[i]?.rooms === want.rooms &&
          now[i]?.adults === want.adults &&
          now[i]?.board === want.board,
      )
        ? true
        : null;
    }).catch(() => {
      throw new Blocker('the pane did not take the room type, room count, adults or meal plan typed into a row');
    });

    // 4. One rates run per stay, through each stay's own search.
    const rates = page.locator(RATES_SECTION);
    await rates.waitFor({ state: 'visible', timeout: STEP_MS }).catch(() => {
      throw new Blocker('the Rates from HMS step is missing');
    });
    const getRates = rates.getByRole('button', { name: 'Get rates from HMS', exact: true });
    await waitFor('Get rates from HMS to be enabled', STEP_MS, async () => ((await getRates.isEnabled()) ? true : null)).catch(
      async () => {
        throw new Blocker(`Get rates from HMS is disabled: ${await visibleText(page, RATES_SECTION)}`);
      },
    );
    const uiStays = new Set(rows.map((row) => row.stay)).size;
    let stepList = await stepButtons(rates);
    if (stepList.length && !(await stepList[0]!.button.isVisible())) {
      await rates.getByText('HMS steps', { exact: true }).click();
      stepList = await stepButtons(rates);
    }
    summary.stays = stepList.length || uiStays;
    if (stepList.length && stepList.length !== uiStays) {
      throw new Blocker(`the pane shows ${uiStays} stays but ${stepList.length} date options`);
    }
    state.expectedStays = summary.stays;
    log(`stays: ${summary.stays}`);

    const expectedLines: number[] = [];
    for (let i = 0; i < summary.stays; i++) {
      const runsBefore = state.ratedStayKeys.length;
      const outcomesBefore = captured.outcomes.length;
      const button = stepList[i]?.button ?? getRates;
      await waitFor(`the search for stay ${i + 1} to be enabled`, STEP_MS, async () =>
        (await button.isEnabled()) ? true : null,
      ).catch(async () => {
        throw new Blocker(`stay ${i + 1} cannot be searched: ${await visibleText(page, RATES_SECTION)}`);
      });
      await button.click();
      await waitFor(`the rates run for stay ${i + 1} to start`, 15_000, async () =>
        state.ratedStayKeys.length > runsBefore ? true : null,
      ).catch(async () => {
        throw new Blocker(`the rates run for stay ${i + 1} did not start: ${await visibleText(page, RATES_SECTION)}`);
      });
      const ranKey = state.ratedStayKeys.at(-1);
      if (stepList[i] && ranKey !== stepList[i]!.key) {
        throw new Blocker(`the search for stay ${i + 1} (${stepList[i]!.key}) ran ${ranKey ?? 'no stay'}`);
      }
      log(`rates run ${i + 1} started`);
      const outcome = await waitFor(`the rates run for stay ${i + 1}`, config.timeoutMs, async () =>
        latestOutcome(captured, HMS_RATES_PROCEDURE, outcomesBefore),
      );
      if (outcome.error) throw new Blocker(`rates run ${i + 1} failed: ${redactText(outcome.error.message).slice(0, 240)}`);
      const data = (outcome.data ?? {}) as { workflowRunId?: unknown; rowRates?: unknown };
      if (typeof data.workflowRunId === 'string') summary.workflowRunIds.push(data.workflowRunId);
      const rowRates = Array.isArray(data.rowRates) ? data.rowRates : [];
      for (const row of rowRates) {
        const nightly = (row as { nightlyMinor?: unknown } | null)?.nightlyMinor;
        if (Array.isArray(nightly) && nightly.every((n) => Number.isSafeInteger(n))) expectedLines.push(rateSegments(nightly));
      }
      // A multi-stay quote counts its rated stays ("1 of 2 stays rated"); one stay is rated once its run returns.
      await waitFor(`stay ${i + 1} to show as rated`, STEP_MS, async () =>
        summary.stays < 2 || new RegExp(`\\b${i + 1} of ${summary.stays} stays rated`).test(await rates.innerText())
          ? true
          : null,
      ).catch(async () => {
        throw new Blocker(`stay ${i + 1} is not rated after its run: ${await visibleText(page, RATES_SECTION)}`);
      });
      summary.staysRated = i + 1;
      log(`stay ${i + 1} rated`);
    }
    // Each room row makes at least one line; a run that reported its rows refines that by nightly rate changes.
    summary.expectedXlsxRows = expectedLines.length === rows.length ? expectedLines.reduce((a, b) => a + b, 0) : rows.length;

    // 5. The combined quote PDF.
    const prepare = page.locator(DOCUMENTS_SECTION).getByRole('button', { name: /^Prepare (quote|PDF)$/ });
    await prepare.first().waitFor({ state: 'visible', timeout: STEP_MS }).catch(() => {
      throw new Blocker('the Quote documents step is missing');
    });
    await waitFor('Prepare quote to be enabled', STEP_MS, async () => ((await prepare.first().isEnabled()) ? true : null)).catch(
      async () => {
        throw new Blocker(`Prepare quote is disabled: ${await visibleText(page, DOCUMENTS_SECTION)}`);
      },
    );
    const pdfBefore = captured.outcomes.length;
    await prepare.first().click();
    const pdfOutcome = await waitFor('the PDF', DOC_MS, async () => latestOutcome(captured, PDF_PROCEDURE, pdfBefore));
    if (pdfOutcome.error) throw new Blocker(`PDF failed: ${redactText(pdfOutcome.error.message).slice(0, 240)}`);
    const pdfBase64 = (pdfOutcome.data as { pdfBase64?: unknown } | undefined)?.pdfBase64;
    if (typeof pdfBase64 !== 'string') throw new Blocker('PDF response carried no file');
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    writeFileSync(join(config.outDir, 'quote.pdf'), pdfBytes, { mode: 0o600 });
    summary.pdf = pdfBytes.length > 0 && pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-';
    log('pdf saved');

    // 6. The Excel.
    const excel = page.locator(DOCUMENTS_SECTION).getByRole('button', { name: 'Download Excel' });
    await waitFor('Download Excel to be enabled', STEP_MS, async () => ((await excel.isEnabled()) ? true : null)).catch(
      async () => {
        throw new Blocker(`Download Excel is disabled: ${await visibleText(page, DOCUMENTS_SECTION)}`);
      },
    );
    const xlsxBefore = captured.outcomes.length;
    await excel.click();
    const xlsxOutcome = await waitFor('the Excel', DOC_MS, async () => latestOutcome(captured, WORKBOOK_PROCEDURE, xlsxBefore));
    if (xlsxOutcome.error) throw new Blocker(`Excel failed: ${redactText(xlsxOutcome.error.message).slice(0, 240)}`);
    const xlsxBase64 = (xlsxOutcome.data as { xlsxBase64?: unknown } | undefined)?.xlsxBase64;
    if (typeof xlsxBase64 !== 'string') throw new Blocker('Excel response carried no file');
    const xlsxBytes = Buffer.from(xlsxBase64, 'base64');
    writeFileSync(join(config.outDir, 'quote.xlsx'), xlsxBytes, { mode: 0o600 });
    summary.xlsx = true;
    let count: ReturnType<typeof countWorkbookLines>;
    try {
      count = countWorkbookLines(xlsxSheetRows(xlsxBytes));
    } catch {
      throw new Blocker('the Excel could not be read');
    }
    summary.xlsxRows = count.roomLines;
    summary.xlsxExtraRows = count.extraLines;
    summary.xlsxTotalRow = count.totalRows === 1 && count.totalMatches === true;
    log('excel saved');

    // 7. The rates and documents steps, guest details masked.
    await waitFor('the prepared quote line', STEP_MS, async () =>
      /Prepared (quote|PDF) /.test(await page.locator(DOCUMENTS_SECTION).innerText()) ? true : null,
    ).catch(() => undefined);
    const shots = await captureShots(page, config.outDir, { rates: RATES_SECTION, documents: DOCUMENTS_SECTION });
    summary.screenshots = { rates: shots.rates === true, documents: shots.documents === true, pane: shots.pane === true };
    log(`screenshots: rates=${summary.screenshots.rates} documents=${summary.screenshots.documents}`);
  };

  const permit = newMailboxPermit();
  const mailbox = newMailboxSwitch();
  const { browser, context, page, captured } = await openProofPage(
    config,
    withMailboxPermit((url, postData) => classifyAe1Request(url, postData, state), permit),
  );
  try {
    try {
      // The run's transport is the active mailbox while the pane is open; the previous default comes back after.
      await withActiveMailbox(browserMailboxApi(context, config.baseUrl, permit), config.transportId, mailbox, log, () =>
        steps(page, captured),
      );
    } catch (error) {
      if (!(error instanceof Blocker) && !(error instanceof MailboxSwitchError)) throw error;
      summary.blocker = error.message;
      const shots = await captureShots(page, config.outDir, { rates: RATES_SECTION, documents: DOCUMENTS_SECTION }).catch(
        () => ({}) as Record<string, boolean>,
      );
      summary.screenshots = { rates: shots.rates === true, documents: shots.documents === true, pane: shots.pane === true };
    }
    await context.close();
  } finally {
    summary.activeMailboxSwitched = mailbox.activeMailboxSwitched;
    summary.restored = mailbox.restored;
    await browser.close();
  }
  summary.ratesRuns = state.ratedStayKeys.length;
  summary.partyLookups = state.partyLookups;
  summary.partyChecks = state.partyChecks;
  summary.hmsReads = summary.ratesRuns + state.partyLookups + state.partyChecks;
  summary.pdfStays = state.pdfStays;
  summary.xlsxStays = state.workbookStays;
  summary.blocked = [...new Set(captured.blocked)].slice(0, 30);
  const failures = ae1Failures(summary);
  return { ...summary, ok: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const config = parseAe1Config(process.argv.slice(2), process.env, process.cwd());
  const summary = await runAe1(config, (line) => console.log(line));
  writeFileSync(join(config.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(`out: ${config.outDir}`);
  console.log(JSON.stringify(summary));
  // 0 pass, 1 AE1 failed, 2 blocked before the proof could finish.
  process.exitCode = summary.ok ? 0 : summary.blocker ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Error text can echo page content, so print the message only and never the stack.
    console.error(`nava-ae1-rates-proof: ${error instanceof Error ? redactText(error.message) : 'failed'}`);
    process.exitCode = 2;
  });
}
