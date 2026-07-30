import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { persistAiCandidateDraft } from '../src/ai/drafts.js';
import { getDb } from '../src/db/client.js';
import {
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import { TEST_DB_AVAILABLE, probeTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('draft eval schema contract', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(mailDraftRevision);
    await db.delete(mailDraft);
    await db.delete(aiDraftGeneration);
    await db.delete(message);
    await db.delete(mailThread);
    await db.delete(mailboxTransport);
  });

  it('stores an AI candidate draft, generation context, and immutable initial revision', async () => {
    const db = getDb();
    const transportId = randomUUID();
    const threadId = randomUUID();
    const messageId = randomUUID();
    const draftId = randomUUID();
    const generationId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(mailboxTransport).values({
      id: transportId,
      email: 'nava@example.com',
      ownerHeaderValue: 'nava@example.com',
    });
    await db.insert(userAuthTable).values({
      id: 'user-1',
      name: 'User',
      email: 'user@example.com',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: '<root@example.com>',
      subject: 'Booking',
      snippet: 'Need help',
      latestMessageAt: new Date('2026-07-06T10:00:00Z'),
    });
    await db.insert(message).values({
      id: messageId,
      transportId,
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
      transportId,
      threadId,
      requestedByUserId: 'user-1',
      contextMessageIds: [messageId],
      model: 'gpt-5.5',
      promptVersion: 'hotel-reply-v1',
    });
    await db.insert(mailDraft).values({
      id: draftId,
      transportId,
      threadId,
      createdByUserId: 'user-1',
      status: 'candidate',
      origin: 'ai',
      replyToMessageId: messageId,
      generationId,
      toAddresses: ['guest@example.com'],
      subject: 'Re: Booking',
      textBody: 'AI draft reply',
      htmlBody: '<p>AI draft reply</p>',
    });
    await db.insert(mailDraftRevision).values({
      id: revisionId,
      draftId,
      generationId,
      kind: 'ai_generated',
      toAddresses: ['guest@example.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Re: Booking',
      textBody: 'AI draft reply',
      htmlBody: '<p>AI draft reply</p>',
      attachments: [],
    });

    const generationRows = await db.select().from(aiDraftGeneration);
    const draftRows = await db.select().from(mailDraft);
    const revisionRows = await db.select().from(mailDraftRevision);

    expect(generationRows[0]?.contextMessageIds).toEqual([messageId]);
    expect(generationRows[0]?.promptVersion).toBe('hotel-reply-v1');
    expect(draftRows[0]).toMatchObject({
      status: 'candidate',
      origin: 'ai',
      replyToMessageId: messageId,
      generationId,
    });
    expect(revisionRows[0]).toMatchObject({
      kind: 'ai_generated',
      generationId,
      textBody: 'AI draft reply',
    });
  });

  it('replays generation without creating duplicate candidate drafts', async () => {
    const db = getDb();
    const transportId = randomUUID();
    const threadId = randomUUID();
    const messageId = randomUUID();
    const generationId = randomUUID();

    await db.insert(mailboxTransport).values({
      id: transportId,
      email: 'replay@example.com',
      ownerHeaderValue: 'replay@example.com',
    });
    await db.insert(userAuthTable).values({
      id: 'user-1',
      name: 'User',
      email: 'user@example.com',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: '<root@example.com>',
      subject: 'Booking',
      snippet: 'Need help',
      latestMessageAt: new Date('2026-07-06T10:00:00Z'),
    });
    await db.insert(message).values({
      id: messageId,
      transportId,
      threadId,
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['replay@example.com'],
      subject: 'Booking',
      textBody: 'Need help',
      receivedAt: new Date('2026-07-06T10:00:00Z'),
    });

    const input = {
      db,
      transportId,
      threadId,
      replyToMessageId: messageId,
      createdByUserId: 'user-1',
      generationId,
      model: 'amazon.nova-lite-v1:0',
      promptVersion: 'draft-v1',
      contextMessageIds: [messageId],
      toAddresses: ['guest@example.com'],
      subject: 'Re: Booking',
      textBody: 'AI draft reply',
      htmlBody: '<p>AI draft reply</p>',
      persistDraft: true,
    };

    const first = await persistAiCandidateDraft(input);
    const second = await persistAiCandidateDraft(input);
    expect(second.id).toBe(first.id);

    const draftRows = await db.select().from(mailDraft).where(eq(mailDraft.generationId, generationId));
    const revisionRows = await db
      .select()
      .from(mailDraftRevision)
      .where(eq(mailDraftRevision.generationId, generationId));
    expect(draftRows).toHaveLength(1);
    expect(revisionRows).toHaveLength(1);
  });
});
