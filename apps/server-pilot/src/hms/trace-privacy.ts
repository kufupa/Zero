import { chmod, lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export const HMS_TRACE_SANITIZER_VERSION = 'hms-trace-sanitizer-v1' as const;
export const HMS_TRACE_MAX_COMPRESSED_BYTES = 256 * 1024 ** 2;
export const HMS_TRACE_MAX_EXPANDED_BYTES = 256 * 1024 ** 2;
export const HMS_TRACE_MAX_ENTRY_COUNT = 4096;
export const HMS_TRACE_MAX_ENTRY_NAME_BYTES = 512;
export const HMS_TRACE_MAX_COMPRESSION_RATIO = 1000;
const MAX_TEXT_ENTRY_BYTES = 32 * 1024 ** 2;
const MAX_SECRET_VALUE_BYTES = 1024 * 1024;
const MAX_SECRET_VARIANT_BYTES = 16 * 1024 ** 2;
const READ_CHUNK_BYTES = 1024 * 1024;
const SUPPORTED_TRACE_STREAMS = new Set(['trace.trace', 'trace.network', 'trace.stacks']);
const REDACTION = '[REDACTED]';
const OMIT = Symbol('omit');

export class HmsTracePrivacyError extends Error {
  readonly code = 'TRACE_PRIVACY_FAILED' as const;

  constructor(reason = 'native trace privacy validation failed') {
    super(reason);
    this.name = 'HmsTracePrivacyError';
  }
}

type Digest = { sha256: string; bytes: number };

export type HmsTraceSanitizationResult = {
  raw: Digest;
  review: Digest;
  sanitizerVersion: typeof HMS_TRACE_SANITIZER_VERSION;
};

export type HmsTracePrivacyOptions = {
  signal?: AbortSignal;
};

type BoundedTraceArchive = Record<string, Uint8Array>;

type ZipCentralEntry = {
  name: string;
  compressedSize: number;
  expandedSize: number;
  crc32: number;
  flags: number;
  compression: number;
  localOffset: number;
  nameBytes: Buffer;
  externalAttributes: number;
};

type SecretVariant = {
  text: string;
  bytes: Buffer;
  short: boolean;
  explicit: boolean;
};

function privacyFailure(): never {
  throw new HmsTracePrivacyError();
}

function assertPrivacyActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) privacyFailure();
  const deadlineMs = (signal as (AbortSignal & { deadlineMs?: unknown }) | undefined)?.deadlineMs;
  if (typeof deadlineMs === 'number' && (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now())) {
    privacyFailure();
  }
}

function deadlineFor(signal: AbortSignal | undefined): number | undefined {
  const deadlineMs = (signal as (AbortSignal & { deadlineMs?: unknown }) | undefined)?.deadlineMs;
  return typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) ? deadlineMs : undefined;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function readBoundedTraceFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  let pathInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    pathInfo = await lstat(path);
  } catch {
    privacyFailure();
  }
  if (!pathInfo!.isFile() || pathInfo!.size <= 0 || pathInfo!.size > HMS_TRACE_MAX_COMPRESSED_BYTES) {
    privacyFailure();
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    assertPrivacyActive(signal);
    handle = await open(path, 'r');
    const initial = await handle.stat();
    if (
      !initial.isFile() ||
      initial.dev !== pathInfo!.dev ||
      initial.ino !== pathInfo!.ino ||
      initial.size !== pathInfo!.size ||
      initial.size <= 0 ||
      initial.size > HMS_TRACE_MAX_COMPRESSED_BYTES
    ) {
      privacyFailure();
    }
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < initial.size) {
      assertPrivacyActive(signal);
      const length = Math.min(READ_CHUNK_BYTES, initial.size - offset);
      const result = await handle.read(bytes, offset, length, offset);
      if (result.bytesRead <= 0) privacyFailure();
      offset += result.bytesRead;
    }
    const final = await handle.stat();
    if (
      !final.isFile() ||
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size ||
      offset !== final.size
    ) {
      privacyFailure();
    }
    assertPrivacyActive(signal);
    return bytes;
  } catch (error) {
    if (error instanceof HmsTracePrivacyError) throw error;
    throw new HmsTracePrivacyError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function digestBytes(bytes: Uint8Array): Digest {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  };
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) privacyFailure();
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) privacyFailure();
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    privacyFailure();
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) return offset;
  }
  privacyFailure();
}

function assertSafeEntryName(name: string, nameBytes: Buffer): void {
  if (
    !name ||
    nameBytes.byteLength > HMS_TRACE_MAX_ENTRY_NAME_BYTES ||
    name.includes('\u0000') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(name)
  ) {
    privacyFailure();
  }
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) privacyFailure();
  const isTrace = SUPPORTED_TRACE_STREAMS.has(name);
  const isResource = /^resources\/[A-Za-z0-9._@+-]+$/.test(name);
  if (!isTrace && !isResource) privacyFailure();
}

function assertEntryType(entry: ZipCentralEntry): void {
  // Unix external attributes encode the mode in the high 16 bits. Reject all
  // non-regular typed entries (especially symlinks) before fflate sees bytes.
  const unixMode = (entry.externalAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  if (unixType !== 0 && unixType !== 0o100000) privacyFailure();
  // DOS directory attributes are never valid native trace files.
  if ((entry.externalAttributes & 0x10) !== 0) privacyFailure();
}

function parseCentralDirectory(bytes: Uint8Array): ZipCentralEntry[] {
  if (bytes.byteLength < 22 || bytes.byteLength > HMS_TRACE_MAX_COMPRESSED_BYTES) {
    privacyFailure();
  }
  const endOffset = findEndOfCentralDirectory(bytes);
  const disk = readU16(bytes, endOffset + 4);
  const centralDisk = readU16(bytes, endOffset + 6);
  const entriesOnDisk = readU16(bytes, endOffset + 8);
  const entriesTotal = readU16(bytes, endOffset + 10);
  const centralSize = readU32(bytes, endOffset + 12);
  const centralOffset = readU32(bytes, endOffset + 16);
  const commentLength = readU16(bytes, endOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entriesTotal ||
    entriesTotal === 0 ||
    entriesTotal > HMS_TRACE_MAX_ENTRY_COUNT ||
    commentLength !== bytes.byteLength - endOffset - 22 ||
    centralOffset > endOffset ||
    centralSize > endOffset - centralOffset
  ) {
    privacyFailure();
  }

  const entries: ZipCentralEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let expandedTotal = 0;
  let compressedTotal = 0;
  for (let index = 0; index < entriesTotal; index += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) privacyFailure();
    const flags = readU16(bytes, offset + 8);
    const compression = readU16(bytes, offset + 10);
    const crc = readU32(bytes, offset + 16);
    const compressedSize = readU32(bytes, offset + 20);
    const expandedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const entryCommentLength = readU16(bytes, offset + 32);
    const entryDisk = readU16(bytes, offset + 34);
    const externalAttributes = readU32(bytes, offset + 38);
    const localOffset = readU32(bytes, offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (
      entryEnd > endOffset ||
      entryDisk !== 0 ||
      (flags & 0x1) !== 0 ||
      (flags & 0x40) !== 0 ||
      (flags & ~(0x0008 | 0x0800)) !== 0 ||
      (compression !== 0 && compression !== 8) ||
      (compressedSize === 0 && expandedSize !== 0) ||
      compressedSize > bytes.byteLength ||
      expandedSize > HMS_TRACE_MAX_EXPANDED_BYTES ||
      (compressedSize > 0 && expandedSize / compressedSize > HMS_TRACE_MAX_COMPRESSION_RATIO)
    ) {
      privacyFailure();
    }
    // ZIP64 sentinels require a parser with larger allocation semantics; fail
    // closed instead of accepting values that are not represented here.
    if (
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      privacyFailure();
    }
    const nameBytes = Buffer.from(bytes.slice(offset + 46, offset + 46 + nameLength));
    const name = decodeUtf8(nameBytes);
    assertSafeEntryName(name, nameBytes);
    if (names.has(name)) privacyFailure();
    names.add(name);
    const entry: ZipCentralEntry = {
      name,
      compressedSize,
      expandedSize,
      crc32: crc,
      flags,
      compression,
      localOffset,
      nameBytes,
      externalAttributes,
    };
    assertEntryType(entry);
    entries.push(entry);
    compressedTotal += compressedSize;
    expandedTotal += expandedSize;
    if (
      !Number.isSafeInteger(compressedTotal) ||
      !Number.isSafeInteger(expandedTotal) ||
      expandedTotal > HMS_TRACE_MAX_EXPANDED_BYTES ||
      compressedTotal > HMS_TRACE_MAX_COMPRESSED_BYTES ||
      (compressedTotal > 0 && expandedTotal / compressedTotal > HMS_TRACE_MAX_COMPRESSION_RATIO)
    ) {
      privacyFailure();
    }
    offset = entryEnd;
  }
  if (offset !== centralOffset + centralSize) privacyFailure();
  if (!names.has('trace.trace') || !names.has('trace.network')) privacyFailure();

  // Validate local headers and data extents without extracting to disk. fflate
  // remains the only ZIP decoder; this bounded preflight only rejects unsafe
  // metadata and overlaps before decompression allocation.
  const extents = entries.map((entry) => {
    const local = entry.localOffset;
    if (local < 0 || local >= centralOffset || readU32(bytes, local) !== 0x04034b50) {
      privacyFailure();
    }
    const localFlags = readU16(bytes, local + 6);
    const localCompression = readU16(bytes, local + 8);
    const localCrc = readU32(bytes, local + 14);
    const localCompressedSize = readU32(bytes, local + 18);
    const localExpandedSize = readU32(bytes, local + 22);
    const localNameLength = readU16(bytes, local + 26);
    const localExtraLength = readU16(bytes, local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    const localDescriptor = (localFlags & 0x0008) !== 0;
    if (
      dataStart < local + 30 ||
      dataEnd < dataStart ||
      dataEnd > centralOffset ||
      localFlags !== entry.flags ||
      localCompression !== entry.compression ||
      (localFlags & ~(0x0008 | 0x0800)) !== 0 ||
      localNameLength !== entry.nameBytes.byteLength ||
      !Buffer.from(bytes.slice(local + 30, local + 30 + localNameLength)).equals(entry.nameBytes)
    ) {
      privacyFailure();
    }
    if (localDescriptor) {
      const valuesAreZero = localCrc === 0 && localCompressedSize === 0 && localExpandedSize === 0;
      const valuesMatch =
        localCrc === entry.crc32 &&
        localCompressedSize === entry.compressedSize &&
        localExpandedSize === entry.expandedSize;
      if (!valuesAreZero && !valuesMatch) privacyFailure();
    } else if (
      localCrc !== entry.crc32 ||
      localCompressedSize !== entry.compressedSize ||
      localExpandedSize !== entry.expandedSize
    ) {
      privacyFailure();
    }

    let end = dataEnd;
    if (localDescriptor) {
      const descriptorSignature = readU32(bytes, dataEnd);
      const descriptorStart = descriptorSignature === 0x08074b50 ? dataEnd + 4 : dataEnd;
      const descriptorEnd = descriptorStart + 12;
      if (descriptorEnd > centralOffset) privacyFailure();
      if (
        readU32(bytes, descriptorStart) !== entry.crc32 ||
        readU32(bytes, descriptorStart + 4) !== entry.compressedSize ||
        readU32(bytes, descriptorStart + 8) !== entry.expandedSize
      ) {
        privacyFailure();
      }
      end = descriptorEnd;
    }
    return { start: local, end };
  });
  extents.sort((a, b) => a.start - b.start);
  for (let index = 1; index < extents.length; index += 1) {
    if (extents[index - 1]!.end > extents[index]!.start) privacyFailure();
  }
  return entries;
}

/** Decode only after strict central-directory bounds/type/name validation. */
export function unzipBoundedTraceArchive(bytes: Uint8Array): BoundedTraceArchive {
  const entries = parseCentralDirectory(bytes);
  const allowed = new Map(
    entries.map((entry) => [
      entry.name,
      { compressedSize: entry.compressedSize, expandedSize: entry.expandedSize },
    ]),
  );
  try {
    const archive = unzipSync(bytes, {
      filter: (entry) => {
        const expected = allowed.get(entry.name);
        if (
          !expected ||
          expected.compressedSize !== entry.size ||
          expected.expandedSize !== entry.originalSize
        ) {
          privacyFailure();
        }
        return true;
      },
    });
    for (const entry of entries) {
      const output = archive[entry.name];
      if (
        output === undefined ||
        output.byteLength !== entry.expandedSize ||
        crc32(output) !== entry.crc32
      ) {
        privacyFailure();
      }
    }
    return archive;
  } catch (error) {
    if (error instanceof HmsTracePrivacyError) throw error;
    throw new HmsTracePrivacyError();
  }
}

function escapedSecretVariants(
  secretValues: readonly string[],
  explicitSecrets: ReadonlySet<string> = new Set(),
): SecretVariant[] {
  const variants = new Map<string, SecretVariant>();
  let variantBytes = 0;
  const addText = (value: string, short: boolean, explicit: boolean): void => {
    if (value.length === 0 || variants.has(`text:${value}`)) return;
    const bytes = Buffer.from(value, 'utf8');
    variantBytes += bytes.byteLength;
    if (variantBytes > MAX_SECRET_VARIANT_BYTES) privacyFailure();
    variants.set(`text:${value}`, { text: value, bytes, short, explicit });
  };
  const addBytes = (bytes: Buffer, short: boolean, explicit: boolean): void => {
    if (bytes.byteLength === 0 || variants.has(`bytes:${bytes.toString('base64')}`)) return;
    variantBytes += bytes.byteLength;
    if (variantBytes > MAX_SECRET_VARIANT_BYTES) privacyFailure();
    variants.set(`bytes:${bytes.toString('base64')}`, {
      text: '',
      bytes,
      short,
      explicit,
    });
  };
  for (const secret of secretValues) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    const secretBytes = Buffer.from(secret, 'utf8');
    if (secretBytes.byteLength > MAX_SECRET_VALUE_BYTES) privacyFailure();
    const explicit = explicitSecrets.has(secret);
    // Short credentials still redact in text when explicitly classified, but
    // their coincidental byte sequences must not invalidate native images.
    const short = secretBytes.byteLength < 4;
    addText(secret, short, explicit);
    try {
      addText(encodeURIComponent(secret), short, explicit);
      addText(encodeURI(secret), short, explicit);
      addText(
        new URLSearchParams({ value: secret }).toString().slice('value='.length),
        short,
        explicit,
      );
    } catch {
      privacyFailure();
    }
    const jsonEscaped = JSON.stringify(secret);
    if (typeof jsonEscaped !== 'string') privacyFailure();
    addText(jsonEscaped.slice(1, -1), short, explicit);
    addText(secretBytes.toString('base64'), short, explicit);
    addText(secretBytes.toString('base64url'), short, explicit);
    const utf16le = Buffer.from(secret, 'utf16le');
    addBytes(utf16le, short, explicit);
    const utf16be = Buffer.alloc(utf16le.length);
    for (let offset = 0; offset < utf16le.length; offset += 2) {
      utf16be[offset] = utf16le[offset + 1]!;
      utf16be[offset + 1] = utf16le[offset]!;
    }
    addBytes(utf16be, short, explicit);
  }
  return [...variants.values()].sort((left, right) => {
    const leftLength = left.text.length || left.bytes.length;
    const rightLength = right.text.length || right.bytes.length;
    return rightLength - leftLength;
  });
}

function isLikelyImage(bytes: Uint8Array): boolean {
  return (
    (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a) ||
    (bytes.length >= 6 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) &&
      bytes[5] === 0x61) ||
    (bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50)
  );
}

function containsSecret(
  bytes: Uint8Array,
  variants: readonly SecretVariant[],
  includeShort = false,
): boolean {
  const source = Buffer.from(bytes);
  return variants.some(
    (variant) => (includeShort || !variant.short) && source.includes(variant.bytes),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function percentCaseInsensitivePattern(value: string): RegExp | undefined {
  if (!value.includes('%')) return undefined;
  let pattern = '';
  for (let offset = 0; offset < value.length; offset += 1) {
    const first = value[offset]!;
    const second = value[offset + 1];
    const third = value[offset + 2];
    if (first === '%' && second && third && /^[0-9a-f]$/i.test(second) && /^[0-9a-f]$/i.test(third)) {
      pattern += `%[${second.toLowerCase()}${second.toUpperCase()}][${third.toLowerCase()}${third.toUpperCase()}]`;
      offset += 2;
    } else {
      pattern += escapeRegExp(first);
    }
  }
  try {
    return new RegExp(pattern, 'g');
  } catch {
    return undefined;
  }
}

function redactText(
  text: string,
  variants: readonly SecretVariant[],
  includeShort = false,
): string {
  let result = text;
  for (const variant of variants) {
    if (
      variant.text.length > 0 &&
      (includeShort || !variant.short || variant.explicit)
    ) {
      result = result.split(variant.text).join(REDACTION);
      const pattern = percentCaseInsensitivePattern(variant.text);
      if (pattern) {
        try {
          result = result.replace(pattern, REDACTION);
        } catch {
          // Malformed/catastrophic percent patterns must not abort live proof.
          // split()+join already redacted the literal form.
        }
      }
    }
  }
  return result;
}

function isSensitiveName(key: string): boolean {
  return /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passcode|secret|credential|token|jwt|sid|api[-_]?key|client[-_]?secret|x[-_](?:api[-_]key|auth(?:entication)?[-_]?(?:token|key)?|access[-_]token|refresh[-_]token|csrf[-_]token|session[-_](?:id|token)|id[-_]token)|(?:access|refresh|csrf|session|id)[-_]?(?:token|key|id))$/i.test(
    key,
  );
}

function isCookieName(key: string): boolean {
  return /^cookies?$/i.test(key);
}

function isBodyName(key: string, parentKey: string): boolean {
  if (/^(postdata|postdataentries|requestbody)$/i.test(key)) return true;
  return /^body$/i.test(key) && /^request$/i.test(parentKey);
}

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string' && value.length > 0) out.add(value);
  else if (Array.isArray(value)) for (const child of value) collectStrings(child, out);
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectStrings(child, out);
    }
  }
}

function collectCookieValues(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectCookieValues(child, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^value$/i.test(key)) collectStrings(child, out);
    else if (child && typeof child === 'object') collectCookieValues(child, out);
  }
}

function headerEntryName(value: Record<string, unknown>): string | null {
  const name = value.name ?? value.key;
  return typeof name === 'string' ? name : null;
}

function isCookieHeaderName(name: string): boolean {
  return /^(?:cookie|set-cookie)$/i.test(name);
}

function collectCookieHeaderValues(value: unknown, out: Set<string>, allPairs: boolean): void {
  if (typeof value === 'string') {
    out.add(value);
    const segments = allPairs ? value.split(';') : [value.split(';')[0]!];
    for (const segment of segments) {
      const separator = segment.indexOf('=');
      if (separator <= 0) continue;
      const cookieValue = segment.slice(separator + 1).trim();
      if (cookieValue.length > 0) out.add(cookieValue);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectCookieHeaderValues(child, out, allPairs);
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectCookieHeaderValues(child, out, allPairs);
    }
  }
}

function collectHeaderValues(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      if (Array.isArray(child)) {
        const name = child[0];
        if (typeof name === 'string' && isSensitiveName(name)) {
          if (isCookieHeaderName(name)) {
            collectCookieHeaderValues(child[1], out, /^cookie$/i.test(name));
          } else collectStrings(child[1], out);
        }
      } else if (child && typeof child === 'object') {
        const record = child as Record<string, unknown>;
        const name = headerEntryName(record);
        if (name && isSensitiveName(name)) {
          if (isCookieHeaderName(name)) {
            collectCookieHeaderValues(record.value, out, /^cookie$/i.test(name));
          } else collectStrings(record.value, out);
        }
      }
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveName(key)) {
      if (isCookieHeaderName(key)) {
        collectCookieHeaderValues(child, out, /^cookie$/i.test(key));
      } else collectStrings(child, out);
    }
  }
}

function looksLikeDynamicSecret(value: string): boolean {
  if (value.length < 8) return false;
  if (/^(?:https?|wss?):\/\//i.test(value)) return false;
  if (/\b(?:token|secret|credential|password|session|cookie|authorization|bearer|jwt)\b/i.test(value)) {
    return true;
  }
  return (
    value.length >= 16 &&
    /^[A-Za-z0-9+/_=-]+$/.test(value) &&
    /[0-9A-Z]/.test(value) &&
    !/^(?:[a-z]{2,3}[-_][A-Z]{2}|[0-9a-f]{8}-[0-9a-f-]{27})$/.test(value)
  );
}

function looksLikeDynamicSecretName(value: string): boolean {
  return /(?:token|secret|credential|password|session|cookie|authorization|bearer|jwt)/i.test(value);
}

function collectTraceDynamicValues(value: unknown, key = '', out = new Set<string>()): Set<string> {
  if (isCookieName(key)) collectCookieValues(value, out);
  if (typeof value === 'string') {
    if (isSensitiveName(key)) {
      out.add(value);
    } else if (/^(?:https?|wss?):\/\//i.test(value)) {
      try {
        const url = new URL(value);
        for (const [queryKey, queryValue] of url.searchParams) {
          if (isSensitiveName(queryKey)) out.add(queryValue);
        }
      } catch {
        // A malformed URL is still handled by the caller-provided variants.
      }
    } else if (looksLikeDynamicSecret(value)) {
      out.add(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    if (/^headers$/i.test(key)) collectHeaderValues(value, out);
    for (const child of value) collectTraceDynamicValues(child, key, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectTraceDynamicValues(child, childKey, out);
  }
  return out;
}

function sanitizeHeaders(value: unknown, variants: readonly SecretVariant[]): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => {
        if (Array.isArray(entry)) {
          return typeof entry[0] !== 'string' || !isSensitiveName(entry[0]);
        }
        if (!entry || typeof entry !== 'object') return true;
        const name = headerEntryName(entry as Record<string, unknown>);
        return name === null || !isSensitiveName(name);
      })
      .map((entry) => {
        const sanitized = sanitizeNode(entry, variants, 'headers', '');
        return sanitized === OMIT ? null : sanitized;
      })
      .filter((entry) => entry !== null);
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveName(key)) continue;
      const sanitized = sanitizeNode(child, variants, key, 'headers');
      if (sanitized !== OMIT) output[key] = sanitized;
    }
    return output;
  }
  return sanitizeNode(value, variants, 'headers', '');
}

function sanitizeNode(
  value: unknown,
  variants: readonly SecretVariant[],
  key: string,
  parentKey: string,
): unknown | typeof OMIT {
  if (isSensitiveName(key) || isCookieName(key) || isBodyName(key, parentKey)) return OMIT;
  if (typeof value === 'string') {
    if (/^(?:url|href)$/i.test(key)) return sanitizeTraceUrl(value, variants);
    return redactText(value, variants);
  }
  if (Array.isArray(value)) {
    return value
      .map((child) => sanitizeNode(child, variants, key, parentKey))
      .filter((child) => child !== OMIT);
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^headers$/i.test(childKey)) {
      const sanitizedHeaders = sanitizeHeaders(child, variants);
      if (sanitizedHeaders !== OMIT) output[childKey] = sanitizedHeaders;
      continue;
    }
    const sanitized = sanitizeNode(child, variants, childKey, key);
    if (sanitized !== OMIT) output[childKey] = sanitized;
  }
  return output;
}

function sanitizeTraceUrl(value: string, variants: readonly SecretVariant[]): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveName(key)) url.searchParams.delete(key);
    }
    return redactText(url.toString(), variants);
  } catch {
    // Keep malformed URL provenance while still removing short known values.
    return redactText(value, variants, true);
  }
}

type TextEncoding = 'utf8' | 'utf16le' | 'utf16be';

type DecodedText = {
  text: string;
  encoding: TextEncoding;
  bom: boolean;
};

function plausibleText(value: string): boolean {
  if (value.length === 0) return true;
  let printable = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code !== 0x7f)) {
      printable += 1;
    }
  }
  return printable / value.length >= 0.8;
}

function decodeUtf16Be(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength % 2 !== 0) return undefined;
  const littleEndian = Buffer.alloc(bytes.byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    littleEndian[offset] = bytes[offset + 1]!;
    littleEndian[offset + 1] = bytes[offset]!;
  }
  return littleEndian.toString('utf16le');
}

function decodeTextRepresentation(bytes: Uint8Array): DecodedText | undefined {
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    if ((bytes.byteLength - 2) % 2 !== 0) return undefined;
    const text = Buffer.from(bytes.subarray(2)).toString('utf16le');
    return plausibleText(text) ? { text, encoding: 'utf16le', bom: true } : undefined;
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = decodeUtf16Be(bytes.subarray(2));
    return text === undefined || !plausibleText(text)
      ? undefined
      : { text, encoding: 'utf16be', bom: true };
  }

  if (bytes.byteLength >= 16 && bytes.byteLength % 2 === 0) {
    let evenZeroes = 0;
    let oddZeroes = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += 2) {
      if (bytes[offset] === 0) evenZeroes += 1;
      if (bytes[offset + 1] === 0) oddZeroes += 1;
    }
    const zeroRatio = Math.max(evenZeroes, oddZeroes) / (bytes.byteLength / 2);
    if (zeroRatio >= 0.25 && evenZeroes !== oddZeroes) {
      const encoding: TextEncoding = oddZeroes > evenZeroes ? 'utf16le' : 'utf16be';
      const text =
        encoding === 'utf16le'
          ? Buffer.from(bytes).toString('utf16le')
          : decodeUtf16Be(bytes);
      if (text !== undefined && plausibleText(text)) return { text, encoding, bom: false };
    }
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return plausibleText(text) ? { text, encoding: 'utf8', bom: false } : undefined;
  } catch {
    return undefined;
  }
}

function encodeTextRepresentation(text: string, encoding: TextEncoding, bom: boolean): Buffer {
  if (encoding === 'utf8') return Buffer.from(text, 'utf8');
  const littleEndian = Buffer.from(text, 'utf16le');
  if (encoding === 'utf16le') {
    return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]) : littleEndian;
  }
  const bigEndian = Buffer.alloc(littleEndian.length);
  for (let offset = 0; offset < littleEndian.length; offset += 2) {
    bigEndian[offset] = littleEndian[offset + 1]!;
    bigEndian[offset + 1] = littleEndian[offset]!;
  }
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]) : bigEndian;
}

function sanitizeJsonLines(bytes: Uint8Array, variants: readonly SecretVariant[]): Buffer {
  if (bytes.byteLength > MAX_TEXT_ENTRY_BYTES) privacyFailure();
  const decoded = decodeTextRepresentation(bytes);
  if (!decoded) privacyFailure();
  const text = decoded.text;
  const lines = text.split('\n');
  const output: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      output.push('');
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      privacyFailure();
    }
    const sanitized = sanitizeNode(parsed, variants, '', '');
    if (sanitized === OMIT) privacyFailure();
    output.push(JSON.stringify(sanitized));
  }
  return encodeTextRepresentation(output.join('\n'), decoded.encoding, decoded.bom);
}

function sanitizeResource(bytes: Uint8Array, variants: readonly SecretVariant[]): Buffer {
  if (isLikelyImage(bytes)) return Buffer.from(bytes);
  const decoded = decodeTextRepresentation(bytes);
  if (!decoded) {
    if (containsSecret(bytes, variants, !isLikelyImage(bytes))) privacyFailure();
    return Buffer.from(bytes);
  }
  const text = decoded.text;
  if (text.length > MAX_TEXT_ENTRY_BYTES) privacyFailure();
  try {
    const parsed = JSON.parse(text) as unknown;
    const sanitized = sanitizeNode(parsed, variants, '', '');
    if (sanitized === OMIT) privacyFailure();
    return encodeTextRepresentation(JSON.stringify(sanitized), decoded.encoding, decoded.bom);
  } catch (error) {
    if (error instanceof HmsTracePrivacyError) throw error;
    return encodeTextRepresentation(
      redactText(text, variants, true),
      decoded.encoding,
      decoded.bom,
    );
  }
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

function containsSecretText(
  text: string,
  variants: readonly SecretVariant[],
  includeShort = false,
): boolean {
  return variants.some((variant) => {
    if (
      !variant.text ||
      (!includeShort && variant.short && !variant.explicit)
    ) {
      return false;
    }
    if (text.includes(variant.text)) return true;
    const pattern = percentCaseInsensitivePattern(variant.text);
    return pattern?.test(text) ?? false;
  });
}

function parseJsonLinesForDynamicValues(
  bytes: Uint8Array,
  dynamicSecrets: Set<string>,
): void {
  const decoded = decodeTextRepresentation(bytes);
  if (!decoded || decoded.text.length > MAX_TEXT_ENTRY_BYTES) privacyFailure();
  for (const line of decoded.text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      privacyFailure();
    }
    collectTraceDynamicValues(parsed, '', dynamicSecrets);
  }
}

function collectResourceDynamicValues(bytes: Uint8Array, dynamicSecrets: Set<string>): void {
  const decoded = decodeTextRepresentation(bytes);
  if (!decoded || decoded.text.length > MAX_TEXT_ENTRY_BYTES) return;
  try {
    collectTraceDynamicValues(JSON.parse(decoded.text), '', dynamicSecrets);
  } catch {
    // Non-JSON resource text is still scanned for caller-provided variants.
  }
}

/** Synchronous archive sanitizer used only inside the private processing boundary. */
export function sanitizeTraceArchiveBytes(
  rawBytes: Uint8Array,
  secretValues: readonly string[],
): Buffer {
  const archive = unzipBoundedTraceArchive(rawBytes);
  const dynamicSecrets = new Set<string>();
  for (const [name, bytes] of Object.entries(archive)) {
    if (SUPPORTED_TRACE_STREAMS.has(name)) parseJsonLinesForDynamicValues(bytes, dynamicSecrets);
    else collectResourceDynamicValues(bytes, dynamicSecrets);
    const nameComponent = name.slice(name.lastIndexOf('/') + 1);
    if (looksLikeDynamicSecretName(nameComponent)) dynamicSecrets.add(nameComponent);
  }

  const variants = escapedSecretVariants(
    [...secretValues, ...dynamicSecrets],
    new Set(secretValues),
  );
  const review: Zippable = {};
  const outputNames = new Set<string>();
  for (const [name, bytes] of Object.entries(archive)) {
    const outputName = redactText(name, variants, true).split(REDACTION).join('redacted');
    const outputNameBytes = Buffer.from(outputName, 'utf8');
    assertSafeEntryName(outputName, outputNameBytes);
    if (outputNames.has(outputName)) privacyFailure();
    outputNames.add(outputName);
    const output = SUPPORTED_TRACE_STREAMS.has(name)
      ? sanitizeJsonLines(bytes, variants)
      : sanitizeResource(bytes, variants);
    if (
      containsSecretText(outputName, variants, true) ||
      containsSecret(output, variants, !isLikelyImage(output))
    ) {
      privacyFailure();
    }
    review[outputName] = output;
  }

  const reviewBytes = Buffer.from(
    zipSync(review, { level: 6, mtime: new Date('1980-01-01T00:00:00.000Z') }),
  );
  if (reviewBytes.byteLength > HMS_TRACE_MAX_COMPRESSED_BYTES) privacyFailure();
  const reviewedArchive = unzipBoundedTraceArchive(reviewBytes);
  for (const [name, bytes] of Object.entries(reviewedArchive)) {
    if (
      containsSecretText(name, variants, true) ||
      containsSecret(bytes, variants, !isLikelyImage(bytes))
    ) {
      privacyFailure();
    }
  }
  return reviewBytes;
}

type TracePrivacyWorkerMessage =
  | { ok: true; bytes: Uint8Array }
  | { ok: false };

function tracePrivacyWorkerUrl(): URL {
  const workerFile = import.meta.url.endsWith('.ts')
    ? './trace-privacy-worker.ts'
    : './trace-privacy-worker.js';
  return new URL(workerFile, import.meta.url);
}

function tracePrivacyWorkerExecArgv(): string[] | undefined {
  if (!import.meta.url.endsWith('.ts')) return undefined;
  return ['--import', 'tsx/esm'];
}

async function sanitizeInPrivateWorker(
  rawBytes: Uint8Array,
  secretValues: readonly string[],
  signal: AbortSignal,
): Promise<Buffer> {
  assertPrivacyActive(signal);
  const worker = new Worker(tracePrivacyWorkerUrl(), {
    workerData: { rawBytes: Buffer.from(rawBytes), secretValues: [...secretValues] },
    ...(tracePrivacyWorkerExecArgv() ? { execArgv: tracePrivacyWorkerExecArgv() } : {}),
  });
  const deadlineMs = deadlineFor(signal);
  let timer: NodeJS.Timeout | undefined;
  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, bytes?: Uint8Array): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // A result (including cancellation) does not cross the privacy boundary
      // until the worker holding the raw archive and credentials has exited.
      void (async () => {
        try {
          await worker.terminate();
          if (error) throw error;
          assertPrivacyActive(signal);
          resolve(Buffer.from(bytes!));
        } catch {
          reject(new HmsTracePrivacyError());
        } finally {
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        }
      })();
    };
    const onAbort = (): void => finish(new HmsTracePrivacyError());
    const onMessage = (message: TracePrivacyWorkerMessage): void => {
      if (!message.ok) finish(new HmsTracePrivacyError());
      else {
        try {
          assertPrivacyActive(signal);
          finish(undefined, message.bytes);
        } catch (error) {
          finish(error instanceof Error ? error : new HmsTracePrivacyError());
        }
      }
    };
    const onError = (): void => finish(new HmsTracePrivacyError());
    // Even a clean exit is a failure if no result arrived first.
    const onExit = (): void => finish(new HmsTracePrivacyError());
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (deadlineMs !== undefined) {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) onAbort();
      else timer = setTimeout(onAbort, remaining);
    }
  });
}

/**
 * Read a bounded native trace ZIP, sanitize JSONL/resource payloads in memory,
 * and atomically write the review ZIP. ZIP decoding is delegated to fflate;
 * the local central-directory audit only bounds metadata and rejects unsafe
 * names/types before fflate allocates expanded buffers.
 */
export async function sanitizePlaywrightTraceFile(
  rawPath: string,
  reviewPath: string,
  secretValues: readonly string[],
  options: HmsTracePrivacyOptions = {},
): Promise<HmsTraceSanitizationResult> {
  const signal = options.signal;
  assertPrivacyActive(signal);
  const rawBytes = await readBoundedTraceFile(rawPath, signal);
  const rawDigest = digestBytes(rawBytes);
  const reviewBytes = signal
    ? await sanitizeInPrivateWorker(rawBytes, secretValues, signal)
    : sanitizeTraceArchiveBytes(rawBytes, secretValues);
  assertPrivacyActive(signal);
  let temporaryReviewPath: string | undefined;
  try {
    temporaryReviewPath = `${reviewPath}.tmp-${randomUUID()}`;
    await writePrivateFile(temporaryReviewPath, reviewBytes);
    assertPrivacyActive(signal);
    await rename(temporaryReviewPath, reviewPath);
  } catch {
    if (temporaryReviewPath) {
      await rm(temporaryReviewPath, { force: true }).catch(() => undefined);
    }
    throw new HmsTracePrivacyError();
  }
  return {
    raw: rawDigest,
    review: digestBytes(reviewBytes),
    sanitizerVersion: HMS_TRACE_SANITIZER_VERSION,
  };
}

/** Collect only storage-state value fields for the in-memory scan set. */
export function collectHmsStorageStateSecretValues(value: unknown): string[] {
  const values = new Set<string>();
  const state = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const cookies = state.cookies;
  if (Array.isArray(cookies)) {
    for (const cookie of cookies) {
      if (!cookie || typeof cookie !== 'object') continue;
      const cookieValue = (cookie as Record<string, unknown>).value;
      if (typeof cookieValue === 'string' && cookieValue.length > 0) values.add(cookieValue);
    }
  }
  const credentialStorageName =
    /(?:token|session|auth|csrf|credential|secret|sid|jwt|refresh|access|cookie|key)/i;
  const origins = state.origins;
  if (Array.isArray(origins)) {
    for (const origin of origins) {
      if (!origin || typeof origin !== 'object') continue;
      const localStorage = (origin as Record<string, unknown>).localStorage;
      if (!Array.isArray(localStorage)) continue;
      for (const entry of localStorage) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.name !== 'string' || !credentialStorageName.test(record.name)) continue;
        if (typeof record.value === 'string' && record.value.length > 0) {
          values.add(record.value);
        }
      }
    }
  }
  return [...values];
}

/** Remove a bounded list of operation-owned files under a protected directory. */
export async function removeNewTraceFiles(
  dir: string,
  baseline: ReadonlyMap<string, number>,
): Promise<void> {
  const walk = async (current: string): Promise<void> => {
    const { readdir, lstat } = await import('node:fs/promises');
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && !baseline.has(full)) {
        await rm(full, { force: false });
      } else if (entry.isSymbolicLink() && !baseline.has(full)) {
        await lstat(full);
        await rm(full, { force: false });
      }
    }
  };
  await walk(dir);
}
