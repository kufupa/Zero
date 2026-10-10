import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { executeHmsJob } from '../src/ai/hms-jobs.js';
import { paneStayLookupLoaders, type PaneStayLookupSpawnResult } from '../src/ai/pane-stay-lookup.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { claimNextAiRun, HMS_JOB_PROMPT_VERSION, markAiRunRunning } from '../src/ai/run-ledger.js';
import type { DB } from '../src/db/client.js';
import { mailThread, message } from '../src/db/schema/mail.js';
import { workItem } from '../src/db/schema/work.js';
import { CENTURION_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { hmsJobProof, parseJobProofArgs } from '../src/ops/hms-job-proof.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();
const CONFIRMATION = '7654321-1';
const ARRIVAL = '2027-03-10';
const ON = { HMS_JOB_QUEUE: 'on' };
const QUEUE = ['queue', '--transport', 't1', '--thread', 'th1', '--user', 'u1', '--confirmation', CONFIRMATION, '--arrival', ARRIVAL];

afterEach(() => {
  paneStayLookupLoaders.lock = null;
  paneStayLookupLoaders.spawn = null;
  vi.unstubAllEnvs();
});

describe('hms-job-proof args', () => {
  it('parses queue and status', () => {
    expect(parseJobProofArgs(QUEUE)).toEqual({
      command: 'queue',
      transportId: 't1',
      threadId: 'th1',
      userId: 'u1',
      confirmation: CONFIRMATION,
      arrival: ARRIVAL,
    });
    const runId = randomUUID();
    expect(parseJobProofArgs(['status', '--transport', 't1', '--thread', 'th1', '--run', runId])).toEqual({
      command: 'status',
      transportId: 't1',
      threadId: 'th1',
      runId,
    });
  });

  it('refuses unknown commands, unknown, missing, repeated or malformed flags', () => {
    expect(() => parseJobProofArgs([])).toThrow('usage');
    expect(() => parseJobProofArgs(['run'])).toThrow('usage');
    expect(() => parseJobProofArgs([...QUEUE, '--run', randomUUID()])).toThrow('unknown argument: --run');
    expect(() => parseJobProofArgs(QUEUE.slice(0, -2))).toThrow('required: --arrival');
    expect(() => parseJobProofArgs(QUEUE.slice(0, -1))).toThrow('missing value for --arrival');
    expect(() => parseJobProofArgs(['queue', '--transport', '--thread', 'th1'])).toThrow('missing value for --transport');
    expect(() => parseJobProofArgs([...QUEUE, '--user', 'u2'])).toThrow('repeated argument: --user');
    expect(() => parseJobProofArgs(QUEUE.map((v) => (v === CONFIRMATION ? '7654321' : v)))).toThrow('--confirmation');
    expect(() => parseJobProofArgs(QUEUE.map((v) => (v === ARRIVAL ? '10/03/2027' : v)))).toThrow('--arrival');
    expect(() => parseJobProofArgs(['status', '--transport', 't1', '--thread', 'th1', '--run', 'x'])).toThrow('uuid');
    expect(() => parseJobProofArgs(['status', '--transport', 't1', '--thread', 'th1', '--run', randomUUID(), '--user', 'u1'])).toThrow(
      'unknown argument: --user',
    );
  });
});

function labStay(lastName: string): PaneStayLookupSpawnResult {
  return {
    outcome: 'found',
    reason: null,
    stay: {
      status: 'Reserved',
      confirmation: CONFIRMATION,
      lastName,
      firstName: 'Proof',
      arrival: ARRIVAL,
      departure: '2027-03-12',
      nights: 2,
      adults: 1,
      children: 0,
      roomType: 'DBL',
      ratePlan: 'BAR',
      mealPlan: 'BB',
      averageRate: '1000.00',
      grandTotal: '2000.00',
      balance: '2000.00',
      sourceOfBusiness: null,
      guaranteeType: null,
      bookingAgency: null,
      organization: null,
    },
    rows: [],
    screenshots: ['stay.png'],
    runId: randomUUID(),
    runDir: `/tmp/pane-lookup-${randomUUID()}`,
  };
}

const HELD: PaneStayLock = { withLock: (fn) => fn() };

async function seedThread(db: DB): Promise<string> {
  const threadId = `thread-${randomUUID()}`;
  await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
  await db.insert(message).values({
    id: `msg-${randomUUID()}`,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: 'ops@centurion.example',
    subject: 'Internal note',
    textBody: 'Internal.',
    receivedAt: new Date(),
  });
  return threadId;
}

/** The U26 form the H2 attach proof leaves on a work item: our Labtest booking. */
async function seedLabForm(db: DB, lastName = 'Labtest'): Promise<void> {
  await db.insert(workItem).values({
    transportId: TRANSPORT_ID,
    kind: 'amendment',
    state: {
      action: 'attach_document',
      confirmation: CONFIRMATION,
      arrival: ARRIVAL,
      lastName,
      attachmentId: 'att-1',
      documentName: 'proof.pdf',
    },
  });
}

/** The ai-worker's pane job path: claim the hms-job/1 run, mark it running, execute it. */
async function workerRuns(db: DB): Promise<string> {
  const claimed = await claimNextAiRun({
    ownerId: 'hms-ai-worker-4242',
    lane: 'hms',
    runKind: 'read_tool',
    promptVersion: HMS_JOB_PROMPT_VERSION,
    db,
  });
  if (!claimed) throw new Error('expected a claimable job');
  const fence = {
    runId: claimed.id,
    claimOwner: claimed.claimOwner!,
    claimToken: claimed.claimToken!,
    deadlineAt: claimed.deadlineAt!,
  };
  if (!(await markAiRunRunning(fence, db))) throw new Error('fenced out');
  return executeHmsJob({ run: claimed, fence, db });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('hms-job-proof (lane DB)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('BETTER_AUTH_URL', 'https://nava.legacy.local');
    vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
    vi.stubEnv('AWS_REGION', 'synthetic-region-1');
    vi.stubEnv('S3_BUCKET', 'proof-synthetic-bucket');
  });

  const queueArgs = (threadId: string, overrides: Partial<{ arrival: string; userId: string }> = {}) => ({
    command: 'queue' as const,
    transportId: TRANSPORT_ID,
    threadId,
    userId: overrides.userId ?? CENTURION_USER_ID,
    confirmation: CONFIRMATION,
    arrival: overrides.arrival ?? ARRIVAL,
  });

  it('refuses anything that is not our Labtest booking, before queueing', () =>
    withSeededTestDb(async (db) => {
      const threadId = await seedThread(db);
      await expect(hmsJobProof(queueArgs(threadId), db, ON)).rejects.toThrow('refused_not_lab_booking');
      await seedLabForm(db, 'Dlamini');
      await expect(hmsJobProof(queueArgs(threadId), db, ON)).rejects.toThrow('refused_not_lab_booking');
      await seedLabForm(db);
      await expect(hmsJobProof(queueArgs(threadId, { arrival: '2026-12-31' }), db, ON)).rejects.toThrow(/refused_not_lab$/);
      await expect(hmsJobProof(queueArgs(threadId, { arrival: '2027-03-11' }), db, ON)).rejects.toThrow(
        'refused_not_lab_booking',
      );
      await expect(hmsJobProof(queueArgs(threadId), db, {})).rejects.toThrow('HMS_JOB_QUEUE=on');
      await expect(hmsJobProof(queueArgs(threadId, { userId: 'user-nobody' }), db, ON)).rejects.toThrow();
    }));

  it('AE5: queue, worker run, status from the database, and the same status from a fresh module instance', () =>
    withSeededTestDb(async (db) => {
      paneStayLookupLoaders.lock = HELD;
      const spawn = vi.fn(async () => labStay('Labtest'));
      paneStayLookupLoaders.spawn = spawn;
      const threadId = await seedThread(db);
      await seedLabForm(db);

      const queued = await hmsJobProof(queueArgs(threadId), db, ON);
      const runId = (queued as { runId: string }).runId;
      expect(runId).toEqual(expect.any(String));
      const status = { command: 'status' as const, transportId: TRANSPORT_ID, threadId, runId };
      expect(await hmsJobProof(status, db, ON)).toMatchObject({ runId, status: 'queued', position: 1, result: null });

      expect(await workerRuns(db)).toBe('succeeded');
      expect(spawn).toHaveBeenCalledWith({ mode: 'find', confirmation: CONFIRMATION, arrival: ARRIVAL });
      const done = await hmsJobProof(status, db, ON);
      expect(done).toMatchObject({ runId, status: 'done', position: null, attempts: 0 });
      expect((done as { result: { stay: { lastName: string } } }).result.stay.lastName).toBe('Labtest');

      // A new process: no module state survives, only the database.
      vi.resetModules();
      const fresh = await import('../src/ops/hms-job-proof.js');
      expect(fresh.hmsJobProof).not.toBe(hmsJobProof);
      expect(await fresh.hmsJobProof(status, db, ON)).toEqual(done);

      // The pane's jobStatus is null while the queue is off; the thread must resume this run.
      expect(await hmsJobProof(status, db, {})).toBeNull();
      await expect(hmsJobProof({ ...status, threadId: await seedThread(db) }, db, ON)).rejects.toThrow('does not resume');
      await expect(hmsJobProof({ ...status, runId: randomUUID() }, db, ON)).rejects.toThrow('no hms job');

      // The succeeded Labtest find is itself evidence: a second proof needs no form.
      await db.delete(workItem).where(sql`${workItem.state}->>'confirmation' = ${CONFIRMATION}`);
      const again = await hmsJobProof(queueArgs(await seedThread(db)), db, ON);
      expect((again as { runId: string }).runId).not.toBe(runId);
    }));
});
