import type {CaseCard, TwinEnvelope} from '../types.js';
import {
  extractSenderHost,
  normalizePartyName,
  searchPartyWithFallback,
  resolvePartySelection,
  type LearnedSenderHit,
} from '../../src/party-matching.js';
import {anchorObservations, isoDate, observeStays} from './backdate.js';
import {anchorPdfs, beforeCutoff, captureTime, quoteKey, rows, verifiedHmsFields, type TwinWorld} from './world.js';

function twinLearnedSender(world: TwinWorld, asOf: number, host: string, kind: 'agency' | 'organization'): LearnedSenderHit | null {
  const rows: Array<{host: string; name: string; kind: 'agency' | 'organization'}> = [];
  const counted = new Set<string>();
  for (const anchor of world.anchors) {
    const observations = anchorObservations(anchor, asOf).filter(row =>
      row.basis === 'last_pre_as_of_pdf' || beforeCutoff(anchor.hms_available_at, asOf));
    const letters = [...anchorPdfs(anchor), object(anchor.primary),
      {sent_at: anchor.hms_available_at, recipient_fields: anchor.recipient_fields}].filter(pdf => beforeCutoff(pdf.sent_at, asOf));
    for (const letter of letters) {
      const recipients = object(letter.recipient_fields);
      const hosts = [...new Set([recipients.to, recipients.cc].flatMap(value => Array.isArray(value) ? value : [value])
        .map(value => String(value ?? '').toLowerCase().match(/@([a-z0-9.-]+)/)?.[1]?.replace(/\.+$/, ''))
        .filter((value): value is string => Boolean(value)))];
      const domain = hosts[0];
      if (!domain || hosts.length !== 1 || !(host === domain || host.endsWith(`.${domain}`)) || extractSenderHost(domain, '') == null) continue;
      const state = observations.filter(row => row.basis === 'pre_as_of_hms_capture' || row.at === Date.parse(String(letter.sent_at)))
        .sort((a, b) => b.at - a.at)[0]?.stay;
      if (!state) continue;
      for (const [party, value] of [['agency', state.ta1 ?? state.agency_text], ['organization', state.company ?? state.company_text]] as const) {
        const name = String(value ?? '').trim();
        const key = `${anchor.confirmation}|${domain}|${party}`;
        if (name && !counted.has(key)) {
          counted.add(key);
          rows.push({host: domain, name, kind: party});
        }
      }
    }
  }
  if (kind === 'organization' && rows.some(r => r.kind === 'agency')) return null;
  const scoped = rows.filter(r => r.kind === kind).sort((a, b) => b.host.length - a.host.length);
  const longest = scoped[0]?.host; if (!longest) return null;
  const names = scoped.filter(r => r.host === longest).map(r => r.name);
  const counts = new Map<string, number>(); for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2 || best[1] / names.length < 0.7) return null;
  const hit = partyRecords(world, kind).find(r => normalizePartyName(String(r.meaning ?? r.name ?? '')) === normalizePartyName(best[0]));
  return {host: longest, kind, name: best[0], nativeId: hit ? String(hit.nativeId ?? hit.code ?? '') || null : null, support: best[1]};
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

function matchReservation(stay: Record<string, unknown>, criteria: Record<string, unknown>): boolean {
  const confirmation = String(stay.confirmation ?? stay.confirmationnumber ?? '');
  const rid = criteria.reservation_id != null ? String(criteria.reservation_id) : '';
  if (rid && !matchesId(rid, confirmation)) return false;
  const name = (value: unknown) => String(value ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  const full = name(stay.guestfullname ?? stay.guest_name);
  const parts = full.split(' ');
  const nativeParts = full.split(/\s*[,/]\s*/);
  const last = name(stay.last_name ?? stay.lastName) || (nativeParts.length > 1 ? nativeParts[0] : parts.at(-1)) || '';
  const first = name(stay.first_name ?? stay.firstName) || (nativeParts.length > 1 ? nativeParts[1] : parts.slice(0, -1).join(' '));
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
    organization: ['organizations', 'organization', 'orgs'],
    agency: ['agencies', 'agency'],
  };
  if (kind === 'meal_plan') return {status: 'unsupported', reason: 'No independent native meal-plan catalogue.'};
  for (const key of keyMap[kind] ?? [kind]) {
    const section = catalogs[key] ?? catalog[key];
    const records = catalogueRecords(section);
    if (records.length) {
      const meta = object(section);
      if (kind === 'organization' || kind === 'agency') return {status: 'use_hms_search_parties', count: records.length};
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
  return catalogueRecords(catalogs[key]).map(item => object(item));
}

/**
 * Prod hms_search_parties returns native HMS candidates only (nativeId/displayName/…).
 * Twin mirrors prod: sequential partySearchQueries, break on first hit (no OR + 25-cap).
 */
async function searchParties(world: TwinWorld, input: Record<string, unknown>): Promise<TwinEnvelope> {
  const kind = String(input.kind ?? 'guest');
  const field = String(input.field ?? 'last_name');
  const rawQuery = String(input.query ?? '').trim();
  const host = extractSenderHost(input.sender_host, rawQuery);
  if (kind === 'guest' && !world.profiles.length) {
    return fail('TWIN_PRE_CUTOFF_PROFILE_UNAVAILABLE', 'No dated guest profiles cover this property.', false, unobserved);
  }
  if (kind !== 'guest' && !Object.keys(world.catalog).length) {
    return fail('TWIN_PRE_CUTOFF_PARTY_UNAVAILABLE', 'No dated native party catalogue covers this property.', false, unobserved);
  }
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
      for (const row of partyRecords(world, kind)) {
        const id = String(row.nativeId ?? row.code ?? row.id ?? '');
        if (!id) continue;
        const name = String(row.meaning ?? row.name ?? row.label ?? '');
        const nameLower = name.toLowerCase();
        const code = String(row.code ?? '').toLowerCase();
        const hay = field === 'profile_id' ? id.toLowerCase() : `${nameLower} ${code}`;
        if (!q || hay.includes(q) || (nameLower.length >= 3 && q.includes(nameLower)) || (code && q === code)) {
          batch.push({nativeId: id, code: row.code ?? null, displayName: row.meaning ?? row.name ?? row.label ?? null, name: row.meaning ?? row.name ?? row.label ?? null, kind});
        }
      }
    }
    return {outcome: batch.length ? 'matches' : 'no_match', criteria: {query: term},
      candidates: batch.slice(0, 25), coverage: {possiblyTruncated: batch.length > 25, source: 'twin'}};
  }, async () => host && (kind === 'agency' || kind === 'organization') ? twinLearnedSender(world, world.cutoff, host, kind) : null);
  const resolved = resolvePartySelection(kind, rows(result.candidates), object(result.coverage).possiblyTruncated !== false, learned, rawQuery);
  const rateMemory = twinPartyRate(world, kind, resolved.selection);
  return ok({...(rateMemory ? {rate_memory: rateMemory} : {}), native: result, ...resolved, ...(learned ? {sender_history: learned} : {})});
}

/** Prod party_rate mirror: last HMS rate plan of a bound party, from anchors captured strictly before the cutoff. */
function twinPartyRate(world: TwinWorld, kind: string, selection: unknown): {rate_plan: string; seen_at: string} | null {
  const name = normalizePartyName(String(object(selection).displayName ?? object(selection).name ?? ''));
  if (!name || (kind !== 'organization' && kind !== 'agency')) return null;
  const codes = new Set(catalogueRecords(object(world.catalog.catalogs ?? world.catalog).ratePlans).map(r => String(object(r).code ?? '')));
  let best: {rate_plan: string; at: number; arrival: string} | null = null;
  for (const anchor of world.anchors) {
    const fields = verifiedHmsFields(anchor, world.cutoff), at = Date.parse(String(captureTime(anchor)));
    const rate = String(fields?.rateplan ?? ''), arrival = isoDate(String(fields?.arrivaldate ?? '').slice(0, 15)) ?? '';
    if (!fields || !codes.has(rate) || normalizePartyName(String(fields[kind === 'agency' ? 'ta1' : 'company'] ?? '')) !== name) continue;
    if (!best || arrival > best.arrival || (arrival === best.arrival && at > best.at)) best = {rate_plan: rate, at, arrival};
  }
  return best ? {rate_plan: best.rate_plan, seen_at: new Date(best.at).toISOString()} : null;
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
        for (const kind of kinds) sections[kind] = catalogueSection(world.catalog, kind);
        return ok({property_code: world.propertyCode, sections});
      }
      case 'hms_search_parties':
        // as_of blinding + sender-map leak fence; catalogue rows only (no invented defaults).
        return searchParties(world, body);
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
