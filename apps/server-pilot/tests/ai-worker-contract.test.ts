import {
  DEFAULT_TRIAGE_PROMPT_VERSION,
  enqueueAiRun,
  claimNextAiRun,
  isSupportedInboundTriagePromptVersion,
  markAiRunRetry,
  resolveDeployedTriagePromptVersion,
} from '../src/ai/run-ledger.js';
import {
  aiWorkflowRun,
  aiDraftGeneration,
  mailCategory,
  mailDraft,
  mailDraftRevision,
  mailThread,
  mailThreadCategory,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import {
  aiWorkerOwnerId,
  executeAiRun,
  runPreparedWorkerCandidateReply,
  renewAiRunLease,
  threadMessagesToTransportIndex,
} from '../src/ai/worker.js';
import { createLocalModelAdapter, type LocalModelRouteEvidence } from '../src/ai/bedrock/local.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, __setDbForTests, type DB } from '../src/db/client.js';
import { resolveModelRoute } from '../src/ai/local-model-routing.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import * as mastraModule from '../src/ai/mastra.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';

const reachable = await probeTestDb();
const here = dirname(fileURLToPath(import.meta.url));

async function claimForExecute(runId: string, lane: 'default' | 'hms' = 'default') {
  const claimed = await claimNextAiRun({
    ownerId: aiWorkerOwnerId(lane),
    lane,
  });
  expect(claimed?.id).toBe(runId);
  return claimed!;
}

/**
 * Seed + run inside the rollback transaction AND point the worker's internal
 * `getDb()` at that same tx handle. `executeAiRun`/`claimNextAiRun` call
 * `getDb()` directly, so without this binding they'd open a separate committed
 * connection that cannot see the uncommitted tx rows. Same mechanism the tRPC
 * `callerFor` helper uses. Restores the cache on exit so committed-style tests
 * (which rely on the per-test TRUNCATE) are unaffected.
 */
async function withWorkerDb<T>(cb: (db: DB) => Promise<T>): Promise<T> {
  return withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    try {
      return await cb(db);
    } finally {
      __setDbForTests(null);
    }
  });
}

/** Committed tables the db-contract tests write; truncated per test for isolation. */
const WORKER_DB_TABLES = [
  'ai_workflow_run',
  'ai_draft_generation',
  'mail_thread_category',
  'mail_draft_revision',
  'mail_draft',
  'message',
  'mail_thread',
  'mail_category',
  'mailbox_transport',
] as const;
describe('ai worker contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AI_TRIAGE_PROMPT_VERSION;
  });

  it('new inbound triage defaults to v6 while explicit v5 compatibility stays opt-in', () => {
    expect(DEFAULT_TRIAGE_PROMPT_VERSION).toBe('triage-v6');
    expect(resolveDeployedTriagePromptVersion({})).toBe('triage-v6');
    expect(isSupportedInboundTriagePromptVersion('triage-v6', {})).toBe(true);
    expect(isSupportedInboundTriagePromptVersion('triage-v5', {})).toBe(false);
    expect(
      isSupportedInboundTriagePromptVersion('triage-v5', {
        AI_TRIAGE_PROMPT_VERSION: 'triage-v5',
      }),
    ).toBe(true);
    expect(
      isSupportedInboundTriagePromptVersion('triage-v4', {
        AI_TRIAGE_PROMPT_VERSION: 'triage-v5',
      }),
    ).toBe(false);

    const ingestStore = readFileSync(join(here, '..', 'src', 'mail', 'ingest', 'store.ts'), 'utf8');
    expect(ingestStore).toMatch(/promptVersion:\s*DEFAULT_TRIAGE_PROMPT_VERSION/);
  });

  it('pm2 config contains ai-worker without SMTP/POP3 secret env keys', async () => {
    const { loadPm2Config } = await import('../src/deploy/load-pm2-config.js');
    const pm2 = loadPm2Config();
    const aiWorker = pm2.apps.find((app) => app.name === 'ai-worker');
    expect(aiWorker).toBeDefined();
    const env = aiWorker?.env ?? {};
    const keys = Object.keys(env).map((key) => key.toUpperCase());
    expect(keys.some((key) => key.includes('SMTP'))).toBe(false);
    expect(keys.some((key) => key.includes('POP3'))).toBe(false);
    expect(env.AI_WORKER_LANE).toBe('default');
  });

  it('pm2 config adds hms-ai-worker via asm-exec worker entrypoint', async () => {
    const { loadPm2Config } = await import('../src/deploy/load-pm2-config.js');
    const pm2 = loadPm2Config();
    const hmsWorker = pm2.apps.find((app) => app.name === 'hms-ai-worker');
    expect(hmsWorker).toBeDefined();
    expect(hmsWorker?.script).toBe('/usr/local/bin/asm-exec');
    expect(hmsWorker?.instances).toBe(1);
    expect(hmsWorker?.exec_mode).toBe('fork');
    expect(hmsWorker?.env?.AI_WORKER_LANE).toBe('hms');
    expect(hmsWorker?.env?.HMS_DRAFT_ENRICHMENT_MODE).toBeDefined();
  });

  it('worker module does not import send-capable SMTP modules', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).not.toMatch(/mail\/send\/smtp/);
    expect(source).not.toMatch(/getSmtpTransport/);
    expect(source).not.toMatch(/pop3-client/);
  });

  it('worker loads causal timestamps and pins run model/prompt/asOf into triage', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/buildCausalTriageMessages/);
    expect(source).toMatch(/createdAt:\s*message\.createdAt/);
    expect(source).toMatch(/receivedAt:\s*message\.receivedAt/);
    expect(source).toMatch(/sentAt:\s*message\.sentAt/);
    expect(source).toMatch(/asOf:\s*run\.createdAt\.toISOString\(\)/);
    expect(source).toMatch(/modelId:\s*run\.modelId/);
    expect(source).toMatch(/promptVersion:\s*run\.promptVersion/);
    expect(source).not.toMatch(/AI_MODEL_ID/);
  });

  it('cuts the transport index at the trigger id for equal-createdAt rows', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/lt\(message\.createdAt/);
    expect(source).toMatch(/eq\(message\.createdAt/);
    expect(source).toMatch(/lte\(message\.id/);
    expect(source).toMatch(/trigger\?\.id \?\? run\.triggerMessageId/);
  });

  it('preserves transport-wide thread identity and RFC headers for Layer B metrics', () => {
    const rows = threadMessagesToTransportIndex([
      {
        id: 'msg-1',
        threadId: 'thread-1',
        fromAddress: 'guest@example.com',
        subject: 'Room enquiry',
        direction: 'inbound',
        createdAt: new Date('2026-09-01T10:00:00Z'),
        receivedAt: new Date('2026-09-01T10:00:00Z'),
        sentAt: null,
        toAddresses: ['centurion@legacyhotels.co.za'],
        ccAddresses: [],
        messageIdHeader: '<guest-1@example.com>',
        inReplyTo: '<hotel-1@legacyhotels.co.za>',
        references: ['<hotel-0@legacyhotels.co.za>', '<hotel-1@legacyhotels.co.za>'],
      },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        threadId: 'thread-1',
        messageIdHeader: '<guest-1@example.com>',
        inReplyTo: '<hotel-1@legacyhotels.co.za>',
        references: ['<hotel-0@legacyhotels.co.za>', '<hotel-1@legacyhotels.co.za>'],
      }),
    ]);
  });

  it('worker consumes v6 workflow output with thread signals and keeps draft AI disabled', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/TRIAGE_PROMPT_VERSION/);
    expect(source).toMatch(/validateWorkflowTriageOutput/);
    expect(source).toMatch(/threadSignals/);
    expect(source).toMatch(/reserveCloudStaffOutboundRecipients/);
    expect(source).not.toMatch(/candidate-draft:\$\{run\.triggerMessageId\}/);
    expect(source).not.toMatch(/MONEY_DRAFT_CATEGORIES/);
  });

  it('worker forces retag runs through full durable apply after dequeue', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/forceUnsettle:\s*run\.metrics\?\.retagPending\s*===\s*true/);
  });

  it('worker fences claimed-to-running with returning and scopes drain CLI', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/markAiRunRunning/);
    expect(source).toMatch(/--drain-prefix/);
    expect(source).toMatch(/--transport-id/);
    expect(source).toMatch(/--prompt-version/);
    expect(source).toMatch(/--timeout-ms/);
    expect(source).toMatch(/runAiWorkerDrain/);
    expect(source).toMatch(/unsupported prompt version/i);
    expect(source).toMatch(/idempotencyPrefix:\s*args\.drainPrefix/);
    expect(source).toMatch(/idempotencyPrefix:\s*input\.idempotencyPrefix/);
    expect(source).not.toMatch(/input\.drainPrefix/);
    expect(source).not.toMatch(/runAiWorkerDrain\(\{[\s\S]*?\bdrainPrefix\s*:/);
  });

  it('parseAiWorkerCliArgs reads drain scope flags', async () => {
    const { parseAiWorkerCliArgs } = await import('../src/ai/worker.js');
    expect(
      parseAiWorkerCliArgs([
        '--drain-prefix',
        'inbound-triage-retag-v5',
        '--transport-id',
        'transport-centurion',
        '--prompt-version',
        'triage-v5',
        '--timeout-ms',
        '120000',
      ]),
    ).toEqual({
      drainPrefix: 'inbound-triage-retag-v5',
      transportId: 'transport-centurion',
      promptVersion: 'triage-v5',
      timeoutMs: 120_000,
      runKind: 'inbound_triage',
    });
  });

  it('supersede script dry-run selects Centurion nonterminal triage and draft rows', async () => {
    const { parseSupersedeArgs, selectSupersedeTargets } = await import(
      '../scripts/supersede-centurion-ai-runs.mjs'
    );
    expect(parseSupersedeArgs([])).toMatchObject({ dryRun: true });
    expect(parseSupersedeArgs(['--apply'])).toMatchObject({ dryRun: false });
    const rows = [
      {
        id: '1',
        transportId: TRANSPORT_ID,
        runKind: 'inbound_triage',
        state: 'queued',
        promptVersion: 'triage-v5',
      },
      {
        id: '2',
        transportId: TRANSPORT_ID,
        runKind: 'candidate_draft',
        state: 'running',
        promptVersion: 'draft-v1',
      },
      {
        id: '3',
        transportId: TRANSPORT_ID,
        runKind: 'feedback_extraction',
        state: 'queued',
        promptVersion: 'feedback-v1',
      },
      {
        id: '4',
        transportId: 'transport-nava',
        runKind: 'inbound_triage',
        state: 'queued',
        promptVersion: 'triage-v5',
      },
      {
        id: '5',
        transportId: TRANSPORT_ID,
        runKind: 'inbound_triage',
        state: 'succeeded',
        promptVersion: 'triage-v5',
      },
    ];
    const selected = selectSupersedeTargets(rows);
    expect(selected.map((r) => r.id).sort()).toEqual(['1', '2']);
  });

  it('worker claims by AI_WORKER_LANE and builds AbortSignal budget fence', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/AI_WORKER_LANE/);
    expect(source).toMatch(/claimNextAiRun\(\{ ownerId: owner, lane/);
    expect(source).toMatch(/remainingRunBudgetMs/);
    expect(source).toMatch(/AbortSignal\.timeout/);
    expect(source).toMatch(/AbortSignal\.any/);
    expect(source).toMatch(/RunDeadlineError/);
    expect(source).toMatch(/lane === 'hms'|lane !== 'hms'/);
  });

  it('HMS shadow startup wires requireHmsWorkerRuntimeConfig fail-closed', async () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/requireHmsWorkerRuntimeConfig/);
    expect(source).toMatch(/assertHmsLaneRuntimeReady/);
    expect(source).toMatch(/maybeInitHmsRuntime/);
    expect(source).toMatch(/maybeInitHmsRuntime\(env\.AI_WORKER_LANE\)/);
    expect(source).toMatch(/maybeInitHmsRuntime\(lane\)/);

    const { assertHmsLaneRuntimeReady } = await import('../src/ai/worker.js');
    const base = {
      NODE_ENV: 'production',
      PORT: '8788',
      DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'nava-mail-artifacts-test',
      POP3_POLL_INTERVAL_MS: '30000',
      POP3_MAX_MESSAGES_PER_CYCLE: '500',
    };

    // Default lane + shadow: no require (must not throw on missing HMS secrets).
    expect(() =>
      assertHmsLaneRuntimeReady({
        ...base,
        AI_WORKER_LANE: 'default',
        HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
      }),
    ).not.toThrow();

    // HMS lane + off: secret-free.
    expect(() =>
      assertHmsLaneRuntimeReady({
        ...base,
        AI_WORKER_LANE: 'hms',
        HMS_DRAFT_ENRICHMENT_MODE: 'off',
      }),
    ).not.toThrow();

    // HMS lane + shadow without runtime fields: fail closed.
    expect(() =>
      assertHmsLaneRuntimeReady({
        ...base,
        AI_WORKER_LANE: 'hms',
        HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
      }),
    ).toThrow(/HMS_/);

    expect(() =>
      assertHmsLaneRuntimeReady({
        ...base,
        AI_WORKER_LANE: 'hms',
        HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
        HMS_READ_SECRET_ARN: 'arn:aws:secretsmanager:af-south-1:123:secret:hms-read',
        HMS_CHROMIUM_EXECUTABLE_PATH: '/opt/nava/chromium/chrome',
        HMS_READ_ROLE_PROOF_PATH: '/opt/nava/shared/hms-read-role-proof.v1.json',
        HMS_HEALTH_STATUS_PATH: '/tmp/nava-zero-hms-health.json',
        HMS_EXPECTED_TENANT: 'HMS_LEGACY',
        HMS_EXPECTED_PROPERTY_CODE: 'HRCEN',
        HMS_EXPECTED_TRANSPORT_ID: 'transport-centurion',
        HMS_EVIDENCE_HMAC_SECRET_ARN:
          'arn:aws:secretsmanager:af-south-1:123:secret:hms-evidence-hmac',
        HMS_EVIDENCE_HMAC_KEY_VERSION: 'evidence-key-v1',
      }),
    ).not.toThrow();

    expect(source).toMatch(/requireHmsEvidenceHmacChildKey/);
  });

  it('worker heartbeats lease and aborts on lost lease', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/heartbeatAiRun\(/);
    expect(source).toMatch(/setInterval/);
    expect(source).toMatch(/clearInterval/);
    expect(source).toMatch(/leaseAbort\.abort\(/);
    expect(source).toMatch(/finally/);
  });

  it('heartbeat rejection aborts the lease instead of becoming an unhandled rejection', async () => {
    const leaseAbort = new AbortController();
    await renewAiRunLease(
      {
        runId: 'run-heartbeat-rejection',
        claimOwner: 'owner',
        claimToken: 'token',
        deadlineAt: new Date(Date.now() + 60_000),
      },
      leaseAbort,
      async () => {
        throw new Error('database connection reset');
      },
    );
    expect(leaseAbort.signal.aborted).toBe(true);
  });

  it('running transition requires matching claimToken fence', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/markAiRunRunning\(/);
    expect(source).not.toMatch(/run\.claimToken\s*\?\?\s*randomUUID\(/);
  });

  it('worker branches candidate_draft on HMS_DRAFT_ENRICHMENT_MODE (off keeps skeleton)', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/HMS_DRAFT_ENRICHMENT_MODE/);
    expect(source).toMatch(/hmsMode === 'off'/);
    expect(source).toMatch(/runClaimSafeCandidateDraft/);
    expect(source).toMatch(/runPreparedWorkerCandidateReply/);
    expect(source).toMatch(/persistDraft/);
  });

  it('normal candidate writer prepares before workflow serialization and has no generic model path', () => {
    const worker = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    const workflow = readFileSync(
      join(here, '..', 'src', 'ai', 'workflows', 'candidate-draft.ts'),
      'utf8',
    );
    const offStart = worker.indexOf("if (hmsMode === 'off')");
    const shadowStart = worker.indexOf("if (run.executorLane === 'hms'", offStart);
    const offBlock = worker.slice(offStart, shadowStart);
    expect(offBlock).toMatch(/runPreparedWorkerCandidateReply/);
    expect(offBlock).toMatch(/candidateModelAdapter|modelAdapter/);
    expect(offBlock).toMatch(/replyAsks/);
    expect(offBlock).toMatch(/deadlineAt/);
    expect(offBlock).not.toMatch(/createMastraRuntime/);
    expect(offBlock).not.toMatch(/inputData:[\s\S]*body:\s*trigger\?/);
    expect(workflow).not.toMatch(/createModelAdapter/);
    expect(workflow).toMatch(/serializePreparedDraftInput/);
  });

  it('worker normal composition prepares before invoking the injected approved adapter', async () => {
    const route: LocalModelRouteEvidence = {
      routeId: 'worker-contract-route',
      purpose: 'draft',
      protocol: 'in_process',
      access: 'current_app',
      egress: 'none',
      retention: 'bounded',
      usage: 'reported',
      modelId: 'worker-contract-model',
    };
    let prompt = '';
    const adapter = createLocalModelAdapter({
      route,
      transport: async ({ userPrompt }) => {
        prompt = userPrompt;
        return {
          output: {
            replyText:
              'We cannot confirm this yet. [MISSING: reservation status | how: approved reservation read]',
          },
          usage: { inputTokens: 3, outputTokens: 4, latencyMs: 1 },
        };
      },
    });
    const result = await runPreparedWorkerCandidateReply({
      requestId: 'worker-contract-request',
      threadId: 'worker-contract-thread',
      requestText: 'Please confirm my reservation.',
      adapter,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000,
    });
    expect(prompt).toContain('u5-prepared-draft-input-v1');
    expect(prompt).toContain('worker-contract-request');
    expect(result.serializedInput).toContain('worker-contract-request');
    expect(result.metrics.fallback).toBe(false);
  });

  it('claim-safe path renders clarification templates and fences persist+succeed TX', () => {
    const worker = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(worker).toMatch(/renderClarificationQuestions/);
    expect(worker).toMatch(/textToSafeHtml/);
    expect(worker).not.toMatch(/questionCodes\.join/);
    expect(worker).toMatch(/persistAiCandidateDraft\(/);
    expect(worker).toMatch(/markAiRunSucceeded\(/);

    const drafts = readFileSync(join(here, '..', 'src', 'ai', 'drafts.ts'), 'utf8');
    expect(drafts).toMatch(/assertThreadStateVersionFresh/);
    expect(drafts).toMatch(/loadLiveThreadStateVersion/);
    expect(drafts).toMatch(/ThreadStateStaleError/);
  });

  it('HMS lane shadow uses finishHmsShadowRun + async live factory; never mock fallback', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/finishHmsShadowRun/);
    expect(source).toMatch(/failHmsShadowRun/);
    expect(source).toMatch(/createLiveHmsCandidateSessionFactory/);
    expect(source).toMatch(/CandidateSessionFactory/);
    expect(source).toMatch(
      /Promise<import\('\.\/candidate-draft-agent\.js'\)\.CandidateToolSession>/,
    );
    expect(source).toMatch(/HMS_DRAFT_ENRICHMENT_MODE === 'off'/);
    expect(source).toMatch(/executorLane === 'hms'/);
    expect(source).toMatch(/probeAttachmentIds:\s*\[\s*\]/);
    expect(source).toMatch(/resolvePlanScopedDraftGate/);
    expect(source).toMatch(/candidateBindings/);
    expect(source).toMatch(/requesterAuthorization/);
    // HMS shadow block must not call mock or draft persist
    const start = source.indexOf("run.executorLane === 'hms'");
    const end = source.indexOf('Non-HMS claim-safe path');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const hmsBlock = source.slice(start, end);
    expect(hmsBlock).not.toMatch(/createMockCandidateSession/);
    expect(hmsBlock).not.toMatch(/persistAiCandidateDraft/);
    expect(hmsBlock).toMatch(/resolveHmsShadowPreBrowser/);
    expect(hmsBlock).toMatch(/resolvePlanScopedDraftGate/);
  });

  it('hms-shadow module rejects drafts import (production-boundary contract)', async () => {
    const shadow = readFileSync(join(here, '..', 'src', 'ai', 'hms-shadow.ts'), 'utf8');
    expect(shadow).not.toMatch(/from ['"]\.\/drafts/);
    expect(shadow).not.toMatch(/persistAiCandidateDraft\s*\(/);
    expect(shadow).toMatch(/hmsShadowMetricsSchema/);
    const { hmsShadowMetricsSchema } = await import('../src/ai/hms-shadow.js');
    expect(() =>
      hmsShadowMetricsSchema.parse({
        outcome: 'candidate',
        toolCalls: 0,
        toolBudgetUsed: 0,
        claimCount: 0,
        rawEvidence: { guest: 'nope' },
      }),
    ).toThrow();
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('ai worker db contract', () => {
  beforeEach(async () => {
    // Committed seedInbound tests never roll back; clear leftover rows (incl.
    // stale queued runs) so claimNextAiRun's oldest-in-lane pick is this test's
    // own run. Also wipes cross-run pollution from prior invocations.
    __setDbForTests(null);
    await getDb().execute(
      sql.raw(`TRUNCATE ${WORKER_DB_TABLES.join(', ')} RESTART IDENTITY CASCADE`),
    );
  });

  async function seedInbound() {
    const db = getDb();
    const transportId = randomUUID();
    const threadId = randomUUID();
    const messageId = randomUUID();
    await db.insert(mailboxTransport).values({
      id: transportId,
      email: `nava-${transportId.slice(0, 8)}@example.com`,
      ownerHeaderValue: `nava-${transportId.slice(0, 8)}@example.com`,
    });
    await db
      .insert(userAuthTable)
      .values({
        id: 'user-1',
        name: 'User',
        email: 'user@example.com',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: `<root-${threadId}@example.com>`,
      subject: 'Booking',
      snippet: 'Need help',
      latestMessageAt: new Date(),
    });
    await db.insert(message).values({
      id: messageId,
      transportId,
      threadId,
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['nava@example.com'],
      subject: 'Booking',
      textBody: 'Need a room tonight',
      receivedAt: new Date(),
    });
    return { transportId, threadId, messageId };
  }

  it('claims a candidate run and persists the assessed prepared reply from the approved route', async () => {
    await withWorkerDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      const unrelatedSubject = 'unrelated-secret-subject credential-token=never-serialize';
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: unrelatedSubject,
        snippet: 'Please confirm my reservation.',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'Guest Person <guest@example.com>',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: unrelatedSubject,
        textBody: 'Please confirm my reservation.',
        receivedAt: new Date(),
      });

      const route: LocalModelRouteEvidence = {
        routeId: 'u5-worker-positive-route',
        purpose: 'draft',
        protocol: 'in_process',
        access: 'current_app',
        egress: 'none',
        retention: 'bounded',
        usage: 'reported',
        modelId: 'u5-worker-positive-model',
      };
      let transportCalls = 0;
      let receivedPrompt = '';
      let receivedSignal: AbortSignal | undefined;
      const adapter = createLocalModelAdapter({
        route,
        transport: async (request) => {
          transportCalls += 1;
          receivedPrompt = request.userPrompt;
          receivedSignal = request.signal;
          return {
            output: {
              replyText:
                'We cannot confirm this yet. [MISSING: reservation status | how: approved reservation read]',
            },
            usage: { inputTokens: 11, outputTokens: 13, latencyMs: 2 },
          };
        },
      });

      const run = await enqueueAiRun({
        transportId: TRANSPORT_ID,
        threadId,
        triggerMessageId: messageId,
        runKind: 'candidate_draft',
        idempotencyKey: `worker-positive-prepared-reply:${messageId}`,
        modelId: route.modelId,
        promptVersion: 'draft-v1',
      });
      await claimForExecute(run.id);

      const result = await executeAiRun(run.id, {
        candidateReplyModelAdapter: adapter,
      });

      expect(result.state).toBe('succeeded');
      expect(transportCalls).toBe(1);
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);
      expect(receivedPrompt).toContain('u5-prepared-draft-input-v1');
      expect(receivedPrompt).toContain('Please confirm my reservation.');
      expect(receivedPrompt).not.toContain(unrelatedSubject);

      const [draft] = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
      expect(draft).toMatchObject({
        status: 'candidate',
        origin: 'ai',
        toAddresses: ['guest@example.com'],
        subject: `Re: ${unrelatedSubject}`,
        textBody:
          'We cannot confirm this yet. [MISSING: reservation status | how: approved reservation read]',
      });
      expect(draft?.textBody).toBe(
        'We cannot confirm this yet. [MISSING: reservation status | how: approved reservation read]',
      );

      const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(row?.state).toBe('succeeded');
      expect(row?.generationId).toBeTruthy();
      expect(row?.metrics).toMatchObject({
        hmsMode: 'off',
        preparedReplyOutcome: 'clarification',
        preparedReplyAssessment: [],
        preparedInputSerializedBytes: expect.any(Number),
        routeId: route.routeId,
        usageSource: 'reported',
        fallback: false,
        provenance: expect.objectContaining({
          routeId: route.routeId,
          purpose: 'draft',
          usageSource: 'reported',
        }),
      });
      expect(JSON.stringify(row?.metrics)).not.toContain(unrelatedSubject);
    });
  });

  it('returns manual review before transport initialization when the approved route is unavailable', async () => {
    let transportCalls = 0;
    expect(() =>
      resolveModelRoute({
        purpose: 'draft',
        transport: async () => {
          transportCalls += 1;
          return {
            output: {},
            usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
          };
        },
      }),
    ).toThrow(/route unavailable/i);
    expect(transportCalls).toBe(0);

    const result = await runPreparedWorkerCandidateReply({
      requestId: 'worker-unavailable-route',
      threadId: 'worker-unavailable-thread',
      requestText: 'Please confirm my reservation.',
      signal: new AbortController().signal,
    });

    expect(result.metrics).toMatchObject({
      fallback: true,
      modelRouteUnavailable: true,
      modelRoutePurpose: 'draft',
      manualReview: true,
    });
    expect(result.textBody).toContain('[MISSING: reservation status');
  });

  it('refuses a purpose-mismatched route before transport initialization', () => {
    let transportCalls = 0;
    const route: LocalModelRouteEvidence = {
      routeId: 'u5-worker-mismatched-route',
      purpose: 'extraction',
      protocol: 'in_process',
      access: 'current_app',
      egress: 'none',
      retention: 'bounded',
      usage: 'reported',
      modelId: 'u5-worker-mismatched-model',
    };

    expect(() =>
      resolveModelRoute({
        purpose: 'draft',
        route,
        transport: async () => {
          transportCalls += 1;
          return {
            output: {},
            usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
          };
        },
      }),
    ).toThrow(/purpose mismatch/i);
    expect(transportCalls).toBe(0);
  });

  it('claims queued run and marks it succeeded', async () => {
    const { transportId, threadId, messageId } = await seedInbound();
    const run = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `worker-success:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v5',
    });
    await claimForExecute(run.id);
    const result = await executeAiRun(run.id);
    expect(result.state).toBe('succeeded');
    const db = getDb();
    const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
    expect(row?.state).toBe('succeeded');
    expect(row?.mastraTraceId).toBeTruthy();
    expect(row?.metrics).toMatchObject({
      applyMode: 'skipped',
      modelId: 'amazon.nova-lite-v1:0',
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      rawOutput: expect.objectContaining({
        category: expect.any(String),
        rationale: expect.any(String),
        policyFlags: expect.any(Array),
      }),
      rationale: expect.any(String),
      policyFlags: expect.any(Array),
      usage: {
        totalTokens: expect.any(Number),
        estimatedCostUsd: expect.any(Number),
      },
    });
    const usage = (row?.metrics as { usage?: { totalTokens?: number } } | null)?.usage;
    expect(usage?.totalTokens).toBeGreaterThan(0);
    expect(JSON.stringify(row?.metrics)).not.toMatch(/Need a room tonight/);
  });

  it('retry does not duplicate candidate draft', async () => {
    const { transportId, threadId, messageId } = await seedInbound();
    const generationId = randomUUID();
    const db = getDb();
    const run = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'candidate_draft',
      idempotencyKey: `worker-draft:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'draft-v1',
    });
    await db.insert(aiDraftGeneration).values({
      id: generationId,
      transportId,
      threadId,
      requestedByUserId: 'user-1',
      contextMessageIds: [messageId],
      model: 'amazon.nova-lite-v1:0',
      promptVersion: 'draft-v1',
    });
    await markAiRunRetry({
      runId: run.id,
      claimOwner: 'worker-a',
      claimToken: 'token-a',
      expectedStates: ['running'],
      attempts: 1,
      nextRunAt: new Date(),
      lastError: 'transient',
      failureClass: 'TRANSIENT_NETWORK',
    });
    const claimToken = randomUUID();
    const claimOwner = aiWorkerOwnerId('default');
    await db
      .update(aiWorkflowRun)
      .set({
        state: 'claimed',
        generationId,
        claimOwner,
        claimToken,
        deadlineAt: new Date(Date.now() + 150_000),
        updatedAt: new Date(),
      })
      .where(eq(aiWorkflowRun.id, run.id));

    await executeAiRun(run.id);
    await executeAiRun(run.id);

    const drafts = await db
      .select()
      .from(mailDraft)
      .where(eq(mailDraft.generationId, generationId));
    const revisions = await db
      .select()
      .from(mailDraftRevision)
      .where(eq(mailDraftRevision.generationId, generationId));
    expect(drafts).toHaveLength(1);
    expect(revisions).toHaveLength(1);
  });

  it('shadow mode does not write categories or enqueue candidate draft', async () => {
    await withWorkerDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'Booking',
        textBody: 'Need a room tonight',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `triage-shadow:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'triage-v5',
        },
        db,
      );

      process.env.AI_WRITE_GATE_ENABLED = 'false';
      process.env.AI_DRAFTS_ENABLED = 'false';
      await claimForExecute(run.id);
      const result = await executeAiRun(run.id);
      expect(result.state).toBe('succeeded');

      const memberships = await db
        .select()
        .from(mailThreadCategory)
        .where(eq(mailThreadCategory.threadId, threadId));
      expect(memberships).toHaveLength(0);

      const draftRuns = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, `candidate-draft:${messageId}`));
      expect(draftRuns).toHaveLength(0);

      const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(row?.metrics).toMatchObject({
        applyMode: 'skipped',
        durableWrite: false,
        modelId: 'amazon.nova-lite-v1:0',
        promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        usage: {
          totalTokens: expect.any(Number),
          estimatedCostUsd: expect.any(Number),
        },
      });
    });
  });

  it('write and draft mode writes category and enqueues one candidate draft', async () => {
    await withWorkerDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'Booking',
        textBody: 'Need a room tonight',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `triage-write:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'triage-v5',
        },
        db,
      );

      process.env.AI_WRITE_GATE_ENABLED = 'true';
      process.env.AI_DRAFTS_ENABLED = 'true';
      await claimForExecute(run.id);
      const result = await executeAiRun(run.id);
      expect(result.state).toBe('succeeded');

      const memberships = await db
        .select({ slug: mailCategory.slug })
        .from(mailThreadCategory)
        .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
        .where(eq(mailThreadCategory.threadId, threadId));
      expect(memberships.map((row) => row.slug)).toContain('new-bookings');

      const draftRuns = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, `candidate-draft:${messageId}`));
      expect(draftRuns).toHaveLength(1);

      const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(row?.metrics).toMatchObject({
        applyMode: 'full',
        durableWrite: true,
        usage: {
          totalTokens: expect.any(Number),
          estimatedCostUsd: expect.any(Number),
        },
      });
    });
  });

  it('retry same triage still enqueues only one candidate draft', async () => {
    await withWorkerDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'Booking',
        textBody: 'Need a room tonight',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `triage-retry:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'triage-v5',
        },
        db,
      );

      process.env.AI_WRITE_GATE_ENABLED = 'true';
      process.env.AI_DRAFTS_ENABLED = 'true';
      await claimForExecute(run.id);
      await executeAiRun(run.id);
      await executeAiRun(run.id);

      const draftRuns = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, `candidate-draft:${messageId}`));
      expect(draftRuns).toHaveLength(1);
    });
  });

  it('spam triage sets spamAt and does not enqueue candidate draft', async () => {
    await withWorkerDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Win a prize',
        snippet: 'spam',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'spam@example.com',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'Win a prize',
        textBody: 'click here spam offer',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `triage-spam:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'triage-v5',
        },
        db,
      );

      process.env.AI_WRITE_GATE_ENABLED = 'true';
      process.env.AI_DRAFTS_ENABLED = 'true';
      await claimForExecute(run.id);
      const result = await executeAiRun(run.id);
      expect(result.state).toBe('succeeded');

      const [thread] = await db.select().from(mailThread).where(eq(mailThread.id, threadId));
      expect(thread?.spamAt).not.toBeNull();

      const draftRuns = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, `candidate-draft:${messageId}`));
      expect(draftRuns).toHaveLength(0);
    });
  });

  it('ops triage does not enqueue candidate draft when drafts enabled', async () => {
    await withWorkerDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Banqueting handover',
        snippet: 'handover',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'gm@legacyhotels.co.za',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'Banqueting handover',
        textBody: 'banqueting handover tomorrow with room readiness list',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `triage-ops:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'triage-v5',
        },
        db,
      );

      process.env.AI_WRITE_GATE_ENABLED = 'true';
      process.env.AI_DRAFTS_ENABLED = 'true';
      await claimForExecute(run.id);
      const result = await executeAiRun(run.id);
      expect(result.state).toBe('succeeded');

      const draftRuns = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, `candidate-draft:${messageId}`));
      expect(draftRuns).toHaveLength(0);
    });
  });

  it('new-bookings triage enqueues candidate draft when drafts enabled', async () => {
    await withWorkerDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'Booking',
        textBody: 'Need a room tonight',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `triage-new-bookings:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'triage-v5',
        },
        db,
      );

      process.env.AI_WRITE_GATE_ENABLED = 'true';
      process.env.AI_DRAFTS_ENABLED = 'true';
      await claimForExecute(run.id);
      const result = await executeAiRun(run.id);
      expect(result.state).toBe('succeeded');

      const draftRuns = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, `candidate-draft:${messageId}`));
      expect(draftRuns).toHaveLength(1);
    });
  });

  it('does not enqueue candidate draft when thread already has spamAt', async () => {
    await withWorkerDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Suspicious mail',
        snippet: 'Already spam',
        spamAt: new Date(),
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'Suspicious mail',
        textBody: 'Actually maybe a booking',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `triage-existing-spam:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'triage-v5',
        },
        db,
      );

      process.env.AI_WRITE_GATE_ENABLED = 'true';
      process.env.AI_DRAFTS_ENABLED = 'true';
      await claimForExecute(run.id);
      const result = await executeAiRun(run.id);
      expect(result.state).toBe('succeeded');

      const [thread] = await db.select().from(mailThread).where(eq(mailThread.id, threadId));
      expect(thread?.spamAt).not.toBeNull();

      const draftRuns = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, `candidate-draft:${messageId}`));
      expect(draftRuns).toHaveLength(0);
    });
  });

  it('zero-row running transition causes no model call', async () => {
    const { transportId, threadId, messageId } = await seedInbound();
    const run = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `worker-fence-lost:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v5',
    });
    const db = getDb();
    await db
      .update(aiWorkflowRun)
      .set({
        state: 'succeeded',
        claimOwner: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aiWorkflowRun.id, run.id));

    const spy = vi.spyOn(mastraModule, 'createMastraRuntime');
    const result = await executeAiRun(run.id);
    expect(spy).not.toHaveBeenCalled();
    expect(result.state).toBe('dead_letter');
    const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
    expect(row?.state).toBe('succeeded');
    expect(row?.mastraTraceId).toBeNull();
  });

  it('unsupported prompt version dead-letters immediately without model call', async () => {
    process.env.AI_TRIAGE_PROMPT_VERSION = 'triage-v5';
    const { transportId, threadId, messageId } = await seedInbound();
    const run = await enqueueAiRun({
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `worker-unsupported-v4:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v4',
    });
    await claimForExecute(run.id);

    const spy = vi.spyOn(mastraModule, 'createMastraRuntime');
    const result = await executeAiRun(run.id);
    expect(result.state).toBe('dead_letter');
    expect(spy).not.toHaveBeenCalled();

    const db = getDb();
    const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
    expect(row?.state).toBe('dead_letter');
    expect(row?.lastError).toMatch(/unsupported prompt version/i);
    expect(row?.lastError).toMatch(/triage-v4/);
  });

  it('scoped drain leaves unrelated queued row untouched and times out on future retry-wait', async () => {
    const scoped = await seedInbound();
    const other = await seedInbound();
    const prefix = `inbound-triage-retag-v5-${randomUUID().slice(0, 8)}`;

    const retryRun = await enqueueAiRun({
      transportId: scoped.transportId,
      threadId: scoped.threadId,
      triggerMessageId: scoped.messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `${prefix}:${scoped.messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v5',
    });
    await enqueueAiRun({
      transportId: other.transportId,
      threadId: other.threadId,
      triggerMessageId: other.messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `inbound-triage:${other.messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v5',
    });

    const db = getDb();
    await db
      .update(aiWorkflowRun)
      .set({
        state: 'retry_wait',
        nextRunAt: new Date(Date.now() + 60 * 60_000),
        claimOwner: null,
        updatedAt: new Date(),
      })
      .where(eq(aiWorkflowRun.id, retryRun.id));

    const { runAiWorkerDrain } = await import('../src/ai/worker.js');
    const drain = await runAiWorkerDrain({
      idempotencyPrefix: prefix,
      transportId: scoped.transportId,
      promptVersion: 'triage-v5',
      runKind: 'inbound_triage',
      timeoutMs: 200,
      pollIntervalMs: 50,
    });
    expect(drain.ok).toBe(false);
    expect(drain.reason).toBe('timeout');
    expect(drain.remainingNonterminal).toBeGreaterThan(0);

    const [untouched] = await db
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.idempotencyKey, `inbound-triage:${other.messageId}`));
    expect(untouched?.state).toBe('queued');
    expect(untouched?.claimOwner).toBeNull();

    const [stillWaiting] = await db
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.id, retryRun.id));
    expect(stillWaiting?.state).toBe('retry_wait');
  });
});

describe('Task 5 HMS live proof CLI (DB-free)', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('hms-live-proof accepts canary/start/status/stop/rearm and rejects lookup argv', () => {
    const source = readFileSync(join(here, '..', 'src', 'ops', 'hms-live-proof.ts'), 'utf8');
    expect(source).toMatch(/action === 'canary'/);
    expect(source).toMatch(/action === 'start'/);
    expect(source).toMatch(/action === 'status'/);
    expect(source).toMatch(/action === 'stop'/);
    expect(source).toMatch(/action === 'rearm'/);
    expect(source).toMatch(/HMS_SHADOW_REARMED/);
    expect(source).toMatch(/assertNoLookupArgv/);
    expect(source).toMatch(/confirmation|external|thread|message|candidate/);
    expect(source).toMatch(/new OperatorExit\(3/);
    expect(source).toMatch(/new OperatorExit\(10/);
    expect(source).toMatch(/new OperatorExit\(20/);
    expect(source).toMatch(/HMS_WAIT/);
    expect(source).toMatch(/ROLLBACK_INCOMPLETE/);
    expect(source).toMatch(/HmsOperatorFailCode|OPERATOR_FAIL_CODES/);
  });

  it('status validates build/deps/manifest/fingerprint/role/health/TTL/deltas', () => {
    const source = readFileSync(join(here, '..', 'src', 'ops', 'hms-live-proof.ts'), 'utf8');
    expect(source).toMatch(/NAVA_BUILD_COMMIT|buildCommit|runningProcessCommit/);
    expect(source).toMatch(/playwright-1\.52\.0-chromium-1169/);
    expect(source).toMatch(/manifestSha256/);
    expect(source).toMatch(/rowFingerprintSha256/);
    expect(source).toMatch(/roleProofSha256/);
    expect(source).toMatch(/expiresAt|proof TTL|PROOF_TTL|24\s*\*\s*60|86400000/i);
    expect(source).toMatch(/forbiddenRowDelta/);
    expect(source).toMatch(/policyBlockDelta/);
    expect(source).toMatch(/HEALTH_STALE|health/);
    expect(source).toMatch(/HMS_SHADOW_VERIFIED|HMS_OFF_READY/);
  });

  it('start isolates proofAttemptId and refuses nonterminal HMS runs', () => {
    const source = readFileSync(join(here, '..', 'src', 'ops', 'hms-live-proof.ts'), 'utf8');
    expect(source).toMatch(/proofAttemptId/);
    expect(source).toMatch(/randomUUID/);
    expect(source).toMatch(/hms-proof:/);
    expect(source).toMatch(/executorLane:\s*'hms'|executorLane === 'hms'/);
    expect(source).toMatch(/generationId:\s*null|generationId === null/);
    expect(source).toMatch(/idempotencyPrefix|AI_WORKER_IDEMPOTENCY_PREFIX/);
    expect(source).toMatch(/RUN_ISOLATION_BLOCKED/);
    expect(source).toMatch(/selectOldestExact|oldest/);
    expect(source).toMatch(/forbiddenRowDelta|aiDraftGeneration|mailDraft/);
    expect(source).toMatch(/HMS_SHADOW_OK/);
    expect(source).toMatch(/HmsReservationCanaryProofV1|canary-proof|canaryProof/);
    expect(source).toMatch(/mode ['"]0600['"]|0o600|mode: 0o600/);
  });

  it('stop dead-letters proof runs, deletes HMS PM2, emits HMS_ROLLBACK_OK', () => {
    const source = readFileSync(join(here, '..', 'src', 'ops', 'hms-live-proof.ts'), 'utf8');
    expect(source).toMatch(/HMS_ROLLBACK_OK/);
    expect(source).toMatch(/dead_letter|markAiRunDeadLetter|dead-letter/i);
    expect(source).toMatch(/pm2 delete hms-ai-worker|hms-ai-worker/);
    expect(source).toMatch(/ROLLBACK_INCOMPLETE/);
    expect(source).toMatch(/hms-shadow-disabled|disable.*start|preventStarts|setStartsDisabled/i);
  });

  it('worker loop honors AI_WORKER_IDEMPOTENCY_PREFIX for proof isolation', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/AI_WORKER_IDEMPOTENCY_PREFIX/);
    expect(source).toMatch(/idempotencyPrefix/);
  });

  it('pm2 hms-ai-worker autorestart is false', async () => {
    const { loadPm2Config } = await import('../src/deploy/load-pm2-config.js');
    const pm2 = loadPm2Config();
    const hms = pm2.apps.find((app) => app.name === 'hms-ai-worker');
    expect(hms?.autorestart).toBe(false);
    expect(
      hms?.max_restarts === undefined || hms?.max_restarts === 0 || hms?.autorestart === false,
    ).toBe(true);
  });
});
