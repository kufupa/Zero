import type { ProposalDraft } from '../../src/schema.js';

export type ToolContext = {
  sessionId: string;
  mode: 'live' | 'labtest' | 'historical';
  signal?: AbortSignal;
  // Acquired by the trusted host from the native shared-admission service.
  credentialLease?: unknown;
};
export type SaveContext = ToolContext & { markDispatched(details: unknown): Promise<void> };
export type ToolResult = {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; retryable: boolean; outcome: 'known' | 'uncertain' } | null;
};

type Parsed = {
  bookingId: string;
  confirmation: string;
  propertyCode: string;
  guestName?: string;
  arrival?: string;
  scope: 'whole_stay' | 'specific_room' | 'unspecified';
  note: string;
  reason?: string;
  currentState?: Record<string, unknown>;
};

type NativeResult = Record<string, unknown>;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const date = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const error = (code: string, message: string, outcome: 'known' | 'uncertain' = 'known'): ToolResult =>
  ({ ok: false, data: null, error: { code, message, retryable: false, outcome } });
const success = (data: unknown): ToolResult => ({ ok: true, data, error: null });

export function withCancelReviewFields(draft: ProposalDraft, nativeReasons: unknown = null): ProposalDraft {
  if (draft.workflow !== 'cancel' || draft.disposition !== 'propose' || draft.actions.length !== 1) return draft;
  const action = draft.actions[0];
  if (action.type !== 'cancel' || action.booking_ids.length !== 1 ||
      (action.details !== null && !object(action.details))) return draft;
  const matches = draft.bookings.map((booking, index) => ({ booking, index }))
    .filter(({ booking }) => booking.id === action.booking_ids[0]);
  if (matches.length !== 1) return draft;
  const { booking, index } = matches[0];
  const details = object(action.details) ? { ...action.details } : {};
  const fields = { ...booking.fields };
  const specs = [...draft.field_specs];
  const reasonOptions = Array.isArray(nativeReasons) ? nativeReasons.flatMap(item =>
    object(item) && text(item.display) && text(item.value) ? [{ value: item.display, label: item.display, meaning: item.value }] : []) : [];
  const definitions = [
    { target: details, key: 'requested_scope', path: '/actions/0/details/requested_scope', label: 'Cancellation scope', control: 'select' as const,
      options: [{ value: 'whole_stay', label: 'Whole stay', meaning: null },
        { value: 'specific_room', label: 'Specific room', meaning: null },
        { value: 'unspecified', label: 'Unspecified', meaning: null }] },
    { target: details, key: 'cancellation_reason', path: '/actions/0/details/cancellation_reason', label: 'Cancellation reason', control: reasonOptions.length ? 'select' as const : 'text' as const, options: reasonOptions },
    { target: details, key: 'cancellation_note', path: '/actions/0/details/cancellation_note', label: 'Cancellation note', control: 'text' as const, options: [] },
    { target: fields, key: 'guest_name', path: `/bookings/${index}/fields/guest_name`, label: 'Guest name', control: 'text' as const, options: [] },
    { target: fields, key: 'arrival_date', path: `/bookings/${index}/fields/arrival_date`, label: 'Arrival date', control: 'date' as const, options: [] },
  ];
  for (const { target, key, path, label, control, options } of definitions) {
    if (!Object.hasOwn(target, key)) target[key] = null;
    const existing = specs.findIndex(spec => spec.path === path || spec.path === path.slice(1));
    if (existing >= 0) specs[existing] = { ...specs[existing], path, control, options, editable: true };
    else specs.push({ path, label, control, options, provenance: 'unknown', editable: true,
      required: false, error: null, evidence: [] });
  }
  const bookings = [...draft.bookings];
  bookings[index] = { ...booking, fields };
  return { ...draft, bookings, actions: [{ ...action, details }], field_specs: specs };
}

function parse(input: unknown): Parsed | null {
  if (!object(input) || input.workflow !== 'cancel' || !object(input.booking) || !object(input.action)) return null;
  const booking = input.booking, action = input.action;
  if (!text(booking.id) || !text(booking.property_code) || !/^[A-Z][A-Z0-9]{1,11}$/.test(booking.property_code) ||
      !text(booking.reservation_id) || !/^(?:\d{6,10}|\d{1,30}-\d{1,10})$/.test(booking.reservation_id) ||
      !(booking.current_state === null || object(booking.current_state)) || !object(booking.fields) ||
      !text(action.id) || action.type !== 'cancel' || !Array.isArray(action.booking_ids) ||
      action.booking_ids.length !== 1 || action.booking_ids[0] !== booking.id ||
      !(action.details === null || object(action.details))) return null;
  const fields = booking.fields, details = object(action.details) ? action.details : {};
  const scope = details.requested_scope ?? 'unspecified';
  if (scope !== 'whole_stay' && scope !== 'specific_room' && scope !== 'unspecified') return null;
  if (fields.arrival_date !== undefined && fields.arrival_date !== null && !date(fields.arrival_date)) return null;
  if (fields.guest_name !== undefined && fields.guest_name !== null &&
      (!text(fields.guest_name) || fields.guest_name.length > 256 || /[\p{Cc}]/u.test(fields.guest_name))) return null;
  const note = details.cancellation_note ?? '';
  const reason = details.cancellation_reason;
  if (typeof note !== 'string' || note.length > 200 || /[\p{Cc}]/u.test(note) ||
      (reason != null && (!text(reason) || reason !== reason.trim() || reason.length > 120 || /[\p{Cc}]/u.test(reason)))) return null;
  return {
    bookingId: booking.id,
    confirmation: booking.reservation_id,
    propertyCode: booking.property_code,
    ...(typeof fields.guest_name === 'string' ? { guestName: fields.guest_name } : {}),
    ...(typeof fields.arrival_date === 'string' ? { arrival: fields.arrival_date } : {}),
    scope, note, ...(typeof reason === 'string' ? { reason } : {}),
    ...(object(booking.current_state) ? {currentState:booking.current_state} : {}),
  };
}

async function nativePreflightModules() {
  const root = new URL('../../../server-pilot/tooling/hms-cloud/', import.meta.url);
  const [preflight, registry] = await Promise.all([
    import(new URL('cancellation-preflight-session.mjs', root).href),
    import(new URL('property-registry.mjs', root).href),
  ]);
  return { preflight, registry };
}

async function nativeWriterModules() {
  const root = new URL('../../../server-pilot/tooling/hms-cloud/', import.meta.url);
  const [cancel, registry] = await Promise.all([
    import(new URL('pane-cancel-session.mjs', root).href),
    import(new URL('property-registry.mjs', root).href),
  ]);
  return { cancel, registry };
}

function nativeFailure(result: NativeResult): ToolResult {
  const issue = typeof result.issue === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.issue)
    ? result.issue : 'HMS_CANCEL_UNAVAILABLE';
  return error(issue, 'Native cancellation preparation did not complete.');
}

function commonInput(target: Parsed, arrival: string, transportId: string, context: ToolContext) {
  return {
    target: { propertyCode: target.propertyCode }, transportId,
    confirmation: target.confirmation, arrival,
    allowRealGuest: context.mode === 'live', credentialLease: context.credentialLease, signal: context.signal,
  };
}

const feeText = (stage: NativeResult): string | null => {
  const value = stage.penaltyText ?? (object(stage.staged) ? stage.staged.penaltyText : null);
  return typeof value === 'string' && value.trim() && value.length <= 2000 ? value : null;
};
const fee = (notice: string | null) => notice
  ? { state: 'review_required', text: notice }
  : { state: 'unknown_precommit', text: null };
const preimageKeys = ['propertyCode', 'confirmation', 'guestId', 'nativeStayId', 'firstName', 'lastName',
  'arrival', 'departure', 'roomType', 'ratePlan', 'note', 'cmsSend', 'allowRealGuest'] as const;
const samePreimage = (left: NativeResult, right: NativeResult) => preimageKeys.every(key => left[key] === right[key]);

async function preview(target: Parsed, arrival: string, transportId: string, context: ToolContext,
  cancel: Awaited<ReturnType<typeof nativeWriterModules>>['cancel']): Promise<NativeResult> {
  return cancel.runCloudPaneCancel({ ...commonInput(target, arrival, transportId, context), mode: 'preview',
    ...(target.reason ? { previewStage: { reasonLabel: target.reason, cancellationNote: target.note } } : {}) });
}

function selectedReason(stage: NativeResult, reason: string | undefined): { code: string; label: string } | null {
  if (!reason || !Array.isArray(stage.reasons)) return null;
  const matches = stage.reasons.filter(item => object(item) && item.display === reason && text(item.value));
  if (matches.length !== 1 || !object(matches[0]) || !text(matches[0].value)) return null;
  return { code: matches[0].value, label: reason };
}

function preflightDisplay(result: NativeResult, bookingId: string) {
  const stay = object(result.stay) ? result.stay : {};
  const observed = (value: unknown) => object(value) && value.state === 'observed' && typeof value.value === 'string'
    ? value.value : null;
  const row = (id: string, label: string, nativePath: string, value: string | null) =>
    ({ id, booking_id: bookingId, label, native_path: nativePath, kind: 'text' as const, value });
  const scope = object(result.roomScope) ? result.roomScope : {};
  const policy = object(result.policy) ? result.policy : {};
  const fee = object(result.fee) ? result.fee : {};
  return [
    row('target', 'Reservation', '/target/confirmation', object(result.target) && typeof result.target.confirmation === 'string' ? result.target.confirmation : null),
    row('status', 'Current status', '/stay/status', observed(stay.status)),
    row('arrival', 'Arrival', '/stay/arrivalDate', observed(stay.arrivalDate)),
    row('departure', 'Departure', '/stay/departureDate', observed(stay.departureDate)),
    row('scope', 'Requested scope', '/roomScope/requested', typeof scope.requested === 'string' ? scope.requested : null),
    row('scope-coverage', 'Scope verification', '/roomScope/complete', scope.complete === true ? 'Complete' : 'Incomplete; staff review required'),
    row('policy', 'Cancellation policy', '/policy/state', policy.state === 'unknown' ? 'Not verified by this read' : null),
    row('fee', 'Cancellation fee', '/fee/state', fee.state === 'unknown_precommit' ? 'Unknown before commit' : null),
  ];
}

export async function prepare(input: unknown, context: ToolContext): Promise<ToolResult> {
  const target = parse(input);
  if (!target) return error('INVALID_CANCEL_INPUT', 'Provide one cancellation target and action.');
  if (!context || !text(context.sessionId) || !['live', 'labtest', 'historical'].includes(context.mode)) {
    return error('INVALID_CONTEXT', 'A server-managed session is required.');
  }
  if (context.mode === 'historical') return error('HISTORICAL_HMS_FORBIDDEN', 'Historical sessions cannot access live HMS.');
  if (context.signal?.aborted) return error('ABORTED', 'Cancellation preparation was aborted.');
  if (!context.credentialLease) return error('HMS_SHARED_LEASE_REQUIRED', 'The host must supply a native shared HMS credential lease.');
  if (target.scope !== 'whole_stay') return error('CANCEL_SCOPE_REQUIRES_REVIEW', 'Choose the whole stay before preparing this cancellation.');
  try {
    const [{ preflight, registry }, { cancel }] = await Promise.all([nativePreflightModules(), nativeWriterModules()]);
    const property = registry.getPropertyRegistration(target.propertyCode);
    if (!property?.active || !text(property.mailboxTransportId)) return error('HMS_PROPERTY_UNSUPPORTED', 'Property is not supported.');
    const readResult = await preflight.withCancellationPreflightSession(async ({ runTool }: { runTool: (request: unknown) => Promise<NativeResult> }) => {
      const read = await runTool({ tool: 'read', confirmation: target.confirmation, includeNativePreimage: true,
        ...(target.guestName ? { guestName: target.guestName } : {}),
        ...(target.arrival ? { arrivalDate: target.arrival } : {}) });
      if (read.outcome !== 'ok') return { failure: nativeFailure(read) };
      const result = await runTool({ tool: 'prepareCancellation', requestedScope: target.scope });
      if (result.outcome !== 'prepared_for_human_review') return { failure: nativeFailure(result) };
      const stay = object(result.stay) ? result.stay : {};
      const status = object(stay.status) ? stay.status : {};
      if (status.state !== 'observed' || typeof status.value !== 'string' || status.value.trim().toLowerCase() !== 'reserved') {
        return { failure: { ...error('CANCEL_STATUS_REQUIRES_REVIEW', 'Fresh status is not Reserved; staff review is required.'), data: result } };
      }
      const record = object(read.record) ? read.record : {};
      const identity = object(record.nativePreimage) ? record.nativePreimage : null;
      return { result, identity };
    }, { propertyCode: target.propertyCode, transportId: property.mailboxTransportId,
      confirmation: target.confirmation, signal: context.signal, credentialLease: context.credentialLease });
    if (readResult.failure) return readResult.failure;
    const { result, identity } = readResult;
    if (!identity || !date(identity.arrival) || identity.confirmation !== target.confirmation ||
        identity.propertyCode !== target.propertyCode || (target.arrival && identity.arrival !== target.arrival)) {
      return error('CANCEL_TARGET_UNVERIFIED', 'The reservation target or arrival could not be verified.');
    }
    for (const [key,native] of Object.entries({first_name:'firstName',last_name:'lastName',arrival_date:'arrival',departure_date:'departure',
      native_stay_id:'reservationStayId',guest_id:'guestId',reservation_id:'reservationId',record_id:'recordId'})) {
      const expected=target.currentState?.[key];
      if(expected!==undefined && expected!==identity[native]) return error('CANCEL_TARGET_CHANGED', 'The selected stay changed. Read it again before preparing.');
    }
    const stage = await preview(target, identity.arrival, property.mailboxTransportId, context, cancel);
    const expected = object(stage.expected) ? stage.expected : null;
    if (!['preview_ok', 'refused_reason_missing'].includes(String(stage.outcome)) || stage.requestDispatched !== false || !expected ||
        expected.confirmation !== identity.confirmation || expected.propertyCode !== identity.propertyCode ||
        expected.nativeStayId !== identity.reservationStayId || expected.guestId !== identity.guestId ||
        expected.firstName !== identity.firstName || expected.lastName !== identity.lastName ||
        expected.arrival !== identity.arrival || expected.departure !== identity.departure) return nativeFailure(stage);
    const reason = selectedReason(stage, target.reason);
    const notice = feeText(stage);
    const data = { ...result, native: { expected, reason, guestName: target.guestName ?? null,
      arrivalHint: target.arrival ?? null, cancellationNote: target.note, penaltyText: notice,
      feeDialogPending: stage.feeDialogPending === true },
      reasons: stage.reasons ?? [], policy_facts: stage.policyFacts ?? [],
      display_rows: [...preflightDisplay(result, target.bookingId).filter(row => row.id !== 'fee'),
        { id: 'cancel-reason', booking_id: target.bookingId, label: 'Cancellation reason', native_path: '/native/reason/label', kind: 'text' as const, value: reason?.label ?? null },
        { id: 'cancel-reason-options', booking_id: target.bookingId, label: 'HMS cancellation reasons', native_path: '/reasons', kind: 'text' as const,
          value: Array.isArray(stage.reasons) ? stage.reasons.flatMap(item => object(item) && text(item.display) ? [item.display] : []).join(', ') || null : null },
        { id: 'cancel-fee', booking_id: target.bookingId, label: 'Cancellation fee or penalty', native_path: '/cancellation_fee/text', kind: 'text' as const, value: notice ?? 'Not shown by HMS before Save' }],
      cancellation_fee: fee(notice), request_dispatched: false };
    if (stage.feeDialogPending === true && !notice) {
      return { ...error('CANCEL_PENALTY_UNAVAILABLE', 'HMS reported a penalty but did not provide its text. Review the reservation in HMS.'), data };
    }
    if (!reason) return { ...error('CANCEL_REASON_REQUIRED', 'Choose a cancellation reason from the HMS reasons and run Prepare again.'), data };
    if (!stage.feeDialogPending && (!object(stage.staged) || stage.staged.reasonCode !== reason.code ||
        stage.staged.reasonLabel !== reason.label || stage.staged.cancellationNote !== target.note)) {
      return { ...nativeFailure(stage), data };
    }
    return success(data);
  } catch (cause) {
    if (context.signal?.aborted) return error('ABORTED', 'Cancellation preparation was aborted.');
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'HMS_PREPARE_FAILED';
    return error(code, 'Native cancellation preparation failed.');
  }
}

export async function save(input: unknown, context: SaveContext): Promise<ToolResult> {
  const target = parse(input);
  if (!target || !object(input) || !text(input.executionId) || input.executionId.length > 200) {
    return error('INVALID_CANCEL_INPUT', 'A cancellation target and execution ID are required.');
  }
  if (!context || !['live', 'labtest'].includes(context.mode) || !text(context.sessionId)) {
    return error('INVALID_CONTEXT', 'A staff session is required.');
  }
  if (target.scope !== 'whole_stay') return error('CANCEL_SCOPE_REQUIRES_REVIEW', 'Choose the whole stay before cancellation.');
  if (context.signal?.aborted) return error('ABORTED', 'Cancellation was aborted before dispatch.');
  if (!context.credentialLease || typeof context.markDispatched !== 'function') {
    return error('HMS_SHARED_LEASE_REQUIRED', 'The host must supply an exclusive native HMS lease and durable dispatch marker.');
  }
  const prepared = object(input.prepared) ? input.prepared : null;
  const native = prepared && object(prepared.native) ? prepared.native : null;
  const expected = native && object(native.expected) ? native.expected : null;
  const reason = native && object(native.reason) ? native.reason : null;
  const preparedFee = prepared && object(prepared.cancellation_fee) ? prepared.cancellation_fee : null;
  const shownNotice = native && typeof native.penaltyText === 'string' ? native.penaltyText : null;
  if (!expected || !reason || !text(reason.code) || !text(reason.label) || reason.label !== target.reason ||
      native?.cancellationNote !== target.note || native?.guestName !== (target.guestName ?? null) ||
      native?.arrivalHint !== (target.arrival ?? null) || expected.propertyCode !== target.propertyCode ||
      expected.confirmation !== target.confirmation || !date(expected.arrival) ||
      (target.arrival && expected.arrival !== target.arrival) || !preparedFee ||
      preparedFee.text !== shownNotice || preparedFee.state !== fee(shownNotice).state) {
    return error('CANCEL_PREPARE_REQUIRED', 'Run Prepare for this reservation and reason before Go.');
  }
  if (shownNotice && input.confirmPenalty !== true) {
    return { ...error('CANCEL_PENALTY_CONFIRMATION_REQUIRED', 'Review the displayed cancellation penalty and confirm it before Go.'),
      data: { cancellation_fee: fee(shownNotice) } };
  }
  const executionId = input.executionId;
  let markerStarted = false;
  let currentNotice: string | null = null;
  let feeChanged = false;
  let cancellationReleased = false;
  let chargeReleased = false;
  try {
    const { cancel, registry } = await nativeWriterModules();
    const property = registry.getPropertyRegistration(target.propertyCode);
    if (!property?.active || !text(property.mailboxTransportId)) return error('HMS_PROPERTY_UNSUPPORTED', 'Property is not supported.');
    const stage = await preview(target, expected.arrival, property.mailboxTransportId, context, cancel);
    const freshExpected = object(stage.expected) ? stage.expected : null;
    const freshReason = selectedReason(stage, target.reason);
    if (stage.outcome !== 'preview_ok' || stage.requestDispatched !== false || !freshExpected || !samePreimage(expected, freshExpected)) {
      return error('CANCEL_RECHECK_CHANGED', 'The reservation could not be rechecked. Run Prepare again.');
    }
    currentNotice = feeText(stage);
    if (stage.feeDialogPending === true && !currentNotice) {
      return { ...error('CANCEL_PENALTY_UNAVAILABLE', 'HMS reported a penalty but did not provide its text. Review the reservation in HMS.'),
        data: { cancellation_fee: { state: 'review_required', text: null } } };
    }
    if (currentNotice !== shownNotice && !(currentNotice === null && native?.commitPenaltyText === shownNotice && input.confirmPenalty === true)) {
      return { ...error('CANCEL_PENALTY_CHANGED', 'The cancellation penalty changed. Review it and run Prepare again.'),
        data: { cancellation_fee: fee(currentNotice) } };
    }
    if (!freshReason || freshReason.code !== reason.code || freshReason.label !== reason.label ||
        (!stage.feeDialogPending && (!object(stage.staged) || stage.staged.reasonCode !== reason.code ||
          stage.staged.reasonLabel !== reason.label || stage.staged.cancellationNote !== target.note))) {
      return error('CANCEL_RECHECK_CHANGED', 'The reservation or cancellation reason changed. Run Prepare again.');
    }
    const mark = async (details: unknown) => {
      if (markerStarted || context.signal?.aborted) throw new Error('CANCEL_DISPATCH_DISARMED');
      markerStarted = true;
      await context.markDispatched(details);
      if (context.signal?.aborted) throw new Error('CANCEL_DISPATCH_DISARMED');
    };
    const result: NativeResult = await cancel.runCloudPaneCancel({
      ...commonInput(target, expected.arrival, property.mailboxTransportId, context), mode: 'commit', expected,
      reasonCode: reason.code, reasonLabel: reason.label, cancellationNote: target.note,
      commitBudgetMs: 20 * 60_000,
      continuationAllowed: () => !context.signal?.aborted,
      beforeDispatch: async () => !context.signal?.aborted,
      awaitChargeApproval: async (dialog: { text?: unknown }) => {
        const observed = typeof dialog.text === 'string' ? dialog.text : null;
        currentNotice = observed;
        feeChanged = observed !== shownNotice;
        return !feeChanged && shownNotice !== null && input.confirmPenalty === true && !context.signal?.aborted;
      },
      prepareChargeWithAuthority: async () => {
        if (!markerStarted) await mark({ workflow: 'cancel', executionId, propertyCode: target.propertyCode, action: 'penalty_acceptance' });
      },
      dispatchWithAuthority: async (send: () => Promise<unknown>, digest: string) => {
        if (cancellationReleased) throw new Error('CANCEL_DISPATCH_DISARMED');
        if (!markerStarted) await mark({ workflow: 'cancel', executionId, requestDigest: digest });
        if (context.signal?.aborted) throw new Error('CANCEL_DISPATCH_DISARMED');
        cancellationReleased = true;
        return send();
      },
      dispatchChargeWithAuthority: async (send: () => Promise<unknown>) => {
        if (!markerStarted || chargeReleased || context.signal?.aborted) throw new Error('CANCEL_DISPATCH_DISARMED');
        chargeReleased = true;
        return send();
      },
    });
    const readback = result.nativeReadback;
    const resultNotice = feeText(result);
    const verifiedZeroNotice = result.outcome === 'cancelled' &&
      result.zeroPenaltyNotice === 'Cancellation Penalty of 0.00 may be added to account.';
    const confirmedResultFee = !resultNotice || verifiedZeroNotice || (shownNotice !== null && input.confirmPenalty === true &&
      resultNotice === shownNotice);
    if (markerStarted && result.outcome === 'cancelled' && result.requestDispatched === true && confirmedResultFee &&
        object(readback) && readback.confirmation === expected.confirmation &&
        readback.nativeStayId === expected.nativeStayId && readback.nativeGuestId === expected.guestId &&
        typeof readback.status === 'string' && /^cancel(?:l)?ed$/i.test(readback.status) &&
        readback.reasonCode === reason.code && readback.cancellationNote === target.note) {
      return success({ confirmation: target.confirmation, reservation_id: readback.nativeStayId, readback });
    }
    if (markerStarted || result.requestDispatched === true) {
      return { ...error('CANCEL_OUTCOME_UNCERTAIN', 'Reconcile the cancellation and any fee in a fresh session before retrying.', 'uncertain'),
        data: { cancellation_fee: fee(feeText(result) ?? currentNotice ?? shownNotice), readback: readback ?? null } };
    }
    if (feeChanged || feeText(result)) {
      return { ...error('CANCEL_PENALTY_CHANGED', 'The cancellation penalty changed. Review it and run Prepare again.'),
        data: { cancellation_fee: fee(currentNotice ?? feeText(result)) } };
    }
    return nativeFailure(result);
  } catch (cause) {
    if (markerStarted) return { ...error('CANCEL_OUTCOME_UNCERTAIN', 'Reconcile the cancellation in a fresh session before retrying.', 'uncertain'),
      data: { cancellation_fee: fee(currentNotice ?? shownNotice) } };
    if (context.signal?.aborted) return error('ABORTED', 'Cancellation was aborted before dispatch.');
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'HMS_CANCEL_FAILED';
    return error(code, 'Native cancellation failed before dispatch.');
  }
}
