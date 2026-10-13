import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelAdapter, ModelInvokeInput, ModelInvokeResult } from '../src/ai/bedrock/adapter.js';
import { createAzureLunaModel, LunaModelAdapter } from '../src/ai/bedrock/luna.js';
import { isScannedPdfVisionEnabled } from '../src/env.js';
import { extractVoucherGuest, readScannedVoucherPages } from '../src/ai/voucher-find.js';
import type { SyncedQuoteAttachment } from '../src/ai/quote-workflow-synced-selection.js';
import {
  assertPdfToolchain,
  extractEmbeddedPdfText,
  pdfSandboxArgv,
  renderPdfPagesForVision,
  renderPdfPagesForVisionWithMetadata,
  VISION_LONG_EDGE_PX,
  VISION_MAX_PAGES,
  type SandboxRunner,
} from '../src/mail/artifacts/read-artifact.js';

const here = fileURLToPath(new URL('.', import.meta.url));
// Image-only, four pages, no text layer. Real Poppler only runs on a host with bwrap.
const SCANNED_PDF = readFileSync(join(here, 'fixtures/scanned-voucher-4p.pdf'));
// The fake sandbox never parses this: only the %PDF- magic is checked before the render.
const PDF_STUB = Buffer.from('%PDF-1.4\n% scanned voucher stub\n');
const JPEG_STUB = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const SIGNAL = () => AbortSignal.timeout(5_000);

/** A fake sandbox: pdftoppm writes `pages` JPEG files into the output directory. Other tools are never asked. */
function fakeRenderer(pages: number, exitCode = 0) {
  const calls: Array<{ tool: string; outputDir?: string }> = [];
  const runner: SandboxRunner = async (tool, _inputPath, _signal, outputDir) => {
    calls.push({ tool, outputDir });
    if (outputDir) {
      for (let page = 1; page <= pages; page += 1) {
        await writeFile(join(outputDir, `page-${page}.jpg`), JPEG_STUB);
      }
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode };
  };
  return { runner, calls };
}

/** A fake model: answers with `output`, or throws when given an Error. Usage is fixed so the log can be checked. */
function fakeVision(output: Record<string, unknown> | Error) {
  const invoke = vi.fn(async (_input: ModelInvokeInput): Promise<ModelInvokeResult> => {
    if (output instanceof Error) throw output;
    return {
      modelId: 'gpt-6-luna',
      output,
      usage: {
        inputTokens: 1200,
        outputTokens: 40,
        totalTokens: 1240,
        latencyMs: 5,
        estimatedCostUsd: 0.0002,
        rateTableVersion: 'test-rates',
      },
    };
  });
  return { adapter: { invoke } as ModelAdapter, invoke };
}

const scanned: SyncedQuoteAttachment = {
  id: 'att-scan',
  filename: 'Smith_VCH_1879.pdf',
  mimeType: 'application/pdf',
  bytesPresent: true,
  pdf: new Uint8Array(PDF_STUB),
};
const withText: SyncedQuoteAttachment = {
  id: 'att-text',
  filename: 'Booking.pdf',
  mimeType: 'application/pdf',
  bytesPresent: true,
  text: 'Guest: Jones\nArrival: 1 Dec 2026',
};

function jpegSize(data: Uint8Array): { width: number; height: number } {
  let at = 2;
  while (at < data.length) {
    const marker = data[at + 1] ?? 0;
    const length = ((data[at + 2] ?? 0) << 8) | (data[at + 3] ?? 0);
    if (data[at] === 0xff && marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: ((data[at + 5] ?? 0) << 8) | (data[at + 6] ?? 0),
        width: ((data[at + 7] ?? 0) << 8) | (data[at + 8] ?? 0),
      };
    }
    at += 2 + length;
  }
  throw new Error('no JPEG frame header');
}

describe('U7 scanned PDF vision fallback', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is on only for the exact value SCANNED_PDF_VISION=on', () => {
    expect(isScannedPdfVisionEnabled({})).toBe(false);
    for (const value of ['off', '1', 'true', 'ON', '']) {
      expect(isScannedPdfVisionEnabled({ SCANNED_PDF_VISION: value })).toBe(false);
    }
    expect(isScannedPdfVisionEnabled({ SCANNED_PDF_VISION: 'on' })).toBe(true);
  });

  it('runs pdftoppm with a bound output dir and the page and size caps; text tools keep their argv', () => {
    const render = pdfSandboxArgv('pdftoppm', '/tmp/in/document.pdf', '/tmp/out');
    const after = (flag: string) => render[render.indexOf(flag) + 1];
    expect(after('--bind')).toBe('/tmp/out');
    expect(render).toContain('/output');
    expect(after('-scale-to')).toBe(String(VISION_LONG_EDGE_PX));
    expect(after('-l')).toBe(String(VISION_MAX_PAGES));
    expect(render).toContain('--fsize=2097152:2097152');
    expect(render.at(-1)).toBe('/output/page');
    expect(render.at(-2)).toBe('/input/document.pdf');
    expect(render).toContain('/usr/bin/pdftoppm');

    const text = pdfSandboxArgv('pdftotext', '/tmp/in/document.pdf');
    expect(text).not.toContain('--bind');
    expect(text).toContain('--fsize=262144:262144');
    expect(() => pdfSandboxArgv('pdftoppm', '/tmp/in/document.pdf')).toThrow(/output directory/);
  });

  it('renders one pdftoppm run and keeps only the first three pages, in page order', async () => {
    const { runner, calls } = fakeRenderer(5);
    const pages = await renderPdfPagesForVision(PDF_STUB, { runner });
    expect(calls.map((call) => call.tool)).toEqual(['pdftoppm']);
    expect(calls[0]?.outputDir).toBeTruthy();
    expect(pages?.map((page) => page.filename)).toEqual(['page-1.jpg', 'page-2.jpg', 'page-3.jpg']);
    expect(pages?.every((page) => page.mediaType === 'image/jpeg')).toBe(true);
  });

  it('reports source page count so a complete three-page PDF is not called truncated', async () => {
    const calls: string[] = [];
    const runner: SandboxRunner = async (tool, _inputPath, _signal, outputDir) => {
      calls.push(tool);
      if (tool === 'pdfinfo') {
        return {
          stdout: Buffer.from('Pages:           3\n'),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        };
      }
      for (let page = 1; page <= 3; page += 1) {
        await writeFile(join(outputDir!, `page-${page}.jpg`), JPEG_STUB);
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    const result = await renderPdfPagesForVisionWithMetadata(PDF_STUB, { runner });
    expect(calls).toEqual(['pdfinfo', 'pdftoppm']);
    expect(result).toMatchObject({ sourcePageCount: 3, truncated: false });
    expect(result?.pages).toHaveLength(3);
  });

  it('reports a longer source PDF as truncated after the three-page render cap', async () => {
    const runner: SandboxRunner = async (tool, _inputPath, _signal, outputDir) => {
      if (tool === 'pdfinfo') {
        return {
          stdout: Buffer.from('Pages:           4\n'),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        };
      }
      for (let page = 1; page <= 3; page += 1) {
        await writeFile(join(outputDir!, `page-${page}.jpg`), JPEG_STUB);
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };

    await expect(renderPdfPagesForVisionWithMetadata(PDF_STUB, { runner })).resolves.toMatchObject({
      sourcePageCount: 4,
      truncated: true,
      pages: expect.arrayContaining([expect.objectContaining({ mediaType: 'image/jpeg' })]),
    });
  });

  it('gives no pages, and no sandbox call, for a body that is not a PDF', async () => {
    const { runner, calls } = fakeRenderer(3);
    await expect(renderPdfPagesForVision(Buffer.from('plain text'), { runner })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('gives no pages when the render exits non-zero, errors, or writes nothing', async () => {
    await expect(renderPdfPagesForVision(PDF_STUB, { runner: fakeRenderer(3, 1).runner })).resolves.toBeNull();
    await expect(renderPdfPagesForVision(PDF_STUB, { runner: fakeRenderer(0).runner })).resolves.toBeNull();
    const broken: SandboxRunner = async () => {
      throw new Error('sandbox down');
    };
    await expect(renderPdfPagesForVision(PDF_STUB, { runner: broken })).resolves.toBeNull();
  });

  it('with the flag off, scanned files are untouched and no render or model call happens', async () => {
    const { runner, calls } = fakeRenderer(3);
    const { adapter, invoke } = fakeVision({ surname: 'Smith' });
    const out = await readScannedVoucherPages([scanned, withText], {
      enabled: false,
      adapter,
      signal: SIGNAL(),
      runner,
    });
    expect(out).toEqual([scanned, withText]);
    expect(calls).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('with the flag on, one scanned voucher gets one model call, and its fields read as guest text', async () => {
    const { runner } = fakeRenderer(2);
    const { adapter, invoke } = fakeVision({
      surname: 'Smith',
      arrival: '2026-11-12',
      departure: '2026-11-15',
      confirmationNumber: 'CV-88412',
    });
    const out = await readScannedVoucherPages([scanned, withText], {
      enabled: true,
      adapter,
      signal: SIGNAL(),
      runner,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    const sent = invoke.mock.calls[0]?.[0];
    expect(sent?.images?.map((image) => image.filename)).toEqual(['page-1.jpg', 'page-2.jpg']);
    expect(sent?.systemPrompt).toMatch(/Never return a payment card number/);
    expect(sent?.responseSchema).toBeDefined();

    const read = out.find((entry) => entry.id === 'att-scan');
    expect(read?.text).toBe(
      'Surname: Smith\nArrival: 2026-11-12\nDeparture: 2026-11-15\nConfirmation: CV-88412',
    );
    expect(out.find((entry) => entry.id === 'att-text')).toBe(withText);
    expect(
      extractVoucherGuest({ subject: '', bodyText: '', attachmentTexts: [read?.text ?? ''] }),
    ).toEqual({ lastName: 'Smith', arrival: '2026-11-12' });
    expect(console.info).toHaveBeenCalledWith(
      'scanned_voucher_vision',
      expect.objectContaining({ code: 'read', pages: 2, inputTokens: 1200, outputTokens: 40 }),
    );
  });

  it('masks a card number the model returns before the reader sees it', async () => {
    const { runner } = fakeRenderer(1);
    const { adapter } = fakeVision({ surname: 'Smith', confirmationNumber: '4111 1111 1111 1111' });
    const [read] = await readScannedVoucherPages([scanned], {
      enabled: true,
      adapter,
      signal: SIGNAL(),
      runner,
    });
    expect(read?.text).toBe('Surname: Smith\nConfirmation: [card ••••1111]');
    expect(read?.text).not.toMatch(/4111/);
  });

  it('a temp-dir setup or cleanup failure never throws: setup gives no pages, cleanup keeps the rendered pages', async () => {
    const { runner, calls } = fakeRenderer(2);
    vi.stubEnv('TMPDIR', '/nonexistent-nava-tmp');
    try {
      await expect(renderPdfPagesForVision(PDF_STUB, { runner })).resolves.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(calls).toHaveLength(0);
    // A read-only pages dir makes the recursive rm fail with EACCES after the pages are read.
    const locking: SandboxRunner = async (tool, inputPath, signal, outputDir) => {
      const result = await runner(tool, inputPath, signal, outputDir);
      await chmod(outputDir!, 0o500);
      return result;
    };
    try {
      const pages = await renderPdfPagesForVision(PDF_STUB, { runner: locking });
      expect(pages?.map((page) => page.filename)).toEqual(['page-1.jpg', 'page-2.jpg']);
    } finally {
      const pagesDir = calls.at(-1)!.outputDir!;
      await chmod(pagesDir, 0o700).catch(() => {});
      await rm(join(pagesDir, '..'), { recursive: true, force: true });
    }
  });

  it('a vision failure leaves the file unread, with no extra warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases: Array<{ runner: SandboxRunner; output: Record<string, unknown> | Error }> = [
      { runner: fakeRenderer(2).runner, output: new Error('model timeout') },
      {
        runner: fakeRenderer(2).runner,
        output: { surname: null, arrival: null, departure: null, confirmationNumber: null },
      },
      { runner: fakeRenderer(2, 1).runner, output: { surname: 'Smith' } },
    ];
    for (const { runner, output } of cases) {
      const { adapter } = fakeVision(output);
      const [read] = await readScannedVoucherPages([scanned], {
        enabled: true,
        adapter,
        signal: SIGNAL(),
        runner,
      });
      expect(read).toBe(scanned);
      expect(read?.text).toBeUndefined();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('the Luna adapter sends rendered pages as image parts, as the Azure route does', async () => {
    const bodies: unknown[] = [];
    const fetchStub = async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          created_at: 1,
          model: 'gpt-6-luna',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: '{"surname":"Smith"}', annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const adapter = new LunaModelAdapter({
      model: createAzureLunaModel({
        baseURL: 'https://voucher-test.invalid/openai/v1',
        apiKey: 'test-key',
        fetch: fetchStub as unknown as typeof fetch,
      }),
      reasoningEffort: 'medium',
    });
    await adapter.invoke({
      modelId: 'gpt-6-luna',
      systemPrompt: 'system',
      userPrompt: 'user',
      images: [{ filename: 'page-1.jpg', mediaType: 'image/jpeg', data: JPEG_STUB }],
      responseSchema: { type: 'object' },
    });
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0])).toContain(
      `data:image/jpeg;base64,${JPEG_STUB.toString('base64')}`,
    );
  });

  describe('real Poppler through the bwrap sandbox', () => {
    // Skips on a dev VPS without bwrap, the same way the U6 artifact suite does.
    const toolchainReady = (() => {
      try {
        assertPdfToolchain();
        return true;
      } catch {
        return false;
      }
    })();
    it.skipIf(!toolchainReady)(
      'reads a scanned PDF as no embedded text, then renders three JPEG pages within the long-edge cap',
      async () => {
        const result = await extractEmbeddedPdfText(
          {
            body: SCANNED_PDF,
            declaredSize: SCANNED_PDF.byteLength,
            declaredMime: 'application/pdf',
            objectMime: 'application/pdf',
          },
          {},
        );
        expect(result).toMatchObject({ status: 'manual_required', data: { reason: 'no_embedded_text' } });

        const pages = await renderPdfPagesForVision(SCANNED_PDF);
        expect(pages?.map((page) => page.filename)).toEqual(['page-1.jpg', 'page-2.jpg', 'page-3.jpg']);
        for (const page of pages ?? []) {
          const { width, height } = jpegSize(page.data);
          expect(Math.max(width, height)).toBeLessThanOrEqual(VISION_LONG_EDGE_PX);
        }
      },
    );
  });
});
