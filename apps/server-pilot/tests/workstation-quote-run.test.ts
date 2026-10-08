import {
  beginQuoteRun,
  latestQuoteRunFor,
  type QuoteRunHandle,
} from '../src/hms/property-queue-state.js';
import { aiDraftGeneration, aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { appRouter } from '../src/trpc/router.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { TRPCError } from '@trpc/server';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { awaitPendingStaffQuote } from '../src/ai/staff-quote-trace-async.js';

const hoisted = vi.hoisted(() => ({
  db: undefined as unknown,
  configure: vi.fn(),
  services: vi.fn(),
  executeStaffQuote: vi.fn(),
  emitEvidence: false,
  lockReleased: undefined as (() => void) | undefined,
}));

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: () => hoisted.db,
}));
vi.mock('../src/ai/staff-quote-installation.js', () => ({
  readInstalledStaffQuoteConfiguration: hoisted.configure,
  getInstalledStaffQuoteServices: hoisted.services,
}));
vi.mock('../src/ai/staff-quote-workflow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/staff-quote-workflow.js')>()),
  executeStaffQuote: hoisted.executeStaffQuote,
}));
vi.mock('../src/hms/property-read-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hms/property-read-lock.js')>()),
  createPostgresPropertyReadLock: () => ({
    key: '0',
    withLock: async <T>(callback: () => Promise<T>) => {
      const value = await callback();
      hoisted.lockReleased?.();
      return value;
    },
  }),
}));
vi.mock('../src/quote-proposal/quote-lines.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/quote-proposal/quote-lines.js')>()),
  deriveQuoteLines: () => [{ description: 'Synthetic standard room' }],
}));

const TRANSPORT = 'transport-centurion';
const USER = 'user-ropperman';
const RUN = '2026-10-07T23-33-12-345Z-abcd1234';
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic-png')]);

const mail = {
  id: 'msg-synthetic-1',
  transportId: TRANSPORT,
  threadId: 'thread-synthetic-1',
  direction: 'inbound',
  subject: 'Accommodation enquiry',
  textBody: 'Please quote two rooms for 12 to 15 October.',
  htmlBody: null,
  receivedAt: new Date('2026-10-06T08:00:00Z'),
  sentAt: null,
  createdAt: new Date('2026-10-06T08:00:00Z'),
  messageIdHeader: '<msg-synthetic-1@example.invalid>',
};

const quoteInput = {
  messageId: mail.id,
  sourceHash: staffQuoteSourceHash(mail),
  selectionEpoch: 1,
  inputRevision: 1,
  groups: [
    {
      id: 'single',
      arrivalDate: '2026-10-12',
      departureDate: '2026-10-15',
      quantity: 2,
      adults: 1,
      childrenAges: [],
      board: 'room_only',
      roomCodes: ['SKNG'],
    },
  ],
  salesStrategy: 'BAR' as const,
  company: '',
  agency: '',
  attention: '',
  clientEmail: '',
  clientTelephone: '',
};

type Recorded = { table: unknown; values: Record<string, unknown> };

/** Minimal drizzle-shaped fake: records writes and where clauses, answers reads from fixtures. */
function fakeDb(options: {
  otherInFlight?: number;
  holder?: { elapsedMs: number } | null;
  failExecute?: boolean;
  ownedRunIds?: string[];
}) {
  const inserted: Recorded[] = [];
  const updated: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const wheres: Array<{ table: unknown; condition: unknown }> = [];
  const selectCalls = vi.fn();
  const executeCalls = vi.fn();
  let lastGenerationId: string | undefined;

  const rowsFor = (table: unknown, fields?: Record<string, unknown>) => {
    if (fields && 'count' in fields) return [{ count: options.otherInFlight ?? 0 }];
    if (table === message) return [mail];
    if (table === aiWorkflowRun) return (options.ownedRunIds ?? []).map((id) => ({ id }));
    if (table === aiDraftGeneration) return lastGenerationId ? [{ id: lastGenerationId }] : [];
    return [];
  };

  const select = (fields?: Record<string, unknown>) => {
    selectCalls();
    let table: unknown;
    // Terminal step is a real Promise (awaitable) that also offers the chain helpers.
    const terminal = (): Promise<unknown[]> & {
      limit: () => Promise<unknown[]>;
      orderBy: () => ReturnType<typeof terminal>;
    } =>
      Object.assign(Promise.resolve(rowsFor(table, fields)), {
        limit: () => Promise.resolve(rowsFor(table, fields)),
        orderBy: () => terminal(),
      });
    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      innerJoin() {
        return chain;
      },
      where(condition: unknown) {
        wheres.push({ table, condition });
        return terminal();
      },
    };
    return chain;
  };

  const writes = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserted.push({ table, values });
          if (table === aiDraftGeneration) lastGenerationId = values.id as string;
          return Promise.resolve();
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              updated.push({ table, values });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  const db = {
    ...writes,
    select,
    execute: async (query: unknown) => {
      executeCalls(query);
      if (options.failExecute) throw new Error('synthetic database unavailable');
      return options.holder ? [{ elapsed_ms: String(options.holder.elapsedMs) }] : [];
    },
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ ...writes }),
  };
  return { db, inserted, updated, wheres, selectCalls, executeCalls };
}

function caller(userId = USER) {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: userId, email: 'staff@example.invalid', name: 'Synthetic Staff' },
    activeTransportId: TRANSPORT,
    accessRole: 'owner',
    transportEmail: 'centurion@example.invalid',
  } as never);
}

let outputDir: string;
const handles: QuoteRunHandle[] = [];
function beginRun(generationId: string, userId = USER, nowMs?: number) {
  const handle = beginQuoteRun({
    generationId,
    transportId: TRANSPORT,
    userId,
    lockKey: '-1',
    nowMs,
  });
  handles.push(handle);
  return handle;
}

async function seedRun(names: string[]) {
  const shots = join(outputDir, RUN, 'screenshots');
  await mkdir(shots, { recursive: true });
  for (const name of names) await writeFile(join(shots, name), PNG);
  await writeFile(join(outputDir, RUN, 'result.json'), '{}');
}

function installation() {
  hoisted.configure.mockReturnValue({
    tenantId: 'synthetic-hotel',
    owner: {
      cdpUrl: 'http://127.0.0.1:9222',
      browserOwnership: 'borrowed',
      propertyCode: 'HRCEN',
      secretPath: '/synthetic/secret.json',
    },
    outputDir,
    ratePolicyConfigurationPath: '/synthetic/policy.json',
  });
  hoisted.services.mockImplementation(
    (options: { onEvidenceDirectory?: (directory: string) => void }) => {
      if (hoisted.emitEvidence) options.onEvidenceDirectory?.(join(outputDir, RUN));
      return {
        resolveQuoteTask: async () => ({}),
        authorizeGuestProposal: async () => true,
      };
    },
  );
}

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'zero-quote-run-'));
  hoisted.emitEvidence = false;
  hoisted.lockReleased = undefined;
  hoisted.configure.mockReset();
  hoisted.services.mockReset();
  hoisted.executeStaffQuote.mockReset();
  vi.stubEnv('DATABASE_URL', 'postgres://synthetic.invalid/quote-run');
});

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.end();
  vi.unstubAllEnvs();
  await rm(outputDir, { recursive: true, force: true });
});

describe('workstation.hmsQueueStatus', () => {
  it('is idle with no message when the caller has no quote in flight', async () => {
    hoisted.db = fakeDb({}).db;
    await expect(caller().workstation.hmsQueueStatus()).resolves.toEqual({
      state: 'idle',
      message: '',
    });
  });

  it('reports the running step from this process without querying the database', async () => {
    const fake = fakeDb({});
    hoisted.db = fake.db;
    beginRun('gen-running').setPhase(1);
    await expect(caller().workstation.hmsQueueStatus()).resolves.toMatchObject({
      state: 'running',
      phase: 'Searching rates',
      phaseIndex: 1,
      phaseCount: 3,
      message: 'Luna is working in HMS – step 1 of 3: Searching rates.',
    });
    expect(fake.selectCalls).not.toHaveBeenCalled();
    expect(fake.executeCalls).not.toHaveBeenCalled();
  });

  it('counts the quotes ahead while waiting, using the lock holder and in-flight quote runs', async () => {
    hoisted.db = fakeDb({ holder: { elapsedMs: 4 * 60_000 }, otherInFlight: 2 }).db;
    beginRun('gen-self', USER, Date.now() - 60_000);
    await expect(caller().workstation.hmsQueueStatus()).resolves.toMatchObject({
      state: 'waiting',
      aheadCount: 1,
      etaMinutes: 6,
      message: '1 quote ahead of yours – about 6 minutes.',
    });
  });

  it('never throws to the pane when the queue lookup fails; it reports idle', async () => {
    hoisted.db = fakeDb({ failExecute: true }).db;
    beginRun('gen-waiting');
    await expect(caller().workstation.hmsQueueStatus()).resolves.toEqual({
      state: 'idle',
      message: '',
    });
  });

  it('does not show another user’s quote run', async () => {
    hoisted.db = fakeDb({}).db;
    beginRun('gen-other-user', 'user-someone-else').setPhase(1);
    await expect(caller().workstation.hmsQueueStatus()).resolves.toEqual({
      state: 'idle',
      message: '',
    });
  });
});

describe('workstation.quoteRunScreenshot', () => {
  it('rejects traversal in the run id or the screenshot name at the procedure boundary', async () => {
    const fake = fakeDb({ ownedRunIds: [RUN] });
    hoisted.db = fake.db;
    hoisted.configure.mockReturnValue({ outputDir });
    await expect(
      caller().workstation.quoteRunScreenshot({ runId: `../${RUN}`, name: 'login-complete.png' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>);
    await expect(
      caller().workstation.quoteRunScreenshot({ runId: RUN, name: '../result.json' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>);
    await expect(
      caller().workstation.quoteRunScreenshot({ runId: RUN, name: '/etc/passwd' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>);
    expect(fake.selectCalls).not.toHaveBeenCalled();
  });

  it('is unavailable for a run this user did not start, without revealing whether it exists', async () => {
    await seedRun(['login-complete.png']);
    const fake = fakeDb({ ownedRunIds: [] });
    hoisted.db = fake.db;
    installation();
    await expect(
      caller().workstation.quoteRunScreenshot({ runId: RUN, name: 'login-complete.png' }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'quote_run_unavailable' });
  });

  it('scopes the ownership lookup to the active mailbox and the requesting user', async () => {
    await seedRun(['login-complete.png']);
    const fake = fakeDb({ ownedRunIds: [RUN] });
    hoisted.db = fake.db;
    installation();
    await caller().workstation.quoteRunScreenshot({ runId: RUN, name: 'login-complete.png' });
    const scoped = fake.wheres.find((entry) => entry.table === aiWorkflowRun);
    expect(scoped).toBeDefined();
    const params = new PgDialect().sqlToQuery(scoped!.condition as never).params;
    expect(params).toEqual(expect.arrayContaining([TRANSPORT, USER, RUN]));
  });

  it('returns the owner’s screenshot as a PNG data URL (happy path)', async () => {
    await seedRun(['login-complete.png']);
    hoisted.db = fakeDb({ ownedRunIds: [RUN] }).db;
    installation();
    await expect(
      caller().workstation.quoteRunScreenshot({ runId: RUN, name: 'login-complete.png' }),
    ).resolves.toEqual({
      status: 'ready',
      name: 'login-complete.png',
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    });
  });
});

describe('workstation.executeStaffQuote run evidence', () => {
  it('returns the run id and the screenshot names, and records the run for owner-only lookup', async () => {
    await seedRun(['login-complete.png', 'group-1-availability-results.png', 'notes.txt']);
    const fake = fakeDb({});
    hoisted.db = fake.db;
    installation();
    hoisted.emitEvidence = true;
    hoisted.executeStaffQuote.mockImplementation(
      async (
        prepared: { authorizationId: string; context: unknown },
        services: { resolveQuoteTask: (c: unknown) => Promise<unknown> },
      ) => {
        await services.resolveQuoteTask(prepared.context);
        return {
          id: 'rev-synthetic-1',
          authorizationId: prepared.authorizationId,
          totalMinor: 220002,
          currency: 'ZAR',
          groups: [{ arrivalDate: '2026-10-12', departureDate: '2026-10-15', context: {} }],
        };
      },
    );

    const quote = await caller().workstation.executeStaffQuote(quoteInput);

    expect(quote).toMatchObject({
      status: 'ready',
      runId: RUN,
      screenshots: ['group-1-availability-results.png', 'login-complete.png'],
    });
    expect(JSON.stringify(quote)).not.toContain(outputDir);
    const run = fake.inserted.find((entry) => entry.table === aiWorkflowRun);
    expect(run?.values.metrics).toMatchObject({ staffQuoteEvidence: { runId: RUN } });
  });

  it('reports the HMS step as 1 while the lock is held and 2 once the quote source returns', async () => {
    await seedRun([]);
    hoisted.db = fakeDb({}).db;
    installation();
    const seen: Array<number | undefined> = [];
    hoisted.executeStaffQuote.mockImplementation(
      async (
        prepared: { authorizationId: string; context: unknown },
        services: { resolveQuoteTask: (c: unknown) => Promise<unknown> },
      ) => {
        seen.push(latestQuoteRunFor({ transportId: TRANSPORT, userId: USER })?.phaseIndex);
        await services.resolveQuoteTask(prepared.context);
        seen.push(latestQuoteRunFor({ transportId: TRANSPORT, userId: USER })?.phaseIndex);
        return {
          id: 'rev-synthetic-2',
          authorizationId: prepared.authorizationId,
          totalMinor: 1,
          currency: 'ZAR',
          groups: [{ arrivalDate: '2026-10-12', departureDate: '2026-10-15', context: {} }],
        };
      },
    );
    await caller().workstation.executeStaffQuote(quoteInput);
    expect(seen).toEqual([1, 2]);
  });

  it('returns a null run id and no screenshots when the capture reported no evidence', async () => {
    hoisted.db = fakeDb({}).db;
    installation();
    hoisted.executeStaffQuote.mockImplementation(async (prepared: { authorizationId: string }) => ({
      id: 'rev-synthetic-3',
      authorizationId: prepared.authorizationId,
      totalMinor: 1,
      currency: 'ZAR',
      groups: [{ arrivalDate: '2026-10-12', departureDate: '2026-10-15', context: {} }],
    }));
    await expect(caller().workstation.executeStaffQuote(quoteInput)).resolves.toMatchObject({
      status: 'ready',
      runId: null,
      screenshots: [],
    });
  });

  it('forgets the in-process run and fails the generation when the quote is not qualified', async () => {
    const fake = fakeDb({});
    hoisted.db = fake.db;
    installation();
    hoisted.executeStaffQuote.mockRejectedValue(new Error('staff_quote_proposal_unauthorized'));
    await expect(caller().workstation.executeStaffQuote(quoteInput)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<TRPCError>);
    expect(latestQuoteRunFor({ transportId: TRANSPORT, userId: USER })).toBeUndefined();
    expect(fake.updated).toContainEqual(
      expect.objectContaining({
        table: aiDraftGeneration,
        values: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});

describe('workstation.executeStaffQuote provisional trace (QUOTE_TRACE_ASYNC)', () => {
  const quoteRevision = (prepared: { authorizationId: string }) => ({
    id: 'rev-synthetic-async',
    authorizationId: prepared.authorizationId,
    totalMinor: 220002,
    currency: 'ZAR',
    groups: [{ arrivalDate: '2026-10-12', departureDate: '2026-10-15', context: {} }],
  });

  /**
   * The installation hands the mutation a finish promise, as the provisional dispatch does. The test
   * decides when the capture child's trace finishes, and whether that finish succeeds.
   */
  function provisionalCapture(options: { failAfterCapture?: boolean } = {}) {
    let emit: ((finished: Promise<void>) => void) | undefined;
    let settle!: { resolve: () => void; reject: (error: Error) => void };
    const finished = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    finished.catch(() => undefined);
    hoisted.configure.mockReturnValue({
      tenantId: 'synthetic-hotel',
      owner: {
        cdpUrl: 'http://127.0.0.1:9222',
        browserOwnership: 'borrowed',
        propertyCode: 'HRCEN',
        secretPath: '/synthetic/secret.json',
      },
      outputDir,
      ratePolicyConfigurationPath: '/synthetic/policy.json',
    });
    hoisted.services.mockImplementation(
      (serviceOptions: {
        onEvidenceDirectory?: (directory: string) => void;
        onTraceFinish?: (finished: Promise<void>) => void;
      }) => {
        emit = serviceOptions.onTraceFinish;
        serviceOptions.onEvidenceDirectory?.(join(outputDir, RUN));
        return { resolveQuoteTask: async () => ({}), authorizeGuestProposal: async () => true };
      },
    );
    hoisted.executeStaffQuote.mockImplementation(async (prepared: { authorizationId: string }) => {
      emit?.(finished);
      if (options.failAfterCapture) throw new Error('staff_quote_proposal_unauthorized');
      return quoteRevision(prepared);
    });
    return {
      finish: () => settle.resolve(),
      fail: (error: Error) => settle.reject(error),
    };
  }

  /** Resolves with the quote if the mutation returns first, or with a marker if it is still waiting. */
  const returnsBeforeFinish = <T>(promise: Promise<T>) =>
    Promise.race([promise, delay(300).then(() => 'still-waiting' as const)]);

  it('returns the captured quote while the trace finishes, releasing the lock and recording the run only after', async () => {
    vi.stubEnv('QUOTE_TRACE_ASYNC', 'on');
    await seedRun(['login-complete.png', 'group-1-availability-results.png']);
    const fake = fakeDb({});
    hoisted.db = fake.db;
    const capture = provisionalCapture();
    const released: string[] = [];
    hoisted.lockReleased = () => released.push('lock');

    const early = await returnsBeforeFinish(caller().workstation.executeStaffQuote(quoteInput));
    expect(early).toMatchObject({ status: 'ready', runId: RUN });
    expect(released).toEqual([]);
    expect(fake.inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(false);

    capture.finish();
    await awaitPendingStaffQuote(RUN);
    expect(released).toEqual(['lock']);
    const run = fake.inserted.find((entry) => entry.table === aiWorkflowRun);
    expect(run?.values.metrics).toMatchObject({ staffQuoteEvidence: { runId: RUN } });
  });

  it('when the trace fails, the quote was already returned but no run is recorded and the generation fails', async () => {
    vi.stubEnv('QUOTE_TRACE_ASYNC', 'on');
    await seedRun(['group-1-availability-results.png']);
    const fake = fakeDb({});
    hoisted.db = fake.db;
    const capture = provisionalCapture();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const early = await returnsBeforeFinish(caller().workstation.executeStaffQuote(quoteInput));
    expect(early).toMatchObject({ status: 'ready' });
    capture.fail(new Error('staff_quote_trace_finish_failed'));
    await awaitPendingStaffQuote(RUN);

    expect(fake.inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(false);
    expect(fake.updated).toContainEqual(
      expect.objectContaining({
        table: aiDraftGeneration,
        values: expect.objectContaining({
          status: 'failed',
          errorMessage: 'staff_quote_trace_finish_failed',
        }),
      }),
    );
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('not recorded'));
    logged.mockRestore();
  });

  it('a newer approval during the trace stops the run from being recorded', async () => {
    vi.stubEnv('QUOTE_TRACE_ASYNC', 'on');
    await seedRun(['group-1-availability-results.png']);
    const fake = fakeDb({});
    hoisted.db = fake.db;
    const capture = provisionalCapture();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await caller().workstation.executeStaffQuote(quoteInput);
    // A later approval for the same message becomes the latest generation.
    await (
      fake.db as unknown as {
        insert: (table: unknown) => { values: (values: Record<string, unknown>) => Promise<void> };
      }
    )
      .insert(aiDraftGeneration)
      .values({ id: 'gen-newer-approval' });
    capture.finish();
    await awaitPendingStaffQuote(RUN);

    expect(fake.inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('staff_quote_superseded'));
    logged.mockRestore();
  });

  it('the quote choices for a message wait for a provisional run to finish before listing it', async () => {
    vi.stubEnv('QUOTE_TRACE_ASYNC', 'on');
    await seedRun(['group-1-availability-results.png']);
    hoisted.db = fakeDb({}).db;
    const capture = provisionalCapture();
    await caller().workstation.executeStaffQuote(quoteInput);

    const choices = caller().workstation.qualifiedProposalChoices({
      internetMessageId: mail.messageIdHeader,
    });
    await expect(returnsBeforeFinish(choices)).resolves.toBe('still-waiting');
    capture.finish();
    await expect(choices).resolves.toMatchObject({ messageId: mail.id });
  });

  it('a screenshot for a provisional run waits for its trace to finish before it is read', async () => {
    vi.stubEnv('QUOTE_TRACE_ASYNC', 'on');
    await seedRun(['group-1-availability-results.png']);
    hoisted.db = fakeDb({ ownedRunIds: [RUN] }).db;
    const capture = provisionalCapture();
    await caller().workstation.executeStaffQuote(quoteInput);

    const shot = caller().workstation.quoteRunScreenshot({
      runId: RUN,
      name: 'group-1-availability-results.png',
    });
    await expect(returnsBeforeFinish(shot)).resolves.toBe('still-waiting');
    capture.finish();
    await expect(shot).resolves.toMatchObject({
      status: 'ready',
      name: 'group-1-availability-results.png',
    });
  });

  it('when the quote fails after a provisional capture, the failure waits for the trace and records nothing', async () => {
    vi.stubEnv('QUOTE_TRACE_ASYNC', 'on');
    await seedRun([]);
    const fake = fakeDb({});
    hoisted.db = fake.db;
    const capture = provisionalCapture({ failAfterCapture: true });
    const outcome = caller()
      .workstation.executeStaffQuote(quoteInput)
      .then(
        () => 'resolved',
        (error: TRPCError) => error.code,
      );

    await expect(returnsBeforeFinish(outcome)).resolves.toBe('still-waiting');
    capture.finish();
    await expect(outcome).resolves.toBe('PRECONDITION_FAILED');
    expect(fake.inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(false);
  });

  it('with the flag off, the lock is released before the run is recorded, as before', async () => {
    vi.stubEnv('QUOTE_TRACE_ASYNC', 'off');
    await seedRun(['group-1-availability-results.png']);
    const fake = fakeDb({});
    hoisted.db = fake.db;
    installation();
    hoisted.emitEvidence = true;
    const order: string[] = [];
    const runsRecorded = () => fake.inserted.filter((entry) => entry.table === aiWorkflowRun).length;
    hoisted.lockReleased = () => order.push(`lock with ${runsRecorded()} runs recorded`);
    hoisted.executeStaffQuote.mockImplementation(async (prepared: { authorizationId: string }) =>
      quoteRevision(prepared),
    );

    const quote = await caller().workstation.executeStaffQuote(quoteInput);
    expect(quote).toMatchObject({ status: 'ready', runId: RUN });
    expect(order).toEqual(['lock with 0 runs recorded']);
    expect(fake.inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(true);
  });

  it('with the flag on but no provisional capture, the run is recorded before the response, as before', async () => {
    vi.stubEnv('QUOTE_TRACE_ASYNC', 'on');
    await seedRun(['group-1-availability-results.png']);
    const fake = fakeDb({});
    hoisted.db = fake.db;
    installation();
    hoisted.emitEvidence = true;
    hoisted.executeStaffQuote.mockImplementation(async (prepared: { authorizationId: string }) =>
      quoteRevision(prepared),
    );

    const quote = await caller().workstation.executeStaffQuote(quoteInput);
    expect(quote).toMatchObject({ status: 'ready', runId: RUN });
    expect(fake.inserted.some((entry) => entry.table === aiWorkflowRun)).toBe(true);
  });
});
