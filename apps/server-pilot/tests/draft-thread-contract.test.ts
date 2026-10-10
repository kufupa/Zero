import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  aiDraftGeneration,
  mailDraft,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('thread draft contract', () => {
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
