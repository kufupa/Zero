import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import type { AiRunFence, AiWorkflowRun } from '../src/ai/run-ledger.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { panePartyLookupLoaders } from '../src/ai/pane-party-lookup.js';
import { HMS_JOB_PROMPT_VERSION } from '../src/ai/run-ledger.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { mailExtraction } from '../src/db/schema/work.js';
import { staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import type { DB } from '../src/db/client.js';
import { and, eq, sql } from 'drizzle-orm';
import { parseEnv } from '../src/env.js';
import { randomUUID } from 'node:crypto';

const runLedger = vi.hoisted(() => ({
  markAiRunDeadLetter: vi.fn(),
  markAiRunPolicyRefused: vi.fn(),
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

async function seedQuote(
  db: DB,
  kind: string,
  agency: string | null,
  spam = false,
  origin: {
    toAddresses?: string[];
    ccAddresses?: string[];
    ownerHeaderValue?: string | null;
  } = {},
  action?: string,
) {
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
    ...(origin.toAddresses ? { toAddresses: origin.toAddresses } : {}),
    ...(origin.ccAddresses ? { ccAddresses: origin.ccAddresses } : {}),
    ...(origin.ownerHeaderValue != null ? { ownerHeaderValue: origin.ownerHeaderValue } : {}),
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
    payload: { agency, ...(action ? { action } : {}) },
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
  runLedger.markAiRunPolicyRefused.mockReset().mockResolvedValue({ id: RUN_ID, state: 'superseded' });
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

  it('falls back to the top email party suggestion and skips kinds outside Needs-you', () => {
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
    ).toEqual({ kind: 'party', name: 'Sample Agency' });
    expect(
      selectPartyPrefetchRequest({
        kind: 'booking',
        payload: {
          agency: 'Sample Agency',
          confirmationNumbers: ['57291630-1'],
          stays: [{ id: 'stay-1' }],
        },
        sender: 'sender@example.test',
        body: '',
      }),
    ).toEqual({ kind: 'party', name: 'Sample Agency' });
    expect(
      selectPartyPrefetchRequest({
        kind: 'other',
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

describe('prepared quote selection', () => {
  it.each([
    { name: 'prefers an available party-bound WS run over a newer BAR run', contract: true, otherParty: false, stale: false, expected: 'ws-run' },
    { name: 'prefers a company-bound WS contract over newer BAR', contract: true, otherParty: false, stale: false, company: true, expected: 'ws-run' },
    { name: 'rejects a contract bound to a different company', contract: true, otherParty: true, stale: false, company: true, expected: 'bar-run' },
    { name: 'keeps BAR when the WS result is not a selected contract', contract: false, otherParty: false, stale: false, expected: 'bar-run' },
    { name: 'keeps BAR over a newer unverified WS result', contract: false, otherParty: false, stale: false, wsNewest: true, expected: 'bar-run' },
    { name: 'keeps BAR when the contract belongs to another party', contract: true, otherParty: true, stale: false, expected: 'bar-run' },
    { name: 'keeps BAR when the contract has expired', contract: true, otherParty: false, stale: true, expected: 'bar-run' },
    { name: 'uses newer BAR when an approval invalidated the older contract', contract: true, otherParty: false, stale: false, approvalBetween: true, expected: 'bar-run' },
    { name: 'does not reuse an unverified WS price as BAR when BAR is missing', contract: false, otherParty: false, stale: false, noBar: true, expected: null },
    { name: 'reuses a verified WS contract when BAR is missing', contract: true, otherParty: false, stale: false, noBar: true, expected: 'ws-run' },
  ])('$name', async ({ contract, otherParty, stale, expected, noBar, wsNewest, approvalBetween, company }) => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    vi.stubEnv('HMS_QUOTE_PREPARE', 'true');
    const quote = staffQuoteInput.parse({
      messageId: 'message-1', sourceHash: 'a'.repeat(64), selectionEpoch: 1, inputRevision: 1,
      groups: [{ id: 'g1', arrivalDate: '2027-01-01', departureDate: '2027-01-02', quantity: 1,
        adults: 1, childrenAges: [], board: 'bb' }],
      salesStrategy: 'BAR', parties: company
        ? { company: { kind: 'company', nativeId: '42', name: 'Acme Company' } }
        : { agency: { kind: 'agency', nativeId: '42', name: 'Acme Travel' } },
    });
    const now = new Date();
    const prepared = (id: string, strategy: 'BAR' | 'WS') => ({
      ...runningRun({ kind: 'staff_quote', input: { ...quote, salesStrategy: strategy,
        ...(strategy === 'WS' && otherParty ? { parties: company
          ? { company: { kind: 'company', nativeId: 'other', name: 'Other' } }
          : { agency: { kind: 'agency', nativeId: 'other', name: 'Other' } } } : {}),
      } }, HMS_JOB_PRIORITY_PREFETCH),
      id, transportId: 'transport-faith', state: 'succeeded',
      createdAt: strategy === 'WS' ? new Date(now.getTime() - 2_000) : now, finishedAt: now,
      readResult: { status: 'ready', asOf: strategy === 'WS' && stale ? new Date(now.getTime() - 25 * 60 * 60_000).toISOString() : now.toISOString(),
        rateOptions: [{ groupId: 'g1', selected: true, contract: strategy === 'WS' && contract, rateCode: strategy === 'WS' ? 'BWS1B' : 'BAR' }] },
      readResultExpiresAt: new Date(now.getTime() + 60_000),
      metrics: { userId: null, quotePrepared: true },
    } as AiWorkflowRun);
    let selects = 0;
    const db = {
      select: () => {
        const index = ++selects;
        const chain = {
          from: () => chain, where: () => chain,
          orderBy: () => index === 2 ? Promise.resolve(wsNewest
            ? [prepared('ws-run', 'WS'), ...(noBar ? [] : [prepared('bar-run', 'BAR')])]
            : [...(noBar ? [] : [prepared('bar-run', 'BAR')]), prepared('ws-run', 'WS')]) : chain,
          limit: async () => index === 1 ? [{ id: 'message-1', messageIdHeader: null }] :
            approvalBetween ? [{ createdAt: new Date(now.getTime() - 1_000) }] : [],
        };
        return chain;
      },
    } as unknown as DB;
    try {
      const result = await readHmsJobView({ transportId: 'transport-faith', userId: 'staff-1', messageId: 'message-1', kind: 'staff_quote', input: quote }, db);
      expect(result?.runId ?? null).toBe(expected);
    } finally {
      vi.unstubAllEnvs();
    }
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

  it.each([['V2', '0'], ['V3', '1']])('stores the resolved HRDAV property on %s no-match results', async (_label, v3) => {
    vi.stubEnv('PARTY_MATCH_V2', '1');
    vi.stubEnv('PARTY_MATCH_V3', v3);
    vi.stubEnv('HMS_DAVINCI_READS', 'on');
    const source = {
      payload: {}, extractionStatus: 'succeeded', extractionKind: 'quote', fromAddress: 'person@example.test',
      ownerHeaderValue: null, toAddresses: [], ccAddresses: [], subject: '', textBody: '',
      direction: 'inbound', historyOnly: false, threadHistoryOnly: false, spamAt: null,
    };
    const limit = vi.fn().mockResolvedValueOnce([source]).mockResolvedValueOnce([]);
    const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, orderBy: () => chain, limit };
    const db = { select: () => chain } as unknown as DB;
    const run = { ...runningRun({ kind: 'party', name: 'Acme Travel', matchVersion: 2 }, HMS_JOB_PRIORITY_PREFETCH), transportId: 'transport-faith' };
    try {
      await expect(executeHmsJob({ run, fence: { ...fence, deadlineAt: new Date(Date.now() + 60_000) }, db })).resolves.toBe('succeeded');
      expect(runLedger.markAiRunSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ readResult: expect.objectContaining({ propertyCode: 'HRDAV', matchStatus: 'needs_pick' }) }), db,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([['V2', '0'], ['V3', '1']])('stores the resolved HRDAV property on %s bound results', async (_label, v3) => {
    vi.stubEnv('PARTY_MATCH_V2', '1');
    vi.stubEnv('PARTY_MATCH_V3', v3);
    vi.stubEnv('HMS_DAVINCI_READS', 'on');
    panePartyLookupLoaders.spawn = vi.fn(async ({ searches }) => ({
      searches: (searches ?? []).map((search) => ({
        outcome: 'resolved', truncated: false,
        candidates: [{ kind: search.kind === 'agency' ? 'bookingAgency' : 'organization', nativeId: '42', displayName: 'Acme Travel' }],
      })),
    }));
    const source = {
      payload: { agency: 'Acme Travel' }, extractionStatus: 'succeeded', extractionKind: 'quote',
      fromAddress: 'agent@acme.test', ownerHeaderValue: null, toAddresses: [], ccAddresses: [],
      subject: 'Booking', textBody: 'Acme Travel', direction: 'inbound', historyOnly: false,
      threadHistoryOnly: false, spamAt: null,
    };
    const limit = vi.fn().mockResolvedValueOnce([source]).mockResolvedValueOnce([]);
    const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, orderBy: () => chain, limit };
    const db = { select: () => chain } as unknown as DB;
    const run = { ...runningRun({ kind: 'party', name: 'Acme Travel', matchVersion: 2 }, HMS_JOB_PRIORITY_PREFETCH), transportId: 'transport-faith' };
    try {
      await expect(executeHmsJob({ run, fence: { ...fence, deadlineAt: new Date(Date.now() + 60_000) }, db })).resolves.toBe('succeeded');
      expect(runLedger.markAiRunSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ readResult: expect.objectContaining({ propertyCode: 'HRDAV', matchStatus: 'bound' }) }), db,
      );
    } finally {
      vi.unstubAllEnvs();
    }
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

    it('ends a policy refusal superseded, not dead-lettered', async () => {
      panePartyLookupLoaders.enabled = () => false;

      await expect(executeHmsJob({ run: runningRun(REQUEST), fence, db: fakeDb })).resolves.toBe(
        'dead_letter',
      );

      expect(runLedger.markAiRunPolicyRefused).toHaveBeenCalledWith(
        expect.objectContaining({
          lastError: 'refused_flag_off',
        }),
        fakeDb,
      );
      expect(runLedger.markAiRunDeadLetter).not.toHaveBeenCalled();
      expect(panePartyLookupLoaders.spawn).not.toHaveBeenCalled();
    });

    it('dead-letters refused_input_invalid as SCHEMA_DRIFT', async () => {
      await expect(
        executeHmsJob({
          run: runningRun({ kind: 'party', name: '   ' }),
          fence,
          db: fakeDb,
        }),
      ).resolves.toBe('dead_letter');
      expect(runLedger.markAiRunDeadLetter).toHaveBeenCalledWith(
        expect.objectContaining({
          lastError: 'refused_input_invalid',
          failureClass: 'SCHEMA_DRIFT',
        }),
        fakeDb,
      );
      expect(runLedger.markAiRunPolicyRefused).not.toHaveBeenCalled();
      expect(panePartyLookupLoaders.spawn).not.toHaveBeenCalled();
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
        const other = await seedQuote(db, 'other', 'No Quote Agency');
        expect(await prefetchPartyForExtraction(other, db, env)).toBe(0);
        const noAction = await seedQuote(db, 'quote', 'Already Handled Tours', false, {}, 'no_action');
        expect(await prefetchPartyForExtraction(noAction, db, env)).toBe(0);

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

    it('does not enqueue or consume the hourly cap for Da Vinci-origin mail', () =>
      withSeededTestDb(async (db) => {
        const davinci = await seedQuote(db, 'quote', 'Horizon Trail Tours', false, {
          toAddresses: ['centurion@legacyhotels.co.za', 'davinci@legacyhotels.co.za'],
        });
        const env = prefetchEnv({ HMS_PREFETCH_PER_HOUR: 1, PARTY_MATCH_V2: true });
        expect(await prefetchPartyForExtraction(davinci, db, env)).toBe(0);

        const centurion = await seedQuote(db, 'quote', 'Horizon Trail Tours');
        expect(await prefetchPartyForExtraction(centurion, db, env)).toBe(1);

        const rows = await db
          .select({ triggerMessageId: aiWorkflowRun.triggerMessageId })
          .from(aiWorkflowRun)
          .where(
            and(
              eq(aiWorkflowRun.transportId, TRANSPORT_ID),
              eq(aiWorkflowRun.runKind, 'read_tool'),
              sql`${aiWorkflowRun.readRequest}->>'kind' = 'party'`,
            ),
          );
        expect(rows).toEqual([{ triggerMessageId: centurion.triggerMessageId }]);
      }));

    it('records a queued Da Vinci V2 job as origin refusal, not missing match', () =>
      withSeededTestDb(async (db) => {
        vi.stubEnv('PARTY_MATCH_V2', '1');
        const quote = await seedQuote(db, 'quote', 'Horizon Trail Tours', false, {
          toAddresses: ['centurion@legacyhotels.co.za', 'davinci@legacyhotels.co.za'],
        });
        const run = {
          ...runningRun(
            { kind: 'party', name: 'Horizon Trail Tours', matchVersion: 2 },
            HMS_JOB_PRIORITY_PREFETCH,
          ),
          transportId: quote.transportId,
          threadId: quote.threadId,
          triggerMessageId: quote.triggerMessageId,
        };
        await expect(executeHmsJob({ run, fence, db })).resolves.toBe('dead_letter');
        expect(runLedger.markAiRunPolicyRefused).toHaveBeenCalledWith(
          expect.objectContaining({
            lastError: 'refused_origin_mismatch',
          }),
          db,
        );
        expect(runLedger.markAiRunDeadLetter).not.toHaveBeenCalled();
        expect(panePartyLookupLoaders.spawn).not.toHaveBeenCalled();
      }));
  },
);
