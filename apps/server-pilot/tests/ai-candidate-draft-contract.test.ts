import {
  candidateDraftWorkflow,
  deriveReplySubject,
  deriveReplyToAddress,
} from '../src/ai/workflows/candidate-draft.js';
import {
  aiWorkflowRun,
  mailDraft,
  mailDraftRevision,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { prepareDraftInput } from '../src/ai/prepared-draft-input.js';
import { createMastraRuntime } from '../src/ai/mastra.js';
import { enqueueAiRun } from '../src/ai/run-ledger.js';
import { executeAiRun } from '../src/ai/worker.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const reachable = await probeTestDb();

describe('candidate draft workflow contract', () => {
  it('deriveReplyToAddress parses display name envelope', () => {
    expect(deriveReplyToAddress('Guest Person <guest@example.com>')).toBe('guest@example.com');
    expect(deriveReplyToAddress('not-an-email')).toBeNull();
  });

  it('deriveReplySubject preserves existing Re prefix', () => {
    expect(deriveReplySubject('Group booking')).toBe('Re: Group booking');
    expect(deriveReplySubject('Re: Group booking')).toBe('Re: Group booking');
  });

  it('candidateDraftWorkflow returns bracketed skeleton body', async () => {
    const mastra = createMastraRuntime(':memory:');
    const workflow = mastra.getWorkflow('candidateDraft');
    const workflowRun = await workflow.createRun();
    const result = await workflowRun.start({
      inputData: {
        transportId: TRANSPORT_ID,
        triggerMessageId: 'msg-1',
        replyToAddress: 'guest@example.com',
        subject: 'Group booking',
        prepared: prepareDraftInput({
          requestId: 'msg-1',
          threadId: 'thread-1',
          audience: 'guest',
          requestText: 'Need a room for next week',
        }),
      },
    });
    expect(result.status).toBe('success');
    expect(result.result?.draftBody.textBody).toContain('[');
    expect(result.result?.draftBody.textBody).toContain(']');
    expect(result.result?.draftBody.textBody.toLowerCase()).toContain('guest');
  });

  it('exports candidateDraftWorkflow from mastra runtime', () => {
    expect(candidateDraftWorkflow.id).toBe('candidate-draft');
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('candidate draft persistence contract', () => {
  it('skips candidate draft when inbound sender cannot be parsed', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'No sender',
        snippet: 'No sender',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: '',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'No sender',
        textBody: 'Please reply',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'candidate_draft',
          idempotencyKey: `candidate-draft:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'draft-v1',
        },
        db,
      );

      const result = await executeAiRun(run.id);
      expect(result.state).toBe('succeeded');

      const drafts = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
      expect(drafts).toHaveLength(0);

      const [updatedRun] = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, run.id));
      expect(updatedRun?.metrics).toMatchObject({
        skipped: true,
        reason: 'missing_reply_to_address',
      });
    });
  });

  it('persists code-derived recipient and subject with candidate draft revision', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Group booking',
        snippet: 'Need help',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'Guest Person <guest@example.com>',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'Group booking',
        textBody: 'Need a room',
        receivedAt: new Date(),
      });

      const run = await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'candidate_draft',
          idempotencyKey: `candidate-draft:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'draft-v1',
        },
        db,
      );

      const result = await executeAiRun(run.id);
      expect(result.state).toBe('succeeded');

      const drafts = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
      expect(drafts).toHaveLength(1);
      const draft = drafts[0]!;
      expect(draft.status).toBe('candidate');
      expect(draft.origin).toBe('ai');
      expect(draft.toAddresses).toEqual(['guest@example.com']);
      expect(draft.subject).toBe('Re: Group booking');
      expect(draft.textBody).toContain('[');
      expect(draft.textBody).toContain(']');

      const revisions = await db
        .select()
        .from(mailDraftRevision)
        .where(eq(mailDraftRevision.draftId, draft.id));
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.kind).toBe('ai_generated');
    });
  });
});
