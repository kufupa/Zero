import {
  claimNextAiRun,
  enqueueAiRun,
  NOT_APPLICABLE_MODEL_ID,
  READ_TOOL_PROMPT_VERSION,
  readAiRunReceipt,
} from '../src/ai/run-ledger.js';
import {
  __setCachedActiveReadRuntimeForTests,
  clearCachedActiveReadRuntimeForTests,
} from '../src/hms/active-read-runtime.js';
import {
  HMS_RUNTIME_ABI_VERSION,
  hmsPortfolioToolReleaseV2Schema,
  sha256Hex,
} from '../src/hms/release-kernel.js';
import { aiWorkflowRun, mailboxAccess, mailThread, message } from '../src/db/schema/mail.js';
import { createLiveHmsCandidateSessionFactory, executeAiRun } from '../src/ai/worker.js';
import { issueReadAdmissionFromMailbox } from '../src/hms/read-admission-issuer.js';
import { quoteStayCandidateFromRequest } from '../src/hms/quote-stay-candidate.js';
import { normalizeQuoteRequest } from '../src/hms/quote-request-normalization.js';
import { buildExactOsrravSearchManifest } from '../src/hms/live-read-manifest.js';
import type { ActiveReadRuntimeState } from '../src/hms/active-read-runtime.js';
import { readInputDigest } from '../src/hms/read-service-contracts.js';
import { QUOTE_STAY_IMPL_V1 } from '../src/hms/read-handler-index.js';
import { type HmsPage, type HmsRuntime } from '../src/hms/runtime.js';
import { probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { CENTURION_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { appRouter } from '../src/trpc/router.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const reachable = await probeTestDb();
const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';
const DEFAULT_QUOTE_TEXT =
  'Please quote arrival 2026-09-10, departure 2026-09-12, 2 adults, 0 children, 1 room, room type STD, rate plan BAR, currency ZAR.';

function liveEnvelope(): string {
  return JSON.stringify({
    pageData: {
      success: true,
      values: {
        availabilitydata: {
          uoc: 'ZAR',
          roomTypeInvArray: [
            {
              roomTypeCode: 'STD',
              roomTypeDailyInvArray: [
                { date: '2026-09-10T00:00:00', numOfAvailable: -2 },
                { date: '2026-09-11T00:00:00', numOfAvailable: 2 },
              ],
              ratePlanInvArray: [
                {
                  ratePlanCode: 'BAR',
                  uoc: 'ZAR',
                  ratePlanDailyInvArray: [
                    { date: '2026-09-10T00:00:00', roomRate: 1200, combNumOfAvailable: -2 },
                    { date: '2026-09-11T00:00:00', roomRate: 1250, combNumOfAvailable: 2 },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  });
}

function runtimeFixture() {
  const posts: Array<{ path: string; fields: Record<string, string> }> = [];
  let latestAuditSpec:
    | { operationId?: string; toolId?: string; toolVersion?: string; requestBranchId?: string }
    | undefined;
  const page: Partial<HmsPage> = {
    async goto() {},
    async content() {
      return '<input name="roomtypes" /><input name="startdate" />';
    },
    async click() {},
    async evaluate(fn: (arg?: unknown) => unknown, arg?: unknown) {
      if (fn.length === 0) {
        return {
          property: 'HRCEN',
          currency: 'ZAR',
          salesstrategy: 'TRANSI',
          showunavailable: '0',
          ratetype: 'DR',
          showexclusiverates: '0',
          showavailableforsale: 'on',
          rowpagesize: '14',
          hoteldate: '06-AUG-2026',
          firstcolumndate: '06-AUG-2026',
          pagemode: 'display',
          ONLY_DATA_REQUIRED: 'true',
        };
      }
      return fn(arg);
    },
    async postForm(url: string, fields: Record<string, string>) {
      posts.push({ path: new URL(url).pathname, fields });
      return liveEnvelope();
    },
    waitForCorrelatedResponse: async () => undefined,
    async close() {},
  };
  const session = {
    id: 'u7-quote-db-session',
    origin: ORIGIN,
    page: page as HmsPage,
    violation: () => null,
    terminal: () => false,
    lastReceipt: vi.fn(() => {
      const auditSpec = latestAuditSpec;
      if (!auditSpec) return null;
      return {
        artifactId: `u7-quote-artifact-${auditSpec.operationId ?? 'unknown'}`,
        operationId: auditSpec.operationId ?? 'unknown',
        toolId: auditSpec.toolId ?? 'hms_quote_stay',
        toolVersion: auditSpec.toolVersion ?? '2.0.0',
        requestBranchId: auditSpec.requestBranchId ?? null,
        executionClass: 'normal',
        inputClass: 'authorized_exact',
        artifactState: 'complete',
        operationOutcome: 'succeeded',
      } as Record<string, unknown>;
    }),
    close: vi.fn(async () => undefined),
  };
  const openReadSession = vi.fn(async (input?: unknown) => {
    latestAuditSpec = (input as { auditSpec?: typeof latestAuditSpec } | undefined)?.auditSpec;
    return session;
  });
  const runtime = {
    openReadSession,
  } as unknown as HmsRuntime;
  return { runtime, posts, session };
}

function installQuoteRelease(candidate: ReturnType<typeof quoteStayCandidateFromRequest>) {
  if (!candidate) throw new Error('quote candidate fixture failed to normalize');
  const manifest = buildExactOsrravSearchManifest(ORIGIN, candidate);
  const digest = (label: string) => sha256Hex(`u7-quote-db:${label}`);
  const release = hmsPortfolioToolReleaseV2Schema.parse({
    schemaVersion: 2,
    releaseId: randomUUID(),
    toolsetVersion: 'u7-quote-db-tools',
    toolsetFingerprint: digest('toolset'),
    sourceRevision: 'u7-quote-db-source',
    phaseAPlanSha256: digest('phase-a'),
    phaseBPlanSha256: digest('phase-b'),
    gateSha256: digest('gate'),
    runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
    runtimeFingerprintSha256: digest('runtime'),
    implementationSha256: QUOTE_STAY_IMPL_V1,
    requesterPolicySha256: digest('requester-policy'),
    privateDigestKeyVersion: 'u7-quote-db-v1',
    liveProofSha256: digest('live-proof'),
    receiptSha256: digest('receipt'),
    qualification: 'live_verified',
    shadowSha256: null,
    evidenceKind: 'hms',
    toolId: 'hms_quote_stay',
    toolVersion: '2.0.0',
    predecessorReleaseId: null,
    rollbackAction: 'disable',
    requestBranches: [
      {
        id: 'quote_availability_search',
        discoveryOperationId: 'quote_availability_search',
        manifestSha256: sha256Hex(JSON.stringify(manifest)),
        discoverySha256: digest('discovery'),
        parserSchemaSha256: digest('parser'),
      },
    ],
    credentialVersionHmacSha256: digest('credential'),
    roleProofSha256: digest('role-proof'),
  });
  return {
    releases: new Map([['hms_quote_stay', release]]),
    predecessors: new Map(),
    toolIds: new Set(['hms_quote_stay']),
    registry: null,
    handlerPathActive: true,
    cutoverComplete: false,
  } as unknown as ActiveReadRuntimeState;
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
    'HMS_HEALTH_STATUS_PATH',
    'HMS_EXPECTED_PROPERTY_CODE',
    'HMS_READ_SECRET_ARN',
    'HMS_CHROMIUM_EXECUTABLE_PATH',
    'HMS_READ_ROLE_PROOF_PATH',
    'HMS_EXPECTED_TENANT',
    'HMS_EXPECTED_TRANSPORT_ID',
    'HMS_EVIDENCE_HMAC_SECRET_ARN',
    'HMS_EVIDENCE_HMAC_KEY_VERSION',
    'HMS_ACTIVE_REGISTRY_PATH',
    'HMS_RELEASE_ROOT',
    'NAVA_BUILD_COMMIT',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.PORT = '3000';
  process.env.BETTER_AUTH_URL = 'https://nava.legacy.local';
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(32);
  process.env.AWS_REGION = 'synthetic-region-1';
  process.env.S3_BUCKET = 'u7-quote-synthetic-bucket';
  process.env.AI_WORKER_LANE = 'hms';
  process.env.HMS_READ_SERVICE_ENABLED = 'true';
  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
  process.env.HMS_RUN_DEADLINE_MS = '150000';
  process.env.HMS_HEALTH_STATUS_PATH = '/tmp/u7-quote-hms-health.json';
  process.env.HMS_EXPECTED_PROPERTY_CODE = 'HRCEN';
  process.env.HMS_READ_SECRET_ARN = 'u7-quote-test-secret';
  process.env.HMS_CHROMIUM_EXECUTABLE_PATH = '/bin/false';
  process.env.HMS_READ_ROLE_PROOF_PATH = '/tmp/u7-quote-role-proof.json';
  process.env.HMS_EXPECTED_TENANT = 'u7-quote-tenant';
  process.env.HMS_EXPECTED_TRANSPORT_ID = 'transport-centurion';
  process.env.HMS_EVIDENCE_HMAC_SECRET_ARN = 'u7-quote-evidence-secret';
  process.env.HMS_EVIDENCE_HMAC_KEY_VERSION = 'u7-v1';
  process.env.HMS_ACTIVE_REGISTRY_PATH = '/tmp/u7-quote-unused-active.json';
  process.env.HMS_RELEASE_ROOT = '/tmp/u7-quote-unused-releases';
  process.env.NAVA_BUILD_COMMIT = 'u7-quote-test-source';
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

async function seedQuoteMailContext(db: DB, suffix: string, textBody = DEFAULT_QUOTE_TEXT) {
  const threadId = randomUUID();
  const triggerMessageId = randomUUID();
  const subject = `Quote request ${suffix}`;
  await db.insert(mailThread).values({
    id: threadId,
    transportId: TRANSPORT_ID,
    threadRootId: `<u7-quote-${suffix}-${threadId}@example.com>`,
    subject,
    snippet: textBody,
    latestMessageAt: new Date('2026-09-08T12:00:00.000Z'),
  });
  await db.insert(message).values({
    id: triggerMessageId,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: `quote-${suffix}@example.com`,
    toAddresses: ['nava@example.com'],
    subject,
    textBody,
    receivedAt: new Date('2026-09-08T12:00:00.000Z'),
  });
  return { transportId: TRANSPORT_ID, threadId, triggerMessageId };
}

async function issueAndEnqueueQuote(
  db: DB,
  context: { transportId: string; threadId: string; triggerMessageId: string },
  releaseId: string,
  suffix: string,
) {
  const issued = await issueReadAdmissionFromMailbox({
    db,
    userId: CENTURION_USER_ID,
    transportId: context.transportId,
    threadId: context.threadId,
    toolId: 'hms_quote_stay',
    releaseId,
    requestBranchId: 'quote_availability_search',
    detail: 'detail',
  });
  const readResultRef = `u7-quote-db-${suffix}-${randomUUID()}`;
  const run = await enqueueAiRun(
    {
      ...context,
      runKind: 'read_tool',
      idempotencyKey: `u7-quote-db-${suffix}-${randomUUID()}`,
      modelId: NOT_APPLICABLE_MODEL_ID,
      promptVersion: READ_TOOL_PROMPT_VERSION,
      executorLane: 'hms',
      readRequest: issued.readRequest,
      readAdmissionIssuer: issued.issuer,
      readResultRef,
    },
    db,
  );
  return { issued, run, readResultRef };
}

function createInjectedQuoteCaller(transportId: string) {
  return appRouter.createCaller({
    auth: null as never,
    c: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: CENTURION_USER_ID, email: '', name: null },
    activeTransportId: transportId,
    transportEmail: '',
    accessRole: 'owner',
  });
}

describe('U7 normal audited quote runtime with guarded PG16 lock', () => {
  it('uses the default session factory, release handler binding, property lock and live driver', async () => {
    if (!reachable) throw new Error('owned disposable PG16 DB probe unexpectedly unavailable');
    await withReadOnlyWorkerEnv(async () => {
      const normalized = normalizeQuoteRequest({
        arrival: '2026-09-10',
        departure: '2026-09-12',
        rooms: [
          { quantity: 1, adultsPerRoom: 2, childAges: [], roomTypeRef: 'STD', ratePlanRef: 'BAR' },
        ],
        currency: 'ZAR',
      });
      expect(normalized.status).toBe('ready');
      if (normalized.status !== 'ready') return;
      const candidate = quoteStayCandidateFromRequest(normalized.request);
      expect(candidate).not.toBeNull();
      if (!candidate) return;
      const activeReadState = installQuoteRelease(candidate);
      const fixture = runtimeFixture();
      const factory = createLiveHmsCandidateSessionFactory({
        runtime: fixture.runtime,
        activeReadState,
      });
      const session = await factory({
        transportId: 'transport-centurion',
        threadId: 'u7-quote-db-thread',
        lookupCandidates: [],
        signal: new AbortController().signal,
        runId: randomUUID(),
        readOnly: true,
        readToolId: 'hms_quote_stay',
        readAdmission: {
          releaseId: activeReadState.releases.get('hms_quote_stay')!.releaseId,
          requestBranchId: 'quote_availability_search',
          requesterAuthorizationId: 'access-u7-quote',
          inputDigest: '0'.repeat(64),
          captureRequired: false,
          captureBindingRef: null,
          reservationRef: null,
          reservationRefIssuedAt: null,
          reservationRefExpiresAt: null,
        },
        quoteCandidates: new Map([[normalized.request.quoteRequestRef, candidate]]),
      });
      expect(session.propertyReadLock).toBeTruthy();
      try {
        const result = await session.propertyReadLock!.withLock(() =>
          session.quoteStay(normalized.request.quoteRequestRef, new AbortController().signal),
        );
        expect(result.status).toBe('ok');
        expect(result.data).toMatchObject({
          requestRef: normalized.request.quoteRequestRef,
          bookable: false,
          stayTotal: null,
          occupancyPriced: false,
        });
        expect(result.data.nightlyObservations[0]?.availableCount).toBe(-2);
        expect(result.data.unresolvedInputs).toContain('negative_observed_overbooking');
        expect(fixture.posts).toHaveLength(1);
        expect(fixture.posts[0]?.path).toBe('/web/base/OSRRAV.HDR.search');
      } finally {
        await session.close?.();
      }
    });
  });

  it('executes the issued quote through DB queue/claim/worker and stores its typed receipt', async () => {
    if (!reachable) throw new Error('owned disposable PG16 DB probe unexpectedly unavailable');
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seedQuoteMailContext(db, 'queue');
        const normalized = normalizeQuoteRequest({
          arrival: '2026-09-10',
          departure: '2026-09-12',
          rooms: [
            {
              quantity: 1,
              adultsPerRoom: 2,
              childAges: [],
              roomTypeRef: 'STD',
              ratePlanRef: 'BAR',
            },
          ],
          currency: 'ZAR',
        });
        expect(normalized.status).toBe('ready');
        if (normalized.status !== 'ready') return;
        const candidate = quoteStayCandidateFromRequest(normalized.request);
        expect(candidate).not.toBeNull();
        if (!candidate) return;
        const activeReadState = installQuoteRelease(candidate);
        __setCachedActiveReadRuntimeForTests(activeReadState);
        try {
          const caller = createInjectedQuoteCaller(context.transportId);
          const enqueued = await caller.ai.enqueueHmsRead({
            threadId: context.threadId,
            toolId: 'hms_quote_stay',
            detail: 'detail',
          });
          expect(enqueued.quoteRequestRef).toBe(normalized.request.quoteRequestRef);
          const [run] = await db
            .select()
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, enqueued.runId));
          if (!run?.readRequest || !run.metrics || typeof run.metrics !== 'object') {
            throw new Error('quote route did not persist its closed request and issuer');
          }
          const persistedRequest = run.readRequest as Record<string, unknown>;
          const { admission: persistedAdmission, ...closedRequest } = persistedRequest;
          expect(persistedAdmission).toMatchObject({
            reservationRef: null,
            requesterAuthorizationId: `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`,
          });
          expect((persistedAdmission as { inputDigest: string }).inputDigest).toBe(
            readInputDigest(closedRequest),
          );
          expect((run.metrics as Record<string, unknown>).readAdmissionIssuer).toBeTruthy();

          const readResultRef = enqueued.readResultRef;
          expect(run.state).toBe('queued');
          const claimed = await claimNextAiRun({
            ownerId: 'u7-quote-db-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          });
          expect(claimed?.id).toBe(run.id);

          const fixture = runtimeFixture();
          const execution = await executeAiRun(run.id, { hmsRuntime: fixture.runtime });
          expect(execution.state).toBe('succeeded');
          expect(fixture.runtime.openReadSession).toHaveBeenCalledTimes(1);
          expect(fixture.runtime.openReadSession.mock.calls[0]?.[0].auditSpec).toMatchObject({
            toolId: 'hms_quote_stay',
            executionClass: 'normal',
            inputClass: 'authorized_exact',
          });

          const [stored] = await db
            .select()
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, run.id));
          expect(stored?.state).toBe('succeeded');
          expect(stored?.readResult).toMatchObject({
            toolId: 'hms_quote_stay',
            scopeRef: normalized.request.quoteRequestRef,
            data: {
              requestRef: normalized.request.quoteRequestRef,
              bookable: false,
              stayTotal: null,
              occupancyPriced: false,
            },
          });
          expect(
            (stored?.readResult as { evidence?: Array<{ artifactRef?: string | null }> } | null)
              ?.evidence?.[0]?.artifactRef,
          ).toMatch(/^u7-quote-artifact-/);
          const receipt = await readAiRunReceipt(
            {
              readResultRef,
              transportId: context.transportId,
              threadId: context.threadId,
              triggerMessageId: context.triggerMessageId,
              requesterAuthorizationId: `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`,
              now: new Date('2026-09-08T12:01:00.000Z'),
            },
            db,
          );
          expect(receipt?.result).toMatchObject({
            toolId: 'hms_quote_stay',
            scopeRef: normalized.request.quoteRequestRef,
          });
          expect(
            (receipt?.result as { evidence?: Array<{ artifactRef?: string | null }> } | null)
              ?.evidence?.[0]?.artifactRef,
          ).toMatch(/^u7-quote-artifact-/);
        } finally {
          clearCachedActiveReadRuntimeForTests();
        }
      });
    });
  });

  it('rejects revoked current mailbox access after enqueue before opening the lower runtime', async () => {
    if (!reachable) throw new Error('owned disposable PG16 DB probe unexpectedly unavailable');
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seedQuoteMailContext(db, 'revoked');
        const normalized = normalizeQuoteRequest({
          arrival: '2026-09-10',
          departure: '2026-09-12',
          rooms: [
            {
              quantity: 1,
              adultsPerRoom: 2,
              childAges: [],
              roomTypeRef: 'STD',
              ratePlanRef: 'BAR',
            },
          ],
          currency: 'ZAR',
        });
        expect(normalized.status).toBe('ready');
        if (normalized.status !== 'ready') return;
        const candidate = quoteStayCandidateFromRequest(normalized.request);
        if (!candidate) throw new Error('quote candidate fixture failed to normalize');
        const activeReadState = installQuoteRelease(candidate);
        __setCachedActiveReadRuntimeForTests(activeReadState);
        try {
          const releaseId = activeReadState.releases.get('hms_quote_stay')!.releaseId;
          const { issued, run } = await issueAndEnqueueQuote(db, context, releaseId, 'revoked');
          await db
            .delete(mailboxAccess)
            .where(eq(mailboxAccess.id, issued.admission.requesterAuthorizationId));
          expect(
            await claimNextAiRun({
              ownerId: 'u7-quote-db-revoked-worker',
              lane: 'hms',
              runKind: 'read_tool',
              db,
            }),
          ).toMatchObject({ id: run.id });
          const fixture = runtimeFixture();
          const execution = await executeAiRun(run.id, { hmsRuntime: fixture.runtime });
          expect(execution.state).toBe('dead_letter');
          expect(fixture.runtime.openReadSession).not.toHaveBeenCalled();
        } finally {
          clearCachedActiveReadRuntimeForTests();
        }
      });
    });
  });

  it('rejects a second real issued quote reference after enqueue before lower I/O', async () => {
    if (!reachable) throw new Error('owned disposable PG16 DB probe unexpectedly unavailable');
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const firstContext = await seedQuoteMailContext(db, 'ref-first');
        const secondContext = await seedQuoteMailContext(
          db,
          'ref-second',
          'Please quote arrival 2026-09-13, departure 2026-09-15, 2 adults, 0 children, 1 room, room type STD, rate plan BAR, currency ZAR.',
        );
        const normalized = normalizeQuoteRequest({
          arrival: '2026-09-10',
          departure: '2026-09-12',
          rooms: [
            {
              quantity: 1,
              adultsPerRoom: 2,
              childAges: [],
              roomTypeRef: 'STD',
              ratePlanRef: 'BAR',
            },
          ],
          currency: 'ZAR',
        });
        expect(normalized.status).toBe('ready');
        if (normalized.status !== 'ready') return;
        const candidate = quoteStayCandidateFromRequest(normalized.request);
        if (!candidate) throw new Error('quote candidate fixture failed to normalize');
        const activeReadState = installQuoteRelease(candidate);
        __setCachedActiveReadRuntimeForTests(activeReadState);
        try {
          const releaseId = activeReadState.releases.get('hms_quote_stay')!.releaseId;
          const first = await issueAndEnqueueQuote(db, firstContext, releaseId, 'ref-first');
          const second = await issueReadAdmissionFromMailbox({
            db,
            userId: CENTURION_USER_ID,
            transportId: secondContext.transportId,
            threadId: secondContext.threadId,
            toolId: 'hms_quote_stay',
            releaseId,
            requestBranchId: 'quote_availability_search',
            detail: 'detail',
          });
          expect(second.quoteRequestRef).not.toBe(first.issued.quoteRequestRef);
          const { admission: _secondAdmission, ...secondClosedRequest } = second.readRequest;
          const tamperedRequest = {
            ...secondClosedRequest,
            admission: first.issued.admission,
          } as Record<string, unknown>;
          await db
            .update(aiWorkflowRun)
            .set({ readRequest: tamperedRequest })
            .where(eq(aiWorkflowRun.id, first.run.id));
          expect(
            await claimNextAiRun({
              ownerId: 'u7-quote-db-ref-worker',
              lane: 'hms',
              runKind: 'read_tool',
              db,
            }),
          ).toMatchObject({ id: first.run.id });
          const fixture = runtimeFixture();
          const execution = await executeAiRun(first.run.id, { hmsRuntime: fixture.runtime });
          expect(execution.state).toBe('dead_letter');
          expect(fixture.runtime.openReadSession).not.toHaveBeenCalled();
        } finally {
          clearCachedActiveReadRuntimeForTests();
        }
      });
    });
  });

  it('rejects an expired claimed run before lower I/O', async () => {
    if (!reachable) throw new Error('owned disposable PG16 DB probe unexpectedly unavailable');
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seedQuoteMailContext(db, 'expired');
        const normalized = normalizeQuoteRequest({
          arrival: '2026-09-10',
          departure: '2026-09-12',
          rooms: [
            {
              quantity: 1,
              adultsPerRoom: 2,
              childAges: [],
              roomTypeRef: 'STD',
              ratePlanRef: 'BAR',
            },
          ],
          currency: 'ZAR',
        });
        expect(normalized.status).toBe('ready');
        if (normalized.status !== 'ready') return;
        const candidate = quoteStayCandidateFromRequest(normalized.request);
        if (!candidate) throw new Error('quote candidate fixture failed to normalize');
        const activeReadState = installQuoteRelease(candidate);
        __setCachedActiveReadRuntimeForTests(activeReadState);
        try {
          const releaseId = activeReadState.releases.get('hms_quote_stay')!.releaseId;
          const { run } = await issueAndEnqueueQuote(db, context, releaseId, 'expired');
          expect(
            await claimNextAiRun({
              ownerId: 'u7-quote-db-expired-worker',
              lane: 'hms',
              runKind: 'read_tool',
              db,
            }),
          ).toMatchObject({ id: run.id });
          await db
            .update(aiWorkflowRun)
            .set({ deadlineAt: new Date(Date.now() - 1_000) })
            .where(eq(aiWorkflowRun.id, run.id));
          const fixture = runtimeFixture();
          await expect(executeAiRun(run.id, { hmsRuntime: fixture.runtime })).rejects.toThrow();
          expect(fixture.runtime.openReadSession).not.toHaveBeenCalled();
        } finally {
          clearCachedActiveReadRuntimeForTests();
        }
      });
    });
  });
});
