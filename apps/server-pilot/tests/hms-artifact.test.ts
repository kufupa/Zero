import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeS3Storage } from '../src/storage/s3.js';
import { MailEvidenceRefSchema, ToolResultSchema } from '../src/ai/draft-evidence.js';
import {
  ARTIFACT_MAX_INPUT_BYTES,
  ARTIFACT_MAX_OUTPUT_BYTES,
  ARTIFACT_MAX_PAGES,
  ARTIFACT_SUBPROCESS_TIMEOUT_MS,
  assertPdfToolchain,
  createToolLedger,
  extractEmbeddedPdfText,
  readAuthorizedArtifact,
  type AttachmentLocator,
  type SandboxRunner,
  type SandboxResult,
} from '../src/mail/artifacts/read-artifact.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const gateScript = readFileSync(
  join(here, '../deploy/pdf-text-gate.sh'),
  'utf8',
);
const implSource = readFileSync(
  join(here, '../src/mail/artifacts/read-artifact.ts'),
  'utf8',
);

function pdfFixtureBody(label = 'fixture'): Buffer {
  // Minimal PDF magic; real Poppler not required — runner is mocked.
  return Buffer.from(`%PDF-1.7\n% ${label}\n`);
}

function locator(overrides: Partial<AttachmentLocator> = {}): AttachmentLocator {
  return {
    s3Key: 'attachments/msg-1/000-note.pdf',
    mimeType: 'application/pdf',
    sizeBytes: pdfFixtureBody().byteLength,
    messageId: 'msg-1',
    ...overrides,
  };
}

function fixtureRunner(input: {
  pdfInfo?: string;
  text?: string;
  infoExit?: number;
  textExit?: number;
  hang?: boolean;
}): SandboxRunner & { commands: () => string[]; killed: () => boolean } {
  const commands: string[] = [];
  let killed = false;
  const runner = Object.assign(
    async (
      tool: 'pdfinfo' | 'pdftotext',
      _inputPath: string,
      signal?: AbortSignal,
    ): Promise<SandboxResult> => {
      commands.push(tool);
      if (input.hang) {
        return await new Promise<SandboxResult>((_resolve, reject) => {
          const onAbort = () => {
            killed = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (tool === 'pdfinfo') {
        return {
          stdout: Buffer.from(input.pdfInfo ?? 'Pages: 1\nEncrypted: no\n'),
          stderr: Buffer.alloc(0),
          exitCode: input.infoExit ?? 0,
        };
      }
      return {
        stdout: Buffer.from(input.text ?? 'Hello booking\n'),
        stderr: Buffer.alloc(0),
        exitCode: input.textExit ?? 0,
      };
    },
    {
      commands: () => commands,
      killed: () => killed,
    },
  );
  return runner;
}

describe('readAuthorizedArtifact', () => {
  it('blocks unauthorized attachment ID before S3', async () => {
    const s3 = new FakeS3Storage('artifact-test');
    const getSpy = vi.spyOn(s3, 'getObject');
    const runner = fixtureRunner({});

    const result = await readAuthorizedArtifact({
      attachmentId: 'foreign',
      authorizedAttachmentIds: new Set(['own']),
      s3,
      signal: AbortSignal.timeout(5_000),
      locator: locator(),
      runner,
    });

    expect(result.status).toBe('manual_required');
    expect(result.data.reason).toBe('unsupported');
    expect(result.draftReady).toBe(false);
    expect(getSpy).not.toHaveBeenCalled();
    expect(runner.commands()).toEqual([]);
  });

  it('reads text/plain with UTF-8 normalization', async () => {
    const body = Buffer.from('\uFEFFline1\r\nline2\0tail', 'utf8');
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-note.txt',
      body,
      contentType: 'text/plain',
    });

    const result = await readAuthorizedArtifact({
      attachmentId: 'att-txt',
      authorizedAttachmentIds: new Set(['att-txt']),
      s3,
      signal: AbortSignal.timeout(5_000),
      locator: locator({
        s3Key: 'attachments/msg-1/000-note.txt',
        mimeType: 'text/plain',
        sizeBytes: body.byteLength,
      }),
    });

    expect(result.status).toBe('ok');
    expect(result.draftReady).toBe(true);
    expect(result.data).toMatchObject({
      mimeType: 'text/plain',
      pageCount: null,
      reason: 'text',
    });
    expect(result.data.text).toBe('line1\nline2tail');
    expect(result.evidence.kind).toBe('mail_attachment');
    expect(result.evidence.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns ok for embedded PDF text via sandboxed runner', async () => {
    const body = pdfFixtureBody('embedded');
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-note.pdf',
      body,
      contentType: 'application/pdf',
    });
    const runner = fixtureRunner({
      pdfInfo: 'Pages: 2\nEncrypted: no\n',
      text: 'Confirmation CONF-99\n',
    });

    const result = await readAuthorizedArtifact({
      attachmentId: 'att-pdf',
      authorizedAttachmentIds: new Set(['att-pdf']),
      s3,
      signal: AbortSignal.timeout(5_000),
      locator: locator({ sizeBytes: body.byteLength }),
      runner,
    });

    expect(result.status).toBe('ok');
    expect(result.data).toMatchObject({
      mimeType: 'application/pdf',
      text: 'Confirmation CONF-99',
      pageCount: 2,
      reason: 'text',
    });
    expect(runner.commands()).toEqual(['pdfinfo', 'pdftotext']);
  });

  it('maps scanned/encrypted/malformed/unsupported to manual_required', async () => {
    const body = pdfFixtureBody('scan');
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-note.pdf',
      body,
      contentType: 'application/pdf',
    });

    const scanned = await readAuthorizedArtifact({
      attachmentId: 'att-1',
      authorizedAttachmentIds: new Set(['att-1']),
      s3,
      signal: AbortSignal.timeout(5_000),
      locator: locator({ sizeBytes: body.byteLength }),
      runner: fixtureRunner({
        pdfInfo: 'Pages: 1\nEncrypted: no\n',
        text: '   \f ',
      }),
    });
    expect(scanned).toMatchObject({
      status: 'manual_required',
      data: { reason: 'no_embedded_text', text: null },
    });

    const encrypted = await extractEmbeddedPdfText(
      {
        body,
        declaredSize: body.byteLength,
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
      },
      {
        runner: fixtureRunner({
          pdfInfo: 'Pages: 1\nEncrypted: yes\n',
        }),
      },
    );
    expect(encrypted).toMatchObject({
      status: 'manual_required',
      data: { reason: 'encrypted' },
    });

    const malformed = await extractEmbeddedPdfText(
      {
        body: Buffer.from('not-a-pdf'),
        declaredSize: 9,
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
      },
      { runner: fixtureRunner({}) },
    );
    expect(malformed).toMatchObject({
      status: 'manual_required',
      data: { reason: 'malformed' },
    });

    const getSpy = vi.spyOn(s3, 'getObject');
    const unsupported = await readAuthorizedArtifact({
      attachmentId: 'att-img',
      authorizedAttachmentIds: new Set(['att-img']),
      s3,
      signal: AbortSignal.timeout(5_000),
      locator: locator({
        s3Key: 'attachments/msg-1/000-pic.png',
        mimeType: 'image/png',
        sizeBytes: 4,
      }),
    });
    expect(unsupported).toMatchObject({
      status: 'manual_required',
      data: { reason: 'unsupported' },
    });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('enforces 20 MiB / 50 pages / 256 KiB / 10s limits', async () => {
    expect(ARTIFACT_MAX_INPUT_BYTES).toBe(20 * 1024 * 1024);
    expect(ARTIFACT_MAX_PAGES).toBe(50);
    expect(ARTIFACT_MAX_OUTPUT_BYTES).toBe(256 * 1024);
    expect(ARTIFACT_SUBPROCESS_TIMEOUT_MS).toBe(10_000);

    const body = pdfFixtureBody('limits');
    const tooManyPages = await extractEmbeddedPdfText(
      {
        body,
        declaredSize: body.byteLength,
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
      },
      {
        runner: fixtureRunner({
          pdfInfo: 'Pages: 51\nEncrypted: no\n',
        }),
      },
    );
    expect(tooManyPages.data.reason).toBe('too_many_pages');

    const hugeText = 'x'.repeat(ARTIFACT_MAX_OUTPUT_BYTES + 1);
    const tooLargeOut = await extractEmbeddedPdfText(
      {
        body,
        declaredSize: body.byteLength,
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
      },
      {
        runner: fixtureRunner({
          pdfInfo: 'Pages: 1\nEncrypted: no\n',
          text: hugeText,
        }),
      },
    );
    expect(tooLargeOut.data.reason).toBe('too_large');

    const s3 = new FakeS3Storage('artifact-test');
    const oversized = Buffer.alloc(ARTIFACT_MAX_INPUT_BYTES + 1, 0x41);
    // Pretend PDF magic at start so mime path is size-gated.
    oversized.write('%PDF-', 0);
    await s3.putObject({
      key: 'attachments/msg-1/000-big.pdf',
      body: oversized,
      contentType: 'application/pdf',
    });
    const tooLargeIn = await readAuthorizedArtifact({
      attachmentId: 'att-big',
      authorizedAttachmentIds: new Set(['att-big']),
      s3,
      signal: AbortSignal.timeout(5_000),
      locator: locator({
        s3Key: 'attachments/msg-1/000-big.pdf',
        sizeBytes: oversized.byteLength,
      }),
      runner: fixtureRunner({}),
    });
    expect(tooLargeIn.data.reason).toBe('too_large');
  });

  it('abort kills subprocess and deletes temp directory', async () => {
    const body = pdfFixtureBody('abort');
    const controller = new AbortController();
    const runner = fixtureRunner({ hang: true });
    const tempDirs: string[] = [];

    const pending = extractEmbeddedPdfText(
      {
        body,
        declaredSize: body.byteLength,
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
      },
      {
        runner,
        signal: controller.signal,
        onTempDir: (dir) => tempDirs.push(dir),
      },
    );

    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    const result = await pending;
    expect(result.data.reason).toBe('timeout');
    expect(runner.killed()).toBe(true);
    expect(tempDirs.length).toBe(1);
    await expect(
      import('node:fs/promises').then((fs) => fs.access(tempDirs[0]!)),
    ).rejects.toThrow();
  });

  it('missing binaries fail startup gate helper', () => {
    expect(() =>
      assertPdfToolchain((p) => p !== '/usr/bin/bwrap'),
    ).toThrow(/bwrap/);
  });

  it('records hash-bound mail evidence on common tool ledger', async () => {
    const body = Buffer.from('plain fact', 'utf8');
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-note.txt',
      body,
      contentType: 'text/plain',
    });
    const ledger = createToolLedger();

    const result = await readAuthorizedArtifact({
      attachmentId: 'att-ledger',
      authorizedAttachmentIds: new Set(['att-ledger']),
      s3,
      signal: AbortSignal.timeout(5_000),
      locator: locator({
        s3Key: 'attachments/msg-1/000-note.txt',
        mimeType: 'text/plain',
        sizeBytes: body.byteLength,
      }),
      ledger,
    });

    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]).toBe(result);
    expect(ToolResultSchema.parse(result)).toEqual(result);
    expect(MailEvidenceRefSchema.parse(result.evidence)).toMatchObject({
      kind: 'mail_attachment',
      toolId: 'mail_read_artifact',
      attachmentId: 'att-ledger',
      sourceHash: result.evidence.sourceHash,
    });
    expect(JSON.stringify(result)).not.toMatch(/attachments\/msg-1/);
  });

  it('never invokes OCR and gate/source omit OCR tools', () => {
    expect(implSource).not.toMatch(/tesseract|ocrmypdf/i);
    expect(gateScript).not.toMatch(/tesseract|ocrmypdf/i);
    expect(implSource).toMatch(/pdfinfo/);
    expect(implSource).toMatch(/pdftotext/);
    expect(gateScript).toMatch(/pdfinfo/);
    expect(gateScript).toMatch(/pdftotext/);
    expect(gateScript).toMatch(/bwrap/);
    expect(gateScript).toMatch(/prlimit/);
  });
});
