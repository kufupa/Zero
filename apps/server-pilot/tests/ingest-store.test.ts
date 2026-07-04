import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mailIngestQuarantine,
  message,
  attachment,
  mailThread,
} from '../src/db/schema/mail';
import { parseRawMessage, generateMessageId } from '../src/mail/ingest/parse-message';
import { IngestTooLargeError } from '../src/mail/ingest/limits';
import {
  persistInboundMessage,
  quarantineOversizedMessage,
} from '../src/mail/ingest/store';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { readFixture } from './helpers/fixtures';

const reachable = await probeTestDb();

// Use a fresh fake S3 for each test so stored keys don't leak between tests.
// IMPORTANT: setS3Storage(fake) makes getS3Storage() return the fake for both
// the parse and persist layers. On EC2 (where S3_BUCKET/AWS_REGION are set)
// the default would otherwise be RealS3Storage, leaving the fake empty and
// the test's storage.assertions failing.
function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'inbound ingest (seeded, transaction-rollback)',
  () => {
    it(
      'routes stamped Centurion mail to Centurion transport',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-stamped.eml');
        // Persist + verify inside ONE seeded transaction so the verify sees
        // the rows the persist inserted (before rollback).
        const { result, stored, threadedId } = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, {
            messageId,
            storage,
          });
          expect(parsed.ownerHeaderValue).toBe('centurion@legacyhotel.com');
          const r = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-1',
              messageId,
            },
            { db, storage },
          );
          let row: typeof message.$inferSelect | undefined;
          if (r.kind === 'stored') {
            const rows = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            row = rows[0];
          }
          return { result: r, stored: row, threadedId: messageId };
        });

        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.transportId).toBe('transport-centurion');
        expect(result.messageId).toBe(threadedId);
        expect(result.threadId).toBeTruthy();
        expect(result.attachmentCount).toBe(0);

        // Verify the message row + raw-mime S3 key landed.
        expect(stored).toBeDefined();
        expect(stored!.transportId).toBe('transport-centurion');
        expect(stored!.direction).toBe('inbound');
        expect(stored!.pop3Uidl).toBe('uidl-1');
        expect(stored!.ownerHeaderValue).toBe('centurion@legacyhotel.com');
        expect(stored!.rawMimeS3Key).toBe(result.rawMimeS3Key);

        // Raw MIME was PUT to the fake S3 under raw-mime/.
        expect(storage.stored.has(result.rawMimeS3Key)).toBe(true);
        expect(result.rawMimeS3Key.startsWith('raw-mime/')).toBe(true);
      },
      30000,
    );

    it(
      'routes missing-header direct-To Nava mail to Nava spam',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('missing-owner.eml');
        const { result, stored, thread } = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          expect(parsed.ownerHeaderValue).toBeNull();
          expect(parsed.toAddresses).toContain('nava@legacyhotel.com');

          const r = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-direct-nava',
              messageId,
            },
            { db, storage },
          );

          if (r.kind !== 'stored') return { result: r, stored: undefined, thread: undefined };
          const messages = await db.select().from(message).where(eq(message.id, r.messageId));
          const threads = await db.select().from(mailThread).where(eq(mailThread.id, r.threadId));
          return { result: r, stored: messages[0], thread: threads[0] };
        });

        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.transportId).toBe('transport-nava');
        expect(stored!.ownerHeaderValue).toBeNull();
        expect(thread!.labelIds).toContain('label-spam-transport-nava');
      },
      30000,
    );

    it(
      'still quarantines missing-header mail with no known To address',
      async () => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          readFixture('missing-owner.eml')
            .toString('utf-8')
            .replace('To: nava@legacyhotel.com', 'To: unknown@example.com'),
          'utf-8',
        );

        const result = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          return persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-no-direct-match',
              messageId,
            },
            { db, storage },
          );
        });

        expect(result.kind).toBe('quarantined');
        if (result.kind !== 'quarantined') return;
        expect(result.reason).toBe('missing_owner_header');
      },
      30000,
    );

    it(
      'routes double-stamped mail using relay (last) X-Zero-Mailbox',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-double-stamp.eml');
        const { result, stored } = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, {
            messageId,
            storage,
          });
          expect(parsed.ownerHeaderValue).toBe('centurion@legacyhotel.com');
          const r = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-double-stamp',
              messageId,
            },
            { db, storage },
          );
          let row: typeof message.$inferSelect | undefined;
          if (r.kind === 'stored') {
            const rows = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            row = rows[0];
          }
          return { result: r, stored: row };
        });

        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.transportId).toBe('transport-centurion');
        expect(stored).toBeDefined();
        expect(stored!.transportId).toBe('transport-centurion');
        expect(stored!.ownerHeaderValue).toBe('centurion@legacyhotel.com');
      },
      30000,
    );

    it(
      'quarantines unknown transport with reason unknown_transport',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-stamped.eml');
        // Mutate the header to point at a transport that does not exist.
        const mutated = Buffer.from(
          raw
            .toString('utf-8')
            .replace(
              'X-Zero-Mailbox: centurion@legacyhotel.com',
              'X-Zero-Mailbox: nope@legacyhotel.com',
            ),
          'utf-8',
        );
        const result = await withSeededTestDb(async (db) => {
          const parsed = await parseRawMessage(mutated, {
            messageId: generateMessageId(),
            storage,
          });
          expect(parsed.ownerHeaderValue).toBe('nope@legacyhotel.com');
          return persistInboundMessage(
            parsed,
            mutated,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-3',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
        });
        expect(result.kind).toBe('quarantined');
        if (result.kind !== 'quarantined') return;
        expect(result.reason).toBe('unknown_transport');
      },
      30000,
    );

    it(
      'streams an attachment to S3 and records an attachment row',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-attachment.eml');
        const { result, attRows, threadedId } = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          expect(parsed.attachments.length).toBe(1);
          expect(parsed.attachments[0]!.filename).toBe('invoice-003.pdf');
          const r = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-4',
              messageId,
            },
            { db, storage },
          );
          let rows: typeof attachment.$inferSelect[] = [];
          if (r.kind === 'stored') {
            rows = await db
              .select()
              .from(attachment)
              .where(eq(attachment.messageId, r.messageId));
          }
          return { result: r, attRows: rows, threadedId: messageId };
        });
        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.attachmentCount).toBe(1);
        // The DB message.id MUST equal the threaded id (no regeneration).
        expect(result.messageId).toBe(threadedId);

        // Attachment S3 key under attachments/.
        const storedAttachment = storage.listKeys('attachments/');
        expect(storedAttachment.length).toBe(1);
        expect(storedAttachment[0]!.startsWith('attachments/')).toBe(true);
        // S3 attachment key prefix MUST equal the DB message.id
        // (attachments/{message.id}/...). This is the contract being verified.
        expect(storedAttachment[0]!.startsWith(`attachments/${threadedId}/`)).toBe(true);

        // Attachment row in DB (read in the same tx before rollback).
        expect(attRows.length).toBe(1);
        expect(attRows[0]!.filename).toBe('invoice-003.pdf');
        expect(attRows[0]!.mimeType).toBe('application/pdf');
        expect(attRows[0]!.s3Key).toBe(storedAttachment[0]);
        expect(attRows[0]!.sizeBytes).toBeGreaterThan(0);
      },
      30000,
    );

    it(
      'treats a duplicate UIDL as safe-to-drain without re-inserting (inbound index)',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-stamped.eml');
        // First + second insert in ONE transaction so the duplicate check
        // sees the first insert's row.
        const { first, second } = await withSeededTestDb(async (db) => {
          const parsed1 = await parseRawMessage(raw, {
            messageId: generateMessageId(),
            storage,
          });
          const f = await persistInboundMessage(
            parsed1,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-dup',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
          const parsed2 = await parseRawMessage(raw, {
            messageId: generateMessageId(),
            storage,
          });
          const s = await persistInboundMessage(
            parsed2,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-dup',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
          return { first: f, second: s };
        });

        expect(first.kind).toBe('stored');
        if (first.kind !== 'stored') return;

        // Second insert with the SAME UIDL — must be reported as duplicate.
        expect(second.kind).toBe('duplicate');
        if (second.kind !== 'duplicate') return;
        expect(second.messageId).toBe(first.messageId);
      },
      30000,
    );

    it(
      'quarantines oversized attachment without leaving a partial message row',
      async () => {
        const prevAttach = process.env.INGEST_MAX_ATTACHMENT_BYTES;
        process.env.INGEST_MAX_ATTACHMENT_BYTES = '50';
        try {
          const storage = withFakeS3();
          const raw = readFixture('centurion-attachment.eml');
          const { result, msgRows, qRow } = await withSeededTestDb(async (db) => {
            const messageId = generateMessageId();
            await expect(
              parseRawMessage(raw, { messageId, storage }),
            ).rejects.toBeInstanceOf(IngestTooLargeError);

            const rawMimeS3Key =
              'raw-mime/ingest-nava-legacy/test/oversized.eml';
            const r = await quarantineOversizedMessage(
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-oversized',
              },
              rawMimeS3Key,
              { db },
            );
            const msgs = await db
              .select()
              .from(message)
              .where(eq(message.pop3Uidl, 'uidl-oversized'));
            const qs = await db
              .select()
              .from(mailIngestQuarantine)
              .where(eq(mailIngestQuarantine.id, r.quarantineId));
            return { result: r, msgRows: msgs, qRow: qs[0] };
          });

          expect(result.kind).toBe('quarantined');
          if (result.kind !== 'quarantined') return;
          expect(result.reason).toBe('message_too_large');
          expect(msgRows.length).toBe(0);
          expect(qRow).toBeDefined();
          expect(qRow!.reason).toBe('message_too_large');
          expect(qRow!.pop3Uidl).toBe('uidl-oversized');
        } finally {
          if (prevAttach === undefined) {
            delete process.env.INGEST_MAX_ATTACHMENT_BYTES;
          } else {
            process.env.INGEST_MAX_ATTACHMENT_BYTES = prevAttach;
          }
        }
      },
      30000,
    );

    it(
      'quarantine redelivery is idempotent for same ingest UIDL',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('missing-owner.eml');
        const { first, second } = await withSeededTestDb(async (db) => {
          const parsed = await parseRawMessage(raw, {
            messageId: generateMessageId(),
            storage,
          });
          const f = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-q-dup',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
          const s = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-q-dup',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
          return { first: f, second: s };
        });

        expect(first.kind).toBe('quarantined');
        expect(second.kind).toBe('quarantined');
        if (first.kind === 'quarantined' && second.kind === 'quarantined') {
          expect(second.quarantineId).toBe(first.quarantineId);
          expect(second.reason).toBe('missing_owner_header');
        }
      },
      30000,
    );

    it(
      'rawMimeKey is deterministic for ingest mailbox + UIDL',
      async () => {
        const { rawMimeKey } = await import('../src/storage/s3.js');
        const a = rawMimeKey({
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'uidl-stable',
        });
        const b = rawMimeKey({
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'uidl-stable',
        });
        expect(a).toBe(b);
        expect(a).toBe('raw-mime/ingest-nava-legacy/uidl-stable.eml');
      },
    );
  },
);

// A pure unit test (no DB) — parse only, no persist.
describe('parseRawMessage (no DB)', () => {
  it('extracts X-Zero-Mailbox and address fields', async () => {
    const storage = withFakeS3();
    const raw = readFixture('centurion-stamped.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.ownerHeaderValue).toBe('centurion@legacyhotel.com');
    expect(parsed.fromAddress).toBe('guest1@example.com');
    expect(parsed.toAddresses).toContain('centurion@legacyhotel.com');
    expect(parsed.ccAddresses).toContain('frontdesk@legacyhotel.com');
    expect(parsed.subject).toBe('Centurion booking confirmation #4471');
    expect(parsed.messageId).toBe('centurion-001@legacyhotel.com');
    expect(parsed.attachments.length).toBe(0);
    expect(parsed.textBody).toContain('Booking #4471');
  });

  it('uses last X-Zero-Mailbox when header appears twice', async () => {
    const storage = withFakeS3();
    const raw = readFixture('centurion-double-stamp.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.ownerHeaderValue).toBe('centurion@legacyhotel.com');
  });

  it('returns null ownerHeaderValue when header missing', async () => {
    const storage = withFakeS3();
    const raw = readFixture('missing-owner.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.ownerHeaderValue).toBeNull();
  });

  it('decodes base64 attachment and streams to S3', async () => {
    const storage = withFakeS3();
    const raw = readFixture('centurion-attachment.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.attachments.length).toBe(1);
    const att = parsed.attachments[0]!;
    expect(att.filename).toBe('invoice-003.pdf');
    expect(att.mimeType).toBe('application/pdf');
    // S3 received a PUT under attachments/.
    const keys = storage.listKeys('attachments/');
    expect(keys.length).toBe(1);
    const stored = storage.get(keys[0]!)!;
    // Decoded PDF starts with `%PDF`.
    expect(stored.slice(0, 4).toString('latin1')).toBe('%PDF');
    expect(att.sizeBytes).toBe(stored.byteLength);
  });

  it('rejects oversized attachments via streamToBuffer limit', async () => {
    const prevAttach = process.env.INGEST_MAX_ATTACHMENT_BYTES;
    process.env.INGEST_MAX_ATTACHMENT_BYTES = '50';
    try {
      const storage = withFakeS3();
      const raw = readFixture('centurion-attachment.eml');
      await expect(
        parseRawMessage(raw, {
          messageId: generateMessageId(),
          storage,
        }),
      ).rejects.toBeInstanceOf(IngestTooLargeError);
      expect(storage.listKeys('attachments/').length).toBe(0);
    } finally {
      if (prevAttach === undefined) {
        delete process.env.INGEST_MAX_ATTACHMENT_BYTES;
      } else {
        process.env.INGEST_MAX_ATTACHMENT_BYTES = prevAttach;
      }
    }
  });
});
