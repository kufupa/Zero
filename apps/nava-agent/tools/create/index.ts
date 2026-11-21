import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareInput, saveInput, type CreateInput } from './schema.js';
import { createGoEnabled, createGoRealGuests, hmsSaveEnabled } from '../../src/hms-mode.js';
import { attachmentsUnconfirmed, confirmedQueuedCreate, type StaffStage } from '../../src/attachment-gate.js';

export type ToolContext = { sessionId: string; mode: 'live' | 'labtest' | 'historical'; signal?: AbortSignal; staffStage?:StaffStage; credentialLease?:Lease };
type SaveContext = ToolContext & { markDispatched(details: unknown): Promise<void> };
type ToolResult = { ok: boolean; data: unknown; error: { code: string; message: string; retryable: boolean; outcome: 'known' | 'uncertain' } | null };

// hms_prepare is a shared dispatcher; mutation packs must not register hms_save.
export const tools: { name: string; description: string; input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }; run(input: unknown, context: ToolContext): Promise<ToolResult> }[] = [];

const nativeResult = z.object({
  outcome: z.string(), issue: z.string().optional(), applied: z.record(z.unknown()).optional(),
  appliedVerification: z.object({ visibleFields: z.boolean().optional() }).passthrough().optional(),
  requestBinding: z.object({ digest: z.string(), request: z.unknown(), arAccountProfileId: z.string().optional() }).passthrough().optional(),
  ratePlanAvailability: z.record(z.unknown()).optional(),
  confirmation: z.string().nullable().optional(), nativeStayId: z.string().optional(),
  writerSessionClosed: z.boolean().optional(),
  save: z.object({ dispatchCallbacksDrained: z.boolean().optional(), browserSendRequests: z.number().optional() }).passthrough().optional(),
  readback: z.object({ mismatches: z.array(z.unknown()).optional() }).passthrough().optional(),
}).passthrough();
const stagedBinding = z.object({
  propertyCode: z.literal('HRCEN'),
  guest: z.object({ nativeId: z.string().regex(/^\d+$/), firstName: z.string(), lastName: z.string() }).passthrough(),
  stay: z.object({ arrival: z.string(), departure: z.string() }).passthrough(),
  note: z.string(),
  sendHmsConfirmation: z.union([z.object({ kind: z.literal('never') }).strict(), z.object({ kind: z.literal('send'), recipient: z.string() }).strict()]),
}).passthrough();
const sameName = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
type NativeResult = z.infer<typeof nativeResult>;
type NativeRequest = Record<string, unknown> & { propertyCode: string; guest: Record<string, unknown>; stay: Record<string, unknown>; room: Record<string, unknown> };
type Lease = { signal: AbortSignal };
type NativeApi = {
  createReservation(input: unknown, options: unknown): Promise<unknown>;
  withCloudCredentialLease<T>(property: string, operation: (lease: Lease) => Promise<T>, options: unknown): Promise<T>;
  createCloudTargetKey(guest: { firstName: string; lastName: string }, arrival: string, property: string): string | null;
  getPropertyRegistration(property: string): unknown;
};

const labGuest = { firstName: 'Proof', lastName: 'Labtest' };
const fail = (code: string, message: string, outcome: 'known' | 'uncertain' = 'known', data: unknown = null): ToolResult =>
  ({ ok: false, data, error: { code, message, retryable: false, outcome } });
const success = (data: unknown): ToolResult => ({ ok: true, data, error: null });

async function nativeApi(): Promise<NativeApi> {
  const base = new URL('../../../server-pilot/tooling/hms-cloud/', import.meta.url);
  const [create, cloud, policy, properties] = await Promise.all([
    import(new URL('create-reservation.mjs', base).href),
    import(new URL('cloud-session.mjs', base).href),
    import(new URL('cloud-create-policy.mjs', base).href),
    import(new URL('property-registry.mjs', base).href),
  ]);
  return { createReservation: create.createReservation, withCloudCredentialLease: cloud.withCloudCredentialLease,
    createCloudTargetKey: policy.createCloudTargetKey, getPropertyRegistration: properties.getPropertyRegistration };
}

function transport(api: NativeApi, property: string): string | null {
  const registration = api.getPropertyRegistration(property);
  if (!object(registration) || registration.active !== true || typeof registration.mailboxTransportId !== 'string' ||
      !Array.isArray(registration.transportIds) || !registration.transportIds.includes(registration.mailboxTransportId)) return null;
  return registration.mailboxTransportId;
}

// These names are the backend contract's business fields, not inferred HMS codes.
const fieldPaths: Record<string, readonly string[]> = {
  guest_profile_id: ['guest', 'profileId'], first_name: ['guest', 'search', 'firstName'],
  last_name: ['guest', 'search', 'lastName'], guest_email: ['guest', 'search', 'email'],
  arrival_date: ['stay', 'arrival'], departure_date: ['stay', 'departure'], adults: ['stay', 'adults'],
  children: ['stay', 'childCount'], child_count: ['stay', 'childCount'], child_ages: ['stay', 'childAges'],
  room_type: ['room', 'roomType'], room_type_for_charge: ['room', 'roomTypeForCharge'], rate_plan: ['room', 'ratePlan'],
  guarantee_type: ['guaranteeType'], source_of_business: ['sourceOfBusiness'], reason_for_stay: ['reasonForStay'],
  track: ['track'], market_segment: ['marketSegment'], guest_opt_in: ['guestoptin4'],
  reservation_note: ['note'], note: ['note'], billing_reference: ['billingReference'], commission_percent: ['taCommission'],
  organization_id: ['parties', 'organizationId'], organization_name: ['parties', 'organizationName'],
  agency_id: ['parties', 'agencyId'], agency_name: ['parties', 'agencyName'],
  ar_account_id: ['parties', 'arAccountId'], ar_account_name: ['parties', 'arAccountName'],
  booker_name: ['booker', 'name'], booker_contact: ['booker', 'contact'],
  cms_send: ['cms', 'send'], cms_message_id: ['cms', 'messageId'], cms_recipient: ['cms', 'recipient'],
  price: ['price'], confirmation_recipient: ['confirmationRecipient'],
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildRequest(input: CreateInput): { request: NativeRequest; unknown: string[]; expectedGuest?: { firstName: string; lastName: string } } | ToolResult {
  const { booking, action } = input;
  if (!booking.property_code || booking.reservation_id !== null || booking.current_state !== null ||
      action.type !== 'create' || !action.booking_ids.includes(booking.id)) {
    return fail('INVALID_CREATE_TARGET', 'Create requires a new booking, property, and a matching create action.');
  }
  if (action.details !== null && (!object(action.details) || Object.keys(action.details).length !== 0)) {
    return fail('UNSUPPORTED_ACTION_DETAILS', 'Create action details must be expressed as booking fields.');
  }
  const request: NativeRequest = { propertyCode: booking.property_code, guest: {}, stay: {}, room: {} };
  const unknown: string[] = [];
  const assigned = new Set<string>();
  for (const [field, value] of Object.entries(booking.fields)) {
    if (field === 'room_count' || field === 'board' || field.startsWith('profile_') || value === null) continue;
    const path = Object.hasOwn(fieldPaths, field) ? fieldPaths[field] : undefined;
    if (!path) { unknown.push(field); continue; }
    const key = path.join('.');
    if (assigned.has(key)) return fail('DUPLICATE_CREATE_FIELD', `Multiple fields map to ${key}.`);
    assigned.add(key);
    let target: Record<string, unknown> = request;
    for (const part of path.slice(0, -1)) {
      if (!(part in target)) target[part] = {};
      if (!object(target[part])) return fail('INVALID_CREATE_FIELD', `Invalid ${field}.`);
      target = target[part];
    }
    target[path[path.length - 1]] = value;
  }
  const firstName = booking.fields.first_name;
  const lastName = booking.fields.last_name;
  const expectedGuest = typeof firstName === 'string' && typeof lastName === 'string' && firstName && lastName
    ? { firstName, lastName } : undefined;
  // A chosen native ID and name can coexist in the proposal; the native request
  // selects by ID and verifies the supplied name separately.
  if ('profileId' in request.guest && 'search' in request.guest) {
    if (!expectedGuest) return fail('GUEST_IDENTITY_CONFLICT', 'Profile ID requires matching first and last name.');
    delete request.guest.search;
  }
  return { request, unknown, ...(expectedGuest ? { expectedGuest } : {}) };
}

function bounded(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > 512_000) throw new Error('NATIVE_RESULT_TOO_LARGE');
  return JSON.parse(json);
}

function guestChoices(result: NativeResult) {
  const candidates = result.guestCandidates;
  const coverage = result.guestCoverage;
  if (!Array.isArray(candidates) || !object(coverage)) return {status:'unavailable',items:[],coverage:null};
  const text = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\r\n\p{Cc}]/u.test(value) ? value : null;
  const items = candidates.flatMap(value => {
    if (!object(value)) return [];
    const nativeId = typeof value.nativeId === 'string' && /^\d{1,100}$/.test(value.nativeId) ? value.nativeId : null;
    const firstName = text(value.firstName), lastName = text(value.lastName);
    if (!nativeId || !firstName || !lastName) return [];
    return [{native_id:nativeId,first_name:firstName,last_name:lastName,city:text(value.city),country:text(value.country)}];
  });
  const shown = items.slice(0,30);
  const truncated = shown.length !== candidates.length;
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const loaded = count(coverage.loaded), total = count(coverage.total);
  const complete = coverage.possiblyTruncated === false && loaded !== null && total === loaded &&
    candidates.length === loaded && !truncated;
  return {status:'available',items:shown,coverage:{loaded,total,complete,possibly_truncated:!complete,
    returned:shown.length,truncated}};
}

// Use the native rate shop for the same stay and party; its rows are observations,
// not a claim that a particular rate is the customer's contract.
async function scopedRateChoices(request: NativeRequest, lease: Lease, transportId: string, roomType?: string, sellableOnly = false) {
  const unavailable = {status:'unavailable',items:[],coverage:null};
  const noChoices = {rateChoices:unavailable,roomChoices:unavailable};
  const {arrival, departure, adults, childAges} = request.stay;
  const childCount = request.stay.childCount ?? (Array.isArray(childAges) ? childAges.length : undefined);
  if (typeof arrival !== 'string' || typeof departure !== 'string' ||
      !Number.isInteger(adults) || !Number.isInteger(childCount) || !Array.isArray(childAges) ||
      childAges.length !== childCount || !childAges.every(Number.isInteger)) return noChoices;
  const parties = object(request.parties) ? request.parties : {};
  if (parties.arAccountId != null || parties.arAccountName != null) return noChoices;
  const rateContext: Record<string, {nativeId:string;name:string}> = {};
  for (const [kind,idKey,nameKey] of [
    ['bookingAgency','agencyId','agencyName'], ['organization','organizationId','organizationName'],
  ] as const) {
    const id = parties[idKey], name = parties[nameKey];
    if (id == null && name == null) continue;
    if (typeof id !== 'string' || !/^\d+$/.test(id) || typeof name !== 'string' || !name.trim()) return noChoices;
    rateContext[kind] = {nativeId:id,name:name.trim()};
  }
  const shopRequest = {schemaVersion:2,propertyCode:request.propertyCode,arrivalDate:arrival,departureDate:departure,
    rooms:[{id:'create',quantity:1,adults,children:childCount,childAges,
      ...(roomType ? {required:{roomCodes:[roomType]}} : {})}],
    ...(Object.keys(rateContext).length ? {rateContext} : {}),
    search:{includeAlternatives:false,includeRestricted:sellableOnly},details:'summary',maxOptionsPerGroup:200};
  try {
    const base = new URL('../../../server-pilot/tooling/hms-cloud/', import.meta.url);
    const {fetchQuote} = await import(new URL('fetch-quote.mjs', base).href);
    const quote: unknown = await fetchQuote({request:shopRequest,propertyCode:request.propertyCode,transportId,
      credentialLease:lease,signal:lease.signal});
    lease.signal.throwIfAborted();
    if (!object(quote) || quote.propertyCode !== request.propertyCode ||
        !Array.isArray(quote.groups) || quote.groups.length !== 1 || !object(quote.groups[0])) return noChoices;
    const group = quote.groups[0], completeness = group.completeness;
    if (group.id !== 'create' || !object(completeness) || completeness.search !== 'complete' ||
        !Array.isArray(group.options) || !Array.isArray(group.applied) ||
        !group.applied.length || !object(group.resolvedContext)) return noChoices;
    for (const [kind,idKey] of [['bookingAgency','travelAgencyID'],['organization','organizationID']] as const) {
      const expected = rateContext[kind]?.nativeId ?? '';
      const resolved = group.resolvedContext[kind];
      if (expected && (!object(resolved) || resolved.id !== expected)) return noChoices;
      if (group.applied.some(row => !object(row) || String(row[idKey] ?? '') !== expected)) return noChoices;
    }
    if (group.applied.some(row => !object(row) || row.propertyCodes !== request.propertyCode ||
        row.adultCount !== adults || row.childCount !== childCount ||
        JSON.stringify(row.childAges === undefined && childCount === 0 ? [] : row.childAges) !== JSON.stringify(childAges))) return noChoices;
    const choices = new Map<string,{value:string;label:string;meaning:string;room_type:string;rate_scope:string;eligibility:string;availability:string}>();
    const rooms = new Map<string,{value:string;label:string;meaning:string}>();
    for (const option of group.options) {
      if (!object(option) || !object(option.rate) || !object(option.room) || option.eligibility !== 'verified' ||
          (sellableOnly && (option.matchStatus !== 'match' || option.availability !== 'available' || option.rate.code === request.room.ratePlan)) ||
          typeof option.rate.code !== 'string' || !/^[A-Z0-9_-]{1,100}$/.test(option.rate.code) ||
          typeof option.rate.label !== 'string' || !option.rate.label.trim() || option.rate.label.length > 200 ||
          /[\r\n\p{Cc}]/u.test(option.rate.label) || typeof option.room.code !== 'string' ||
          !/^[A-Z0-9_-]{1,100}$/.test(option.room.code) || (roomType && option.room.code !== roomType) ||
          !['public','contextual','unknown'].includes(String(option.rateScope)) ||
          !['available','unavailable','restricted','unknown'].includes(String(option.availability))) continue;
      const value = option.rate.code, meaning = [option.rate.label.trim(),
        typeof option.mealPlan === 'string' ? option.mealPlan : null].filter(Boolean).join(' · ');
      const choice = {value,label:value,meaning,room_type:option.room.code,rate_scope:String(option.rateScope),eligibility:option.eligibility,
        availability:String(option.availability)};
      choices.set(JSON.stringify(choice),choice);
      if (/^[A-Z0-9]{1,12}$/.test(option.room.code)) {
        const name = typeof option.room.label === 'string' ? option.room.label.trim() : '';
        rooms.set(option.room.code,{value:option.room.code,label:option.room.code,meaning:name});
      }
    }
    const all = [...choices.values()], items = all.slice(0,50);
    const truncated = completeness.optionsTruncated !== false || completeness.matchingRowsUnseen !== false || items.length !== all.length;
    const soldOut = sellableOnly && !!roomType && !truncated && group.options.length > 0 &&
      group.options.every(option => object(option) && object(option.room) &&
        option.room.code === roomType && option.availability === 'unavailable');
    if (sellableOnly && !items.length && !soldOut) return noChoices;
    const roomItems = [...rooms.values()].slice(0,50);
    return {rateChoices:{status:soldOut?'sold_out':'available',items,coverage:{complete:!truncated,possibly_truncated:truncated,
      returned:items.length,source_options:completeness.sourceOptions,examined_options:completeness.examinedOptions}},
      roomChoices:{status:'available',items:roomItems,coverage:{complete:!truncated && roomItems.length === rooms.size,
        possibly_truncated:truncated || roomItems.length !== rooms.size,returned:roomItems.length}}};
  } catch (error) {
    if (lease.signal.aborted) throw error;
    return noChoices;
  }
}

function nativeRoomChoices(result: NativeResult, shop: Awaited<ReturnType<typeof scopedRateChoices>>['roomChoices']) {
  const choices = new Map<string,{value:string;label:string;meaning:string}>();
  if (result.issue === 'room_type_not_unique' && Array.isArray(result.roomCandidates)) {
    for (const candidate of result.roomCandidates) {
      if (!object(candidate) || typeof candidate.code !== 'string' || !/^[A-Z0-9]{1,12}$/.test(candidate.code) ||
          typeof candidate.nativeId !== 'string' || !candidate.nativeId || !object(candidate.gridData)) continue;
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      choices.set(candidate.code,{value:candidate.code,label:candidate.code,meaning:name});
    }
  }
  for (const choice of shop.items) choices.set(choice.value,choice);
  if (!choices.size) return shop;
  const items = [...choices.values()].slice(0,50);
  return {status:'available',items,coverage:{complete:false,possibly_truncated:true,returned:items.length}};
}

async function loadNativeResult(api: NativeApi, request: NativeRequest, options: Record<string, unknown>): Promise<NativeResult> {
  return nativeResult.parse(await api.createReservation(request, options));
}

function leaseDatabase(): string | undefined {
  // Must point at the existing native admission database, shared with all HMS users.
  // The rewrite's DATABASE_URL is deliberately not used as a fallback.
  return process.env.HMS_CREDENTIAL_LEASE_DATABASE_URL;
}

export async function prepare(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (context.mode === 'historical') return fail('HISTORICAL_HMS_DISABLED', 'Historical sessions cannot access live HMS.');
  if (context.signal?.aborted) return fail('ABORTED', 'Operation aborted.');
  const parsed = prepareInput.safeParse(input);
  if (!parsed.success) return fail('INVALID_INPUT', 'Create input does not match the booking and action contract.');
  if (process.env.NAVA_CREATE_PREPARE_ONLY==='1' && !await confirmedQueuedCreate(context.staffStage,context.sessionId,parsed.data)) {
    return fail(attachmentsUnconfirmed.code, attachmentsUnconfirmed.message);
  }
  const built = buildRequest(parsed.data);
  if ('ok' in built) return built;
  const { request, expectedGuest } = built;
  const arrival = request.stay.arrival;
  if (!expectedGuest || typeof arrival !== 'string') return fail('INVALID_CREATE_TARGET', 'Create Prepare requires guest first name, last name, and arrival date.');
  if (!leaseDatabase()) return fail('HMS_SHARED_LEASE_DATABASE_REQUIRED', 'Configure the existing shared HMS admission database.');
  try {
    const api = await nativeApi();
    const transportId = transport(api, request.propertyCode);
    if (!transportId) return fail('UNSUPPORTED_PROPERTY', 'Native HMS property or transport is unavailable.');
    const cloudTargetKey = api.createCloudTargetKey(expectedGuest, arrival, request.propertyCode);
    if (!cloudTargetKey) return fail('INVALID_CREATE_TARGET', 'Native create target is invalid.');
    const run = async (lease: Lease) => {
      const result = await loadNativeResult(api, { ...request, mode: 'prepare' }, {
        credentialLease: lease, signal: lease.signal, transportId, expectedGuest, cloudTargetKey, requireExplicitGuestSelection: true,
        allowRealGuest: context.mode === 'live' && arrival >= new Date().toISOString().slice(0, 10),
      });
      const rateUnavailable = result.issue === 'RATE_NOT_AVAILABLE' ||
        (object(result.detail) && result.detail.issue === 'RATE_NOT_AVAILABLE');
      const needsRate = !built.unknown.length && (rateUnavailable ||
        (result.outcome === 'needs_input' && !!result.applied && !!result.appliedVerification &&
          (result.issue === 'room_type_not_unique' || !request.room.ratePlan || object(result.ratePlanIssue) ||
          (Array.isArray(result.missing) && result.missing.some(field => typeof field === 'string' && field.startsWith('room.rate'))))));
      const roomType = typeof result.applied?.roomType === 'string' ? result.applied.roomType :
        typeof request.room.roomType === 'string' ? request.room.roomType : undefined;
      const choices = needsRate ? await scopedRateChoices(request,lease,transportId,roomType,rateUnavailable) :
        {rateChoices:{status:'unavailable',items:[],coverage:null},roomChoices:{status:'unavailable',items:[],coverage:null}};
      return {result,rateChoices:{...choices.rateChoices,sellable_only:rateUnavailable},roomChoices:nativeRoomChoices(result,choices.roomChoices)};
    };
    const {result,rateChoices,roomChoices} = context.credentialLease ? await run(context.credentialLease) :
      await api.withCloudCredentialLease(request.propertyCode, run, { databaseUrl: leaseDatabase(), readOnly: true, signal: context.signal });
    const trackChoices = object(result.trackChoices) && result.trackChoices.property_code === request.propertyCode
      ? result.trackChoices : {status:'unavailable',property_code:request.propertyCode,items:[],coverage:null};
    const data = bounded({ native: result, unsupportedFields: built.unknown, guest_candidates:guestChoices(result),
      rate_choices:rateChoices, room_choices:roomChoices, track_choices:trackChoices });
    if (built.unknown.length || result.outcome !== 'prepared') return fail('CREATE_PREPARE_INCOMPLETE', result.issue ?? 'Native create is incomplete.', 'known', data);
    return success(data);
  } catch (error) {
    return fail(context.signal?.aborted ? 'ABORTED' : 'CREATE_PREPARE_UNAVAILABLE', error instanceof Error && error.message === 'NATIVE_RESULT_TOO_LARGE' ? error.message : 'Native create prepare failed.');
  }
}

export async function save(input: unknown, context: SaveContext): Promise<ToolResult> {
  const staffGo = createGoEnabled() && context.mode === 'live';
  if (!hmsSaveEnabled() && !staffGo) return fail('SAVE_DISABLED', 'Only unsaved Prepare is available.');
  if (context.mode !== 'labtest' && !staffGo) return fail('LABTEST_ONLY', 'Create Save is available only in Labtest mode.');
  if (context.signal?.aborted) return fail('ABORTED', 'Operation aborted.');
  const parsed = saveInput.safeParse(input);
  if (!parsed.success || typeof context.markDispatched !== 'function') return fail('INVALID_INPUT', 'Create Save requires an execution ID and durable dispatch callback.');
  const built = buildRequest(parsed.data);
  if ('ok' in built) return built;
  const { request, expectedGuest, unknown } = built;
  if (unknown.length) return fail('UNSUPPORTED_CREATE_FIELDS', 'Unsupported fields cannot be saved.', 'known', { fields: unknown });
  if (parsed.data.booking.fields.guest_email != null && !request.guest.profileId) {
    return fail('GUEST_PROFILE_REQUIRED', 'Choose the guest profile in Prepare before Save.');
  }
  const today = new Date().toISOString().slice(0, 10);
  const labtest = expectedGuest?.firstName === labGuest.firstName && expectedGuest.lastName === labGuest.lastName;
  const cmsSend = object(request.cms) && request.cms.send === true;
  if (!expectedGuest || request.propertyCode !== 'HRCEN' || typeof request.stay.arrival !== 'string') {
    return fail('CREATE_TARGET_REQUIRED', 'HRCEN, guest first and last name, and arrival are required.');
  }
  if (labtest ? (request.stay.arrival < '2027-01-01' || cmsSend) : (!staffGo || !createGoRealGuests() || request.stay.arrival < today)) {
    return fail('LABTEST_TARGET_REQUIRED', labtest ? 'Labtest needs arrival in 2027 or later and CMS off.' : 'Real-guest Save needs staff Go enabled for real guests and a current or future arrival.');
  }
  // Staff Go must save at the HMS price staff saw after Prepare.
  const expectedPrice = parsed.data.expectedPrice;
  if (staffGo && !expectedPrice) return fail('CREATE_PRICE_UNVERIFIED', 'Run Prepare so Infor shows the price before Go.');
  // Every Create states CMS explicitly; absent means do not send.
  request.cms = { ...(object(request.cms) ? request.cms : {}), send: cmsSend };
  if (!leaseDatabase()) return fail('HMS_SHARED_LEASE_DATABASE_REQUIRED', 'Configure the existing shared HMS admission database.');
  let markerAttempted = false;
  try {
    const api = await nativeApi();
    const transportId = transport(api, request.propertyCode);
    if (!transportId) return fail('UNSUPPORTED_PROPERTY', 'Native HMS property or transport is unavailable.');
    const target = api.createCloudTargetKey(expectedGuest, request.stay.arrival, request.propertyCode);
    if (!target) return fail('INVALID_CREATE_TARGET', 'Native create target is invalid.');
    const realGuest = !labtest;
    const write = async (lease: Lease) => {
      const priorRooms=parsed.data.priorRooms;
      const siblingTools=priorRooms?.length ? await import(new URL('../../../server-pilot/tooling/hms-cloud/batch-sibling-readback.mjs',import.meta.url).href) as {
        verifyApprovedBatchSiblings(siblings:unknown[],options:unknown):Promise<boolean>;
        censusMatchesApprovedSiblings(census:unknown,siblings:unknown[],options:unknown):boolean;
      } : null;
      if(siblingTools) {
        const options={propertyCode:request.propertyCode,transportId,signal:lease.signal,credentialLease:lease};
        let verified=await siblingTools.verifyApprovedBatchSiblings(priorRooms ?? [],options);
        if(!verified && !lease.signal.aborted) {
          await delay(1000,undefined,{signal:lease.signal});
          verified=await siblingTools.verifyApprovedBatchSiblings(priorRooms ?? [],options);
        }
        if(!verified) return fail('CREATE_PREVIOUS_ROOM_UNVERIFIED','Check the completed rooms in Infor before continuing.');
      }
      const options = { credentialLease: lease, signal: lease.signal, expectedGuest, cloudTargetKey: target, transportId,
        ...(realGuest ? { allowRealGuest: true, requireExplicitGuestSelection: true } : {}) };
      const stage = await loadNativeResult(api, { ...request, mode: 'prepare' }, options);
      const guest = stage.applied?.guest;
      const note = stage.applied?.note;
      const binding = stagedBinding.safeParse(stage.requestBinding?.request);
      if (stage.outcome !== 'prepared' || stage.appliedVerification?.visibleFields !== true ||
          !object(guest) || !sameName(guest.firstName, expectedGuest.firstName) || !sameName(guest.lastName, expectedGuest.lastName) ||
          !/^\d+$/.test(String(guest.nativeId ?? '')) || (request.guest.profileId != null && String(request.guest.profileId) !== String(guest.nativeId)) ||
          typeof note !== 'string' || !note ||
          !stage.requestBinding || !/^[a-f0-9]{64}$/.test(stage.requestBinding.digest) || !binding.success ||
          binding.data.guest.nativeId !== String(guest.nativeId) || binding.data.stay.arrival !== request.stay.arrival ||
          binding.data.stay.departure !== request.stay.departure || binding.data.note !== note ||
          (binding.data.sendHmsConfirmation.kind === 'send') !== cmsSend ||
          (binding.data.sendHmsConfirmation.kind === 'send' && (labtest || binding.data.sendHmsConfirmation.recipient !== (request.cms as Record<string, unknown>).recipient))) {
        return fail('CREATE_RESTAGE_INCOMPLETE', stage.issue ?? 'Fresh stage was not verified.', 'known', bounded({ native: stage }));
      }
      const commit = { ...request, mode: 'commit', guest: { profileId: String(guest.nativeId) }, note };
      const price = stage.ratePlanAvailability;
      if (price && !['averageRate', 'totalRate', 'currency'].every(key => typeof price[key] === 'string' && price[key].trim())) {
        return fail('CREATE_PRICE_UNVERIFIED', 'Native staged price is incomplete.', 'known', bounded({ native: stage }));
      }
      if (expectedPrice && (!price || price.averageRate !== expectedPrice.averageRate || price.totalRate !== expectedPrice.totalRate || price.currency !== expectedPrice.currency)) {
        const now = price ? `${price.currency} ${price.totalRate}` : 'no price';
        return fail('CREATE_PRICE_CHANGED', `Infor price changed since Prepare (was ${expectedPrice.currency} ${expectedPrice.totalRate}, now ${now}). Nothing saved; run Prepare again.`, 'known', bounded({ native: stage }));
      }
      const saved = await loadNativeResult(api, commit, {
        ...options,
        expectedRequestDigest: stage.requestBinding.digest,
        ...(price ? { expectedRateAvailability: price } : {}),
        ...(stage.requestBinding.arAccountProfileId ? { expectedArProfileId: stage.requestBinding.arAccountProfileId } : {}),
        ...(siblingTools ? { verifyLabtestMatches: async (census:unknown) => siblingTools.censusMatchesApprovedSiblings(census,priorRooms ?? [],{propertyCode:request.propertyCode}) } : {}),
        authorizeCandidate: async () => !lease.signal.aborted && !markerAttempted,
        dispatchCandidate: async (_candidate: unknown, proceed: () => Promise<unknown>, evidence: {preimage:unknown;writer:unknown;guaranteeDisplay:unknown}) => {
          if (markerAttempted || lease.signal.aborted) throw new Error('DISPATCH_NOT_AUTHORIZED');
          markerAttempted = true;
          await context.markDispatched(bounded({ workflow:'create',executionId:parsed.data.executionId,
            operation:'create',propertyCode:request.propertyCode,transportId,firstName:binding.data.guest.firstName,
            lastName:binding.data.guest.lastName,nativeGuestId:binding.data.guest.nativeId,approvedDigest:stage.requestBinding.digest,
            recovery:{request:binding.data,preimage:evidence.preimage,writer:evidence.writer,guaranteeDisplay:evidence.guaranteeDisplay,
              ...(price?{ratePlanAvailability:price}:{}),...(priorRooms?{batchManifest:priorRooms}:{}),
              ...(stage.requestBinding.arAccountProfileId?{arAccountProfileId:stage.requestBinding.arAccountProfileId}:{})} }));
          lease.signal.throwIfAborted();
          return proceed();
        },
      });
      if (markerAttempted && saved.outcome === 'saved' && saved.writerSessionClosed === true &&
          saved.save?.dispatchCallbacksDrained === true && saved.save.browserSendRequests === 0 &&
          typeof saved.confirmation === 'string' && /^\d+-\d+$/.test(saved.confirmation) &&
          typeof saved.nativeStayId === 'string' && /^\d+$/.test(saved.nativeStayId) &&
          Array.isArray(saved.readback?.mismatches) && saved.readback.mismatches.length === 0) {
        return success(bounded({ confirmation: saved.confirmation, reservation_id: saved.nativeStayId, readback: saved.readback,
          ...(priorRooms ? {sibling:{confirmation:saved.confirmation,nativeStayId:saved.nativeStayId,approvedRequest:binding.data,
            requestDigest:stage.requestBinding.digest,ratePlanAvailability:expectedPrice,
            ...(saved.save?.checkedPricing !== undefined ? {checkedPricing:saved.save.checkedPricing} : {}),
            ...(stage.requestBinding.arAccountProfileId ? {arProfileId:stage.requestBinding.arAccountProfileId} : {})}} : {}) }));
      }
      return fail(markerAttempted ? 'CREATE_SAVE_UNCERTAIN' : 'CREATE_SAVE_REFUSED', saved.issue ?? 'Native Save was not verified.', markerAttempted ? 'uncertain' : 'known', bounded({ native: saved }));
    };
    // The registry already holds the exclusive write lease; taking a second one here would wait on ourselves.
    return context.credentialLease ? await write(context.credentialLease)
      : await api.withCloudCredentialLease(request.propertyCode, write, { databaseUrl: leaseDatabase(), readOnly: false, signal: context.signal });
  } catch {
    return fail(markerAttempted ? 'CREATE_SAVE_UNCERTAIN' : 'CREATE_SAVE_UNAVAILABLE', markerAttempted ? 'Save may have dispatched; reconcile before any retry.' : 'Native create Save did not dispatch.', markerAttempted ? 'uncertain' : 'known');
  }
}
