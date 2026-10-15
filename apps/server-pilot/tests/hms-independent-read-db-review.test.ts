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
  createHmsBrowserArtifactStore,
  ensureHmsBrowserArtifactRoot,
  HMS_BROWSER_ARTIFACT_MIN_FREE_BYTES,
} from '../src/hms/browser-artifacts.js';
import {
  existingDocumentRefForRecord,
  existingDocumentScopeRef,
  mailAttachmentRecord,
} from '../src/mail/artifacts/existing-document-service.js';
import {
  linkedContextReferenceSchema,
  mintLinkedContextReference,
  type LinkedContextReference,
} from '../src/hms/context-read-reference.js';
import {
  __clearQuoteReferenceAuthorityLoaderForTests,
  __setQuoteReferenceAuthorityLoaderForTests,
} from '../src/hms/read-admission-issuer.js';
import {
  aiWorkflowRun,
  attachment,
  mailboxAccess,
  mailboxTransport,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  openTestDbSession,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import {
  extractLookupCandidates,
  filterExactReservationCandidates,
} from '../src/ai/thread-context.js';
import { executeAiRun, runAiWorkerOnce, type CandidateSessionFactory } from '../src/ai/worker.js';
import { syntheticQuoteReferenceAuthorityLoader } from './helpers/quote-reference-authority.js';
import { issueReadAdmissionFromMailbox } from '../src/hms/read-admission-issuer.js';
import { CENTURION_USER_ID, MARTHA_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { buildLiveGroupBlockListManifest } from '../src/hms/live-read-manifest.js';
import { createPostgresPropertyReadLock } from '../src/hms/property-read-lock.js';
import type { CandidateToolSession } from '../src/ai/candidate-draft-agent.js';
import { GROUP_BLOCK_READ_IMPL_V1 } from '../src/hms/read-handler-index.js';
import { __setDbForTests, getDb, type DB } from '../src/db/client.js';
import { issueReadAdmission } from '../src/hms/read-admission.js';
import { resolveMailboxContext } from '../src/trpc/context.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import * as mastraModule from '../src/ai/mastra.js';
import { appRouter } from '../src/trpc/router.js';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const reachable = await probeTestDb();
const observedAt = '2026-09-07T12:00:00.000Z';
const expiresAt = '2026-09-07T12:05:00.000Z';
const REQUESTER_AUTHORIZATION_ID = `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`;
const READ_MANIFEST_SHA256 = 'a'.repeat(64);
const QUOTE_REQUEST_TEXT =
  'Please quote arrival 2026-09-10, departure 2026-09-12, 2 adults, 0 children, 1 room, room type STD, rate plan BAR, currency ZAR.';
const GROUP_MANIFEST_SHA256 = createHash('sha256')
  .update(JSON.stringify(buildLiveGroupBlockListManifest('https://appsrv-1.legacyhotels.co.za')))
  .digest('hex');

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function syntheticTraceZip(): Buffer {
  const entries = [
    ['trace.trace', '{"type":"context-created"}\n'],
    ['trace.network', '{"type":"request"}\n'],
  ] as const;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name);
    const body = Buffer.from(text);
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralBody = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBody.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBody, end]);
}

async function createAuditedGroupRuntime(transport: string): Promise<{
  runtime: unknown;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'u15-group-runtime-'));
  await ensureHmsBrowserArtifactRoot(root);
  const store = await createHmsBrowserArtifactStore({
    root,
    getFreeBytes: async () => HMS_BROWSER_ARTIFACT_MIN_FREE_BYTES,
  });
  const runtime = {
    openReadSession: async (input: {
      transportId: string;
      signal: AbortSignal;
      auditSpec?: Parameters<typeof store.beginCapture>[0];
    }) => {
      if (!input.auditSpec) throw new Error('synthetic group audit spec missing');
      const handle = await store.beginCapture(input.auditSpec);
      await writeFile(join(handle.stagingDir, 'trace.zip'), syntheticTraceZip());
      let receipt: unknown = null;
      let closed = false;
      return {
        id: 'synthetic-group-session',
        origin: 'https://appsrv-1.legacyhotels.co.za',
        page: {
          postForm: async (url: string) => (url.endsWith('GSGRPB.LST') ? transport : ''),
          waitForCorrelatedResponse: async () => undefined,
          content: async () => transport,
        },
        terminal: () => false,
        violation: () => null,
        lastReceipt: () => receipt,
        close: async (options?: {
          outcome?: 'succeeded' | 'unverified_negative' | 'failed';
          terminalCode?: 'OK' | 'UNVERIFIED_NEGATIVE' | 'TOOL_ERROR';
          complete?: boolean;
        }) => {
          if (closed) return;
          closed = true;
          receipt = await handle.finalize({
            outcome: options?.outcome ?? 'failed',
            terminalCode: options?.terminalCode ?? 'TOOL_ERROR',
            terminalStage: 'tool',
            sourceRevision: input.auditSpec.sourceRevision ?? 'unknown',
            playwrightRevision: '1.52.0',
            chromiumRevision: '1169',
            requestRules: [],
            blockedRequests: 0,
            mutationRequests: 0,
            popupCount: 0,
            downloadCount: 0,
            webSocketCount: 0,
            complete: options?.complete ?? false,
          });
        },
      };
    },
  };
  return {
    runtime,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

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
    'HMS_EXPECTED_PROPERTY_CODE',
    'HMS_EXPECTED_TENANT',
    'HMS_EXPECTED_TRANSPORT_ID',
    'HMS_READ_SECRET_ARN',
    'HMS_CHROMIUM_EXECUTABLE_PATH',
    'HMS_READ_ROLE_PROOF_PATH',
    'HMS_EVIDENCE_HMAC_SECRET_ARN',
    'HMS_EVIDENCE_HMAC_KEY_VERSION',
    'HMS_HEALTH_STATUS_PATH',
    'NAVA_BUILD_COMMIT',
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
  process.env.HMS_EXPECTED_PROPERTY_CODE = 'HRCEN';
  process.env.HMS_EXPECTED_TENANT = 'u8-review-tenant';
  process.env.HMS_EXPECTED_TRANSPORT_ID = TRANSPORT_ID;
  process.env.HMS_READ_SECRET_ARN = 'u8-review-secret';
  process.env.HMS_CHROMIUM_EXECUTABLE_PATH = '/bin/false';
  process.env.HMS_READ_ROLE_PROOF_PATH = '/tmp/u8-review-role-proof.json';
  process.env.HMS_EVIDENCE_HMAC_SECRET_ARN = 'u8-review-evidence-secret';
  process.env.HMS_EVIDENCE_HMAC_KEY_VERSION = 'u8-v1';
  process.env.HMS_HEALTH_STATUS_PATH = '/tmp/u8-review-health.json';
  process.env.NAVA_BUILD_COMMIT = 'u8-review-source';
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

function syntheticManualReadResult(toolId: string) {
  return {
    toolId,
    schemaVersion:
      toolId === 'hms_read_reservation'
        ? 'reservation-context/1'
        : toolId === 'hms_find_reservation'
          ? 'reservation-find/1'
          : 'u8-i3/1',
    status: 'manual_required' as const,
    data: null,
    completeness: 'unknown' as const,
    unavailableSections: [],
    scopeRef: `u8-i3-scope-${toolId}`,
    evidence: [],
    page: null,
    issues: [],
  };
}

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
    propertyCode: 'HRCEN',
    manifestSha256: READ_MANIFEST_SHA256,
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

async function withIndependentReadRaceDb<T>(
  callback: (input: {
    inspectDb: DB;
    leftDb: DB;
    rightDb: DB;
    base: Awaited<ReturnType<typeof enqueueAiRun>>;
    baseInput: Awaited<ReturnType<typeof readRunInput>>;
    leftInput: Awaited<ReturnType<typeof readRunInput>>;
    rightInput: Awaited<ReturnType<typeof readRunInput>>;
    transportId: string;
  }) => Promise<T>,
): Promise<T> {
  const fixtureId = `u8-followup-race-${randomUUID()}`;
  const transportId = `${fixtureId}-transport`;
  const threadId = `${fixtureId}-thread`;
  const triggerMessageId = `${fixtureId}-message`;
  const setupSession = openTestDbSession();
  let leftSession: ReturnType<typeof openTestDbSession> | undefined;
  let rightSession: ReturnType<typeof openTestDbSession> | undefined;

  const makeInput = (suffix: string) => {
    const readResultRef = `${fixtureId}-${suffix}-ref`;
    const issued = issueReadAdmission({
      source: {
        userId: `${fixtureId}-user`,
        mailboxAccessId: `${fixtureId}-access`,
        transportId,
        threadId,
        triggerMessageId,
        releaseId: 'release-red',
        requestBranchId: 'guest_stay_search',
        manifestSha256: READ_MANIFEST_SHA256,
        captureBindingRef: readResultRef,
      },
      now: new Date(observedAt),
      toolId: 'hms_find_reservation',
      candidateId: 'CONF-RACE-0001',
    });
    return {
      transportId,
      threadId,
      triggerMessageId,
      runKind: 'read_tool' as const,
      idempotencyKey: `${fixtureId}:logical`,
      modelId: NOT_APPLICABLE_MODEL_ID,
      promptVersion: READ_TOOL_PROMPT_VERSION,
      executorLane: 'hms' as const,
      readRequest: issued.readRequest,
      readAdmissionIssuer: issued.issuer,
      readResultRef,
    };
  };

  try {
    await setupSession.db.insert(mailboxTransport).values({
      id: transportId,
      email: `${fixtureId}@example.com`,
      ownerHeaderValue: `${fixtureId}@example.com`,
      mailboxType: 'shared',
      displayName: 'U8 independent retry race fixture',
      isActive: true,
    });
    await setupSession.db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: `<${fixtureId}@example.com>`,
      subject: 'U8 independent retry race fixture',
      snippet: 'U8 independent retry race fixture',
      latestMessageAt: new Date(observedAt),
    });
    await setupSession.db.insert(message).values({
      id: triggerMessageId,
      transportId,
      threadId,
      direction: 'inbound',
      fromAddress: `${fixtureId}@example.com`,
      toAddresses: ['nava@example.com'],
      subject: 'U8 independent retry race fixture',
      textBody: 'U8 independent retry race fixture',
      receivedAt: new Date(observedAt),
    });

    const baseInput = makeInput('base');
    const base = await enqueueAiRun(baseInput, setupSession.db);
    await setupSession.db
      .update(aiWorkflowRun)
      .set({
        state: 'dead_letter',
        failureClass: 'POLICY_BLOCK',
        lastError: 'synthetic terminal read failure',
        finishedAt: new Date(observedAt),
        updatedAt: new Date(observedAt),
      })
      .where(eq(aiWorkflowRun.id, base.id));

    leftSession = openTestDbSession();
    rightSession = openTestDbSession();
    return await callback({
      inspectDb: setupSession.db,
      leftDb: leftSession.db,
      rightDb: rightSession.db,
      base,
      baseInput,
      leftInput: makeInput('left'),
      rightInput: makeInput('right'),
      transportId,
    });
  } finally {
    await Promise.all([
      leftSession?.close() ?? Promise.resolve(),
      rightSession?.close() ?? Promise.resolve(),
    ]);
    await setupSession.db.delete(aiWorkflowRun).where(eq(aiWorkflowRun.transportId, transportId));
    await setupSession.db.delete(message).where(eq(message.id, triggerMessageId));
    await setupSession.db.delete(mailThread).where(eq(mailThread.id, threadId));
    await setupSession.db.delete(mailboxTransport).where(eq(mailboxTransport.id, transportId));
    await setupSession.close();
  }
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
    propertyCode: 'HRCEN',
    manifestSha256: READ_MANIFEST_SHA256,
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
    propertyCode: 'HRCEN',
    manifestSha256: READ_MANIFEST_SHA256,
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
          linkedContextRefs: {
            company: 'CONF-RED',
            group: 'GROUP-U15',
            event: 'EVENT-U15',
            notes: 'RESOURCE-U15',
          },
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
          requestBranches: [{ id: 'guest_stay_search', manifestSha256: READ_MANIFEST_SHA256 }],
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

function installAllReadReleasesForTests(): void {
  __setCachedActiveReadRuntimeForTests({
    releases: new Map([
      [
        'hms_find_reservation',
        {
          releaseId: 'u8-i3-find-release',
          toolId: 'hms_find_reservation',
          evidenceKind: 'hms',
          sourceRevision: 'u8-i3-source',
          requestBranches: [{ id: 'guest_stay_search', manifestSha256: READ_MANIFEST_SHA256 }],
        },
      ],
      [
        'hms_quote_stay',
        {
          releaseId: 'u8-i3-quote-release',
          toolId: 'hms_quote_stay',
          evidenceKind: 'hms',
          sourceRevision: 'u8-i3-source',
          requestBranches: [{ id: 'quote_availability_search', manifestSha256: 'b'.repeat(64) }],
        },
      ],
      [
        'hms_read_folio',
        {
          releaseId: 'u8-i3-folio-release',
          toolId: 'hms_read_folio',
          evidenceKind: 'hms',
          requestBranches: [
            { id: 'folio_summary', manifestSha256: 'c'.repeat(64) },
            { id: 'deposit_ledger_summary', manifestSha256: 'd'.repeat(64) },
          ],
        },
      ],
      [
        'hms_company_account_read',
        {
          releaseId: 'u8-i3-company-release',
          toolId: 'hms_company_account_read',
          evidenceKind: 'hms',
          requestBranches: [
            { id: 'reservation_linked_company_billing', manifestSha256: 'e'.repeat(64) },
          ],
        },
      ],
      [
        'hms_group_block_read',
        {
          releaseId: 'u8-i3-group-release',
          toolId: 'hms_group_block_read',
          evidenceKind: 'hms',
          requestBranches: [{ id: 'group_block_list', manifestSha256: GROUP_MANIFEST_SHA256 }],
        },
      ],
      [
        'hms_event_read',
        {
          releaseId: 'u8-i3-event-release',
          toolId: 'hms_event_read',
          evidenceKind: 'hms',
          requestBranches: [{ id: 'event_list', manifestSha256: 'f'.repeat(64) }],
        },
      ],
      [
        'hms_read_notes_traces',
        {
          releaseId: 'u8-i3-notes-release',
          toolId: 'hms_read_notes_traces',
          evidenceKind: 'hms',
          requestBranches: [{ id: 'notes_traces_list', manifestSha256: '1'.repeat(64) }],
        },
      ],
    ]),
    predecessors: new Map(),
    toolIds: new Set([
      'hms_find_reservation',
      'hms_quote_stay',
      'hms_read_reservation',
      'hms_read_folio',
      'hms_company_account_read',
      'hms_group_block_read',
      'hms_event_read',
      'hms_read_notes_traces',
      'documents_list_existing',
      'documents_read_existing',
    ]),
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
    __clearQuoteReferenceAuthorityLoaderForTests();
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

  it('selects the newer valid inbound instead of an older clockless import', async () => {
    await withWorkerDb(async (db) => {
      const context = await seededMailContext(db);
      const newerMessageId = randomUUID();
      const clocklessOlderMessageId = randomUUID();
      await db.insert(message).values([
        {
          id: newerMessageId,
          transportId: context.transportId,
          threadId: context.threadId,
          direction: 'inbound',
          fromAddress: 'newer@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'newer causal inbound',
          textBody: 'newer causal inbound confirmation CONF-NEWER',
          receivedAt: new Date('2026-09-07T12:02:00.000Z'),
          createdAt: new Date('2026-09-07T12:02:00.000Z'),
        },
        {
          id: clocklessOlderMessageId,
          transportId: context.transportId,
          threadId: context.threadId,
          direction: 'inbound',
          fromAddress: 'import@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'older imported inbound',
          textBody: 'older imported inbound confirmation CONF-OLDER',
          receivedAt: null,
          createdAt: new Date('2026-09-07T11:59:00.000Z'),
        },
      ]);

      const issued = await issueReadAdmissionFromMailbox({
        db,
        userId: CENTURION_USER_ID,
        transportId: context.transportId,
        threadId: context.threadId,
        toolId: 'hms_find_reservation',
        releaseId: 'release-red',
        requestBranchId: 'guest_stay_search',
        propertyCode: 'HRCEN',
        manifestSha256: READ_MANIFEST_SHA256,
        captureBindingRef: `u8-nullable-clock-${randomUUID()}`,
        now: new Date(observedAt),
      });

      const expectedCandidate = filterExactReservationCandidates(
        extractLookupCandidates('newer causal inbound confirmation CONF-NEWER'),
      )[0];
      expect(expectedCandidate).toBeDefined();
      expect(issued.triggerMessageId).toBe(newerMessageId);
      expect(issued.issuer.triggerMessageId).toBe(newerMessageId);
      expect(issued.candidateId).toBe(expectedCandidate?.id);
      expect(issued.triggerMessageId).not.toBe(clocklessOlderMessageId);
    });
  });

  it('creates a fresh read attempt after terminal failure and deduplicates concurrent retriggers', async () => {
    await withWorkerDb(async (db) => {
      const context = await seededMailContext(db);
      const firstInput = await readRunInput(context, 'terminal-retry-first');
      const first = await enqueueAiRun(firstInput, db);
      await db
        .update(aiWorkflowRun)
        .set({
          state: 'dead_letter',
          failureClass: 'POLICY_BLOCK',
          lastError: 'synthetic terminal read failure',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(aiWorkflowRun.id, first.id));

      const retryInput = await readRunInput(context, 'terminal-retry-second');
      retryInput.idempotencyKey = firstInput.idempotencyKey;
      const retry = await enqueueAiRun(retryInput, db);

      expect(retry.id).not.toBe(first.id);
      expect(retry.state).toBe('queued');
      expect(retry.readResultRef).toBe(retryInput.readResultRef);

      const concurrentInputs = await Promise.all([
        readRunInput(context, 'terminal-retry-concurrent-a'),
        readRunInput(context, 'terminal-retry-concurrent-b'),
      ]);
      concurrentInputs[0].idempotencyKey = firstInput.idempotencyKey;
      concurrentInputs[1].idempotencyKey = firstInput.idempotencyKey;
      const [concurrentA, concurrentB] = await Promise.all(
        concurrentInputs.map((input) => enqueueAiRun(input, db)),
      );

      expect(concurrentA.id).toBe(retry.id);
      expect(concurrentB.id).toBe(retry.id);
      const rows = await db
        .select({ id: aiWorkflowRun.id, state: aiWorkflowRun.state })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.threadId, context.threadId));
      expect(rows.filter((row) => row.id === first.id || row.id === retry.id)).toHaveLength(2);
      expect(rows.find((row) => row.id === first.id)?.state).toBe('dead_letter');
    });
  });

  it('reuses a nonterminal retry when terminal and active siblings tie on createdAt', async () => {
    await withWorkerDb(async (db) => {
      const context = await seededMailContext(db);
      const firstInput = await readRunInput(context, 'timestamp-tie-base');
      const first = await enqueueAiRun(firstInput, db);
      const tiedCreatedAt = new Date('2026-09-07T12:01:00.000Z');
      await db
        .update(aiWorkflowRun)
        .set({ state: 'dead_letter', updatedAt: tiedCreatedAt })
        .where(eq(aiWorkflowRun.id, first.id));

      const activeId = '00000000-0000-0000-0000-000000000001';
      const terminalId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      await db.insert(aiWorkflowRun).values([
        {
          ...first,
          id: activeId,
          idempotencyKey: `${firstInput.idempotencyKey}:attempt:active`,
          readResultRef: 'receipt-red-timestamp-tie-active',
          state: 'queued' as const,
          createdAt: tiedCreatedAt,
          updatedAt: tiedCreatedAt,
        },
        {
          ...first,
          id: terminalId,
          idempotencyKey: `${firstInput.idempotencyKey}:attempt:terminal`,
          readResultRef: 'receipt-red-timestamp-tie-terminal',
          state: 'dead_letter' as const,
          createdAt: tiedCreatedAt,
          updatedAt: tiedCreatedAt,
        },
      ]);

      const retryInput = await readRunInput(context, 'timestamp-tie-retrigger');
      retryInput.idempotencyKey = firstInput.idempotencyKey;
      const retry = await enqueueAiRun(retryInput, db);

      expect(retry.id).toBe(activeId);
      expect(retry.state).toBe('queued');
      const tiedRows = await db
        .select({
          id: aiWorkflowRun.id,
          idempotencyKey: aiWorkflowRun.idempotencyKey,
          readResultRef: aiWorkflowRun.readResultRef,
          state: aiWorkflowRun.state,
        })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.threadId, context.threadId));
      expect(
        tiedRows.filter((row) => row.idempotencyKey.startsWith(firstInput.idempotencyKey)),
      ).toHaveLength(3);
      expect(tiedRows).toContainEqual({
        id: first.id,
        idempotencyKey: firstInput.idempotencyKey,
        readResultRef: firstInput.readResultRef,
        state: 'dead_letter',
      });
      expect(tiedRows).toContainEqual({
        id: terminalId,
        idempotencyKey: `${firstInput.idempotencyKey}:attempt:terminal`,
        readResultRef: 'receipt-red-timestamp-tie-terminal',
        state: 'dead_letter',
      });
    });
  });

  it('deduplicates terminal-to-first-retry calls across independent DB sessions', async () => {
    await withIndependentReadRaceDb(
      async ({
        inspectDb,
        leftDb,
        rightDb,
        base,
        baseInput,
        leftInput,
        rightInput,
        transportId,
      }) => {
        await Promise.all([
          leftDb
            .select({ id: aiWorkflowRun.id })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, base.id)),
          rightDb
            .select({ id: aiWorkflowRun.id })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, base.id)),
        ]);

        let readyCount = 0;
        let release!: () => void;
        const bothReady = new Promise<void>((resolve) => {
          release = resolve;
        });
        const enqueueAfterBarrier = async (db: DB, input: typeof leftInput) => {
          readyCount += 1;
          if (readyCount === 2) release();
          await bothReady;
          return enqueueAiRun(input, db);
        };

        const [leftRetry, rightRetry] = await Promise.all([
          enqueueAfterBarrier(leftDb, leftInput),
          enqueueAfterBarrier(rightDb, rightInput),
        ]);

        expect(leftRetry.id).toBe(rightRetry.id);
        expect(leftRetry.state).toBe('queued');
        expect(leftRetry.readResultRef).toBe(rightRetry.readResultRef);
        expect([leftInput.readResultRef, rightInput.readResultRef]).toContain(
          leftRetry.readResultRef,
        );

        const rows = await inspectDb
          .select({
            id: aiWorkflowRun.id,
            idempotencyKey: aiWorkflowRun.idempotencyKey,
            readResultRef: aiWorkflowRun.readResultRef,
            state: aiWorkflowRun.state,
          })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.transportId, transportId));
        const logicalRows = rows.filter(
          (row) =>
            row.idempotencyKey === baseInput.idempotencyKey ||
            row.idempotencyKey.startsWith(`${baseInput.idempotencyKey}:attempt:`),
        );
        expect(logicalRows).toHaveLength(2);
        expect(logicalRows).toContainEqual({
          id: base.id,
          idempotencyKey: baseInput.idempotencyKey,
          readResultRef: baseInput.readResultRef,
          state: 'dead_letter',
        });
      },
    );
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
                requestBranches: [
                  { id: 'guest_stay_search', manifestSha256: READ_MANIFEST_SHA256 },
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
        if (findExecution.state !== 'succeeded') {
          const [failedRun] = await db
            .select({
              lastError: aiWorkflowRun.lastError,
              failureClass: aiWorkflowRun.failureClass,
            })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, find.runId))
            .limit(1);
          throw new Error(
            `find execution failed: ${failedRun?.failureClass ?? 'unknown'} ${failedRun?.lastError ?? 'no error'}`,
          );
        }
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

  it('binds identical read requests to each authorized mailbox access and preserves receipt guards', async () => {
    await withWorkerDb(async (db) => {
      await withReadOnlyWorkerEnv(async () => {
        const context = await seededMailContext(db);
        installActiveFindReleaseForTests();
        const firstCaller = createInjectedReadCaller(CENTURION_USER_ID, context.transportId);
        const secondCaller = createInjectedReadCaller(MARTHA_USER_ID, context.transportId);

        const [first, second] = await Promise.all([
          firstCaller.ai.enqueueHmsRead({ threadId: context.threadId }),
          secondCaller.ai.enqueueHmsRead({ threadId: context.threadId }),
        ]);

        expect(first.runId).not.toBe(second.runId);
        expect(first.readResultRef).not.toBe(second.readResultRef);
        const firstDuplicate = await firstCaller.ai.enqueueHmsRead({
          threadId: context.threadId,
        });
        expect(firstDuplicate.runId).toBe(first.runId);
        expect(firstDuplicate.readResultRef).toBe(first.readResultRef);

        const [firstRow, secondRow] = await Promise.all(
          [first.runId, second.runId].map(async (runId) => {
            const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
            return row;
          }),
        );
        expect(firstRow?.metrics).toMatchObject({
          readAdmissionIssuer: { userId: CENTURION_USER_ID },
        });
        expect(secondRow?.metrics).toMatchObject({
          readAdmissionIssuer: { userId: MARTHA_USER_ID },
        });

        await db
          .update(aiWorkflowRun)
          .set({
            state: 'succeeded',
            readResult: positiveFindResult,
            readResultExpiresAt: new Date('2099-09-07T12:05:00.000Z'),
          })
          .where(eq(aiWorkflowRun.id, first.runId));
        await db
          .update(aiWorkflowRun)
          .set({
            state: 'succeeded',
            readResult: positiveFindResult,
            readResultExpiresAt: new Date('2099-09-07T12:05:00.000Z'),
          })
          .where(eq(aiWorkflowRun.id, second.runId));

        await expect(
          firstCaller.ai.readHmsReceipt({
            threadId: context.threadId,
            readResultRef: first.readResultRef,
          }),
        ).resolves.toMatchObject({ result: { toolId: 'hms_find_reservation' } });
        await expect(
          secondCaller.ai.readHmsReceipt({
            threadId: context.threadId,
            readResultRef: second.readResultRef,
          }),
        ).resolves.toMatchObject({ result: { toolId: 'hms_find_reservation' } });
        await expect(
          secondCaller.ai.readHmsReceipt({
            threadId: context.threadId,
            readResultRef: first.readResultRef,
          }),
        ).rejects.toThrow(/READ_RECEIPT_NOT_FOUND/);
      });
    });
  });

  it('binds all ten normal read route families to each actor and receipt', async () => {
    await withWorkerDb(async (db) => {
      const context = await seededMailContext(db);
      const quoteContext = await seededMailContext(db);
      await db
        .update(message)
        .set({ subject: 'Quote request U8 I3', textBody: QUOTE_REQUEST_TEXT })
        .where(eq(message.id, quoteContext.triggerMessageId));
      const attachmentId = `u8-i3-attachment-${randomUUID()}`;
      const attachmentKey = `attachments/${context.triggerMessageId}/u8-i3-document.txt`;
      await db.insert(attachment).values({
        id: attachmentId,
        messageId: context.triggerMessageId,
        filename: 'u8-i3-document.txt',
        mimeType: 'text/plain',
        sizeBytes: 32,
        s3Key: attachmentKey,
      });
      const documentScope = {
        scopeRef: existingDocumentScopeRef({
          transportId: context.transportId,
          threadId: context.threadId,
          triggerMessageId: context.triggerMessageId,
        }),
        propertyRef: 'unknown',
        guestRef: null,
        stayStart: null,
        stayEnd: null,
        payerRef: null,
        requestedKind: null,
        requestedPriceVisibility: 'allowed' as const,
      };
      const documentRef = existingDocumentRefForRecord(
        mailAttachmentRecord({
          scope: documentScope,
          source: 'mail_attachment',
          attachmentId,
          authorizedAttachmentIds: new Set([attachmentId]),
          messageId: context.triggerMessageId,
          filename: 'u8-i3-document.txt',
          mimeType: 'text/plain',
          sizeBytes: 32,
          s3Key: attachmentKey,
          text: 'u8-i3-document.txt',
          observedAt,
        }),
      );

      installAllReadReleasesForTests();
      __setQuoteReferenceAuthorityLoaderForTests(syntheticQuoteReferenceAuthorityLoader());
      const actors = [
        {
          userId: CENTURION_USER_ID,
          caller: createInjectedReadCaller(CENTURION_USER_ID, context.transportId),
        },
        {
          userId: MARTHA_USER_ID,
          caller: createInjectedReadCaller(MARTHA_USER_ID, context.transportId),
        },
      ];
      const parents = await Promise.all(
        actors.map(async (actor) => {
          const parent = await actor.caller.ai.enqueueHmsRead({
            threadId: context.threadId,
            toolId: 'hms_find_reservation',
          });
          const contextRefs = {} as Record<LinkedContextReference['kind'], LinkedContextReference>;
          const contextIssuedAt = new Date();
          const contextExpiresAt = new Date(contextIssuedAt.getTime() + 4 * 60_000);
          for (const kind of ['company', 'group', 'event', 'notes'] as const) {
            contextRefs[kind] = mintLinkedContextReference({
              kind,
              sourceRef: `u8-i3-${kind}-source`,
              parentReadResultRef: parent.readResultRef,
              propertyCode: 'HRCEN',
              requestBranchId: 'guest_stay_search',
              sourceRevision: 'u8-i3-source',
              issuedAt: contextIssuedAt,
              expiresAt: contextExpiresAt,
            });
          }
          const [storedParent] = await db
            .select({ metrics: aiWorkflowRun.metrics })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, parent.runId));
          const metrics =
            storedParent?.metrics && typeof storedParent.metrics === 'object'
              ? storedParent.metrics
              : {};
          await db
            .update(aiWorkflowRun)
            .set({
              state: 'succeeded',
              readResult: positiveFindResult,
              readResultExpiresAt: new Date('2099-09-07T12:05:00.000Z'),
              metrics: { ...metrics, linkedContextReferences: Object.values(contextRefs) },
            })
            .where(eq(aiWorkflowRun.id, parent.runId));
          return { ...actor, parent, contextRefs };
        }),
      );

      type Actor = (typeof parents)[number];
      type EnqueuedRead = { runId: string; readResultRef: string };
      type RouteFamily = {
        toolId: string;
        threadId: string;
        enqueue: (actor: Actor) => Promise<EnqueuedRead>;
      };
      const families: RouteFamily[] = [
        {
          toolId: 'hms_find_reservation',
          threadId: context.threadId,
          enqueue: async (actor) => actor.parent,
        },
        {
          toolId: 'hms_quote_stay',
          threadId: quoteContext.threadId,
          enqueue: (actor) =>
            actor.caller.ai.enqueueHmsRead({
              threadId: quoteContext.threadId,
              toolId: 'hms_quote_stay',
              detail: 'detail',
            }),
        },
        {
          toolId: 'hms_read_reservation',
          threadId: context.threadId,
          enqueue: (actor) =>
            actor.caller.ai.enqueueHmsContextRead({
              threadId: context.threadId,
              findResultRef: actor.parent.readResultRef,
              sections: ['core'],
              detail: 'summary',
            }),
        },
        {
          toolId: 'hms_read_folio',
          threadId: context.threadId,
          enqueue: (actor) =>
            actor.caller.ai.enqueueHmsFolioRead({
              threadId: context.threadId,
              findResultRef: actor.parent.readResultRef,
              sections: ['balance'],
            }),
        },
        {
          toolId: 'hms_company_account_read',
          threadId: context.threadId,
          enqueue: (actor) =>
            actor.caller.ai.enqueueHmsCompanyRead({
              threadId: context.threadId,
              findResultRef: actor.parent.readResultRef,
              reservationRef: actor.contextRefs.company.reference,
            }),
        },
        {
          toolId: 'hms_group_block_read',
          threadId: context.threadId,
          enqueue: (actor) =>
            actor.caller.ai.enqueueHmsGroupRead({
              threadId: context.threadId,
              findResultRef: actor.parent.readResultRef,
              groupRef: actor.contextRefs.group.reference,
              sections: ['summary'],
            }),
        },
        {
          toolId: 'hms_event_read',
          threadId: context.threadId,
          enqueue: (actor) =>
            actor.caller.ai.enqueueHmsEventRead({
              threadId: context.threadId,
              findResultRef: actor.parent.readResultRef,
              eventRef: actor.contextRefs.event.reference,
            }),
        },
        {
          toolId: 'hms_read_notes_traces',
          threadId: context.threadId,
          enqueue: (actor) =>
            actor.caller.ai.enqueueHmsNotesRead({
              threadId: context.threadId,
              findResultRef: actor.parent.readResultRef,
              resourceRef: actor.contextRefs.notes.reference,
              states: ['open'],
              limit: 20,
              audience: 'staff',
            }),
        },
        {
          toolId: 'documents_list_existing',
          threadId: context.threadId,
          enqueue: (actor) =>
            actor.caller.ai.enqueueExistingDocumentList({
              threadId: context.threadId,
              source: 'mail_attachment',
              requestedPriceVisibility: 'allowed',
            }),
        },
        {
          toolId: 'documents_read_existing',
          threadId: context.threadId,
          enqueue: (actor) =>
            actor.caller.ai.enqueueExistingDocumentRead({
              threadId: context.threadId,
              documentRef,
              format: 'text',
            }),
        },
      ];
      expect(families.map((family) => family.toolId)).toEqual([
        'hms_find_reservation',
        'hms_quote_stay',
        'hms_read_reservation',
        'hms_read_folio',
        'hms_company_account_read',
        'hms_group_block_read',
        'hms_event_read',
        'hms_read_notes_traces',
        'documents_list_existing',
        'documents_read_existing',
      ]);

      for (const family of families) {
        const runs = await Promise.all(
          parents.map(async (actor) => ({ actor, run: await family.enqueue(actor) })),
        );
        expect(runs[0]!.run.runId).not.toBe(runs[1]!.run.runId);
        expect(runs[0]!.run.readResultRef).not.toBe(runs[1]!.run.readResultRef);

        for (const entry of runs) {
          const [stored] = await db
            .select({ metrics: aiWorkflowRun.metrics })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, entry.run.runId));
          const metrics =
            stored?.metrics && typeof stored.metrics === 'object'
              ? (stored.metrics as Record<string, unknown>)
              : {};
          expect(metrics.readAdmissionIssuer).toMatchObject({
            userId: entry.actor.userId,
            mailboxAccessId: `access-${entry.actor.userId}-${TRANSPORT_ID}`,
          });
          if (family.toolId !== 'hms_find_reservation') {
            await db
              .update(aiWorkflowRun)
              .set({
                state: 'succeeded',
                readResult: syntheticManualReadResult(family.toolId),
                readResultExpiresAt: new Date('2099-09-07T12:05:00.000Z'),
              })
              .where(eq(aiWorkflowRun.id, entry.run.runId));
          }
          await expect(
            entry.actor.caller.ai.readHmsReceipt({
              threadId: family.threadId,
              readResultRef: entry.run.readResultRef,
            }),
          ).resolves.toMatchObject({ result: { toolId: family.toolId } });
        }
        await expect(
          runs[1]!.actor.caller.ai.readHmsReceipt({
            threadId: family.threadId,
            readResultRef: runs[0]!.run.readResultRef,
          }),
        ).rejects.toThrow(/READ_RECEIPT_NOT_FOUND/);
      }
    });
  });

  it('runs all four U15 branches through the default session, queue, worker, and typed receipts', async () => {
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
                requestBranches: [
                  { id: 'guest_stay_search', manifestSha256: READ_MANIFEST_SHA256 },
                ],
              },
            ],
            [
              'hms_company_account_read',
              {
                releaseId: 'u15-company-release',
                toolId: 'hms_company_account_read',
                evidenceKind: 'hms',
                requestBranches: [
                  {
                    id: 'reservation_linked_company_billing',
                    manifestSha256: 'b'.repeat(64),
                  },
                ],
              },
            ],
            [
              'hms_group_block_read',
              {
                releaseId: 'u15-group-release',
                toolId: 'hms_group_block_read',
                evidenceKind: 'hms',
                toolVersion: '1.0.0',
                implementationSha256: GROUP_BLOCK_READ_IMPL_V1,
                runtimeFingerprintSha256: 'f'.repeat(64),
                privateDigestKeyVersion: 'v1',
                sourceRevision: 'u15-db',
                credentialVersionHmacSha256: 'g'.repeat(64),
                roleProofSha256: 'h'.repeat(64),
                requestBranches: [
                  {
                    id: 'group_block_list',
                    discoveryOperationId: 'group_block_list',
                    manifestSha256: GROUP_MANIFEST_SHA256,
                  },
                ],
              },
            ],
            [
              'hms_event_read',
              {
                releaseId: 'u15-event-release',
                toolId: 'hms_event_read',
                evidenceKind: 'hms',
                requestBranches: [{ id: 'event_list', manifestSha256: 'd'.repeat(64) }],
              },
            ],
            [
              'hms_read_notes_traces',
              {
                releaseId: 'u15-notes-release',
                toolId: 'hms_read_notes_traces',
                evidenceKind: 'hms',
                requestBranches: [{ id: 'notes_traces_list', manifestSha256: 'e'.repeat(64) }],
              },
            ],
          ]),
          predecessors: new Map(),
          toolIds: new Set([
            'hms_find_reservation',
            'hms_company_account_read',
            'hms_group_block_read',
            'hms_event_read',
            'hms_read_notes_traces',
          ]),
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
        const [routeCandidate] = filterExactReservationCandidates(
          extractLookupCandidates('U8 review fixture confirmation CONF-RED'),
        );
        const find = await caller.ai.enqueueHmsRead({ threadId: context.threadId });
        expect(find.candidateId).toBe(routeCandidate?.id);
        await claimNextAiRun({
          ownerId: 'u15-review-worker',
          lane: 'hms',
          runKind: 'read_tool',
          db,
        });
        expect(
          await executeAiRun(find.runId, {
            candidateSessionFactory: syntheticReadSessionFactory(async () =>
              syntheticMatchedRead('u15-parent-evidence', '2099-09-07T12:05:00.000Z'),
            ),
          }),
        ).toMatchObject({ state: 'succeeded' });

        const parentReceipt = await caller.ai.readHmsReceipt({
          threadId: context.threadId,
          readResultRef: find.readResultRef,
        });
        const publicLinkedContextRefs = parentReceipt.result.linkedContextRefs ?? [];
        expect(publicLinkedContextRefs).toHaveLength(4);
        for (const binding of publicLinkedContextRefs) {
          expect(Object.keys(binding).sort()).toEqual(['expiresAt', 'kind', 'reference']);
          expect(Date.parse(binding.expiresAt)).toBeGreaterThan(Date.now());
        }

        const [parentAfterFind] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, find.runId))
          .limit(1);
        if (!parentAfterFind) throw new Error('U15 parent run was not retained');
        const parentMetrics =
          parentAfterFind.metrics && typeof parentAfterFind.metrics === 'object'
            ? (parentAfterFind.metrics as Record<string, unknown>)
            : {};
        const linkedContextReferences = Array.isArray(parentMetrics.linkedContextReferences)
          ? parentMetrics.linkedContextReferences
              .map((value) => linkedContextReferenceSchema.safeParse(value))
              .filter(
                (value): value is { success: true; data: LinkedContextReference } => value.success,
              )
              .map((value) => value.data)
          : [];
        expect(linkedContextReferences).toHaveLength(4);
        for (const binding of linkedContextReferences) {
          expect(binding.parentReadResultRef).toBe(find.readResultRef);
          expect(binding.propertyCode).toBe('HRCEN');
          expect(binding.requestBranchId).toBe('guest_stay_search');
          expect(binding.sourceRef).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
        }
        const contextReferenceFor = (kind: 'company' | 'group' | 'event' | 'notes') => {
          const binding = publicLinkedContextRefs.find((value) => value.kind === kind);
          if (!binding) throw new Error(`missing synthetic ${kind} parent binding`);
          return binding.reference;
        };
        const companyContextReference = contextReferenceFor('company');
        const groupContextReference = contextReferenceFor('group');
        const eventContextReference = contextReferenceFor('event');
        const notesContextReference = contextReferenceFor('notes');

        const mutatedQueuedGroup = await caller.ai.enqueueHmsGroupRead({
          threadId: context.threadId,
          findResultRef: find.readResultRef,
          groupRef: groupContextReference,
          sections: ['summary'],
        });
        const [mutatedQueuedRow] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, mutatedQueuedGroup.runId))
          .limit(1);
        if (!mutatedQueuedRow) throw new Error('mutated queued group run was not retained');
        const mutatedRequest = mutatedQueuedRow.readRequest as Record<string, unknown>;
        const mutatedAdmission = mutatedRequest.admission as Record<string, unknown>;
        await db
          .update(aiWorkflowRun)
          .set({
            readRequest: {
              ...mutatedRequest,
              groupRef: companyContextReference,
              admission: {
                ...mutatedAdmission,
                reservationRef: companyContextReference,
                contextReference: {
                  ...(mutatedAdmission.contextReference as Record<string, unknown>),
                  reference: companyContextReference,
                },
              },
            },
          })
          .where(eq(aiWorkflowRun.id, mutatedQueuedGroup.runId));
        expect(
          await claimNextAiRun({
            ownerId: 'u15-review-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: mutatedQueuedGroup.runId });
        const openReadSession = vi.fn();
        const mutatedExecution = await executeAiRun(mutatedQueuedGroup.runId, {
          hmsRuntime: { openReadSession } as never,
        });
        expect(mutatedExecution.state).toBe('dead_letter');
        expect(openReadSession).not.toHaveBeenCalled();

        const syntheticGroupTransport = JSON.stringify({
          pageData: {
            grid: {
              GRIDRESULT: {
                GRID: {
                  DATA: [
                    {
                      groupbookingreferencenumber: 'GROUP-U15',
                      status: 'Tentative',
                      startdate: '01-SEP-2026',
                      enddate: '03-SEP-2026',
                      con: 11,
                    },
                  ],
                },
              },
            },
          },
        });
        const auditedGroup = await createAuditedGroupRuntime(syntheticGroupTransport);
        const dispatches = [
          {
            toolId: 'hms_company_account_read' as const,
            run: await caller.ai.enqueueHmsCompanyRead({
              threadId: context.threadId,
              findResultRef: find.readResultRef,
              reservationRef: companyContextReference,
            }),
            expected: {
              status: 'manual_required',
              data: {
                organizationRef: { state: 'unknown' },
                billingMode: { state: 'unknown' },
              },
            },
          },
          {
            toolId: 'hms_group_block_read' as const,
            run: await caller.ai.enqueueHmsGroupRead({
              threadId: context.threadId,
              findResultRef: find.readResultRef,
              groupRef: groupContextReference,
              sections: ['summary', 'blocks', 'delegates'],
            }),
            expected: {
              status: 'partial',
              data: {
                summary: {
                  state: 'available',
                  data: {
                    groupRef: { state: 'known', value: 'GROUP-U15' },
                    status: { state: 'known', value: 'tentative' },
                    startDate: { state: 'known', value: '2026-09-01' },
                    endDate: { state: 'known', value: '2026-09-03' },
                    releasePolicy: { state: 'unknown', reasonCode: 'SURFACE_UNPROVEN' },
                    billingRef: { state: 'unknown', reasonCode: 'SURFACE_UNPROVEN' },
                  },
                },
                blocks: { state: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
                delegates: { state: 'unavailable', reasonCode: 'SOURCE_UNAVAILABLE' },
              },
            },
          },
          {
            toolId: 'hms_event_read' as const,
            run: await caller.ai.enqueueHmsEventRead({
              threadId: context.threadId,
              findResultRef: find.readResultRef,
              eventRef: eventContextReference,
            }),
            expected: {
              status: 'manual_required',
              data: {
                source: { state: 'unknown' },
                depositAmount: { state: 'unknown' },
                depositReceived: { state: 'unknown' },
                depositDueDate: { state: 'unknown' },
              },
            },
          },
          {
            toolId: 'hms_read_notes_traces' as const,
            run: await caller.ai.enqueueHmsNotesRead({
              threadId: context.threadId,
              findResultRef: find.readResultRef,
              resourceRef: notesContextReference,
              states: ['open', 'completed'],
              limit: 20,
              audience: 'customer',
            }),
            expected: {
              status: 'manual_required',
              data: {
                notes: { state: 'unavailable', reasonCode: 'SOURCE_UNAVAILABLE' },
              },
            },
          },
        ];

        try {
          for (const dispatch of dispatches) {
            expect(dispatch.run.runState).toBe('queued');
            expect(
              await claimNextAiRun({
                ownerId: 'u15-review-worker',
                lane: 'hms',
                runKind: 'read_tool',
                db,
              }),
            ).toMatchObject({ id: dispatch.run.runId });
            const execution = await executeAiRun(dispatch.run.runId, {
              hmsRuntime:
                dispatch.toolId === 'hms_group_block_read' ? auditedGroup.runtime : ({} as never),
            });
            expect(execution.state, dispatch.toolId).toBe('succeeded');
            const receipt = await caller.ai.readHmsReceipt({
              threadId: context.threadId,
              readResultRef: dispatch.run.readResultRef,
            });
            expect(receipt.result).toMatchObject({
              toolId: dispatch.toolId,
              ...dispatch.expected,
            });
            if (dispatch.toolId === 'hms_group_block_read') {
              const evidence = receipt.result.evidence[0];
              expect(evidence).toMatchObject({
                sourceSystem: 'hms',
                sourceSurface: 'GSGRPB.LST',
                requestBranchId: 'group_block_list',
                scopeVerified: true,
                artifactRef: expect.any(String),
                manifestSha256: GROUP_MANIFEST_SHA256,
                sourceHash: expect.any(String),
              });
              expect(Date.parse(evidence.expiresAt)).toBeGreaterThan(Date.now());
            }
          }
        } finally {
          await auditedGroup.cleanup();
        }

        await expect(
          caller.ai.enqueueHmsEventRead({
            threadId: context.threadId,
            findResultRef: 'foreign-find-result',
            eventRef: 'EVENT-FOREIGN',
          }),
        ).rejects.toThrow(/parent|receipt|scope|provenance/i);
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
          const rows = await db
            .select({ id: aiWorkflowRun.id })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.threadId, context.threadId));
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
        const rows = await db
          .select({ id: aiWorkflowRun.id })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.threadId, context.threadId));
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
        const lockAcquisitionOptions: Array<{ signal?: AbortSignal; deadlineAt?: number }> = [];
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
              withLock: async (callback, acquisitionOptions) => {
                lockAcquisitionOptions.push(acquisitionOptions ?? {});
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
        const outerLockOptions = lockAcquisitionOptions.find(
          (options) => typeof options.deadlineAt === 'number',
        );
        expect(outerLockOptions?.signal).toBeDefined();
        expect(outerLockOptions?.deadlineAt).toEqual(expect.any(Number));
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

  it('cancels a waiting independent PG connection before the holder releases', async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('owned disposable TEST_DATABASE_URL is required');
    const firstLock = createPostgresPropertyReadLock({
      tenantId: 'tenant-u8-cancellation',
      propertyCode: 'HRCEN',
      databaseUrl,
    });
    const secondLock = createPostgresPropertyReadLock({
      tenantId: 'tenant-u8-cancellation',
      propertyCode: 'HRCEN',
      databaseUrl,
    });

    let releaseFirst = () => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst = false;
    const first = firstLock.withLock(async () => {
      enteredFirst = true;
      await firstEntered;
      return 'first';
    });
    while (!enteredFirst) await new Promise((resolve) => setTimeout(resolve, 5));

    const controller = new AbortController();
    let enteredSecond = false;
    const second = secondLock.withLock(
      async () => {
        enteredSecond = true;
        return 'second';
      },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort(new Error('read deadline expired'));
    const outcome = await Promise.race([
      second.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 250)),
    ]);

    try {
      expect(outcome).toBe('rejected');
      expect(enteredSecond).toBe(false);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
    }
  });
});
