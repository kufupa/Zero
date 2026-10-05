import {
  activateSource,
  redeemActivation,
  claimSource,
  sourceStatus,
} from '../src/outlook-sync/service.js';
import { outlookSyncSource, outlookSyncArtifact } from '../src/db/schema/outlook-sync.js';
import { createOutlookSyncNativeHandler } from '../src/http/outlook-sync-native.js';
import { outlookSyncFixture } from './helpers/outlook-sync-fixture.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import * as ledger from '../src/outlook-sync/ledger.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
vi.setConfig({ testTimeout: 30000 });
async function fixture(db: Parameters<typeof outlookSyncFixture>[0]) {
  const f = await outlookSyncFixture(db),
    a = await activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key);
  const r = await redeemActivation(
    db,
    f.deviceId,
    {
      version: 1,
      sourceId: a.sourceId,
      activationTicket: a.activationTicket,
      idempotencyKey: f.activation.idempotencyKey,
      storeId: f.storeId,
      rootEntryId: f.rootEntryId,
    },
    f.key,
  );
  const base = {
    version: 1 as const,
    sourceId: a.sourceId,
    sourceHandle: r.sourceHandle,
    storeId: f.storeId,
    rootEntryId: f.rootEntryId,
  };
  const c = await claimSource(db, f.deviceId, { ...base, workerId: randomUUID() }),
    scope = { ...base, claimFence: c.claimFence };
  const observed = f.observation();
  observed.requiredArtifactRoles = ['original-msg', 'body-text'];
  const scan = await ledger.recordInventory(db, f.deviceId, {
    ...scope,
    scan: { mode: 'history', from: r.historyFrom, to: r.historyTo },
    partitionId: 'root',
    pageId: 'p',
    checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
    observations: [observed],
    discoveryComplete: true,
  });
  const id = scan.observations[0].observationId;
  const manifest = (role: string, bytes: number, version = 1) => ({
    version: 1 as const,
    observationId: id,
    semanticVersion: 1,
    artifacts: [
      {
        role,
        version,
        sizeBytes: bytes,
        sha256: 'a'.repeat(64),
        contentType: 'application/octet-stream',
        availability: 'available' as const,
      },
    ],
  });
  return { f, scope, id, manifest };
}
describe('durable source transfer byte backpressure', () => {
  it('reserves declarations once, persists quota without artifacts and keeps authorized heartbeat from clearing server pause', async () =>
    withIngestionDb(async ({ db }) => {
      const { f, scope, manifest } = await fixture(db);
      const limit = 1024 ** 3;
      await ledger.prepareArtifacts(db, f.deviceId, scope, manifest('original-msg', limit));
      await ledger.prepareArtifacts(db, f.deviceId, scope, manifest('original-msg', limit));
      expect((await db.select().from(outlookSyncSource))[0].pendingBytes).toBe(limit);
      await expect(
        ledger.prepareArtifacts(db, f.deviceId, scope, manifest('body-text', 1)),
      ).rejects.toThrow('quota');
      expect(await db.select().from(outlookSyncArtifact)).toHaveLength(1);
      expect(
        await sourceStatus(db, f.auth, new Headers(), f.transportId, scope.sourceId),
      ).toMatchObject({ resourcePauseReason: 'quota' });
      const handler = createOutlookSyncNativeHandler(db, f.key);
      const blocked = await handler(await f.signedRequest('/api/outlook/native/sync/lease', scope));
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toMatchObject({ code: 'SYNC_QUOTA_EXCEEDED', retryable: true });
      const heart = await handler(
        await f.signedRequest('/api/outlook/native/sync/heartbeat', {
          ...scope,
          resourcePauseReason: null,
        }),
      );
      expect(heart.status).toBe(200);
      expect(await heart.json()).toMatchObject({ resourcePauseReason: 'quota' });
      expect((await db.select().from(outlookSyncSource))[0].resourcePauseReason).toBe('quota');
    }));
  it('renews a quota-paused claim and uploads its existing reservation while rejecting new extraction', async () =>
    withIngestionDb(async ({ db }) => {
      const { f, scope, manifest } = await fixture(db);
      const [artifact] = await ledger.prepareArtifacts(
        db,
        f.deviceId,
        scope,
        manifest('original-msg', 1024 ** 3),
      );
      await expect(
        ledger.prepareArtifacts(db, f.deviceId, scope, manifest('body-text', 1)),
      ).rejects.toThrow('quota');
      const { OutlookSyncStorage } = await import('../src/outlook-sync/storage.js');
      const storage = new OutlookSyncStorage({
        bucket: 'test-private',
        region: 'af-south-1',
        client: { send: async () => ({ UploadId: 'test-upload' }) } as never,
        signer: async () => 'https://test-private.s3.af-south-1.amazonaws.com/scoped',
      });
      const handler = createOutlookSyncNativeHandler(db, f.key, { storage });
      await db
        .update(outlookSyncSource)
        .set({ claimExpiresAt: new Date(0) })
        .where(eq(outlookSyncSource.id, scope.sourceId));
      const base = {
        version: 1,
        sourceId: scope.sourceId,
        sourceHandle: scope.sourceHandle,
        storeId: scope.storeId,
        rootEntryId: scope.rootEntryId,
      };
      const claimResponse = await handler(
        await f.signedRequest('/api/outlook/native/sync/claim', {
          ...base,
          workerId: randomUUID(),
        }),
      );
      expect(claimResponse.status).toBe(200);
      const claim = await claimResponse.json();
      expect(claim).toMatchObject({ resourcePauseReason: 'quota' });
      const fenced = { ...base, claimFence: claim.claimFence };
      const grant = await handler(
        await f.signedRequest('/api/outlook/native/sync/upload', {
          ...fenced,
          artifactId: artifact.id,
        }),
      );
      expect(grant.status).toBe(200);
      const data = await grant.json();
      expect(data.grant.headers['content-length']).toBe(String(16 * 1024 ** 2));
      expect(
        (await handler(await f.signedRequest('/api/outlook/native/sync/lease', fenced))).status,
      ).toBe(429);
      expect((await db.select().from(outlookSyncSource))[0]).toMatchObject({
        pendingBytes: 1024 ** 3,
        resourcePauseReason: 'quota',
      });
    }));
  it('allows one larger artifact alone and releases immutable acceptance once so pending retry can resume', async () =>
    withIngestionDb(async ({ db }) => {
      const { f, scope, manifest } = await fixture(db),
        bytes = 2 * 1024 ** 3;
      const [a] = await ledger.prepareArtifacts(
        db,
        f.deviceId,
        scope,
        manifest('original-msg', bytes),
      );
      expect((await db.select().from(outlookSyncSource))[0].pendingBytes).toBe(bytes);
      await expect(
        ledger.prepareArtifacts(db, f.deviceId, scope, manifest('body-text', 10)),
      ).rejects.toThrow('quota');
      const { createHash } = await import('node:crypto');
      const key = `outlook-sync-originals/v1/${createHash('sha256')
        .update(JSON.stringify([scope.sourceId, a.observationId, a.id]))
        .digest('hex')}/${a.sha256}`;
      const receipt = { key, bytes, sha256: a.sha256, eTag: '"sealed"' };
      await ledger.acceptArtifact(db, f.deviceId, scope, a.id, receipt);
      await ledger.acceptArtifact(db, f.deviceId, scope, a.id, receipt);
      expect((await db.select().from(outlookSyncSource))[0]).toMatchObject({
        pendingBytes: 0,
        pendingArtifactCount: 0,
        resourcePauseReason: null,
        committedCount: 0,
      });
      await ledger.prepareArtifacts(db, f.deviceId, scope, manifest('body-text', 10));
      expect((await db.select().from(outlookSyncSource))[0].pendingBytes).toBe(10);
    }));
  it('reclaims expired unaccepted reservations in bounded work and renews the same artifact without duplicate bytes', async () =>
    withIngestionDb(async ({ db }) => {
      const { f, scope, manifest } = await fixture(db);
      const [a] = await ledger.prepareArtifacts(
        db,
        f.deviceId,
        scope,
        manifest('original-msg', 1024 ** 3),
      );
      await db
        .update(outlookSyncArtifact)
        .set({ reservationExpiresAt: new Date(0) })
        .where(eq(outlookSyncArtifact.id, a.id));
      await ledger.prepareArtifacts(db, f.deviceId, scope, manifest('body-text', 100));
      expect((await db.select().from(outlookSyncSource))[0]).toMatchObject({
        pendingBytes: 100,
        pendingArtifactCount: 1,
      });
      expect(
        (await db.select().from(outlookSyncArtifact).where(eq(outlookSyncArtifact.id, a.id)))[0]
          .quotaReserved,
      ).toBe(false);
      await expect(
        ledger.prepareArtifacts(db, f.deviceId, scope, manifest('original-msg', 1024 ** 3)),
      ).rejects.toThrow('quota');
      const { setSourcePendingByteLimit } = await import('../src/outlook-sync/quota.js');
      await setSourcePendingByteLimit(db, {
        sourceId: scope.sourceId,
        deviceId: f.deviceId,
        userId: f.userId,
        transportId: f.transportId,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
        limitBytes: 2 * 1024 ** 3,
      });
      await ledger.prepareArtifacts(db, f.deviceId, scope, manifest('original-msg', 1024 ** 3));
      await ledger.prepareArtifacts(db, f.deviceId, scope, manifest('original-msg', 1024 ** 3));
      expect((await db.select().from(outlookSyncSource))[0]).toMatchObject({
        pendingBytes: 1024 ** 3 + 100,
        pendingArtifactCount: 2,
      });
    }));
  it('authorized heartbeat reclaims expired unaccepted capacity and resumes without local spool or operator reset', async () =>
    withIngestionDb(async ({ db }) => {
      const { f, scope, manifest } = await fixture(db);
      const [a] = await ledger.prepareArtifacts(
        db,
        f.deviceId,
        scope,
        manifest('original-msg', 1024 ** 3),
      );
      await expect(
        ledger.prepareArtifacts(db, f.deviceId, scope, manifest('body-text', 1)),
      ).rejects.toThrow('quota');
      await db
        .update(outlookSyncArtifact)
        .set({ reservationExpiresAt: new Date(0) })
        .where(eq(outlookSyncArtifact.id, a.id));
      const handler = createOutlookSyncNativeHandler(db, f.key),
        response = await handler(
          await f.signedRequest('/api/outlook/native/sync/heartbeat', {
            ...scope,
            resourcePauseReason: 'quota',
          }),
        );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resourcePauseReason: null });
      expect((await db.select().from(outlookSyncSource))[0]).toMatchObject({
        pendingBytes: 0,
        pendingArtifactCount: 0,
        resourcePauseReason: null,
      });
      await ledger.prepareArtifacts(db, f.deviceId, scope, manifest('body-text', 1));
    }));
  it('serializes concurrent reservations and persists explicit source-scoped operator adjustment', async () =>
    withIngestionDb(async ({ db }) => {
      const { f, scope, manifest } = await fixture(db);
      const n = 600 * 1024 ** 2;
      const results = await Promise.allSettled([
        ledger.prepareArtifacts(db, f.deviceId, scope, manifest('original-msg', n)),
        ledger.prepareArtifacts(db, f.deviceId, scope, manifest('body-text', n)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await db.select().from(outlookSyncSource))[0].pendingBytes).toBe(n);
      const quota = await import('../src/outlook-sync/quota.js');
      await quota.setSourcePendingByteLimit(db, {
        sourceId: scope.sourceId,
        deviceId: f.deviceId,
        userId: f.userId,
        transportId: f.transportId,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
        limitBytes: 2 * 1024 ** 3,
      });
      expect((await db.select().from(outlookSyncSource))[0]).toMatchObject({
        pendingByteLimit: 2 * 1024 ** 3,
        resourcePauseReason: null,
      });
      const winner = (await db.select().from(outlookSyncArtifact))[0].role;
      await ledger.prepareArtifacts(
        db,
        f.deviceId,
        scope,
        manifest(winner === 'original-msg' ? 'body-text' : 'original-msg', n),
      );
      expect((await db.select().from(outlookSyncSource))[0].pendingBytes).toBe(2 * n);
      await expect(
        quota.setSourcePendingByteLimit(db, {
          sourceId: scope.sourceId,
          deviceId: f.deviceId,
          userId: randomUUID(),
          transportId: f.transportId,
          storeId: f.storeId,
          rootEntryId: f.rootEntryId,
          limitBytes: 3 * 1024 ** 3,
        }),
      ).rejects.toThrow();
      expect(
        (
          await db.select().from(outlookSyncSource).where(eq(outlookSyncSource.id, scope.sourceId))
        )[0].pendingByteLimit,
      ).toBe(2 * 1024 ** 3);
    }));
});
