import {
  outlookSyncSource,
  outlookSyncArtifact,
  outlookSyncObservation,
  outlookSyncScan,
} from '../src/db/schema/outlook-sync.js';
import {
  activateSource,
  sourceStatus,
  invalidateSourceSession,
} from '../src/outlook-sync/service.js';
import { createOutlookSyncNativeHandler } from '../src/http/outlook-sync-native.js';
import { message, mailLiveAdmission, attachment } from '../src/db/schema/mail.js';
import { outlookSyncFixture } from './helpers/outlook-sync-fixture.js';
import { OutlookSyncStorage } from '../src/outlook-sync/storage.js';
import { runSyncDrainPass } from '../src/outlook-sync/drain.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { createHash, randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
vi.setConfig({ testTimeout: 30000 });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
class PrivateObjects {
  objects = new Map<string, { bytes: Buffer; metadata: Record<string, string>; etag: string }>();
  uploads = new Map<
    string,
    { key: string; metadata: Record<string, string>; parts: Map<number, Buffer> }
  >();
  offline = false;
  async send(command: { constructor: { name: string }; input: any }) {
    if (this.offline) throw new Error('simulated storage outage');
    const a = command.input,
      object = this.objects.get(a.Key);
    switch (command.constructor.name) {
      case 'HeadObjectCommand':
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { ContentLength: object.bytes.length, Metadata: object.metadata, ETag: object.etag };
      case 'GetObjectCommand':
        if (!object || object.etag !== a.IfMatch)
          throw Object.assign(new Error('changed'), { name: 'PreconditionFailed' });
        return { Body: Readable.from([object.bytes]) };
      case 'CreateMultipartUploadCommand': {
        const id = randomUUID();
        this.uploads.set(id, { key: a.Key, metadata: a.Metadata, parts: new Map() });
        return { UploadId: id };
      }
      case 'UploadPartCommand':
        this.uploads.get(a.UploadId)!.parts.set(a.PartNumber, Buffer.from(a.Body));
        return { ETag: '"' + sha(a.Body) + '"' };
      case 'CompleteMultipartUploadCommand': {
        if (this.objects.has(a.Key))
          throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
        const upload = this.uploads.get(a.UploadId)!;
        const bytes = Buffer.concat(
          a.MultipartUpload.Parts.map((p: any) => upload.parts.get(p.PartNumber)!),
        );
        this.objects.set(a.Key, { bytes, metadata: upload.metadata, etag: '"' + sha(bytes) + '"' });
        this.uploads.delete(a.UploadId);
        return {};
      }
      case 'AbortMultipartUploadCommand':
        this.uploads.delete(a.UploadId);
        return {};
      default:
        throw new Error(command.constructor.name);
    }
  }
}
it.each(['enrichment', 'live hint'] as const)(
  'native golden inventory upgrades through %s, signed sealing and one live admission across retries',
  async (upgrade) =>
    withIngestionDb(async ({ db }) => {
      const f = await outlookSyncFixture(db),
        objects = new PrivateObjects();
      const storage = new OutlookSyncStorage({
        bucket: 'private-mail',
        region: 'af-south-1',
        client: objects as unknown as S3Client,
        signer: async () => 'https://private-mail.s3.af-south-1.amazonaws.com/upload',
      });
      const handler = createOutlookSyncNativeHandler(db, f.key, { storage });
      const route = async (op: string, input: unknown, status = 200) => {
        const response = await handler(
          await f.signedRequest('/api/outlook/native/sync/' + op, input),
        );
        expect(response.status, op).toBe(status);
        return response.status === 200 ? response.json() : null;
      };
      const a = await activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key);
      const activation = {
        version: 1,
        sourceId: a.sourceId,
        activationTicket: a.activationTicket,
        idempotencyKey: f.activation.idempotencyKey,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      };
      const r = await route('activate', activation);
      expect(await route('activate', activation)).toEqual(r);
      const base = {
        version: 1,
        sourceId: a.sourceId,
        sourceHandle: r.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      };
      const c = await route('claim', { ...base, workerId: randomUUID() }),
        scope = { ...base, claimFence: c.claimFence };
      const golden = JSON.parse(
        await readFile(new URL('./fixtures/outlook-sync-v1.json', import.meta.url), 'utf8'),
      );
      golden.locator.storeId = f.storeId;
      golden.locator.rootEntryId = f.rootEntryId;
      const at = new Date().toISOString();
      if (upgrade === 'live hint') {
        golden.timestamps.receivedAt = at;
        golden.event.observedAt = at;
      }
      const inventory = {
        ...scope,
        scan: { mode: 'history', from: r.historyFrom, to: r.historyTo },
        partitionId: 'root',
        pageId: 'native-golden',
        checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
        observations: [golden],
        discoveryComplete: true,
      };
      const discovered = await route('inventory', inventory);
      expect(
        (
          await route('inventory', {
            ...inventory,
            scan: { ...inventory.scan, id: discovered.scanId },
          })
        ).observations,
      ).toEqual(discovered.observations);
      const observationId = discovered.observations[0].observationId;
      await route(
        'upload',
        {
          ...scope,
          manifest: {
            version: 1,
            observationId,
            semanticVersion: golden.semanticVersion,
            artifacts: [
              {
                role: 'original-msg',
                version: 1,
                sizeBytes: 1,
                sha256: 'a'.repeat(64),
                contentType: 'application/vnd.ms-outlook',
                availability: 'available',
              },
            ],
          },
        },
        403,
      );
      const full = {
        ...f.observation(golden.sourceObservationId),
        semanticReady: true,
        semanticVersion: golden.semanticVersion + (upgrade === 'enrichment' ? 1 : 0),
        requiredArtifactRoles: ['original-msg', 'body-text', 'attachment:stable'],
        timestamps: { ...golden.timestamps, receivedAt: at },
        event: {
          kind: 'new-mail',
          observedAt: at,
          receivedAt: at,
          wasUnsent: false,
          isUnsent: false,
          sentCopySaved: false,
        },
      };
      if (upgrade === 'live hint') {
        const event = { ...scope, eventOnly: true, observations: [full] };
        const hinted = await route('inventory', event);
        expect(hinted.observations[0].observationId).toBe(observationId);
        expect((await route('inventory', event)).observations).toEqual(hinted.observations);
        expect(await db.select().from(outlookSyncObservation)).toHaveLength(1);
        const [upgraded] = await db.select().from(outlookSyncObservation);
        expect(upgraded).toMatchObject({
          id: observationId,
          direction: 'inbound',
          availability: 'available',
          requiredArtifactRoles: full.requiredArtifactRoles,
          exportState: 'pending',
          ingestionState: 'pending',
        });
        expect(upgraded.evidence.event).toEqual(full.event);
        const memberships = await db.select().from(outlookSyncScan);
        expect(memberships.filter((row) => row.recordKind === 'membership')).toHaveLength(1);
        expect((await db.select().from(outlookSyncSource))[0].discoveredCount).toBe(1);
      } else {
        await route('upload', { ...scope, observationId, observation: full });
      }
      const bodies = [
        Buffer.from('native original MSG'),
        Buffer.from('Native Unicode café'),
        Buffer.from('attachment evidence'),
      ];
      const roles = ['original-msg', 'body-text', 'attachment:stable'];
      const manifest = {
        version: 1,
        observationId,
        semanticVersion: full.semanticVersion,
        artifacts: bodies.map((b, i) => ({
          role: roles[i],
          version: 1,
          sizeBytes: b.length,
          sha256: sha(b),
          contentType: i === 1 ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          availability: 'available',
          ...(i === 2 ? { fileName: 'invoice.pdf', attachmentIndex: 0, inline: false } : {}),
        })),
      };
      const prepared = await route('upload', { ...scope, manifest });
      for (let i = 0; i < prepared.artifacts.length; i++) {
        const artifactId = prepared.artifacts[i].artifactId,
          grant = await route('upload', { ...scope, artifactId });
        expect(grant.grant.headers['x-amz-checksum-sha256']).toBe(
          Buffer.from(sha(bodies[i]), 'hex').toString('base64'),
        );
        objects.objects.set(grant.uploadSession.stagingKey, {
          bytes: bodies[i],
          metadata: storage.metadataFor(grant.uploadSession),
          etag: '"staging-' + i + '"',
        });
        const receipt = await route('finalize', { ...scope, artifactId });
        expect(await route('finalize', { ...scope, artifactId })).toEqual(receipt);
      }
      expect((await db.select().from(outlookSyncSource))[0]).toMatchObject({
        pendingBytes: 0,
        committedCount: 0,
        retainedCount: 1,
      });
      await invalidateSourceSession(db, f.sessionId);
      await route('upload', { ...scope, artifactId: prepared.artifacts[0].artifactId }, 403);
      objects.offline = true;
      expect(await runSyncDrainPass(db, storage, 'restart-1', 1)).toMatchObject({
        retried: 1,
        committed: 0,
      });
      objects.offline = false;
      await db
        .update(outlookSyncObservation)
        .set({ drainNextAttemptAt: new Date(0) })
        .where(eq(outlookSyncObservation.id, observationId));
      expect(await runSyncDrainPass(db, storage, 'restart-2', 1)).toMatchObject({ committed: 1 });
      expect(await runSyncDrainPass(db, storage, 'restart-3', 1)).toMatchObject({ committed: 0 });
      expect(
        await db.select().from(message).where(eq(message.transportId, f.transportId)),
      ).toHaveLength(1);
      const [m] = await db.select().from(message).where(eq(message.transportId, f.transportId));
      expect(m.textBody).toBe('Native Unicode café');
      expect(m.historyOnly).toBe(false);
      expect(await db.select().from(attachment).where(eq(attachment.messageId, m.id))).toHaveLength(
        1,
      );
      expect(
        await db
          .select()
          .from(mailLiveAdmission)
          .where(eq(mailLiveAdmission.transportId, f.transportId)),
      ).toHaveLength(1);
      expect(await db.select().from(outlookSyncArtifact)).toHaveLength(3);
      expect((await db.select().from(outlookSyncSource))[0].committedCount).toBe(1);
      expect(
        await sourceStatus(db, f.auth, new Headers(), f.transportId, scope.sourceId),
      ).toMatchObject({ state: 'sign-in-required', committed: 1 });
    }),
);
