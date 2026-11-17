import { z } from 'zod';
import { day, patch, prepareEnvelope, prepareManifest } from './schema.js';

type ToolContext = { sessionId: string; mode: 'live' | 'labtest' | 'historical'; signal?: AbortSignal };
type ToolResult =
  | { ok: true; data: unknown; error: null }
  | { ok: false; data: unknown; error: { code: string; message: string; retryable: boolean; outcome: 'known' } };

const refuse = (code: string, message: string, data: unknown = null): ToolResult =>
  ({ ok: false, data, error: { code, message, retryable: false, outcome: 'known' } });

const nativePath = (file: string) => new URL(`../../../server-pilot/tooling/hms-cloud/${file}.mjs`, import.meta.url).href;
const nativeId = z.string().regex(/^\d{1,100}$/);
const selectedStay = z.object({
  source: z.literal('record_view_ext_model'),
  propertyCode: z.string(),
  confirmation: z.string().regex(/^\d{6,10}-\d{1,10}$/),
  reservationStayId: nativeId,
  reservationId: nativeId,
  recordId: nativeId,
  guestId: nativeId,
  status: z.string(),
  firstName: z.string().min(1).max(200),
  lastName: z.string().min(1).max(200),
  arrival: day,
  departure: day,
  adults: z.number().int().min(1).max(16),
  children: z.number().int().min(0).max(9),
  childAges: z.union([z.literal('unknown'), z.array(z.number().int().min(0).max(17)).max(9)]),
  roomType: z.string(),
  ratePlan: z.string(),
  guaranteeCode: z.string().optional(),
});
const freshRead = z.object({
  shallow: z.object({ confirmation: z.string() }),
  record: z.object({
    nativePreimage: selectedStay,
    details: z.object({ fields: z.array(z.object({
      name: z.string().nullable(), value: z.unknown(), rawValue: z.unknown().optional(),
    })) }),
  }),
});
const nativeStatus = z.object({ outcome: z.string(), issue: z.string().regex(/^[A-Z][A-Z_0-9]{2,80}$/).optional(),
  diagnostic: z.object({ phase: z.enum(['credential_lease', 'party_preimage', 'nightly_quote', 'native_prepare']) }).optional() });
const minor = z.string().regex(/^\d{1,24}$/);
const prepared = z.object({
  nativeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approvedPrices: z.object({
    version: z.literal(2),
    currency: z.string().regex(/^[A-Z]{3}$/),
    totalCents: minor,
    averageCents: minor.nullable(),
    options: z.array(z.object({
      roomType: z.string().max(12), ratePlan: z.string().max(12),
      currency: z.string().regex(/^[A-Z]{3}$/),
      nightly: z.array(z.object({ date: day, amountCents: minor })),
    })).max(100),
  }),
  preserved: z.object({ cmsSend: z.boolean() }),
});

type Property = { propertyCode: string; origin: string; active: boolean };
type ReadTool = (input: {
  tool: 'read'; confirmation: string; arrivalDate?: string; includeNativePreimage: true;
}) => Promise<unknown>;
type NativeStay = z.infer<typeof selectedStay>;
const fieldMap = {
  arrival_date: 'arrival', departure_date: 'departure', adults: 'adults', room_type: 'roomType', rate_plan: 'ratePlan',
  first_name: 'firstName', last_name: 'lastName', booker_name: 'bookerName',
  booker_contact: 'bookerContact', reservation_note: 'reservationNote',
} satisfies Record<keyof z.infer<typeof patch>, string>;
const stayFields = {
  arrival_date: 'arrival', departure_date: 'departure', adults: 'adults', room_type: 'roomType', rate_plan: 'ratePlan',
  first_name: 'firstName', last_name: 'lastName',
} satisfies Partial<Record<keyof z.infer<typeof patch>, keyof NativeStay>>;
const recordFields = { booker_name: 'caller', booker_contact: 'udfchar06', reservation_note: 'reservationnote' };
const priceFields = ['arrival_date', 'departure_date', 'adults', 'room_type', 'rate_plan'] as const;

function nativeRefusal(raw: unknown, fallback: string, message: string): ToolResult {
  const result = nativeStatus.safeParse(raw);
  const issue = result.success ? result.data.issue : undefined;
  if (issue === 'RATE_NOT_AVAILABLE') {
    return refuse(issue, 'HMS did not offer the requested rate.', { availability: { status: 'unavailable' } });
  }
  return refuse(issue ?? fallback, message, result.success && result.data.diagnostic
    ? { phase: result.data.diagnostic.phase } : null);
}

export async function prepare(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (context.mode === 'historical') return refuse('HISTORICAL_HMS_UNAVAILABLE', 'Historical sessions cannot contact HMS.');
  if (context.signal?.aborted) return refuse('AMEND_ABORTED', 'Amendment preparation was aborted.');
  const envelope = prepareEnvelope.safeParse(input);
  if (!envelope.success) return refuse('AMEND_INPUT_INVALID', 'Supply one booking, its property, and an amend action.');
  const { booking, action } = envelope.data;
  if (action.booking_ids[0] !== booking.id) return refuse('AMEND_TARGET_MISMATCH', 'Action does not identify the supplied booking.');
  const delta = patch.safeParse(booking.fields);
  if (!delta.success) {
    const unsupported = Object.keys(booking.fields).filter(key => !Object.hasOwn(fieldMap, key));
    return unsupported.length
      ? refuse('AMEND_FIELDS_UNSUPPORTED', 'One or more requested fields cannot be staged by this adapter.')
      : refuse('AMEND_FIELDS_INVALID', 'Requested fields do not match the amend field types.');
  }
  const requested = delta.data;
  if (!Object.keys(requested).length) return refuse('AMEND_CHANGE_REQUIRED', 'Supply at least one requested change.');
  const hint = booking.current_state?.arrival_date;
  const expectedArrival = hint == null ? null : day.safeParse(hint);
  if (expectedArrival?.success === false) return refuse('AMEND_INPUT_INVALID', 'Current arrival, if supplied, must be an ISO calendar date.');
  const candidateConfirmation = booking.reservation_id;
  const confirmation = action.details.confirmation_number ??
    (candidateConfirmation && /^\d{6,10}(?:-\d{1,10})?$/.test(candidateConfirmation) ? candidateConfirmation : null);
  if (!confirmation) return refuse('AMEND_CONFIRMATION_REQUIRED', 'Supply the confirmation number for the selected stay.');
  const signal = AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(context.signal ? [context.signal] : [])]);
  let phase: 'adapter' | 'target_read' | 'native_prepare' = 'adapter';

  try {
    const registry: { getPropertyRegistration(code: string): Property | undefined } =
      await import(nativePath('property-registry'));
    const property = registry.getPropertyRegistration(booking.property_code);
    if (!property?.active) return refuse('AMEND_PROPERTY_UNSUPPORTED', 'Property has no active native adapter.');
    const reader: { withSavedStayAgentSession(
      run: (session: { runTool: ReadTool }) => Promise<unknown>,
      options: { readOnly: true; readOnlyConfirmation: string; propertyCode: string; signal: AbortSignal },
    ): Promise<unknown> } = await import(nativePath('saved-stay-agent-session'));
    phase = 'target_read';
    const raw = await reader.withSavedStayAgentSession(({ runTool }) => runTool({
      tool: 'read', confirmation, arrivalDate: expectedArrival?.data, includeNativePreimage: true,
    }), { readOnly: true, readOnlyConfirmation: confirmation, propertyCode: property.propertyCode, signal });
    signal.throwIfAborted();
    if (nativeStatus.safeParse(raw).data?.outcome !== 'ok') {
      return nativeRefusal(raw, 'AMEND_TARGET_UNVERIFIED', 'HMS did not resolve one exact stay. Verify the confirmation and current arrival.');
    }
    const read = freshRead.safeParse(raw);
    if (!read.success) return refuse('AMEND_TARGET_UNVERIFIED', 'Native record is missing a verified saved-stay preimage.');
    const { shallow, record } = read.data;
    const selected = record.nativePreimage;
    if (selected.propertyCode !== property.propertyCode || selected.confirmation !== shallow.confirmation ||
        (confirmation.includes('-') ? selected.confirmation !== confirmation : selected.confirmation.split('-')[0] !== confirmation) ||
        (booking.reservation_id !== null && booking.reservation_id !== selected.reservationStayId &&
          booking.reservation_id !== selected.confirmation && booking.reservation_id !== selected.confirmation.split('-')[0]) ||
        (expectedArrival?.data !== undefined && expectedArrival.data !== selected.arrival)) {
      return refuse('AMEND_TARGET_MISMATCH', 'Fresh read did not match the requested stay identity.');
    }
    if (selected.status !== 'Reserved') return refuse('AMEND_STATUS_UNSUPPORTED', 'Only Reserved stays can be staged by this adapter.');
    const before = {
      ...Object.fromEntries(Object.entries(stayFields).map(([key, native]) => [key, selected[native]])),
      ...Object.fromEntries(Object.entries(recordFields).map(([key, native]) => {
        const fields = record.details.fields.filter(field => field.name === native);
        if (fields.length !== 1) return [key, null];
        const value = key === 'reservation_note' ? fields[0]?.rawValue : fields[0]?.value;
        return [key, typeof value === 'string' ? value : null];
      })),
    };
    const changedKeys = patch.keyof().options.filter(key => requested[key] !== undefined && before[key] !== requested[key]);
    if (!changedKeys.length) return refuse('AMEND_UNCHANGED', 'Requested fields already match HMS.');
    if ((requested.arrival_date ?? selected.arrival) >= (requested.departure_date ?? selected.departure)) {
      return refuse('AMEND_DATES_INVALID', 'Departure must follow arrival.');
    }
    const needsAvailability = priceFields.some(key => requested[key] !== undefined && requested[key] !== before[key]);
    const retainRates = action.details.retain_rates ?? !needsAvailability;
    if (retainRates === needsAvailability) {
      return refuse('AMEND_RATE_POLICY_UNSUPPORTED', needsAvailability
        ? 'This adapter cannot stage a retained price for dates, occupancy, room, or rate changes.'
        : 'Repricing without a date, occupancy, room, or rate change is unsupported.');
    }

    phase = 'native_prepare';
    const native: { prepareCloudPaneAmend(input: {
      target: Property; selected: NativeStay; confirmation: string; arrival: string; changes: Record<string, unknown>;
      discoveryOnly: true; allowRealGuest: true; signal: AbortSignal;
    }): Promise<unknown> } = await import(nativePath('pane-amend-session'));
    const changes = {
      ...Object.fromEntries(changedKeys.map(key => [fieldMap[key], requested[key]])),
      retainRates: retainRates ? 'yes' : 'no',
      cmsSend: false, cmsMessageId: '', cmsRecipient: '',
    };
    const response = await native.prepareCloudPaneAmend({
      target: property, selected, confirmation: selected.confirmation, arrival: selected.arrival,
      changes, discoveryOnly: true, allowRealGuest: true, signal,
    });
    signal.throwIfAborted();
    if (nativeStatus.safeParse(response).data?.outcome !== 'prepared') {
      return nativeRefusal(response, 'AMEND_STAGE_UNVERIFIED', 'HMS did not verify the unsaved amendment.');
    }
    const staged = prepared.safeParse(response);
    if (!staged.success) return refuse('AMEND_STAGE_UNVERIFIED', 'Native stage did not return a verified price and form binding.');
    if (staged.data.preserved.cmsSend) {
      return refuse('AMEND_CMS_PRESERVATION_UNSUPPORTED', 'Current CMS send setting cannot be preserved by this preview.');
    }
    const price = staged.data.approvedPrices;
    const options = price.options.slice(0, 20);
    return { ok: true, error: null, data: {
      outcome: 'prepared', workflow: 'amend', property_code: property.propertyCode,
      confirmation: selected.confirmation, reservation_id: selected.confirmation, native_stay_id: selected.reservationStayId,
      current_state: Object.fromEntries(patch.keyof().options.filter(key => requested[key] !== undefined)
        .map(key => [key, before[key] ?? null])),
      fields: requested, changed_fields: changedKeys,
      cms_send: false, current_cms_send: staged.data.preserved.cmsSend,
      native_digest: staged.data.nativeDigest,
      availability: { status: needsAvailability ? 'native_check_passed' : 'not_checked' },
      price: { basis: retainRates ? 'saved_stay' : 'staged_stay', currency: price.currency,
        total_cents: price.totalCents, average_nightly_cents: price.averageCents,
        rate_shop_options: options.map(option => ({
          room_type: option.roomType, rate_plan: option.ratePlan, currency: option.currency,
          nightly: option.nightly.slice(0, 31).map(night => ({ date: night.date, amount_cents: night.amountCents })),
          nights_observed: option.nightly.length,
        })),
        rate_options_observed: price.options.length,
        rate_options_returned: options.length },
      warnings: ['Unsaved preview. No reservation or email was changed.',
        'Rate Shop observations do not hold inventory or establish the final payable total.'],
    } };
  } catch (error) {
    const safeCodes = ['HMS_CREDENTIAL_LEASE_DATABASE_REQUIRED', 'HMS_CREDENTIAL_LEASE_CONTENDED',
      'HMS_CREDENTIAL_LEASE_CONNECTION_FAILED', 'HMS_CREDENTIAL_LEASE_LOST'];
    const code = error instanceof Error && safeCodes.includes(error.message) ? error.message : 'AMEND_NATIVE_UNAVAILABLE';
    return signal.aborted ? refuse('AMEND_ABORTED', 'Amendment preparation was aborted or timed out.')
      : refuse(code, 'Native amend session could not be opened or completed.', { phase });
  }
}

export const tools = [{ ...prepareManifest, run: prepare }];
