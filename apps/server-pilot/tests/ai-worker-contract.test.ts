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
  runAiWorkerOnce,
  renewAiRunLease,
  threadMessagesToTransportIndex,
} from '../src/ai/worker.js';
import { createLocalModelAdapter, type LocalModelRouteEvidence } from '../src/ai/bedrock/local.js';
import { classifyMailSource } from '../src/ai/mail-source.js';
import { __forceSendAtPastForTests, flushDue } from '../src/mail/send/outbound-queue.js';
import { FakeSmtpTransport, __setSmtpTransportForTests } from '../src/mail/send/smtp.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, __setDbForTests, type DB } from '../src/db/client.js';
import { resolveModelRoute } from '../src/ai/local-model-routing.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import { workItem } from '../src/db/schema/work.js';
import { resolveMailboxContext } from '../src/trpc/context.js';
import * as mastraModule from '../src/ai/mastra.js';
import { appRouter } from '../src/trpc/router.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';

const reachable = await probeTestDb();
const here = dirname(fileURLToPath(import.meta.url));
const requireFixture = createRequire(import.meta.url);

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
    __setSmtpTransportForTests(null);
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

  it('dispatches reply_check runs on the default lane', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/from '\.\/reply-check\.js'/);
    expect(source).toMatch(/run\.runKind === 'reply_check'/);
    expect(source).toMatch(/executeReplyCheckRun\(\{ run: runWithFence, fence, db \}\)/);
  });

  it('warms the Luna analyse cache fire-and-forget only after the live inbound run succeeds', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/from '\.\/quote-workflow-warmer\.js'/);
    const runOnce = source.match(/const executed = await executeAiRun\(claimed\.id[\s\S]*?\n  return true;\n\}/)?.[0];
    expect(runOnce).toBeDefined();
    expect(runOnce).toMatch(
      /isInboundTriageClassifierEnabled\(process\.env\)\s*\?\s*'inbound_triage'\s*:\s*'inbound_extraction';\s*if \(executed\.state === 'succeeded' && claimed\.runKind === inboundTriggerKind\) \{[\s\S]*?scheduleInboundTriageAnalyseWarm\(claimed\);/,
    );
    expect(runOnce).not.toMatch(/await scheduleInboundTriageAnalyseWarm/);
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
    expect(result.metrics).toMatchObject({
      fallback: true,
      modelOutputRejected: 'unbounded_prose',
    });
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
    // These committed compatibility fixtures intentionally use triage-v5;
    // current v6 is the default and v5 must remain explicit for the fixture.
    process.env.AI_TRIAGE_PROMPT_VERSION = 'triage-v5';
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

  it('routes marked channel mail deterministically without model, baseline, HMS, or work-item work', async () => {
    const previous = {
      writeGate: process.env.AI_WRITE_GATE_ENABLED,
      workflowTriage: process.env.WORKFLOW_TRIAGE_V6,
      classifier: process.env.INBOUND_TRIAGE_CLASSIFIER,
      extraction: process.env.INBOUND_EXTRACTION,
      warmer: process.env.LUNA_ANALYSE_WARMER,
      workerLane: process.env.AI_WORKER_LANE,
    };
    process.env.AI_WRITE_GATE_ENABLED = 'true';
    process.env.WORKFLOW_TRIAGE_V6 = 'false';
    process.env.INBOUND_TRIAGE_CLASSIFIER = 'on';
    process.env.INBOUND_EXTRACTION = 'on';
    process.env.LUNA_ANALYSE_WARMER = 'on';
    process.env.AI_WORKER_LANE = 'default';
    try {
      await withWorkerDb(async (db) => {
        const threadId = randomUUID();
        const messageId = randomUUID();
        const fromAddress = 'reservations@legacyhotels.co.za';
        const subject = 'FW: Expedia Partner Central - New reservation';
        const textBody =
          'Forwarded message:\nFrom: Expedia Partner Central <notice@m.expediapartnercentral.com>\nSubject: New reservation';
        const mailSourceDecision = classifyMailSource({ fromAddress, subject, bodyText: textBody });
        expect(mailSourceDecision.kind).toBe('channel');

        await db.insert(mailThread).values({
          id: threadId,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadId}@example.com>`,
          subject,
          snippet: 'Forwarded Expedia notice',
          latestMessageAt: new Date(),
        });
        await db.insert(message).values({
          id: messageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress,
          toAddresses: ['centurion@legacyhotels.co.za'],
          subject,
          textBody,
          receivedAt: new Date(),
        });
        const [existingPrimary] = await db
          .select({ id: mailCategory.id })
          .from(mailCategory)
          .where(and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'new-bookings')))
          .limit(1);
        expect(existingPrimary).toBeDefined();
        if (!existingPrimary) throw new Error('seeded new-bookings category is required');
        await db.insert(mailThreadCategory).values({
          threadId,
          categoryId: existingPrimary.id,
          transportId: TRANSPORT_ID,
        });
        const run = await enqueueAiRun(
          {
            transportId: TRANSPORT_ID,
            threadId,
            triggerMessageId: messageId,
            runKind: 'inbound_triage',
            idempotencyKey: `mail-source-worker:${messageId}`,
            modelId: 'amazon.nova-lite-v1:0',
            promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
            metrics: { mailSourceDecision },
          },
          db,
        );
        const routeFactory = vi.fn(() => {
          throw new Error('source-routed mail must not initialize baseline model routes');
        });
        const mastraFactory = vi.spyOn(mastraModule, 'createMastraRuntime');

        expect(
          await runAiWorkerOnce({
            transportId: TRANSPORT_ID,
            runKind: 'inbound_triage',
            mailBaselineExtractionRouteFactory: routeFactory,
          }),
        ).toBe(true);

        expect(routeFactory).not.toHaveBeenCalled();
        expect(mastraFactory).not.toHaveBeenCalled();
        const runs = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.threadId, threadId));
        expect(runs.map((row) => row.runKind)).toEqual(['inbound_triage']);
        expect(runs[0]?.id).toBe(run.id);
        expect(runs[0]?.metrics).toMatchObject({
          mailSourceDecision: {
            kind: 'channel',
            source: 'Expedia Partner Central',
            reason: 'forwarded_sender:m.expediapartnercentral.com',
          },
          deterministicMailSourceRoute: true,
          triageRationale: expect.stringContaining('Expedia Partner Central'),
          applyMode: 'full',
        });
        const folders = await db
          .select({ slug: mailCategory.slug })
          .from(mailThreadCategory)
          .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
          .where(eq(mailThreadCategory.threadId, threadId));
        expect(folders.map((row) => row.slug)).toEqual(['automated-channel']);
        expect(await db.select().from(workItem).where(eq(workItem.threadId, threadId))).toHaveLength(0);
      });
    } finally {
      if (previous.writeGate === undefined) delete process.env.AI_WRITE_GATE_ENABLED;
      else process.env.AI_WRITE_GATE_ENABLED = previous.writeGate;
      if (previous.workflowTriage === undefined) delete process.env.WORKFLOW_TRIAGE_V6;
      else process.env.WORKFLOW_TRIAGE_V6 = previous.workflowTriage;
      if (previous.classifier === undefined) delete process.env.INBOUND_TRIAGE_CLASSIFIER;
      else process.env.INBOUND_TRIAGE_CLASSIFIER = previous.classifier;
      if (previous.extraction === undefined) delete process.env.INBOUND_EXTRACTION;
      else process.env.INBOUND_EXTRACTION = previous.extraction;
      if (previous.warmer === undefined) delete process.env.LUNA_ANALYSE_WARMER;
      else process.env.LUNA_ANALYSE_WARMER = previous.warmer;
      if (previous.workerLane === undefined) delete process.env.AI_WORKER_LANE;
      else process.env.AI_WORKER_LANE = previous.workerLane;
    }
  }, 20_000);

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
      });
      expect(draft?.textBody).toContain(
        '[MISSING: reservation status | how: approved reservation read]',
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
        fallback: true,
        modelOutputRejected: 'unbounded_prose',
        provenance: expect.objectContaining({
          routeId: route.routeId,
          purpose: 'draft',
          usageSource: 'reported',
        }),
      });
      expect(JSON.stringify(row?.metrics)).not.toContain(unrelatedSubject);
    });
  });

  it('normal refresh composes the default worker with the configured draft route', async () => {
    const prior = {
      AI_DRAFTS_ENABLED: process.env.AI_DRAFTS_ENABLED,
      AI_MODEL_ROUTE: process.env.AI_MODEL_ROUTE,
      AI_WORKER_LANE: process.env.AI_WORKER_LANE,
      HMS_DRAFT_ENRICHMENT_MODE: process.env.HMS_DRAFT_ENRICHMENT_MODE,
    };
    process.env.AI_DRAFTS_ENABLED = 'true';
    process.env.AI_MODEL_ROUTE = 'approved-local';
    process.env.AI_WORKER_LANE = 'default';
    process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';

    try {
      await withWorkerDb(async (db) => {
        const threadId = randomUUID();
        const messageId = randomUUID();
        await db.insert(mailThread).values({
          id: threadId,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadId}@example.com>`,
          subject: 'Booking',
          snippet: 'Please confirm the reservation.',
          latestMessageAt: new Date(),
        });
        await db.insert(message).values({
          id: messageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'Please confirm the reservation.',
          receivedAt: new Date(),
        });

        const mailbox = await resolveMailboxContext('user-navaai', TRANSPORT_ID, db);
        const caller = appRouter.createCaller({
          auth: null as never,
          reqHeaders: new Headers(),
          sessionUser: { id: 'user-navaai', email: '', name: null },
          ...mailbox,
        });

        const route: LocalModelRouteEvidence = {
          routeId: 'u6-normal-draft-route',
          purpose: 'draft',
          protocol: 'in_process',
          access: 'current_app',
          egress: 'none',
          retention: 'bounded',
          usage: 'reported',
          modelId: 'u6-normal-draft-model',
        };
        let transportCalls = 0;
        const candidateDraftRouteFactory = () => ({
          route,
          transport: async () => {
            transportCalls += 1;
            return {
              output: {
                replyText:
                  'We will confirm this shortly. [MISSING: reservation status | how: approved reservation read]',
              },
              usage: { inputTokens: 5, outputTokens: 7, latencyMs: 1 },
            };
          },
        });

        const refresh = await caller.ai.refreshHmsCandidate({ threadId });
        const [queued] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, refresh.runId));
        expect(refresh.runState).toBe('queued');
        expect(queued?.executorLane).toBe('default');

        // This factory is the normal-worker composition seam; only its lower
        // in-process transport is synthetic. Do not bypass it with an adapter.
        const worked = await runAiWorkerOnce({
          candidateDraftRouteFactory,
        } as unknown as Parameters<typeof runAiWorkerOnce>[0]);

        expect(worked).toBe(true);
        expect(transportCalls).toBe(1);
        const [draft] = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
        expect(draft).toMatchObject({ status: 'candidate', origin: 'ai' });
        const [completed] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, refresh.runId));
        expect(completed?.state).toBe('succeeded');
        expect(completed?.metrics).toMatchObject({
          routeId: route.routeId,
          provenance: expect.objectContaining({ routeId: route.routeId, purpose: 'draft' }),
        });
      });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('normal configured factory persists the same server-owned release binding', async () => {
    const prior = {
      AI_DRAFTS_ENABLED: process.env.AI_DRAFTS_ENABLED,
      AI_MODEL_ROUTE: process.env.AI_MODEL_ROUTE,
      AI_WORKER_LANE: process.env.AI_WORKER_LANE,
      HMS_DRAFT_ENRICHMENT_MODE: process.env.HMS_DRAFT_ENRICHMENT_MODE,
      AI_APPROVED_LOCAL_DRAFT_CONFIG: process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG,
    };
    const route = {
      routeId: 'u6-configured-draft-route',
      purpose: 'draft' as const,
      protocol: 'in_process' as const,
      access: 'current_app' as const,
      egress: 'none' as const,
      retention: 'bounded' as const,
      usage: 'reported' as const,
      modelId: 'u6-configured-draft-model',
    };
    const release = {
      releaseId: 'u6-configured-release-a',
      releaseVersion: '2026.09.09.1',
      sourceRevision: 'source-configured-a',
      fingerprint: 'c'.repeat(64),
      purpose: 'draft' as const,
      capabilityFamilyVersions: { draft: 'u6-draft-v1' },
      issuedAt: '2026-09-09T10:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      withdrawn: false,
    };
    const fixturePath = join(here, 'fixtures', 'u6-approved-local-draft.cjs');
    const fixture = requireFixture(fixturePath) as {
      resetTransportCalls: () => void;
      getTransportCalls: () => number;
    };
    fixture.resetTransportCalls();
    process.env.AI_DRAFTS_ENABLED = 'true';
    process.env.AI_MODEL_ROUTE = 'approved-local';
    process.env.AI_WORKER_LANE = 'default';
    process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
    process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify({
      module: fixturePath,
      route,
      release,
    });

    try {
      await withWorkerDb(async (db) => {
        const threadId = randomUUID();
        const messageId = randomUUID();
        await db.insert(mailThread).values({
          id: threadId,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadId}@example.com>`,
          subject: 'Configured release',
          snippet: 'Please confirm the reservation.',
          latestMessageAt: new Date(),
        });
        await db.insert(message).values({
          id: messageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Configured release',
          textBody: 'Please confirm the reservation.',
          receivedAt: new Date(),
        });

        const mailbox = await resolveMailboxContext('user-navaai', TRANSPORT_ID, db);
        const caller = appRouter.createCaller({
          auth: null as never,
          reqHeaders: new Headers(),
          sessionUser: { id: 'user-navaai', email: '', name: null },
          ...mailbox,
        });
        const refresh = await caller.ai.refreshHmsCandidate({ threadId });
        expect(await runAiWorkerOnce()).toBe(true);
        expect(fixture.getTransportCalls()).toBe(1);

        const [draft] = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
        expect(draft).toMatchObject({ status: 'candidate', origin: 'ai' });
        const [completed] = await db
          .select({ metrics: aiWorkflowRun.metrics })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, refresh.runId));
        expect(completed?.metrics).toMatchObject({
          routeBinding: { ...route, release },
        });
      });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('does not reuse an A-generation body after a normal worker retry binds release B', async () => {
    const prior = {
      AI_DRAFTS_ENABLED: process.env.AI_DRAFTS_ENABLED,
      AI_MODEL_ROUTE: process.env.AI_MODEL_ROUTE,
      AI_WORKER_LANE: process.env.AI_WORKER_LANE,
      HMS_DRAFT_ENRICHMENT_MODE: process.env.HMS_DRAFT_ENRICHMENT_MODE,
      AI_APPROVED_LOCAL_DRAFT_CONFIG: process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG,
    };
    const route = {
      routeId: 'u6-configured-draft-route',
      purpose: 'draft' as const,
      protocol: 'in_process' as const,
      access: 'current_app' as const,
      egress: 'none' as const,
      retention: 'bounded' as const,
      usage: 'reported' as const,
      modelId: 'u6-configured-draft-model',
    };
    const releaseA = {
      releaseId: 'u6-a-to-b-release-a',
      releaseVersion: '2026.09.10.1',
      sourceRevision: 'u6-a-to-b-source-a',
      fingerprint: 'a'.repeat(64),
      purpose: 'draft' as const,
      capabilityFamilyVersions: { draft: 'u6-draft-v1' },
      issuedAt: '2026-09-09T10:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      withdrawn: false,
    };
    const releaseB = {
      ...releaseA,
      releaseId: 'u6-a-to-b-release-b',
      releaseVersion: '2026.09.10.2',
      sourceRevision: 'u6-a-to-b-source-b',
      fingerprint: 'b'.repeat(64),
      capabilityFamilyVersions: { draft: 'u6-draft-v2' },
    };
    const fixturePath = join(here, 'fixtures', 'u6-approved-local-draft.cjs');
    process.env.AI_DRAFTS_ENABLED = 'true';
    process.env.AI_MODEL_ROUTE = 'approved-local';
    process.env.AI_WORKER_LANE = 'default';
    process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
    process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify({
      module: fixturePath,
      route,
      release: releaseA,
    });

    try {
      await withWorkerDb(async (db) => {
        const threadId = randomUUID();
        const messageId = randomUUID();
        await db.insert(mailThread).values({
          id: threadId,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadId}@example.com>`,
          subject: 'A to B release retry',
          snippet: 'Please confirm the reservation.',
          latestMessageAt: new Date(),
        });
        await db.insert(message).values({
          id: messageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'A to B release retry',
          textBody: 'Please confirm the reservation.',
          receivedAt: new Date(),
        });

        const mailbox = await resolveMailboxContext('user-navaai', TRANSPORT_ID, db);
        const caller = appRouter.createCaller({
          auth: null as never,
          reqHeaders: new Headers(),
          sessionUser: { id: 'user-navaai', email: '', name: null },
          ...mailbox,
        });
        const first = await caller.ai.refreshHmsCandidate({ threadId });
        expect(await runAiWorkerOnce()).toBe(true);
        const [firstRun] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, first.runId));
        expect(firstRun?.state).toBe('succeeded');
        expect(firstRun?.generationId).toBeTruthy();

        const adopted = await caller.drafts.ensureEditableForReply({
          threadId,
          replyToMessageId: messageId,
        });
        await caller.drafts.update({
          id: adopted.id,
          subject: 'Re: A to B release retry',
          content: 'Body written under release A.',
          html: '<p>Body written under release A.</p>',
        });
        const revisionsBeforeRetry = await db
          .select()
          .from(mailDraftRevision)
          .where(eq(mailDraftRevision.draftId, adopted.id));

        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify({
          module: fixturePath,
          route,
          release: releaseB,
        });
        const second = await caller.ai.refreshHmsCandidate({ threadId });
        await db
          .update(aiWorkflowRun)
          .set({ generationId: firstRun!.generationId })
          .where(eq(aiWorkflowRun.id, second.runId));
        expect(await runAiWorkerOnce()).toBe(true);

        const [secondRun] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, second.runId));
        expect(secondRun?.generationId).toBe(firstRun?.generationId);
        expect(secondRun?.state).not.toBe('succeeded');
        expect(secondRun?.metrics).not.toMatchObject({
          routeBinding: { release: releaseB },
        });

        const [draft] = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
        expect(draft?.generationId).toBe(firstRun?.generationId);
        const revisions = await db
          .select()
          .from(mailDraftRevision)
          .where(eq(mailDraftRevision.draftId, draft!.id));
        expect(revisions).toHaveLength(revisionsBeforeRetry.length);
        await expect(
          caller.drafts.approve({
            draftId: adopted.id,
            subject: 'Re: A to B release retry',
            html: '<p>Body written under release A.</p>',
            text: 'Body written under release A.',
            to: ['guest@example.com'],
            cc: [],
            bcc: [],
            attachments: [],
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
      });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30000);

  it('normal refresh keeps unavailable or invalid configured routes manual-only', async () => {
    const prior = {
      AI_DRAFTS_ENABLED: process.env.AI_DRAFTS_ENABLED,
      AI_MODEL_ROUTE: process.env.AI_MODEL_ROUTE,
      AI_WORKER_LANE: process.env.AI_WORKER_LANE,
      HMS_DRAFT_ENRICHMENT_MODE: process.env.HMS_DRAFT_ENRICHMENT_MODE,
      AI_APPROVED_LOCAL_DRAFT_CONFIG: process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG,
    };
    process.env.AI_DRAFTS_ENABLED = 'true';
    process.env.AI_MODEL_ROUTE = 'approved-local';
    process.env.AI_WORKER_LANE = 'default';
    process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';

    const wrongPurposeDescriptor = JSON.stringify({
      module: 'node:missing-u6-draft-route-fixture',
      route: {
        routeId: 'u6-invalid-purpose-route',
        purpose: 'extraction',
        protocol: 'in_process',
        access: 'current_app',
        egress: 'none',
        retention: 'bounded',
        usage: 'reported',
        modelId: 'u6-invalid-purpose-model',
      },
    });
    const cases = [
      { name: 'missing', descriptor: undefined },
      { name: 'malformed', descriptor: '{' },
      { name: 'wrong-purpose', descriptor: wrongPurposeDescriptor },
    ] as const;

    try {
      await withWorkerDb(async (db) => {
        const observations: Array<{
          name: string;
          worked: boolean;
          draftCount: number;
          approvalRejected: boolean;
          metrics: Record<string, unknown> | null;
        }> = [];
        for (const testCase of cases) {
          if (testCase.descriptor === undefined) {
            delete process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG;
          } else {
            process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = testCase.descriptor;
          }
          const threadId = randomUUID();
          const messageId = randomUUID();
          await db.insert(mailThread).values({
            id: threadId,
            transportId: TRANSPORT_ID,
            threadRootId: `<${threadId}@example.com>`,
            subject: `Unavailable route ${testCase.name}`,
            snippet: 'Please confirm the reservation.',
            latestMessageAt: new Date(),
          });
          await db.insert(message).values({
            id: messageId,
            transportId: TRANSPORT_ID,
            threadId,
            direction: 'inbound',
            fromAddress: 'guest@example.com',
            toAddresses: ['nava@example.com'],
            subject: `Unavailable route ${testCase.name}`,
            textBody: 'Please confirm the reservation.',
            receivedAt: new Date(),
          });

          const mailbox = await resolveMailboxContext('user-navaai', TRANSPORT_ID, db);
          const caller = appRouter.createCaller({
            auth: null as never,
            reqHeaders: new Headers(),
            sessionUser: { id: 'user-navaai', email: '', name: null },
            ...mailbox,
          });
          const refresh = await caller.ai.refreshHmsCandidate({ threadId });
          const worked = await runAiWorkerOnce();
          const drafts = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
          const [run] = await db
            .select({ metrics: aiWorkflowRun.metrics })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, refresh.runId));
          let approvalRejected = false;
          if (drafts[0]) {
            const editable = await caller.drafts.ensureEditableForReply({
              threadId,
              replyToMessageId: messageId,
            });
            await expect(
              caller.drafts.approve({
                draftId: editable.id,
                subject: editable.subject ?? `Re: Unavailable route ${testCase.name}`,
                html: editable.message ?? 'Manual review required.',
                text: editable.message ?? 'Manual review required.',
                to: ['guest@example.com'],
                cc: [],
                bcc: [],
                attachments: [],
              }),
            ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
            approvalRejected = true;
          }
          observations.push({
            name: testCase.name,
            worked,
            draftCount: drafts.length,
            approvalRejected,
            metrics: (run?.metrics as Record<string, unknown> | null) ?? null,
          });
        }

        expect(observations).toEqual(
          cases.map(({ name }) => ({
            name,
            worked: true,
            draftCount: 1,
            approvalRejected: true,
            metrics: expect.objectContaining({
              modelRouteUnavailable: true,
              manualReview: true,
              modelRoutePurpose: 'draft',
            }),
          })),
        );
        for (const observation of observations) {
          expect(observation.metrics).not.toHaveProperty('routeId');
          expect(observation.metrics).not.toHaveProperty('routeBinding');
        }
      });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('carries the generated candidate through adopt, edit, approval, and fake SMTP', async () => {
    const prior = {
      AI_DRAFTS_ENABLED: process.env.AI_DRAFTS_ENABLED,
      AI_MODEL_ROUTE: process.env.AI_MODEL_ROUTE,
      AI_WORKER_LANE: process.env.AI_WORKER_LANE,
      HMS_DRAFT_ENRICHMENT_MODE: process.env.HMS_DRAFT_ENRICHMENT_MODE,
      AI_APPROVED_LOCAL_DRAFT_CONFIG: process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG,
      UNDO_SEND_SECONDS: process.env.UNDO_SEND_SECONDS,
      MAIL_SELF_BCC: process.env.MAIL_SELF_BCC,
    };
    process.env.AI_DRAFTS_ENABLED = 'true';
    process.env.AI_MODEL_ROUTE = 'approved-local';
    process.env.AI_WORKER_LANE = 'default';
    process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
    process.env.UNDO_SEND_SECONDS = '30';
    process.env.MAIL_SELF_BCC = 'false';

    try {
      await withWorkerDb(async (db) => {
        const threadId = randomUUID();
        const messageId = randomUUID();
        await db.insert(mailThread).values({
          id: threadId,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadId}@example.com>`,
          subject: 'Hello',
          snippet: 'Hello from the guest',
          latestMessageAt: new Date(),
        });
        await db.insert(message).values({
          id: messageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Hello',
          textBody: 'Hello from the guest',
          receivedAt: new Date(),
        });

        const mailbox = await resolveMailboxContext('user-navaai', TRANSPORT_ID, db);
        const caller = appRouter.createCaller({
          auth: null as never,
          reqHeaders: new Headers(),
          sessionUser: { id: 'user-navaai', email: '', name: null },
          ...mailbox,
        });
        const route = {
          routeId: 'u6-joined-draft-route',
          purpose: 'draft' as const,
          protocol: 'in_process' as const,
          access: 'current_app' as const,
          egress: 'none' as const,
          retention: 'bounded' as const,
          usage: 'reported' as const,
          modelId: 'u6-joined-draft-model',
        };
        const release = {
          releaseId: 'u6-joined-draft-release',
          releaseVersion: '2026.09.10.1',
          sourceRevision: 'u6-joined-draft-source',
          fingerprint: 'e'.repeat(64),
          purpose: 'draft' as const,
          capabilityFamilyVersions: { draft: 'u6-draft-v1' },
          issuedAt: '2026-09-09T10:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          withdrawn: false,
        };
        process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG = JSON.stringify({
          module: join(here, 'fixtures', 'u6-approved-local-draft.cjs'),
          route,
          release,
        });
        let transportCalls = 0;
        const candidateDraftRouteFactory = () => ({
          route,
          release,
          transport: async () => {
            transportCalls += 1;
            return {
              output: { replyText: 'Thanks for reaching out. We will follow up shortly.' },
              usage: { inputTokens: 4, outputTokens: 8, latencyMs: 1 },
            };
          },
        });

        const refresh = await caller.ai.refreshHmsCandidate({ threadId });
        expect(refresh.runState).toBe('queued');
        expect(
          await runAiWorkerOnce({
            candidateDraftRouteFactory,
          } as unknown as Parameters<typeof runAiWorkerOnce>[0]),
        ).toBe(true);
        expect(transportCalls).toBe(1);

        const [candidate] = await db
          .select()
          .from(mailDraft)
          .where(eq(mailDraft.threadId, threadId));
        expect(candidate).toMatchObject({ status: 'candidate', origin: 'ai' });
        const adopted = await caller.drafts.ensureEditableForReply({
          threadId,
          replyToMessageId: messageId,
        });
        expect(adopted.status).toBe('active');
        await caller.drafts.update({
          id: adopted.id,
          subject: 'Re: Hello',
          content: 'Edited by the reviewer',
          html: '<p>Edited by the reviewer</p>',
        });
        const approval = await caller.drafts.approve({
          draftId: adopted.id,
          subject: 'Re: Hello',
          html: '<p>Edited by the reviewer</p>',
          text: 'Edited by the reviewer',
          to: ['guest@example.com'],
          cc: [],
          bcc: [],
          attachments: [],
        });
        expect(approval).toMatchObject({
          routeBinding: expect.objectContaining({ routeId: route.routeId, purpose: 'draft' }),
        });

        const fake = new FakeSmtpTransport();
        __setSmtpTransportForTests(fake);
        const queued = await caller.mail.send({
          threadId,
          draftId: adopted.id,
          to: ['guest@example.com'],
          subject: 'Re: Hello',
          message: '<p>Edited by the reviewer</p>',
          text: 'Edited by the reviewer',
          draftApproval: approval,
        });
        expect(queued).toMatchObject({ queued: true });
        await __forceSendAtPastForTests(queued.messageId, TRANSPORT_ID, db);
        await expect(flushDue({ db })).resolves.toEqual({ flushed: 1 });
        expect(fake.sent).toHaveLength(1);
        const [sent] = await db
          .select({ status: mailDraft.status, isSent: mailDraft.isSent })
          .from(mailDraft)
          .where(eq(mailDraft.id, adopted.id));
        expect(sent).toEqual({ status: 'sent', isSent: true });
      });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 30000);

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
        primaryFolder: expect.any(String),
        isSpam: expect.any(Boolean),
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

  it('write and draft mode writes category without enqueuing a candidate draft', async () => {
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
      expect(draftRuns).toHaveLength(0);

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

  it('retry same triage still does not enqueue a candidate draft', async () => {
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
      expect(draftRuns).toHaveLength(0);
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

  it('new-bookings triage does not enqueue candidate draft when drafts enabled', async () => {
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
      expect(draftRuns).toHaveLength(0);
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
        textBody: 'Actually maybe a spam booking',
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
