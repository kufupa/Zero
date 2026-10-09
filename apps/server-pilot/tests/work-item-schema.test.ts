import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { describe, expect, it } from 'vitest';

// withIngestionDb seeds this transport when seed is left on.
const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';

describe('mail extraction', () => {
  it('keeps one extraction per message and version, and cascades them with the message', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      await seedInboxThread(db, {
        threadId: 'thread-1',
        transportId: TRANSPORT_ID,
        transportEmail: TRANSPORT_EMAIL,
        messageId: 'msg-1',
      });
      await sql`INSERT INTO mail_extraction (message_id, extractor_version, status, kind) VALUES ('msg-1', 'v1', 'succeeded', 'quote')`;
      await expect(
        sql`INSERT INTO mail_extraction (message_id, extractor_version, status) VALUES ('msg-1', 'v1', 'failed')`,
      ).rejects.toThrow('mail_extraction_message_version_uidx');
      await sql`INSERT INTO mail_extraction (message_id, extractor_version, status) VALUES ('msg-1', 'v2', 'succeeded')`;

      await sql`DELETE FROM message WHERE id = 'msg-1'`;
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mail_extraction`;
      expect(row?.n).toBe(0);
    });
  });
});

describe('custom rates', () => {
  it('keeps one active name per transport, frees it once archived, and refuses a negative amount', async () => {
    await withIngestionDb(async ({ sql }) => {
      await sql`INSERT INTO custom_rate (transport_id, name, amount_minor, currency) VALUES (${TRANSPORT_ID}, 'Corporate BB', 185000, 'ZAR')`;
      await expect(
        sql`INSERT INTO custom_rate (transport_id, name, amount_minor, currency) VALUES (${TRANSPORT_ID}, 'Corporate BB', 1, 'ZAR')`,
      ).rejects.toThrow('custom_rate_transport_name_active_uidx');

      await sql`UPDATE custom_rate SET archived_at = now() WHERE name = 'Corporate BB'`;
      await sql`INSERT INTO custom_rate (transport_id, name, amount_minor, currency) VALUES (${TRANSPORT_ID}, 'Corporate BB', 190000, 'ZAR')`;

      await expect(
        sql`INSERT INTO custom_rate (transport_id, name, amount_minor, currency) VALUES (${TRANSPORT_ID}, 'Negative', -1, 'ZAR')`,
      ).rejects.toThrow('custom_rate_amount_check');

      const [row] = await sql<{ n: number; defaults: string }[]>`
        SELECT count(*)::int AS n, min(room_codes::text) AS defaults FROM custom_rate
      `;
      expect(row).toEqual({ n: 2, defaults: '[]' });
    });
  });
});

describe('work item and work event vocabularies', () => {
  it('keeps one work item per thread, kind and source message and defaults to needs_you', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      await seedInboxThread(db, {
        threadId: 'thread-1',
        transportId: TRANSPORT_ID,
        transportEmail: TRANSPORT_EMAIL,
        messageId: 'msg-1',
      });
      await sql`INSERT INTO work_item (transport_id, thread_id, source_message_id, kind) VALUES (${TRANSPORT_ID}, 'thread-1', 'msg-1', 'quote')`;
      await expect(
        sql`INSERT INTO work_item (transport_id, thread_id, source_message_id, kind) VALUES (${TRANSPORT_ID}, 'thread-1', 'msg-1', 'quote')`,
      ).rejects.toThrow('work_item_thread_kind_source_uidx');

      const [row] = await sql<{ status: string; state: string }[]>`
        SELECT status, state::text AS state FROM work_item
      `;
      expect(row).toEqual({ status: 'needs_you', state: '{}' });
    });
  });

  it('refuses unknown statuses, kinds, actors and event types', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      await seedInboxThread(db, {
        threadId: 'thread-1',
        transportId: TRANSPORT_ID,
        transportEmail: TRANSPORT_EMAIL,
        messageId: 'msg-1',
      });
      await expect(
        sql`INSERT INTO work_item (transport_id, thread_id, source_message_id, kind, status) VALUES (${TRANSPORT_ID}, 'thread-1', 'msg-1', 'quote', 'queued')`,
      ).rejects.toThrow('work_item_status_check');
      await expect(
        sql`INSERT INTO work_item (transport_id, thread_id, source_message_id, kind) VALUES (${TRANSPORT_ID}, 'thread-1', 'msg-1', 'invoice')`,
      ).rejects.toThrow('work_item_kind_check');

      const [item] = await sql<{ id: string }[]>`
        INSERT INTO work_item (transport_id, thread_id, source_message_id, kind)
        VALUES (${TRANSPORT_ID}, 'thread-1', 'msg-1', 'quote') RETURNING id
      `;
      await expect(
        sql`INSERT INTO work_event (work_item_id, actor_kind, type) VALUES (${item!.id}, 'robot', 'field.edit')`,
      ).rejects.toThrow('work_event_actor_kind_check');
      await expect(
        sql`INSERT INTO work_event (work_item_id, actor_kind, type) VALUES (${item!.id}, 'user', 'field.delete')`,
      ).rejects.toThrow('work_event_type_check');
    });
  });
});
