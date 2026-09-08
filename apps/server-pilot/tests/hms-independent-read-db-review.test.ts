import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { __setDbForTests, type DB } from '../src/db/client.js';
import {
  aiWorkflowRun,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import {
  claimNextAiRun,
  enqueueAiRun,
  markAiRunSucceeded,
  NOT_APPLICABLE_MODEL_ID,
  READ_TOOL_PROMPT_VERSION,
  readAiRunReceipt,
} from '../src/ai/run-ledger.js';
import {
  executeAiRun,
  runAiWorkerOnce,
  type CandidateSessionFactory,
} from '../src/ai/worker.js';
import * as mastraModule from '../src/ai/mastra.js';
import type { CandidateToolSession } from '../src/ai/candidate-draft-agent.js';
import { createPostgresPropertyReadLock } from '../src/hms/property-read-lock.js';
import { readInputDigest, readReservationRef } from '../src/hms/read-service-contracts.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();
const observedAt = '2026-09-07T12:00:00.000Z';
const expiresAt = '2026-09-07T12:05:00.000Z';

const typedReadResult = {
  toolId: 'hms_find_reservation' as const,
  schemaVersion: 'reservation-find/1',
  status: 'ok' as const,
  data: { matches: [], matchCount: 0, capped: false },
  completeness: 'complete' as const,
  unavailableSections: [],
  scopeRef: 'resref-red',
  evidence: [
    {
      evidenceRef: 'evidence-red',
      sourceSystem: 'hms' as const,
      sourceSurface: 'guest-stay',
      requestBranchId: 'guest_stay_search',
      observedAt,
      sourceUpdatedAt: null,
      expiresAt,
      scopeVerified: true,
      artifactRef: null,
    },
  ],
  page: null,
  issues: [],
};

async function withWorkerDb<T>(callback: (db: DB) => Promise<T>): Promise<T> {
  return withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    try {
      return await callback(db);
    } finally {
      __setDbForTests(null);
    }
  });
}

async function seededMailContext(db: DB) {
  const transportId = randomUUID();
  const threadId = randomUUID();
  const triggerMessageId = randomUUID();
  await db.insert(mailboxTransport).values({
    id: transportId,
    email: `u8-review-${transportId.slice(0, 8)}@example.com`,
    ownerHeaderValue: `u8-review-${transportId.slice(0, 8)}@example.com`,
  });
  await db.insert(mailThread).values({
    id: threadId,
    transportId,
    threadRootId: `<u8-review-${threadId}@example.com>`,
    subject: 'U8 review fixture',
    snippet: 'U8 review fixture',
    latestMessageAt: new Date(observedAt),
  });
  await db.insert(message).values({
    id: triggerMessageId,
    transportId,
    threadId,
    direction: 'inbound',
    fromAddress: 'u8-review@example.com',
    toAddresses: ['nava@example.com'],
    subject: 'U8 review fixture',
    textBody: 'U8 review fixture confirmation CONF-RED',
    receivedAt: new Date(observedAt),
  });
  return {
    transportId,
    threadId,
    triggerMessageId,
  };
}

async function withReadOnlyWorkerEnv<T>(callback: () => Promise<T>): Promise<T> {
  const keys = [
    'PORT',
    'BETTER_AUTH_URL',
    'BETTER_AUTH_SECRET',
    'AWS_REGION',
    'S3_BUCKET',
    'AI_WORKER_LANE',
    'HMS_READ_SERVICE_ENABLED',
    'HMS_DRAFT_ENRICHMENT_MODE',
    'HMS_RUN_DEADLINE_MS',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.PORT = '3000';
  process.env.BETTER_AUTH_URL = 'https://nava.legacy.local';
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(32);
  process.env.AWS_REGION = 'synthetic-region-1';
  process.env.S3_BUCKET = 'u8-review-synthetic-bucket';
  process.env.AI_WORKER_LANE = 'hms';
  process.env.HMS_READ_SERVICE_ENABLED = 'true';
  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
  process.env.HMS_RUN_DEADLINE_MS = '150000';
  try {
    return await callback();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function readRunInput(context: Awaited<ReturnType<typeof seededMailContext>>, suffix: string) {
  const closedRequest = {
    toolId: 'hms_find_reservation' as const,
    candidateId: '61029cf2ae474e6a',
  };
  return {
    ...context,
    runKind: 'read_tool' as const,
    idempotencyKey: `u8-review-read:${suffix}:${randomUUID()}`,
    modelId: NOT_APPLICABLE_MODEL_ID,
    promptVersion: READ_TOOL_PROMPT_VERSION,
    executorLane: 'hms' as const,
    readRequest: {
      ...closedRequest,
      admission: {
        releaseId: 'release-red',
        requestBranchId: 'guest_stay_search',
        requesterAuthorizationId: 'auth-red',
        inputDigest: readInputDigest(closedRequest),
        captureRequired: false,
        captureBindingRef: null,
        reservationRef: null,
      },
    },
    readResultRef: `receipt-red-${suffix}`,
  };
}

function contextReadRunInput(
  context: Awaited<ReturnType<typeof seededMailContext>>,
  suffix: string,
  overrides: { reservationRef?: string; candidateId?: string } = {},
) {
  const candidateId = overrides.candidateId ?? '61029cf2ae474e6a';
  const closedRequest = {
    toolId: 'hms_read_reservation' as const,
    reservationRef: overrides.reservationRef ?? readReservationRef({
      transportId: context.transportId,
      threadId: context.threadId,
      triggerMessageId: context.triggerMessageId,
      candidateId,
    }),
    candidateId,
    sections: ['core', 'stay'] as const,
    detail: 'summary' as const,
  };
  return {
    ...context,
    runKind: 'read_tool' as const,
    idempotencyKey: `u8-review-context:${suffix}:${randomUUID()}`,
    modelId: NOT_APPLICABLE_MODEL_ID,
    promptVersion: READ_TOOL_PROMPT_VERSION,
    executorLane: 'hms' as const,
    readRequest: {
      ...closedRequest,
      admission: {
        releaseId: 'release-red',
        requestBranchId: 'guest_stay_search',
        requesterAuthorizationId: 'auth-red',
        inputDigest: readInputDigest(closedRequest),
        captureRequired: false,
        captureBindingRef: null,
        reservationRef: closedRequest.reservationRef,
      },
    },
    readResultRef: `receipt-red-${suffix}`,
  };
}

async function seedReceiptRow(
  db: DB,
  suffix: string,
  overrides: {
    state?: 'queued' | 'succeeded';
    readResult?: unknown;
    readResultExpiresAt?: Date;
  } = {},
) {
  const context = await seededMailContext(db);
  const run = await enqueueAiRun(readRunInput(context, `receipt-${suffix}`), db);
  const readResultRef = `receipt-red-${suffix}`;
  await db
    .update(aiWorkflowRun)
    .set({
      state: overrides.state ?? 'succeeded',
      readResultRef,
      readResult: overrides.readResult ?? typedReadResult,
      readResultExpiresAt: overrides.readResultExpiresAt ?? new Date('2099-09-07T12:05:00.000Z'),
    })
    .where(eq(aiWorkflowRun.id, run.id));
  return { context, run, readResultRef };
}

type SyntheticReservationRead = Awaited<ReturnType<CandidateToolSession['findReservation']>>;

function syntheticMatchedRead(
  evidenceId: string,
  resultExpiresAt: string,
): SyntheticReservationRead {
  return {
    status: 'ok',
    draftReady: false,
    data: {
      matches: [{
        confirmationNumber: 'CONF-RED',
        externalReference: null,
        guestName: null,
        reservationStatus: 'Confirmed',
        arrivalDate: '2026-09-10',
        departureDate: '2026-09-12',
        roomType: 'STD',
        ratePlan: null,
      }],
      matchCount: 1,
      capped: false,
    },
    unresolvedFields: [],
    evidence: {
      kind: 'hms',
      id: evidenceId,
      toolId: 'hms_find_reservation',
      toolVersion: '1.2.0',
      propertyCode: 'HRCEN',
      observedAt,
      expiresAt: resultExpiresAt,
      claimKeys: [],
      sourceHash: 'c'.repeat(64),
    },
  };
}

function syntheticReadSessionFactory(
  findReservation: CandidateToolSession['findReservation'],
): CandidateSessionFactory {
  return async ({ lookupCandidates }) => ({
    findReservation,
    quoteStay: async () => { throw new Error('not used'); },
    readArtifact: async () => { throw new Error('not used'); },
    lookupCandidates: new Map(lookupCandidates.map((candidate) => [candidate.id, candidate])),
    authorizedAttachmentIds: new Set(),
    propertyReadLock: {
      key: '1',
      withLock: async (callback) => callback({
        query: async () => [],
        close: async () => undefined,
      }),
    },
  });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('U8 independent review DB RED contracts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('claims a read_tool with drafting off and durably retains the typed receipt body', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(readRunInput(context, 'body'), db);
        const claimed = await claimNextAiRun({
          ownerId: 'hms-review-worker',
          lane: 'hms',
          runKind: 'read_tool',
          db,
        });
        expect(claimed?.id).toBe(run.id);

        const modelRuntime = vi.spyOn(mastraModule, 'createMastraRuntime');
        const result = await executeAiRun(run.id, {
          readToolExecutor: async () => ({
            result: typedReadResult,
            readResultRef: 'receipt-red-body',
          }),
        });

        expect(result.state).toBe('succeeded');
        expect(modelRuntime).not.toHaveBeenCalled();
        const [stored] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, run.id));
        expect(stored?.readResultRef).toBe('receipt-red-body');
        expect(stored?.readResult).toEqual(typedReadResult);
        const receipt = await readAiRunReceipt({
          readResultRef: 'receipt-red-body',
          transportId: context.transportId,
          threadId: context.threadId,
          triggerMessageId: context.triggerMessageId,
          requesterAuthorizationId: 'auth-red',
          now: new Date('2026-09-07T12:00:00.000Z'),
        }, db);
        expect(receipt?.result).toEqual(typedReadResult);
      });
    });
  });

  it('rejects a read_tool enqueue without trusted admission', async () => {
    await withWorkerDb(async (db) => {
      const context = await seededMailContext(db);
      const input = readRunInput(context, 'missing-admission');
      const { admission: _admission, ...closedRequest } = input.readRequest;

      await expect(enqueueAiRun({ ...input, readRequest: closedRequest }, db)).rejects.toThrow(/admission/i);
    });
  });

  it('requires a succeeded state before returning a durable receipt', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'nonterminal', { state: 'queued' });
      await expect(readAiRunReceipt({
        readResultRef,
        transportId: context.transportId,
        threadId: context.threadId,
        triggerMessageId: context.triggerMessageId,
        requesterAuthorizationId: 'auth-red',
      }, db)).resolves.toBeNull();
    });
  });

  it('rejects a receipt with the wrong mail scope', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'wrong-scope');
      await expect(readAiRunReceipt({
        readResultRef,
        transportId: 'foreign-transport',
        threadId: context.threadId,
        triggerMessageId: context.triggerMessageId,
        requesterAuthorizationId: 'auth-red',
      }, db)).resolves.toBeNull();
    });
  });

  it('rejects a receipt for the wrong trusted requester', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'wrong-requester');
      await expect(readAiRunReceipt({
        readResultRef,
        transportId: context.transportId,
        threadId: context.threadId,
        triggerMessageId: context.triggerMessageId,
        requesterAuthorizationId: 'auth-foreign',
      }, db)).resolves.toBeNull();
    });
  });

  it('rejects an expired receipt', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'expired', {
        readResultExpiresAt: new Date('2026-09-07T12:00:00.000Z'),
      });
      await expect(readAiRunReceipt({
        readResultRef,
        transportId: context.transportId,
        threadId: context.threadId,
        triggerMessageId: context.triggerMessageId,
        requesterAuthorizationId: 'auth-red',
        now: new Date('2026-09-07T12:00:00.000Z'),
      }, db)).resolves.toBeNull();
    });
  });

  it('rejects a replayed or foreign receipt reference', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'replay');
      await expect(readAiRunReceipt({
        readResultRef: `${readResultRef}-foreign`,
        transportId: context.transportId,
        threadId: context.threadId,
        triggerMessageId: context.triggerMessageId,
        requesterAuthorizationId: 'auth-red',
      }, db)).resolves.toBeNull();
      await expect(readAiRunReceipt({
        readResultRef,
        transportId: context.transportId,
        threadId: 'foreign-thread',
        triggerMessageId: context.triggerMessageId,
        requesterAuthorizationId: 'auth-red',
      }, db)).resolves.toBeNull();
    });
  });

  it('rejects a malformed durable receipt body', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'malformed', { readResult: {} });
      await expect(readAiRunReceipt({
        readResultRef,
        transportId: context.transportId,
        threadId: context.threadId,
        triggerMessageId: context.triggerMessageId,
        requesterAuthorizationId: 'auth-red',
      }, db)).rejects.toThrow();
    });
  });

  it('does not overwrite a receipt when the durable success fence is stale', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(readRunInput(context, 'stale-fence'), db);
        const claimed = await claimNextAiRun({ ownerId: 'hms-review-worker', lane: 'hms', runKind: 'read_tool', db });
        expect(claimed?.id).toBe(run.id);
        const originalRef = 'receipt-red-stale-original';
        await db.update(aiWorkflowRun).set({
          readResultRef: originalRef,
          readResult: typedReadResult,
          readResultExpiresAt: new Date('2099-09-07T12:05:00.000Z'),
        }).where(eq(aiWorkflowRun.id, run.id));

        const staleWrite = await markAiRunSucceeded({
          runId: run.id,
          claimOwner: 'stale-owner',
          claimToken: 'stale-token',
          expectedStates: ['running'],
          readResultRef: 'receipt-red-stale-overwrite',
          readResult: { ...typedReadResult, status: 'not_found' },
          readResultExpiresAt: new Date('2099-09-07T12:06:00.000Z'),
        }, db);
        expect(staleWrite).toBeNull();
        const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
        expect(stored?.readResultRef).toBe(originalRef);
        expect(stored?.readResult).toEqual(typedReadResult);
      });
    });
  });

  it('runs the production adapter around a synthetic PMS boundary and persists its typed receipt', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(readRunInput(context, 'adapter'), db);
        const claimed = await claimNextAiRun({
          ownerId: 'hms-review-worker',
          lane: 'hms',
          runKind: 'read_tool',
          db,
        });
        expect(claimed?.id).toBe(run.id);

        const externalBoundary = vi.fn(async () => ({
          status: 'ok' as const,
          draftReady: false,
          data: {
            matches: [{
              confirmationNumber: 'CONF-RED',
              externalReference: null,
              guestName: null,
              reservationStatus: 'Confirmed',
              arrivalDate: '2026-09-10',
              departureDate: '2026-09-12',
              roomType: 'STD',
              ratePlan: null,
            }],
            matchCount: 1,
            capped: false,
          },
          unresolvedFields: [],
          evidence: {
            kind: 'hms' as const,
            id: 'evidence-red-adapter',
            toolId: 'hms_find_reservation' as const,
            toolVersion: '1.2.0',
            propertyCode: 'HRCEN',
            observedAt,
            expiresAt,
            claimKeys: [],
            sourceHash: 'a'.repeat(64),
          },
        }));
        const result = await executeAiRun(run.id, {
          candidateSessionFactory: async ({ lookupCandidates }) => ({
            findReservation: externalBoundary,
            quoteStay: async () => { throw new Error('not used'); },
            readArtifact: async () => { throw new Error('not used'); },
            lookupCandidates: new Map(lookupCandidates.map((candidate) => [candidate.id, candidate])),
            authorizedAttachmentIds: new Set(),
            propertyReadLock: {
              key: '1',
              withLock: async (callback) => callback({
                query: async () => [],
                close: async () => undefined,
              }),
            },
          }),
        });

        expect(result.state).toBe('succeeded');
        expect(externalBoundary).toHaveBeenCalledOnce();
        const [stored] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, run.id));
        expect(stored?.readResult).toMatchObject({
          toolId: 'hms_find_reservation',
          status: 'ok',
        });
      });
    });
  });

  it('executes the normal resolved-context path through the same adapter and fence', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(contextReadRunInput(context, 'context'), db);
        const claimed = await claimNextAiRun({
          ownerId: 'hms-review-worker',
          lane: 'hms',
          runKind: 'read_tool',
          db,
        });
        expect(claimed?.id).toBe(run.id);

        const contextObservedAt = '2099-09-07T12:00:00.000Z';
        const contextExpiresAt = '2099-09-07T12:05:00.000Z';
        let lockDepth = 0;
        const externalBoundary = vi.fn(async () => ({
          ...(() => {
            expect(lockDepth).toBe(1);
            return {};
          })(),
          status: 'ok' as const,
          draftReady: false,
          data: {
            matches: [{
              confirmationNumber: 'CONF-RED',
              externalReference: null,
              guestName: null,
              reservationStatus: 'Confirmed',
              arrivalDate: '2026-09-10',
              departureDate: '2026-09-12',
              roomType: 'STD',
              ratePlan: null,
            }],
            matchCount: 1,
            capped: false,
          },
          unresolvedFields: [],
          evidence: {
            kind: 'hms' as const,
            id: 'evidence-red-context',
            toolId: 'hms_find_reservation' as const,
            toolVersion: '1.2.0',
            propertyCode: 'HRCEN',
            observedAt: contextObservedAt,
            expiresAt: contextExpiresAt,
            claimKeys: [],
            sourceHash: 'b'.repeat(64),
          },
        }));
        const result = await executeAiRun(run.id, {
          candidateSessionFactory: async ({ lookupCandidates }) => ({
            findReservation: externalBoundary,
            quoteStay: async () => { throw new Error('not used'); },
            readArtifact: async () => { throw new Error('not used'); },
            lookupCandidates: new Map(lookupCandidates.map((candidate) => [candidate.id, candidate])),
            authorizedAttachmentIds: new Set(),
            propertyReadLock: {
              key: '1',
              withLock: async (callback) => {
                lockDepth += 1;
                try {
                  return await callback({
                    query: async () => [],
                    close: async () => undefined,
                  });
                } finally {
                  lockDepth -= 1;
                }
              },
            },
          }),
        });
        expect(result.state).toBe('succeeded');
        expect(externalBoundary).toHaveBeenCalledOnce();
        const [stored] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, run.id));
        expect(stored?.readResult).toMatchObject({
          toolId: 'hms_read_reservation',
          status: 'ok',
        });
      });
    });
  });

  it('rejects an unminted resolved-context reference before opening the session', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(
          contextReadRunInput(context, 'unminted', { reservationRef: 'model-invented-ref' }),
          db,
        );
        expect(await claimNextAiRun({ ownerId: 'hms-review-worker', lane: 'hms', runKind: 'read_tool', db })).toMatchObject({ id: run.id });
        const sessionFactory = vi.fn(syntheticReadSessionFactory(async () =>
          syntheticMatchedRead('evidence-red-unminted', '2099-09-07T12:05:00.000Z')));

        const result = await executeAiRun(run.id, { candidateSessionFactory: sessionFactory });

        expect(result.state).toBe('dead_letter');
        expect(sessionFactory).not.toHaveBeenCalled();
      });
    });
  });

  it('rejects a replayed reference from a foreign candidate scope', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(
          contextReadRunInput(context, 'foreign-candidate', {
            candidateId: 'foreign-candidate',
            reservationRef: 'foreign-candidate',
          }),
          db,
        );
        expect(await claimNextAiRun({ ownerId: 'hms-review-worker', lane: 'hms', runKind: 'read_tool', db })).toMatchObject({ id: run.id });
        const sessionFactory = vi.fn(syntheticReadSessionFactory(async () =>
          syntheticMatchedRead('evidence-red-foreign', '2099-09-07T12:05:00.000Z')));

        const result = await executeAiRun(run.id, { candidateSessionFactory: sessionFactory });

        expect(result.state).toBe('dead_letter');
        expect(sessionFactory).not.toHaveBeenCalled();
      });
    });
  });

  it('rejects a reservation reference replayed into another thread scope', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const originalContext = await seededMailContext(db);
        const replayContext = await seededMailContext(db);
        expect(originalContext.threadId).not.toBe(replayContext.threadId);
        const run = await enqueueAiRun(
          contextReadRunInput(replayContext, 'replayed-thread-ref', {
            reservationRef: '61029cf2ae474e6a',
          }),
          db,
        );
        expect(await claimNextAiRun({ ownerId: 'hms-review-worker', lane: 'hms', runKind: 'read_tool', db })).toMatchObject({ id: run.id });
        const sessionFactory = vi.fn(syntheticReadSessionFactory(async () =>
          syntheticMatchedRead('evidence-red-replayed-thread', '2099-09-07T12:05:00.000Z')));

        const result = await executeAiRun(run.id, { candidateSessionFactory: sessionFactory });

        expect(result.state).toBe('dead_letter');
        expect(sessionFactory).not.toHaveBeenCalled();
      });
    });
  });

  it('rejects a resolved context whose matched evidence is expired', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(contextReadRunInput(context, 'expired-context'), db);
        expect(await claimNextAiRun({ ownerId: 'hms-review-worker', lane: 'hms', runKind: 'read_tool', db })).toMatchObject({ id: run.id });
        const externalBoundary = vi.fn(async () =>
          syntheticMatchedRead('evidence-red-expired-context', '2026-09-07T12:00:00.000Z'));

        const result = await executeAiRun(run.id, {
          candidateSessionFactory: syntheticReadSessionFactory(externalBoundary),
        });

        expect(result.state).toBe('dead_letter');
        expect(externalBoundary).toHaveBeenCalledOnce();
      });
    });
  });

  it('does not let drafting-off HMS claims consume a queued draft ahead of a read', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const draft = await enqueueAiRun(
          {
            ...context,
            runKind: 'candidate_draft',
            idempotencyKey: `u8-review-draft:${randomUUID()}`,
            modelId: 'test-model',
            promptVersion: 'draft-v1',
            executorLane: 'hms',
          },
          db,
        );
        const read = await enqueueAiRun(readRunInput(context, 'isolation'), db);
        const readExecutor = vi.fn(async () => ({
          result: typedReadResult,
          readResultRef: 'receipt-red-isolation',
        }));

        expect(await runAiWorkerOnce({ readToolExecutor: readExecutor })).toBe(true);
        expect(readExecutor).toHaveBeenCalledOnce();
        const [storedDraft] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, draft.id));
        const [storedRead] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, read.id));
        expect(storedDraft?.state).toBe('queued');
        expect(storedRead?.state).toBe('succeeded');
      });
    });
  });

  it('serializes two real PG connections and fails closed when the held lock is lost', async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('owned disposable TEST_DATABASE_URL is required');
    const firstLock = createPostgresPropertyReadLock({
      tenantId: 'tenant-u8-review',
      propertyCode: 'HRCEN',
      databaseUrl,
    });
    const secondLock = createPostgresPropertyReadLock({
      tenantId: 'tenant-u8-review',
      propertyCode: 'HRCEN',
      databaseUrl,
    });

    let releaseFirst = () => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      const release = () => resolve();
      releaseFirst = release;
    });
    let enteredFirst = false;
    const first = firstLock.withLock(async () => {
      enteredFirst = true;
      await firstEntered;
      return 'first';
    });

    while (!enteredFirst) await new Promise((resolve) => setTimeout(resolve, 5));
    let enteredSecond = false;
    const second = secondLock.withLock(async () => {
      enteredSecond = true;
      return 'second';
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(enteredSecond).toBe(false);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
    }
    expect(enteredSecond).toBe(true);

    await expect(
      firstLock.withLock(async (connection) => {
        await connection.query(`SELECT pg_advisory_unlock(${firstLock.key})`);
        return 'unexpected-success';
      }),
    ).rejects.toMatchObject({ code: 'PROPERTY_READ_LOCK_LOST' });
  });
});
