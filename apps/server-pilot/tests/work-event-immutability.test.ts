import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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

  it('deletes the source message without blocking, and keeps the item and its events', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const { workItemId } = await seedWorkItemWithEvent(db);
      await sql`INSERT INTO mail_extraction (message_id, extractor_version, status) VALUES ('msg-1', 'v1', 'succeeded')`;
      await sql`UPDATE work_item SET extraction_id = (SELECT id FROM mail_extraction) WHERE id = ${workItemId}`;

      await sql`DELETE FROM message WHERE id = 'msg-1'`;

      const [item] = await sql<
        { threadId: string | null; sourceMessageId: string | null; extractionId: string | null }[]
      >`
        SELECT thread_id AS "threadId", source_message_id AS "sourceMessageId", extraction_id AS "extractionId"
        FROM work_item WHERE id = ${workItemId}
      `;
      expect(item).toEqual({ threadId: 'thread-1', sourceMessageId: null, extractionId: null });
      const [events] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM work_event`;
      expect(events?.n).toBe(1);
    });
  });

  it('deletes the thread without blocking, and keeps the item and its events', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const { workItemId } = await seedWorkItemWithEvent(db);

      await sql`DELETE FROM mail_thread WHERE id = 'thread-1'`;

      const [item] = await sql<{ threadId: string | null; sourceMessageId: string | null }[]>`
        SELECT thread_id AS "threadId", source_message_id AS "sourceMessageId"
        FROM work_item WHERE id = ${workItemId}
      `;
      expect(item).toEqual({ threadId: null, sourceMessageId: null });
      const [counts] = await sql<{ messages: number; events: number }[]>`
        SELECT (SELECT count(*)::int FROM message) AS messages,
               (SELECT count(*)::int FROM work_event) AS events
      `;
      expect(counts).toEqual({ messages: 0, events: 1 });
    });
  });

  it('still runs the pilot wipe TRUNCATE when work rows and events exist', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      await seedWorkItemWithEvent(db);
      const script = readFileSync(
        fileURLToPath(new URL('../deploy/pilot-db-wipe.sh', import.meta.url)),
        'utf8',
      );
      const wipeSql = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(script)?.[1];
      expect(wipeSql).toContain('TRUNCATE TABLE');
      await sql.unsafe(wipeSql!);
      const [counts] = await sql<{ items: number; events: number }[]>`
        SELECT (SELECT count(*)::int FROM work_item) AS items,
               (SELECT count(*)::int FROM work_event) AS events
      `;
      expect(counts).toEqual({ items: 0, events: 0 });
    });
  });
});

describe('approvals are single-use', () => {
  it('refuses a second approval.consumed for the same work item and payload hash', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const { workItemId } = await seedWorkItemWithEvent(db);
      const consume = (hash: string) =>
        sql`INSERT INTO work_event (work_item_id, actor_kind, type, payload_hash) VALUES (${workItemId}, 'system', 'approval.consumed', ${hash})`;
      await consume('sha256:a');
      await expect(consume('sha256:a')).rejects.toThrow('work_event_approval_consumed_uidx');
      await consume('sha256:b');
      // Grants are not limited by the index, and a consume needs a hash so the index applies.
      await sql`INSERT INTO work_event (work_item_id, actor_kind, type, payload_hash) VALUES (${workItemId}, 'user', 'approval.granted', 'sha256:a')`;
      await sql`INSERT INTO work_event (work_item_id, actor_kind, type, payload_hash) VALUES (${workItemId}, 'user', 'approval.granted', 'sha256:a')`;
      await expect(
        sql`INSERT INTO work_event (work_item_id, actor_kind, type) VALUES (${workItemId}, 'system', 'approval.consumed')`,
      ).rejects.toThrow('work_event_approval_hash_check');
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM work_event WHERE type = 'approval.consumed'
      `;
      expect(row?.n).toBe(2);
    });
  });
});
