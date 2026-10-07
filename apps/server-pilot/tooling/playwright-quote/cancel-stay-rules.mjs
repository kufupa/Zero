// Pure rules for cancel-stay.mjs: argument parsing, the lab identity guard,
// reason and status matching, penalty text, outcome and exit mapping. No
// Playwright import, so these run under node --test without a browser.

export const DEFAULT_REASON = 'Test Reservations';
export const LAB_ARRIVAL_FLOOR = '2027-01-01';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HMS_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const VALUE_FLAGS = new Set(['--confirmation', '--arrival', '--mode', '--out', '--reason']);
const REQUIRED_FLAGS = ['--confirmation', '--arrival', '--mode', '--out'];
const MODES = new Set(['preview', 'commit']);
const OK_OUTCOMES = new Set(['preview_ok', 'cancelled', 'already_cancelled']);
const REFUSED_OUTCOMES = new Set(['refused_not_lab', 'refused_identity_mismatch', 'refused_reason_missing']);
const CDP_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function refuse(error) {
  return { ok: false, exitCode: 2, error };
}

export function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return match[0];
}

// HMS shows arrival as DD-MON-YYYY (for example 14-SEP-2027). ISO input passes through.
export function hmsDateToIso(value) {
  const text = squash(value);
  if (parseIsoDate(text)) return text;
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (!match) return null;
  const month = HMS_MONTHS.indexOf(match[2].toUpperCase());
  if (month === -1) return null;
  return parseIsoDate(`${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`);
}

const HMS_DATE_TOKEN = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;
const CONFIRMATION_TOKEN = /^\d+-\d+$/;
// "Last, First" with no digits, so the "Sep 14, 2027 - Nov 13, 2027" window line never matches.
const GUEST_TOKEN = /^(\p{L}[\p{L}'’. -]*),\s*(\p{L}[\p{L}'’. -]*)?$/u;
// Status is words only: dates, "Records: 1 of 1" and ids never match.
const STATUS_TOKEN = /^\p{L}[\p{L} -]*$/u;
const WINDOW_LABEL = /^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})\s+-\s+([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})$/;

function monthNumber(word) {
  const index = HMS_MONTHS.indexOf(String(word).slice(0, 3).toUpperCase());
  return index === -1 ? null : index + 1;
}

function isoFromParts(year, month, day) {
  if (!month) return null;
  return parseIsoDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

// Quick-search window line, for example "Sep 14, 2027 - Nov 13, 2027". Returns inclusive ISO bounds or null.
export function parseDateWindowLabel(text) {
  const match = WINDOW_LABEL.exec(squash(text));
  if (!match) return null;
  const from = isoFromParts(match[3], monthNumber(match[1]), match[2]);
  const to = isoFromParts(match[6], monthNumber(match[4]), match[5]);
  if (!from || !to || from > to) return null;
  return { from, to };
}

// True when the arrival day falls inside the window, both ends included.
export function windowCovers(window, arrivalIso) {
  const day = parseIsoDate(arrivalIso);
  return Boolean(window && day && window.from <= day && day <= window.to);
}

// Reads one quick-search row from its cell texts in document order. Returns null unless the row has exactly
// one confirmation (equal to the expected one), exactly one "Last, First" guest, a status word after the guest,
// and HMS dates (arrival first, departure second). Dates stay in HMS form; identityCheck converts them.
export function parseQuickSearchRow(cellTexts, confirmation) {
  const cells = [];
  for (const raw of cellTexts ?? []) {
    for (const line of String(raw ?? '').split('\n')) {
      const cell = squash(line);
      if (cell) cells.push(cell);
    }
  }
  const expected = squash(confirmation);
  const confirmations = cells.filter((cell) => CONFIRMATION_TOKEN.test(cell));
  if (confirmations.length !== 1 || confirmations[0] !== expected) return null;
  const guests = cells.filter((cell) => GUEST_TOKEN.test(cell));
  if (guests.length !== 1) return null;
  const guest = GUEST_TOKEN.exec(guests[0]);
  const dates = cells.filter((cell) => HMS_DATE_TOKEN.test(cell));
  if (!dates[0] || !hmsDateToIso(dates[0])) return null;
  if (dates[1] && !hmsDateToIso(dates[1])) return null;
  const guestIndex = cells.indexOf(guests[0]);
  const status = cells
    .slice(guestIndex + 1)
    .find((cell) => STATUS_TOKEN.test(cell) && !HMS_DATE_TOKEN.test(cell));
  if (!status) return null;
  return {
    confirmation: expected,
    lastName: guest[1].trim(),
    firstName: (guest[2] ?? '').trim(),
    status,
    arrival: dates[0],
    departure: dates[1] ?? null,
  };
}

export function parseCancelArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!VALUE_FLAGS.has(flag)) return refuse(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || VALUE_FLAGS.has(value)) return refuse(`Missing value for ${flag}`);
    if (values.has(flag)) return refuse(`Repeated argument: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const missing = REQUIRED_FLAGS.find((flag) => !values.get(flag));
  if (missing) return refuse(`Required: ${missing}`);
  const confirmation = values.get('--confirmation').trim();
  if (!/^\d+-\d+$/.test(confirmation)) return refuse('--confirmation must look like 57291630-1');
  const arrival = parseIsoDate(values.get('--arrival'));
  if (!arrival) return refuse('--arrival must be a real calendar date, YYYY-MM-DD');
  const mode = values.get('--mode');
  if (!MODES.has(mode)) return refuse('--mode must be preview or commit');
  const reason = squash(values.get('--reason') ?? DEFAULT_REASON);
  if (!reason) return refuse('--reason must not be empty');
  return { ok: true, exitCode: 0, args: { confirmation, arrival, mode, reason, out: values.get('--out') } };
}

// Refuses before any browser work when the requested arrival is not a 2027+ lab stay.
export function preflight(args) {
  if (args.arrival < LAB_ARRIVAL_FLOOR) return { ok: false, outcome: 'refused_not_lab', reason: 'arrival_before_2027' };
  return { ok: true, outcome: null, reason: null };
}

// Lab guard on the open record: last name exactly Labtest (case-insensitive) and arrival on or after 2027-01-01.
export function labGuard({ lastName, arrival }) {
  if (!/^labtest$/i.test(squash(lastName))) return { ok: false, reason: 'last_name_not_labtest', arrivalIso: null };
  const arrivalIso = hmsDateToIso(arrival);
  if (!arrivalIso) return { ok: false, reason: 'arrival_unparsed', arrivalIso: null };
  if (arrivalIso < LAB_ARRIVAL_FLOOR) return { ok: false, reason: 'arrival_before_2027', arrivalIso };
  return { ok: true, reason: null, arrivalIso };
}

// Full identity check on the opened record. The lab guard runs first, so a real guest is always refused as not_lab.
export function identityCheck(args, record) {
  const lab = labGuard(record);
  if (!lab.ok) return { ok: false, outcome: 'refused_not_lab', reason: lab.reason };
  if (squash(record.confirmation) !== args.confirmation) return { ok: false, outcome: 'refused_identity_mismatch', reason: 'confirmation' };
  if (lab.arrivalIso !== args.arrival) return { ok: false, outcome: 'refused_identity_mismatch', reason: 'arrival' };
  return { ok: true, outcome: null, reason: null };
}

export function isCancelledStatus(status) {
  return /^cancel{1,2}ed$/i.test(squash(status));
}

export function normalizeReasons(texts) {
  return [...new Set(texts.map((text) => squash(text)).filter(Boolean))];
}

// Index of the single option matching the wanted reason (case-insensitive). -1 when absent or ambiguous.
export function findReasonIndex(texts, wanted) {
  const target = squash(wanted).toLowerCase();
  if (!target) return -1;
  const hits = texts.flatMap((text, index) => (squash(text).toLowerCase() === target ? [index] : []));
  return hits.length === 1 ? hits[0] : -1;
}

// Returns the first text that mentions a cancellation penalty, with the amount token (for example 2060.00 or R2,060.00).
export function parsePenalty(texts) {
  for (const raw of texts) {
    const text = squash(raw);
    if (!/cancellation penalty/i.test(text)) continue;
    const amount = /penalty of\s+((?:[A-Za-z]{1,3}\s?)?\d[\d.,]*)/i.exec(text)?.[1] ?? null;
    return { text: text.slice(0, 300), amount };
  }
  return null;
}

// Signed month distance from the picker title (for example "September 2026") to the arrival month. Positive = click next.
export function pickerMonthSteps(title, targetIso) {
  const match = /^([A-Za-z]{3,})\s+(\d{4})$/.exec(squash(title));
  const target = parseIsoDate(targetIso);
  if (!match || !target) return null;
  const word = match[1].slice(0, 3).toLowerCase();
  const month = MONTH_NAMES.findIndex((name) => name.slice(0, 3).toLowerCase() === word);
  if (month === -1) return null;
  const [targetYear, targetMonth] = target.split('-').map(Number);
  return (targetYear * 12 + targetMonth - 1) - (Number(match[2]) * 12 + month);
}

// Outcome from the status before the action and the status read back after it.
// Preview must leave the status unchanged. Commit counts as cancelled only when the status reads Cancelled.
export function resolveOutcome({ mode, statusBefore, statusAfter }) {
  if (isCancelledStatus(statusBefore)) return 'already_cancelled';
  if (mode === 'preview') {
    const before = squash(statusBefore);
    return before && before === squash(statusAfter) ? 'preview_ok' : 'execution_failure';
  }
  return isCancelledStatus(statusAfter) ? 'cancelled' : 'cancel_unconfirmed';
}

export function exitCodeFor(outcome) {
  if (OK_OUTCOMES.has(outcome)) return 0;
  if (REFUSED_OUTCOMES.has(outcome)) return 2;
  return 1;
}

// Same local-CDP and borrowed-browser rules as fetch-quote.mjs and create-lab-stay.mjs.
export function checkCdpEnv(env) {
  let url;
  try {
    url = new URL(env.HMS_STAGEHAND_CDP_URL ?? '');
  } catch {
    return { ok: false, error: 'CDP_URL_REQUIRED', href: null };
  }
  if (!['http:', 'ws:'].includes(url.protocol) || !CDP_HOSTS.has(url.hostname) || url.username || url.password || url.search) {
    return { ok: false, error: 'PRIVATE_CDP_REQUIRED', href: null };
  }
  if (env.HMS_STAGEHAND_BROWSER_OWNERSHIP !== 'borrowed') return { ok: false, error: 'BORROWED_REQUIRED', href: null };
  return { ok: true, error: null, href: url.href };
}
