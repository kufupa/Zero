import { maskCardNumbers } from './card-mask.js';
import { normalizeMessageText } from './thread-context.js';
import {
  isReservationistSignatureNoise,
  type AttachmentAdmission,
  type ReservationistAttachmentMetadata,
} from './reservationist-attachment-input.js';
import type { ReservationistRuntimeInput } from './reservationist-runtime.js';

/** Rows must be loaded by the server for one mailbox and thread. */
export type ReservationistWorkerMessage = {
  id: string;
  transportId: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  disclosure: 'guest' | 'staff_only';
  textBody: string | null;
  htmlBody: string | null;
  subject: string | null;
  receivedAt: Date | null;
  sentAt: Date | null;
  /** Mailbox arrival, not a sender-supplied timestamp. */
  arrivedAt: Date | null;
  createdAt: Date;
};

export type ReservationistWorkerAttachment = {
  id: string;
  messageId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  isInline: boolean;
  contentId: string | null;
  disclosure: 'guest' | 'staff_only';
};

const time = (date: Date | null): number | null =>
  date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : null;

/**
 * Compose the runtime's actual causal thread and admitted business files.
 * The caller owns mailbox authorization and supplies the existing attachment
 * admission edge; no PMS write or mail-send capability is introduced here.
 */
export async function buildReservationistWorkerInput(options: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  requestId: string;
  propertyCode: string;
  messages: readonly ReservationistWorkerMessage[];
  attachments: readonly ReservationistWorkerAttachment[];
  sourceAt: string;
  deadlineAt: number;
  signal: AbortSignal;
  /** Optional authorized bounded read for older rows without a stored content hash. */
  resolveSourceHash?: (attachment: ReservationistWorkerAttachment) => Promise<string | null>;
  admit: (metadata: ReservationistAttachmentMetadata) => Promise<AttachmentAdmission>;
}): Promise<{ input: ReservationistRuntimeInput; admissions: AttachmentAdmission[]; ignoredSignatures: number }> {
  const { transportId, threadId, triggerMessageId } = options;
  options.signal.throwIfAborted();
  if (!transportId || !threadId || !triggerMessageId || !options.requestId || !options.propertyCode ||
      !Number.isFinite(Date.parse(options.sourceAt)) || !Number.isFinite(options.deadlineAt) ||
      options.deadlineAt <= Date.now()) throw new Error('worker_intake_scope_invalid');
  if (new Set(options.messages.map((m) => m.id)).size !== options.messages.length ||
      options.messages.some((m) => !m.id || m.transportId !== transportId || m.threadId !== threadId ||
        !['inbound', 'outbound'].includes(m.direction) || !['guest', 'staff_only'].includes(m.disclosure)))
    throw new Error('worker_intake_scope_invalid');
  const trigger = options.messages.find((m) => m.id === triggerMessageId);
  if (!trigger || trigger.direction !== 'inbound' || trigger.disclosure !== 'guest')
    throw new Error('worker_intake_trigger_invalid');
  const triggerAt = time(trigger.receivedAt) ?? time(trigger.sentAt) ?? time(trigger.createdAt);
  const triggerArrival = time(trigger.arrivedAt) ?? time(trigger.createdAt);
  if (triggerAt === null || triggerArrival === null || Date.parse(options.sourceAt) < triggerAt ||
      Date.parse(options.sourceAt) > Date.now()) throw new Error('worker_intake_clock_invalid');

  const selected: Array<{ row: ReservationistWorkerMessage; at: number }> = [];
  for (const row of options.messages) {
    if (row.id === triggerMessageId) { selected.push({ row, at: triggerAt }); continue; }
    const arrived = time(row.arrivedAt) ?? time(row.createdAt);
    const at = row.direction === 'outbound' ? arrived : time(row.receivedAt) ?? time(row.sentAt) ?? time(row.createdAt);
    if (arrived === null || at === null) throw new Error('worker_intake_clock_invalid');
    // Later mailbox arrivals are never context, even if their authored date is backdated.
    if (arrived > triggerArrival) continue;
    if (arrived === triggerArrival || at > triggerAt) throw new Error('worker_intake_order_ambiguous');
    selected.push({ row, at });
  }
  selected.sort((a, b) => a.at - b.at || a.row.id.localeCompare(b.row.id));
  const messages = selected.map(({ row, at }) => ({
    id: row.id,
    at: new Date(at).toISOString(),
    direction: row.direction,
    text: maskCardNumbers(normalizeMessageText(row)),
    ...(row.subject ? { subject: maskCardNumbers(row.subject) } : {}),
    disclosure: row.disclosure,
  }));
  if (messages.length > 64 || messages.some((m) => m.text.length > 40000 || (m.subject?.length ?? 0) > 4096) ||
      messages.reduce((sum, m) => sum + m.text.length + (m.subject?.length ?? 0), 0) > 1280000)
    throw new Error('worker_intake_context_limit');

  const messageIds = new Set(options.messages.map((m) => m.id));
  if (new Set(options.attachments.map((a) => a.id)).size !== options.attachments.length ||
      options.attachments.some((a) => !messageIds.has(a.messageId)))
    throw new Error('worker_intake_attachment_identity_invalid');
  const selectedById = new Map(selected.map(({ row, at }) => [row.id, { row, at }]));
  const currentText = messages.find((m) => m.id === triggerMessageId)!.text;
  const relevant = options.attachments.filter((a) => selectedById.has(a.messageId)).sort((a, b) => a.id.localeCompare(b.id));
  if (relevant.length > 256) throw new Error('worker_intake_attachment_limit');
  const admissions: AttachmentAdmission[] = [];
  let ignoredSignatures = 0;
  for (const attachment of relevant) {
    options.signal.throwIfAborted();
    const entry = selectedById.get(attachment.messageId)!;
    const text = messages.find((m) => m.id === attachment.messageId)!.text;
    const signatureNoise = isReservationistSignatureNoise({
      messageText: text,
      currentRequestText: currentText,
      attachment,
      attachments: relevant,
    });
    if (signatureNoise) { ignoredSignatures++; continue; }
    if (admissions.length >= 64) throw new Error('worker_intake_attachment_limit');
    const sourceHash = attachment.sha256 ?? await options.resolveSourceHash?.({ ...attachment });
    options.signal.throwIfAborted();
    if (!attachment.id || !sourceHash || !/^[a-f0-9]{64}$/.test(sourceHash))
      throw new Error('worker_intake_attachment_identity_invalid');
    const metadata: ReservationistAttachmentMetadata = {
      attachmentId: attachment.id,
      messageId: attachment.messageId,
      threadId,
      ownerRef: transportId,
      messageAt: new Date(entry.at).toISOString(),
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sourceHash,
      disclosure: attachment.disclosure,
      inline: attachment.isInline,
      ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
    };
    if (!['guest', 'staff_only'].includes(metadata.disclosure) ||
        (entry.row.disclosure === 'staff_only' && metadata.disclosure !== 'staff_only'))
      throw new Error('worker_intake_attachment_disclosure_invalid');
    const metadataIdentity = JSON.stringify(metadata);
    const admission = await options.admit(metadata);
    options.signal.throwIfAborted();
    if (!admission || JSON.stringify(metadata) !== metadataIdentity ||
        JSON.stringify(admission.metadata) !== metadataIdentity || admission.draftReady !== false ||
        !['admitted', 'manual_required'].includes(admission.status))
      throw new Error('worker_intake_admission_mismatch');
    admissions.push(admission);
  }
  const causalAt = new Date(triggerAt).toISOString();
  return {
    input: {
      version: 1,
      requestId: options.requestId,
      propertyCode: options.propertyCode,
      trigger: { id: triggerMessageId, at: causalAt },
      messages,
      authorizationScope: { ownerRef: transportId, threadId },
      authorizedArtifacts: admissions.map((admission) => ({ ...admission.metadata })),
      requiredTaskKinds: [],
      requiredAskSpans: [],
      clock: { causalAt, sourceAt: options.sourceAt, sourceMode: 'current_read', deadlineAt: options.deadlineAt },
      capabilities: { pmsWrite: false, emailSend: false },
    },
    admissions,
    ignoredSignatures,
  };
}
