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
  resolveTransportMatch,
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

const NAVA: TransportMatchCandidate = {
  id: 'transport-nava',
  email: 'nava-ai@example.test',
  sendFromConfig: null,
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
  return pairs.every((pair) => row[pair.col] === pair.value);
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
    transaction: async (callback: (tx: DB) => Promise<unknown>) => callback(db as unknown as DB),
  } as unknown as DB;

  return {
    db,
    rows: <T extends Row>(table: object) => (tables.get(table) ?? []) as T[],
  };
}

function syntheticEml(args: {
  from: string;
  to: string;
  messageId?: string;
  inReplyTo?: string;
  date?: string;
  subject: string;
}): Buffer {
  const lines = [`From: ${args.from}`, `To: ${args.to}`];
  if (args.messageId) lines.push(`Message-ID: <${args.messageId}>`);
  if (args.inReplyTo) lines.push(`In-Reply-To: <${args.inReplyTo}>`);
  lines.push(
    `Date: ${args.date ?? SHARED_DATE}`,
    `Subject: ${args.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Synthetic body.',
  );
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

describe('resolveTransportMatch aggregate nava post-filter', () => {
  it('drops transport-nava when a hotel also matches, leaving unique hotel', () => {
    expect(
      resolveTransportMatch(
        [HOTEL_A, HOTEL_B, NAVA],
        ['hotel-a@example.test', 'nava-ai@example.test'],
      ),
    ).toEqual({ kind: 'unique', transport: HOTEL_A });
  });

  it('drops transport-nava from genuine cross-hotel multi', () => {
    expect(
      resolveTransportMatch(
        [HOTEL_A, HOTEL_B, NAVA],
        ['hotel-a@example.test', 'hotel-b@example.test', 'nava-ai@example.test'],
      ),
    ).toEqual({
      kind: 'multi',
      ids: ['transport-hotel-a', 'transport-hotel-b'],
    });
  });

  it('keeps unique transport-nava when no hotel matches', () => {
    expect(resolveTransportMatch([HOTEL_A, NAVA], ['nava-ai@example.test'])).toEqual({
      kind: 'unique',
      transport: NAVA,
    });
  });

  it('leaves ambiguous semantics untouched when one identity matches nava and a hotel', () => {
    const shared: TransportMatchCandidate = {
      id: 'transport-nava',
      email: 'nava-ai@example.test',
      sendFromConfig: { aliases: ['hotel-a-desk@example.test'] },
    };
    expect(resolveTransportMatch([HOTEL_A, shared], ['hotel-a-desk@example.test'])).toEqual({
      kind: 'ambiguous',
      ids: ['transport-hotel-a', 'transport-nava'],
    });
  });
});

describe('per-transport ingest identity contract', () => {
  it('same Message-ID, two UIDLs, both routed to A → one message + two receipts', async () => {
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
    const stored = fake.rows<{ id: string; transportId: string }>(message)[0]!;
    expect(stored.transportId).toBe(HOTEL_A.id);
    expect(
      fake
        .rows<{ canonicalMessageId: string; pop3Uidl: string }>(mailIngestSourceReceipt)
        .every((row) => row.canonicalMessageId === stored.id),
    ).toBe(true);
  });

  it('same Message-ID, UIDL to A and UIDL to B → one message per hotel, isolated rows', async () => {
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
    const messages = fake.rows<{
      id: string;
      transportId: string;
      threadId: string;
    }>(message);
    expect(messages).toHaveLength(2);
    const rowA = messages.find((row) => row.transportId === HOTEL_A.id);
    const rowB = messages.find((row) => row.transportId === HOTEL_B.id);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowA!.threadId).not.toBe(rowB!.threadId);

    const threads = fake.rows<{ id: string; transportId: string }>(mailThread);
    expect(threads.every((row) => row.transportId === HOTEL_A.id || row.transportId === HOTEL_B.id)).toBe(
      true,
    );
    expect(threads.find((row) => row.id === rowA!.threadId)?.transportId).toBe(HOTEL_A.id);
    expect(threads.find((row) => row.id === rowB!.threadId)?.transportId).toBe(HOTEL_B.id);

    const receipts = fake.rows<{
      canonicalMessageId: string;
      transportId: string;
    }>(mailIngestSourceReceipt);
    expect(receipts).toHaveLength(2);
    expect(receipts.find((row) => row.canonicalMessageId === rowA!.id)?.transportId).toBe(HOTEL_A.id);
    expect(receipts.find((row) => row.canonicalMessageId === rowB!.id)?.transportId).toBe(HOTEL_B.id);

    for (const att of fake.rows<{ messageId: string }>(attachment)) {
      const owner = messages.find((row) => row.id === att.messageId);
      expect(owner).toBeDefined();
    }
    for (const label of fake.rows<{ transportId: string }>(mailLabel)) {
      expect([HOTEL_A.id, HOTEL_B.id]).toContain(label.transportId);
    }
  });

  it('threading parent lookup never joins a parent on another transport', async () => {
    const fake = recordingDb([HOTEL_A, HOTEL_B]);
    const parentMid = 'contract-parent@example.test';
    const parent = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-a@example.test',
        messageId: parentMid,
        subject: 'parent on hotel a',
      }),
      'uidl-parent-a',
      fake.db,
    );
    const child = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-b@example.test',
        messageId: 'contract-child@example.test',
        inReplyTo: parentMid,
        subject: 'reply on hotel b',
      }),
      'uidl-child-b',
      fake.db,
    );

    expect(parent.kind).toBe('stored');
    expect(child.kind).toBe('stored');
    if (parent.kind !== 'stored' || child.kind !== 'stored') return;
    expect(child.threadId).not.toBe(parent.threadId);
    expect(child.transportId).toBe(HOTEL_B.id);
    expect(parent.transportId).toBe(HOTEL_A.id);
    const childRow = fake
      .rows<{ threadId: string; transportId: string }>(message)
      .find((row) => row.transportId === HOTEL_B.id);
    expect(childRow?.threadId).toBe(child.threadId);
  });
});

describe('cross-hotel fan-out', () => {
  it('stores one copy per matched hotel for a single UIDL addressed to both', async () => {
    const fake = recordingDb([HOTEL_A, HOTEL_B, NAVA]);
    const raw = syntheticEml({
      from: 'guest@example.test',
      to: 'hotel-a@example.test, hotel-b@example.test',
      messageId: SHARED_MID,
      subject: 'one pop copy two hotels',
    });
    const first = await persistSynthetic(raw, 'uidl-fanout-1', fake.db);
    expect(['stored', 'reconciled']).toContain(first.kind);

    const messages = fake.rows<{
      id: string;
      transportId: string;
      threadId: string;
      ingestMailboxId: string | null;
      pop3Uidl: string | null;
      sourceProvenance: Record<string, unknown> | null;
    }>(message);
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((row) => row.transportId))).toEqual(
      new Set([HOTEL_A.id, HOTEL_B.id]),
    );
    expect(new Set(messages.map((row) => row.threadId)).size).toBe(2);

    const owned = messages.filter((row) => row.pop3Uidl === 'uidl-fanout-1');
    expect(owned).toHaveLength(1);
    const extra = messages.find((row) => row.id !== owned[0]!.id)!;
    expect(extra.pop3Uidl).toBeNull();
    expect(extra.ingestMailboxId).toBeNull();
    expect(extra.sourceProvenance).toMatchObject({
      fanoutFrom: { pop3Uidl: 'uidl-fanout-1', ingestMailboxId: 'ingest-nava-legacy' },
    });

    const receipts = fake.rows<{
      pop3Uidl: string;
      transportId: string;
      canonicalMessageId: string;
    }>(mailIngestSourceReceipt);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.pop3Uidl).toBe('uidl-fanout-1');
    expect(receipts[0]!.canonicalMessageId).toBe(owned[0]!.id);
    expect(receipts[0]!.transportId).toBe(owned[0]!.transportId);

    const retry = await persistSynthetic(raw, 'uidl-fanout-1', fake.db);
    expect(['duplicate', 'reconciled']).toContain(retry.kind);
    expect(fake.rows(message)).toHaveLength(2);
    expect(fake.rows(mailIngestSourceReceipt)).toHaveLength(1);
  });

  it('does not treat transport-nava as a second hotel on fan-out', async () => {
    const fake = recordingDb([HOTEL_A, NAVA]);
    const result = await persistSynthetic(
      syntheticEml({
        from: 'guest@example.test',
        to: 'hotel-a@example.test, nava-ai@example.test',
        messageId: SHARED_MID,
        subject: 'hotel plus aggregate',
      }),
      'uidl-hotel-plus-nava',
      fake.db,
    );
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') return;
    expect(result.transportId).toBe(HOTEL_A.id);
    expect(fake.rows(message)).toHaveLength(1);
    expect(fake.rows<{ transportId: string }>(message)[0]!.transportId).toBe(HOTEL_A.id);
  });
});
