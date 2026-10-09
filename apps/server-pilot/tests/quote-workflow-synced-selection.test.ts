import { asc, getTableName } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db/client.js';
import { attachment } from '../src/db/schema/mail.js';
import {
  loadSyncedQuoteSelectionFromMailbox,
  orderCausalPreceding,
  readQuoteAttachments,
  type QuoteAttachmentRow,
} from '../src/ai/quote-workflow-synced-selection.js';

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: vi.fn(),
}));

/** Minimal select chain: where/limit/orderBy, awaitable, rows keyed by table name. */
function fakeMailboxDb(
  rowsByTable: Record<string, unknown[]>,
  orderByCalls: Array<{ table: string; args: unknown[] }>,
) {
  const query = (table: string) => {
    const rows = rowsByTable[table] ?? [];
    const builder = Object.assign(Promise.resolve(rows), {
      where: () => builder,
      limit: async () => rows,
      orderBy: (...args: unknown[]) => {
        orderByCalls.push({ table, args });
        return builder;
      },
    });
    return builder;
  };
  return {
    select: () => ({ from: (table: object) => query(getTableName(table as never)) }),
  };
}

function row(overrides: Partial<QuoteAttachmentRow> & { id: string }): QuoteAttachmentRow {
  return {
    filename: `${overrides.id}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1_000,
    isInline: false,
    s3Key: `attachments/m1/${overrides.id}`,
    messageId: 'm1',
    ...overrides,
  };
}

describe('readQuoteAttachments', () => {
  it('skips inline parts entirely and reads only non-inline PDFs', async () => {
    const read: string[] = [];
    const result = await readQuoteAttachments(
      [
        row({ id: 'logo', filename: 'logo.png', mimeType: 'image/png', isInline: true }),
        row({ id: 'inline-pdf', isInline: true }),
        row({ id: 'quote-ask' }),
        row({ id: 'sheet', filename: 'rooming.xlsx', mimeType: 'application/vnd.ms-excel', sizeBytes: 20_000 }),
      ],
      async (attachment) => {
        read.push(attachment.id);
        return { text: 'Rooming list text' };
      },
    );
    expect(read).toEqual(['quote-ask']);
    expect(result).toEqual([
      {
        id: 'quote-ask',
        filename: 'quote-ask.pdf',
        mimeType: 'application/pdf',
        byteSize: 1_000,
        bytesPresent: true,
        text: 'Rooming list text',
      },
      {
        id: 'sheet',
        filename: 'rooming.xlsx',
        mimeType: 'application/vnd.ms-excel',
        byteSize: 20_000,
        bytesPresent: false,
        readFailure: 'not a PDF',
      },
    ]);
  });

  it('never reads or lists signatures, invites, contact cards or tiny files', async () => {
    const read: string[] = [];
    const result = await readQuoteAttachments(
      [
        row({ id: 'sig', filename: 'image001.jpg', mimeType: 'image/jpeg', sizeBytes: 12_000 }),
        row({ id: 'cid', filename: 'attachment-0', mimeType: 'image/png', sizeBytes: 30_000, contentId: 'logo@x' }),
        row({ id: 'svg', filename: 'sig.svg', mimeType: 'image/svg+xml', sizeBytes: 50_000 }),
        row({ id: 'ics', filename: 'invite.ics', mimeType: 'text/calendar', sizeBytes: 2_000 }),
        row({ id: 'vcf', filename: 'contact.vcf', mimeType: 'text/vcard', sizeBytes: 900 }),
        row({
          id: 'tiny-doc',
          filename: 'note.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 3_000,
        }),
        row({ id: 'unknown-small', filename: 'data.bin', mimeType: 'application/octet-stream', sizeBytes: 8_000 }),
      ],
      async (attachment) => {
        read.push(attachment.id);
        return { text: 'x' };
      },
    );
    expect(read).toEqual([]);
    expect(result).toEqual([]);
  });

  it('keeps a document that carries a Content-ID: a cid never skips a document', async () => {
    const result = await readQuoteAttachments(
      [
        row({
          id: 'rooming',
          filename: 'rooming.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 50_000,
          contentId: 'rooming-cid@x',
        }),
      ],
      async () => ({ text: null }),
    );
    expect(result).toMatchObject([{ id: 'rooming', bytesPresent: false, readFailure: 'not a PDF' }]);
  });

  it('lists the office documents and large unknown files it could not read, and keeps PDF failures', async () => {
    const result = await readQuoteAttachments(
      [
        row({
          id: 'rooming',
          filename: 'rooming.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 50_000,
        }),
        row({ id: 'rooms', filename: 'rooms.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 9_000 }),
        row({ id: 'terms', filename: 'terms.odt', mimeType: 'application/vnd.oasis.opendocument.text', sizeBytes: 9_000 }),
        row({ id: 'legacy', filename: 'rooms.doc', mimeType: 'application/msword', sizeBytes: 9_000 }),
        row({ id: 'forward', filename: 'forward.msg', mimeType: 'application/vnd.ms-outlook', sizeBytes: 60_000 }),
        row({ id: 'tiny-pdf', sizeBytes: 1_000 }),
      ],
      async (attachment) => (attachment.id === 'tiny-pdf' ? { text: null, reason: 'encrypted' } : { text: null }),
    );
    expect(result.map((part) => [part.id, part.readFailure])).toEqual([
      ['rooming', 'not a PDF'],
      ['rooms', 'not a PDF'],
      ['terms', 'not a PDF'],
      ['legacy', 'not a PDF'],
      ['forward', 'not a PDF'],
      ['tiny-pdf', 'encrypted'],
    ]);
  });

  it('caps reads at 3 files and 5 MB total', async () => {
    const read: string[] = [];
    const result = await readQuoteAttachments(
      [
        row({ id: 'a' }),
        row({ id: 'big', sizeBytes: 6 * 1024 * 1024 }),
        row({ id: 'b' }),
        row({ id: 'c' }),
        row({ id: 'd' }),
      ],
      async (attachment) => {
        read.push(attachment.id);
        return { text: 'x' };
      },
    );
    expect(read).toEqual(['a', 'b', 'c']);
    expect(result.find((part) => part.id === 'big')?.readFailure).toBe('over the 3 file / 5 MB analysis limit');
    expect(result.find((part) => part.id === 'd')?.readFailure).toBe('over the 3 file / 5 MB analysis limit');
  });

  it('keeps scanned PDF bytes for the model and turns reader failures into readFailure', async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 45]);
    const result = await readQuoteAttachments([row({ id: 'scan' }), row({ id: 'locked' }), row({ id: 'boom' })], async (attachment) => {
      if (attachment.id === 'scan') return { text: null, pdf };
      if (attachment.id === 'locked') return { text: null, reason: 'encrypted' };
      throw new Error('s3 down');
    });
    expect(result[0]).toMatchObject({ id: 'scan', bytesPresent: true, pdf });
    expect(result[1]).toMatchObject({ id: 'locked', bytesPresent: false, readFailure: 'encrypted' });
    expect(result[2]).toMatchObject({ id: 'boom', bytesPresent: false, readFailure: 'read failed' });
  });
});

describe('orderCausalPreceding', () => {
  it('keeps older same-thread mail before the selected message and drops later replies', () => {
    const selected = { id: 'mid', receivedAt: new Date('2026-10-05T12:00:00Z') };
    const preceding = orderCausalPreceding(selected, [
      { id: 'later', textBody: 'thanks, confirm', receivedAt: new Date('2026-10-05T15:00:00Z') },
      { id: 'mid', textBody: 'please quote', receivedAt: new Date('2026-10-05T12:00:00Z') },
      { id: 'older', textBody: 'original ask', receivedAt: new Date('2026-10-04T09:00:00Z') },
      { id: 'same-time', textBody: 'same-minute note', receivedAt: new Date('2026-10-05T12:00:00Z') },
      { id: 'undated', textBody: 'no clock', receivedAt: null },
    ]);
    expect(preceding.map((row) => row.bodyText)).toEqual(['original ask', 'same-minute note']);
  });

  it('does not invent causal order when the selected message has no receivedAt', () => {
    expect(
      orderCausalPreceding({ id: 'x', receivedAt: null }, [
        { id: 'older', textBody: 'ask', receivedAt: new Date('2026-10-04T09:00:00Z') },
      ]),
    ).toEqual([]);
  });
});

describe('loadSyncedQuoteSelectionFromMailbox', () => {
  it('reads attachment rows in id order so the analyse cache key does not follow row order', async () => {
    const orderByCalls: Array<{ table: string; args: unknown[] }> = [];
    vi.mocked(getDb).mockReturnValue(
      fakeMailboxDb(
        {
          message: [
            {
              id: 'm1',
              threadId: 't1',
              subject: 'Rooms',
              textBody: 'Quote 2 rooms',
              receivedAt: new Date('2026-10-05T12:00:00Z'),
            },
          ],
          attachment: [
            {
              id: 'att-b',
              filename: 'b.xlsx',
              mimeType: 'application/vnd.ms-excel',
              sizeBytes: 10,
              isInline: false,
              s3Key: 'attachments/m1/att-b',
              messageId: 'm1',
            },
            {
              id: 'att-a',
              filename: 'a.xlsx',
              mimeType: 'application/vnd.ms-excel',
              sizeBytes: 10,
              isInline: false,
              s3Key: 'attachments/m1/att-a',
              messageId: 'm1',
            },
          ],
        },
        orderByCalls,
      ) as never,
    );
    await loadSyncedQuoteSelectionFromMailbox({
      transportId: 'transport-1',
      internetMessageId: '<m1@example.com>',
    });
    expect(orderByCalls).toEqual([{ table: 'attachment', args: [asc(attachment.id)] }]);
  });
});
