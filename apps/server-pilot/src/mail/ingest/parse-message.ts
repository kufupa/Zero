/**
 * Streaming raw-MIME parser.
 *
 * Uses the `MailParser` class (NOT `simpleParser`) so attachments stream to
 * S3 via `parser.on('data', ...)` instead of being buffered in memory.
 *
 * `parseRawMessage(raw)` returns the headers, address fields, bodies, and a
 * list of *attachment descriptors* (filename, mime type, size, contentId,
 * inline flag, S3 key) — the attachment bytes have already been uploaded to
 * S3 by the time the promise resolves.
 *
 * Routing marker `X-Zero-Mailbox` is extracted from the headers here so the
 * store layer can route without re-parsing.
 */
import { getIngestLimits, type IngestLimits, assertWithinIngestLimits } from './limits.js';
import { attachmentKey, getS3Storage, type S3Storage } from '../../storage/s3.js';
import { MailParser, type Headers } from 'mailparser';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

export interface ParsedAttachment {
  /** SHA256 of uploaded attachment bytes; absent only on legacy projections. */
  sha256?: string;
  /** Generated S3 key under `attachments/`. */
  s3Key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentId: string | null;
  isInline: boolean;
}

export type ParseFailureWithUploadedAttachments = Error & {
  uploadedAttachments: ParsedAttachment[];
};

/**
 * Return only attachments whose S3 PUT completed before parsing failed.
 * Callers use this to persist durable cleanup work before poison handling.
 */
export function uploadedAttachmentsFromParseFailure(error: unknown): ParsedAttachment[] {
  if (!error || typeof error !== 'object' || !('uploadedAttachments' in error)) return [];
  const attachments = (error as { uploadedAttachments?: unknown }).uploadedAttachments;
  return Array.isArray(attachments) ? (attachments as ParsedAttachment[]) : [];
}

export type OutboundCorrelation =
  | { kind: 'absent' }
  | { kind: 'valid'; outboundId: string }
  | { kind: 'malformed' };

export interface ParsedInboundMessage {
  /** `X-Zero-Mailbox` header value, lowercased; null when absent. */
  ownerHeaderValue: string | null;
  /** Strict local outbound correlation header state. */
  outboundCorrelation: OutboundCorrelation;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: Date | null;
  /** Receiving server's top-most Received stamp; null when absent or malformed. */
  deliveredAt: Date | null;
  attachments: ParsedAttachment[];
  /** Raw header lines kept for quarantine diagnostics. */
  rawHeaderLines: { key: string; line: string }[];
}

export interface ParseOptions {
  /** Generated message id used to build attachment S3 keys. */
  messageId: string;
  /** Optional S3 storage override (tests inject a fake). */
  storage?: S3Storage;
}

/**
 * Parse the date suffix of the first Received header in an RFC822 header block.
 * Raw MIME ingestion and the existing-row backfill share this parser so both
 * use the top-most server stamp, never the sender's Date header.
 */
export function parseTopReceivedDate(rawMimePrefix: Buffer | string): Date | null {
  try {
    const raw = Buffer.isBuffer(rawMimePrefix) ? rawMimePrefix.toString('latin1') : rawMimePrefix;
    const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? '';
    let name: string | null = null;
    let value = '';
    for (const line of headerBlock.split(/\r?\n/)) {
      if (/^[\t ]/.test(line)) {
        if (name) value += ` ${line.trim()}`;
        continue;
      }
      if (name === 'received') return parseReceivedDate(value);
      const colon = line.indexOf(':');
      if (colon <= 0) {
        name = null;
        value = '';
        continue;
      }
      name = line.slice(0, colon).trim().toLowerCase();
      value = line.slice(colon + 1).trim();
    }
    return name === 'received' ? parseReceivedDate(value) : null;
  } catch {
    return null;
  }
}

/**
 * Parse a raw RFC822 message and stream attachments to S3.
 *
 * @param raw raw MIME bytes
 * @param opts.messageId database id of the future `message` row; used to
 *   namespace attachment S3 keys (`attachments/{messageId}/...`)
 * @returns a `ParsedInboundMessage` with all fields populated; attachments
 *   are already in S3.
 */
export async function parseRawMessage(
  raw: Buffer,
  opts: ParseOptions,
): Promise<ParsedInboundMessage> {
  const limits = getIngestLimits();
  assertWithinIngestLimits(raw.length, 'message', limits);

  const storage = opts.storage ?? getS3Storage();

  const parser = new MailParser();
  let headers: Headers | null = null;
  let rawHeaderLines: { key: string; line: string }[] = [];
  let text: string | null = null;
  let html: string | null = null;
  const attachments: ParsedAttachment[] = [];
  const uploadedAttachments: ParsedAttachment[] = [];
  const errors: Error[] = [];

  const attachmentPromises: Promise<void>[] = [];

  parser.on('headers', (h) => {
    headers = h;
    // `parser.headerLines` is populated when the headers event fires.
    const lines = (parser as unknown as { headerLines?: { key: string; line: string }[] })
      .headerLines;
    if (lines) rawHeaderLines = lines.map((l) => ({ key: l.key, line: l.line }));
  });

  parser.on('data', (part) => {
    if (part.type === 'text') {
      if (typeof part.text === 'string' && part.text) text = part.text;
      if (typeof part.html === 'string' && part.html) html = part.html;
      return;
    }
    if (part.type === 'attachment') {
      const idx = attachments.length;
      const filename = part.filename ?? `attachment-${idx}`;
      const s3Key = attachmentKey({
        messageId: opts.messageId,
        index: idx,
        filename,
      });
      const isInline = part.contentDisposition?.trim().toLowerCase() === 'inline';
      const attachment: ParsedAttachment = {
        s3Key,
        filename,
        mimeType: part.contentType ?? 'application/octet-stream',
        sizeBytes: 0,
        contentId: part.cid ?? null,
        isInline,
      };
      attachments.push(attachment);

      // Stream `part.content` (a Readable) to S3. The mailparser contract:
      // we must call `part.release()` after consuming the stream so the
      // parser can continue.
      //
      // RCA: @aws-sdk/client-s3 PutObject with a streaming Readable Body
      // requires a content-length and tries to compute a SHA256 checksum,
      // which fails for mailparser's StreamHash Transform ("Unable to
      // calculate hash for flowing readable stream") when the stream is
      // already in flowing mode. The cleanest fix is to buffer the attachment
      // stream to a Buffer before the PUT (attachments are bounded by the
      // POP3 RETR payload, which is already fully loaded in memory). The
      // streaming MailParser contract (`parser.on('data', ...)`) is
      // preserved — only the final S3 PUT buffers.
      const content = part.content as Readable;
      const p = (async () => {
        try {
          const buf = await streamToBuffer(content, limits);
          const result = await storage.putObject({
            key: s3Key,
            body: buf,
            contentType: attachment.mimeType,
          });
          attachment.sizeBytes = result.bytes;
          attachment.sha256 = createHash('sha256').update(buf).digest('hex');
          uploadedAttachments.push(attachment);
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        } finally {
          part.release?.();
        }
      })();
      attachmentPromises.push(p);
      return;
    }
  });

  parser.on('error', (err) => {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  });

  // Feed the raw bytes through the parser.
  const readable = Readable.from([raw]);
  let parserFailure: Error | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      readable.on('error', reject);
      parser.on('end', () => resolve());
      parser.on('error', reject);
      readable.pipe(parser);
    });
  } catch (err) {
    parserFailure = err instanceof Error ? err : new Error(String(err));
  }

  // A parser error can occur while another attachment PUT is in flight.
  // Wait before exposing the failure so cleanup has an exact durable key set.
  await Promise.all(attachmentPromises);

  const failure = parserFailure ?? errors[0];
  if (failure) {
    throw withUploadedAttachments(failure, uploadedAttachments);
  }

  if (!headers) {
    throw withUploadedAttachments(
      new Error('parseRawMessage: headers event never fired'),
      uploadedAttachments,
    );
  }

  return buildParsedMessage({
    headers,
    rawHeaderLines,
    text,
    html,
    attachments,
  });
}

function withUploadedAttachments(
  error: Error,
  uploadedAttachments: ParsedAttachment[],
): ParseFailureWithUploadedAttachments {
  const exactUploads = [...uploadedAttachments];
  try {
    Object.defineProperty(error, 'uploadedAttachments', {
      configurable: true,
      enumerable: true,
      value: exactUploads,
    });
    return error as ParseFailureWithUploadedAttachments;
  } catch {
    const wrapped = new Error(error.message, {
      cause: error,
    }) as ParseFailureWithUploadedAttachments;
    wrapped.uploadedAttachments = exactUploads;
    return wrapped;
  }
}

export function buildParsedMessage(args: {
  headers: Headers;
  rawHeaderLines: { key: string; line: string }[];
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
}): ParsedInboundMessage {
  const { headers, rawHeaderLines, text, html, attachments } = args;

  const ownerHeaderValue = lastHeader(headers, 'x-zero-mailbox');
  const outboundCorrelation = parseOutboundCorrelation(headers);
  const messageIdRaw = firstHeader(headers, 'message-id');
  const messageId = messageIdRaw ? stripAngles(messageIdRaw) : null;
  const inReplyToRaw = firstHeader(headers, 'in-reply-to');
  const inReplyTo = inReplyToRaw ? stripAngles(inReplyToRaw) : null;
  const referencesRaw = headers.get('references');
  const references = normalizeReferences(referencesRaw);
  const fromHeaderRaw = firstHeader(headers, 'from');
  const fromEmail = extractAddress(headers.get('from')) ?? fromHeaderRaw;
  const senderEmail = extractAddress(headers.get('sender'));
  // ponytail: Outlook calendar FW keeps organizer in From; Sender is transmitter.
  const effectiveEmail =
    senderEmail && fromEmail && senderEmail.trim().toLowerCase() !== fromEmail.trim().toLowerCase()
      ? senderEmail
      : fromEmail;
  // Preserve display name if available in fromHeaderRaw: "Name <email@domain.com>"
  const fromAddress =
    effectiveEmail === fromEmail &&
    fromHeaderRaw &&
    fromHeaderRaw.includes('<') &&
    fromHeaderRaw.includes('>')
      ? fromHeaderRaw.trim()
      : effectiveEmail;
  const toAddresses = extractAddresses(headers.get('to'));
  const ccAddresses = extractAddresses(headers.get('cc'));
  const bccAddresses = extractAddresses(headers.get('bcc'));
  const subject = firstHeader(headers, 'subject');
  const dateVal = headers.get('date');
  const receivedAt =
    dateVal instanceof Date ? dateVal : typeof dateVal === 'string' ? parseDate(dateVal) : null;
  const firstReceived = rawHeaderLines.find((header) => header.key.toLowerCase() === 'received');
  const deliveredAt = firstReceived ? parseReceivedDate(firstReceived.line) : null;

  return {
    ownerHeaderValue: ownerHeaderValue ? ownerHeaderValue.toLowerCase() : null,
    outboundCorrelation,
    messageId,
    inReplyTo,
    references,
    fromAddress,
    toAddresses,
    ccAddresses,
    bccAddresses,
    subject: subject ?? null,
    textBody: text,
    htmlBody: html,
    receivedAt,
    deliveredAt,
    attachments,
    rawHeaderLines,
  };
}

function firstHeader(headers: Headers, name: string): string | null {
  const v = headers.get(name);
  if (!v) return null;
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) {
    const first = v[0];
    if (typeof first === 'string') return first.trim();
    if (first && typeof first === 'object') {
      if ('text' in first && typeof (first as { text?: unknown }).text === 'string') {
        return (first as { text: string }).text.trim();
      }
      if ('value' in first) {
        const val = (first as { value?: unknown }).value;
        if (Array.isArray(val) && val.length > 0) {
          const item = val[0];
          if (item && typeof item === 'object') {
            const { name: itemName, address: itemAddr } = item as { name?: string; address?: string };
            if (itemName && itemAddr) return `${itemName.trim()} <${itemAddr.trim()}>`;
            if (itemAddr) return itemAddr.trim();
          }
        }
      }
    }
    return null;
  }
  if (typeof v === 'object' && v) {
    if ('text' in v && typeof (v as { text?: unknown }).text === 'string') {
      return (v as { text: string }).text.trim();
    }
    if ('value' in v) {
      const val = (v as { value?: unknown }).value;
      if (Array.isArray(val) && val.length > 0) {
        const item = val[0];
        if (item && typeof item === 'object') {
          const { name: itemName, address: itemAddr } = item as { name?: string; address?: string };
          if (itemName && itemAddr) return `${itemName.trim()} <${itemAddr.trim()}>`;
          if (itemAddr) return itemAddr.trim();
        }
      }
    }
  }
  return null;
}

/** Last non-empty occurrence — trusted relay stamp wins over forged earlier values. */
function lastHeader(headers: Headers, name: string): string | null {
  const v = headers.get(name);
  if (!v) return null;
  const values = Array.isArray(v) ? v : [v];
  for (let i = values.length - 1; i >= 0; i--) {
    const s = values[i];
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  return null;
}

function parseOutboundCorrelation(headers: Headers): OutboundCorrelation {
  const value = headers.get('x-zero-outbound-id');
  if (value === undefined) return { kind: 'absent' };

  const values = Array.isArray(value) ? value : [value];
  const last = values.at(-1);
  if (typeof last !== 'string') return { kind: 'malformed' };

  const outboundId = last.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(outboundId)) {
    return { kind: 'malformed' };
  }

  return { kind: 'valid', outboundId: outboundId.toLowerCase() };
}

function normalizeReferences(v: unknown): string[] {
  if (!v) return [];
  let refs: string[] = [];
  if (Array.isArray(v)) {
    refs = v.filter((x): x is string => typeof x === 'string');
  } else if (typeof v === 'string') {
    refs = v
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    return [];
  }
  return refs.map(stripAngles);
}

function extractAddress(v: unknown): string | null {
  if (!v) return null;
  if (Array.isArray(v)) {
    const first = v[0];
    if (first && typeof first === 'object' && 'value' in first) {
      const addr = first as { value?: Array<{ address?: string }> };
      return addr.value?.[0]?.address ?? null;
    }
    if (first && typeof first === 'object' && 'address' in first) {
      return (first as { address?: string }).address ?? null;
    }
    if (typeof first === 'string') return first.trim();
  }
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && v && 'value' in v) {
    const addr = v as { value?: Array<{ address?: string }> };
    return addr.value?.[0]?.address ?? null;
  }
  return null;
}

function extractAddresses(v: unknown): string[] {
  if (!v) return [];
  const out: string[] = [];
  const push = (item: unknown) => {
    if (typeof item === 'string') {
      out.push(item.trim());
      return;
    }
    if (item && typeof item === 'object' && 'value' in item) {
      const list = (item as { value?: Array<{ address?: string }> }).value;
      if (list) {
        for (const a of list) {
          if (a.address) out.push(a.address);
        }
      }
    }
  };
  if (Array.isArray(v)) {
    for (const item of v) push(item);
  } else {
    push(v);
  }
  return out;
}

function parseDate(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const RFC_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RFC_WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const RFC_ZONE_OFFSETS: Record<string, number> = {
  ut: 0,
  utc: 0,
  gmt: 0,
  est: -5 * 60,
  edt: -4 * 60,
  cst: -6 * 60,
  cdt: -5 * 60,
  mst: -7 * 60,
  mdt: -6 * 60,
  pst: -8 * 60,
  pdt: -7 * 60,
  z: 0,
};

function parseReceivedDate(raw: string): Date | null {
  const unfolded = raw.replace(/\r?\n[\t ]+/g, ' ').trim();
  const value = unfolded.replace(/^received\s*:/i, '').trim();
  const withoutComments = stripRfcComments(value);
  if (!withoutComments) return null;
  const semicolon = withoutComments.lastIndexOf(';');
  if (semicolon < 0) return null;
  const dateText = withoutComments.slice(semicolon + 1).trim();
  if (!dateText) return null;
  const match = /^(?:(sun|mon|tue|wed|thu|fri|sat),[\t ]*)?(\d{1,2})[\t ]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[\t ]+(\d{4})[\t ]+([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?[\t ]+([a-z]{1,5}|[+-]\d{2}:?\d{2})$/i.exec(dateText);
  if (!match) return null;

  const day = Number(match[2]);
  const month = RFC_MONTHS.indexOf(match[3]!.toLowerCase());
  const year = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7] ?? '0');
  if (month < 0 || year < 100) return null;

  const localTime = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (
    localTime.getUTCFullYear() !== year ||
    localTime.getUTCMonth() !== month ||
    localTime.getUTCDate() !== day ||
    localTime.getUTCHours() !== hour ||
    localTime.getUTCMinutes() !== minute ||
    localTime.getUTCSeconds() !== second
  ) {
    return null;
  }
  const weekday = match[1]?.toLowerCase();
  if (weekday && RFC_WEEKDAYS[localTime.getUTCDay()] !== weekday) return null;

  const zone = match[8]!;
  const numericZone = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  let offsetMinutes: number | undefined;
  if (numericZone) {
    const hours = Number(numericZone[2]);
    const minutes = Number(numericZone[3]);
    if (hours > 23 || minutes > 59) return null;
    offsetMinutes = (numericZone[1] === '+' ? 1 : -1) * (hours * 60 + minutes);
  } else {
    offsetMinutes = RFC_ZONE_OFFSETS[zone.toLowerCase()];
  }
  if (offsetMinutes === undefined) return null;

  const deliveredAt = new Date(localTime.getTime() - offsetMinutes * 60_000);
  return Number.isNaN(deliveredAt.getTime()) ? null : deliveredAt;
}

/** Remove balanced RFC comments while refusing unclosed or unmatched parentheses. */
function stripRfcComments(raw: string): string | null {
  let output = '';
  let depth = 0;
  let escaped = false;
  for (const char of raw) {
    if (depth > 0) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      continue;
    }
    if (char === '(') {
      depth = 1;
      output += ' ';
    } else if (char === ')') {
      return null;
    } else {
      output += char;
    }
  }
  if (depth !== 0 || escaped) return null;
  return output.replace(/[\t ]+/g, ' ').trim();
}

/** Drain a Readable into a Buffer (used for attachment S3 PUT). */
async function streamToBuffer(stream: Readable, limits: IngestLimits): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    assertWithinIngestLimits(total, 'attachment', limits);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Strip leading/trailing `<` `>` from a Message-ID / In-Reply-To value. */
function stripAngles(raw: string): string {
  return raw.replace(/^<+|>+$/g, '').trim();
}

/**
 * Generate a UUID for the inbound message. The SAME UUID must be used for:
 *   - namespacing attachment S3 keys (`attachments/{messageId}/...`) via
 *     `parseRawMessage`'s `opts.messageId`, AND
 *   - the `message.id` DB row via `IngestMeta.messageId` → `store.ts`.
 * Threading one UUID through both keeps the S3 attachment key prefix equal
 * to the DB `message.id`. The caller (worker / parseAndPersist) is
 * responsible for not regenerating it between parse and persist.
 */
export function generateMessageId(): string {
  return randomUUID();
}

/**
 * Deterministic UUID-shaped candidate id for one POP3 mailbox/UIDL pair.
 * Retryable ingest paths use this for attachment-key ownership before a
 * canonical message row has committed.
 */
export function candidateMessageIdForPop3Uidl(ingestMailboxId: string, pop3Uidl: string): string {
  const hash = createHash('sha256')
    .update(ingestMailboxId)
    .update('\0')
    .update(pop3Uidl)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(
    17,
    20,
  )}-${hash.slice(20, 32)}`;
}
