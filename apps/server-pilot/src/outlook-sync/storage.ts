/** Private direct uploads and bounded, immutable sealing. Never use a presigned staging key for ingestion. */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import type { HeadObjectCommandOutput, CompletedPart } from '@aws-sdk/client-s3';
import { sha256Stream, fixedSizeStreamParts } from '../storage/s3.js';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

export const SYNC_PART_BYTES = 16 * 1024 * 1024;
export const SYNC_SINGLE_PUT_LIMIT = 100 * 1024 * 1024;
const MAX_PARTS = 10_000;
export type SyncUploadBinding = {
  sourceId: string;
  observationId: string;
  artifactId: string;
  expectedBytes: number;
  sha256: string;
  contentType: string;
  authorityExpiresAt: Date;
};
export type SyncUploadSession = Omit<SyncUploadBinding, 'authorityExpiresAt'> & {
  version: 1;
  attemptId: string;
  stagingKey: string;
  mode: 'single' | 'multipart';
  partSize: number;
  partCount: number;
  uploadId?: string;
};
export type SyncCompletedPart = { partNumber: number; eTag: string; sha256?: string };
export type SyncSealedArtifact = {
  key: string;
  bytes: number;
  sha256: string;
  eTag: string;
  versionId?: string;
};
type SyncSigner = (
  client: S3Client,
  command: PutObjectCommand | UploadPartCommand,
  options: {
    expiresIn: number;
    signingDate: Date;
    signableHeaders: Set<string>;
    unhoistableHeaders: Set<string>;
  },
) => Promise<string>;
export type SyncStorageOptions = {
  bucket?: string;
  region?: string;
  client?: S3Client;
  signer?: SyncSigner;
};
const scopeHash = (session: Pick<SyncUploadBinding, 'sourceId' | 'observationId' | 'artifactId'>) =>
  createHash('sha256')
    .update(JSON.stringify([session.sourceId, session.observationId, session.artifactId]))
    .digest('hex');
const sealedKey = (session: SyncUploadSession) =>
  `outlook-sync-originals/v1/${scopeHash(session)}/${session.sha256}`;
const base64 = (sha: string) => Buffer.from(sha, 'hex').toString('base64');
const code = (err: unknown) => (err as { name?: string })?.name;
const absent = (err: unknown) =>
  ['NoSuchKey', 'NotFound'].includes(code(err) ?? '') ||
  (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
const conditionalConflict = (err: unknown) =>
  ['PreconditionFailed', 'ConditionalRequestConflict'].includes(code(err) ?? '');

export class OutlookSyncStorage {
  readonly bucket: string;
  readonly client: S3Client;
  private readonly signer: SyncSigner;
  constructor(options: SyncStorageOptions = {}) {
    this.bucket = options.bucket ?? process.env.S3_BUCKET ?? '';
    const region = options.region ?? process.env.AWS_REGION ?? '';
    if (!this.bucket || !region)
      throw new Error('Private sync S3 bucket and region must be configured');
    this.client = options.client ?? new S3Client({ region });
    this.signer =
      options.signer ??
      ((client, command, opts) =>
        command instanceof PutObjectCommand
          ? getSignedUrl(client, command, opts)
          : getSignedUrl(client, command, opts));
  }
  /** Ownership is hashed: user-controlled identifiers never become object paths or metadata. */
  metadataFor(session: SyncUploadSession): Record<string, string> {
    return {
      'sync-scope': scopeHash(session),
      'sync-sha256': session.sha256,
      'sync-bytes': String(session.expectedBytes),
    };
  }
  private assertBinding(binding: Omit<SyncUploadBinding, 'authorityExpiresAt'>) {
    if (
      !Number.isSafeInteger(binding.expectedBytes) ||
      binding.expectedBytes < 0 ||
      binding.expectedBytes > SYNC_PART_BYTES * MAX_PARTS
    )
      throw new Error('Invalid artifact size');
    if (!/^[0-9a-f]{64}$/.test(binding.sha256)) throw new Error('Invalid artifact checksum');
    if (
      ![binding.sourceId, binding.observationId, binding.artifactId].every(
        (id) => typeof id === 'string' && id.length > 0 && id.length <= 512,
      )
    )
      throw new Error('Invalid artifact scope');
    if (
      typeof binding.contentType !== 'string' ||
      binding.contentType.length < 1 ||
      binding.contentType.length > 256 ||
      /[\r\n]/.test(binding.contentType)
    )
      throw new Error('Invalid content type');
  }
  private assertSession(session: SyncUploadSession) {
    this.assertBinding(session);
    const mode = session.expectedBytes < SYNC_SINGLE_PUT_LIMIT ? 'single' : 'multipart';
    if (
      session.version !== 1 ||
      !/^[0-9a-f-]{36}$/.test(session.attemptId) ||
      session.stagingKey !== `outlook-sync-staging/v1/${scopeHash(session)}/${session.attemptId}` ||
      session.mode !== mode ||
      session.partSize !== SYNC_PART_BYTES ||
      session.partCount !==
        (mode === 'single' ? 1 : Math.ceil(session.expectedBytes / SYNC_PART_BYTES)) ||
      (mode === 'multipart' && !session.uploadId)
    )
      throw new Error('Invalid upload scope');
  }
  private expiry(authorityExpiresAt: Date, at = Date.now()) {
    const seconds = Math.min(300, Math.floor((authorityExpiresAt.getTime() - at) / 1000));
    if (!Number.isFinite(seconds) || seconds < 1) throw new Error('Expired staff authority');
    return seconds;
  }
  private send(
    command:
      | PutObjectCommand
      | GetObjectCommand
      | HeadObjectCommand
      | CreateMultipartUploadCommand
      | UploadPartCommand
      | CompleteMultipartUploadCommand
      | AbortMultipartUploadCommand
      | ListPartsCommand,
  ): Promise<any> {
    return this.client.send(command as any, { abortSignal: AbortSignal.timeout(120_000) });
  }
  async beginUpload(
    binding: SyncUploadBinding,
    prior?: SyncUploadSession,
  ): Promise<SyncUploadSession> {
    this.assertBinding(binding);
    this.expiry(binding.authorityExpiresAt);
    if (prior) {
      this.assertSession(prior);
      if (
        scopeHash(prior) !== scopeHash(binding) ||
        prior.sha256 !== binding.sha256 ||
        prior.expectedBytes !== binding.expectedBytes ||
        prior.contentType !== binding.contentType
      )
        throw new Error('Upload scope changed');
      if (prior.mode === 'multipart') {
        try {
          await this.send(
            new ListPartsCommand({
              Bucket: this.bucket,
              Key: prior.stagingKey,
              UploadId: prior.uploadId,
              MaxParts: 1,
            }),
          );
        } catch (err) {
          if (code(err) !== 'NoSuchUpload') throw err;
          if (!(await this.head(prior.stagingKey))) return this.beginUpload(binding);
        }
      }
      return prior;
    }
    const { authorityExpiresAt: _authority, ...identity } = binding;
    const mode = binding.expectedBytes < SYNC_SINGLE_PUT_LIMIT ? 'single' : 'multipart';
    const attemptId = randomUUID();
    const session: SyncUploadSession = {
      ...identity,
      version: 1,
      attemptId,
      stagingKey: `outlook-sync-staging/v1/${scopeHash(binding)}/${attemptId}`,
      mode,
      partSize: SYNC_PART_BYTES,
      partCount: mode === 'single' ? 1 : Math.ceil(binding.expectedBytes / SYNC_PART_BYTES),
    };
    if (mode === 'multipart') {
      const response = await this.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: session.stagingKey,
          ContentType: session.contentType,
          ServerSideEncryption: 'AES256',
          Metadata: this.metadataFor(session),
          ChecksumAlgorithm: 'SHA256',
        }),
      );
      if (!response.UploadId) throw new Error('Missing multipart identity');
      session.uploadId = response.UploadId;
    }
    return session;
  }
  async grantPart(
    session: SyncUploadSession,
    partNumber: number,
    partSha256: string,
    authorityExpiresAt: Date,
  ) {
    this.assertSession(session);
    const signingDate = new Date();
    const expiresIn = this.expiry(authorityExpiresAt, signingDate.getTime());
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount)
      throw new Error('Invalid part number');
    if (
      !/^[0-9a-f]{64}$/.test(partSha256) ||
      (session.mode === 'single' && partSha256 !== session.sha256)
    )
      throw new Error('Invalid part checksum');
    const length =
      session.mode === 'single'
        ? session.expectedBytes
        : Math.min(SYNC_PART_BYTES, session.expectedBytes - (partNumber - 1) * SYNC_PART_BYTES);
    const headers: Record<string, string> = {
      'content-length': String(length),
      'x-amz-checksum-sha256': base64(partSha256),
    };
    const common = {
      Bucket: this.bucket,
      Key: session.stagingKey,
      ContentLength: length,
      ChecksumSHA256: base64(partSha256),
    };
    let command: PutObjectCommand | UploadPartCommand;
    if (session.mode === 'single') {
      headers['content-type'] = session.contentType;
      headers['x-amz-server-side-encryption'] = 'AES256';
      for (const [key, value] of Object.entries(this.metadataFor(session)))
        headers[`x-amz-meta-${key}`] = value;
      command = new PutObjectCommand({
        ...common,
        ContentType: session.contentType,
        ServerSideEncryption: 'AES256',
        Metadata: this.metadataFor(session),
      });
    } else
      command = new UploadPartCommand({
        ...common,
        UploadId: session.uploadId,
        PartNumber: partNumber,
      });
    const expiresAt = new Date(signingDate.getTime() + expiresIn * 1000).toISOString();
    const url = await this.signer(this.client, command, {
      expiresIn,
      signingDate,
      signableHeaders: new Set(Object.keys(headers)),
      unhoistableHeaders: new Set(Object.keys(headers).filter((name) => name.startsWith('x-amz-'))),
    });
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new Error('Unsafe storage URL');
    return { url, headers, expiresAt, partNumber };
  }
  private async head(key: string): Promise<HeadObjectCommandOutput | null> {
    try {
      return await this.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (absent(err)) return null;
      throw err;
    }
  }
  private verifyHead(head: HeadObjectCommandOutput, session: SyncUploadSession) {
    const metadata = this.metadataFor(session);
    if (Object.entries(metadata).some(([key, value]) => head.Metadata?.[key] !== value))
      throw new Error('Artifact ownership mismatch');
    if (head.ContentLength !== session.expectedBytes || !head.ETag)
      throw new Error('Artifact size/identity mismatch');
  }
  private async read(key: string, head: HeadObjectCommandOutput) {
    const result = await this.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        IfMatch: head.ETag,
        ...(head.VersionId ? { VersionId: head.VersionId } : {}),
      }),
    );
    if (!result.Body) throw new Error('Artifact bytes unavailable');
    const body = result.Body as Readable;
    // Bound stalls while keeping upstream paused until the consumer asks for another chunk.
    return Readable.from(
      (async function* () {
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const iterator = body[Symbol.asyncIterator]();
        try {
          for (;;) {
            watchdog = setTimeout(
              () =>
                body.destroy(
                  Object.assign(new Error('Storage stream timeout'), { name: 'TimeoutError' }),
                ),
              120_000,
            );
            watchdog.unref();
            let next: IteratorResult<Buffer>;
            try {
              next = await iterator.next();
            } finally {
              clearTimeout(watchdog);
            }
            if (next.done) break;
            yield next.value;
          }
        } finally {
          clearTimeout(watchdog);
          body.destroy();
        }
      })(),
    );
  }
  private async receipt(
    key: string,
    session: SyncUploadSession,
  ): Promise<SyncSealedArtifact | null> {
    const head = await this.head(key);
    if (!head) return null;
    this.verifyHead(head, session);
    const actual = await sha256Stream(await this.read(key, head), session.expectedBytes);
    if (actual.sha256 !== session.sha256 || actual.bytes !== session.expectedBytes)
      throw new Error('Sealed artifact checksum mismatch');
    return {
      key,
      bytes: actual.bytes,
      sha256: actual.sha256,
      eTag: head.ETag!,
      ...(head.VersionId ? { versionId: head.VersionId } : {}),
    };
  }
  /** Small display/ingestion projections only. Large originals remain streamed/private. */
  async readSealedBounded(receipt: SyncSealedArtifact, maxBytes: number): Promise<Buffer> {
    if (
      !/^outlook-sync-originals\/v1\/[0-9a-f]{64}\/[0-9a-f]{64}$/.test(receipt.key) ||
      !receipt.key.endsWith(`/${receipt.sha256}`)
    )
      throw new Error('Invalid sealed key');
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < 0 ||
      receipt.bytes > maxBytes
    )
      throw new Error('Projection size exceeded');
    const head = await this.head(receipt.key);
    if (
      !head ||
      head.ContentLength !== receipt.bytes ||
      head.ETag !== receipt.eTag ||
      (receipt.versionId && head.VersionId !== receipt.versionId)
    )
      throw new Error('Sealed receipt identity mismatch');
    const body = await this.read(receipt.key, head);
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) throw new Error('Projection size exceeded');
        hash.update(buffer);
        chunks.push(buffer);
      }
      if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.sha256)
        throw new Error('Sealed checksum mismatch');
      return Buffer.concat(chunks, bytes);
    } finally {
      body.destroy();
    }
  }
  async verifyReceipt(
    session: SyncUploadSession,
    supplied: SyncSealedArtifact,
  ): Promise<SyncSealedArtifact> {
    this.assertSession(session);
    if (supplied.key !== sealedKey(session)) throw new Error('Invalid sealed scope');
    const current = await this.receipt(supplied.key, session);
    if (
      !current ||
      current.eTag !== supplied.eTag ||
      current.bytes !== supplied.bytes ||
      current.sha256 !== supplied.sha256 ||
      current.versionId !== supplied.versionId
    )
      throw new Error('Sealed receipt identity mismatch');
    return current;
  }
  async seal(
    session: SyncUploadSession,
    completedParts?: SyncCompletedPart[],
  ): Promise<SyncSealedArtifact> {
    this.assertSession(session);
    const key = sealedKey(session);
    const existing = await this.receipt(key, session);
    if (existing) return existing;
    if (session.mode === 'multipart') {
      if (
        !completedParts ||
        completedParts.length !== session.partCount ||
        completedParts.some(
          (part, i) =>
            part.partNumber !== i + 1 ||
            !part.eTag ||
            part.eTag.length > 256 ||
            /[\r\n]/.test(part.eTag) ||
            (part.sha256 && !/^[0-9a-f]{64}$/.test(part.sha256)),
        )
      )
        throw new Error('Invalid completed parts');
      // Verify current S3 receipts; a client cannot omit checksum or select replaced parts.
      const listed: CompletedPart[] = [];
      let marker: string | undefined;
      try {
        do {
          const page = await this.send(
            new ListPartsCommand({
              Bucket: this.bucket,
              Key: session.stagingKey,
              UploadId: session.uploadId,
              PartNumberMarker: marker,
              MaxParts: 1000,
            }),
          );
          for (const part of page.Parts ?? []) {
            const expected = completedParts[listed.length];
            const size = Math.min(
              SYNC_PART_BYTES,
              session.expectedBytes - listed.length * SYNC_PART_BYTES,
            );
            if (
              !expected ||
              part.PartNumber !== expected.partNumber ||
              part.ETag !== expected.eTag ||
              part.Size !== size ||
              !part.ChecksumSHA256 ||
              (expected.sha256 && part.ChecksumSHA256 !== base64(expected.sha256))
            )
              throw new Error('Multipart part receipt mismatch');
            listed.push({
              PartNumber: part.PartNumber,
              ETag: part.ETag,
              ChecksumSHA256: part.ChecksumSHA256,
            });
          }
          if (!page.IsTruncated) break;
          if (
            !/^[0-9]+$/.test(String(page.NextPartNumberMarker)) ||
            Number(page.NextPartNumberMarker) <= Number(marker ?? 0) ||
            listed.length >= session.partCount
          )
            throw new Error('Invalid multipart parts continuation');
          marker = String(page.NextPartNumberMarker);
        } while (marker !== undefined);
        if (listed.length !== session.partCount) throw new Error('Missing multipart parts');
        await this.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: session.stagingKey,
            UploadId: session.uploadId,
            IfNoneMatch: '*',
            MpuObjectSize: session.expectedBytes,
            MultipartUpload: { Parts: listed },
          }),
        );
      } catch (err) {
        if (code(err) !== 'NoSuchUpload' && !conditionalConflict(err)) throw err;
      }
    }
    const stagedHead = await this.head(session.stagingKey);
    if (!stagedHead) throw new Error('Staged artifact unavailable');
    this.verifyHead(stagedHead, session);
    const body = await this.read(session.stagingKey, stagedHead);
    let sealedUploadId: string | undefined;
    try {
      if (session.expectedBytes === 0) {
        const actual = await sha256Stream(body, 0);
        if (actual.sha256 !== session.sha256) throw new Error('Artifact checksum mismatch');
        await this.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: Buffer.alloc(0),
            ContentLength: 0,
            IfNoneMatch: '*',
            ChecksumSHA256: base64(session.sha256),
            ContentType: session.contentType,
            ServerSideEncryption: 'AES256',
            Metadata: this.metadataFor(session),
          }),
        );
      } else {
        const created = await this.send(
          new CreateMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: session.contentType,
            ServerSideEncryption: 'AES256',
            Metadata: this.metadataFor(session),
            ChecksumAlgorithm: 'SHA256',
          }),
        );
        if (!created.UploadId) throw new Error('Missing seal multipart identity');
        sealedUploadId = created.UploadId;
        const hash = createHash('sha256');
        let bytes = 0;
        const parts: CompletedPart[] = [];
        for await (const part of fixedSizeStreamParts(
          body,
          SYNC_PART_BYTES,
          session.expectedBytes,
        )) {
          bytes += part.length;
          hash.update(part);
          const partHash = createHash('sha256').update(part).digest('base64');
          const uploaded = await this.send(
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: sealedUploadId,
              PartNumber: parts.length + 1,
              Body: part,
              ContentLength: part.length,
              ChecksumSHA256: partHash,
            }),
          );
          if (!uploaded.ETag) throw new Error('Missing sealed part receipt');
          parts.push({
            PartNumber: parts.length + 1,
            ETag: uploaded.ETag,
            ChecksumSHA256: partHash,
          });
        }
        if (bytes !== session.expectedBytes || hash.digest('hex') !== session.sha256)
          throw new Error('Artifact checksum mismatch');
        await this.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: sealedUploadId,
            MultipartUpload: { Parts: parts },
            MpuObjectSize: bytes,
            IfNoneMatch: '*',
          }),
        );
        sealedUploadId = undefined;
      }
    } catch (err) {
      if (!conditionalConflict(err)) throw err;
    } finally {
      body.destroy();
      if (sealedUploadId)
        await this.send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: sealedUploadId,
          }),
        ).catch(() => undefined);
    }
    const accepted = await this.receipt(key, session);
    if (!accepted) throw new Error('Sealed artifact receipt unavailable');
    return accepted;
  }
}
