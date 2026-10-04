import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30000 });
import { z } from 'zod';

describe('outlook sync versioned contracts', () => {
  it('accepts the exact committed native metadata DTO and preserves safe bigint precision', async () => {
    const { readFile } = await import('node:fs/promises');
    const { syncObservationV1 } = await import('../src/outlook-sync/contracts.js');
    const raw = await readFile(new URL('./fixtures/outlook-sync-v1.json', import.meta.url), 'utf8');
    const native = await readFile(
      new URL('../vsto/tests/fixtures/outlook-sync-v1.json', import.meta.url),
      'utf8',
    );
    expect(raw).toBe(native);
    const parsed = syncObservationV1.parse(JSON.parse(raw));
    expect(parsed.semanticReady).toBe(false);
    expect(parsed.semanticVersion).toBe(63926711760000);
    expect(parsed.timestamps.receivedAt).toBe('2026-10-04T11:55:00.0000000Z');
    const fullRaw = await readFile(
      new URL('./fixtures/outlook-sync-full-v1.json', import.meta.url),
      'utf8',
    );
    expect(fullRaw).toBe(
      await readFile(
        new URL('../vsto/tests/fixtures/outlook-sync-full-v1.json', import.meta.url),
        'utf8',
      ),
    );
    const full = syncObservationV1.parse(JSON.parse(fullRaw));
    expect(full.semanticReady).toBe(true);
    expect(full.requiredArtifactRoles).toContain('attachment:1');
    expect(full.contentIdentity?.attachments[0]).toMatchObject({
      role: 'attachment:1',
      sizeBytes: 4096,
    });
  });
  it('rejects unknown versions, fields, unsafe bytes and preserves zero bytes', async () => {
    const contracts = await import('../src/outlook-sync/contracts.js').catch(() => null);
    expect(contracts, 'strict persisted sync contracts exist').not.toBeNull();
    if (!contracts) return;
    const artifact = {
      role: 'original-msg',
      version: 1,
      sizeBytes: 0,
      sha256: 'a'.repeat(64),
      contentType: 'application/vnd.ms-outlook',
    };
    expect(
      contracts.syncManifestV1.parse({
        version: 1,
        observationId: 'observation',
        semanticVersion: 1,
        artifacts: [artifact],
      }).artifacts[0].sizeBytes,
    ).toBe(0);
    expect(() =>
      contracts.syncManifestV1.parse({
        version: 2,
        observationId: 'observation',
        semanticVersion: 1,
        artifacts: [artifact],
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      contracts.syncManifestV1.parse({
        version: 1,
        observationId: 'observation',
        semanticVersion: 1,
        artifacts: [{ ...artifact, sizeBytes: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    ).toThrow();
    expect(() =>
      contracts.syncManifestV1.parse({
        version: 1,
        observationId: 'observation',
        semanticVersion: 1,
        artifacts: [artifact],
        arbitraryCom: true,
      }),
    ).toThrow();
  });
});

describe('persisted sync foundation', () => {
  it('has real persisted source, immutable scan partitions, observations and bigint artifacts', async () => {
    const schema = await import('../src/db/schema/outlook-sync.js').catch(() => null);
    expect(schema, 'four-table sync ledger exists').not.toBeNull();
    if (!schema) return;
    expect(schema.outlookSyncSource).toBeDefined();
    expect(schema.outlookSyncScan).toBeDefined();
    expect(schema.outlookSyncObservation).toBeDefined();
    expect(schema.outlookSyncArtifact).toBeDefined();
  });
});

it('reuses only same-source retained originals for corroborated unchanged content across metadata versions', async () =>
  withIngestionDb(async ({ db }) => {
    const ledger = await import('../src/outlook-sync/ledger.js');
    expect(ledger.reuseObservationArtifacts).toBeTypeOf('function');
    const service = await import('../src/outlook-sync/service.js'),
      f = await outlookSyncFixture(db);
    const a = await service.activateSource(
      db,
      f.auth,
      new Headers(),
      f.transportId,
      f.activation,
      f.key,
    );
    const r = await service.redeemActivation(
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
    const c = await service.claimSource(db, f.deviceId, { ...base, workerId: randomUUID() }),
      scope = { ...base, claimFence: c.claimFence };
    const old = {
      ...f.observation('stable-content'),
      contentIdentity: { sha256: 'b'.repeat(64), attachments: [] },
      event: { ...f.observation().event, kind: 'new-mail' as const },
    };
    const prior = await ledger.recordLiveHint(db, f.deviceId, scope, old);
    const [artifact] = await ledger.prepareArtifacts(db, f.deviceId, scope, {
      version: 1,
      observationId: prior.observationId,
      semanticVersion: 1,
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
    });
    const key = `outlook-sync-originals/v1/${createHash('sha256')
      .update(JSON.stringify([a.sourceId, prior.observationId, artifact.id]))
      .digest('hex')}/${artifact.sha256}`;
    await ledger.attachUploadSession(db, f.deviceId, scope, artifact.id, {
      version: 1,
      sourceId: a.sourceId,
      observationId: prior.observationId,
      artifactId: artifact.id,
      expectedBytes: 1,
      sha256: artifact.sha256,
      contentType: 'application/vnd.ms-outlook',
      mode: 'single',
      partSize: 16777216,
      partCount: 1,
      stagingKey: 'staging',
      attemptId: 'attempt',
    });
    await ledger.acceptArtifact(db, f.deviceId, scope, artifact.id, {
      key,
      bytes: 1,
      sha256: artifact.sha256,
      eTag: 'sealed',
    });
    const newer = {
      ...old,
      semanticVersion: 2,
      semantic: { ...old.semantic, isRead: true, categories: ['Read'] },
      timestamps: { ...old.timestamps, modifiedAt: new Date().toISOString() },
    };
    const next = await ledger.recordLiveHint(db, f.deviceId, scope, newer);
    expect(
      await ledger.reuseObservationArtifacts(
        db,
        f.deviceId,
        scope,
        next.observationId,
        prior.observationId,
      ),
    ).toEqual({ reused: true });
    expect(
      await ledger.reuseObservationArtifacts(
        db,
        f.deviceId,
        scope,
        next.observationId,
        prior.observationId,
      ),
    ).toEqual({ reused: true });
    const { outlookSyncObservation, outlookSyncArtifact } = await import(
      '../src/db/schema/outlook-sync.js'
    );
    const [row] = await db
      .select()
      .from(outlookSyncObservation)
      .where(eq(outlookSyncObservation.id, next.observationId));
    expect(row.exportState).toBe('retained');
    expect(row.ingestionState).toBe('pending');
    const [copy] = await db
      .select()
      .from(outlookSyncArtifact)
      .where(eq(outlookSyncArtifact.observationId, next.observationId));
    expect(copy).toBeUndefined();
    expect(row.artifactOrigin).toEqual({
      sourceId: a.sourceId,
      observationId: prior.observationId,
    });
    const partial = await ledger.recordLiveHint(db, f.deviceId, scope, {
      ...old,
      sourceObservationId: 'partial-protected',
      contentIdentity: undefined,
      requiredArtifactRoles: ['original-msg', 'attachment:1'],
    });
    const [part] = await ledger.prepareArtifacts(db, f.deviceId, scope, {
      version: 1,
      observationId: partial.observationId,
      semanticVersion: 1,
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
    });
    const partialKey = `outlook-sync-originals/v1/${createHash('sha256')
      .update(JSON.stringify([a.sourceId, partial.observationId, part.id]))
      .digest('hex')}/${part.sha256}`;
    await ledger.acceptArtifact(db, f.deviceId, scope, part.id, {
      key: partialKey,
      bytes: 1,
      sha256: part.sha256,
      eTag: 'sealed',
    });
    await ledger.reportObservationGap(
      db,
      f.deviceId,
      scope,
      partial.observationId,
      'protected',
      'attachment-1-protected',
    );
    const [kept] = await db
      .select()
      .from(outlookSyncArtifact)
      .where(eq(outlookSyncArtifact.id, part.id));
    const [gap] = await db
      .select()
      .from(outlookSyncObservation)
      .where(eq(outlookSyncObservation.id, partial.observationId));
    expect(kept.sealedKey).toBe(partialKey);
    expect(kept.acceptedAt).not.toBeNull();
    expect(gap.exportState).toBe('pending');
    expect(gap.ingestionState).toBe('attention');
    expect(gap.errorCode).toBe('attachment-1-protected');
    const changed = await ledger.recordLiveHint(db, f.deviceId, scope, {
      ...newer,
      semanticVersion: 3,
      contentIdentity: { sha256: 'c'.repeat(64), attachments: [] },
    });
    expect(
      await ledger.reuseObservationArtifacts(
        db,
        f.deviceId,
        scope,
        changed.observationId,
        prior.observationId,
      ),
    ).toEqual({ reused: false });
    await expect(
      ledger.reuseObservationArtifacts(db, f.deviceId, scope, changed.observationId, randomUUID()),
    ).rejects.toThrow();
    const noProof = await ledger.recordLiveHint(db, f.deviceId, scope, {
      ...newer,
      semanticVersion: 4,
      contentIdentity: undefined,
    });
    expect(
      await ledger.reuseObservationArtifacts(
        db,
        f.deviceId,
        scope,
        noProof.observationId,
        prior.observationId,
      ),
    ).toEqual({ reused: false });
    const f2 = await outlookSyncFixture(db),
      a2 = await service.activateSource(
        db,
        f2.auth,
        new Headers(),
        f2.transportId,
        f2.activation,
        f2.key,
      );
    const foreign = await db
      .insert(outlookSyncObservation)
      .values({
        id: randomUUID(),
        sourceId: a2.sourceId,
        sourceObservationId: old.sourceObservationId,
        semanticVersion: 1,
        evidence: old,
        availability: 'available',
        direction: 'inbound',
        requiredArtifactRoles: old.requiredArtifactRoles,
        exportState: 'retained',
      })
      .returning();
    await expect(
      ledger.reuseObservationArtifacts(db, f.deviceId, scope, noProof.observationId, foreign[0].id),
    ).rejects.toThrow();
    await service.controlSource(db, f.auth, new Headers(), f.transportId, {
      sourceId: a.sourceId,
      operation: 'pause',
      idempotencyKey: randomUUID(),
    });
    await expect(
      ledger.reuseObservationArtifacts(
        db,
        f.deviceId,
        scope,
        next.observationId,
        prior.observationId,
      ),
    ).rejects.toThrow();
  }));

it('requires reliable unchanged provider identities for attachment reuse and denies altered immutable content', async () => {
  const { reusableContent } = await import('../src/outlook-sync/content.js');
  const base = {
    semanticReady: true,
    semantic: { isRead: false, categories: [], subject: 'same' },
    timestamps: {
      receivedAt: '2026-10-04T00:00:00Z',
      sentAt: null,
      createdAt: null,
      originalDate: null,
      modifiedAt: null,
    },
    direction: 'inbound',
    requiredArtifactRoles: ['original-msg', 'attachment:1'],
    contentIdentity: {
      sha256: 'a'.repeat(64),
      attachments: [
        {
          role: 'attachment:1',
          stableId: 'provider',
          modifiedAt: '2026-10-04T00:00:00Z',
          sizeBytes: 5,
        },
      ],
    },
  };
  expect(
    reusableContent(base, {
      ...base,
      semantic: { ...base.semantic, isRead: true, categories: ['new'] },
      timestamps: { ...base.timestamps, modifiedAt: '2026-10-04T01:00:00Z' },
    }),
  ).toBe(true);
  expect(
    reusableContent(base, { ...base, semantic: { ...base.semantic, subject: 'changed' } }),
  ).toBe(false);
  expect(
    reusableContent(base, {
      ...base,
      contentIdentity: {
        ...base.contentIdentity,
        attachments: [{ ...base.contentIdentity.attachments[0], sizeBytes: 6 }],
      },
    }),
  ).toBe(false);
  expect(reusableContent(base, { ...base, contentIdentity: undefined })).toBe(false);
});

import { outlookSyncFixture } from './helpers/outlook-sync-fixture.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { createHash, randomUUID } from 'node:crypto';
import { session } from '../src/db/schema/auth.js';
import { eq, sql } from 'drizzle-orm';

describe('real PostgreSQL source authority and coverage', () => {
  it('recovers lost activation and redemption replies without duplicating or extending authority', async () =>
    withIngestionDb(async ({ db }) => {
      const service = await import('../src/outlook-sync/service.js').catch(() => null);
      expect(service, 'persisted authorized activation exists').not.toBeNull();
      if (!service) return;
      const f = await outlookSyncFixture(db);
      const [a, b] = await Promise.all([
        service.activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key),
        service.activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key),
      ]);
      expect(a).toEqual(b);
      const payload = {
        version: 1 as const,
        sourceId: a.sourceId,
        activationTicket: a.activationTicket,
        idempotencyKey: f.activation.idempotencyKey,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      };
      const redeemed = await service.redeemActivation(db, f.deviceId, payload, f.key);
      expect(await service.redeemActivation(db, f.deviceId, payload, f.key)).toEqual(redeemed);
      expect(redeemed.sourceHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const foreign = { ...payload, idempotencyKey: randomUUID() };
      await expect(service.redeemActivation(db, f.deviceId, foreign, f.key)).rejects.toThrow();
      const { outlookSyncSource } = await import('../src/db/schema/outlook-sync.js');
      const rows = await db.select().from(outlookSyncSource);
      expect(rows).toHaveLength(1);
      expect(rows[0].handleCiphertext).not.toContain(redeemed.sourceHandle);
    }));
  it('fences a previous worker, persists Pause, rejects absolute expiry and rebinds same user', async () =>
    withIngestionDb(async ({ db }) => {
      const service = await import('../src/outlook-sync/service.js').catch(() => null);
      expect(service).not.toBeNull();
      if (!service) return;
      const f = await outlookSyncFixture(db),
        a = await service.activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        );
      const r = await service.redeemActivation(
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
      const scope = {
        version: 1 as const,
        sourceId: a.sourceId,
        sourceHandle: r.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      };
      const claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() });
      const { outlookSyncSource } = await import('../src/db/schema/outlook-sync.js');
      await db
        .update(outlookSyncSource)
        .set({ claimExpiresAt: new Date(0) })
        .where(eq(outlookSyncSource.id, a.sourceId));
      const takeover = await service.claimSource(db, f.deviceId, {
        ...scope,
        workerId: randomUUID(),
      });
      expect(takeover.claimFence).toBeGreaterThan(claim.claimFence);
      await expect(
        service.issueReadLease(db, f.deviceId, { ...scope, claimFence: claim.claimFence }),
      ).rejects.toThrow();
      const lease = await service.issueReadLease(db, f.deviceId, {
        ...scope,
        claimFence: takeover.claimFence,
      });
      expect(Date.parse(lease.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
      await service.controlSource(db, f.auth, new Headers(), f.transportId, {
        sourceId: a.sourceId,
        operation: 'pause',
        idempotencyKey: randomUUID(),
      });
      await expect(
        service.issueReadLease(db, f.deviceId, { ...scope, claimFence: takeover.claimFence }),
      ).rejects.toThrow();
      expect(
        (await service.sourceStatus(db, f.auth, new Headers(), f.transportId, a.sourceId))
          .userPaused,
      ).toBe(true);
      await db
        .update(session)
        .set({
          createdAt: sql`clock_timestamp() - interval '24 hours'`,
          expiresAt: sql`clock_timestamp() + interval '1 hour'`,
        })
        .where(eq(session.id, f.sessionId));
      await expect(
        service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
      ).rejects.toThrow();
      const newSession = randomUUID();
      await db.insert(session).values({
        id: newSession,
        token: randomUUID(),
        userId: f.userId,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const newAuth = {
        api: { getSession: async () => ({ user: { id: f.userId }, session: { id: newSession } }) },
      };
      const rebound = await service.activateSource(
        db,
        newAuth,
        new Headers(),
        f.transportId,
        { ...f.activation, sourceId: a.sourceId, idempotencyKey: randomUUID() },
        f.key,
      );
      expect(rebound.sourceId).toBe(a.sourceId);
      expect(rebound.historyFrom).toBe(r.historyFrom);
      expect((await db.select().from(outlookSyncSource))[0].userPaused).toBe(true);
    }));
});

describe('durable scan membership and receipts', () => {
  it('counts reused observations independently across scans and never commits pending originals', async () =>
    withIngestionDb(async ({ db }) => {
      const ledger = await import('../src/outlook-sync/ledger.js').catch(() => null);
      expect(ledger, 'durable page ledger exists').not.toBeNull();
      if (!ledger) return;
      const service = await import('../src/outlook-sync/service.js'),
        f = await outlookSyncFixture(db),
        a = await service.activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        ),
        r = await service.redeemActivation(
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
      const scope = {
          version: 1 as const,
          sourceId: a.sourceId,
          sourceHandle: r.sourceHandle,
          storeId: f.storeId,
          rootEntryId: f.rootEntryId,
        },
        claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
        fenced = { ...scope, claimFence: claim.claimFence };
      const observation = f.observation(),
        page = {
          ...fenced,
          scan: { mode: 'history' as const, from: r.historyFrom, to: r.historyTo },
          partitionId: 'inbox',
          pageId: 'page-1',
          checkpoint: { cursor: null, generation: 'initial', complete: true, gapCode: null },
          observations: [observation],
          discoveryComplete: true,
        };
      const first = await ledger.recordInventory(db, f.deviceId, page);
      expect(first.discoveredCount).toBe(1);
      expect(first.committedCount).toBe(0);
      expect(first.status).not.toBe('committed');
      expect(
        await ledger.recordInventory(db, f.deviceId, {
          ...page,
          scan: { ...page.scan, id: first.scanId },
        }),
      ).toEqual(first);
      const manifest = {
        version: 1 as const,
        observationId: first.observations[0].observationId,
        semanticVersion: 1,
        artifacts: [
          {
            role: 'original-msg',
            version: 1,
            sizeBytes: 0,
            sha256: 'a'.repeat(64),
            contentType: 'application/vnd.ms-outlook',
            availability: 'available' as const,
          },
        ],
      };
      const artifacts = await ledger.prepareArtifacts(db, f.deviceId, fenced, manifest);
      expect(artifacts).toHaveLength(1);
      await ledger.acceptArtifact(db, f.deviceId, fenced, artifacts[0].id, {
        key: `outlook-sync-originals/v1/${createHash('sha256')
          .update(JSON.stringify([scope.sourceId, artifacts[0].observationId, artifacts[0].id]))
          .digest('hex')}/${artifacts[0].sha256}`,
        bytes: 0,
        sha256: 'a'.repeat(64),
        eTag: 'verified',
      });
      await ledger.markObservationIngested(
        db,
        first.observations[0].observationId,
        'canonical-fixture',
      );
      const completed = await ledger.scanSummary(db, first.scanId);
      expect(completed.status).toBe('committed');
      expect(completed.committedCount).toBe(1);
      const second = await ledger.recordInventory(db, f.deviceId, {
        ...page,
        scan: { mode: 'reconcile', from: r.historyFrom, to: r.historyTo },
        pageId: 'second',
      });
      expect(second.scanId).not.toBe(first.scanId);
      expect(second.discoveredCount).toBe(1);
      expect(second.committedCount).toBe(1);
      expect(second.status).toBe('committed');
      expect((await ledger.scanSummary(db, first.scanId)).committedCount).toBe(1);
    }));
  it('empty complete discovery commits but unfinished partitions and unavailable rows remain gaps', async () =>
    withIngestionDb(async ({ db }) => {
      const ledger = await import('../src/outlook-sync/ledger.js').catch(() => null);
      expect(ledger).not.toBeNull();
      if (!ledger) return;
      const service = await import('../src/outlook-sync/service.js'),
        f = await outlookSyncFixture(db),
        a = await service.activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        ),
        r = await service.redeemActivation(
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
        ),
        scope = {
          version: 1 as const,
          sourceId: a.sourceId,
          sourceHandle: r.sourceHandle,
          storeId: f.storeId,
          rootEntryId: f.rootEntryId,
        },
        claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() });
      const page = {
        ...scope,
        claimFence: claim.claimFence,
        scan: { mode: 'history' as const, from: r.historyFrom, to: r.historyTo },
        partitionId: 'root',
        pageId: 'empty',
        checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
        observations: [],
        discoveryComplete: true,
      };
      expect((await ledger.recordInventory(db, f.deviceId, page)).status).toBe('committed');
      const outside = {
        ...f.observation('pre-floor-only'),
        timestamps: {
          ...f.observation().timestamps,
          receivedAt: new Date(Date.parse(r.historyFrom) - 1000).toISOString(),
        },
      };
      const excluded = await ledger.recordInventory(db, f.deviceId, {
        ...page,
        scan: { mode: 'reconcile', from: r.historyFrom, to: r.historyTo },
        pageId: 'excluded',
        observations: [outside],
      });
      expect(excluded.status).toBe('committed');
      expect(excluded.discoveredCount).toBe(0);
      expect(excluded.committedCount).toBe(0);
      await expect(
        ledger.prepareArtifacts(
          db,
          f.deviceId,
          { ...scope, claimFence: claim.claimFence },
          {
            version: 1,
            observationId: excluded.observations[0].observationId,
            semanticVersion: outside.semanticVersion,
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
        ),
      ).rejects.toThrow();
      const unknown = { ...f.observation(), availability: 'protected' as const };
      const gap = await ledger.recordInventory(db, f.deviceId, {
        ...page,
        scan: { mode: 'reconcile', from: r.historyFrom, to: r.historyTo },
        pageId: 'gap',
        observations: [unknown],
        checkpoint: { ...page.checkpoint, complete: false, gapCode: 'folder-unavailable' },
      });
      expect(gap.gapCount).toBeGreaterThan(0);
      expect(gap.status).not.toBe('committed');
      await expect(
        ledger.recordInventory(db, f.deviceId, {
          ...page,
          scan: {
            id: gap.scanId,
            mode: 'reconcile',
            from: new Date(0).toISOString(),
            to: r.historyTo,
          },
        }),
      ).rejects.toThrow();
    }));
});

describe('bounded native pending ordering', () => {
  it('waits for full history metadata discovery and returns bounded globally newest pending references', async () =>
    withIngestionDb(async ({ db }) => {
      const ledger = await import('../src/outlook-sync/ledger.js');
      expect(ledger.pendingObservations, 'server pending export queue exists').toBeTypeOf(
        'function',
      );
      if (!ledger.pendingObservations) return;
      const service = await import('../src/outlook-sync/service.js'),
        f = await outlookSyncFixture(db),
        a = await service.activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        ),
        r = await service.redeemActivation(
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
        ),
        scope = {
          version: 1 as const,
          sourceId: a.sourceId,
          sourceHandle: r.sourceHandle,
          storeId: f.storeId,
          rootEntryId: f.rootEntryId,
        },
        claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
        fenced = { ...scope, claimFence: claim.claimFence };
      const older = {
          ...f.observation('older'),
          timestamps: {
            ...f.observation().timestamps,
            receivedAt: new Date(Date.parse(r.historyTo) - 86400000).toISOString(),
          },
        },
        newer = {
          ...f.observation('newer'),
          timestamps: {
            ...f.observation().timestamps,
            receivedAt: new Date(Date.parse(r.historyTo) - 10000).toISOString(),
          },
        },
        outbound = {
          ...f.observation('outbound'),
          direction: 'outbound' as const,
          timestamps: {
            ...f.observation().timestamps,
            receivedAt: new Date(Date.parse(r.historyTo) - 200000000).toISOString(),
            sentAt: new Date(Date.parse(r.historyTo) - 1000).toISOString(),
          },
        },
        unknown = {
          ...f.observation('unknown-date'),
          availability: 'unknown-date' as const,
          timestamps: {
            receivedAt: null,
            sentAt: null,
            createdAt: null,
            modifiedAt: null,
            originalDate: null,
          },
        },
        outside = {
          ...f.observation('outside-floor'),
          timestamps: {
            ...f.observation().timestamps,
            receivedAt: new Date(Date.parse(r.historyFrom) - 1000).toISOString(),
          },
        },
        outsideMetadata = {
          ...outside,
          sourceObservationId: 'outside-metadata',
          semanticReady: false,
        };
      const page = {
        ...fenced,
        scan: { mode: 'history' as const, from: r.historyFrom, to: r.historyTo },
        partitionId: 'inbox',
        pageId: 'first',
        checkpoint: { cursor: 'continue', generation: '1', complete: false, gapCode: null },
        observations: [older],
        discoveryComplete: false,
      };
      const scan = await ledger.recordInventory(db, f.deviceId, page);
      expect((await ledger.pendingObservations(db, f.deviceId, fenced)).items).toHaveLength(0);
      await ledger.recordInventory(db, f.deviceId, {
        ...page,
        scan: { ...page.scan, id: scan.scanId },
        pageId: 'last',
        checkpoint: { ...page.checkpoint, cursor: null, complete: true },
        observations: [newer, outbound, unknown, outside, outsideMetadata],
        discoveryComplete: true,
      });
      const pending = await ledger.pendingObservations(db, f.deviceId, fenced);
      expect(pending.items.map((x) => x.observation.sourceObservationId)).toEqual([
        'outside-metadata',
      ]);
      expect(pending.items[0].metadataOnly).toBe(true);
      expect(pending.historyDiscoveryReady).toBe(true);
      const metadata = pending.items.find(
        (x) => x.observation.sourceObservationId === 'outside-metadata',
      )!;
      expect(
        await ledger.enrichObservation(db, f.deviceId, fenced, metadata.observationId, {
          ...outsideMetadata,
          semanticReady: true,
        }),
      ).toMatchObject({ exportEligible: false });
      expect(
        (await ledger.pendingObservations(db, f.deviceId, fenced)).items.map(
          (x) => x.observation.sourceObservationId,
        ),
      ).not.toContain('outside-metadata');
      expect(
        (await ledger.pendingObservations(db, f.deviceId, fenced)).items.map(
          (x) => x.observation.sourceObservationId,
        ),
      ).toEqual(['outbound', 'newer', 'older', 'unknown-date']);
      const status = await service.sourceStatus(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        a.sourceId,
      );
      expect(status.discovered).toBe(4);
      expect(status.committed).toBe(0);
      expect(status.gaps).toBe(1);
    }));
});

describe('logout, interval safety and rollback', () => {
  it('leaves capture valid on pane absence, fences logout, and finishes accepted canonical ingestion afterwards', async () =>
    withIngestionDb(async ({ db }) => {
      const service = await import('../src/outlook-sync/service.js'),
        ledger = await import('../src/outlook-sync/ledger.js'),
        f = await outlookSyncFixture(db),
        a = await service.activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        ),
        r = await service.redeemActivation(
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
        ),
        scope = {
          version: 1 as const,
          sourceId: a.sourceId,
          sourceHandle: r.sourceHandle,
          storeId: f.storeId,
          rootEntryId: f.rootEntryId,
        },
        claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
        fenced = { ...scope, claimFence: claim.claimFence };
      expect(await service.issueReadLease(db, f.deviceId, fenced)).toHaveProperty('expiresAt');
      const page = {
          ...fenced,
          scan: { mode: 'history' as const, from: r.historyFrom, to: r.historyTo },
          partitionId: 'root',
          pageId: 'accepted',
          checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
          observations: [f.observation()],
          discoveryComplete: true,
        },
        scan = await ledger.recordInventory(db, f.deviceId, page),
        observationId = scan.observations[0].observationId;
      const [artifact] = await ledger.prepareArtifacts(db, f.deviceId, fenced, {
        version: 1,
        observationId,
        semanticVersion: 1,
        artifacts: [
          {
            role: 'original-msg',
            version: 1,
            sizeBytes: 0,
            sha256: 'b'.repeat(64),
            contentType: 'application/vnd.ms-outlook',
            availability: 'available',
          },
        ],
      });
      const key = `outlook-sync-originals/v1/${createHash('sha256')
        .update(JSON.stringify([scope.sourceId, artifact.observationId, artifact.id]))
        .digest('hex')}/${artifact.sha256}`;
      await ledger.acceptArtifact(db, f.deviceId, fenced, artifact.id, {
        key,
        bytes: 0,
        sha256: artifact.sha256,
        eTag: 'verified',
      });
      await service.invalidateSourceSession(db, f.sessionId);
      await expect(service.issueReadLease(db, f.deviceId, fenced)).rejects.toThrow();
      await ledger.markObservationIngested(db, observationId, 'canonical-accepted');
      expect((await ledger.scanSummary(db, scan.scanId)).status).toBe('committed');
    }));
  it('rolls a forged page back completely and persistent Pause refuses syncNow/start', async () =>
    withIngestionDb(async ({ db }) => {
      const service = await import('../src/outlook-sync/service.js'),
        ledger = await import('../src/outlook-sync/ledger.js'),
        f = await outlookSyncFixture(db),
        a = await service.activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        ),
        r = await service.redeemActivation(
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
        ),
        scope = {
          version: 1 as const,
          sourceId: a.sourceId,
          sourceHandle: r.sourceHandle,
          storeId: f.storeId,
          rootEntryId: f.rootEntryId,
        },
        claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
        fenced = { ...scope, claimFence: claim.claimFence };
      const good = f.observation(),
        bad = f.observation();
      bad.locator.rootEntryId = 'foreign';
      await expect(
        ledger.recordInventory(db, f.deviceId, {
          ...fenced,
          scan: { mode: 'history', from: r.historyFrom, to: r.historyTo },
          partitionId: 'root',
          pageId: 'rolledback',
          checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
          observations: [good, bad],
          discoveryComplete: true,
        }),
      ).rejects.toThrow();
      const { outlookSyncObservation, outlookSyncScan } = await import(
        '../src/db/schema/outlook-sync.js'
      );
      expect(await db.select().from(outlookSyncObservation)).toHaveLength(0);
      expect(await db.select().from(outlookSyncScan)).toHaveLength(0);
      await service.controlSource(db, f.auth, new Headers(), f.transportId, {
        sourceId: a.sourceId,
        operation: 'pause',
        idempotencyKey: randomUUID(),
      });
      for (const operation of ['start', 'syncNow', 'retryMissing'] as const)
        await expect(
          service.controlSource(db, f.auth, new Headers(), f.transportId, {
            sourceId: a.sourceId,
            operation,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toThrow();
      expect(
        (await service.sourceStatus(db, f.auth, new Headers(), f.transportId, a.sourceId))
          .userPaused,
      ).toBe(true);
    }));
  it('clamps one calendar month at month end in hotel timezone', async () => {
    const { onboardingBounds } = await import('../src/outlook-sync/service.js');
    expect(onboardingBounds(new Date('2026-03-31T12:30:00Z')).historyFrom.toISOString()).toBe(
      '2026-02-28T12:30:00.000Z',
    );
    expect(onboardingBounds(new Date('2024-03-31T12:00:00Z')).historyFrom.toISOString()).toBe(
      '2024-02-29T12:00:00.000Z',
    );
  });
});

it('persists protected pending gaps and live hints without a second active metadata scan', async () =>
  withIngestionDb(async ({ db }) => {
    const ledger = await import('../src/outlook-sync/ledger.js');
    expect(ledger.recordLiveHint).toBeTypeOf('function');
    expect(ledger.reportObservationGap).toBeTypeOf('function');
    if (!ledger.recordLiveHint || !ledger.reportObservationGap) return;
    const service = await import('../src/outlook-sync/service.js'),
      f = await outlookSyncFixture(db),
      a = await service.activateSource(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        f.activation,
        f.key,
      ),
      r = await service.redeemActivation(
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
      ),
      scope = {
        version: 1 as const,
        sourceId: a.sourceId,
        sourceHandle: r.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      },
      claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
      fenced = { ...scope, claimFence: claim.claimFence };
    await ledger.recordInventory(db, f.deviceId, {
      ...fenced,
      scan: { mode: 'history', from: r.historyFrom, to: r.historyTo },
      partitionId: 'root',
      pageId: 'ongoing',
      checkpoint: { cursor: 'more', generation: '1', complete: false, gapCode: null },
      observations: [],
      discoveryComplete: false,
    });
    const observation = f.observation();
    observation.event.kind = 'new-mail';
    observation.event.receivedAt = observation.timestamps.receivedAt;
    const hint = await ledger.recordLiveHint(db, f.deviceId, fenced, observation);
    expect((await ledger.pendingObservations(db, f.deviceId, fenced)).items[0].observationId).toBe(
      hint.observationId,
    );
    await ledger.reportObservationGap(
      db,
      f.deviceId,
      fenced,
      hint.observationId,
      'protected',
      'protected-original',
    );
    expect((await ledger.pendingObservations(db, f.deviceId, fenced)).items).toHaveLength(0);
    expect(
      (await service.sourceStatus(db, f.auth, new Headers(), f.transportId, a.sourceId)).gaps,
    ).toBe(1);
  }));

it('cached status distinguishes full history discovery and live progress', async () =>
  withIngestionDb(async ({ db }) => {
    const service = await import('../src/outlook-sync/service.js'),
      ledger = await import('../src/outlook-sync/ledger.js'),
      f = await outlookSyncFixture(db),
      a = await service.activateSource(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        f.activation,
        f.key,
      ),
      r = await service.redeemActivation(
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
      ),
      scope = {
        version: 1 as const,
        sourceId: a.sourceId,
        sourceHandle: r.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      },
      claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
      fenced = { ...scope, claimFence: claim.claimFence };
    expect(
      (await service.sourceStatus(db, f.auth, new Headers(), f.transportId, a.sourceId)).history,
    ).toEqual({ discoveryComplete: false, discovered: 0, retained: 0, committed: 0, gaps: 0 });
    await ledger.recordInventory(db, f.deviceId, {
      ...fenced,
      scan: { mode: 'history', from: r.historyFrom, to: r.historyTo },
      partitionId: 'root',
      pageId: 'history',
      checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
      observations: [f.observation()],
      discoveryComplete: true,
    });
    const live = f.observation();
    live.event.kind = 'new-mail';
    await ledger.recordLiveHint(db, f.deviceId, fenced, live);
    const status = await service.sourceStatus(db, f.auth, new Headers(), f.transportId, a.sourceId);
    expect(status.history.discoveryComplete).toBe(true);
    expect(status.history.discovered).toBe(1);
    expect(status.live.discovered).toBe(1);
  }));

it('persists native safe-integer semantic versions above 32 bits', async () =>
  withIngestionDb(async ({ db }) => {
    const service = await import('../src/outlook-sync/service.js'),
      ledger = await import('../src/outlook-sync/ledger.js'),
      f = await outlookSyncFixture(db),
      a = await service.activateSource(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        f.activation,
        f.key,
      ),
      r = await service.redeemActivation(
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
      ),
      scope = {
        version: 1 as const,
        sourceId: a.sourceId,
        sourceHandle: r.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      },
      claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
      fenced = { ...scope, claimFence: claim.claimFence };
    const o = f.observation();
    o.event.kind = 'new-mail';
    o.semanticVersion = 5000000000000;
    const result = await ledger.recordLiveHint(db, f.deviceId, fenced, o);
    expect(result.semanticVersion).toBe(5000000000000);
  }));

it('refreshes a moved stable observation locator without erasing event evidence or duplicating it', async () =>
  withIngestionDb(async ({ db }) => {
    const service = await import('../src/outlook-sync/service.js'),
      ledger = await import('../src/outlook-sync/ledger.js'),
      f = await outlookSyncFixture(db),
      a = await service.activateSource(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        f.activation,
        f.key,
      ),
      r = await service.redeemActivation(
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
      ),
      scope = {
        version: 1 as const,
        sourceId: a.sourceId,
        sourceHandle: r.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      },
      claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
      fenced = { ...scope, claimFence: claim.claimFence },
      o = f.observation();
    o.event.kind = 'new-mail';
    const hint = await ledger.recordLiveHint(db, f.deviceId, fenced, o);
    const moved = {
      ...o,
      locator: { ...o.locator, folderEntryId: 'archive', entryId: 'changed-entry' },
      event: { ...o.event, kind: 'inventory' as const },
    };
    await ledger.recordInventory(db, f.deviceId, {
      ...fenced,
      scan: { mode: 'history', from: r.historyFrom, to: r.historyTo },
      partitionId: 'archive',
      pageId: 'moved',
      checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
      observations: [moved],
      discoveryComplete: true,
    });
    const pending = await ledger.pendingObservations(db, f.deviceId, fenced);
    expect(pending.items[0].observationId).toBe(hint.observationId);
    expect(pending.items[0].observation.locator.folderEntryId).toBe('archive');
    expect(pending.items[0].observation.event.kind).toBe('new-mail');
  }));

it('enriches metadata-only observations before artifacts and rejects arbitrary replacement', async () =>
  withIngestionDb(async ({ db }) => {
    const ledger = await import('../src/outlook-sync/ledger.js');
    expect(ledger.enrichObservation).toBeTypeOf('function');
    if (!ledger.enrichObservation) return;
    const service = await import('../src/outlook-sync/service.js'),
      f = await outlookSyncFixture(db),
      a = await service.activateSource(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        f.activation,
        f.key,
      ),
      r = await service.redeemActivation(
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
      ),
      scope = {
        version: 1 as const,
        sourceId: a.sourceId,
        sourceHandle: r.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      },
      claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() }),
      fenced = { ...scope, claimFence: claim.claimFence },
      stub = { ...f.observation(), semanticReady: false };
    stub.event.kind = 'new-mail';
    const hint = await ledger.recordLiveHint(db, f.deviceId, fenced, stub);
    const full = {
      ...stub,
      semanticReady: true,
      semanticVersion: 5000000000000,
      semantic: { ...stub.semantic, subject: 'Full extracted original' },
      requiredArtifactRoles: ['original-msg', 'body-text'],
    };
    expect(
      await ledger.enrichObservation(db, f.deviceId, fenced, hint.observationId, full),
    ).toMatchObject({ semanticVersion: full.semanticVersion });
    await expect(
      ledger.enrichObservation(db, f.deviceId, fenced, hint.observationId, {
        ...full,
        semantic: { ...full.semantic, subject: 'forged replacement' },
      }),
    ).rejects.toThrow();
  }));

it(
  'keeps 10,001-item page counters incremental and replay-safe without mailbox arrays',
  async () =>
    withIngestionDb(async ({ db }) => {
      const service = await import('../src/outlook-sync/service.js'),
        ledger = await import('../src/outlook-sync/ledger.js'),
        f = await outlookSyncFixture(db),
        a = await service.activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        ),
        r = await service.redeemActivation(
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
        ),
        scope = {
          version: 1 as const,
          sourceId: a.sourceId,
          sourceHandle: r.sourceHandle,
          storeId: f.storeId,
          rootEntryId: f.rootEntryId,
        },
        workerId = randomUUID();
      let scanId: string | undefined;
      const began = Date.now();
      for (let start = 0; start < 10001; start += 100) {
        const claim = await service.claimSource(db, f.deviceId, { ...scope, workerId });
        const n = Math.min(100, 10001 - start),
          observations = Array.from({ length: n }, (_, i) => f.observation(`many-${start + i}`)),
          page = {
            ...scope,
            claimFence: claim.claimFence,
            scan: { id: scanId, mode: 'history' as const, from: r.historyFrom, to: r.historyTo },
            partitionId: 'root',
            pageId: `p-${start}`,
            checkpoint: {
              cursor: start + n < 10001 ? String(start + n) : null,
              generation: '1',
              complete: start + n === 10001,
              gapCode: null,
            },
            observations,
            discoveryComplete: start + n === 10001,
          };
        const result = await ledger.recordInventory(db, f.deviceId, page);
        scanId = result.scanId;
        expect(result.discoveredCount).toBe(start + n);
        expect(result.observations).toHaveLength(n);
        if (start === 0)
          expect(
            (
              await ledger.recordInventory(db, f.deviceId, {
                ...page,
                scan: { ...page.scan, id: scanId },
              })
            ).discoveredCount,
          ).toBe(n);
      }
      const status = await service.sourceStatus(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        a.sourceId,
      );
      expect(status.discovered).toBe(10001);
      expect(status.history.discovered).toBe(10001);
      expect(status.history.discoveryComplete).toBe(true);
      expect(status.committed).toBe(0);
      expect(Date.now() - began).toBeLessThan(180000);
    }),
  240000,
);

it('seeds delta baselines when migrating an existing counted source without double-counting', async () =>
  withIngestionDb(
    async ({ db, sql }) => {
      const service = await import('../src/outlook-sync/service.js'),
        f = await outlookSyncFixture(db);
      const a = { sourceId: randomUUID() };
      await sql`insert into outlook_sync_source (id,device_id,transport_id,user_id,store_id,root_entry_id,session_id,policy_generation,authority_expires_at,activation_key,activation_ticket_hash,activation_ticket_ciphertext,activation_expires_at) values (${a.sourceId},${f.deviceId},${f.transportId},${f.userId},${f.storeId},${f.rootEntryId},${f.sessionId},1,now()+interval '1 hour','older-key','older-hash','older-cipher',now()+interval '1 minute')`;
      await sql`insert into outlook_sync_observation (id,source_id,source_observation_id,semantic_version,evidence,availability,direction,required_artifact_roles) values ('older',${a.sourceId},'older',1,'{}','available','inbound','["original-msg"]')`;
      await sql`update outlook_sync_source set discovered_count=1,live_summary='{"discovered":1,"retained":0,"committed":0,"gaps":0}' where id=${a.sourceId}`;
      const { readFile } = await import('node:fs/promises');
      const migration = await readFile(
        new URL('../drizzle/0041_outlook_sync_incremental_summaries.sql', import.meta.url),
        'utf8',
      );
      await sql.unsafe(migration);
      await sql.unsafe(
        await readFile(
          new URL('../drizzle/0042_outlook_sync_pending_quota.sql', import.meta.url),
          'utf8',
        ),
      );
      await sql.unsafe(
        await readFile(
          new URL('../drizzle/0043_outlook_sync_artifact_origin.sql', import.meta.url),
          'utf8',
        ),
      );
      const ledger = await import('../src/outlook-sync/ledger.js');
      await ledger.refreshSourceSummary(db, a.sourceId, ['older']);
      const status = await service.sourceStatus(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        a.sourceId,
      );
      expect(status.discovered).toBe(1);
      expect(status.live.discovered).toBe(1);
    },
    { through: 40 },
  ));

it.each(['eligible', 'excluded', 'declared', 'enriched'] as const)(
  'handles same-version inventory-to-live upgrades with %s observation guards',
  async (scenario) =>
    withIngestionDb(async ({ db }) => {
      const service = await import('../src/outlook-sync/service.js');
      const ledger = await import('../src/outlook-sync/ledger.js');
      const { outlookSyncObservation, outlookSyncArtifact, outlookSyncScan } = await import(
        '../src/db/schema/outlook-sync.js'
      );
      const f = await outlookSyncFixture(db);
      const a = await service.activateSource(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        f.activation,
        f.key,
      );
      const r = await service.redeemActivation(
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
      const scope = {
        version: 1 as const,
        sourceId: a.sourceId,
        sourceHandle: r.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      };
      const claim = await service.claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() });
      const fenced = { ...scope, claimFence: claim.claimFence };
      const stub = {
        ...f.observation(),
        semanticReady: false,
        direction: 'unknown' as const,
        availability: 'unknown-date' as const,
        semantic: { ...f.observation().semantic, from: '', to: [] },
      };
      const inventory = await ledger.recordInventory(db, f.deviceId, {
        ...fenced,
        scan: { mode: 'history', from: r.historyFrom, to: r.historyTo },
        partitionId: 'root',
        pageId: 'stub',
        checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
        observations: [stub],
        discoveryComplete: true,
      });
      const observationId = inventory.observations[0].observationId;
      const full = {
        ...stub,
        semanticReady: true,
        direction: 'inbound' as const,
        availability: 'available' as const,
        semantic: { ...stub.semantic, from: 'guest@example.test', to: ['staff@example.test'] },
        requiredArtifactRoles: ['original-msg', 'body-text'],
        event: { ...stub.event, kind: 'new-mail' as const, receivedAt: stub.timestamps.receivedAt },
      };
      if (scenario === 'excluded') {
        full.timestamps = {
          ...full.timestamps,
          receivedAt: new Date(Date.parse(r.historyFrom) - 1).toISOString(),
        };
        full.event.receivedAt = full.timestamps.receivedAt;
      }
      if (scenario === 'declared') {
        await db.insert(outlookSyncArtifact).values({
          id: randomUUID(),
          observationId,
          role: 'original-msg',
          version: 1,
          expectedBytes: 1,
          sha256: 'a'.repeat(64),
          contentType: 'application/vnd.ms-outlook',
        });
      } else if (scenario === 'enriched') {
        await ledger.enrichObservation(db, f.deviceId, fenced, observationId, {
          ...full,
          event: stub.event,
        });
        full.semantic = { ...full.semantic, subject: 'Changed after enrichment' };
      }
      if (scenario === 'declared' || scenario === 'enriched') {
        const [before] = await db.select().from(outlookSyncObservation);
        await expect(ledger.recordLiveHint(db, f.deviceId, fenced, full)).rejects.toThrow();
        expect((await db.select().from(outlookSyncObservation))[0]).toEqual(before);
        return;
      }
      const upgraded = await ledger.recordLiveHint(db, f.deviceId, fenced, full);
      expect(upgraded.observationId).toBe(observationId);
      expect((await ledger.recordLiveHint(db, f.deviceId, fenced, full)).observationId).toBe(
        observationId,
      );
      const rows = await db.select().from(outlookSyncObservation);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: observationId,
        direction: full.direction,
        availability: full.availability,
        requiredArtifactRoles: full.requiredArtifactRoles,
        exportState: scenario === 'excluded' ? 'excluded' : 'pending',
        ingestionState: scenario === 'excluded' ? 'excluded' : 'pending',
      });
      expect(rows[0].evidence.event).toEqual(full.event);
      const memberships = (await db.select().from(outlookSyncScan)).filter(
        (row) => row.recordKind === 'membership',
      );
      expect(memberships).toHaveLength(1);
      expect(memberships[0].observationId).toBe(observationId);
      expect((await ledger.scanSummary(db, inventory.scanId)).discoveredCount).toBe(
        scenario === 'excluded' ? 0 : 1,
      );
      const status = await service.sourceStatus(
        db,
        f.auth,
        new Headers(),
        f.transportId,
        a.sourceId,
      );
      expect(status.gaps).toBe(0);
      expect(status.discovered).toBe(scenario === 'excluded' ? 0 : 1);
    }),
);
