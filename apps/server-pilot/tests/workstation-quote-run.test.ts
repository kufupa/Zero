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

const hoisted = vi.hoisted(() => ({
  db: undefined as unknown,
  configure: vi.fn(),
  services: vi.fn(),
  executeStaffQuote: vi.fn(),
  emitEvidence: false,
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
    withLock: async <T>(callback: () => Promise<T>) => callback(),
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
