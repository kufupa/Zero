import {
  activateSource,
  activeTransportStatus,
  controlSource,
  redeemActivation,
} from '../src/outlook-sync/service.js';
import { outlookSyncFixture } from './helpers/outlook-sync-fixture.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { __setDbForTests } from '../src/db/client.js';
import { session } from '../src/db/schema/auth.js';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30000 });
import { randomUUID } from 'node:crypto';

describe('native sync route authority', () => {
  it('returns read-only sync status for the active mailbox without a device bridge', async () =>
    withIngestionDb(async ({ db }) => {
      const f = await outlookSyncFixture(db);
      expect(await activeTransportStatus(db, f.auth, new Headers(), f.transportId)).toBeNull();

      const activation = await activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key);
      expect(await activeTransportStatus(db, f.auth, new Headers(), f.transportId)).toMatchObject({
        sourceId: activation.sourceId,
        state: 'pending',
        discovered: 0,
        committed: 0,
      });
    }));

  it('reports the source session health instead of comparing it to the webmail session', async () =>
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
      await redeemActivation(
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

      const webmailSessionId = randomUUID();
      await db.insert(session).values({
        id: webmailSessionId,
        token: randomUUID(),
        userId: f.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const webmailAuth = {
        api: {
          getSession: async () => ({
            user: { id: f.userId },
            session: { id: webmailSessionId },
          }),
        },
      };

      expect(
        await activeTransportStatus(db, webmailAuth, new Headers(), f.transportId),
      ).toMatchObject({
        sourceId: activation.sourceId,
        state: 'running',
      });

      await controlSource(db, webmailAuth, new Headers(), f.transportId, {
        sourceId: activation.sourceId,
        operation: 'resume',
        idempotencyKey: randomUUID(),
      });
      expect(
        await activeTransportStatus(db, webmailAuth, new Headers(), f.transportId),
      ).toMatchObject({
        sourceId: activation.sourceId,
        state: 'sign-in-required',
      });
    }));

  it('isolates heartbeat controls when two authorized sources reuse an idempotency key', async () =>
    withIngestionDb(async ({ db }) => {
      const { createOutlookSyncNativeHandler } = await import('../src/http/outlook-sync-native.js');
      const first = await outlookSyncFixture(db),
        second = await outlookSyncFixture(db);
      const key = randomUUID();
      const activate = async (f: typeof first) => {
        const handler = createOutlookSyncNativeHandler(db, f.key);
        const a = await activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        );
        const response = await handler(
          await f.signedRequest('/api/outlook/native/sync/activate', {
            version: 1,
            sourceId: a.sourceId,
            activationTicket: a.activationTicket,
            idempotencyKey: f.activation.idempotencyKey,
            storeId: f.storeId,
            rootEntryId: f.rootEntryId,
          }),
        );
        expect(response.status).toBe(200);
        const activated = await response.json();
        return {
          handler,
          scope: {
            version: 1,
            sourceId: a.sourceId,
            sourceHandle: activated.sourceHandle,
            storeId: f.storeId,
            rootEntryId: f.rootEntryId,
          },
        };
      };
      const one = await activate(first),
        two = await activate(second);
      await controlSource(db, first.auth, new Headers(), first.transportId, {
        sourceId: one.scope.sourceId,
        operation: 'pause',
        idempotencyKey: key,
      });
      await controlSource(db, second.auth, new Headers(), second.transportId, {
        sourceId: two.scope.sourceId,
        operation: 'syncNow',
        idempotencyKey: key,
      });
      const response = await two.handler(
        await second.signedRequest('/api/outlook/native/sync/heartbeat', two.scope),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        sourceId: two.scope.sourceId,
        control: { idempotencyKey: key, operation: 'syncNow', window: null },
        userPaused: false,
      });
    }));

  it('returns paused status without a claim fence and never renews stale authority', async () =>
    withIngestionDb(async ({ db }) => {
      const { createOutlookSyncNativeHandler } = await import('../src/http/outlook-sync-native.js');
      const f = await outlookSyncFixture(db),
        handler = createOutlookSyncNativeHandler(db, f.key),
        a = await activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key);
      const activated = await (
        await handler(
          await f.signedRequest('/api/outlook/native/sync/activate', {
            version: 1,
            sourceId: a.sourceId,
            activationTicket: a.activationTicket,
            idempotencyKey: f.activation.idempotencyKey,
            storeId: f.storeId,
            rootEntryId: f.rootEntryId,
          }),
        )
      ).json();
      const scope = {
        version: 1,
        sourceId: a.sourceId,
        sourceHandle: activated.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      };
      await controlSource(db, f.auth, new Headers(), f.transportId, {
        sourceId: a.sourceId,
        operation: 'pause',
        idempotencyKey: randomUUID(),
      });
      const response = await handler(
        await f.signedRequest('/api/outlook/native/sync/heartbeat', scope),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ userPaused: true, claimFence: 2 });
      const { outlookSyncSource } = await import('../src/db/schema/outlook-sync.js');
      expect((await db.select().from(outlookSyncSource))[0].claimExpiresAt).toBeNull();
      const stale = await handler(
        await f.signedRequest('/api/outlook/native/sync/heartbeat', {
          ...scope,
          claimFence: 0,
          resourcePauseReason: 'offline',
        }),
      );
      expect(stale.status).toBe(200);
      expect((await db.select().from(outlookSyncSource))[0].resourcePauseReason).toBeNull();
      const forged = await handler(
        await f.signedRequest('/api/outlook/native/sync/heartbeat', {
          ...scope,
          sourceHandle: 'x'.repeat(43),
        }),
      );
      expect(forged.status).toBe(403);
    }));
  it('accepts bounded full enrichment above 64 KiB and rejects an oversized upload envelope', async () =>
    withIngestionDb(async ({ db }) => {
      const { createOutlookSyncNativeHandler } = await import('../src/http/outlook-sync-native.js');
      const { redeemActivation, claimSource } = await import('../src/outlook-sync/service.js');
      const { recordInventory } = await import('../src/outlook-sync/ledger.js');
      const f = await outlookSyncFixture(db),
        handler = createOutlookSyncNativeHandler(db, f.key);
      const a = await activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key);
      const redeemed = await redeemActivation(
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
        sourceHandle: redeemed.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      };
      const claim = await claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() });
      const fenced = { ...scope, claimFence: claim.claimFence };
      const stub = {
        ...f.observation(),
        semanticReady: false,
        direction: 'unknown' as const,
        requiredArtifactRoles: [],
      };
      const inventory = await recordInventory(db, f.deviceId, {
        ...fenced,
        scan: { mode: 'history', from: redeemed.historyFrom, to: redeemed.historyTo },
        partitionId: 'root',
        pageId: randomUUID(),
        checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
        observations: [stub],
        discoveryComplete: true,
      });
      const full = {
        ...f.observation(stub.sourceObservationId),
        semanticReady: true,
        semantic: { ...stub.semantic, transportHeaders: 'X-Long: ' + 'a'.repeat(70_000) },
      };
      const response = await handler(
        await f.signedRequest('/api/outlook/native/sync/upload', {
          ...fenced,
          observationId: inventory.observations[0].observationId,
          observation: full,
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ accepted: true });
      const oversized = await handler(
        new Request('https://test.invalid/api/outlook/native/sync/upload', {
          method: 'POST',
          body: 'a'.repeat(1_048_577),
        }),
      );
      expect(oversized.status).toBe(413);
    }));
  it('reports a prior live worker claim as retryable while preserving source authority', async () =>
    withIngestionDb(async ({ db }) => {
      const { createOutlookSyncNativeHandler } = await import('../src/http/outlook-sync-native.js');
      const { redeemActivation, claimSource } = await import('../src/outlook-sync/service.js');
      const { outlookSyncSource } = await import('../src/db/schema/outlook-sync.js');
      const { eq } = await import('drizzle-orm');
      const f = await outlookSyncFixture(db),
        handler = createOutlookSyncNativeHandler(db, f.key);
      const a = await activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key);
      const redeemed = await redeemActivation(
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
        sourceHandle: redeemed.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      };
      const first = await claimSource(db, f.deviceId, { ...scope, workerId: randomUUID() });
      const secondWorker = randomUUID();
      const busy = await handler(
        await f.signedRequest('/api/outlook/native/sync/claim', {
          ...scope,
          workerId: secondWorker,
        }),
      );
      expect(busy.status).toBe(409);
      expect(busy.headers.get('retry-after')).toBe('60');
      expect(await busy.json()).toEqual({ code: 'SYNC_CLAIM_BUSY', retryable: true });
      expect(
        (await handler(await f.signedRequest('/api/outlook/native/sync/heartbeat', scope))).status,
      ).toBe(200);
      await db
        .update(outlookSyncSource)
        .set({ claimExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(outlookSyncSource.id, a.sourceId));
      const takeover = await handler(
        await f.signedRequest('/api/outlook/native/sync/claim', {
          ...scope,
          workerId: secondWorker,
        }),
      );
      expect(takeover.status).toBe(200);
      expect((await takeover.json()).claimFence).toBe(first.claimFence + 1);
      const forged = await handler(
        await f.signedRequest('/api/outlook/native/sync/claim', {
          ...scope,
          sourceHandle: 'a'.repeat(43),
          workerId: secondWorker,
        }),
      );
      expect(forged.status).toBe(403);
    }));
  it('requires ticket and exact fresh HMAC, rejects replay/query/unknown fields and binds native-only handle', async () =>
    withIngestionDb(async ({ db }) => {
      const module = await import('../src/http/outlook-sync-native.js').catch(() => null);
      expect(module, 'finite native sync routes exist').not.toBeNull();
      if (!module) return;
      const f = await outlookSyncFixture(db),
        handler = module.createOutlookSyncNativeHandler(db, f.key),
        a = await activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key),
        payload = {
          version: 1,
          sourceId: a.sourceId,
          activationTicket: a.activationTicket,
          idempotencyKey: f.activation.idempotencyKey,
          storeId: f.storeId,
          rootEntryId: f.rootEntryId,
        };
      const request = await f.signedRequest('/api/outlook/native/sync/activate', payload),
        clone = request.clone();
      const response = await handler(request);
      expect(response.status).toBe(200);
      const r = await response.json();
      expect(r.sourceHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await handler(clone)).status).toBe(403);
      expect(
        await (
          await handler(await f.signedRequest('/api/outlook/native/sync/activate', payload))
        ).json(),
      ).toEqual(r);
      expect(
        (
          await handler(
            await f.signedRequest('/api/outlook/native/sync/activate', {
              ...payload,
              idempotencyKey: randomUUID(),
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await handler(
            await f.signedRequest('/api/outlook/native/sync/activate', {
              ...payload,
              execute: 'evil',
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await handler(
            new Request('https://test.invalid/api/outlook/native/sync/claim?x=1', {
              method: 'POST',
              body: '{}',
            }),
          )
        ).status,
      ).toBe(400);
      const scope = {
        version: 1,
        sourceId: a.sourceId,
        sourceHandle: r.sourceHandle,
        storeId: f.storeId,
        rootEntryId: f.rootEntryId,
      };
      const claim = await handler(
        await f.signedRequest('/api/outlook/native/sync/claim', {
          ...scope,
          workerId: randomUUID(),
        }),
      );
      expect(claim.status).toBe(200);
      const c = await claim.json();
      expect(
        (
          await handler(
            await f.signedRequest('/api/outlook/native/sync/lease', {
              ...scope,
              claimFence: c.claimFence,
            }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await handler(
            await f.signedRequest('/api/outlook/native/sync/lease', {
              ...scope,
              sourceId: randomUUID(),
              claimFence: c.claimFence,
            }),
          )
        ).status,
      ).toBe(403);
    }));
  it('hosted routes use real auth and never expose handle or accept injected identity', async () =>
    withIngestionDb(async ({ db, sql }) => {
      const module = await import('../src/trpc/routes/outlook-sync.js').catch(() => null);
      expect(module).not.toBeNull();
      if (!module) return;
      const f = await outlookSyncFixture(db);
      process.env.NAVA_OUTLOOK_DEVICE_WRAPPING_KEY = f.key;
      __setDbForTests({ db, conn: sql });
      try {
        const caller = module.outlookSyncRouter.createCaller({
          auth: f.auth,
          reqHeaders: new Headers({ 'x-zero-active-transport': f.transportId }),
        } as never);
        const a = await caller.activate(f.activation);
        expect(a).not.toHaveProperty('sourceHandle');
        expect(await caller.status({ sourceId: a.sourceId })).not.toHaveProperty(
          'activationTicket',
        );
        const injected = module.outlookSyncRouter.createCaller({
          auth: { api: { getSession: async () => null } },
          reqHeaders: new Headers(),
          sessionUser: { id: f.userId, email: 'fake@example.test' },
          activeTransportId: f.transportId,
          accessRole: 'member',
        } as never);
        await expect(injected.activate(f.activation)).rejects.toThrow();
      } finally {
        __setDbForTests(null);
      }
    }));
});

it('real Better Auth session deletion invokes durable source fencing', async () =>
  withIngestionDb(async ({ db, sql }) => {
    const f = await outlookSyncFixture(db);
    __setDbForTests({ db, conn: sql });
    process.env.NAVA_AUTH_SESSION_PROFILE = 'legacy';
    process.env.BETTER_AUTH_URL = 'https://test.invalid';
    process.env.GOOGLE_CLIENT_ID = '';
    process.env.GOOGLE_CLIENT_SECRET = '';
    try {
      const { createAuth } = await import('../src/lib/auth.js'),
        auth = createAuth();
      expect(auth.options.databaseHooks?.session?.delete?.after, 'logout hook wired').toBeTypeOf(
        'function',
      );
      if (auth.options.databaseHooks?.session?.delete?.after) {
        const a = await activateSource(
          db,
          f.auth,
          new Headers(),
          f.transportId,
          f.activation,
          f.key,
        );
        const { redeemActivation } = await import('../src/outlook-sync/service.js');
        await redeemActivation(
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
        await auth.options.databaseHooks.session.delete.after({ id: f.sessionId } as never, null);
        const { outlookSyncSource } = await import('../src/db/schema/outlook-sync.js');
        expect((await db.select().from(outlookSyncSource))[0].handleHash).toBeNull();
      }
    } finally {
      __setDbForTests(null);
    }
  }));
