import {arrivalWindow, normalizeReservationReference} from '../../src/reservation-reference.js';
import type {CaseCard, TwinEnvelope} from '../types.js';
import {
  extractSenderHost,
  distinctivePartyTokens,
  searchPartyWithFallback,
  resolvePartySelection,
  type LearnedSenderHit,
} from '../../src/party-matching.js';
import {isoDate, observeStays} from './backdate.js';
import {anchorCaptures, anchorPdfs, beforeCutoff, quoteKey, rows, type TwinWorld} from './world.js';

// Ignore legal suffixes and punctuation; keep commercial name words.
function partyKey(value: unknown): string {
  const tokens = String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const suffixes = new Set(['pty', 'ltd', 'limited', 'inc', 'llc', 'cc', 'plc']);
  while (tokens.length > 1 && suffixes.has(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.join('');
}

function twinLearnedSender(world: TwinWorld, host: string, kind: 'agency' | 'organization'): LearnedSenderHit | null {
  const matches = new Map<string, Map<string, {name: string; support: number}>>();
  const counted = new Set<string>();
  const cutoffDate = new Date(world.cutoff).toISOString().slice(0, 10);
  for (const anchor of world.anchors) {
    const state = anchorCaptures(anchor).map(row => object(row.hms_fields)).find(fields => {
      const departure = isoDate(fields.departure_date ?? fields.departuredate);
      return departure !== null && departure < cutoffDate;
    });
    const agency = String(state?.ta1 ?? state?.agency_text ?? '').trim();
    const name = kind === 'agency' ? agency : agency ? '' : String(state?.company ?? state?.company_text ?? '').trim();
    if (!name) continue;
    for (const pdf of anchorPdfs(anchor)) {
      if (!beforeCutoff(pdf.sent_at, world.cutoff)) continue;
      const mail = world.threadSenders?.get(String(pdf.thread_id ?? ''));
      if (!mail || mail.at >= world.cutoff || mail.at > Date.parse(String(pdf.sent_at))) continue;
      const domain = mail.host;
      const seen = `${anchor.confirmation}|${domain}`;
      if (counted.has(seen) || !(host === domain || host.endsWith(`.${domain}`))) continue;
      counted.add(seen);
      const names = matches.get(domain) ?? new Map();
      matches.set(domain, names);
      const key = partyKey(name);
      const best = names.get(key) ?? {name, support: 0};
      best.support++;
      names.set(key, best);
    }
  }
  for (const [, names] of [...matches].sort(([a], [b]) => b.length - a.length)) {
    const [best, next] = [...names.values()].sort((a, b) => b.support - a.support);
    if (!best || best.support < 2 || next && next.support === best.support) continue;
    const hit = partyRecords(world, kind).find(row => partyKey(row.meaning ?? row.name) === partyKey(best.name));
    return {host, kind, ...best, nativeId: hit ? String(hit.nativeId ?? hit.code ?? '') || null : null};
  }
  return null;
}

const ok = <T>(data: T): TwinEnvelope<T> => ({ok: true, data, error: null});
const fail = (code: string, message: string, retryable = false, data: unknown = null): TwinEnvelope => ({
  ok: false,
  data,
  error: {code, message, retryable, outcome: 'known'},
});

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Emit Stay360-shaped fields from backdated shown stay (PDF projection). */
function fieldMap(stay: Record<string, unknown> | null): Array<{name: string; type: string; label: string; value: unknown; section: null}> {
  if (!stay) return [];
  const labels: Record<string, string> = {
    status: 'Status:',
    confirmation: 'Confirmation Number:',
    confirmationnumber: 'Confirmation Number:',
    guestfullname: 'Guest Name:',
    arrivaldate: 'Arrival',
    departuredate: 'Departure',
    adults: 'Adults',
    roomtype: 'Room Type',
    rateplan: 'Rate Plan',
    mealplan: 'Meal Plan',
    company: 'Company',
    emailaddress: 'Email',
    averagenightly: 'Average Nightly',
    grandtotal: 'Grand Total',
  };
  return Object.entries(stay).map(([name, value]) => ({
    name: name.toLowerCase(),
    type: 'text',
    label: labels[name.toLowerCase()] ?? name,
    value,
    section: null,
  }));
}

const name = (value: unknown) => String(value ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

function reservationNames(stay: Record<string, unknown>) {
  const full = name(stay.guestfullname ?? stay.guest_name);
  const parts = full.split(' ');
  const nativeParts = full.split(/\s*[,/]\s*/);
  const last = name(stay.last_name ?? stay.lastName ?? stay.lastname) || (nativeParts.length > 1 ? nativeParts[0] : parts.at(-1)) || '';
  const first = name(stay.first_name ?? stay.firstName ?? stay.firstname) || (nativeParts.length > 1 ? nativeParts[1] : parts.slice(0, -1).join(' '));
  return {full, first, last};
}

function matchReservation(stay: Record<string, unknown>, criteria: Record<string, unknown>): boolean {
  const confirmation = String(stay.confirmation ?? stay.confirmationnumber ?? '');
  const rid = typeof criteria.reservation_id === 'string' ? normalizeReservationReference(criteria.reservation_id) : '';
  if (rid && !matchesId(rid, confirmation)) return false;
  const {full, first, last} = reservationNames(stay);
  const surname = name(criteria.last_name ?? criteria.guest_name);
  const given = name(criteria.guest_first_name);
  if (surname.includes('/') && criteria.guest_name_is_surname !== true) {
    const [left, right] = surname.split(/\s*\/\s*/);
    if (!((left === last && right === first) || (right === last && left === first))) return false;
  } else {
    if (surname && surname !== last && !(criteria.guest_name_is_surname === true && !stay.last_name && !stay.lastName && full.endsWith(` ${surname}`))) return false;
    if (given && given !== first && !full.startsWith(`${given} `)) return false;
  }
  for (const date of ['arrival', 'departure']) {
    const requested = criteria[`${date}_date`];
    const value = stay[`${date}_date`] ?? stay[`${date}date`] ?? stay[date];
    if (requested && (isoDate(requested) === null || isoDate(value) !== isoDate(requested))) return false;
  }
  return true;
}

function catalogueRecords(section: unknown): unknown[] {
  if (Array.isArray(section)) return section;
  const row = object(section);
  if (Array.isArray(row.records)) return row.records;
  if (Array.isArray(row.items)) return row.items;
  return [];
}

function catalogueSection(catalog: Record<string, unknown>, kind: string): Record<string, unknown> {
  const catalogs = object(catalog.catalogs ?? catalog);
  const keyMap: Record<string, string[]> = {
    room_type: ['roomTypes', 'room_type', 'roomType'],
    rate_plan: ['ratePlans', 'rate_plan', 'ratePlan'],
    meal_plan: ['mealPlans', 'meal_plan', 'mealPlan'],
    source_of_business: ['sourceBusiness', 'sourcesOfBusiness', 'source_of_business'],
    track: ['tracks', 'track', 'trackSubsegment'],
    guarantee_type: ['guaranteeTypes', 'guarantee_type'],
  };
  if (kind === 'meal_plan') return {status: 'unsupported', reason: 'No independent native meal-plan catalogue.'};
  for (const key of keyMap[kind] ?? [kind]) {
    const section = catalogs[key] ?? catalog[key];
    const records = catalogueRecords(section);
    if (records.length) {
      const meta = object(section);
      return {
        records: records.map(r => ({code: object(r).code, meaning: object(r).meaning})),
        status: meta.status ?? 'ok',
        scope: meta.scope ?? null,
        coverage: meta.coverage ?? 'complete',
      };
    }
  }
  return {status: 'unavailable', reason: 'catalog_path_or_property_missing', items: [], records: []};
}

function partyRecords(world: TwinWorld, kind: string): Array<Record<string, unknown>> {
  const catalogs = object(world.catalog.catalogs ?? world.catalog);
  const key =
    kind === 'agency' ? 'agencies' :
    kind === 'organization' ? 'organizations' :
    kind === 'ar_account' ? 'arAccounts' :
    null;
  if (!key) return [];
  // Treat the directory as static reference data; rarely, it may expose parties created after the case.
  return catalogueRecords(catalogs[key]).map(object);
}

/**
 * Prod hms_search_parties returns native HMS candidates only (nativeId/displayName/…).
 * Twin mirrors prod: sequential partySearchQueries, break on first hit (no OR + 25-cap).
 */
async function searchParties(world: TwinWorld, input: Record<string, unknown>, card: CaseCard): Promise<TwinEnvelope> {
  const kind = String(input.kind ?? 'guest');
  const field = String(input.field ?? 'last_name');
  const rawQuery = String(input.query ?? '').trim();
  const host = extractSenderHost(input.sender_host, '') ?? extractSenderHost(object(card.selected_email).from_address, rawQuery);
  if (kind === 'guest' && !world.profiles.length) {
    return fail('TWIN_PRE_CUTOFF_PROFILE_UNAVAILABLE', 'No dated guest profiles cover this property.', false, unobserved);
  }
  if (kind !== 'guest' && !Object.keys(world.catalog).length) {
    return fail('TWIN_PRE_CUTOFF_PARTY_UNAVAILABLE', 'No dated native party catalogue covers this property.', false, unobserved);
  }
  const parties = kind === 'guest' ? [] : partyRecords(world, kind);
  const {result, learned} = await searchPartyWithFallback(rawQuery, kind, async term => {
    const q = term.toLowerCase();
    const batch: Array<Record<string, unknown>> = [];
    if (kind === 'guest') {
      for (const profile of world.profiles) {
        const first = String(profile.firstName ?? profile.first_name ?? '').toLowerCase();
        const last = String(profile.lastName ?? profile.last_name ?? '').toLowerCase();
        const email = String(profile.email ?? '').toLowerCase();
        const id = String(profile.nativeId ?? profile.profile_id ?? profile.guestid ?? '');
        if (!id) continue;
        const hay = field === 'first_name' ? first : field === 'email' ? email : field === 'phone'
          ? String(profile.mobile ?? profile.phone ?? '').replace(/[^\d+]/g, '') : field === 'profile_id' ? id.toLowerCase() : last;
        if (!q || hay.includes(field === 'phone' ? q.replace(/[^\d+]/g, '') || q : q) || field === 'name' && `${last} ${first}`.includes(q)) {
          const displayName = `${profile.firstName ?? profile.first_name ?? ''} ${profile.lastName ?? profile.last_name ?? ''}`.trim() || null;
          batch.push({nativeId: id, firstName: profile.firstName ?? profile.first_name ?? null, lastName: profile.lastName ?? profile.last_name ?? null, displayName, name: displayName});
        }
      }
    } else {
      const partial = distinctivePartyTokens(term).length > 0, queryKey = partyKey(term);
      for (const row of parties) {
        const id = String(row.nativeId ?? row.code ?? row.id ?? '');
        if (!id) continue;
        const name = String(row.meaning ?? row.name ?? row.label ?? '');
        const nameLower = name.toLowerCase();
        const code = String(row.code ?? '').toLowerCase();
        const hay = field === 'profile_id' ? id.toLowerCase() : `${nameLower} ${code}`;
        const nameKey = partyKey(name);
        if (q === id.toLowerCase() || q === code && !!code || q === nameLower && !!nameLower ||
          partial && (hay.includes(q) || !!queryKey && nameKey.includes(queryKey))) {
          batch.push({nativeId: id, code: row.code ?? null, displayName: row.meaning ?? row.name ?? row.label ?? null, name: row.meaning ?? row.name ?? row.label ?? null, kind});
        }
      }
    }
    return {outcome: batch.length ? 'matches' : 'no_match', criteria: {query: term},
      candidates: batch.slice(0, 25), coverage: {possiblyTruncated: batch.length > 25, source: 'twin'}};
  }, async () => host && (kind === 'agency' || kind === 'organization') ? twinLearnedSender(world, host, kind) : null);
  const resolved = resolvePartySelection(kind, rows(result.candidates), object(result.coverage).possiblyTruncated !== false, learned, rawQuery);
  return ok({native: result, ...resolved, ...(learned ? {sender_history: learned} : {})});
}

function quoteFromWorld(world: TwinWorld, input: Record<string, unknown>): TwinEnvelope {
  const capture = world.quotes.get(quoteKey(input));
  if (capture) return capture.response;
  world.coverage.quoteMisses += 1;
  return fail('TWIN_NO_PRICE', 'No dated native quote capture matches the complete request.', false, unobserved);
}

function matchesId(requested: string, actual: string): boolean {
  return requested === actual || (!requested.includes('-') && actual.startsWith(`${requested}-`));
}

type Stays = ReturnType<typeof observeStays>;
const unobserved = {twin_coverage: 'unobserved', documents_observed: false};

function readReservation(stays: Stays, input: Record<string, unknown>): TwinEnvelope {
  if (!input.reservation_id) return fail('CONFIRMATION_NOT_FOUND', 'No reservation reference supplied.');
  const matches = [...stays.values()].filter(row => matchReservation(row.stay, input));
  if (matches.length > 1) return fail('CONFIRMATION_AMBIGUOUS', 'More than one observed stay satisfies the requested criteria.');
  const found = matches[0];
  if (!found) return fail('TWIN_PRE_CUTOFF_STAY_UNAVAILABLE', 'No observed stay matches the requested criteria.', false, unobserved);
  return ok({
    outcome: 'ok',
    id: null,
    tool: 'read',
    shallow: {confirmation: found.confirmation},
    twin_coverage: 'observed',
    documents_observed: found.documents !== null,
    record: {
      notes: [],
      details: {grids: [], fields: fieldMap(found.stay)},
      documents: found.documents,
      documents_observed: found.documents !== null,
    },
  });
}

function searchReservations(stays: Stays, input: Record<string, unknown>): TwinEnvelope {
  const criteria = object(input.criteria);
  if (!criteria.reservation_id && !criteria.guest_name && !criteria.guest_first_name) {
    return fail('INPUT_GAP', 'Provide a confirmation number or a guest surname.');
  }
  const observed = [...stays.values()];
  if (criteria.near_arrival === true && !criteria.reservation_id) {
    const arrival = isoDate(criteria.arrival_date);
    if (!arrival || typeof criteria.guest_name !== 'string') return fail('INVALID_INPUT', 'Provide surname and original arrival.');
    const {from, to} = arrivalWindow(arrival);
    const candidates = observed.flatMap(row => {
      const {stay} = row;
      const {first, last} = reservationNames(stay);
      const arrival_date = isoDate(stay.arrival_date ?? stay.arrivaldate ?? stay.arrival);
      if (!arrival_date || arrival_date < from || arrival_date > to ||
          !matchReservation(row.stay, {guest_name: criteria.guest_name, guest_name_is_surname: true})) return [];
      return [{reservation_id: row.confirmation, arrival_date, departure_date: isoDate(stay.departure_date ?? stay.departuredate ?? stay.departure),
        first_name: first, last_name: last, status: stay.status}];
    });
    const narrowed = candidates.length > 1 && criteria.guest_first_name ?
      candidates.filter(row => name(row.first_name) === name(criteria.guest_first_name)) : candidates;
    return candidates.length ? ok({outcome: 'candidates', candidates: narrowed.length ? narrowed : candidates, twin_coverage: 'observed'}) :
      fail('TWIN_PRE_CUTOFF_STAY_UNAVAILABLE', 'No observed stay matches the requested criteria; absence is unconfirmed.', false, unobserved);
  }
  let matches = observed.filter(row => matchReservation(row.stay, criteria));
  if (!matches.length && !criteria.reservation_id && criteria.guest_first_name && criteria.guest_name_is_surname !== true) {
    matches = observed.filter(row => matchReservation(row.stay, {...criteria, guest_name: criteria.guest_first_name, guest_first_name: undefined}));
  }
  const candidates = matches.map(row => ({
      reservation_id: row.confirmation,
      documents_observed: row.documents !== null,
      native: {ok: true, notes: [], method: 'twin', details: {cards: [{title: 'Stay', grids: [], fields: fieldMap(row.stay)}]}},
    }));
  if (!candidates.length) {
    return fail('TWIN_PRE_CUTOFF_STAY_UNAVAILABLE', 'No observed stay matches the requested criteria; absence is unconfirmed.', false, unobserved);
  }
  return ok({outcome: 'candidates', candidates, completeness: 'twin', twin_coverage: 'observed'});
}

export function createTwinDispatch(world: TwinWorld, card: CaseCard) {
  let stays: Stays | undefined;
  return async function dispatch(name: string, input: unknown): Promise<TwinEnvelope> {
    const body = object(input);
    if (name.startsWith('hms_') && body.property_code !== world.propertyCode) {
      return fail('PROPERTY_MISMATCH', `Replay case uses ${world.propertyCode}; supply it as property_code.`);
    }
    switch (name) {
      case 'hms_search_reservations':
        return searchReservations(stays ??= observeStays(world, card), body);
      case 'hms_read_reservation':
        return readReservation(stays ??= observeStays(world, card), body);
      case 'hms_read_catalogue': {
        if (!Object.keys(world.catalog).length) {
          return fail('TWIN_PRE_CUTOFF_CATALOGUE_UNAVAILABLE', 'No dated catalogue predates the decision cutoff.');
        }
        const kinds = Array.isArray(body.kinds) ? body.kinds as string[] : [];
        const sections: Record<string, unknown> = {};
        for (const kind of kinds) sections[kind] = ['agency', 'organization', 'ar_account', 'agencies', 'organizations', 'orgs', 'arAccounts'].includes(kind)
          ? {status: 'use_hms_search_parties'} : catalogueSection(world.catalog, kind);
        return ok({property_code: world.propertyCode, sections});
      }
      case 'hms_search_parties':
        return searchParties(world, body, card);
      case 'hms_quote':
        return quoteFromWorld(world, body);
      case 'save':
      case 'hms_save':
        return fail('TWIN_NO_SAVE', 'Twin does not simulate Save/readback; staff Go is out of scope.');
      default:
        return fail('UNAVAILABLE', `Twin does not implement ${name}`);
    }
  };
}
