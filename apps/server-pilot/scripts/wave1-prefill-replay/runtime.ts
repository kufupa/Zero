import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../../src/db/client.js';
import { attachment, mailboxTransport, mailThread, message } from '../../src/db/schema/mail.js';
import { FakeS3Storage, getS3Storage, setS3Storage, S3KeyExistsError, S3ObjectTooLargeError,
  type S3CopyOptions, type S3GetResult, type S3HeadResult, type S3PutOptions, type S3PutResult } from '../../src/storage/s3.js';

const indexRow = z.object({ row_id: z.string(), thread_id: z.string(), message_id: z.string().nullable(),
  timestamp: z.string(), sent_at: z.string().nullable(), direction: z.enum(['inbound', 'outbound']),
  transport_id: z.string(), subject: z.string().nullable(), addresses_json: z.string(),
  headers_json: z.string(), body: z.string().nullable() });
const addressesSchema = z.object({ from: z.array(z.string()).default([]), to: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]), bcc: z.array(z.string()).default([]) });

export type OriginalMailboxMessage = {
  id: string; thread_id: string; subject: string | null; text_body: string | null; html_body: string | null;
  from_address?: string | null;
};

export type RecoveredAttachment = {
  id: string; messageId: string; filename: string; mimeType: string; path: string; sha256: string;
  bytes?: number; isInline?: boolean; contentId?: string | null; sourceAttachmentId?: string | null;
  sourceSha256?: string | null; s3Key?: string; createdAt?: string;
};

/** Read immutable recovered originals lazily; runtime-created objects remain in FakeS3 memory. */
export class ReplayStorage extends FakeS3Storage {
  private readonly originals = new Map<string, { path: string; sizeBytes: number; sha256: string; contentType: string }>();

  register(key: string, file: { path: string; sizeBytes: number; sha256: string; contentType: string }): void {
    this.originals.set(key, file);
  }

  override async putObject(opts: S3PutOptions): Promise<S3PutResult> {
    if (opts.ifNoneMatch && this.originals.has(opts.key)) throw new S3KeyExistsError(opts.key);
    const result = await super.putObject(opts);
    this.originals.delete(opts.key);
    return result;
  }

  override async getObject(key: string): Promise<S3GetResult | null> {
    const original = this.originals.get(key);
    if (!original) return super.getObject(key);
    this.calls.push({ op: 'GET', key });
    return this.readOriginal(original);
  }

  override async getObjectBounded(key: string, maxBytes: number, signal?: AbortSignal): Promise<S3GetResult | null> {
    const original = this.originals.get(key);
    if (!original) return super.getObjectBounded(key, maxBytes, signal);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid maxBytes');
    signal?.throwIfAborted();
    this.calls.push({ op: 'GET_BOUNDED', key });
    if (original.sizeBytes > maxBytes) throw new S3ObjectTooLargeError(maxBytes, original.sizeBytes);
    return this.readOriginal(original, signal);
  }

  private async readOriginal(original: { path: string; sizeBytes: number; sha256: string; contentType: string },
    signal?: AbortSignal): Promise<S3GetResult> {
    const body = await readFile(original.path, { signal });
    if (body.byteLength !== original.sizeBytes || createHash('sha256').update(body).digest('hex') !== original.sha256)
      throw new Error('Recovered attachment bytes changed');
    return { body, contentType: original.contentType };
  }

  override async headObject(key: string): Promise<S3HeadResult | null> {
    const original = this.originals.get(key);
    if (!original) return super.headObject(key);
    this.calls.push({ op: 'HEAD', key });
    const info = await stat(original.path);
    return info.isFile() ? { sizeBytes: info.size, contentType: original.contentType, eTag: original.sha256 } : null;
  }

  override async copyObject(opts: S3CopyOptions): Promise<{ key: string; bucket: string }> {
    if (!this.originals.has(opts.sourceKey)) return super.copyObject(opts);
    const source = await this.getObject(opts.sourceKey);
    if (!source) throw new Error('Recovered copy source missing');
    await this.putObject({ key: opts.destKey, body: source.body, contentType: opts.contentType ?? source.contentType });
    return { key: opts.destKey, bucket: this.bucket };
  }

  override async deleteObject(key: string): Promise<void> {
    this.originals.delete(key);
    await super.deleteObject(key);
  }

  override listKeys(prefix: string): string[] {
    return [...new Set([...super.listKeys(prefix), ...[...this.originals.keys()].filter(key => key.startsWith(prefix))])].sort();
  }
}

/** The application has global database readers, so check the actual connected server before seeding. */
export async function assertDisposableDatabase(db: DB): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Replay DATABASE_URL is missing');
  const parsed = new URL(url);
  const database = parsed.pathname.slice(1);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' || parsed.port !== '55447' ||
      !/^nava_replay(?:_[a-z0-9_]+)?$/.test(database))
    throw new Error('Replay DATABASE_URL is not disposable');
  const rows = await db.execute(sql`select current_database() as database, current_user as db_user, host(inet_server_addr()) as address, inet_server_port() as port`);
  const row = rows[0];
  const local = row && ((Number(row.port) === 55447 && ['127.0.0.1', '::1'].includes(String(row.address))) ||
    (Number(row.port) === 5432 && /^172\.17\.\d{1,3}\.\d{1,3}$/.test(String(row.address))));
  if (!row || row.database !== database || row.db_user !== 'fresh_replay' || !local)
    throw new Error(`Replay requires an owned local replay database (actual ${JSON.stringify(row)})`);
}

export async function assertReplayIsolation(db: DB, privateDir: string): Promise<void> {
  await assertDisposableDatabase(db);
  if (process.env.TEST_DATABASE_URL || process.env.VITEST_ALLOW_PILOT_RDS) throw new Error('Replay test database environment is set');
  if (getS3Storage().kind !== 'fake') throw new Error('Replay requires isolated fake storage');
  const shots = process.env.HMS_SHOTS_DIR;
  if (!shots || !isAbsolute(shots) || !isAbsolute(privateDir)) throw new Error('Replay screenshot directory is not isolated');
  const root = await realpath(privateDir), actual = await realpath(shots);
  const child = relative(root, actual);
  if (!child || child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('Replay screenshot directory is outside its private run');
}

export function createReplayStorage(): ReplayStorage {
  const storage = new ReplayStorage('wave1-prefill-replay');
  setS3Storage(storage);
  return storage;
}

/** Seed every recovered source attachment so normal mailbox readers retain their visibility. */
export async function seedAllRecoveredAttachments(input: { db: DB; storage: ReplayStorage;
  recovered: readonly RecoveredAttachment[] }): Promise<{ registered: number; unavailable: string[] }> {
  await assertDisposableDatabase(input.db);
  const prior = await input.db.select().from(attachment);
  const recoveredIds = new Set(input.recovered.map(file => file.id));
  const previousById = new Map(prior.map(row => [row.id, row]));
  const previousLegacy = new Map(prior.filter(row => row.sha256 && !recoveredIds.has(row.id))
    .map(row => [`${row.messageId}\u001f${row.sha256}`, row]));
  const usedLegacy = new Set<string>();
  const unavailable: string[] = [];
  let registered = 0;
  for (let i = 0; i < input.recovered.length; i += 200) {
    const batch = await Promise.all(input.recovered.slice(i, i + 200).map(async file => {
      try {
        if (!/^[a-f0-9]{64}$/.test(file.sha256) || !isAbsolute(file.path)) throw new Error('Invalid artifact metadata');
        const info = await stat(file.path);
        if (!info.isFile() || (file.bytes !== undefined && file.bytes !== info.size)) throw new Error('Artifact size changed');
        const byId = previousById.get(file.id);
        const storedHash = file.sourceSha256 === undefined ? file.sha256 : file.sourceSha256;
        if (storedHash !== null && storedHash !== file.sha256) throw new Error('Source attachment hash mismatch');
        if (byId && (byId.messageId !== file.messageId || byId.sha256 !== storedHash)) throw new Error('Attachment identity changed');
        const legacy = previousLegacy.get(`${file.messageId}\u001f${file.sha256}`);
        const existing = byId ?? (legacy && !usedLegacy.has(legacy.id) ? legacy : undefined);
        if (existing && !byId) usedLegacy.add(existing.id);
        const key = existing?.s3Key ?? file.s3Key ?? `attachments/${file.messageId}/${file.id}`;
        input.storage.register(key, { path: file.path, sizeBytes: info.size, sha256: file.sha256, contentType: file.mimeType });
        registered += 1;
        return existing ? null : { id: file.id, messageId: file.messageId, filename: file.filename,
          mimeType: file.mimeType, sizeBytes: info.size, sha256: storedHash, s3Key: key,
          isInline: file.isInline ?? false, contentId: file.contentId ?? null, sourceAttachmentId: file.sourceAttachmentId ?? null,
          ...(file.createdAt ? { createdAt: new Date(file.createdAt) } : {}) };
      } catch { unavailable.push(file.id); return null; }
    }));
    const inserts = batch.filter((row): row is NonNullable<typeof row> => row !== null);
    if (inserts.length) await input.db.insert(attachment).values(inserts).onConflictDoNothing();
  }
  return { registered, unavailable };
}

/** This catalog contains saved hotel outbound originals; it does not establish inbound coverage. */
export async function readConfirmationCatalog(path: string): Promise<RecoveredAttachment[]> {
  const catalogItem = z.object({ attachment: z.object({ attachmentId: z.string(), filename: z.string(), mimeType: z.string() }),
    parentMessage: z.object({ messageDbId: z.string() }),
    file: z.object({ status: z.string(), path: z.string().optional(), sha256: z.string().optional() }) });
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  return lines.flatMap(line => {
    const entry = catalogItem.parse(JSON.parse(line));
    if (entry.file.status !== 'available' || !entry.file.path || !entry.file.sha256) return [];
    return [{ id: entry.attachment.attachmentId, messageId: entry.parentMessage.messageDbId,
      filename: entry.attachment.filename, mimeType: entry.attachment.mimeType,
      path: resolve(dirname(path), entry.file.path), sha256: entry.file.sha256 }];
  });
}

/** Reconstruct the entire saved mailbox, leaving unknown visibility/arrival metadata explicit. */
export async function seedMailbox(db: DB, indexPath: string, mailboxAddress: string,
  originals: ReadonlyMap<string, OriginalMailboxMessage>): Promise<{ messages: number; threads: number }> {
  await assertDisposableDatabase(db);
  const index = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const source = index.prepare('select row_id,thread_id,message_id,timestamp,sent_at,direction,transport_id,subject,addresses_json,headers_json,body from messages').all();
    const rows = source.map((value) => indexRow.parse(value));
    if (rows.some((row) => row.transport_id !== 'transport-centurion')) throw new Error('Unexpected source transport');
    if (rows.length !== originals.size || rows.some(row => originals.get(row.row_id)?.thread_id !== row.thread_id))
      throw new Error('Original mailbox and source index do not match');
    await db.insert(mailboxTransport).values({ id: 'transport-centurion', email: mailboxAddress,
      ownerHeaderValue: mailboxAddress }).onConflictDoNothing();
    const threads = [...new Set(rows.map((row) => row.thread_id))].map((id) => ({ id,
      transportId: 'transport-centurion', threadRootId: id }));
    for (let i = 0; i < threads.length; i += 200) await db.insert(mailThread).values(threads.slice(i, i + 200)).onConflictDoNothing();
    for (let i = 0; i < rows.length; i += 200) {
      const values = rows.slice(i, i + 200).map((row) => {
        const addresses = addressesSchema.parse(JSON.parse(row.addresses_json));
        const original = originals.get(row.row_id)!;
        const receivedAt = new Date(row.timestamp);
        const sentAt = row.sent_at ? new Date(row.sent_at) : null;
        if (!Number.isFinite(receivedAt.getTime()) || (sentAt && !Number.isFinite(sentAt.getTime())))
          throw new Error(`Invalid source timestamp for ${row.row_id}`);
        return { id: row.row_id, transportId: row.transport_id, threadId: row.thread_id,
          messageIdHeader: row.message_id, direction: row.direction, fromAddress: original.from_address ?? '',
          toAddresses: addresses.to, ccAddresses: addresses.cc, bccAddresses: addresses.bcc,
          subject: original.subject, textBody: original.text_body, htmlBody: original.html_body, receivedAt, sentAt, createdAt: receivedAt,
          sourceProvenance: { replay: { arrival: 'reconstructed_from_saved_timestamp', visibility: 'unknown' } } };
      });
      await db.insert(message).values(values).onConflictDoNothing();
    }
    return { messages: rows.length, threads: threads.length };
  } finally { index.close(); }
}

/** Only attributable, byte-verified originals may be placed in the fake mailbox store. */
export async function seedThreadAttachments(input: { db: DB; storage: FakeS3Storage; threadId: string;
  cutoff: Date; recovered: readonly RecoveredAttachment[] }): Promise<{ loaded: string[]; unavailable: string[] }> {
  await assertDisposableDatabase(input.db);
  const rows = await input.db.select({ id: message.id, receivedAt: message.receivedAt }).from(message)
    .where(and(eq(message.transportId, 'transport-centurion'), eq(message.threadId, input.threadId)));
  const ids = new Set(rows.filter((row) => row.receivedAt && row.receivedAt <= input.cutoff).map((row) => row.id));
  const loaded: string[] = [], unavailable: string[] = [];
  for (const file of input.recovered.filter((entry) => ids.has(entry.messageId))) {
    let bytes: Buffer;
    try { bytes = await readFile(file.path); } catch { unavailable.push(file.id); continue; }
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) { unavailable.push(file.id); continue; }
    const s3Key = `attachments/${file.messageId}/${file.id}`;
    await input.storage.putObject({ key: s3Key, body: bytes, contentType: file.mimeType });
    await input.db.insert(attachment).values({ id: file.id, messageId: file.messageId, filename: file.filename,
      mimeType: file.mimeType, sizeBytes: bytes.byteLength, sha256: file.sha256, s3Key,
      isInline: file.isInline ?? false, contentId: file.contentId ?? null,
      sourceAttachmentId: file.sourceAttachmentId ?? null }).onConflictDoNothing();
    loaded.push(file.id);
  }
  return { loaded, unavailable };
}
