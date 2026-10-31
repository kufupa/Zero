import { isLuhnValid, maskCardNumbers } from './card-mask.js';
import { normalizeMessageText } from './thread-context.js';
import { load } from 'cheerio';
import { normalizeContentId } from '../mail/cid-images.js';
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

/** Plain text retains paragraph and quote boundaries for source spans and masking. */
function modelMessageText(row: ReservationistWorkerMessage, normalized: string): string {
  if (row.textBody?.trim() || !normalized.includes('<')) return maskCardNumbers(normalized);
  const $ = load(normalized, null, false);
  $('details.quoted-toggle, blockquote').each((_, element) => {
    $(element).prepend('\nFrom: quoted history\n');
    $(element).children('summary').remove();
  });
  $('br, hr').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6').each((_, element) => {
    $(element).prepend('\n').append('\n');
  });
  $('img').each((_, element) => { $(element).replaceWith($('<span>').text($(element).attr('alt') ?? '')); });
  const rendered = $.root().text().replace(/\u00a0/g, ' ').trim();
  // HTML may put each group of a card number on a separate visual line. Mask
  // such Luhn-valid spans before the normal line-bounded text masker runs;
  // split dates first so an adjacent date cannot hide a card or be joined to it.
  const parts = rendered.split(/((?<!\d)(?:\d{4}[-./]\d{2}[-./]\d{2}|\d{2}[-./]\d{2}[-./]\d{4})(?!\d))/);
  const cardsMasked = parts.map((part, index) => index % 2 === 1 ? part : part.replace(/(?<!\d)(?:\d[ \t\r\n-]{0,8}){13,19}(?!\d)/g, (candidate) => {
    const digits = candidate.replace(/[ \t\r\n-]/g, '');
    if (!isLuhnValid(digits)) return candidate;
    const tail = candidate.match(/[ \t\r\n-]+$/)?.[0] ?? '';
    return `[card ••••${digits.slice(-4)}]${tail}`;
  })).join('');
  return maskCardNumbers(cardsMasked);
}

/** Separate inspection view: preserve CID positions and meaningful image descriptions. */
function signatureInspection(row: ReservationistWorkerMessage, normalized: string, inspectAlternateHtml: boolean) {
  const hasText = Boolean(row.textBody?.trim());
  const html = hasText ? row.htmlBody : normalized;
  const describedCids = new Set<string>();
  if (!html || !html.includes('<')) return { texts: [normalized], describedCids, preserveAll: false };
  // An oversized unused HTML alternative is never parsed; keep its images instead.
  if (hasText && (!inspectAlternateHtml || html.length > 2_000_000))
    return { texts: [normalized], describedCids, preserveAll: true };
  const $ = load(html, null, false);
  $('details.quoted-toggle, blockquote').before('\nFrom: quoted history\n');
  $('img').each((_, element) => {
    const src = $(element).attr('src')?.trim() ?? '';
    const alt = $(element).attr('alt')?.trim() ?? '';
    const cid = /^cid:/i.test(src) ? normalizeContentId(src) : null;
    // Unknown descriptions can describe business content; only generic signature labels are disposable.
    if (cid && alt && !/^(?:image\d*|logo|company logo|hotel logo|banner|signature|footer|spacer|icon)$/i.test(alt)) describedCids.add(cid);
    $(element).replaceWith($('<span>').text(cid ? ` ${alt} ${src} ` : ` ${alt} `));
  });
  $('br').replaceWith('\n');
  $('p, div, li, tr').each((_, element) => { $(element).prepend('\n').append('\n'); });
  const htmlText = $.root().text();
  // A multipart message can contain a request only in its HTML alternative.
  // Omit an image only when every available view agrees it is signature noise.
  return { texts: hasText ? [normalized, htmlText] : [htmlText], describedCids, preserveAll: false };
}

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
  resolveSourceHash?: (attachment: ReservationistWorkerAttachment, signal: AbortSignal) => Promise<string | null>;
  admit: (metadata: ReservationistAttachmentMetadata, signal: AbortSignal) => Promise<AttachmentAdmission>;
}): Promise<{ input: ReservationistRuntimeInput; admissions: AttachmentAdmission[]; ignoredSignatures: number }> {
  const { transportId, threadId, triggerMessageId } = options;
  options.signal.throwIfAborted();
  if (!transportId || !threadId || !triggerMessageId || !options.requestId || !options.propertyCode ||
      !Number.isFinite(Date.parse(options.sourceAt)) || !Number.isFinite(options.deadlineAt) ||
      options.deadlineAt <= Date.now()) throw new Error('worker_intake_scope_invalid');
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647, Math.ceil(options.deadlineAt - Date.now())))),
  ]);
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() >= options.deadlineAt) throw new Error('worker_intake_deadline_exceeded');
  };
  const bounded = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    check();
    const value = await new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('worker_intake_aborted'));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { check(); return operation(signal); }).then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
    check();
    return value;
  };
  if (new Set(options.messages.map((m) => m.id)).size !== options.messages.length ||
      options.messages.some((m) => !m.id || m.transportId !== transportId || m.threadId !== threadId ||
        !['inbound', 'outbound'].includes(m.direction) || !['guest', 'staff_only'].includes(m.disclosure)))
    throw new Error('worker_intake_scope_invalid');
  const trigger = options.messages.find((m) => m.id === triggerMessageId);
  if (!trigger || trigger.direction !== 'inbound' || trigger.disclosure !== 'guest')
    throw new Error('worker_intake_trigger_invalid');
  // The mailbox arrival clock, rather than a sender-supplied Date header,
  // establishes both ordering and the runtime's causal cutoff.
  const triggerAt = time(trigger.arrivedAt) ?? time(trigger.createdAt);
  if (triggerAt === null || Date.parse(options.sourceAt) < triggerAt ||
      Date.parse(options.sourceAt) > Date.now()) throw new Error('worker_intake_clock_invalid');

  const selected: Array<{ row: ReservationistWorkerMessage; at: number }> = [];
  for (const row of options.messages) {
    if (row.id === triggerMessageId) { selected.push({ row, at: triggerAt }); continue; }
    const arrived = time(row.arrivedAt) ?? time(row.createdAt);
    if (arrived === null) throw new Error('worker_intake_clock_invalid');
    // Later mailbox arrivals are never context, even if their authored date is backdated.
    if (arrived > triggerAt) continue;
    if (arrived === triggerAt) throw new Error('worker_intake_order_ambiguous');
    selected.push({ row, at: arrived });
  }
  // Bound raw inputs before HTML sanitization; the normalized limits below
  // still govern what the model receives.
  const rawBodies = selected.map(({ row }) => row.textBody?.trim() ? row.textBody! : row.htmlBody ?? '');
  if (selected.length > 64 || rawBodies.some((body) => body.length > 2_000_000) ||
      rawBodies.reduce((sum, body) => sum + body.length, 0) > 8_000_000 ||
      selected.some(({ row }) => (row.subject?.length ?? 0) > 4096))
    throw new Error('worker_intake_context_limit');
  check();
  selected.sort((a, b) => a.at - b.at || a.row.id.localeCompare(b.row.id));
  const normalized = new Map(selected.map(({ row }) => [row.id, normalizeMessageText(row)]));
  const messages = selected.map(({ row, at }) => ({
    id: row.id,
    at: new Date(at).toISOString(),
    direction: row.direction,
    text: modelMessageText(row, normalized.get(row.id)!),
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
  const alternateHtmlSize = selected.reduce((sum, { row }) => sum + (row.textBody?.trim() ? row.htmlBody?.length ?? 0 : 0), 0);
  const signatureViews = new Map(messages.map((message) => [message.id,
    signatureInspection(selectedById.get(message.id)!.row, normalized.get(message.id)!, alternateHtmlSize <= 8_000_000)]));
  const preserveAllImages = [...signatureViews.values()].some((view) => view.preserveAll);
  const relevant = options.attachments.filter((a) => selectedById.has(a.messageId)).sort((a, b) => a.id.localeCompare(b.id));
  if (relevant.length > 256) throw new Error('worker_intake_attachment_limit');
  const admissions: AttachmentAdmission[] = [];
  let ignoredSignatures = 0;
  let retainedBytes = 0;
  for (const attachment of relevant) {
    check();
    const entry = selectedById.get(attachment.messageId)!;
    const sourceView = signatureViews.get(attachment.messageId)!;
    const cid = attachment.contentId ? normalizeContentId(attachment.contentId) : null;
    // An intervening causal message can make a prior footer image relevant.
    const signatureNoise = !preserveAllImages && !(cid && sourceView.describedCids.has(cid)) && sourceView.texts.every((sourceText) => messages.every((message) => signatureViews.get(message.id)!.texts.every((requestText) => isReservationistSignatureNoise({
      messageText: sourceText,
      currentSubject: message.subject,
      currentRequestText: requestText,
      attachment,
      attachments: relevant,
    }))));
    if (signatureNoise) { ignoredSignatures++; continue; }
    if (admissions.length >= 64) throw new Error('worker_intake_attachment_limit');
    if (!attachment.id || !Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0)
      throw new Error('worker_intake_attachment_identity_invalid');
    const sourceHash = attachment.sha256 ?? (options.resolveSourceHash
      ? await bounded((edge) => options.resolveSourceHash!({ ...attachment }, edge))
      : undefined);
    check();
    if (!sourceHash || !/^[a-f0-9]{64}$/.test(sourceHash))
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
    // Keep over-budget files visible to staff without reading or retaining their bytes.
    const admission: AttachmentAdmission = retainedBytes + metadata.sizeBytes > 20 * 1024 * 1024
      ? { status: 'manual_required', reason: 'attachment_total_resource_unavailable', metadata, draftReady: false }
      : await bounded((edge) => options.admit(metadata, edge));
    if (!admission || JSON.stringify(metadata) !== metadataIdentity ||
        JSON.stringify(admission.metadata) !== metadataIdentity || admission.draftReady !== false ||
        !['admitted', 'manual_required'].includes(admission.status))
      throw new Error('worker_intake_admission_mismatch');
    if (admission.bytes) {
      if (admission.bytes.body.length !== metadata.sizeBytes || retainedBytes + admission.bytes.body.length > 20 * 1024 * 1024)
        throw new Error('worker_intake_attachment_limit');
      retainedBytes += admission.bytes.body.length;
    }
    admissions.push(admission);
  }
  check();
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
