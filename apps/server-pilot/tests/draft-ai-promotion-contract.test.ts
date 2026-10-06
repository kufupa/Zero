import {
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { TRANSPORT_ID } from '../src/db/seed.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('AI draft promotion contract', () => {
  async function seedThread(db: DB) {
    const threadId = randomUUID();
    const parentMessageId = randomUUID();
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
    const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
    return { caller, threadId, parentMessageId };
  }

  it('returns existing active draft instead of promoting an AI candidate', async () => {
    await withSeededTestDb(async (db) => {
      const { caller, threadId, parentMessageId } = await seedThread(db);
      const activeDraftId = randomUUID();
      const candidateDraftId = randomUUID();
      const generationId = randomUUID();

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
        },
        {
          id: candidateDraftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'candidate',
          origin: 'ai',
          generationId,
          replyToMessageId: parentMessageId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'AI candidate',
        },
      ]);

      await expect(
        caller.drafts.ensureEditableForReply({ threadId, replyToMessageId: parentMessageId }),
      ).resolves.toMatchObject({
        id: activeDraftId,
        status: 'active',
        origin: 'manual',
      });

      const candidateRows = await db
        .select()
        .from(mailDraft)
        .where(eq(mailDraft.id, candidateDraftId));
      expect(candidateRows[0]?.status).toBe('candidate');
    });
  });

  it('promotes newest AI candidate for reply parent and discards older sibling candidates', async () => {
    await withSeededTestDb(async (db) => {
      const { caller, threadId, parentMessageId } = await seedThread(db);
      const olderDraftId = randomUUID();
      const newestDraftId = randomUUID();
      const olderGenerationId = randomUUID();
      const newestGenerationId = randomUUID();

      await db.insert(aiDraftGeneration).values([
        {
          id: olderGenerationId,
          transportId: TRANSPORT_ID,
          threadId,
          requestedByUserId: 'user-navaai',
          contextMessageIds: [parentMessageId],
          model: 'gpt-5.5',
          promptVersion: 'hotel-reply-v1',
          createdAt: new Date('2026-07-06T10:01:00Z'),
        },
        {
          id: newestGenerationId,
          transportId: TRANSPORT_ID,
          threadId,
          requestedByUserId: 'user-navaai',
          contextMessageIds: [parentMessageId],
          model: 'gpt-5.5',
          promptVersion: 'hotel-reply-v2',
          createdAt: new Date('2026-07-06T10:02:00Z'),
        },
      ]);
      await db.insert(mailDraft).values([
        {
          id: olderDraftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'candidate',
          origin: 'ai',
          generationId: olderGenerationId,
          replyToMessageId: parentMessageId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'Older AI candidate',
          updatedAt: new Date('2026-07-06T10:01:00Z'),
        },
        {
          id: newestDraftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'candidate',
          origin: 'ai',
          generationId: newestGenerationId,
          replyToMessageId: parentMessageId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'Newest AI candidate',
          updatedAt: new Date('2026-07-06T10:02:00Z'),
        },
      ]);

      const promoted = await caller.drafts.ensureEditableForReply({
        threadId,
        replyToMessageId: parentMessageId,
      });

      expect(promoted).toMatchObject({
        id: newestDraftId,
        status: 'active',
        origin: 'ai',
        generationId: newestGenerationId,
        content: 'Newest AI candidate',
      });

      const rows = await db
        .select()
        .from(mailDraft)
        .where(and(eq(mailDraft.transportId, TRANSPORT_ID), eq(mailDraft.threadId, threadId)));
      expect(rows.find((draft) => draft.id === olderDraftId)?.status).toBe('discarded');
      expect(rows.find((draft) => draft.id === newestDraftId)?.status).toBe('active');

      const revisions = await db.select().from(mailDraftRevision);
      expect(revisions).toContainEqual(
        expect.objectContaining({
          draftId: newestDraftId,
          generationId: newestGenerationId,
          kind: 'promoted',
          textBody: 'Newest AI candidate',
        }),
      );
    });
  });

  it('rejects AI promotion without a concrete reply parent', async () => {
    await withSeededTestDb(async (db) => {
      const { caller, threadId } = await seedThread(db);
      await expect(
        caller.drafts.ensureEditableForReply({ threadId, replyToMessageId: null }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_REQUIRED' });
    });
  });

  it('blocks stale HMS AI candidate promotion without mutation', async () => {
    await withSeededTestDb(async (db) => {
      const { caller, threadId, parentMessageId } = await seedThread(db);
      const generationId = randomUUID();
      const candidateDraftId = randomUUID();
      const threadStateVersion = 'stale-version-not-live';

      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'gpt-5.5',
        promptVersion: 'hotel-reply-v1',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [
          {
            kind: 'hms',
            id: 'ev-1',
            toolId: 'hms_quote_stay',
            toolVersion: '1',
            propertyCode: 'CEN',
            observedAt: '2026-07-06T10:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
            claimKeys: ['rate'],
            sourceHash: 'a'.repeat(64),
          },
        ],
      });
      await db.insert(mailDraft).values({
        id: candidateDraftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'candidate',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'HMS candidate',
      });

      await expect(
        caller.drafts.ensureEditableForReply({
          threadId,
          replyToMessageId: parentMessageId,
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'STALE_AI_CANDIDATE',
      });

      const candidateRows = await db
        .select()
        .from(mailDraft)
        .where(eq(mailDraft.id, candidateDraftId));
      expect(candidateRows[0]?.status).toBe('candidate');
    });
  });

  it('off-mode skeleton promotion keeps current behavior', async () => {
    await withSeededTestDb(async (db) => {
      const { caller, threadId, parentMessageId } = await seedThread(db);
      const generationId = randomUUID();
      const candidateDraftId = randomUUID();

      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'gpt-5.5',
        promptVersion: 'hotel-reply-v1',
      });
      await db.insert(mailDraft).values({
        id: candidateDraftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'candidate',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Skeleton candidate',
      });

      await expect(
        caller.drafts.ensureEditableForReply({
          threadId,
          replyToMessageId: parentMessageId,
        }),
      ).resolves.toMatchObject({
        id: candidateDraftId,
        status: 'active',
        origin: 'ai',
      });
    });
  });
});
