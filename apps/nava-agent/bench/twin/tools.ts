import {isDeepStrictEqual} from 'node:util';
import type {CaseCard, TwinEnvelope} from '../types.js';
import {projectHmsShown} from './backdate.js';
import {quoteKey, type TwinWorld} from './world.js';

export type TwinMode = 'twin' | 'cassette';

const ok = <T>(data: T): TwinEnvelope<T> => ({ok: true, data, error: null});
const fail = (code: string, message: string, retryable = false, data: unknown = null): TwinEnvelope => ({
  ok: false,
  data,
  error: {code, message, retryable, outcome: 'known'},
});

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

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

function catalogueSection(catalog: Record<string, unknown>, kind: string): Record<string, unknown> {
  const catalogs = object(catalog.catalogs ?? catalog);
  const keyMap: Record<string, string[]> = {
    room_type: ['roomTypes', 'room_type', 'roomType'],
    rate_plan: ['ratePlans', 'rate_plan', 'ratePlan'],
    meal_plan: ['mealPlans', 'meal_plan', 'mealPlan'],
    source_of_business: ['sourceBusiness', 'sourcesOfBusiness', 'source_of_business'],
    track: ['tracks', 'track'],
    guarantee_type: ['guaranteeTypes', 'guarantee_type'],
    organization: ['organizations', 'organization', 'orgs'],
    agency: ['agencies', 'agency'],
  };
  for (const key of keyMap[kind] ?? [kind]) {
    if (Array.isArray(catalogs[key])) return {items: catalogs[key], coverage: 'complete'};
    if (Array.isArray((catalogs as Record<string, unknown>)[key])) return {items: (catalogs as Record<string, unknown>)[key], coverage: 'complete'};
  }
  // flat lists on root
  for (const key of keyMap[kind] ?? []) {
    if (Array.isArray(catalog[key])) return {items: catalog[key], coverage: 'complete'};
  }
  if (kind === 'meal_plan') return {status: 'unsupported', reason: 'No independent native meal-plan catalogue.'};
  return {status: 'unavailable', reason: 'catalog_path_or_property_missing'};
}

function searchParties(world: TwinWorld, input: Record<string, unknown>): TwinEnvelope {
  const kind = String(input.kind ?? 'guest');
  const field = String(input.field ?? 'last_name');
  const query = String(input.query ?? '').toLowerCase();
  const candidates: Array<Record<string, unknown>> = [];
  if (kind === 'guest') {
    for (const profile of world.profiles) {
      const first = String(profile.firstName ?? profile.first_name ?? '').toLowerCase();
      const last = String(profile.lastName ?? profile.last_name ?? '').toLowerCase();
      const email = String(profile.email ?? '').toLowerCase();
      const id = String(profile.nativeId ?? profile.profile_id ?? profile.guestid ?? '');
      const hay =
        field === 'first_name' ? first :
        field === 'email' ? email :
        field === 'profile_id' ? id.toLowerCase() :
        last;
      if (!query || hay.includes(query) || `${last} ${first}`.includes(query)) {
        candidates.push({
          nativeId: id || `twin-guest-${candidates.length + 1}`,
          firstName: profile.firstName ?? profile.first_name ?? null,
          lastName: profile.lastName ?? profile.last_name ?? null,
          name: `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim() || null,
        });
      }
      if (candidates.length >= 25) break;
    }
  }
  return ok({
    native: {
      outcome: candidates.length ? 'candidates' : 'not_found',
      criteria: {kind, field, query: input.query},
      candidates,
      coverage: 'twin',
    },
    selection: candidates.length === 1 ? 'candidate' : 'none',
    ambiguity: candidates.length > 1,
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

function cassetteReplay(card: CaseCard, name: string, input: unknown): TwinEnvelope | null {
  const pairs = card.cassette ?? card.recorded_calls ?? card.tool_pairs ?? [];
  for (const pair of pairs) {
    const tool = pair.tool ?? pair.name;
    if (tool !== name) continue;
    if (!isDeepStrictEqual(pair.input, input)) continue;
    const result = pair.result ?? pair.response;
    if (result && typeof result === 'object' && result !== null && 'ok' in result) return result as TwinEnvelope;
    return ok(result);
  }
  return null;
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
  const shown = projectHmsShown(world, card);
  const criteria = object(input.criteria);
  if (!shown.exists || !shown.stay) {
    return ok({outcome: 'not_found_in_searched_range', candidates: [], completeness: 'twin'});
  }
  if (!matchReservation(shown.stay, criteria)) {
    return ok({outcome: 'not_found_in_searched_range', candidates: [], completeness: 'twin'});
  }
  const confirmation = String(shown.stay.confirmation ?? shown.confirmation ?? '');
  return ok({
    outcome: 'candidates',
    candidates: [{
      reservation_id: confirmation,
      native: {
        ok: true,
        notes: [],
        method: 'twin',
        details: {cards: [{title: 'Stay', grids: [], fields: fieldMap(shown.stay)}]},
      },
    }],
    completeness: 'twin',
  });
}

export function createTwinDispatch(world: TwinWorld, card: CaseCard, mode: TwinMode = 'twin') {
  return async function dispatch(name: string, input: unknown): Promise<TwinEnvelope> {
    if (mode === 'cassette') {
      const hit = cassetteReplay(card, name, input);
      if (hit) return hit;
      return fail('CASSETTE_MISS', `No recorded pair for ${name}`);
    }
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
        return searchParties(world, body);
      case 'hms_quote':
        return quoteFromWorld(world, body);
      case 'hms_prepare': {
        const shown = projectHmsShown(world, card);
        return ok({
          workflow: body.workflow ?? card.workflow,
          unsaved: true,
          booking_id: object(object(body).booking).id ?? 'stay-1',
          native: {expected: shown.stay, twin: true},
          guest_candidates: [],
          rate_choices: [],
          room_choices: [],
          track_choices: [],
        });
      }
      case 'save':
      case 'hms_save':
        return ok(world.save(input));
      default:
        return fail('UNAVAILABLE', `Twin does not implement ${name}`);
    }
  };
}
