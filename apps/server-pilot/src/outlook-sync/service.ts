import {
  authenticatedStaff,
  authorizedSource,
  databaseNow,
  hashSyncSecret,
  requireRoot,
  requireStaffSession,
  SyncDeniedError,
  SyncClaimBusyError,
  type SyncAuth,
} from './authorization.js';
import {
  activateInput,
  controlInput,
  nativeActivateInput,
  nativeClaimInput,
  nativeLeaseInput,
  type SyncReadLeaseV1,
  type SyncStatusV1,
} from './contracts.js';
import {
  outlookSyncSource,
  outlookSyncScan,
  outlookSyncObservation,
} from '../db/schema/outlook-sync.js';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { wrappingKey } from '../outlook-security/device.js';
import { refreshSourceSummary } from './ledger.js';
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import type { z } from 'zod';

function protect(value: string, rawKey: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', wrappingKey(rawKey), iv);
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
function unprotect(value: string, rawKey: string) {
  const bytes = Buffer.from(value, 'base64'),
    cipher = createDecipheriv('aes-256-gcm', wrappingKey(rawKey), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}
export function onboardingBounds(at: Date, timezone = 'Africa/Johannesburg') {
  // Calendar arithmetic occurs in the hotel timezone, then converts back to UTC; month end clamps.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  const prev = new Date(Date.UTC(values.year, values.month - 2, 1)),
    year = prev.getUTCFullYear(),
    month = prev.getUTCMonth(),
    day = Math.min(values.day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  const wall = new Date(Date.UTC(year, month, day, values.hour, values.minute, values.second));
  const rendered = (date: Date) => {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const v = Object.fromEntries(p.map((a) => [a.type, Number(a.value)]));
    return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
  };
  let utc = wall.getTime();
  for (let i = 0; i < 3; i++) utc += wall.getTime() - rendered(new Date(utc));
  return { historyFrom: new Date(utc + at.getUTCMilliseconds()), historyTo: at, timezone };
}
function activationResponse(s: typeof outlookSyncSource.$inferSelect, key: string) {
  return {
    activationTicket: unprotect(s.activationTicketCiphertext, key),
    sourceId: s.id,
    historyFrom: s.historyFrom?.toISOString() ?? null,
    historyTo: s.historyTo?.toISOString() ?? null,
    expiresAt: s.activationExpiresAt.toISOString(),
  };
}
export async function activateSource(
  db: DB,
  auth: SyncAuth,
  headers: Headers,
  transportId: string,
  raw: z.infer<typeof activateInput>,
  key: string,
) {
  const input = activateInput.parse(raw);
  return db.transaction(async (tx) => {
    const t = tx as DB,
      staff = await authenticatedStaff(t, auth, headers),
      root = await requireRoot(t, { ...input, userId: staff.userId, transportId });
    // Advisory identity lock covers the first activation before a source row exists.
    await t.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.deviceId, transportId, input.storeId, input.rootEntryId])},0))`,
    );
    let [s] = await t
      .select()
      .from(outlookSyncSource)
      .where(
        and(
          eq(outlookSyncSource.deviceId, input.deviceId),
          eq(outlookSyncSource.transportId, transportId),
          eq(outlookSyncSource.storeId, input.storeId),
          eq(outlookSyncSource.rootEntryId, input.rootEntryId),
        ),
      )
      .for('update');
    const now = await databaseNow(t);
    if ((input.sourceId && s?.id !== input.sourceId) || (s && s.userId !== staff.userId))
      throw new SyncDeniedError();
    if (
      s &&
      s.activationKey === input.idempotencyKey &&
      s.sessionId === staff.sessionId &&
      s.activationExpiresAt > now
    )
      return activationResponse(s, key);
    if (s && s.activationKey === input.idempotencyKey) throw new SyncDeniedError();
    const ticket = randomBytes(32).toString('base64url'),
      expiresAt = new Date(Math.min(now.getTime() + 60_000, staff.expiresAt.getTime()));
    const binding = {
      sessionId: staff.sessionId,
      policyGeneration: root.policyGeneration,
      authorityExpiresAt: staff.expiresAt,
      activationKey: input.idempotencyKey,
      activationTicketHash: hashSyncSecret(ticket),
      activationTicketCiphertext: protect(ticket, key),
      activationExpiresAt: expiresAt,
      redeemedAt: null,
      handleHash: null,
      handleCiphertext: null,
      claimFence: (s?.claimFence ?? 0) + 1,
      claimOwner: null,
      claimExpiresAt: null,
      updatedAt: now,
    };
    if (s)
      [s] = await t
        .update(outlookSyncSource)
        .set(binding)
        .where(eq(outlookSyncSource.id, s.id))
        .returning();
    else
      [s] = await t
        .insert(outlookSyncSource)
        .values({
          id: randomUUID(),
          deviceId: input.deviceId,
          userId: staff.userId,
          transportId,
          storeId: input.storeId,
          rootEntryId: input.rootEntryId,
          ...binding,
        })
        .returning();
    return activationResponse(s, key);
  });
}
export async function redeemActivation(
  db: DB,
  deviceId: string,
  raw: z.infer<typeof nativeActivateInput>,
  key: string,
) {
  const input = nativeActivateInput.parse(raw);
  return db.transaction(async (tx) => {
    const t = tx as DB;
    let [s] = await t
      .select()
      .from(outlookSyncSource)
      .where(eq(outlookSyncSource.id, input.sourceId))
      .for('update');
    const now = await databaseNow(t);
    if (
      !s ||
      s.deviceId !== deviceId ||
      s.storeId !== input.storeId ||
      s.rootEntryId !== input.rootEntryId ||
      s.activationKey !== input.idempotencyKey ||
      s.activationTicketHash !== hashSyncSecret(input.activationTicket) ||
      s.activationExpiresAt <= now
    )
      throw new SyncDeniedError();
    const staff = await requireStaffSession(t, s.sessionId, s.userId);
    await requireRoot(t, s, s.policyGeneration);
    if (!s.redeemedAt) {
      const handle = randomBytes(32).toString('base64url'),
        bounds = s.captureStartedAt
          ? {}
          : { ...onboardingBounds(now, s.timezone), captureStartedAt: now, committedThrough: now };
      [s] = await t
        .update(outlookSyncSource)
        .set({
          ...bounds,
          handleHash: hashSyncSecret(handle),
          handleCiphertext: protect(handle, key),
          redeemedAt: now,
          status: s.userPaused ? 'paused' : 'running',
        })
        .where(eq(outlookSyncSource.id, s.id))
        .returning();
    }
    if (!s.handleCiphertext) throw new SyncDeniedError();
    return {
      version: 1 as const,
      sourceId: s.id,
      sourceHandle: unprotect(s.handleCiphertext, key),
      userPaused: s.userPaused,
      resourcePauseReason: s.resourcePauseReason,
      historyFrom: s.historyFrom!.toISOString(),
      historyTo: s.historyTo!.toISOString(),
      captureStartedAt: s.captureStartedAt!.toISOString(),
      timezone: s.timezone,
      expiresAt: new Date(
        Math.min(s.authorityExpiresAt.getTime(), staff.expiresAt.getTime()),
      ).toISOString(),
    };
  });
}
export async function claimSource(db: DB, deviceId: string, raw: z.infer<typeof nativeClaimInput>) {
  const input = nativeClaimInput.parse(raw);
  return db.transaction(async (tx) => {
    const t = tx as DB,
      { source: s, now, staff } = await authorizedSource(t, deviceId, input, { allowQuota: true });
    if (s.claimExpiresAt && s.claimExpiresAt > now && s.claimOwner !== input.workerId)
      throw new SyncClaimBusyError();
    const fence =
      s.claimOwner === input.workerId && s.claimExpiresAt && s.claimExpiresAt > now
        ? s.claimFence
        : s.claimFence + 1;
    const expiry = new Date(Math.min(now.getTime() + 60_000, staff.expiresAt.getTime()));
    await t
      .update(outlookSyncSource)
      .set({ claimFence: fence, claimOwner: input.workerId, claimExpiresAt: expiry })
      .where(eq(outlookSyncSource.id, s.id));
    return {
      version: 1 as const,
      sourceId: s.id,
      claimFence: fence,
      resourcePauseReason: s.resourcePauseReason,
      expiresAt: expiry.toISOString(),
    };
  });
}
export async function issueReadLease(
  db: DB,
  deviceId: string,
  raw: z.infer<typeof nativeLeaseInput>,
): Promise<SyncReadLeaseV1> {
  const input = nativeLeaseInput.parse(raw);
  return db.transaction(async (tx) => {
    const {
      source: s,
      now,
      staff,
    } = await authorizedSource(tx as DB, deviceId, input, { requireFence: true });
    return {
      version: 1,
      sourceId: s.id,
      storeId: s.storeId,
      rootEntryId: s.rootEntryId,
      policyGeneration: s.policyGeneration,
      claimFence: s.claimFence,
      expiresAt: new Date(
        Math.min(now.getTime() + 60_000, staff.expiresAt.getTime(), s.claimExpiresAt!.getTime()),
      ).toISOString(),
    };
  });
}
export async function controlSource(
  db: DB,
  auth: SyncAuth,
  headers: Headers,
  transportId: string,
  raw: z.infer<typeof controlInput>,
) {
  const input = controlInput.parse(raw);
  return db.transaction(async (tx) => {
    const t = tx as DB,
      staff = await authenticatedStaff(t, auth, headers);
    const [s] = await t
      .select()
      .from(outlookSyncSource)
      .where(eq(outlookSyncSource.id, input.sourceId))
      .for('update');
    if (!s || s.userId !== staff.userId || s.transportId !== transportId)
      throw new SyncDeniedError();
    await requireRoot(t, s);
    const now = await databaseNow(t);
    if (
      input.window &&
      (!s.historyFrom ||
        Date.parse(input.window.from) < s.historyFrom.getTime() ||
        Date.parse(input.window.to) > now.getTime() ||
        Date.parse(input.window.from) >= Date.parse(input.window.to))
    )
      throw new SyncDeniedError();
    const hash = hashSyncSecret(JSON.stringify([input.operation, input.window ?? null]));
    const key = `control:${input.idempotencyKey}`;
    const [prior] = await t
      .select()
      .from(outlookSyncScan)
      .where(and(eq(outlookSyncScan.sourceId, s.id), eq(outlookSyncScan.recordKey, key)));
    if (prior) {
      if (prior.checkpoint?.hash !== hash) throw new SyncDeniedError();
      return { accepted: true };
    }
    await t.insert(outlookSyncScan).values({
      id: randomUUID(),
      sourceId: s.id,
      recordKind: 'control',
      recordKey: key,
      mode: 'reconcile',
      from: now,
      to: now,
      claimFence: s.claimFence,
      checkpoint: { hash, operation: input.operation, window: input.window ?? null },
      status: 'committed',
    });
    if (s.userPaused && !['pause', 'resume'].includes(input.operation)) throw new SyncDeniedError();
    if (input.operation === 'retryMissing') {
      const retry = await t
        .select({ id: outlookSyncObservation.id })
        .from(outlookSyncObservation)
        .where(
          and(
            eq(outlookSyncObservation.sourceId, s.id),
            eq(outlookSyncObservation.ingestionState, 'attention'),
            sql`${outlookSyncObservation.errorCode} <> 'AMBIGUOUS_IDENTITY'`,
          ),
        )
        .limit(100);
      if (retry.length) {
        await t
          .update(outlookSyncObservation)
          .set({ availability: 'available', ingestionState: 'pending', errorCode: null })
          .where(sql`${outlookSyncObservation.id} = any(${retry.map((r) => r.id)}::text[])`);
        await refreshSourceSummary(
          t,
          s.id,
          retry.map((r) => r.id),
        );
      }
    }
    const paused =
      input.operation === 'pause' ? true : input.operation === 'resume' ? false : s.userPaused;
    await t
      .update(outlookSyncSource)
      .set({
        userPaused: paused,
        resourcePauseReason: null,
        status: paused
          ? 'paused'
          : s.sessionId === staff.sessionId
            ? 'running'
            : 'sign-in-required',
        claimFence: paused ? s.claimFence + 1 : s.claimFence,
        claimExpiresAt: paused ? null : s.claimExpiresAt,
        controlKey: input.idempotencyKey,
        controlHash: hash,
        updatedAt: now,
      })
      .where(eq(outlookSyncSource.id, s.id));
    return { accepted: true };
  });
}
export async function sourceStatus(
  db: DB,
  auth: SyncAuth,
  headers: Headers,
  transportId: string,
  sourceId: string,
): Promise<SyncStatusV1> {
  return db.transaction(async (tx) => {
    const t = tx as DB,
      staff = await authenticatedStaff(t, auth, headers),
      [s] = await t.select().from(outlookSyncSource).where(eq(outlookSyncSource.id, sourceId));
    if (!s || s.userId !== staff.userId || s.transportId !== transportId)
      throw new SyncDeniedError();
    await requireRoot(t, s);
    const now = await databaseNow(t);
    const gap = s.gapCount;
    return {
      version: 1,
      sourceId: s.id,
      state: s.userPaused
        ? 'paused'
        : (!s.handleHash && s.captureStartedAt) ||
            s.sessionId !== staff.sessionId ||
            s.authorityExpiresAt <= now
          ? 'sign-in-required'
          : s.resourcePauseReason || gap
            ? 'attention'
            : s.captureStartedAt
              ? 'running'
              : 'pending',
      capabilityRequirement: 'mailboxSync:1',
      historyFrom: s.historyFrom?.toISOString() ?? null,
      historyTo: s.historyTo?.toISOString() ?? null,
      timezone: s.timezone,
      captureStartedAt: s.captureStartedAt?.toISOString() ?? null,
      discoveredThrough: s.discoveredThrough?.toISOString() ?? null,
      committedThrough: s.committedThrough?.toISOString() ?? null,
      discovered: s.discoveredCount,
      retained: s.retainedCount,
      committed: s.committedCount,
      gaps: gap,
      history: s.historySummary,
      live: s.liveSummary,
      userPaused: s.userPaused,
      resourcePauseReason: s.resourcePauseReason,
    };
  });
}
/** Auth logout deletes the real session; this helper additionally fences grants immediately. Pane unmount never calls it. */
export async function invalidateSourceSession(db: DB, sessionId: string) {
  await db
    .update(outlookSyncSource)
    .set({
      status: 'sign-in-required',
      claimFence: sql`${outlookSyncSource.claimFence}+1`,
      claimExpiresAt: null,
      handleHash: null,
      handleCiphertext: null,
    })
    .where(eq(outlookSyncSource.sessionId, sessionId));
}
