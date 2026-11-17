import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { schemas } from './schema.js';
import { proposalDraft, type ProposalDraft } from '../../src/schema.js';

export type ToolContext = { sessionId: string; mode: 'live' | 'labtest' | 'historical'; signal?: AbortSignal; propertyCode?: string | null; credentialLease?: unknown; staffStage?: { jobId: string; workflow: string } };
export type ToolResult = { ok: boolean; data: unknown; error: { code: string; message: string; retryable: boolean; outcome: 'known' | 'uncertain' } | null };
const fail = (code: string, message: string, retryable = false): ToolResult => ({ ok: false, data: null, error: { code, message, retryable, outcome: 'known' } });
const ok = (data: unknown): ToolResult => ({ ok: true, data, error: null });
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\r\n]/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const date = (value: unknown): value is string => str(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const nativeRoot = new URL('../../../server-pilot/tooling/hms-cloud/', import.meta.url);
const native = (name: string) => import(new URL(name, nativeRoot).href);

async function execute(context: ToolContext, action: () => Promise<ToolResult>): Promise<ToolResult> {
  if (context.mode === 'historical') return fail('HISTORICAL_HMS_DISABLED', 'Live HMS is unavailable in historical mode.');
  if (context.mode !== 'live' && context.mode !== 'labtest') return fail('INVALID_MODE', 'Unsupported tool mode.');
  if (context.signal?.aborted) return fail('ABORTED', 'HMS read aborted.');
  try {
    const result = await action();
    return context.signal?.aborted ? fail('ABORTED', 'HMS read aborted.') : result;
  } catch (error) {
    if (context.signal?.aborted) return fail('ABORTED', 'HMS read aborted.');
    if (obj(error) && error.code === 'ERR_MODULE_NOT_FOUND') return fail('NATIVE_DEPENDENCIES_UNAVAILABLE', 'Native HMS module dependencies are unavailable.');
    const raw = error instanceof Error ? error.message.split('\n')[0] : '';
    const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(raw) ? raw : 'HMS_READ_FAILED';
    return fail(code, 'Native HMS read failed; no result was inferred.', true);
  }
}

async function savedRead(property: string, confirmation: string, context: ToolContext, view: 'shallow' | 'record', hints: Record<string, unknown> = {}) {
  const { withSavedStayAgentSession } = await native('saved-stay-agent-session.mjs');
  return withSavedStayAgentSession(
    ({ runTool }: { runTool: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }) =>
      runTool({ tool: 'read', confirmation, view, ...hints }),
    { propertyCode: property, readOnly: true, readOnlyConfirmation: confirmation, signal: context.signal, credentialLease: context.credentialLease },
  );
}

async function verifyObservedDeparture(result: Record<string, unknown>, requested: string): Promise<'match' | 'mismatch' | 'unverified'> {
  const record = obj(result.record) ? result.record : {};
  const details = obj(record.details) ? record.details : {};
  const fields: unknown[] = Array.isArray(details.fields) ? details.fields : [];
  const departures = fields.filter(field => obj(field) && field.name === 'departuredate');
  if (departures.length !== 1 || !obj(departures[0]) || !str(departures[0].value)) return 'unverified';
  const { hmsDateToIso } = await native('cancel-stay-rules.mjs');
  const actual: unknown = hmsDateToIso(departures[0].value);
  return typeof actual !== 'string' ? 'unverified' : actual === requested ? 'match' : 'mismatch';
}

async function departureRefusal(result: Record<string, unknown>, requested: string | undefined): Promise<ToolResult | null> {
  if (!requested) return null;
  const comparison = await verifyObservedDeparture(result, requested);
  return comparison === 'match' ? null : fail(comparison === 'mismatch' ? 'CONFIRMATION_HINT_MISMATCH' : 'CONFIRMATION_HINT_UNVERIFIED',
    comparison === 'mismatch' ? 'The native departure differs from the requested date.' : 'Infor did not return one readable departure date.');
}

export async function searchReservations(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (!obj(input) || !keys(input, ['property_code', 'criteria']) || !str(input.property_code) || !obj(input.criteria) ||
      !keys(input.criteria, ['reservation_id', 'guest_name', 'arrival_date', 'departure_date'])) return fail('INVALID_INPUT', 'Property and valid search criteria are required.');
  const { reservation_id: id, guest_name: name, arrival_date: arrival, departure_date: departure } = input.criteria;
  if ((id !== undefined && !str(id)) || (name !== undefined && !str(name)) ||
      (arrival !== undefined && !date(arrival)) || (departure !== undefined && !date(departure))) return fail('INVALID_INPUT', 'Invalid search criterion.');
  if (!id && !name) return fail('INPUT_GAP', 'Provide a reservation identifier or surname.');
  if (id && !/^(?:\d+-\d+|\d{6,10})$/.test(id)) return fail('UNSUPPORTED_IDENTIFIER', 'Native reader requires a confirmation number.');
  if (!id && name && (name.includes(' ') || name.includes(','))) return fail('UNSUPPORTED_CRITERIA', 'Surname search requires the surname alone.');
  const property = input.property_code;
  return execute(context, async () => {
    if (id) {
      const result: Record<string, unknown> = await savedRead(property, id, context, departure ? 'record' : 'shallow', { guestName: name, arrivalDate: arrival });
      if (result.outcome === 'ok') {
        const refusal = await departureRefusal(result, departure);
        return refusal ?? ok({ outcome: 'candidates', candidates: [{ reservation_id: id, native: result.shallow }], completeness: result.completeness });
      }
      if (result.outcome === 'read_failed' && ['AMBIGUOUS_CONFIRMATION', 'CONFIRMATION_HINT_UNVERIFIED', 'CONFIRMATION_HINT_MISMATCH', 'SEARCH_RESULTS_CAPPED', 'CONFIRMATION_NOT_FOUND'].includes(String(result.issue))) {
        return ok({ outcome: result.issue === 'CONFIRMATION_NOT_FOUND' ? 'not_found_in_searched_range' : 'ambiguous_or_incomplete', native: result });
      }
      return fail(String(result.issue || 'HMS_READ_FAILED'), 'Native reservation search failed.', true);
    }
    const dir = await mkdtemp(join(tmpdir(), 'nava-hms-read-'));
    try {
      const { searchGuestInCloud } = await native('pane-guest-search.mjs');
      const { withCloudReadSession } = await native('cloud-session.mjs');
      const openSession = context.credentialLease ?
        (operation: unknown, options: Record<string, unknown>) => withCloudReadSession((page: unknown, identity: unknown) => {
          if (!identity || typeof operation !== 'function') throw new Error('GUEST_STAY_PROPERTY_UNVERIFIED');
          return operation(page, identity);
        }, { ...options, credentialLease: context.credentialLease }) : undefined;
      const result: Record<string, unknown> = await searchGuestInCloud({ propertyCode: property, lastName: name, arrival, departure, dir }, { signal: context.signal, ...(openSession ? { openSession } : {}) });
      const { screenshots: _screenshots, unreadableRows: _unreadableRows, ...publicResult } = result;
      if (!['ok', 'ambiguous_capped'].includes(String(result.outcome))) return fail('HMS_SEARCH_INCOMPLETE', 'Native surname search failed or returned unreadable rows.', true);
      return ok({ outcome: result.outcome === 'ambiguous_capped' ? 'incomplete' : 'candidates', native: publicResult });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

const lookupText = z.string().trim().min(1).max(256).regex(/^[^\r\n]+$/);
const optionalText = lookupText.nullable().optional().transform(value => value ?? undefined);
const optionalDate = z.string().date().nullable().optional().transform(value => value ?? undefined);
const stageLookup = z.object({
  reservation_id: optionalText, guest_name: optionalText,
  arrival_date: optionalDate, departure_date: optionalDate,
}).strict().refine(value => !!value.reservation_id || !!value.guest_name);
const stageInput = z.object({
  workflow: z.literal('triage'), booking: z.object({ id: z.string().min(1) }).passthrough().nullable(),
  action: z.object({ type: z.literal('triage'), details: z.object({ lookup: stageLookup }).passthrough() }).passthrough(),
}).strict();

export function withTriageLookupFields(draft: ProposalDraft): ProposalDraft {
  if (draft.workflow !== 'triage' || draft.actions.length !== 1 || draft.actions[0].type !== 'triage') return draft;
  const action = draft.actions[0];
  if (action.details !== null && !obj(action.details)) return draft;
  const details = obj(action.details) ? { ...action.details } : {};
  if (details.lookup !== undefined && details.lookup !== null && !obj(details.lookup)) return draft;
  const lookup: Record<string, unknown> = obj(details.lookup) ? { ...details.lookup } : {};
  const definitions = [
    ['reservation_id', 'Confirmation number', 'text'], ['guest_name', 'Guest surname or name', 'text'],
    ['arrival_date', 'Arrival date', 'date'], ['departure_date', 'Departure date', 'date'],
  ] as const;
  const fieldSpecs = [...draft.field_specs];
  for (const [key, label, control] of definitions) {
    if (!Object.hasOwn(lookup, key)) lookup[key] = null;
    const path = `/actions/0/details/lookup/${key}`;
    const existing = fieldSpecs.findIndex(field => field.path === path || field.path === path.slice(1));
    if (existing >= 0) fieldSpecs[existing] = { ...fieldSpecs[existing], editable: true };
    else fieldSpecs.push({ path, label, control, provenance: 'unknown', editable: true,
      required: false, error: null, options: [], evidence: [] });
  }
  return proposalDraft.parse({ ...draft, actions: [{ ...action, details: { ...details, lookup } }], field_specs: fieldSpecs });
}

/** Staff job: use only the revision-pinned lookup and the launcher's admitted read lease. */
export async function stageRead(input: unknown, context: ToolContext): Promise<ToolResult> {
  const parsed = stageInput.safeParse(input);
  if (!parsed.success) return fail('INPUT_GAP', 'Provide a reservation number or surname in the lookup.');
  if (context.mode === 'historical') return fail('HISTORICAL_HMS_DISABLED', 'Live HMS is unavailable in historical mode.');
  if (!context.propertyCode || !context.credentialLease || !context.staffStage?.jobId || context.staffStage.workflow !== 'triage') {
    return fail('STAFF_READ_CONTEXT_REQUIRED', 'A staff read job with an admitted HMS lease is required.');
  }
  const lookup = parsed.data.action.details.lookup;
  const property = context.propertyCode;
  if (!lookup.reservation_id) {
    const result = await searchReservations({ property_code: property, criteria: lookup }, context);
    if (!result.ok || !obj(result.data) || !obj(result.data.native)) return result;
    const native = result.data.native;
    const rows: unknown[] = Array.isArray(native.rows) ? native.rows : [];
    const matches = rows.filter(row => obj(row) && str(row.lastName) &&
      row.lastName.toLocaleLowerCase() === lookup.guest_name?.toLocaleLowerCase() &&
      (!lookup.arrival_date || row.arrival === lookup.arrival_date) &&
      (!lookup.departure_date || row.departure === lookup.departure_date));
    return ok({ outcome: result.data.outcome, candidates: matches.slice(0, 25),
      coverage: { completeness: native.completeness ?? null, records: native.records ?? null, candidates_truncated: matches.length > 25 },
      observed_fields: {}, display_rows: [] });
  }
  const reservationId = lookup.reservation_id;
  if (!/^(?:\d+-\d+|\d{6,10})$/.test(reservationId)) return fail('UNSUPPORTED_IDENTIFIER', 'Native reader requires a confirmation number.');
  return execute(context, async () => {
    const result: Record<string, unknown> = await savedRead(property, reservationId, context, 'record',
      { guestName: lookup.guest_name, arrivalDate: lookup.arrival_date });
    if (result.outcome !== 'ok') {
      return { ok: false, data: { outcome: 'not_uniquely_read', coverage: result.completeness ?? null },
        error: { code: str(result.issue) && /^[A-Z][A-Z0-9_]{2,100}$/.test(result.issue) ? result.issue : 'HMS_READ_INCOMPLETE', message: 'Infor did not uniquely read the requested stay.', retryable: false, outcome: 'known' } };
    }
    const refusal = await departureRefusal(result, lookup.departure_date);
    if (refusal) return refusal;
    const record = obj(result.record) ? result.record : {};
    const details = obj(record.details) ? record.details : {};
    const fields = Array.isArray(details.fields) ? details.fields : [];
    const statuses = fields.filter((field: unknown) => obj(field) && field.name === 'status' && str(field.value));
    const status = statuses.length === 1 && obj(statuses[0]) && str(statuses[0].value) ? statuses[0].value : null;
    const data = { outcome: 'uniquely_read', observed_fields: { stay: result.shallow ?? null, status },
      coverage: { completeness: result.completeness ?? null, searched_ranges: result.searchedRanges ?? null },
      display_rows: status ? [{ id: 'status', booking_id: parsed.data.booking?.id ?? null, kind: 'text', label: 'Reservation status', value: status, native_path: '/observed_fields/status' }] : [] };
    if (!status) return { ok: false, data, error: { code: 'STATUS_UNAVAILABLE', message: 'Infor did not return one readable reservation status.', retryable: false, outcome: 'known' } };
    return ok(data);
  });
}

export async function readReservation(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (!obj(input) || !keys(input, ['property_code', 'reservation_id']) || !str(input.property_code) || !str(input.reservation_id)) return fail('INVALID_INPUT', 'Property and reservation identifier are required.');
  if (!/^(?:\d+-\d+|\d{6,10})$/.test(input.reservation_id)) return fail('UNSUPPORTED_IDENTIFIER', 'Native reader requires a confirmation number.');
  const property = input.property_code, id = input.reservation_id;
  return execute(context, async () => {
    const result: Record<string, unknown> = await savedRead(property, id, context, 'record');
    if (result.outcome === 'ok') return ok(result);
    if (['AMBIGUOUS_CONFIRMATION', 'CONFIRMATION_HINT_UNVERIFIED', 'CONFIRMATION_HINT_MISMATCH', 'SEARCH_RESULTS_CAPPED', 'CONFIRMATION_NOT_FOUND'].includes(String(result.issue))) return ok({ outcome: 'not_uniquely_read', native: result });
    return fail(String(result.issue || 'HMS_READ_FAILED'), 'Native reservation read failed.', true);
  });
}

const catalogueKinds: Record<string, string> = { room_type: 'roomTypes', rate_plan: 'ratePlans', source_of_business: 'sourceBusiness', track: 'trackSubsegment', guarantee_type: 'guaranteeTypes', organization: 'organizations', agency: 'agencies' };
export async function readCatalogue(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (!obj(input) || !keys(input, ['property_code', 'kinds']) || !str(input.property_code) || !Array.isArray(input.kinds) || !input.kinds.length ||
      input.kinds.some(kind => typeof kind !== 'string' || !Object.hasOwn(catalogueKinds, kind) && kind !== 'meal_plan')) return fail('INVALID_INPUT', 'Property and supported catalogue kinds are required.');
  const property = input.property_code, kinds: string[] = input.kinds;
  return execute(context, async () => {
    const { loadHmsNativeCatalog, nativeCatalogReadOptions } = await native('hms-native-catalog.mjs');
    const loaded = await loadHmsNativeCatalog(nativeCatalogReadOptions({ propertyCode: property }));
    const sections: Record<string, unknown> = {};
    for (const kind of kinds) {
      if (context.signal?.aborted) throw new Error('ABORTED');
      try {
        if (kind === 'meal_plan') { sections[kind] = { status: 'unsupported', reason: 'No independent native meal-plan catalogue.' }; continue; }
        const entry = loaded.status === 'available' ? loaded.catalog.catalogs[catalogueKinds[kind]] : undefined;
        if (entry) {
          sections[kind] = { ...entry, status: loaded.catalog.schemaVersion === 'hms-native-catalogs/v2' && entry.coverage.complete && entry.scope.wholeCatalogComplete ? 'available' : 'partial', captured_at: loaded.catalog.capturedAt };
          continue;
        }
        const roomRateTool = kind === 'room_type' ? 'searchRoomTypes' : kind === 'rate_plan' ? 'searchRatePlans' : null;
        if (roomRateTool) {
          const { withCloudRoomRateReadSession } = await native('hms-lookup-read-session.mjs');
          const result: Record<string, unknown> = await withCloudRoomRateReadSession(roomRateTool,
            ({ runTool }: { runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }) => runTool({ tool: roomRateTool, query: '', limit: 100 }),
            { propertyCode: property, signal: context.signal });
          sections[kind] = { status: ['matches', 'no_match'].includes(String(result.outcome)) ? 'partial' : 'unavailable', native: result };
        } else if (kind === 'source_of_business' || kind === 'guarantee_type') {
          const { withCloudLookupReadSession } = await native('hms-lookup-read-session.mjs');
          const result: Record<string, unknown> = await withCloudLookupReadSession(
            ({ runTool }: { runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }) => runTool(kind === 'source_of_business' ?
              { tool: 'searchGuestStaySourceBusiness', query: '' } : { tool: 'listGuestStayDropdown', field: 'guaranteeType' }),
            { propertyCode: property, signal: context.signal });
          sections[kind] = { status: ['matches', 'no_match', 'ok'].includes(String(result.outcome)) ? 'partial' : 'unavailable', native: result };
        } else sections[kind] = { status: 'unavailable', reason: loaded.status === 'available' ? 'kind_not_captured' : loaded.issue };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        sections[kind] = { status: 'unavailable', reason: obj(error) && error.code === 'ERR_MODULE_NOT_FOUND' ? 'native_dependencies_unavailable' : 'native_read_failed' };
      }
    }
    return ok({ property_code: property, sections });
  });
}

const partyFields: Record<string, Record<string, string>> = {
  guest: { last_name: 'lastName', first_name: 'firstName', email: 'email', phone: 'phoneNumber', profile_id: 'profileId' },
  organization: { name: 'name' }, agency: { name: 'name' }, ar_account: { name: 'name' },
};
export async function searchParties(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (!obj(input) || !keys(input, ['property_code', 'kind', 'field', 'query']) || !str(input.property_code) || !str(input.kind) || !str(input.field) || !str(input.query) || !Object.hasOwn(partyFields, input.kind) || !Object.hasOwn(partyFields[input.kind], input.field)) return fail('INVALID_INPUT', 'Property, supported party kind, field and query are required.');
  const property = input.property_code, kind = input.kind, field = partyFields[kind][input.field], query = input.query;
  return execute(context, async () => {
    const { withCloudLookupReadSession } = await native('hms-lookup-read-session.mjs');
    const result: Record<string, unknown> = await withCloudLookupReadSession(
      ({ runTool }: { runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }) =>
        runTool(kind === 'guest' ? { tool: 'searchGuestProfiles', field, query } :
          { tool: kind === 'organization' ? 'searchOrganization' : kind === 'agency' ? 'searchPrimaryBookingAgency' : 'searchArAccount', query }),
      { propertyCode: property, signal: context.signal },
    );
    if (!['matches', 'no_match', 'ambiguous', 'resolved', 'incomplete'].includes(String(result.outcome))) return fail(String(result.issue || 'PARTY_SEARCH_FAILED'), 'Native party search failed.', true);
    return ok({ native: result, selection: 'none', ambiguity: 'Candidates require explicit selection; incomplete coverage may hide additional matches.' });
  });
}

export const tools = [
  { name: 'hms_search_reservations', description: 'Search native reservation candidates without selecting a booking.', input_schema: schemas.hms_search_reservations, run: searchReservations },
  { name: 'hms_read_reservation', description: 'Read a fresh uniquely identified native saved reservation.', input_schema: schemas.hms_read_reservation, run: readReservation },
  { name: 'hms_read_catalogue', description: 'Read native catalogue codes and meanings with explicit coverage.', input_schema: schemas.hms_read_catalogue, run: readCatalogue },
  { name: 'hms_search_parties', description: 'Search native guest, organization, agency or A/R candidates without linking.', input_schema: schemas.hms_search_parties, run: searchParties },
];
