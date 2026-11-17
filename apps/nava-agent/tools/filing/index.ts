import { createHash } from 'node:crypto';
import { filingPrepareSchema } from './schema.js';

/** Both capabilities are installed by the server, never by model input. */
export type ToolContext = {
  sessionId: string;
  mode: 'live' | 'labtest' | 'historical';
  signal?: AbortSignal;
  hmsCredentialLease?: unknown;
  resolveAttachment?: (request: AttachmentReference) => Promise<TrustedAttachment | null>;
};

type AttachmentReference = {
  sessionId: string;
  messageId: string;
  attachmentId: string;
  handle: string;
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
  readConfirmationFromStay360: (page: unknown, confirmation: string, options?: Record<string, string>) => Promise<unknown>;
  readRecordViewFromStay360: (page: unknown, confirmation: string, options: Record<string, unknown>) => Promise<NativeRecord>;
  installPaneAttachReadGuard: (context: unknown, options: Record<string, unknown>) => Promise<void>;
  filingSnapshot: (record: NativeRecord) => { cmsSend: boolean } | null;
  approvedDocumentDispatch: (record: NativeRecord, stay: Record<string, unknown>, snapshot: { cmsSend: boolean }) => unknown;
  prepareCloudPaneAttach: (input: Record<string, unknown>) => Promise<{ outcome?: string; issue?: string; documentCode?: string }>;
  getPropertyRegistration: (propertyCode: string) => { active: boolean; mailboxTransportId: string } | null;
};

const failure = (code: string, message: string, retryable = false): ToolResult => ({
  ok: false, data: null, error: { code, message, retryable, outcome: 'known' },
});
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\p{Cc}]/u.test(value);

type Request = {
  bookingId: string; propertyCode: string; reservationId: string | null; confirmation: string;
  fields: Record<string, unknown>; ref: Omit<AttachmentReference, 'sessionId'>; description?: string;
};

function parse(input: unknown): Request | null {
  if (!object(input) || input.workflow !== 'filing' || !object(input.booking) || !object(input.action)) return null;
  const booking = input.booking, action = input.action;
  if (!text(booking.id) || !text(booking.property_code, 20) || !/^[A-Z0-9]+$/.test(booking.property_code) ||
      !(booking.reservation_id === null || text(booking.reservation_id, 128)) || !object(booking.fields) ||
      !(booking.current_state === null || object(booking.current_state)) || !text(action.id) ||
      !['filing', 'attach_document', 'voucher_submission', 'payment_proof_submission'].includes(String(action.type)) ||
      !Array.isArray(action.booking_ids) || action.booking_ids.length !== 1 || action.booking_ids[0] !== booking.id ||
      !object(action.details)) return null;
  const details = action.details;
  if (Object.keys(details).some(key => !['message_id', 'attachment_id', 'attachment_handle', 'description'].includes(key)) ||
      !text(details.message_id) || !text(details.attachment_id) || !text(details.attachment_handle, 2048) ||
      (details.description !== undefined && !text(details.description, 200))) return null;
  const state = object(booking.current_state) ? booking.current_state : {};
  const candidates = [booking.fields.confirmation_number, state.confirmation_number, state.confirmation,
    typeof booking.reservation_id === 'string' && /^\d+-\d+$/.test(booking.reservation_id) ? booking.reservation_id : undefined]
    .filter(value => value !== undefined && value !== null);
  if (!candidates.length || candidates.some(value => typeof value !== 'string' || value !== candidates[0]) ||
      typeof candidates[0] !== 'string' || !/^\d{1,95}-\d{1,4}$/.test(candidates[0])) return null;
  return {
    bookingId: booking.id, propertyCode: booking.property_code, reservationId: booking.reservation_id,
    confirmation: candidates[0], fields: booking.fields,
    ref: { messageId: details.message_id, attachmentId: details.attachment_id, handle: details.attachment_handle },
    ...(typeof details.description === 'string' ? { description: details.description } : {}),
  };
}

function matchesAttachment(reference: AttachmentReference, attachment: TrustedAttachment | null): attachment is TrustedAttachment {
  return Boolean(attachment && attachment.sessionId === reference.sessionId && attachment.messageId === reference.messageId &&
    attachment.attachmentId === reference.attachmentId && attachment.handle === reference.handle &&
    text(attachment.name, 150) && attachment.name === attachment.name.replace(/\s+/g, ' ').trim() &&
    !/["\\/\p{Cc}]/u.test(attachment.name) && /\.pdf$/i.test(attachment.name) &&
    attachment.mimeType.toLowerCase() === 'application/pdf' && Buffer.isBuffer(attachment.bytes) &&
    attachment.bytes.length > 5 && attachment.bytes.length <= 10 * 1024 * 1024 &&
    attachment.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
}

async function nativeModules(): Promise<NativeModules> {
  const base = new URL('../../../server-pilot/tooling/hms-cloud/', import.meta.url);
  const load = (name: string) => import(new URL(name, base).href);
  const [session, confirmation, record, guard, attach, property] = await Promise.all([
    load('cloud-session.mjs'), load('stay360-confirmation.mjs'), load('stay360-record-view.mjs'),
    load('pane-attach-read-guard.mjs'), load('pane-attach-session.mjs'), load('property-registry.mjs'),
  ]);
  return { ...session, ...confirmation, ...record, ...guard, ...attach, ...property } as NativeModules;
}

function matchesRequestedStay(request: Request, native: NativeIdentity, mode: ToolContext['mode']): boolean {
  if (native.source !== 'record_view_ext_model' || native.propertyCode !== request.propertyCode ||
      native.confirmation !== request.confirmation ||
      (request.reservationId && request.reservationId !== native.confirmation &&
        request.reservationId !== native.reservationId && request.reservationId !== native.reservationStayId)) return false;
  const hints = { first_name: native.firstName, last_name: native.lastName,
    arrival_date: native.arrival, departure_date: native.departure };
  if (Object.entries(hints).some(([key, value]) => request.fields[key] != null && request.fields[key] !== value)) return false;
  return mode !== 'labtest' || (native.firstName === 'Proof' && native.lastName === 'Labtest' &&
    native.arrival >= '2027-01-01' && native.status === 'Reserved');
}

/** Open a fresh, bounded native stage. Nothing here dispatches an upload. */
export async function prepare(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (context?.mode === 'historical') return failure('HISTORICAL_HMS_UNAVAILABLE', 'Historical sessions cannot access live HMS.');
  if (!context || !text(context.sessionId) || !['live', 'labtest'].includes(context.mode)) return failure('INVALID_CONTEXT', 'Server session context is invalid.');
  if (context.signal?.aborted) return failure('ABORTED', 'Filing preflight was aborted.');
  const request = parse(input);
  if (!request) return failure('INVALID_FILING_INPUT', 'One booking, its exact confirmation, and one selected attachment are required.');
  if (typeof context.resolveAttachment !== 'function') return failure('ATTACHMENT_SOURCE_UNAVAILABLE', 'Session-authorized attachment resolver is unavailable.');
  if (!context.hmsCredentialLease) return failure('HMS_ADMISSION_UNAVAILABLE', 'A lease from the existing shared HMS admission service is required.');
  const reference = { sessionId: context.sessionId, ...request.ref };
  try {
    const attachment = await context.resolveAttachment(reference);
    context.signal?.throwIfAborted();
    if (!matchesAttachment(reference, attachment)) return failure('ATTACHMENT_UNAVAILABLE', 'The selected session attachment is not an available PDF.');
    const bytes = Buffer.from(attachment.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const native = await nativeModules();
    const property = native.getPropertyRegistration(request.propertyCode);
    if (!property?.active) return failure('PROPERTY_UNAVAILABLE', 'The selected HMS property is unavailable.');
    const approved = { current: null as NativeIdentity | null };
    const target = await native.withCloudReadSession(async page => {
      await native.readConfirmationFromStay360(page, request.confirmation);
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
      return { identity, snapshot, stay };
    }, { propertyCode: request.propertyCode, transportId: property.mailboxTransportId, startScreen: 'OSRESS',
      credentialLease: context.hmsCredentialLease, signal: context.signal,
      prepareContext: (browserContext: unknown) => native.installPaneAttachReadGuard(browserContext, {
        propertyCode: request.propertyCode, confirmation: request.confirmation, allowRealGuest: context.mode === 'live',
        getNative: () => approved.current, getApprovedNativeIdentity: () => approved.current,
      }) });
    context.signal?.throwIfAborted();
    if (!target) return failure('STAY_MISMATCH', 'The fresh native stay does not match the selected booking or Labtest policy.');
    const staged = await native.prepareCloudPaneAttach({ target: { propertyCode: request.propertyCode },
      transportId: property.mailboxTransportId, credentialLease: context.hmsCredentialLease, signal: context.signal,
      confirmation: target.identity.confirmation, arrival: target.identity.arrival,
      guestName: `${target.identity.firstName} ${target.identity.lastName}`, approvedStay: target.stay,
      approvedSnapshot: target.snapshot, allowRealGuest: context.mode === 'live', documentName: attachment.name,
      documentDescription: request.description ?? attachment.name, bytes, pdfSha256: sha256 });
    context.signal?.throwIfAborted();
    if (staged.outcome !== 'prepared' || !text(staged.documentCode, 40)) {
      const code = text(staged.issue, 80) && /^[A-Z][A-Z0-9_]+$/.test(staged.issue) ? staged.issue : 'NATIVE_PREPARE_UNAVAILABLE';
      return failure(code, 'The native document form could not be verified without submitting.', true);
    }
    return { ok: true, data: { outcome: 'prepared', booking_id: request.bookingId,
      target: { property_code: request.propertyCode, confirmation: target.identity.confirmation,
        reservation_id: target.identity.reservationId, reservation_stay_id: target.identity.reservationStayId },
      document: { name: attachment.name, mime_type: 'application/pdf', sha256, document_code: staged.documentCode,
        description: request.description ?? attachment.name },
      warnings: ['Native document classification is not established; upload is unavailable.'] }, error: null };
  } catch {
    return context.signal?.aborted ? failure('ABORTED', 'Filing preflight was aborted.')
      : failure('NATIVE_PREPARE_UNAVAILABLE', 'Attachment resolution or native preflight failed.', true);
  }
}

export const tools = [{ name: 'hms_filing_preflight',
  description: 'Stage a selected session PDF on the exact HMS stay without uploading.',
  input_schema: filingPrepareSchema, run: prepare }];
