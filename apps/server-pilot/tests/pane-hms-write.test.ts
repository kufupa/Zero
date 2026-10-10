import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { appRouter } from '../src/trpc/router.js';
import { aiWorkflowRun, attachment } from '../src/db/schema/mail.js';
import { workEvent, workItem, type WorkEventType } from '../src/db/schema/work.js';
import {
  approveHmsWrite,
  HmsApprovalError,
  hmsStateDigest,
  storeHmsSnapshot,
  sweepLostHmsWriteLeases,
} from '../src/ai/hms-approval.js';
import {
  paneStayCancelLoaders,
  type PaneStayCancelSpawnInput,
  type PaneStayCancelSpawnResult,
} from '../src/ai/pane-stay-cancel.js';
import {
  paneStayLookupLoaders,
  type PaneStayFields,
  type PaneStayLookupSpawnInput,
} from '../src/ai/pane-stay-lookup.js';
import {
  PANE_ATTACH_MAX_BYTES,
  paneHmsWriteLoaders,
  paneHmsWriteMode,
  prepareAmend,
  prepareHmsWriteSnapshot,
  type PaneAttachSpawnInput,
  type PaneAttachSpawnResult,
  runPaneHmsWriteOnce,
} from '../src/ai/pane-hms-write.js';
import { claimNextAiRun, toAiRunFence, type AiRunFence } from '../src/ai/run-ledger.js';
import { parseAttachOnceArgs } from '../src/ops/hms-attach-once.js';
import { ARTIFACT_MAX_INPUT_BYTES } from '../src/mail/artifacts/read-artifact.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { withIngestionDb } from './helpers/ingestion-db.js';

// The attach CLI's cap is pinned to the read path's cap. The CLI is plain .mjs, so it is imported as the rules tests do.
const attachCli = (await import('../tooling/playwright-quote/attach-document.mjs' as string)) as {
  ATTACH_MAX_BYTES: number;
};

const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';
const USER = 'user-ropperman';
const CONFIRMATION = '57291630-1';
const ARRIVAL = '2027-09-14';
const ENV = { RESERVATIONIST_PANE_AMEND: 'lab' };
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('proof'),
]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n%test document\n');
// claimNextAiRun validates the whole process env. These values are synthetic and restored after the suite.
const SYNTHETIC_ENV: Record<string, string> = {
  PORT: '3000',
  BETTER_AUTH_URL: 'https://nava.legacy.local',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  AWS_REGION: 'synthetic-region-1',
  S3_BUCKET: 'pane-hms-write-synthetic-bucket',
};
const previousEnv = new Map<string, string | undefined>();

const LAB_STAY: PaneStayFields = {
  status: 'Reserved',
  confirmation: CONFIRMATION,
  lastName: 'Labtest',
  firstName: 'Lab',
  arrival: ARRIVAL,
  departure: '2027-09-16',
  nights: 2,
  adults: 1,
  children: 0,
  roomType: 'DBL',
  ratePlan: 'BAR',
  mealPlan: 'BB',
  averageRate: '1000.00',
  grandTotal: '2000.00',
  balance: '0.00',
  sourceOfBusiness: 'Direct',
  guaranteeType: 'None',
  bookingAgency: null,
  organization: null,
};

const ATTACH_FORM = {
  action: 'attach_document',
  confirmation: CONFIRMATION,
  arrival: ARRIVAL,
  lastName: 'Labtest',
  attachmentId: 'att-1',
  documentName: 'Confirmation.pdf',
};
const CANCEL_FORM = {
  action: 'cancel',
  confirmation: CONFIRMATION,
  arrival: ARRIVAL,
  lastName: 'Labtest',
  reason: 'Test Reservations',
};

// What HMS shows now. Each test sets it, and the lookup fake reads it.
let hmsStay: PaneStayFields;
let lookups: PaneStayLookupSpawnInput[];
let attachCalls: { input: PaneAttachSpawnInput; bytes: Buffer }[];
let cancelCalls: PaneStayCancelSpawnInput[];
let onAttach: (input: PaneAttachSpawnInput) => Promise<PaneAttachSpawnResult>;
let onCancel: (input: PaneStayCancelSpawnInput) => Promise<PaneStayCancelSpawnResult>;
let storage: FakeS3Storage;
const runDirs: string[] = [];

beforeAll(() => {
  for (const [key, value] of Object.entries(SYNTHETIC_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function runDirWithPngs(names: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pane-hms-write-test-'));
  runDirs.push(dir);
  for (const name of names) await writeFile(join(dir, name), PNG_BYTES);
  return dir;
}

async function defaultAttach(): Promise<PaneAttachSpawnResult> {
  const runDir = await runDirWithPngs(['before.png', 'after.png']);
  return { outcome: 'attached', uploadSent: true, screenshots: ['before.png', 'after.png'], runDir };
}

async function defaultCancel(): Promise<PaneStayCancelSpawnResult> {
  const runDir = await runDirWithPngs(['before.png', 'after.png']);
  return {
    outcome: 'cancelled',
    statusBefore: 'Reserved',
    statusAfter: 'Cancelled',
    reasons: ['Test Reservations'],
    penaltyText: null,
    screenshots: [join(runDir, 'before.png'), join(runDir, 'after.png')],
    runDir,
    clickedOk: true,
  };
}

beforeEach(() => {
  storage = new FakeS3Storage('pane-hms-write-test');
  setS3Storage(storage);
  hmsStay = { ...LAB_STAY };
  lookups = [];
  attachCalls = [];
  cancelCalls = [];
  onAttach = defaultAttach;
  onCancel = defaultCancel;
  paneStayLookupLoaders.enabled = () => true;
  paneStayLookupLoaders.spawn = async (input) => {
    lookups.push(input);
    return { outcome: 'found', reason: null, stay: { ...hmsStay }, rows: [], screenshots: [] };
  };
  paneHmsWriteLoaders.lock = { withLock: async (fn) => fn() };
  paneHmsWriteLoaders.spawnAttach = async (input) => {
    attachCalls.push({ input, bytes: await readFile(input.file) });
    return onAttach(input);
  };
  paneStayCancelLoaders.spawn = async (input) => {
    cancelCalls.push(input);
    return onCancel(input);
  };
});

afterEach(async () => {
  resetS3Storage();
  paneStayLookupLoaders.enabled = null;
  paneStayLookupLoaders.spawn = null;
  paneHmsWriteLoaders.lock = null;
  paneHmsWriteLoaders.spawnAttach = null;
  paneHmsWriteLoaders.readAttachment = null;
  paneStayCancelLoaders.spawn = null;
  await Promise.all(runDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seedWriteItem(
  db: DB,
  opts: { n?: number; state: Record<string, unknown> },
): Promise<string> {
  const n = opts.n ?? 1;
  await seedInboxThread(db, {
    threadId: `thread-${n}`,
    transportId: TRANSPORT_ID,
    transportEmail: TRANSPORT_EMAIL,
    messageId: `msg-${n}`,
  });
  const [item] = await db
    .insert(workItem)
    .values({
      transportId: TRANSPORT_ID,
      threadId: `thread-${n}`,
      sourceMessageId: `msg-${n}`,
      kind: 'quote',
      state: { ...opts.state },
    })
    .returning({ id: workItem.id });
  return item!.id;
}

async function seedPdf(
  db: DB,
  storage: FakeS3Storage,
  opts: { id: string; messageId: string; body: Buffer; mimeType?: string },
): Promise<void> {
  const mimeType = opts.mimeType ?? 'application/pdf';
  const s3Key = `attachments/${opts.messageId}/${opts.id}.pdf`;
  await storage.putObject({ key: s3Key, body: opts.body, contentType: mimeType });
  await db.insert(attachment).values({
    id: opts.id,
    messageId: opts.messageId,
    filename: 'Confirmation.pdf',
    mimeType,
    sizeBytes: opts.body.byteLength,
    sha256: sha256(opts.body),
    s3Key,
    isInline: false,
  });
}

function approve(db: DB, workItemId: string) {
  return approveHmsWrite({ db, transportId: TRANSPORT_ID, actorUserId: USER, workItemId });
}

async function claimWrite(db: DB): Promise<{ runId: string; fence: AiRunFence }> {
  const run = await claimNextAiRun({ ownerId: 'hms-worker-a', lane: 'hms', runKind: 'hms_write', db });
  if (!run) throw new Error('expected an hms_write claim');
  return { runId: run.id, fence: toAiRunFence(run) as AiRunFence };
}

async function prepare(db: DB, workItemId: string): Promise<void> {
  const prepared = await prepareHmsWriteSnapshot({
    db,
    transportId: TRANSPORT_ID,
    workItemId,
    confirmation: CONFIRMATION,
    arrival: ARRIVAL,
    env: ENV,
  });
  expect(prepared.status).toBe('stored');
}

async function runRow(db: DB, runId: string) {
  const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId)).limit(1);
  return row!;
}

async function stateOf(db: DB, workItemId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ state: workItem.state })
    .from(workItem)
    .where(eq(workItem.id, workItemId))
    .limit(1);
  return row!.state as Record<string, unknown>;
}

async function eventsOf(db: DB, workItemId: string, type: WorkEventType) {
  return db
    .select()
    .from(workEvent)
    .where(and(eq(workEvent.workItemId, workItemId), eq(workEvent.type, type)));
}

describe('pane HMS write (U26)', () => {
  it('pins the attach cap to the read path cap, and the amend gate is lab only', () => {
    expect(attachCli.ATTACH_MAX_BYTES).toBe(ARTIFACT_MAX_INPUT_BYTES);
    expect(PANE_ATTACH_MAX_BYTES).toBe(ARTIFACT_MAX_INPUT_BYTES);
    expect(paneHmsWriteMode({ RESERVATIONIST_PANE_AMEND: 'lab' })).toBe('lab');
    expect(paneHmsWriteMode({ RESERVATIONIST_PANE_AMEND: 'on' })).toBe('off');
    expect(paneHmsWriteMode({})).toBe('off');
  });

  it('the H2 ops entry takes prepare and run with named flags only', () => {
    expect(parseAttachOnceArgs(['prepare', '--transport', 't', '--work-item', 'w'])).toEqual({
      command: 'prepare',
      transportId: 't',
      workItemId: 'w',
    });
    expect(
      parseAttachOnceArgs(['run', '--transport', 't', '--work-item', 'w', '--run', 'r', '--confirmation', CONFIRMATION]),
    ).toMatchObject({ command: 'run', runId: 'r', confirmation: CONFIRMATION, file: null });
    expect(() => parseAttachOnceArgs(['run', '--transport', 't', '--work-item', 'w', '--run', 'r'])).toThrow(
      /required: --confirmation/,
    );
    expect(() => parseAttachOnceArgs(['prepare', '--transport', 't', '--work-item', 'w', '--file', 'x.pdf'])).toThrow(
      /unknown argument/,
    );
    expect(() => parseAttachOnceArgs(['approve'])).toThrow(/usage/);
  });

  it('refuses a non-Labtest attach or cancel and a cancel before 2027 before consume, with no HMS read and no Save', async () => {
    await withIngestionDb(async ({ db }) => {
      const attachId = await seedWriteItem(db, { state: { ...ATTACH_FORM, lastName: 'Smith' } });
      await storeHmsSnapshot({ db, transportId: TRANSPORT_ID, workItemId: attachId, readHmsState: async () => hmsStay });
      await approve(db, attachId);
      const attachRun = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...attachRun, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'POLICY_BLOCK',
        reason: 'refused_not_lab',
      });

      const cancelId = await seedWriteItem(db, {
        n: 2,
        state: { ...CANCEL_FORM, arrival: '2026-05-01' },
      });
      await storeHmsSnapshot({ db, transportId: TRANSPORT_ID, workItemId: cancelId, readHmsState: async () => hmsStay });
      await approve(db, cancelId);
      const cancelRun = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...cancelRun, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'POLICY_BLOCK',
        reason: 'refused_not_lab',
      });

      const otherGuestId = await seedWriteItem(db, { n: 3, state: { ...CANCEL_FORM, lastName: 'Smith' } });
      await storeHmsSnapshot({ db, transportId: TRANSPORT_ID, workItemId: otherGuestId, readHmsState: async () => hmsStay });
      await approve(db, otherGuestId);
      const otherGuestRun = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...otherGuestRun, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'POLICY_BLOCK',
        reason: 'refused_not_lab',
      });

      expect(lookups).toHaveLength(0);
      expect(attachCalls).toHaveLength(0);
      expect(cancelCalls).toHaveLength(0);
      expect(await eventsOf(db, attachId, 'approval.consumed')).toHaveLength(0);
      expect(await eventsOf(db, otherGuestId, 'approval.consumed')).toHaveLength(0);
    });
  });

  it('refuses an attachment that is not a PDF before consume', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      await seedPdf(db, storage, { id: 'att-1', messageId: 'msg-1', body: Buffer.from('plain text, not a pdf') });
      await storeHmsSnapshot({ db, transportId: TRANSPORT_ID, workItemId, readHmsState: async () => hmsStay });
      await approve(db, workItemId);
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'POLICY_BLOCK',
        reason: 'attachment_not_pdf',
      });
      expect(attachCalls).toHaveLength(0);
      expect(await eventsOf(db, workItemId, 'approval.consumed')).toHaveLength(0);
    });
  });

  it('checks the PDF magic and the size cap on bytes from any reader, before consume', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      await storeHmsSnapshot({ db, transportId: TRANSPORT_ID, workItemId, readHmsState: async () => hmsStay });
      await approve(db, workItemId);
      paneHmsWriteLoaders.readAttachment = async () =>
        Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(PANE_ATTACH_MAX_BYTES)]);
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'POLICY_BLOCK',
        reason: 'attachment_size_invalid',
      });
      expect(attachCalls).toHaveLength(0);
      expect(await eventsOf(db, workItemId, 'approval.consumed')).toHaveLength(0);
    });
  });

  it('attaches the approved PDF after a valid approval and records the before and after PNGs as evidence', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      await seedPdf(db, storage, { id: 'att-1', messageId: 'msg-1', body: PDF_BYTES });
      await prepare(db, workItemId);
      const approval = await approve(db, workItemId);
      const run = await claimWrite(db);
      expect(run.runId).toBe(approval.runId);

      const result = await runPaneHmsWriteOnce({ ...run, db, env: ENV });
      expect(result).toMatchObject({
        status: 'succeeded',
        action: 'attach_document',
        outcome: 'attached',
        evidence: ['before.png', 'after.png'],
      });
      expect(attachCalls).toHaveLength(1);
      expect(attachCalls[0]!.bytes.equals(PDF_BYTES)).toBe(true);
      expect(attachCalls[0]!.input).toMatchObject({
        confirmation: CONFIRMATION,
        arrival: ARRIVAL,
        documentName: 'Confirmation.pdf',
      });
      expect((await runRow(db, run.runId)).state).toBe('succeeded');
      const evidence = await eventsOf(db, workItemId, 'write.evidence');
      expect(evidence.map((event) => (event.value as { name: string }).name).sort()).toEqual([
        'after.png',
        'before.png',
      ]);
    });
  });

  it('a form changed after approval is refused at consume, and no Save is sent', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      await seedPdf(db, storage, { id: 'att-1', messageId: 'msg-1', body: PDF_BYTES });
      await prepare(db, workItemId);
      await approve(db, workItemId);
      await db
        .update(workItem)
        .set({ state: { ...ATTACH_FORM, documentName: 'Changed.pdf' } })
        .where(eq(workItem.id, workItemId));
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'NEEDS_CHECK',
        reason: 'state_changed',
      });
      expect(attachCalls).toHaveLength(0);
    });
  });

  it('an HMS change between approve and Save ends in needs-check and drops the stored snapshot', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      await seedPdf(db, storage, { id: 'att-1', messageId: 'msg-1', body: PDF_BYTES });
      await prepare(db, workItemId);
      await approve(db, workItemId);
      hmsStay = { ...LAB_STAY, roomType: 'SUITE' };
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'NEEDS_CHECK',
        reason: 'hms_changed',
      });
      expect(attachCalls).toHaveLength(0);
      expect((await stateOf(db, workItemId)).hmsSnapshot).toBeUndefined();
      expect(await eventsOf(db, workItemId, 'status.changed')).toHaveLength(1);
    });
  });

  it('a stay that opens as a non-Labtest record is refused before Save as needs-check, and approval waits for a fresh read', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      await seedPdf(db, storage, { id: 'att-1', messageId: 'msg-1', body: PDF_BYTES });
      // The approval snapshot is the non-Labtest record. Prepare would refuse it, so the snapshot is stored directly.
      hmsStay = { ...LAB_STAY, lastName: 'Smith' };
      await storeHmsSnapshot({ db, transportId: TRANSPORT_ID, workItemId, readHmsState: async () => hmsStay });
      await approve(db, workItemId);
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'NEEDS_CHECK',
        reason: 'pane_save_labtest_required',
      });
      expect(attachCalls).toHaveLength(0);
      // Needs-check that wrote nothing does not block approval. The dropped snapshot makes the next approval wait for a read.
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'snapshot_missing' });
    });
  });

  it('a cancellation penalty after OK ends unknown, and approval stays blocked until the booking is read back', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: CANCEL_FORM });
      await prepare(db, workItemId);
      await approve(db, workItemId);
      onCancel = async () => {
        const runDir = await runDirWithPngs(['before.png', 'after.png']);
        return {
          outcome: 'cancel_penalty_pending',
          statusBefore: 'Reserved',
          statusAfter: 'Reserved',
          reasons: [],
          penaltyText: 'Penalty 500',
          screenshots: [join(runDir, 'before.png'), join(runDir, 'after.png')],
          runDir,
          clickedOk: true,
        };
      };
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'UNKNOWN',
        reason: 'cancel_penalty_pending',
      });
      expect(cancelCalls).toHaveLength(1);
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'needs_check_open' });
    });
  });

  it('a lease lost after Save ends as LEASE_LOST, blocks approval, and sends no second upload', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      await seedPdf(db, storage, { id: 'att-1', messageId: 'msg-1', body: PDF_BYTES });
      await prepare(db, workItemId);
      await approve(db, workItemId);
      onAttach = async () => {
        const result = await defaultAttach();
        // The lease goes stale while the CLI is running. The sweep turns the claim into LEASE_LOST.
        const far = new Date(Date.now() + 2 * 60 * 60_000);
        await sweepLostHmsWriteLeases({ db, now: far, staleRunTimeoutMs: 60 * 60_000 });
        return result;
      };
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toEqual({ status: 'lease_lost' });
      expect((await runRow(db, run.runId)).failureClass).toBe('LEASE_LOST');
      await expect(approve(db, workItemId)).rejects.toBeInstanceOf(HmsApprovalError);
      await expect(approve(db, workItemId)).rejects.toMatchObject({ refusal: 'needs_check_open' });
      expect(attachCalls).toHaveLength(1);
    });
  });

  it('a cancel that is confirmed as cancelled succeeds and records its evidence', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: CANCEL_FORM });
      await prepare(db, workItemId);
      await approve(db, workItemId);
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toMatchObject({
        status: 'succeeded',
        action: 'cancel',
        outcome: 'cancelled',
        evidence: ['before.png', 'after.png'],
      });
      expect(cancelCalls).toEqual([
        {
          mode: 'commit',
          confirmation: CONFIRMATION,
          arrival: ARRIVAL,
          reason: 'Test Reservations',
          allowRealGuest: false,
          // The read that matched the approval: the cancel CLI compares its own read of the record with it before OK.
          expectStay: LAB_STAY,
        },
      ]);
      expect((await runRow(db, run.runId)).state).toBe('succeeded');
    });
  });

  it('a cancel whose record changed after the pre-Save read is refused by the CLI with no OK, and ends in needs-check', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: CANCEL_FORM });
      await prepare(db, workItemId);
      await approve(db, workItemId);
      onCancel = async () => ({
        outcome: 'refused_stay_changed',
        statusBefore: 'Reserved',
        statusAfter: null,
        reasons: [],
        penaltyText: null,
        screenshots: [],
        clickedOk: false,
      });
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toEqual({
        status: 'ended',
        failureClass: 'NEEDS_CHECK',
        reason: 'refused_stay_changed',
      });
      expect(cancelCalls[0]?.expectStay).toEqual(LAB_STAY);
      // Nothing was written, so a fresh read and approval are allowed without a read-back.
      expect((await stateOf(db, workItemId)).hmsSnapshot).toBeUndefined();
    });
  });

  it('prepare refuses without the amend flag and for a non-Labtest stay, storing no snapshot', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      expect(
        await prepareHmsWriteSnapshot({
          db,
          transportId: TRANSPORT_ID,
          workItemId,
          confirmation: CONFIRMATION,
          arrival: ARRIVAL,
          env: {},
        }),
      ).toEqual({ status: 'refused', reason: 'refused_flag_off' });
      expect(lookups).toHaveLength(0);

      hmsStay = { ...LAB_STAY, lastName: 'Smith' };
      expect(
        await prepareHmsWriteSnapshot({
          db,
          transportId: TRANSPORT_ID,
          workItemId,
          confirmation: CONFIRMATION,
          arrival: ARRIVAL,
          env: ENV,
        }),
      ).toEqual({ status: 'refused', reason: 'pane_save_labtest_required' });
      expect((await stateOf(db, workItemId)).hmsSnapshot).toBeUndefined();
    });
  });

  it('amend prepare returns the current record beside the requested values and saves nothing', async () => {
    await withIngestionDb(async ({ db }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      const prepared = await prepareAmend({
        db,
        transportId: TRANSPORT_ID,
        workItemId,
        confirmation: CONFIRMATION,
        arrival: ARRIVAL,
        env: ENV,
        requested: { roomType: 'SUITE', adults: 1 },
      });
      expect(prepared).toMatchObject({
        status: 'stored',
        changes: ['roomType'],
        current: { roomType: 'DBL', adults: 1, arrival: ARRIVAL },
        requested: { roomType: 'SUITE', adults: 1 },
      });
      expect(attachCalls).toHaveLength(0);
      expect(cancelCalls).toHaveLength(0);
      expect((await stateOf(db, workItemId)).hmsSnapshot).toMatchObject({
        digest: hmsStateDigest(LAB_STAY),
      });
    });
  });

  it('a flag drops the pre-write snapshot, and the reread procedure stores a fresh read the next approval binds (U18)', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const workItemId = await seedWriteItem(db, { state: ATTACH_FORM });
      await seedPdf(db, storage, { id: 'att-1', messageId: 'msg-1', body: PDF_BYTES });
      await prepare(db, workItemId);
      await approve(db, workItemId);
      const run = await claimWrite(db);
      expect(await runPaneHmsWriteOnce({ ...run, db, env: ENV })).toMatchObject({
        status: 'succeeded',
      });
      const caller = appRouter.createCaller({
        auth: null as never,
        reqHeaders: new Headers({ 'x-zero-active-transport': TRANSPORT_ID }),
        sessionUser: { id: USER, email: 'staff@example.invalid', name: 'Staff' },
        activeTransportId: TRANSPORT_ID,
        accessRole: 'owner',
        transportEmail: TRANSPORT_EMAIL,
      } as never);
      __setDbForTests({ db, conn: sql } as never);
      const previousMode = process.env.RESERVATIONIST_PANE_AMEND;
      try {
        await caller.hmsApproval.review({ workItemId, runId: run.runId, decision: 'flag', note: 'Wrong document' });
        expect((await stateOf(db, workItemId)).hmsSnapshot).toBeUndefined();
        await expect(approve(db, workItemId)).rejects.toMatchObject({
          refusal: 'snapshot_missing',
        });

        delete process.env.RESERVATIONIST_PANE_AMEND;
        await expect(caller.hmsApproval.reread({ workItemId })).resolves.toEqual({
          status: 'refused',
          reason: 'refused_flag_off',
        });
        process.env.RESERVATIONIST_PANE_AMEND = 'lab';
        hmsStay = { ...LAB_STAY, departure: '2027-09-17' };
        const reread = await caller.hmsApproval.reread({ workItemId });
        expect(reread).toMatchObject({ status: 'stored' });
        expect((await stateOf(db, workItemId)).hmsSnapshot).toMatchObject({
          digest: hmsStateDigest(hmsStay),
        });
        const again = await approve(db, workItemId);
        const [grant] = await db.select().from(workEvent).where(eq(workEvent.id, again.grantId));
        expect(grant?.value).toMatchObject({ hmsBeforeDigest: hmsStateDigest(hmsStay) });
      } finally {
        if (previousMode === undefined) delete process.env.RESERVATIONIST_PANE_AMEND;
        else process.env.RESERVATIONIST_PANE_AMEND = previousMode;
        __setDbForTests(null);
      }
    });
  });
});
