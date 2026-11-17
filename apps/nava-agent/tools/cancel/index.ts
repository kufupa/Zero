import { prepareSchema, toolName } from './schema.js';

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
  confirmation: string;
  propertyCode: string;
  guestName?: string;
  arrival?: string;
  scope: 'whole_stay' | 'specific_room' | 'unspecified';
  note: string;
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
  if (typeof note !== 'string' || note.length > 200 || /[\p{Cc}]/u.test(note)) return null;
  return {
    confirmation: booking.reservation_id,
    propertyCode: booking.property_code,
    ...(typeof fields.guest_name === 'string' ? { guestName: fields.guest_name } : {}),
    ...(typeof fields.arrival_date === 'string' ? { arrival: fields.arrival_date } : {}),
    scope, note,
  };
}

async function nativeModules() {
  const root = new URL('../../../server-pilot/tooling/hms-cloud/', import.meta.url);
  const [preflight, cancel, registry] = await Promise.all([
    import(new URL('cancellation-preflight-session.mjs', root).href),
    import(new URL('pane-cancel-session.mjs', root).href),
    import(new URL('property-registry.mjs', root).href),
  ]);
  return { preflight, cancel, registry };
}

function nativeFailure(result: NativeResult): ToolResult {
  const issue = typeof result.issue === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.issue)
    ? result.issue : 'HMS_CANCEL_UNAVAILABLE';
  return error(issue, 'Native cancellation preparation did not complete.');
}

function commonInput(target: Parsed, transportId: string, context: ToolContext) {
  return {
    target: { propertyCode: target.propertyCode }, transportId,
    confirmation: target.confirmation, arrival: target.arrival,
    allowRealGuest: false, credentialLease: context.credentialLease, signal: context.signal,
  };
}

async function labStage(target: Parsed, transportId: string, context: ToolContext, cancel: Awaited<ReturnType<typeof nativeModules>>['cancel']) {
  return cancel.runCloudPaneCancel({ ...commonInput(target, transportId, context), mode: 'preview',
    previewStage: { reasonLabel: 'Test Reservations', cancellationNote: target.note } });
}

function validateStage(stage: NativeResult): ToolResult | null {
  if (stage.feeDialogPending === true || stage.penaltyText || (object(stage.staged) && stage.staged.penaltyText)) {
    const notice = stage.penaltyText ?? (object(stage.staged) ? stage.staged.penaltyText : null);
    return { ...error('CANCEL_FEE_REQUIRES_REVIEW', 'Cancellation fee or penalty requires review; no acceptance is authorized.'),
      data: { fee: { state: 'review_required', text: typeof notice === 'string' && notice.length <= 2000 ? notice : null },
        policy_facts: stage.policyFacts ?? [] } };
  }
  if (stage.outcome !== 'preview_ok' || stage.requestDispatched !== false || !object(stage.expected) ||
      !object(stage.staged) || stage.staged.reasonCode !== 'TEST' || stage.staged.reasonLabel !== 'Test Reservations') {
    return nativeFailure(stage);
  }
  return null;
}

function labTarget(target: Parsed): boolean {
  return target.propertyCode === 'HRCEN' && /^\d+-\d+$/.test(target.confirmation) &&
    target.arrival !== undefined && target.arrival >= '2027-01-01' && target.scope === 'whole_stay';
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
  try {
    const { preflight, cancel, registry } = await nativeModules();
    const property = registry.getPropertyRegistration(target.propertyCode);
    if (!property?.active || !text(property.mailboxTransportId)) return error('HMS_PROPERTY_UNSUPPORTED', 'Property is not supported.');
    if (context.mode === 'labtest') {
      if (!labTarget(target)) return error('LABTEST_TARGET_REQUIRED', 'Use one whole Proof Labtest stay at HRCEN with arrival in 2027 or later.');
      const stage: NativeResult = await labStage(target, property.mailboxTransportId, context, cancel);
      const refusal = validateStage(stage);
      if (refusal) return refusal;
      return success({ outcome: 'staged', expected: stage.expected, staged: stage.staged,
        policy_facts: stage.policyFacts ?? [], fee: { state: 'unknown_precommit' }, request_dispatched: false });
    }
    return await preflight.withCancellationPreflightSession(async ({ runTool }: { runTool: (request: unknown) => Promise<NativeResult> }) => {
      const read = await runTool({ tool: 'read', confirmation: target.confirmation,
        ...(target.guestName ? { guestName: target.guestName } : {}),
        ...(target.arrival ? { arrivalDate: target.arrival } : {}) });
      if (read.outcome !== 'ok') return nativeFailure(read);
      const result = await runTool({ tool: 'prepareCancellation', requestedScope: target.scope });
      return result.outcome === 'prepared_for_human_review' ? success(result) : nativeFailure(result);
    }, { propertyCode: target.propertyCode, transportId: property.mailboxTransportId,
      confirmation: target.confirmation, signal: context.signal, credentialLease: context.credentialLease });
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
  if (!context || context.mode !== 'labtest' || !text(context.sessionId) || !labTarget(target)) {
    return error('LABTEST_ONLY', 'Cancellation Save is limited to a whole HRCEN Proof Labtest stay in 2027 or later.');
  }
  if (context.signal?.aborted) return error('ABORTED', 'Cancellation was aborted before dispatch.');
  if (!context.credentialLease || typeof context.markDispatched !== 'function') {
    return error('HMS_SHARED_LEASE_REQUIRED', 'The host must supply an exclusive native HMS lease and durable dispatch marker.');
  }
  const executionId = input.executionId;
  let markerStarted = false;
  try {
    const { cancel, registry } = await nativeModules();
    const property = registry.getPropertyRegistration(target.propertyCode);
    if (!property?.active || !text(property.mailboxTransportId)) return error('HMS_PROPERTY_UNSUPPORTED', 'Property is not supported.');
    const stage: NativeResult = await labStage(target, property.mailboxTransportId, context, cancel);
    const refusal = validateStage(stage);
    if (refusal) return refusal;
    const expected = stage.expected;
    const result: NativeResult = await cancel.runCloudPaneCancel({
      ...commonInput(target, property.mailboxTransportId, context), mode: 'commit', expected,
      reasonCode: 'TEST', reasonLabel: 'Test Reservations', cancellationNote: target.note,
      commitBudgetMs: 20 * 60_000,
      continuationAllowed: () => !context.signal?.aborted,
      beforeDispatch: async () => !context.signal?.aborted,
      dispatchWithAuthority: async (send: () => Promise<unknown>, digest: string) => {
        if (markerStarted || context.signal?.aborted) throw new Error('CANCEL_DISPATCH_DISARMED');
        markerStarted = true;
        await context.markDispatched({ workflow: 'cancel', executionId, requestDigest: digest });
        if (context.signal?.aborted) throw new Error('CANCEL_DISPATCH_DISARMED');
        return send();
      },
    });
    const readback = result.nativeReadback;
    if (markerStarted && result.outcome === 'cancelled' && result.requestDispatched === true &&
        result.chargeApproved === false && result.chargeDispatched === false && object(readback) &&
        object(expected) && readback.confirmation === expected.confirmation &&
        readback.nativeStayId === expected.nativeStayId && readback.nativeGuestId === expected.guestId &&
        typeof readback.status === 'string' && /^cancel(?:l)?ed$/i.test(readback.status) &&
        readback.reasonCode === 'TEST' && readback.cancellationNote === target.note) {
      return success({ confirmation: target.confirmation, reservation_id: readback.nativeStayId, readback });
    }
    if (markerStarted || result.requestDispatched === true) {
      return error('CANCEL_OUTCOME_UNCERTAIN', 'Reconcile the cancellation and any fee in a fresh session before retrying.', 'uncertain');
    }
    return nativeFailure(result);
  } catch (cause) {
    if (markerStarted) return error('CANCEL_OUTCOME_UNCERTAIN', 'Reconcile the cancellation in a fresh session before retrying.', 'uncertain');
    if (context.signal?.aborted) return error('ABORTED', 'Cancellation was aborted before dispatch.');
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'HMS_CANCEL_FAILED';
    return error(code, 'Native cancellation failed before dispatch.');
  }
}

export const tools = [{
  name: toolName,
  description: 'Prepare cancellation facts for one reservation. Live mode reads only; Labtest mode stages without saving.',
  input_schema: prepareSchema,
  run: prepare,
}];
