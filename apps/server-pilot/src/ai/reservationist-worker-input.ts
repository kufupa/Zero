import { maskIncomingCardNumbers } from './card-mask.js';
import { normalizeMessageText } from './thread-context.js';
import { load } from 'cheerio';
import { normalizeContentId } from '../mail/cid-images.js';
import {
  isReservationistSignatureNoise,
  type AttachmentAdmission,
  type ReservationistAttachmentMetadata,
  type ReservationistMetadataOnlyAttachment,
} from './reservationist-attachment-input.js';
import type { ReservationistRuntimeInput } from './reservationist-runtime.js';
import { HTML_ALTERNATIVE_MARKER, type ReservationistMessageView } from './reservationist-message-view.js';
import { deriveReplyToAddress } from './workflows/candidate-draft.js';

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
function modelMessageText(row: Pick<ReservationistWorkerMessage, 'textBody' | 'htmlBody'>, normalized: string): string {
  if (row.textBody?.trim() || !normalized.includes('<')) return maskIncomingCardNumbers(normalized);
  const $ = load(normalized, null, false);
  $('details.quoted-toggle, blockquote').each((_, element) => {
    $(element).prepend('\nFrom: quoted history\n');
    $(element).children('summary').remove();
  });
  $('br, hr').each((_, element) => {
    $(element).replaceWith($(element).closest('td, th').length ? ' ' : '\n');
  });
  $('td, th').append('\t');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6').each((_, element) => {
    const separator = $(element).closest('td, th').length ? ' ' : '\n';
    $(element).prepend(separator).append(separator);
  });
  $('img').each((_, element) => {
    const alt = $(element).attr('alt')?.trim() ?? '';
    $(element).replaceWith($('<span>').text(/^(?:image\d*|logo|company logo|hotel logo|banner|signature|footer|spacer|icon)$/i.test(alt) ? '' : alt));
  });
  const rendered = $.root().text().replace(/\u00a0/g, ' ').trim();
  // HTML can split card groups across visual lines; dates stay independent.
  return maskIncomingCardNumbers(rendered);
}

/** Reuse the citable, masked text for intake and later draft checks. */
export function renderReservationistMessage(row: Pick<ReservationistWorkerMessage, 'textBody' | 'htmlBody'>, normalized = normalizeMessageText(row)) {
  return combineMessageViews(modelMessageText(row, normalized), row.textBody?.trim() && row.htmlBody
    ? modelMessageText({ textBody: null, htmlBody: row.htmlBody }, normalizeMessageText({ textBody: null, htmlBody: row.htmlBody })) : '');
}

export function reservationistMessageAt(row: { direction: string; arrivedAt?: Date | null; createdAt?: Date | null; receivedAt: Date | null; sentAt: Date | null }) {
  return row.arrivedAt ?? (row.direction === 'inbound' ? row.receivedAt : row.sentAt) ?? row.createdAt ?? null;
}

/** A past reply is guest-visible only when addressed to the current guest. */
export function reservationistDisclosure(row: { direction: string; fromAddress: string; toAddresses: string[]; ccAddresses: string[]; bccAddresses: string[] }, guestAddress: string): 'guest' | 'staff_only' {
  const address = (value: string) => deriveReplyToAddress(value)?.toLowerCase();
  return row.direction === 'inbound'
    ? address(row.fromAddress) === guestAddress ? 'guest' : 'staff_only'
    : [...row.toAddresses, ...row.ccAddresses, ...row.bccAddresses].some(value => address(value) === guestAddress) ? 'guest' : 'staff_only';
}

/** Keep each complete authored alternative, including postscripts, before quoted history. */
function combineMessageViews(primary: string, alternative: string): { text: string; sourceViews?: ReservationistMessageView[] } {
  const comparable = (text: string) => text.replace(/\s+/g, ' ').trim();
  if (!alternative || comparable(primary) === comparable(alternative)) return { text: primary };
  const boundary = /^[\t ]*(?:>|From:\s|Sent:\s|Subject:\s|On .{1,250}wrote:|Begin forwarded message:|Forwarded message:|-{2,}\s*(?:Original Message|Forwarded message))/imu;
  const split = (text: string) => {
    const at = text.search(boundary);
    return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at)];
  };
  const [primaryBody, primaryTail] = split(primary);
  const [alternativeBody, alternativeTail] = split(alternative);
  let text = '';
  const sourceViews: ReservationistMessageView[] = [];
  const add = (value: string, name?: ReservationistMessageView['name'], prefix = '') => {
    if (!value) return;
    if (text) text += '\n\n';
    text += prefix;
    const start = text.length;
    text += value;
    if (name) sourceViews.push({ name, start, end: text.length });
  };
  add(primaryBody?.trim() ?? '', 'plain');
  // Keep each authored view intact: deleting a repeated line can detach a negation or condition from the next line.
  if (alternativeBody?.trim() && comparable(primaryBody ?? '') !== comparable(alternativeBody))
    add(alternativeBody.trim(), 'html', HTML_ALTERNATIVE_MARKER);
  if (primaryTail?.trim()) add(primaryTail.trim());
  if (alternativeTail?.trim() && comparable(primaryTail ?? '') !== comparable(alternativeTail))
    add(alternativeTail.trim(), undefined, '[HTML alternative context]\n');
  return { text, ...(sourceViews.length === 2 ? { sourceViews } : {}) };
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
  $('td, th').append('\t');
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
  const rawBodies = selected.flatMap(({ row }) => [row.textBody ?? '', row.htmlBody ?? '']);
  if (selected.length > 64 || rawBodies.some((body) => body.length > 2_000_000) ||
      rawBodies.reduce((sum, body) => sum + body.length, 0) > 8_000_000 ||
      selected.some(({ row }) => (row.subject?.length ?? 0) > 4096))
    throw new Error('worker_intake_context_limit');
  check();
  selected.sort((a, b) => a.at - b.at || a.row.id.localeCompare(b.row.id));
  if (selected.some((entry, index) => index > 0 && entry.at === selected[index - 1]!.at))
    throw new Error('worker_intake_order_ambiguous');
  const normalized = new Map(selected.map(({ row }) => [row.id, normalizeMessageText(row)]));
  const messages = selected.map(({ row, at }) => ({
    id: row.id,
    at: new Date(at).toISOString(),
    direction: row.direction,
    ...renderReservationistMessage(row, normalized.get(row.id)!),
    ...(row.subject ? { subject: maskIncomingCardNumbers(row.subject) } : {}),
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
    const cidSourceViews = cid
      ? sourceView.texts.filter((text) => [...text.matchAll(/\bcid:([^\s[\]<>"')]+)/gi)]
        .some((reference) => normalizeContentId(reference[1]!) === cid))
      : [];
    // An intervening causal message can make a prior footer image relevant.
    // A plain alternative need not repeat a CID that appears in its HTML sibling.
    // It remains part of every current-request/dependency check below.
    const signatureNoise = cidSourceViews.length > 0 && !preserveAllImages && !(cid && sourceView.describedCids.has(cid)) && cidSourceViews.every((sourceText) => messages.every((message) => signatureViews.get(message.id)!.texts.every((requestText) => isReservationistSignatureNoise({
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
    const identity: ReservationistMetadataOnlyAttachment = {
      attachmentId: attachment.id,
      messageId: attachment.messageId,
      threadId,
      ownerRef: transportId,
      messageAt: new Date(entry.at).toISOString(),
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sourceIdentity: 'metadata_only',
      disclosure: attachment.disclosure,
      inline: attachment.isInline,
      ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
    };
    if (!['guest', 'staff_only'].includes(identity.disclosure) ||
        (entry.row.disclosure === 'staff_only' && identity.disclosure !== 'staff_only'))
      throw new Error('worker_intake_attachment_disclosure_invalid');
    // An unread file remains a staff task; metadata is never used as a content hash.
    const manual = (reason: string): AttachmentAdmission => ({ status: 'manual_required', reason, metadata: identity, draftReady: false });
    if (retainedBytes + identity.sizeBytes > 20 * 1024 * 1024) {
      admissions.push(manual('attachment_total_resource_unavailable'));
      continue;
    }
    const resolveHash = async () => {
      if (!options.resolveSourceHash) return null;
      try { return await bounded((edge) => options.resolveSourceHash!({ ...attachment }, edge)); }
      catch { check(); return null; }
    };
    const sourceHash = attachment.sha256 ?? await resolveHash();
    check();
    if (!sourceHash || !/^[a-f0-9]{64}$/.test(sourceHash)) {
      admissions.push(manual('attachment_identity_unavailable'));
      continue;
    }
    const { sourceIdentity: _identity, ...metadataBase } = identity;
    const metadata: ReservationistAttachmentMetadata = { ...metadataBase, sourceHash };
    const metadataIdentity = JSON.stringify(metadata);
    const admission = await bounded((edge) => options.admit(metadata, edge));
    if (!admission || JSON.stringify(metadata) !== metadataIdentity ||
        JSON.stringify(admission.metadata) !== metadataIdentity || admission.draftReady !== false ||
        !['admitted', 'manual_required'].includes(admission.status))
      throw new Error('worker_intake_admission_mismatch');
    // An unread attachment's stored hash may exist even though its bytes cannot
    // be rechecked; retain it only as a metadata-bound staff task in that case.
    if (admission.status === 'manual_required' && attachment.sha256 && options.resolveSourceHash && await resolveHash() !== sourceHash) {
      admissions.push(manual('attachment_identity_unavailable'));
      continue;
    }
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
