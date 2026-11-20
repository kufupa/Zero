import type {CaseCard, TwinEnvelope} from '../types.js';
import {partySearchQueries} from '../../src/party-matching.js';
import {projectHmsShown} from './backdate.js';
import {quoteKey, type TwinWorld} from './world.js';

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
  if (rid && confirmation && rid !== confirmation && !confirmation.startsWith(rid) && !rid.startsWith(confirmation.split('-')[0]!)) {
    return false;
  }
  const surname = String(criteria.guest_name ?? '').toLowerCase();
  if (surname) {
    const guest = String(stay.guestfullname ?? stay.last_name ?? stay.lastName ?? '').toLowerCase();
    if (!guest.includes(surname.split(/\s+/)[0]!)) return false;
  }
  const arrival = criteria.arrival_date != null ? String(criteria.arrival_date) : '';
  if (arrival) {
    const got = String(stay.arrivaldate ?? stay.arrival_date ?? stay.arrival ?? '');
    if (got && !got.includes(arrival) && !arrival.includes(got.slice(0, 10))) return false;
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
      return {
        items: records,
        records,
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

function tokenOverlap(a: string, b: string): boolean {
  const tokens = (s: string) => new Set(s.split(/[^a-z0-9]+/).filter(t => t.length >= 4));
  const ta = tokens(a);
  const tb = tokens(b);
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit >= 1;
}

/**
 * Prod hms_search_parties returns native HMS candidates only (nativeId/displayName/…).
 * Twin must not invent defaults / prior_stays / govHint — skills may still apply property
 * defaults from skill text, same as live.
 */
function searchParties(world: TwinWorld, input: Record<string, unknown>): TwinEnvelope {
  const kind = String(input.kind ?? 'guest');
  const field = String(input.field ?? 'last_name');
  const rawQuery = String(input.query ?? '').trim();
  // Mirror prod: try partySearchQueries terms in order, stop at the first term with hits (no OR, no fake cap).
  const queries = rawQuery ? partySearchQueries(rawQuery, kind) : [''];
  let candidates: Array<Record<string, unknown>> = [];
  let matchedTerm = rawQuery;
  for (const term of queries) {
    const q = term.toLowerCase();
    const batch: Array<Record<string, unknown>> = [];
    if (kind === 'guest') {
      for (const profile of world.profiles) {
        const first = String(profile.firstName ?? profile.first_name ?? '').toLowerCase();
        const last = String(profile.lastName ?? profile.last_name ?? '').toLowerCase();
        const email = String(profile.email ?? '').toLowerCase();
        const id = String(profile.nativeId ?? profile.profile_id ?? profile.guestid ?? '');
        const hay = field === 'first_name' ? first : field === 'email' ? email : field === 'profile_id' ? id.toLowerCase() : last;
        if (!q || hay.includes(q) || `${last} ${first}`.includes(q)) {
          const displayName = `${profile.firstName ?? profile.first_name ?? ''} ${profile.lastName ?? profile.last_name ?? ''}`.trim() || null;
          batch.push({nativeId: id || `twin-guest-${batch.length + 1}`, firstName: profile.firstName ?? profile.first_name ?? null, lastName: profile.lastName ?? profile.last_name ?? null, displayName, name: displayName});
        }
      }
    } else {
      for (const row of partyRecords(world, kind)) {
        const id = String(row.nativeId ?? row.code ?? row.id ?? '');
        const name = String(row.meaning ?? row.name ?? row.label ?? '');
        const nameLower = name.toLowerCase();
        const code = String(row.code ?? '').toLowerCase();
        const hay = field === 'profile_id' ? id.toLowerCase() : `${nameLower} ${code}`;
        if (!q || hay.includes(q) || (nameLower.length >= 3 && q.includes(nameLower)) || (code && q === code) || tokenOverlap(nameLower, q)) {
          batch.push({nativeId: id || `twin-${kind}-${batch.length + 1}`, code: row.code ?? null, displayName: name || null, name: name || null, kind});
        }
      }
    }
    if (batch.length) { candidates = batch; matchedTerm = term; break; }
  }
  const single = ['organization', 'agency'].includes(kind) && candidates.length === 1 ? candidates[0] : null;
  return ok({
    native: {
      outcome: candidates.length ? 'matches' : 'no_match',
      criteria: {query: matchedTerm || rawQuery}, // prod shape; tool-registry partyRead needs it to bind
      candidates,
      coverage: {possiblyTruncated: false, source: 'twin'},
    },
    selection: single ?? 'none',
    ambiguity: single ? null : 'Multiple or incomplete candidates require staff selection.',
  });
}

function quoteFromWorld(world: TwinWorld, input: Record<string, unknown>): TwinEnvelope {
  const quoteId = String(input.quote_id ?? '');
  const groups = Array.isArray(input.groups) ? input.groups as Array<Record<string, unknown>> : [];
  const outGroups: Array<Record<string, unknown>> = [];
  let miss = false;
  for (const group of groups) {
    const arrival = String(group.arrival_date ?? '');
    const departure = String(group.departure_date ?? '');
    const roomsIn = Array.isArray(group.rooms) ? group.rooms as Array<Record<string, unknown>> : [];
    const rooms = [];
    for (const room of roomsIn) {
      const roomCode = String(
        object(room.preferred).roomCodes?.[0] ??
        object(room.required).roomCode ??
        room.room_type ??
        room.id ??
        'STQN',
      );
      const key = quoteKey(arrival, departure, String(roomCode));
      const hit = world.quotes.get(key) ?? world.quotes.get(quoteKey(arrival, departure, String(room.id ?? '')));
      if (!hit) {
        miss = true;
        world.coverage.quoteMisses += 1;
        rooms.push({room_id: String(room.id ?? '1'), option_count: 0, options: [], outcome: 'execution_failure'});
      } else {
        const options = Array.isArray(object(hit).options) ? object(hit).options as unknown[] : [hit];
        rooms.push({room_id: String(room.id ?? '1'), option_count: options.length, options, outcome: 'quote'});
      }
    }
    outGroups.push({
      group_id: String(group.group_id ?? 'g1'),
      arrival_date: arrival,
      departure_date: departure,
      status: miss ? 'incomplete' : 'complete',
      rooms,
    });
  }
  if (miss) {
    return fail('TWIN_NO_PRICE', 'No recorded native_quote capture for requested stay; twin never invents prices.', false, {
      quote_order: quoteId ? [quoteId] : [],
      quotes: quoteId ? {[quoteId]: {quote_id: quoteId, property_code: input.property_code, groups: outGroups}} : {},
      nightly_fields: ['amount', 'currency', 'date', 'inventory', 'price_status', 'restricted'],
    });
  }
  return ok({
    quote_order: quoteId ? [quoteId] : [],
    quotes: quoteId ? {[quoteId]: {quote_id: quoteId, property_code: input.property_code, groups: outGroups}} : {},
    searches: [],
    display_rows: [],
    nightly_fields: ['amount', 'currency', 'date', 'inventory', 'price_status', 'restricted'],
  });
}

function readReservation(world: TwinWorld, card: CaseCard, input: Record<string, unknown>): TwinEnvelope {
  const shown = projectHmsShown(world, card);
  const rid = String(input.reservation_id ?? '');
  if (!shown.exists || !shown.stay) return fail('CONFIRMATION_NOT_FOUND', 'Twin has no stay at as_of for this confirmation.');
  const confirmation = String(shown.stay.confirmation ?? shown.confirmation ?? '');
  if (rid && confirmation && rid !== confirmation && !confirmation.startsWith(rid.split('-')[0]!)) {
    return fail('CONFIRMATION_HINT_MISMATCH', 'Requested reservation does not match twin stay at as_of.');
  }
  return ok({
    outcome: 'ok',
    id: null,
    tool: 'read',
    record: {
      notes: [],
      details: {grids: [], fields: fieldMap(shown.stay)},
      documents: shown.documents,
    },
  });
}

function searchReservations(world: TwinWorld, card: CaseCard, input: Record<string, unknown>): TwinEnvelope {
  const criteria = object(input.criteria);
  const rid = criteria.reservation_id != null ? String(criteria.reservation_id) : '';
  const surname = String(criteria.guest_name ?? '').toLowerCase().trim();
  const candidates: Array<Record<string, unknown>> = [];

  // Explicit confirmation: resolve from world anchors (multi-conf cancel lists).
  if (rid) {
    const base = rid.split('-')[0]!;
    for (const anchor of world.anchors) {
      const conf = String(anchor.confirmation ?? '');
      if (conf === rid || conf.startsWith(`${base}-`) || conf === base) {
        const stay = {...object(anchor.hms_fields), confirmation: conf};
        candidates.push({
          reservation_id: conf,
          native: {
            ok: true,
            notes: [],
            method: 'twin',
            details: {cards: [{title: 'Stay', grids: [], fields: fieldMap(stay)}]},
          },
        });
        break;
      }
    }
  }

  // Guest surname search across anchors (cancel by guest list).
  if (!candidates.length && surname) {
    const needle = surname.split(/\s+/)[0]!;
    for (const anchor of world.anchors) {
      const guest = String(object(anchor.hms_fields).guestfullname ?? '').toLowerCase();
      if (!guest.includes(needle)) continue;
      const conf = String(anchor.confirmation ?? '');
      if (!conf) continue;
      candidates.push({
        reservation_id: conf,
        native: {
          ok: true,
          notes: [],
          method: 'twin',
          details: {cards: [{title: 'Stay', grids: [], fields: fieldMap({...object(anchor.hms_fields), confirmation: conf})}]},
        },
      });
      if (candidates.length >= 10) break;
    }
  }

  // Fall back to this case's as_of-projected stay.
  if (!candidates.length) {
    const shown = projectHmsShown(world, card);
    if (shown.exists && shown.stay && matchReservation(shown.stay, criteria)) {
      const confirmation = String(shown.stay.confirmation ?? shown.confirmation ?? '');
      candidates.push({
        reservation_id: confirmation,
        native: {
          ok: true,
          notes: [],
          method: 'twin',
          details: {cards: [{title: 'Stay', grids: [], fields: fieldMap(shown.stay)}]},
        },
      });
    }
  }

  if (!candidates.length) {
    return ok({outcome: 'not_found_in_searched_range', candidates: [], completeness: 'twin'});
  }
  return ok({outcome: 'candidates', candidates, completeness: 'twin'});
}

/** Twin = reads + unsaved Prepare only. No cassette. No Save/readback simulation. */
export function createTwinDispatch(world: TwinWorld, card: CaseCard) {
  return async function dispatch(name: string, input: unknown): Promise<TwinEnvelope> {
    const body = object(input);
    switch (name) {
      case 'hms_search_reservations':
        return searchReservations(world, card, body);
      case 'hms_read_reservation':
        return readReservation(world, card, body);
      case 'hms_read_catalogue': {
        const kinds = Array.isArray(body.kinds) ? body.kinds as string[] : [];
        const sections: Record<string, unknown> = {};
        for (const kind of kinds) sections[kind] = catalogueSection(world.catalog, kind);
        return ok({property_code: body.property_code ?? 'HRCEN', sections});
      }
      case 'hms_search_parties':
        // as_of blinding still applies to reservation/PDF projection; party lookup
        // mirrors prod (live catalogue rows only — no invented defaults/prior_stays).
        return searchParties(world, body);
      case 'hms_quote':
        return quoteFromWorld(world, body);
      case 'hms_prepare': {
        const shown = projectHmsShown(world, card);
        return ok({
          workflow: body.workflow ?? card.workflow,
          unsaved: true,
          booking_id: object(object(body).booking).id ?? 'stay-1',
          reservation_id: object(object(body).booking).reservation_id ?? card.real_confirmation ?? card.confirmation ?? null,
          native: {expected: shown.stay, twin: true},
          guest_candidates: [],
          rate_choices: [],
          room_choices: [],
          track_choices: [],
        });
      }
      case 'save':
      case 'hms_save':
        return fail('TWIN_NO_SAVE', 'Twin does not simulate Save/readback; staff Go is out of scope.');
      default:
        return fail('UNAVAILABLE', `Twin does not implement ${name}`);
    }
  };
}
