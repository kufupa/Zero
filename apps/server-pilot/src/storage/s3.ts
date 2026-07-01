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
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

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

export interface S3Storage {
  readonly kind: 'real' | 'fake';
  readonly bucket: string;
  putObject(opts: S3PutOptions): Promise<S3PutResult>;
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
  private readonly client: S3Client;

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
    const bytes = await byteLength(opts.body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: opts.key,
        Body: opts.body,
        ContentType: opts.contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
    return { key: opts.key, bucket: this.bucket, bytes };
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

/**
 * Build a raw-mime S3 key.
 *
 * Layout: `raw-mime/{ingestMailboxId}/{yyyy}/{mm}/{dd}/{uuid}.eml`
 *
 * Matches the bucket lifecycle rule `raw-mime/*` (30-day expiry).
 */
export function rawMimeKey(opts: {
  ingestMailboxId: string;
  pop3Uidl: string;
  receivedAt?: Date;
}): string {
  const d = opts.receivedAt ?? new Date();
  const yyyy = d.getUTCFullYear().toString();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const uuid = randomUUID();
  return `raw-mime/${opts.ingestMailboxId}/${yyyy}/${mm}/${dd}/${uuid}-${opts.pop3Uidl}.eml`;
}

/**
 * Build an attachment S3 key.
 *
 * Layout: `attachments/{messageId}/{index}-{filename}`
 *
 * Matches the bucket lifecycle rule `attachments/*` (90-day expiry).
 */
export function attachmentKey(opts: {
  messageId: string;
  index: number;
  filename: string;
}): string {
  const safe = opts.filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `attachments/${opts.messageId}/${String(opts.index).padStart(3, '0')}-${safe}`;
}

async function byteLength(
  body: Buffer | Uint8Array | Readable,
): Promise<number> {
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  // Stream: drain to compute length. Real S3 PUT will re-read from buffer.
  return (await toBuffer(body)).byteLength;
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
