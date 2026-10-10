import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { applyDurableTriageResult } from '../src/ai/triage.js';
import { refineTriageOutput } from '../src/ai/triage.js';
import { mailSenderPreference, mailThread } from '../src/db/schema/mail.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import { parseRawMessage, generateMessageId } from '../src/mail/ingest/parse-message.js';
import {
  getLatestInboundFromAddress,
  getSenderPreference,
  removeSenderPreference,
  upsertSenderPreference,
} from '../src/mail/sender-preference.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { message } from '../src/db/schema/mail.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { callerFor } from './helpers/trpc-caller.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();

describe('getLatestInboundFromAddress source contract', () => {
  it('orders by createdAt DESC, id DESC', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../src/mail/sender-preference.ts'), 'utf8');
    expect(src).toMatch(
      /orderBy\(\s*desc\(\s*message\.createdAt\s*\)\s*,\s*desc\(\s*message\.id\s*\)\s*\)/,
    );
    expect(src).not.toMatch(/orderBy\(\s*desc\(\s*message\.receivedAt\s*\)\s*\)/);
  });
});

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('sender preference (seeded)', () => {
  it('upsert is unique per transport+email and updates kind', async () => {
    await withSeededTestDb(async (db) => {
      const first = await upsertSenderPreference({
        db,
        transportId: TRANSPORT_ID,
        emailRaw: 'Spammer <BAD@Example.COM>',
        kind: 'block',
      });
      expect(first).toEqual({ email: 'bad@example.com', kind: 'block' });

      await upsertSenderPreference({
        db,
        transportId: TRANSPORT_ID,
        emailRaw: 'bad@example.com',
        kind: 'allow',
      });

      const rows = await db
        .select()
        .from(mailSenderPreference)
        .where(
          and(
            eq(mailSenderPreference.transportId, TRANSPORT_ID),
            eq(mailSenderPreference.email, 'bad@example.com'),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('allow');

      expect(
        await getSenderPreference({
          db,
          transportId: TRANSPORT_ID,
          emailRaw: 'Spammer <bad@example.com>',
        }),
      ).toBe('allow');

      const removed = await removeSenderPreference({
        db,
        transportId: TRANSPORT_ID,
        emailRaw: 'bad@example.com',
      });
      expect(removed.removed).toBe(true);
      expect(
        await getSenderPreference({
          db,
          transportId: TRANSPORT_ID,
          emailRaw: 'bad@example.com',
        }),
      ).toBeNull();
    });
  });

  it('moveThreads spam upserts block for latest inbound sender', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = `thread-pref-spam-${randomUUID()}`;
      const sender = 'markspam@example.com';
      await seedInboxThread(db, {
        threadId,
        transportId: TRANSPORT_ID,
        transportEmail: 'centurion@legacyhotel.com',
        fromAddress: sender,
      });

      const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
      const result = await caller.mail.moveThreads({ threadIds: [threadId], destination: 'spam' });

      expect(result.preferences).toEqual([{ email: sender, kind: 'block' }]);
      expect(
        await getSenderPreference({ db, transportId: TRANSPORT_ID, emailRaw: sender }),
      ).toBe('block');
    });
  });

  it('moveThreads inbox upserts allow for latest inbound sender', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = `thread-pref-inbox-${randomUUID()}`;
      const sender = 'ham@example.com';
      await seedInboxThread(db, {
        threadId,
        transportId: TRANSPORT_ID,
        transportEmail: 'centurion@legacyhotel.com',
        fromAddress: sender,
      });
      await db
        .update(mailThread)
        .set({ spamAt: new Date() })
        .where(eq(mailThread.id, threadId));

      const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
      const result = await caller.mail.moveThreads({ threadIds: [threadId], destination: 'inbox' });

      expect(result.preferences).toEqual([{ email: sender, kind: 'allow' }]);
      expect(
        await getSenderPreference({ db, transportId: TRANSPORT_ID, emailRaw: sender }),
      ).toBe('allow');
    });
  });

  it('ingest with block preference sets spamAt even for never-spam sender', async () => {
    await withSeededTestDb(async (db) => {
      const storage = withFakeS3();
      const neverSpamFrom = 'aroransh17@gmail.com';
      await upsertSenderPreference({
        db,
        transportId: TRANSPORT_ID,
        emailRaw: neverSpamFrom,
        kind: 'block',
      });

      const raw = Buffer.from(
        [
          'From: aroransh17@gmail.com',
          'To: centurion@legacyhotel.com',
          'X-Zero-Mailbox: centurion@legacyhotel.com',
          'Subject: blocked never-spam ingest',
          'Message-ID: <blocked-never-spam@test>',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'user blocked this sender',
        ].join('\r\n'),
        'utf-8',
      );

      const messageId = generateMessageId();
      const parsed = await parseRawMessage(raw, { messageId, storage });
      const result = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `uidl-block-never-spam-${randomUUID()}`,
          messageId,
        },
        { db, storage },
      );

      expect(result.kind).toBe('stored');
      if (result.kind !== 'stored') return;

      const [thread] = await db
        .select({ spamAt: mailThread.spamAt })
        .from(mailThread)
        .where(eq(mailThread.id, result.threadId));
      expect(thread?.spamAt).not.toBeNull();
    });
  });

  it('allow preference skips AI spam_at on unsettled thread', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const sender = 'allowed@example.com';
      await seedInboxThread(db, {
        threadId,
        transportId: TRANSPORT_ID,
        transportEmail: 'centurion@legacyhotel.com',
        fromAddress: sender,
      });
      await upsertSenderPreference({
        db,
        transportId: TRANSPORT_ID,
        emailRaw: sender,
        kind: 'allow',
      });

      const result = await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        output: {
          category: 'spam',
          urgent: false,
          confidence: 0.99,
          rationale: 'sales spam',
          policyFlags: [],
        },
        writeGateEnabled: true,
      });

      expect(result.applyMode).toBe('full');
      const [thread] = await db
        .select({ spamAt: mailThread.spamAt })
        .from(mailThread)
        .where(eq(mailThread.id, threadId));
      expect(thread?.spamAt).toBeNull();
    });
  });

  it('never-spam refine still remaps AI spam before apply', () => {
    const refined = refineTriageOutput(
      {
        from: 'frontdesk@legacyhotels.co.za',
        subject: 'Promo?',
        body: 'Book a demo unsubscribe',
      },
      {
        category: 'spam',
        urgent: false,
        confidence: 0.99,
        rationale: 'salesy',
        policyFlags: [],
      },
    );
    expect(refined.category).toBe('ops');
    expect(refined.policyFlags).toContain('refine:never-spam-allowlist');
  });

  it('getLatestInboundFromAddress uses createdAt/id not backdated receivedAt', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = `thread-latest-order-${randomUUID()}`;
      await seedInboxThread(db, {
        threadId,
        transportId: TRANSPORT_ID,
        transportEmail: 'centurion@legacyhotel.com',
        fromAddress: 'older-created@example.com',
        messageId: `msg-older-created-${threadId}`,
      });

      const olderCreated = new Date('2026-07-01T00:00:00.000Z');
      const newerCreated = new Date('2026-07-02T00:00:00.000Z');
      const backdatedReceived = new Date('2026-07-03T00:00:00.000Z');
      const earlierReceived = new Date('2026-06-01T00:00:00.000Z');

      await db
        .update(message)
        .set({
          createdAt: olderCreated,
          receivedAt: backdatedReceived,
          fromAddress: 'older-created@example.com',
        })
        .where(eq(message.id, `msg-older-created-${threadId}`));

      await db.insert(message).values({
        id: `msg-newer-created-${threadId}`,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'newer-created@example.com',
        toAddresses: ['centurion@legacyhotel.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'newer created',
        textBody: 'trusted order wins',
        ownerHeaderValue: 'centurion@legacyhotel.com',
        messageIdHeader: `${threadId}-newer@example.com`,
        references: [],
        isRead: false,
        isStarred: false,
        createdAt: newerCreated,
        receivedAt: earlierReceived,
      });

      const latest = await getLatestInboundFromAddress(db, TRANSPORT_ID, threadId);
      expect(latest).toBe('newer-created@example.com');
    });
  });
});
