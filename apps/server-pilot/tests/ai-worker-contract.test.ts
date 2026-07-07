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
  mailDraft,
  mailDraftRevision,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import { enqueueAiRun, markAiRunRetry } from '../src/ai/run-ledger.js';
import { executeAiRun } from '../src/ai/worker.js';
import { TEST_DB_AVAILABLE, probeTestDb } from './helpers/test-db.js';

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
  });

  it('worker module does not import send-capable SMTP modules', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).not.toMatch(/mail\/send\/smtp/);
    expect(source).not.toMatch(/getSmtpTransport/);
    expect(source).not.toMatch(/pop3-client/);
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
      promptVersion: 'triage-v1',
    });
    const result = await executeAiRun(run.id);
    expect(result.state).toBe('succeeded');
    const db = getDb();
    const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
    expect(row?.state).toBe('succeeded');
    expect(row?.mastraTraceId).toBeTruthy();
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
});
