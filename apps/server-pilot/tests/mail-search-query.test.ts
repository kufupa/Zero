import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import {
  attachment,
  mailCategory,
  mailThread,
  mailThreadCategory,
  message,
} from '../src/db/schema/mail.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { parseSearchQuery } from '../src/mail/search/parse.js';
import { buildThreadSearchConditions } from '../src/mail/search/query.js';
import { refreshThreadSearchVector } from '../src/mail/search/search-vector.js';
import type { ParsedSearchQuery } from '../src/mail/search/types.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';

const reachable = await probeTestDb();

async function listThreadIdsForSearch(
  db: DB,
  parsed: ParsedSearchQuery,
  transportId = TRANSPORT_ID,
): Promise<string[]> {
  const conditions = buildThreadSearchConditions(db, parsed, { transportId });
  const rows = await db
    .select({ id: mailThread.id })
    .from(mailThread)
    .where(and(eq(mailThread.transportId, transportId), ...conditions));
  return rows.map((row) => row.id);
}

async function listThreadIdsForQuery(
  db: DB,
  q: string,
  transportId = TRANSPORT_ID,
): Promise<string[]> {
  return listThreadIdsForSearch(db, parseSearchQuery(q), transportId);
}

async function seedThreadWithMessage(
  db: DB,
  opts: {
    threadId?: string;
    messageId?: string;
    subject: string;
    snippet: string;
    textBody?: string;
    fromAddress?: string;
    toAddresses?: string[];
    ccAddresses?: string[];
    bccAddresses?: string[];
    isRead?: boolean;
    isStarred?: boolean;
    labelIds?: string[];
    latestMessageAt?: Date;
    withAttachment?: boolean;
    refreshSearchVector?: boolean;
  },
): Promise<{ threadId: string; messageId: string }> {
  const threadId = opts.threadId ?? randomUUID();
  const messageId = opts.messageId ?? randomUUID();

  await db.insert(mailThread).values({
    id: threadId,
    transportId: TRANSPORT_ID,
    threadRootId: `<${threadId}@example.com>`,
    subject: opts.subject,
    snippet: opts.snippet,
    isRead: opts.isRead ?? true,
    isStarred: opts.isStarred ?? false,
    labelIds: opts.labelIds ?? [],
    latestMessageAt: opts.latestMessageAt ?? new Date('2026-07-06T12:00:00Z'),
  });

  await db.insert(message).values({
    id: messageId,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: opts.fromAddress ?? 'sender@example.com',
    toAddresses: opts.toAddresses ?? ['nava@example.com'],
    ccAddresses: opts.ccAddresses ?? [],
    bccAddresses: opts.bccAddresses ?? [],
    subject: opts.subject,
    textBody: opts.textBody ?? opts.snippet,
    receivedAt: opts.latestMessageAt ?? new Date('2026-07-06T12:00:00Z'),
  });
  if (opts.refreshSearchVector ?? true) {
    await refreshThreadSearchVector(db, threadId);
  }

  if (opts.withAttachment) {
    await db.insert(attachment).values({
      id: randomUUID(),
      messageId,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      s3Key: `attachments/${messageId}/invoice.pdf`,
    });
  }

  return { threadId, messageId };
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('buildThreadSearchConditions', () => {
  it('matches free text via search_vector FTS', async () => {
    await withSeededTestDb(async (db) => {
      const { threadId } = await seedThreadWithMessage(db, {
        subject: 'Hotel invoice',
        snippet: 'Please review the attached invoice',
      });
      await seedThreadWithMessage(db, {
        subject: 'Breakfast menu',
        snippet: 'Restaurant options',
      });

      const ids = await listThreadIdsForQuery(db, 'invoice');
      expect(ids).toEqual([threadId]);
    });
  });

  it('matches a token that exists only in message text_body', async () => {
    await withSeededTestDb(async (db) => {
      const { threadId } = await seedThreadWithMessage(db, {
        subject: 'Housekeeping',
        snippet: 'See note',
        textBody: 'uniquebodytoken left in the guest bathroom',
      });
      await seedThreadWithMessage(db, {
        subject: 'Housekeeping',
        snippet: 'See note',
        textBody: 'minibar restock only',
      });

      const ids = await listThreadIdsForQuery(db, 'uniquebodytoken');
      expect(ids).toEqual([threadId]);
    });
  });

  it(
    'does not match a token beyond deterministic 20-message body cap',
    async () => {
      await withSeededTestDb(async (db) => {
        const receivedAt = new Date('2026-07-06T12:00:00Z');
        const { threadId } = await seedThreadWithMessage(db, {
          messageId: '00000000-0000-0000-0000-000000000001',
          subject: 'Housekeeping',
          snippet: 'See note',
          textBody: 'messagecapboundarytoken',
          latestMessageAt: receivedAt,
          refreshSearchVector: false,
        });
        await db.insert(message).values(
          Array.from({ length: 20 }, (_, index) => ({
            id: `00000000-0000-0000-0000-${String(index + 2).padStart(12, '0')}`,
            transportId: TRANSPORT_ID,
            threadId,
            direction: 'inbound' as const,
            fromAddress: 'sender@example.com',
            toAddresses: ['nava@example.com'],
            ccAddresses: [],
            bccAddresses: [],
            subject: 'Housekeeping',
            textBody: `recent message ${index}`,
            receivedAt,
          })),
        );
        await refreshThreadSearchVector(db, threadId);

        expect(
          await listThreadIdsForQuery(db, 'messagecapboundarytoken'),
        ).toEqual([]);
      });
    },
    30000,
  );

  it(
    'does not match a token after 8,000 body characters',
    async () => {
      await withSeededTestDb(async (db) => {
        await seedThreadWithMessage(db, {
          subject: 'Housekeeping',
          snippet: 'See note',
          textBody: `${'a '.repeat(4000)}charcapboundarytoken`,
        });

        expect(
          await listThreadIdsForQuery(db, 'charcapboundarytoken'),
        ).toEqual([]);
      });
    },
    30000,
  );

  it('filters from: via message EXISTS join', async () => {
    await withSeededTestDb(async (db) => {
      const { threadId } = await seedThreadWithMessage(db, {
        subject: 'VIP transfer',
        snippet: 'Pickup at 6am',
        fromAddress: 'alice@corp.com',
      });
      await seedThreadWithMessage(db, {
        subject: 'Other',
        snippet: 'Other sender',
        fromAddress: 'bob@corp.com',
      });

      const ids = await listThreadIdsForQuery(db, 'from:alice@corp.com');
      expect(ids).toEqual([threadId]);
    });
  });

  it(
    'filters to:, cc:, and bcc: via message address arrays',
    async () => {
      await withSeededTestDb(async (db) => {
        const toThread = (
          await seedThreadWithMessage(db, {
            subject: 'To match',
            snippet: 'to filter',
            toAddresses: ['ops@corp.com'],
          })
        ).threadId;
        const ccThread = (
          await seedThreadWithMessage(db, {
            subject: 'Cc match',
            snippet: 'cc filter',
            ccAddresses: ['finance@corp.com'],
          })
        ).threadId;
        const bccThread = (
          await seedThreadWithMessage(db, {
            subject: 'Bcc match',
            snippet: 'bcc filter',
            bccAddresses: ['hidden@corp.com'],
          })
        ).threadId;

        expect(await listThreadIdsForQuery(db, 'to:ops@corp.com')).toEqual([toThread]);
        expect(await listThreadIdsForQuery(db, 'cc:finance@corp.com')).toEqual([ccThread]);
        expect(await listThreadIdsForQuery(db, 'bcc:hidden@corp.com')).toEqual([bccThread]);
      });
    },
    30000,
  );

  it('filters is:read, is:starred, and is:important on mail_thread', async () => {
    await withSeededTestDb(async (db) => {
      const unreadId = (
        await seedThreadWithMessage(db, {
          subject: 'Unread',
          snippet: 'needs reply',
          isRead: false,
        })
      ).threadId;
      const starredId = (
        await seedThreadWithMessage(db, {
          subject: 'Starred',
          snippet: 'flagged',
          isStarred: true,
        })
      ).threadId;
      const importantId = (
        await seedThreadWithMessage(db, {
          subject: 'Important',
          snippet: 'priority',
          labelIds: ['IMPORTANT'],
        })
      ).threadId;

      expect(await listThreadIdsForQuery(db, 'is:unread')).toEqual([unreadId]);
      expect(await listThreadIdsForQuery(db, 'is:starred')).toEqual([starredId]);
      expect(await listThreadIdsForQuery(db, 'is:important')).toEqual([importantId]);
    });
  });

  it('filters has:attachment via attachment EXISTS', async () => {
    await withSeededTestDb(async (db) => {
      const withAtt = (
        await seedThreadWithMessage(db, {
          subject: 'With file',
          snippet: 'attachment present',
          withAttachment: true,
        })
      ).threadId;
      await seedThreadWithMessage(db, {
        subject: 'No file',
        snippet: 'plain text only',
      });

      expect(await listThreadIdsForQuery(db, 'has:attachment')).toEqual([withAtt]);
      expect(await listThreadIdsForQuery(db, 'has:attachment')).toEqual([withAtt]);
    });
  });

  it('filters after: and before: on latestMessageAt', async () => {
    await withSeededTestDb(async (db) => {
      const earlyId = (
        await seedThreadWithMessage(db, {
          subject: 'Early',
          snippet: 'old thread',
          latestMessageAt: new Date('2026-01-01T10:00:00Z'),
        })
      ).threadId;
      const lateId = (
        await seedThreadWithMessage(db, {
          subject: 'Late',
          snippet: 'new thread',
          latestMessageAt: new Date('2026-06-01T10:00:00Z'),
        })
      ).threadId;

      expect(await listThreadIdsForQuery(db, 'after:2026/03/01')).toEqual([lateId]);
      expect(await listThreadIdsForQuery(db, 'before:2026-03-01')).toEqual([earlyId]);
    });
  });

  it('filters label: via labelIds jsonb containment', async () => {
    await withSeededTestDb(async (db) => {
      const labeledId = (
        await seedThreadWithMessage(db, {
          subject: 'Work item',
          snippet: 'labelled',
          labelIds: ['label-work'],
        })
      ).threadId;
      await seedThreadWithMessage(db, {
        subject: 'Personal',
        snippet: 'other label',
        labelIds: ['label-personal'],
      });

      expect(await listThreadIdsForQuery(db, 'label:label-work')).toEqual([labeledId]);
    });
  });

  it('filters category: via mail_thread_category slug join', async () => {
    await withSeededTestDb(async (db) => {
      const categoryId = randomUUID();
      const slug = `travel-${categoryId.slice(0, 8)}`;
      const matchingThreadId = randomUUID();

      await db.insert(mailCategory).values({
        id: categoryId,
        transportId: TRANSPORT_ID,
        slug,
        name: 'Travel Agents',
        sortOrder: 10,
      });
      await seedThreadWithMessage(db, {
        threadId: matchingThreadId,
        subject: 'Airport pickup',
        snippet: 'Travel category thread',
      });
      await seedThreadWithMessage(db, {
        subject: 'Breakfast',
        snippet: 'Uncategorized',
      });
      await db.insert(mailThreadCategory).values({
        threadId: matchingThreadId,
        categoryId,
        transportId: TRANSPORT_ID,
      });

      expect(await listThreadIdsForQuery(db, `category:${slug}`)).toEqual([matchingThreadId]);
    });
  });
});
