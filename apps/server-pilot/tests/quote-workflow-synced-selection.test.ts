import { describe, expect, it } from 'vitest';
import {
  orderCausalPreceding,
  readQuoteAttachments,
  type QuoteAttachmentRow,
} from '../src/ai/quote-workflow-synced-selection.js';

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
        row({ id: 'sheet', filename: 'rooming.xlsx', mimeType: 'application/vnd.ms-excel' }),
      ],
      async (attachment) => {
        read.push(attachment.id);
        return { text: 'Rooming list text' };
      },
    );
    expect(read).toEqual(['quote-ask']);
    expect(result).toEqual([
      { id: 'quote-ask', filename: 'quote-ask.pdf', byteSize: 1_000, bytesPresent: true, text: 'Rooming list text' },
      { id: 'sheet', filename: 'rooming.xlsx', byteSize: 1_000, bytesPresent: false, readFailure: 'not a PDF' },
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
