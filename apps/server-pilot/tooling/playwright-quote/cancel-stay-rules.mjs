// Pure rules for cancel-stay.mjs: argument parsing, the lab identity guard,
// reason and status matching, penalty text, outcome and exit mapping. No
// Playwright import, so these run under node --test without a browser.
import { classifyAmendPayment } from './amend-stay-rules.mjs';

export const DEFAULT_REASON = 'Test Reservations';
export const LAB_ARRIVAL_FLOOR = '2027-01-01';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HMS_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// --last-name is optional. With it, a quick search that does not show the confirmation retries by surname.
// --expect-stay names a JSON file with the stay the approval was checked against. Commit only (pane write runner, U26).
const VALUE_FLAGS = new Set(['--confirmation', '--arrival', '--mode', '--out', '--reason', '--last-name', '--expect-stay']);
// Lifts the Labtest guard for one run. Only the server passes it, and only when that cancel
// workflow's resolved mode is on. PANE_WRITE_* and RESERVATIONIST_PANE_SAVE never lift it.
export const ALLOW_REAL_GUEST_FLAG = '--allow-real-guest';
const REQUIRED_FLAGS = ['--confirmation', '--arrival', '--mode', '--out'];
const MODES = new Set(['preview', 'commit']);
const OK_OUTCOMES = new Set(['preview_ok', 'cancelled', 'already_cancelled']);
// cancel_penalty_pending is neither OK nor refused: exit 1, and the pane reports it as needs check.
const REFUSED_OUTCOMES = new Set([
  'refused_not_lab',
  'refused_identity_mismatch',
  'refused_reason_missing',
  'refused_penalty',
  'refused_stay_changed',
  'refused_not_unpaid',
]);
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
// Non-empty squashed lines of the raw cell texts, in order. A cell whose text spans lines yields one entry per line.
function cellLines(cellTexts) {
  const cells = [];
  for (const raw of cellTexts ?? []) {
    for (const line of String(raw ?? '').split('\n')) {
      const cell = squash(line);
      if (cell) cells.push(cell);
    }
  }
  return cells;
}

export function parseQuickSearchRow(cellTexts, confirmation) {
  const cells = cellLines(cellTexts);
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

// Balance text from the record: "0.00", "0.00 ZAR", "R2,060.00", "-12.50". Returns the number text or null.
export function parseBalanceValue(text) {
  const cleaned = squash(text)
    .replace(/^[A-Za-z]{1,3}\s?/, '')
    .replace(/\s*[A-Za-z]{3}$/, '')
    .replace(/,/g, '');
  return /^-?\d+(\.\d{1,2})?$/.test(cleaned) ? cleaned : null;
}

// Which record to act on. An open form for this confirmation is authoritative: its status and balance are the
// record's own. Otherwise the dropdown row is used, and it is guarded before any record is opened.
export function chooseStaySource({ confirmation, open, row, allowOpen = true }) {
  if (allowOpen && open && squash(open.confirmation) === squash(confirmation)) return 'open_record';
  if (row) return 'row';
  return null;
}

export function parseCancelArgs(argv) {
  const values = new Map();
  let allowRealGuest = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === ALLOW_REAL_GUEST_FLAG) {
      if (allowRealGuest) return refuse(`Repeated argument: ${flag}`);
      allowRealGuest = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return refuse(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || VALUE_FLAGS.has(value) || value === ALLOW_REAL_GUEST_FLAG) {
      return refuse(`Missing value for ${flag}`);
    }
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
  const lastName = optionalSurname(values);
  if (lastName === false) return refuse('--last-name must be a surname: letters, apostrophe, dot, hyphen or space');
  const expectStay = values.get('--expect-stay');
  if (expectStay !== undefined && mode !== 'commit') return refuse('--expect-stay is for commit only');
  return {
    ok: true,
    exitCode: 0,
    args: {
      confirmation,
      arrival,
      mode,
      reason,
      out: values.get('--out'),
      lastName,
      allowRealGuest,
      ...(expectStay !== undefined ? { expectStay } : {}),
    },
  };
}

// The optional --last-name: its squashed surname, null when absent, or false when present but not a surname.
function optionalSurname(values) {
  if (!values.has('--last-name')) return null;
  const lastName = squash(values.get('--last-name'));
  return GUEST_SURNAME.test(lastName) ? lastName : false;
}

// Refuses before any browser work when the requested arrival is not a 2027+ lab stay. An on-mode run (allowRealGuest)
// has no lab guard, so this floor does not apply to it.
export function preflight(args) {
  if (!args.allowRealGuest && args.arrival < LAB_ARRIVAL_FLOOR) {
    return { ok: false, outcome: 'refused_not_lab', reason: 'arrival_before_2027' };
  }
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

/** Commit only: a fresh folio/stay snapshot must classify unpaid or the run stops before Save. Preview never refuses. */
export function unpaidCommitRefusal(mode, stay) {
  if (mode !== 'commit') return null;
  return classifyAmendPayment(stay) === 'unpaid' ? null : 'refused_not_unpaid';
}

// Full identity check on the opened record. Without --allow-real-guest the lab guard runs first, so a real guest is
// refused as not_lab. With it (on mode) the lab guard is skipped, and the arrival must still be readable. The
// confirmation always applies. The arrival must match for a write (commit). With arrivalHint the requested arrival is
// only a hint, so a different arrival does not refuse: arrivalReport says whether it differs.
export function identityCheck(args, record, { arrivalHint = false } = {}) {
  const arrivalIso = hmsDateToIso(record.arrival);
  if (!args.allowRealGuest) {
    const lab = labGuard(record);
    if (!lab.ok) return { ok: false, outcome: 'refused_not_lab', reason: lab.reason };
  } else if (!arrivalIso) {
    return { ok: false, outcome: 'refused_identity_mismatch', reason: 'arrival_unparsed' };
  }
  if (squash(record.confirmation) !== args.confirmation) return { ok: false, outcome: 'refused_identity_mismatch', reason: 'confirmation' };
  if (!arrivalHint && arrivalIso !== args.arrival) return { ok: false, outcome: 'refused_identity_mismatch', reason: 'arrival' };
  return { ok: true, outcome: null, reason: null };
}

// The note HMS takes with the cancel. A lab run keeps the lab-proof text; an on-mode run records the staff's reason.
export const LAB_CANCEL_NOTE = 'Lab proof cancel';
export function cancelNoteFor(args) {
  return args.allowRealGuest ? args.reason : LAB_CANCEL_NOTE;
}

// A cancellation penalty dialog refuses the run before the reason OK. Nothing is clicked on it (never Waive, never OK).
// Returns the outcome to report, or null when no penalty is open.
export function penaltyRefusal(penalty) {
  return penalty ? 'refused_penalty' : null;
}

// The Waive control on the charge window. "penalty" in the sentence is not a waive.
export function penaltyHasWaive(texts) {
  return (texts ?? []).some((text) => /\bwaive\b/i.test(squash(text)));
}

// Profile cancellation.noticeHours, or null when absent/invalid. Unknown or empty profile fails closed (no warning).
export function noticeHoursFromProfile(profile) {
  const hours = profile?.cancellation?.noticeHours;
  return Number.isInteger(hours) && hours > 0 ? hours : null;
}

// Warning-only: arrival is inside the profile notice window. Missing hours, unknown profile, or unreadable arrival
// stay silent. Does not refuse the run.
export function noticeWindowWarning({ arrival, profile, now = Date.now() }) {
  const hours = noticeHoursFromProfile(profile);
  if (hours == null) return null;
  const arrivalIso = parseIsoDate(arrival) ?? hmsDateToIso(arrival);
  if (!arrivalIso) return null;
  const arrivalMs = Date.parse(`${arrivalIso}T00:00:00Z`);
  if (!Number.isFinite(arrivalMs)) return null;
  const hoursUntil = (arrivalMs - now) / 3_600_000;
  if (hoursUntil > hours) return null;
  return `Arrival is inside the ${hours}-hour cancellation notice window.`;
}

export function isStaleScreenError(error) {
  const name = String(error?.name ?? '');
  const text = squash(error?.message || error);
  return name === 'TimeoutError' || /timeout \d+ms/i.test(text) || /timeout .*exceeded/i.test(text);
}

// One return to Guest Stay, then one more attempt. A second timeout is STALE_SCREEN, not another wait.
export async function withStaleRecovery(io, result) {
  try {
    return await io.attempt();
  } catch (error) {
    if (!isStaleScreenError(error)) throw error;
    result.recovered = true;
    try {
      await io.recover();
    } catch (error) {
      if (!isStaleScreenError(error)) throw error;
      result.outcome = 'execution_failure';
      result.refusal = 'stale_screen';
      result.error = 'STALE_SCREEN';
      return null;
    }
    try {
      return await io.attempt();
    } catch (error) {
      if (!isStaleScreenError(error)) throw error;
      result.outcome = 'execution_failure';
      result.refusal = 'stale_screen';
      result.error = 'STALE_SCREEN';
      return null;
    }
  }
}

// Any cancellation-penalty dialog refuses the run. Never click Waive or OK. Escape / window close only.
async function applyPenaltyPolicy({ result, io, penalty, afterOk = false }) {
  if (!penalty) return 'continue';
  recordPenalty(result, penalty);
  await io.shot('penalty.png');
  if (typeof io.close === 'function') {
    try {
      await io.close();
    } catch {
      // Dialog may stay open; still refuse. Never click Waive or OK.
    }
  }
  if (afterOk) {
    result.penaltyPending = true;
    return 'stop';
  }
  result.refusal = 'penalty_dialog_open';
  result.outcome = 'refused_penalty';
  return 'stop';
}

// Writes the charge text and amount onto the run result.
export function recordPenalty(result, penalty) {
  result.penaltyText = penalty.text;
  result.penaltyAmount = penalty.amount;
}

// The cancel dialog, from the first look to the readback. Every page action goes through io, so these decisions run the
// same way on the real page (cancel-stay.mjs dialogIo) and on a scripted dialog in the tests. Any penalty dialog is
// recorded, dismissed via Escape/close if possible, and refused — never Waive, never OK on the charge.
// Exactly one reason OK is clicked, and only after a last look finds no unhandled charge. io: windowTexts, shot, mark,
// fillNote, readReasons, pickReason, readRecord, close, clickOk, clickPenalty, waitAfterOk, settle, readBalance.
export async function runCancelDialog({ args, record, result, io, profile, now }) {
  const warning = noticeWindowWarning({
    arrival: record?.arrival ?? args.arrival,
    profile,
    now: now ?? Date.now(),
  });
  if (warning) result.warning = warning;
  const windowsBefore = await io.windowTexts();
  const before = await applyPenaltyPolicy({
    result,
    io,
    penalty: parsePenalty(windowsBefore),
  });
  if (before === 'stop') return result;
  if (args.mode === 'commit') await io.fillNote(cancelNoteFor(args));
  const list = await io.readReasons();
  result.reasons = list.reasons;
  io.mark('reasons');

  if (args.mode === 'preview') {
    if (list.reasons.length === 0) throw new Error('REASON_LIST_EMPTY');
    await io.close();
    const after = await io.readRecord();
    result.statusAfter = after.confirmation === args.confirmation ? squash(after.status) : null;
    result.outcome = resolveOutcome({ mode: 'preview', statusBefore: record.status, statusAfter: result.statusAfter });
    return result;
  }

  const index = findReasonIndex(list.texts, args.reason);
  if (index === -1) {
    result.refusal = 'reason_not_in_list';
    await io.close();
    result.outcome = 'refused_reason_missing';
    return result;
  }
  const again = await io.readRecord();
  if (!identityCheck(args, again).ok) throw new Error('IDENTITY_CHANGED_BEFORE_OK');
  await io.pickReason(list, index);
  // Last look before the one OK: any leftover charge refuses with no OK click.
  const windowsNow = await io.windowTexts();
  const lastLook = await applyPenaltyPolicy({
    result,
    io,
    penalty: parsePenalty(windowsNow),
  });
  if (lastLook === 'stop') return result;
  let clicked;
  try {
    clicked = await io.clickOk();
  } catch (error) {
    // The click runs inside the page. A reply lost after it (browser or connection drop) may follow a sent cancel, so
    // the run counts as clicked: it ends unconfirmed and is read back before any new approval.
    result.clickedOk = true;
    throw error;
  }
  if (!clicked) throw new Error('REASON_OK_NOT_UNIQUE');
  result.clickedOk = true;
  io.mark('committed');
  await io.waitAfterOk();
  // HMS shows its "Processing request." mask while the cancel applies, and the open form keeps its old status until the
  // mask clears (live 0144). Wait for the mask, then poll the status until it reads Cancelled. After 60 s it is unconfirmed.
  const settled = await io.settle();
  const windows = await io.windowTexts();
  result.followUps = windows.filter((text) => text && !/Cancellation Reason/.test(text)).map((text) => text.slice(0, 240));
  result.reasonStillOpen = windows.some((text) => /Cancellation Reason/.test(text));
  await applyPenaltyPolicy({
    result,
    io,
    penalty: parsePenalty(windows),
    afterOk: true,
  });
  if (typeof io.readBalance === 'function') result.balance = await io.readBalance();
  result.statusAfter = settled.statusAfter;
  result.settle = settled;
  result.readbackMethod = 'settle';
  await io.shot('readback.png');
  io.mark('readback');
  // A charge left unclicked after the OK is pending. Never Waive/OK the charge.
  result.outcome = result.penaltyPending
    ? 'cancel_penalty_pending'
    : resolveOutcome({ mode: 'commit', statusBefore: record.status, statusAfter: result.statusAfter });
  return result;
}

// The arrival the operator asked about (requestedArrival, possibly a date the guest proposed) against the arrival HMS
// holds for the booking (hmsArrival, ISO). arrivalMismatch is true only when both are known and differ.
export function arrivalReport(args, hmsArrival) {
  const requestedArrival = args.arrival ?? null;
  const hms = hmsArrival ?? null;
  return {
    arrivalMismatch: Boolean(requestedArrival && hms && hms !== requestedArrival),
    requestedArrival,
    hmsArrival: hms,
  };
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
// An error after the reason OK click leaves the cancel uncertain: HMS may have applied it before a read or screenshot
// failed. Only a read that shows Cancelled settles it. Before the click nothing was applied, so it stays a failure.
export function outcomeAfterFailure({ clickedOk, statusAfter }) {
  if (!clickedOk) return 'execution_failure';
  return isCancelledStatus(statusAfter) ? 'cancelled' : 'cancel_unconfirmed';
}

export function resolveOutcome({ mode, statusBefore, statusAfter }) {
  if (isCancelledStatus(statusBefore)) return 'already_cancelled';
  if (mode === 'preview') {
    const before = squash(statusBefore);
    return before && before === squash(statusAfter) ? 'preview_ok' : 'execution_failure';
  }
  return isCancelledStatus(statusAfter) ? 'cancelled' : 'cancel_unconfirmed';
}

// After a commit's reason OK HMS shows a "Processing request." mask and keeps the open form's old status until it clears
// (live 0144: a readback 3.5 s after OK still read Reserved, and the booking was cancelled). settleCancel waits for the
// mask, then polls the status until it reads Cancelled. Each wait gives up after the budget (60 s), polling every
// interval (3 s).
export const SETTLE_BUDGET_MS = 60_000;
export const SETTLE_INTERVAL_MS = 3_000;

// Calls read() now, then every intervalMs, until until(value) holds. It gives up once budgetMs has passed since the first
// call, after a last read at the budget. now() and sleep(ms) are injected so the schedule can run on a fake clock.
export async function pollUntil({ read, until, budgetMs, intervalMs, now = Date.now, sleep }) {
  const start = now();
  let polls = 0;
  for (;;) {
    polls += 1;
    const value = await read();
    const elapsedMs = now() - start;
    if (until(value)) return { value, timedOut: false, polls, elapsedMs };
    if (elapsedMs >= budgetMs) return { value, timedOut: true, polls, elapsedMs };
    await sleep(Math.min(intervalMs, budgetMs - elapsedMs));
  }
}

// io: { maskVisible(), readStatus() }. The status is the last one read, so an unconfirmed commit still reports what
// HMS showed last. A mask that never clears does not stop the status poll: HMS may have cancelled regardless.
export async function settleCancel(io, {
  budgetMs = SETTLE_BUDGET_MS,
  intervalMs = SETTLE_INTERVAL_MS,
  now = Date.now,
  sleep,
}) {
  const mask = await pollUntil({
    read: io.maskVisible,
    until: (visible) => !visible,
    budgetMs,
    intervalMs,
    now,
    sleep,
  });
  const status = await pollUntil({
    read: io.readStatus,
    until: (value) => isCancelledStatus(value),
    budgetMs,
    intervalMs,
    now,
    sleep,
  });
  return {
    statusAfter: status.value,
    cancelled: !status.timedOut,
    maskCleared: !mask.timedOut,
    maskMs: mask.elapsedMs,
    statusPolls: status.polls,
    statusMs: status.elapsedMs,
  };
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

// ---- Read-only lookups (stay-lookup.mjs): find by confirmation, search-guest by surname. ----

const LOOKUP_MODES = new Set(['find', 'search-guest']);
const LOOKUP_VALUE_FLAGS = new Set(['--mode', '--confirmation', '--arrival', '--departure', '--last-name', '--out']);
// Switches with no value. --debug-html writes the form or panel HTML into the run directory.
const LOOKUP_SWITCHES = new Set(['--debug-html']);
// Flags each mode accepts besides --mode, --out and the switches.
const LOOKUP_MODE_FLAGS = {
  find: new Set(['--confirmation', '--arrival', '--last-name']),
  'search-guest': new Set(['--last-name', '--arrival', '--departure']),
};
const LOOKUP_OK_OUTCOMES = new Set(['found', 'not_found', 'ok']);
// Surname typed into the header search: starts with a letter; letters, apostrophe, dot, hyphen and space after.
const GUEST_SURNAME = /^\p{L}[\p{L}'’. -]{0,59}$/u;

export function parseLookupArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (LOOKUP_SWITCHES.has(flag)) {
      if (values.has(flag)) return refuse(`Repeated argument: ${flag}`);
      values.set(flag, true);
      continue;
    }
    if (!LOOKUP_VALUE_FLAGS.has(flag)) return refuse(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || LOOKUP_VALUE_FLAGS.has(value) || LOOKUP_SWITCHES.has(value)) {
      return refuse(`Missing value for ${flag}`);
    }
    if (values.has(flag)) return refuse(`Repeated argument: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const mode = values.get('--mode');
  if (!LOOKUP_MODES.has(mode)) return refuse('--mode must be find or search-guest');
  if (!values.has('--out')) return refuse('Required: --out');
  const accepted = LOOKUP_MODE_FLAGS[mode];
  const stray = [...values.keys()].find((flag) => !['--mode', '--out', ...LOOKUP_SWITCHES].includes(flag)
    && !accepted.has(flag));
  if (stray) return refuse(`${stray} is not valid with --mode ${mode}`);
  const out = values.get('--out');
  const debugHtml = values.get('--debug-html') === true;
  let arrival = null;
  if (values.has('--arrival')) {
    arrival = parseIsoDate(values.get('--arrival'));
    if (!arrival) return refuse('--arrival must be a real calendar date, YYYY-MM-DD');
  }
  if (mode === 'find') {
    if (!values.has('--confirmation')) return refuse('Required: --confirmation');
    const confirmation = values.get('--confirmation').trim();
    if (!/^\d+-\d+$/.test(confirmation)) return refuse('--confirmation must look like 57291630-1');
    const lastName = optionalSurname(values);
    if (lastName === false) return refuse('--last-name must be a surname: letters, apostrophe, dot, hyphen or space');
    return {
      ok: true,
      exitCode: 0,
      args: { mode, confirmation, arrival, lastName, departure: null, out, debugHtml },
    };
  }
  if (!values.has('--last-name')) return refuse('Required: --last-name');
  if (!values.has('--arrival')) return refuse('Required: --arrival');
  const lastName = squash(values.get('--last-name'));
  if (!GUEST_SURNAME.test(lastName)) return refuse('--last-name must be a surname: letters, apostrophe, dot, hyphen or space');
  let departure = null;
  if (values.has('--departure')) {
    departure = parseIsoDate(values.get('--departure'));
    if (!departure) return refuse('--departure must be a real calendar date, YYYY-MM-DD');
    if (departure <= arrival) return refuse('--departure must be after --arrival');
  }
  return {
    ok: true,
    exitCode: 0,
    args: { mode, confirmation: null, arrival, lastName, departure, out, debugHtml },
  };
}

export function lookupExitCode(outcome) {
  return LOOKUP_OK_OUTCOMES.has(outcome) ? 0 : 1;
}

// Record form labels as shown on screen, mapped to the stay fields the lookup reports. Anything else is ignored.
const FORM_FIELD_BY_LABEL = new Map([
  ['status', 'status'],
  ['confirmation number', 'confirmation'],
  ['last name', 'lastName'],
  ['first name', 'firstName'],
  ['arrival date', 'arrival'],
  ['departure date', 'departure'],
  ['nights', 'nights'],
  ['adults', 'adults'],
  ['children', 'children'],
  ['room type', 'roomType'],
  ['rate plan', 'ratePlan'],
  ['meal plan', 'mealPlan'],
  ['average rate', 'averageRate'],
  ['grand total', 'grandTotal'],
  ['balance', 'balance'],
  ['source of business', 'sourceOfBusiness'],
  ['guarantee type', 'guaranteeType'],
  ['primary booking agency', 'bookingAgency'],
  ['organization', 'organization'],
  ['reservation note / billing instructions', 'reservationNote'],
]);
export const STAY_FIELDS = [...FORM_FIELD_BY_LABEL.values()];
const STAY_COUNT_FIELDS = new Set(['nights', 'adults', 'children']);
const STAY_MONEY_FIELDS = new Set(['averageRate', 'grandTotal', 'balance']);
const STAY_DATE_FIELDS = new Set(['arrival', 'departure']);

// "Confirmation Number:" (with its required-field dot) reads as "confirmation number". Unmapped labels return null.
export function formLabelKey(label) {
  const text = squash(label).toLowerCase().replace(/^[^a-z]+/, '').replace(/[^a-z]+$/, '');
  return FORM_FIELD_BY_LABEL.get(text) ?? null;
}

function coerceStayField(field, text) {
  if (STAY_COUNT_FIELDS.has(field)) return /^\d+$/.test(text) ? Number(text) : null;
  if (STAY_MONEY_FIELDS.has(field)) return parseBalanceValue(text);
  if (STAY_DATE_FIELDS.has(field)) return hmsDateToIso(text);
  return text;
}

// The fields of the approved stay that the record opened for the write no longer shows the same way. Only the expected
// stay's own fields are compared: they are what the approval's HMS digest covered. Blank text and null are the same.
export function stayChanges(expected, actual) {
  const norm = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = squash(value);
    return text === '' ? null : text;
  };
  return Object.keys(expected ?? {}).filter((field) => norm(expected[field]) !== norm(actual?.[field]));
}

// pairs: [{label, value}] read from the open record. A field is null when no visible input carries it, or when
// two different non-empty values appear for it (listed in conflicts). Counts are numbers, money is decimal text,
// dates are ISO.
export function stayFromFormPairs(pairs) {
  const texts = new Map(STAY_FIELDS.map((field) => [field, new Set()]));
  for (const pair of pairs ?? []) {
    const field = formLabelKey(pair?.label);
    if (!field) continue;
    const text = squash(pair.value);
    if (text) texts.get(field).add(text);
  }
  const stay = {};
  const conflicts = [];
  for (const field of STAY_FIELDS) {
    const values = [...texts.get(field)];
    if (values.length > 1) {
      conflicts.push(field);
      stay[field] = null;
    } else {
      stay[field] = values.length === 1 ? coerceStayField(field, values[0]) : null;
    }
  }
  return { stay, conflicts };
}

// The record or row must show the requested confirmation, and the requested arrival when one was given.
// A missing confirmation means the form was not read, so the run is a failure rather than a mismatch.
// The record or row must show the requested confirmation, and only that: the arrival is a hint, so a different arrival is
// reported by arrivalReport rather than refused.
export function stayIdentityVerdict(args, stay) {
  if (!stay || !stay.confirmation) return { outcome: 'execution_failure', reason: 'form_unreadable' };
  if (squash(stay.confirmation) !== args.confirmation) return { outcome: 'ambiguous', reason: 'confirmation_mismatch' };
  return { outcome: 'found', reason: null };
}

// "Records: 1 of 1" in the quick panel footer: rows shown and rows matched. Null when absent or impossible.
export function parseRecordsFooter(text) {
  const match = /Records:\s*(\d+)\s+of\s+(\d+)/i.exec(squash(text));
  if (!match) return null;
  const shown = Number(match[1]);
  const total = Number(match[2]);
  return shown <= total ? { shown, total } : null;
}

// One dropdown row from its cell texts (a text may span lines). Null unless exactly one line is a confirmation and
// parseQuickSearchRow reads the rest of the row.
function parseDropdownRow(cellTexts) {
  const confirmations = cellLines(cellTexts).filter((cell) => CONFIRMATION_TOKEN.test(cell));
  return confirmations.length === 1 ? parseQuickSearchRow(cellTexts, confirmations[0]) : null;
}

function toPanelRow(row) {
  return {
    confirmation: row.confirmation,
    lastName: row.lastName,
    firstName: row.firstName,
    status: row.status,
    arrival: hmsDateToIso(row.arrival),
    departure: row.departure ? hmsDateToIso(row.departure) : null,
  };
}

// Each raw row is the cell texts of one dropdown row. A row that does not parse counts as unreadable; the caller
// fails closed on any unreadable row.
export function parsePanelRows(rawRows) {
  const rows = [];
  let unreadable = 0;
  for (const cells of rawRows ?? []) {
    const row = parseDropdownRow(cells);
    if (row) rows.push(toPanelRow(row));
    else unreadable += 1;
  }
  return { rows, unreadable };
}

// Snapshot from snapshotPanel (stay-lookup-dom.mjs). A candidate is a data row when one of its cell or line texts is a
// confirmation. Its cells are read first; when they do not parse, its lines are read. A row that parses neither way is
// unreadable and its texts come back for the dump. Each unresolved confirmation leaf is unreadable too.
export function parsePanelSnapshot(snapshot) {
  const rows = [];
  const unreadableRows = [];
  let unreadable = snapshot?.unresolved ?? 0;
  for (const candidate of snapshot?.rows ?? []) {
    const texts = [...cellLines(candidate.cells), ...cellLines(candidate.lines)];
    if (!texts.some((text) => CONFIRMATION_TOKEN.test(text))) continue;
    const row = parseDropdownRow(candidate.cells) ?? parseDropdownRow(candidate.lines);
    if (row) {
      rows.push(toPanelRow(row));
    } else {
      unreadable += 1;
      unreadableRows.push(candidate);
    }
  }
  return { rows, unreadable, unreadableRows };
}

// Every panel row must be read, and the footer must account for all of them. Capped panels are not complete.
export function searchGuestOutcome({ records, rows, unreadable }) {
  if (!records) return { outcome: 'execution_failure', reason: 'records_footer_missing' };
  if (records.shown < records.total) return { outcome: 'ambiguous_capped', reason: 'records_capped' };
  if (unreadable > 0) return { outcome: 'execution_failure', reason: 'rows_unreadable' };
  if (rows.length !== records.shown) return { outcome: 'execution_failure', reason: 'row_count_mismatch' };
  return { outcome: 'ok', reason: null };
}

// Rows for the same guest on the same dates: surname (case-insensitive), arrival, and departure when given.
export function sameStayRows(rows, { lastName, arrival, departure = null }) {
  const surname = squash(lastName).toLowerCase();
  return rows.filter((row) => row.lastName.toLowerCase() === surname
    && row.arrival === arrival
    && (departure === null || row.departure === departure));
}

// Entries from snapshotRecordForm to {label, value, name} pairs. An input whose id is some label's for attribute takes
// that label. Any other input takes the nearest earlier known label whose innermost row is one of the input's rows;
// unknown labels never claim an input, and a label is claimed once. A label with no input is simply not paired.
export function formPairsFromSnapshot(entries) {
  const known = (entry) => entry.kind === 'label' && formLabelKey(entry.text) !== null;
  const labelByFor = new Map();
  entries.forEach((entry, index) => {
    if (known(entry) && entry.forId && !labelByFor.has(entry.forId)) labelByFor.set(entry.forId, index);
  });
  const claimed = new Set();
  const labelOf = new Map();
  entries.forEach((entry, index) => {
    if (entry.kind !== 'field' || !entry.id || !labelByFor.has(entry.id)) return;
    const labelIndex = labelByFor.get(entry.id);
    if (claimed.has(labelIndex)) return;
    labelOf.set(index, labelIndex);
    claimed.add(labelIndex);
  });
  entries.forEach((field, index) => {
    if (field.kind !== 'field' || labelOf.has(index)) return;
    for (let labelIndex = index - 1; labelIndex >= 0; labelIndex -= 1) {
      const label = entries[labelIndex];
      if (!known(label) || claimed.has(labelIndex) || label.rows.length === 0) continue;
      if (!field.rows.includes(label.rows[0])) continue;
      labelOf.set(index, labelIndex);
      claimed.add(labelIndex);
      break;
    }
  });
  return [...labelOf].map(([fieldIndex, labelIndex]) => ({
    label: entries[labelIndex].text,
    value: entries[fieldIndex].value,
    name: entries[fieldIndex].name,
  }));
}
