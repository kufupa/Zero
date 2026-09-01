import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AI_PRIMARY_CATEGORY_SLUGS, AI_MANAGED_CATEGORY_SEED_ROWS } from '../src/ai/categories.js';
import { appRouter } from '../src/trpc/router.js';
import { __setDbForTests } from '../src/db/client.js';
import { mailThread, mailThreadCategory, mailboxTransport } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';

const reachable = await probeTestDb();

it('primary slugs are revenue queues', () => {
  expect([...AI_PRIMARY_CATEGORY_SLUGS]).toEqual([
    'new-bookings',
    'groups-events',
    'at-risk',
    'ops',
  ]);
  expect(AI_MANAGED_CATEGORY_SEED_ROWS.map((r) => r.slug)).toEqual([
    'at-risk',
    'new-bookings',
    'groups-events',
    'ops',
    'bookings',
    'manage-stay',
    'confirm-reconcile',
    'money-billing',
    'documents-delivery',
    'exceptions-recovery',
    'guest-experience',
    'internal-partner',
    'automated-channel',
    'unknown-review',
    'urgent',
  ]);
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('categories router', () => {
  it('creates mailbox-scoped categories and assigns multiple categories to one thread', async () => {
    await withSeededTestDb(async (db) => {
      const transportId = randomUUID();
      const threadId = randomUUID();
      const transportEmail = `nava-${randomUUID()}@example.com`;
      await db.insert(mailboxTransport).values({
        id: transportId,
        email: transportEmail,
        ownerHeaderValue: transportEmail,
      });
      await db.insert(mailThread).values({
        id: threadId,
        transportId,
        threadRootId: '<root@example.com>',
        subject: 'VIP booking',
        snippet: 'Need travel agent',
        isRead: false,
      });

      __setDbForTests({ db, conn: null as never });
      const caller = appRouter.createCaller({
        source: 'test',
        sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
        activeTransportId: transportId,
        accessRole: 'owner',
        transportEmail: transportEmail,
      } as never);

      const travel = await caller.categories.create({
        slug: 'new-bookings',
        name: 'New Bookings',
        color: '#14b8a6',
        sortOrder: 10,
      });
      const urgent = await caller.categories.create({
        slug: 'urgent',
        name: 'Urgent',
        color: '#ef4444',
        sortOrder: 20,
      });

      await caller.categories.setThreadCategories({
        threadId,
        categoryIds: [travel.id, urgent.id],
      });

      const categories = await caller.categories.list();
      expect(categories.map((c) => c.slug)).toEqual(['new-bookings', 'urgent']);

      const membership = await db.select().from(mailThreadCategory);
      expect(membership.filter((row) => row.threadId === threadId)).toHaveLength(2);
    });
  });

  it('rejects duplicate slugs in the same mailbox', async () => {
    await withSeededTestDb(async (db) => {
      const transportId = randomUUID();
      const transportEmail = `nava-${randomUUID()}@example.com`;
      await db.insert(mailboxTransport).values({
        id: transportId,
        email: transportEmail,
        ownerHeaderValue: transportEmail,
      });

      __setDbForTests({ db, conn: null as never });
      const caller = appRouter.createCaller({
        source: 'test',
        sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
        activeTransportId: transportId,
        accessRole: 'owner',
        transportEmail: transportEmail,
      } as never);

      await caller.categories.create({ slug: 'urgent', name: 'Urgent', sortOrder: 1 });
      await expect(
        caller.categories.create({ slug: 'urgent', name: 'Urgent Again', sortOrder: 2 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<TRPCError>);
    });
  });
});
