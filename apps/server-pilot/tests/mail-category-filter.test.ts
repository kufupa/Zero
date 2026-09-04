import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  mailCategory,
  mailDraft,
  mailThread,
  mailThreadCategory,
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

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('mail.listThreads category and system filters', () => {
  it('filters by multi-select categories and unread state, then hydrates draft counts', async () => {
    await withSeededTestDb(async (db) => {
      const travelId = randomUUID();
      const urgentId = randomUUID();
      const matchingThreadId = randomUUID();
      const otherThreadId = randomUUID();
      const draftId = randomUUID();
      const parentMessageId = randomUUID();

      await db.insert(mailCategory).values([
        { id: travelId, transportId: TRANSPORT_ID, slug: `travel-${travelId.slice(0, 8)}`, name: 'Travel Agents', sortOrder: 10 },
        { id: urgentId, transportId: TRANSPORT_ID, slug: `urgent-${urgentId.slice(0, 8)}`, name: 'Urgent', sortOrder: 20 },
      ]);
      await db.insert(mailThread).values([
        {
          id: matchingThreadId,
          transportId: TRANSPORT_ID,
          threadRootId: `<${matchingThreadId}@example.com>`,
          subject: 'VIP airport transfer',
          snippet: 'Travel agent needs answer',
          isRead: false,
          latestMessageAt: new Date('2026-07-06T10:00:00Z'),
        },
        {
          id: otherThreadId,
          transportId: TRANSPORT_ID,
          threadRootId: `<${otherThreadId}@example.com>`,
          subject: 'Breakfast',
          snippet: 'Restaurant booking',
          isRead: false,
          latestMessageAt: new Date('2026-07-06T09:00:00Z'),
        },
      ]);
      await db.insert(message).values({
        id: parentMessageId,
        transportId: TRANSPORT_ID,
        threadId: matchingThreadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'VIP airport transfer',
        textBody: 'Travel agent needs answer',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(mailThreadCategory).values([
        { threadId: matchingThreadId, categoryId: travelId, transportId: TRANSPORT_ID },
        { threadId: matchingThreadId, categoryId: urgentId, transportId: TRANSPORT_ID },
      ]);
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId: matchingThreadId,
        createdByUserId: 'user-navaai',
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        status: 'active',
        origin: 'manual',
        subject: 'Re: VIP airport transfer',
      });

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const result = await mail.listThreads({
        folder: 'all',
        filters: { unread: true, categoryIds: [travelId] },
        limit: 20,
      });

      expect(result.threads.map((t) => t.id)).toEqual([matchingThreadId]);
      expect(result.threads[0]?.categoryIds).toEqual(expect.arrayContaining([travelId, urgentId]));
      expect(result.threads[0]?.hasDraft).toBe(true);
      expect(result.threads[0]?.draftCount).toBe(1);
    });
  });

  it('lists categorized thread via seeded groups-events category slug filter', async () => {
    await withSeededTestDb(async (db) => {
      const [groupCategory] = await db
        .select()
        .from(mailCategory)
        .where(and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'groups-events')))
        .limit(1);
      expect(groupCategory).toBeDefined();

      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Group quote for 20 rooms',
        snippet: 'Need 20 rooms',
        isRead: false,
        latestMessageAt: new Date('2026-07-06T11:00:00Z'),
      });
      await db.insert(message).values({
        id: parentMessageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['centurion@legacyhotel.com'],
        subject: 'Group quote for 20 rooms',
        textBody: 'Need 20 rooms',
        receivedAt: new Date('2026-07-06T11:00:00Z'),
      });
      await db.insert(mailThreadCategory).values({
        threadId,
        categoryId: groupCategory!.id,
        transportId: TRANSPORT_ID,
      });

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const inbox = await mail.listThreads({ folder: 'inbox', limit: 20 });
      expect(inbox.threads.map((t) => t.id)).toContain(threadId);

      const groupOnly = await mail.listThreads({
        folder: 'inbox',
        filters: { categoryIds: [groupCategory!.id] },
        limit: 20,
      });
      expect(groupOnly.threads.map((t) => t.id)).toEqual([threadId]);
    });
  });

  it('mail.get returns categoryIds and categories matching listThreads', async () => {
    await withSeededTestDb(async (db) => {
      const [groupCategory] = await db
        .select()
        .from(mailCategory)
        .where(and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'groups-events')))
        .limit(1);
      expect(groupCategory).toBeDefined();

      const threadId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Get category wire',
        snippet: 'wire',
        isRead: true,
        latestMessageAt: new Date('2026-07-06T12:00:00Z'),
      });
      await db.insert(message).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'a@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Get category wire',
        textBody: 'hello',
        receivedAt: new Date('2026-07-06T12:00:00Z'),
      });
      await db.insert(mailThreadCategory).values({
        threadId,
        categoryId: groupCategory!.id,
        transportId: TRANSPORT_ID,
      });

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const detail = await mail.get({ id: threadId });
      expect(detail.categoryIds).toEqual([groupCategory!.id]);
      expect(detail.categories.map((c) => c.slug)).toEqual(['groups-events']);
    });
  });
});
