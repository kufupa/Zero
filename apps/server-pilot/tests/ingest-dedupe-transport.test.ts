import { describe, expect, it } from 'vitest';
import {
  attachment,
  mailIngestCandidateAttachmentCleanup,
  mailIngestQuarantine,
  mailIngestSourceReceipt,
  mailLabel,
  mailSenderPreference,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail.js';
import type { DB } from '../src/db/client.js';
import { parseRawMessage, generateMessageId } from '../src/mail/ingest/parse-message.js';
import {
  persistInboundMessage,
  type TransportMatchCandidate,
} from '../src/mail/ingest/store.js';
import { FakeS3Storage } from '../src/storage/s3.js';

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

const SHARED_DATE = 'Thu, 15 Oct 2026 12:00:00 +0000';
const SHARED_MID = 'contract-same@example.test';

type Row = Record<string, unknown>;

function toCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function walkEqPairs(node: unknown, pairs: Array<{ col: string; value: unknown }>): void {
  if (!node || typeof node !== 'object') return;
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return;
  let pendingCol: string | null = null;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object') {
      const rec = chunk as {
        name?: unknown;
        value?: unknown;
        encoder?: unknown;
        queryChunks?: unknown[];
      };
      if (typeof rec.name === 'string' && rec.value === undefined && !rec.queryChunks) {
        pendingCol = toCamel(rec.name);
        continue;
      }
      if (pendingCol && rec.encoder && rec.value !== undefined && !rec.queryChunks) {
        pairs.push({ col: pendingCol, value: rec.value });
        pendingCol = null;
        continue;
      }
    }
    walkEqPairs(chunk, pairs);
  }
}

function matchesWhere(row: Row, where: unknown): boolean {
  if (!where) return true;
  const pairs: Array<{ col: string; value: unknown }> = [];
  walkEqPairs(where, pairs);
  if (pairs.length === 0) return true;
  return pairs.every((pair) => {
    const actual = pair.col in row ? row[pair.col] : null;
    return actual === pair.value;
  });
}

function projectRows(rows: Row[], projection: Record<string, unknown> | undefined): Row[] {
  if (!projection) return rows;
  return rows.map((row) => {
    const out: Row = {};
    for (const key of Object.keys(projection)) {
      out[key] = row[key];
    }
    return out;
  });
}

function recordingDb(transports: TransportMatchCandidate[]) {
  const tables = new Map<object, Row[]>([
    [
      mailboxTransport,
      transports.map((t) => ({
        ...t,
        ownerHeaderValue: t.email,
        isActive: true,
      })),
    ],
    [message, []],
    [mailThread, []],
    [mailIngestSourceReceipt, []],
    [attachment, []],
    [mailLabel, []],
    [mailIngestQuarantine, []],
    [mailIngestCandidateAttachmentCleanup, []],
    [mailSenderPreference, []],
  ]);

  const insertRows = (table: object, values: Row | Row[], ignoreConflict: boolean) => {
    const list = Array.isArray(values) ? values : [values];
    const rows = tables.get(table) ?? [];
    for (const value of list) {
      if (ignoreConflict && rows.some((row) => row.id === value.id)) continue;
      if (
        ignoreConflict &&
        table === mailIngestSourceReceipt &&
        rows.some(
          (row) =>
            row.ingestMailboxId === value.ingestMailboxId && row.pop3Uidl === value.pop3Uidl,
        )
      ) {
        continue;
      }
      rows.push({ ...value });
    }
    tables.set(table, rows);
  };

  const db = {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: object) => {
        const state: { where?: unknown; limit: number } = { limit: Infinity };
        const run = () => {
          const rows = (tables.get(table) ?? []).filter((row) => matchesWhere(row, state.where));
          return projectRows(rows.slice(0, state.limit), projection);
        };
        const query: {
          where: (w: unknown) => unknown;
          limit: (n: number) => unknown;
          orderBy: () => unknown;
          for: () => unknown;
          then: Promise<Row[]>['then'];
        } = {
          where: (w: unknown) => {
            state.where = w;
            return query;
          },
          limit: (n: number) => {
            state.limit = n;
            return query;
          },
          orderBy: () => query,
          for: () => query,
          then: (onFulfilled, onRejected) => Promise.resolve(run()).then(onFulfilled, onRejected),
        };
        return query;
      },
    }),
    insert: (table: object) => ({
      values: (values: Row | Row[]) => {
        let ignoreConflict = false;
        const builder = {
          onConflictDoNothing: () => {
            ignoreConflict = true;
            return builder;
          },
          then: (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
            Promise.resolve(insertRows(table, values, ignoreConflict)).then(
              onFulfilled,
              onRejected,
            ),
        };
        return builder;
      },
    }),
    update: (table: object) => ({
      set: (patch: Row) => ({
        where: (where: unknown) => {
          const rows = tables.get(table) ?? [];
          for (const row of rows) {
            if (matchesWhere(row, where)) Object.assign(row, patch);
          }
          return Promise.resolve(undefined);
        },
      }),
    }),
    execute: async () => undefined,
    delete: (table: object) => ({
      where: (where: unknown) => {
        tables.set(
          table,
          (tables.get(table) ?? []).filter((row) => !matchesWhere(row, where)),
        );
        return Promise.resolve(undefined);
      },
    }),
    transaction: async (callback: (tx: DB) => Promise<unknown>) => callback(db as unknown as DB),
  } as unknown as DB;

  return {
    db,
    rows: <T extends Row>(table: object) => (tables.get(table) ?? []) as T[],
    seed: (table: object, row: Row) => {
      const rows = tables.get(table) ?? [];
      rows.push({ ...row });
      tables.set(table, rows);
    },
  };
}

function syntheticEml(args: {
  from: string;
  to: string;
  messageId?: string;
  date?: string;
  ownerHeader?: string;
  subject: string;
}): Buffer {
  const lines = [`From: ${args.from}`, `To: ${args.to}`];
  if (args.messageId) lines.push(`Message-ID: <${args.messageId}>`);
  if (args.ownerHeader) lines.push(`X-Zero-Mailbox: ${args.ownerHeader}`);
  lines.push(`Date: ${args.date ?? SHARED_DATE}`, `Subject: ${args.subject}`, 'MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=utf-8', '', 'Synthetic body.');
  return Buffer.from(lines.join('\r\n'), 'utf8');
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

describe('per-transport ingest dedupe', () => {
  it('same Message-ID on two transports → two rows', async () => {
    const fake = recordingDb([HOTEL_A, HOTEL_B]);
    const first = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-a@example.test',
        messageId: SHARED_MID,
        subject: 'copy for hotel a',
      }),
      'uidl-route-a',
      fake.db,
    );
    const second = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-b@example.test',
        messageId: SHARED_MID,
        subject: 'copy for hotel b',
      }),
      'uidl-route-b',
      fake.db,
    );

    expect(first.kind).toBe('stored');
    expect(second.kind).toBe('stored');
    const messages = fake.rows<{ id: string; transportId: string }>(message);
    expect(messages).toHaveLength(2);
    expect(messages.find((row) => row.transportId === HOTEL_A.id)).toBeDefined();
    expect(messages.find((row) => row.transportId === HOTEL_B.id)).toBeDefined();
  });

  it('same Message-ID twice on one transport → one row', async () => {
    const fake = recordingDb([HOTEL_A, HOTEL_B]);
    const raw = syntheticEml({
      from: 'guest@example.test',
      to: 'hotel-a@example.test',
      messageId: SHARED_MID,
      subject: 'same transport copies',
    });
    const first = await persistSynthetic(raw, 'uidl-a-1', fake.db);
    const second = await persistSynthetic(raw, 'uidl-a-2', fake.db);

    expect(first.kind).toBe('stored');
    expect(['duplicate', 'reconciled']).toContain(second.kind);
    expect(fake.rows(message)).toHaveLength(1);
    expect(fake.rows(mailIngestSourceReceipt)).toHaveLength(2);
  });

  it('redelivered UIDL after routing change → duplicate, no quarantine', async () => {
    const fake = recordingDb([HOTEL_B]);
    const raw = syntheticEml({
      from: 'guest@example.test',
      to: 'hotel-a@example.test, hotel-b@example.test',
      subject: 'uidl stored before routing change',
    });
    const first = await persistSynthetic(raw, 'uidl-route-change', fake.db);
    expect(first.kind).toBe('stored');
    expect(fake.rows(message)).toHaveLength(1);
    expect(fake.rows<{ transportId: string }>(message)[0]!.transportId).toBe(HOTEL_B.id);

    fake.seed(mailboxTransport, {
      ...HOTEL_A,
      ownerHeaderValue: HOTEL_A.email,
      isActive: true,
    });
    const retry = await persistSynthetic(raw, 'uidl-route-change', fake.db);
    expect(retry.kind).toBe('duplicate');
    expect(fake.rows(message)).toHaveLength(1);
    expect(fake.rows(mailIngestQuarantine)).toHaveLength(0);
  });

  it('forged stamp for hotel A on To hotel B stores under B never A', async () => {
    const fake = recordingDb([HOTEL_A, HOTEL_B]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: HOTEL_B.email,
        ownerHeader: HOTEL_A.email,
        subject: 'forged stamp',
      }),
      'uidl-forged-stamp-b',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_B.id);
    const rows = fake.rows<{ transportId: string; sourceProvenance: unknown }>(message);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transportId).toBe(HOTEL_B.id);
    expect(rows[0]!.sourceProvenance).toEqual({
      stampRoute: 'stamp_ignored_uncorroborated',
    });
  });

  it('corroborated stamp records stamp_corroborated provenance', async () => {
    const fake = recordingDb([HOTEL_A, HOTEL_B]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: HOTEL_A.email,
        ownerHeader: HOTEL_A.email,
        subject: 'corroborated stamp',
      }),
      'uidl-stamp-corroborated',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_A.id);
    expect(fake.rows<{ sourceProvenance: unknown }>(message)[0]!.sourceProvenance).toEqual({
      stampRoute: 'stamp_corroborated',
    });
  });

  it('multi → quarantine multi_transport', async () => {
    const fake = recordingDb([HOTEL_A, HOTEL_B]);
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
    expect(fake.rows(message)).toHaveLength(0);
  });
});
