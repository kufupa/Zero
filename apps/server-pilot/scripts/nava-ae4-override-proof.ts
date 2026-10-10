/**
 * AE4 live proof: a discount override, end to end in the real pane, with one HMS read and no HMS write.
 *
 * Staff pick rate code NCOR1B, enter R1,850 per night and type "Kamala OK'd – repeat group". PASS means:
 *   - the client quote PDF and the Excel show R1,850 only (no note, no HMS rate);
 *   - the pane review shows the override and a "Copy for HMS comments" line;
 *   - a work_event row holds the HMS (AI) rate, her rate, the note and her session user.
 *
 * The driver opens one thread in /nava-preview, sets the type to Quote, types one stay, saves the override on the row
 * (which starts the stay's rates run: workstation.executeStaffQuote, the one HMS call, a read), prepares the PDF and the
 * Excel, and screenshots the row's review with guest details masked ([data-pii], as nava-preview-run.ts does).
 *
 * Guard: every tRPC request is checked by procedure name. Reads and the analysis pass. Of the writes, only the AE4 ones
 * pass (AE4_WRITE_PROCEDURES): the work item open and field events, the one rates run, the PDF and the Excel. A second
 * rates run, a rates run that carries a company or agency (the server would look it up in HMS first), every HMS write,
 * every mailbox write and every unknown call is aborted.
 *
 * The rate event is written only when the mail's stored read is a quote (a work_item of kind 'quote' exists, see
 * workstation.ts executeStaffQuote and work-events.ts quoteWorkItemIdFor). The driver checks that before the HMS read
 * and stops with blocker "no_quote_work_item" otherwise. NAVA_AE4_ALLOW_NO_EVENT=1 goes on without the event.
 *
 * Environment (values are never printed): NAVA_PREVIEW_BASE_URL, NAVA_PREVIEW_STORAGE_STATE, NAVA_PREVIEW_RESOLVE_TO,
 * NAVA_PREVIEW_TRANSPORT_ID, NAVA_PREVIEW_CHROMIUM as nava-preview-run.ts. Optional stay and override inputs:
 * NAVA_AE4_ARRIVAL (2027-03-10), NAVA_AE4_DEPARTURE (2027-03-11), NAVA_AE4_ROOM (STQN), NAVA_AE4_BOARD (bb),
 * NAVA_AE4_RATE_CODE (NCOR1B), NAVA_AE4_RATE (1,850), NAVA_AE4_NOTE ("Kamala OK'd – repeat group").
 *
 * Usage: nava-preview-gate.sh --ae4 <thread-id>   (signs in, then runs:)
 *   pnpm --dir apps/server-pilot exec tsx scripts/nava-ae4-override-proof.ts --threads <id> --out <dir> --timeout-ms 600000
 *
 * Output: <out>/summary.json, review.png (the row's price box), pane.png (the whole pane), quote.pdf, quote.xlsx.
 * The last stdout line is the summary as one JSON line.
 *
 * Read-only check of the work_event row (SELECT only; no guest field is selected). Put the summary's workflowRunId in:
 *
 *   SELECT e.id                                AS work_event_id,
 *          e.at,
 *          e.type,
 *          e.actor_kind,
 *          e.actor_user_id,
 *          e.field_path,
 *          e.ai_value ->> 'rateCode'           AS ai_rate_code,
 *          e.ai_value -> 'nightlyMinor'        AS ai_nightly_minor,
 *          e.value ->> 'source'                AS price_source,
 *          e.value ->> 'rateCode'              AS override_rate_code,
 *          (e.value ->> 'amountMinor')::int    AS override_rate_minor,
 *          e.value ->> 'note'                  AS override_note,
 *          e.ai_source                         AS workflow_run_id,
 *          w.kind                              AS work_item_kind
 *     FROM work_event e
 *     JOIN work_item w ON w.id = e.work_item_id
 *    WHERE e.type = 'rate.override'
 *      AND e.ai_source = '<workflowRunId>'
 *    ORDER BY e.at DESC;
 *
 * Expected: one row, actor_kind user, actor_user_id user-navaai, override_rate_code NCOR1B, override_rate_minor 185000,
 * override_note "Kamala OK'd – repeat group", ai_nightly_minor the HMS rate, work_item_kind quote.
 */
import { chromium, type Browser, type Page, type Request, type Response, type Route } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import {
  ANALYSIS_PROCEDURES,
  fitPaneToContent,
  KNOWN_WRITE_PROCEDURES,
  MARK_PII_JS,
  outcomeOf,
  parseRunConfig,
  PII_SELECTOR,
  READ_PANE_JS,
  READ_PROCEDURES,
  redactText,
  type PaneRead,
  type RunConfig,
} from './nava-preview-run';

/** The writes AE4 needs. Nothing here writes to HMS or the mailbox; executeStaffQuote is the one HMS read. */
export const AE4_WRITE_PROCEDURES: ReadonlySet<string> = new Set([
  'workItems.open',
  'workItems.recordEvent',
  'workstation.executeStaffQuote',
  'workstation.qualifiedQuoteProposalPdf',
  'workstation.quoteWorkbook',
]);
/** The rates run. It reads HMS once; the guard lets one through. */
export const HMS_RATES_PROCEDURE = 'workstation.executeStaffQuote';

export type Ae4Inputs = {
  arrival: string;
  departure: string;
  room: string;
  board: 'room_only' | 'bb' | 'dinner_bb';
  rateCode: string;
  /** As staff type it, e.g. "1,850". */
  rate: string;
  rateMinor: number;
  note: string;
  allowNoEvent: boolean;
};

export type Ae4Config = RunConfig & { threadId: string; inputs: Ae4Inputs };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM_CODE = /^[A-Z]{2,8}$/;
const RATE_CODE = /^[A-Z0-9_-]{1,16}$/;
const BOARDS = new Set(['room_only', 'bb', 'dinner_bb']);

/** A rand amount as staff type it ("1,850", "1 850.00") in cents, or null. */
export function randToMinor(raw: string): number | null {
  const compact = raw.replace(/[\s,]/g, '').replace(/^R/i, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(compact)) return null;
  const minor = Math.round(Number(compact) * 100);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** Reads the run settings (as nava-preview-run.ts, one thread) and the AE4 inputs. Messages never echo a value. */
export function parseAe4Config(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Ae4Config {
  const base = parseRunConfig(argv, env, cwd);
  if (base.selection.kind !== 'threads' || base.selection.ids.length !== 1) {
    throw new Error('AE4 runs on exactly one thread: --threads <id>');
  }
  const pick = (key: string, fallback: string) => env[key]?.trim() || fallback;
  const arrival = pick('NAVA_AE4_ARRIVAL', '2027-03-10');
  const departure = pick('NAVA_AE4_DEPARTURE', '2027-03-11');
  if (!ISO_DATE.test(arrival) || !ISO_DATE.test(departure) || departure <= arrival) {
    throw new Error('NAVA_AE4_ARRIVAL and NAVA_AE4_DEPARTURE must be YYYY-MM-DD, departure after arrival');
  }
  // The proof reads HMS for a far-off stay only, so no live booking period is touched.
  if (arrival < '2027-01-01') throw new Error('NAVA_AE4_ARRIVAL must be in 2027 or later');
  const room = pick('NAVA_AE4_ROOM', 'STQN').toUpperCase();
  if (!ROOM_CODE.test(room)) throw new Error('NAVA_AE4_ROOM must be an HMS room code');
  const board = pick('NAVA_AE4_BOARD', 'bb');
  if (!BOARDS.has(board)) throw new Error('NAVA_AE4_BOARD must be room_only, bb or dinner_bb');
  const rateCode = pick('NAVA_AE4_RATE_CODE', 'NCOR1B').toUpperCase();
  if (!RATE_CODE.test(rateCode)) throw new Error('NAVA_AE4_RATE_CODE must be an HMS rate code');
  const rate = pick('NAVA_AE4_RATE', '1,850');
  const rateMinor = randToMinor(rate);
  if (rateMinor === null) throw new Error('NAVA_AE4_RATE must be a rand amount like 1,850');
  const note = pick('NAVA_AE4_NOTE', "Kamala OK'd – repeat group");
  if (note.length > 500) throw new Error('NAVA_AE4_NOTE must be at most 500 characters');
  return {
    ...base,
    threadId: base.selection.ids[0]!,
    inputs: {
      arrival,
      departure,
      room,
      board: board as Ae4Inputs['board'],
      rateCode,
      rate,
      rateMinor,
      note,
      allowNoEvent: env.NAVA_AE4_ALLOW_NO_EVENT?.trim() === '1',
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Request guard

export type GuardState = { hmsReads: number };
export type Ae4Decision = {
  allowed: boolean;
  procedures: string[];
  blocked: Array<{ procedure: string; reason: 'write' | 'unknown' | 'second_hms_read' | 'party_lookup' }>;
};

const TRPC_PREFIX = '/api/trpc/';

/** Procedure names in a /api/trpc/ path, batched or not. */
export function trpcProcedures(url: string): string[] {
  const { pathname } = new URL(url);
  return pathname.startsWith(TRPC_PREFIX) ? pathname.slice(TRPC_PREFIX.length).split(',').filter(Boolean) : [];
}

/** The input of one batched call (superjson body {"0":{"json":...}}), or undefined. */
function batchInput(postData: string | null, index: number): unknown {
  if (!postData) return undefined;
  try {
    const body = JSON.parse(postData) as Record<string, { json?: unknown } | undefined>;
    const entry = body?.[String(index)];
    return entry && typeof entry === 'object' && 'json' in entry ? entry.json : entry;
  } catch {
    return undefined;
  }
}

function hasParties(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const parties = (input as { parties?: unknown }).parties;
  if (!parties || typeof parties !== 'object') return false;
  return Object.values(parties as Record<string, unknown>).some((value) => value !== null && value !== undefined);
}

/**
 * Whether one request may go. A batch goes only when every call in it may. The rates run passes once, and only without
 * picked parties (with them the server looks the company or agency up in HMS before the rates read). The state counts the
 * rates run only when the whole request is let through.
 */
export function classifyAe4Request(url: string, postData: string | null, state: GuardState): Ae4Decision {
  const procedures = trpcProcedures(url);
  if (procedures.length === 0) {
    return { allowed: false, procedures, blocked: [{ procedure: '(none)', reason: 'unknown' }] };
  }
  const blocked: Ae4Decision['blocked'] = [];
  let ratesRuns = 0;
  procedures.forEach((procedure, index) => {
    if (READ_PROCEDURES.has(procedure) || ANALYSIS_PROCEDURES.has(procedure)) return;
    if (!AE4_WRITE_PROCEDURES.has(procedure)) {
      blocked.push({ procedure, reason: KNOWN_WRITE_PROCEDURES.has(procedure) ? 'write' : 'unknown' });
      return;
    }
    if (procedure !== HMS_RATES_PROCEDURE) return;
    if (state.hmsReads + ratesRuns >= 1) {
      blocked.push({ procedure, reason: 'second_hms_read' });
      return;
    }
    if (hasParties(batchInput(postData, index))) {
      blocked.push({ procedure, reason: 'party_lookup' });
      return;
    }
    ratesRuns += 1;
  });
  const allowed = blocked.length === 0;
  if (allowed) state.hmsReads += ratesRuns;
  return { allowed, procedures, blocked };
}

// ---------------------------------------------------------------------------------------------------------------------
// tRPC responses

export type TrpcOutcome = { procedure: string; data?: unknown; error?: { message: string; code: string | null } };

/** Splits an httpBatchLink response (superjson) into one outcome per procedure in the path. */
export function parseTrpcBatch(url: string, body: string): TrpcOutcome[] {
  const procedures = trpcProcedures(url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return procedures.map((procedure, index) => {
    const item = items[index] as
      | { result?: { data?: { json?: unknown } | unknown }; error?: { json?: unknown } | unknown }
      | undefined;
    if (!item || typeof item !== 'object') return { procedure };
    if (item.error) {
      const raw = (item.error as { json?: unknown }).json ?? item.error;
      const err = raw as { message?: unknown; data?: { code?: unknown } };
      return {
        procedure,
        error: {
          message: typeof err.message === 'string' ? err.message : 'error',
          code: typeof err.data?.code === 'string' ? err.data.code : null,
        },
      };
    }
    const data = item.result?.data as { json?: unknown } | undefined;
    return { procedure, data: data && typeof data === 'object' && 'json' in data ? data.json : data };
  });
}

/** The stored read the pane sees (workItems.getByMessage or workItems.open). */
export type StoredWorkView = { status: string; workItemId: string | null; workflow: string | null };

export function storedWorkView(data: unknown): StoredWorkView | null {
  if (!data || typeof data !== 'object') return null;
  const view = data as { status?: unknown; workItemId?: unknown; analysis?: { luna?: { workflow?: unknown } } };
  if (typeof view.status !== 'string') return null;
  return {
    status: view.status,
    workItemId: typeof view.workItemId === 'string' ? view.workItemId : null,
    workflow: typeof view.analysis?.luna?.workflow === 'string' ? view.analysis.luna.workflow : null,
  };
}

/** One row's rate from the rates run (rowRatesFor on the server). */
export type RunRowRate = {
  source: string;
  hmsNightlyMinor: number[];
  nightlyMinor: number[];
  rateCode: string | null;
  note: string | null;
  hmsComment: string | null;
};

export type RatesRun = { workflowRunId: string | null; totalMinor: number | null; rows: RunRowRate[] };

const isMinorList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => Number.isSafeInteger(item));

export function ratesRunOf(data: unknown): RatesRun {
  const run = (data ?? {}) as { workflowRunId?: unknown; totalMinor?: unknown; rowRates?: unknown };
  const rows = Array.isArray(run.rowRates) ? run.rowRates : [];
  return {
    workflowRunId: typeof run.workflowRunId === 'string' ? run.workflowRunId : null,
    totalMinor: Number.isSafeInteger(run.totalMinor) ? (run.totalMinor as number) : null,
    rows: rows.flatMap((raw): RunRowRate[] => {
      const row = (raw ?? {}) as Record<string, unknown>;
      if (typeof row.source !== 'string' || !isMinorList(row.hmsNightlyMinor) || !isMinorList(row.nightlyMinor)) {
        return [];
      }
      const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : null);
      return [
        {
          source: row.source,
          hmsNightlyMinor: row.hmsNightlyMinor,
          nightlyMinor: row.nightlyMinor,
          rateCode: text('rateCode'),
          note: text('note'),
          hmsComment: text('hmsComment'),
        },
      ];
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Document text checks

/**
 * Every money-like amount in the text, in cents. Thousands may be grouped by a comma or a (non-breaking) space; cents by a
 * dot or a comma. "R1,850.00", "R 1 850,00" and a sheet value "1850" all read as 185000. "11,850.00" stays 1185000.
 */
export function amountsInText(text: string): number[] {
  const out: number[] = [];
  const pattern = /\d{1,3}(?:[, \u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d{1,2})?(?!\d)/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    // A digit right before the match means the regex started inside a longer number.
    if (start > 0 && /\d/.test(text[start - 1]!)) continue;
    const token = match[0];
    const decimal = /[.,](\d{1,2})$/.exec(token);
    const whole = (decimal ? token.slice(0, -decimal[0].length) : token).replace(/[, \u00a0\u202f]/g, '');
    const cents = decimal ? Number(decimal[1]!.padEnd(2, '0')) : 0;
    const minor = Number(whole) * 100 + cents;
    if (Number.isSafeInteger(minor)) out.push(minor);
  }
  return out;
}

export function textHasAmount(text: string, minor: number): boolean {
  return amountsInText(text).includes(minor);
}

/** Lower case, letters and digits only, single spaces. Dashes, quotes and apostrophes of any kind become a space. */
export function normaliseWords(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Pieces of the note that would show it leaked: the whole note, each word of 6+ letters, and each pair of neighbouring
 * words with 8+ letters together. "Kamala OK'd – repeat group" gives "kamala", "repeat", "kamala ok" and "repeat group".
 */
export function noteFragments(note: string): string[] {
  const words = normaliseWords(note).split(' ').filter(Boolean);
  const out = new Set<string>();
  if (words.length) out.add(words.join(' '));
  for (const word of words) if (word.length >= 6) out.add(word);
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i]!.length + words[i + 1]!.length >= 8) out.add(`${words[i]} ${words[i + 1]}`);
  }
  return [...out];
}

export function textHasNote(text: string, note: string): boolean {
  const haystack = ` ${normaliseWords(text)} `;
  return noteFragments(note).some((fragment) => haystack.includes(` ${fragment} `));
}

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The text of an .xlsx: every shared string, every inline string and every cell value that is not a shared-string index.
 * One item per line. Drawings and styles are not read.
 */
export function xlsxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, {
    filter: (file) => file.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(file.name),
  });
  const lines: string[] = [];
  const shared = files['xl/sharedStrings.xml'];
  if (shared) {
    for (const match of strFromU8(shared).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) lines.push(decodeXml(match[1]!));
  }
  for (const [name, data] of Object.entries(files)) {
    if (name === 'xl/sharedStrings.xml') continue;
    const xml = strFromU8(data);
    for (const cell of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? '';
      const inner = cell[2] ?? '';
      if (/\bt="s"/.test(attrs)) continue;
      for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) lines.push(decodeXml(t[1]!));
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (value) lines.push(decodeXml(value[1]!));
    }
  }
  return lines.join('\n');
}

export type DocumentCheck = {
  /** Her rate is on the document. */
  hasRate: boolean;
  /** Any piece of the internal note is on the document. */
  hasNote: boolean;
  /** An HMS nightly rate is on the document. Null when an HMS rate equals hers, so the check cannot tell them apart. */
  hasAiRate: boolean | null;
};

export function checkDocumentText(
  text: string,
  expect: { rateMinor: number; note: string; aiRatesMinor: readonly number[] },
): DocumentCheck {
  const amounts = new Set(amountsInText(text));
  const aiRates = [...new Set(expect.aiRatesMinor)];
  return {
    hasRate: amounts.has(expect.rateMinor),
    hasNote: textHasNote(text, expect.note),
    hasAiRate: aiRates.includes(expect.rateMinor) ? null : aiRates.some((rate) => amounts.has(rate)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Summary

export type Ae4Summary = {
  ok: boolean;
  run: string;
  threadId: string;
  pdfHas1850: boolean | null;
  pdfHasNote: boolean | null;
  pdfHasAiRate: boolean | null;
  xlsxHas1850: boolean | null;
  xlsxHasNote: boolean | null;
  xlsxHasAiRate: boolean | null;
  reviewShowsOverride: boolean;
  copyForHmsLine: string | null;
  copyButtonShown: boolean;
  aiRateMinor: number[];
  overrideRateMinor: number;
  storedWorkflow: string | null;
  workItemId: string | null;
  workflowRunId: string | null;
  /** No route returns it. The header's SELECT finds it by workflowRunId (work_event.ai_source). */
  workEventId: null;
  hmsReads: number;
  blocked: string[];
  failures: string[];
  blocker: string | null;
};

/** What keeps the run from passing. Empty means AE4 passed. */
export function ae4Failures(summary: Omit<Ae4Summary, 'ok' | 'failures'>, allowNoEvent = false): string[] {
  const failures: string[] = [];
  if (summary.blocker) failures.push(`blocker: ${summary.blocker}`);
  if (summary.pdfHas1850 !== true) failures.push('PDF does not show the override rate');
  if (summary.pdfHasNote !== false) failures.push('PDF shows the internal note');
  if (summary.pdfHasAiRate === true) failures.push('PDF shows the HMS rate');
  if (summary.xlsxHas1850 !== true) failures.push('Excel does not show the override rate');
  if (summary.xlsxHasNote !== false) failures.push('Excel shows the internal note');
  if (summary.xlsxHasAiRate === true) failures.push('Excel shows the HMS rate');
  if (!summary.reviewShowsOverride) failures.push('the pane review does not show the override');
  if (!summary.copyForHmsLine || !summary.copyButtonShown) failures.push('no Copy for HMS comments line');
  if (summary.hmsReads !== 1) failures.push(`expected one HMS read, saw ${summary.hmsReads}`);
  if (!allowNoEvent && (summary.storedWorkflow !== 'quote' || !summary.workflowRunId)) {
    failures.push('no rate.override work_event can be written for this mail');
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------------------------------
// Browser run

class Blocker extends Error {}

const SETTLE_MS = 120_000;
const STEP_MS = 30_000;
const POLL_MS = 1_000;
const DOC_MS = 180_000;
const VIEWPORT = { width: 1600, height: 1000 };

type Captured = {
  outcomes: TrpcOutcome[];
  blocked: string[];
};

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined>): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe().catch((error: unknown) => {
      if (error instanceof Blocker) throw error;
      return null;
    });
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Blocker(`timed out: ${what}`);
}

function latestOutcome(captured: Captured, procedure: string, after = 0): TrpcOutcome | null {
  for (let i = captured.outcomes.length - 1; i >= after; i--) {
    if (captured.outcomes[i]!.procedure === procedure) return captured.outcomes[i]!;
  }
  return null;
}

async function readPane(page: Page, threadId: string): Promise<PaneRead | null> {
  return page
    .evaluate(`(${READ_PANE_JS})(${JSON.stringify(threadId)})`)
    .then((value) => value as PaneRead)
    .catch(() => null);
}

/** The disabled reason the pane shows next to a button, for a blocker line. Product copy only, scrubbed anyway. */
async function visibleText(page: Page, selector: string): Promise<string> {
  const text = await page
    .locator(selector)
    .first()
    .innerText({ timeout: 2_000 })
    .catch(() => '');
  return redactText(text.replace(/\s+/g, ' ').trim()).slice(0, 240);
}

async function capturePane(page: Page, outDir: string): Promise<{ pane: boolean; review: boolean }> {
  await fitPaneToContent(page);
  await page.evaluate(`(${MARK_PII_JS})()`).catch(() => 0);
  const mask = [page.locator(`[data-runner-mask], ${PII_SELECTOR}`)];
  const panePath = join(outDir, 'pane.png');
  const reviewPath = join(outDir, 'review.png');
  await page
    .locator('[data-preview-pane]')
    .screenshot({ path: panePath, mask, timeout: 15_000 })
    .catch(() => undefined);
  await page
    .locator('[data-preview-pane] section[aria-label$=" price"]')
    .first()
    .screenshot({ path: reviewPath, mask, timeout: 15_000 })
    .catch(() => undefined);
  await page.setViewportSize(VIEWPORT).catch(() => undefined);
  return { pane: existsSync(panePath), review: existsSync(reviewPath) };
}

export async function runAe4(config: Ae4Config, log: (line: string) => void): Promise<Ae4Summary> {
  const { inputs, threadId } = config;
  const run = basename(config.outDir) || 'ae4';
  mkdirSync(config.outDir, { recursive: true, mode: 0o700 });
  const state: GuardState = { hmsReads: 0 };
  const captured: Captured = { outcomes: [], blocked: [] };
  const summary: Omit<Ae4Summary, 'ok' | 'failures'> = {
    run,
    threadId,
    pdfHas1850: null,
    pdfHasNote: null,
    pdfHasAiRate: null,
    xlsxHas1850: null,
    xlsxHasNote: null,
    xlsxHasAiRate: null,
    reviewShowsOverride: false,
    copyForHmsLine: null,
    copyButtonShown: false,
    aiRateMinor: [],
    overrideRateMinor: inputs.rateMinor,
    storedWorkflow: null,
    workItemId: null,
    workflowRunId: null,
    workEventId: null,
    hmsReads: 0,
    blocked: [],
    blocker: null,
  };

  const host = new URL(config.baseUrl).hostname;
  const browser: Browser = await chromium.launch({
    headless: true,
    args: config.resolveTo ? [`--host-resolver-rules=MAP ${host} ${config.resolveTo}`] : [],
    ignoreDefaultArgs: ['--hide-scrollbars'],
    ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}),
  });
  try {
    const context = await browser.newContext({
      storageState: config.storageStatePath,
      viewport: VIEWPORT,
      acceptDownloads: false,
      ...(config.transportId ? { extraHTTPHeaders: { 'x-zero-active-transport': config.transportId } } : {}),
    });
    const page = await context.newPage();
    await page.route('**/api/trpc/**', async (route: Route) => {
      const request: Request = route.request();
      const decision = classifyAe4Request(request.url(), request.postData(), state);
      if (decision.allowed) {
        await route.continue();
        return;
      }
      for (const item of decision.blocked) captured.blocked.push(`${item.procedure} (${item.reason})`);
      await route.abort('blockedbyclient');
    });
    page.on('response', (response: Response) => {
      const url = response.url();
      if (!url.includes(TRPC_PREFIX)) return;
      void response
        .text()
        .then((body) => {
          captured.outcomes.push(...parseTrpcBatch(url, body));
        })
        .catch(() => undefined);
    });

    try {
      // 1. Open the thread and let the pane read it.
      await page.goto(`${config.baseUrl}/nava-preview?thread=${encodeURIComponent(threadId)}`, {
        waitUntil: 'domcontentloaded',
      });
      if (new URL(page.url()).pathname.startsWith('/login')) throw new Blocker('the storage state has no session');
      await waitFor('the pane to read the email', SETTLE_MS, async () => {
        const read = await readPane(page, threadId);
        const outcome = read ? outcomeOf(read) : null;
        if (outcome === 'unsynced' || outcome === 'error') throw new Blocker(`pane ${outcome}`);
        return outcome;
      });
      log('pane settled');

      // 2. The stored read decides whether a rate event can be written. Checked before any HMS call.
      const noRead: StoredWorkView = { status: 'none', workItemId: null, workflow: null };
      const stored = await waitFor('the stored read', 15_000, async () => {
        const get = latestOutcome(captured, 'workItems.getByMessage');
        return get ? (storedWorkView(get.data) ?? noRead) : null;
      }).catch(() => noRead);
      summary.storedWorkflow = stored.status === 'ready' ? stored.workflow : null;
      summary.workItemId = stored.workItemId;
      if (summary.storedWorkflow !== 'quote' && !inputs.allowNoEvent) {
        throw new Blocker(
          `no_quote_work_item: the stored read is ${summary.storedWorkflow ?? stored.status}, so no rate.override work_event can be written (workstation.ts executeStaffQuote -> quoteWorkItemIdFor needs work_item.kind = 'quote'). Use a quote-request email or set NAVA_AE4_ALLOW_NO_EVENT=1`,
        );
      }

      const pane = page.locator('[data-preview-pane]');
      // 3. Type: Quote.
      const type = pane.locator('select[aria-label="Nava reads this as"]');
      await type.waitFor({ state: 'visible', timeout: STEP_MS }).catch(() => {
        throw new Blocker('treat-as select ("Nava reads this as") is missing');
      });
      if ((await type.inputValue()) !== 'quote') {
        await type.selectOption('quote');
        log('type set to Quote');
      }
      await waitFor('the quote workspace', SETTLE_MS, async () => {
        const read = await readPane(page, threadId);
        if (!read || read.analysing) return null;
        const rooms = await pane.locator('select[aria-label="Room type"]').count();
        const add = await pane.getByRole('button', { name: 'Add stay', exact: true }).count();
        return rooms > 0 || add > 0 ? true : null;
      });

      // 4. One stay: dates, one room, two adults, a room type, a meal plan.
      if ((await pane.locator('select[aria-label="Room type"]').count()) === 0) {
        await pane.getByRole('button', { name: 'Add stay', exact: true }).click();
      }
      const roomSelects = pane.locator('select[aria-label="Room type"]');
      await roomSelects.first().waitFor({ state: 'visible', timeout: STEP_MS });
      if ((await roomSelects.count()) !== 1) {
        throw new Blocker(`the quote has ${await roomSelects.count()} rows; AE4 needs one stay with one room`);
      }
      const arrivalInput = pane.locator('input[aria-label="Arrival"]');
      if (!(await arrivalInput.isVisible())) await pane.getByRole('button', { name: /Change dates/ }).click();
      await arrivalInput.fill(inputs.arrival);
      await pane.locator('input[aria-label="Departure"]').fill(inputs.departure);
      await roomSelects.first().selectOption(inputs.room);
      await pane.locator('input[aria-label="Rooms"]').fill('1', { force: true });
      await pane.locator('input[aria-label="Adults"]').fill('2', { force: true });
      await pane.locator('select[aria-label="Meal plan"]').selectOption(inputs.board);
      log('stay typed');

      // 5. The override on the row. Saving it re-runs the stay: the one HMS read.
      const priceBox = pane.locator('section[aria-label$=" price"]').first();
      await priceBox.waitFor({ state: 'visible', timeout: STEP_MS });
      const toggle = priceBox.getByRole('button', { name: 'Change price' });
      if (await toggle.count()) await toggle.click();
      const overrideButton = priceBox.getByRole('button', { name: 'Discount / override' });
      await waitFor('Discount / override to be enabled', STEP_MS, async () =>
        (await overrideButton.isEnabled()) ? true : null,
      ).catch(async () => {
        throw new Blocker(`Discount / override is disabled: ${await visibleText(page, '[data-preview-pane] section[aria-label$=" price"]')}`);
      });
      await overrideButton.click();
      const form = priceBox.locator('form[aria-label^="Discount or override"]');
      await form.waitFor({ state: 'visible', timeout: STEP_MS });
      await form.locator('select').first().selectOption(inputs.rateCode);
      await form.getByLabel(/Override rate per night/).fill(inputs.rate);
      await form.getByLabel(/Approved by \/ why/).fill(inputs.note);
      const save = form.getByRole('button', { name: 'Save override' });
      if (!(await save.isEnabled())) {
        throw new Blocker(`Save override is disabled: ${await visibleText(page, '[data-preview-pane] form[aria-label^="Discount or override"]')}`);
      }
      const runsBefore = captured.outcomes.length;
      await save.click();
      log('override saved');

      // A saved price starts the stay's run by itself. If it did not, "Get rates from HMS" runs it with the same price.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      if (state.hmsReads === 0) {
        const getRates = pane.getByRole('button', { name: 'Get rates from HMS' });
        if ((await getRates.count()) && (await getRates.isEnabled())) {
          await getRates.click();
          log('rates started from Get rates from HMS');
        }
      }
      if (state.hmsReads === 0) {
        throw new Blocker(`the rates run did not start: ${await visibleText(page, '[data-preview-pane] section[aria-label$=" price"]')}`);
      }
      const ratesOutcome = await waitFor('the HMS rates run', config.timeoutMs, async () =>
        latestOutcome(captured, HMS_RATES_PROCEDURE, runsBefore),
      );
      if (ratesOutcome.error) throw new Blocker(`rates run failed: ${redactText(ratesOutcome.error.message).slice(0, 240)}`);
      const rates = ratesRunOf(ratesOutcome.data);
      summary.workflowRunId = rates.workflowRunId;
      const row = rates.rows.find((item) => item.source === 'override') ?? rates.rows[0];
      summary.aiRateMinor = row ? [...new Set(row.hmsNightlyMinor)] : [];
      log('rates run returned');

      // 6. The review: the override line, the note and the HMS comment with its copy button.
      const reviewText = await waitFor('the HMS comment line', STEP_MS, async () => {
        const text = await priceBox.innerText();
        return /HMS comment:/.test(text) ? text.replace(/\s+/g, ' ') : null;
      }).catch(async () => (await priceBox.innerText().catch(() => '')).replace(/\s+/g, ' '));
      summary.reviewShowsOverride =
        reviewText.includes(`${inputs.rateCode} override`) &&
        textHasAmount(reviewText, inputs.rateMinor) &&
        reviewText.includes('Approved by / why:') &&
        textHasNote(reviewText, inputs.note);
      summary.copyForHmsLine = /HMS comment: (.+?)(?: Copy for HMS comments|$)/.exec(reviewText)?.[1]?.trim() ?? null;
      summary.copyButtonShown = (await priceBox.getByRole('button', { name: 'Copy for HMS comments' }).count()) > 0;
      const shots = await capturePane(page, config.outDir);
      log(`screenshots: pane=${shots.pane} review=${shots.review}`);

      // 7. The client documents.
      const preparePdf = pane.getByRole('button', { name: /^Prepare (PDF|quote)$/ });
      await preparePdf.first().waitFor({ state: 'visible', timeout: STEP_MS });
      // The run selects its own result (session.ts staff quote), so the button enables without a pick.
      await waitFor('Prepare PDF to be enabled', STEP_MS, async () =>
        (await preparePdf.first().isEnabled()) ? true : null,
      ).catch(async () => {
        const reason = await preparePdf
          .first()
          .locator('xpath=following-sibling::p[1]')
          .innerText({ timeout: 2_000 })
          .catch(() => '');
        throw new Blocker(`Prepare PDF is disabled: ${redactText(reason.trim()).slice(0, 240)}`);
      });
      const docsBefore = captured.outcomes.length;
      await preparePdf.first().click();
      const pdfOutcome = await waitFor('the PDF', DOC_MS, async () =>
        latestOutcome(captured, 'workstation.qualifiedQuoteProposalPdf', docsBefore),
      );
      if (pdfOutcome.error) throw new Blocker(`PDF failed: ${redactText(pdfOutcome.error.message).slice(0, 240)}`);
      const pdfBase64 = (pdfOutcome.data as { pdfBase64?: unknown } | undefined)?.pdfBase64;
      if (typeof pdfBase64 !== 'string') throw new Blocker('PDF response carried no file');
      const pdfPath = join(config.outDir, 'quote.pdf');
      writeFileSync(pdfPath, Buffer.from(pdfBase64, 'base64'), { mode: 0o600 });
      log('pdf saved');

      const excel = pane.getByRole('button', { name: 'Download Excel' });
      await waitFor('Download Excel to be enabled', STEP_MS, async () => ((await excel.isEnabled()) ? true : null));
      const xlsxBefore = captured.outcomes.length;
      await excel.click();
      const xlsxOutcome = await waitFor('the Excel', DOC_MS, async () =>
        latestOutcome(captured, 'workstation.quoteWorkbook', xlsxBefore),
      );
      if (xlsxOutcome.error) throw new Blocker(`Excel failed: ${redactText(xlsxOutcome.error.message).slice(0, 240)}`);
      const xlsxBase64 = (xlsxOutcome.data as { xlsxBase64?: unknown } | undefined)?.xlsxBase64;
      if (typeof xlsxBase64 !== 'string') throw new Blocker('Excel response carried no file');
      const xlsxBytes = Buffer.from(xlsxBase64, 'base64');
      writeFileSync(join(config.outDir, 'quote.xlsx'), xlsxBytes, { mode: 0o600 });
      log('excel saved');

      // 8. What the client would read. The text itself is never printed.
      const expectations = { rateMinor: inputs.rateMinor, note: inputs.note, aiRatesMinor: summary.aiRateMinor };
      let pdfText: string;
      try {
        pdfText = execFileSync('/usr/bin/pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        throw new Blocker('pdftotext could not read the PDF (is poppler-utils installed?)');
      }
      const pdf = checkDocumentText(pdfText, expectations);
      summary.pdfHas1850 = pdf.hasRate;
      summary.pdfHasNote = pdf.hasNote;
      summary.pdfHasAiRate = pdf.hasAiRate;
      const xlsx = checkDocumentText(xlsxText(xlsxBytes), expectations);
      summary.xlsxHas1850 = xlsx.hasRate;
      summary.xlsxHasNote = xlsx.hasNote;
      summary.xlsxHasAiRate = xlsx.hasAiRate;

      // A work item made while the pane was open (workItems.open) is the one the event lands on.
      const opened = storedWorkView(latestOutcome(captured, 'workItems.open')?.data);
      if (opened?.workItemId) summary.workItemId = opened.workItemId;
    } catch (error) {
      if (!(error instanceof Blocker)) throw error;
      summary.blocker = error.message;
      await capturePane(page, config.outDir).catch(() => undefined);
    }
    await context.close();
  } finally {
    await browser.close();
  }
  summary.hmsReads = state.hmsReads;
  summary.blocked = [...new Set(captured.blocked)].slice(0, 30);
  const failures = ae4Failures(summary, inputs.allowNoEvent);
  return { ...summary, ok: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const config = parseAe4Config(process.argv.slice(2), process.env, process.cwd());
  const summary = await runAe4(config, (line) => console.log(line));
  writeFileSync(join(config.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(`out: ${config.outDir}`);
  console.log(JSON.stringify(summary));
  // 0 pass, 1 AE4 failed, 2 blocked before the proof could finish.
  process.exitCode = summary.ok ? 0 : summary.blocker ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Error text can echo page content, so print the message only and never the stack.
    console.error(`nava-ae4-override-proof: ${error instanceof Error ? redactText(error.message) : 'failed'}`);
    process.exitCode = 2;
  });
}
