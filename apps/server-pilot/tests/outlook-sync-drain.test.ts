import {
  recordInventory,
  recordLiveHint,
  prepareArtifacts,
  attachUploadSession,
  acceptArtifact,
} from '../src/outlook-sync/ledger.js';
import {
  OutlookSyncStorage,
  type SyncSealedArtifact,
  type SyncUploadSession,
} from '../src/outlook-sync/storage.js';
import {
  outlookSyncArtifact,
  outlookSyncObservation,
  outlookSyncSource,
} from '../src/db/schema/outlook-sync.js';
import {
  claimSyncIngestion,
  ingestClaimedObservation,
  runSyncDrainPass,
} from '../src/outlook-sync/drain.js';
import { activateSource, redeemActivation, claimSource } from '../src/outlook-sync/service.js';
import { message, mailLiveAdmission, attachment } from '../src/db/schema/mail.js';
import { buildOutlookHistoryInput } from '../src/outlook-sync/ingest.js';
import { outlookSyncFixture } from './helpers/outlook-sync-fixture.js';
import { session as staffSession } from '../src/db/schema/auth.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
class Artifacts {
  bytes = new Map<string, Buffer>();
  unavailable = false;
  beforeRead?: () => Promise<void>;
  async verifyReceipt(_session: SyncUploadSession, receipt: SyncSealedArtifact) {
    await this.beforeRead?.();
    this.beforeRead = undefined;
    if (this.unavailable) throw new Error('storage offline');
    const body = this.bytes.get(receipt.key);
    if (!body || sha(body) !== receipt.sha256 || body.length !== receipt.bytes)
      throw new Error('checksum mismatch');
    return receipt;
  }
  async readSealedBounded(receipt: SyncSealedArtifact, max: number) {
    await this.verifyReceipt({} as SyncUploadSession, receipt);
    const body = this.bytes.get(receipt.key)!;
    if (body.length > max) throw new Error('size exceeded');
    return body;
  }
}
async function accepted(
  db: any,
  options: {
    live?: boolean;
    direction?: 'inbound' | 'outbound' | 'unknown';
    missing?: boolean;
  } = {},
) {
  const f = await outlookSyncFixture(db),
    activated = await activateSource(db, f.auth, new Headers(), f.transportId, f.activation, f.key);
  const r = await redeemActivation(
    db,
    f.deviceId,
    {
      version: 1,
      sourceId: activated.sourceId,
      activationTicket: activated.activationTicket,
      idempotencyKey: f.activation.idempotencyKey,
      storeId: f.storeId,
      rootEntryId: f.rootEntryId,
    },
    f.key,
  );
  const base = {
      version: 1 as const,
      sourceId: activated.sourceId,
      sourceHandle: r.sourceHandle,
      storeId: f.storeId,
      rootEntryId: f.rootEntryId,
    },
    c = await claimSource(db, f.deviceId, { ...base, workerId: randomUUID() }),
    scope = { ...base, claimFence: c.claimFence };
  const observed = f.observation();
  const date = new Date(Date.now() + 10).toISOString();
  observed.timestamps.receivedAt = date;
  observed.event.observedAt = date;
  observed.direction = options.direction ?? 'inbound';
  observed.requiredArtifactRoles = ['original-msg', 'body-text', 'attachment:1'];
  if (options.live) {
    observed.event.kind = 'new-mail';
    observed.event.receivedAt = date;
  }
  const scan = await recordInventory(db, f.deviceId, {
    ...scope,
    scan: { mode: 'history', from: r.historyFrom, to: r.historyTo },
    partitionId: 'root',
    pageId: '1',
    checkpoint: { cursor: null, generation: '1', complete: true, gapCode: null },
    observations: [observed],
    discoveryComplete: true,
  });
  const bodies = [
    Buffer.from('Unicode MSG'),
    Buffer.from('Searchable body €'),
    Buffer.from('attachment'),
  ];
  const roles = ['original-msg', 'body-text', 'attachment:1'];
  const rows = await prepareArtifacts(db, f.deviceId, scope, {
    version: 1,
    observationId: scan.observations[0].observationId,
    semanticVersion: 1,
    artifacts: bodies.map((b, i) => ({
      role: roles[i],
      version: 1,
      sizeBytes: b.length,
      sha256: sha(b),
      contentType: i === 1 ? 'text/plain' : 'application/octet-stream',
      fileName: i === 2 ? 'same-name.txt' : undefined,
      availability: 'available' as const,
    })),
  });
  const adapter = new Artifacts(),
    uploader = new OutlookSyncStorage({ bucket: 'test', region: 'af-south-1' });
  for (let i = 0; i < rows.length; i++) {
    if (options.missing && i === 2) continue;
    const a = rows[i],
      upload = await uploader.beginUpload({
        sourceId: scope.sourceId,
        observationId: a.observationId,
        artifactId: a.id,
        expectedBytes: a.expectedBytes,
        sha256: a.sha256,
        contentType: a.contentType,
        authorityExpiresAt: new Date(Date.now() + 60_000),
      });
    await attachUploadSession(db, f.deviceId, scope, a.id, upload);
    const hash = createHash('sha256')
        .update(JSON.stringify([scope.sourceId, a.observationId, a.id]))
        .digest('hex'),
      key = `outlook-sync-originals/v1/${hash}/${a.sha256}`;
    const receipt = { key, bytes: a.expectedBytes, sha256: a.sha256, eTag: 'verified' };
    adapter.bytes.set(key, bodies[i]);
    await acceptArtifact(db, f.deviceId, scope, a.id, receipt);
  }
  return {
    f,
    sourceId: scope.sourceId,
    observationId: rows[0].observationId,
    adapter,
    roles,
    scope,
    observed,
  };
}
it('drains verified prior-origin artifacts for read/category-only versions and refuses changed/foreign lineage', async () =>
  withIngestionDb(async ({ db }) => {
    const a = await accepted(db);
    const fingerprint = {
      sha256: 'a'.repeat(64),
      attachments: [
        {
          role: 'attachment:1',
          stableId: 'stable1',
          modifiedAt: a.observed.timestamps.receivedAt!,
          sizeBytes: 10,
        },
      ],
    };
    await db
      .update(outlookSyncObservation)
      .set({ evidence: { ...a.observed, contentIdentity: fingerprint } })
      .where(eq(outlookSyncObservation.id, a.observationId));
    expect((await runSyncDrainPass(db, a.adapter, 'initial', 1)).committed).toBe(1);
    const next = {
      ...a.observed,
      semanticVersion: 2,
      contentIdentity: fingerprint,
      semantic: { ...a.observed.semantic, isRead: true, categories: ['Reviewed'] },
      timestamps: { ...a.observed.timestamps, modifiedAt: new Date().toISOString() },
    };
    const { recordLiveHint, reuseObservationArtifacts } = await import(
      '../src/outlook-sync/ledger.js'
    );
    const hint = await recordLiveHint(db, a.f.deviceId, a.scope, {
      ...next,
      event: { ...next.event, kind: 'folder-hint' },
    });
    expect(
      await reuseObservationArtifacts(
        db,
        a.f.deviceId,
        a.scope,
        hint.observationId,
        a.observationId,
      ),
    ).toMatchObject({ reused: true });
    expect(await db.select().from(outlookSyncArtifact)).toHaveLength(3);
    expect((await runSyncDrainPass(db, a.adapter, 'reuse', 1)).committed).toBe(1);
    expect(
      await db.select().from(message).where(eq(message.transportId, a.f.transportId)),
    ).toHaveLength(1);
    const [current] = await db
      .select()
      .from(outlookSyncObservation)
      .where(eq(outlookSyncObservation.id, hint.observationId));
    await db
      .update(outlookSyncObservation)
      .set({
        ingestionState: 'pending',
        drainExpiresAt: null,
        artifactOrigin: { sourceId: randomUUID(), observationId: a.observationId },
      })
      .where(eq(outlookSyncObservation.id, current.id));
    const claim = await claimSyncIngestion(db, 'forged');
    await expect(ingestClaimedObservation(db, a.adapter, claim!)).rejects.toThrow(
      'ARTIFACT_ORIGIN_MISMATCH',
    );
    await db
      .update(outlookSyncObservation)
      .set({
        artifactOrigin: current.artifactOrigin,
        drainExpiresAt: null,
        ingestionState: 'pending',
      })
      .where(eq(outlookSyncObservation.id, current.id));
    a.adapter.beforeRead = async () => {
      await db
        .update(outlookSyncObservation)
        .set({
          evidence: { ...a.observed, contentIdentity: { ...fingerprint, sha256: 'b'.repeat(64) } },
        })
        .where(eq(outlookSyncObservation.id, a.observationId));
    };
    const second = await claimSyncIngestion(db, 'changed');
    await expect(ingestClaimedObservation(db, a.adapter, second!)).rejects.toThrow(
      'ARTIFACT_ORIGIN_MISMATCH',
    );
  }));
describe('server-owned durable Outlook ingestion drain', () => {
  it(
    'claims only retained originals and survives logout with bodies/attachments and no historical admission',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db);
        await db.delete(staffSession).where(eq(staffSession.id, a.f.sessionId));
        expect(await runSyncDrainPass(db, a.adapter, 'worker')).toMatchObject({ committed: 1 });
        const [m] = await db.select().from(message).where(eq(message.transportId, a.f.transportId));
        expect(m.textBody).toBe('Searchable body €');
        expect(m.historyOnly).toBe(true);
        expect(await db.select().from(mailLiveAdmission)).toHaveLength(0);
        const files = await db.select().from(attachment).where(eq(attachment.messageId, m.id));
        expect(files).toHaveLength(1);
        expect(files[0].sizeBytes).toBe(10);
        expect(
          (await db.select().from(outlookSyncSource).where(eq(outlookSyncSource.id, a.sourceId)))[0]
            .committedCount,
        ).toBe(1);
        expect((await runSyncDrainPass(db, a.adapter, 'restart')).committed).toBe(0);
      }),
    30000,
  );
  it(
    'persists retry state across outage and restart, then completes without loss of sealed originals',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db);
        a.adapter.unavailable = true;
        expect((await runSyncDrainPass(db, a.adapter, 'old')).retried).toBe(1);
        const [pending] = await db
          .select()
          .from(outlookSyncObservation)
          .where(eq(outlookSyncObservation.id, a.observationId));
        expect(pending.ingestionState).toBe('pending');
        expect(pending.retryCount).toBe(1);
        expect(
          await db.select().from(message).where(eq(message.transportId, a.f.transportId)),
        ).toHaveLength(0);
        await db
          .update(outlookSyncObservation)
          .set({ drainNextAttemptAt: new Date(0) })
          .where(eq(outlookSyncObservation.id, a.observationId));
        a.adapter.unavailable = false;
        expect((await runSyncDrainPass(db, a.adapter, 'restart')).committed).toBe(1);
        expect(a.adapter.bytes.size).toBe(3);
      }),
    30000,
  );
  it(
    'fences an expired worker after takeover and prevents effects/counts under stale claims',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db),
          old = await claimSyncIngestion(db, 'old');
        expect(old).not.toBeNull();
        await db
          .update(outlookSyncObservation)
          .set({ drainExpiresAt: new Date(0) })
          .where(eq(outlookSyncObservation.id, a.observationId));
        const newer = await claimSyncIngestion(db, 'new');
        expect(newer!.fence).toBeGreaterThan(old!.fence);
        await expect(ingestClaimedObservation(db, a.adapter, old!)).rejects.toThrow('claim');
        expect(
          await db.select().from(message).where(eq(message.transportId, a.f.transportId)),
        ).toHaveLength(0);
        expect(await ingestClaimedObservation(db, a.adapter, newer!)).toMatchObject({
          state: 'committed',
        });
      }),
    30000,
  );
  it(
    'keeps missing required artifacts pending and reports unknown direction as an attention gap',
    async () =>
      withIngestionDb(async ({ db }) => {
        const missing = await accepted(db, { missing: true });
        expect(await claimSyncIngestion(db, 'worker')).toBeNull();
        const unknown = await accepted(db, { direction: 'unknown' });
        expect((await runSyncDrainPass(db, unknown.adapter, 'worker')).attention).toBe(1);
        expect(
          (
            await db
              .select()
              .from(outlookSyncObservation)
              .where(eq(outlookSyncObservation.id, unknown.observationId))
          )[0].errorCode,
        ).toBe('UNKNOWN_DIRECTION');
        expect(
          (
            await db
              .select()
              .from(outlookSyncSource)
              .where(eq(outlookSyncSource.id, unknown.sourceId))
          )[0].gapCount,
        ).toBe(1);
        expect(missing.adapter.bytes.size).toBe(2);
      }),
    30000,
  );
  it(
    'rechecks the durable fence after storage reads before any canonical effects',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db),
          claim = await claimSyncIngestion(db, 'worker');
        a.adapter.beforeRead = async () => {
          await db
            .update(outlookSyncObservation)
            .set({ drainFence: claim!.fence + 1, drainOwner: 'takeover' })
            .where(eq(outlookSyncObservation.id, a.observationId));
        };
        await expect(ingestClaimedObservation(db, a.adapter, claim!)).rejects.toThrow('claim');
        expect(
          await db.select().from(message).where(eq(message.transportId, a.f.transportId)),
        ).toHaveLength(0);
        expect(a.adapter.bytes.size).toBe(3);
      }),
    30000,
  );
  it(
    'rolls back canonical insertion when its observation receipt cannot commit, then retries',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db),
          claim = await claimSyncIngestion(db, 'worker');
        await db.execute(
          sql`CREATE FUNCTION reject_sync_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ingestion_state = 'committed' THEN RAISE EXCEPTION 'receipt outage'; END IF; RETURN NEW; END $$`,
        );
        await db.execute(
          sql`CREATE TRIGGER reject_sync_receipt BEFORE UPDATE ON outlook_sync_observation FOR EACH ROW EXECUTE FUNCTION reject_sync_receipt()`,
        );
        await expect(ingestClaimedObservation(db, a.adapter, claim!)).rejects.toMatchObject({
          cause: { message: 'receipt outage' },
        });
        expect(
          await db.select().from(message).where(eq(message.transportId, a.f.transportId)),
        ).toHaveLength(0);
        await db.execute(sql`DROP TRIGGER reject_sync_receipt ON outlook_sync_observation`);
        expect(await ingestClaimedObservation(db, a.adapter, claim!)).toMatchObject({
          state: 'committed',
        });
      }),
    30000,
  );
  it(
    'retains complete header/body provenance with Unicode and marks invalid UTF8 unavailable',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db),
          [source] = await db
            .select()
            .from(outlookSyncSource)
            .where(eq(outlookSyncSource.id, a.sourceId)),
          [observation] = await db
            .select()
            .from(outlookSyncObservation)
            .where(eq(outlookSyncObservation.id, a.observationId)),
          artifacts = await db
            .select()
            .from(outlookSyncArtifact)
            .where(eq(outlookSyncArtifact.observationId, a.observationId));
        const result = await buildOutlookHistoryInput(a.adapter, source, observation, artifacts);
        expect(result.input.sourceProvenance.artifacts).toHaveLength(3);
        expect(result.input.textBody).toBe('Searchable body €');
        const body = artifacts.find((x) => x.role === 'body-text')!,
          invalid = Buffer.from([0xff]);
        a.adapter.bytes.set(body.sealedKey!, invalid);
        body.expectedBytes = 1;
        body.sha256 = sha(invalid);
        body.verifiedReceipt = { ...body.verifiedReceipt, bytes: 1, sha256: body.sha256 };
        body.uploadSession = { ...body.uploadSession, expectedBytes: 1, sha256: body.sha256 };
        await expect(
          buildOutlookHistoryInput(a.adapter, source, observation, artifacts),
        ).rejects.toThrow('INVALID_PROJECTION_UTF8');
      }),
    30000,
  );
  it(
    'admits a late stronger arrival hint after history already committed without recopying mail',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db);
        expect((await runSyncDrainPass(db, a.adapter, 'history')).committed).toBe(1);
        expect(
          await db
            .select()
            .from(mailLiveAdmission)
            .where(eq(mailLiveAdmission.transportId, a.f.transportId)),
        ).toHaveLength(0);
        const incoming = {
          ...a.observed,
          event: {
            ...a.observed.event,
            kind: 'new-mail' as const,
            receivedAt: a.observed.timestamps.receivedAt,
          },
        };
        await recordLiveHint(db, a.f.deviceId, a.scope, incoming);
        expect((await runSyncDrainPass(db, a.adapter, 'arrival')).committed).toBe(1);
        expect(
          await db.select().from(message).where(eq(message.transportId, a.f.transportId)),
        ).toHaveLength(1);
        expect(
          await db
            .select()
            .from(mailLiveAdmission)
            .where(eq(mailLiveAdmission.transportId, a.f.transportId)),
        ).toHaveLength(1);
        expect(a.adapter.bytes.size).toBe(3);
      }),
    30000,
  );
  it(
    'uses stronger event-only evidence committed during storage verification for admission',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db),
          claim = await claimSyncIngestion(db, 'worker');
        const incoming = {
          ...a.observed,
          event: {
            ...a.observed.event,
            kind: 'new-mail' as const,
            receivedAt: a.observed.timestamps.receivedAt,
          },
        };
        a.adapter.beforeRead = async () => {
          await recordLiveHint(db, a.f.deviceId, a.scope, incoming);
        };
        expect(await ingestClaimedObservation(db, a.adapter, claim!)).toMatchObject({
          state: 'committed',
        });
        expect(
          await db
            .select()
            .from(mailLiveAdmission)
            .where(eq(mailLiveAdmission.transportId, a.f.transportId)),
        ).toHaveLength(1);
      }),
    30000,
  );
  it(
    'keeps ambiguous canonical identities as retained attention without automatic admission',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db, { live: true });
        const [source] = await db
          .select()
          .from(outlookSyncSource)
          .where(eq(outlookSyncSource.id, a.sourceId));
        const [observation] = await db
          .select()
          .from(outlookSyncObservation)
          .where(eq(outlookSyncObservation.id, a.observationId));
        const all = await db
          .select()
          .from(outlookSyncArtifact)
          .where(eq(outlookSyncArtifact.observationId, a.observationId));
        const prepared = await buildOutlookHistoryInput(a.adapter, source, observation, all);
        const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
        const first = await persistOutlookHistory(db, {
          ...prepared.input,
          sourceObservationId: 'candidate-one',
          internetMessageId: null,
        });
        const second = await persistOutlookHistory(db, {
          ...prepared.input,
          sourceObservationId: 'candidate-two',
          internetMessageId: null,
        });
        const header = 'reused@example.test';
        await db
          .update(message)
          .set({ messageIdHeader: header })
          .where(eq(message.id, first.messageId));
        await db
          .update(message)
          .set({ messageIdHeader: header })
          .where(eq(message.id, second.messageId));
        const changed = {
          ...a.observed,
          semantic: { ...a.observed.semantic, internetMessageId: header },
        };
        await db
          .update(outlookSyncObservation)
          .set({ evidence: changed })
          .where(eq(outlookSyncObservation.id, a.observationId));
        expect((await runSyncDrainPass(db, a.adapter, 'worker')).attention).toBe(1);
        expect(
          await db.select().from(message).where(eq(message.transportId, a.f.transportId)),
        ).toHaveLength(3);
        expect(
          await db
            .select()
            .from(mailLiveAdmission)
            .where(eq(mailLiveAdmission.transportId, a.f.transportId)),
        ).toHaveLength(0);
        const [attention] = await db
          .select()
          .from(outlookSyncObservation)
          .where(eq(outlookSyncObservation.id, a.observationId));
        expect(attention).toMatchObject({
          ingestionState: 'attention',
          exportState: 'retained',
          errorCode: 'AMBIGUOUS_IDENTITY',
        });
        expect(
          (await db.select().from(outlookSyncSource).where(eq(outlookSyncSource.id, a.sourceId)))[0]
            .gapCount,
        ).toBe(1);
      }),
    30000,
  );
  it(
    'rejects semantic/timestamp mutation during storage verification before canonical effects',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db),
          claim = await claimSyncIngestion(db, 'worker');
        a.adapter.beforeRead = async () => {
          await db
            .update(outlookSyncObservation)
            .set({
              evidence: {
                ...a.observed,
                timestamps: { ...a.observed.timestamps, receivedAt: new Date(0).toISOString() },
              },
            })
            .where(eq(outlookSyncObservation.id, a.observationId));
        };
        await expect(ingestClaimedObservation(db, a.adapter, claim!)).rejects.toThrow(
          'OBSERVATION_CHANGED',
        );
        expect(
          await db.select().from(message).where(eq(message.transportId, a.f.transportId)),
        ).toHaveLength(0);
      }),
    30000,
  );
  it(
    'atomically admits qualifying server-cutover inbound evidence once and preserves history receipts after logout',
    async () =>
      withIngestionDb(async ({ db }) => {
        const a = await accepted(db, { live: true });
        await db.delete(staffSession).where(eq(staffSession.id, a.f.sessionId));
        expect((await runSyncDrainPass(db, a.adapter, 'worker')).committed).toBe(1);
        expect(
          await db
            .select()
            .from(mailLiveAdmission)
            .where(eq(mailLiveAdmission.transportId, a.f.transportId)),
        ).toHaveLength(1);
        const [m] = await db.select().from(message).where(eq(message.transportId, a.f.transportId));
        expect(m.historyOnly).toBe(false);
        expect((await runSyncDrainPass(db, a.adapter, 'restart')).committed).toBe(0);
      }),
    30000,
  );
});
