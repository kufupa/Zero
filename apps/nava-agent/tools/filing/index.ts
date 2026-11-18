import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { filingBooking, filingPrepare, filingSave } from './schema.js';

export const maxFilingPdfBytes = 10 * 1024 * 1024;

/** Both capabilities are installed by the server, never by model input. */
export type ToolContext = {
  sessionId: string;
  mode: 'live' | 'labtest' | 'historical';
  signal?: AbortSignal;
  credentialLease?: unknown;
  authorizeTarget?: (request: TargetAuthorization, options: { signal: AbortSignal }) => Promise<boolean>;
  resolveAttachment?: (request: AttachmentReference, options: { signal: AbortSignal }) => Promise<TrustedAttachment | null>;
};
export type SaveContext = ToolContext & { markDispatched(details: unknown): Promise<void> };

export type TargetAuthorization = {
  sessionId: string; bookingId: string; propertyCode: string; reservationId: string | null; confirmation: string;
};
export type AttachmentReference = {
  sessionId: string;
  messageId: string;
  attachmentId: string;
};
export type TrustedAttachment = AttachmentReference & {
  name: string;
  mimeType: string;
  bytes: Buffer;
};
export type ToolResult = {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; retryable: boolean; outcome: 'known' | 'uncertain' } | null;
};
type NativeIdentity = {
  source: string; propertyCode: string; confirmation: string; reservationId: string;
  reservationStayId: string; guestId: string; firstName: string; lastName: string;
  status: string; arrival: string; departure: string;
};
type NativeRecord = { nativePreimage: NativeIdentity | null; details: { fields: unknown[] } };
type NativeModules = {
  withCloudReadSession: <T>(fn: (page: unknown) => Promise<T>, options: Record<string, unknown>) => Promise<T>;
  readConfirmationFromStay360: (page: unknown, confirmation: string,
    options: { arrivalDate?: string; signal?: AbortSignal }) => Promise<unknown>;
  readRecordViewFromStay360: (page: unknown, confirmation: string, options: Record<string, unknown>) => Promise<NativeRecord>;
  readDocumentsFromStay360: (page: unknown, confirmation: string) => Promise<{
    documents: unknown[];
    coverage: { loadedDocuments: number; refreshVerified: boolean; complete: boolean | null };
    captureScope: string;
  }>;
  installPaneAttachReadGuard: (context: unknown, options: Record<string, unknown>) => Promise<void>;
  filingSnapshot: (record: NativeRecord) => { cmsSend: boolean } | null;
  approvedDocumentDispatch: (record: NativeRecord, stay: Record<string, unknown>, snapshot: { cmsSend: boolean }) => unknown;
  prepareCloudPaneAttach: (input: Record<string, unknown>) => Promise<{ outcome?: string; issue?: string; documentCode?: string }>;
  runCloudPaneAttach: (input: Record<string, unknown>) => Promise<{
    outcome?: string; uploadSent?: boolean; documentCode?: string; listed?: boolean;
    nativeReadback?: unknown; cleanupRoot?: string;
    nativeDiagnostics?: { checkStatus?: number | null; uploadStatus?: number | null; refreshStatus?: number | null;
      visibleDialogs?: number; blockedRequests?: number };
  }>;
  getPropertyRegistration: (propertyCode: string) => { active: boolean; mailboxTransportId: string } | null;
};

const failure = (code: string, message: string, retryable = false): ToolResult => ({
  ok: false, data: null, error: { code, message, retryable, outcome: 'known' },
});
const safeErrorCode = (error: unknown, fallback: string): string =>
  error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : fallback;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\p{Cc}]/u.test(value);

type TargetRequest = {
  bookingId: string; propertyCode: string; reservationId: string | null; confirmation: string;
  fields: Record<string, unknown>;
};
type Request = TargetRequest & { ref: Omit<AttachmentReference, 'sessionId'>; description?: string };

function parseBooking(input: unknown): TargetRequest | null {
  const parsed = filingBooking.safeParse(input);
  if (!parsed.success) return null;
  const booking = parsed.data;
  const state = booking.current_state ?? {};
  const candidates = [booking.fields.confirmation_number, state.confirmation_number, state.confirmation,
    typeof booking.reservation_id === 'string' && /^\d+-\d+$/.test(booking.reservation_id) ? booking.reservation_id : undefined]
    .filter(value => value !== undefined && value !== null);
  if (!candidates.length || candidates.some(value => typeof value !== 'string' || value !== candidates[0]) ||
      typeof candidates[0] !== 'string' || !/^\d{1,95}-\d{1,4}$/.test(candidates[0])) return null;
  return { bookingId: booking.id, propertyCode: booking.property_code, reservationId: booking.reservation_id,
    confirmation: candidates[0], fields: booking.fields };
}

export function parseFilingRequest(input: unknown): Request | null {
  const parsed = filingPrepare.safeParse(input);
  if (!parsed.success) return null;
  const { booking: inputBooking, action } = parsed.data;
  const booking = parseBooking(inputBooking);
  if (!booking || action.booking_ids[0] !== booking.bookingId) return null;
  const details = action.details;
  return {
    ...booking,
    ref: { messageId: details.message_id, attachmentId: details.attachment_id },
    ...(typeof details.description === 'string' ? { description: details.description } : {}),
  };
}

function matchesAttachment(reference: AttachmentReference, attachment: TrustedAttachment | null): attachment is TrustedAttachment {
  return Boolean(attachment && attachment.sessionId === reference.sessionId && attachment.messageId === reference.messageId &&
    attachment.attachmentId === reference.attachmentId &&
    text(attachment.name, 150) && attachment.name === attachment.name.replace(/\s+/g, ' ').trim() &&
    !/["\\/\p{Cc}]/u.test(attachment.name) && /\.pdf$/i.test(attachment.name) &&
    typeof attachment.mimeType === 'string' && attachment.mimeType.toLowerCase() === 'application/pdf' && Buffer.isBuffer(attachment.bytes) &&
    attachment.bytes.length > 5 && attachment.bytes.length <= maxFilingPdfBytes &&
    attachment.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
}

function effectiveSignal(context: ToolContext): AbortSignal | undefined {
  const lease = context.credentialLease;
  const leaseSignal = object(lease) && lease.signal instanceof AbortSignal ? lease.signal : undefined;
  return context.signal && leaseSignal ? AbortSignal.any([context.signal, leaseSignal]) : context.signal ?? leaseSignal;
}

async function bounded<T>(context: ToolContext, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = AbortSignal.timeout(60_000);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const result = await operation(signal);
  signal.throwIfAborted();
  return result;
}

async function authorize(context: ToolContext, request: TargetRequest): Promise<boolean> {
  const check = context.authorizeTarget;
  if (!check) return false;
  const target = { sessionId: context.sessionId, bookingId: request.bookingId, propertyCode: request.propertyCode,
    reservationId: request.reservationId, confirmation: request.confirmation };
  return (await bounded(context, signal => check(target, { signal }))) === true;
}

async function nativeModules(): Promise<NativeModules> {
  const base = new URL('../../../server-pilot/tooling/hms-cloud/', import.meta.url);
  const load = (name: string) => import(new URL(name, base).href);
  const [session, confirmation, record, guard, attach, property, documents] = await Promise.all([
    load('cloud-session.mjs'), load('stay360-confirmation.mjs'), load('stay360-record-view.mjs'),
    load('pane-attach-read-guard.mjs'), load('pane-attach-session.mjs'), load('property-registry.mjs'),
    load('stay360-documents.mjs'),
  ]);
  return { ...session, ...confirmation, ...record, ...guard, ...attach, ...property, ...documents } as NativeModules;
}

function matchesRequestedStay(request: TargetRequest, native: NativeIdentity, mode: ToolContext['mode']): boolean {
  if (native.source !== 'record_view_ext_model' || native.propertyCode !== request.propertyCode ||
      native.confirmation !== request.confirmation ||
      (request.reservationId && request.reservationId !== native.confirmation &&
        request.reservationId !== native.reservationId && request.reservationId !== native.reservationStayId)) return false;
  const name = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  for (const [hint, actual] of [[request.fields.guest_first_name, native.firstName], [request.fields.first_name, native.firstName],
    [request.fields.guest_last_name, native.lastName], [request.fields.last_name, native.lastName]]) {
    if (hint != null && (typeof hint !== 'string' || typeof actual !== 'string' || name(hint) !== name(actual))) return false;
  }
  if ((request.fields.arrival_date != null && request.fields.arrival_date !== native.arrival) ||
      (request.fields.departure_date != null && request.fields.departure_date !== native.departure)) return false;
  return mode !== 'labtest' || (native.firstName === 'Proof' && native.lastName === 'Labtest' &&
    native.arrival >= '2027-01-01' && native.status === 'Reserved');
}

async function observeTarget(native: NativeModules, request: TargetRequest, context: ToolContext,
  transportId: string) {
  const approved = { current: null as NativeIdentity | null };
  return native.withCloudReadSession(async page => {
    const arrivalDate = request.fields.arrival_date;
    await native.readConfirmationFromStay360(page, request.confirmation,
      { arrivalDate: typeof arrivalDate === 'string' ? arrivalDate : undefined, signal: context.signal });
    context.signal?.throwIfAborted();
    const record = await native.readRecordViewFromStay360(page, request.confirmation,
      { nativePropertyCode: request.propertyCode, nativeIdentityOnly: true });
    const identity = record.nativePreimage, snapshot = native.filingSnapshot(record);
    if (!identity || !snapshot || !matchesRequestedStay(request, identity, context.mode) ||
        (context.mode === 'labtest' && snapshot.cmsSend !== false)) return null;
    const stay = { propertyCode: request.propertyCode, confirmation: identity.confirmation,
      firstName: identity.firstName, lastName: identity.lastName, arrival: identity.arrival, departure: identity.departure,
      nativeGuestId: identity.guestId, nativeStayId: identity.reservationStayId, allowRealGuest: context.mode === 'live' };
    if (!native.approvedDocumentDispatch(record, stay, snapshot)) return null;
    approved.current = identity;
    const documents = await native.readDocumentsFromStay360(page, request.confirmation);
    context.signal?.throwIfAborted();
    return { identity, snapshot, stay, documents };
  }, { propertyCode: request.propertyCode, transportId, startScreen: 'OSRESS',
    credentialLease: context.credentialLease, signal: context.signal,
    prepareContext: (browserContext: unknown) => native.installPaneAttachReadGuard(browserContext, {
      propertyCode: request.propertyCode, confirmation: request.confirmation, allowRealGuest: context.mode === 'live',
      getNative: () => approved.current, getApprovedNativeIdentity: () => approved.current,
    }) });
}

/** Read the currently loaded document tree; its completeness remains native-unknown. */
export async function inspect(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (context?.mode === 'historical') return failure('HISTORICAL_HMS_UNAVAILABLE', 'Historical sessions cannot access live HMS.');
  if (!context || !text(context.sessionId) || !['live', 'labtest'].includes(context.mode)) return failure('INVALID_CONTEXT', 'Server session context is invalid.');
  context = { ...context, signal: effectiveSignal(context) };
  if (context.signal?.aborted) return failure('ABORTED', 'Filing document lookup was aborted.');
  const request = object(input) ? parseBooking(input.booking) : null;
  if (!request) return failure('INVALID_FILING_INPUT', 'One booking with its exact confirmation is required.');
  if (typeof context.authorizeTarget !== 'function') return failure('TARGET_AUTHORIZATION_UNAVAILABLE', 'Session-authorized booking selection is unavailable.');
  if (!context.credentialLease) return failure('HMS_ADMISSION_UNAVAILABLE', 'A lease from the existing shared HMS admission service is required.');
  try {
    if (!await authorize(context, request)) return failure('TARGET_NOT_AUTHORIZED', 'The selected booking is outside the session scope.');
    context.signal?.throwIfAborted();
    const native = await nativeModules();
    const property = native.getPropertyRegistration(request.propertyCode);
    if (!property?.active) return failure('PROPERTY_UNAVAILABLE', 'The selected HMS property is unavailable.');
    const target = await observeTarget(native, request, context, property.mailboxTransportId);
    if (!target?.documents) return failure('STAY_MISMATCH', 'The fresh native stay does not match the selected booking or Labtest policy.');
    return { ok: true, data: { outcome: 'documents_read', booking_id: request.bookingId,
      target: { property_code: request.propertyCode, confirmation: target.identity.confirmation,
        reservation_id: target.identity.reservationId, reservation_stay_id: target.identity.reservationStayId },
      documents: target.documents.documents, coverage: target.documents.coverage,
      capture_scope: target.documents.captureScope }, error: null };
  } catch (error) {
    return context.signal?.aborted ? failure('ABORTED', 'Filing document lookup was aborted.')
      : failure(safeErrorCode(error, 'DOCUMENT_READ_UNAVAILABLE'), 'The native document listing could not be verified.', true);
  }
}

/** Save exactly the stay and PDF shown in Prepare, then return the fresh Documents observation. */
export async function save(input: unknown, context: SaveContext): Promise<ToolResult> {
  const parsed = filingSave.safeParse(input);
  const request = parsed.success ? parseFilingRequest({ workflow: parsed.data.workflow, booking: parsed.data.booking, action: parsed.data.action }) : null;
  const prepared = parsed.success ? parsed.data.prepared : undefined;
  if (!parsed.success || !request || !prepared) return failure('INVALID_FILING_INPUT', 'Prepare the selected stay and PDF before Save.');
  if (!context || !text(context.sessionId) || !['live', 'labtest'].includes(context.mode)) return failure('INVALID_CONTEXT', 'Server session context is invalid.');
  if (!context.credentialLease || typeof context.markDispatched !== 'function' ||
      typeof context.authorizeTarget !== 'function' || typeof context.resolveAttachment !== 'function') {
    return failure('FILING_CONTEXT_UNAVAILABLE', 'The shared HMS lease and selected source are required.');
  }
  context = { ...context, signal: effectiveSignal(context) };
  if (context.signal?.aborted) return failure('ABORTED', 'Filing was aborted before dispatch.');
  const reference = { sessionId: context.sessionId, ...request.ref };
  if (prepared.booking_id !== request.bookingId || prepared.target.property_code !== request.propertyCode ||
      prepared.target.confirmation !== request.confirmation || prepared.source.message_id !== reference.messageId ||
      prepared.source.attachment_id !== reference.attachmentId ||
      prepared.document.description !== (request.description ?? prepared.document.name)) {
    return failure('PREPARED_FILING_CHANGED', 'The selected stay or PDF changed; prepare again.');
  }
  let markerStarted = false;
  let temp: string | undefined;
  let nativeCleanup: string | undefined;
  const uncertain = (): ToolResult => ({ ok: false, data: null, error: {
    code: 'FILING_OUTCOME_UNCERTAIN', message: 'Check the stay Documents before retrying.', retryable: false, outcome: 'uncertain',
  } });
  try {
    if (!await authorize(context, request)) return failure('TARGET_NOT_AUTHORIZED', 'The selected booking is outside the session scope.');
    const attachment = await bounded(context, signal => context.resolveAttachment!(reference, { signal }));
    if (!matchesAttachment(reference, attachment) || attachment.name !== prepared.document.name ||
        createHash('sha256').update(attachment.bytes).digest('hex') !== prepared.document.sha256) {
      return failure('ATTACHMENT_CHANGED', 'The selected PDF changed or is unavailable; prepare again.');
    }
    const native = await nativeModules();
    const property = native.getPropertyRegistration(request.propertyCode);
    if (!property?.active) return failure('PROPERTY_UNAVAILABLE', 'The selected HMS property is unavailable.');
    const target = await observeTarget(native, request, context, property.mailboxTransportId);
    if (!target || target.identity.reservationId !== prepared.target.reservation_id || target.identity.status !== prepared.target.native_status ||
        target.identity.reservationStayId !== prepared.target.reservation_stay_id ||
        !isDeepStrictEqual(target.stay, prepared.target.native_stay) ||
        !isDeepStrictEqual(target.snapshot, prepared.target.native_snapshot)) {
      return failure('STAY_MISMATCH', 'The native stay changed since Prepare.');
    }
    temp = await mkdtemp(join(tmpdir(), 'nava-filing-pdf-'));
    const file = join(temp, 'selected.pdf');
    await writeFile(file, attachment.bytes, { mode: 0o600 });
    const allowed = async () => !context.signal?.aborted && await authorize(context, request);
    const result = await native.runCloudPaneAttach({ target: { propertyCode: request.propertyCode },
      transportId: property.mailboxTransportId, credentialLease: context.credentialLease, signal: context.signal,
      confirmation: prepared.target.confirmation, arrival: prepared.target.native_stay.arrival,
      guestName: `${prepared.target.native_stay.firstName} ${prepared.target.native_stay.lastName}`,
      approvedStay: prepared.target.native_stay, approvedSnapshot: prepared.target.native_snapshot,
      allowRealGuest: context.mode === 'live', documentName: prepared.document.name,
      documentDescription: prepared.document.description, documentCode: prepared.document.document_code,
      pdfSha256: prepared.document.sha256, file, beforeDispatch: allowed,
      finalAuthority: async (code: string) => code === prepared.document.document_code && await allowed(),
      continuationAllowed: () => !context.signal?.aborted,
      dispatchWithAuthority: async (code: string, guestId: string, stayId: string, requestDigest: string, send: () => Promise<unknown>) => {
        if (markerStarted || code !== prepared.document.document_code || guestId !== prepared.target.native_stay.nativeGuestId ||
            stayId !== prepared.target.native_stay.nativeStayId || !await allowed()) throw new Error('FILING_DISPATCH_DISARMED');
        markerStarted = true;
        await context.markDispatched({ workflow: 'filing', executionId: parsed.data.executionId, requestDigest,
          confirmation: prepared.target.confirmation, reservationStayId: stayId, documentCode: code });
        context.signal?.throwIfAborted();
        return send();
      },
    });
    nativeCleanup = result.cleanupRoot;
    const readback = result.nativeReadback;
    if (markerStarted && result.outcome === 'confirmed' && result.uploadSent === true && result.listed === true &&
        result.documentCode === prepared.document.document_code && object(readback) &&
        readback.confirmation === prepared.target.confirmation && readback.nativeStayId === prepared.target.native_stay.nativeStayId &&
        readback.nativeGuestId === prepared.target.native_stay.nativeGuestId && readback.documentCode === prepared.document.document_code &&
        readback.documentName === prepared.document.name && readback.documentDescription === prepared.document.description &&
        readback.uniqueFreshListing === true) {
      return { ok: true, data: { confirmation: prepared.target.confirmation,
        reservation_id: prepared.target.reservation_stay_id, readback }, error: null };
    }
    if (markerStarted || result.uploadSent) return uncertain();
    return { ...failure('FILING_SAVE_FAILED', 'The document was not submitted; prepare again.'),
      data: { outcome: result.outcome ?? 'unknown', ...result.nativeDiagnostics } };
  } catch (error) {
    if (markerStarted) return uncertain();
    if (context.signal?.aborted) return failure('ABORTED', 'Filing was aborted before dispatch.');
    return failure(safeErrorCode(error, 'FILING_SAVE_FAILED'), 'Filing failed before dispatch.');
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
    if (nativeCleanup) await rm(nativeCleanup, { recursive: true, force: true }).catch(() => {});
  }
}

/** Open a fresh, bounded native stage. Nothing here dispatches an upload. */
export async function prepare(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (context?.mode === 'historical') return failure('HISTORICAL_HMS_UNAVAILABLE', 'Historical sessions cannot access live HMS.');
  if (!context || !text(context.sessionId) || !['live', 'labtest'].includes(context.mode)) return failure('INVALID_CONTEXT', 'Server session context is invalid.');
  context = { ...context, signal: effectiveSignal(context) };
  if (context.signal?.aborted) return failure('ABORTED', 'Filing preflight was aborted.');
  const request = parseFilingRequest(input);
  if (!request) return failure('INVALID_FILING_INPUT', 'One booking, its exact confirmation, and one selected attachment are required.');
  if (typeof context.authorizeTarget !== 'function') return failure('TARGET_AUTHORIZATION_UNAVAILABLE', 'Session-authorized booking selection is unavailable.');
  if (typeof context.resolveAttachment !== 'function') return failure('ATTACHMENT_SOURCE_UNAVAILABLE', 'Session-authorized attachment resolver is unavailable.');
  if (!context.credentialLease) return failure('HMS_ADMISSION_UNAVAILABLE', 'A lease from the existing shared HMS admission service is required.');
  const reference = { sessionId: context.sessionId, ...request.ref };
  try {
    if (!await authorize(context, request)) return failure('TARGET_NOT_AUTHORIZED', 'The selected booking is outside the session scope.');
    const native = await nativeModules();
    const property = native.getPropertyRegistration(request.propertyCode);
    if (!property?.active) return failure('PROPERTY_UNAVAILABLE', 'The selected HMS property is unavailable.');
    const target = await observeTarget(native, request, context, property.mailboxTransportId);
    context.signal?.throwIfAborted();
    if (!target) return failure('STAY_MISMATCH', 'The fresh native stay does not match the selected booking or Labtest policy.');
    const loaded = target.documents.documents.slice(0, 20).filter(object).map(({ name, documentCode }) => ({
      name: typeof name === 'string' ? name.slice(0, 150) : null,
      document_code: typeof documentCode === 'string' ? documentCode.slice(0, 40) : null,
    }));
    const documents = { coverage: target.documents.coverage, capture_scope: target.documents.captureScope,
      documents: loaded, listed_documents: loaded.length };
    const resolver = context.resolveAttachment;
    const attachment = await bounded(context, signal => resolver(reference, { signal }));
    context.signal?.throwIfAborted();
    if (!matchesAttachment(reference, attachment)) return failure('ATTACHMENT_UNAVAILABLE', 'The selected session attachment is not an available PDF.');
    const bytes = attachment.bytes;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!await authorize(context, request)) return failure('TARGET_NOT_AUTHORIZED', 'The selected booking is outside the session scope.');
    const staged = await native.prepareCloudPaneAttach({ target: { propertyCode: request.propertyCode },
      transportId: property.mailboxTransportId, credentialLease: context.credentialLease, signal: context.signal,
      confirmation: target.identity.confirmation, arrival: target.identity.arrival,
      guestName: `${target.identity.firstName} ${target.identity.lastName}`, approvedStay: target.stay,
      approvedSnapshot: target.snapshot, allowRealGuest: context.mode === 'live', documentName: attachment.name,
      documentDescription: request.description ?? attachment.name, bytes, pdfSha256: sha256 });
    context.signal?.throwIfAborted();
    if (staged.outcome !== 'prepared' || !text(staged.documentCode, 40)) {
      const code = text(staged.issue, 80) && /^[A-Z][A-Z0-9_]+$/.test(staged.issue) ? staged.issue : 'NATIVE_PREPARE_UNAVAILABLE';
      return { ...failure(code, 'The native document form could not be verified without submitting.', true),
        data: { outcome: 'documents_read', ...documents } };
    }
    const description = request.description ?? attachment.name;
    const row = (id: string, label: string, value: string, native_path: string) =>
      ({ id, booking_id: request.bookingId, kind: 'text', label, value, native_path });
    return { ok: true, data: { outcome: 'prepared', unsaved: true, booking_id: request.bookingId,
      target: { property_code: request.propertyCode, confirmation: target.identity.confirmation,
        reservation_id: target.identity.reservationId, reservation_stay_id: target.identity.reservationStayId,
        native_status: target.identity.status, native_stay: target.stay, native_snapshot: target.snapshot },
      source: { message_id: reference.messageId, attachment_id: reference.attachmentId },
      document: { name: attachment.name, mime_type: 'application/pdf', sha256, document_code: staged.documentCode, description },
      ...documents, observed_fields: ['document_code', 'description', 'file'],
      display_rows: [row('filing-target', 'HMS confirmation', target.identity.confirmation, '/target/confirmation'),
        row('filing-file', 'Selected PDF', attachment.name, '/document/name'),
        row('filing-description', 'Description', description, '/document/description'),
        row('filing-code', 'Document code', staged.documentCode, '/document/document_code'),
        row('filing-coverage', 'Existing documents', `${target.documents.coverage.loadedDocuments} loaded; full list unverified.`, '/coverage/loadedDocuments')],
      warnings: ['Document form prepared. Nothing uploaded.', 'The document code identifies the draft, not a verified document category.'] }, error: null };
  } catch (error) {
    return context.signal?.aborted ? failure('ABORTED', 'Filing preflight was aborted.')
      : failure(safeErrorCode(error, 'NATIVE_PREPARE_UNAVAILABLE'), 'Attachment resolution or native preflight failed.', true);
  }
}
