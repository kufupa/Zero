import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailDraft,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { workItem } from '../src/db/schema/work.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('thread draft contract', () => {
  it('chooses the latest analysis for the selected email even when an older draft was edited later', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID(), parentMessageId = randomUUID(), otherMessageId = randomUUID();
      const oldGeneration = randomUUID(), newGeneration = randomUUID();
      const oldRun = randomUUID(), newRun = randomUUID();
      await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`, subject: 'Booking', latestMessageAt: new Date('2026-07-06T10:00:00Z') });
      await db.insert(message).values([parentMessageId, otherMessageId].map(id => ({
        id, transportId: TRANSPORT_ID, threadId, direction: 'inbound' as const,
        fromAddress: 'guest@example.com', toAddresses: ['nava@example.com'], textBody: 'Need help',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      })));
      await db.insert(aiDraftGeneration).values([oldGeneration, newGeneration].map(id => ({
        id, transportId: TRANSPORT_ID, threadId, requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId], model: 'test', promptVersion: 'test',
      })));
      await db.insert(mailDraft).values([
        { id: randomUUID(), transportId: TRANSPORT_ID, threadId, createdByUserId: 'user-navaai',
          status: 'active', origin: 'ai', replyToMessageId: parentMessageId, generationId: oldGeneration,
          toAddresses: ['guest@example.com'], updatedAt: new Date('2026-07-06T11:00:00Z') },
        { id: randomUUID(), transportId: TRANSPORT_ID, threadId, createdByUserId: 'user-navaai',
          status: 'candidate', origin: 'ai', replyToMessageId: parentMessageId, generationId: newGeneration,
          toAddresses: ['guest@example.com'], updatedAt: new Date('2026-07-06T10:20:00Z') },
      ]);
      await db.insert(aiWorkflowRun).values([
        { id: oldRun, idempotencyKey: randomUUID(), transportId: TRANSPORT_ID, threadId,
          triggerMessageId: parentMessageId, generationId: oldGeneration, runKind: 'candidate_draft',
          modelId: 'test', promptVersion: 'test', state: 'succeeded', createdAt: new Date('2026-07-06T10:00:00Z'),
          metrics: { reservationistResult: { version: 1, readiness: 'needs_clarification', tasks: [{ id: 'old', kind: 'change' }] } } },
        { id: newRun, idempotencyKey: randomUUID(), transportId: TRANSPORT_ID, threadId,
          triggerMessageId: parentMessageId, generationId: newGeneration, runKind: 'candidate_draft',
          modelId: 'test', promptVersion: 'test', state: 'succeeded', createdAt: new Date('2026-07-06T10:10:00Z'),
          metrics: { reservationistResult: { version: 1, readiness: 'needs_clarification', tasks: [{ id: 'new', kind: 'question' }] } } },
      ]);
      const { drafts } = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
      expect(await drafts.reviewForMessage({ threadId, messageId: parentMessageId })).toMatchObject({
        replyToMessageId: parentMessageId, reviewSummary: { tasks: [{ label: 'Answer question' }] },
      });
      expect(await drafts.reviewForMessage({ threadId, messageId: otherMessageId })).toBeNull();
      // A newer no-action analysis produces no draft; do not resurrect the older review.
      const noActionGeneration = randomUUID();
      await db.insert(aiDraftGeneration).values({ id: noActionGeneration, transportId: TRANSPORT_ID, threadId,
        requestedByUserId: 'user-navaai', contextMessageIds: [parentMessageId], model: 'test', promptVersion: 'test' });
      await db.insert(aiWorkflowRun).values({ id: randomUUID(), idempotencyKey: randomUUID(), transportId: TRANSPORT_ID,
        threadId, triggerMessageId: parentMessageId, generationId: noActionGeneration, runKind: 'candidate_draft',
        modelId: 'test', promptVersion: 'test', state: 'succeeded', createdAt: new Date('2026-07-06T10:30:00Z') });
      expect(await drafts.reviewForMessage({ threadId, messageId: parentMessageId })).toBeNull();
      // A later no-action run must not hide earlier requests on an actual staff work item.
      const [item] = await db.insert(workItem).values({ transportId: TRANSPORT_ID, threadId,
        sourceMessageId: parentMessageId, kind: 'other' }).returning();
      const input = { threadId, messageId: parentMessageId, workItemId: item!.id };
      expect((await drafts.reviewForMessage(input))?.reviewSummary?.tasks).toMatchObject([
        { id: 'new', runId: newRun, label: 'Earlier request', handled: false },
        { id: 'old', runId: oldRun, label: 'Earlier request', handled: false },
      ]);
      await drafts.setRequestHandled({ workItemId: item!.id, runId: newRun, taskId: 'new', handled: true });
      expect((await drafts.reviewForMessage(input))?.reviewSummary?.tasks).toMatchObject([
        { id: 'old', runId: oldRun, handled: false },
      ]);
    });
  });

  it('returns plural visible drafts from mail.get without adding drafts to messages', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const activeDraftId = randomUUID();
      const candidateDraftId = randomUUID();
      const generationId = randomUUID();

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(message).values({
        id: parentMessageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Need help',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'gpt-5.5',
        promptVersion: 'hotel-reply-v1',
      });
      await db.insert(mailDraft).values([
        {
          id: activeDraftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'active',
          origin: 'manual',
          replyToMessageId: parentMessageId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'Human draft',
          // Pin order: drafts.list sorts by updatedAt desc, then id (random here).
          updatedAt: new Date('2026-07-06T10:05:00Z'),
        },
        {
          id: candidateDraftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'candidate',
          origin: 'ai',
          replyToMessageId: parentMessageId,
          generationId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'AI candidate',
          updatedAt: new Date('2026-07-06T10:00:00Z'),
        },
      ]);

      const { mail, drafts } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const thread = await mail.get({ id: threadId });
      expect(thread.messages).toHaveLength(1);
      expect(thread.messages.some((m) => m.isDraft)).toBe(false);
      expect(thread.drafts.map((draft) => draft.id)).toEqual([activeDraftId, candidateDraftId]);
      expect(thread.drafts[0]).toMatchObject({
        status: 'active',
        origin: 'manual',
        replyToMessageId: parentMessageId,
        isStale: false,
      });

      const listed = await drafts.list({ threadId, limit: 10 });
      expect(listed.threads.map((draft) => draft.id)).toEqual([activeDraftId, candidateDraftId]);

      const inbox = await mail.listThreads({ folder: 'inbox', limit: 50 });
      const row = inbox.threads.find((t) => t.id === threadId);
      expect(row?.hasDraft).toBe(true);
      expect(row?.draftCount).toBe(2);
    });
  });
});
