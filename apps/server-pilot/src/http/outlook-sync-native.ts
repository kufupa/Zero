import {
  acceptArtifact,
  attachUploadSession,
  ownedArtifact,
  prepareArtifacts,
  recordInventory,
  pendingObservations,
  recordLiveHint,
  reportObservationGap,
  enrichObservation,
  renewFinalizationClaim,
} from '../outlook-sync/ledger.js';
import {
  nativeActivateInput,
  nativeClaimInput,
  nativeFenced,
  nativeHeartbeatInput,
  nativeInventoryInput,
  nativeLeaseInput,
  syncManifestV1,
  syncObservationV1,
} from '../outlook-sync/contracts.js';
import {
  OutlookSyncStorage,
  type SyncUploadSession,
  type SyncSealedArtifact,
} from '../outlook-sync/storage.js';
import {
  authorizedSource,
  SyncDeniedError,
  SyncClaimBusyError,
} from '../outlook-sync/authorization.js';
import { claimSource, issueReadLease, redeemActivation } from '../outlook-sync/service.js';
import { outlookSyncSource, outlookSyncScan } from '../db/schema/outlook-sync.js';
import { verifyDeviceRequest, wrappingKey } from '../outlook-security/device.js';
import { reclaimExpiredReservations } from '../outlook-sync/quota.js';
import { SyncQuotaError } from '../outlook-sync/authorization.js';
import type { DB } from '../db/client.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

// Handler factories are per request in main; coalescing must survive across those factories.
const finalizations = new WeakMap<DB, Map<string, Promise<unknown>>>();
const eventInput = nativeFenced.extend({
  eventOnly: z.literal(true),
  observations: z.array(syncObservationV1).max(100),
});
const uploadInput = nativeFenced.extend({
  reuseObservationId: z.string().min(1).max(512).optional(),
  observation: syncObservationV1.optional(),
  observationId: z.string().min(1).max(512).optional(),
  availability: z.enum(['missing', 'protected', 'unsupported']).optional(),
  gapCode: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  pending: z.boolean().optional(),
  manifest: syncManifestV1.optional(),
  artifactId: z.string().min(1).max(512).optional(),
  partNumber: z.number().int().positive().max(10000).optional(),
  partSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
const finalizeInput = nativeFenced.extend({
  artifactId: z.string().min(1).max(512),
  completedParts: z
    .array(
      z
        .object({
          partNumber: z.number().int().positive().max(10000),
          eTag: z.string().min(1).max(1024),
          sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        })
        .strict(),
    )
    .max(10000)
    .optional(),
});
async function boundedBody(request: Request, max: number) {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > max) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}
/** HMAC proves enrolled device only; source handle + live original staff session + root generation + fence prove read authority. */
export function createOutlookSyncNativeHandler(
  db: DB,
  key: string,
  options: { storage?: OutlookSyncStorage; finalizeRenewalMs?: number } = {},
) {
  wrappingKey(key);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      operation = url.pathname.split('/').at(-1),
      known = ['activate', 'claim', 'lease', 'inventory', 'upload', 'finalize', 'heartbeat'];
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!url.pathname.startsWith('/api/outlook/native/sync/') || !known.includes(operation ?? ''))
      return new Response(null, { status: 404 });
    if (url.search) return new Response(null, { status: 400 });
    const max = ['inventory', 'upload', 'finalize'].includes(operation ?? '') ? 1_048_576 : 65_536;
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > max) return new Response(null, { status: 413 });
    const body = await boundedBody(request, max);
    if (!body) return new Response(null, { status: 413 });
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    const schemas = {
      activate: nativeActivateInput,
      claim: nativeClaimInput,
      lease: nativeLeaseInput,
      inventory: z.union([nativeInventoryInput, eventInput]),
      heartbeat: nativeHeartbeatInput,
      upload: uploadInput,
      finalize: finalizeInput,
    };
    const validation = schemas[operation as keyof typeof schemas].safeParse(raw);
    if (!validation.success) return new Response(null, { status: 400 });
    const verified = await verifyDeviceRequest(
      db,
      {
        deviceId: request.headers.get('x-nava-device-id') ?? '',
        nonce: request.headers.get('x-nava-nonce') ?? '',
        timestamp: request.headers.get('x-nava-timestamp') ?? '',
        signature: request.headers.get('x-nava-signature') ?? '',
        method: request.method,
        path: url.pathname,
        body,
      },
      key,
    );
    if (!verified)
      return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
    try {
      let result: unknown;
      if (operation === 'activate')
        result = await redeemActivation(db, verified.deviceId, nativeActivateInput.parse(raw), key);
      else if (operation === 'claim')
        result = await claimSource(db, verified.deviceId, nativeClaimInput.parse(raw));
      else if (operation === 'lease')
        result = await issueReadLease(db, verified.deviceId, nativeLeaseInput.parse(raw));
      else if (operation === 'inventory') {
        const event = eventInput.safeParse(raw);
        if (event.success) {
          const observations = [];
          for (const o of event.data.observations)
            observations.push(await recordLiveHint(db, verified.deviceId, event.data, o));
          result = { version: 1, observations };
        } else
          result = await recordInventory(db, verified.deviceId, nativeInventoryInput.parse(raw));
      } else if (operation === 'heartbeat') {
        const input = nativeHeartbeatInput.parse(raw);
        result = await db.transaction(async (tx) => {
          const {
            source: s,
            now,
            staff,
          } = await authorizedSource(tx as DB, verified.deviceId, input, {
            allowPaused: true,
          });
          const wasServerQuota = s.resourcePauseReason === 'quota';
          if (wasServerQuota) {
            await reclaimExpiredReservations(tx as DB, s.id);
            const [freshSource] = await tx
              .select()
              .from(outlookSyncSource)
              .where(eq(outlookSyncSource.id, s.id));
            s.resourcePauseReason = freshSource.resourcePauseReason;
          }
          const freshFence =
            s.claimFence === input.claimFence && s.claimExpiresAt && s.claimExpiresAt > now;
          const expiry = freshFence
            ? new Date(Math.min(now.getTime() + 60_000, staff.expiresAt.getTime()))
            : now;
          await tx
            .update(outlookSyncSource)
            .set({
              claimExpiresAt: freshFence ? expiry : s.claimExpiresAt,
              resourcePauseReason: wasServerQuota
                ? s.resourcePauseReason
                : s.resourcePauseReason === 'quota'
                  ? 'quota'
                  : freshFence
                    ? (input.resourcePauseReason ?? null)
                    : s.resourcePauseReason,
              subscriptionStartedAt: input.subscriptionStartedAt
                ? new Date(input.subscriptionStartedAt)
                : s.subscriptionStartedAt,
            })
            .where(eq(outlookSyncSource.id, s.id));
          const [control] = s.controlKey
            ? await tx
                .select()
                .from(outlookSyncScan)
                .where(
                  and(
                    eq(outlookSyncScan.sourceId, s.id),
                    eq(outlookSyncScan.recordKey, `control:${s.controlKey}`),
                  ),
                )
                .limit(1)
            : [];
          return {
            version: 1,
            sourceId: s.id,
            control: control
              ? {
                  idempotencyKey: s.controlKey,
                  operation: control.checkpoint?.operation,
                  window: control.checkpoint?.window ?? null,
                }
              : null,
            userPaused: s.userPaused,
            claimFence: s.claimFence,
            resourcePauseReason: s.resourcePauseReason,
            committedThrough: s.committedThrough?.toISOString() ?? null,
            authorityExpiresAt: s.authorityExpiresAt.toISOString(),
            expiresAt: expiry.toISOString(),
          };
        });
      } else if (operation === 'upload') {
        const input = uploadInput.parse(raw);
        if (input.observationId && input.reuseObservationId) {
          const { reuseObservationArtifacts } = await import('../outlook-sync/ledger.js');
          result = await reuseObservationArtifacts(
            db,
            verified.deviceId,
            input,
            input.observationId,
            input.reuseObservationId,
          );
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        }
        if (input.observationId && input.observation) {
          result = await enrichObservation(
            db,
            verified.deviceId,
            input,
            input.observationId,
            input.observation,
          );
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        }
        if (input.observationId && input.availability) {
          result = await reportObservationGap(
            db,
            verified.deviceId,
            input,
            input.observationId,
            input.availability,
            input.gapCode ?? 'unavailable',
          );
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        }
        if (input.pending) {
          result = await pendingObservations(db, verified.deviceId, input);
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        }
        const artifacts = input.manifest
          ? await prepareArtifacts(db, verified.deviceId, input, input.manifest)
          : [];
        if (!input.artifactId) {
          if (!input.manifest) throw new SyncDeniedError();
          result = {
            version: 1,
            artifacts: artifacts.map((a) => ({
              artifactId: a.id,
              observationId: a.observationId,
              role: a.role,
              version: a.version,
              expectedBytes: a.expectedBytes,
              sha256: a.sha256,
              sealed: a.sealedKey !== null,
            })),
          };
        } else {
          const authority = await db.transaction((tx) =>
            authorizedSource(tx as DB, verified.deviceId, input, {
              requireFence: true,
              allowQuota: true,
            }),
          );
          const a = await ownedArtifact(db, input.sourceId, input.artifactId);
          const storage = options.storage ?? new OutlookSyncStorage();
          const session = await storage.beginUpload(
            {
              sourceId: input.sourceId,
              observationId: a.observationId,
              artifactId: a.id,
              expectedBytes: a.expectedBytes,
              sha256: a.sha256,
              contentType: a.contentType,
              authorityExpiresAt: new Date(
                Math.min(
                  authority.staff.expiresAt.getTime(),
                  authority.source.claimExpiresAt!.getTime(),
                  authority.now.getTime() + 60_000,
                ),
              ),
            },
            a.uploadSession as unknown as SyncUploadSession | undefined,
          );
          await attachUploadSession(db, verified.deviceId, input, a.id, session, a.uploadSession);
          const grant = await storage.grantPart(
            session,
            input.partNumber ?? 1,
            input.partSha256 ?? a.sha256,
            new Date(
              Math.min(
                authority.staff.expiresAt.getTime(),
                authority.source.claimExpiresAt!.getTime(),
                authority.now.getTime() + 60_000,
              ),
            ),
          );
          await db.transaction((tx) =>
            authorizedSource(tx as DB, verified.deviceId, input, {
              requireFence: true,
              allowQuota: true,
            }),
          );
          result = { version: 1, artifactId: a.id, uploadSession: session, grant };
        }
      } else {
        const input = finalizeInput.parse(raw);
        const authority = await db.transaction((tx) =>
          authorizedSource(tx as DB, verified.deviceId, input, {
            requireFence: true,
            allowQuota: true,
          }),
        );
        const a = await ownedArtifact(db, input.sourceId, input.artifactId);
        if (!a.uploadSession) throw new SyncDeniedError();
        const storage = options.storage ?? new OutlookSyncStorage();
        const session = a.uploadSession as unknown as SyncUploadSession;
        if (a.acceptedAt && a.verifiedReceipt) {
          const receipt = await storage.verifyAcceptedReceipt(
            session,
            a.verifiedReceipt as unknown as SyncSealedArtifact,
          );
          result = await acceptArtifact(db, verified.deviceId, input, a.id, receipt);
        } else {
          let pending = finalizations.get(db);
          if (!pending) {
            pending = new Map();
            finalizations.set(db, pending);
          }
          const id = JSON.stringify([input.sourceId, a.id, session.attemptId, input.claimFence]);
          let work = pending.get(id);
          if (!work) {
            if (pending.size >= 100) throw new Error('Finalize capacity busy');
            work = (async () => {
              const controller = new AbortController();
              const expiresAt = Math.min(
                authority.source.authorityExpiresAt.getTime(),
                authority.staff.expiresAt.getTime(),
              );
              const expiry = setTimeout(
                () => controller.abort(new SyncDeniedError()),
                Math.max(0, expiresAt - Date.now()),
              );
              expiry.unref();
              let renewal: Promise<void> | undefined;
              const timer = setInterval(() => {
                if (renewal || controller.signal.aborted) return;
                renewal = renewFinalizationClaim(
                  db,
                  verified.deviceId,
                  input,
                  authority.source.claimOwner!,
                )
                  .then(() => undefined)
                  .catch((error) => {
                    controller.abort(error);
                  })
                  .finally(() => {
                    renewal = undefined;
                  });
              }, options.finalizeRenewalMs ?? 20_000);
              timer.unref();
              try {
                const sealed = await storage.seal(session, input.completedParts, controller.signal);
                controller.signal.throwIfAborted();
                return await acceptArtifact(db, verified.deviceId, input, a.id, sealed);
              } finally {
                clearInterval(timer);
                clearTimeout(expiry);
                await renewal;
              }
            })();
            pending.set(id, work);
            void work.finally(() => pending!.delete(id)).catch(() => undefined);
          }
          result = await work;
          // Every retry/joiner remains independently authorized, even if authority changed during shared work.
          await db.transaction((tx) =>
            authorizedSource(tx as DB, verified.deviceId, input, {
              requireFence: true,
              allowQuota: true,
            }),
          );
        }
      }
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (error instanceof SyncClaimBusyError)
        return Response.json(
          { code: 'SYNC_CLAIM_BUSY', retryable: true },
          { status: 409, headers: { 'cache-control': 'no-store', 'retry-after': '60' } },
        );
      if (error instanceof SyncQuotaError)
        return Response.json(
          { code: 'SYNC_QUOTA_EXCEEDED', retryable: true },
          { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': '60' } },
        );
      if (error instanceof SyncDeniedError)
        return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
      if (error instanceof z.ZodError) return new Response(null, { status: 400 });
      return Response.json(
        { code: 'SYNC_UNAVAILABLE' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
  };
}
