/**
 * Read-only Centurion quarantine recovery.
 *
 * This command deliberately owns a parser separate from the ingest parser:
 * the ingest parser streams attachments to S3, while this command only reads
 * one existing raw-MIME object, computes hashes, and records metadata.  It
 * never imports an ingest/re-ingest operation and has no database or object
 * storage write call.
 */
import {
  CENTURION_TRANSPORT_ID,
  CENTURION_WINDOW_END_UTC,
  CENTURION_WINDOW_START_UTC,
  CENTURION_WINDOW_TIMEZONE,
} from '../src/ops/centurion-thread-corpus-postgres-reader.js';
import { preflightPrivateThreadCorpusOutputDestination } from '../src/ops/centurion-thread-corpus-snapshot.js';
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
} from '../src/mail/ingest/limits.js';
import { S3ObjectTooLargeError, getS3Storage, type S3Storage } from '../src/storage/s3.js';
import { directCenturionImdsRequest } from './export-centurion-nine-day-corpus-live.js';
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { MailParser, type Headers } from 'mailparser';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import postgres from 'postgres';
import path from 'node:path';

export const CENTURION_INGEST_MAILBOX_IDS = ['ingest-nava-legacy'] as const;
export const CENTURION_QUARANTINE_WINDOW = {
  startInclusive: CENTURION_WINDOW_START_UTC,
  endExclusive: CENTURION_WINDOW_END_UTC,
  spilloverStartInclusive: CENTURION_WINDOW_END_UTC,
  spilloverEndExclusive: '2026-09-17T22:00:00.000Z',
  timezone: CENTURION_WINDOW_TIMEZONE,
} as const;

const APPROVED_INSTANCE_ID = 'i-008f737974a9ba9b3';
const PRIVATE_CORPUS_DIRECTORY_NAME = 'connected-mailbox-corpus';
const CORPUS_PATH_SEGMENTS = ['.private', PRIVATE_CORPUS_DIRECTORY_NAME] as const;
const EXPORTER_VERSION = 'centurion-quarantine-live-v1';
const SNAPSHOT_ID_PREFIX = 'centurion-quarantine-';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_MIME_MAX_BYTES = DEFAULT_MAX_MESSAGE_BYTES;
const DEFAULT_ATTACHMENT_MAX_BYTES = DEFAULT_MAX_ATTACHMENT_BYTES;
const IMAGE_UNSUPPORTED_PATTERN = /^image\/(?:gif|png|jpe?g)$/i;

export type QuarantineRawMimeStatus =
  | 'available'
  | 'missing'
  | 'oversized'
  | 'read_error'
  | 'not_attempted';

export type QuarantineParseStatus = 'parsed' | 'parse_error' | 'missing_object' | 'not_attempted';

export type QuarantineRecordStatus =
  | 'inbound'
  | 'outbound'
  | 'ambiguous'
  | 'unattributed'
  | 'missing_object'
  | 'parse_error';

export type QuarantineRoutingStatus =
  | 'centurion'
  | 'owner_mismatch'
  | 'unrelated_mailbox'
  | 'missing_object'
  | 'parse_error';

export type QuarantineReportPartition =
  | 'core'
  | 'september17_spillover'
  | 'outside_window'
  | 'undated';

export type QuarantineAttachmentContentStatus =
  | 'available'
  | 'unsupported'
  | 'oversized'
  | 'malformed'
  | 'unavailable';

export type CenturionQuarantineMetadataRow = {
  id: string;
  ingestMailboxId: string;
  ingestMailboxEmail: string | null;
  pop3Uidl: string;
  rawMimeS3Key: string;
  reason: string;
  ownerHeaderValue: string | null;
  parsedHeaders: unknown;
  quarantineCreatedAt: string | null;
};

export type CenturionQuarantineQueueRow = {
  messageId: string;
  transportId: string;
  status: string;
  messageIdHeader: string | null;
  smtpPayload: unknown;
  createdAt: string | null;
};

export type CenturionQuarantineExistingMessageRow = {
  id: string;
  transportId: string;
  ingestMailboxId: string | null;
  pop3Uidl: string | null;
  rawMimeS3Key: string | null;
  messageIdHeader: string | null;
  direction: string | null;
  createdAt: string | null;
};

export type CenturionQuarantineStorage = Pick<S3Storage, 'getObjectBounded'>;

type QuarantineObject = {
  body: Buffer;
  contentType: string;
};

type QuarantineRawMime = {
  primaryKey: string;
  archiveKey: string;
  primaryStatus: QuarantineRawMimeStatus;
  archiveStatus: QuarantineRawMimeStatus;
  status: QuarantineRawMimeStatus;
  source: 'primary' | 'archive' | null;
  selectedKey: string | null;
  byteLength: number | null;
  sha256: string | null;
  contentType: string | null;
  artifactPath: string | null;
};

export type CenturionQuarantineAttachment = {
  filename: string;
  contentType: string;
  contentDisposition: string | null;
  contentId: string | null;
  inline: boolean;
  byteSize: number;
  sha256: string | null;
  contentStatus: QuarantineAttachmentContentStatus;
};

type QuarantineEvidence = {
  effectiveSender: string | null;
  ownerHeaderValue: string | null;
  ownerHeaderMatches: boolean;
  ownerHeaderMismatch: boolean;
  ownerHeaderConflict: boolean;
  senderMatchesCenturion: boolean;
  recipientMatchesCenturion: boolean;
  bccMirror: boolean;
  selfLoopback: boolean;
  queueCorrelated: boolean;
  queueStatus: string | null;
};

export type CenturionQuarantineRecord = {
  recordType: 'quarantine';
  schemaVersion: 'centurion-quarantine-v1';
  id: string;
  ingestMailboxId: string;
  ingestMailboxEmail: string | null;
  pop3Uidl: string;
  reason: string;
  ownerHeaderValue: string | null;
  parsedHeaders: unknown;
  quarantineCreatedAt: string | null;
  messageDate: string | null;
  dateHeader: string | null;
  dateStatus: 'valid' | 'invalid' | 'missing';
  reportPartition: QuarantineReportPartition;
  quarantineCreatedPartition: QuarantineReportPartition;
  status: QuarantineRecordStatus;
  routingStatus: QuarantineRoutingStatus;
  parseStatus: QuarantineParseStatus;
  parseError: string | null;
  rawMime: QuarantineRawMime;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  textBody: string;
  htmlBody: string;
  headers: Record<string, string[]>;
  rawHeaders: Array<{ key: string; line: string }>;
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  effectiveSender: string | null;
  attachments: CenturionQuarantineAttachment[];
  evidence: QuarantineEvidence;
  duplicateUidl: boolean;
  duplicateRawHash: boolean;
};

export type CenturionQuarantineCounts = {
  sourceRowCount: number;
  quarantineRowCount: number;
  centurionRowCount: number;
  parseFailureCount: number;
  coreCount: number;
  september17SpilloverCount: number;
  undatedCount: number;
  outsideWindowCount: number;
  parseErrorCount: number;
  missingObjectCount: number;
  duplicateUidGroupCount: number;
  duplicateRawHashGroupCount: number;
};

export type CenturionQuarantineSnapshot = {
  schemaVersion: 'centurion-quarantine-v1';
  asOf: string;
  transportId: typeof CENTURION_TRANSPORT_ID;
  window: typeof CENTURION_QUARANTINE_WINDOW;
  records: readonly CenturionQuarantineRecord[];
  counts: CenturionQuarantineCounts;
  /** Private runtime payload; never serialized into the JSONL/manifest records. */
  rawArtifacts: readonly CenturionQuarantineRawArtifact[];
};

export type CenturionQuarantineRawArtifact = {
  path: string;
  body: Buffer;
};

export type CenturionQuarantineSnapshotWriteRequest = {
  repoRoot: string;
  outDir: string;
  snapshotId: string;
  snapshot: CenturionQuarantineSnapshot;
  rawArtifacts: readonly CenturionQuarantineRawArtifact[];
};

export type CenturionQuarantineReadInput = {
  asOf: string;
  rows: readonly CenturionQuarantineMetadataRow[];
  transportIdentities: ReadonlySet<string>;
  queueRows: readonly CenturionQuarantineQueueRow[];
  existingMessages: readonly CenturionQuarantineExistingMessageRow[];
  storage: CenturionQuarantineStorage;
  maxMessageBytes?: number;
  maxAttachmentBytes?: number;
};

export type CenturionQuarantineReader = {
  readCenturionQuarantineSnapshot(): Promise<CenturionQuarantineSnapshot>;
  close(): Promise<void>;
};

export type CenturionQuarantinePostgresClient = {
  <TRow extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromiseLike<readonly TRow[]>;
  begin<T>(
    options: string,
    load: (connection: CenturionQuarantinePostgresClient) => Promise<T>,
  ): Promise<T>;
  end(): Promise<void>;
};

export type CenturionQuarantinePostgresReaderOptions = {
  databaseUrl: string;
  storage: CenturionQuarantineStorage;
  asOf?: string;
  clientFactory?: (
    databaseUrl: string,
    options: { max: 1; ssl: ReturnType<typeof getPostgresSslOptions> },
  ) => CenturionQuarantinePostgresClient;
};

export type CenturionQuarantineExportReader = Pick<
  CenturionQuarantineReader,
  'readCenturionQuarantineSnapshot' | 'close'
>;

export type LiveCenturionQuarantineDependencies = {
  args(): readonly string[];
  platform(): string;
  scriptPath(): string;
  attestImdsV2(): Promise<boolean>;
  preflightOutputDestination(repoRoot: string, outDir: string): Promise<void>;
  uuid(): string;
  environment(): Readonly<{ DATABASE_URL?: string; AWS_REGION?: string; S3_BUCKET?: string }>;
  createStorage(): CenturionQuarantineStorage;
  createReader(options: CenturionQuarantinePostgresReaderOptions): CenturionQuarantineExportReader;
  writeSnapshot(request: CenturionQuarantineSnapshotWriteRequest): Promise<void>;
  validateAllocatedDir(request: {
    repoRoot: string;
    corpusRoot: string;
    snapshotId: string;
    outDir: string;
  }): void;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
};

type MessageParserAttachmentPart = {
  type: 'attachment';
  filename?: string | null;
  contentType?: string | null;
  contentDisposition?: string | null;
  cid?: string | null;
  content: AsyncIterable<Buffer | Uint8Array | string>;
  release?: () => void;
};

type MessageParserTextPart = {
  type: 'text';
  text?: string;
  html?: string;
};

type MessageParserPart = Partial<MessageParserTextPart> | Partial<MessageParserAttachmentPart>;

type ParsedLocalMime = {
  ownerHeaderValue: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  dateHeader: string | null;
  messageDate: string | null;
  dateStatus: 'valid' | 'invalid' | 'missing';
  textBody: string;
  htmlBody: string;
  headers: Record<string, string[]>;
  rawHeaders: Array<{ key: string; line: string }>;
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  effectiveSender: string | null;
  attachments: CenturionQuarantineAttachment[];
};

type RawLoadResult = {
  rawMime: QuarantineRawMime;
  object: QuarantineObject | null;
};

function failPreflight(): never {
  throw new Error('preflight failed');
}

function nonBlankEnvironmentValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return failPreflight();
  return value;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeTimestamp(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function normalizeAddress(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  const bracketed = text.match(/<\s*([^<>]+?)\s*>/);
  return (bracketed?.[1] ?? text).trim().toLowerCase() || null;
}

function addressDisplay(name: unknown, address: unknown): string | null {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  const display = textOrNull(name);
  return display ? `${display} <${normalized}>` : normalized;
}

function stringValues(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (value instanceof Date) return [value.toUTCString()];
  if (Array.isArray(value)) return value.flatMap((item) => stringValues(item, depth + 1));
  if (typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  if (typeof object.text === 'string' && object.text.trim()) return [object.text.trim()];
  if (Array.isArray(object.value))
    return object.value.flatMap((item) => stringValues(item, depth + 1));
  const display = addressDisplay(object.name, object.address);
  if (display) return [display];
  if (typeof object.address === 'string') return [object.address.trim()];
  return [];
}

function addressValues(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? splitAddressHeader(value) : [];
  if (Array.isArray(value)) return value.flatMap((item) => addressValues(item, depth + 1));
  if (typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.value))
    return object.value.flatMap((item) => addressValues(item, depth + 1));
  const display = addressDisplay(object.name, object.address);
  if (display) return [display];
  return stringValues(value, depth + 1).flatMap(splitAddressHeader);
}

function splitAddressHeader(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let angleDepth = 0;
  let quote = false;
  for (const character of value) {
    if (character === '"') quote = !quote;
    if (!quote && character === '<') angleDepth += 1;
    if (!quote && character === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (!quote && angleDepth === 0 && character === ',') {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function headerValues(headers: Headers, name: string): string[] {
  return stringValues(headers.get(name));
}

function firstHeader(headers: Headers, name: string): string | null {
  return headerValues(headers, name)[0] ?? null;
}

function lastHeader(headers: Headers, name: string): string | null {
  const values = headerValues(headers, name);
  return values.at(-1) ?? null;
}

function normalizeMessageId(value: string | null): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  const unwrapped = text.replace(/^<|>$/g, '').trim().toLowerCase();
  return unwrapped || null;
}

function normalizeReferences(value: string | null): string[] {
  if (!value) return [];
  return distinct(
    [...value.matchAll(/<([^<>]+)>/g)].map((match) => match[1] ?? '').filter(Boolean),
  ).map((value) => value.toLowerCase());
}

function canonicalHeaders(
  lines: readonly { key: string; line: string }[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const item of lines) {
    const key = item.key.trim().toLowerCase();
    if (!key) continue;
    const colon = item.line.indexOf(':');
    const value = (colon >= 0 ? item.line.slice(colon + 1) : item.line).trim();
    (result[key] ??= []).push(value);
  }
  return result;
}

function rawHeaderLines(parser: MailParser): Array<{ key: string; line: string }> {
  const lines = (parser as unknown as { headerLines?: unknown }).headerLines;
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as { key?: unknown; line?: unknown };
    return typeof value.key === 'string' && typeof value.line === 'string'
      ? [{ key: value.key, line: value.line }]
      : [];
  });
}

function rawHeaderValue(
  lines: readonly { key: string; line: string }[],
  name: string,
): string | null {
  const header = lines.find((line) => line.key.trim().toLowerCase() === name.toLowerCase());
  if (!header) return null;
  const colon = header.line.indexOf(':');
  if (colon < 0) return null;
  return (
    header.line
      .slice(colon + 1)
      .replace(/\r?\n[ \t]+/g, ' ')
      .trim() || null
  );
}

function hasPlausibleHeaderBlock(raw: Buffer): boolean {
  const prefix = raw.subarray(0, Math.min(raw.byteLength, 256 * 1024)).toString('utf8');
  const separator = prefix.search(/\r?\n\r?\n/);
  const headerBlock = separator >= 0 ? prefix.slice(0, separator) : prefix;
  return headerBlock.split(/\r?\n/).some((line) => /^[A-Za-z0-9][^:]*:/.test(line));
}

function parseDateHeader(value: string | null): {
  date: string | null;
  status: 'valid' | 'invalid' | 'missing';
} {
  if (!value) return { date: null, status: 'missing' };
  const match = value.match(
    /^(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s*,\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(UT|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[+-]\d{4})$/i,
  );
  if (!match) return { date: null, status: 'invalid' };

  const day = Number(match[1]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  const month = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ].indexOf(match[2]!.toLowerCase());
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month];
  if (month < 0 || day < 1 || day > (daysInMonth ?? 0) || hour > 23 || minute > 59 || second > 59) {
    return { date: null, status: 'invalid' };
  }

  const zone = match[7]!.toUpperCase();
  let offsetMinutes: number | null = null;
  const numericZone = zone.match(/^([+-])(\d{2})(\d{2})$/);
  if (numericZone) {
    const offsetHours = Number(numericZone[2]);
    const offsetPartMinutes = Number(numericZone[3]);
    if (offsetHours > 23 || offsetPartMinutes > 59) {
      return { date: null, status: 'invalid' };
    }
    offsetMinutes = (offsetHours * 60 + offsetPartMinutes) * (numericZone[1] === '+' ? 1 : -1);
  } else {
    offsetMinutes =
      {
        UT: 0,
        GMT: 0,
        EST: -5 * 60,
        EDT: -4 * 60,
        CST: -6 * 60,
        CDT: -5 * 60,
        MST: -7 * 60,
        MDT: -6 * 60,
        PST: -8 * 60,
        PDT: -7 * 60,
      }[zone] ?? null;
  }
  if (offsetMinutes === null) return { date: null, status: 'invalid' };

  const local = new Date(0);
  local.setUTCFullYear(year, month, day);
  local.setUTCHours(hour, minute, second, 0);
  const timestamp = local.getTime() - offsetMinutes * 60 * 1000;
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) {
    return { date: null, status: 'invalid' };
  }
  return { date: date.toISOString(), status: 'valid' };
}

function safeParserError(error: unknown): string {
  if (error instanceof Error && error.name && error.message) {
    return `${error.name}: ${error.message}`.slice(0, 240);
  }
  return 'MIME parser failed';
}

function isS3TooLarge(error: unknown): boolean {
  return (
    error instanceof S3ObjectTooLargeError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'S3ObjectTooLargeError')
  );
}

function attachmentStatus(
  contentType: string,
  byteSize: number,
  maxBytes: number,
): QuarantineAttachmentContentStatus {
  if (IMAGE_UNSUPPORTED_PATTERN.test(contentType)) return 'unsupported';
  if (byteSize > maxBytes) return 'oversized';
  return 'available';
}

/** Parse a raw RFC822 object locally without invoking ingest storage helpers. */
export async function parseCenturionQuarantineMime(
  raw: Buffer,
  options: { maxAttachmentBytes?: number } = {},
): Promise<ParsedLocalMime> {
  if (!hasPlausibleHeaderBlock(raw)) throw new Error('MIME headers missing');
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  const parser = new MailParser();
  let parsedHeaders: Headers | undefined;
  let textParts: string[] = [];
  let htmlParts: string[] = [];
  const attachments: CenturionQuarantineAttachment[] = [];
  const attachmentTasks: Promise<void>[] = [];
  let parserError: unknown;

  parser.on('headers', (headers: Headers) => {
    parsedHeaders = headers;
  });
  parser.on('data', (data: unknown) => {
    const part = data as MessageParserPart;
    if (part.type === 'text') {
      if (typeof part.text === 'string' && part.text) textParts.push(part.text);
      if (typeof part.html === 'string' && part.html) htmlParts.push(part.html);
      return;
    }
    if (
      part.type !== 'attachment' ||
      !part.content ||
      typeof (part.content as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function'
    ) {
      return;
    }
    const attachment: CenturionQuarantineAttachment = {
      filename: textOrNull(part.filename) ?? `attachment-${attachments.length}`,
      contentType: textOrNull(part.contentType) ?? 'application/octet-stream',
      contentDisposition: textOrNull(part.contentDisposition),
      contentId: textOrNull(part.cid),
      inline: textOrNull(part.contentDisposition)?.toLowerCase() === 'inline',
      byteSize: 0,
      sha256: null,
      contentStatus: 'unavailable',
    };
    attachments.push(attachment);
    const task = (async () => {
      const hash = createHash('sha256');
      try {
        for await (const chunk of part.content as AsyncIterable<Buffer | Uint8Array | string>) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          attachment.byteSize += bytes.byteLength;
          hash.update(bytes);
        }
        attachment.sha256 = hash.digest('hex');
        attachment.contentStatus = attachmentStatus(
          attachment.contentType,
          attachment.byteSize,
          maxAttachmentBytes,
        );
      } catch {
        attachment.contentStatus = 'malformed';
        attachment.sha256 = null;
      } finally {
        try {
          part.release?.();
        } catch {
          // Release is best-effort after the side-effect-free local read.
        }
      }
    })();
    attachmentTasks.push(task);
  });
  parser.on('error', (error: unknown) => {
    parserError = error;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const readable = Readable.from([raw]);
      readable.on('error', reject);
      parser.once('end', resolve);
      parser.once('error', reject);
      readable.pipe(parser);
    });
  } catch (error) {
    parserError ??= error;
  }
  await Promise.allSettled(attachmentTasks);
  if (parserError) throw new Error(safeParserError(parserError));
  if (!parsedHeaders) throw new Error('MIME headers event missing');

  const lines = rawHeaderLines(parser);
  const dateHeader = rawHeaderValue(lines, 'date');
  const parsedDate = parseDateHeader(dateHeader);
  const from = addressValues(parsedHeaders.get('from'));
  const sender = addressValues(parsedHeaders.get('sender'));
  const effectiveSender =
    sender[0] && normalizeAddress(sender[0]) !== normalizeAddress(from[0] ?? null)
      ? sender[0]
      : (from[0] ?? null);
  const references = normalizeReferences(firstHeader(parsedHeaders, 'references'));
  return {
    ownerHeaderValue: lastHeader(parsedHeaders, 'x-zero-mailbox'),
    messageId: firstHeader(parsedHeaders, 'message-id'),
    inReplyTo: firstHeader(parsedHeaders, 'in-reply-to'),
    references,
    subject: firstHeader(parsedHeaders, 'subject'),
    dateHeader,
    messageDate: parsedDate.date,
    dateStatus: parsedDate.status,
    textBody: textParts.join('\n'),
    htmlBody: htmlParts.join('\n'),
    headers: canonicalHeaders(lines),
    rawHeaders: lines,
    from,
    to: addressValues(parsedHeaders.get('to')),
    cc: addressValues(parsedHeaders.get('cc')),
    bcc: addressValues(parsedHeaders.get('bcc')),
    effectiveSender,
    attachments,
  };
}

function nestedStrings(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => nestedStrings(item, depth + 1));
  if (typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap((item) =>
    nestedStrings(item, depth + 1),
  );
}

export function transportIdentitySet(input: {
  email?: unknown;
  ownerHeaderValue?: unknown;
  sendFromConfig?: unknown;
}): ReadonlySet<string> {
  return new Set(
    [input.email, input.ownerHeaderValue, ...nestedStrings(input.sendFromConfig)]
      .map(normalizeAddress)
      .filter((value): value is string => value !== null),
  );
}

function archiveKeyFor(
  row: Pick<CenturionQuarantineMetadataRow, 'ingestMailboxId' | 'pop3Uidl'>,
): string {
  const safeUidl = row.pop3Uidl.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `quarantine-archive/${row.ingestMailboxId}/${safeUidl}.eml`;
}

async function readOneObject(
  storage: CenturionQuarantineStorage,
  key: string,
  maxBytes: number,
): Promise<{ status: QuarantineRawMimeStatus; object: QuarantineObject | null }> {
  try {
    const object = await storage.getObjectBounded(key, maxBytes);
    if (!object) return { status: 'missing', object: null };
    if (object.body.byteLength > maxBytes) return { status: 'oversized', object: null };
    return { status: 'available', object };
  } catch (error) {
    return { status: isS3TooLarge(error) ? 'oversized' : 'read_error', object: null };
  }
}

async function loadRawObject(
  row: CenturionQuarantineMetadataRow,
  storage: CenturionQuarantineStorage,
  maxBytes: number,
): Promise<RawLoadResult> {
  const primaryKey = row.rawMimeS3Key;
  const archiveKey = archiveKeyFor(row);
  const primary = await readOneObject(storage, primaryKey, maxBytes);
  if (primary.object) {
    const hash = createHash('sha256').update(primary.object.body).digest('hex');
    return {
      object: primary.object,
      rawMime: {
        primaryKey,
        archiveKey,
        primaryStatus: primary.status,
        archiveStatus: 'not_attempted',
        status: 'available',
        source: 'primary',
        selectedKey: primaryKey,
        byteLength: primary.object.body.byteLength,
        sha256: hash,
        contentType: primary.object.contentType,
        artifactPath: null,
      },
    };
  }
  const archive =
    archiveKey === primaryKey
      ? { status: 'missing' as const, object: null }
      : await readOneObject(storage, archiveKey, maxBytes);
  if (archive.object) {
    const hash = createHash('sha256').update(archive.object.body).digest('hex');
    return {
      object: archive.object,
      rawMime: {
        primaryKey,
        archiveKey,
        primaryStatus: primary.status,
        archiveStatus: archive.status,
        status: 'available',
        source: 'archive',
        selectedKey: archiveKey,
        byteLength: archive.object.body.byteLength,
        sha256: hash,
        contentType: archive.object.contentType,
        artifactPath: null,
      },
    };
  }
  const failureStatus =
    primary.status === 'oversized' || archive.status === 'oversized'
      ? 'oversized'
      : primary.status === 'read_error' || archive.status === 'read_error'
        ? 'read_error'
        : 'missing';
  return {
    object: null,
    rawMime: {
      primaryKey,
      archiveKey,
      primaryStatus: primary.status,
      archiveStatus: archive.status,
      status: failureStatus,
      source: null,
      selectedKey: null,
      byteLength: null,
      sha256: null,
      contentType: null,
      artifactPath: null,
    },
  };
}

function isKnownCenturionMailbox(
  row: CenturionQuarantineMetadataRow,
  identities: ReadonlySet<string>,
): boolean {
  return (
    (CENTURION_INGEST_MAILBOX_IDS as readonly string[]).includes(row.ingestMailboxId) ||
    (row.ingestMailboxEmail !== null &&
      identities.has(normalizeAddress(row.ingestMailboxEmail) ?? ''))
  );
}

function parsedQueueMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const outcome = (payload as Record<string, unknown>).deliveryOutcome;
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
  return typeof (outcome as Record<string, unknown>).messageId === 'string'
    ? ((outcome as Record<string, unknown>).messageId as string)
    : null;
}

function queueEvidence(
  messageId: string | null,
  queueRows: readonly CenturionQuarantineQueueRow[],
): { correlated: boolean; status: string | null } {
  const normalized = normalizeMessageId(messageId);
  if (!normalized) return { correlated: false, status: null };
  const matches = queueRows.filter(
    (row) =>
      normalizeMessageId(row.messageIdHeader) === normalized ||
      normalizeMessageId(parsedQueueMessageId(row.smtpPayload)) === normalized,
  );
  if (matches.length === 0) return { correlated: false, status: null };
  const sent = matches.find((row) => row.status.toLowerCase() === 'sent');
  return { correlated: true, status: sent?.status ?? matches[0]?.status ?? null };
}

function partitionForDate(value: string | null): QuarantineReportPartition {
  if (!value) return 'undated';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'undated';
  const start = Date.parse(CENTURION_QUARANTINE_WINDOW.startInclusive);
  const end = Date.parse(CENTURION_QUARANTINE_WINDOW.endExclusive);
  const spillEnd = Date.parse(CENTURION_QUARANTINE_WINDOW.spilloverEndExclusive);
  if (timestamp >= start && timestamp < end) return 'core';
  if (timestamp >= end && timestamp < spillEnd) return 'september17_spillover';
  return 'outside_window';
}

function directionForSignals(input: {
  knownMailbox: boolean;
  ownerMismatch: boolean;
  senderMatches: boolean;
  recipientMatches: boolean;
  bccMirror: boolean;
  selfLoopback: boolean;
  queueCorrelated: boolean;
  queueStatus: string | null;
}): { status: QuarantineRecordStatus; routingStatus: QuarantineRoutingStatus } {
  if (!input.knownMailbox) return { status: 'unattributed', routingStatus: 'unrelated_mailbox' };
  if (input.ownerMismatch) return { status: 'unattributed', routingStatus: 'owner_mismatch' };
  if (input.queueCorrelated && input.queueStatus?.toLowerCase() === 'sent') {
    return { status: 'outbound', routingStatus: 'centurion' };
  }
  if (input.senderMatches && input.recipientMatches) {
    return { status: 'ambiguous', routingStatus: 'centurion' };
  }
  if (input.senderMatches) return { status: 'outbound', routingStatus: 'centurion' };
  if (input.recipientMatches || input.bccMirror)
    return { status: 'inbound', routingStatus: 'centurion' };
  if (input.selfLoopback) return { status: 'ambiguous', routingStatus: 'centurion' };
  return { status: 'unattributed', routingStatus: 'centurion' };
}

function initialEvidence(): QuarantineEvidence {
  return {
    effectiveSender: null,
    ownerHeaderValue: null,
    ownerHeaderMatches: false,
    ownerHeaderMismatch: false,
    ownerHeaderConflict: false,
    senderMatchesCenturion: false,
    recipientMatchesCenturion: false,
    bccMirror: false,
    selfLoopback: false,
    queueCorrelated: false,
    queueStatus: null,
  };
}

function emptyRawMime(
  row: CenturionQuarantineMetadataRow,
  status: QuarantineRawMimeStatus,
): QuarantineRawMime {
  return {
    primaryKey: row.rawMimeS3Key,
    archiveKey: archiveKeyFor(row),
    primaryStatus: status,
    archiveStatus: status === 'not_attempted' ? 'not_attempted' : 'missing',
    status,
    source: null,
    selectedKey: null,
    byteLength: null,
    sha256: null,
    contentType: null,
    artifactPath: null,
  };
}

function recordBase(
  row: CenturionQuarantineMetadataRow,
  knownMailbox: boolean,
): CenturionQuarantineRecord {
  const createdAt = normalizeTimestamp(row.quarantineCreatedAt);
  const evidence = initialEvidence();
  return {
    recordType: 'quarantine',
    schemaVersion: 'centurion-quarantine-v1',
    id: row.id,
    ingestMailboxId: row.ingestMailboxId,
    ingestMailboxEmail: row.ingestMailboxEmail,
    pop3Uidl: row.pop3Uidl,
    reason: row.reason,
    ownerHeaderValue: row.ownerHeaderValue,
    parsedHeaders: row.parsedHeaders,
    quarantineCreatedAt: createdAt,
    messageDate: null,
    dateHeader: null,
    dateStatus: 'missing',
    reportPartition: 'undated',
    quarantineCreatedPartition: partitionForDate(createdAt),
    status: knownMailbox ? 'missing_object' : 'unattributed',
    routingStatus: knownMailbox ? 'missing_object' : 'unrelated_mailbox',
    parseStatus: knownMailbox ? 'missing_object' : 'not_attempted',
    parseError: null,
    rawMime: knownMailbox ? emptyRawMime(row, 'missing') : emptyRawMime(row, 'not_attempted'),
    messageId: null,
    inReplyTo: null,
    references: [],
    subject: null,
    textBody: '',
    htmlBody: '',
    headers: {},
    rawHeaders: [],
    from: [],
    to: [],
    cc: [],
    bcc: [],
    effectiveSender: null,
    attachments: [],
    evidence: { ...evidence },
    duplicateUidl: false,
    duplicateRawHash: false,
  };
}

function applyParsedSignals(
  record: CenturionQuarantineRecord,
  parsed: ParsedLocalMime,
  input: {
    knownMailbox: boolean;
    transportIdentities: ReadonlySet<string>;
    queueRows: readonly CenturionQuarantineQueueRow[];
  },
): void {
  const rowOwner = normalizeAddress(record.ownerHeaderValue);
  const parsedOwner = normalizeAddress(parsed.ownerHeaderValue);
  const ownerConflict = rowOwner !== null && parsedOwner !== null && rowOwner !== parsedOwner;
  const rowOwnerMismatch = rowOwner !== null && !input.transportIdentities.has(rowOwner);
  const parsedOwnerMismatch = parsedOwner !== null && !input.transportIdentities.has(parsedOwner);
  const ownerMismatch = ownerConflict || rowOwnerMismatch || parsedOwnerMismatch;
  const ownerMatches =
    !ownerMismatch &&
    (rowOwner !== null || parsedOwner !== null) &&
    input.transportIdentities.has(parsedOwner ?? rowOwner ?? '');
  const effectiveSenderAddress = normalizeAddress(parsed.effectiveSender);
  const senderMatches =
    effectiveSenderAddress !== null && input.transportIdentities.has(effectiveSenderAddress);
  const addresses = [...parsed.to, ...parsed.cc, ...parsed.bcc];
  const recipientMatches = addresses.some((value) =>
    input.transportIdentities.has(normalizeAddress(value) ?? ''),
  );
  const bccMirror =
    parsed.bcc.some((value) => input.transportIdentities.has(normalizeAddress(value) ?? '')) &&
    !senderMatches;
  const selfLoopback = senderMatches && recipientMatches;
  const queue = queueEvidence(parsed.messageId, input.queueRows);
  const direction = directionForSignals({
    knownMailbox: input.knownMailbox,
    ownerMismatch,
    senderMatches,
    recipientMatches,
    bccMirror,
    selfLoopback,
    queueCorrelated: queue.correlated,
    queueStatus: queue.status,
  });

  record.ownerHeaderValue = parsed.ownerHeaderValue ?? record.ownerHeaderValue;
  record.messageDate = parsed.messageDate;
  record.dateHeader = parsed.dateHeader;
  record.dateStatus = parsed.dateStatus;
  record.reportPartition = partitionForDate(parsed.messageDate);
  record.status = direction.status;
  record.routingStatus = direction.routingStatus;
  record.parseStatus = 'parsed';
  record.messageId = parsed.messageId;
  record.inReplyTo = parsed.inReplyTo;
  record.references = parsed.references;
  record.subject = parsed.subject;
  record.textBody = parsed.textBody;
  record.htmlBody = parsed.htmlBody;
  record.headers = parsed.headers;
  record.rawHeaders = parsed.rawHeaders;
  record.from = parsed.from;
  record.to = parsed.to;
  record.cc = parsed.cc;
  record.bcc = parsed.bcc;
  record.effectiveSender = parsed.effectiveSender;
  record.attachments = parsed.attachments;
  record.evidence = {
    effectiveSender: parsed.effectiveSender,
    ownerHeaderValue: parsed.ownerHeaderValue ?? record.ownerHeaderValue,
    ownerHeaderMatches: ownerMatches,
    ownerHeaderMismatch: ownerMismatch,
    ownerHeaderConflict: ownerConflict,
    senderMatchesCenturion: senderMatches,
    recipientMatchesCenturion: recipientMatches,
    bccMirror,
    selfLoopback,
    queueCorrelated: queue.correlated,
    queueStatus: queue.status,
  };
}

function markDuplicateGroups(
  records: CenturionQuarantineRecord[],
  existingMessages: readonly CenturionQuarantineExistingMessageRow[],
  asOf: string,
): { duplicateUidGroupCount: number; duplicateRawHashGroupCount: number } {
  const uidGroups = new Map<string, CenturionQuarantineRecord[]>();
  const hashGroups = new Map<string, CenturionQuarantineRecord[]>();
  for (const record of records) {
    const uidKey = `${record.ingestMailboxId}\u0000${record.pop3Uidl}`;
    const uidGroup = uidGroups.get(uidKey) ?? [];
    uidGroup.push(record);
    uidGroups.set(uidKey, uidGroup);
    if (record.rawMime.sha256) {
      const hashGroup = hashGroups.get(record.rawMime.sha256) ?? [];
      hashGroup.push(record);
      hashGroups.set(record.rawMime.sha256, hashGroup);
    }
  }
  const existingUidKeys = new Set(
    existingMessages
      .filter((message) => {
        const createdAt = Date.parse(message.createdAt ?? '');
        const cutoff = Date.parse(asOf);
        return Number.isFinite(createdAt) && Number.isFinite(cutoff) && createdAt < cutoff;
      })
      .filter((message) => message.ingestMailboxId && message.pop3Uidl)
      .map((message) => `${message.ingestMailboxId}\u0000${message.pop3Uidl}`),
  );
  let duplicateUidGroupCount = 0;
  for (const [key, group] of uidGroups) {
    const duplicate = group.length > 1 || existingUidKeys.has(key);
    if (!duplicate) continue;
    duplicateUidGroupCount += 1;
    for (const record of group) record.duplicateUidl = true;
  }
  let duplicateRawHashGroupCount = 0;
  for (const group of hashGroups.values()) {
    if (group.length < 2) continue;
    duplicateRawHashGroupCount += 1;
    for (const record of group) record.duplicateRawHash = true;
  }
  return { duplicateUidGroupCount, duplicateRawHashGroupCount };
}

function recordCounts(
  records: readonly CenturionQuarantineRecord[],
  duplicateCounts: { duplicateUidGroupCount: number; duplicateRawHashGroupCount: number },
  quarantineRowCount: number,
): CenturionQuarantineCounts {
  const centurion = records.filter((record) => record.routingStatus !== 'unrelated_mailbox');
  return {
    sourceRowCount: records.length,
    quarantineRowCount,
    centurionRowCount: centurion.length,
    parseFailureCount: centurion.filter((record) => record.reason.toLowerCase() === 'parse_failure')
      .length,
    coreCount: records.filter((record) => record.reportPartition === 'core').length,
    september17SpilloverCount: records.filter(
      (record) => record.reportPartition === 'september17_spillover',
    ).length,
    undatedCount: records.filter((record) => record.reportPartition === 'undated').length,
    outsideWindowCount: records.filter((record) => record.reportPartition === 'outside_window')
      .length,
    parseErrorCount: records.filter((record) => record.parseStatus === 'parse_error').length,
    missingObjectCount: records.filter((record) => record.parseStatus === 'missing_object').length,
    ...duplicateCounts,
  };
}

/** Build the complete source ledger from offline metadata and a read-only object seam. */
export async function buildCenturionQuarantineSnapshot(
  input: CenturionQuarantineReadInput,
): Promise<CenturionQuarantineSnapshot> {
  const maxMessageBytes = input.maxMessageBytes ?? RAW_MIME_MAX_BYTES;
  const records: CenturionQuarantineRecord[] = [];
  const artifacts: CenturionQuarantineRawArtifact[] = [];
  const sortedRows = [...input.rows].sort((left, right) =>
    `${left.quarantineCreatedAt ?? ''}\u0000${left.id}`.localeCompare(
      `${right.quarantineCreatedAt ?? ''}\u0000${right.id}`,
    ),
  );
  for (const row of sortedRows) {
    const knownMailbox = isKnownCenturionMailbox(row, input.transportIdentities);
    const record = recordBase(row, knownMailbox);
    if (knownMailbox) {
      const loaded = await loadRawObject(row, input.storage, maxMessageBytes);
      record.rawMime = loaded.rawMime;
      if (loaded.object) {
        const artifactPath = `raw-mime/${createHash('sha256').update(`${row.id}\u0000${row.pop3Uidl}`).digest('hex').slice(0, 32)}.eml`;
        record.rawMime.artifactPath = artifactPath;
        artifacts.push({ path: artifactPath, body: loaded.object.body });
        try {
          const parsed = await parseCenturionQuarantineMime(loaded.object.body, {
            maxAttachmentBytes: input.maxAttachmentBytes,
          });
          applyParsedSignals(record, parsed, {
            knownMailbox,
            transportIdentities: input.transportIdentities,
            queueRows: input.queueRows,
          });
        } catch (error) {
          record.status = 'parse_error';
          record.routingStatus = 'parse_error';
          record.parseStatus = 'parse_error';
          record.parseError = safeParserError(error);
          record.reportPartition = 'undated';
        }
      } else {
        record.status = 'missing_object';
        record.routingStatus = 'missing_object';
        record.parseStatus = 'missing_object';
      }
    }
    records.push(record);
  }
  const duplicateCounts = markDuplicateGroups(
    records,
    input.existingMessages,
    normalizeTimestamp(input.asOf) ?? input.asOf,
  );
  const counts = recordCounts(records, duplicateCounts, input.rows.length);
  return {
    schemaVersion: 'centurion-quarantine-v1',
    asOf: normalizeTimestamp(input.asOf) ?? input.asOf,
    transportId: CENTURION_TRANSPORT_ID,
    window: CENTURION_QUARANTINE_WINDOW,
    records,
    counts,
    rawArtifacts: artifacts,
  };
}

function defaultClientFactory(
  databaseUrl: string,
  options: { max: 1; ssl: ReturnType<typeof getPostgresSslOptions> },
): CenturionQuarantinePostgresClient {
  return postgres(databaseUrl, options) as unknown as CenturionQuarantinePostgresClient;
}

function dbText(value: unknown): string | null {
  return textOrNull(value);
}

function dbUnknown(value: unknown): unknown {
  return value;
}

function mapMetadataRow(row: Record<string, unknown>): CenturionQuarantineMetadataRow | null {
  const id = dbText(row.id);
  const ingestMailboxId = dbText(row.ingestMailboxId);
  const pop3Uidl = dbText(row.pop3Uidl);
  const rawMimeS3Key = dbText(row.rawMimeS3Key);
  const reason = dbText(row.reason);
  if (!id || !ingestMailboxId || !pop3Uidl || !rawMimeS3Key || !reason) return null;
  return {
    id,
    ingestMailboxId,
    ingestMailboxEmail: dbText(row.ingestMailboxEmail),
    pop3Uidl,
    rawMimeS3Key,
    reason,
    ownerHeaderValue: dbText(row.ownerHeaderValue),
    parsedHeaders: dbUnknown(row.parsedHeaders),
    quarantineCreatedAt: normalizeTimestamp(row.quarantineCreatedAt),
  };
}

function mapQueueRow(row: Record<string, unknown>): CenturionQuarantineQueueRow | null {
  const messageId = dbText(row.messageId);
  const transportId = dbText(row.transportId);
  const status = dbText(row.status);
  if (!messageId || !transportId || !status) return null;
  return {
    messageId,
    transportId,
    status,
    messageIdHeader: dbText(row.messageIdHeader),
    smtpPayload: dbUnknown(row.smtpPayload),
    createdAt: normalizeTimestamp(row.createdAt),
  };
}

function mapExistingMessageRow(
  row: Record<string, unknown>,
): CenturionQuarantineExistingMessageRow | null {
  const id = dbText(row.id);
  const transportId = dbText(row.transportId);
  if (!id || !transportId) return null;
  return {
    id,
    transportId,
    ingestMailboxId: dbText(row.ingestMailboxId),
    pop3Uidl: dbText(row.pop3Uidl),
    rawMimeS3Key: dbText(row.rawMimeS3Key),
    messageIdHeader: dbText(row.messageIdHeader),
    direction: dbText(row.direction),
    createdAt: normalizeTimestamp(row.createdAt),
  };
}

function queueTransportRows(
  rows: readonly CenturionQuarantineQueueRow[],
): CenturionQuarantineQueueRow[] {
  return rows.filter((row) => row.transportId === CENTURION_TRANSPORT_ID);
}

export function createCenturionQuarantinePostgresReader(
  options: CenturionQuarantinePostgresReaderOptions,
): CenturionQuarantineReader {
  const databaseUrl = nonBlankEnvironmentValue(options.databaseUrl);
  const client = (options.clientFactory ?? defaultClientFactory)(databaseUrl, {
    max: 1,
    ssl: getPostgresSslOptions(databaseUrl),
  });
  let closed = false;
  return {
    async readCenturionQuarantineSnapshot(): Promise<CenturionQuarantineSnapshot> {
      if (closed) throw new Error('reader closed');
      return await client.begin('isolation level repeatable read read only', async (connection) => {
        const asOfRows = options.asOf
          ? [{ asOf: options.asOf }]
          : await connection<{ asOf?: unknown }>`SELECT CURRENT_TIMESTAMP AS "asOf"`;
        const asOf = normalizeTimestamp(asOfRows[0]?.asOf);
        if (!asOf) throw new Error('snapshot timestamp unavailable');
        const transportRows = await connection<Record<string, unknown>>`
          SELECT id, email, owner_header_value AS "ownerHeaderValue", send_from_config AS "sendFromConfig"
          FROM mailbox_transport
          WHERE id = ${CENTURION_TRANSPORT_ID} AND is_active = true
        `;
        const transport = transportRows[0];
        if (!transport) throw new Error('Centurion transport unavailable');
        const identities = transportIdentitySet(transport);
        if (identities.size === 0) throw new Error('Centurion transport identities unavailable');
        const metadataRows = await connection<Record<string, unknown>>`
          SELECT
            q.id,
            q.ingest_mailbox_id AS "ingestMailboxId",
            im.email AS "ingestMailboxEmail",
            q.pop3_uidl AS "pop3Uidl",
            q.raw_mime_s3_key AS "rawMimeS3Key",
            q.reason,
            q.owner_header_value AS "ownerHeaderValue",
            q.parsed_headers AS "parsedHeaders",
            q.created_at AS "quarantineCreatedAt"
          FROM mail_ingest_quarantine AS q
          LEFT JOIN mail_ingest_mailbox AS im ON im.id = q.ingest_mailbox_id
          WHERE q.created_at < ${asOf}
          ORDER BY q.created_at, q.id
        `;
        const queueRows = await connection<Record<string, unknown>>`
          SELECT
            q.message_id AS "messageId",
            q.transport_id AS "transportId",
            q.status,
            m.message_id_header AS "messageIdHeader",
            q.smtp_payload AS "smtpPayload",
            q.created_at AS "createdAt"
          FROM outbound_send_queue AS q
          LEFT JOIN message AS m ON m.id = q.message_id AND m.transport_id = q.transport_id
          WHERE q.transport_id = ${CENTURION_TRANSPORT_ID}
            AND q.created_at < ${asOf}
          ORDER BY q.created_at, q.id
        `;
        const existingRows = await connection<Record<string, unknown>>`
          SELECT
            m.id,
            m.transport_id AS "transportId",
            m.ingest_mailbox_id AS "ingestMailboxId",
            m.pop3_uidl AS "pop3Uidl",
            m.raw_mime_s3_key AS "rawMimeS3Key",
            m.message_id_header AS "messageIdHeader",
            m.direction::text AS "direction",
            m.created_at AS "createdAt"
          FROM message AS m
          WHERE (m.transport_id = ${CENTURION_TRANSPORT_ID}
             OR m.ingest_mailbox_id = ANY(${[...CENTURION_INGEST_MAILBOX_IDS]}))
            AND m.created_at < ${asOf}
        `;
        return await buildCenturionQuarantineSnapshot({
          asOf,
          rows: metadataRows
            .map(mapMetadataRow)
            .filter((row): row is CenturionQuarantineMetadataRow => row !== null),
          transportIdentities: identities,
          queueRows: queueTransportRows(
            queueRows
              .map(mapQueueRow)
              .filter((row): row is CenturionQuarantineQueueRow => row !== null),
          ),
          existingMessages: existingRows
            .map(mapExistingMessageRow)
            .filter((row): row is CenturionQuarantineExistingMessageRow => row !== null),
          storage: options.storage,
        });
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await client.end();
    },
  };
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    !value.split('/').includes('..')
  );
}

function repoRootFromScript(scriptPath: string): string {
  if (!isCanonicalAbsolutePath(scriptPath)) return failPreflight();
  return path.posix.resolve(path.posix.dirname(scriptPath), '../../..');
}

function corpusRootFor(repoRoot: string): string {
  if (!isCanonicalAbsolutePath(repoRoot)) return failPreflight();
  return path.posix.join(repoRoot, ...CORPUS_PATH_SEGMENTS);
}

function snapshotIdFor(uuid: string): string {
  if (!UUID_PATTERN.test(uuid)) return failPreflight();
  return `${SNAPSHOT_ID_PREFIX}${uuid}`;
}

function outputPathFor(corpusRoot: string, snapshotId: string): string {
  if (!isCanonicalAbsolutePath(corpusRoot) || !snapshotId.startsWith(SNAPSHOT_ID_PREFIX))
    return failPreflight();
  return path.posix.join(corpusRoot, snapshotId);
}

function defaultValidateAllocatedDir(request: {
  repoRoot: string;
  corpusRoot: string;
  snapshotId: string;
  outDir: string;
}): void {
  if (
    !isCanonicalAbsolutePath(request.repoRoot) ||
    !isCanonicalAbsolutePath(request.corpusRoot) ||
    !isCanonicalAbsolutePath(request.outDir) ||
    !request.snapshotId.startsWith(SNAPSHOT_ID_PREFIX) ||
    request.snapshotId === SNAPSHOT_ID_PREFIX
  )
    return failPreflight();
  const relative = path.posix.relative(request.repoRoot, request.outDir);
  if (relative !== `${CORPUS_PATH_SEGMENTS.join('/')}/${request.snapshotId}`)
    return failPreflight();
}

function orderedRecordHash(snapshot: CenturionQuarantineSnapshot): string {
  return createHash('sha256')
    .update(snapshot.records.map((record) => JSON.stringify(record)).join('\n'))
    .digest('hex');
}

function safeManifest(
  snapshot: CenturionQuarantineSnapshot,
  snapshotId: string,
): Record<string, unknown> {
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotId,
    exporterVersion: EXPORTER_VERSION,
    transportId: snapshot.transportId,
    asOf: snapshot.asOf,
    window: snapshot.window,
    counts: snapshot.counts,
    orderedRecordSha256: orderedRecordHash(snapshot),
    source: {
      readMode: 'ec2-imds-v2-read-only-rds-repeatable-read-s3-get-only',
      writes: false,
      reportedParseFailureCount: snapshot.counts.parseFailureCount,
    },
    relatedNormalSnapshotSchema: 'centurion-nine-day-corpus-v1',
  };
}

function assertSnapshot(snapshot: CenturionQuarantineSnapshot): void {
  if (
    snapshot.transportId !== CENTURION_TRANSPORT_ID ||
    snapshot.schemaVersion !== 'centurion-quarantine-v1' ||
    !Array.isArray(snapshot.records) ||
    !snapshot.counts ||
    !Number.isSafeInteger(snapshot.counts.sourceRowCount)
  )
    return failPreflight();
  if (
    snapshot.counts.sourceRowCount !== snapshot.records.length ||
    snapshot.counts.quarantineRowCount < snapshot.records.length
  )
    return failPreflight();
  for (const record of snapshot.records) {
    if (
      record.schemaVersion !== 'centurion-quarantine-v1' ||
      record.recordType !== 'quarantine' ||
      !record.id ||
      !record.ingestMailboxId ||
      !record.pop3Uidl
    )
      return failPreflight();
  }
}

async function defaultWriteSnapshot(
  request: CenturionQuarantineSnapshotWriteRequest,
): Promise<void> {
  const outputDirectory = path.resolve(request.outDir);
  const outputRoot = path.resolve(request.repoRoot, '.private', PRIVATE_CORPUS_DIRECTORY_NAME);
  if (
    path.dirname(outputDirectory) !== outputRoot ||
    !outputDirectory.startsWith(`${outputRoot}${path.sep}`)
  )
    return failPreflight();
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const entry = await lstat(outputDirectory);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(path.dirname(outputDirectory))) !== outputRoot
  )
    return failPreflight();
  const rawDirectory = path.join(outputDirectory, 'raw-mime');
  await mkdir(rawDirectory, { recursive: false, mode: 0o700 });
  await chmod(rawDirectory, 0o700);
  for (const artifact of request.rawArtifacts) {
    const artifactPath = path.resolve(outputDirectory, artifact.path);
    if (path.dirname(artifactPath) !== rawDirectory || !artifact.path.startsWith('raw-mime/'))
      return failPreflight();
    await writeFile(artifactPath, artifact.body, { mode: 0o600, flag: 'wx' });
    await chmod(artifactPath, 0o600);
  }
  const recordsJsonl = `${request.snapshot.records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await writeFile(path.join(outputDirectory, 'quarantine.jsonl'), recordsJsonl, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(
    path.join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(safeManifest(request.snapshot, request.snapshotId), null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  await chmod(path.join(outputDirectory, 'quarantine.jsonl'), 0o600);
  await chmod(path.join(outputDirectory, 'manifest.json'), 0o600);
}

function failureJson(code: 'invalid_arguments' | 'preflight_failed' | 'export_failed'): string {
  return `${JSON.stringify({ event: 'centurion_quarantine_export.failed', code })}\n`;
}

function writeFailure(
  dependencies: LiveCenturionQuarantineDependencies,
  code: 'invalid_arguments' | 'preflight_failed' | 'export_failed',
): number {
  try {
    dependencies.writeStderr(failureJson(code));
  } catch {
    /* fixed failure output is best effort */
  }
  return 1;
}

async function defaultAttestImdsV2(): Promise<boolean> {
  const token = await directCenturionImdsRequest('PUT', '/latest/api/token', {
    'X-aws-ec2-metadata-token-ttl-seconds': '60',
  });
  if (!token) return false;
  const instanceId = await directCenturionImdsRequest('GET', '/latest/meta-data/instance-id', {
    'X-aws-ec2-metadata-token': token,
  });
  return instanceId === APPROVED_INSTANCE_ID;
}

function defaultDependencies(): LiveCenturionQuarantineDependencies {
  return {
    args: () => process.argv.slice(2),
    platform: () => process.platform,
    scriptPath: () => fileURLToPath(import.meta.url),
    attestImdsV2: defaultAttestImdsV2,
    preflightOutputDestination: async (repoRoot, outDir) => {
      await preflightPrivateThreadCorpusOutputDestination(repoRoot, outDir);
    },
    uuid: randomUUID,
    environment: () => ({
      DATABASE_URL: process.env.DATABASE_URL,
      AWS_REGION: process.env.AWS_REGION,
      S3_BUCKET: process.env.S3_BUCKET,
    }),
    createStorage: () => getS3Storage(),
    createReader: (options) => createCenturionQuarantinePostgresReader(options),
    writeSnapshot: defaultWriteSnapshot,
    validateAllocatedDir: defaultValidateAllocatedDir,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value),
  };
}

type PreparedExport = {
  repoRoot: string;
  corpusRoot: string;
  outDir: string;
  snapshotId: string;
  databaseUrl: string;
  awsRegion: string;
  s3Bucket: string;
};

async function prepareExport(
  dependencies: LiveCenturionQuarantineDependencies,
): Promise<PreparedExport> {
  if (dependencies.platform() !== 'linux') return failPreflight();
  const repoRoot = repoRootFromScript(dependencies.scriptPath());
  if (!(await dependencies.attestImdsV2())) return failPreflight();
  const corpusRoot = corpusRootFor(repoRoot);
  const snapshotId = snapshotIdFor(dependencies.uuid());
  const outDir = outputPathFor(corpusRoot, snapshotId);
  await dependencies.preflightOutputDestination(repoRoot, outDir);
  dependencies.validateAllocatedDir({ repoRoot, corpusRoot, snapshotId, outDir });
  const environment = dependencies.environment();
  return {
    repoRoot,
    corpusRoot,
    outDir,
    snapshotId,
    databaseUrl: nonBlankEnvironmentValue(environment.DATABASE_URL),
    awsRegion: nonBlankEnvironmentValue(environment.AWS_REGION),
    s3Bucket: nonBlankEnvironmentValue(environment.S3_BUCKET),
  };
}

export function createCenturionQuarantineExportCommand(
  overrides: Partial<LiveCenturionQuarantineDependencies> = {},
): () => Promise<number> {
  const dependencies: LiveCenturionQuarantineDependencies = {
    ...defaultDependencies(),
    ...overrides,
  };
  return async (): Promise<number> => {
    let args: readonly string[];
    try {
      args = dependencies.args();
    } catch {
      return writeFailure(dependencies, 'invalid_arguments');
    }
    if (args.length !== 0) return writeFailure(dependencies, 'invalid_arguments');
    let prepared: PreparedExport;
    try {
      prepared = await prepareExport(dependencies);
    } catch {
      return writeFailure(dependencies, 'preflight_failed');
    }
    let reader: CenturionQuarantineExportReader | undefined;
    try {
      const storage = dependencies.createStorage();
      reader = dependencies.createReader({
        databaseUrl: prepared.databaseUrl,
        storage,
      });
      const snapshot = await reader.readCenturionQuarantineSnapshot();
      assertSnapshot(snapshot);
      await reader.close();
      reader = undefined;
      await dependencies.writeSnapshot({
        repoRoot: prepared.repoRoot,
        outDir: prepared.outDir,
        snapshotId: prepared.snapshotId,
        snapshot,
        rawArtifacts: snapshot.rawArtifacts ?? [],
      });
      dependencies.writeStdout(`${JSON.stringify(snapshot.counts)}\n`);
      return 0;
    } catch {
      return writeFailure(dependencies, 'export_failed');
    } finally {
      if (reader) {
        try {
          await reader.close();
        } catch {
          /* fixed failure output */
        }
      }
    }
  };
}

export async function runCenturionQuarantineExport(
  overrides: Partial<LiveCenturionQuarantineDependencies> = {},
): Promise<number> {
  return await createCenturionQuarantineExportCommand(overrides)();
}

function isEntryScript(): boolean {
  const entryPath = process.argv[1];
  return (
    typeof entryPath === 'string' && fileURLToPath(import.meta.url) === path.resolve(entryPath)
  );
}

if (isEntryScript()) {
  void runCenturionQuarantineExport().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
