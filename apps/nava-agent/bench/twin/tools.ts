import {arrivalWindow, isHmsConfirmation, normalizeReservationReference} from '../../src/reservation-reference.js';
import type {CaseCard, TwinEnvelope} from '../types.js';
import {
  extractSenderHost,
  distinctivePartyTokens,
  searchPartyWithFallback,
  resolvePartySelection,
  type LearnedSenderHit,
} from '../../src/party-matching.js';
import {isoDate, observeStays} from './backdate.js';
import {
  completeNoMatch, queryDigest, unobservedResult, observedResult, type Scope,
} from './read-result.js';
import {anchorCaptures, anchorPdfs, beforeCutoff, quoteKey, rows, type TwinWorld} from './world.js';

// Ignore legal suffixes and punctuation; keep commercial name words.
function partyKey(value: unknown): string {
  const tokens = String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const suffixes = new Set(['pty', 'ltd', 'limited', 'inc', 'llc', 'cc', 'plc']);
  while (tokens.length > 1 && suffixes.has(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.join('');
}

export function twinSenderHost(sender: unknown, body: unknown): string | null {
  if (typeof sender === 'string' && /(?:^|[@.])legacyhotels\.co\.za>?\s*$/i.test(sender)) {
    const forwarded = typeof body === 'string' ? /^\s*>?\s*From:[^\r\n<>]*<([^<>\s]+@[^<>\s]+)>/im.exec(body) : null;
    return extractSenderHost(forwarded?.[1], '');
  }
  return extractSenderHost(sender, '');
}

export function twinLearnedSender(world: TwinWorld, host: string, kind: 'agency' | 'organization'): LearnedSenderHit | null {
  if (!world.threadSenders?.size && !world.senderPairs?.length) return null;
  const matches = new Map<string, Map<string, {name: string; support: number}>>();
  const counted = new Set<string>();
  const directMisses = new Map<string, number>();
  const cutoffDate = new Date(world.cutoff).toISOString().slice(0, 10);
  const recordStay = (conf: string, domain: string, agency: string, company: string) => {
    const seen = `${conf}|${domain}`;
    if (counted.has(seen)) return;
    counted.add(seen);
    const name = kind === 'agency' ? agency : agency ? '' : company;
    if (!name) {
      if (kind === 'agency') directMisses.set(domain, (directMisses.get(domain) ?? 0) + 1);
      return;
    }
    const names = matches.get(domain) ?? new Map();
    matches.set(domain, names);
    const key = partyKey(name);
    const best = names.get(key) ?? {name, support: 0};
    best.support++;
    names.set(key, best);
  };
  for (const anchor of world.anchors) {
    const domains = new Set<string>();
    for (const pdf of anchorPdfs(anchor)) {
      if (!beforeCutoff(pdf.sent_at, world.cutoff)) continue;
      const mail = world.threadSenders?.get(String(pdf.thread_id ?? ''));
      if (!mail || !(mail.at < world.cutoff) || mail.at > Date.parse(String(pdf.sent_at))) continue;
      if (host === mail.host || host.endsWith(`.${mail.host}`)) domains.add(mail.host);
    }
    if (!domains.size) continue;
    const state = anchorCaptures(anchor).filter(row => beforeCutoff(row.captured_at, world.cutoff)).map(row => object(row.hms_fields)).find(fields => {
      const departure = isoDate(fields.departure_date ?? fields.departuredate);
      return departure !== null && departure < cutoffDate;
    });
    if (!state) continue;
    const agency = String(state.ta1 ?? '').trim();
    const company = String(state.company ?? state.company_text ?? '').trim();
    for (const domain of domains) recordStay(anchor.confirmation, domain, agency, company);
  }
  for (const pair of world.senderPairs ?? []) {
    if (!(pair.mailAtMs < world.cutoff) || !(pair.sentAtMs < world.cutoff)) continue;
    if (host === pair.host || host.endsWith(`.${pair.host}`)) {
      recordStay(pair.confirmation, pair.host, pair.ta1, pair.company);
    }
  }
  for (const [domain, names] of [...matches].sort(([a], [b]) => b.length - a.length)) {
    const [best, next] = [...names.values()].sort((a, b) => b.support - a.support);
    if (!best || best.support < 2 || next && next.support === best.support) continue;
    if (kind === 'agency' && (best.support < 3 || best.support / (best.support + (directMisses.get(domain) ?? 0)) < 0.85)) continue;
    const hit = partyRecords(world, kind).find(row => partyKey(row.meaning ?? row.name ?? row.label) === partyKey(best.name));
    return {host, kind, ...best, nativeId: hit ? String(hit.nativeId ?? hit.code ?? hit.id ?? '') || null : null};
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
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'madam']);

function stripHonorifics(value: string): string {
  return value.split(' ').filter(token => token && !HONORIFICS.has(token)).join(' ');
}

function reservationNames(stay: Record<string, unknown>) {
  const full = name(stay.guestfullname ?? stay.guest_name);
  const parts = full.split(' ').filter(Boolean);
  const nativeParts = full.split(/\s*[,/]\s*/).map(part => stripHonorifics(part.trim())).filter(Boolean);
  const last = stripHonorifics(name(stay.last_name ?? stay.lastName ?? stay.lastname))
    || (nativeParts.length > 1 ? nativeParts[0] : stripHonorifics(parts.at(-1) ?? '')) || '';
  const first = stripHonorifics(name(stay.first_name ?? stay.firstName ?? stay.firstname))
    || (nativeParts.length > 1 ? nativeParts[1] : stripHonorifics(parts.slice(0, -1).join(' '))) || '';
  return {full, first, last};
}

function matchReservation(stay: Record<string, unknown>, criteria: Record<string, unknown>): boolean {
  const confirmation = String(stay.confirmation ?? stay.confirmationnumber ?? '');
  const rid = typeof criteria.reservation_id === 'string' ? normalizeReservationReference(criteria.reservation_id) : '';
  const hasGuest = Boolean(name(criteria.last_name) || name(criteria.guest_name));
  const useId = rid && (/^(?:\d+-\d+|\d{6,10})$/.test(rid) || !hasGuest);
  if (useId && !matchesId(rid, confirmation)) return false;
  const {full, first, last} = reservationNames(stay);
  const surname = stripHonorifics((name(criteria.last_name) || name(criteria.guest_name)));
  const given = stripHonorifics(name(criteria.guest_first_name));
  const hasExplicitLast = stay.last_name != null || stay.lastName != null || stay.lastname != null;
  if (surname.includes('/') && criteria.guest_name_is_surname !== true) {
    const [left, right] = surname.split(/\s*\/\s*/).map(stripHonorifics);
    if (!((left === last && right === first) || (right === last && left === first))) return false;
  } else {
    const fullNameMatch = !criteria.last_name && criteria.guest_name_is_surname !== true && surname === stripHonorifics(full);
    const compoundSurname = (criteria.last_name || criteria.guest_name_is_surname === true)
      && !hasExplicitLast && full.endsWith(` ${surname}`);
    if (surname && surname !== last && !fullNameMatch && !compoundSurname) return false;
    if (given && given !== first && !full.startsWith(`${given} `) && !first.startsWith(`${given} `) && !first.endsWith(` ${given}`)) return false;
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
  const selected = object(card.selected_email);
  const host = twinSenderHost(selected.from_address ?? selected.from, selected.body ?? selected.body_text)
    ?? extractSenderHost(input.sender_host, rawQuery);
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
  const digest = queryDigest(scopeOf(world), 'hms_quote', input);
  const capture = world.quotes.get(quoteKey(input));
  if (capture) {
    const response = capture.response;
    if (response.ok && response.data && typeof response.data === 'object') {
      const data = response.data as Record<string, unknown>;
      return ok({
        ...data,
        twin_coverage: 'observed',
        read_result: observedResult(data, [], digest),
      });
    }
    return response;
  }
  world.coverage.quoteMisses += 1;
  // Missing tape is unobserved — never invent sold-out / blank Documents / successful Prepare.
  return fail('TWIN_NO_PRICE', 'No dated native quote capture matches the complete request.', false,
    coveragePayload(unobservedResult('no_matching_quote_receipt', digest)));
}

function matchesId(requested: string, actual: string): boolean {
  return requested === actual || (!requested.includes('-') && actual.startsWith(`${requested}-`));
}

type Stays = ReturnType<typeof observeStays>;
type StayRow = Stays extends Map<string, infer V> ? V : never;
const unobserved = {twin_coverage: 'unobserved' as const, documents_observed: false};

function scopeOf(world: TwinWorld): Scope {
  return {property: world.propertyCode, mailbox: null};
}

/** Identity stubs prove confirmation existence only — never guest/date completeness. */
function isIdentityStub(row: StayRow): boolean {
  return row.basis === 'pre_as_of_identity';
}

/**
 * Complete no-match requires every *queryable* observed stay to carry fields the query uses.
 * Confirmation-only identity stubs never answer guest/date queries and never prove catalogue completeness alone.
 */
function canClaimCompleteNoMatch(observed: StayRow[], criteria: Record<string, unknown>): boolean {
  if (!observed.length) return false;
  const needsGuest = Boolean(
    name(criteria.guest_name) || name(criteria.last_name) || name(criteria.guest_first_name)
    || criteria.arrival_date || criteria.departure_date || criteria.near_arrival === true,
  );
  if (needsGuest) {
    const queryable = observed.filter(row => !isIdentityStub(row));
    if (!queryable.length) return false;
    return queryable.every(row => {
      const {last, full} = reservationNames(row.stay);
      const arrival = isoDate(row.stay.arrival_date ?? row.stay.arrivaldate ?? row.stay.arrival);
      return Boolean(last || full) && (!(criteria.arrival_date || criteria.near_arrival) || arrival != null);
    });
  }
  // ID-only: stubs alone never prove HMS absence; mixed stub+full still a partial tape.
  if (observed.some(isIdentityStub)) return false;
  return true;
}

function coveragePayload(result: ReturnType<typeof unobservedResult> | ReturnType<typeof completeNoMatch> | ReturnType<typeof observedResult>) {
  if (result.state === 'observed') {
    return {twin_coverage: 'observed' as const, documents_observed: false, read_result: result};
  }
  if (result.state === 'no_match') {
    return {
      twin_coverage: 'no_match' as const,
      documents_observed: false,
      query_digest: result.queryDigest,
      complete: true as const,
      read_result: result,
    };
  }
  // Legacy envelope for existing honesty checks; read_result available via typed helpers.
  return {twin_coverage: 'unobserved' as const, documents_observed: false};
}

function missStay(observed: StayRow[], criteria: Record<string, unknown>, digest: string): TwinEnvelope {
  if (!observed.length) {
    return fail('TWIN_PRE_CUTOFF_STAY_UNAVAILABLE', 'No observed stay matches the requested criteria; absence is unconfirmed.', false,
      coveragePayload(unobservedResult('no_pre_cutoff_stay_tape', digest)));
  }
  if (!canClaimCompleteNoMatch(observed, criteria)) {
    return fail('TWIN_PRE_CUTOFF_STAY_UNAVAILABLE', 'No observed stay matches the requested criteria; absence is unconfirmed.', false,
      coveragePayload(unobservedResult('partial_or_identity_stub_tape', digest)));
  }
  return fail('TWIN_PRE_CUTOFF_STAY_NO_MATCH', 'Complete pre-cutoff search found no matching stay.', false,
    coveragePayload(completeNoMatch(digest, observed.map(row => row.confirmation))));
}

function readReservation(stays: Stays, world: TwinWorld, input: Record<string, unknown>): TwinEnvelope {
  const digest = queryDigest(scopeOf(world), 'hms_read_reservation', input);
  if (!input.reservation_id) return fail('CONFIRMATION_NOT_FOUND', 'No reservation reference supplied.');
  const matches = [...stays.values()].filter(row => matchReservation(row.stay, input));
  if (matches.length > 1) return fail('CONFIRMATION_AMBIGUOUS', 'More than one observed stay satisfies the requested criteria.');
  const found = matches[0];
  if (!found) {
    return missStay([...stays.values()], input, digest);
  }
  const data = {
    outcome: 'ok',
    id: null,
    tool: 'read',
    shallow: {confirmation: found.confirmation},
    twin_coverage: 'observed' as const,
    documents_observed: found.documents !== null,
    read_result: observedResult({confirmation: found.confirmation}, [found.confirmation], digest),
    record: {
      notes: [],
      details: {grids: [], fields: fieldMap(found.stay)},
      documents: found.documents,
      documents_observed: found.documents !== null,
    },
  };
  return ok(data);
}

/**
 * Mirror native stay-search ladder (tools/triage searchReservations):
 * (a) HMS-shaped confirmation alone → (b) surname + arrival ±3d → (c) surname + first.
 * Stuffed agency/PNR reservation_id is ignored except as rung (a) when HMS-shaped.
 */
function searchReservations(stays: Stays, world: TwinWorld, input: Record<string, unknown>): TwinEnvelope {
  const criteria = object(input.criteria);
  const digest = queryDigest(scopeOf(world), 'hms_search_reservations', input);
  const surname = name(criteria.guest_name) || name(criteria.last_name);
  const given = name(criteria.guest_first_name);
  const rid = typeof criteria.reservation_id === 'string' ? normalizeReservationReference(criteria.reservation_id) : '';
  if (!rid && !surname && !given) {
    return fail('INPUT_GAP', 'Provide a confirmation number or a guest surname.');
  }
  const observed = [...stays.values()];
  type Cand = {
    reservation_id: string; arrival_date: string | null; departure_date: string | null;
    first_name: string; last_name: string; status: unknown;
    documents_observed: boolean;
    native: {ok: true; notes: []; method: 'twin'; details: {cards: [{title: 'Stay'; grids: []; fields: ReturnType<typeof fieldMap>}]}};
  };
  const toCand = (row: StayRow): Cand => {
    const {first, last} = reservationNames(row.stay);
    return {
      reservation_id: row.confirmation,
      arrival_date: isoDate(row.stay.arrival_date ?? row.stay.arrivaldate ?? row.stay.arrival),
      departure_date: isoDate(row.stay.departure_date ?? row.stay.departuredate ?? row.stay.departure),
      first_name: first, last_name: last, status: row.stay.status,
      documents_observed: row.documents !== null,
      native: {ok: true, notes: [], method: 'twin', details: {cards: [{title: 'Stay', grids: [], fields: fieldMap(row.stay)}]}},
    };
  };
  const hit = (rung: string, rows: StayRow[]) => {
    if (!rows.length) return null;
    const candidates = rows.map(toCand);
    return ok({
      outcome: 'candidates', candidates, completeness: 'twin', twin_coverage: 'observed', matched_rung: rung,
      read_result: observedResult({candidates}, candidates.map(c => c.reservation_id), digest),
    });
  };

  if (rid && isHmsConfirmation(rid)) {
    const rows = observed.filter(row => matchesId(rid, row.confirmation));
    const found = hit('confirmation', rows);
    if (found) return found;
  }

  const arrival = isoDate(criteria.arrival_date);
  if (surname && arrival) {
    const {from, to} = arrivalWindow(arrival);
    const rows = observed.filter(row => {
      const arrival_date = isoDate(row.stay.arrival_date ?? row.stay.arrivaldate ?? row.stay.arrival);
      return !!arrival_date && arrival_date >= from && arrival_date <= to &&
        matchReservation(row.stay, {guest_name: surname, guest_name_is_surname: true});
    });
    const narrowed = rows.length > 1 && given
      ? rows.filter(row => name(reservationNames(row.stay).first) === given)
      : rows;
    const found = hit('surname_near_arrival', narrowed.length ? narrowed : rows);
    if (found) return found;
  }

  if (surname && given) {
    const rows = observed.filter(row =>
      matchReservation(row.stay, {guest_name: surname, guest_first_name: given, guest_name_is_surname: true}));
    const found = hit('surname_first_name', rows);
    if (found) return found;
  }

  // Legacy single-shot AND path for criteria that never formed a rung (e.g. surname-only).
  if (!isHmsConfirmation(rid) && surname && !arrival && !given) {
    let matches = observed.filter(row => matchReservation(row.stay, {
      guest_name: surname, guest_name_is_surname: criteria.guest_name_is_surname,
    }));
    if (!matches.length && criteria.guest_first_name && criteria.guest_name_is_surname !== true) {
      matches = observed.filter(row => matchReservation(row.stay, {guest_name: criteria.guest_first_name}));
    }
    const found = hit('surname_only', matches);
    if (found) return found;
  }

  return missStay(observed, {
    ...criteria,
    // Ladder miss: do not AND stuffed reservation_id with guest/date for completeness claims.
    ...(rid && !isHmsConfirmation(rid) ? {reservation_id: undefined} : {}),
    near_arrival: surname && arrival ? true : criteria.near_arrival,
  }, digest);
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
        return searchReservations(stays ??= observeStays(world, card), world, body);
      case 'hms_read_reservation':
        return readReservation(stays ??= observeStays(world, card), world, body);
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
