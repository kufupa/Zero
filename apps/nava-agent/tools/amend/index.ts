import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { day, patch, prepareEnvelope, prepareManifest } from './schema.js';

export type ToolContext = { sessionId: string; mode: 'live' | 'labtest' | 'historical'; signal?: AbortSignal; credentialLease?: unknown };
export type SaveContext = ToolContext & { markDispatched(details: unknown): Promise<void> };
type ToolResult =
  | { ok: true; data: unknown; error: null }
  | { ok: false; data: unknown; error: { code: string; message: string; retryable: boolean; outcome: 'known' | 'uncertain' } };

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
      name: z.string().nullable(), type: z.string().optional(), value: z.unknown(), rawValue: z.unknown().optional(),
    })) }),
  }),
});
const nativeStatus = z.object({ outcome: z.string(), issue: z.string().regex(/^[A-Z][A-Z_0-9]{2,80}$/).optional(),
  diagnostic: z.object({ phase: z.enum(['credential_lease', 'party_preimage', 'nightly_quote', 'native_prepare']) }).optional() });
const minor = z.string().regex(/^\d{1,24}$/);
const major = (cents: string) => {
  const padded = cents.padStart(3, '0');
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
};
const nativePrepared = z.object({
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
  }).passthrough(),
  preserved: z.object({ cmsSend: z.boolean(), cmsRecipient: z.string() }).passthrough(),
});
export const preparedAmend = nativePrepared.extend({
  request: prepareEnvelope,
  selected: selectedStay,
  changes: z.record(z.unknown()),
  childAgePreimage: z.array(z.number().int().min(0).max(17)).max(9),
});
export type PreparedAmend = z.infer<typeof preparedAmend>;

type Property = { propertyCode: string; origin: string; active: boolean; mailboxTransportId: string; transportIds: string[] };
type ReadTool = (input: {
  tool: 'read'; confirmation: string; arrivalDate?: string; includeNativePreimage: true;
}) => Promise<unknown>;
type NativeStay = z.infer<typeof selectedStay>;
const fieldMap = {
  arrival_date: 'arrival', departure_date: 'departure', adults: 'adults', room_type: 'roomType',
  room_type_for_charge: 'roomTypeForCharge', rate_plan: 'ratePlan', first_name: 'firstName', last_name: 'lastName',
  guest_email: 'guestEmail', booker_name: 'bookerName', booker_contact: 'bookerContact',
  billing_reference: 'billingReference', reservation_note: 'reservationNote', cms_send: 'cmsSend',
  cms_message_id: 'cmsMessageId', cms_recipient: 'cmsRecipient',
} satisfies Record<keyof z.infer<typeof patch>, string>;
const stayFields = {
  arrival_date: 'arrival', departure_date: 'departure', adults: 'adults', room_type: 'roomType', rate_plan: 'ratePlan',
  first_name: 'firstName', last_name: 'lastName',
} satisfies Partial<Record<keyof z.infer<typeof patch>, keyof NativeStay>>;
const recordFields = { room_type_for_charge: 'roomtypecharge', guest_email: 'emailaddress', booker_name: 'caller',
  booker_contact: 'udfchar06', billing_reference: 'billingreference', reservation_note: 'reservationnote',
  cms_message_id: 'udfchar09', cms_recipient: 'udfchar13' };
const nativeNoteLineEndings = (value: string) => value.replace(/\r\n/g, '\n');
const priceFields = ['arrival_date', 'departure_date', 'adults', 'room_type', 'room_type_for_charge', 'rate_plan'] as const;

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
  if (!context.credentialLease) return refuse('HMS_SHARED_LEASE_REQUIRED', 'The host must supply an admitted HMS credential lease.');
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
  if (requested.reservation_note !== undefined) requested.reservation_note = nativeNoteLineEndings(requested.reservation_note);
  if (!Object.keys(requested).length) return refuse('AMEND_CHANGE_REQUIRED', 'Supply at least one requested change.');
  if (typeof booking.current_state?.first_name !== 'string' || !booking.current_state.first_name.trim() ||
      typeof booking.current_state?.last_name !== 'string' || !booking.current_state.last_name.trim() ||
      typeof booking.current_state?.arrival_date !== 'string') {
    return refuse('AMEND_IDENTITY_REQUIRED', 'Supply the verified current guest name and arrival before preparing.');
  }
  const hint = booking.current_state?.arrival_date;
  const expectedArrival = hint == null ? null : day.safeParse(hint);
  if (expectedArrival?.success === false) return refuse('AMEND_INPUT_INVALID', 'Current arrival, if supplied, must be an ISO calendar date.');
  const candidateConfirmation = booking.reservation_id;
  const confirmation = action.details.confirmation_number ??
    (candidateConfirmation && /^\d{6,10}(?:-\d{1,10})?$/.test(candidateConfirmation) ? candidateConfirmation : null);
  if (!confirmation) return refuse('AMEND_CONFIRMATION_REQUIRED', 'Supply the confirmation number for the selected stay.');
  const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(context.signal ? [context.signal] : [])]);
  let phase: 'adapter' | 'target_read' | 'native_prepare' = 'adapter';

  try {
    const registry: { getPropertyRegistration(code: string): Property | undefined } =
      await import(nativePath('property-registry'));
    const property = registry.getPropertyRegistration(booking.property_code);
    if (!property?.active || typeof property.mailboxTransportId !== 'string' ||
        !Array.isArray(property.transportIds) || !property.transportIds.includes(property.mailboxTransportId)) {
      return refuse('AMEND_PROPERTY_UNSUPPORTED', 'Property has no active native adapter.');
    }
    const reader: { withSavedStayAgentSession(
      run: (session: { runTool: ReadTool }) => Promise<unknown>,
      options: { readOnly: true; readOnlyConfirmation: string; propertyCode: string; transportId: string; signal: AbortSignal; credentialLease: unknown },
    ): Promise<unknown> } = await import(nativePath('saved-stay-agent-session'));
    phase = 'target_read';
    const raw = await reader.withSavedStayAgentSession(({ runTool }) => runTool({
      tool: 'read', confirmation, arrivalDate: expectedArrival?.data, includeNativePreimage: true,
    }), { readOnly: true, readOnlyConfirmation: confirmation, propertyCode: property.propertyCode,
      transportId: property.mailboxTransportId, signal, credentialLease: context.credentialLease });
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
          booking.reservation_id !== selected.reservationId &&
          booking.reservation_id !== selected.confirmation && booking.reservation_id !== selected.confirmation.split('-')[0]) ||
        (expectedArrival?.data !== undefined && expectedArrival.data !== selected.arrival)) {
      return refuse('AMEND_TARGET_MISMATCH', 'Fresh read did not match the requested stay identity.');
    }
    if (selected.status !== 'Reserved') return refuse('AMEND_STATUS_UNSUPPORTED', 'Only Reserved stays can be staged by this adapter.');
    for (const [key, native] of Object.entries(stayFields)) {
      const expected = booking.current_state?.[key];
      if (expected !== undefined && expected !== null && expected !== selected[native]) {
        return refuse('AMEND_PREIMAGE_CHANGED', 'The current stay no longer matches the proposal. Read it again before preparing.');
      }
    }
    const cms = record.details.fields.filter(field => field.name === 'udfchkbox04');
    const currentCmsSend = cms[0]?.value;
    if (cms.length !== 1 || cms[0]?.type !== 'checkbox' || typeof currentCmsSend !== 'boolean') {
      return refuse('AMEND_CMS_UNVERIFIED', 'HMS did not show the current CMS setting.');
    }
    const before: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(stayFields).map(([key, native]) => [key, selected[native]])),
      ...Object.fromEntries(Object.entries(recordFields).map(([key, native]) => {
        const fields = record.details.fields.filter(field => field.name === native);
        if (fields.length !== 1) return [key, null];
        const value = key === 'reservation_note' ? fields[0]?.rawValue : fields[0]?.value;
        return [key, typeof value === 'string' ? value : null];
      })), cms_send: currentCmsSend,
    };
    if (typeof before.cms_message_id !== 'string' || typeof before.cms_recipient !== 'string') {
      return refuse('AMEND_CMS_UNVERIFIED', 'HMS did not show the current CMS message and recipient.');
    }
    const changedKeys = patch.keyof().options.filter(key => {
      const previous = before[key];
      return requested[key] !== undefined
        && (key === 'reservation_note' && typeof previous === 'string' ? nativeNoteLineEndings(previous) : previous) !== requested[key];
    });
    if (!changedKeys.length) return refuse('AMEND_UNCHANGED', 'Requested fields already match HMS.');
    if (changedKeys.some(key => Object.hasOwn(recordFields, key) && before[key] === null)) {
      return refuse('AMEND_PREIMAGE_UNVERIFIED', 'The current value of a requested field was not observed.');
    }
    if ((requested.arrival_date ?? selected.arrival) >= (requested.departure_date ?? selected.departure)) {
      return refuse('AMEND_DATES_INVALID', 'Departure must follow arrival.');
    }
    const needsAvailability = priceFields.some(key => requested[key] !== undefined && requested[key] !== before[key]);
    const retainRates = action.details.retain_rates ?? !needsAvailability;

    phase = 'native_prepare';
    const native: { readCloudSavedChildAges(input: Record<string, unknown>): Promise<unknown>;
      prepareCloudPaneAmend(input: {
      target: Property; selected: NativeStay; confirmation: string; arrival: string; changes: Record<string, unknown>;
      childAgePreimage: number[]; allowRealGuest: boolean; transportId: string; signal: AbortSignal; credentialLease: unknown;
    }): Promise<unknown> } = await import(nativePath('pane-amend-session'));
    const common = { target: property, selected, confirmation: selected.confirmation, arrival: selected.arrival,
      allowRealGuest: context.mode === 'live', transportId: property.mailboxTransportId, signal, credentialLease: context.credentialLease };
    const ageRead = z.object({ outcome: z.literal('ok'), ages: z.array(z.number().int().min(0).max(17)).max(9) })
      .safeParse(await native.readCloudSavedChildAges(common));
    if (!ageRead.success || ageRead.data.ages.length !== selected.children ||
        (Array.isArray(selected.childAges) && !isDeepStrictEqual([...selected.childAges].sort((a, b) => a - b),
          [...ageRead.data.ages].sort((a, b) => a - b)))) {
      return refuse('AMEND_CHILD_AGES_UNVERIFIED', 'HMS could not confirm the current child ages.');
    }
    const childAgePreimage = ageRead.data.ages;
    const changes = {
      ...Object.fromEntries(changedKeys.map(key => [fieldMap[key], requested[key]])),
      retainRates: retainRates ? 'yes' : 'no',
      cmsSend: requested.cms_send ?? currentCmsSend,
      cmsMessageId: requested.cms_message_id ?? before.cms_message_id,
      cmsRecipient: requested.cms_recipient ?? before.cms_recipient,
    };
    const response = await native.prepareCloudPaneAmend({
      ...common, changes, childAgePreimage,
    });
    signal.throwIfAborted();
    if (nativeStatus.safeParse(response).data?.outcome !== 'prepared') {
      return nativeRefusal(response, 'AMEND_STAGE_UNVERIFIED', 'HMS did not verify the unsaved amendment.');
    }
    const staged = nativePrepared.safeParse(response);
    if (!staged.success) return refuse('AMEND_STAGE_UNVERIFIED', 'Native stage did not return a verified price and form binding.');
    phase = 'target_read';
    const rereadRaw = await reader.withSavedStayAgentSession(({ runTool }) => runTool({
      tool: 'read', confirmation: selected.confirmation, arrivalDate: selected.arrival, includeNativePreimage: true,
    }), { readOnly: true, readOnlyConfirmation: selected.confirmation, propertyCode: property.propertyCode,
      transportId: property.mailboxTransportId, signal, credentialLease: context.credentialLease });
    signal.throwIfAborted();
    const reread = freshRead.safeParse(rereadRaw);
    if (nativeStatus.safeParse(rereadRaw).data?.outcome !== 'ok' || !reread.success ||
        reread.data.shallow.confirmation !== selected.confirmation ||
        !isDeepStrictEqual(reread.data.record.nativePreimage, selected)) {
      return refuse('AMEND_READBACK_UNVERIFIED', 'The original stay could not be confirmed unchanged after the unsaved preview.');
    }
    const afterFields = reread.data.record.details.fields;
    const afterCms = afterFields.filter(field => field.name === 'udfchkbox04');
    if (afterCms.length !== 1 || afterCms[0]?.type !== 'checkbox' || afterCms[0].value !== currentCmsSend ||
        changedKeys.some(key => {
          if (!Object.hasOwn(recordFields, key)) return false;
          const native = recordFields[key as keyof typeof recordFields];
          const fields = afterFields.filter(field => field.name === native);
          return fields.length !== 1 || (key === 'reservation_note' ? fields[0]?.rawValue : fields[0]?.value) !== before[key];
        })) {
      return refuse('AMEND_READBACK_UNVERIFIED', 'The original stay or CMS state could not be confirmed unchanged after the unsaved preview.');
    }
    const price = staged.data.approvedPrices;
    const options = price.options.slice(0, 20);
    const displayRows = [
      { id: 'availability', booking_id: booking.id, kind: 'availability', label: 'Amendment availability',
        native_path: '/availability/status', status: needsAvailability ? 'available' : 'unknown', rooms_available: null },
      { id: 'total', booking_id: booking.id, kind: 'money', label: 'Stay total', native_path: '/price/total_cents',
        amount: major(price.totalCents), currency: price.currency, unit: 'stay', date: null, basis: 'native', official: true },
      ...(price.averageCents === null ? [] : [{ id: 'average', booking_id: booking.id, kind: 'money',
        label: 'Average nightly rate', native_path: '/price/average_nightly_cents', amount: major(price.averageCents),
        currency: price.currency, unit: 'night', date: null, basis: 'native', official: true }]),
      ...options.flatMap((option, i) => [
        { id: `option-${i}-room`, booking_id: booking.id, kind: 'code', label: `Rate Shop option ${i + 1} room`,
          native_path: `/price/rate_shop_options/${i}/room_type`, code: option.roomType, meaning: null },
        { id: `option-${i}-rate`, booking_id: booking.id, kind: 'code', label: `Rate Shop option ${i + 1} rate`,
          native_path: `/price/rate_shop_options/${i}/rate_plan`, code: option.ratePlan, meaning: null },
        ...option.nightly.slice(0, 31).map((night, j) => ({ id: `option-${i}-night-${j}`, booking_id: booking.id,
          kind: 'money', label: `Rate Shop option ${i + 1} nightly price`,
          native_path: `/price/rate_shop_options/${i}/nightly/${j}/amount_cents`, amount: major(night.amountCents),
          currency: option.currency, unit: 'night', date: night.date, basis: 'native', official: false })),
      ]),
    ];
    return { ok: true, error: null, data: {
      outcome: 'prepared', workflow: 'amend', property_code: property.propertyCode,
      confirmation: selected.confirmation, reservation_id: selected.confirmation, native_stay_id: selected.reservationStayId,
      current_state: { ...before, children: selected.children, child_ages: selected.childAges },
      fields: requested, changed_fields: changedKeys,
      original_stay_unchanged: true,
      cms_send: changes.cmsSend, current_cms_send: staged.data.preserved.cmsSend,
      native_digest: staged.data.nativeDigest,
      native: { request: envelope.data, selected, changes, childAgePreimage, nativeDigest: staged.data.nativeDigest,
        approvedPrices: staged.data.approvedPrices, preserved: staged.data.preserved },
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
      display_rows: displayRows,
      coverage: { rate_options_observed: price.options.length, rate_options_returned: options.length,
        nights_truncated: options.some(option => option.nightly.length > 31),
        note: 'Rate Shop options are bounded observations, not a complete catalogue or a held price.' },
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

const saveEnvelope = prepareEnvelope.extend({
  executionId: z.string().min(1).max(200),
  prepared: z.union([preparedAmend, z.object({ native: preparedAmend }).passthrough()]).optional(),
}).strict();

export async function save(input: unknown, context: SaveContext): Promise<ToolResult> {
  const parsed = saveEnvelope.safeParse(input);
  if (!parsed.success) return refuse('AMEND_INPUT_INVALID', 'Supply the reviewed amendment and execution ID.');
  if (context.mode === 'historical') return refuse('HISTORICAL_HMS_UNAVAILABLE', 'Historical sessions cannot contact HMS.');
  if (context.signal?.aborted) return refuse('AMEND_ABORTED', 'Amendment was aborted before dispatch.');
  if (!context.credentialLease || typeof context.markDispatched !== 'function') {
    return refuse('HMS_SHARED_LEASE_REQUIRED', 'The host must supply the exclusive HMS lease and dispatch marker.');
  }
  const { executionId, prepared: snapshot, ...request } = parsed.data;
  const reviewed = snapshot && 'native' in snapshot ? snapshot.native : snapshot;
  if (!reviewed) return refuse('AMEND_PREPARE_REQUIRED', 'Prepare the amendment and review its HMS price before Save.');
  if (!isDeepStrictEqual(request, reviewed.request) || reviewed.selected.propertyCode !== request.booking.property_code ||
      request.action.booking_ids[0] !== request.booking.id) {
    return refuse('AMEND_PREPARE_CHANGED', 'The amendment changed after Prepare. Prepare it again.');
  }
  let markerStarted = false;
  let directory: string | undefined;
  const uncertain = (): ToolResult => ({ ok: false, data: null, error: {
    code: 'AMEND_OUTCOME_UNCERTAIN', message: 'Read the stay in HMS before retrying this amendment.',
    retryable: false, outcome: 'uncertain',
  } });
  try {
    const registry: { getPropertyRegistration(code: string): Property | undefined } = await import(nativePath('property-registry'));
    const property = registry.getPropertyRegistration(request.booking.property_code);
    if (!property?.active || !property.transportIds.includes(property.mailboxTransportId)) {
      return refuse('AMEND_PROPERTY_UNSUPPORTED', 'Property has no active native adapter.');
    }
    const native: { commitCloudPaneAmend(input: Record<string, unknown>, authorization: Record<string, unknown>): Promise<unknown> } =
      await import(nativePath('pane-amend-session'));
    directory = await mkdtemp(join(tmpdir(), 'nava-amend-'));
    const beforeScreenshot = join(directory, 'before.png');
    const afterScreenshot = join(directory, 'after.png');
    const operationDigest = createHash('sha256').update(JSON.stringify(reviewed)).digest('hex');
    const response = await native.commitCloudPaneAmend({
      target: property, transportId: property.mailboxTransportId, credentialLease: context.credentialLease,
      selected: reviewed.selected, confirmation: reviewed.selected.confirmation, arrival: reviewed.selected.arrival,
      changes: reviewed.changes, childAgePreimage: reviewed.childAgePreimage,
      nativeDigest: reviewed.nativeDigest, approvedPrices: reviewed.approvedPrices,
      preserved: reviewed.preserved, allowRealGuest: context.mode === 'live', beforeScreenshot, afterScreenshot,
      signal: context.signal,
    }, {
      operationDigest,
      isEnabled: () => !context.signal?.aborted,
      sealBeforeEvidence: async () => ({ eventId: randomUUID(),
        sha256: createHash('sha256').update(await readFile(beforeScreenshot)).digest('hex') }),
      authorizeFirst: async (step: { phase: string; requestDigest: string }) => {
        if (markerStarted || context.signal?.aborted) throw new Error('AMEND_DISPATCH_DISARMED');
        markerStarted = true;
        await context.markDispatched({ workflow: 'amend', executionId, phase: step.phase, requestDigest: step.requestDigest });
        context.signal?.throwIfAborted();
        return { holdId: randomUUID(), ownerToken: randomBytes(32).toString('hex') };
      },
    });
    const result = z.object({ outcome: z.string(), issue: z.string().optional(),
      writerSessionClosed: z.boolean().optional(), dispatchCallbacksDrained: z.boolean().optional(),
      businessFieldsMatched: z.boolean().optional(), readback: z.object({ confirmation: z.string(),
        nativeStayId: nativeId }).passthrough().optional() }).safeParse(response);
    if (markerStarted && result.success && result.data.outcome === 'amended' && result.data.writerSessionClosed &&
        result.data.dispatchCallbacksDrained && result.data.businessFieldsMatched && result.data.readback &&
        result.data.readback.confirmation === reviewed.selected.confirmation &&
        result.data.readback.nativeStayId === reviewed.selected.reservationStayId) {
      return { ok: true, data: { confirmation: result.data.readback.confirmation,
        reservation_id: result.data.readback.nativeStayId, readback: result.data.readback }, error: null };
    }
    if (markerStarted) return uncertain();
    return nativeRefusal(response, 'AMEND_SAVE_REFUSED', 'HMS did not save the amendment.');
  } catch {
    return markerStarted ? uncertain() : refuse('AMEND_SAVE_UNAVAILABLE', 'Native amendment stopped before dispatch.');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export const tools = [{ ...prepareManifest, run: prepare }];
