import { z } from 'zod';
import { prepareInput, saveInput, type CreateInput } from './schema.js';

export type ToolContext = { sessionId: string; mode: 'live' | 'labtest' | 'historical'; signal?: AbortSignal };
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
  guest: z.object({ nativeId: z.string().regex(/^\d+$/), firstName: z.literal('Proof'), lastName: z.literal('Labtest') }).passthrough(),
  stay: z.object({ arrival: z.string(), departure: z.string() }).passthrough(),
  note: z.string(),
  sendHmsConfirmation: z.object({ kind: z.literal('never') }).strict(),
}).passthrough();
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

function buildRequest(input: CreateInput): { request: NativeRequest; unknown: string[]; expectedGuest?: { firstName: string; lastName: string } } | ToolResult {
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
    const path = fieldPaths[field];
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
    if (!expectedGuest || booking.fields.guest_email !== undefined) return fail('GUEST_IDENTITY_CONFLICT', 'Profile ID requires matching first and last name; email lookup cannot be combined.');
    delete request.guest.search;
  }
  return { request, unknown, ...(expectedGuest ? { expectedGuest } : {}) };
}

function bounded(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > 512_000) throw new Error('NATIVE_RESULT_TOO_LARGE');
  return JSON.parse(json);
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
  const built = buildRequest(parsed.data);
  if ('ok' in built) return built;
  if (!leaseDatabase()) return fail('HMS_SHARED_LEASE_DATABASE_REQUIRED', 'Configure the existing shared HMS admission database.');
  try {
    const api = await nativeApi();
    const transportId = transport(api, built.request.propertyCode);
    if (!transportId) return fail('UNSUPPORTED_PROPERTY', 'Native HMS property or transport is unavailable.');
    const result = await api.withCloudCredentialLease(built.request.propertyCode, lease => {
      const options: Record<string, unknown> = { credentialLease: lease, signal: lease.signal, transportId };
      if (built.expectedGuest) options.expectedGuest = built.expectedGuest;
      // Current/future real-guest prepares may stage supported fields; commit
      // remains independently restricted to Labtest below.
      if (context.mode === 'live' && built.expectedGuest && typeof built.request.stay.arrival === 'string' &&
          built.request.stay.arrival >= new Date().toISOString().slice(0, 10)) options.allowRealGuest = true;
      return loadNativeResult(api, { ...built.request, mode: 'prepare' }, options);
    }, { databaseUrl: leaseDatabase(), readOnly: true, signal: context.signal });
    const data = bounded({ native: result, unsupportedFields: built.unknown });
    if (built.unknown.length || result.outcome !== 'prepared') return fail('CREATE_PREPARE_INCOMPLETE', result.issue ?? 'Native create is incomplete.', 'known', data);
    return success(data);
  } catch (error) {
    return fail(context.signal?.aborted ? 'ABORTED' : 'CREATE_PREPARE_UNAVAILABLE', error instanceof Error && error.message === 'NATIVE_RESULT_TOO_LARGE' ? error.message : 'Native create prepare failed.');
  }
}

export async function save(input: unknown, context: SaveContext): Promise<ToolResult> {
  if (context.mode !== 'labtest') return fail('LABTEST_ONLY', 'Create Save is available only in Labtest mode.');
  if (context.signal?.aborted) return fail('ABORTED', 'Operation aborted.');
  const parsed = saveInput.safeParse(input);
  if (!parsed.success || typeof context.markDispatched !== 'function') return fail('INVALID_INPUT', 'Create Save requires an execution ID and durable dispatch callback.');
  const built = buildRequest(parsed.data);
  if ('ok' in built) return built;
  const { request, expectedGuest, unknown } = built;
  if (unknown.length) return fail('UNSUPPORTED_CREATE_FIELDS', 'Unsupported fields cannot be saved.', 'known', { fields: unknown });
  if (request.propertyCode !== 'HRCEN' || expectedGuest?.firstName !== labGuest.firstName || expectedGuest.lastName !== labGuest.lastName ||
      typeof request.stay.arrival !== 'string' || request.stay.arrival < '2027-01-01' ||
      !object(request.cms) || request.cms.send !== false) {
    return fail('LABTEST_TARGET_REQUIRED', 'HRCEN Proof Labtest, arrival in 2027 or later, and explicit CMS off are required.');
  }
  if (!leaseDatabase()) return fail('HMS_SHARED_LEASE_DATABASE_REQUIRED', 'Configure the existing shared HMS admission database.');
  let markerAttempted = false;
  try {
    const api = await nativeApi();
    const transportId = transport(api, request.propertyCode);
    if (!transportId) return fail('UNSUPPORTED_PROPERTY', 'Native HMS property or transport is unavailable.');
    const target = api.createCloudTargetKey(labGuest, request.stay.arrival, request.propertyCode);
    if (!target) return fail('INVALID_CREATE_TARGET', 'Native create target is invalid.');
    return await api.withCloudCredentialLease(request.propertyCode, async lease => {
      const options = { credentialLease: lease, signal: lease.signal, expectedGuest: labGuest, cloudTargetKey: target, transportId };
      const stage = await loadNativeResult(api, { ...request, mode: 'prepare' }, options);
      const guest = stage.applied?.guest;
      const note = stage.applied?.note;
      const binding = stagedBinding.safeParse(stage.requestBinding?.request);
      if (stage.outcome !== 'prepared' || stage.appliedVerification?.visibleFields !== true ||
          !object(guest) || guest.firstName !== 'Proof' || guest.lastName !== 'Labtest' ||
          !/^\d+$/.test(String(guest.nativeId ?? '')) || typeof note !== 'string' || !note ||
          !stage.requestBinding || !/^[a-f0-9]{64}$/.test(stage.requestBinding.digest) || !binding.success ||
          binding.data.guest.nativeId !== String(guest.nativeId) || binding.data.stay.arrival !== request.stay.arrival ||
          binding.data.stay.departure !== request.stay.departure || binding.data.note !== note) {
        return fail('CREATE_RESTAGE_INCOMPLETE', stage.issue ?? 'Fresh Labtest stage was not verified.', 'known', bounded({ native: stage }));
      }
      const commit = { ...request, mode: 'commit', guest: { profileId: String(guest.nativeId) }, note };
      const price = stage.ratePlanAvailability;
      if (price && !['averageRate', 'totalRate', 'currency'].every(key => typeof price[key] === 'string' && price[key].trim())) {
        return fail('CREATE_PRICE_UNVERIFIED', 'Native staged price is incomplete.', 'known', bounded({ native: stage }));
      }
      const saved = await loadNativeResult(api, commit, {
        ...options,
        expectedRequestDigest: stage.requestBinding.digest,
        ...(price ? { expectedRateAvailability: price } : {}),
        ...(stage.requestBinding.arAccountProfileId ? { expectedArProfileId: stage.requestBinding.arAccountProfileId } : {}),
        authorizeCandidate: async () => !lease.signal.aborted && !markerAttempted,
        dispatchCandidate: async (_candidate: unknown, proceed: () => Promise<unknown>) => {
          if (markerAttempted || lease.signal.aborted) throw new Error('DISPATCH_NOT_AUTHORIZED');
          markerAttempted = true;
          await context.markDispatched({ workflow: 'create', executionId: parsed.data.executionId, propertyCode: request.propertyCode });
          lease.signal.throwIfAborted();
          return proceed();
        },
      });
      if (markerAttempted && saved.outcome === 'saved' && saved.writerSessionClosed === true &&
          saved.save?.dispatchCallbacksDrained === true && saved.save.browserSendRequests === 0 &&
          typeof saved.confirmation === 'string' && /^\d+-\d+$/.test(saved.confirmation) &&
          typeof saved.nativeStayId === 'string' && /^\d+$/.test(saved.nativeStayId) &&
          Array.isArray(saved.readback?.mismatches) && saved.readback.mismatches.length === 0) {
        return success(bounded({ confirmation: saved.confirmation, reservation_id: saved.nativeStayId, readback: saved.readback }));
      }
      return fail(markerAttempted ? 'CREATE_SAVE_UNCERTAIN' : 'CREATE_SAVE_REFUSED', saved.issue ?? 'Native Save was not verified.', markerAttempted ? 'uncertain' : 'known', bounded({ native: saved }));
    }, { databaseUrl: leaseDatabase(), readOnly: false, signal: context.signal });
  } catch {
    return fail(markerAttempted ? 'CREATE_SAVE_UNCERTAIN' : 'CREATE_SAVE_UNAVAILABLE', markerAttempted ? 'Save may have dispatched; reconcile before any retry.' : 'Native create Save did not dispatch.', markerAttempted ? 'uncertain' : 'known');
  }
}
