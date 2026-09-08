import {
  claimNextAiRun,
  enqueueAiRun,
  markAiRunSucceeded,
  NOT_APPLICABLE_MODEL_ID,
  READ_TOOL_PROMPT_VERSION,
  readAiRunReceipt,
} from '../src/ai/run-ledger.js';
import {
  __setCachedActiveReadRuntimeForTests,
  clearCachedActiveReadRuntimeForTests,
  type ActiveReadRuntimeState,
} from '../src/hms/active-read-runtime.js';
import {
  aiWorkflowRun,
  mailboxAccess,
  mailboxTransport,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import {
  extractLookupCandidates,
  filterExactReservationCandidates,
} from '../src/ai/thread-context.js';
import { executeAiRun, runAiWorkerOnce, type CandidateSessionFactory } from '../src/ai/worker.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { issueReadAdmissionFromMailbox } from '../src/hms/read-admission-issuer.js';
import { CENTURION_USER_ID, MARTHA_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { createPostgresPropertyReadLock } from '../src/hms/property-read-lock.js';
import type { CandidateToolSession } from '../src/ai/candidate-draft-agent.js';
import { __setDbForTests, getDb, type DB } from '../src/db/client.js';
import { resolveMailboxContext } from '../src/trpc/context.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as mastraModule from '../src/ai/mastra.js';
import { appRouter } from '../src/trpc/router.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const reachable = await probeTestDb();
const observedAt = '2026-09-07T12:00:00.000Z';
const expiresAt = '2026-09-07T12:05:00.000Z';
const REQUESTER_AUTHORIZATION_ID = `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`;

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
  const transportId = TRANSPORT_ID;
  const threadId = randomUUID();
  const triggerMessageId = randomUUID();
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

const positiveFindResult = {
  toolId: 'hms_find_reservation' as const,
  schemaVersion: 'reservation-find/1',
  status: 'ok' as const,
  data: {
    matches: [
      {
        reservationRef: null,
        label: {
          state: 'known' as const,
          value: 'CONF-RED',
          data: 'CONF-RED',
          evidenceRef: 'evidence-red',
          observedAt,
          sourceUpdatedAt: null,
          expiresAt: '2099-09-07T12:05:00.000Z',
        },
        referenceKind: {
          state: 'known' as const,
          value: 'confirmation',
          data: 'confirmation',
          evidenceRef: 'evidence-red',
          observedAt,
          sourceUpdatedAt: null,
          expiresAt: '2099-09-07T12:05:00.000Z',
        },
        status: {
          state: 'known' as const,
          value: 'Confirmed',
          data: 'Confirmed',
          evidenceRef: 'evidence-red',
          observedAt,
          sourceUpdatedAt: null,
          expiresAt: '2099-09-07T12:05:00.000Z',
        },
        arrival: {
          state: 'known' as const,
          value: '2026-09-10',
          data: '2026-09-10',
          evidenceRef: 'evidence-red',
          observedAt,
          sourceUpdatedAt: null,
          expiresAt: '2099-09-07T12:05:00.000Z',
        },
        departure: {
          state: 'known' as const,
          value: '2026-09-12',
          data: '2026-09-12',
          evidenceRef: 'evidence-red',
          observedAt,
          sourceUpdatedAt: null,
          expiresAt: '2099-09-07T12:05:00.000Z',
        },
        roomType: {
          state: 'known' as const,
          value: 'STD',
          data: 'STD',
          evidenceRef: 'evidence-red',
          observedAt,
          sourceUpdatedAt: null,
          expiresAt: '2099-09-07T12:05:00.000Z',
        },
        matchEvidenceRefs: ['evidence-red'],
      },
    ],
    matchCount: 1,
    capped: false,
  },
  completeness: 'complete' as const,
  unavailableSections: [],
  scopeRef: 'scope-red',
  evidence: [
    {
      evidenceRef: 'evidence-red',
      sourceSystem: 'hms' as const,
      sourceSurface: 'guest-stay',
      requestBranchId: 'guest_stay_search',
      observedAt,
      sourceUpdatedAt: null,
      expiresAt: '2099-09-07T12:05:00.000Z',
      scopeVerified: true,
      artifactRef: null,
    },
  ],
  page: null,
  issues: [],
};

async function readRunInput(
  context: Awaited<ReturnType<typeof seededMailContext>>,
  suffix: string,
) {
  const readResultRef = `receipt-red-${suffix}`;
  const issued = await issueReadAdmissionFromMailbox({
    db: getDb(),
    userId: CENTURION_USER_ID,
    transportId: context.transportId,
    threadId: context.threadId,
    toolId: 'hms_find_reservation',
    releaseId: 'release-red',
    requestBranchId: 'guest_stay_search',
    captureBindingRef: readResultRef,
  });
  return {
    ...context,
    runKind: 'read_tool' as const,
    idempotencyKey: `u8-review-read:${suffix}:${randomUUID()}`,
    modelId: NOT_APPLICABLE_MODEL_ID,
    promptVersion: READ_TOOL_PROMPT_VERSION,
    executorLane: 'hms' as const,
    readRequest: issued.readRequest,
    readAdmissionIssuer: issued.issuer,
    readResultRef,
  };
}

async function contextReadRunInput(
  context: Awaited<ReturnType<typeof seededMailContext>>,
  suffix: string,
  overrides: {
    reservationRef?: string;
    candidateId?: string;
    reservationRefIssuedAt?: string;
    reservationRefExpiresAt?: string;
  } = {},
) {
  const db = getDb();
  const parentRef = `parent-red-${suffix}-${randomUUID()}`;
  const readResultRef = `receipt-red-${suffix}`;
  const find = await issueReadAdmissionFromMailbox({
    db,
    userId: CENTURION_USER_ID,
    transportId: context.transportId,
    threadId: context.threadId,
    toolId: 'hms_find_reservation',
    releaseId: 'release-red',
    requestBranchId: 'guest_stay_search',
    captureBindingRef: parentRef,
  });
  const parent = await enqueueAiRun(
    {
      ...context,
      runKind: 'read_tool' as const,
      idempotencyKey: `u8-review-parent:${suffix}:${randomUUID()}`,
      modelId: NOT_APPLICABLE_MODEL_ID,
      promptVersion: READ_TOOL_PROMPT_VERSION,
      executorLane: 'hms' as const,
      readRequest: find.readRequest,
      readAdmissionIssuer: find.issuer,
      readResultRef: parentRef,
    },
    db,
  );
  await db
    .update(aiWorkflowRun)
    .set({
      state: 'succeeded',
      readResult: positiveFindResult,
      readResultExpiresAt: new Date('2099-09-07T12:05:00.000Z'),
    })
    .where(eq(aiWorkflowRun.id, parent.id));
  const issued = await issueReadAdmissionFromMailbox({
    db,
    userId: CENTURION_USER_ID,
    transportId: context.transportId,
    threadId: context.threadId,
    toolId: 'hms_read_reservation',
    parentReadResultRef: parentRef,
    sections: ['core', 'stay'],
    detail: 'summary',
    releaseId: 'release-red',
    requestBranchId: 'guest_stay_search',
    captureBindingRef: readResultRef,
  });
  return {
    ...context,
    runKind: 'read_tool' as const,
    idempotencyKey: `u8-review-context:${suffix}:${randomUUID()}`,
    modelId: NOT_APPLICABLE_MODEL_ID,
    promptVersion: READ_TOOL_PROMPT_VERSION,
    executorLane: 'hms' as const,
    readRequest: {
      ...issued.readRequest,
      ...(overrides.candidateId === undefined ? {} : { candidateId: overrides.candidateId }),
      ...(overrides.reservationRef === undefined
        ? {}
        : { reservationRef: overrides.reservationRef }),
      admission: {
        ...issued.admission,
        ...(overrides.reservationRef === undefined
          ? {}
          : { reservationRef: overrides.reservationRef }),
        ...(overrides.reservationRefIssuedAt === undefined
          ? {}
          : { reservationRefIssuedAt: overrides.reservationRefIssuedAt }),
        ...(overrides.reservationRefExpiresAt === undefined
          ? {}
          : { reservationRefExpiresAt: overrides.reservationRefExpiresAt }),
      },
    },
    readAdmissionIssuer: issued.issuer,
    readResultRef,
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
  const run = await enqueueAiRun(await readRunInput(context, `receipt-${suffix}`), db);
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
      matches: [
        {
          confirmationNumber: 'CONF-RED',
          externalReference: null,
          guestName: null,
          reservationStatus: 'Confirmed',
          arrivalDate: '2026-09-10',
          departureDate: '2026-09-12',
          roomType: 'STD',
          ratePlan: null,
        },
      ],
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
    quoteStay: async () => {
      throw new Error('not used');
    },
    readArtifact: async () => {
      throw new Error('not used');
    },
    lookupCandidates: new Map(lookupCandidates.map((candidate) => [candidate.id, candidate])),
    authorizedAttachmentIds: new Set(),
    propertyReadLock: {
      key: '1',
      withLock: async (callback) =>
        callback({
          query: async () => [],
          close: async () => undefined,
        }),
    },
  });
}

function installActiveFindReleaseForTests(): void {
  __setCachedActiveReadRuntimeForTests({
    releases: new Map([
      [
        'hms_find_reservation',
        {
          releaseId: 'release-red',
          toolId: 'hms_find_reservation',
          evidenceKind: 'hms',
          requestBranches: [{ id: 'guest_stay_search' }],
        },
      ],
    ]),
    predecessors: new Map(),
    toolIds: new Set(['hms_find_reservation']),
    registry: null,
    handlerPathActive: true,
    cutoverComplete: false,
  } as unknown as ActiveReadRuntimeState);
}

function createInjectedReadCaller(userId: string, transportId: string) {
  return appRouter.createCaller({
    auth: null as never,
    c: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: userId, email: '', name: null },
    activeTransportId: transportId,
    transportEmail: '',
    accessRole: 'owner',
  });
}

async function seedSucceededRouteFind(
  db: DB,
  context: Awaited<ReturnType<typeof seededMailContext>>,
) {
  installActiveFindReleaseForTests();
  const caller = createInjectedReadCaller(CENTURION_USER_ID, context.transportId);
  const find = await caller.ai.enqueueHmsRead({ threadId: context.threadId });
  await db
    .update(aiWorkflowRun)
    .set({
      state: 'succeeded',
      readResult: positiveFindResult,
      readResultExpiresAt: new Date('2099-09-07T12:05:00.000Z'),
    })
    .where(eq(aiWorkflowRun.id, find.runId));
  return { caller, find };
}

type ParentIssuerMutation = {
  label: string;
  apply: (issuer: Record<string, unknown>) => void;
};

const parentIssuerMutations: readonly ParentIssuerMutation[] = [
  { label: 'missing provenance', apply: () => undefined },
  {
    label: 'foreign user origin',
    apply: (issuer) => {
      issuer.userId = 'user-navaai';
    },
  },
  {
    label: 'foreign mailbox access origin',
    apply: (issuer) => {
      issuer.mailboxAccessId = `access-${MARTHA_USER_ID}-${TRANSPORT_ID}`;
    },
  },
  {
    label: 'spoofed transport origin',
    apply: (issuer) => {
      issuer.transportId = 'transport-nava';
    },
  },
  {
    label: 'spoofed thread origin',
    apply: (issuer) => {
      issuer.threadId = randomUUID();
    },
  },
  {
    label: 'spoofed trigger origin',
    apply: (issuer) => {
      issuer.triggerMessageId = randomUUID();
    },
  },
  {
    label: 'spoofed request digest',
    apply: (issuer) => {
      issuer.inputDigest = 'f'.repeat(64);
    },
  },
  {
    label: 'parent issuer on find',
    apply: (issuer) => {
      issuer.parentReadResultRef = 'spoof-parent';
    },
  },
  {
    label: 'evidence issuer on find',
    apply: (issuer) => {
      issuer.evidenceExpiresAt = '2099-09-07T12:05:00.000Z';
    },
  },
];

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('U8 independent review DB RED contracts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearCachedActiveReadRuntimeForTests();
  });

  it('claims a read_tool with drafting off and durably retains the typed receipt body', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(await readRunInput(context, 'body'), db);
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
        const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
        expect(stored?.readResultRef).toBe('receipt-red-body');
        expect(stored?.readResult).toEqual(typedReadResult);
        const receipt = await readAiRunReceipt(
          {
            readResultRef: 'receipt-red-body',
            transportId: context.transportId,
            threadId: context.threadId,
            triggerMessageId: context.triggerMessageId,
            requesterAuthorizationId: REQUESTER_AUTHORIZATION_ID,
            now: new Date('2026-09-07T12:00:00.000Z'),
          },
          db,
        );
        expect(receipt?.result).toEqual(typedReadResult);
      });
    });
  });

  it('rejects a read_tool enqueue without trusted admission', async () => {
    await withWorkerDb(async (db) => {
      const context = await seededMailContext(db);
      const input = await readRunInput(context, 'missing-admission');
      const closedRequest = { ...input.readRequest };
      delete closedRequest.admission;

      await expect(enqueueAiRun({ ...input, readRequest: closedRequest }, db)).rejects.toThrow(
        /admission/i,
      );
    });
  });

  it.each(['serialized', 'object-spread', 'raw-object'] as const)(
    'rejects a %s issuer ticket before inserting a queued run',
    async (variant) => {
      await withWorkerDb(async (db) => {
        const context = await seededMailContext(db);
        const input = await readRunInput(context, `issuer-ticket-${variant}`);
        const issuer =
          variant === 'serialized'
            ? JSON.parse(JSON.stringify(input.readAdmissionIssuer))
            : variant === 'object-spread'
              ? { ...input.readAdmissionIssuer }
              : Object.fromEntries(Object.entries(input.readAdmissionIssuer));

        await expect(enqueueAiRun({ ...input, readAdmissionIssuer: issuer }, db)).rejects.toThrow(
          /issuer|server-owned/i,
        );
        const rows = await db
          .select({ id: aiWorkflowRun.id })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.readResultRef, input.readResultRef));
        expect(rows).toHaveLength(0);
      });
    },
  );

  it('rejects a caller-fabricated 2099 context window before inserting a queued run', async () => {
    await withWorkerDb(async (db) => {
      const context = await seededMailContext(db);
      const input = await contextReadRunInput(context, 'fabricated-2099', {
        reservationRefExpiresAt: '2099-12-31T23:59:59.000Z',
      });

      await expect(enqueueAiRun(input, db)).rejects.toThrow(/issuer|server|admission/i);
      const rows = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.readResultRef, input.readResultRef));
      expect(rows).toHaveLength(0);
    });
  });

  it('runs the authenticated model-free caller through issuer, queue, worker, receipt, and context follow-up', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const mailbox = await resolveMailboxContext(CENTURION_USER_ID, TRANSPORT_ID, db);
        __setCachedActiveReadRuntimeForTests({
          releases: new Map([
            [
              'hms_find_reservation',
              {
                releaseId: 'release-red',
                toolId: 'hms_find_reservation',
                evidenceKind: 'hms',
                requestBranches: [{ id: 'guest_stay_search' }],
              },
            ],
          ]),
          predecessors: new Map(),
          toolIds: new Set(['hms_find_reservation']),
          registry: null,
          handlerPathActive: true,
          cutoverComplete: false,
        } as unknown as ActiveReadRuntimeState);
        const caller = appRouter.createCaller({
          auth: null as never,
          c: null as never,
          reqHeaders: new Headers(),
          sessionUser: { id: CENTURION_USER_ID, email: '', name: null },
          ...mailbox,
        });
        const modelRuntime = vi.spyOn(mastraModule, 'createMastraRuntime');
        const [routeCandidate] = filterExactReservationCandidates(
          extractLookupCandidates('U8 review fixture confirmation CONF-RED'),
        );

        const find = await caller.ai.enqueueHmsRead({ threadId: context.threadId });
        expect(find).toMatchObject({
          runState: 'queued',
          triggerMessageId: context.triggerMessageId,
          candidateId: routeCandidate?.id,
        });
        expect(
          await claimNextAiRun({
            ownerId: 'hms-review-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: find.runId });
        const findExecution = await executeAiRun(find.runId, {
          candidateSessionFactory: syntheticReadSessionFactory(async () =>
            syntheticMatchedRead('evidence-route-find', '2099-09-07T12:05:00.000Z'),
          ),
        });
        expect(findExecution.state).toBe('succeeded');
        expect(modelRuntime).not.toHaveBeenCalled();
        const findReceipt = await caller.ai.readHmsReceipt({
          threadId: context.threadId,
          readResultRef: find.readResultRef,
        });
        expect(findReceipt.result).toMatchObject({
          toolId: 'hms_find_reservation',
          status: 'ok',
          data: { matchCount: 1 },
        });

        const contextRun = await caller.ai.enqueueHmsContextRead({
          threadId: context.threadId,
          findResultRef: find.readResultRef,
          sections: ['core', 'stay'],
          detail: 'summary',
        });
        expect(contextRun).toMatchObject({
          runState: 'queued',
          triggerMessageId: context.triggerMessageId,
          candidateId: routeCandidate?.id,
        });
        expect(Date.parse(contextRun.reservationRefExpiresAt!)).toBeLessThanOrEqual(
          Date.now() + 5 * 60_000,
        );
        expect(
          await claimNextAiRun({
            ownerId: 'hms-review-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: contextRun.runId });
        const contextExecution = await executeAiRun(contextRun.runId, {
          candidateSessionFactory: syntheticReadSessionFactory(async () =>
            syntheticMatchedRead('evidence-route-context', '2099-09-07T12:05:00.000Z'),
          ),
        });
        expect(contextExecution.state).toBe('succeeded');
        const contextReceipt = await caller.ai.readHmsReceipt({
          threadId: context.threadId,
          readResultRef: contextRun.readResultRef,
        });
        expect(contextReceipt.result).toMatchObject({
          toolId: 'hms_read_reservation',
          status: expect.any(String),
        });
      });
    });
  });

  it.each(parentIssuerMutations)(
    'rejects context issuance with %s before enqueueing a context run',
    async ({ label, apply }) => {
      await withWorkerDb(async (db) => {
        await withReadOnlyWorkerEnv(async () => {
          const context = await seededMailContext(db);
          const { caller, find } = await seedSucceededRouteFind(db, context);
          const [parent] = await db
            .select()
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, find.runId))
            .limit(1);
          if (!parent) throw new Error('route parent fixture was not persisted');
          const metrics = {
            ...(parent.metrics as Record<string, unknown>),
          };
          if (label === 'missing provenance') {
            delete metrics.readAdmissionIssuer;
          } else {
            const issuer = {
              ...(metrics.readAdmissionIssuer as Record<string, unknown>),
            };
            apply(issuer);
            metrics.readAdmissionIssuer = issuer;
          }
          await db.update(aiWorkflowRun).set({ metrics }).where(eq(aiWorkflowRun.id, find.runId));

          await expect(
            caller.ai.enqueueHmsContextRead({
              threadId: context.threadId,
              findResultRef: find.readResultRef,
              sections: ['core', 'stay'],
              detail: 'summary',
            }),
          ).rejects.toThrow(/issuer|parent|provenance|scope/i);
          const rows = await db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun);
          expect(rows).toHaveLength(1);
        });
      });
    },
  );

  it.each(
    parentIssuerMutations.filter(({ label }) =>
      [
        'missing provenance',
        'foreign user origin',
        'foreign mailbox access origin',
        'spoofed request digest',
      ].includes(label),
    ),
  )('worker rejects context with %s parent issuer before session/PMS', async ({ label, apply }) => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const input = await contextReadRunInput(
          context,
          `parent-worker-${label.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
        );
        const parentRef = input.readAdmissionIssuer.parentReadResultRef;
        if (!parentRef) throw new Error('context fixture did not retain parent receipt ref');
        const [parent] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.readResultRef, parentRef))
          .limit(1);
        if (!parent) throw new Error('context parent fixture was not persisted');
        const metrics = { ...(parent.metrics as Record<string, unknown>) };
        if (label === 'missing provenance') {
          delete metrics.readAdmissionIssuer;
        } else {
          const issuer = { ...(metrics.readAdmissionIssuer as Record<string, unknown>) };
          apply(issuer);
          metrics.readAdmissionIssuer = issuer;
        }
        await db.update(aiWorkflowRun).set({ metrics }).where(eq(aiWorkflowRun.id, parent.id));
        const run = await enqueueAiRun(input, db);
        expect(
          await claimNextAiRun({
            ownerId: 'hms-review-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: run.id });
        const externalBoundary = vi.fn(async () =>
          syntheticMatchedRead('evidence-parent-origin', '2099-09-07T12:05:00.000Z'),
        );
        const sessionFactory = vi.fn(syntheticReadSessionFactory(externalBoundary));
        const result = await executeAiRun(run.id, { candidateSessionFactory: sessionFactory });

        expect(result.state).toBe('dead_letter');
        expect(sessionFactory).not.toHaveBeenCalled();
        expect(externalBoundary).not.toHaveBeenCalled();
      });
    });
  });

  it.each([
    { label: 'false authenticated user', userId: 'user-without-this-grant' },
    {
      label: 'missing mailbox access',
      userId: CENTURION_USER_ID,
      mutate: async (db: DB) => {
        await db.delete(mailboxAccess).where(eq(mailboxAccess.id, REQUESTER_AUTHORIZATION_ID));
      },
    },
    {
      label: 'revoked/deleted mailbox access',
      userId: CENTURION_USER_ID,
      mutate: async (db: DB) => {
        await db.delete(mailboxAccess).where(eq(mailboxAccess.id, REQUESTER_AUTHORIZATION_ID));
      },
    },
    {
      label: 'inactive transport grant',
      userId: CENTURION_USER_ID,
      mutate: async (db: DB) => {
        await db
          .update(mailboxTransport)
          .set({ isActive: false })
          .where(eq(mailboxTransport.id, TRANSPORT_ID));
      },
    },
  ])('authenticated route rejects a %s before queue insertion', async ({ userId, mutate }) => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        installActiveFindReleaseForTests();
        if (mutate) await mutate(db);
        const caller = createInjectedReadCaller(userId, context.transportId);

        await expect(caller.ai.enqueueHmsRead({ threadId: context.threadId })).rejects.toThrow(
          /grant|mailbox|active|forbidden/i,
        );
        const rows = await db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun);
        expect(rows).toHaveLength(0);
      });
    });
  });

  it.each([
    {
      label: 'false persisted user',
      kind: 'issuer' as const,
      mutate: (issuer: Record<string, unknown>) => {
        issuer.userId = 'user-navaai';
      },
    },
    {
      label: 'deleted mailbox access',
      kind: 'grant' as const,
      mutate: async (db: DB) => {
        await db.delete(mailboxAccess).where(eq(mailboxAccess.id, REQUESTER_AUTHORIZATION_ID));
      },
    },
    {
      label: 'inactive transport grant',
      kind: 'grant' as const,
      mutate: async (db: DB) => {
        await db
          .update(mailboxTransport)
          .set({ isActive: false })
          .where(eq(mailboxTransport.id, TRANSPORT_ID));
      },
    },
  ])('worker rejects a %s before session/PMS', async ({ label, kind, mutate }) => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const input = await readRunInput(
          context,
          `grant-${label.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
        );
        const run = await enqueueAiRun(input, db);
        if (kind === 'issuer') {
          const metrics = { ...(run.metrics as Record<string, unknown>) };
          const issuer = { ...(metrics.readAdmissionIssuer as Record<string, unknown>) };
          (mutate as (issuer: Record<string, unknown>) => void)(issuer);
          metrics.readAdmissionIssuer = issuer;
          await db.update(aiWorkflowRun).set({ metrics }).where(eq(aiWorkflowRun.id, run.id));
        } else {
          await (mutate as (db: DB) => Promise<void>)(db);
        }
        expect(
          await claimNextAiRun({
            ownerId: 'hms-review-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: run.id });
        const externalBoundary = vi.fn(async () =>
          syntheticMatchedRead('evidence-grant-origin', '2099-09-07T12:05:00.000Z'),
        );
        const sessionFactory = vi.fn(syntheticReadSessionFactory(externalBoundary));
        const result = await executeAiRun(run.id, { candidateSessionFactory: sessionFactory });

        expect(result.state).toBe('dead_letter');
        expect(sessionFactory).not.toHaveBeenCalled();
        expect(externalBoundary).not.toHaveBeenCalled();
      });
    });
  });

  it('rejects a resolved-context admission with a missing issuance window', async () => {
    await withWorkerDb(async (db) => {
      const context = await seededMailContext(db);
      const input = await contextReadRunInput(context, 'missing-ref-expiry');
      const admission = { ...input.readRequest.admission };
      delete admission.reservationRefIssuedAt;
      delete admission.reservationRefExpiresAt;

      await expect(
        enqueueAiRun(
          {
            ...input,
            readRequest: { ...input.readRequest, admission },
          },
          db,
        ),
      ).rejects.toThrow();
    });
  });

  it('requires a succeeded state before returning a durable receipt', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'nonterminal', {
        state: 'queued',
      });
      await expect(
        readAiRunReceipt(
          {
            readResultRef,
            transportId: context.transportId,
            threadId: context.threadId,
            triggerMessageId: context.triggerMessageId,
            requesterAuthorizationId: REQUESTER_AUTHORIZATION_ID,
          },
          db,
        ),
      ).resolves.toBeNull();
    });
  });

  it('rejects a receipt with the wrong mail scope', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'wrong-scope');
      await expect(
        readAiRunReceipt(
          {
            readResultRef,
            transportId: 'foreign-transport',
            threadId: context.threadId,
            triggerMessageId: context.triggerMessageId,
            requesterAuthorizationId: REQUESTER_AUTHORIZATION_ID,
          },
          db,
        ),
      ).resolves.toBeNull();
    });
  });

  it('rejects a receipt for the wrong trusted requester', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'wrong-requester');
      await expect(
        readAiRunReceipt(
          {
            readResultRef,
            transportId: context.transportId,
            threadId: context.threadId,
            triggerMessageId: context.triggerMessageId,
            requesterAuthorizationId: 'auth-foreign',
          },
          db,
        ),
      ).resolves.toBeNull();
    });
  });

  it('rejects an expired receipt', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'expired', {
        readResultExpiresAt: new Date('2026-09-07T12:00:00.000Z'),
      });
      await expect(
        readAiRunReceipt(
          {
            readResultRef,
            transportId: context.transportId,
            threadId: context.threadId,
            triggerMessageId: context.triggerMessageId,
            requesterAuthorizationId: REQUESTER_AUTHORIZATION_ID,
            now: new Date('2026-09-07T12:00:00.000Z'),
          },
          db,
        ),
      ).resolves.toBeNull();
    });
  });

  it('rejects a replayed or foreign receipt reference', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'replay');
      await expect(
        readAiRunReceipt(
          {
            readResultRef: `${readResultRef}-foreign`,
            transportId: context.transportId,
            threadId: context.threadId,
            triggerMessageId: context.triggerMessageId,
            requesterAuthorizationId: REQUESTER_AUTHORIZATION_ID,
          },
          db,
        ),
      ).resolves.toBeNull();
      await expect(
        readAiRunReceipt(
          {
            readResultRef,
            transportId: context.transportId,
            threadId: 'foreign-thread',
            triggerMessageId: context.triggerMessageId,
            requesterAuthorizationId: REQUESTER_AUTHORIZATION_ID,
          },
          db,
        ),
      ).resolves.toBeNull();
    });
  });

  it('rejects a malformed durable receipt body', async () => {
    await withWorkerDb(async (db) => {
      const { context, readResultRef } = await seedReceiptRow(db, 'malformed', { readResult: {} });
      await expect(
        readAiRunReceipt(
          {
            readResultRef,
            transportId: context.transportId,
            threadId: context.threadId,
            triggerMessageId: context.triggerMessageId,
            requesterAuthorizationId: REQUESTER_AUTHORIZATION_ID,
          },
          db,
        ),
      ).rejects.toThrow();
    });
  });

  it('does not overwrite a receipt when the durable success fence is stale', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(await readRunInput(context, 'stale-fence'), db);
        const claimed = await claimNextAiRun({
          ownerId: 'hms-review-worker',
          lane: 'hms',
          runKind: 'read_tool',
          db,
        });
        expect(claimed?.id).toBe(run.id);
        const originalRef = 'receipt-red-stale-original';
        await db
          .update(aiWorkflowRun)
          .set({
            readResultRef: originalRef,
            readResult: typedReadResult,
            readResultExpiresAt: new Date('2099-09-07T12:05:00.000Z'),
          })
          .where(eq(aiWorkflowRun.id, run.id));

        const staleWrite = await markAiRunSucceeded(
          {
            runId: run.id,
            claimOwner: 'stale-owner',
            claimToken: 'stale-token',
            expectedStates: ['running'],
            readResultRef: 'receipt-red-stale-overwrite',
            readResult: { ...typedReadResult, status: 'not_found' },
            readResultExpiresAt: new Date('2099-09-07T12:06:00.000Z'),
          },
          db,
        );
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
        const run = await enqueueAiRun(await readRunInput(context, 'adapter'), db);
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
            matches: [
              {
                confirmationNumber: 'CONF-RED',
                externalReference: null,
                guestName: null,
                reservationStatus: 'Confirmed',
                arrivalDate: '2026-09-10',
                departureDate: '2026-09-12',
                roomType: 'STD',
                ratePlan: null,
              },
            ],
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
            quoteStay: async () => {
              throw new Error('not used');
            },
            readArtifact: async () => {
              throw new Error('not used');
            },
            lookupCandidates: new Map(
              lookupCandidates.map((candidate) => [candidate.id, candidate]),
            ),
            authorizedAttachmentIds: new Set(),
            propertyReadLock: {
              key: '1',
              withLock: async (callback) =>
                callback({
                  query: async () => [],
                  close: async () => undefined,
                }),
            },
          }),
        });

        expect(result.state).toBe('succeeded');
        expect(externalBoundary).toHaveBeenCalledOnce();
        const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
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
        const run = await enqueueAiRun(await contextReadRunInput(context, 'context'), db);
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
            matches: [
              {
                confirmationNumber: 'CONF-RED',
                externalReference: null,
                guestName: null,
                reservationStatus: 'Confirmed',
                arrivalDate: '2026-09-10',
                departureDate: '2026-09-12',
                roomType: 'STD',
                ratePlan: null,
              },
            ],
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
            quoteStay: async () => {
              throw new Error('not used');
            },
            readArtifact: async () => {
              throw new Error('not used');
            },
            lookupCandidates: new Map(
              lookupCandidates.map((candidate) => [candidate.id, candidate]),
            ),
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
        const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
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
        await expect(
          enqueueAiRun(
            await contextReadRunInput(context, 'unminted', {
              reservationRef: 'model-invented-ref',
            }),
            db,
          ),
        ).rejects.toThrow(/issuer|admission/i);
      });
    });
  });

  it('rejects a replayed reference from a foreign candidate scope', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        await expect(
          enqueueAiRun(
            await contextReadRunInput(context, 'foreign-candidate', {
              candidateId: 'foreign-candidate',
              reservationRef: 'foreign-candidate',
            }),
            db,
          ),
        ).rejects.toThrow(/issuer|admission/i);
      });
    });
  });

  it('rejects a reservation reference replayed into another thread scope', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const originalContext = await seededMailContext(db);
        const replayContext = await seededMailContext(db);
        expect(originalContext.threadId).not.toBe(replayContext.threadId);
        await expect(
          enqueueAiRun(
            await contextReadRunInput(replayContext, 'replayed-thread-ref', {
              reservationRef: '61029cf2ae474e6a',
            }),
            db,
          ),
        ).rejects.toThrow(/issuer|admission/i);
      });
    });
  });

  it('rejects a resolved context whose matched evidence is expired', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(await contextReadRunInput(context, 'expired-context'), db);
        expect(
          await claimNextAiRun({
            ownerId: 'hms-review-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: run.id });
        const externalBoundary = vi.fn(async () =>
          syntheticMatchedRead('evidence-red-expired-context', '2026-09-07T12:00:00.000Z'),
        );

        const result = await executeAiRun(run.id, {
          candidateSessionFactory: syntheticReadSessionFactory(externalBoundary),
        });

        expect(result.state).toBe('dead_letter');
        expect(externalBoundary).toHaveBeenCalledOnce();
      });
    });
  });

  it('rejects an expired previously-issued context reference before opening a session', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        await expect(
          enqueueAiRun(
            await contextReadRunInput(context, 'expired-issued-ref', {
              reservationRefIssuedAt: '2026-09-07T11:00:00.000Z',
              reservationRefExpiresAt: '2026-09-07T12:00:00.000Z',
            }),
            db,
          ),
        ).rejects.toThrow(/issuer|admission/i);
      });
    });
  });

  it('rejects a persisted admission whose expiry was tampered after issuance', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(
          await contextReadRunInput(context, 'tampered-ref-expiry'),
          db,
        );
        const request = run.readRequest as Record<string, unknown>;
        const admission = request.admission as Record<string, unknown>;
        await db
          .update(aiWorkflowRun)
          .set({
            readRequest: {
              ...request,
              admission: {
                ...admission,
                reservationRefExpiresAt: '2099-09-07T12:06:00.000Z',
              },
            },
          })
          .where(eq(aiWorkflowRun.id, run.id));
        expect(
          await claimNextAiRun({
            ownerId: 'hms-review-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: run.id });
        const externalBoundary = vi.fn(async () =>
          syntheticMatchedRead('evidence-red-tampered-expiry', '2099-09-07T12:05:00.000Z'),
        );
        const sessionFactory = vi.fn(syntheticReadSessionFactory(externalBoundary));

        const result = await executeAiRun(run.id, { candidateSessionFactory: sessionFactory });

        expect(result.state).toBe('dead_letter');
        expect(sessionFactory).not.toHaveBeenCalled();
        expect(externalBoundary).not.toHaveBeenCalled();
      });
    });
  });

  it('rejects refreshing an already-issued reservation reference with a new expiry', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        const run = await enqueueAiRun(await contextReadRunInput(context, 'ref-refresh'), db);
        const request = run.readRequest as Record<string, unknown>;
        const admission = request.admission as Record<string, unknown>;
        const metrics = run.metrics as Record<string, unknown>;
        const binding = metrics.readAdmissionBinding as Record<string, unknown>;
        const refreshedExpiry = '2099-09-07T12:06:00.000Z';
        await db
          .update(aiWorkflowRun)
          .set({
            readRequest: {
              ...request,
              admission: { ...admission, reservationRefExpiresAt: refreshedExpiry },
            },
            metrics: {
              ...metrics,
              readAdmissionBinding: { ...binding, reservationRefExpiresAt: refreshedExpiry },
            },
          })
          .where(eq(aiWorkflowRun.id, run.id));
        expect(
          await claimNextAiRun({
            ownerId: 'hms-review-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: run.id });
        const externalBoundary = vi.fn(async () =>
          syntheticMatchedRead('evidence-red-ref-refresh', refreshedExpiry),
        );
        const sessionFactory = vi.fn(syntheticReadSessionFactory(externalBoundary));

        const result = await executeAiRun(run.id, { candidateSessionFactory: sessionFactory });

        expect(result.state).toBe('dead_letter');
        expect(sessionFactory).not.toHaveBeenCalled();
        expect(externalBoundary).not.toHaveBeenCalled();
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
        const read = await enqueueAiRun(await readRunInput(context, 'isolation'), db);
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
