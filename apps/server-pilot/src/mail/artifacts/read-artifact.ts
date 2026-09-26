/**
 * Authorized mail artifact reads: text/plain + embedded PDF text only.
 * No OCR. No raw text persistence. Hash-bound MailEvidenceRef only.
 * Model never receives S3 keys.
 */
import { S3ObjectTooLargeError, type S3Storage } from '../../storage/s3.js';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { ToolResult } from '../../ai/draft-evidence.js';
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
};

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
};

export type SandboxRunner = (
  tool: 'pdfinfo' | 'pdftotext',
  inputPath: string,
  signal?: AbortSignal,
) => Promise<SandboxResult>;

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
    // Artifact text is server-only candidate material. It is never model evidence.
    draftReady: false,
    data: {
      mimeType: args.mimeType,
      text: args.text,
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

/**
 * Run pdfinfo/pdftotext under bubblewrap + prlimit.
 * Never retries unsandboxed. No OCR binaries.
 */
export async function runPdfSandbox(
  tool: 'pdfinfo' | 'pdftotext',
  inputPath: string,
  signal?: AbortSignal,
): Promise<SandboxResult> {
  const toolArgs =
    tool === 'pdfinfo'
      ? ['/input/document.pdf']
      : ['-layout', '-enc', 'UTF-8', '-eol', 'unix', '/input/document.pdf', '-'];

  const argv = [
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
    '--chdir',
    '/tmp',
    '--',
    '/usr/bin/prlimit',
    '--cpu=5:5',
    '--as=536870912:536870912',
    `--fsize=${ARTIFACT_MAX_OUTPUT_BYTES}:${ARTIFACT_MAX_OUTPUT_BYTES}`,
    '--nofile=32:32',
    '--nproc=16:16',
    '--core=0:0',
    '--',
    `/usr/bin/${tool}`,
    ...toolArgs,
  ];

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

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > ARTIFACT_MAX_OUTPUT_BYTES) {
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
      });
    });
  });
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
        reason: info.exitCode === 3 ? 'encrypted' : 'malformed',
        sourceHash,
        now,
      });
    }

    const infoText = info.stdout.toString('utf8');
    if (/^Encrypted:\s+yes/im.test(infoText)) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: 'encrypted',
        sourceHash,
        now,
      });
    }

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

    if (textResult.exitCode !== 0) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: textResult.exitCode === 3 ? 'encrypted' : 'malformed',
        sourceHash,
        pageCount,
        now,
      });
    }

    if (textResult.stdout.byteLength > ARTIFACT_MAX_OUTPUT_BYTES) {
      return manualResult({
        attachmentId,
        mimeType,
        reason: 'too_large',
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

  if (!locator.s3Key.startsWith(`attachments/${locator.messageId}/`)) {
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

  if (locator.mimeType !== 'text/plain' && locator.mimeType !== 'application/pdf') {
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
        (head.contentType && head.contentType !== locator.mimeType) ||
        !(await input.revalidate())
      ) {
        return finish(
          manualResult({
            attachmentId: input.attachmentId,
            mimeType: locator.mimeType,
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
          mimeType: locator.mimeType,
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
          mimeType: locator.mimeType,
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
          mimeType: locator.mimeType,
          reason,
          sourceHash: null,
          now,
        }),
      );
    }
    throw err;
  }

  if (locator.sizeBytes !== object.body.byteLength) {
    return finish(
      manualResult({
        attachmentId: input.attachmentId,
        mimeType: locator.mimeType,
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

  return finish(
    await extractEmbeddedPdfText(
      {
        body: object.body,
        declaredSize: locator.sizeBytes,
        declaredMime: locator.mimeType,
        objectMime:
          object.contentType === 'application/pdf' ? 'application/pdf' : object.contentType,
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
  if (!locator.s3Key.startsWith(`attachments/${locator.messageId}/`)) return null;
  if (
    !Number.isInteger(locator.sizeBytes) ||
    locator.sizeBytes < 0 ||
    locator.sizeBytes > ARTIFACT_MAX_INPUT_BYTES
  ) {
    return null;
  }
  if (locator.mimeType !== 'text/plain' && locator.mimeType !== 'application/pdf') {
    return null;
  }

  if (input.revalidate) {
    try {
      const head = await input.s3.headObject(locator.s3Key);
      if (
        !head ||
        head.sizeBytes !== locator.sizeBytes ||
        (head.contentType && head.contentType !== locator.mimeType) ||
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
  if (object.contentType && object.contentType !== locator.mimeType) return null;

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
    !current.s3Key.startsWith(`attachments/${current.messageId}/`)
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
