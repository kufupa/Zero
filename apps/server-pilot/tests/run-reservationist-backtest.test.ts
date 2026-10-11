import { replayExtraction } from '../scripts/run-reservationist-backtest.js';
import { AE1_OUTPUT, fakeModel } from './fixtures/inbound-extraction.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { message } from '../src/db/schema/mail.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';

/** Runs `body` on a fresh database, which the production loader reads through getDb(). */
async function withStoredMail(body: (db: DB) => Promise<void>) {
  await withIngestionDb(async ({ db }) => {
    __setDbForTests({ db, conn: null as never });
    try {
      await body(db);
    } finally {
      __setDbForTests(null);
    }
  });
}

describe('replayExtraction', () => {
  it('replays a case with the stored thread, sender and mailbox, as the inbound worker does', async () => {
    await withStoredMail(async (db) => {
      const mails = [
        ['msg-replay-earlier', 'Earlier: we need two rooms in October.', '2026-10-10T08:00:00Z'],
        ['msg-replay-trigger', 'Please confirm the booking for 12 October.', '2026-10-10T09:00:00Z'],
      ] as const;
      for (const [id, textBody, receivedAt] of mails) {
        await seedInboxThread(db, {
          threadId: 'thread-replay',
          transportId: TRANSPORT_ID,
          transportEmail: TRANSPORT_EMAIL,
          messageId: id,
          messageIdHeader: `${id}@example.com`,
          fromAddress: 'guest@example.com',
          subject: 'Rooms',
          textBody,
        });
        await db.update(message).set({ receivedAt: new Date(receivedAt) }).where(eq(message.id, id));
      }
      const model = fakeModel(() => AE1_OUTPUT);

      const trace = await replayExtraction(
        { message_id: 'msg-replay-trigger', transport_id: TRANSPORT_ID },
        model.adapter,
      );

      expect(trace.error).toBeUndefined();
      expect(trace.extraction).not.toBeNull();
      expect(model.calls).toHaveLength(1);
      const prompt = model.calls[0]!.userPrompt;
      expect(prompt).toContain('Earlier: we need two rooms in October.');
      expect(prompt).toContain('Please confirm the booking for 12 October.');
      expect(prompt).toContain('From: guest@example.com');
      expect(prompt).toContain(`Mailbox: ${TRANSPORT_EMAIL}`);
    });
  });

  it('reports a case whose message is not in the database, with no model call', async () => {
    await withStoredMail(async () => {
      const model = fakeModel(() => AE1_OUTPUT);

      const trace = await replayExtraction(
        { message_id: 'msg-replay-missing', transport_id: TRANSPORT_ID },
        model.adapter,
      );

      expect(trace).toEqual({
        extraction: null,
        usage: null,
        error: 'message msg-replay-missing is not in the database',
      });
      expect(model.calls).toHaveLength(0);
    });
  });
});
