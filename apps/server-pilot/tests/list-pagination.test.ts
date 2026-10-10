import { describe, expect, it } from 'vitest';
import { mailThread, mailDraft } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { TRANSPORT_ID } from '../src/db/seed.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('list keyset pagination', () => {
  it(
    'mail.listThreads page 2 returns rows after 55-thread seed',
    async () => {
      const result = await withSeededTestDb(async (db) => {
        const base = Date.now();
        const threadRows = Array.from({ length: 55 }, (_, i) => ({
          id: `paginate-thread-${i}`,
          transportId: TRANSPORT_ID,
          threadRootId: `paginate-root-${i}`,
          subject: `Pagination thread ${i}`,
          snippet: `Snippet ${i}`,
          isArchived: false,
          isStarred: false,
          isRead: true,
          labelIds: [] as string[],
          latestMessageAt: new Date(base - i * 60_000),
        }));
        await db.insert(mailThread).values(threadRows);

        const { mail } = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
        const page1 = await mail.listThreads({ folder: 'all', limit: 50 });
        expect(page1.threads.length).toBe(50);
        expect(page1.nextPageToken).toBeTruthy();

        const page2 = await mail.listThreads({
          folder: 'all',
          limit: 50,
          cursor: page1.nextPageToken!,
        });
        expect(page2.threads.length).toBeGreaterThanOrEqual(5);

        const page1Ids = new Set(page1.threads.map((t) => t.id));
        for (const t of page2.threads) {
          expect(page1Ids.has(t.id)).toBe(false);
        }

        return { page1Count: page1.threads.length, page2Count: page2.threads.length };
      });

      expect(result.page1Count).toBe(50);
      expect(result.page2Count).toBeGreaterThanOrEqual(5);
    },
    30000,
  );

  it(
    'mail.listThreads filters q and labelIds in SQL before limit',
    async () => {
      await withSeededTestDb(async (db) => {
        await db.insert(mailThread).values([
          {
            id: 'filter-thread-alpha',
            transportId: TRANSPORT_ID,
            threadRootId: 'filter-root-alpha',
            subject: 'Alpha hotel booking',
            snippet: 'alpha snippet',
            isArchived: false,
            isStarred: false,
            isRead: true,
            labelIds: ['label-work'],
            latestMessageAt: new Date(),
          },
          {
            id: 'filter-thread-beta',
            transportId: TRANSPORT_ID,
            threadRootId: 'filter-root-beta',
            subject: 'Beta conference',
            snippet: 'beta snippet',
            isArchived: false,
            isStarred: false,
            isRead: true,
            labelIds: ['label-personal'],
            latestMessageAt: new Date(Date.now() - 60_000),
          },
        ]);

        const { mail } = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
        const byQuery = await mail.listThreads({
          folder: 'all',
          q: 'alpha',
          limit: 50,
        });
        expect(byQuery.threads.some((t) => t.id === 'filter-thread-alpha')).toBe(true);
        expect(byQuery.threads.some((t) => t.id === 'filter-thread-beta')).toBe(false);

        const byLabel = await mail.listThreads({
          folder: 'all',
          labelIds: ['label-personal'],
          limit: 50,
        });
        expect(byLabel.threads.some((t) => t.id === 'filter-thread-beta')).toBe(true);
        expect(byLabel.threads.some((t) => t.id === 'filter-thread-alpha')).toBe(false);
      });
    },
    30000,
  );

  it(
    'drafts.list paginates on (updatedAt, id)',
    async () => {
      const result = await withSeededTestDb(async (db) => {
        const base = Date.now();
        const draftRows = Array.from({ length: 55 }, (_, i) => ({
          id: `paginate-draft-${i}`,
          transportId: TRANSPORT_ID,
          createdByUserId: 'user-navaai',
          subject: `Draft ${i}`,
          textBody: `Body ${i}`,
          isSent: false,
          updatedAt: new Date(base - i * 60_000),
        }));
        await db.insert(mailDraft).values(draftRows);

        const { drafts } = await callerFor('user-navaai', {
          db,
          requestedTransportId: TRANSPORT_ID,
        });
        const page1 = await drafts.list({ limit: 50 });
        expect(page1.threads.length).toBe(50);
        expect(page1.nextPageToken).toBeTruthy();

        const page2 = await drafts.list({
          limit: 50,
          cursor: page1.nextPageToken!,
        });
        expect(page2.threads.length).toBeGreaterThanOrEqual(5);

        const page1Ids = new Set(page1.threads.map((d) => d.id));
        for (const d of page2.threads) {
          expect(page1Ids.has(d.id)).toBe(false);
        }

        return { page2Count: page2.threads.length };
      });

      expect(result.page2Count).toBeGreaterThanOrEqual(5);
    },
    30000,
  );
});
