import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { TRANSPORT_ID } from '../src/db/seed.js';

const reachable = await probeTestDb();
const here = dirname(fileURLToPath(import.meta.url));

describe('ai worker contract', () => {
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

  it('pm2 config adds hms-ai-worker on same worker entrypoint', async () => {
    const { loadPm2Config } = await import('../src/deploy/load-pm2-config.js');
    const pm2 = loadPm2Config();
    const hmsWorker = pm2.apps.find((app) => app.name === 'hms-ai-worker');
    expect(hmsWorker).toBeDefined();
    expect(hmsWorker?.script).toBe('dist/ai/worker.js');
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

  it('worker claims by AI_WORKER_LANE and builds AbortSignal budget fence', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/AI_WORKER_LANE/);
    expect(source).toMatch(/claimNextAiRun\(\{ ownerId: owner, lane \}/);
    expect(source).toMatch(/remainingRunBudgetMs/);
    expect(source).toMatch(/AbortSignal\.timeout/);
    expect(source).toMatch(/AbortSignal\.any/);
    expect(source).toMatch(/RunDeadlineError/);
    expect(source).toMatch(/lane === 'hms'/);
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
      promptVersion: 'triage-v4',
    });
    const result = await executeAiRun(run.id);
    expect(result.state).toBe('succeeded');
    const db = getDb();
    const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
    expect(row?.state).toBe('succeeded');
    expect(row?.mastraTraceId).toBeTruthy();
    expect(row?.metrics).toMatchObject({
      applyMode: 'skipped',
      usage: {
        totalTokens: expect.any(Number),
        estimatedCostUsd: expect.any(Number),
      },
    });
    const usage = (row?.metrics as { usage?: { totalTokens?: number } } | null)?.usage;
    expect(usage?.totalTokens).toBeGreaterThan(0);
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
          promptVersion: 'triage-v4',
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
          promptVersion: 'triage-v4',
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
          promptVersion: 'triage-v4',
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
          promptVersion: 'triage-v4',
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
          promptVersion: 'triage-v4',
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
          promptVersion: 'triage-v4',
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
          promptVersion: 'triage-v4',
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
});
