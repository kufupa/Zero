import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
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
import { user as userAuthTable } from '../src/db/schema/auth.js';
import { enqueueAiRun, markAiRunRetry } from '../src/ai/run-ledger.js';
import { executeAiRun } from '../src/ai/worker.js';
import * as mastraModule from '../src/ai/mastra.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { TRANSPORT_ID } from '../src/db/seed.js';

const reachable = await probeTestDb();
const here = dirname(fileURLToPath(import.meta.url));

describe('ai worker contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AI_TRIAGE_PROMPT_VERSION;
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

  it('worker fences claimed-to-running with returning and scopes drain CLI', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/markAiRunRunning/);
    expect(source).toMatch(/--drain-prefix/);
    expect(source).toMatch(/--transport-id/);
    expect(source).toMatch(/--prompt-version/);
    expect(source).toMatch(/--timeout-ms/);
    expect(source).toMatch(/runAiWorkerDrain/);
    expect(source).toMatch(/unsupported prompt version/i);
    // CLI keeps drainPrefix at parse boundary; drain API uses idempotencyPrefix only.
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
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('ai worker db contract', () => {
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
      expectedStates: ['running'],
      attempts: 1,
      nextRunAt: new Date(),
      lastError: 'transient',
    });
    await db
      .update(aiWorkflowRun)
      .set({ state: 'claimed', generationId, updatedAt: new Date() })
      .where(eq(aiWorkflowRun.id, run.id));

    await executeAiRun(run.id);
    await executeAiRun(run.id);

    const drafts = await db.select().from(mailDraft).where(eq(mailDraft.generationId, generationId));
    const revisions = await db
      .select()
      .from(mailDraftRevision)
      .where(eq(mailDraftRevision.generationId, generationId));
    expect(drafts).toHaveLength(1);
    expect(revisions).toHaveLength(1);
  });

  it('shadow mode does not write categories or enqueue candidate draft', async () => {
    await withSeededTestDb(async (db) => {
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
    await withSeededTestDb(async (db) => {
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
    await withSeededTestDb(async (db) => {
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
    await withSeededTestDb(async (db) => {
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
    await withSeededTestDb(async (db) => {
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
    await withSeededTestDb(async (db) => {
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
    await withSeededTestDb(async (db) => {
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
