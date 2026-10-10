import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeS3Storage, S3ObjectTooLargeError } from '../src/storage/s3.js';
import { MailEvidenceRefSchema, ToolResultSchema } from '../src/ai/draft-evidence.js';
import {
  ARTIFACT_MAX_INPUT_BYTES,
  ARTIFACT_MAX_OUTPUT_BYTES,
  ARTIFACT_MAX_PAGES,
  ARTIFACT_SUBPROCESS_TIMEOUT_MS,
  MAIL_READ_ARTIFACT_TOOL_VERSION,
  assertPdfToolchain,
  createToolLedger,
  extractEmbeddedPdfText,
  recheckAuthorizedArtifactIdentity,
  readAuthorizedArtifact,
  readAuthorizedArtifactBytes,
  sniffImageBytes,
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

function resolveLocatorOf(
  loc: AttachmentLocator | null,
): (attachmentId: string) => Promise<AttachmentLocator | null> {
  return async () => loc;
}

function fixtureRunner(input: {
  pdfInfo?: string;
  text?: string;
  infoExit?: number;
  infoStderr?: string;
  textExit?: number;
  textStderr?: string;
  /** The sandbox killed pdftotext for writing past its output cap. */
  textTruncated?: boolean;
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
          stderr: Buffer.from(input.infoStderr ?? ''),
          exitCode: input.infoExit ?? 0,
        };
      }
      return {
        stdout: Buffer.from(input.text ?? 'Hello booking\n'),
        stderr: Buffer.from(input.textStderr ?? ''),
        exitCode: input.textExit ?? 0,
        ...(input.textTruncated ? { truncated: true } : {}),
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
  it('publishes v2 candidate-only evidence', async () => {
    const body = Buffer.from('Confirmation CONF-88421', 'utf8');
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-note.txt',
      body,
      contentType: 'text/plain',
    });
    const result = await readAuthorizedArtifact({
      attachmentId: 'att-v2',
      authorizedAttachmentIds: new Set(['att-v2']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'attachments/msg-1/000-note.txt',
          mimeType: 'text/plain',
          sizeBytes: body.byteLength,
        }),
      ),
    });
    expect(MAIL_READ_ARTIFACT_TOOL_VERSION).toBe('2');
    expect(result.status).toBe('ok');
    expect(result.draftReady).toBe(false);
    expect(result.evidence.claimKeys).toEqual([]);
    expect(result.evidence.toolVersion).toBe('2');
  });

  it('blocks unauthorized attachment ID before resolveLocator and S3', async () => {
    const s3 = new FakeS3Storage('artifact-test');
    const getSpy = vi.spyOn(s3, 'getObjectBounded');
    const resolveLocator = vi.fn(resolveLocatorOf(locator()));
    const runner = fixtureRunner({});

    const result = await readAuthorizedArtifact({
      attachmentId: 'foreign',
      authorizedAttachmentIds: new Set(['own']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator,
      runner,
    });

    expect(result.status).toBe('manual_required');
    expect(result.data.reason).toBe('unsupported');
    expect(result.draftReady).toBe(false);
    expect(resolveLocator).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    expect(runner.commands()).toEqual([]);
  });

  it('returns manual when resolveLocator is null without S3', async () => {
    const s3 = new FakeS3Storage('artifact-test');
    const getSpy = vi.spyOn(s3, 'getObjectBounded');
    const resolveLocator = vi.fn(async () => null);

    const result = await readAuthorizedArtifact({
      attachmentId: 'att-missing',
      authorizedAttachmentIds: new Set(['att-missing']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator,
      runner: fixtureRunner({}),
    });

    expect(result.status).toBe('manual_required');
    expect(result.data.reason).toBe('malformed');
    expect(resolveLocator).toHaveBeenCalledWith('att-missing');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('rejects wrong-prefix locator key before S3', async () => {
    const s3 = new FakeS3Storage('artifact-test');
    const getSpy = vi.spyOn(s3, 'getObjectBounded');

    const result = await readAuthorizedArtifact({
      attachmentId: 'att-prefix',
      authorizedAttachmentIds: new Set(['att-prefix']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'raw-mime/other/poison.eml',
          messageId: 'msg-1',
        }),
      ),
      runner: fixtureRunner({}),
    });

    expect(result.status).toBe('manual_required');
    expect(result.data.reason).toBe('unsupported');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('fails closed when declared sizeBytes small but stored body huge', async () => {
    const s3 = new FakeS3Storage('artifact-test');
    const huge = Buffer.alloc(1024 * 1024, 0x41);
    huge.write('%PDF-', 0);
    await s3.putObject({
      key: 'attachments/msg-1/000-note.pdf',
      body: huge,
      contentType: 'application/pdf',
    });
    const getSpy = vi.spyOn(s3, 'getObjectBounded');
    const declared = 32;

    const result = await readAuthorizedArtifact({
      attachmentId: 'att-mismatch',
      authorizedAttachmentIds: new Set(['att-mismatch']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({ sizeBytes: declared }),
      ),
      runner: fixtureRunner({}),
    });

    expect(result.status).toBe('manual_required');
    expect(result.data.reason).toBe('malformed');
    expect(getSpy).toHaveBeenCalledWith(
      'attachments/msg-1/000-note.pdf',
      declared,
      expect.any(AbortSignal),
    );
    await expect(getSpy.mock.results[0]?.value).rejects.toBeInstanceOf(
      S3ObjectTooLargeError,
    );
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
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'attachments/msg-1/000-note.txt',
          mimeType: 'text/plain',
          sizeBytes: body.byteLength,
        }),
      ),
    });

    expect(result.status).toBe('ok');
    expect(result.draftReady).toBe(false);
    expect(result.data).toMatchObject({
      mimeType: 'text/plain',
      pageCount: null,
      reason: 'text',
    });
    expect(result.data.text).toBe('line1\nline2tail');
    expect(result.evidence.kind).toBe('mail_attachment');
    expect(result.evidence.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects text/plain when streamed contentType mismatches', async () => {
    const body = Buffer.from('hello', 'utf8');
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-note.txt',
      body,
      contentType: 'application/octet-stream',
    });

    const result = await readAuthorizedArtifact({
      attachmentId: 'att-txt-mime',
      authorizedAttachmentIds: new Set(['att-txt-mime']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'attachments/msg-1/000-note.txt',
          mimeType: 'text/plain',
          sizeBytes: body.byteLength,
        }),
      ),
    });

    expect(result.status).toBe('manual_required');
    expect(result.data.reason).toBe('unsupported');
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
      resolveLocator: resolveLocatorOf(locator({ sizeBytes: body.byteLength })),
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
      resolveLocator: resolveLocatorOf(locator({ sizeBytes: body.byteLength })),
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
        // A user password: pdftotext refuses with Poppler's exact diagnostic. Owner-only locks read (see below).
        runner: fixtureRunner({
          pdfInfo: 'Pages: 1\nEncrypted: yes\n',
          textExit: 1,
          textStderr: 'Command Line Error: Incorrect password\n',
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

    const getSpy = vi.spyOn(s3, 'getObjectBounded');
    const unsupported = await readAuthorizedArtifact({
      attachmentId: 'att-img',
      authorizedAttachmentIds: new Set(['att-img']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'attachments/msg-1/000-pic.png',
          mimeType: 'image/png',
          sizeBytes: 4,
        }),
      ),
    });
    expect(unsupported).toMatchObject({
      status: 'manual_required',
      data: { reason: 'unsupported' },
    });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('maps parser dependency failure without exposing parser error text', async () => {
    const body = pdfFixtureBody('parser-failure');
    const result = await extractEmbeddedPdfText(
      {
        body,
        declaredSize: body.byteLength,
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
      },
      {
        runner: async () => {
          throw new Error('private parser stderr payload');
        },
      },
    );
    expect(result).toMatchObject({
      status: 'manual_required',
      data: { reason: 'parser_failure', text: null },
    });
    expect(JSON.stringify(result)).not.toContain('private parser stderr payload');
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
    const getSpy = vi.spyOn(s3, 'getObjectBounded');
    const tooLargeIn = await readAuthorizedArtifact({
      attachmentId: 'att-big',
      authorizedAttachmentIds: new Set(['att-big']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'attachments/msg-1/000-big.pdf',
          sizeBytes: oversized.byteLength,
        }),
      ),
      runner: fixtureRunner({}),
    });
    expect(tooLargeIn.data.reason).toBe('too_large');
    expect(getSpy).not.toHaveBeenCalled();
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

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(runner.killed()).toBe(true);
    expect(tempDirs.length).toBe(1);
    await expect(
      import('node:fs/promises').then((fs) => fs.access(tempDirs[0]!)),
    ).rejects.toThrow();
  });

  it('propagates caller abort during S3 read', async () => {
    const controller = new AbortController();
    const s3 = new FakeS3Storage('artifact-test');
    const bounded = vi.spyOn(s3, 'getObjectBounded').mockImplementation(
      async (_key, _max, signal) =>
        await new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );
    const pending = readAuthorizedArtifact({
      attachmentId: 'att-abort',
      authorizedAttachmentIds: new Set(['att-abort']),
      s3,
      signal: controller.signal,
      resolveLocator: resolveLocatorOf(locator()),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(bounded).toHaveBeenCalledWith(
      'attachments/msg-1/000-note.pdf',
      pdfFixtureBody().byteLength,
      controller.signal,
    );
  });

  it('rechecks authorization, locator metadata, and S3 bytes without parsing', async () => {
    const body = pdfFixtureBody('identity');
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-note.pdf',
      body,
      contentType: 'application/pdf',
    });
    const loc = locator({ sizeBytes: body.byteLength });
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    await expect(
      recheckAuthorizedArtifactIdentity({
        attachmentId: 'att-id',
        authorizedAttachmentIds: new Set(['att-id']),
        expectedLocator: loc,
        expectedSha256,
        s3,
        signal: AbortSignal.timeout(5_000),
        resolveLocator: resolveLocatorOf(loc),
      }),
    ).resolves.toBe(true);
    await expect(
      recheckAuthorizedArtifactIdentity({
        attachmentId: 'att-id',
        authorizedAttachmentIds: new Set(),
        expectedLocator: loc,
        expectedSha256,
        s3,
        signal: AbortSignal.timeout(5_000),
        resolveLocator: resolveLocatorOf(loc),
      }),
    ).resolves.toBe(false);
    await expect(
      recheckAuthorizedArtifactIdentity({
        attachmentId: 'att-id',
        authorizedAttachmentIds: new Set(['att-id']),
        expectedLocator: loc,
        expectedSha256: '0'.repeat(64),
        s3,
        signal: AbortSignal.timeout(5_000),
        resolveLocator: resolveLocatorOf(loc),
      }),
    ).resolves.toBe(false);
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
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'attachments/msg-1/000-note.txt',
          mimeType: 'text/plain',
          sizeBytes: body.byteLength,
        }),
      ),
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

  it('rejects non-finite sizeBytes before S3', async () => {
    const s3 = new FakeS3Storage('artifact-test');
    const getSpy = vi.spyOn(s3, 'getObjectBounded');
    const result = await readAuthorizedArtifact({
      attachmentId: 'att-nan',
      authorizedAttachmentIds: new Set(['att-nan']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({ sizeBytes: Number.NaN }),
      ),
      runner: fixtureRunner({}),
    });
    expect(result.status).toBe('manual_required');
    expect(result.data.reason).toBe('malformed');
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe('PDF read gates (U6)', () => {
  const pdfInput = (body: Buffer) => ({
    body,
    declaredSize: body.byteLength,
    declaredMime: 'application/pdf',
    objectMime: 'application/pdf',
  });

  it('reads an owner-locked PDF with text, and masks the card and CVV on the way out', async () => {
    const body = pdfFixtureBody('owner-locked');
    const result = await extractEmbeddedPdfText(pdfInput(body), {
      runner: fixtureRunner({
        pdfInfo: 'Pages: 1\nEncrypted: yes (print:yes copy:no change:no addNotes:no algorithm:RC4)\n',
        text: 'Guest: Mr John Smith\nVirtual card number: 4111 1111 1111 1111\nCVV: 123\n',
      }),
    });
    expect(result).toMatchObject({ status: 'ok', data: { reason: 'text' } });
    expect(result.data.text).toContain('Guest: Mr John Smith');
    expect(result.data.text).toContain('[card ••••1111]');
    expect(result.data.text).toContain('CVV: [code masked]');
    expect(result.data.text).not.toContain('4111');
    expect(result.data.text).not.toContain('123');
  });

  it('keeps a user-password PDF encrypted when pdfinfo itself refuses it', async () => {
    const body = pdfFixtureBody('user-locked');
    const result = await extractEmbeddedPdfText(pdfInput(body), {
      runner: fixtureRunner({ infoExit: 1, infoStderr: 'Command Line Error: Incorrect password\n' }),
    });
    expect(result).toMatchObject({ status: 'manual_required', data: { reason: 'encrypted' } });
  });

  it('reports a sandbox that cannot start as a reader failure, never as a damaged PDF', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const body = pdfFixtureBody('owner-locked');
      // AppArmor's userns restriction on an unconfined service: bubblewrap fails before Poppler runs.
      const result = await extractEmbeddedPdfText(pdfInput(body), {
        runner: fixtureRunner({ infoExit: 1, infoStderr: 'bwrap: setting up uid map: Permission denied\n' }),
      });
      expect(result).toMatchObject({ status: 'manual_required', data: { reason: 'parser_failure' } });
      expect(warn).toHaveBeenCalledWith('pdf_sandbox_unavailable', {
        tool: 'pdfinfo',
        error: 'bwrap: setting up uid map: Permission denied',
      });

      const textStep = await extractEmbeddedPdfText(pdfInput(body), {
        runner: fixtureRunner({ textExit: 1, textStderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n' }),
      });
      expect(textStep).toMatchObject({ status: 'manual_required', data: { reason: 'parser_failure' } });

      // Poppler's own non-password error on a real parse is still "malformed".
      const broken = await extractEmbeddedPdfText(pdfInput(body), {
        runner: fixtureRunner({ infoExit: 1, infoStderr: 'Syntax Error: Couldn\'t find trailer dictionary\n' }),
      });
      expect(broken).toMatchObject({ status: 'manual_required', data: { reason: 'malformed' } });

      // A document-controlled Poppler line that happens to start with "bwrap: " is not a sandbox failure.
      warn.mockClear();
      const spoofed = await extractEmbeddedPdfText(pdfInput(body), {
        runner: fixtureRunner({ infoExit: 1, infoStderr: "Syntax Error: Unknown font tag 'F1\nbwrap: Jane Doe'\n" }),
      });
      expect(spoofed).toMatchObject({ status: 'manual_required', data: { reason: 'malformed' } });
      expect(warn).not.toHaveBeenCalledWith('pdf_sandbox_unavailable', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('reads an octet-stream part named .pdf by its %PDF- magic, with card digits masked', async () => {
    const body = pdfFixtureBody('voucher');
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-voucher.pdf',
      body,
      contentType: 'application/octet-stream',
    });
    const result = await readAuthorizedArtifact({
      attachmentId: 'att-vch',
      authorizedAttachmentIds: new Set(['att-vch']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'attachments/msg-1/000-voucher.pdf',
          mimeType: 'application/octet-stream',
          sizeBytes: body.byteLength,
        }),
      ),
      runner: fixtureRunner({ text: 'Virtual card 4111 1111 1111 1111\n' }),
    });
    expect(result).toMatchObject({ status: 'ok', data: { reason: 'text' } });
    expect(result.data.text).toContain('[card ••••1111]');
    expect(result.data.text).not.toContain('4111');
  });

  it('refuses an octet-stream part that is not named .pdf, before any S3 read', async () => {
    const body = pdfFixtureBody('unnamed');
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-booking.bin',
      body,
      contentType: 'application/octet-stream',
    });
    const getSpy = vi.spyOn(s3, 'getObjectBounded');
    const result = await readAuthorizedArtifact({
      attachmentId: 'att-bin',
      authorizedAttachmentIds: new Set(['att-bin']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'attachments/msg-1/000-booking.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: body.byteLength,
        }),
      ),
      runner: fixtureRunner({}),
    });
    expect(result).toMatchObject({ status: 'manual_required', data: { reason: 'unsupported' } });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('binds an Outlook-sync original to its DB sha256: a matching sha is read, a mismatch is refused', async () => {
    const body = pdfFixtureBody('sealed');
    const sha = createHash('sha256').update(body).digest('hex');
    const key = `outlook-sync-originals/v1/${'a'.repeat(64)}/${sha}`;
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({ key, body, contentType: 'application/pdf' });
    const read = (dbSha: string) =>
      readAuthorizedArtifact({
        attachmentId: 'att-sealed',
        authorizedAttachmentIds: new Set(['att-sealed']),
        s3,
        signal: AbortSignal.timeout(5_000),
        resolveLocator: resolveLocatorOf(
          locator({ s3Key: key, sizeBytes: body.byteLength, sha256: dbSha }),
        ),
        runner: fixtureRunner({ text: 'Booking ABC123\n' }),
      });
    expect(await read(sha)).toMatchObject({ status: 'ok', data: { reason: 'text' } });
    expect(await read('b'.repeat(64))).toMatchObject({
      status: 'manual_required',
      data: { reason: 'unsupported' },
    });
  });

  it('refuses an Outlook-sync original whose stored bytes do not hash to its key', async () => {
    const body = pdfFixtureBody('sealed');
    const swapped = pdfFixtureBody('swapped-bytes');
    const sha = createHash('sha256').update(body).digest('hex');
    const key = `outlook-sync-originals/v1/${'a'.repeat(64)}/${sha}`;
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({ key, body: swapped, contentType: 'application/pdf' });
    const result = await readAuthorizedArtifact({
      attachmentId: 'att-sealed',
      authorizedAttachmentIds: new Set(['att-sealed']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({ s3Key: key, sizeBytes: swapped.byteLength, sha256: sha }),
      ),
      runner: fixtureRunner({ text: 'Booking ABC123\n' }),
    });
    expect(result).toMatchObject({ status: 'manual_required', data: { reason: 'malformed' } });
  });

  it('reports pdftotext output past the 256 KiB cap as too_large, not as a parser failure', async () => {
    const body = pdfFixtureBody('big');
    const result = await extractEmbeddedPdfText(pdfInput(body), {
      runner: fixtureRunner({
        text: 'x'.repeat(ARTIFACT_MAX_OUTPUT_BYTES),
        textExit: -1,
        textTruncated: true,
      }),
    });
    expect(result).toMatchObject({ status: 'manual_required', data: { reason: 'too_large' } });
  });

  it('sniffs an octet-stream logo: its bytes come back only when allowSniff is set, and image magic is an image', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(24),
    ]);
    const s3 = new FakeS3Storage('artifact-test');
    await s3.putObject({
      key: 'attachments/msg-1/000-logo.bin',
      body: png,
      contentType: 'application/octet-stream',
    });
    const request = {
      attachmentId: 'att-logo',
      authorizedAttachmentIds: new Set(['att-logo']),
      s3,
      signal: AbortSignal.timeout(5_000),
      resolveLocator: resolveLocatorOf(
        locator({
          s3Key: 'attachments/msg-1/000-logo.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: png.byteLength,
        }),
      ),
    };
    const sniffed = await readAuthorizedArtifactBytes({ ...request, allowSniff: true });
    expect(sniffed && sniffImageBytes(sniffed.body)).toBe(true);
    expect(await readAuthorizedArtifactBytes(request)).toBeNull();
    expect(sniffImageBytes(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toBe(true);
    expect(sniffImageBytes(pdfFixtureBody())).toBe(false);
  });

  // Real Poppler through the bwrap sandbox. Runs only on a host with the full toolchain, so it skips on a dev VPS.
  const toolchainReady = (() => {
    try {
      assertPdfToolchain();
      return true;
    } catch {
      return false;
    }
  })();
  describe.skipIf(!toolchainReady)('real Poppler through the sandbox', () => {
    const fixture = (name: string) => readFileSync(join(here, 'fixtures', name));

    it('reads the owner-locked voucher (no user password, copy:no) and masks its card', async () => {
      const result = await extractEmbeddedPdfText(pdfInput(fixture('voucher-owner-locked.pdf')), {});
      expect(result).toMatchObject({ status: 'ok', data: { reason: 'text' } });
      expect(result.data.text).toContain('[card ••••1111]');
      expect(result.data.text).not.toContain('4111 1111');
    });

    it('keeps the user-password voucher encrypted', async () => {
      const result = await extractEmbeddedPdfText(pdfInput(fixture('voucher-user-locked.pdf')), {});
      expect(result).toMatchObject({ status: 'manual_required', data: { reason: 'encrypted' } });
    });
  });
});
