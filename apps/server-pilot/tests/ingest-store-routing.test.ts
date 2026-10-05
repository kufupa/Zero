import { describe, expect, it } from 'vitest';
import { mailboxTransport, message } from '../src/db/schema/mail.js';
import type { DB } from '../src/db/client.js';
import { parseRawMessage, generateMessageId } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { withIngestionDb } from './helpers/ingestion-db.js';

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

function dbWithGenericDirectToFallback(): {
  db: DB;
  mailboxTransportSelects: number;
  transactions: number;
} {
  let mailboxTransportSelects = 0;
  let transactions = 0;

  const db = {
    select: () => {
      let source: unknown;
      const rowsForQuery = () =>
        source === mailboxTransport && mailboxTransportSelects === 2
          ? [
              {
                id: 'transport-generic',
                email: 'generic@example.com',
                sendFromConfig: null,
              },
            ]
          : [];
      const rowsForQueryResult = () => queryResult(rowsForQuery());
      const query = {
        from: (table: unknown) => {
          source = table;
          if (source === mailboxTransport) mailboxTransportSelects += 1;
          return query;
        },
        where: () => rowsForQueryResult(),
        orderBy: () => rowsForQueryResult(),
        limit: () => rowsForQueryResult(),
        for: () => queryResult([]),
      };
      return query;
    },
    insert: () => ({ values: async () => undefined }),
    transaction: async (callback: (tx: DB) => Promise<unknown>) => {
      transactions += 1;
      // The pre-fix implementation reaches persistence after the second
      // mailboxTransport lookup. Do not model the rest of the insert here;
      // returning lets the buggy function report a stored result, which is
      // exactly what this regression must reject.
      if (mailboxTransportSelects === 2) return undefined;
      return callback(db as unknown as DB);
    },
  } as unknown as DB;

  return {
    db,
    get mailboxTransportSelects() {
      return mailboxTransportSelects;
    },
    get transactions() {
      return transactions;
    },
  };
}

describe('persistInboundMessage explicit transport override', () => {
  it('quarantines an unresolved override instead of using a generic direct-To route', async () => {
    const raw = Buffer.from(
      [
        'From: guest@example.com',
        'To: generic@example.com',
        'Subject: unresolved explicit route',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'This must not be stored under the generic route.',
      ].join('\r\n'),
      'utf8',
    );
    const storage = new FakeS3Storage('test-mail-bucket');
    const messageId = generateMessageId();
    const parsed = await parseRawMessage(raw, { messageId, storage });
    const fake = dbWithGenericDirectToFallback();

    const result = await persistInboundMessage(
      parsed,
      raw,
      {
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl: 'uidl-unresolved-explicit-route',
        messageId,
      },
      {
        db: fake.db,
        storage,
        skipAiEnqueue: true,
        transportOverride: 'transport-centurion',
      },
    );

    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.reason).toBe('unknown_transport');
    expect(fake.mailboxTransportSelects).toBe(1);
    expect(fake.transactions).toBe(1);
  });
});

describe('persistInboundMessage owner route stamps', () => {
  it('quarantines missing owner stamps before canonical insertion', async () =>
    withIngestionDb(async ({ db }) => {
      const storage = new FakeS3Storage('test-mail-bucket');
      const raw = Buffer.from(
        [
          'From: centurion@legacyhotels.co.za',
          'To: guest@example.com',
          'Subject: sender must not assign transport',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'No stamp and no trusted direct-To route.',
        ].join('\r\n'),
        'utf8',
      );
      const messageId = generateMessageId();
      const parsed = await parseRawMessage(raw, { messageId, storage });
      const result = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'uidl-missing-owner-stamp',
          messageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      expect(result.kind).toBe('quarantined');
      if (result.kind !== 'quarantined') return;
      expect(result.reason).toBe('missing_owner_header');
      expect(await db.select().from(message)).toHaveLength(0);
    }));

  it('quarantines forged owner stamps before canonical insertion', async () =>
    withIngestionDb(async ({ db }) => {
      const storage = new FakeS3Storage('test-mail-bucket');
      const raw = Buffer.from(
        [
          'From: guest@example.com',
          'To: centurion@legacyhotels.co.za',
          'X-Zero-Mailbox: forged-owner@example.test',
          'Subject: forged stamp',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Forged owner stamp must not choose a transport.',
        ].join('\r\n'),
        'utf8',
      );
      const messageId = generateMessageId();
      const parsed = await parseRawMessage(raw, { messageId, storage });
      const result = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'uidl-forged-owner-stamp',
          messageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      expect(result.kind).toBe('quarantined');
      if (result.kind !== 'quarantined') return;
      expect(result.reason).toBe('unknown_transport');
      expect(await db.select().from(message)).toHaveLength(0);
    }));

  it('quarantines conflicting owner stamps before canonical insertion', async () =>
    withIngestionDb(async ({ db }) => {
      const storage = new FakeS3Storage('test-mail-bucket');
      const raw = Buffer.from(
        [
          'From: guest@example.com',
          'To: centurion@legacyhotels.co.za',
          'X-Zero-Mailbox: centurion@legacyhotels.co.za',
          'X-Zero-Mailbox: forged-owner@example.test',
          'Subject: conflicting stamps',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Trusted relay stamp must not be overridden by a later forged stamp.',
        ].join('\r\n'),
        'utf8',
      );
      const messageId = generateMessageId();
      const parsed = await parseRawMessage(raw, { messageId, storage });
      const result = await persistInboundMessage(
        parsed,
        raw,
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'uidl-conflicting-owner-stamp',
          messageId,
        },
        { db, storage, skipAiEnqueue: true },
      );
      expect(result.kind).toBe('quarantined');
      if (result.kind !== 'quarantined') return;
      expect(result.reason).toBe('unknown_transport');
      expect(await db.select().from(message)).toHaveLength(0);
    }));
});
