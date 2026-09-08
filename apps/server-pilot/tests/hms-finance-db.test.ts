import {
  __setCachedActiveReadRuntimeForTests,
  clearCachedActiveReadRuntimeForTests,
  loadWorkerActiveReadSet,
  type ActiveReadRuntimeState,
} from '../src/hms/active-read-runtime.js';
import {
  fingerprintActiveSet,
  hmsActiveRegistryV2Schema,
  HMS_RUNTIME_ABI_VERSION,
  hmsPortfolioToolReleaseV2Schema,
  sha256Hex,
} from '../src/hms/release-kernel.js';
import {
  createLiveHmsCandidateSessionFactory,
  executeAiRun,
  type CandidateSessionFactory,
} from '../src/ai/worker.js';
import { FOLIO_READ_IMPL_V1, createReadToolHandler } from '../src/hms/read-handler-index.js';
import { aiWorkflowRun, mailboxAccess, mailThread, message } from '../src/db/schema/mail.js';
import { CENTURION_USER_ID, MARTHA_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { reviewedManifestSha256 } from '../src/hms/release-manifest-binding.js';
import { resolveHmsSourceRevision } from '../src/hms/production-runtime.js';
import { mergeFolioEvidence } from '../src/hms/live-folio-read-driver.js';
import { runtimeFingerprintSha256 } from '../src/hms/evidence-runtime.js';
import { fingerprintReadToolRegistry } from '../src/hms/read-tools.js';
import { probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolveMailboxContext } from '../src/trpc/context.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { claimNextAiRun } from '../src/ai/run-ledger.js';
import { afterEach, describe, expect, it } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const reachable = await probeTestDb();
const OBSERVED_AT = new Date('2026-09-07T12:00:00.000Z');

function installFindRelease(): void {
  __setCachedActiveReadRuntimeForTests({
    releases: new Map([
      [
        'hms_find_reservation',
        {
          releaseId: 'u17-db-find-release',
          toolId: 'hms_find_reservation',
          evidenceKind: 'hms',
          requestBranches: [{ id: 'guest_stay_search' }],
        },
      ],
      [
        'hms_read_folio',
        {
          releaseId: 'u17-db-folio-release',
          toolId: 'hms_read_folio',
          evidenceKind: 'hms',
          requestBranches: [
            { id: 'folio_summary', discoveryOperationId: 'folio_summary' },
            {
              id: 'deposit_ledger_summary',
              discoveryOperationId: 'deposit_ledger_summary',
            },
          ],
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

async function installRealFolioRelease(): Promise<{
  root: string;
  active: Awaited<ReturnType<typeof loadWorkerActiveReadSet>>;
  releaseId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'u17-finance-release-'));
  const releaseId = randomUUID();
  const sourceRevision = resolveHmsSourceRevision();
  const runtimeFp = runtimeFingerprintSha256({
    sourceRevision,
    playwrightRevision: '1.52.0',
    chromiumRevision: '1169',
  });
  const toolsetVersion = 'u17-finance-test-tools';
  const toolsetFingerprint = fingerprintReadToolRegistry();
  const folioManifestSha256 = reviewedManifestSha256(
    await readFile(
      join(process.cwd(), 'src/hms/request-manifests/hms_read_folio.folio.1.0.0.json'),
      'utf8',
    ),
    {
      toolId: 'hms_read_folio',
      toolVersion: '1.0.0',
      discoveryOperationId: 'folio_summary',
    },
  );
  const depositManifestSha256 = reviewedManifestSha256(
    await readFile(
      join(process.cwd(), 'src/hms/request-manifests/hms_read_folio.deposit-ledger.1.0.0.json'),
      'utf8',
    ),
    {
      toolId: 'hms_read_folio',
      toolVersion: '1.0.0',
      discoveryOperationId: 'deposit_ledger_summary',
    },
  );
  const digest = (label: string) => sha256Hex(`u17-finance-release:${label}`);
  const release = hmsPortfolioToolReleaseV2Schema.parse({
    schemaVersion: 2,
    releaseId,
    toolsetVersion,
    toolsetFingerprint,
    sourceRevision,
    phaseAPlanSha256: digest('phase-a'),
    phaseBPlanSha256: digest('phase-b'),
    gateSha256: digest('gate'),
    runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
    runtimeFingerprintSha256: runtimeFp,
    requesterPolicySha256: digest('requester-policy'),
    privateDigestKeyVersion: 'u17-v1',
    liveProofSha256: digest('live-proof'),
    receiptSha256: digest('receipt'),
    qualification: 'live_verified',
    shadowSha256: null,
    evidenceKind: 'hms',
    toolId: 'hms_read_folio',
    toolVersion: '1.0.0',
    implementationSha256: FOLIO_READ_IMPL_V1,
    predecessorReleaseId: null,
    rollbackAction: 'disable',
    requestBranches: [
      {
        id: 'folio_summary',
        discoveryOperationId: 'folio_summary',
        manifestSha256: folioManifestSha256,
        discoverySha256: digest('discovery-folio'),
        parserSchemaSha256: digest('parser-folio'),
      },
      {
        id: 'deposit_ledger_summary',
        discoveryOperationId: 'deposit_ledger_summary',
        manifestSha256: depositManifestSha256,
        discoverySha256: digest('discovery-deposit'),
        parserSchemaSha256: digest('parser-deposit'),
      },
    ],
    credentialVersionHmacSha256: digest('credential'),
    roleProofSha256: digest('role-proof'),
  });
  const active = {
    schemaVersion: 2 as const,
    generation: 1,
    toolsetVersion,
    toolsetFingerprint,
    active: { hms_read_folio: releaseId },
    immediatePredecessor: {},
  };
  const registry = hmsActiveRegistryV2Schema.parse({
    ...active,
    activeSetFingerprint: fingerprintActiveSet(active),
  });
  await writeFile(join(root, `${releaseId}.json`), `${JSON.stringify(release)}\n`, {
    mode: 0o600,
  });
  const registryPath = join(root, 'active.json');
  await writeFile(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  const loaded = await loadWorkerActiveReadSet({
    registryPath,
    releaseRoot: root,
    runtimeFingerprintSha256: runtimeFp,
  });
  expect(loaded.registry).toMatchObject({ active: { hms_read_folio: releaseId } });
  expect(loaded.handlerPathActive).toBe(true);
  return { root, active: loaded, releaseId };
}

async function seedMailThread(db: DB) {
  const threadId = randomUUID();
  const triggerMessageId = randomUUID();
  await db.insert(mailThread).values({
    id: threadId,
    transportId: TRANSPORT_ID,
    threadRootId: `<u17-finance-db-${threadId}@example.com>`,
    subject: 'U17 finance DB fixture',
    snippet: 'U17 finance DB fixture',
    latestMessageAt: OBSERVED_AT,
  });
  await db.insert(message).values({
    id: triggerMessageId,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: 'u17-finance-db@example.com',
    toAddresses: ['nava@example.com'],
    subject: 'U17 finance DB fixture',
    textBody: 'Please reconcile confirmation CONF-U17DB-001.',
    receivedAt: OBSERVED_AT,
  });
  return { threadId, triggerMessageId };
}

async function withDb<T>(callback: (db: DB) => Promise<T>): Promise<T> {
  return withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    try {
      return await callback(db);
    } finally {
      __setDbForTests(null);
    }
  });
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
  process.env.S3_BUCKET = 'u17-finance-synthetic-bucket';
  process.env.AI_WORKER_LANE = 'hms';
  process.env.HMS_READ_SERVICE_ENABLED = 'true';
  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
  process.env.HMS_RUN_DEADLINE_MS = '150000';
  process.env.HMS_HEALTH_STATUS_PATH = '/tmp/u17-finance-hms-health.json';
  process.env.HMS_EXPECTED_PROPERTY_CODE = 'HRCEN';
  process.env.HMS_READ_SECRET_ARN = 'u17-finance-test-secret';
  process.env.HMS_CHROMIUM_EXECUTABLE_PATH = '/bin/false';
  process.env.HMS_READ_ROLE_PROOF_PATH = '/tmp/u17-finance-role-proof.json';
  process.env.HMS_EXPECTED_TENANT = 'u17-finance-tenant';
  process.env.HMS_EXPECTED_TRANSPORT_ID = TRANSPORT_ID;
  process.env.HMS_EVIDENCE_HMAC_SECRET_ARN = 'u17-finance-test-evidence-secret';
  process.env.HMS_EVIDENCE_HMAC_KEY_VERSION = 'u17-v1';
  process.env.HMS_ACTIVE_REGISTRY_PATH = '/tmp/u17-finance-unused-active.json';
  process.env.HMS_RELEASE_ROOT = '/tmp/u17-finance-unused-releases';
  process.env.NAVA_BUILD_COMMIT = 'u17-finance-test-source';
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

function makeLowerIoRuntime(options: { finalizedReceipt?: boolean } = {}): {
  runtime: import('../src/hms/runtime.js').HmsRuntime;
  calls: Array<{
    releaseId: string;
    requestBranchId: string;
    manifestSha256: string;
    runtimeFingerprintSha256: string;
    authorization: import('../src/hms/release-kernel.js').HmsSessionAuthorization;
  }>;
} {
  const calls: Array<{
    releaseId: string;
    requestBranchId: string;
    manifestSha256: string;
    runtimeFingerprintSha256: string;
    authorization: import('../src/hms/release-kernel.js').HmsSessionAuthorization;
  }> = [];
  const response = (rows: Array<Record<string, unknown>>) =>
    JSON.stringify({
      pageData: {
        success: true,
        grid: {
          GRIDRESULT: {
            type: 'LIST.DATA_ONLY.STORED',
            GRID: { DATA: rows },
          },
        },
      },
    });
  const page = {
    postForm: async (url: string) => {
      if (url.includes('OSRESS.search')) {
        return JSON.stringify({
          pageData: {
            foliobalance: '120.00',
            propertycurrency: 'ZAR',
            success: true,
            grid: {
              GRIDRESULT: {
                type: 'LIST.DATA_ONLY.STORED',
                GRID: {
                  DATA: [
                    {
                      confirmationnumber: 'CONF-U17DB-001',
                      foliobalance: '120.00',
                      propertycurrency: 'ZAR',
                    },
                  ],
                },
              },
            },
          },
        });
      }
      if (url.includes('OSLEDG.LST')) {
        return response([{ closingdate: '2026-09-07', property: 'HRCEN' }]);
      }
      if (url.includes('OSLEDG.DLD')) {
        return response([
          {
            confirmationnumber: 'CONF-U17DB-001',
            currency: 'ZAR',
            newdeposits: '500.00',
            refunds: '0.00',
            forfeits: '0.00',
            toguestledger: '100.00',
            fromdeposit: '0.00',
            due: '500.00',
          },
        ]);
      }
      return '';
    },
    waitForCorrelatedResponse: async () => undefined,
    content: async () => '',
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
    readPropertyBinding: async () => ({
      tenant: 'u17-finance-tenant',
      propertyCode: 'HRCEN',
      propertyName: 'Synthetic Centurion',
    }),
    fillLogin: async () => undefined,
    submitLogin: async () => undefined,
    click: async () => undefined,
    fill: async () => undefined,
    press: async () => undefined,
    url: () => 'https://synthetic-hms.invalid/',
    title: async () => 'Synthetic HMS',
    evaluateStableDom: async <T>() => undefined as T,
    evaluate: async <T>() => undefined as T,
  };
  let latestAuditSpec:
    | {
        operationId?: string;
        toolId?: string;
        toolVersion?: string;
        executionClass?: string;
        inputClass?: string;
        requestBranchId?: string;
      }
    | undefined;
  const runtime = {
    start: async () => undefined,
    openReadSession: async (input: {
      sessionAuthorization?: {
        releaseId: string;
        requestBranchId: string;
        manifestSha256: string;
        runtimeFingerprintSha256: string;
      };
      auditSpec?: typeof latestAuditSpec;
    }) => {
      const authorization = input.sessionAuthorization;
      if (!authorization) throw new Error('lower runtime requires session authorization');
      latestAuditSpec = input.auditSpec;
      calls.push({
        releaseId: authorization.releaseId,
        requestBranchId: authorization.requestBranchId,
        manifestSha256: authorization.manifestSha256,
        runtimeFingerprintSha256: authorization.runtimeFingerprintSha256,
        authorization:
          authorization as import('../src/hms/release-kernel.js').HmsSessionAuthorization,
      });
      return {
        id: randomUUID(),
        origin: 'https://synthetic-hms.invalid',
        violation: () => null,
        terminal: () => false,
        page,
        lastReceipt: () => {
          if (!options.finalizedReceipt || !latestAuditSpec) return null;
          return {
            schemaVersion: 1,
            artifactId: `u17-folio-artifact-${latestAuditSpec.requestBranchId ?? 'unknown'}`,
            operationId: latestAuditSpec.operationId ?? 'unknown',
            sourceRevision: 'u17-finance-test-source',
            toolId: latestAuditSpec.toolId ?? 'hms_read_folio',
            toolVersion: latestAuditSpec.toolVersion ?? '1.0.0',
            dependencyRevision: 'playwright-1.52.0-chromium-1169',
            playwrightRevision: '1.52.0',
            chromiumRevision: '1169',
            executionClass: latestAuditSpec.executionClass ?? 'normal',
            inputClass: latestAuditSpec.inputClass ?? 'authorized_exact',
            credentialMode: 'view_only',
            roleProofSha256: null,
            roleProofExpiresAt: null,
            requestBranchId: latestAuditSpec.requestBranchId ?? null,
            operationOutcome: 'succeeded',
            requestRules: [],
            blockedRequests: 0,
            mutationRequests: 0,
            popupCount: 0,
            downloadCount: 0,
            webSocketCount: 0,
            milestones: {},
            terminalCode: 'OK',
            terminalStage: 'receipt_finalize',
            expiresAt: '2099-09-07T12:05:00.000Z',
            artifactState: 'complete',
            trace: { sha256: '1'.repeat(64), bytes: 1 },
            video: null,
          };
        },
        close: async () => undefined,
      };
    },
    health: () => ({
      state: 'ready' as const,
      browserLaunches: 0,
      contextsCreated: 0,
      contextsClosed: 0,
      activeSessions: 0,
      checkedAt: new Date().toISOString(),
      staleAfterMs: 60_000,
    }),
    close: async () => undefined,
    stats: () => ({ browserLaunches: 0, contextsCreated: 0, contextsClosed: 0 }),
  } as unknown as import('../src/hms/runtime.js').HmsRuntime;
  return { runtime, calls };
}

afterEach(() => {
  clearCachedActiveReadRuntimeForTests();
});

describe('U17 finance normal-runtime DB RED contract', () => {
  it('requires the finance DB fixture to carry active release and handler proof', async () => {
    await withReadOnlyWorkerEnv(async () => {
      const installed = await installRealFolioRelease();
      try {
        const active = installed.active;
        const folioRelease = active.releases.get('hms_read_folio');
        expect(folioRelease).toMatchObject({
          implementationSha256: FOLIO_READ_IMPL_V1,
          runtimeFingerprintSha256: expect.any(String),
        });
        expect(active.toolIds.has('hms_read_folio')).toBe(true);
        expect(active.registry).toMatchObject({ active: { hms_read_folio: installed.releaseId } });
        expect(active.handlerPathActive).toBe(true);
      } finally {
        await rm(installed.root, { recursive: true, force: true });
      }
    });
  });

  it('uses the registered release through default session construction with only lower PMS I/O substituted', async () => {
    await withReadOnlyWorkerEnv(async () => {
      const installed = await installRealFolioRelease();
      try {
        const lowerIo = makeLowerIoRuntime();
        const factory = createLiveHmsCandidateSessionFactory({
          runtime: lowerIo.runtime,
          activeReadState: installed.active,
        });
        const session = await factory({
          transportId: TRANSPORT_ID,
          threadId: 'u17-runtime-thread',
          lookupCandidates: [
            {
              id: 'u17-runtime-candidate',
              kind: 'confirmation',
              value: 'CONF-U17DB-001',
            },
          ],
          signal: new AbortController().signal,
          runId: 'u17-runtime-run',
          readResultRef: 'u17-runtime-read-result',
          readOnly: true,
          readToolId: 'hms_read_folio',
          folioSections: ['balance', 'deposits'],
          readAdmission: {
            releaseId: installed.releaseId,
            requestBranchId: 'folio_summary',
            requesterAuthorizationId: 'access-u17',
            inputDigest: '0'.repeat(64),
            captureRequired: true,
            captureBindingRef: 'u17-runtime-read-result',
            reservationRef: 'reservation-u17',
            reservationRefIssuedAt: '2026-09-07T12:00:00.000Z',
            reservationRefExpiresAt: '2099-09-07T12:05:00.000Z',
          },
        });
        if (!session.readFolio) throw new Error('default session did not expose finance read');
        const result = await session.readFolio(
          'u17-runtime-candidate',
          new AbortController().signal,
        );

        expect(result.status).toBe('manual_required');
        expect(result.data).toEqual(expect.any(Object));
        expect(result.evidence).toEqual(expect.objectContaining({ scopeVerified: false }));
        expect(lowerIo.calls).toHaveLength(2);
        expect(lowerIo.calls.map((call) => call.releaseId)).toEqual([
          installed.releaseId,
          installed.releaseId,
        ]);
        expect(lowerIo.calls.map((call) => call.requestBranchId)).toEqual([
          'folio_summary',
          'deposit_ledger_summary',
        ]);
        expect(lowerIo.calls.map((call) => call.runtimeFingerprintSha256)).toEqual([
          installed.active.releases.get('hms_read_folio')?.runtimeFingerprintSha256,
          installed.active.releases.get('hms_read_folio')?.runtimeFingerprintSha256,
        ]);
        expect(lowerIo.calls.map((call) => call.manifestSha256)).toEqual([
          installed.active.releases.get('hms_read_folio')?.requestBranches[0]?.manifestSha256,
          installed.active.releases.get('hms_read_folio')?.requestBranches[1]?.manifestSha256,
        ]);

        await expect(
          loadWorkerActiveReadSet({
            registryPath: join(installed.root, 'active.json'),
            releaseRoot: installed.root,
            runtimeFingerprintSha256: '0'.repeat(64),
          }),
        ).rejects.toThrow(/runtime fingerprint/i);
        const release = installed.active.releases.get('hms_read_folio');
        if (!release) throw new Error('registered folio release missing');
        const authorization = lowerIo.calls[0]!.authorization;
        expect(() =>
          createReadToolHandler(
            { ...release, implementationSha256: '0'.repeat(64) },
            authorization,
          ),
        ).toThrow(/no handler|implementation/i);
        expect(() =>
          createReadToolHandler(release, { ...authorization, manifestSha256: '0'.repeat(64) }),
        ).toThrow(/manifest/i);
        expect(lowerIo.calls).toHaveLength(2);
      } finally {
        await rm(installed.root, { recursive: true, force: true });
      }
    });
  });

  it('uses the authenticated mailbox grant, parent queue, worker, and typed finance receipt', async () => {
    if (!reachable) throw new Error('owned disposable DB probe unexpectedly unavailable');

    await withDb(async (db) => {
      installFindRelease();
      const context = await seedMailThread(db);
      const mailbox = await resolveMailboxContext(CENTURION_USER_ID, TRANSPORT_ID, db);
      const caller = appRouter.createCaller({
        auth: null as never,
        c: null as never,
        reqHeaders: new Headers(),
        sessionUser: { id: CENTURION_USER_ID, email: '', name: null },
        ...mailbox,
      });

      const parent = await caller.ai.enqueueHmsRead({ threadId: context.threadId });
      expect(parent).toMatchObject({
        runState: 'queued',
        triggerMessageId: context.triggerMessageId,
        readResultRef: expect.any(String),
      });

      const financeObservedAt = new Date().toISOString();
      let sessionFactoryCalls = 0;
      const sessionFactory: CandidateSessionFactory = async ({ lookupCandidates }) => {
        sessionFactoryCalls += 1;
        return {
          findReservation: async () => ({
            status: 'ok' as const,
            draftReady: false,
            data: {
              matches: [
                {
                  confirmationNumber: 'CONF-U17DB-001',
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
              id: randomUUID(),
              toolId: 'hms_find_reservation' as const,
              toolVersion: '1.2.0',
              propertyCode: 'HRCEN',
              observedAt: OBSERVED_AT.toISOString(),
              expiresAt: '2099-09-07T12:05:00.000Z',
              claimKeys: [],
              sourceHash: '1'.repeat(64),
            },
          }),
          quoteStay: async () => {
            throw new Error('not used');
          },
          readArtifact: async () => {
            throw new Error('not used');
          },
          readFolio: async () =>
            mergeFolioEvidence(
              [
                {
                  status: 'ok',
                  currency: 'ZAR',
                  totalBalance: '-120.00',
                  evidenceId: randomUUID(),
                  blocker: null,
                  rowsScanned: 2,
                  bytesObserved: 120,
                  durationMs: 5,
                  observedAt: financeObservedAt,
                },
                {
                  status: 'ok',
                  currency: 'ZAR',
                  depositSummary: {
                    total: '500.00',
                    due: { amount: '500.00', status: 'due' },
                    paid: { amount: '300.00', status: 'paid' },
                    refunded: { amount: '0.00', status: 'none_refunded' },
                    forfeited: { amount: '0.00', status: 'none_forfeited' },
                    transferred: { amount: '100.00', status: 'transferred' },
                  },
                  evidenceId: randomUUID(),
                  blocker: null,
                  rowsScanned: 2,
                  bytesObserved: 120,
                  durationMs: 5,
                  observedAt: financeObservedAt,
                },
              ],
              { recipientClass: 'unknown', inquiryClass: 'other' },
            ),
          lookupCandidates: new Map(lookupCandidates.map((candidate) => [candidate.id, candidate])),
          authorizedAttachmentIds: new Set(),
          propertyReadLock: {
            key: 'u17-finance-db',
            withLock: async (callback) =>
              callback({ query: async () => [], close: async () => undefined }),
          },
        };
      };

      await withReadOnlyWorkerEnv(async () => {
        const installed = await installRealFolioRelease();
        const lowerIo = makeLowerIoRuntime({ finalizedReceipt: true });
        try {
          expect(
            await claimNextAiRun({
              ownerId: 'u17-finance-worker',
              lane: 'hms',
              runKind: 'read_tool',
              db,
            }),
          ).toMatchObject({ id: parent.runId });
          const parentExecution = await executeAiRun(parent.runId, {
            candidateSessionFactory: sessionFactory,
          });
          if (parentExecution.state !== 'succeeded') {
            const [failedParent] = await db
              .select({
                state: aiWorkflowRun.state,
                lastError: aiWorkflowRun.lastError,
                failureClass: aiWorkflowRun.failureClass,
              })
              .from(aiWorkflowRun)
              .where(eq(aiWorkflowRun.id, parent.runId));
            throw new Error(`parent execution failed: ${JSON.stringify(failedParent)}`);
          }
          const parentReceipt = await caller.ai.readHmsReceipt({
            threadId: context.threadId,
            readResultRef: parent.readResultRef,
          });
          expect(parentReceipt.result).toMatchObject({
            toolId: 'hms_find_reservation',
            status: 'ok',
          });

          const finance = await caller.ai.enqueueHmsFolioRead({
            threadId: context.threadId,
            findResultRef: parent.readResultRef,
            sections: ['balance', 'deposits'],
          });
          expect(finance).toMatchObject({ runState: 'queued', reservationRef: expect.any(String) });
          expect(
            await claimNextAiRun({
              ownerId: 'u17-finance-worker',
              lane: 'hms',
              runKind: 'read_tool',
              db,
            }),
          ).toMatchObject({ id: finance.runId });
          const financeExecution = await executeAiRun(finance.runId, {
            hmsRuntime: lowerIo.runtime,
          });
          if (financeExecution.state !== 'succeeded') {
            const [failedFinance] = await db
              .select({
                state: aiWorkflowRun.state,
                lastError: aiWorkflowRun.lastError,
                failureClass: aiWorkflowRun.failureClass,
              })
              .from(aiWorkflowRun)
              .where(eq(aiWorkflowRun.id, finance.runId));
            throw new Error(`finance execution failed: ${JSON.stringify(failedFinance)}`);
          }
          const receipt = await caller.ai.readHmsReceipt({
            threadId: context.threadId,
            readResultRef: finance.readResultRef,
          });
          expect(receipt.result).toMatchObject({
            toolId: 'hms_read_folio',
            status: 'ok',
            completeness: 'complete',
            scopeRef: finance.reservationRef,
          });
          expect(receipt.result.data).toMatchObject({
            totalBalance: '120.00',
            disclosure: { claimEligibility: 'blocked' },
          });
          expect(receipt.result.evidence[0]).toMatchObject({
            scopeVerified: true,
            artifactRef: expect.stringMatching(/^u17-folio-artifact-/),
            artifactRefs: expect.arrayContaining([expect.stringMatching(/^u17-folio-artifact-/)]),
            sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          });

          const authorizationFinance = await caller.ai.enqueueHmsFolioRead({
            threadId: context.threadId,
            findResultRef: parent.readResultRef,
            sections: ['authorization'],
          });
          expect(
            await claimNextAiRun({
              ownerId: 'u17-finance-worker',
              lane: 'hms',
              runKind: 'read_tool',
              db,
            }),
          ).toMatchObject({ id: authorizationFinance.runId });
          const authorizationExecution = await executeAiRun(authorizationFinance.runId, {
            candidateSessionFactory: sessionFactory,
          });
          if (authorizationExecution.state !== 'succeeded') {
            const [failedAuthorization] = await db
              .select({
                state: aiWorkflowRun.state,
                lastError: aiWorkflowRun.lastError,
                failureClass: aiWorkflowRun.failureClass,
              })
              .from(aiWorkflowRun)
              .where(eq(aiWorkflowRun.id, authorizationFinance.runId));
            throw new Error(
              `authorization execution failed: ${JSON.stringify(failedAuthorization)}`,
            );
          }
          const authorizationReceipt = await caller.ai.readHmsReceipt({
            threadId: context.threadId,
            readResultRef: authorizationFinance.readResultRef,
          });
          expect(authorizationReceipt.result).toMatchObject({
            toolId: 'hms_read_folio',
            completeness: 'partial',
            unavailableSections: [expect.objectContaining({ section: 'authorization' })],
          });
          const successfulSessionFactoryCalls = sessionFactoryCalls;

          const runRows = async () => db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun);
          const runsBeforeControls = await runRows();

          const foreignMailbox = await resolveMailboxContext(MARTHA_USER_ID, TRANSPORT_ID, db);
          const [foreignGrant] = await db
            .select({ id: mailboxAccess.id })
            .from(mailboxAccess)
            .where(
              and(
                eq(mailboxAccess.userId, MARTHA_USER_ID),
                eq(mailboxAccess.transportId, TRANSPORT_ID),
              ),
            )
            .limit(1);
          if (!foreignGrant)
            throw new Error('foreign current grant missing for provenance control');
          const foreignCaller = appRouter.createCaller({
            auth: null as never,
            c: null as never,
            reqHeaders: new Headers(),
            sessionUser: { id: MARTHA_USER_ID, email: '', name: null },
            ...foreignMailbox,
          });
          await expect(
            foreignCaller.ai.enqueueHmsFolioRead({
              threadId: context.threadId,
              findResultRef: parent.readResultRef,
              sections: ['balance'],
            }),
          ).rejects.toThrow(/parent|issuer|scope|grant/i);
          expect(await runRows()).toHaveLength(runsBeforeControls.length);

          const [storedParent] = await db
            .select()
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, parent.runId))
            .limit(1);
          if (!storedParent || !storedParent.readResult || !storedParent.readResultExpiresAt) {
            throw new Error('positive parent row missing for authority controls');
          }
          const positiveParentResult = storedParent.readResult;
          const positiveParentExpiry = storedParent.readResultExpiresAt;
          const positiveParentData = parentReceipt.result.data as {
            matches: readonly unknown[];
            matchCount: number;
            capped: boolean;
          };
          await db
            .update(aiWorkflowRun)
            .set({
              readResult: {
                ...parentReceipt.result,
                status: 'ambiguous',
                data: {
                  ...positiveParentData,
                  matches: [...positiveParentData.matches, ...positiveParentData.matches],
                  matchCount: 2,
                },
              },
            })
            .where(eq(aiWorkflowRun.id, parent.runId));
          await expect(
            caller.ai.enqueueHmsFolioRead({
              threadId: context.threadId,
              findResultRef: parent.readResultRef,
              sections: ['balance'],
            }),
          ).rejects.toThrow(/positive|evidence|parent|receipt/i);
          await db
            .update(aiWorkflowRun)
            .set({ readResult: positiveParentResult })
            .where(eq(aiWorkflowRun.id, parent.runId));

          await db
            .update(aiWorkflowRun)
            .set({ readResultExpiresAt: new Date(Date.now() - 1_000) })
            .where(eq(aiWorkflowRun.id, parent.runId));
          await expect(
            caller.ai.enqueueHmsFolioRead({
              threadId: context.threadId,
              findResultRef: parent.readResultRef,
              sections: ['balance'],
            }),
          ).rejects.toThrow(/expired|evidence|receipt|parent/i);
          await db
            .update(aiWorkflowRun)
            .set({ readResultExpiresAt: positiveParentExpiry })
            .where(eq(aiWorkflowRun.id, parent.runId));

          const claimReadRun = async (runId: string) => {
            expect(
              await claimNextAiRun({
                ownerId: 'u17-finance-worker',
                lane: 'hms',
                runKind: 'read_tool',
                db,
              }),
            ).toMatchObject({ id: runId });
          };
          const expectAuthorityDeadLetter = async (runId: string, errorPattern: RegExp) => {
            const execution = await executeAiRun(runId, {
              candidateSessionFactory: sessionFactory,
            });
            expect(execution).toMatchObject({ state: 'dead_letter' });
            const [run] = await db
              .select({ state: aiWorkflowRun.state, lastError: aiWorkflowRun.lastError })
              .from(aiWorkflowRun)
              .where(eq(aiWorkflowRun.id, runId));
            expect(run).toMatchObject({ state: 'dead_letter' });
            expect(run?.lastError).toMatch(errorPattern);
            expect(sessionFactoryCalls).toBe(successfulSessionFactoryCalls);
          };

          const expiredFinance = await caller.ai.enqueueHmsFolioRead({
            threadId: context.threadId,
            findResultRef: parent.readResultRef,
            sections: ['balance'],
          });
          await claimReadRun(expiredFinance.runId);
          const [storedExpiredFinance] = await db
            .select()
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, expiredFinance.runId))
            .limit(1);
          if (
            !storedExpiredFinance ||
            !storedExpiredFinance.readRequest ||
            !storedExpiredFinance.metrics ||
            typeof storedExpiredFinance.readRequest !== 'object' ||
            typeof storedExpiredFinance.metrics !== 'object'
          ) {
            throw new Error('issued finance run missing persisted expiry authority');
          }
          const expiredIssuedAt = new Date(Date.now() - 60_000).toISOString();
          const expiredAt = new Date(Date.now() - 1_000).toISOString();
          const expiredRequest = storedExpiredFinance.readRequest as Record<string, unknown>;
          const expiredAdmission = expiredRequest.admission;
          const expiredMetrics = storedExpiredFinance.metrics as Record<string, unknown>;
          const expiredIssuer = expiredMetrics.readAdmissionIssuer;
          if (
            !expiredAdmission ||
            typeof expiredAdmission !== 'object' ||
            !expiredIssuer ||
            typeof expiredIssuer !== 'object'
          ) {
            throw new Error('issued finance run missing expiry admission provenance');
          }
          await db
            .update(aiWorkflowRun)
            .set({
              readRequest: {
                ...expiredRequest,
                admission: {
                  ...(expiredAdmission as Record<string, unknown>),
                  reservationRefIssuedAt: expiredIssuedAt,
                  reservationRefExpiresAt: expiredAt,
                },
              },
              metrics: {
                ...expiredMetrics,
                readAdmissionIssuer: {
                  ...(expiredIssuer as Record<string, unknown>),
                  reservationRefIssuedAt: expiredIssuedAt,
                  reservationRefExpiresAt: expiredAt,
                },
              },
            })
            .where(eq(aiWorkflowRun.id, expiredFinance.runId));
          await expectAuthorityDeadLetter(expiredFinance.runId, /expired|not yet issued/i);

          const provenanceFinance = await caller.ai.enqueueHmsFolioRead({
            threadId: context.threadId,
            findResultRef: parent.readResultRef,
            sections: ['deposits'],
          });
          await claimReadRun(provenanceFinance.runId);
          const [storedProvenanceFinance] = await db
            .select()
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, provenanceFinance.runId))
            .limit(1);
          if (
            !storedProvenanceFinance ||
            !storedProvenanceFinance.metrics ||
            typeof storedProvenanceFinance.metrics !== 'object'
          ) {
            throw new Error('issued finance run missing persisted provenance');
          }
          const provenanceMetrics = storedProvenanceFinance.metrics as Record<string, unknown>;
          const provenanceIssuer = provenanceMetrics.readAdmissionIssuer;
          if (!provenanceIssuer || typeof provenanceIssuer !== 'object') {
            throw new Error('issued finance run missing issuer provenance');
          }
          await db
            .update(aiWorkflowRun)
            .set({
              metrics: {
                ...provenanceMetrics,
                readAdmissionIssuer: {
                  ...(provenanceIssuer as Record<string, unknown>),
                  mailboxAccessId: foreignGrant.id,
                },
              },
            })
            .where(eq(aiWorkflowRun.id, provenanceFinance.runId));
          await expectAuthorityDeadLetter(
            provenanceFinance.runId,
            /issuer|provenance|mailbox|authorization/i,
          );

          const revokedFinance = await caller.ai.enqueueHmsFolioRead({
            threadId: context.threadId,
            findResultRef: parent.readResultRef,
            sections: ['transactions'],
          });
          await claimReadRun(revokedFinance.runId);

          await db
            .delete(mailboxAccess)
            .where(eq(mailboxAccess.id, `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`));
          await expectAuthorityDeadLetter(revokedFinance.runId, /grant|mailbox|active/i);
          const runsBeforeRevokedProducerControl = await runRows();
          await expect(
            caller.ai.enqueueHmsFolioRead({
              threadId: context.threadId,
              findResultRef: parent.readResultRef,
              sections: ['balance'],
            }),
          ).rejects.toThrow(/grant|mailbox|active/i);
          expect(await runRows()).toHaveLength(runsBeforeRevokedProducerControl.length);
          expect(sessionFactoryCalls).toBe(successfulSessionFactoryCalls);
          expect(lowerIo.calls).toHaveLength(2);
          expect(lowerIo.calls.every((call) => call.releaseId === installed.releaseId)).toBe(true);
        } finally {
          await rm(installed.root, { recursive: true, force: true });
        }
      });
    });
  });
});
