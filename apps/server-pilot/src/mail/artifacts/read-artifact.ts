/**
 * Authorized mail artifact reads: text/plain + embedded PDF text only.
 * No OCR. No raw text persistence. Hash-bound MailEvidenceRef only.
 * Model never receives S3 keys.
 */
import { S3ObjectTooLargeError, type S3Storage } from '../../storage/s3.js';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { ToolResult } from '../../ai/draft-evidence.js';
import { maskCardNumbers } from '../../ai/card-mask.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const ARTIFACT_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const ARTIFACT_MAX_OUTPUT_BYTES = 256 * 1024;
export const ARTIFACT_MAX_PAGES = 50;
export const ARTIFACT_SUBPROCESS_TIMEOUT_MS = 10_000;
export const MAIL_READ_ARTIFACT_TOOL_VERSION = '2';

export type ArtifactReason =
  | 'text'
  | 'no_embedded_text'
  | 'encrypted'
  | 'malformed'
  | 'too_large'
  | 'too_many_pages'
  | 'timeout'
  | 'parser_failure'
  | 'unsupported';

export type ArtifactData = {
  mimeType: 'text/plain' | 'application/pdf';
  text: string | null;
  pageCount: number | null;
  reason: ArtifactReason;
};

type MailArtifactEvidence = Omit<
  Extract<ToolResult<ArtifactData>['evidence'], { kind: 'mail_attachment' }>,
  'sourceHash'
> & {
  sourceHash: string | null;
};

export type ArtifactReadResult = Omit<ToolResult<ArtifactData>, 'evidence'> & {
  evidence: MailArtifactEvidence;
};

export type AttachmentLocator = {
  /** Server-resolved only; never from model. */
  s3Key: string;
  mimeType: string;
  sizeBytes: number;
  messageId: string;
  /** The DB sha256 of the stored object. Binds an Outlook-sync original key to its bytes. */
  sha256?: string | null;
};

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function isDocxMimeType(mimeType: string): boolean {
  return mimeType.split(';', 1)[0]?.trim().toLowerCase() === DOCX_MIME;
}

/**
 * Internal bounded-byte result. Callers may turn this into a private artifact
 * handle, but must not serialize `body`, `locator`, or an object URL.
 */
export type AuthorizedArtifactBytes = {
  body: Buffer;
  contentType: string;
  sha256: string;
  locator: AttachmentLocator;
};

export type SandboxResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  /** Stdout passed the output cap, so the child was killed. The exit code then says nothing about the PDF. */
  truncated?: boolean;
};

/** pdftoppm only renders vision pages, into the output directory. */
export type PdfSandboxTool = 'pdfinfo' | 'pdftotext' | 'pdftoppm';

export type SandboxRunner = (
  tool: PdfSandboxTool,
  inputPath: string,
  signal?: AbortSignal,
  outputDir?: string,
) => Promise<SandboxResult>;

function pdfFailureReason(
  tool: PdfSandboxTool,
  result: SandboxResult,
): 'encrypted' | 'malformed' | 'parser_failure' {
  // bubblewrap prefixes its own setup errors with "bwrap: " and exits 1 before Poppler runs, e.g. when AppArmor
  // refuses the user namespace to an unconfined service. That says nothing about the PDF, so it is never "damaged".
  // Anchored to the start of stderr (no /m): once Poppler runs, a later line may echo document bytes.
  const sandboxError = /^bwrap: [^\n]*/.exec(result.stderr.toString('utf8'))?.[0];
  if (sandboxError) {
    // bubblewrap's own line names a syscall, never document text, so it is safe to log.
    console.warn('pdf_sandbox_unavailable', { tool, error: sandboxError.slice(0, 200) });
    return 'parser_failure';
  }
  // Poppler reports a password-required PDF with exit 1, not its permissions exit 3.
  // Match only its exact diagnostic; never expose parser stderr as artifact text.
  return result.exitCode === 3 ||
    (result.exitCode === 1 &&
      /^Command Line Error: Incorrect password$/m.test(result.stderr.toString('utf8')))
    ? 'encrypted'
    : 'malformed';
}

export type ToolLedger = {
  record(result: ArtifactReadResult): void;
  entries(): readonly ArtifactReadResult[];
};

export function createToolLedger(): ToolLedger {
  const items: ArtifactReadResult[] = [];
  return {
    record(result) {
      items.push(result);
    },
    entries() {
      return items;
    },
  };
}

const PDF_BINS = [
  '/usr/bin/pdfinfo',
  '/usr/bin/pdftotext',
  '/usr/bin/bwrap',
  '/usr/bin/prlimit',
] as const;

/** Startup gate: missing Poppler/bwrap/prlimit fail closed. */
export function assertPdfToolchain(exists: (path: string) => boolean = existsSync): void {
  for (const bin of PDF_BINS) {
    if (!exists(bin)) {
      throw new Error(`pdf toolchain missing: ${bin}`);
    }
  }
}

function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function normalizeUtf8Text(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .split('\u0000')
    .join('')
    .replace(/\r\n?/g, '\n')
    .trim();
}

// Outlook-sync originals are sealed under a scope hash and named by the attachment's own sha256.
const OUTLOOK_SYNC_KEY = /^outlook-sync-originals\/v1\/[0-9a-f]{64}\/([0-9a-f]{64})$/;

/** The row's own message key, or a sealed Outlook-sync key whose name is the row's DB sha256. */
function keyBelongsTo(locator: AttachmentLocator): boolean {
  if (locator.s3Key.startsWith(`attachments/${locator.messageId}/`)) return true;
  const sealed = OUTLOOK_SYNC_KEY.exec(locator.s3Key);
  return sealed !== null && locator.sha256 === sealed[1];
}

/** A sealed key has no message prefix, so its bytes must hash to the DB sha256 that names them. */
function sealedBytesMatch(locator: AttachmentLocator, body: Buffer): boolean {
  return !OUTLOOK_SYNC_KEY.test(locator.s3Key) || sha256Hex(body) === locator.sha256;
}

/**
 * Stored types that may hold this row's PDF. A generic octet-stream row counts only when its key is a .pdf, and the
 * %PDF- magic is checked when the bytes are parsed.
 */
function storedPdfTypes(locator: Pick<AttachmentLocator, 'mimeType' | 's3Key'>): string[] {
  if (locator.mimeType === 'application/pdf') return ['application/pdf'];
  if (locator.mimeType === 'application/octet-stream' && /\.pdf$/i.test(locator.s3Key)) {
    return ['application/octet-stream', 'application/pdf'];
  }
  return [];
}

/** The stored content type is one this row may hold: its declared type, or the PDF types of a PDF row. */
function storedTypeOk(locator: Pick<AttachmentLocator, 'mimeType' | 's3Key'>, stored: string): boolean {
  const pdfTypes = storedPdfTypes(locator);
  return pdfTypes.length > 0 ? pdfTypes.includes(stored) : stored === locator.mimeType;
}

/** Image bytes by magic: PNG, JPEG, GIF or WebP. Logos and signature images are skipped, not reported. */
export function sniffImageBytes(body: Buffer): boolean {
  const head = body.subarray(0, 12);
  return (
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('latin1')) ||
    (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')
  );
}

function emptyEvidence(
  attachmentId: string,
  sourceHash: string | null,
  now: Date,
): ArtifactReadResult['evidence'] {
  return {
    kind: 'mail_attachment',
    id: randomUUID(),
    toolId: 'mail_read_artifact',
    toolVersion: MAIL_READ_ARTIFACT_TOOL_VERSION,
    attachmentId,
    observedAt: now.toISOString(),
    sourceHash,
    claimKeys: [],
  };
}

function manualResult(args: {
  attachmentId: string;
  mimeType: 'text/plain' | 'application/pdf';
  reason: ArtifactReason;
  sourceHash: string | null;
  pageCount?: number | null;
  now: Date;
  unresolvedFields?: string[];
}): ArtifactReadResult {
  return {
    status: 'manual_required',
    draftReady: false,
    data: {
      mimeType: args.mimeType,
      text: null,
      pageCount: args.pageCount ?? null,
      reason: args.reason,
    },
    unresolvedFields: args.unresolvedFields ?? ['attachment.text'],
    evidence: emptyEvidence(args.attachmentId, args.sourceHash, args.now),
  };
}

function okResult(args: {
  attachmentId: string;
  mimeType: 'text/plain' | 'application/pdf';
  text: string;
  pageCount: number | null;
  sourceHash: string;
  now: Date;
}): ArtifactReadResult {
  return {
    status: 'ok',
    // Artifact text is server-only candidate material. It is never model evidence. Card numbers and security
    // codes are masked here, so no caller can hold or persist the unmasked text.
    draftReady: false,
    data: {
      mimeType: args.mimeType,
      text: maskCardNumbers(args.text),
      pageCount: args.pageCount,
      reason: 'text',
    },
    unresolvedFields: [],
    evidence: {
      ...emptyEvidence(args.attachmentId, args.sourceHash, args.now),
      claimKeys: [],
    },
  };
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (typeof err === 'object' &&
      err !== null &&
      'name' in err &&
      (err as { name: string }).name === 'AbortError')
  );
}

/** Vision pages: the first pages only, long edge capped. Each rendered page has its own file cap. */
export const VISION_MAX_PAGES = 3;
export const VISION_LONG_EDGE_PX = 1568;
const VISION_MAX_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * The bubblewrap argv for one Poppler tool. Only pdftoppm gets a writable output directory, mounted at /output, and
 * its per-file cap is the page cap rather than the text cap.
 */
export function pdfSandboxArgv(tool: PdfSandboxTool, inputPath: string, outputDir?: string): string[] {
  if (tool === 'pdftoppm' && !outputDir) throw new Error('pdftoppm needs an output directory');
  const toolArgs =
    tool === 'pdfinfo'
      ? ['/input/document.pdf']
      : tool === 'pdftotext'
        ? ['-layout', '-enc', 'UTF-8', '-eol', 'unix', '/input/document.pdf', '-']
        : [
            '-scale-to', String(VISION_LONG_EDGE_PX), '-f', '1', '-l', String(VISION_MAX_PAGES),
            '-jpeg', '-jpegopt', 'quality=75', '/input/document.pdf', '/output/page',
          ];
  const fileCap = tool === 'pdftoppm' ? VISION_MAX_PAGE_BYTES : ARTIFACT_MAX_OUTPUT_BYTES;

  return [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--cap-drop',
    'ALL',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/input',
    '--ro-bind',
    inputPath,
    '/input/document.pdf',
    ...(outputDir ? ['--dir', '/output', '--bind', outputDir, '/output'] : []),
    '--chdir',
    '/tmp',
    '--',
    '/usr/bin/prlimit',
    '--cpu=5:5',
    '--as=536870912:536870912',
    `--fsize=${fileCap}:${fileCap}`,
    '--nofile=32:32',
    '--nproc=16:16',
    '--core=0:0',
    '--',
    `/usr/bin/${tool}`,
    ...toolArgs,
  ];
}

/**
 * Run one Poppler tool under bubblewrap + prlimit.
 * Never retries unsandboxed. No OCR binaries.
 */
export async function runPdfSandbox(
  tool: PdfSandboxTool,
  inputPath: string,
  signal?: AbortSignal,
  outputDir?: string,
): Promise<SandboxResult> {
  const argv = pdfSandboxArgv(tool, inputPath, outputDir);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }

    const child = spawn('/usr/bin/bwrap', argv, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
      signal,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > ARTIFACT_MAX_OUTPUT_BYTES) {
        truncated = true;
        child.kill('SIGKILL');
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).byteLength < 64 * 1024) stderr.push(chunk);
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: exitCode ?? -1,
        truncated,
      });
    });
  });
}

/** One rendered page, ready for a vision model. */
export type VisionPage = { filename: string; mediaType: 'image/jpeg'; data: Uint8Array };

/**
 * The first pages of a scanned PDF as JPEGs, rendered by pdftoppm inside runPdfSandbox. Null when the render fails,
 * so the caller keeps the plain unread message.
 */
export async function renderPdfPagesForVision(
  body: Buffer,
  options: { runner?: SandboxRunner; signal?: AbortSignal } = {},
): Promise<VisionPage[] | null> {
  if (body.byteLength > ARTIFACT_MAX_INPUT_BYTES || body.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return null;
  }
  // Setup and cleanup failures leave this file unread too; they never fail the caller's other files.
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'nava-pdf-'));
    await chmod(directory, 0o700);
    const inputPath = join(directory, 'document.pdf');
    const pagesDir = join(directory, 'pages');
    await writeFile(inputPath, body, { mode: 0o600 });
    await mkdir(pagesDir, { mode: 0o700 });

    const runner = options.runner ?? runPdfSandbox;
    if (options.runner === undefined) {
      assertPdfToolchain();
    }
    const linkedSignal = AbortSignal.any([
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(ARTIFACT_SUBPROCESS_TIMEOUT_MS),
    ]);
    const rendered = await runner('pdftoppm', inputPath, linkedSignal, pagesDir);
    if (rendered.exitCode !== 0) return null;

    const names = (await readdir(pagesDir))
      .filter((name) => /\.jpe?g$/i.test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .slice(0, VISION_MAX_PAGES);
    if (names.length === 0) return null;
    return await Promise.all(
      names.map(async (filename) => ({
        filename,
        mediaType: 'image/jpeg' as const,
        data: new Uint8Array(await readFile(join(pagesDir, filename))),
      })),
    );
  } catch {
    return null;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractEmbeddedPdfText(
  source: {
    body: Buffer;
    declaredSize: number;
    declaredMime: string;
    objectMime: string;
  },
  options: {
    runner?: SandboxRunner;
    signal?: AbortSignal;
    attachmentId?: string;
    now?: Date;
    onTempDir?: (dir: string) => void;
  } = {},
): Promise<ArtifactReadResult> {
  const attachmentId = options.attachmentId ?? 'attachment';
  const now = options.now ?? new Date();
  const mimeType = 'application/pdf' as const;

  if (source.declaredMime !== 'application/pdf' || source.objectMime !== 'application/pdf') {
    return manualResult({
      attachmentId,
      mimeType,
      reason: 'unsupported',
      sourceHash: sha256Hex(source.body),
      now,
    });
  }

  if (
    source.declaredSize > ARTIFACT_MAX_INPUT_BYTES ||
    source.body.byteLength > ARTIFACT_MAX_INPUT_BYTES
  ) {
    return manualResult({
      attachmentId,
      mimeType,
      reason: 'too_large',
      sourceHash: null,
      now,
    });
  }

  if (source.declaredSize !== source.body.byteLength) {
    return manualResult({
      attachmentId,
      mimeType,
      reason: 'malformed',
      sourceHash: null,
      now,
    });
  }

  if (source.body.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return manualResult({
      attachmentId,
      mimeType,
      reason: 'malformed',
      sourceHash: sha256Hex(source.body),
      now,
    });
  }

  const sourceHash = sha256Hex(source.body);
  const directory = await mkdtemp(join(tmpdir(), 'nava-pdf-'));
  options.onTempDir?.(directory);
  try {
    await chmod(directory, 0o700);
    const inputPath = join(directory, 'document.pdf');
    await writeFile(inputPath, source.body, { mode: 0o600 });

    const runner = options.runner ?? runPdfSandbox;
    if (options.runner === undefined) {
      assertPdfToolchain();
    }
    const linkedSignal = AbortSignal.any([
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(ARTIFACT_SUBPROCESS_TIMEOUT_MS),
    ]);

    let info: SandboxResult;
    try {
      info = await runner('pdfinfo', inputPath, linkedSignal);
    } catch (err) {
      if (isAbortError(err) || linkedSignal.aborted) {
        if (options.signal?.aborted) throw err;
        return manualResult({
          attachmentId,
          mimeType,
          reason: 'timeout',
          sourceHash,
          now,
        });
      }
      return manualResult({
        attachmentId,
        mimeType,
        reason: 'parser_failure',
        sourceHash,
        now,
      });
    }

    if (info.exitCode !== 0) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: pdfFailureReason('pdfinfo', info),
        sourceHash,
        now,
      });
    }

    // "Encrypted: yes" alone is not a refusal. An owner-only lock opens with no password, and pdftotext decides below:
    // a user password fails there as "Incorrect password" and stays encrypted.
    const infoText = info.stdout.toString('utf8');
    const pageCount = Number(/^Pages:\s+(\d+)/im.exec(infoText)?.[1] ?? 0);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: 'malformed',
        sourceHash,
        now,
      });
    }
    if (pageCount > ARTIFACT_MAX_PAGES) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: 'too_many_pages',
        sourceHash,
        pageCount,
        now,
      });
    }

    let textResult: SandboxResult;
    try {
      textResult = await runner('pdftotext', inputPath, linkedSignal);
    } catch (err) {
      if (isAbortError(err) || linkedSignal.aborted) {
        if (options.signal?.aborted) throw err;
        return manualResult({
          attachmentId,
          mimeType,
          reason: 'timeout',
          sourceHash,
          pageCount,
          now,
        });
      }
      return manualResult({
        attachmentId,
        mimeType,
        reason: 'parser_failure',
        sourceHash,
        pageCount,
        now,
      });
    }

    // Over the output cap the sandbox kills pdftotext, so report the size before the exit code, which is then -1.
    if (textResult.truncated || textResult.stdout.byteLength > ARTIFACT_MAX_OUTPUT_BYTES) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: 'too_large',
        sourceHash,
        pageCount,
        now,
      });
    }

    if (textResult.exitCode !== 0) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: pdfFailureReason('pdftotext', textResult),
        sourceHash,
        pageCount,
        now,
      });
    }

    const normalized = normalizeUtf8Text(textResult.stdout.toString('utf8'));
    if (!normalized) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: 'no_embedded_text',
        sourceHash,
        pageCount,
        now,
      });
    }

    if (Buffer.byteLength(normalized, 'utf8') > ARTIFACT_MAX_OUTPUT_BYTES) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: 'too_large',
        sourceHash,
        pageCount,
        now,
      });
    }

    return okResult({
      attachmentId,
      mimeType,
      text: normalized,
      pageCount,
      sourceHash,
      now,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Authorized attachment ID → resolve DB locator → bounded S3 → text/plain or pdftotext.
 * Locator resolved by attachmentId only; caller never supplies S3 keys. Keys never in ToolResult.
 */
export async function readAuthorizedArtifact(input: {
  attachmentId: string;
  authorizedAttachmentIds: ReadonlySet<string>;
  s3: S3Storage;
  signal: AbortSignal;
  /** Server-side resolve by attachmentId (DB in prod; fixture map in tests). */
  resolveLocator: (attachmentId: string) => Promise<AttachmentLocator | null>;
  runner?: SandboxRunner;
  ledger?: ToolLedger;
  now?: Date;
  expectedLocator?: AttachmentLocator;
  /** Revalidate current DB grant/source immediately before object bytes. */
  revalidate?: () => Promise<boolean>;
}): Promise<ArtifactReadResult> {
  const now = input.now ?? new Date();

  const finish = (result: ArtifactReadResult): ArtifactReadResult => {
    input.ledger?.record(result);
    return result;
  };

  if (!input.authorizedAttachmentIds.has(input.attachmentId)) {
    return finish(
      manualResult({
        attachmentId: input.attachmentId,
        mimeType: 'application/pdf',
        reason: 'unsupported',
        sourceHash: null,
        now,
        unresolvedFields: ['attachment'],
      }),
    );
  }

  const locator = await input.resolveLocator(input.attachmentId);
  if (!locator) {
    return finish(
      manualResult({
        attachmentId: input.attachmentId,
        mimeType: 'application/pdf',
        reason: 'malformed',
        sourceHash: null,
        now,
        unresolvedFields: ['attachment'],
      }),
    );
  }

  if (input.expectedLocator && !sameLocator(locator, input.expectedLocator)) {
    return finish(
      manualResult({
        attachmentId: input.attachmentId,
        mimeType: locator.mimeType === 'text/plain' ? 'text/plain' : 'application/pdf',
        reason: 'malformed',
        sourceHash: null,
        now,
      }),
    );
  }

  if (!keyBelongsTo(locator)) {
    return finish(
      manualResult({
        attachmentId: input.attachmentId,
        mimeType: 'application/pdf',
        reason: 'unsupported',
        sourceHash: null,
        now,
        unresolvedFields: ['attachment'],
      }),
    );
  }

  if (
    !Number.isFinite(locator.sizeBytes) ||
    locator.sizeBytes < 0 ||
    !Number.isInteger(locator.sizeBytes)
  ) {
    return finish(
      manualResult({
        attachmentId: input.attachmentId,
        mimeType: locator.mimeType === 'text/plain' ? 'text/plain' : 'application/pdf',
        reason: 'malformed',
        sourceHash: null,
        now,
        unresolvedFields: ['attachment'],
      }),
    );
  }

  if (locator.sizeBytes > ARTIFACT_MAX_INPUT_BYTES) {
    return finish(
      manualResult({
        attachmentId: input.attachmentId,
        mimeType: locator.mimeType === 'text/plain' ? 'text/plain' : 'application/pdf',
        reason: 'too_large',
        sourceHash: null,
        now,
      }),
    );
  }

  if (locator.mimeType !== 'text/plain' && storedPdfTypes(locator).length === 0) {
    return finish(
      manualResult({
        attachmentId: input.attachmentId,
        mimeType: 'application/pdf',
        reason: 'unsupported',
        sourceHash: null,
        now,
      }),
    );
  }

  if (input.revalidate) {
    try {
      const head = await input.s3.headObject(locator.s3Key);
      if (
        !head ||
        head.sizeBytes !== locator.sizeBytes ||
        (head.contentType && !storedTypeOk(locator, head.contentType)) ||
        !(await input.revalidate())
      ) {
        return finish(
          manualResult({
            attachmentId: input.attachmentId,
            mimeType: locator.mimeType === 'text/plain' ? 'text/plain' : 'application/pdf',
            reason: 'unsupported',
            sourceHash: null,
            now,
          }),
        );
      }
    } catch {
      return finish(
        manualResult({
          attachmentId: input.attachmentId,
          mimeType: locator.mimeType === 'text/plain' ? 'text/plain' : 'application/pdf',
          reason: 'unsupported',
          sourceHash: null,
          now,
        }),
      );
    }
  }

  const maxBytes = Math.min(locator.sizeBytes, ARTIFACT_MAX_INPUT_BYTES);
  let object: { body: Buffer; contentType: string };
  try {
    const fetched = await input.s3.getObjectBounded(locator.s3Key, maxBytes, input.signal);
    if (!fetched) {
      return finish(
        manualResult({
          attachmentId: input.attachmentId,
          mimeType: locator.mimeType === 'text/plain' ? 'text/plain' : 'application/pdf',
          reason: 'malformed',
          sourceHash: null,
          now,
        }),
      );
    }
    object = fetched;
  } catch (err) {
    if (err instanceof S3ObjectTooLargeError) {
      const reason: ArtifactReason =
        maxBytes >= ARTIFACT_MAX_INPUT_BYTES ? 'too_large' : 'malformed';
      return finish(
        manualResult({
          attachmentId: input.attachmentId,
          mimeType: locator.mimeType === 'text/plain' ? 'text/plain' : 'application/pdf',
          reason,
          sourceHash: null,
          now,
        }),
      );
    }
    throw err;
  }

  if (locator.sizeBytes !== object.body.byteLength || !sealedBytesMatch(locator, object.body)) {
    return finish(
      manualResult({
        attachmentId: input.attachmentId,
        mimeType: locator.mimeType === 'text/plain' ? 'text/plain' : 'application/pdf',
        reason: 'malformed',
        sourceHash: null,
        now,
      }),
    );
  }

  if (locator.mimeType === 'text/plain') {
    if (object.contentType && object.contentType !== 'text/plain') {
      return finish(
        manualResult({
          attachmentId: input.attachmentId,
          mimeType: 'text/plain',
          reason: 'unsupported',
          sourceHash: sha256Hex(object.body),
          now,
        }),
      );
    }
    if (object.body.byteLength > ARTIFACT_MAX_OUTPUT_BYTES) {
      return finish(
        manualResult({
          attachmentId: input.attachmentId,
          mimeType: 'text/plain',
          reason: 'too_large',
          sourceHash: sha256Hex(object.body),
          now,
        }),
      );
    }
    const text = normalizeUtf8Text(object.body.toString('utf8'));
    if (!text) {
      return finish(
        manualResult({
          attachmentId: input.attachmentId,
          mimeType: 'text/plain',
          reason: 'no_embedded_text',
          sourceHash: sha256Hex(object.body),
          now,
        }),
      );
    }
    if (Buffer.byteLength(text, 'utf8') > ARTIFACT_MAX_OUTPUT_BYTES) {
      return finish(
        manualResult({
          attachmentId: input.attachmentId,
          mimeType: 'text/plain',
          reason: 'too_large',
          sourceHash: sha256Hex(object.body),
          now,
        }),
      );
    }
    return finish(
      okResult({
        attachmentId: input.attachmentId,
        mimeType: 'text/plain',
        text,
        pageCount: null,
        sourceHash: sha256Hex(object.body),
        now,
      }),
    );
  }

  // The row's stored type must be one of its PDF types. extractEmbeddedPdfText then checks the %PDF- magic.
  const pdfTypes = storedPdfTypes(locator);
  return finish(
    await extractEmbeddedPdfText(
      {
        body: object.body,
        declaredSize: locator.sizeBytes,
        declaredMime: 'application/pdf',
        objectMime: pdfTypes.includes(object.contentType) ? 'application/pdf' : object.contentType,
      },
      {
        runner: input.runner,
        signal: input.signal,
        attachmentId: input.attachmentId,
        now,
      },
    ),
  );
}

/**
 * Authorized attachment ID → resolved locator → bounded bytes. This is the
 * private artifact branch used after all document validation has passed. It
 * deliberately shares the authorization, attachment-prefix, MIME, size and
 * bounded S3 checks with `readAuthorizedArtifact`; it never accepts an S3 key
 * from a caller and never returns a URL or model-facing body.
 */
export async function readAuthorizedArtifactBytes(input: {
  attachmentId: string;
  authorizedAttachmentIds: ReadonlySet<string>;
  s3: S3Storage;
  signal: AbortSignal;
  resolveLocator: (attachmentId: string) => Promise<AttachmentLocator | null>;
  expectedLocator?: AttachmentLocator;
  expectedSha256?: string;
  /** Trusted worker acquisition only; visual admission remains a separate boundary. */
  allowRaster?: boolean;
  /** Explicit trusted Office acquisition; only original DOCX bytes, no conversion here. */
  allowOffice?: boolean;
  /**
   * Logo check only: an octet-stream row returns its bytes so the caller can sniff the image magic. The bytes are
   * never parsed as a PDF here.
   */
  allowSniff?: boolean;
  /** Revalidate current DB grant/source immediately before object bytes. */
  revalidate?: () => Promise<boolean>;
}): Promise<AuthorizedArtifactBytes | null> {
  if (input.signal.aborted) {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  if (!input.authorizedAttachmentIds.has(input.attachmentId)) return null;

  const locator = await input.resolveLocator(input.attachmentId);
  if (!locator) return null;
  if (input.expectedLocator && !sameLocator(locator, input.expectedLocator)) return null;
  if (!keyBelongsTo(locator)) return null;
  if (
    !Number.isInteger(locator.sizeBytes) ||
    locator.sizeBytes < 0 ||
    locator.sizeBytes > ARTIFACT_MAX_INPUT_BYTES
  ) {
    return null;
  }
  const raster = input.allowRaster === true &&
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(locator.mimeType);
  const office = input.allowOffice === true && isDocxMimeType(locator.mimeType);
  if ((raster || office) && (!input.expectedLocator || !input.revalidate ||
    locator.s3Key.includes('\\') ||
    locator.s3Key.split('/').some(part => !part || part === '.' || part === '..'))) {
    return null;
  }
  const sniff = input.allowSniff === true && locator.mimeType === 'application/octet-stream';
  if (
    locator.mimeType !== 'text/plain' &&
    storedPdfTypes(locator).length === 0 &&
    !raster &&
    !office &&
    !sniff
  ) {
    return null;
  }

  if (input.revalidate) {
    try {
      const head = await input.s3.headObject(locator.s3Key);
      if (
        !head ||
        head.sizeBytes !== locator.sizeBytes ||
        (head.contentType && !storedTypeOk(locator, head.contentType)) ||
        !(await input.revalidate())
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }

  let object: { body: Buffer; contentType: string } | null;
  try {
    object = await input.s3.getObjectBounded(
      locator.s3Key,
      Math.min(locator.sizeBytes, ARTIFACT_MAX_INPUT_BYTES),
      input.signal,
    );
  } catch (error) {
    if (error instanceof S3ObjectTooLargeError) return null;
    throw error;
  }
  if (!object || object.body.byteLength !== locator.sizeBytes) return null;
  if (object.contentType && !storedTypeOk(locator, object.contentType)) return null;
  if (!sealedBytesMatch(locator, object.body)) return null;

  const sha256 = sha256Hex(object.body);
  if (input.expectedSha256 && sha256 !== input.expectedSha256) return null;

  const bytes: AuthorizedArtifactBytes = {
    body: object.body,
    contentType: locator.mimeType,
    sha256,
    locator,
  };
  return bytes;
}

function sameLocator(a: AttachmentLocator, b: AttachmentLocator): boolean {
  return (
    a.s3Key === b.s3Key &&
    a.mimeType === b.mimeType &&
    a.sizeBytes === b.sizeBytes &&
    a.messageId === b.messageId
  );
}

/**
 * Freshness-only re-read. Revalidates authorization + locator identity and
 * hashes bounded bytes without parsing or exposing content.
 */
export async function recheckAuthorizedArtifactIdentity(input: {
  attachmentId: string;
  authorizedAttachmentIds: ReadonlySet<string>;
  expectedLocator: AttachmentLocator;
  expectedSha256: string;
  s3: S3Storage;
  signal: AbortSignal;
  resolveLocator: (attachmentId: string) => Promise<AttachmentLocator | null>;
}): Promise<boolean> {
  if (input.signal.aborted) {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  if (!input.authorizedAttachmentIds.has(input.attachmentId)) return false;
  const current = await input.resolveLocator(input.attachmentId);
  if (!current || !sameLocator(current, input.expectedLocator)) return false;
  if (
    current.sizeBytes < 0 ||
    current.sizeBytes > ARTIFACT_MAX_INPUT_BYTES ||
    !Number.isInteger(current.sizeBytes) ||
    !keyBelongsTo(current)
  ) {
    return false;
  }
  try {
    const object = await input.s3.getObjectBounded(current.s3Key, current.sizeBytes, input.signal);
    if (!object || object.body.byteLength !== current.sizeBytes) return false;
    return sha256Hex(object.body) === input.expectedSha256;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return false;
  }
}
