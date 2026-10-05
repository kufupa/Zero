import {
  recordInventory,
  prepareArtifacts,
  attachUploadSession,
  renewFinalizationClaim,
} from '../src/outlook-sync/ledger.js';
import {
  activateSource,
  redeemActivation,
  claimSource,
  controlSource,
} from '../src/outlook-sync/service.js';
import { OutlookSyncStorage, type SyncSealedArtifact } from '../src/outlook-sync/storage.js';
import { outlookSyncSource, outlookSyncArtifact } from '../src/db/schema/outlook-sync.js';
import { createOutlookSyncNativeHandler } from '../src/http/outlook-sync-native.js';
import { outlookSyncFixture } from './helpers/outlook-sync-fixture.js';
import { approveReadRoot } from '../src/outlook-security/device.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { session } from '../src/db/schema/auth.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
vi.setConfig({ testTimeout: 30000 });
async function setup(db: Parameters<typeof outlookSyncFixture>[0]) {
  const f = await outlookSyncFixture(db);
  const a = await activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key);
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
  const workerId = randomUUID(),
    c = await claimSource(db, f.deviceId, { ...base, workerId });
  const scope = { ...base, claimFence: c.claimFence };
  const inv = await recordInventory(db, f.deviceId, {
    ...scope,
    scan: { mode: 'history', from: r.historyFrom, to: r.historyTo },
    partitionId: 'root',
    pageId: 'complete',
    checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
    observations: [f.observation()],
    discoveryComplete: true,
  });
  const [artifact] = await prepareArtifacts(db, f.deviceId, scope, {
    version: 1,
    observationId: inv.observations[0].observationId,
    semanticVersion: 1,
    artifacts: [
      {
        role: 'original-msg',
        version: 1,
        sizeBytes: 3,
        sha256: 'a'.repeat(64),
        contentType: 'application/vnd.ms-outlook',
        availability: 'available',
      },
    ],
  });
  const storage = new OutlookSyncStorage({ bucket: 'fixture', region: 'af-south-1' });
  const upload = await storage.beginUpload({
    sourceId: scope.sourceId,
    observationId: artifact.observationId,
    artifactId: artifact.id,
    expectedBytes: 3,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    authorityExpiresAt: new Date(Date.now() + 60000),
  });
  await attachUploadSession(db, f.deviceId, scope, artifact.id, upload);
  const hash = (await import('node:crypto'))
    .createHash('sha256')
    .update(JSON.stringify([scope.sourceId, artifact.observationId, artifact.id]))
    .digest('hex');
  const receipt: SyncSealedArtifact = {
    key: `outlook-sync-originals/v1/${hash}/${artifact.sha256}`,
    bytes: 3,
    sha256: artifact.sha256,
    eTag: '"immutable"',
  };
  return { f, scope, workerId, artifact, upload, storage, receipt };
}
describe('server-owned in-flight finalize renewal', () => {
  it('extends only the still-fresh same-owner same-fence claim and refuses expired rotation', () =>
    withIngestionDb(async ({ db }) => {
      const x = await setup(db);
      await db
        .update(outlookSyncSource)
        .set({ claimExpiresAt: new Date(Date.now() + 1000) })
        .where(eq(outlookSyncSource.id, x.scope.sourceId));
      await renewFinalizationClaim(db, x.f.deviceId, x.scope, x.workerId);
      expect(
        (
          await db
            .select()
            .from(outlookSyncSource)
            .where(eq(outlookSyncSource.id, x.scope.sourceId))
        )[0].claimExpiresAt!.getTime(),
      ).toBeGreaterThan(Date.now() + 50000);
      await db
        .update(outlookSyncSource)
        .set({ claimExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(outlookSyncSource.id, x.scope.sourceId));
      await expect(renewFinalizationClaim(db, x.f.deviceId, x.scope, x.workerId)).rejects.toThrow();
    }));
  it('coalesces authorized retries and returns persisted accepted receipt without sealing again', () =>
    withIngestionDb(async ({ db }) => {
      const x = await setup(db);
      let release!: (r: SyncSealedArtifact) => void, started!: () => void;
      const ready = new Promise<void>((r) => (started = r)),
        deferred = new Promise<SyncSealedArtifact>((r) => (release = r));
      const seal = vi.spyOn(x.storage, 'seal').mockImplementation(async () => {
        started();
        return deferred;
      });
      const head = vi.spyOn(x.storage, 'verifyAcceptedReceipt').mockResolvedValue(x.receipt);
      const handler = createOutlookSyncNativeHandler(db, x.f.key, { storage: x.storage });
      const payload = { ...x.scope, artifactId: x.artifact.id };
      const one = handler(await x.f.signedRequest('/api/outlook/native/sync/finalize', payload));
      await ready;
      const two = handler(await x.f.signedRequest('/api/outlook/native/sync/finalize', payload));
      await new Promise((r) => setTimeout(r, 30));
      expect(seal).toHaveBeenCalledTimes(1);
      release(x.receipt);
      expect((await one).status).toBe(200);
      expect((await two).status).toBe(200);
      expect(
        (
          await db
            .select()
            .from(outlookSyncArtifact)
            .where(eq(outlookSyncArtifact.id, x.artifact.id))
        )[0].acceptedAt,
      ).not.toBeNull();
      expect(
        (await handler(await x.f.signedRequest('/api/outlook/native/sync/finalize', payload)))
          .status,
      ).toBe(200);
      expect(seal).toHaveBeenCalledTimes(1);
      // A concurrent caller may reach artifact lookup just after acceptance; it must use HEAD, never a second seal.
      const acceptedChecks = head.mock.calls.length;
      expect(acceptedChecks).toBeGreaterThanOrEqual(1);
      expect(acceptedChecks).toBeLessThanOrEqual(2);
    }));
  it('stops deferred seal after Pause changes authority, preserving acceptance freshness', () =>
    withIngestionDb(async ({ db }) => {
      const x = await setup(db);
      let started!: () => void;
      const ready = new Promise<void>((r) => (started = r));
      vi.spyOn(x.storage, 'seal').mockImplementation(async (_s, _p, signal) => {
        started();
        return new Promise((_r, reject) =>
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
        );
      });
      const handler = createOutlookSyncNativeHandler(db, x.f.key, {
        storage: x.storage,
        finalizeRenewalMs: 5,
      });
      const result = handler(
        await x.f.signedRequest('/api/outlook/native/sync/finalize', {
          ...x.scope,
          artifactId: x.artifact.id,
        }),
      );
      await ready;
      await controlSource(db, x.f.auth, new Headers(), x.f.transportId, {
        sourceId: x.scope.sourceId,
        operation: 'pause',
        idempotencyKey: randomUUID(),
      });
      expect((await result).status).toBe(403);
      expect(
        (
          await db
            .select()
            .from(outlookSyncArtifact)
            .where(eq(outlookSyncArtifact.id, x.artifact.id))
        )[0].acceptedAt,
      ).toBeNull();
    }));
  it('renews during deferred sealing across the original claim deadline without rotating its fence', () =>
    withIngestionDb(async ({ db }) => {
      const x = await setup(db);
      await db
        .update(outlookSyncSource)
        .set({ claimExpiresAt: new Date(Date.now() + 500) })
        .where(eq(outlookSyncSource.id, x.scope.sourceId));
      vi.spyOn(x.storage, 'seal').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 600));
        return x.receipt;
      });
      const handler = createOutlookSyncNativeHandler(db, x.f.key, {
        storage: x.storage,
        finalizeRenewalMs: 20,
      });
      expect(
        (
          await handler(
            await x.f.signedRequest('/api/outlook/native/sync/finalize', {
              ...x.scope,
              artifactId: x.artifact.id,
            }),
          )
        ).status,
      ).toBe(200);
      const [source] = await db
        .select()
        .from(outlookSyncSource)
        .where(eq(outlookSyncSource.id, x.scope.sourceId));
      expect(source.claimFence).toBe(x.scope.claimFence);
      expect(source.claimOwner).toBe(x.workerId);
      expect(source.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50000);
    }));
  it.each([
    'session-revoked',
    'staff-expired',
    'root-generation',
    'takeover',
    'source-expired',
  ] as const)('aborts sealing on %s without accepting or rotating the rejected claim', (cause) =>
    withIngestionDb(async ({ db }) => {
      const x = await setup(db);
      let started!: () => void;
      const ready = new Promise<void>((r) => (started = r));
      vi.spyOn(x.storage, 'seal').mockImplementation(async (_s, _p, signal) => {
        started();
        return new Promise((_r, reject) =>
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
        );
      });
      const handler = createOutlookSyncNativeHandler(db, x.f.key, {
        storage: x.storage,
        finalizeRenewalMs: 5,
      });
      const result = handler(
        await x.f.signedRequest('/api/outlook/native/sync/finalize', {
          ...x.scope,
          artifactId: x.artifact.id,
        }),
      );
      await ready;
      if (cause === 'session-revoked')
        await db.delete(session).where(eq(session.id, x.f.sessionId));
      else if (cause === 'staff-expired')
        await db
          .update(session)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(session.id, x.f.sessionId));
      else if (cause === 'root-generation')
        await approveReadRoot(db, {
          deviceId: x.f.deviceId,
          userId: x.f.userId,
          transportId: x.f.transportId,
          storeId: x.f.storeId,
          rootEntryId: x.f.rootEntryId,
          policyVersion: 1,
        });
      else
        await db
          .update(outlookSyncSource)
          .set(
            cause === 'takeover'
              ? { claimFence: x.scope.claimFence + 1, claimOwner: randomUUID() }
              : { authorityExpiresAt: new Date(Date.now() - 1000) },
          )
          .where(eq(outlookSyncSource.id, x.scope.sourceId));
      expect((await result).status).toBe(403);
      expect(
        (
          await db
            .select()
            .from(outlookSyncArtifact)
            .where(eq(outlookSyncArtifact.id, x.artifact.id))
        )[0].acceptedAt,
      ).toBeNull();
      if (cause === 'takeover')
        expect(
          (
            await db
              .select()
              .from(outlookSyncSource)
              .where(eq(outlookSyncSource.id, x.scope.sourceId))
          )[0].claimFence,
        ).toBe(x.scope.claimFence + 1);
    }),
  );
});
