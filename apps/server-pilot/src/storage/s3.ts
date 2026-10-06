/**
 * S3 storage wrapper for raw MIME + attachments.
 *
 * One interface (`S3Storage`) implemented by two adapters:
 * - `RealS3Storage` — uses `@aws-sdk/client-s3` against the configured bucket.
 *   Constructed from env when `S3_BUCKET`/`AWS_REGION` are present.
 * - `FakeS3Storage` — in-memory map of `key -> { body, contentType }`.
 *   Used by tests and by the worker when no real S3 is configured.
 *
 * The rest of the ingest pipeline (parse-message, store, worker) only ever
 * sees the `S3Storage` interface, so production and fixture paths share code.
 */
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

export interface S3PutOptions {
  key: string;
  body: Buffer | Uint8Array | Readable;
  contentType: string;
}

export interface S3PutResult {
  key: string;
  bucket: string;
  bytes: number;
}

export interface S3CopyOptions {
  sourceKey: string;
  destKey: string;
  contentType?: string;
}

export interface S3GetResult {
  body: Buffer;
  contentType: string;
}

export interface S3HeadResult {
  sizeBytes: number;
  contentType?: string;
  eTag?: string;
}

/** Thrown when a bounded read would exceed maxBytes; callers must not keep the body. */
export class S3ObjectTooLargeError extends Error {
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(maxBytes: number, observedBytes: number) {
    super(
      `S3 object exceeds maxBytes=${maxBytes} (observed>=${observedBytes})`,
    );
    this.name = 'S3ObjectTooLargeError';
    this.maxBytes = maxBytes;
    this.observedBytes = observedBytes;
  }
}

export interface S3Storage {
  readonly kind: 'real' | 'fake';
  readonly bucket: string;
  putObject(opts: S3PutOptions): Promise<S3PutResult>;
  getObject(key: string): Promise<S3GetResult | null>;
  /** Read object only if body length ≤ maxBytes; abort/fail closed otherwise. */
  getObjectBounded(
    key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<S3GetResult | null>;
  headObject(key: string): Promise<S3HeadResult | null>;
  copyObject(opts: S3CopyOptions): Promise<{ key: string; bucket: string }>;
  deleteObject(key: string): Promise<void>;
}

/**
 * Real S3 backed by `@aws-sdk/client-s3`.
 *
 * Constructed from env (region + bucket). Uses the default AWS credential
 * chain (EC2 instance profile in production).
 */
export class RealS3Storage implements S3Storage {
  readonly kind = 'real' as const;
  readonly bucket: string;
  readonly client: S3Client;

  constructor(region: string, bucket: string) {
    this.bucket = bucket;
    this.client = new S3Client({ region });
  }

  static fromEnv(env: {
    AWS_REGION: string;
    S3_BUCKET: string;
  }): RealS3Storage {
    return new RealS3Storage(env.AWS_REGION, env.S3_BUCKET);
  }

  async putObject(opts: S3PutOptions): Promise<S3PutResult> {
    const body = await toBuffer(opts.body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: opts.key,
        Body: body,
        ContentType: opts.contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
    return { key: opts.key, bucket: this.bucket, bytes: body.byteLength };
  }

  async getObject(key: string): Promise<S3GetResult | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return null;
      const body = await toBuffer(response.Body as Readable);
      return {
        body,
        contentType: response.ContentType ?? 'application/octet-stream',
      };
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: string }).name)
          : '';
      if (
        code === 'NoSuchKey' ||
        code === 'NotFound' ||
        (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  async getObjectBounded(
    key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<S3GetResult | null> {
    assertBoundedMaxBytes(maxBytes);
    throwIfAborted(signal);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        signal ? { abortSignal: signal } : undefined,
      );
      if (!response.Body) return null;
      const contentLength = response.ContentLength;
      if (
        typeof contentLength === 'number' &&
        contentLength > maxBytes
      ) {
        const body = response.Body as Readable;
        body.destroy();
        throw new S3ObjectTooLargeError(maxBytes, contentLength);
      }
      const body = await streamToBufferBounded(
        response.Body as Readable,
        maxBytes,
        signal,
      );
      return {
        body,
        contentType: response.ContentType ?? 'application/octet-stream',
      };
    } catch (err: unknown) {
      if (err instanceof S3ObjectTooLargeError) throw err;
      const code =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: string }).name)
          : '';
      if (code === 'NoSuchKey' || code === 'NotFound') return null;
      throw err;
    }
  }

  async copyObject(opts: S3CopyOptions): Promise<{ key: string; bucket: string }> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${opts.sourceKey}`,
        Key: opts.destKey,
        ContentType: opts.contentType ?? 'message/rfc822',
        ServerSideEncryption: 'AES256',
      }),
    );
    return { key: opts.destKey, bucket: this.bucket };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async headObject(key: string): Promise<S3HeadResult | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType,
        eTag: response.ETag,
      };
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: string }).name)
          : '';
      if (
        code === 'NoSuchKey' ||
        code === 'NotFound' ||
        (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  /** Best-effort reachability probe; throws if the bucket is not accessible. */
  async probe(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

/**
 * In-memory S3 fake. Records every PUT in a map keyed by `key`.
 *
 * Used by tests (so assertions can inspect stored bytes) and by the worker
 * when no real S3 bucket is configured (fixture/fake path).
 */
export class FakeS3Storage implements S3Storage {
  readonly kind = 'fake' as const;
  readonly bucket: string;
  readonly stored = new Map<string, { body: Buffer; contentType: string }>();
  readonly calls: { op: string; key: string }[] = [];

  constructor(bucket = 'fake-mail-bucket') {
    this.bucket = bucket;
  }

  async putObject(opts: S3PutOptions): Promise<S3PutResult> {
    const body = await toBuffer(opts.body);
    this.calls.push({ op: 'PUT', key: opts.key });
    this.stored.set(opts.key, { body, contentType: opts.contentType });
    return { key: opts.key, bucket: this.bucket, bytes: body.byteLength };
  }

  async getObject(key: string): Promise<S3GetResult | null> {
    this.calls.push({ op: 'GET', key });
    const entry = this.stored.get(key);
    if (!entry) return null;
    return { body: entry.body, contentType: entry.contentType };
  }

  async getObjectBounded(
    key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<S3GetResult | null> {
    assertBoundedMaxBytes(maxBytes);
    throwIfAborted(signal);
    this.calls.push({ op: 'GET_BOUNDED', key });
    const entry = this.stored.get(key);
    if (!entry) return null;
    if (entry.body.byteLength > maxBytes) {
      throw new S3ObjectTooLargeError(maxBytes, entry.body.byteLength);
    }
    return { body: entry.body, contentType: entry.contentType };
  }

  async copyObject(opts: S3CopyOptions): Promise<{ key: string; bucket: string }> {
    const src = this.stored.get(opts.sourceKey);
    if (!src) {
      throw new Error(`fake s3: missing source key ${opts.sourceKey}`);
    }
    this.calls.push({ op: 'COPY', key: opts.destKey });
    this.stored.set(opts.destKey, {
      body: Buffer.from(src.body),
      contentType: opts.contentType ?? src.contentType,
    });
    return { key: opts.destKey, bucket: this.bucket };
  }

  async deleteObject(key: string): Promise<void> {
    this.calls.push({ op: 'DELETE', key });
    this.stored.delete(key);
  }

  async headObject(key: string): Promise<S3HeadResult | null> {
    this.calls.push({ op: 'HEAD', key });
    const entry = this.stored.get(key);
    if (!entry) return null;
    return {
      sizeBytes: entry.body.byteLength,
      contentType: entry.contentType,
      eTag: '"fake-etag"',
    };
  }

  /** Test helper: get stored bytes for a key. */
  get(key: string): Buffer | undefined {
    const entry = this.stored.get(key);
    return entry ? entry.body : undefined;
  }

  /** Test helper: list keys (sorted) under a prefix. */
  listKeys(prefix: string): string[] {
    return [...this.stored.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

function sanitizeUidl(uidl: string): string {
  return uidl.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * Build a deterministic raw-mime S3 key.
 *
 * Layout: `raw-mime/{ingestMailboxId}/{sanitizedUidl}.eml`
 *
 * Retries overwrite the same object. Matches lifecycle rule `raw-mime/*`.
 */
export function rawMimeKey(opts: {
  ingestMailboxId: string;
  pop3Uidl: string;
}): string {
  return `raw-mime/${opts.ingestMailboxId}/${sanitizeUidl(opts.pop3Uidl)}.eml`;
}

/**
 * Non-expiring quarantine archive prefix (no lifecycle rule on this path).
 */
export function quarantineArchiveKey(opts: {
  ingestMailboxId: string;
  pop3Uidl: string;
}): string {
  return `quarantine-archive/${opts.ingestMailboxId}/${sanitizeUidl(opts.pop3Uidl)}.eml`;
}

/**
 * Copy raw MIME from the ingest prefix to the quarantine archive prefix.
 */
export async function archiveQuarantineRawMime(
  storage: S3Storage,
  sourceKey: string,
  opts: { ingestMailboxId: string; pop3Uidl: string },
): Promise<string> {
  const destKey = quarantineArchiveKey(opts);
  await storage.copyObject({
    sourceKey,
    destKey,
    contentType: 'message/rfc822',
  });
  return destKey;
}

/**
 * Build an attachment S3 key.
 *
 * Layout: `attachments/{messageId}/{index}-{filename}`
 *
 * Matches the retained `attachments/*` prefix (Intelligent-Tiering after 30 days; no expiry).
 */
export function attachmentKey(opts: {
  messageId: string;
  index: number;
  filename: string;
}): string {
  const safe = opts.filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `attachments/${opts.messageId}/${String(opts.index).padStart(3, '0')}-${safe}`;
}

async function toBuffer(body: Buffer | Uint8Array | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return streamToBuffer(body);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function streamToBufferBounded(
  stream: Readable,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  assertBoundedMaxBytes(maxBytes);
  throwIfAborted(signal);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      throwIfAborted(signal);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw new S3ObjectTooLargeError(maxBytes, total);
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (!(err instanceof S3ObjectTooLargeError)) {
      try {
        stream.destroy();
      } catch {
        // ignore destroy errors while propagating original
      }
    }
    throw err;
  }
  return Buffer.concat(chunks);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function assertBoundedMaxBytes(maxBytes: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes < 0 || !Number.isInteger(maxBytes)) {
    throw new TypeError(
      `getObjectBounded maxBytes must be a non-negative finite integer (got ${String(maxBytes)})`,
    );
  }
}

/**
 * Module-level singleton chosen by env. Tests and worker can override via
 * `setS3Storage` to inject a fake.
 */
let current: S3Storage | null = null;

export function getS3Storage(): S3Storage {
  if (current) return current;
  // Lazy default: real S3 if env has bucket + region, else fake.
  const bucket = process.env.S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (bucket && region) {
    current = RealS3Storage.fromEnv({ AWS_REGION: region, S3_BUCKET: bucket });
  } else {
    current = new FakeS3Storage(bucket ?? 'fake-mail-bucket');
  }
  return current;
}

export function setS3Storage(storage: S3Storage): void {
  current = storage;
}

export function resetS3Storage(): void {
  current = null;
}
