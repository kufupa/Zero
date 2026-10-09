import {
  buildPrivateThreadCorpusSnapshot,
  formatLogicalMessages,
  type FormattedLogicalMessages,
  type PrivateThreadCorpusSnapshotContext,
  type ThreadCorpusAttachmentDescriptor,
  type ThreadCorpusAttachmentLocator,
  type ThreadCorpusSourceRow,
} from '../src/ops/centurion-thread-corpus-snapshot.js';
import {
  DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS,
  hydrateThreadCorpusArtifacts,
  type ThreadCorpusHydrationLimits,
} from '../src/ops/centurion-thread-corpus-hydrator.js';
import { type SandboxResult, type SandboxRunner } from '../src/mail/artifacts/read-artifact.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function makeAttachment(
  id: string,
  messageId: string,
  contentType: string,
  byteSize: number,
): ThreadCorpusAttachmentDescriptor {
  return {
    id,
    messageId,
    filename: `${id}.synthetic`,
    contentType,
    byteSize,
  };
}

function makeLocator(
  attachmentId: string,
  messageId: string,
  s3Key: string,
  mimeType: string,
  sizeBytes: number,
): ThreadCorpusAttachmentLocator {
  return { attachmentId, messageId, s3Key, mimeType, sizeBytes };
}

function makeRow(input: {
  id: string;
  raw?: { locator: string | null; status: string | null };
  attachments?: ThreadCorpusAttachmentDescriptor[];
  body?: string;
}): ThreadCorpusSourceRow {
  return {
    sourceRowId: input.id,
    scopeMembership: ['active_transport'],
    receivedAt: '2026-08-22T11:00:00.000Z',
    threadId: `thread-${input.id}`,
    messageId: `<${input.id}@synthetic.test>`,
    contentFingerprint: `content-${input.id}`,
    provenanceFingerprint: `provenance-${input.id}`,
    body: input.body ?? `SYNTHETIC_BODY_${input.id}`,
    privateMessage: {
      subject: `Synthetic ${input.id}`,
      direction: 'inbound',
      addresses: { from: [], to: [], cc: [], bcc: [] },
      originalAddresses: { from: [], to: [], cc: [], bcc: [] },
      canonicalHeaders: {},
      sentAt: null,
      rawMime: input.raw ?? { locator: null, status: 'missing' },
      attachments: input.attachments ?? [],
      draftRevisionLinks: [],
      outboundDelivery: { queueState: 'unknown', deliveryStatus: 'not_claimed' },
      sourceMetadata: {
        transportId: 'transport-centurion',
      },
    },
  };
}

function format(rows: readonly ThreadCorpusSourceRow[]): FormattedLogicalMessages {
  return formatLogicalMessages(rows);
}

function snapshotContext(): PrivateThreadCorpusSnapshotContext {
  return {
    snapshotId: 'task8-synthetic-snapshot',
    scope: {
      scopeKeys: ['active_transport'],
      transportIds: ['transport-centurion'],
      messagePredicate: 'active_transport_before_as_of',
    },
    asOf: '2026-08-22T12:00:00.000Z',
    exporterVersion: 'task8-test',
  };
}

function payloadStatus(
  hydration: Awaited<ReturnType<typeof hydrateThreadCorpusArtifacts>>,
  kind: 'raw_mime' | 'attachment_text',
  ownerId: string,
): string {
  const payload = hydration.payloads.find((candidate) => {
    if (kind === 'raw_mime') {
      return candidate.kind === 'raw_mime' && candidate.sourceRowId === ownerId;
    }
    return candidate.kind === 'attachment_text' && candidate.attachmentId === ownerId;
  });
  expect(payload).toBeDefined();
  return payload!.status;
}

function retainedBytes(
  hydration: Awaited<ReturnType<typeof hydrateThreadCorpusArtifacts>>,
): number {
  return hydration.payloads.reduce(
    (total, payload) =>
      total + (payload.status === 'available' ? (payload.content?.byteLength ?? 0) : 0),
    0,
  );
}

function payloadIds(hydration: Awaited<ReturnType<typeof hydrateThreadCorpusArtifacts>>): string[] {
  return hydration.payloads.map((payload) =>
    payload.kind === 'raw_mime'
      ? `${payload.kind}:${payload.sourceRowId}`
      : `${payload.kind}:${payload.attachmentId}`,
  );
}

function pdfBody(label = 'fixture'): Buffer {
  return Buffer.from(`%PDF-1.7\n${label}\n`, 'utf8');
}

function abortError(): Error {
  return Object.assign(new Error('synthetic abort'), { name: 'AbortError' });
}

function pdfRunner(input: {
  info?: string;
  text?: string;
  infoExit?: number;
  textExit?: number;
  textStderr?: string;
  throwError?: Error;
  waitForAbort?: boolean;
}): SandboxRunner {
  return async (
    tool: 'pdfinfo' | 'pdftotext',
    _inputPath: string,
    signal?: AbortSignal,
  ): Promise<SandboxResult> => {
    if (input.waitForAbort) {
      return await new Promise<SandboxResult>((_resolve, reject) => {
        const onAbort = () => reject(abortError());
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (input.throwError) throw input.throwError;
    if (tool === 'pdfinfo') {
      return {
        stdout: Buffer.from(input.info ?? 'Pages: 1\nEncrypted: no\n'),
        stderr: Buffer.alloc(0),
        exitCode: input.infoExit ?? 0,
      };
    }
    return {
      stdout: Buffer.from(input.text ?? 'Synthetic PDF text\n'),
      stderr: Buffer.from(input.textStderr ?? ''),
      exitCode: input.textExit ?? 0,
    };
  };
}

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('hydrateThreadCorpusArtifacts', () => {
  it('accepts active-only formatted input and rejects legacy quarantine fields before reads', async () => {
    const storage = new FakeS3Storage('active-only-contract');
    const legacyFormatted = format([
      makeRow({
        id: 'active-only',
        raw: { locator: 'raw-mime/active-only/source.eml', status: 'pending_hydration' },
      }),
    ]);
    const activeOnlyFormatted = {
      threads: legacyFormatted.threads,
    } as unknown as FormattedLogicalMessages;

    await expect(
      hydrateThreadCorpusArtifacts({
        formatted: activeOnlyFormatted,
        attachmentLocators: [],
        storage,
      }),
    ).resolves.toMatchObject({
      attachmentLocators: [],
    });

    const legacyRoot = {
      ...activeOnlyFormatted,
      quarantineRecords: [],
    } as FormattedLogicalMessages;
    const legacyLogical = structuredClone(activeOnlyFormatted) as unknown as {
      threads: Array<{ messages: Array<Record<string, unknown>> }>;
    };
    legacyLogical.threads[0]!.messages[0]!.quarantined = false;
    const legacySource = structuredClone(activeOnlyFormatted) as unknown as {
      threads: Array<{
        messages: Array<{ sourceRows: Array<Record<string, unknown>> }>;
      }>;
    };
    legacySource.threads[0]!.messages[0]!.sourceRows[0]!.isQuarantined = false;

    for (const formatted of [legacyRoot, legacyLogical, legacySource]) {
      const readsBeforeLegacyInput = storage.calls.filter(
        (call) => call.op === 'GET_BOUNDED',
      ).length;
      const legacyMessage = await errorMessage(
        hydrateThreadCorpusArtifacts({
          formatted: formatted as FormattedLogicalMessages,
          attachmentLocators: [],
          storage,
        }),
      );
      expect(legacyMessage).toBe('Invalid thread corpus hydration input');
      expect(storage.calls.filter((call) => call.op === 'GET_BOUNDED')).toHaveLength(
        readsBeforeLegacyInput,
      );
    }
  });

  it('hydrates synthetic raw MIME, text, and PDF in canonical order and seals opaque refs', async () => {
    const storage = new FakeS3Storage('task8-order');
    const rawAKey = 'raw-mime/row-a/a.eml';
    const rawBKey = 'raw-mime/row-b/b.eml';
    const textKey = 'attachments/row-a/a.txt';
    const pdfKey = 'attachments/row-b/b.pdf';
    const textBody = Buffer.from('\uFEFFtext line\r\nsecond\0', 'utf8');
    const pdf = pdfBody('order');
    await storage.putObject({
      key: rawAKey,
      body: Buffer.from([1, 2]),
      contentType: 'message/rfc822',
    });
    await storage.putObject({
      key: rawBKey,
      body: Buffer.from([3, 4]),
      contentType: 'message/rfc822',
    });
    await storage.putObject({
      key: textKey,
      body: textBody,
      contentType: 'text/plain; charset=utf-8',
    });
    await storage.putObject({
      key: pdfKey,
      body: pdf,
      contentType: 'APPLICATION/PDF; version=1.7',
    });

    const textLocator = makeLocator(
      'att-a-text',
      'row-a',
      textKey,
      'text/plain',
      textBody.byteLength,
    );
    const pdfLocator = makeLocator(
      'att-b-pdf',
      'row-b',
      pdfKey,
      'Application/PDF; charset=binary',
      pdf.byteLength,
    );
    const formatted = format([
      makeRow({
        id: 'row-b',
        raw: { locator: rawBKey, status: 'pending_hydration' },
        attachments: [
          makeAttachment('att-b-pdf', 'row-b', pdfLocator.mimeType, pdf.byteLength),
          makeAttachment('att-b-no-locator', 'row-b', 'text/plain', 0),
        ],
      }),
      makeRow({
        id: 'row-a',
        raw: { locator: rawAKey, status: 'pending_hydration' },
        attachments: [makeAttachment('att-a-text', 'row-a', 'text/plain', textBody.byteLength)],
      }),
    ]);

    const hydration = await hydrateThreadCorpusArtifacts({
      formatted,
      attachmentLocators: [pdfLocator, textLocator],
      storage,
      pdfRunner: pdfRunner({ text: 'PDF booking\r\n' }),
    });
    const snapshot = buildPrivateThreadCorpusSnapshot({
      context: snapshotContext(),
      formatted,
      hydration,
    });

    expect(
      storage.calls.filter((call) => call.op === 'GET_BOUNDED').map((call) => call.key),
    ).toEqual([rawAKey, rawBKey, textKey, pdfKey]);
    expect(hydration.attachmentLocators.map((locator) => locator.attachmentId)).toEqual([
      'att-a-text',
      'att-b-pdf',
    ]);
    expect(payloadIds(hydration)).toEqual([
      'attachment_text:att-a-text',
      'attachment_text:att-b-pdf',
      'raw_mime:row-a',
      'raw_mime:row-b',
    ]);
    expect(payloadStatus(hydration, 'raw_mime', 'row-a')).toBe('available');
    expect(payloadStatus(hydration, 'raw_mime', 'row-b')).toBe('available');
    expect(payloadStatus(hydration, 'attachment_text', 'att-a-text')).toBe('available');
    expect(payloadStatus(hydration, 'attachment_text', 'att-b-pdf')).toBe('available');
    expect(snapshot.artifactFiles.map((file) => file.kind)).toEqual([
      'attachment_text',
      'attachment_text',
      'raw_mime',
      'raw_mime',
    ]);
    for (const locator of [rawAKey, rawBKey, textKey, pdfKey]) {
      expect(snapshot.corpusJsonl).not.toContain(locator);
      expect(snapshot.manifestJson).not.toContain(locator);
    }
  });

  it('maps object failures with fixed pre-read precedence and skips forbidden calls', async () => {
    const storage = new FakeS3Storage('task8-statuses');
    const rawTooLargeKey = 'raw-mime/raw-too-large/x.eml';
    const attachmentMismatchKey = 'attachments/row-att/mismatch.txt';
    const attachmentMimeKey = 'attachments/row-att/mime.txt';
    await storage.putObject({
      key: rawTooLargeKey,
      body: Buffer.from('1234'),
      contentType: 'message/rfc822',
    });
    await storage.putObject({
      key: attachmentMismatchKey,
      body: Buffer.from('abc'),
      contentType: 'text/plain',
    });
    await storage.putObject({
      key: attachmentMimeKey,
      body: Buffer.from('abc'),
      contentType: 'application/pdf',
    });

    const locators = [
      makeLocator('att-missing', 'row-att', 'attachments/row-att/missing.txt', 'text/plain', 1),
      makeLocator(
        'att-declared-too-large',
        'row-att',
        'attachments/row-att/large.txt',
        'text/plain',
        5,
      ),
      makeLocator('att-invalid-key', 'row-att', 'wrong-prefix/att.txt', 'text/plain', 1),
      makeLocator('att-unsupported', 'row-att', 'attachments/row-att/image.jpg', 'image/jpeg', 1),
      makeLocator('att-size-mismatch', 'row-att', attachmentMismatchKey, 'text/plain', 2),
      makeLocator(
        'att-mime-mismatch',
        'row-att',
        attachmentMimeKey,
        'TEXT/PLAIN; charset=utf-8',
        3,
      ),
    ];
    const formatted = format([
      makeRow({
        id: 'raw-missing',
        raw: { locator: 'raw-mime/raw-missing/x.eml', status: 'pending_hydration' },
      }),
      makeRow({
        id: 'raw-too-large',
        raw: { locator: rawTooLargeKey, status: 'pending_hydration' },
      }),
      makeRow({
        id: 'raw-invalid',
        raw: { locator: 'not-raw/raw-invalid', status: 'pending_hydration' },
      }),
      makeRow({
        id: 'row-att',
        attachments: locators.map((locator) =>
          makeAttachment(
            locator.attachmentId,
            locator.messageId,
            locator.mimeType,
            locator.sizeBytes,
          ),
        ),
      }),
    ]);

    const hydration = await hydrateThreadCorpusArtifacts({
      formatted,
      attachmentLocators: locators,
      storage,
      limits: { maxRawMimeBytes: 3, maxAttachmentInputBytes: 4 },
    });

    expect(payloadStatus(hydration, 'raw_mime', 'raw-missing')).toBe('expired_or_missing');
    expect(payloadStatus(hydration, 'raw_mime', 'raw-too-large')).toBe('too_large');
    expect(payloadStatus(hydration, 'raw_mime', 'raw-invalid')).toBe('read_failed');
    expect(payloadStatus(hydration, 'attachment_text', 'att-missing')).toBe('expired_or_missing');
    expect(payloadStatus(hydration, 'attachment_text', 'att-declared-too-large')).toBe('too_large');
    expect(payloadStatus(hydration, 'attachment_text', 'att-invalid-key')).toBe('read_failed');
    expect(payloadStatus(hydration, 'attachment_text', 'att-unsupported')).toBe('unsupported');
    expect(payloadStatus(hydration, 'attachment_text', 'att-size-mismatch')).toBe('malformed');
    expect(payloadStatus(hydration, 'attachment_text', 'att-mime-mismatch')).toBe('unsupported');
    const readKeys = storage.calls
      .filter((call) => call.op === 'GET_BOUNDED')
      .map((call) => call.key);
    expect(readKeys).not.toContain('not-raw/raw-invalid');
    expect(readKeys).not.toContain('wrong-prefix/att.txt');
    expect(readKeys).not.toContain('attachments/row-att/image.jpg');
    expect(readKeys).not.toContain('attachments/row-att/large.txt');
  });

  it('retains non-empty images only in attachment-inclusive mode and marks zero-byte files malformed', async () => {
    const storage = new FakeS3Storage('task8-inclusive-edge-cases');
    const imageKey = 'attachments/row-inclusive/image.png';
    const zeroPdfKey = 'attachments/row-inclusive/empty.pdf';
    await storage.putObject({
      key: imageKey,
      body: Buffer.from([1, 2, 3]),
      contentType: 'image/png',
    });
    await storage.putObject({
      key: zeroPdfKey,
      body: Buffer.alloc(0),
      contentType: 'application/pdf',
    });
    const image = makeLocator('att-image', 'row-inclusive', imageKey, 'image/png', 3);
    const zeroPdf = makeLocator('att-zero-pdf', 'row-inclusive', zeroPdfKey, 'application/pdf', 0);
    const formatted = format([
      makeRow({
        id: 'row-inclusive',
        attachments: [
          makeAttachment(image.attachmentId, image.messageId, image.mimeType, image.sizeBytes),
          makeAttachment(zeroPdf.attachmentId, zeroPdf.messageId, zeroPdf.mimeType, zeroPdf.sizeBytes),
        ],
      }),
    ]);

    const hydration = await hydrateThreadCorpusArtifacts({
      formatted,
      attachmentLocators: [image, zeroPdf],
      storage,
      retainAttachmentBytes: true,
      pdfRunner: pdfRunner({ text: 'should not run for an empty PDF' }),
    });

    expect(payloadStatus(hydration, 'attachment_text', image.attachmentId)).toBe('unsupported');
    expect(payloadStatus(hydration, 'attachment_text', zeroPdf.attachmentId)).toBe('malformed');
    expect(
      hydration.payloads.find(
        (payload) => payload.kind === 'attachment_bytes' && payload.attachmentId === image.attachmentId,
      ),
    ).toMatchObject({ kind: 'attachment_bytes', status: 'available', content: new Uint8Array([1, 2, 3]) });
    expect(
      hydration.payloads.find(
        (payload) => payload.kind === 'attachment_bytes' && payload.attachmentId === zeroPdf.attachmentId,
      ),
    ).toEqual({ kind: 'attachment_bytes', attachmentId: zeroPdf.attachmentId, status: 'malformed' });
    expect(() =>
      buildPrivateThreadCorpusSnapshot({
        context: snapshotContext(),
        formatted,
        hydration,
      }),
    ).not.toThrow();
  });

  it('defers raw MIME in attachment-inclusive mode so attachment bytes receive the aggregate budget', async () => {
    const storage = new FakeS3Storage('task8-attachment-budget-priority');
    const rawKey = 'raw-mime/row-priority/source.eml';
    const pdfKey = 'attachments/row-priority/booking.pdf';
    const pdf = pdfBody('booking');
    await storage.putObject({
      key: rawKey,
      body: Buffer.alloc(64, 7),
      contentType: 'message/rfc822',
    });
    await storage.putObject({
      key: pdfKey,
      body: pdf,
      contentType: 'application/pdf',
    });
    const locator = makeLocator(
      'att-priority-pdf',
      'row-priority',
      pdfKey,
      'application/pdf',
      pdf.byteLength,
    );
    const formatted = format([
      makeRow({
        id: 'row-priority',
        raw: { locator: rawKey, status: 'available' },
        attachments: [
          makeAttachment(locator.attachmentId, locator.messageId, locator.mimeType, locator.sizeBytes),
        ],
      }),
    ]);

    const hydration = await hydrateThreadCorpusArtifacts({
      formatted,
      attachmentLocators: [locator],
      storage,
      retainAttachmentBytes: true,
      retainRawMime: false,
      pdfRunner: pdfRunner({ text: 'booking confirmation' }),
      limits: { maxTotalArtifactBytes: 128 },
    });

    expect(hydration.retainRawMime).toBe(false);
    expect(payloadStatus(hydration, 'raw_mime', 'row-priority')).toBe('budget_exhausted');
    expect(
      hydration.payloads.find(
        (payload) =>
          payload.kind === 'attachment_bytes' && payload.attachmentId === locator.attachmentId,
      ),
    ).toMatchObject({ status: 'available' });
    expect(storage.calls.filter((call) => call.op === 'GET_BOUNDED').map((call) => call.key)).not.toContain(
      rawKey,
    );
    expect(() =>
      buildPrivateThreadCorpusSnapshot({
        context: snapshotContext(),
        formatted,
        hydration,
      }),
    ).not.toThrow();
  });

  it('skips inline decorative images before S3 hydration', async () => {
    const storage = new FakeS3Storage('task8-decorative-image-filter');
    const key = 'attachments/row-decorative/logo.png';
    const image = {
      ...makeLocator('att-decorative', 'row-decorative', key, 'image/png', 3),
      filename: 'logo.png',
      inline: true,
    } as ThreadCorpusAttachmentLocator;
    const formatted = format([
      makeRow({
        id: 'row-decorative',
        attachments: [
          {
            ...makeAttachment(image.attachmentId, image.messageId, image.mimeType, image.sizeBytes),
            filename: image.filename,
            inline: image.inline,
          },
        ],
      }),
    ]);

    const hydration = await hydrateThreadCorpusArtifacts({
      formatted,
      attachmentLocators: [image],
      storage,
      retainAttachmentBytes: true,
    });

    expect(payloadStatus(hydration, 'attachment_text', image.attachmentId)).toBe('unsupported');
    expect(
      hydration.payloads.find(
        (payload) =>
          payload.kind === 'attachment_bytes' && payload.attachmentId === image.attachmentId,
      ),
    ).toEqual({ kind: 'attachment_bytes', attachmentId: image.attachmentId, status: 'unsupported' });
    expect(storage.calls.filter((call) => call.op === 'GET_BOUNDED')).toHaveLength(0);
  });

  it('uses injected PDF runner outcomes, normalized MIME, and configured output cap', async () => {
    const cases: Array<{
      id: string;
      declaredMime: string;
      objectMime: string;
      runner: SandboxRunner;
      expected: string;
      limits?: Partial<ThreadCorpusHydrationLimits>;
    }> = [
      {
        id: 'text',
        declaredMime: 'Application/PDF; charset=binary',
        objectMime: 'APPLICATION/PDF; version=1.7',
        runner: pdfRunner({ text: 'PDF text\r\n' }),
        expected: 'available',
      },
      {
        id: 'encrypted',
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
        // A user password: pdftotext refuses with Poppler's diagnostic. An owner-only lock would extract text.
        runner: pdfRunner({
          info: 'Pages: 1\nEncrypted: yes\n',
          textExit: 1,
          textStderr: 'Command Line Error: Incorrect password\n',
        }),
        expected: 'encrypted',
      },
      {
        id: 'malformed',
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
        runner: pdfRunner({ infoExit: 1 }),
        expected: 'malformed',
      },
      {
        id: 'page-limit',
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
        runner: pdfRunner({ info: 'Pages: 51\nEncrypted: no\n' }),
        expected: 'too_many_pages',
      },
      {
        id: 'parser',
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
        runner: pdfRunner({ throwError: new Error('SYNTHETIC_PDF_RUNNER_FAILURE') }),
        expected: 'parser_failure',
      },
      {
        id: 'lower-cap',
        declaredMime: 'application/pdf',
        objectMime: 'application/pdf',
        runner: pdfRunner({ text: 'long PDF text' }),
        expected: 'too_large',
        limits: { maxAttachmentTextBytes: 3 },
      },
    ];

    for (const current of cases) {
      const storage = new FakeS3Storage(`task8-pdf-${current.id}`);
      const body = pdfBody(current.id);
      const key = `attachments/row-${current.id}/${current.id}.pdf`;
      const locator = makeLocator(
        `att-${current.id}`,
        `row-${current.id}`,
        key,
        current.declaredMime,
        body.byteLength,
      );
      await storage.putObject({ key, body, contentType: current.objectMime });
      const hydration = await hydrateThreadCorpusArtifacts({
        formatted: format([
          makeRow({
            id: `row-${current.id}`,
            attachments: [
              makeAttachment(
                locator.attachmentId,
                locator.messageId,
                locator.mimeType,
                locator.sizeBytes,
              ),
            ],
          }),
        ]),
        attachmentLocators: [locator],
        storage,
        pdfRunner: current.runner,
        limits: current.limits,
      });

      expect(payloadStatus(hydration, 'attachment_text', locator.attachmentId)).toBe(
        current.expected,
      );
    }

    const timeoutStorage = new FakeS3Storage('task8-pdf-timeout');
    const timeoutBody = pdfBody('timeout');
    const timeoutKey = 'attachments/row-timeout/timeout.pdf';
    const timeoutLocator = makeLocator(
      'att-timeout',
      'row-timeout',
      timeoutKey,
      'application/pdf',
      timeoutBody.byteLength,
    );
    await timeoutStorage.putObject({
      key: timeoutKey,
      body: timeoutBody,
      contentType: 'application/pdf',
    });
    const timeoutHydration = await hydrateThreadCorpusArtifacts({
      formatted: format([
        makeRow({
          id: 'row-timeout',
          attachments: [
            makeAttachment(
              timeoutLocator.attachmentId,
              timeoutLocator.messageId,
              timeoutLocator.mimeType,
              timeoutLocator.sizeBytes,
            ),
          ],
        }),
      ]),
      attachmentLocators: [timeoutLocator],
      storage: timeoutStorage,
      pdfRunner: pdfRunner({ waitForAbort: true }),
      limits: { perObjectTimeoutMs: 100, perObjectAbortGraceMs: 250 },
    });
    expect(payloadStatus(timeoutHydration, 'attachment_text', 'att-timeout')).toBe('timeout');
  });

  it('applies aggregate retained-byte budget deterministically across caller order', async () => {
    const rawAKey = 'raw-mime/raw-a/a.eml';
    const rawBKey = 'raw-mime/raw-b/b.eml';
    const attachmentAKey = 'attachments/raw-a/a.txt';
    const attachmentBKey = 'attachments/raw-b/b.txt';
    const rows = [
      makeRow({
        id: 'raw-b',
        raw: { locator: rawBKey, status: 'pending_hydration' },
        attachments: [makeAttachment('att-b', 'raw-b', 'text/plain', 1)],
      }),
      makeRow({
        id: 'raw-a',
        raw: { locator: rawAKey, status: 'pending_hydration' },
        attachments: [makeAttachment('att-a', 'raw-a', 'text/plain', 1)],
      }),
    ];
    const locators = [
      makeLocator('att-b', 'raw-b', attachmentBKey, 'text/plain', 1),
      makeLocator('att-a', 'raw-a', attachmentAKey, 'text/plain', 1),
    ];

    const hydrateInOrder = async (
      rowsInput: readonly ThreadCorpusSourceRow[],
      locatorsInput: readonly ThreadCorpusAttachmentLocator[],
    ) => {
      const storage = new FakeS3Storage('task8-budget');
      await storage.putObject({
        key: rawAKey,
        body: Buffer.from('aa'),
        contentType: 'message/rfc822',
      });
      await storage.putObject({
        key: rawBKey,
        body: Buffer.from('bb'),
        contentType: 'message/rfc822',
      });
      await storage.putObject({
        key: attachmentAKey,
        body: Buffer.from('a'),
        contentType: 'text/plain',
      });
      await storage.putObject({
        key: attachmentBKey,
        body: Buffer.from('b'),
        contentType: 'text/plain',
      });
      const hydration = await hydrateThreadCorpusArtifacts({
        formatted: format(rowsInput),
        attachmentLocators: locatorsInput,
        storage,
        limits: {
          maxRawMimeBytes: 2,
          maxAttachmentInputBytes: 2,
          maxAttachmentTextBytes: 2,
          maxTotalArtifactBytes: 3,
        },
      });
      return {
        hydration,
        reads: storage.calls.filter((call) => call.op === 'GET_BOUNDED').map((call) => call.key),
      };
    };

    const forward = await hydrateInOrder(rows, locators);
    const reversed = await hydrateInOrder([...rows].reverse(), [...locators].reverse());

    expect(reversed.hydration).toEqual(forward.hydration);
    expect(reversed.reads).toEqual(forward.reads);
    expect(payloadStatus(forward.hydration, 'raw_mime', 'raw-b')).toBe('budget_exhausted');
    expect(payloadStatus(forward.hydration, 'attachment_text', 'att-b')).toBe('budget_exhausted');
    expect(payloadStatus(forward.hydration, 'raw_mime', 'raw-b')).not.toBe('too_large');
    expect(retainedBytes(forward.hydration)).toBe(3);
  });

  it('keeps raw objects above their per-object cap classified as too_large', async () => {
    const storage = new FakeS3Storage('task8-budget-vs-cap');
    const rawKey = 'raw-mime/raw-over-cap/raw.eml';
    await storage.putObject({
      key: rawKey,
      body: Buffer.from('12345'),
      contentType: 'message/rfc822',
    });

    const hydration = await hydrateThreadCorpusArtifacts({
      formatted: format([
        makeRow({
          id: 'raw-over-cap',
          raw: { locator: rawKey, status: 'pending_hydration' },
        }),
      ]),
      attachmentLocators: [],
      storage,
      limits: { maxRawMimeBytes: 4, maxTotalArtifactBytes: 3 },
    });

    expect(payloadStatus(hydration, 'raw_mime', 'raw-over-cap')).toBe('too_large');
  });

  it('hydrates attachment reads in bounded parallel batches while committing budget canonically', async () => {
    const bodies = new Map<string, Buffer>([
      ['attachments/row-parallel/a.txt', Buffer.from('a')],
      ['attachments/row-parallel/b.txt', Buffer.from('bb')],
      ['attachments/row-parallel/c.txt', Buffer.from('ccc')],
    ]);
    let active = 0;
    let maxActive = 0;
    const storage = {
      async getObjectBounded(key: string): Promise<{ body: Buffer; contentType: string } | null> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, key.endsWith('/a.txt') ? 12 : 2));
        active -= 1;
        const body = bodies.get(key);
        return body ? { body, contentType: 'text/plain' } : null;
      },
    };
    const locators = [...bodies.entries()].map(([key, body], index) =>
      makeLocator(`att-${index}`, 'row-parallel', key, 'text/plain', body.byteLength),
    );
    const hydration = await hydrateThreadCorpusArtifacts({
      formatted: format([
        makeRow({
          id: 'row-parallel',
          attachments: locators.map((locator) =>
            makeAttachment(
              locator.attachmentId,
              locator.messageId,
              locator.mimeType,
              locator.sizeBytes,
            ),
          ),
        }),
      ]),
      attachmentLocators: locators,
      storage,
      attachmentConcurrency: 2,
      limits: { maxTotalArtifactBytes: 3 },
    });

    expect(maxActive).toBe(2);
    expect(payloadStatus(hydration, 'attachment_text', 'att-0')).toBe('available');
    expect(payloadStatus(hydration, 'attachment_text', 'att-1')).toBe('available');
    expect(payloadStatus(hydration, 'attachment_text', 'att-2')).toBe('budget_exhausted');
    expect(retainedBytes(hydration)).toBe(3);
  });

  it('freezes resolved defaults, honors overrides, clones output, and preserves inputs', async () => {
    expect(Object.isFrozen(DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS)).toBe(true);
    expect(DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS).toMatchObject({
      maxRawMimeBytes: 25 * 1024 * 1024,
      maxAttachmentInputBytes: 20 * 1024 * 1024,
      maxAttachmentTextBytes: 256 * 1024,
      maxTotalArtifactBytes: 256 * 1024 * 1024,
      perObjectTimeoutMs: 15_000,
      perObjectAbortGraceMs: 250,
    });

    const storage = new FakeS3Storage('task8-clones');
    const rawKey = 'raw-mime/row-clone/clone.eml';
    const attachmentKey = 'attachments/row-clone/clone.txt';
    const rawBody = Buffer.from('raw!');
    const attachmentBody = Buffer.from('txt');
    await storage.putObject({ key: rawKey, body: rawBody, contentType: 'message/rfc822' });
    await storage.putObject({
      key: attachmentKey,
      body: attachmentBody,
      contentType: 'text/plain',
    });
    const locator = makeLocator(
      'att-clone',
      'row-clone',
      attachmentKey,
      'text/plain',
      attachmentBody.byteLength,
    );
    const formatted = format([
      makeRow({
        id: 'row-clone',
        raw: { locator: rawKey, status: 'pending_hydration' },
        attachments: [
          makeAttachment(
            locator.attachmentId,
            locator.messageId,
            locator.mimeType,
            locator.sizeBytes,
          ),
        ],
      }),
    ]);
    const formattedBefore = JSON.stringify(formatted);
    const locatorBefore = { ...locator };
    const hydration = await hydrateThreadCorpusArtifacts({
      formatted,
      attachmentLocators: [locator],
      storage,
    });
    const rawPayload = hydration.payloads.find(
      (payload) => payload.kind === 'raw_mime' && payload.sourceRowId === 'row-clone',
    );

    expect(hydration.attachmentLocators[0]).not.toBe(locator);
    hydration.attachmentLocators[0]!.s3Key = 'changed-in-output-only';
    rawPayload?.content?.fill(0);
    expect(locator).toEqual(locatorBefore);
    expect(JSON.stringify(formatted)).toBe(formattedBefore);
    expect(storage.get(rawKey)).toEqual(rawBody);
    expect(storage.get(attachmentKey)).toEqual(attachmentBody);

    const rawOverride = await hydrateThreadCorpusArtifacts({
      formatted,
      attachmentLocators: [locator],
      storage,
      limits: { maxRawMimeBytes: 3 },
    });
    const attachmentOverride = await hydrateThreadCorpusArtifacts({
      formatted,
      attachmentLocators: [locator],
      storage,
      limits: { maxAttachmentInputBytes: 2 },
    });
    expect(payloadStatus(rawOverride, 'raw_mime', 'row-clone')).toBe('too_large');
    expect(payloadStatus(attachmentOverride, 'attachment_text', 'att-clone')).toBe('too_large');
  });

  it('fails closed for structural input, malformed limits, and source-available failures', async () => {
    const marker = 'TASK8_SYNTHETIC_LOCATOR_BODY_ADDRESS_MARKER';
    const rawKey = `raw-mime/${marker}/raw.eml`;
    const attachmentKey = `attachments/row-invalid/${marker}.txt`;
    const attachment = makeAttachment('att-invalid', 'row-invalid', 'text/plain', 1);
    const baseFormatted = format([
      makeRow({
        id: 'row-invalid',
        raw: { locator: rawKey, status: 'pending_hydration' },
        attachments: [attachment],
        body: marker,
      }),
    ]);
    const baseLocator = makeLocator('att-invalid', 'row-invalid', attachmentKey, 'text/plain', 1);
    const duplicateFormatted = structuredClone(baseFormatted);
    duplicateFormatted.threads[0]!.messages[0]!.sourceRows.push(
      structuredClone(duplicateFormatted.threads[0]!.messages[0]!.sourceRows[0]!),
    );
    const unexpectedRaw = format([
      makeRow({ id: 'row-unexpected', raw: { locator: rawKey, status: 'unrecognized_raw_state' } }),
    ]);
    const invalidLimits: unknown[] = [
      null,
      [],
      new Date(),
      { maxRawMimeBytes: 0 },
      { maxAttachmentInputBytes: 1.5 },
      { maxAttachmentTextBytes: Number.MAX_SAFE_INTEGER + 1 },
      { perObjectTimeoutMs: -1 },
      { perObjectAbortGraceMs: 0 },
      { unknown: 1 },
    ];

    for (const input of [
      {
        formatted: duplicateFormatted,
        attachmentLocators: [baseLocator],
        limits: undefined,
      },
      {
        formatted: baseFormatted,
        attachmentLocators: [{ ...baseLocator, messageId: 'wrong-owner' }],
        limits: undefined,
      },
      {
        formatted: unexpectedRaw,
        attachmentLocators: [],
        limits: undefined,
      },
      ...invalidLimits.map((limits) => ({
        formatted: baseFormatted,
        attachmentLocators: [baseLocator],
        limits,
      })),
    ]) {
      const storage = new FakeS3Storage('task8-invalid');
      const message = await errorMessage(
        hydrateThreadCorpusArtifacts({
          formatted: input.formatted,
          attachmentLocators: input.attachmentLocators,
          storage,
          limits: input.limits as Partial<ThreadCorpusHydrationLimits>,
        }),
      );
      expect(message).toBe('Invalid thread corpus hydration input');
      expect(message).not.toContain(marker);
      expect(storage.calls.filter((call) => call.op === 'GET_BOUNDED')).toEqual([]);
    }

    for (const attachmentConcurrency of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, 9]) {
      const storage = new FakeS3Storage(`task8-invalid-concurrency-${String(attachmentConcurrency)}`);
      const message = await errorMessage(
        hydrateThreadCorpusArtifacts({
          formatted: baseFormatted,
          attachmentLocators: [baseLocator],
          storage,
          attachmentConcurrency,
        }),
      );
      expect(message).toBe('Invalid thread corpus hydration input');
      expect(storage.calls.filter((call) => call.op === 'GET_BOUNDED')).toEqual([]);
    }

    const availableFormatted = format([
      makeRow({
        id: 'row-available',
        raw: { locator: 'raw-mime/row-available/raw.eml', status: 'available' },
      }),
    ]);
    const availableStorage = new FakeS3Storage('task8-available');
    await availableStorage.putObject({
      key: 'raw-mime/row-available/raw.eml',
      body: Buffer.from('x'),
      contentType: 'message/rfc822',
    });
    const availableSuccess = await hydrateThreadCorpusArtifacts({
      formatted: availableFormatted,
      attachmentLocators: [],
      storage: availableStorage,
    });
    expect(payloadStatus(availableSuccess, 'raw_mime', 'row-available')).toBe('available');

    const zeroByteStorage = new FakeS3Storage('task8-available-zero');
    await zeroByteStorage.putObject({
      key: 'raw-mime/row-available/raw.eml',
      body: Buffer.alloc(0),
      contentType: 'message/rfc822',
    });
    const zeroByteMessage = await errorMessage(
      hydrateThreadCorpusArtifacts({
        formatted: availableFormatted,
        attachmentLocators: [],
        storage: zeroByteStorage,
      }),
    );
    expect(zeroByteMessage).toBe('Invalid thread corpus hydration input');
  });

  it('rejects a missing raw MIME source that still carries a locator before reads', async () => {
    const storage = new FakeS3Storage('task8-missing-locator');
    const rawKey = 'raw-mime/row-missing/should-not-read.eml';
    const message = await errorMessage(
      hydrateThreadCorpusArtifacts({
        formatted: format([
          makeRow({
            id: 'row-missing',
            raw: { locator: rawKey, status: 'missing' },
          }),
        ]),
        attachmentLocators: [],
        storage,
      }),
    );

    expect(message).toBe('Invalid thread corpus hydration input');
    expect(storage.calls.filter((call) => call.op === 'GET_BOUNDED')).toEqual([]);
  });

  it('rejects attachment locator optional metadata mismatches before reads', async () => {
    const descriptor: ThreadCorpusAttachmentDescriptor = {
      ...makeAttachment('att-metadata', 'row-metadata', 'text/plain', 1),
      inline: true,
      contentId: '<original@example.test>',
    };
    const formatted = format([
      makeRow({
        id: 'row-metadata',
        attachments: [descriptor],
      }),
    ]);
    const baseLocator = makeLocator(
      descriptor.id,
      descriptor.messageId,
      'attachments/row-metadata/metadata.txt',
      descriptor.contentType,
      descriptor.byteSize,
    );
    const mismatchedLocators: ThreadCorpusAttachmentLocator[] = [
      { ...baseLocator, filename: 'different.txt' },
      { ...baseLocator, inline: false },
      { ...baseLocator, contentId: '<different@example.test>' },
    ];

    for (const [index, locator] of mismatchedLocators.entries()) {
      const storage = new FakeS3Storage(`task8-metadata-mismatch-${index}`);
      const message = await errorMessage(
        hydrateThreadCorpusArtifacts({
          formatted,
          attachmentLocators: [locator],
          storage,
        }),
      );

      expect(message).toBe('Invalid thread corpus hydration input');
      expect(storage.calls.filter((call) => call.op === 'GET_BOUNDED')).toEqual([]);
    }
  });

  it('maps abort and storage failures without leaking dependency errors', async () => {
    const storage = new FakeS3Storage('task8-errors');
    const formatted = format([
      makeRow({
        id: 'raw-error',
        raw: { locator: 'raw-mime/raw-error/x.eml', status: 'pending_hydration' },
      }),
      makeRow({
        id: 'raw-abort',
        raw: { locator: 'raw-mime/raw-abort/x.eml', status: 'pending_hydration' },
      }),
      makeRow({
        id: 'row-errors',
        attachments: [
          makeAttachment('att-error', 'row-errors', 'text/plain', 1),
          makeAttachment('att-abort', 'row-errors', 'text/plain', 1),
        ],
      }),
    ]);
    const locators = [
      makeLocator('att-error', 'row-errors', 'attachments/row-errors/error.txt', 'text/plain', 1),
      makeLocator('att-abort', 'row-errors', 'attachments/row-errors/abort.txt', 'text/plain', 1),
    ];
    vi.spyOn(storage, 'getObjectBounded').mockImplementation(async (key) => {
      if (key.includes('raw-error') || key.includes('/error.txt')) {
        throw new Error('SYNTHETIC_STORAGE_FAILURE');
      }
      throw abortError();
    });

    const hydration = await hydrateThreadCorpusArtifacts({
      formatted,
      attachmentLocators: locators,
      storage,
    });

    expect(payloadStatus(hydration, 'raw_mime', 'raw-error')).toBe('read_failed');
    expect(payloadStatus(hydration, 'raw_mime', 'raw-abort')).toBe('read_failed');
    expect(payloadStatus(hydration, 'attachment_text', 'att-error')).toBe('read_failed');
    expect(payloadStatus(hydration, 'attachment_text', 'att-abort')).toBe('timeout');
    expect(JSON.stringify(hydration)).not.toContain('SYNTHETIC_STORAGE_FAILURE');
  });

  it('stops batch when a storage read ignores abort and starts no later operation', async () => {
    const storage = new FakeS3Storage('task8-storage-hang');
    const calls: string[] = [];
    vi.spyOn(storage, 'getObjectBounded').mockImplementation(async (key) => {
      calls.push(key);
      return await new Promise<never>(() => undefined);
    });
    const formatted = format([
      makeRow({
        id: 'raw-b',
        raw: { locator: 'raw-mime/raw-b/b.eml', status: 'pending_hydration' },
      }),
      makeRow({
        id: 'raw-a',
        raw: { locator: 'raw-mime/raw-a/a.eml', status: 'pending_hydration' },
      }),
    ]);

    await expect(
      hydrateThreadCorpusArtifacts({
        formatted,
        attachmentLocators: [],
        storage,
        limits: { perObjectTimeoutMs: 10, perObjectAbortGraceMs: 10 },
      }),
    ).rejects.toThrow(/^Thread corpus hydration stopped$/);
    expect(calls).toEqual(['raw-mime/raw-a/a.eml']);
  });

  it('stops batch when PDF extraction ignores abort and maps arbitrary extractor rejection', async () => {
    const body = pdfBody('hang');
    const firstKey = 'attachments/row-pdf/a.pdf';
    const secondKey = 'attachments/row-pdf/b.pdf';
    const first = makeLocator('att-a', 'row-pdf', firstKey, 'application/pdf', body.byteLength);
    const second = makeLocator('att-b', 'row-pdf', secondKey, 'application/pdf', body.byteLength);
    const formatted = format([
      makeRow({
        id: 'row-pdf',
        attachments: [
          makeAttachment(first.attachmentId, first.messageId, first.mimeType, first.sizeBytes),
          makeAttachment(second.attachmentId, second.messageId, second.mimeType, second.sizeBytes),
        ],
      }),
    ]);
    const hangingStorage = new FakeS3Storage('task8-pdf-hang');
    await hangingStorage.putObject({ key: firstKey, body, contentType: 'application/pdf' });
    await hangingStorage.putObject({ key: secondKey, body, contentType: 'application/pdf' });

    await expect(
      hydrateThreadCorpusArtifacts({
        formatted,
        attachmentLocators: [second, first],
        storage: hangingStorage,
        pdfExtractor: async () => await new Promise<never>(() => undefined),
        limits: { perObjectTimeoutMs: 10, perObjectAbortGraceMs: 10 },
      }),
    ).rejects.toThrow(/^Thread corpus hydration stopped$/);
    expect(
      hangingStorage.calls.filter((call) => call.op === 'GET_BOUNDED').map((call) => call.key),
    ).toEqual([firstKey]);

    const rejectionStorage = new FakeS3Storage('task8-pdf-rejection');
    await rejectionStorage.putObject({ key: firstKey, body, contentType: 'application/pdf' });
    const rejected = await hydrateThreadCorpusArtifacts({
      formatted: format([
        makeRow({
          id: 'row-pdf',
          attachments: [
            makeAttachment(first.attachmentId, first.messageId, first.mimeType, first.sizeBytes),
          ],
        }),
      ]),
      attachmentLocators: [first],
      storage: rejectionStorage,
      pdfExtractor: async () => {
        throw new Error('SYNTHETIC_PDF_EXTRACTOR_REJECTION');
      },
    });
    expect(payloadStatus(rejected, 'attachment_text', 'att-a')).toBe('parser_failure');
    expect(JSON.stringify(rejected)).not.toContain('SYNTHETIC_PDF_EXTRACTOR_REJECTION');
  });
});

function hydratorSourceGuardViolations(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    'centurion-thread-corpus-hydrator.ts',
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const fetchAliases = new Set<string>();
  const unwrapExpression = (node: ts.Expression): ts.Expression => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return unwrapExpression(node.expression);
    }
    return node;
  };
  const isCapabilityPath = (node: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(node);
    if (ts.isIdentifier(unwrapped)) {
      return ['global', 'globalThis', 'process'].includes(unwrapped.text);
    }
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      return isCapabilityPath(unwrapped.expression);
    }
    return false;
  };
  const isConsolePath = (node: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(node);
    if (ts.isIdentifier(unwrapped)) return unwrapped.text === 'console';
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      return isConsolePath(unwrapped.expression);
    }
    return false;
  };
  const isFetchReference = (node: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(node);
    if (ts.isIdentifier(unwrapped)) {
      return unwrapped.text === 'fetch' || fetchAliases.has(unwrapped.text);
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
      return unwrapped.name.text === 'fetch' && isCapabilityPath(unwrapped.expression);
    }
    if (ts.isElementAccessExpression(unwrapped)) {
      return (
        ts.isStringLiteral(unwrapped.argumentExpression) &&
        unwrapped.argumentExpression.text === 'fetch' &&
        isCapabilityPath(unwrapped.expression)
      );
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('@aws-sdk/')
    ) {
      violations.push('Direct AWS client import is prohibited');
    }
    if (ts.isIdentifier(node) && node.text === 'getS3Storage') {
      violations.push('getS3Storage is prohibited');
    }
    if (ts.isIdentifier(node) && ['fetch', 'global', 'globalThis', 'process'].includes(node.text)) {
      violations.push(`${node.text} capability identifier is prohibited`);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (isCapabilityPath(node.expression)) {
        violations.push('global/process capability access is prohibited');
      }
      if (isConsolePath(node.expression)) {
        violations.push('console member access is prohibited');
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFetchReference(node.initializer)
    ) {
      fetchAliases.add(node.name.text);
    }
    if (ts.isCallExpression(node) && isFetchReference(node.expression)) {
      violations.push('fetch is prohibited');
    }
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Error' &&
      node.arguments?.some(
        (argument) =>
          ts.isTemplateExpression(argument) &&
          /\b(locator|content)\b/i.test(argument.getText(sourceFile)),
      )
    ) {
      violations.push('Locator/content-bearing error template is prohibited');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('centurion thread corpus hydrator source boundary', () => {
  it('has no direct AWS, environment, network, console, or content-bearing errors', () => {
    const sourcePath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-hydrator.ts', import.meta.url),
    );
    expect(hydratorSourceGuardViolations(readFileSync(sourcePath, 'utf8'))).toEqual([]);
  });

  it.each([
    "import { S3Client } from '@aws-sdk/client-s3';",
    'getS3Storage();',
    'process.env.DATABASE_URL;',
    'globalThis.process.env.DATABASE_URL;',
    "globalThis['process']['env'];",
    "global['process']['env'];",
    "fetch('https://synthetic.invalid');",
    "globalThis['fetch']('https://synthetic.invalid');",
    "const send = fetch; send('https://synthetic.invalid');",
    "const send = globalThis['fetch']; send('https://synthetic.invalid');",
    "console.log('synthetic'); console['error']('synthetic');",
    "(console as unknown as { log: (...args: unknown[]) => void }).log('synthetic');",
    "((console)).log('synthetic');",
    'new Error(`locator ${locator}`);',
    'new Error(`content ${content}`);',
  ])('rejects prohibited capability source: %s', (fixture) => {
    expect(hydratorSourceGuardViolations(fixture)).not.toEqual([]);
  });
});
