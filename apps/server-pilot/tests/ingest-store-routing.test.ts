import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mailIngestQuarantine,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import type { DB } from '../src/db/client.js';
import {
  parseRawMessage,
  generateMessageId,
  candidateMessageIdForPop3Uidl,
  type ParsedInboundMessage,
} from '../src/mail/ingest/parse-message.js';
import {
  isStampCorroborated,
  persistInboundMessage,
  resolveTransportMatch,
  type TransportMatchCandidate,
} from '../src/mail/ingest/store.js';
import {
  fanoutCopyPop3Uidl,
  persistFanoutCopies,
} from '../src/mail/ingest/fanout.js';
import { FakeS3Storage } from '../src/storage/s3.js';

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

const HOTEL_A: TransportMatchCandidate = {
  id: 'transport-hotel-a',
  email: 'hotel-a@example.test',
  sendFromConfig: { aliases: ['hotel-a-desk@example.test'] },
};

const HOTEL_B: TransportMatchCandidate = {
  id: 'transport-hotel-b',
  email: 'hotel-b@example.test',
  sendFromConfig: { aliases: ['hotel-b-desk@example.test'] },
};

function syntheticEml(args: {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  ownerHeader?: string;
  extraHeaders?: string[];
  subject: string;
}): Buffer {
  const lines = [`From: ${args.from}`, `To: ${args.to}`];
  if (args.cc) lines.push(`Cc: ${args.cc}`);
  if (args.bcc) lines.push(`Bcc: ${args.bcc}`);
  if (args.ownerHeader) lines.push(`X-Zero-Mailbox: ${args.ownerHeader}`);
  if (args.extraHeaders) lines.push(...args.extraHeaders);
  lines.push(
    `Subject: ${args.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Synthetic body.',
  );
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

function withIngestOwnerHeaderEnv(
  value: string,
  run: () => Promise<void>,
): Promise<void> {
  const prev = process.env.INGEST_REQUIRE_OWNER_HEADER;
  process.env.INGEST_REQUIRE_OWNER_HEADER = value;
  return run().finally(() => {
    if (prev === undefined) delete process.env.INGEST_REQUIRE_OWNER_HEADER;
    else process.env.INGEST_REQUIRE_OWNER_HEADER = prev;
  });
}

function parsedForStamp(overrides: Partial<ParsedInboundMessage> = {}): ParsedInboundMessage {
  return {
    ownerHeaderValue: HOTEL_A.email,
    outboundCorrelation: { kind: 'absent' },
    messageId: null,
    inReplyTo: null,
    references: [],
    fromAddress: 'guest@example.test',
    toAddresses: [],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'synthetic',
    textBody: null,
    htmlBody: null,
    receivedAt: null,
    deliveredAt: null,
    attachments: [],
    rawHeaderLines: [],
    ...overrides,
  };
}

async function persistSynthetic(
  raw: Buffer,
  pop3Uidl: string,
  db: DB,
): Promise<Awaited<ReturnType<typeof persistInboundMessage>>> {
  const storage = new FakeS3Storage('test-mail-bucket');
  const messageId = generateMessageId();
  const parsed = await parseRawMessage(raw, { messageId, storage });
  return persistInboundMessage(
    parsed,
    raw,
    { ingestMailboxId: 'ingest-nava-legacy', pop3Uidl, messageId },
    { db, storage, skipAiEnqueue: true },
  );
}

function dbWithActiveTransports(
  transports: Array<
    TransportMatchCandidate & {
      ownerHeaderValue?: string;
    }
  >,
): { db: DB } {
  const db = {
    select: () => {
      let source: unknown;
      const rowsForQuery = () => (source === mailboxTransport ? transports : []);
      const rowsForQueryResult = () => queryResult(rowsForQuery());
      const query = {
        from: (table: unknown) => {
          source = table;
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
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    execute: async () => undefined,
    transaction: async () => ({
      failureCount: 0,
      claimedTaskCount: 0,
      selectedTaskCount: 0,
      deletedTaskCount: 0,
      canContinue: false,
    }),
  } as unknown as DB;
  return { db };
}

const ingestionDbAvailable =
  Boolean(process.env.TEST_DATABASE_URL?.trim()) &&
  process.env.CONFIRM_DISPOSABLE_TEST_DB === '1';

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

describe.skipIf(!ingestionDbAvailable)('persistInboundMessage owner route stamps', () => {
  it('quarantines missing owner stamps before canonical insertion', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
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
    });
  });

  it('quarantines forged owner stamps before canonical insertion', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
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
    });
  });

  it('quarantines conflicting owner stamps before canonical insertion', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
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
    });
  });
});

describe('isStampCorroborated', () => {
  it('accepts To naming the stamped transport', () => {
    expect(
      isStampCorroborated(HOTEL_A, parsedForStamp({ toAddresses: [HOTEL_A.email] })),
    ).toBe(true);
  });

  it('accepts a To alias from send_from_config', () => {
    expect(
      isStampCorroborated(
        HOTEL_A,
        parsedForStamp({ toAddresses: ['hotel-a-desk@example.test'] }),
      ),
    ).toBe(true);
  });

  it('accepts Cc naming the stamped transport', () => {
    expect(
      isStampCorroborated(HOTEL_A, parsedForStamp({ ccAddresses: [HOTEL_A.email] })),
    ).toBe(true);
  });

  it('accepts Bcc naming the stamped transport', () => {
    expect(
      isStampCorroborated(HOTEL_A, parsedForStamp({ bccAddresses: [HOTEL_A.email] })),
    ).toBe(true);
  });

  it('accepts From equal to the stamped transport', () => {
    expect(
      isStampCorroborated(HOTEL_A, parsedForStamp({ fromHeaderAddress: HOTEL_A.email })),
    ).toBe(true);
  });

  it('accepts From equal to a send_from_config alias', () => {
    expect(
      isStampCorroborated(
        HOTEL_A,
        parsedForStamp({ fromHeaderAddress: 'hotel-a-desk@example.test' }),
      ),
    ).toBe(true);
  });

  it('does not corroborate Sender-substituted fromAddress when From is a guest', () => {
    expect(
      isStampCorroborated(
        HOTEL_A,
        parsedForStamp({
          fromAddress: HOTEL_A.email,
          fromHeaderAddress: 'guest@example.test',
          toAddresses: [HOTEL_B.email],
        }),
      ),
    ).toBe(false);
  });

  it('does not fall back to fromAddress when fromHeaderAddress is absent', () => {
    expect(
      isStampCorroborated(HOTEL_A, parsedForStamp({ fromAddress: HOTEL_A.email })),
    ).toBe(false);
  });

  it('rejects Delivered-To naming the stamped transport (sender-forgeable)', () => {
    expect(
      isStampCorroborated(
        HOTEL_A,
        parsedForStamp({
          rawHeaderLines: [
            { key: 'delivered-to', line: `Delivered-To: ${HOTEL_A.email}` },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects X-Original-To naming the stamped transport (sender-forgeable)', () => {
    expect(
      isStampCorroborated(
        HOTEL_A,
        parsedForStamp({
          rawHeaderLines: [
            { key: 'x-original-to', line: `X-Original-To: Desk <${HOTEL_A.email}>` },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects a stamp with no matching To/Cc/Bcc/From identity', () => {
    expect(
      isStampCorroborated(
        HOTEL_A,
        parsedForStamp({
          fromAddress: 'guest@example.test',
          toAddresses: ['guest-copy@example.test'],
          rawHeaderLines: [
            { key: 'delivered-to', line: 'Delivered-To: sink@example.test' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('does not treat another hotel as corroboration', () => {
    expect(
      isStampCorroborated(HOTEL_A, parsedForStamp({ toAddresses: [HOTEL_B.email] })),
    ).toBe(false);
  });

  // Invariant: stamp may only select a transport unstamped routing would
  // also accept from the same parsed To/Cc/Bcc/From. Envelope headers
  // cannot move mail to a hotel those fields do not name.
  it('never corroborates a hotel absent from To/Cc/Bcc/From', () => {
    expect(
      isStampCorroborated(
        HOTEL_A,
        parsedForStamp({
          toAddresses: [HOTEL_B.email],
          rawHeaderLines: [
            { key: 'delivered-to', line: `Delivered-To: ${HOTEL_A.email}` },
            { key: 'x-original-to', line: `X-Original-To: ${HOTEL_A.email}` },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe('resolveTransportMatch', () => {
  it('routes a unique alias to that transport', () => {
    expect(resolveTransportMatch([HOTEL_A, HOTEL_B], ['hotel-a-desk@example.test'])).toEqual({
      kind: 'unique',
      transport: HOTEL_A,
    });
  });

  it('treats several of one transport own aliases as unique', () => {
    expect(
      resolveTransportMatch(
        [HOTEL_A, HOTEL_B],
        ['hotel-a@example.test', 'hotel-a-desk@example.test'],
      ),
    ).toEqual({ kind: 'unique', transport: HOTEL_A });
  });

  it('returns none when no identity matches', () => {
    expect(resolveTransportMatch([HOTEL_A, HOTEL_B], ['guest@example.test'])).toEqual({
      kind: 'none',
    });
  });

  it('returns none for empty addresses', () => {
    expect(resolveTransportMatch([HOTEL_A], [])).toEqual({ kind: 'none' });
  });

  it('quarantine-shape ambiguous when one identity matches two transports', () => {
    const shared: TransportMatchCandidate = {
      id: 'transport-hotel-b',
      email: 'hotel-b@example.test',
      sendFromConfig: { aliases: ['hotel-a-desk@example.test'] },
    };
    expect(resolveTransportMatch([HOTEL_A, shared], ['hotel-a-desk@example.test'])).toEqual({
      kind: 'ambiguous',
      ids: ['transport-hotel-a', 'transport-hotel-b'],
    });
  });

  it('quarantine-shape multi when different addresses match distinct transports', () => {
    expect(
      resolveTransportMatch(
        [HOTEL_A, HOTEL_B],
        ['hotel-a@example.test', 'hotel-b@example.test'],
      ),
    ).toEqual({
      kind: 'multi',
      ids: ['transport-hotel-a', 'transport-hotel-b'],
    });
  });

  it('does not match by domain or suffix', () => {
    expect(resolveTransportMatch([HOTEL_A], ['desk@example.test'])).toEqual({ kind: 'none' });
    expect(resolveTransportMatch([HOTEL_A], ['hotel-a@example.test.extra'])).toEqual({
      kind: 'none',
    });
  });

  it('normalizes case and angle-addr wrapping', () => {
    expect(resolveTransportMatch([HOTEL_A], ['Hotel-A-Desk@Example.TEST'])).toEqual({
      kind: 'unique',
      transport: HOTEL_A,
    });
    expect(resolveTransportMatch([HOTEL_A], ['Desk <hotel-a@example.test>'])).toEqual({
      kind: 'unique',
      transport: HOTEL_A,
    });
  });
});

describe('persistInboundMessage fail-closed transport match', () => {
  it('routes unique alias on To', async () => {
    const fake = dbWithActiveTransports([{ ...HOTEL_A, ownerHeaderValue: HOTEL_A.email }]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-a-desk@example.test',
        subject: 'unique alias route',
      }),
      'uidl-unique-alias',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_A.id);
  });

  it('routes when several of one transport own aliases appear on To', async () => {
    const fake = dbWithActiveTransports([{ ...HOTEL_A, ownerHeaderValue: HOTEL_A.email }]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-a@example.test, hotel-a-desk@example.test',
        subject: 'own alias duplicates',
      }),
      'uidl-own-alias-dupes',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_A.id);
  });

  it('quarantines To two hotels as multi_transport', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-a@example.test, hotel-b@example.test',
        subject: 'two hotels',
      }),
      'uidl-multi-transport',
      fake.db,
    );
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.reason).toBe('multi_transport');
  });

  it('quarantines a shared alias as ambiguous_transport', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      {
        ...HOTEL_B,
        sendFromConfig: { aliases: ['hotel-a-desk@example.test'] },
        ownerHeaderValue: HOTEL_B.email,
      },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-a-desk@example.test',
        subject: 'shared alias',
      }),
      'uidl-ambiguous-alias',
      fake.db,
    );
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.reason).toBe('ambiguous_transport');
  });

  it('ignores unique owner header when recipients do not name that transport', async () => {
    const fake = dbWithActiveTransports([{ ...HOTEL_A, ownerHeaderValue: HOTEL_A.email }]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'guest-copy@example.test',
        ownerHeader: 'hotel-a@example.test',
        subject: 'unique owner header',
      }),
      'uidl-unique-owner-header',
      fake.db,
    );
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.reason).toBe('missing_owner_header');
  });

  it('stores forged stamp for hotel A on mail To hotel B only under B, never A', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: HOTEL_B.email,
        ownerHeader: HOTEL_A.email,
        subject: 'forged stamp onto other hotel',
      }),
      'uidl-forged-stamp-to-b',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_B.id);
  });

  it('stores To B plus stamp A plus X-Original-To A under B, never A', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: HOTEL_B.email,
        ownerHeader: HOTEL_A.email,
        extraHeaders: [`X-Original-To: ${HOTEL_A.email}`],
        subject: 'forged original-to onto other hotel',
      }),
      'uidl-forged-x-original-to-a',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_B.id);
  });

  it('does not fan out a copy to a hotel named only in Sender', async () => {
    const cen = {
      id: 'transport-centurion',
      email: 'hotel-cen@example.test',
      sendFromConfig: null,
    };
    const fth = {
      id: 'transport-faith',
      email: 'hotel-fth@example.test',
      sendFromConfig: null,
    };
    const fake = dbWithActiveTransports([
      { ...cen, ownerHeaderValue: cen.email },
      { ...fth, ownerHeaderValue: fth.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: cen.email,
        extraHeaders: [`Sender: ${fth.email}`],
        subject: 'sender only is not a copy',
      }),
      'uidl-sender-only-no-copy',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(cen.id);
    expect(result.fanoutTransportIds ?? []).toEqual([]);
  });

  it('does not copy a Cc alias shared by two other hotels', async () => {
    const cen = {
      id: 'transport-centurion',
      email: 'hotel-cen@example.test',
      sendFromConfig: null,
    };
    const dav = {
      id: 'transport-davinci',
      email: 'hotel-dav@example.test',
      sendFromConfig: { aliases: ['shared-desk@example.test'] },
    };
    const fth = {
      id: 'transport-faith',
      email: 'hotel-fth@example.test',
      sendFromConfig: { aliases: ['shared-desk@example.test'] },
    };
    const fake = dbWithActiveTransports([
      { ...cen, ownerHeaderValue: cen.email },
      { ...dav, ownerHeaderValue: dav.email },
      { ...fth, ownerHeaderValue: fth.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: cen.email,
        cc: 'shared-desk@example.test',
        subject: 'shared alias is not a copy',
      }),
      'uidl-shared-alias-no-copy',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(cen.id);
    expect(result.fanoutTransportIds ?? []).toEqual([]);
  });

  it('copy persist never inserts quarantine when the override cannot resolve', async () => {
    let quarantineInserts = 0;
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
    ]);
    const db = {
      ...fake.db,
      insert: (table: unknown) => ({
        values: async () => {
          if (table === mailIngestQuarantine) quarantineInserts += 1;
          return undefined;
        },
      }),
    } as unknown as DB;
    const storage = new FakeS3Storage('test-mail-bucket');
    const raw = syntheticEml({
      from: 'guest@example.test',
      to: HOTEL_A.email,
      subject: 'copy unresolved override',
    });
    const messageId = generateMessageId();
    const parsed = await parseRawMessage(raw, { messageId, storage });
    const result = await persistInboundMessage(
      parsed,
      raw,
      {
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl: 'uidl-copy-no-quarantine',
        messageId,
      },
      {
        db,
        storage,
        skipAiEnqueue: true,
        fanoutCopy: true,
        transportOverride: 'transport-missing',
      },
    );
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.code).toBe('unresolved_override');
    expect(quarantineInserts).toBe(0);
  });

  it('failed copy persist returns uploaded attachment keys', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
    ]);
    const storage = new FakeS3Storage('test-mail-bucket');
    const raw = Buffer.from(
      [
        'From: guest@example.test',
        `To: ${HOTEL_A.email}`,
        'Subject: copy fail keys',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Synthetic body.',
        '--b1',
        'Content-Type: application/octet-stream; name="note.bin"',
        'Content-Disposition: attachment; filename="note.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        'ZmFuLW91dA==',
        '--b1--',
      ].join('\r\n'),
      'utf8',
    );
    const messageId = generateMessageId();
    const parsed = await parseRawMessage(raw, { messageId, storage });
    expect(parsed.attachments.length).toBeGreaterThan(0);
    const result = await persistInboundMessage(
      parsed,
      raw,
      {
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl: 'uidl-copy-fail-keys',
        messageId,
      },
      {
        db: fake.db,
        storage,
        skipAiEnqueue: true,
        fanoutCopy: true,
        transportOverride: 'transport-missing',
      },
    );
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.code).toBe('unresolved_override');
    expect(result.uploadedAttachmentKeys.length).toBeGreaterThan(0);
    expect(
      result.uploadedAttachmentKeys.every((key) => key.startsWith(`attachments/${messageId}/`)),
    ).toBe(true);
  });

  it('keeps fromHeaderAddress on From when Sender differs', async () => {
    const parsed = await parseRawMessage(
      syntheticEml({
        from: 'guest@example.test',
        to: HOTEL_B.email,
        ownerHeader: HOTEL_A.email,
        extraHeaders: [`Sender: ${HOTEL_A.email}`],
        subject: 'sender vs from header',
      }),
      { messageId: generateMessageId(), storage: new FakeS3Storage('test-mail-bucket') },
    );
    expect(parsed.fromHeaderAddress).toBe('guest@example.test');
    expect(parsed.fromAddress).toBe(HOTEL_A.email);
  });

  it('stores From guest Sender A To B stamp A under B, never A', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: HOTEL_B.email,
        ownerHeader: HOTEL_A.email,
        extraHeaders: [`Sender: ${HOTEL_A.email}`],
        subject: 'sender stamp onto other hotel',
      }),
      'uidl-sender-stamp-to-b',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_B.id);
  });

  it('quarantines uncorroborated stamp when INGEST_REQUIRE_OWNER_HEADER is true', async () => {
    await withIngestOwnerHeaderEnv('true', async () => {
      const fake = dbWithActiveTransports([
        { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
        { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
      ]);
      const result = await persistSynthetic(
        syntheticEml({
          from: HOTEL_B.email,
          to: 'guest@example.test',
          ownerHeader: HOTEL_A.email,
          subject: 'uncorroborated stamp require header',
        }),
        'uidl-uncorroborated-require-true',
        fake.db,
      );
      expect(result.kind).toBe('quarantined');
      if (result.kind !== 'quarantined') return;
      expect(result.reason).toBe('missing_owner_header');
    });
  });

  it('routes uncorroborated stamp via equated From when INGEST_REQUIRE_OWNER_HEADER is false', async () => {
    await withIngestOwnerHeaderEnv('false', async () => {
      const fake = dbWithActiveTransports([
        { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
        { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
      ]);
      const result = await persistSynthetic(
        syntheticEml({
          from: HOTEL_B.email,
          to: 'guest@example.test',
          ownerHeader: HOTEL_A.email,
          subject: 'uncorroborated stamp relaxed header',
        }),
        'uidl-uncorroborated-require-false',
        fake.db,
      );
      expect(result.kind).toBe('stored');
      if (result.kind !== 'stored') return;
      expect(result.transportId).toBe(HOTEL_B.id);
    });
  });

  it('stores To B plus stamp A plus Delivered-To A under B, never A', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: HOTEL_B.email,
        ownerHeader: HOTEL_A.email,
        extraHeaders: [`Delivered-To: ${HOTEL_A.email}`],
        subject: 'forged delivered-to onto other hotel',
      }),
      'uidl-forged-delivered-to-a',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_B.id);
  });

  it('routes stamp A plus To A to A', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: HOTEL_A.email,
        ownerHeader: HOTEL_A.email,
        subject: 'corroborated stamp',
      }),
      'uidl-stamp-and-to-a',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_A.id);
  });

  it('stores corroborated stamp A when To names A and B', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: `${HOTEL_A.email}, ${HOTEL_B.email}`,
        ownerHeader: HOTEL_A.email,
        subject: 'stamp before multi',
      }),
      'uidl-stamp-multi',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_A.id);
  });

  it('routes own outbound echo with stamp to the sending transport', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      { ...HOTEL_B, ownerHeaderValue: HOTEL_B.email },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: HOTEL_A.email,
        to: 'guest@example.test',
        ownerHeader: HOTEL_A.email,
        subject: 'own outbound echo',
      }),
      'uidl-outbound-echo-stamp',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_A.id);
  });

  it('routes outbound echo corroborated only by Bcc', async () => {
    const fake = dbWithActiveTransports([{ ...HOTEL_A, ownerHeaderValue: HOTEL_A.email }]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'guest-copy@example.test',
        bcc: HOTEL_A.email,
        ownerHeader: HOTEL_A.email,
        subject: 'bcc corroborates stamp',
      }),
      'uidl-bcc-stamp',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_A.id);
  });

  it('quarantines unknown owner header as unknown_transport', async () => {
    const fake = dbWithActiveTransports([{ ...HOTEL_A, ownerHeaderValue: HOTEL_A.email }]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-a@example.test',
        ownerHeader: 'nobody@example.test',
        subject: 'unknown owner header',
      }),
      'uidl-unknown-owner-header',
      fake.db,
    );
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.reason).toBe('unknown_transport');
  });

  it('quarantines owner header that matches two identity sets as ambiguous_transport', async () => {
    const fake = dbWithActiveTransports([
      { ...HOTEL_A, ownerHeaderValue: HOTEL_A.email },
      {
        ...HOTEL_B,
        sendFromConfig: { aliases: [HOTEL_A.email] },
        ownerHeaderValue: HOTEL_B.email,
      },
    ]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'guest-copy@example.test',
        ownerHeader: HOTEL_A.email,
        subject: 'owner header identity clash',
      }),
      'uidl-owner-header-ambiguous',
      fake.db,
    );
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') return;
    expect(result.reason).toBe('ambiguous_transport');
  });
});

const INGEST_MAILBOX_ID = 'ingest-nava-legacy';
const CEN_ID = 'transport-centurion';
const DAV_ID = 'transport-davinci';
const FTH_ID = 'transport-faith';
const OTHER_ID = 'transport-other';
const CEN_EMAIL = 'hotel-cen@example.test';
const DAV_EMAIL = 'hotel-dav@example.test';
const FTH_EMAIL = 'hotel-fth@example.test';
const OTHER_EMAIL = 'hotel-other@example.test';

async function seedFanoutHotels(
  db: DB,
  extra?: { other?: boolean; sharedDavOnFaith?: boolean },
): Promise<void> {
  await db
    .update(mailboxTransport)
    .set({
      email: CEN_EMAIL,
      ownerHeaderValue: CEN_EMAIL,
      sendFromConfig: { aliases: ['hotel-cen-desk@example.test'] },
      isActive: true,
    })
    .where(eq(mailboxTransport.id, CEN_ID));
  await db
    .insert(mailboxTransport)
    .values([
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
        sendFromConfig: extra?.sharedDavOnFaith
          ? { aliases: [DAV_EMAIL] }
          : { aliases: ['hotel-fth-desk@example.test'] },
      },
    ]);
  if (extra?.other) {
    await db.insert(mailboxTransport).values({
      id: OTHER_ID,
      email: OTHER_EMAIL,
      ownerHeaderValue: OTHER_EMAIL,
      mailboxType: 'personal',
      isActive: true,
      sendFromConfig: null,
    });
  }
}

async function persistPrimaryAndCopies(args: {
  db: DB;
  raw: Buffer;
  pop3Uidl: string;
  storage?: FakeS3Storage;
}) {
  const storage = args.storage ?? new FakeS3Storage('test-mail-bucket');
  const messageId = candidateMessageIdForPop3Uidl(INGEST_MAILBOX_ID, args.pop3Uidl);
  const parsed = await parseRawMessage(args.raw, { messageId, storage });
  const meta = {
    ingestMailboxId: INGEST_MAILBOX_ID,
    pop3Uidl: args.pop3Uidl,
    messageId,
  };
  const primary = await persistInboundMessage(parsed, args.raw, meta, {
    db: args.db,
    storage,
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
      storage,
      raw: args.raw,
      meta: { ...meta, rawMimeS3Key: primary.rawMimeS3Key },
      transportIds: primary.fanoutTransportIds ?? [],
      skipAiEnqueue: true,
    });
  }
  return { primary, copies, storage, messageId };
}

describe.skipIf(!ingestionDbAvailable)('mailbox fan-out routing', () => {
  it('1. stamped hotel mail To three hotel boxes keeps primary id and raw UIDL plus two copies', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-fanout-stamp-three';
      const { primary, copies, messageId } = await persistPrimaryAndCopies({
        db,
        pop3Uidl,
        raw: syntheticEml({
          from: 'guest@example.test',
          to: `${CEN_EMAIL}, ${DAV_EMAIL}, ${FTH_EMAIL}`,
          ownerHeader: CEN_EMAIL,
          subject: 'stamped three hotel boxes',
        }),
      });
      expect(primary.kind).toBe('stored');
      if (primary.kind !== 'stored') return;
      expect(primary.transportId).toBe(CEN_ID);
      expect(primary.messageId).toBe(messageId);
      expect(primary.messageId).toBe(
        candidateMessageIdForPop3Uidl(INGEST_MAILBOX_ID, pop3Uidl),
      );
      expect(primary.fanoutTransportIds).toEqual([DAV_ID, FTH_ID]);
      expect(copies?.results.map((row) => row.transportId)).toEqual([DAV_ID, FTH_ID]);
      expect(copies?.results.every((row) => row.result.kind === 'stored')).toBe(true);
      const rows = await db.select().from(message);
      expect(rows).toHaveLength(3);
      const byTransport = Object.fromEntries(rows.map((row) => [row.transportId, row]));
      expect(byTransport[CEN_ID]?.id).toBe(messageId);
      expect(byTransport[CEN_ID]?.pop3Uidl).toBe(pop3Uidl);
      expect(byTransport[DAV_ID]?.pop3Uidl).toBe(fanoutCopyPop3Uidl(pop3Uidl, DAV_ID));
      expect(byTransport[FTH_ID]?.pop3Uidl).toBe(fanoutCopyPop3Uidl(pop3Uidl, FTH_ID));
      expect(await db.select().from(mailIngestQuarantine)).toHaveLength(0);
    });
  });

  it('2. unstamped To-unique keeps primary and copies Cc/From hotel boxes', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-fanout-to-unique';
      const { primary, copies, messageId } = await persistPrimaryAndCopies({
        db,
        pop3Uidl,
        raw: syntheticEml({
          from: FTH_EMAIL,
          to: CEN_EMAIL,
          cc: DAV_EMAIL,
          subject: 'to unique plus cc from',
        }),
      });
      expect(primary.kind).toBe('stored');
      if (primary.kind !== 'stored') return;
      expect(primary.transportId).toBe(CEN_ID);
      expect(primary.messageId).toBe(messageId);
      expect(primary.fanoutTransportIds).toEqual([DAV_ID, FTH_ID]);
      expect(copies?.results.map((row) => row.transportId)).toEqual([DAV_ID, FTH_ID]);
      const rows = await db.select().from(message);
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.transportId === CEN_ID)?.pop3Uidl).toBe(pop3Uidl);
      expect(await db.select().from(mailIngestQuarantine)).toHaveLength(0);
    });
  });

  it('3. To two hotel boxes stores two rows and zero quarantine', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-fanout-two-hotel';
      const { primary, copies } = await persistPrimaryAndCopies({
        db,
        pop3Uidl,
        raw: syntheticEml({
          from: 'guest@example.test',
          to: `${DAV_EMAIL}, ${FTH_EMAIL}`,
          subject: 'two hotel boxes',
        }),
      });
      expect(primary.kind).toBe('stored');
      if (primary.kind !== 'stored') return;
      expect(primary.transportId).toBe(DAV_ID);
      expect(primary.fanoutTransportIds).toEqual([FTH_ID]);
      expect(copies?.results).toHaveLength(1);
      expect(copies?.results[0]?.transportId).toBe(FTH_ID);
      expect(copies?.results[0]?.result.kind).toBe('stored');
      const rows = await db.select().from(message);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.transportId).sort()).toEqual([DAV_ID, FTH_ID]);
      expect(await db.select().from(mailIngestQuarantine)).toHaveLength(0);
    });
  });

  it('4. From hotel A To hotel B stores A outbound and B inbound', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-fanout-from-to';
      const { primary, copies } = await persistPrimaryAndCopies({
        db,
        pop3Uidl,
        raw: syntheticEml({
          from: FTH_EMAIL,
          to: DAV_EMAIL,
          subject: 'from a to b',
        }),
      });
      expect(primary.kind).toBe('stored');
      if (primary.kind !== 'stored') return;
      expect(primary.transportId).toBe(DAV_ID);
      expect(primary.fanoutTransportIds).toEqual([FTH_ID]);
      expect(copies?.results[0]?.result.kind).toBe('stored');
      const rows = await db.select().from(message);
      expect(rows).toHaveLength(2);
      const byTransport = Object.fromEntries(rows.map((row) => [row.transportId, row]));
      expect(byTransport[DAV_ID]?.direction).toBe('inbound');
      expect(byTransport[FTH_ID]?.direction).toBe('outbound');
      expect(await db.select().from(mailIngestQuarantine)).toHaveLength(0);
    });
  });

  it('a real UIDL equal to the old copy suffix is a new message, not a copy duplicate', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const rawUidl = 'uidl-copy-identity';
      const collidingUidl = `${rawUidl}#t:${DAV_ID}`;
      const first = await persistPrimaryAndCopies({
        db,
        pop3Uidl: rawUidl,
        raw: syntheticEml({
          from: 'guest@example.test',
          to: `${CEN_EMAIL}, ${DAV_EMAIL}`,
          subject: 'primary then colliding uidl',
        }),
      });
      expect(first.primary.kind).toBe('stored');
      const copyUidl = fanoutCopyPop3Uidl(rawUidl, DAV_ID);
      expect(copyUidl).not.toBe(collidingUidl);
      const second = await persistPrimaryAndCopies({
        db,
        pop3Uidl: collidingUidl,
        raw: syntheticEml({
          from: 'guest@example.test',
          to: CEN_EMAIL,
          subject: 'real uidl that looks like an old copy',
        }),
      });
      expect(second.primary.kind).toBe('stored');
      if (second.primary.kind !== 'stored') return;
      expect(second.primary.messageId).not.toBe(first.messageId);
      const rows = await db.select().from(message);
      expect(rows.some((row) => row.pop3Uidl === collidingUidl)).toBe(true);
      expect(rows.some((row) => row.pop3Uidl === copyUidl)).toBe(true);
    });
  });

  it('copy direction uses From, not Sender, on a delegated send', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db);
      const pop3Uidl = 'uidl-fanout-delegated-from';
      const { primary, copies } = await persistPrimaryAndCopies({
        db,
        pop3Uidl,
        raw: syntheticEml({
          from: FTH_EMAIL,
          to: DAV_EMAIL,
          extraHeaders: ['Sender: assistant@example.test'],
          subject: 'delegated send',
        }),
      });
      expect(primary.kind).toBe('stored');
      if (primary.kind !== 'stored') return;
      expect(primary.transportId).toBe(DAV_ID);
      expect(primary.fanoutTransportIds).toEqual([FTH_ID]);
      expect(copies?.results[0]?.result.kind).toBe('stored');
      const rows = await db.select().from(message);
      expect(rows).toHaveLength(2);
      const byTransport = Object.fromEntries(rows.map((row) => [row.transportId, row]));
      expect(byTransport[DAV_ID]?.direction).toBe('inbound');
      expect(byTransport[FTH_ID]?.direction).toBe('outbound');
      expect(byTransport[FTH_ID]?.isRead).toBe(true);
    });
  });

  it('5. To one hotel box plus one non-hotel transport quarantines', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db, { other: true });
      const pop3Uidl = 'uidl-fanout-hotel-plus-other';
      const { primary, copies } = await persistPrimaryAndCopies({
        db,
        pop3Uidl,
        raw: syntheticEml({
          from: 'guest@example.test',
          to: `${DAV_EMAIL}, ${OTHER_EMAIL}`,
          subject: 'hotel plus other',
        }),
      });
      expect(primary.kind).toBe('quarantined');
      if (primary.kind !== 'quarantined') return;
      expect(primary.reason).toBe('multi_transport');
      expect(copies).toBeUndefined();
      expect(await db.select().from(message)).toHaveLength(0);
      expect(await db.select().from(mailIngestQuarantine)).toHaveLength(1);
    });
  });

  it('6. one address on two transports is ambiguous_transport', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    await withIngestionDb(async ({ db }) => {
      await seedFanoutHotels(db, { sharedDavOnFaith: true });
      const pop3Uidl = 'uidl-fanout-ambiguous';
      const { primary, copies } = await persistPrimaryAndCopies({
        db,
        pop3Uidl,
        raw: syntheticEml({
          from: 'guest@example.test',
          to: DAV_EMAIL,
          subject: 'shared identity',
        }),
      });
      expect(primary.kind).toBe('quarantined');
      if (primary.kind !== 'quarantined') return;
      expect(primary.reason).toBe('ambiguous_transport');
      expect(copies).toBeUndefined();
      expect(await db.select().from(message)).toHaveLength(0);
      expect(await db.select().from(mailIngestQuarantine)).toHaveLength(1);
    });
  });
});
