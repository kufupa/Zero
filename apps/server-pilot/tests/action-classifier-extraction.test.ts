import { describe, expect, it, vi } from 'vitest';
import {
  ACTION_CLASSIFICATION_RULES,
  buildInboundPrompt,
  extractInboundMail,
  EXTRACTION_MIN_IMAGE_BYTES,
  prepareExtractionVisionImages,
  type AttachmentRead,
} from '../src/ai/extraction/extract.js';
import type { ModelAdapter, ModelInvokeInput } from '../src/ai/bedrock/adapter.js';
import type { SyncedQuoteAttachment } from '../src/ai/quote-workflow-synced-selection.js';
import { selectionFor } from './fixtures/inbound-extraction.js';

const signal = new AbortController().signal;

function image(
  id: string,
  size = EXTRACTION_MIN_IMAGE_BYTES + 1,
  extra: Partial<SyncedQuoteAttachment> = {},
): SyncedQuoteAttachment {
  return {
    id,
    filename: `${id}.png`,
    mimeType: 'image/png',
    byteSize: size,
    image: { mediaType: 'image/png', data: new Uint8Array(size) },
    bytesPresent: true,
    ...extra,
  };
}

describe('generic action-classifier prompt', () => {
  it('uses the target and thread state, applies document precedence, and provides short synthetic examples', () => {
    expect(ACTION_CLASSIFICATION_RULES).toMatch(/TARGET message plus prior and next thread messages/i);
    expect(ACTION_CLASSIFICATION_RULES).toMatch(/acknowledgements?.*thanks.*FYI.*resolved.*no_action/i);
    expect(ACTION_CLASSIFICATION_RULES).toMatch(/agent\/TMC voucher.*new_booking/i);
    expect(ACTION_CLASSIFICATION_RULES).toMatch(/money already moved/i);
    expect(ACTION_CLASSIFICATION_RULES).toMatch(/invoices?.*folios?.*pro-forma.*statements?.*VCC.*refunds?.*remittance allocation.*billing/i);
    expect(ACTION_CLASSIFICATION_RULES).toMatch(/conference.*function.*rooming list.*group_event/i);
    expect(ACTION_CLASSIFICATION_RULES).toMatch(/sender domain alone/i);
    expect(ACTION_CLASSIFICATION_RULES).not.toMatch(/Centurion|HRCEN|Legacy Hotels/i);
    expect((ACTION_CLASSIFICATION_RULES.match(/Example \d+:/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect((ACTION_CLASSIFICATION_RULES.match(/Example \d+:/g) ?? []).length).toBeLessThanOrEqual(10);
  });

  it('places attachment text before thread history and caps the user prompt without silently marking a complete attachment read', () => {
    const selection = selectionFor('TARGET asks for availability.');
    selection.attachments.push({
      id: 'quote-text',
      filename: 'rates.txt',
      mimeType: 'text/plain',
      byteSize: 150,
      text: 'ATTACHMENT_EVIDENCE '.repeat(6),
      bytesPresent: true,
    });
    selection.threadMessages = [
      {
        direction: 'outbound',
        timestamp: '2026-10-10T12:00:00.000Z',
        subject: 'Reply',
        bodyText: 'THREAD_HISTORY '.repeat(1_000),
      },
    ];

    const prompt = buildInboundPrompt(selection, undefined, undefined, { maxChars: 1_000 });
    expect(prompt.user.length).toBeLessThanOrEqual(1_000);
    expect(prompt.user.indexOf('ATTACHMENT_EVIDENCE')).toBeGreaterThanOrEqual(0);
    expect(prompt.user.indexOf('ATTACHMENT_EVIDENCE')).toBeLessThan(prompt.user.indexOf('THREAD CONTEXT'));
    expect(prompt.attachmentReads).toMatchObject([{ id: 'quote-text', status: 'read' }]);
  });

  it('marks an attachment not-read when its text excerpt or the prompt cap truncates it', () => {
    const selection = selectionFor('Please review the attached document.');
    selection.attachments.push({
      id: 'long-text',
      filename: 'long.txt',
      mimeType: 'text/plain',
      byteSize: 25_000,
      text: 'x'.repeat(25_000),
      bytesPresent: true,
    });
    const perAttachment = buildInboundPrompt(selection, undefined, undefined, { maxChars: 200_000 });
    expect(perAttachment.attachmentReads).toMatchObject([
      { id: 'long-text', status: 'not_read', truncated: true },
    ]);

    const promptLimited = buildInboundPrompt(selection, undefined, undefined, { maxChars: 300 });
    expect(promptLimited.user.length).toBeLessThanOrEqual(300);
    expect(promptLimited.attachmentReads).toMatchObject([
      { id: 'long-text', status: 'not_read', truncated: true },
    ]);
  });

  it('reports clipped or omitted thread history and uses the selected message timestamp fallback', () => {
    const selection = selectionFor('Target message.');
    selection.receivedAt = undefined;
    selection.threadReferenceAt = '2026-10-13T12:00:00.000Z';
    selection.threadMessages = [
      {
        direction: 'inbound',
        timestamp: '2026-10-10T12:00:00.000Z',
        subject: 'Older request',
        bodyText: 'OLDER_HISTORY '.repeat(1_000),
      },
      {
        direction: 'outbound',
        timestamp: '2026-10-13T11:00:00.000Z',
        subject: 'Resolution',
        bodyText: 'The request is resolved.',
      },
    ];

    const nearTargetFirst = buildInboundPrompt(selection);
    expect(nearTargetFirst.user).toContain('The request is resolved.');
    expect(nearTargetFirst.threadContextTruncated).toBe(true);
    expect(nearTargetFirst.system).toMatch(/thread context status: incomplete/i);

    const omittedByPromptCap = buildInboundPrompt(selection, undefined, undefined, { maxChars: 100 });
    expect(omittedByPromptCap.threadContextTruncated).toBe(true);
    expect(omittedByPromptCap.system).toMatch(/thread context status: incomplete/i);
  });
});

describe('extraction call budget', () => {
  it('uses the configured effort for both the request token cap and deadline', async () => {
    for (const budget of [
      { effort: 'medium', deadlineMs: 60_000, maxOutputTokens: 16_000 },
      { effort: 'max', deadlineMs: 180_000, maxOutputTokens: 48_000 },
    ] as const) {
      const calls: ModelInvokeInput[] = [];
      const adapter: ModelAdapter = {
        invoke: async (input) => {
          calls.push(input);
          return {
            modelId: input.modelId,
            output: {},
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              latencyMs: 0,
              estimatedCostUsd: 0,
              rateTableVersion: 'test',
            },
          };
        },
      };
      const startedAt = Date.now();

      const result = await extractInboundMail({
        adapter,
        selection: selectionFor('Synthetic extraction request.'),
        messageId: 'synthetic-message',
        env: { EXTRACTION_REASONING_EFFORT: budget.effort, EXTRACTION_VISION: 'off' },
      });

      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.maxOutputTokens).toBe(budget.maxOutputTokens);
      expect(calls[0]?.deadlineAt).toBeGreaterThanOrEqual(startedAt + budget.deadlineMs - 1_000);
      expect(calls[0]?.deadlineAt).toBeLessThanOrEqual(startedAt + budget.deadlineMs + 1_000);
    }
  });
});

describe('extraction vision inputs', () => {
  it('gates vision off explicitly and honestly marks eligible visual sources unread', async () => {
    const renderPdf = vi.fn(async () => []);
    const result = await prepareExtractionVisionImages([image('inline', 21_000, { isInline: true }), image('ok')], {
      enabled: false,
      signal,
      renderPdf,
    });

    expect(result.images).toEqual([]);
    expect(renderPdf).not.toHaveBeenCalled();
    expect(result.attachmentReads).toMatchObject([
      { id: 'inline', status: 'not_read' },
      { id: 'ok', status: 'not_read', reason: 'vision disabled by EXTRACTION_VISION' },
    ]);
  });

  it('sends at most four image parts, skips inline/tiny images, and marks a dropped source truncated', async () => {
    const result = await prepareExtractionVisionImages(
      [
        image('one'),
        image('two'),
        image('three'),
        image('four'),
        image('five'),
        image('signature', EXTRACTION_MIN_IMAGE_BYTES),
        image('inline', 21_000, { isInline: true }),
      ],
      { enabled: true, signal, renderPdf: vi.fn(async () => []) },
    );

    expect(result.images).toHaveLength(4);
    expect(result.attachmentReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'four', status: 'read' }),
        expect.objectContaining({ id: 'five', status: 'not_read', truncated: true }),
        expect.objectContaining({ id: 'signature', status: 'not_read' }),
        expect.objectContaining({ id: 'inline', status: 'not_read' }),
      ]),
    );
  });

  it('limits each scanned PDF to three pages and the combined request to four images', async () => {
    const pdf: SyncedQuoteAttachment = {
      id: 'scan',
      filename: 'scan.pdf',
      mimeType: 'application/pdf',
      byteSize: 100,
      pdf: new Uint8Array([37, 80, 68, 70, 45]),
      bytesPresent: true,
    };
    const pages = Array.from({ length: 5 }, (_, index) => ({
      filename: `page-${index + 1}.jpg`,
      mediaType: 'image/jpeg' as const,
      data: new Uint8Array([index + 1]),
    }));
    const renderPdf = vi.fn(async () => pages);
    const result = await prepareExtractionVisionImages([pdf], { enabled: true, signal, renderPdf });

    expect(renderPdf).toHaveBeenCalledOnce();
    expect(result.images).toHaveLength(3);
    expect(result.attachmentReads).toMatchObject([
      { id: 'scan', status: 'not_read', truncated: true },
    ]);

    const mixed = await prepareExtractionVisionImages(
      [pdf, image('direct')],
      { enabled: true, signal, renderPdf: async () => pages },
    );
    expect(mixed.images).toHaveLength(4);
  });

  it('distinguishes a complete three-page PDF from a longer PDF truncated by the renderer', async () => {
    const pdf: SyncedQuoteAttachment = {
      id: 'three-page-scan',
      filename: 'three-page-scan.pdf',
      mimeType: 'application/pdf',
      byteSize: 100,
      pdf: new Uint8Array([37, 80, 68, 70, 45]),
      bytesPresent: true,
    };
    const pages = Array.from({ length: 3 }, (_, index) => ({
      filename: `page-${index + 1}.jpg`,
      mediaType: 'image/jpeg' as const,
      data: new Uint8Array([index + 1]),
    }));
    const complete = await prepareExtractionVisionImages([pdf], {
      enabled: true,
      renderPdf: async () => ({ pages, sourcePageCount: 3, truncated: false }),
    });
    expect(complete.attachmentReads).toMatchObject([{ id: 'three-page-scan', status: 'read' }]);
    expect(complete.attachmentReads[0]?.truncated).toBeUndefined();

    const partial = await prepareExtractionVisionImages([pdf], {
      enabled: true,
      renderPdf: async () => ({ pages, sourcePageCount: 4, truncated: true }),
    });
    expect(partial.attachmentReads).toMatchObject([
      { id: 'three-page-scan', status: 'not_read', truncated: true },
    ]);
  });
});

// Keep this import-used type local to the tests: it documents the audit contract exposed to storage.
const _attachmentReadTypecheck: AttachmentRead | null = null;
void _attachmentReadTypecheck;
