import {
  OutlookSyncStorage,
  SYNC_PART_BYTES,
  SYNC_SINGLE_PUT_LIMIT,
} from '../src/outlook-sync/storage.js';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const digest = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const missing = () => Object.assign(new Error('missing'), { name: 'NoSuchKey' });
class CommandStore {
  objects = new Map<string, { bytes: Buffer; metadata: Record<string, string>; etag: string }>();
  uploads = new Map<
    string,
    { key: string; metadata: Record<string, string>; parts: Map<number, Buffer> }
  >();
  calls: { name: string; input: any }[] = [];
  nextId = 0;
  overwriteAfterRead: (() => void) | undefined;
  async send(command: any) {
    const input = command.input;
    const name = command.constructor.name;
    this.calls.push({ name, input });
    const object = this.objects.get(input.Key);
    if (name === 'HeadObjectCommand') {
      if (!object) throw missing();
      return { ContentLength: object.bytes.length, Metadata: object.metadata, ETag: object.etag };
    }
    if (name === 'GetObjectCommand') {
      if (!object) throw missing();
      if (input.IfMatch && input.IfMatch !== object.etag)
        throw Object.assign(new Error('changed'), { name: 'PreconditionFailed' });
      const snapshot = Buffer.from(object.bytes);
      this.overwriteAfterRead?.();
      this.overwriteAfterRead = undefined;
      return {
        Body: Readable.from([snapshot]),
        ContentLength: snapshot.length,
        Metadata: object.metadata,
        ETag: object.etag,
      };
    }
    if (name === 'PutObjectCommand') {
      if (input.IfNoneMatch === '*' && object)
        throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
      const chunks: Buffer[] = [];
      for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      this.objects.set(input.Key, {
        bytes,
        metadata: input.Metadata ?? {},
        etag: `"${digest(bytes)}"`,
      });
      return { ETag: `"${digest(bytes)}"` };
    }
    if (name === 'CreateMultipartUploadCommand') {
      const UploadId = `upload-${++this.nextId}`;
      this.uploads.set(UploadId, {
        key: input.Key,
        metadata: input.Metadata ?? {},
        parts: new Map(),
      });
      return { UploadId };
    }
    if (name === 'UploadPartCommand') {
      const bytes = Buffer.from(input.Body);
      this.uploads.get(input.UploadId)!.parts.set(input.PartNumber, bytes);
      return {
        ETag: `"${digest(bytes)}"`,
        ChecksumSHA256: Buffer.from(digest(bytes), 'hex').toString('base64'),
      };
    }
    if (name === 'ListPartsCommand') {
      const upload = this.uploads.get(input.UploadId);
      if (!upload) throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
      return {
        IsTruncated: false,
        Parts: [...upload.parts].map(([PartNumber, bytes]) => ({
          PartNumber,
          Size: bytes.length,
          ETag: `"${digest(bytes)}"`,
          ChecksumSHA256: Buffer.from(digest(bytes), 'hex').toString('base64'),
        })),
      };
    }
    if (name === 'CompleteMultipartUploadCommand') {
      if (input.IfNoneMatch === '*' && object)
        throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
      const upload = this.uploads.get(input.UploadId);
      if (!upload) throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
      const bytes = Buffer.concat(
        input.MultipartUpload.Parts.map((part: any) => upload.parts.get(part.PartNumber)!),
      );
      this.objects.set(input.Key, { bytes, metadata: upload.metadata, etag: `"${digest(bytes)}"` });
      this.uploads.delete(input.UploadId);
      return { ETag: `"${digest(bytes)}"` };
    }
    if (name === 'AbortMultipartUploadCommand') {
      this.uploads.delete(input.UploadId);
      return {};
    }
    throw new Error(name);
  }
}
function setup(body = Buffer.from('retained original')) {
  const commands = new CommandStore();
  const signed: any[] = [];
  const storage = new OutlookSyncStorage({
    bucket: 'private-mail',
    region: 'af-south-1',
    client: commands as any,
    signer: async (_client: any, command: any, options: any) => {
      signed.push({ command, options });
      return 'https://private-mail.s3.af-south-1.amazonaws.com/signed';
    },
  });
  const binding = {
    sourceId: 'source',
    observationId: 'observation',
    artifactId: 'artifact',
    expectedBytes: body.length,
    sha256: digest(body),
    contentType: 'application/vnd.ms-outlook',
    authorityExpiresAt: new Date(Date.now() + 90_000),
  };
  async function staged() {
    const session = await storage.beginUpload(binding);
    commands.objects.set(session.stagingKey, {
      bytes: body,
      metadata: storage.metadataFor(session),
      etag: '"staging-1"',
    });
    return session;
  }
  return { commands, storage, binding, staged, signed, body };
}
describe('private Outlook sync originals', () => {
  it('grants a checksum-bound PUT for exact artifact with expiry inside staff authority, never sealed prefix', async () => {
    const { storage, binding, signed } = setup();
    const session = await storage.beginUpload(binding);
    const grant = await storage.grantPart(session, 1, binding.sha256, binding.authorityExpiresAt);
    expect(session.mode).toBe('single');
    expect(session.stagingKey.startsWith('outlook-sync-staging/v1/')).toBe(true);
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(binding.authorityExpiresAt.getTime());
    expect(grant.headers['x-amz-checksum-sha256']).toBe(
      Buffer.from(binding.sha256, 'hex').toString('base64'),
    );
    expect(signed[0].command.input.ContentLength).toBe(binding.expectedBytes);
    expect(signed[0].command.input.ChecksumSHA256).toBe(grant.headers['x-amz-checksum-sha256']);
    expect(signed[0].options.signableHeaders.has('content-length')).toBe(true);
    expect(signed[0].options.signingDate).toBeInstanceOf(Date);
    expect(
      signed[0].options.signingDate.getTime() + signed[0].options.expiresIn * 1000,
    ).toBeLessThanOrEqual(binding.authorityExpiresAt.getTime());
  });
  it('zero bytes are retained and have a genuine sealed receipt', async () => {
    const { storage, staged, commands } = setup(Buffer.alloc(0));
    const receipt = await storage.seal(await staged());
    expect(receipt.bytes).toBe(0);
    expect(commands.objects.get(receipt.key)?.bytes).toEqual(Buffer.alloc(0));
  });
  it('seals a coherent version with conditional immutable write despite staging overwrite, and repeated finalize survives cleanup', async () => {
    const { storage, staged, commands, body } = setup();
    const session = await staged();
    commands.overwriteAfterRead = () =>
      commands.objects.set(session.stagingKey, {
        bytes: Buffer.from('hostile'),
        metadata: {},
        etag: '"new"',
      });
    const receipt = await storage.seal(session);
    expect(commands.objects.get(receipt.key)?.bytes).toEqual(body);
    expect(
      commands.calls.find((c) => c.name === 'CompleteMultipartUploadCommand')?.input.IfNoneMatch,
    ).toBe('*');
    expect(
      commands.calls
        .find((c) => c.name === 'CompleteMultipartUploadCommand')
        ?.input.MultipartUpload.Parts.every((part: any) => part.ChecksumSHA256),
    ).toBe(true);
    commands.objects.delete(session.stagingKey);
    expect(await storage.seal(session)).toEqual(receipt);
  });
  it('rejects mismatched bytes, ownership metadata, unsafe sizes and foreign session paths', async () => {
    const { storage, staged, commands, binding } = setup();
    const session = await staged();
    commands.objects.get(session.stagingKey)!.bytes = Buffer.alloc(binding.expectedBytes, 1);
    await expect(storage.seal(session)).rejects.toThrow('checksum');
    expect(commands.uploads.size).toBe(0);
    expect(
      [...commands.objects.keys()].some((key) => key.startsWith('outlook-sync-originals/')),
    ).toBe(false);
    commands.objects.get(session.stagingKey)!.metadata = {};
    await expect(storage.seal(session)).rejects.toThrow('ownership');
    await expect(
      storage.beginUpload({ ...binding, expectedBytes: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow('size');
    await expect(storage.seal({ ...session, stagingKey: 'attachments/customer' })).rejects.toThrow(
      'scope',
    );
  });
  it('rejects expired authority and renews the same scoped grant with fresh authority', async () => {
    const { storage, binding, signed } = setup();
    const session = await storage.beginUpload(binding);
    await expect(storage.grantPart(session, 1, binding.sha256, new Date(0))).rejects.toThrow(
      'authority',
    );
    await storage.grantPart(session, 1, binding.sha256, binding.authorityExpiresAt);
    await storage.grantPart(session, 1, binding.sha256, new Date(Date.now() + 120_000));
    expect(signed[0].command.input).toEqual(signed[1].command.input);
    await expect(storage.beginUpload({ ...binding, sourceId: 'foreign' }, session)).rejects.toThrow(
      'scope',
    );
  });
  it('uses 16MiB multipart at 100MiB including >32-bit metadata, exact parts and renewal', async () => {
    const { storage, binding, signed } = setup();
    const session = await storage.beginUpload({ ...binding, expectedBytes: SYNC_SINGLE_PUT_LIMIT });
    expect(session.mode).toBe('multipart');
    expect(session.partSize).toBe(SYNC_PART_BYTES);
    expect(session.partCount).toBe(7);
    const partSha = digest('part');
    await storage.grantPart(session, 7, partSha, binding.authorityExpiresAt);
    expect(signed[0].command.input.ContentLength).toBe(4 * 1024 * 1024);
    expect(signed[0].command.input.UploadId).toBe(session.uploadId);
    await expect(
      storage.grantPart(session, 8, partSha, binding.authorityExpiresAt),
    ).rejects.toThrow('part');
    const larger = await storage.beginUpload({ ...binding, expectedBytes: 2 ** 32 + 1 });
    expect(larger.expectedBytes).toBe(2 ** 32 + 1);
    await expect(storage.seal(session, [{ partNumber: 1, eTag: 'x' }])).rejects.toThrow('parts');
  });
  it('seals a 100MiB original from 16MiB parts, rejects overwritten part receipts and retries completed staging', async () => {
    const body = Buffer.alloc(SYNC_SINGLE_PUT_LIMIT, 42);
    const { storage, binding, commands } = setup(body);
    const session = await storage.beginUpload(binding);
    const completed = [];
    for (let start = 0, n = 1; start < body.length; start += SYNC_PART_BYTES, n++) {
      const part = body.subarray(start, start + SYNC_PART_BYTES);
      commands.uploads.get(session.uploadId!)!.parts.set(n, part);
      completed.push({ partNumber: n, eTag: `"${digest(part)}"` });
    }
    await expect(
      storage.seal(
        session,
        completed.map((part, i) => (i === 0 ? { ...part, eTag: 'wrong' } : part)),
      ),
    ).rejects.toThrow('part');
    const receipt = await storage.seal(session, completed);
    expect(receipt.bytes).toBe(SYNC_SINGLE_PUT_LIMIT);
    expect(receipt.sha256).toBe(binding.sha256);
    const sealedParts = commands.calls.filter((c) => c.name === 'UploadPartCommand');
    expect(Math.max(...sealedParts.map((c) => c.input.Body.length))).toBe(SYNC_PART_BYTES);
    const completion = commands.calls.find(
      (c) => c.name === 'CompleteMultipartUploadCommand' && c.input.Key === session.stagingKey,
    );
    expect(completion?.input.MultipartUpload.Parts.every((part: any) => part.ChecksumSHA256)).toBe(
      true,
    );
    expect(await storage.seal(session, completed)).toEqual(receipt);
  }, 30_000);
  it('renews an abandoned multipart session into a new scoped upload rather than retrying a dead upload forever', async () => {
    const { storage, binding, commands } = setup();
    const large = { ...binding, expectedBytes: SYNC_SINGLE_PUT_LIMIT };
    const session = await storage.beginUpload(large);
    commands.uploads.delete(session.uploadId!);
    const renewed = await storage.beginUpload(large, session);
    expect(renewed.uploadId).not.toBe(session.uploadId);
    expect(renewed.stagingKey).not.toBe(session.stagingKey);
  });
  it('checks sealed bytes instead of trusting metadata when repeated finalize sees a corrupted receipt object', async () => {
    const { storage, staged, commands } = setup();
    const session = await staged();
    const receipt = await storage.seal(session);
    commands.objects.get(receipt.key)!.bytes.fill(1);
    await expect(storage.seal(session)).rejects.toThrow('checksum');
  });
  it('reads only checksum-verified bounded sealed projections for the drain', async () => {
    const { storage, staged, commands, body } = setup();
    const session = await staged();
    const receipt = await storage.seal(session);
    expect((await storage.readSealedBounded(receipt, body.length)).toString()).toBe(
      body.toString(),
    );
    expect(await storage.verifyReceipt(session, receipt)).toEqual(receipt);
    await expect(storage.verifyReceipt(session, { ...receipt, eTag: 'foreign' })).rejects.toThrow(
      'identity',
    );
    await expect(storage.readSealedBounded(receipt, 1)).rejects.toThrow('size');
    await expect(
      storage.readSealedBounded({ ...receipt, key: session.stagingKey }, body.length),
    ).rejects.toThrow('sealed');
    commands.objects.get(receipt.key)!.bytes.fill(1);
    await expect(storage.readSealedBounded(receipt, body.length)).rejects.toThrow('checksum');
  });
  it('uses the real AWS presigner to bind all upload headers and payload integrity', async () => {
    const client = new S3Client({
      region: 'af-south-1',
      credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    });
    const storage = new OutlookSyncStorage({
      bucket: 'private-test-mail',
      region: 'af-south-1',
      client,
    });
    const { binding } = setup();
    const session = await storage.beginUpload(binding);
    const grant = await storage.grantPart(session, 1, binding.sha256, binding.authorityExpiresAt);
    const signedHeaders = new URL(grant.url).searchParams.get('X-Amz-SignedHeaders')!.split(';');
    for (const name of Object.keys(grant.headers)) expect(signedHeaders).toContain(name);
    expect(new URL(grant.url).host).toBe('private-test-mail.s3.af-south-1.amazonaws.com');
    client.destroy();
  });
  it('concurrent seals converge on one immutable original and matching receipts', async () => {
    const { storage, staged, commands } = setup();
    const session = await staged();
    const receipts = await Promise.all([storage.seal(session), storage.seal(session)]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(
      [...commands.objects.keys()].filter((key) => key.startsWith('outlook-sync-originals/')),
    ).toHaveLength(1);
    expect(commands.uploads.size).toBe(0);
  });
  it('never falls back to fake storage when the production adapter is unconfigured', () => {
    expect(() => new OutlookSyncStorage({ bucket: '', region: '' })).toThrow('configured');
  });
});

import {
  recordInventory,
  prepareArtifacts,
  attachUploadSession,
  acceptArtifact,
} from '../src/outlook-sync/ledger.js';
import {
  outlookSyncArtifact,
  outlookSyncObservation,
  outlookSyncSource,
} from '../src/db/schema/outlook-sync.js';
import { activateSource, redeemActivation, claimSource } from '../src/outlook-sync/service.js';
import { outlookSyncFixture } from './helpers/outlook-sync-fixture.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

describe('migrated PostgreSQL durable storage receipts', () => {
  it(
    'persists one sealed/pending receipt across retries without counting canonical ingestion and rejects stale/foreign finalize',
    async () =>
      withIngestionDb(async ({ db }) => {
        const f = await outlookSyncFixture(db);
        const activation = await activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        );
        const redeemed = await redeemActivation(
          db,
          f.deviceId,
          {
            version: 1,
            sourceId: activation.sourceId,
            activationTicket: activation.activationTicket,
            idempotencyKey: f.activation.idempotencyKey,
            storeId: f.storeId,
            rootEntryId: f.rootEntryId,
          },
          f.key,
        );
        const source = {
          version: 1 as const,
          sourceId: activation.sourceId,
          sourceHandle: redeemed.sourceHandle,
          storeId: f.storeId,
          rootEntryId: f.rootEntryId,
        };
        const claim = await claimSource(db, f.deviceId, { ...source, workerId: randomUUID() });
        const scope = { ...source, claimFence: claim.claimFence };
        const observed = f.observation();
        const scan = await recordInventory(db, f.deviceId, {
          ...scope,
          scan: { mode: 'history', from: redeemed.historyFrom, to: redeemed.historyTo },
          partitionId: 'root',
          pageId: 'complete',
          checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
          observations: [observed],
          discoveryComplete: true,
        });
        const { storage, commands, body, binding } = setup();
        const [artifact] = await prepareArtifacts(db, f.deviceId, scope, {
          version: 1,
          observationId: scan.observations[0].observationId,
          semanticVersion: 1,
          artifacts: [
            {
              role: 'original-msg',
              version: 1,
              sizeBytes: body.length,
              sha256: binding.sha256,
              contentType: binding.contentType,
              availability: 'available',
            },
          ],
        });
        const upload = await storage.beginUpload({
          ...binding,
          sourceId: scope.sourceId,
          observationId: artifact.observationId,
          artifactId: artifact.id,
        });
        await attachUploadSession(db, f.deviceId, scope, artifact.id, upload);
        commands.objects.set(upload.stagingKey, {
          bytes: body,
          metadata: storage.metadataFor(upload),
          etag: '"staging"',
        });
        const sealed = await storage.seal(upload);
        const first = await acceptArtifact(db, f.deviceId, scope, artifact.id, sealed);
        commands.objects.delete(upload.stagingKey);
        expect(
          await acceptArtifact(db, f.deviceId, scope, artifact.id, await storage.seal(upload)),
        ).toEqual(first);
        const persisted = await db
          .select()
          .from(outlookSyncArtifact)
          .where(eq(outlookSyncArtifact.id, artifact.id));
        expect(persisted).toHaveLength(1);
        expect(persisted[0].sealedKey).toBe(sealed.key);
        expect(persisted[0].verifiedReceipt).toEqual(sealed);
        expect(persisted[0].ingestionState).toBe('pending');
        expect(
          (
            await db
              .select()
              .from(outlookSyncObservation)
              .where(eq(outlookSyncObservation.id, artifact.observationId))
          )[0].ingestionState,
        ).toBe('pending');
        expect(
          (
            await db
              .select()
              .from(outlookSyncSource)
              .where(eq(outlookSyncSource.id, scope.sourceId))
          )[0].committedCount,
        ).toBe(0);
        await expect(
          acceptArtifact(db, f.deviceId, scope, artifact.id, {
            ...sealed,
            key: sealed.key.replace(/\/[a-f0-9]{64}\//, `/${'f'.repeat(64)}/`),
          }),
        ).rejects.toThrow();
        await db
          .update(outlookSyncSource)
          .set({ claimFence: claim.claimFence + 1 })
          .where(eq(outlookSyncSource.id, scope.sourceId));
        await expect(acceptArtifact(db, f.deviceId, scope, artifact.id, sealed)).rejects.toThrow();
        expect(commands.objects.get(sealed.key)?.bytes).toEqual(body);
      }),
    30_000,
  );
});
