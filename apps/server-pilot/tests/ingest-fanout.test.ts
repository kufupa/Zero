import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  attachment,
  mailIngestQuarantine,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import type { DB } from '../src/db/client.js';
import { candidateMessageIdForPop3Uidl, parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import {
  fanoutCopyPop3Uidl,
  persistFanoutCopies,
} from '../src/mail/ingest/fanout.js';
import { ingestOnce } from '../src/mail/ingest/worker.js';
import { FakePop3Client } from '../src/mail/ingest/pop3-client.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';

const ingestionDbAvailable =
  Boolean(process.env.TEST_DATABASE_URL?.trim()) &&
  process.env.CONFIRM_DISPOSABLE_TEST_DB === '1';

const INGEST_MAILBOX_ID = 'ingest-nava-legacy';
const CEN_ID = 'transport-centurion';
const DAV_ID = 'transport-davinci';
const FTH_ID = 'transport-faith';
const CEN_EMAIL = 'hotel-cen@example.test';
const DAV_EMAIL = 'hotel-dav@example.test';
const FTH_EMAIL = 'hotel-fth@example.test';

function syntheticFanoutEml(args: {
  from: string;
  to: string;
  subject: string;
  withAttachment?: boolean;
}): Buffer {
  if (!args.withAttachment) {
    return Buffer.from(
      [
        `From: ${args.from}`,
        `To: ${args.to}`,
        `Subject: ${args.subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Synthetic body.',
      ].join('\r\n'),
      'utf8',
    );
  }
  return Buffer.from(
    [
      `From: ${args.from}`,
      `To: ${args.to}`,
      `Subject: ${args.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="fanout-boundary"',
      '',
      '--fanout-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Synthetic body.',
      '--fanout-boundary',
      'Content-Type: application/octet-stream; name="note.bin"',
      'Content-Disposition: attachment; filename="note.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      'ZmFuLW91dA==',
      '--fanout-boundary--',
    ].join('\r\n'),
    'utf8',
  );
}

async function seedFanoutHotels(db: DB): Promise<void> {
  await db
    .update(mailboxTransport)
    .set({
      email: CEN_EMAIL,
      ownerHeaderValue: CEN_EMAIL,
      sendFromConfig: { aliases: ['hotel-cen-desk@example.test'] },
      isActive: true,
    })
    .where(eq(mailboxTransport.id, CEN_ID));
  await db.insert(mailboxTransport).values([
    {
      id: DAV_ID,
      email: DAV_EMAIL,
      ownerHeaderValue: DAV_EMAIL,
      mailboxType: 'personal',
      isActive: true,
      sendFromConfig: { aliases: ['hotel-dav-desk@example.test'] },
    },
    {
      id: FTH_ID,
      email: FTH_EMAIL,
      ownerHeaderValue: FTH_EMAIL,
      mailboxType: 'personal',
      isActive: true,
      sendFromConfig: { aliases: ['hotel-fth-desk@example.test'] },
    },
  ]);
}

async function persistPrimaryAndCopies(args: {
  db: DB;
  raw: Buffer;
  pop3Uidl: string;
  storage: FakeS3Storage;
}) {
  const messageId = candidateMessageIdForPop3Uidl(INGEST_MAILBOX_ID, args.pop3Uidl);
  const parsed = await parseRawMessage(args.raw, { messageId, storage: args.storage });
  const meta = {
    ingestMailboxId: INGEST_MAILBOX_ID,
    pop3Uidl: args.pop3Uidl,
    messageId,
  };
  const primary = await persistInboundMessage(parsed, args.raw, meta, {
    db: args.db,
    storage: args.storage,
    skipAiEnqueue: true,
  });
  let copies: Awaited<ReturnType<typeof persistFanoutCopies>> | undefined;
  if (
    primary.kind === 'stored' ||
    primary.kind === 'duplicate' ||
    primary.kind === 'reconciled'
  ) {
    copies = await persistFanoutCopies({
      db: args.db,
      storage: args.storage,
      raw: args.raw,
      meta: { ...meta, rawMimeS3Key: primary.rawMimeS3Key },
      transportIds: primary.fanoutTransportIds ?? [],
      skipAiEnqueue: true,
    });
  }
  return { primary, copies, messageId };
}

describe('mailbox fan-out copies without ingest db', () => {
  it('keeps copy UIDLs outside the RFC 1939 POP3 unique-id charset', () => {
    const copyUidl = fanoutCopyPop3Uidl('uidl-raw', DAV_ID);
    expect(copyUidl).not.toBe(`uidl-raw#t:${DAV_ID}`);
    expect([...copyUidl].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x21 || code > 0x7e;
    })).toBe(true);
  });

  it('claims the copy UIDL before parse and does not upload when the claim is not held', async () => {
    type QueryRows = unknown[];
    type SelectResult = Promise<QueryRows> & {
      for: () => SelectResult;
      limit: () => SelectResult;
      orderBy: () => SelectResult;
    };
    function queryResult(rows: QueryRows): SelectResult {
      const result = Promise.resolve(rows) as SelectResult;
      result.for = () => queryResult(rows);
      result.limit = () => queryResult(rows);
      result.orderBy = () => queryResult(rows);
      return result;
    }
    const db = {
      select: () => {
        const query = {
          from: () => query,
          where: () => queryResult([]),
          orderBy: () => queryResult([]),
          limit: () => queryResult([]),
          for: () => queryResult([]),
        };
        return query;
      },
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: async () => [],
          }),
        }),
      }),
    } as unknown as DB;
    const storage = new FakeS3Storage('fanout-claim-bucket');
    const raw = syntheticFanoutEml({
      from: 'guest@example.test',
      to: `${CEN_EMAIL}, ${DAV_EMAIL}`,
      subject: 'claim before parse',
      withAttachment: true,
    });
    const copies = await persistFanoutCopies({
      db,
      storage,
      raw,
      meta: {
        ingestMailboxId: INGEST_MAILBOX_ID,
        pop3Uidl: 'uidl-copy-unclaimed',
        messageId: candidateMessageIdForPop3Uidl(INGEST_MAILBOX_ID, 'uidl-copy-unclaimed'),
      },
      transportIds: [DAV_ID],
      skipAiEnqueue: true,
    });
    expect(copies.results).toHaveLength(1);
    expect(copies.results[0]?.result.kind).toBe('failed');
    if (copies.results[0]?.result.kind !== 'failed') return;
    expect(copies.results[0].result.code).toBe('claim_pending');
    expect(
      storage.calls.some((call) => call.op === 'PUT' && call.key.startsWith('attachments/')),
    ).toBe(false);
  });
});

describe.skipIf(!ingestionDbAvailable)('mailbox fan-out copies', () => {
  it('7. copy 2 fails keeps primary, no DELE, re-poll creates only copy 2', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-fanout-copy2-fail';
      const raw = syntheticFanoutEml({
        from: 'guest@example.test',
        to: `${CEN_EMAIL}, ${DAV_EMAIL}, ${FTH_EMAIL}`,
        subject: 'copy two fails',
        withAttachment: true,
      });
      const storage = new FakeS3Storage('fanout-copy2-bucket');
      resetS3Storage();
      setS3Storage(storage);
      const copy2Id = candidateMessageIdForPop3Uidl(
        INGEST_MAILBOX_ID,
        fanoutCopyPop3Uidl(pop3Uidl, FTH_ID),
      );
      const originalPut = storage.putObject.bind(storage);
      let failCopy2 = true;
      storage.putObject = async (opts) => {
        if (failCopy2 && opts.key.startsWith(`attachments/${copy2Id}/`)) {
          throw new Error('injected copy 2 attachment put failure');
        }
        return originalPut(opts);
      };
      const pop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });

      const first = await ingestOnce({
        pop3,
        db,
        ingestMailboxId: INGEST_MAILBOX_ID,
      });
      expect(first.deled).toBe(0);
      expect(first.items[0]?.status).toBe('deferred');
      const afterFirst = await db.select().from(message);
      expect(afterFirst).toHaveLength(2);
      expect(afterFirst.map((row) => row.transportId).sort()).toEqual([CEN_ID, DAV_ID]);
      expect(afterFirst.find((row) => row.transportId === CEN_ID)?.pop3Uidl).toBe(pop3Uidl);

      failCopy2 = false;
      const second = await ingestOnce({
        pop3,
        db,
        ingestMailboxId: INGEST_MAILBOX_ID,
      });
      expect(second.deled).toBe(1);
      const afterSecond = await db.select().from(message);
      expect(afterSecond).toHaveLength(3);
      expect(afterSecond.map((row) => row.transportId).sort()).toEqual([CEN_ID, DAV_ID, FTH_ID]);
      const copy2 = afterSecond.find((row) => row.transportId === FTH_ID);
      expect(copy2?.pop3Uidl).toBe(fanoutCopyPop3Uidl(pop3Uidl, FTH_ID));
      expect(copy2?.id).toBe(copy2Id);
    });
  });

  it('8. re-poll after success inserts 0 new rows', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-fanout-repoll';
      const storage = new FakeS3Storage('fanout-repoll-bucket');
      const raw = syntheticFanoutEml({
        from: 'guest@example.test',
        to: `${CEN_EMAIL}, ${DAV_EMAIL}, ${FTH_EMAIL}`,
        subject: 'repoll success',
      });
      const first = await persistPrimaryAndCopies({ db, raw, pop3Uidl, storage });
      expect(first.primary.kind).toBe('stored');
      expect(first.copies?.results.every((row) => row.result.kind === 'stored')).toBe(true);
      expect(await db.select().from(message)).toHaveLength(3);

      const second = await persistPrimaryAndCopies({ db, raw, pop3Uidl, storage });
      expect(second.primary.kind).toBe('duplicate');
      expect(second.copies?.results.every((row) => row.result.kind === 'duplicate')).toBe(true);
      expect(await db.select().from(message)).toHaveLength(3);
    });
  });

  it('9. copies use distinct attachment keys; cleanup of one leaves the other', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-fanout-attachments';
      const storage = new FakeS3Storage('fanout-attach-bucket');
      const raw = syntheticFanoutEml({
        from: 'guest@example.test',
        to: `${CEN_EMAIL}, ${DAV_EMAIL}`,
        subject: 'distinct attachment keys',
        withAttachment: true,
      });
      const { primary, copies } = await persistPrimaryAndCopies({
        db,
        raw,
        pop3Uidl,
        storage,
      });
      expect(primary.kind).toBe('stored');
      expect(copies?.results).toHaveLength(1);
      expect(copies?.results[0]?.result.kind).toBe('stored');
      const rows = await db.select().from(attachment);
      expect(rows).toHaveLength(2);
      const keys = rows.map((row) => row.s3Key).sort();
      expect(keys[0]).not.toBe(keys[1]);
      const prefixes = [...new Set(rows.map((row) => row.s3Key.split('/').slice(0, 2).join('/')))];
      expect(prefixes).toHaveLength(2);
      const [firstKey, secondKey] = keys;
      expect(storage.get(firstKey!)).toBeDefined();
      expect(storage.get(secondKey!)).toBeDefined();
      await storage.deleteObject(firstKey!);
      expect(storage.get(firstKey!)).toBeUndefined();
      expect(storage.get(secondKey!)).toBeDefined();
    });
  });

  it('copy persist never inserts quarantine when a copy UIDL is already quarantined', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-copy-existing-quarantine';
      const copyUidl = fanoutCopyPop3Uidl(pop3Uidl, DAV_ID);
      await db.insert(mailIngestQuarantine).values({
        id: randomUUID(),
        ingestMailboxId: INGEST_MAILBOX_ID,
        pop3Uidl: copyUidl,
        rawMimeS3Key: 'raw-mime/copy-existing',
        reason: 'multi_transport',
        ownerHeaderValue: null,
        parsedHeaders: null,
      });
      const storage = new FakeS3Storage('fanout-existing-quarantine');
      const copies = await persistFanoutCopies({
        db,
        storage,
        raw: syntheticFanoutEml({
          from: 'guest@example.test',
          to: `${CEN_EMAIL}, ${DAV_EMAIL}`,
          subject: 'existing copy quarantine',
        }),
        meta: {
          ingestMailboxId: INGEST_MAILBOX_ID,
          pop3Uidl,
          messageId: candidateMessageIdForPop3Uidl(INGEST_MAILBOX_ID, pop3Uidl),
        },
        transportIds: [DAV_ID],
        skipAiEnqueue: true,
      });
      expect(copies.results[0]?.result.kind).toBe('failed');
      if (copies.results[0]?.result.kind !== 'failed') return;
      expect(copies.results[0].result.code).toBe('existing_quarantine');
      expect(await db.select().from(mailIngestQuarantine)).toHaveLength(1);
      expect(await db.select().from(message)).toHaveLength(0);
    });
  });

  it('failed copy returns cleanup keys after parse', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-copy-fail-keys';
      const storage = new FakeS3Storage('fanout-fail-keys');
      const copies = await persistFanoutCopies({
        db,
        storage,
        raw: syntheticFanoutEml({
          from: 'guest@example.test',
          to: `${CEN_EMAIL}, ${DAV_EMAIL}`,
          subject: 'unresolved copy keys',
          withAttachment: true,
        }),
        meta: {
          ingestMailboxId: INGEST_MAILBOX_ID,
          pop3Uidl,
          messageId: candidateMessageIdForPop3Uidl(INGEST_MAILBOX_ID, pop3Uidl),
        },
        transportIds: ['transport-ayanda'],
        skipAiEnqueue: true,
      });
      expect(copies.results[0]?.result.kind).toBe('failed');
      if (copies.results[0]?.result.kind !== 'failed') return;
      expect(copies.results[0].result.code).toBe('unresolved_override');
      expect(copies.results[0].result.uploadedAttachmentKeys.length).toBeGreaterThan(0);
      const copyUidl = fanoutCopyPop3Uidl(pop3Uidl, 'transport-ayanda');
      const copyMessageId = candidateMessageIdForPop3Uidl(INGEST_MAILBOX_ID, copyUidl);
      expect(
        copies.results[0].result.uploadedAttachmentKeys.every((key) =>
          key.startsWith(`attachments/${copyMessageId}/`),
        ),
      ).toBe(true);
      expect(await db.select().from(mailIngestQuarantine)).toHaveLength(0);
    });
  });
});
