import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import type { AiRunFence, AiWorkflowRun } from '../src/ai/run-ledger.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { panePartyLookupLoaders } from '../src/ai/pane-party-lookup.js';
import { HMS_JOB_PROMPT_VERSION } from '../src/ai/run-ledger.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { mailExtraction } from '../src/db/schema/work.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import type { DB } from '../src/db/client.js';
import { and, eq, sql } from 'drizzle-orm';
import { parseEnv } from '../src/env.js';
import { randomUUID } from 'node:crypto';

const runLedger = vi.hoisted(() => ({
  markAiRunDeadLetter: vi.fn(),
  markAiRunRetry: vi.fn(),
  markAiRunSucceeded: vi.fn(),
}));

vi.mock('../src/ai/run-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/run-ledger.js')>()),
  ...runLedger,
}));

vi.mock('../src/hms/property-queue-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hms/property-queue-state.js')>()),
  staffQuoteInFlight: vi.fn(async () => false),
}));

import {
  executeHmsJob,
  prefetchPartyForExtraction,
  HMS_JOB_PRIORITY_PREFETCH,
  HMS_JOB_PRIORITY_USER,
  hmsJobRequestSchema,
  partyMatchV2Enabled,
  partyPrefetchIdempotencyKey,
  partyPrefetchV2IdempotencyKey,
  selectPartyPrefetchRequest,
  selectPartyMatchV2PrefetchRequest,
  readHmsJobView,
} from '../src/ai/hms-jobs.js';

const reachable = await probeTestDb();

const REQUEST = { kind: 'party', name: 'Acme Travel', partyKind: 'company' } as const;
const RUN_ID = '00000000-0000-4000-8000-000000000001';
const fence = { claimOwner: 'hms-worker', claimToken: 'claim-token' } as AiRunFence;
const fakeDb = {} as DB;

function runningRun(readRequest: unknown, priority = HMS_JOB_PRIORITY_USER): AiWorkflowRun {
  return {
    id: RUN_ID,
    transportId: 'transport-1',
    threadId: 'thread-1',
    triggerMessageId: 'message-1',
    runKind: 'read_tool',
    idempotencyKey: 'hms-job:user:party',
    modelId: 'not_applicable',
    promptVersion: HMS_JOB_PROMPT_VERSION,
    readRequest,
    readResult: null,
    executorLane: 'hms',
    priority,
    state: 'running',
    attempts: 0,
    metrics: { userId: 'staff-1', owner: 'staff-1:transport-1' },
  } as AiWorkflowRun;
}

function lockThatRuns(): PaneStayLock {
  return { withLock: async (run) => run() } as unknown as PaneStayLock;
}

async function seedQuote(db: DB, kind: string, agency: string | null, spam = false) {
  const threadId = `thread-${randomUUID()}`;
  const messageId = `message-${randomUUID()}`;
  await db.insert(mailThread).values({
    id: threadId,
    transportId: TRANSPORT_ID,
    threadRootId: threadId,
    ...(spam ? { spamAt: new Date() } : {}),
  });
  await db.insert(message).values({
    id: messageId,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: 'agent@example.test',
    subject: 'Rate request',
    textBody: 'Travel Agency Details: Suggested Agency',
    receivedAt: new Date(),
  });
  await db.insert(mailExtraction).values({
    id: randomUUID(),
    messageId,
    extractorVersion: `party-job-test-${randomUUID()}`,
    status: 'succeeded',
    kind,
    payload: { agency },
  });
  const [run] = await db
    .insert(aiWorkflowRun)
    .values({
      id: randomUUID(),
      transportId: TRANSPORT_ID,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_extraction',
      idempotencyKey: `inbound-extraction:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'test-extraction',
      admissionSnapshotId: `snapshot-${randomUUID()}`,
      state: 'succeeded',
      executorLane: 'default',
      priority: 0,
    })
    .returning();
  if (!run) throw new Error('party prefetch extraction seed failed');
  return run;
}

function prefetchEnv(overrides: Partial<ReturnType<typeof parseEnv>> = {}) {
  return {
    ...parseEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgres://zero:secret@127.0.0.1:5432/test',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'synthetic-region-1',
      S3_BUCKET: 'party-prefetch-test',
    }),
    HMS_PREFETCH_ENABLED: true,
    ...overrides,
  };
}

beforeEach(() => {
  runLedger.markAiRunDeadLetter.mockReset().mockResolvedValue({ id: RUN_ID });
  runLedger.markAiRunRetry.mockReset().mockResolvedValue({ id: RUN_ID });
  runLedger.markAiRunSucceeded.mockReset().mockResolvedValue({ id: RUN_ID });
  panePartyLookupLoaders.enabled = () => true;
  panePartyLookupLoaders.lock = lockThatRuns();
  panePartyLookupLoaders.spawn = vi.fn(async () => ({
    outcome: 'resolved',
    candidates: [{ kind: 'organization', nativeId: '42', displayName: 'Acme Travel' }],
    truncated: false,
  }));
});

afterEach(() => {
  panePartyLookupLoaders.enabled = null;
  panePartyLookupLoaders.lock = null;
  panePartyLookupLoaders.spawn = null;
});

describe('HMS party job request', () => {
  it('accepts a party name and optional company or agency kind', () => {
    expect(hmsJobRequestSchema.safeParse(REQUEST)).toMatchObject({ success: true, data: REQUEST });
    expect(hmsJobRequestSchema.safeParse({ kind: 'party', name: 'Travel Hub' })).toMatchObject({
      success: true,
      data: { kind: 'party', name: 'Travel Hub' },
    });
    expect(hmsJobRequestSchema.safeParse({ kind: 'party', name: '' }).success).toBe(false);
    expect(hmsJobRequestSchema.safeParse({ kind: 'party', name: 'x'.repeat(257) }).success).toBe(
      false,
    );
    expect(
      hmsJobRequestSchema.safeParse({ kind: 'party', name: 'Travel Hub', partyKind: 'guest' })
        .success,
    ).toBe(false);
    expect(hmsJobRequestSchema.safeParse({ kind: 'party', name: 'Amicis', matchVersion: 2 }).success).toBe(
      true,
    );
  });
});

describe('party prefetch selection', () => {
  it('uses the extraction agency before email suggestions', () => {
    expect(
      selectPartyPrefetchRequest({
        kind: 'quote',
        payload: { agency: '  Horizon Trail Tours  ' },
        sender: 'sender@example.test',
        body: 'Travel Agency Details: Another Agency',
      }),
    ).toEqual({ kind: 'party', name: 'Horizon Trail Tours' });
  });

  it('falls back to the top email party suggestion and skips non-quote mail', () => {
    expect(
      selectPartyPrefetchRequest({
        kind: 'quote',
        payload: { agency: null },
        sender: 'sender@example.test',
        body: 'Travel Agency Details: Sample Agency',
      }),
    ).toEqual({ kind: 'party', name: 'Sample Agency' });
    expect(
      selectPartyPrefetchRequest({
        kind: 'booking',
        payload: { agency: 'Sample Agency' },
        sender: 'sender@example.test',
        body: '',
      }),
    ).toBeNull();
  });

  it('builds one kind-less prefetch key from transport, normalized name, and day', () => {
    const key = partyPrefetchIdempotencyKey(
      'transport-1',
      ' Horizon  Trail Tours ',
      '2026-10-12',
    );
    expect(key).toBe(
      partyPrefetchIdempotencyKey(
        'transport-1',
        'horizon trail tours',
        '2026-10-12',
      ),
    );
    expect(key).not.toBe(
      partyPrefetchIdempotencyKey(
        'transport-2',
        'horizon trail tours',
        '2026-10-12',
      ),
    );
    expect(key).not.toBe(
      partyPrefetchIdempotencyKey(
        'transport-1',
        'horizon trail tours',
        '2026-10-13',
      ),
    );
  });

  it('V2 queues the agency before the end client and marks the request version', () => {
    expect(
      selectPartyMatchV2PrefetchRequest({
        kind: 'quote',
        payload: { agency: 'Amicis Health (Pty) Ltd', endClient: 'Voerkraal Restaurant' },
        sender: 'agent@travelagency.co.za',
        subject: 'Quote request',
        body: '',
      }),
    ).toEqual({ kind: 'party', name: 'Amicis Health (Pty) Ltd', matchVersion: 2 });
  });

  it('uses a per-message idempotency key for V2 evidence and keeps its gate default-off', () => {
    const first = partyPrefetchV2IdempotencyKey('transport-1', 'message-1', '2026-10-13');
    expect(first).not.toBe(partyPrefetchV2IdempotencyKey('transport-1', 'message-2', '2026-10-13'));
    expect(first).not.toBe(partyPrefetchV2IdempotencyKey('transport-2', 'message-1', '2026-10-13'));
    expect(partyMatchV2Enabled({})).toBe(false);
    expect(partyMatchV2Enabled({ PARTY_MATCH_V2: '1' })).toBe(true);
    expect(partyMatchV2Enabled({ PARTY_MATCH_V2: 'on' })).toBe(false);
  });
});

describe('executeHmsJob party reads', () => {
  it('stores the party find result on a succeeded job', async () => {
    const run = runningRun(REQUEST);

    await expect(executeHmsJob({ run, fence, db: fakeDb })).resolves.toBe('succeeded');

    expect(runLedger.markAiRunSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        readResult: expect.objectContaining({
          kind: 'party',
          outcome: 'resolved',
          results: [{ kind: 'company', nativeId: '42', name: 'Acme Travel' }],
          best: { kind: 'company', nativeId: '42', name: 'Acme Travel' },
        }),
      }),
      fakeDb,
    );
  });

  it('yields a background party job on a busy lock without using an attempt', async () => {
    let lockOptions: unknown;
    panePartyLookupLoaders.lock = {
      withLock: async (_run, options) => {
        lockOptions = options;
        throw new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE);
      },
    } as unknown as PaneStayLock;

    await expect(
      executeHmsJob({ run: runningRun(REQUEST, HMS_JOB_PRIORITY_PREFETCH), fence, db: fakeDb }),
    ).resolves.toBe('retry_wait');

    expect(runLedger.markAiRunRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 0,
        failureClass: 'HMS_LOCK_BUSY',
        lastError: 'property lock busy',
      }),
      fakeDb,
    );
    expect(lockOptions).toEqual({ tryOnce: true });
  });

  it('retries an execution failure as a transient HMS read failure', async () => {
    panePartyLookupLoaders.spawn = vi.fn(async () => ({
      outcome: 'execution_failure',
      candidates: [],
    }));

    await expect(executeHmsJob({ run: runningRun(REQUEST), fence, db: fakeDb })).resolves.toBe(
      'retry_wait',
    );

    expect(runLedger.markAiRunRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        failureClass: 'TRANSIENT_NETWORK',
        lastError: 'lookup execution failed',
      }),
      fakeDb,
    );
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'party prefetch (lane DB)',
  { timeout: 60_000 },
  () => {
    beforeEach(() => {
      vi.stubEnv('HMS_JOB_QUEUE', 'on');
    });

    it('queues one party read for a quote and skips spam and non-quote extractions', () =>
      withSeededTestDb(async (db) => {
        const quote = await seedQuote(db, 'quote', 'Horizon Trail Tours');
        const env = prefetchEnv();
        expect(await prefetchPartyForExtraction(quote, db, env)).toBe(1);
        expect(await prefetchPartyForExtraction(quote, db, env)).toBe(0);

        const spam = await seedQuote(db, 'quote', 'Spam Travel', true);
        expect(await prefetchPartyForExtraction(spam, db, env)).toBe(0);
        const booking = await seedQuote(db, 'booking', 'No Quote Agency');
        expect(await prefetchPartyForExtraction(booking, db, env)).toBe(0);

        const rows = await db
          .select({
            id: aiWorkflowRun.id,
            request: aiWorkflowRun.readRequest,
            priority: aiWorkflowRun.priority,
            triggerMessageId: aiWorkflowRun.triggerMessageId,
          })
          .from(aiWorkflowRun)
          .where(
            and(
              eq(aiWorkflowRun.transportId, TRANSPORT_ID),
              eq(aiWorkflowRun.runKind, 'read_tool'),
              sql`${aiWorkflowRun.readRequest}->>'kind' = 'party'`,
            ),
          );
        expect(rows).toEqual([
          expect.objectContaining({
            request: { kind: 'party', name: 'Horizon Trail Tours' },
            priority: HMS_JOB_PRIORITY_PREFETCH,
            triggerMessageId: quote.triggerMessageId,
          }),
        ]);
        const job = rows[0];
        if (!job) throw new Error('party prefetch row missing');
        await expect(
          readHmsJobView({ transportId: TRANSPORT_ID, runId: job.id }, db),
        ).resolves.toMatchObject({ sourceMessageId: quote.triggerMessageId });
      }));

    it('uses the existing hourly prefetch cap', () =>
      withSeededTestDb(async (db) => {
        const quote = await seedQuote(db, 'quote', 'Horizon Trail Tours');
        expect(
          await prefetchPartyForExtraction(quote, db, prefetchEnv({ HMS_PREFETCH_PER_HOUR: 0 })),
        ).toBe(0);
      }));
  },
);
