import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { appRouter } from '../src/trpc/router.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import {
  HMS_WRITE_EVIDENCE_PREFIX,
  HmsApprovalError,
  approveHmsWrite,
  assertHmsUnchangedBeforeSave,
  consumeHmsWriteApproval,
  endHmsWriteRun,
  formDigest,
  hmsStateDigest,
  hmsWriteStateOf,
  readHmsWriteEvidence,
  recordHmsWriteEvidence,
  resolveHmsNeedsCheck,
  reviewHmsWrite,
  sweepLostHmsWriteLeases,
} from '../src/ai/hms-approval.js';
import { canonicalJson } from '../src/ai/draft-approval.js';
import { queueUserHmsJob, readHmsJobView } from '../src/ai/hms-jobs.js';
import {
  claimNextAiRun,
  enqueueAiRun,
  markAiRunDeadLetter,
  markAiRunSucceeded,
  toAiRunFence,
  type AiRunFence,
} from '../src/ai/run-ledger.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { withIngestionDb } from './helpers/ingestion-db.js';

const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';
const MINUTE = 60_000;
// Seed time comes from the wall clock once. Every later step runs on this injected clock.
const NOW = new Date();
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);
const STALE_RUN_MS = 60 * MINUTE;

const FORM = { stays: { s1: { arrival: '2027-03-01', rooms: 2 } } };
const EDITED_FORM = { stays: { s1: { arrival: '2027-03-02', rooms: 2 } } };
const HMS_BEFORE = { booking: 'L-1', arrival: '2027-03-01', rooms: 2 };
const HMS_CHANGED = { booking: 'L-1', arrival: '2027-03-02', rooms: 2 };
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('after-save-proof'),
]);
const USER = 'user-ropperman';
// claimNextAiRun validates the whole process env. These values are synthetic and restored after the suite.
const SYNTHETIC_ENV: Record<string, string> = {
  PORT: '3000',
  BETTER_AUTH_URL: 'https://nava.legacy.local',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  AWS_REGION: 'synthetic-region-1',
  S3_BUCKET: 'hms-approval-synthetic-bucket',
};
const previousEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const [key, value] of Object.entries(SYNTHETIC_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  if (!process.env.DATABASE_URL && process.env.TEST_DATABASE_URL) {
    previousEnv.set('DATABASE_URL', process.env.DATABASE_URL);
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
});

afterAll(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// Each n is one inbound thread with one work item. A work item is unique per (thread, kind, source message).
async function seedItem(
  db: DB,
  opts: { n?: number; snapshotAt?: Date | null; hms?: unknown; form?: Record<string, unknown> } = {},
): Promise<string> {
  const n = opts.n ?? 1;
  await seedInboxThread(db, {
    threadId: `thread-${n}`,
    transportId: TRANSPORT_ID,
    transportEmail: TRANSPORT_EMAIL,
    messageId: `msg-${n}`,
  });
  const snapshotAt = opts.snapshotAt === undefined ? NOW : opts.snapshotAt;
  const state: Record<string, unknown> = { ...(opts.form ?? FORM) };
  if (snapshotAt) {
    state.hmsSnapshot = {
      digest: hmsStateDigest(opts.hms ?? HMS_BEFORE),
      readAt: snapshotAt.toISOString(),
    };
  }
  const [item] = await db
    .insert(workItem)
    .values({
      transportId: TRANSPORT_ID,
      threadId: `thread-${n}`,
      sourceMessageId: `msg-${n}`,
      kind: 'quote',
      state,
    })
    .returning({ id: workItem.id });
  return item!.id;
}

function approve(
  db: DB,
  workItemId: string,
  extra: { now?: Date; rereadHmsState?: () => Promise<unknown>; transportId?: string } = {},
) {
  return approveHmsWrite({
    db,
    transportId: extra.transportId ?? TRANSPORT_ID,
    actorUserId: USER,
    workItemId,
    now: extra.now ?? NOW,
    rereadHmsState: extra.rereadHmsState,
  });
}

async function claimWrite(db: DB, now: Date = NOW) {
  const run = await claimNextAiRun({
    ownerId: 'hms-worker-a',
    lane: 'hms',
    runKind: 'hms_write',
    db,
    now,
  });
  if (!run) throw new Error('expected an hms_write claim');
  return { runId: run.id, fence: toAiRunFence(run) as AiRunFence };
}

async function runRow(db: DB, runId: string) {
  const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId)).limit(1);
  return row!;
}

async function grantRow(db: DB, grantId: string) {
  const [row] = await db.select().from(workEvent).where(eq(workEvent.id, grantId)).limit(1);
  return row!;
}

function callerFor(transportId: string) {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers({ 'x-zero-active-transport': transportId }),
    sessionUser: { id: USER, email: 'staff@example.invalid', name: 'Staff' },
    activeTransportId: transportId,
    accessRole: 'owner',
    transportEmail: TRANSPORT_EMAIL,
  } as never);
}

afterEach(() => {
  __setDbForTests(null);
  resetS3Storage();
});

describe('HMS write approvals', () => {
  it('approve writes a server-made grant bound to the form, the HMS digest and its own event id, and queues one hms_write run', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      const grant = await approve(db, workItemId);
      const event = await grantRow(db, grant.grantId);
      expect(event).toMatchObject({
        type: 'approval.granted',
        actorKind: 'user',
        actorUserId: USER,
        workItemId,
      });
      expect(event.value).toEqual({
        grantId: grant.grantId,
        workItemId,
        transportId: TRANSPORT_ID,
        actorUserId: USER,
        formDigest: formDigest(FORM),
        hmsBeforeDigest: hmsStateDigest(HMS_BEFORE),
        hmsReadAt: NOW.toISOString(),
      });
      // payload_hash covers the whole payload, including the grant id that is the event id.
      expect(event.payloadHash).toBe(sha256(canonicalJson(event.value)));
      const run = await runRow(db, grant.runId);
      expect(run).toMatchObject({
        runKind: 'hms_write',
        executorLane: 'hms',
        priority: 10,
        state: 'queued',
        workItemId,
        idempotencyKey: `hms-write:${grant.grantId}`,
      });
    });
  });

  it('the client cannot write an approval: the procedure takes only a work item id and the form digest it showed, and one approval is in flight at a time', async () => {
    await withIngestionDb(
      async ({ db, sql }) => {
        const workItemId = await seedItem(db);
        __setDbForTests({ db, conn: sql } as never);
        const caller = callerFor(TRANSPORT_ID);
        await expect(
          caller.hmsApproval.approve({
            workItemId,
            formDigest: 'forged',
            hmsBeforeDigest: 'forged',
          } as never),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        // The card sends back the digest of the form it showed. A form edited since then is refused, not approved.
        await expect(
          caller.hmsApproval.approve({ workItemId, formDigest: formDigest(EDITED_FORM) }),
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'form_outdated' });
        const granted = await caller.hmsApproval.approve({ workItemId, formDigest: formDigest(FORM) });
        expect(granted.runId).toEqual(expect.any(String));
        const [count] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM work_event WHERE type = 'approval.granted'`;
        expect(count?.n).toBe(1);
        await expect(
          caller.hmsApproval.approve({ workItemId, formDigest: formDigest(FORM) }),
        ).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'write_in_flight',
        });
      },
    );
  });

  it('a work item of another transport is not found, and a stale or missing snapshot is refused unless it is re-read first', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db, { snapshotAt: at(-31) });
      await expect(approve(db, workItemId, { transportId: 'transport-nava' })).rejects.toMatchObject({
        refusal: 'not_found',
      });
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'snapshot_stale' });
      const reread = await approve(db, workItemId, {
        rereadHmsState: async () => HMS_CHANGED,
      });
      const event = await grantRow(db, reread.grantId);
      expect(event.value).toMatchObject({
        formDigest: formDigest(FORM),
        hmsBeforeDigest: hmsStateDigest(HMS_CHANGED),
        hmsReadAt: NOW.toISOString(),
      });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, workItemId));
      expect(item!.state).toMatchObject({
        hmsSnapshot: { digest: hmsStateDigest(HMS_CHANGED), readAt: NOW.toISOString() },
      });

      const missing = await seedItem(db, { n: 2, snapshotAt: null, form: EDITED_FORM });
      await expect(approve(db, missing)).rejects.toMatchObject({ refusal: 'snapshot_missing' });
    });
  });

  it('an edit after approval needs re-approval: the old grant is refused, and a fresh grant gets a new hash', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      const first = await approve(db, workItemId);
      const firstRun = await claimWrite(db);
      await db
        .update(workItem)
        .set({
          state: {
            ...EDITED_FORM,
            hmsSnapshot: { digest: hmsStateDigest(HMS_BEFORE), readAt: NOW.toISOString() },
          },
        })
        .where(eq(workItem.id, workItemId));
      await expect(
        consumeHmsWriteApproval({ db, runId: firstRun.runId, fence: firstRun.fence, now: NOW }),
      ).rejects.toMatchObject({ refusal: 'state_changed' });
      // The refused runner gives the run back as a policy block. A new approval is then the only way forward.
      await markAiRunDeadLetter(
        {
          runId: firstRun.runId,
          claimOwner: firstRun.fence.claimOwner,
          claimToken: firstRun.fence.claimToken,
          expectedStates: ['claimed'],
          lastError: 'state_changed',
          failureClass: 'POLICY_BLOCK',
        },
        db,
      );
      // Unchanged state approved again: new grant id, new payload hash, new run.
      const second = await approve(db, workItemId);
      expect(second.grantId).not.toBe(first.grantId);
      const [a, b] = await Promise.all([grantRow(db, first.grantId), grantRow(db, second.grantId)]);
      expect(b!.payloadHash).not.toBe(a!.payloadHash);
      expect(b!.value).toMatchObject({ formDigest: formDigest(EDITED_FORM) });
      const secondRun = await claimWrite(db);
      const used = await consumeHmsWriteApproval({
        db,
        runId: secondRun.runId,
        fence: secondRun.fence,
        now: NOW,
      });
      expect(used.grantId).toBe(second.grantId);
    });
  });

  it('an approval is single-use, expires with its snapshot, and the unique index blocks a second consumption', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const workItemId = await seedItem(db);
      const grant = await approve(db, workItemId);
      const claim = await claimWrite(db);
      const consumed = await consumeHmsWriteApproval({
        db,
        runId: claim.runId,
        fence: claim.fence,
        now: NOW,
      });
      expect(consumed).toMatchObject({
        grantId: grant.grantId,
        payloadHash: (await grantRow(db, grant.grantId)).payloadHash,
        hmsBeforeDigest: hmsStateDigest(HMS_BEFORE),
      });
      await expect(
        consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW }),
      ).rejects.toMatchObject({ refusal: 'already_consumed' });
      await expect(
        sql`INSERT INTO work_event (work_item_id, actor_kind, type, payload_hash)
            VALUES (${workItemId}, 'system', 'approval.consumed', ${consumed.payloadHash})`,
      ).rejects.toThrow();

      // Expiry: a second approval that is consumed 31 minutes after its snapshot is refused.
      const late = await seedItem(db, { n: 2, form: { stays: { s9: { rooms: 1 } } } });
      await approve(db, late);
      const lateClaim = await claimWrite(db);
      await expect(
        consumeHmsWriteApproval({ db, runId: lateClaim.runId, fence: lateClaim.fence, now: at(31) }),
      ).rejects.toMatchObject({ refusal: 'snapshot_stale' });
    });
  });

  it('a consume without a matching grant is refused, and so is a grant whose stored payload does not hash', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId: 'thread-1',
          triggerMessageId: 'msg-1',
          runKind: 'hms_write',
          idempotencyKey: `hms-write:${randomUUID()}`,
          modelId: 'not_applicable',
          promptVersion: 'hms-write/1',
          executorLane: 'hms',
          workItemId,
        },
        db,
      );
      const claim = await claimWrite(db);
      expect(claim.runId).toBe(run.id);
      await expect(
        consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW }),
      ).rejects.toMatchObject({ refusal: 'no_grant' });
    });
  });

  it('a queued write is claimed only by an explicit hms_write claim', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const generic = await claimNextAiRun({ ownerId: 'hms-worker-a', lane: 'hms', db, now: NOW });
      expect(generic).toBeNull();
      const explicit = await claimNextAiRun({
        ownerId: 'hms-worker-a',
        lane: 'hms',
        runKind: 'hms_write',
        db,
        now: NOW,
      });
      expect(explicit?.runKind).toBe('hms_write');
    });
  });

  it('a queued hms_write run does not move a pane job in the HMS queue', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const job = await queueUserHmsJob(
        {
          transportId: TRANSPORT_ID,
          userId: USER,
          threadId: 'thread-1',
          request: { kind: 'search_guest', lastName: 'Dlamini', arrival: '2027-03-01' },
        },
        db,
      );
      // The write was approved first at the same priority, so it would sit ahead of the job if it counted.
      const view = await readHmsJobView({ transportId: TRANSPORT_ID, runId: job!.id }, db);
      expect(view?.position).toBe(1);
    });
  });

  it('the pre-Save hook refuses a run that has not consumed its grant', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      await expect(
        assertHmsUnchangedBeforeSave({
          db,
          runId: claim.runId,
          fence: claim.fence,
          readHmsState: async () => HMS_BEFORE,
        }),
      ).rejects.toMatchObject({ refusal: 'not_consumed' });
    });
  });

  it('an edit after consume is caught before Save: the hook dead-letters to needs-check', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      const consumed = await consumeHmsWriteApproval({
        db,
        runId: claim.runId,
        fence: claim.fence,
        now: NOW,
      });
      expect(consumed.form).toEqual(FORM);
      await db
        .update(workItem)
        .set({ state: { ...FORM, stays: { s1: { arrival: '2027-03-01', rooms: 3 } } } })
        .where(eq(workItem.id, workItemId));
      await expect(
        assertHmsUnchangedBeforeSave({
          db,
          runId: claim.runId,
          fence: claim.fence,
          readHmsState: async () => HMS_BEFORE,
        }),
      ).resolves.toEqual({ status: 'needs_check', reason: 'form_changed' });
    });
  });

  it('an edit or a dismiss made while HMS is re-read is caught after the read, and Save is refused', async () => {
    await withIngestionDb(async ({ db }) => {
      for (const [n, change, reason] of [
        [1, { state: EDITED_FORM }, 'form_changed'],
        [2, { status: 'dismissed' as const }, 'not_open'],
      ] as const) {
        const workItemId = await seedItem(db, { n });
        await approve(db, workItemId);
        const claim = await claimWrite(db);
        await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
        await expect(
          assertHmsUnchangedBeforeSave({
            db,
            runId: claim.runId,
            fence: claim.fence,
            readHmsState: async () => {
              await db.update(workItem).set(change).where(eq(workItem.id, workItemId));
              return HMS_BEFORE;
            },
          }),
        ).resolves.toEqual({ status: 'needs_check', reason });
        expect(await runRow(db, claim.runId)).toMatchObject({ state: 'dead_letter', lastError: reason });
      }
    });
  });

  it('an approval that passes 30 minutes during the pre-Save read refuses Save', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: at(29) });
      await expect(
        assertHmsUnchangedBeforeSave({
          db,
          runId: claim.runId,
          fence: claim.fence,
          readHmsState: async () => HMS_BEFORE,
          now: () => at(31),
        }),
      ).resolves.toEqual({ status: 'needs_check', reason: 'snapshot_stale' });
    });
  });

  it('ends a POLICY_BLOCK write run superseded and still records needs-check', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      await expect(
        endHmsWriteRun({
          db,
          fence: claim.fence,
          failureClass: 'POLICY_BLOCK',
          reason: 'refused_flag_off',
        }),
      ).resolves.toBe(true);
      expect(await runRow(db, claim.runId)).toMatchObject({
        state: 'superseded',
        failureClass: 'POLICY_BLOCK',
        lastError: 'refused_flag_off',
      });
      const events = (
        await db.select().from(workEvent).where(eq(workEvent.workItemId, workItemId))
      ).filter((row) => row.type === 'status.changed');
      expect(events.map((row) => row.value)).toEqual([
        expect.objectContaining({
          needsCheck: true,
          runId: claim.runId,
          failureClass: 'POLICY_BLOCK',
          reason: 'refused_flag_off',
        }),
      ]);
    });
  });

  it('a consumed write that ends outside needs-check blocks a new approval until it is read back', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
      await markAiRunDeadLetter(
        {
          runId: claim.runId,
          claimOwner: claim.fence.claimOwner,
          claimToken: claim.fence.claimToken,
          expectedStates: ['claimed', 'running'],
          lastError: 'UNKNOWN',
          failureClass: 'UNKNOWN',
        },
        db,
      );
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'needs_check_open' });
    });
  });

  it('a lost-lease needs-check is resolved only by a read-back or a staff note, logged with the session user', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
      const later = at(120);
      await sweepLostHmsWriteLeases({ db, now: later, staleRunTimeoutMs: STALE_RUN_MS });
      await expect(
        approve(db, workItemId, { now: later, rereadHmsState: async () => HMS_CHANGED }),
      ).rejects.toMatchObject({ refusal: 'needs_check_open' });

      const resolve = (extra: { note?: string; transportId?: string } = {}) =>
        resolveHmsNeedsCheck({
          db,
          transportId: extra.transportId ?? TRANSPORT_ID,
          actorUserId: USER,
          workItemId,
          note: extra.note,
          now: later,
        });
      await expect(resolve()).rejects.toMatchObject({ refusal: 'note_required' });
      await expect(resolve({ note: '   ' })).rejects.toMatchObject({ refusal: 'note_required' });
      await expect(resolve({ note: 'checked', transportId: 'transport-other' })).rejects.toMatchObject({
        refusal: 'not_found',
      });

      // Through the procedure: the note is required, and the actor is the session user.
      __setDbForTests({ db, conn: sql } as never);
      const caller = callerFor(TRANSPORT_ID);
      await expect(
        caller.hmsApproval.resolveNeedsCheck({ workItemId, note: '' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.hmsApproval.resolveNeedsCheck({ workItemId, note: 'Booking reads amended in HMS' }),
      ).resolves.toEqual({ runId: claim.runId, resolution: 'staff_checked' });
      const events = await db.select().from(workEvent).where(eq(workEvent.workItemId, workItemId));
      expect(events.find((row) => (row.value as { resolvedRunId?: string })?.resolvedRunId)).toMatchObject({
        type: 'status.changed',
        actorKind: 'user',
        actorUserId: USER,
        value: { needsCheck: false, resolvedRunId: claim.runId, resolution: 'staff_checked' },
      });
      await expect(resolve({ note: 'again' })).rejects.toMatchObject({ refusal: 'no_needs_check' });

      // The staff resolve dropped the snapshot, so the next approval re-reads HMS, and a new run is queued.
      await expect(approve(db, workItemId, { now: later })).rejects.toMatchObject({
        refusal: 'snapshot_missing',
      });
      const next = await approve(db, workItemId, { now: later, rereadHmsState: async () => HMS_CHANGED });
      expect(next.runId).not.toBe(claim.runId);
    });
  });

  it('a needs-check resolved by an HMS re-read stores that read as the snapshot', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
      await markAiRunDeadLetter(
        {
          runId: claim.runId,
          claimOwner: claim.fence.claimOwner,
          claimToken: claim.fence.claimToken,
          expectedStates: ['claimed', 'running'],
          lastError: 'UNKNOWN',
          failureClass: 'UNKNOWN',
        },
        db,
      );
      const later = at(1);
      await expect(
        resolveHmsNeedsCheck({
          db,
          transportId: TRANSPORT_ID,
          actorUserId: USER,
          workItemId,
          rereadHmsState: async () => HMS_CHANGED,
          now: later,
        }),
      ).resolves.toEqual({ runId: claim.runId, resolution: 'hms_reread' });
      const next = await approve(db, workItemId, { now: later });
      expect((await grantRow(db, next.grantId)).value).toMatchObject({
        hmsBeforeDigest: hmsStateDigest(HMS_CHANGED),
        hmsReadAt: later.toISOString(),
      });
    });
  });

  it('a needs-check cannot be resolved while a write is in flight, or when nothing blocks', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      const resolve = () =>
        resolveHmsNeedsCheck({ db, transportId: TRANSPORT_ID, actorUserId: USER, workItemId, note: 'ok' });
      await expect(resolve()).rejects.toMatchObject({ refusal: 'no_needs_check' });
      await approve(db, workItemId);
      await expect(resolve()).rejects.toMatchObject({ refusal: 'write_in_flight' });
    });
  });

  it('a snapshot stamped in the future is stale, not fresh', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await expect(
        approve(db, workItemId, { now: new Date(NOW.getTime() - 60_000) }),
      ).rejects.toMatchObject({ refusal: 'snapshot_stale' });
    });
  });

  it('an HMS digest hashes a Date by its value, so a changed date cannot hide', () => {
    expect(hmsStateDigest({ checkIn: new Date(0) })).not.toBe(
      hmsStateDigest({ checkIn: new Date(86_400_000) }),
    );
  });

  it('a pre-Save re-read passes when HMS is unchanged, and aborts to needs-check when it changed or cannot be read', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
      await expect(
        assertHmsUnchangedBeforeSave({
          db,
          runId: claim.runId,
          fence: claim.fence,
          readHmsState: async () => HMS_BEFORE,
        }),
      ).resolves.toEqual({ status: 'unchanged' });
      await expect(
        assertHmsUnchangedBeforeSave({
          db,
          runId: claim.runId,
          fence: claim.fence,
          readHmsState: async () => HMS_CHANGED,
        }),
      ).resolves.toEqual({ status: 'needs_check', reason: 'hms_changed' });
      const dead = await runRow(db, claim.runId);
      expect(dead).toMatchObject({
        state: 'dead_letter',
        failureClass: 'NEEDS_CHECK',
        lastError: 'hms_changed',
      });
      const [event] = await db
        .select()
        .from(workEvent)
        .where(eq(workEvent.workItemId, workItemId))
        .then((rows) => rows.filter((row) => row.type === 'status.changed'));
      expect(event?.value).toMatchObject({ needsCheck: true, runId: claim.runId });

      // HMS moved on, so the approved snapshot is gone: a fresh approval must re-read HMS first, and binds the new read.
      const [item] = await db.select().from(workItem).where(eq(workItem.id, workItemId));
      expect(item?.state).not.toHaveProperty('hmsSnapshot');
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'snapshot_missing' });
      // Nothing was written, so a fresh approval of the unchanged form is allowed after a pre-Save needs-check.
      const again = await approve(db, workItemId, { rereadHmsState: async () => HMS_CHANGED });
      expect((await grantRow(db, again.grantId)).value).toMatchObject({
        hmsBeforeDigest: hmsStateDigest(HMS_CHANGED),
      });
      const retry = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: retry.runId, fence: retry.fence, now: NOW });
      await expect(
        assertHmsUnchangedBeforeSave({
          db,
          runId: retry.runId,
          fence: retry.fence,
          readHmsState: async () => {
            throw new Error('HMS unreachable');
          },
        }),
      ).resolves.toEqual({ status: 'needs_check', reason: 'reread_failed' });
    });
  });

  it('crash after Save, then lease loss: needs-check and read-back, with no re-run and no second upload', async () => {
    await withIngestionDb(async ({ db }) => {
      const storage = new FakeS3Storage('test-hms-evidence');
      const workItemId = await seedItem(db);
      const grant = await approve(db, workItemId);
      const claim = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
      await expect(
        assertHmsUnchangedBeforeSave({
          db,
          runId: claim.runId,
          fence: claim.fence,
          readHmsState: async () => HMS_BEFORE,
        }),
      ).resolves.toEqual({ status: 'unchanged' });
      // Save happens here in the runner. Its after-save screenshot is sealed before the worker dies.
      const sealed = await recordHmsWriteEvidence({
        db,
        storage,
        transportId: TRANSPORT_ID,
        workItemId,
        runId: claim.runId,
        name: 'after-save.png',
        png: PNG_BYTES,
        now: NOW,
      });
      expect(sealed.key.startsWith(`${HMS_WRITE_EVIDENCE_PREFIX}${TRANSPORT_ID}/`)).toBe(true);

      // The worker dies. Its lease goes stale, and no other lane may take the run.
      const later = at(120);
      expect(
        await claimNextAiRun({ ownerId: 'hms-worker-b', lane: 'hms', db, now: later }),
      ).toBeNull();
      expect(
        await claimNextAiRun({
          ownerId: 'hms-worker-b',
          lane: 'hms',
          runKind: 'hms_write',
          db,
          now: later,
        }),
      ).toBeNull();

      await expect(
        sweepLostHmsWriteLeases({ db, now: later, staleRunTimeoutMs: STALE_RUN_MS }),
      ).resolves.toBe(1);
      expect(await runRow(db, claim.runId)).toMatchObject({
        state: 'dead_letter',
        failureClass: 'LEASE_LOST',
      });
      const events = (
        await db.select().from(workEvent).where(eq(workEvent.workItemId, workItemId))
      ).filter((row) => row.type === 'status.changed');
      expect(events.map((row) => row.value)).toEqual([
        expect.objectContaining({ needsCheck: true, reason: 'lease_lost', runId: claim.runId }),
      ]);

      // The zombie worker can no longer consume, check, or write. A re-upload of the same key is refused.
      await expect(
        consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: later }),
      ).rejects.toMatchObject({ refusal: 'lease_lost' });
      await expect(
        assertHmsUnchangedBeforeSave({
          db,
          runId: claim.runId,
          fence: claim.fence,
          readHmsState: async () => HMS_BEFORE,
        }),
      ).resolves.toEqual({ status: 'lease_lost' });
      await expect(
        recordHmsWriteEvidence({
          db,
          storage,
          transportId: TRANSPORT_ID,
          workItemId,
          runId: claim.runId,
          name: 'after-save.png',
          png: Buffer.concat([PNG_BYTES, Buffer.from('second copy')]),
          now: later,
        }),
      ).rejects.toMatchObject({ refusal: 'evidence_exists' });
      expect(storage.stored.get(sealed.key)?.body.equals(PNG_BYTES)).toBe(true);
      expect(storage.calls.filter((call) => call.key === sealed.key)).toHaveLength(2);

      // A new approval stays blocked until someone has read the booking back.
      await expect(approve(db, workItemId, { now: later })).rejects.toMatchObject({
        refusal: 'needs_check_open',
      });
      expect(grant.runId).toBe(claim.runId);
    });
  });

  it('a stale hms_write lease is not reclaimed before the sweep either', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      const later = at(120);
      expect(
        await claimNextAiRun({
          ownerId: 'hms-worker-b',
          lane: 'hms',
          runKind: 'hms_write',
          db,
          now: later,
        }),
      ).toBeNull();
      await expect(
        sweepLostHmsWriteLeases({ db, now: later, staleRunTimeoutMs: STALE_RUN_MS }),
      ).resolves.toBe(1);
      // The sweep is idempotent: the run is already terminal.
      await expect(
        sweepLostHmsWriteLeases({ db, now: later, staleRunTimeoutMs: STALE_RUN_MS }),
      ).resolves.toBe(0);
      expect((await runRow(db, claim.runId)).state).toBe('dead_letter');
    });
  });

  it('evidence is sealed and sha256-checked, and a read is refused across transports', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const storage = new FakeS3Storage('test-hms-evidence');
      setS3Storage(storage);
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      const sealed = await recordHmsWriteEvidence({
        db,
        storage,
        transportId: TRANSPORT_ID,
        workItemId,
        runId: claim.runId,
        name: 'after-save.png',
        png: PNG_BYTES,
        now: NOW,
      });
      expect(sealed.sha256).toBe(sha256(PNG_BYTES));
      const [event] = await db.select().from(workEvent).where(eq(workEvent.id, sealed.eventId));
      expect(event).toMatchObject({
        type: 'write.evidence',
        evidence: {
          key: sealed.key,
          sha256: sealed.sha256,
          bytes: PNG_BYTES.byteLength,
          contentType: 'image/png',
        },
      });

      const ok = await readHmsWriteEvidence({
        db,
        storage,
        transportId: TRANSPORT_ID,
        workItemId,
        eventId: sealed.eventId,
      });
      expect(ok).toEqual({
        status: 'ok',
        dataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      });
      await expect(
        readHmsWriteEvidence({
          db,
          storage,
          transportId: 'transport-nava',
          workItemId,
          eventId: sealed.eventId,
        }),
      ).resolves.toEqual({ status: 'unavailable', reason: 'evidence_unavailable' });

      storage.stored.set(sealed.key, {
        body: Buffer.from('tampered bytes'),
        contentType: 'image/png',
      });
      await expect(
        readHmsWriteEvidence({
          db,
          storage,
          transportId: TRANSPORT_ID,
          workItemId,
          eventId: sealed.eventId,
        }),
      ).resolves.toEqual({ status: 'unavailable', reason: 'evidence_unavailable' });

      await expect(
        recordHmsWriteEvidence({
          db,
          storage,
          transportId: TRANSPORT_ID,
          workItemId,
          runId: claim.runId,
          name: 'not-a-png.png',
          png: Buffer.from('plain text'),
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(HmsApprovalError);

      // The route reads through the caller's transport and never returns another transport's bytes.
      storage.stored.set(sealed.key, { body: PNG_BYTES, contentType: 'image/png' });
      __setDbForTests({ db, conn: sql } as never);
      setS3Storage(storage);
      await expect(
        callerFor('transport-nava').hmsApproval.evidence({ workItemId, eventId: sealed.eventId }),
      ).resolves.toEqual({ status: 'unavailable', reason: 'evidence_unavailable' });
      await expect(
        callerFor(TRANSPORT_ID).hmsApproval.evidence({ workItemId, eventId: sealed.eventId }),
      ).resolves.toEqual({
        status: 'ok',
        dataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      });
    });
  });
});

describe('HMS write review and write state', () => {
  // The queued approval runs: it consumes its grant and the run succeeds (Save read back), as U26's runner will leave it.
  async function runApprovedWrite(db: DB): Promise<string> {
    const claim = await claimWrite(db);
    await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
    await markAiRunSucceeded(
      {
        runId: claim.runId,
        claimOwner: claim.fence.claimOwner,
        claimToken: claim.fence.claimToken,
        expectedStates: ['claimed', 'running'],
      },
      db,
    );
    return claim.runId;
  }

  const review = (
    db: DB,
    workItemId: string,
    extra: Partial<Parameters<typeof reviewHmsWrite>[0]> = {},
  ) =>
    reviewHmsWrite({
      db,
      transportId: TRANSPORT_ID,
      actorUserId: USER,
      workItemId,
      decision: 'ok',
      now: NOW,
      ...extra,
    });

  it('a review needs an executed write, and an OK keeps the email open for other requests', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db, { form: { ...FORM, otherRequest: 'Send the invoice' } });
      await expect(review(db, workItemId)).rejects.toMatchObject({ refusal: 'no_executed_write' });
      await approve(db, workItemId);
      await expect(review(db, workItemId)).rejects.toMatchObject({ refusal: 'write_in_flight' });

      const runId = await runApprovedWrite(db);
      await expect(review(db, workItemId)).resolves.toEqual({ runId, status: 'needs_you' });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, workItemId));
      expect(item?.status).toBe('needs_you');
      expect(item?.state.otherRequest).toBe('Send the invoice');
      expect(item?.state).not.toHaveProperty('hmsSnapshot');
      const reviewed = await db
        .select()
        .from(workEvent)
        .where(eq(workEvent.workItemId, workItemId));
      expect(reviewed.find((row) => row.type === 'review.ok')).toMatchObject({
        actorKind: 'user',
        actorUserId: USER,
        value: { runId },
      });
      await expect(review(db, workItemId)).rejects.toMatchObject({ refusal: 'already_reviewed' });
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'snapshot_missing' });
    });
  });

  it('a reply sent before review closes the item after the write is reviewed', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const runId = await runApprovedWrite(db);
      await db.insert(message).values({
        id: 'reply-1',
        transportId: TRANSPORT_ID,
        threadId: 'thread-1',
        direction: 'outbound',
        fromAddress: TRANSPORT_EMAIL,
        toAddresses: ['guest@example.invalid'],
        textBody: 'Your request is complete.',
        sentAt: at(1),
      });

      await expect(review(db, workItemId, { now: at(2) })).resolves.toEqual({ runId, status: 'done' });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, workItemId));
      expect(item).toMatchObject({ status: 'done', sentMessageId: 'reply-1' });
    });
  });

  it('a flag needs a note, returns the executed write to needs_you, and drops the pre-write snapshot so the next approval re-reads', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const runId = await runApprovedWrite(db);
      const flag = (extra: Partial<Parameters<typeof reviewHmsWrite>[0]> = {}) =>
        review(db, workItemId, { decision: 'flag', now: at(5), ...extra });
      await expect(flag({ note: '  ' })).rejects.toMatchObject({ refusal: 'note_required' });
      await expect(flag({ note: 'x'.repeat(501) })).rejects.toMatchObject({
        refusal: 'note_required',
      });

      await expect(flag({ note: 'Arrival is 2 Nov in HMS' })).resolves.toEqual({
        runId,
        status: 'needs_you',
      });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, workItemId));
      expect(item?.status).toBe('needs_you');
      // The snapshot was read before the write changed HMS. It is gone, so it cannot back a new approval.
      expect(item?.state).not.toHaveProperty('hmsSnapshot');
      await expect(approve(db, workItemId, { now: at(6) })).rejects.toMatchObject({
        refusal: 'snapshot_missing',
      });
      const fresh = await approve(db, workItemId, {
        now: at(6),
        rereadHmsState: async () => HMS_CHANGED,
      });
      expect((await grantRow(db, fresh.grantId)).value).toMatchObject({
        hmsBeforeDigest: hmsStateDigest(HMS_CHANGED),
      });
      const events = await db.select().from(workEvent).where(eq(workEvent.workItemId, workItemId));
      expect(events.find((row) => row.type === 'review.flag')).toMatchObject({
        actorUserId: USER,
        value: { runId, note: 'Arrival is 2 Nov in HMS' },
      });
    });
  });

  it('a review names the run it was shown: a newer write refuses it, so OK never closes a write nobody saw', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const shown = await runApprovedWrite(db);
      // Another pane approves and finishes a second write while this one still shows the first.
      await approve(db, workItemId);
      const latest = await runApprovedWrite(db);
      await expect(review(db, workItemId, { runId: shown })).rejects.toMatchObject({ refusal: 'run_changed' });
      await expect(review(db, workItemId, { runId: latest })).resolves.toEqual({ runId: latest, status: 'needs_you' });
    });
  });

  it('OK is refused when the form changed after the write, and a flag still returns the item for a new approval', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const runId = await runApprovedWrite(db);
      const [item] = await db.select().from(workItem).where(eq(workItem.id, workItemId));
      await db
        .update(workItem)
        .set({ state: { ...item!.state, ...EDITED_FORM } })
        .where(eq(workItem.id, workItemId));
      await expect(review(db, workItemId, { runId })).rejects.toMatchObject({ refusal: 'state_changed' });
      expect((await db.select().from(workItem).where(eq(workItem.id, workItemId)))[0]?.status).toBe('needs_you');
      await expect(
        review(db, workItemId, { runId, decision: 'flag', note: 'Arrival edited after the write' }),
      ).resolves.toEqual({ runId, status: 'needs_you' });
    });
  });

  it('one decision per run', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      await runApprovedWrite(db);
      await review(db, workItemId, { decision: 'flag', note: 'Rate is off' });
      await expect(review(db, workItemId)).rejects.toMatchObject({ refusal: 'already_reviewed' });
    });
  });

  it('the procedure takes a flag only with a note, refuses a re-read of a form it cannot read, and hides other transports', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const runId = await runApprovedWrite(db);
      __setDbForTests({ db, conn: sql } as never);
      const caller = callerFor(TRANSPORT_ID);
      await expect(
        caller.hmsApproval.review({ workItemId, decision: 'flag', note: '' } as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.hmsApproval.review({ workItemId, decision: 'ok', note: 'not allowed' } as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.hmsApproval.review({ workItemId, runId, decision: 'flag', note: 'Check arrival in HMS' }),
      ).resolves.toEqual({ runId, status: 'needs_you' });
      // This form names no booking to read (no confirmation, arrival or action), so nothing reaches HMS.
      await expect(caller.hmsApproval.reread({ workItemId })).resolves.toEqual({
        status: 'refused',
        reason: 'form_invalid',
      });
      await expect(
        callerFor('transport-nava').hmsApproval.review({ workItemId, runId, decision: 'ok' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        callerFor('transport-nava').hmsApproval.writeState({ workItemId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        callerFor('transport-nava').hmsApproval.reread({ workItemId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('a form changed while its write is still queued supersedes that run, so approving again is not stuck', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      const first = await approve(db, workItemId);
      // Unchanged form: the queued run stands and a second approval is refused as in flight.
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'write_in_flight' });
      await db
        .update(workItem)
        .set({
          state: {
            ...EDITED_FORM,
            hmsSnapshot: { digest: hmsStateDigest(HMS_BEFORE), readAt: NOW.toISOString() },
          },
        })
        .where(eq(workItem.id, workItemId));
      expect(
        (await hmsWriteStateOf({ db, transportId: TRANSPORT_ID, workItemId, now: NOW }))?.grant,
      ).toMatchObject({ grantId: first.grantId, fingerprintMatches: false });
      const second = await approve(db, workItemId);
      expect(await runRow(db, first.runId)).toMatchObject({
        state: 'superseded',
        lastError: 'form_changed',
      });
      const claim = await claimWrite(db);
      expect(claim.runId).toBe(second.runId);
      const used = await consumeHmsWriteApproval({
        db,
        runId: claim.runId,
        fence: claim.fence,
        now: NOW,
      });
      expect(used.grantId).toBe(second.grantId);

      // A claimed run may be reading HMS already. It is never superseded: the approval stays refused as in flight.
      await db
        .update(workItem)
        .set({
          state: {
            ...FORM,
            hmsSnapshot: { digest: hmsStateDigest(HMS_BEFORE), readAt: NOW.toISOString() },
          },
        })
        .where(eq(workItem.id, workItemId));
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'write_in_flight' });
      expect((await runRow(db, claim.runId)).state).toBe('claimed');
    });
  });

  it('a review is refused while a needs-check is open', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db);
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
      await markAiRunDeadLetter(
        {
          runId: claim.runId,
          claimOwner: claim.fence.claimOwner,
          claimToken: claim.fence.claimToken,
          expectedStates: ['claimed', 'running'],
          lastError: 'UNKNOWN',
          failureClass: 'UNKNOWN',
        },
        db,
      );
      await expect(review(db, workItemId)).rejects.toMatchObject({ refusal: 'needs_check_open' });
    });
  });

  it('the write state masks card numbers in the values the cards show (KTD13), and leaves the digest alone', async () => {
    await withIngestionDb(async ({ db }) => {
      const form = { guestNote: 'Card 4111 1111 1111 1111 CVV 123', rooms: 2 };
      const workItemId = await seedItem(db, { form });
      await db
        .update(workItem)
        .set({
          state: {
            ...form,
            hmsSnapshot: {
              digest: hmsStateDigest(HMS_BEFORE),
              readAt: NOW.toISOString(),
              values: { guestNote: ['pay with 4111111111111111'] },
            },
          },
        })
        .where(eq(workItem.id, workItemId));
      const view = await hmsWriteStateOf({ db, transportId: TRANSPORT_ID, workItemId, now: NOW });
      expect(view?.form).toEqual({ guestNote: 'Card [card ••••1111] CVV [code masked]', rooms: 2 });
      expect(view?.before).toEqual({ guestNote: ['pay with [card ••••1111]'] });
      const grant = await approve(db, workItemId);
      expect((await grantRow(db, grant.grantId)).value).toMatchObject({
        formDigest: formDigest(form),
      });
    });
  });

  it('the write state shows the form, the stored before values, the approval against the form, and evidence past retention as expired', async () => {
    await withIngestionDb(async ({ db }) => {
      const storage = new FakeS3Storage('test-hms-evidence');
      const workItemId = await seedItem(db);
      const arrival = 'stays[s1].requested.arrival';
      await db
        .update(workItem)
        .set({
          state: {
            [arrival]: '2027-03-01',
            hmsSnapshot: {
              digest: hmsStateDigest(HMS_BEFORE),
              readAt: NOW.toISOString(),
              values: { [arrival]: '2026-10-31' },
            },
          },
        })
        .where(eq(workItem.id, workItemId));
      const editArrival = async (value: string) => {
        const [row] = await db
          .select({ state: workItem.state })
          .from(workItem)
          .where(eq(workItem.id, workItemId));
        await db
          .update(workItem)
          .set({ state: { ...row!.state, [arrival]: value } })
          .where(eq(workItem.id, workItemId));
      };
      const stateNow = () =>
        hmsWriteStateOf({ db, transportId: TRANSPORT_ID, workItemId, now: NOW });

      expect(await stateNow()).toMatchObject({
        status: 'needs_you',
        form: { [arrival]: '2027-03-01' },
        before: { [arrival]: '2026-10-31' },
        snapshot: { readAt: NOW.toISOString(), stale: false },
        grant: null,
        run: null,
        needsCheck: false,
      });
      expect(
        await hmsWriteStateOf({ db, transportId: 'transport-nava', workItemId, now: NOW }),
      ).toBeNull();

      const grant = await approve(db, workItemId);
      expect((await stateNow())?.grant).toEqual({
        grantId: grant.grantId,
        consumed: false,
        fingerprintMatches: true,
      });
      await editArrival('2027-03-02');
      expect((await stateNow())?.grant).toEqual({
        grantId: grant.grantId,
        consumed: false,
        fingerprintMatches: false,
      });
      await editArrival('2027-03-01');
      const claim = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
      await editArrival('2027-03-02');
      expect(await stateNow()).toMatchObject({
        grant: { grantId: grant.grantId, consumed: true, fingerprintMatches: false },
        run: { runId: claim.runId, state: 'claimed', evidence: [], reviewed: null },
      });

      // A second item: its write sealed an old screenshot (past the 90-day window) and a new one, then succeeded.
      const old = await seedItem(db, { n: 2 });
      const second = await approve(db, old);
      const secondClaim = await claimWrite(db);
      expect(secondClaim.runId).not.toBe(claim.runId);
      await consumeHmsWriteApproval({
        db,
        runId: secondClaim.runId,
        fence: secondClaim.fence,
        now: NOW,
      });
      const ninetyOneDaysAgo = at(-91 * 24 * 60);
      await recordHmsWriteEvidence({
        db,
        storage,
        transportId: TRANSPORT_ID,
        workItemId: old,
        runId: secondClaim.runId,
        name: 'before.png',
        png: PNG_BYTES,
        now: ninetyOneDaysAgo,
      });
      await recordHmsWriteEvidence({
        db,
        storage,
        transportId: TRANSPORT_ID,
        workItemId: old,
        runId: secondClaim.runId,
        name: 'after-save.png',
        png: PNG_BYTES,
        now: NOW,
      });
      await markAiRunSucceeded(
        {
          runId: secondClaim.runId,
          claimOwner: secondClaim.fence.claimOwner,
          claimToken: secondClaim.fence.claimToken,
          expectedStates: ['claimed', 'running'],
        },
        db,
      );
      expect(second.runId).toBe(secondClaim.runId);
      const shown = await hmsWriteStateOf({
        db,
        transportId: TRANSPORT_ID,
        workItemId: old,
        now: NOW,
      });
      expect(shown?.run).toMatchObject({
        state: 'succeeded',
        evidence: [
          { name: 'before.png', expired: true },
          { name: 'after-save.png', expired: false },
        ],
        reviewed: null,
      });
      await review(db, old);
      expect(
        (await hmsWriteStateOf({ db, transportId: TRANSPORT_ID, workItemId: old, now: NOW }))?.run
          ?.reviewed,
      ).toBe('ok');
    });
  });
});

describe('HMS attach form digest and unconfirmed upload (U9)', () => {
  const ATTACH_HASH = 'a'.repeat(64);
  const ATTACH_FORM = {
    action: 'attach_document',
    confirmation: '57291630-1',
    arrival: '2027-09-14',
    lastName: 'Labtest',
    attachmentId: 'att-1',
    documentName: 'Confirmation.pdf',
    pdfSha256: ATTACH_HASH,
  };

  it('the attach form digest covers the PDF hash, so a changed hash is a different approval', () => {
    expect(formDigest(ATTACH_FORM)).not.toBe(
      formDigest({ ...ATTACH_FORM, pdfSha256: 'b'.repeat(64) }),
    );
    expect(formDigest(ATTACH_FORM)).toBe(formDigest({ ...ATTACH_FORM }));
  });

  it('does not card-mask a PDF hash that contains a long digit run', async () => {
    await withIngestionDb(async ({ db }) => {
      const pdfSha256 = `${'a'.repeat(5)}4111111111111111${'b'.repeat(43)}`;
      const workItemId = await seedItem(db, { form: { ...ATTACH_FORM, pdfSha256 } });
      const view = await hmsWriteStateOf({ db, transportId: TRANSPORT_ID, workItemId, now: NOW });
      expect(view?.form.pdfSha256).toBe(pdfSha256);
    });
  });

  it('upload_unconfirmed leaves needs-check open and refuses another approval', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedItem(db, { form: ATTACH_FORM });
      await approve(db, workItemId);
      const claim = await claimWrite(db);
      await consumeHmsWriteApproval({ db, runId: claim.runId, fence: claim.fence, now: NOW });
      expect(
        await endHmsWriteRun({
          db,
          fence: claim.fence,
          failureClass: 'UNKNOWN',
          reason: 'upload_unconfirmed',
        }),
      ).toBe(true);
      const view = await hmsWriteStateOf({ db, transportId: TRANSPORT_ID, workItemId, now: NOW });
      expect(view).toMatchObject({
        needsCheck: true,
        form: ATTACH_FORM,
        run: { lastError: 'upload_unconfirmed' },
      });
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'needs_check_open' });
    });
  });
});
