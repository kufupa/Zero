import {
  outlookSyncSource as sourceTable,
  outlookSyncScan as scanTable,
  outlookSyncObservation as observationTable,
  outlookSyncArtifact as artifactTable,
} from '../db/schema/outlook-sync.js';
import {
  reservePendingArtifacts,
  releasePendingArtifact,
  reclaimExpiredReservations,
  renewArtifactReservation,
} from './quota.js';
import {
  nativeInventoryInput,
  syncManifestV1,
  type NativeSyncScope,
  type SyncManifestV1,
} from './contracts.js';
import { authorizedSource, databaseNow, hashSyncSecret, SyncDeniedError } from './authorization.js';
import type { SyncSealedArtifact, SyncUploadSession } from './storage.js';
import { assertExportEligible } from './eligibility.js';
import { createHash, randomUUID } from 'node:crypto';
import { SyncQuotaError } from './authorization.js';
import { isExportEligible } from './eligibility.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { reusableContent } from './content.js';
import type { DB } from '../db/client.js';
import type { z } from 'zod';

/** Persisted graph: source -> immutable interval scan -> bounded partition/page receipts + unique memberships.
 * Discovery does not imply coverage. All required immutable artifacts AND canonical ingestion must commit. */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );

export async function reuseObservationArtifacts(
  db: DB,
  deviceId: string,
  scope: NativeSyncScope,
  observationId: string,
  reuseObservationId: string,
) {
  return db.transaction(async (tx) => {
    const t = tx as DB,
      { source: s } = await authorizedSource(t, deviceId, scope, { requireFence: true });
    const [current] = await t
      .select()
      .from(observationTable)
      .where(and(eq(observationTable.id, observationId), eq(observationTable.sourceId, s.id)))
      .for('update');
    const [requested] = await t
      .select()
      .from(observationTable)
      .where(and(eq(observationTable.id, reuseObservationId), eq(observationTable.sourceId, s.id)))
      .for('update');
    if (!current || !requested || current.sourceObservationId !== requested.sourceObservationId)
      throw new SyncDeniedError();
    if (
      current.evidence.semanticReady === false ||
      requested.exportState !== 'retained' ||
      !isExportEligible(s, current) ||
      !reusableContent(current.evidence, requested.evidence)
    )
      return { reused: false };
    const originId = requested.artifactOrigin?.observationId ?? requested.id;
    const [origin] = await t
      .select()
      .from(observationTable)
      .where(and(eq(observationTable.id, originId), eq(observationTable.sourceId, s.id)))
      .for('update');
    if (
      !origin ||
      origin.artifactOrigin ||
      origin.sourceObservationId !== current.sourceObservationId ||
      !reusableContent(current.evidence, origin.evidence)
    )
      throw new SyncDeniedError();
    const artifacts = await t
      .select()
      .from(artifactTable)
      .where(eq(artifactTable.observationId, origin.id))
      .for('share');
    for (const role of current.requiredArtifactRoles) {
      const a = artifacts.filter((a) => a.role === role).sort((a, b) => b.version - a.version)[0];
      if (!a?.acceptedAt || !a.sealedKey || !a.uploadSession || !a.verifiedReceipt)
        return { reused: false };
      const session = a.uploadSession as unknown as SyncUploadSession,
        receipt = a.verifiedReceipt as unknown as SyncSealedArtifact;
      if (
        session.sourceId !== s.id ||
        session.observationId !== origin.id ||
        session.artifactId !== a.id ||
        session.expectedBytes !== a.expectedBytes ||
        session.sha256 !== a.sha256 ||
        receipt.key !== a.sealedKey ||
        receipt.bytes !== a.expectedBytes ||
        receipt.sha256 !== a.sha256
      )
        throw new SyncDeniedError();
    }
    const existing = await t
      .select({ id: artifactTable.id })
      .from(artifactTable)
      .where(eq(artifactTable.observationId, current.id))
      .limit(1);
    if (existing.length) return { reused: false };
    await t
      .update(observationTable)
      .set({
        artifactOrigin: { sourceId: s.id, observationId: origin.id },
        exportState: 'retained',
      })
      .where(eq(observationTable.id, current.id));
    await refreshSourceSummary(t, s.id, [current.id]);
    return { reused: true };
  });
}
export async function refreshSourceSummary(db: DB, sourceId: string, affectedIds?: string[]) {
  const [source] = await db
    .select()
    .from(sourceTable)
    .where(eq(sourceTable.id, sourceId))
    .for('update');
  if (!source) throw new SyncDeniedError();
  const rows = await db
    .select()
    .from(observationTable)
    .where(
      and(
        eq(observationTable.sourceId, sourceId),
        affectedIds
          ? inArray(observationTable.id, affectedIds)
          : eq(observationTable.summaryDirty, true),
      ),
    )
    .limit(100)
    .for('update');
  const history = { ...source.historySummary },
    live = { ...source.liveSummary };
  let discovered = source.discoveredCount,
    retained = source.retainedCount,
    committed = source.committedCount,
    gaps = source.gapCount;
  const scans = new Set<string>();
  for (const o of rows) {
    const members = await db
      .select()
      .from(scanTable)
      .where(and(eq(scanTable.observationId, o.id), eq(scanTable.recordKind, 'membership')));
    const parents = members.length
      ? await db
          .select()
          .from(scanTable)
          .where(
            inArray(
              scanTable.id,
              members.map((m) => m.parentId!),
            ),
          )
      : [];
    const next = {
        history: parents.some((p) => p.mode === 'history'),
        eligible: isExportEligible(source, o),
        retained: o.exportState === 'retained',
        committed: o.ingestionState === 'committed',
        gap: o.availability !== 'available' || o.ingestionState === 'attention',
      },
      old = o.summaryCache;
    if (!next.eligible && o.exportState !== 'retained')
      await db
        .update(observationTable)
        .set({ exportState: 'excluded', ingestionState: 'excluded' })
        .where(eq(observationTable.id, o.id));
    const apply = (
      summary: typeof live,
      value: Omit<typeof next, 'eligible'> & { eligible?: boolean },
      sign: number,
    ) => {
      summary.discovered += sign * Number(value.eligible ?? true);
      summary.retained += sign * Number(value.retained);
      summary.committed += sign * Number(value.committed);
      summary.gaps += sign * Number(value.gap);
    };
    if (old) apply(old.history ? history : live, old, -1);
    else discovered++;
    discovered += Number(next.eligible) - Number(old?.eligible ?? true);
    apply(next.history ? history : live, next, 1);
    retained += Number(next.retained) - Number(old?.retained ?? false);
    committed += Number(next.committed) - Number(old?.committed ?? false);
    gaps += Number(next.gap) - Number(old?.gap ?? false);
    await db
      .update(observationTable)
      .set({ summaryCache: next, summaryDirty: false })
      .where(eq(observationTable.id, o.id));
    for (const m of members) {
      const prior = m.checkpoint ?? {},
        countEligible = next.eligible,
        de = Number(countEligible) - Number(prior.eligible ?? true),
        countCommitted = next.committed && next.retained && !next.gap,
        dc = Number(countCommitted) - Number(prior.committed ?? false),
        dg = Number(next.gap) - Number(prior.gap ?? false);
      await db
        .update(scanTable)
        .set({ checkpoint: { committed: countCommitted, gap: next.gap, eligible: countEligible } })
        .where(eq(scanTable.id, m.id));
      if (dc || dg || de)
        await db
          .update(scanTable)
          .set({
            discoveredCount: sql`${scanTable.discoveredCount}+${de}`,
            committedCount: sql`${scanTable.committedCount}+${dc}`,
            gapCount: sql`${scanTable.gapCount}+${dg}`,
          })
          .where(eq(scanTable.id, m.parentId!));
      scans.add(m.parentId!);
    }
  }
  await db
    .update(sourceTable)
    .set({
      historySummary: history,
      liveSummary: live,
      discoveredCount: discovered,
      retainedCount: retained,
      committedCount: committed,
      gapCount: gaps,
    })
    .where(eq(sourceTable.id, sourceId));
  for (const scanId of scans) await recomputeScan(db, scanId);
}
async function recomputeScan(db: DB, scanId: string) {
  const [scan] = await db.select().from(scanTable).where(eq(scanTable.id, scanId)).for('update');
  if (!scan) throw new SyncDeniedError();
  const partitions = await db
    .select({ checkpoint: scanTable.checkpoint })
    .from(scanTable)
    .where(and(eq(scanTable.parentId, scanId), eq(scanTable.recordKind, 'partition')));
  const gaps = scan.gapCount,
    discovered = scan.discoveredCount,
    committed = scan.committedCount,
    complete =
      scan.discoveryComplete &&
      partitions.every((p) => p.checkpoint?.complete === true) &&
      gaps === 0 &&
      committed === discovered;
  const status = complete ? 'committed' : scan.discoveryComplete ? 'discovered' : 'discovering';
  await db
    .update(scanTable)
    .set({ discoveredCount: discovered, committedCount: committed, gapCount: gaps, status })
    .where(eq(scanTable.id, scanId));
  if (scan.discoveryComplete) {
    await db
      .update(sourceTable)
      .set({
        discoveredThrough: sql`greatest(${sourceTable.discoveredThrough},${scan.to.toISOString()}::timestamp)`,
      })
      .where(eq(sourceTable.id, scan.sourceId));
  }
  if (complete && scan.mode !== 'history') {
    // Coverage advances only across a contiguous interval, never from the greatest message Date.
    await db
      .update(sourceTable)
      .set({
        committedThrough: sql`greatest(${sourceTable.committedThrough},${scan.to.toISOString()}::timestamp)`,
      })
      .where(
        and(
          eq(sourceTable.id, scan.sourceId),
          sql`${sourceTable.committedThrough} >= ${scan.from.toISOString()}::timestamp`,
        ),
      );
  }
}
export async function scanSummary(db: DB, scanId: string) {
  const [s] = await db.select().from(scanTable).where(eq(scanTable.id, scanId));
  if (!s) throw new SyncDeniedError();
  return {
    scanId: s.id,
    status: s.status,
    discoveredCount: s.discoveredCount,
    committedCount: s.committedCount,
    gapCount: s.gapCount,
  };
}
async function inventoryResponse(
  db: DB,
  scanId: string,
  input: z.infer<typeof nativeInventoryInput>,
) {
  const observations = [];
  for (const o of input.observations) {
    const [row] = await db
      .select({ id: observationTable.id })
      .from(observationTable)
      .where(
        and(
          eq(observationTable.sourceId, input.sourceId),
          eq(observationTable.sourceObservationId, o.sourceObservationId),
          eq(observationTable.semanticVersion, o.semanticVersion),
        ),
      );
    if (row)
      observations.push({
        sourceObservationId: o.sourceObservationId,
        semanticVersion: o.semanticVersion,
        observationId: row.id,
      });
  }
  return { ...(await scanSummary(db, scanId)), observations };
}
export async function recordInventory(
  db: DB,
  deviceId: string,
  raw: z.infer<typeof nativeInventoryInput>,
) {
  const input = nativeInventoryInput.parse(raw);
  return db.transaction(async (tx) => {
    const t = tx as DB,
      { source: s, now } = await authorizedSource(t, deviceId, input, { requireFence: true }),
      from = new Date(input.scan.from),
      to = new Date(input.scan.to);
    if (
      !s.historyFrom ||
      !s.historyTo ||
      from < s.historyFrom ||
      to > now ||
      from > to ||
      (input.scan.mode === 'history' &&
        (from.getTime() !== s.historyFrom.getTime() || to.getTime() !== s.historyTo.getTime()))
    )
      throw new SyncDeniedError();
    let scan: typeof scanTable.$inferSelect | undefined;
    if (input.scan.id) {
      [scan] = await t
        .select()
        .from(scanTable)
        .where(
          and(
            eq(scanTable.id, input.scan.id),
            eq(scanTable.sourceId, s.id),
            eq(scanTable.recordKind, 'scan'),
          ),
        )
        .for('update');
    } else {
      [scan] = await t
        .select()
        .from(scanTable)
        .where(
          and(
            eq(scanTable.sourceId, s.id),
            eq(scanTable.recordKind, 'scan'),
            inArray(scanTable.status, ['pending', 'discovering']),
          ),
        )
        .for('update');
    }
    if (
      scan &&
      (scan.mode !== input.scan.mode ||
        scan.from.getTime() !== from.getTime() ||
        scan.to.getTime() !== to.getTime())
    )
      throw new SyncDeniedError();
    if (input.scan.id && !scan) throw new SyncDeniedError();
    if (!scan) {
      const id = randomUUID();
      [scan] = await t
        .insert(scanTable)
        .values({
          id,
          sourceId: s.id,
          recordKey: `scan:${id}`,
          mode: input.scan.mode,
          from,
          to,
          claimFence: s.claimFence,
          status: 'discovering',
        })
        .returning();
    }
    const pageKey = `page:${scan.id}:${hashSyncSecret(input.partitionId)}:${hashSyncSecret(input.pageId)}`,
      payloadHash = hashSyncSecret(
        JSON.stringify([input.checkpoint, input.observations, input.discoveryComplete]),
      );
    const [prior] = await t
      .select()
      .from(scanTable)
      .where(and(eq(scanTable.sourceId, s.id), eq(scanTable.recordKey, pageKey)));
    if (prior) {
      if (prior.checkpoint?.payloadHash !== payloadHash) throw new SyncDeniedError();
      return inventoryResponse(t, scan.id, input);
    }
    if (scan.status === 'committed') throw new SyncDeniedError();
    const partitionKey = `partition:${scan.id}:${hashSyncSecret(input.partitionId)}`;
    const [oldPartition] = await t
      .select()
      .from(scanTable)
      .where(and(eq(scanTable.sourceId, s.id), eq(scanTable.recordKey, partitionKey)));
    const gapDelta =
      Number(Boolean(input.checkpoint.gapCode)) -
      Number(Boolean(oldPartition?.checkpoint?.gapCode));
    if (gapDelta) {
      await t
        .update(scanTable)
        .set({ gapCount: sql`${scanTable.gapCount}+${gapDelta}` })
        .where(eq(scanTable.id, scan.id));
      await t
        .update(sourceTable)
        .set({ gapCount: sql`${sourceTable.gapCount}+${gapDelta}` })
        .where(eq(sourceTable.id, s.id));
    }
    await t
      .insert(scanTable)
      .values({
        id: randomUUID(),
        sourceId: s.id,
        parentId: scan.id,
        recordKind: 'partition',
        recordKey: partitionKey,
        mode: scan.mode,
        from,
        to,
        claimFence: s.claimFence,
        checkpoint: input.checkpoint,
      })
      .onConflictDoUpdate({
        target: [scanTable.sourceId, scanTable.recordKey],
        set: { checkpoint: input.checkpoint, claimFence: s.claimFence },
      });
    for (const o of input.observations) {
      if (
        o.locator.storeId !== s.storeId ||
        o.locator.rootEntryId !== s.rootEntryId ||
        o.event.isUnsent
      )
        throw new SyncDeniedError();
      let [obs] = await t
        .insert(observationTable)
        .values({
          id: randomUUID(),
          sourceId: s.id,
          sourceObservationId: o.sourceObservationId,
          semanticVersion: o.semanticVersion,
          evidence: o,
          availability: o.availability,
          direction: o.direction,
          requiredArtifactRoles: o.requiredArtifactRoles,
        })
        .onConflictDoNothing()
        .returning();
      if (!obs) {
        [obs] = await t
          .select()
          .from(observationTable)
          .where(
            and(
              eq(observationTable.sourceId, s.id),
              eq(observationTable.sourceObservationId, o.sourceObservationId),
              eq(observationTable.semanticVersion, o.semanticVersion),
            ),
          );
        if (JSON.stringify(obs.evidence) !== JSON.stringify(o)) {
          // Rediscovery may add observation timestamps/event hints but cannot change versioned semantic identity.
          const old = obs.evidence as unknown as z.infer<
            typeof import('./contracts.js').syncObservationV1
          >;
          if (
            o.semanticReady &&
            stableJson([old.semantic, old.requiredArtifactRoles]) !==
              stableJson([o.semantic, o.requiredArtifactRoles])
          )
            throw new SyncDeniedError();
          await t
            .update(observationTable)
            .set({ evidence: { ...old, locator: o.locator } })
            .where(eq(observationTable.id, obs.id));
        }
      }
      const [membership] = await t
        .insert(scanTable)
        .values({
          id: randomUUID(),
          sourceId: s.id,
          parentId: scan.id,
          recordKind: 'membership',
          recordKey: `member:${scan.id}:${obs.id}`,
          mode: scan.mode,
          from,
          to,
          claimFence: s.claimFence,
          observationId: obs.id,
        })
        .onConflictDoNothing()
        .returning();
      if (membership)
        await t
          .update(scanTable)
          .set({ discoveredCount: sql`${scanTable.discoveredCount}+1` })
          .where(eq(scanTable.id, scan.id));
      await t
        .update(observationTable)
        .set({ summaryDirty: true })
        .where(eq(observationTable.id, obs.id));
    }
    await t.insert(scanTable).values({
      id: randomUUID(),
      sourceId: s.id,
      parentId: scan.id,
      recordKind: 'page',
      recordKey: pageKey,
      mode: scan.mode,
      from,
      to,
      claimFence: s.claimFence,
      checkpoint: { payloadHash, ...input.checkpoint },
      status: 'committed',
    });
    await t
      .update(scanTable)
      .set({
        claimFence: s.claimFence,
        discoveryComplete: scan.discoveryComplete || input.discoveryComplete,
      })
      .where(eq(scanTable.id, scan.id));
    if (input.discoveryComplete && scan.mode === 'history') {
      const [ss] = await t.select().from(sourceTable).where(eq(sourceTable.id, s.id));
      await t
        .update(sourceTable)
        .set({ historySummary: { ...ss.historySummary, discoveryComplete: true } })
        .where(eq(sourceTable.id, s.id));
    }
    await refreshSourceSummary(t, s.id);
    await recomputeScan(t, scan.id);
    return inventoryResponse(t, scan.id, input);
  });
}
export async function prepareArtifacts(
  db: DB,
  deviceId: string,
  scope: NativeSyncScope,
  raw: SyncManifestV1,
) {
  const manifest = syncManifestV1.parse(raw);
  const outcome = await db.transaction(async (tx) => {
    const t = tx as DB,
      { source: s } = await authorizedSource(t, deviceId, scope, {
        requireFence: true,
        allowQuota: true,
      });
    const [obs] = await t
      .select()
      .from(observationTable)
      .where(
        and(eq(observationTable.id, manifest.observationId), eq(observationTable.sourceId, s.id)),
      )
      .for('update');
    if (
      !obs ||
      obs.evidence.semanticReady === false ||
      obs.semanticVersion !== manifest.semanticVersion
    )
      throw new SyncDeniedError();
    assertExportEligible(s, obs);
    await reclaimExpiredReservations(t, s.id);
    const [quotaSource] = await t.select().from(sourceTable).where(eq(sourceTable.id, s.id));
    const existing = await t
      .select()
      .from(artifactTable)
      .where(eq(artifactTable.observationId, obs.id));
    if (
      !(await reservePendingArtifacts(
        t,
        quotaSource,
        manifest.artifacts.filter(
          (a) =>
            !existing.some(
              (row) =>
                row.role === a.role &&
                row.version === a.version &&
                (row.quotaReserved || row.acceptedAt),
            ),
        ),
      ))
    )
      return { quota: true as const };
    const result = [];
    for (const a of manifest.artifacts) {
      if (!obs.requiredArtifactRoles.includes(a.role) || a.availability !== 'available')
        throw new SyncDeniedError();
      let [row] = await t
        .insert(artifactTable)
        .values({
          id: randomUUID(),
          observationId: obs.id,
          role: a.role,
          version: a.version,
          expectedBytes: a.sizeBytes,
          sha256: a.sha256,
          contentType: a.contentType,
          metadata: a,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        [row] = await t
          .select()
          .from(artifactTable)
          .where(
            and(
              eq(artifactTable.observationId, obs.id),
              eq(artifactTable.role, a.role),
              eq(artifactTable.version, a.version),
            ),
          );
        if (
          row.expectedBytes !== a.sizeBytes ||
          row.sha256 !== a.sha256 ||
          row.contentType !== a.contentType
        )
          throw new SyncDeniedError();
      }
      if (!row.quotaReserved && !row.acceptedAt) {
        [row] = await t
          .update(artifactTable)
          .set({
            quotaReserved: true,
            reservationExpiresAt: sql`clock_timestamp()+interval '7 days'`,
          })
          .where(eq(artifactTable.id, row.id))
          .returning();
      }
      result.push(row);
    }
    return { artifacts: result };
  });
  if ('quota' in outcome) throw new SyncQuotaError();
  return outcome.artifacts;
}
export async function ownedArtifact(db: DB, sourceId: string, artifactId: string) {
  const [row] = await db
    .select({ artifact: artifactTable })
    .from(artifactTable)
    .innerJoin(observationTable, eq(observationTable.id, artifactTable.observationId))
    .where(and(eq(artifactTable.id, artifactId), eq(observationTable.sourceId, sourceId)))
    .limit(1);
  if (!row) throw new SyncDeniedError();
  return row.artifact;
}
export async function attachUploadSession(
  db: DB,
  deviceId: string,
  scope: NativeSyncScope,
  artifactId: string,
  session: SyncUploadSession,
  prior?: Record<string, unknown> | null,
) {
  const outcome = await db.transaction(async (tx) => {
    const t = tx as DB;
    await authorizedSource(t, deviceId, scope, { requireFence: true, allowQuota: true });
    const a = await ownedArtifact(t, scope.sourceId, artifactId);
    if (
      session.sourceId !== scope.sourceId ||
      session.artifactId !== a.id ||
      session.observationId !== a.observationId ||
      session.expectedBytes !== a.expectedBytes ||
      session.sha256 !== a.sha256
    )
      throw new SyncDeniedError();
    if (
      a.uploadSession &&
      stableJson(a.uploadSession) !== stableJson(session) &&
      stableJson(a.uploadSession) !== stableJson(prior ?? null)
    )
      throw new SyncDeniedError();
    if (!(await renewArtifactReservation(t, scope.sourceId, a.id))) return { quota: true as const };
    await t
      .update(artifactTable)
      .set({
        uploadSession: session as unknown as Record<string, unknown>,
        stagingKey: session.stagingKey,
      })
      .where(eq(artifactTable.id, a.id));
    return { session };
  });
  if ('quota' in outcome) throw new SyncQuotaError();
  return outcome.session;
}
export async function acceptArtifact(
  db: DB,
  deviceId: string,
  scope: NativeSyncScope,
  artifactId: string,
  sealed: SyncSealedArtifact,
) {
  return db.transaction(async (tx) => {
    const t = tx as DB;
    await authorizedSource(t, deviceId, scope, { requireFence: true, allowQuota: true });
    const a = await ownedArtifact(t, scope.sourceId, artifactId);
    if (
      a.expectedBytes !== sealed.bytes ||
      a.sha256 !== sealed.sha256 ||
      sealed.key !==
        `outlook-sync-originals/v1/${createHash('sha256')
          .update(JSON.stringify([scope.sourceId, a.observationId, a.id]))
          .digest('hex')}/${a.sha256}`
    )
      throw new SyncDeniedError();
    if (a.sealedKey && a.sealedKey !== sealed.key) throw new SyncDeniedError();
    await releasePendingArtifact(t, scope.sourceId, a);
    const now = await databaseNow(t);
    await t
      .update(artifactTable)
      .set({
        sealedKey: sealed.key,
        verifiedReceipt: sealed as unknown as Record<string, unknown>,
        acceptedAt: a.acceptedAt ?? now,
      })
      .where(eq(artifactTable.id, a.id));
    await refreshObservation(t, a.observationId);
    return {
      version: 1 as const,
      sourceId: scope.sourceId,
      observationId: a.observationId,
      artifactId: a.id,
      role: a.role,
      sealedKey: sealed.key,
      sizeBytes: sealed.bytes,
      sha256: sealed.sha256,
      acceptedAt: (a.acceptedAt ?? now).toISOString(),
      ingestionState: a.ingestionState,
    };
  });
}
async function refreshObservation(db: DB, id: string) {
  const [o] = await db
    .select()
    .from(observationTable)
    .where(eq(observationTable.id, id))
    .for('update');
  const artifacts = await db
    .select()
    .from(artifactTable)
    .where(eq(artifactTable.observationId, o.artifactOrigin?.observationId ?? id));
  const retained =
    o.requiredArtifactRoles.length > 0 &&
    o.requiredArtifactRoles.every((role) =>
      artifacts.some((a) => a.role === role && a.sealedKey && a.acceptedAt),
    );
  await db
    .update(observationTable)
    .set({ exportState: retained ? 'retained' : 'pending' })
    .where(eq(observationTable.id, id));
  await refreshSourceSummary(db, o.sourceId, [id]);
}
/** Server-owned drain may finish already sealed work after staff logout; it mints no read/upload grants. */
export async function markObservationIngested(
  db: DB,
  observationId: string,
  canonicalMessageId: string,
  attention = false,
) {
  return db.transaction(async (tx) => {
    const t = tx as DB;
    const [owner] = await t
      .select({ sourceId: observationTable.sourceId })
      .from(observationTable)
      .where(eq(observationTable.id, observationId));
    if (!owner) throw new SyncDeniedError();
    await t.select().from(sourceTable).where(eq(sourceTable.id, owner.sourceId)).for('update');
    const [o] = await t
      .select()
      .from(observationTable)
      .where(eq(observationTable.id, observationId))
      .for('update');
    if (!o || o.exportState !== 'retained') throw new SyncDeniedError();
    await t
      .update(observationTable)
      .set({ ingestionState: attention ? 'attention' : 'committed', canonicalMessageId })
      .where(eq(observationTable.id, o.id));
    await t
      .update(artifactTable)
      .set({ ingestionState: 'committed' })
      .where(eq(artifactTable.observationId, o.id));
    await refreshObservation(t, o.id);
  });
}

export async function pendingObservations(db: DB, deviceId: string, scope: NativeSyncScope) {
  return db.transaction(async (tx) => {
    const t = tx as DB,
      { source: s } = await authorizedSource(t, deviceId, scope, { requireFence: true });
    const history = await t
      .select({ id: scanTable.id, complete: scanTable.discoveryComplete })
      .from(scanTable)
      .where(
        and(
          eq(scanTable.sourceId, s.id),
          eq(scanTable.recordKind, 'scan'),
          eq(scanTable.mode, 'history'),
        ),
      )
      .limit(1);
    const ready = history.length > 0 && history[0].complete;
    const remainingMetadata = ready
      ? await t.execute(
          sql`select 1 from outlook_sync_observation o join outlook_sync_scan m on m.observation_id=o.id join outlook_sync_scan sc on sc.id=m.parent_id where o.source_id=${s.id} and m.record_kind='membership' and sc.mode='history' and o.export_state not in ('retained','excluded') and o.availability in ('available','unknown-date') and o.evidence->>'semanticReady'='false' limit 1`,
        )
      : [];
    const enrichingHistory = remainingMetadata.length > 0;
    // Global metadata ordering is server-owned; native keeps only this bounded page of references.
    const rows = await t.execute(
      sql`select o.id,o.semantic_version,o.evidence, ((o.evidence->>'semanticReady')='false' and (o.evidence->'event'->>'kind')='inventory' and not exists(select 1 from outlook_sync_scan m join outlook_sync_scan sc on sc.id=m.parent_id where m.observation_id=o.id and m.record_kind='membership' and sc.mode<>'history')) as metadata_only from outlook_sync_observation o where o.source_id=${s.id} and o.export_state not in ('retained','excluded') and ((o.evidence->>'semanticReady')='false' or coalesce(case when o.direction='outbound' then o.evidence->'timestamps'->>'sentAt' when o.direction='inbound' then o.evidence->'timestamps'->>'receivedAt' else coalesce(o.evidence->'timestamps'->>'receivedAt',o.evidence->'timestamps'->>'sentAt') end,'')='' or (case when o.direction='outbound' then o.evidence->'timestamps'->>'sentAt' when o.direction='inbound' then o.evidence->'timestamps'->>'receivedAt' else coalesce(o.evidence->'timestamps'->>'receivedAt',o.evidence->'timestamps'->>'sentAt') end)::timestamptz >= ${s.historyFrom?.toISOString() ?? new Date().toISOString()}::timestamptz) and o.availability in ('available','unknown-date') and (not ${enrichingHistory} or (o.evidence->>'semanticReady')='false' or (o.evidence->'event'->>'kind')<>'inventory' or exists(select 1 from outlook_sync_scan m join outlook_sync_scan sc on sc.id=m.parent_id where m.observation_id=o.id and m.record_kind='membership' and sc.mode<>'history')) and (${ready} or (o.evidence->'event'->>'kind') <> 'inventory' or exists (select 1 from outlook_sync_scan m join outlook_sync_scan sc on sc.id=m.parent_id where m.observation_id=o.id and m.record_kind='membership' and sc.mode<>'history')) order by case when (o.evidence->'event'->>'kind') in ('new-mail','saved-sent') then 0 else 1 end, coalesce(case when o.direction='outbound' then o.evidence->'timestamps'->>'sentAt' else o.evidence->'timestamps'->>'receivedAt' end,o.evidence->'timestamps'->>'createdAt','') desc, o.source_observation_id asc limit 100`,
    );
    return {
      version: 1 as const,
      historyDiscoveryReady: ready,
      items: (() => {
        const items = [];
        let bytes = 128;
        for (const row of rows) {
          const item = {
            observationId: String(row.id),
            metadataOnly: row.metadata_only === true,
            semanticVersion: Number(row.semantic_version),
            observation: row.evidence as unknown as import('./contracts.js').SyncObservationV1,
          };
          const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
          if (bytes + size > 1_048_000) break;
          items.push(item);
          bytes += size;
        }
        return items;
      })(),
    };
  });
}

export async function recordLiveHint(
  db: DB,
  deviceId: string,
  scope: NativeSyncScope,
  raw: import('./contracts.js').SyncObservationV1,
) {
  const { syncObservationV1 } = await import('./contracts.js');
  const o = syncObservationV1.parse(raw);
  return db.transaction(async (tx) => {
    const t = tx as DB,
      { source: s } = await authorizedSource(t, deviceId, scope, { requireFence: true });
    if (
      o.locator.storeId !== s.storeId ||
      o.locator.rootEntryId !== s.rootEntryId ||
      o.event.isUnsent ||
      !['new-mail', 'saved-sent', 'folder-hint'].includes(o.event.kind)
    )
      throw new SyncDeniedError();
    let [obs] = await t
      .insert(observationTable)
      .values({
        id: randomUUID(),
        sourceId: s.id,
        sourceObservationId: o.sourceObservationId,
        semanticVersion: o.semanticVersion,
        evidence: o,
        availability: o.availability,
        direction: o.direction,
        requiredArtifactRoles: o.requiredArtifactRoles,
      })
      .onConflictDoNothing()
      .returning();
    if (!obs) {
      [obs] = await t
        .select()
        .from(observationTable)
        .where(
          and(
            eq(observationTable.sourceId, s.id),
            eq(observationTable.sourceObservationId, o.sourceObservationId),
            eq(observationTable.semanticVersion, o.semanticVersion),
          ),
        );
      const old = obs.evidence as unknown as import('./contracts.js').SyncObservationV1;
      const metadataUpgrade =
        old.semanticReady === false && old.event.kind === 'inventory' && o.semanticReady;
      if (metadataUpgrade) {
        // Discovery can win the race with a full live hint. Only an unexported
        // metadata stub may acquire its semantic projection and arrival evidence.
        const declared = await t
          .select({ id: artifactTable.id })
          .from(artifactTable)
          .where(eq(artifactTable.observationId, obs.id))
          .limit(1);
        if (declared.length) throw new SyncDeniedError();
        await t
          .update(observationTable)
          .set({
            evidence: o,
            availability: o.availability,
            direction: o.direction,
            requiredArtifactRoles: o.requiredArtifactRoles,
            exportState: 'pending',
            ingestionState: 'pending',
            errorCode: null,
          })
          .where(eq(observationTable.id, obs.id));
      } else {
        if (
          stableJson([old.semantic, old.requiredArtifactRoles]) !==
          stableJson([o.semantic, o.requiredArtifactRoles])
        )
          throw new SyncDeniedError();
        if (old.event.kind === 'inventory')
          await t
            .update(observationTable)
            .set({
              evidence: o,
              ingestionState: obs.ingestionState === 'committed' ? 'pending' : obs.ingestionState,
            })
            .where(eq(observationTable.id, obs.id));
      }
    }
    await refreshSourceSummary(t, s.id, [obs.id]);
    return {
      sourceObservationId: o.sourceObservationId,
      semanticVersion: o.semanticVersion,
      observationId: obs.id,
    };
  });
}
export async function reportObservationGap(
  db: DB,
  deviceId: string,
  scope: NativeSyncScope,
  observationId: string,
  availability: 'missing' | 'protected' | 'unsupported',
  gapCode: string,
) {
  return db.transaction(async (tx) => {
    const t = tx as DB;
    await authorizedSource(t, deviceId, scope, { requireFence: true });
    const [o] = await t
      .select()
      .from(observationTable)
      .where(
        and(eq(observationTable.id, observationId), eq(observationTable.sourceId, scope.sourceId)),
      )
      .for('update');
    if (!o || o.exportState === 'retained') throw new SyncDeniedError();
    await t
      .update(observationTable)
      .set({ availability, errorCode: gapCode, ingestionState: 'attention' })
      .where(eq(observationTable.id, o.id));
    await refreshObservation(t, o.id);
    return { accepted: true };
  });
}

export async function enrichObservation(
  db: DB,
  deviceId: string,
  scope: NativeSyncScope,
  observationId: string,
  raw: import('./contracts.js').SyncObservationV1,
) {
  const { syncObservationV1 } = await import('./contracts.js');
  const full = syncObservationV1.parse(raw);
  return db.transaction(async (tx) => {
    const t = tx as DB,
      { source: s } = await authorizedSource(t, deviceId, scope, { requireFence: true });
    const [o] = await t
      .select()
      .from(observationTable)
      .where(and(eq(observationTable.id, observationId), eq(observationTable.sourceId, s.id)))
      .for('update');
    if (
      !o ||
      !full.semanticReady ||
      full.sourceObservationId !== o.sourceObservationId ||
      full.locator.storeId !== s.storeId ||
      full.locator.rootEntryId !== s.rootEntryId ||
      full.event.isUnsent
    )
      throw new SyncDeniedError();
    const prior = syncObservationV1.parse(o.evidence);
    if (prior.semanticReady) {
      if (stableJson(prior) !== stableJson(full)) throw new SyncDeniedError();
      return {
        accepted: true,
        observationId: o.id,
        semanticVersion: o.semanticVersion,
        exportEligible: isExportEligible(s, o),
      };
    }
    const declared = await t
      .select({ id: artifactTable.id })
      .from(artifactTable)
      .where(eq(artifactTable.observationId, o.id))
      .limit(1);
    if (declared.length) throw new SyncDeniedError();
    await t
      .update(observationTable)
      .set({
        semanticVersion: full.semanticVersion,
        evidence: full,
        availability: full.availability,
        direction: full.direction,
        requiredArtifactRoles: full.requiredArtifactRoles,
      })
      .where(eq(observationTable.id, o.id));
    await refreshSourceSummary(t, s.id, [o.id]);
    return {
      accepted: true,
      observationId: o.id,
      semanticVersion: full.semanticVersion,
      exportEligible: isExportEligible(s, { evidence: full }),
    };
  });
}
