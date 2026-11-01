import { maskIncomingCardNumbers } from './card-mask.js';
import { normalizeMessageText } from './thread-context.js';
import { load } from 'cheerio';
import { normalizeContentId } from '../mail/cid-images.js';
import {
  isReservationistSignatureNoise,
  type AttachmentAdmission,
  type ReservationistAttachmentMetadata,
} from './reservationist-attachment-input.js';
import type { ReservationistRuntimeInput } from './reservationist-runtime.js';
import { combineMessageViews } from './reservationist-message-view.js';
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
  pop3Uidl?: string | null;
  sourceProvenance?: Record<string, unknown> | null;
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
  // Outlook sometimes puts the old body beside, rather than inside, its header.
  // Group that body before the existing quoted-HTML normalization runs.
  if (row.htmlBody?.includes('OutlookMessageHeader')) {
    const original = load(row.htmlBody, null, false);
    original('.OutlookMessageHeader').each((_, element) => {
      const header = original(element);
      if (header.parents('blockquote, .gmail_quote, #divRplyFwdMsg, details.quoted-toggle').length) return;
      const following = header.nextAll();
      if (!following.length) return;
      const quoted = original('<div class="gmail_quote"></div>');
      header.before(quoted);
      quoted.append(header).append(following);
    });
    normalized = normalizeMessageText({ textBody: null, htmlBody: original.root().html() ?? '' });
  }
  const $ = load(normalized, null, false);
  $('details.quoted-toggle > summary').remove();
  $('br, hr').replaceWith('\n');
  $('td, th').append('\t');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6').prepend('\n').append('\n');
  $('img').each((_, element) => {
    const alt = $(element).attr('alt')?.trim() ?? '';
    $(element).replaceWith($('<span>').text(/^(?:image\d*|logo|company logo|hotel logo|banner|signature|footer|spacer|icon)$/i.test(alt) ? '' : alt));
  });
  const history: string[] = [];
  $('details.quoted-toggle, blockquote').each((_, element) => {
    if ($(element).parents('details.quoted-toggle, blockquote').length) return;
    const quoted = $(element).text().trim();
    if (quoted) history.push(`From: quoted history\n${quoted}`);
    $(element).remove();
  });
  const rendered = [$.root().text().trim(), ...history].filter(Boolean).join('\n\n').replace(/\u00a0/g, ' ').trim();
  return maskIncomingCardNumbers(rendered);
}

/** Reuse the citable, masked text for intake and later draft checks. */
export function renderReservationistMessage(row: Pick<ReservationistWorkerMessage, 'textBody' | 'htmlBody'>, normalized?: string) {
  if ((row.textBody?.length ?? 0) > 2_000_000 || (row.htmlBody?.length ?? 0) > 2_000_000) throw new Error('worker_intake_context_limit');
  return combineMessageViews(modelMessageText(row, normalized ?? normalizeMessageText(row)), row.textBody?.trim() && row.htmlBody
    ? modelMessageText({ textBody: null, htmlBody: row.htmlBody }, normalizeMessageText({ textBody: null, htmlBody: row.htmlBody })) : '');
}

/** A POP3 Date header cannot move an observed message earlier, including returned native replies. */
export function reservationistMessageAt(row: { direction: string; arrivedAt?: Date | null; createdAt?: Date | null; receivedAt: Date | null; sentAt: Date | null; pop3Uidl?: string | null; sourceProvenance?: Record<string, unknown> | null }) {
  const importedPop3 = row.pop3Uidl != null && row.sourceProvenance?.canonicalContentVersion == null;
  if (row.direction === 'outbound') {
    if (!importedPop3) return row.sentAt;
    const observed = row.arrivedAt ?? row.createdAt ?? null;
    return observed && row.sentAt && row.sentAt.getTime() > observed.getTime() ? row.sentAt : observed;
  }
  return row.arrivedAt ?? row.createdAt ?? row.receivedAt ?? null;
}

/** A past reply is guest-visible only when addressed to the current guest. */
export function reservationistDisclosure(row: { direction: string; fromAddress: string; toAddresses: string[]; ccAddresses: string[]; bccAddresses: string[] }, guestAddress: string): 'guest' | 'staff_only' {
  const address = (value: string) => deriveReplyToAddress(value)?.toLowerCase();
  return row.direction === 'inbound'
    ? address(row.fromAddress) === guestAddress ? 'guest' : 'staff_only'
    : [...row.toAddresses, ...row.ccAddresses, ...row.bccAddresses].some(value => address(value) === guestAddress) ? 'guest' : 'staff_only';
}

function signatureInspection(row: ReservationistWorkerMessage, normalized: string, inspectAlternateHtml: boolean) {
  const hasText = Boolean(row.textBody?.trim());
  const html = hasText ? row.htmlBody : normalized;
  const describedCids = new Set<string>();
  if (!html || !html.includes('<')) return { texts: hasText && html ? [normalized, html] : [normalized], describedCids, preserveAll: false };
  // An oversized unused HTML alternative is never parsed; keep its images instead.
  if (hasText && (!inspectAlternateHtml || html.length > 2_000_000))
    return { texts: [normalized], describedCids, preserveAll: true };
  const $ = load(html, null, false);
  $('details.quoted-toggle, blockquote, .gmail_quote, #divRplyFwdMsg, .OutlookMessageHeader').before('\nFrom: quoted history\n');
  const genericImageLabel = /^(?:image\d*|logo|company logo|hotel logo|banner|signature|footer|spacer|icon)$/i;
  $('img').each((_, element) => {
    const src = $(element).attr('src')?.trim() ?? '';
    const alt = $(element).attr('alt')?.trim() ?? '';
    const cid = /^cid:/i.test(src) ? normalizeContentId(src) : null;
    const heading = $(element).prev('h1, h2, h3, h4, h5, h6').text().trim();
    const usefulAlt = genericImageLabel.test(alt) ? '' : alt;
    // Semantic headings immediately above an image describe it even without a trailing colon.
    // Generic brand/signature labels remain eligible for the existing noise filter.
    const usefulHeading = heading && !genericImageLabel.test(heading);
    if (cid && (usefulAlt || usefulHeading)) describedCids.add(cid);
    $(element).replaceWith($('<span>').text(cid ? ` ${usefulAlt} ${src} ` : ` ${usefulAlt} `));
  });
  $('br').replaceWith('\n');
  $('td, th').append('\t');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6').each((_, element) => { $(element).prepend('\n').append('\n'); });
  const htmlText = $.root().text();
  // Multipart requests may be HTML-only; discard images only when every view agrees they are signature noise.
  return { texts: hasText ? [normalized, htmlText] : [htmlText], describedCids, preserveAll: false };
}

/** Compose causal mail and admitted files; caller owns authorization/admission, with no send or PMS write. */
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
  // Use mailbox arrival for POP3, and confirmed send time for native outbound mail.
  const triggerAt = time(trigger.arrivedAt);
  if (triggerAt === null || Date.parse(options.sourceAt) < triggerAt ||
      Date.parse(options.sourceAt) > Date.now()) throw new Error('worker_intake_clock_invalid');

  const selected: Array<{ row: ReservationistWorkerMessage; at: number }> = [];
  for (const row of options.messages) {
    if (row.id === triggerMessageId) { selected.push({ row, at: triggerAt }); continue; }
    const at = time(reservationistMessageAt(row));
    // Queued native outbound rows without a confirmed send are not context.
    if (at === null) { if (row.direction === 'outbound') continue; throw new Error('worker_intake_clock_invalid'); }
    if (at > triggerAt) continue;
    if (at === triggerAt) throw new Error('worker_intake_order_ambiguous');
    selected.push({ row, at });
  }
  // Bound raw inputs before HTML sanitization; normalized limits still govern model input.
  const rawBodies = selected.flatMap(({ row }) => [row.textBody ?? '', row.htmlBody ?? '']);
  if (selected.length > 64 || rawBodies.some((body) => body.length > 2_000_000) ||
      rawBodies.reduce((sum, body) => sum + body.length, 0) > 8_000_000 ||
      selected.some(({ row }) => (row.subject?.length ?? 0) > 4096))
    throw new Error('worker_intake_context_limit');
  check();
  // IDs only stabilize serialization within tied earlier timestamps; they do not establish chronology.
  selected.sort((a, b) => a.at - b.at || a.row.id.localeCompare(b.row.id));
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
  const requestTexts = (message: (typeof messages)[number]) => [...signatureViews.get(message.id)!.texts,
    ...(message.sourceViews?.map((view) => message.text.slice(view.start, view.end)) ?? [message.text])];
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
    // Intervening messages may make footer images relevant; plain may omit an HTML CID, which still participates in dependency checks.
    const signatureNoise = cidSourceViews.length > 0 && !preserveAllImages && !(cid && sourceView.describedCids.has(cid)) && cidSourceViews.every((sourceText) => messages.every((message) => requestTexts(message).every((requestText) => isReservationistSignatureNoise({
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
