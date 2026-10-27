import { createHash } from 'node:crypto';
import { amendRoomTypes } from './property-profile.mjs';

export const AMEND_FIELDS = ['arrival', 'departure', 'adults', 'children', 'roomType'];
export const LAB_ARRIVAL_FLOOR = '2027-01-01';
const FLAGS = new Set(['--request', '--mode', '--out', '--digest', '--property']);
const SHA256 = /^[a-f0-9]{64}$/;
const CONFIRMATION = /^\d+-\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const refused = (error) => ({ ok: false, exitCode: 2, error });

const PANE_WRITE_ENV_NAMES = [
  'PANE_WRITE_CREATE',
  'PANE_WRITE_AMEND_UNPAID',
  'PANE_WRITE_AMEND_PAID',
  'PANE_WRITE_CANCEL_UNPAID',
  'PANE_WRITE_CANCEL_PAID',
];

function parseLabOn(value) {
  return value === 'lab' || value === 'on' ? value : 'off';
}

function anyPaneWriteEnvSet(env) {
  return PANE_WRITE_ENV_NAMES.some((name) => env[name] !== undefined);
}

/** Commit only when the amend switch for this money state is lab or on. Create mode never opens amend. */
export function amendCommitAllowed(mode, env = process.env, moneyState = 'unpaid') {
  if (mode !== 'commit') return true;
  const paid = moneyState !== 'unpaid';
  if (!anyPaneWriteEnvSet(env)) {
    return env.RESERVATIONIST_PANE_SAVE === 'lab';
  }
  const key = paid ? 'PANE_WRITE_AMEND_PAID' : 'PANE_WRITE_AMEND_UNPAID';
  const resolved = parseLabOn(env[key]);
  if (paid && resolved === 'on') return false;
  return resolved === 'lab' || resolved === 'on';
}

function paymentText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function parseDepositReceived(value) {
  const text = paymentText(value);
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;
  const normalized = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.includes(',') && !cleaned.includes('.')
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function guaranteeKind(guaranteeType) {
  const text = paymentText(guaranteeType).toLowerCase();
  if (!text) return 'missing';
  if (/^non[-\s]?guaranteed/.test(text) || text === 'none') return 'non_paying';
  if (
    /guaranteed/.test(text) ||
    /confirmation received/.test(text) ||
    /awaiting voucher/.test(text) ||
    /deposit requested/.test(text) ||
    /group definite/.test(text) ||
    /credit card/.test(text)
  ) {
    return 'paying';
  }
  return 'unknown';
}

function isProvisionalStatus(status) {
  const text = paymentText(status).toLowerCase();
  return text === 'reserved' || text === 'provisional';
}

/** R7: unpaid = provisional + deposit 0 + non-paying guarantee. Confirmed blank string is 0 then; unread null is unknown. */
export function classifyAmendPayment(stay) {
  if (!stay || typeof stay !== 'object') return 'unknown';
  if (!paymentText(stay.status) || !paymentText(stay.guaranteeType)) return 'unknown';
  const guarantee = guaranteeKind(stay.guaranteeType);
  if (guarantee === 'missing' || guarantee === 'unknown') return 'unknown';
  const depositRaw = stay.depositReceived;
  if (depositRaw == null) return guarantee === 'paying' ? 'guaranteed' : 'unknown';
  const depositText = paymentText(depositRaw);
  const confirmedBlank = typeof depositRaw === 'string' && depositText === '';
  const deposit = depositText ? parseDepositReceived(depositRaw) : null;
  if (depositText && deposit == null) return 'unknown';
  if (deposit != null && deposit > 0) return 'paid';
  if (guarantee === 'paying') return 'guaranteed';
  const depositIsZero = deposit === 0 || confirmedBlank;
  if (isProvisionalStatus(stay.status) && depositIsZero && guarantee === 'non_paying') return 'unpaid';
  return 'unknown';
}

export function parseAmendArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) return refused(`Unknown argument: ${flag}`);
    const value = argv[++i];
    if (value === undefined || FLAGS.has(value)) return refused(`Missing value for ${flag}`);
    if (values.has(flag)) return refused(`Repeated argument: ${flag}`);
    values.set(flag, value);
  }
  for (const flag of ['--request', '--mode', '--out']) if (!values.has(flag)) return refused(`Required: ${flag}`);
  const mode = values.get('--mode');
  const digest = values.get('--digest') ?? null;
  if (!['preview', 'commit'].includes(mode)) return refused('--mode must be preview or commit');
  if (mode === 'commit' ? !SHA256.test(digest ?? '') : digest !== null) {
    return refused(mode === 'commit' ? '--digest must be a preview SHA-256 digest' : '--digest is only accepted with commit mode');
  }
  const property = values.get('--property') ?? 'HRCEN';
  if (!amendRoomTypes(property).length) return refused('PROPERTY_UNKNOWN');
  return {
    ok: true,
    exitCode: 0,
    args: { request: values.get('--request'), mode, out: values.get('--out'), digest, property },
  };
}

function realDate(value) {
  const date = typeof value === 'string' && ISO_DATE.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
  return Boolean(date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value);
}
const count = (value) => Number.isInteger(value) && value >= 0 && value <= 16;

export function validateAmendRequest(value, propertyCode = 'HRCEN') {
  const keys = Object.keys(value ?? {}).filter((key) => key !== 'currentArrival').sort().join(',');
  if (!plainObject(value) || keys !== 'confirmation,expectedLastName,fields') return { ok: false, reason: 'request_fields_invalid' };
  // currentArrival moves the HMS calendar window to the stay; without it find only sees the current window.
  if (value.currentArrival !== undefined && !realDate(value.currentArrival)) return { ok: false, reason: 'current_arrival_invalid' };
  if (typeof value.confirmation !== 'string' || !CONFIRMATION.test(value.confirmation)) return { ok: false, reason: 'confirmation_invalid' };
  if (typeof value.expectedLastName !== 'string' || !/^labtest$/i.test(value.expectedLastName)) return { ok: false, reason: 'expected_last_name_not_labtest' };
  if (!plainObject(value.fields)) return { ok: false, reason: 'fields_invalid' };
  if (!Object.keys(value.fields).length) return { ok: false, reason: 'fields_required' };
  const entries = Object.entries(value.fields);
  if (entries.some(([field]) => !AMEND_FIELDS.includes(field))) return { ok: false, reason: 'unsupported_field' };
  const allowedRooms = amendRoomTypes(propertyCode);
  for (const [field, target] of entries) {
    if ((field === 'arrival' || field === 'departure') && !realDate(target)) return { ok: false, reason: 'date_invalid' };
    if (field === 'arrival' && target < LAB_ARRIVAL_FLOOR) return { ok: false, reason: 'target_arrival_before_2027' };
    if ((field === 'adults' || field === 'children') && (!count(target) || (field === 'adults' && target < 1))) return { ok: false, reason: 'count_invalid' };
    if (field === 'roomType' && (typeof target !== 'string' || !allowedRooms.includes(target))) return { ok: false, reason: 'room_type_invalid' };
  }
  if (value.fields.arrival && value.fields.departure && value.fields.departure <= value.fields.arrival) return { ok: false, reason: 'departure_not_after_arrival' };
  return { ok: true, request: value };
}

export function validateAmendCurrent(request, current) {
  if (!plainObject(current)) return 'current_unreadable';
  if (current.confirmation !== request.confirmation) return 'confirmation_mismatch';
  if (typeof current.lastName !== 'string' || !/^labtest$/i.test(current.lastName)) return 'current_last_name_not_labtest';
  if (!['Reserved', 'Confirmed'].includes(current.status)) return 'status_unsupported';
  if (!realDate(current.arrival)) return 'current_arrival_invalid';
  if (current.arrival < LAB_ARRIVAL_FLOOR) return 'current_arrival_before_2027';
  if (!realDate(current.departure) || current.departure <= current.arrival) return 'departure_not_after_arrival';
  if (!count(current.adults) || !count(current.children)) return 'current_count_invalid';
  if (typeof current.roomType !== 'string' || !current.roomType) return 'current_room_type_unreadable';
  if (classifyAmendPayment(current) !== 'unpaid') return 'payment_unknown';
  const arrival = request.fields.arrival ?? current.arrival;
  const departure = request.fields.departure ?? current.departure;
  if (!realDate(arrival)) return 'date_invalid';
  if (arrival < LAB_ARRIVAL_FLOOR) return 'target_arrival_before_2027';
  if (!realDate(departure) || departure <= arrival) return 'departure_not_after_arrival';
  if (Object.entries(request.fields).every(([field, value]) => String(current[field]) === String(value))) return 'no_changes';
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function amendPreviewDigest({ confirmation, expectedLastName, current, fields }) {
  const state = Object.fromEntries(['confirmation', 'lastName', 'status', 'arrival', 'departure', 'adults', 'children', 'roomType'].map((key) => [key, current[key]]));
  return createHash('sha256').update(JSON.stringify(canonical({ version: 1, action: 'amend', confirmation, expectedLastName, current: state, fields })), 'utf8').digest('hex');
}

export const unsupportedFieldReason = (state) =>
  state?.count === 1 && state.disabled === false && state.readOnly === false ? null : 'unsupported_field';
export const dangerousDialogKind = (text) =>
  /\bpenalt(?:y|ies)\b/i.test(text) ? 'penalty' : /\bcharge(?:s)?\b/i.test(text) ? 'charge' : /\brate\b/i.test(text) ? 'rate' : null;
const HMS_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function calendarIsoFromDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return realDate(`${year}-${month}-${day}`) ? `${year}-${month}-${day}` : null;
}

/** Calendar ISO from an Ext Date, HMS DD-MON-YYYY, or ISO text. Occupancy stays numeric/string. */
export function amendFieldIso(value) {
  const fromDate = calendarIsoFromDate(value);
  if (fromDate) return fromDate;
  const text = String(value ?? '').trim();
  if (realDate(text)) return text;
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (!match) return null;
  const month = HMS_MONTHS.indexOf(match[2].toUpperCase());
  if (month === -1) return null;
  return realDate(`${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`)
    ? `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`
    : null;
}

export function amendFieldMatches(field, expected, actual) {
  if (actual == null || actual === '') return false;
  if (field === 'arrival' || field === 'departure') return amendFieldIso(actual) === expected;
  return String(actual) === String(expected);
}

export function compareChangedFields(fields, readback) {
  const actual = plainObject(readback) ? readback : {};
  const diff = Object.fromEntries(Object.entries(fields).filter(([field, value]) =>
    !Object.hasOwn(actual, field) || !amendFieldMatches(field, value, actual[field])).map(([field, expected]) =>
    [field, { expected, actual: actual[field] ?? null }]));
  return { matches: Object.keys(diff).length === 0, diff };
}

// Fill → blur → readback each field. Returns the first field that did not stick, or null.
export async function commitAndVerifyFields(io, fields) {
  for (const [field, value] of Object.entries(fields ?? {})) {
    await io.fill(field, value);
    await io.blur(field);
    const actual = await io.read(field);
    if (!amendFieldMatches(field, value, actual)) return field;
  }
  return null;
}
