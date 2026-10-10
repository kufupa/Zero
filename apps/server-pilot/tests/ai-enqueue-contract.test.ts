import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  aiWorkflowRun,
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
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

async function seedCenturionThread(db: import('../src/db/client.js').DB) {
  await db
    .insert(mailThread)
    .values({
      id: 'thread-centurion-1',
      transportId: 'transport-centurion',
      threadRootId: 'centurion-root-1',
      subject: 'Centurion booking #4471',
      snippet: 'Original booking inquiry',
      isArchived: false,
      isStarred: false,
      isRead: false,
      labelIds: [],
      latestMessageAt: new Date(),
    })
    .onConflictDoNothing({ target: mailThread.id });

  await db
    .insert(message)
    .values({
      id: 'msg-centurion-inbound-1',
      transportId: 'transport-centurion',
      threadId: 'thread-centurion-1',
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['centurion@legacyhotel.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Centurion booking #4471',
      textBody: 'I need a room',
      messageIdHeader: 'inbound-msg-id-1',
      references: [],
      isRead: false,
      isStarred: false,
      receivedAt: new Date(),
    })
    .onConflictDoNothing({ target: message.id });
}

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('AI enqueue contract', () => {
  it('stores hotel-From copy as outbound with zero triage runs', async () => {
    await withSeededTestDb(async (db) => {
      const storage = withFakeS3();
      const raw = readFixture('centurion-hotel-sent.eml');
      const messageId = generateMessageId();
      const parsed = await parseRawMessage(raw, { messageId, storage });
      await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: `uidl-${randomUUID()}`,
          messageId,
        },
        { db, storage },
      );

      const [msg] = await db.select().from(message).where(eq(message.id, messageId));
      expect(msg.direction).toBe('outbound');

      const runs = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(runs).toHaveLength(0);
    });
  });

  it('enqueues inbound_triage with promptVersion triage-v6 for guest From', async () => {
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
          pop3Uidl: `uidl-${randomUUID()}`,
          messageId,
        },
        { db, storage },
      );

      const [run] = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.triggerMessageId, messageId));
      expect(run.runKind).toBe('inbound_triage');
      expect(run.promptVersion).toBe('triage-v6');
    });
  });

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

      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: 'transport-centurion',
      });
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

        await seedCenturionThread(db);
        await db.insert(aiDraftGeneration).values({
          id: generationId,
          transportId,
          threadId,
          requestedByUserId: 'user-navaai',
          contextMessageIds: [inboundId],
          model: 'amazon.nova-lite-v1:0',
          promptVersion: 'draft-v1',
        });
        await db
          .insert(mailDraft)
          .values({
            id: draftId,
            transportId,
            threadId,
            createdByUserId: 'user-navaai',
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

        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-centurion',
        });
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
      const transportId = 'transport-centurion';
      const threadId = 'thread-centurion-1';
      const inboundId = 'msg-centurion-inbound-1';
      const draftId = randomUUID();
      const generationId = randomUUID();

      await seedCenturionThread(db);
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [inboundId],
        model: 'amazon.nova-lite-v1:0',
        promptVersion: 'draft-v1',
      });
      await db
        .insert(mailDraft)
        .values({
          id: draftId,
          transportId,
          threadId,
          createdByUserId: 'user-navaai',
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

      const failingSmtp = {
        send: async () => {
          throw new Error('smtp failure');
        },
      };
      __setSmtpTransportForTests(failingSmtp);

      try {
        const caller = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-centurion',
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
