import { asc, getTableName } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db/client.js';
import { attachment } from '../src/db/schema/mail.js';
import { attachmentReads, buildInboundPrompt } from '../src/ai/extraction/extract.js';
import { buildQuoteWorkflowPrompt } from '../src/ai/quote-workflow-llm.js';
import { readAuthorizedArtifactBytes } from '../src/mail/artifacts/read-artifact.js';
import { storedAnalysis } from '../src/ai/work-items.js';
import {
  createArtifactReader,
  loadSyncedQuoteSelectionFromMailbox,
  orderCausalPreceding,
  overlayHmsConfirmation,
  applyThreadConfirmationOverlay,
  readQuoteAttachments,
  resolveThreadConfirmationEvidence,
  THREAD_CONFIRMATION_AMBIGUOUS,
  type QuoteAttachmentRow,
} from '../src/ai/quote-workflow-synced-selection.js';

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: vi.fn(),
}));

vi.mock('../src/mail/artifacts/read-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mail/artifacts/read-artifact.js')>()),
  readAuthorizedArtifactBytes: vi.fn(),
}));

vi.mock('../src/storage/s3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/storage/s3.js')>()),
  getS3Storage: vi.fn(() => ({ headObject: vi.fn(), getObjectBounded: vi.fn() })),
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

const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const docxMimeWithParams = 'Application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="x.docx"';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Small, real stored ZIP DOCX; conversion remains a fake in this unit test. */
function minimalDocx(): Buffer {
  const files = [
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ARRIVAL: 30 September 2026. DEPARTURE: 02 October 2026.</w:t></w:r></w:p>${' '.repeat(4 * 1024)}<w:sectPr/></w:body></w:document>`],
  ];
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [filename, text] of files) {
    const name = Buffer.from(filename);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.concat([header, name, data]);
    local.push(entry);

    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(0x21, 14);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(data.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([index, name]));
    offset += entry.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
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

  it('reads a DOCX document that carries a Content-ID: a cid never skips a document', async () => {
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
    expect(result).toMatchObject([{ id: 'rooming', bytesPresent: false, readFailure: 'no readable text' }]);
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
      ['rooming', 'no readable text'],
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
        row({
          id: 'docx-big',
          filename: 'oversized.docx',
          mimeType: docxMime,
          sizeBytes: 6 * 1024 * 1024,
        }),
      ],
      async (attachment) => {
        read.push(attachment.id);
        return { text: 'x' };
      },
    );
    expect(read).toEqual(['a', 'b', 'c']);
    expect(result.find((part) => part.id === 'big')?.readFailure).toBe('over the 3 file / 5 MB analysis limit');
    expect(result.find((part) => part.id === 'd')?.readFailure).toBe('over the 3 file / 5 MB analysis limit');
    expect(result.find((part) => part.id === 'docx-big')?.readFailure).toBe(
      'over the 3 file / 5 MB analysis limit',
    );
  });

  it('keeps scanned PDFs as quote-analysis files and marks them unread for text extraction', async () => {
    const pdf = new Uint8Array(Buffer.from('%PDF-1.7'));
    const result = await readQuoteAttachments([row({ id: 'scan' }), row({ id: 'locked' }), row({ id: 'boom' })], async (attachment) => {
      if (attachment.id === 'scan') return { text: null, pdf };
      if (attachment.id === 'locked') return { text: null, reason: 'encrypted' };
      throw new Error('s3 down');
    });
    expect(result[0]).toMatchObject({ id: 'scan', bytesPresent: true, pdf });
    expect(result[1]).toMatchObject({ id: 'locked', bytesPresent: false, readFailure: 'encrypted' });
    expect(result[2]).toMatchObject({ id: 'boom', bytesPresent: false, readFailure: 'read failed' });
    expect(attachmentReads([result[0]!])).toMatchObject([
      { id: 'scan', status: 'not_read', reason: 'scanned PDF: no text layer, not sent to the model' },
    ]);
    const selection = { subject: '', bodyText: '', preceding: [], attachments: [result[0]!] };
    expect(buildInboundPrompt(selection).user).not.toContain('scan.pdf');
    expect(buildQuoteWorkflowPrompt(selection).files).toEqual([
      { filename: 'scan.pdf', mediaType: 'application/pdf', data: pdf },
    ]);
  });

  it('puts converted DOCX arrival and departure text in the inbound extraction prompt', async () => {
    const docx = minimalDocx();
    const pdf = Buffer.from('%PDF-1.7 synthetic');
    const sha256 = createHash('sha256').update(docx).digest('hex');
    const doc = row({
      id: 'request',
      filename: 'stay-request.docx',
      mimeType: docxMimeWithParams,
      sizeBytes: docx.length,
      sha256,
    });
    vi.mocked(readAuthorizedArtifactBytes).mockImplementation(async (input) => {
      expect(input.allowOffice).toBe(true);
      expect(input.expectedLocator).toMatchObject({
        s3Key: doc.s3Key,
        mimeType: docxMimeWithParams,
        sizeBytes: docx.length,
        messageId: doc.messageId,
        sha256,
      });
      expect(input.expectedSha256).toBe(sha256);
      expect(await input.revalidate?.()).toBe(true);
      return {
        body: docx,
        contentType: docxMimeWithParams,
        sha256,
        locator: input.expectedLocator!,
      };
    });
    const officeConverter = vi.fn(async (original: Uint8Array, signal: AbortSignal) => {
      signal.throwIfAborted();
      const zip = Buffer.from(original).toString('latin1');
      expect(zip).toContain('ARRIVAL: 30 September 2026');
      expect(zip).toContain('DEPARTURE: 02 October 2026');
      return pdf;
    });
    const runner = async (tool: string) => ({
      stdout: Buffer.from(
        tool === 'pdfinfo'
          ? 'Pages: 1\nEncrypted: no'
          : 'ARRIVAL: 30 September 2026. DEPARTURE: 02 October 2026.\f',
      ),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    });
    const reader = createArtifactReader([doc], new AbortController().signal, {
      revalidateOffice: async () => true,
      officeConverter,
      runner: runner as never,
    });
    const attachments = await readQuoteAttachments([doc], reader);
    const selection = {
      subject: 'Request for rates',
      bodyText: 'As per the attached request.',
      preceding: [],
      attachments,
    };
    const prompt = buildInboundPrompt(selection).user;

    expect(officeConverter).toHaveBeenCalledOnce();
    expect(attachments).toMatchObject([
      {
        id: 'request',
        bytesPresent: true,
        text: expect.stringContaining('ARRIVAL: 30 September 2026'),
      },
    ]);
    expect(prompt).toContain('ARRIVAL: 30 September 2026');
    expect(prompt).toContain('DEPARTURE: 02 October 2026');
    expect(buildQuoteWorkflowPrompt(selection).user).toContain('DEPARTURE: 02 October 2026');
  });

  it('does not report DOCX as an identity change when office revalidation is unavailable', async () => {
    const doc = row({ id: 'voucher', filename: 'voucher.docx', mimeType: docxMime, sha256: 'a'.repeat(64) });
    const reader = createArtifactReader([doc], new AbortController().signal);
    vi.mocked(readAuthorizedArtifactBytes).mockClear();

    expect(await reader(doc)).toEqual({ text: null, reason: 'not a PDF' });
    expect(readAuthorizedArtifactBytes).not.toHaveBeenCalled();
  });

  it('drops an unknown-type part whose bytes are an image, and lists a non-image one as not a PDF', async () => {
    const result = await readQuoteAttachments(
      [
        row({ id: 'logo', filename: 'attachment.bin', mimeType: 'application/octet-stream', sizeBytes: 30_000 }),
        row({ id: 'blob', filename: 'export.dat', mimeType: 'application/octet-stream', sizeBytes: 30_000 }),
      ],
      async (attachment) =>
        attachment.id === 'logo' ? { text: null, reason: 'image' } : { text: null, reason: 'not a PDF' },
    );
    expect(result).toEqual([
      {
        id: 'blob',
        filename: 'export.dat',
        mimeType: 'application/octet-stream',
        byteSize: 30_000,
        bytesPresent: false,
        readFailure: 'not a PDF',
      },
    ]);
  });

  it('lets PDFs claim the file cap before an unknown part, so a logo cannot push a voucher out', async () => {
    const read: string[] = [];
    const result = await readQuoteAttachments(
      [
        row({ id: 'logo', filename: 'attachment.bin', mimeType: 'application/octet-stream', sizeBytes: 30_000 }),
        row({ id: 'a' }),
        row({ id: 'b' }),
        row({ id: 'c' }),
      ],
      async (attachment) => {
        read.push(attachment.id);
        return { text: 'Voucher text' };
      },
    );
    expect(read).toEqual(['a', 'b', 'c']);
    expect(result.find((part) => part.id === 'logo')?.readFailure).toBe(
      'over the 3 file / 5 MB analysis limit',
    );
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

describe('resolveThreadConfirmationEvidence', () => {
  it('takes one exact dashed HMS number from a sibling confirmation PDF filename', () => {
    expect(
      resolveThreadConfirmationEvidence([{ filename: '57291630-1.pdf' }]),
    ).toEqual({ confirmation: '57291630-1', reason: null });
  });

  it('takes a dashed number from readable attachment text, not from a later message body', () => {
    expect(
      resolveThreadConfirmationEvidence([
        { filename: 'confirmation.pdf', text: 'Booking 73114001-1 is confirmed.' },
      ]),
    ).toEqual({ confirmation: '73114001-1', reason: null });
    expect(
      resolveThreadConfirmationEvidence([
        { filename: 'note.txt', text: undefined },
      ]),
    ).toEqual({ confirmation: null, reason: null });
  });

  it('fails closed when distinct dashed numbers appear on thread confirmation files', () => {
    const resolved = resolveThreadConfirmationEvidence([
      { filename: '57291630-1.pdf' },
      { filename: '73114001-1.pdf' },
    ]);
    expect(resolved.confirmation).toBeNull();
    expect(resolved.reason).toEqual(expect.any(String));
    expect(resolved.reason).not.toHaveLength(0);
  });

  it('never turns a bare eight-digit filename into a dashed HMS number', () => {
    expect(resolveThreadConfirmationEvidence([{ filename: 'ren_47360291.pdf' }])).toEqual({
      confirmation: null,
      reason: null,
    });
    expect(overlayHmsConfirmation('47360291', { confirmation: null, reason: null })).toEqual({
      confirmation: '47360291',
      reason: null,
    });
  });

  it('does not invent a number from unread, scanned, or over-limit PDFs', () => {
    expect(
      resolveThreadConfirmationEvidence([
        { filename: 'scan.pdf', readFailure: 'no readable text' },
        { filename: 'locked.pdf', readFailure: 'encrypted' },
        { filename: 'huge.pdf', readFailure: 'over the 3 file / 5 MB analysis limit' },
      ]),
    ).toEqual({ confirmation: null, reason: null });
  });

  it('keeps a valid selected HMS number and fills from evidence only when that number is missing', () => {
    expect(overlayHmsConfirmation('57291630-1', { confirmation: '73114001-1', reason: null })).toEqual({
      confirmation: '57291630-1',
      reason: null,
    });
    expect(overlayHmsConfirmation(null, { confirmation: '57291630-1', reason: null })).toEqual({
      confirmation: '57291630-1',
      reason: null,
    });
  });

  it('overlays the live analysis payload without touching guest-request attachments', () => {
    const payload = applyThreadConfirmationOverlay(
      {
        sourceRevision: 4,
        luna: { confirmationNumber: null, missing: [] },
        amendment: { confirmationNumber: null },
        reviewItems: [],
      },
      { confirmation: '57291630-1', reason: null },
    );
    expect(payload.sourceRevision).toBe(4);
    expect(payload.amendment?.confirmationNumber).toBe('57291630-1');
    expect(payload.luna?.confirmationNumber).toBe('57291630-1');
  });
});

function fakeThreadMailboxDb(input: {
  selected: Record<string, unknown>;
  threadMessages: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  orderByCalls: Array<{ table: string; args: unknown[] }>;
}) {
  let messageQueries = 0;
  const query = (table: string, rows: unknown[]) => {
    const builder = Object.assign(Promise.resolve(rows), {
      where: () => builder,
      limit: async () => rows,
      orderBy: (...args: unknown[]) => {
        input.orderByCalls.push({ table, args });
        return builder;
      },
    });
    return builder;
  };
  return {
    select: () => ({
      from: (table: object) => {
        const name = getTableName(table as never);
        if (name === 'message') {
          messageQueries += 1;
          const rows = messageQueries === 1 ? [input.selected] : input.threadMessages;
          return query(name, rows);
        }
        return query(name, input.attachments);
      },
    }),
  };
}

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

  it('resolves a later sibling confirmation PDF and keeps it out of the guest-request attachments', async () => {
    const orderByCalls: Array<{ table: string; args: unknown[] }> = [];
    const selected = {
      id: 'guest',
      threadId: 't1',
      subject: 'Change dates',
      textBody: 'Please move our stay.',
      receivedAt: new Date('2026-10-05T12:00:00Z'),
    };
    vi.mocked(getDb).mockReturnValue(
      fakeThreadMailboxDb({
        selected,
        threadMessages: [
          selected,
          {
            id: 'staff',
            threadId: 't1',
            textBody: 'Later body must not supply a number.',
            receivedAt: new Date('2026-10-06T09:00:00Z'),
          },
        ],
        attachments: [
          {
            id: 'guest-sheet',
            filename: 'dates.xlsx',
            mimeType: 'application/vnd.ms-excel',
            sizeBytes: 20_000,
            isInline: false,
            s3Key: 'attachments/guest/sheet',
            messageId: 'guest',
          },
          {
            id: 'staff-pdf',
            filename: '57291630-1.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1_000,
            isInline: false,
            s3Key: 'attachments/staff/conf',
            messageId: 'staff',
          },
          {
            id: 'other-thread',
            filename: '73114001-1.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1_000,
            isInline: false,
            s3Key: 'attachments/other/conf',
            messageId: 'other-guest',
          },
        ],
        orderByCalls,
      }) as never,
    );

    const loaded = await loadSyncedQuoteSelectionFromMailbox({
      transportId: 'transport-1',
      internetMessageId: '<guest@example.com>',
    });

    expect(loaded?.attachments.map((part) => part.filename)).toEqual(['dates.xlsx']);
    expect(loaded?.preceding).toEqual([]);
    expect(loaded?.threadConfirmation).toEqual({ confirmation: '57291630-1', reason: null });
  });
});

function amendmentRead(confirmationNumbers: string[]) {
  return {
    kind: 'amendment' as const,
    payload: {
      contact: { name: null, email: null, phone: null },
      agency: null,
      endClient: null,
      confirmationNumbers,
      stays: [],
      missing: [],
    },
    attachments: [] as const,
  };
}

describe('storedAnalysis thread confirmation overlay', () => {
  it('fills a stored amendment confirmation from sibling PDF evidence', () => {
    const analysis = storedAnalysis(amendmentRead([]), {}, { confirmation: '57291630-1', reason: null }).analysis;
    expect(analysis.amendment?.confirmationNumber).toBe('57291630-1');
    expect(analysis.luna.confirmationNumber).toBe('57291630-1');
  });

  it('fails closed on the stored path when thread PDFs disagree, and never dashes a bare number', () => {
    const ambiguous = storedAnalysis(amendmentRead(['47360291']), {}, {
      confirmation: null,
      reason: THREAD_CONFIRMATION_AMBIGUOUS,
    }).analysis;
    expect(ambiguous.amendment?.confirmationNumber).toBeNull();
    expect(ambiguous.reviewItems.some((item) => item.text.includes('more than one booking number'))).toBe(true);

    const bare = storedAnalysis(amendmentRead(['47360291']), {}, { confirmation: null, reason: null }).analysis;
    expect(bare.amendment?.confirmationNumber).toBe('47360291');
    expect(bare.amendment?.confirmationNumber).not.toBe('47360291-1');
  });
});
