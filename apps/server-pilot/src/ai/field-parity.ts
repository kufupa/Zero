import { createRequestFieldOptions, prefillBoardFromLuna } from './booking-draft.js';
import { bookingCodeDefaults } from './booking-code-rules.js';
import { DIRECT_BOOKING_DEFAULTS, buildCreatePrefill } from './aop/create-prefill.js';
import { dayFromText } from './voucher-find.js';
import { profileFor } from '../../tooling/playwright-quote/property-profile.mjs';

export const FIELD_PARITY_FIELDS = [
  'agency', 'guaranteeType', 'roomType', 'ratePlan', 'adults', 'children', 'arrivalDate', 'departureDate',
  'mealPlan', 'marketSegment', 'sourceOfBusiness', 'track', 'cmsSendMail', 'cmsMessageId', 'bookerEmail', 'reservationNote',
] as const;
export type FieldParityField = (typeof FIELD_PARITY_FIELDS)[number];
export type ParityCause = 'extract' | 'lookup' | 'default' | 'not_in_email' | 'truth_drift';
export type FieldParityValues = Partial<Record<FieldParityField, unknown>>;
export type FieldParityInput = {
  id: string; source: FieldParityValues; nava: FieldParityValues; truth: FieldParityValues;
  provenance?: Partial<Record<FieldParityField, ParityCause>>; partyBound?: boolean; mailbox?: 'faith' | 'other';
};
export type FieldParityVerdict = {
  id: string; field: FieldParityField; unit: number | null; verdict: 'hit' | 'miss' | 'excluded';
  cause?: ParityCause; note?: 'staff_left_blank' | 'truth_field_unread'; partyBound: boolean;
  mailbox: 'faith' | 'other'; guaranteeBucket?: string;
};
export type FieldParityResult = { id: string; fields: FieldParityVerdict[]; partyBound: boolean; mailbox: 'faith' | 'other' };
type FieldAggregate = { field: FieldParityField; n: number; hit: number; miss: number; excluded: number; causes: Record<ParityCause, number> };
export type FieldParityAggregate = {
  fields: FieldAggregate[];
  cmsMessageIdMix: { agencyBound: { n: number; hit: number }; direct: { n: number; hit: number } };
  guaranteeTypeMix: Record<string, number>;
  faithMailbox: { pairs: number; fields: FieldAggregate[] };
  otherMailboxes: { pairs: number; fields: FieldAggregate[] };
};

const ROOM = new Set<FieldParityField>(['roomType', 'ratePlan', 'adults', 'children']);
const CAUSES: ParityCause[] = ['extract', 'lookup', 'default', 'not_in_email', 'truth_drift'];
const PARTICLES = new Set(['van der', 'van den', 'van de', 'von der', 'de la', 'de los', 'de las', 'del', 'van', 'von', 'de', 'da', 'dos', 'du', 'la', 'le']);
const GUARANTEE = new Map(Object.entries({
  AVOUCH: 'AVOUCH', 'AWAITING VOUCHER': 'AVOUCH', CNFREC: 'CNFREC', 'CONFIRMATION RECEIVED': 'CNFREC',
  DEPREQ: 'DEPREQ', 'DEPOSIT REQUESTED': 'DEPREQ', GRPDEF: 'GRPDEF', 'GROUP DEFINITE': 'GRPDEF',
  GTDAGT: 'GTDAGT', 'GUARANTEED BY AGENT': 'GTDAGT', GTDCMP: 'GTDCMP', 'GUARANTEED BY COMPANY': 'GTDCMP',
  GTDCC: 'GTDCC', 'GUARANTEED BY CREDIT CARD': 'GTDCC', CCIATA: 'CCIATA',
  'GUARANTEED BY CREDIT CARD AND AGENT': 'CCIATA', GTDDEP: 'GTDDEP', 'GUARANTEED BY DEPOSIT': 'GTDDEP',
  NGG: 'NGG', 'NON-GUARANTEED GROUP': 'NGG', NGI: 'NGI', 'NON-GUARANTEED INDIVIDUAL': 'NGI',
}));
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const rec = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const str = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number') && String(value).trim() ? String(value).trim() : null;
const blank = (value: unknown): boolean => value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);

function day(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const text = str(value);
  if (!text) return null;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
  const parsed = iso ?? (Number.isFinite(Date.parse(text)) ? new Date(text).toISOString().slice(0, 10) : dayFromText(text));
  return parsed;
}

function bands(ages: readonly number[]): Record<'child1' | 'child2' | 'child3', number> {
  const out = { child1: 0, child2: 0, child3: 0 };
  for (const age of ages) if (age >= 0 && age <= 2) out.child1++; else if (age <= 12 && age >= 3) out.child2++; else if (age <= 17 && age >= 13) out.child3++;
  return out;
}

function board(value: unknown): string | null {
  const text = str(value)?.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const mapped = prefillBoardFromLuna(text);
  if (mapped !== 'unknown') return mapped.toLowerCase();
  if (/\b(bed\s*&\s*breakfast|bed\s+and\s+breakfast|breakfast)\b/.test(text)) return 'bb';
  if (/\b(room[ _-]?only|ro)\b/.test(text)) return 'room_only';
  return text;
}

function scalar(field: FieldParityField, value: unknown): string | null {
  if (blank(value)) return null;
  if (field === 'arrivalDate' || field === 'departureDate') return day(value);
  if (field === 'mealPlan') return board(value);
  if (field === 'guaranteeType') {
    const text = String(value).trim().replace(/\s+/g, ' ').toUpperCase();
    return GUARANTEE.get(text) ?? text;
  }
  if (field === 'cmsSendMail' && typeof value !== 'boolean') {
    const text = String(value).trim().toLowerCase();
    if (['1', 'y', 'yes', 'on', 'true'].includes(text)) return 'true';
    if (['0', 'n', 'no', 'off', 'false'].includes(text)) return 'false';
  }
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalized(field: FieldParityField, value: unknown): string | null {
  if (field === 'children' && Array.isArray(value) && value.every((age) => Number.isInteger(age) && Number(age) >= 0 && Number(age) <= 17)) {
    const b = bands(value as number[]); return `child1:${b.child1}|child2:${b.child2}|child3:${b.child3}`;
  }
  if (field === 'children' && isRecord(value)) {
    if (['child1', 'child2', 'child3'].some((key) => key in value)) return ['child1', 'child2', 'child3'].map((key) => `${key}:${scalar('adults', value[key] ?? 0) ?? '0'}`).join('|');
    if ('count' in value) return `source-count:${scalar('adults', value.count) ?? '?'};ages:${Array.isArray(value.ages) ? value.ages.map(String).sort().join(',') : '?'}`;
  }
  return scalar(field, value);
}

function cause(input: FieldParityInput, field: FieldParityField, source: unknown, expected: unknown): ParityCause {
  const hint = input.provenance?.[field];
  if (blank(source) && hint === 'extract') return 'not_in_email';
  return hint ?? (blank(expected) ? (blank(source) ? 'not_in_email' : 'extract') : blank(source) ? 'default' : 'extract');
}

function safeGuarantee(value: unknown): string | undefined {
  const text = str(value)?.replace(/\s+/g, ' ').toUpperCase();
  if (!text) return undefined;
  const known = GUARANTEE.get(text);
  return known ?? 'other';
}

function compare(input: FieldParityInput, field: FieldParityField): FieldParityVerdict[] {
  const source = input.source[field], expected = ROOM.has(field) && Array.isArray(input.nava[field]) ? [...input.nava[field] as unknown[]] : [input.nava[field]];
  const actual = ROOM.has(field) && Array.isArray(input.truth[field]) ? [...input.truth[field] as unknown[]] : [input.truth[field]];
  if (source === undefined && input.nava[field] === undefined && input.truth[field] === undefined) return [];
  const sort = (items: unknown[]) => items.sort((a, b) => (normalized(field, a) ?? '').localeCompare(normalized(field, b) ?? ''));
  if (ROOM.has(field)) { sort(expected); sort(actual); }
  const count = ROOM.has(field) ? Math.max(expected.length, actual.length, Array.isArray(source) ? source.length : 0) : 1;
  return Array.from({ length: count }, (_, i) => {
    const want = expected[i], got = actual[i], sourceAt = Array.isArray(source) ? source[i] : source;
    const base = { id: input.id, field, unit: ROOM.has(field) ? i + 1 : null, partyBound: input.partyBound ?? false, mailbox: input.mailbox ?? 'other' };
    if (field === 'guaranteeType' && got !== undefined) Object.assign(base, { guaranteeBucket: safeGuarantee(got) });
    if (got === undefined || blank(got)) return { ...base, verdict: 'excluded', cause: 'truth_drift', note: got === undefined ? 'truth_field_unread' : 'staff_left_blank' };
    if (blank(want)) { const why = cause(input, field, sourceAt, want); return { ...base, verdict: why === 'not_in_email' ? 'excluded' : 'miss', cause: why }; }
    const wantKey = normalized(field, want), gotKey = normalized(field, got);
    if (wantKey !== null && wantKey === gotKey) return { ...base, verdict: 'hit' };
    const why = cause(input, field, sourceAt, want);
    return { ...base, verdict: why === 'not_in_email' ? 'excluded' : 'miss', cause: why };
  });
}

export function scoreFieldParity(input: FieldParityInput): FieldParityResult {
  if (!/^P\d{3,}$/.test(input.id)) throw new Error('field_parity_id_must_be_sanitized');
  return { id: input.id, fields: FIELD_PARITY_FIELDS.flatMap((field) => compare(input, field)), partyBound: input.partyBound ?? false, mailbox: input.mailbox ?? 'other' };
}

function aggregateRows(results: readonly FieldParityResult[]): FieldAggregate[] {
  return FIELD_PARITY_FIELDS.map((field) => {
    const rows = results.flatMap((result) => result.fields.filter((row) => row.field === field));
    const counts = { hit: 0, miss: 0, excluded: 0 }, causes = Object.fromEntries(CAUSES.map((value) => [value, 0])) as Record<ParityCause, number>;
    for (const row of rows) { counts[row.verdict]++; if (row.cause) causes[row.cause]++; }
    return { field, n: counts.hit + counts.miss, ...counts, causes };
  });
}

export function aggregateFieldParity(results: readonly FieldParityResult[]): FieldParityAggregate {
  const mix = { agencyBound: { n: 0, hit: 0 }, direct: { n: 0, hit: 0 } };
  const messageRows = results.flatMap((row) => row.fields.filter((field) => field.field === 'cmsMessageId' && field.verdict !== 'excluded'));
  for (const row of messageRows) { const bucket = row.partyBound ? mix.agencyBound : mix.direct; bucket.n++; if (row.verdict === 'hit') bucket.hit++; }
  const guarantees: Record<string, number> = {};
  for (const row of results.flatMap((result) => result.fields)) if (row.field === 'guaranteeType' && row.guaranteeBucket) guarantees[row.guaranteeBucket] = (guarantees[row.guaranteeBucket] ?? 0) + 1;
  const faith = results.filter((row) => row.mailbox === 'faith'), other = results.filter((row) => row.mailbox !== 'faith');
  return { fields: aggregateRows(results), cmsMessageIdMix: mix, guaranteeTypeMix: guarantees, faithMailbox: { pairs: faith.length, fields: aggregateRows(faith) }, otherMailboxes: { pairs: other.length, fields: aggregateRows(other) } };
}

export function normalizeSurname(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim().split(',')[0]!.replace(/^(?:mr|mrs|ms|miss|dr|prof)\.?\s+/i, '');
  const normalized = raw.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[‐‑‒–—-]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ').filter(Boolean);
  if (!/\s/.test(raw.trim()) && /[‐‑‒–—-]/.test(raw)) return normalized;
  for (let i = 0; i < words.length - 1; i++) if (PARTICLES.has(words.slice(i, -1).join(' '))) return words.slice(i).join(' ');
  return words.at(-1) ?? '';
}

function dateDelta(expected: unknown, actual: unknown): number | null {
  const left = day(expected), right = day(actual);
  return left && right ? Math.round(Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000) : null;
}
const truthField = (truth: Record<string, unknown>, key: string): unknown => truth[key] ?? rec(truth.fields)[key];
const labtest = (truth: Record<string, unknown>) => ['firstname', 'lastname', 'guestname', 'createdby'].some((key) => String(truthField(truth, key) ?? '').toLowerCase().includes('labtest'));
export function isNavaCreated(createdBy: unknown, serviceUser = 'NAVAAI'): boolean {
  const clean = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''), user = clean(serviceUser), actor = clean(createdBy);
  return Boolean(actor && (actor === user || actor.startsWith('nava')));
}

export type ConfirmationTruthCandidate = { confirmationNumber: string; sameThread: boolean; truth: Record<string, unknown> | null };
export type ConfirmationLinkResult = { accepted: Array<ConfirmationTruthCandidate & { arrivalDeltaDays: number }>; excluded: 'labtest' | 'nava_created' | null; reason: 'unlinked' | null };
export function linkConfirmationCandidates(input: { surname: string; arrival: string; candidates: readonly ConfirmationTruthCandidate[]; serviceUser?: string }): ConfirmationLinkResult {
  const accepted = input.candidates.flatMap((candidate) => {
    const truth = candidate.truth;
    if (!truth || labtest(truth) || isNavaCreated(truthField(truth, 'createdby'), input.serviceUser)) return [];
    const delta = dateDelta(input.arrival, truthField(truth, 'arrivaldate'));
    return normalizeSurname(truthField(truth, 'lastname')) === normalizeSurname(input.surname) && delta !== null && delta <= 3 ? [{ ...candidate, arrivalDeltaDays: delta }] : [];
  }).sort((a, b) => Number(b.sameThread) - Number(a.sameThread) || a.arrivalDeltaDays - b.arrivalDeltaDays || a.confirmationNumber.localeCompare(b.confirmationNumber));
  const excluded = accepted.length ? null : input.candidates.some((row) => row.truth && labtest(row.truth)) ? 'labtest' : input.candidates.some((row) => row.truth && isNavaCreated(truthField(row.truth, 'createdby'), input.serviceUser)) ? 'nava_created' : null;
  return { accepted, excluded, reason: accepted.length ? null : 'unlinked' };
}

type BuildInput = { propertyCode: string; payload: Record<string, unknown>; partyMatch?: unknown; preparedRateRun?: unknown; emailText?: string | null };
const nameOf = (value: unknown): string | null => typeof value === 'string' ? str(value) : str(rec(value).name);
function rateCode(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) return value.map((item) => rateCode(item, depth + 1)).find(Boolean) ?? null;
  if (!isRecord(value)) return null;
  for (const key of ['ratePlan', 'rateCode', 'rateplan', 'ratecode', 'planCode']) if (/^[A-Za-z0-9_-]{2,16}$/.test(str(value[key]) ?? '')) return str(value[key]);
  return Object.values(value).map((item) => rateCode(item, depth + 1)).find(Boolean) ?? null;
}
function trackSegment(propertyCode: string, track: unknown): string | null {
  const profile = rec(profileFor(propertyCode) as unknown), choices = rec(rec(rec(profile.createForm).options).track).choices;
  return Array.isArray(choices) ? str(choices.filter(isRecord).find((row) => [row.value, row.display].some((value) => str(value)?.toLowerCase() === str(track)?.toLowerCase()))?.marketSegment) : null;
}

/** Rebuilds only deterministic pane fields; does not invoke a model or HMS. */
export async function buildNavaPrefill(input: BuildInput): Promise<{ source: FieldParityValues; nava: FieldParityValues; provenance: Partial<Record<FieldParityField, ParityCause>>; partyBound: boolean }> {
  const payload = input.payload, stay = rec((Array.isArray(payload.stays) ? payload.stays : []).find(isRecord));
  const requested = rec(stay.requested), rows = (Array.isArray(stay.rows) ? stay.rows : []).filter(isRecord);
  const guests = Array.isArray(stay.guests) ? stay.guests : [];
  const rooms = rows.flatMap((row) => Array.from({ length: Math.min(Number(row.rooms) || 0, 20) }, (_, i) => ({ row, guest: nameOf(guests[i]) })));
  const mail = input.emailText ?? '', ages = rooms.flatMap(({ row }) => Array.isArray(row.childAges) ? row.childAges.filter((v): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 17) : []);
  const kidsMentioned = ages.length > 0 || /\b(?:children|child|kids?)\b/i.test(mail), countMatch = /\b(\d{1,2})\s*(?:children|child|kids?)\b/i.exec(mail);
  const partyMatch = rec(input.partyMatch), bound = rec(partyMatch.boundParty ?? partyMatch.best), boundId = str(bound.nativeId ?? bound.ta1 ?? bound.id);
  const agency = nameOf(payload.agency), organization = nameOf(payload.organization), kind = str(bound.kind) ?? (agency ? 'agency' : organization ? 'organization' : boundId ? 'agency' : null);
  const defaults = boundId ? bookingCodeDefaults(kind === 'government' ? 'government' : kind === 'organization' ? 'organization' : 'agency') : DIRECT_BOOKING_DEFAULTS;
  const booker = rec(payload.booker), contact = rec(payload.contact), email = str(payload.bookerEmail ?? booker.email ?? contact.email);
  const rate = rateCode(input.preparedRateRun) ?? str(payload.ratePlan ?? payload.rateText), boardText = str(requested.board ?? stay.board ?? rows[0]?.board);
  const options = createRequestFieldOptions(input.propertyCode);
  const build = await buildCreatePrefill({
    arrival: str(requested.arrival) ?? '', departure: str(requested.departure), nights: Number.isInteger(requested.nights) ? Number(requested.nights) : null,
    rooms: rooms.map(({ row, guest }) => ({ adults: Number(row.adultsPerRoom) || 0, childAges: Array.isArray(row.childAges) ? row.childAges.filter((v): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 17) : [], roomTypeText: str(row.roomType), guestName: guest })),
    boardText, rateText: rate, agencyName: agency, organizationName: organization, voucherNumber: null,
    bookerName: str(payload.bookerName ?? booker.name), bookerEmail: email, billingReference: str(payload.billingReference), paidBy: null,
    partyKind: kind === 'agency' || kind === 'organization' || kind === 'government' ? kind : null,
    defaults: { track: str(payload.track) ?? defaults.track, sourceOfBusiness: str(payload.sourceOfBusiness) ?? defaults.sourceOfBusiness, guaranteeType: str(payload.guaranteeType) ?? defaults.guaranteeType },
    propertyCode: input.propertyCode,
  });
  const requests = build.requests, note = str(payload.reservationNote ?? payload.note ?? payload.specialRequests);
  const source: FieldParityValues = {
    ...(agency || organization ? { agency: agency ?? organization } : {}), ...(str(payload.guaranteeType) ? { guaranteeType: payload.guaranteeType } : {}),
    ...(rows.length ? { roomType: rooms.map(({ row }) => str(row.roomType)), adults: rooms.map(({ row }) => Number(row.adultsPerRoom) || 0) } : {}),
    ...(str(payload.ratePlan ?? payload.rateText) ? { ratePlan: payload.ratePlan ?? payload.rateText } : {}),
    ...(kidsMentioned ? { children: ages.length ? rooms.map(({ row }) => bands(Array.isArray(row.childAges) ? row.childAges.filter((v): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 17) : [])) : { count: countMatch ? Number(countMatch[1]) : null, ages: null } } : {}),
    ...(str(requested.arrival) ? { arrivalDate: requested.arrival } : {}), ...(str(requested.departure) ? { departureDate: requested.departure } : {}),
    ...(boardText ? { mealPlan: boardText } : {}), ...(str(payload.marketSegment) ? { marketSegment: payload.marketSegment } : {}),
    ...(str(payload.sourceOfBusiness) ? { sourceOfBusiness: payload.sourceOfBusiness } : {}), ...(str(payload.track) ? { track: payload.track } : {}),
    ...(payload.confirmationSendMail !== undefined || payload.cmsSendMail !== undefined ? { cmsSendMail: payload.confirmationSendMail ?? payload.cmsSendMail } : {}),
    ...(str(payload.cmsMessageId) ? { cmsMessageId: payload.cmsMessageId } : {}), ...(email ? { bookerEmail: email } : {}), ...(note ? { reservationNote: true } : {}),
  };
  const agesToBands = requests.map((request) => kidsMentioned && !ages.length ? null : bands(Array.isArray(request.childAges) ? request.childAges.filter((v): v is number => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 17) : []));
  const profile = rec(profileFor(input.propertyCode) as unknown), cms = rec(profile.cms), sendMail = payload.confirmationSendMail ?? payload.cmsSendMail ?? true;
  const nava: FieldParityValues = {
    agency: boundId, guaranteeType: requests[0]?.guaranteeType, roomType: requests.map((row) => row.roomType ?? null), ratePlan: requests.map((row) => row.ratePlan ?? null),
    adults: requests.map((row) => row.adults ?? null), children: agesToBands, arrivalDate: requests[0]?.arrival ?? null, departureDate: requests[0]?.departure ?? null,
    mealPlan: board(boardText), marketSegment: str(payload.marketSegment) ?? trackSegment(input.propertyCode, requests[0]?.track),
    sourceOfBusiness: requests[0]?.sourceOfBusiness, track: requests[0]?.track, cmsSendMail: Boolean(sendMail),
    cmsMessageId: str(payload.cmsMessageId) ?? str(boundId ? cms.defaultAgency : cms.defaultGuest) ?? (boundId ? '03' : '01'),
    bookerEmail: requests[0]?.bookerEmail, reservationNote: Boolean(note),
  };
  const extracted = (key: string) => str(payload[key]) !== null;
  const provenance: Partial<Record<FieldParityField, ParityCause>> = {
    agency: 'lookup', guaranteeType: extracted('guaranteeType') ? 'extract' : 'default', roomType: 'extract',
    ratePlan: input.preparedRateRun && rate ? 'lookup' : rate ? 'extract' : 'default', adults: 'extract', children: 'extract',
    arrivalDate: 'extract', departureDate: 'extract', mealPlan: 'extract', marketSegment: extracted('marketSegment') ? 'extract' : 'default',
    sourceOfBusiness: extracted('sourceOfBusiness') ? 'extract' : 'default', track: extracted('track') ? 'extract' : 'default',
    cmsSendMail: payload.confirmationSendMail !== undefined || payload.cmsSendMail !== undefined ? 'extract' : 'default',
    cmsMessageId: extracted('cmsMessageId') ? 'extract' : 'default', bookerEmail: 'extract', reservationNote: 'extract',
  };
  if (!options.roomType.length) throw new Error('hrdav_room_options_unavailable');
  return { source, nava, provenance, partyBound: Boolean(boundId) };
}
