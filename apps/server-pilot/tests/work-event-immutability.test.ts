import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';

// withIngestionDb seeds this transport when seed is left on.
const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';

/** One inbound message, a work item on it and one field edit on that item. */
async function seedWorkItemWithEvent(db: DB) {
  await seedInboxThread(db, {
    threadId: 'thread-1',
    transportId: TRANSPORT_ID,
    transportEmail: TRANSPORT_EMAIL,
    messageId: 'msg-1',
  });
  const [item] = await db
    .insert(workItem)
    .values({
      transportId: TRANSPORT_ID,
      threadId: 'thread-1',
      sourceMessageId: 'msg-1',
      kind: 'quote',
    })
    .returning({ id: workItem.id });
  const [event] = await db
    .insert(workEvent)
    .values({
      workItemId: item!.id,
      actorKind: 'user',
      type: 'field.edit',
      fieldPath: 'stays[s_1a2b].rows[r_9c8d].count',
      aiValue: 2,
      value: 3,
      msSinceOpen: 4200,
    })
    .returning({ id: workEvent.id });
  return { workItemId: item!.id, eventId: event!.id };
}

describe('work events are insert-only', () => {
  it('refuses UPDATE on a work event', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const { eventId } = await seedWorkItemWithEvent(db);
      await expect(
        sql`UPDATE work_event SET type = 'field.accept' WHERE id = ${eventId}`,
      ).rejects.toThrow('work events are append-only');
      const [row] = await sql<
        { type: string }[]
      >`SELECT type FROM work_event WHERE id = ${eventId}`;
      expect(row?.type).toBe('field.edit');
    });
  });

  it('refuses DELETE on a work event', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const { eventId } = await seedWorkItemWithEvent(db);
      await expect(sql`DELETE FROM work_event WHERE id = ${eventId}`).rejects.toThrow(
        'work events are append-only',
      );
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM work_event`;
      expect(row?.n).toBe(1);
    });
  });

  it('refuses deleting a work item that has events, and still deletes one without events', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const { workItemId } = await seedWorkItemWithEvent(db);
      await expect(sql`DELETE FROM work_item WHERE id = ${workItemId}`).rejects.toThrow(
        'violates foreign key constraint',
      );
      const [bare] = await db
        .insert(workItem)
        .values({
          transportId: TRANSPORT_ID,
          threadId: 'thread-1',
          sourceMessageId: 'msg-1',
          kind: 'booking',
        })
        .returning({ id: workItem.id });
      await sql`DELETE FROM work_item WHERE id = ${bare!.id}`;
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM work_item`;
      expect(row?.n).toBe(1);
    });
  });

  it('keeps approval history when the source mail is deleted', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      await seedWorkItemWithEvent(db);
      await expect(sql`DELETE FROM message WHERE id = 'msg-1'`).rejects.toThrow(
        'violates foreign key constraint',
      );
      const [counts] = await sql<{ items: number; events: number }[]>`
        SELECT (SELECT count(*)::int FROM work_item) AS items,
               (SELECT count(*)::int FROM work_event) AS events
      `;
      expect(counts).toEqual({ items: 1, events: 1 });
    });
  });
});
