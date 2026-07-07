import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  aiWorkflowRun,
  mailDraft,
  mailDraftRevision,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import { generateMessageId, parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import {
  FakeSmtpTransport,
  __setSmtpTransportForTests,
} from '../src/mail/send/smtp.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { callerFor } from './helpers/trpc-caller.js';
import { readFixture } from './helpers/fixtures.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';

const reachable = await probeTestDb();

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('AI enqueue contract', () => {
  it('creates one queued inbound triage run when a message is stored', async () => {
    await withSeededTestDb(async (db) => {
      const storage = withFakeS3();
      const raw = readFixture('centurion-stamped.eml');
      const messageId = generateMessageId();
      const parsed = await parseRawMessage(raw, { messageId, storage });
      const result = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `uidl-${randomUUID()}`,
          messageId,
        },
        { db, storage },
      );
      expect(result.kind).toBe('stored');

      const runs = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.runKind).toBe('inbound_triage');
      expect(runs[0]?.state).toBe('queued');
    });
  });

  it('does not create a duplicate run for duplicate inbound UIDL', async () => {
    await withSeededTestDb(async (db) => {
      const storage = withFakeS3();
      const raw = readFixture('centurion-stamped.eml');
      const pop3Uidl = `uidl-dup-${randomUUID()}`;
      const meta = {
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl,
      };

      const firstId = generateMessageId();
      const firstParsed = await parseRawMessage(raw, { messageId: firstId, storage });
      const first = await persistInboundMessage(
        firstParsed,
        raw,
        { ...meta, messageId: firstId },
        { db, storage },
      );
      expect(first.kind).toBe('stored');

      const secondId = generateMessageId();
      const secondParsed = await parseRawMessage(raw, { messageId: secondId, storage });
      const second = await persistInboundMessage(
        secondParsed,
        raw,
        { ...meta, messageId: secondId },
        { db, storage },
      );
      expect(second.kind).toBe('duplicate');

      const runs = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.triggerMessageId, firstId));
      expect(runs).toHaveLength(1);
    });
  });

  it('keeps inbox listing independent of AI run presence', async () => {
    await withSeededTestDb(async (db) => {
      const storage = withFakeS3();
      const raw = readFixture('centurion-stamped.eml');
      const messageId = generateMessageId();
      const parsed = await parseRawMessage(raw, { messageId, storage });
      await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `uidl-list-${randomUUID()}`,
          messageId,
        },
        { db, storage },
      );

      const caller = await callerFor('user-centurion-worker', { db });
      const list = await caller.mail.listThreads({ folder: 'inbox' });
      expect(list.threads.length).toBeGreaterThan(0);
    });
  });

  it('creates feedback run with sent revision for AI-origin draft send', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        const transportId = 'transport-centurion';
        const threadId = 'thread-centurion-1';
        const inboundId = 'msg-centurion-inbound-1';
        const draftId = randomUUID();
        const generationId = randomUUID();

        await db
          .insert(mailDraft)
          .values({
            id: draftId,
            transportId,
            threadId,
            createdByUserId: 'user-centurion-worker',
            toAddresses: ['guest@example.com'],
            subject: 'Re: booking',
            textBody: 'AI draft',
            htmlBody: '<p>AI draft</p>',
            status: 'active',
            origin: 'ai',
            generationId,
            replyToMessageId: inboundId,
          })
          .onConflictDoNothing();

        const caller = await callerFor('user-centurion-worker', { db });
        const result = await caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: booking',
          html: '<p>Edited send</p>',
          text: 'Edited send',
        });
        expect(result.sent).toBe(true);

        const revisions = await db
          .select()
          .from(mailDraftRevision)
          .where(eq(mailDraftRevision.draftId, draftId));
        expect(revisions.some((row) => row.kind === 'sent')).toBe(true);

        const feedbackRuns = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.idempotencyKey, `feedback:${draftId}`));
        expect(feedbackRuns).toHaveLength(1);
        expect(feedbackRuns[0]?.runKind).toBe('feedback_extraction');
        expect(feedbackRuns[0]?.triggerMessageId).toBe(result.messageId);
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  });

  it('does not create feedback run when SMTP send fails', async () => {
    await withSeededTestDb(async (db) => {
      const transportId = randomUUID();
      const threadId = randomUUID();
      const inboundId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();

      await db.insert(mailboxTransport).values({
        id: transportId,
        email: `nava-${transportId.slice(0, 8)}@example.com`,
        ownerHeaderValue: `nava-${transportId.slice(0, 8)}@example.com`,
      });
      await db
        .insert(userAuthTable)
        .values({
          id: 'user-1',
          name: 'User',
          email: 'user@example.com',
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
      await db.insert(mailThread).values({
        id: threadId,
        transportId,
        threadRootId: `<root-${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: inboundId,
        transportId,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Need help',
        receivedAt: new Date(),
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId,
        threadId,
        createdByUserId: 'user-1',
        toAddresses: ['guest@example.com'],
        subject: 'Re: booking',
        textBody: 'AI draft',
        htmlBody: '<p>AI draft</p>',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: inboundId,
      });

      const failingSmtp = {
        send: async () => {
          throw new Error('smtp failure');
        },
      };
      __setSmtpTransportForTests(failingSmtp);

      try {
        const caller = await callerFor('user-1', {
          db,
          requestedTransportId: transportId,
        });
        await expect(
          caller.mail.send({
            threadId,
            draftId,
            to: ['guest@example.com'],
            subject: 'Re: booking',
            html: '<p>Edited send</p>',
            text: 'Edited send',
          }),
        ).rejects.toThrow(/smtp failure/i);

        const feedbackRuns = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.idempotencyKey, `feedback:${draftId}`));
        expect(feedbackRuns).toHaveLength(0);
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  });
});
