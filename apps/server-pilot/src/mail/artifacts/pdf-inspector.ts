import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const PDF_INSPECTOR_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const PDF_INSPECTOR_MAX_PAGES = 50;
export const PDF_INSPECTOR_MAX_OUTPUT_BYTES = 256 * 1024;
export const PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES = 2 * 1024 * 1024;
export const PDF_INSPECTOR_TIMEOUT_MS = 10_000;

const PDF_INSPECTOR_STDERR_BYTES = 64 * 1024;
const DEFAULT_NODE_MODULES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../node_modules',
);
const DEFAULT_CHILD_SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/pdf-inspector-child.mjs',
);

export type PdfInspectorReason =
  | 'text'
  | 'no_embedded_text'
  | 'encrypted'
  | 'malformed'
  | 'too_large'
  | 'too_many_pages'
  | 'timeout'
  | 'parser_failure';

export type PdfInspectorDetectionType = 'TextBased' | 'Scanned' | 'ImageBased' | 'Mixed';

export type PdfInspectorResult = {
  status: 'ok' | 'manual_required';
  reason: PdfInspectorReason;
  pageCount: number | null;
  markdown: string | null;
  pdfType: PdfInspectorDetectionType | null;
  confidence: number | null;
  pagesNeedingOcr: number[];
  pagesWithTables: number[];
  pagesWithColumns: number[];
  isComplexLayout: boolean | null;
  hasEncodingIssues: boolean | null;
  elapsedMs: number;
};

export type PdfInspectorCommand = {
  executable: string;
  args: string[];
  env: Record<string, string>;
};

export type PdfInspectorCommandPaths = {
  appPnpmStorePath?: string;
  bwrapPath?: string;
  childArgs?: string[];
  childScriptPath?: string;
  nodeModulesPath?: string;
  nodePath?: string;
  pnpmStorePath?: string;
  prlimitPath?: string;
};

export type PdfInspectorChildExecution = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  outputLimitExceeded: boolean;
};

export type PdfInspectorChildExecutor = (
  command: PdfInspectorCommand,
  options: {
    signal: AbortSignal;
    maxOutputBytes: number;
  },
) => Promise<PdfInspectorChildExecution>;

export type PdfInspectorOptions = {
  runChild?: PdfInspectorChildExecutor;
  signal?: AbortSignal;
  timeoutMs?: number;
  commandPaths?: PdfInspectorCommandPaths;
};

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function normalizeText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .split('\u0000')
    .join('')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function boundedPush(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
): number {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) return currentBytes;
  const bounded = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(bounded);
  return currentBytes + bounded.byteLength;
}

/**
 * Run child with no inherited env. Caller owns sandbox command construction.
 * Abort kills child. Output overrun kills child and returns a bounded marker.
 */
export function runPdfInspectorChild(
  command: PdfInspectorCommand,
  options: {
    signal: AbortSignal;
    maxOutputBytes?: number;
  },
): Promise<PdfInspectorChildExecution> {
  const maxOutputBytes = options.maxOutputBytes ?? PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES;

  return new Promise((resolvePromise, rejectPromise) => {
    if (options.signal.aborted) {
      rejectPromise(abortError());
      return;
    }

    const child = spawn(command.executable, command.args, {
      shell: false,
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let aborted = false;
    let outputLimitExceeded = false;
    let settled = false;

    const cleanup = () => {
      options.signal.removeEventListener('abort', onAbort);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const finishResolve = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        rejectPromise(abortError());
        return;
      }
      resolvePromise({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode,
        signal,
        outputLimitExceeded,
      });
    };
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };

    options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (aborted || outputLimitExceeded) return;
      if (stdoutBytes + chunk.byteLength > maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutBytes += chunk.byteLength;
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = boundedPush(stderr, chunk, stderrBytes, PDF_INSPECTOR_STDERR_BYTES);
    });
    child.once('error', (error) => {
      if (aborted) {
        finishReject(abortError());
      } else {
        finishReject(error);
      }
    });
    child.once('close', (exitCode, signal) => {
      finishResolve(exitCode, signal);
    });
  });
}

/**
 * Build only sandboxed execution. No unsandboxed fallback exists.
 */
export function buildPdfInspectorCommand(
  inputPath: string,
  paths: PdfInspectorCommandPaths = {},
): PdfInspectorCommand {
  const nodePath = paths.nodePath ?? process.execPath;
  const nodeBinPath = dirname(nodePath);
  const nodeName = basename(nodePath);
  const childScriptPath = paths.childScriptPath ?? DEFAULT_CHILD_SCRIPT_PATH;
  const nodeModulesPath = paths.nodeModulesPath ?? DEFAULT_NODE_MODULES_PATH;
  const pnpmStorePath =
    paths.pnpmStorePath ?? resolve(nodeModulesPath, '../../../node_modules/.pnpm');
  const appPnpmStorePath = paths.appPnpmStorePath ?? join(nodeModulesPath, '.pnpm');
  const bwrapPath = paths.bwrapPath ?? '/usr/bin/bwrap';
  const prlimitPath = paths.prlimitPath ?? '/usr/bin/prlimit';

  return {
    executable: bwrapPath,
    env: { PATH: '/usr/bin:/bin' },
    args: [
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
      'NAPI_RS_ENFORCE_VERSION_CHECK',
      '1',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind-try',
      '/lib64',
      '/lib64',
      '--dir',
      '/runtime',
      '--ro-bind',
      nodeBinPath,
      '/runtime/node',
      '--ro-bind',
      nodeModulesPath,
      '/app/node_modules',
      '--dir',
      '/node_modules',
      '--ro-bind-try',
      pnpmStorePath,
      '/node_modules/.pnpm',
      '--ro-bind-try',
      appPnpmStorePath,
      '/app/.pnpm',
      '--ro-bind',
      childScriptPath,
      '/app/pdf-inspector-child.mjs',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/app',
      '--dir',
      '/input',
      '--ro-bind',
      inputPath,
      '/input/document.pdf',
      '--chdir',
      '/tmp',
      '--',
      prlimitPath,
      '--cpu=5:5',
      '--as=1073741824:1073741824',
      `--fsize=${PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES}:${PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES}`,
      '--nofile=32:32',
      '--nproc=16:16',
      '--core=0:0',
      '--',
      `/runtime/node/${nodeName}`,
      '/app/pdf-inspector-child.mjs',
      '/input/document.pdf',
      ...(paths.childArgs ?? []),
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReason(value: unknown): value is PdfInspectorReason {
  return (
    value === 'text' ||
    value === 'no_embedded_text' ||
    value === 'encrypted' ||
    value === 'malformed' ||
    value === 'too_large' ||
    value === 'too_many_pages' ||
    value === 'timeout' ||
    value === 'parser_failure'
  );
}

function isDetectionType(value: unknown): value is PdfInspectorDetectionType {
  return (
    value === 'TextBased' || value === 'Scanned' || value === 'ImageBased' || value === 'Mixed'
  );
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function optionalConfidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function optionalPageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function pageList(value: unknown): number[] {
  return value as number[];
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validChildProtocol(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const requiredFields = [
    'status',
    'reason',
    'pageCount',
    'markdown',
    'pdfType',
    'confidence',
    'pagesNeedingOcr',
    'pagesWithTables',
    'pagesWithColumns',
    'isComplexLayout',
    'hasEncodingIssues',
  ];
  if (requiredFields.some((field) => !hasOwn(value, field))) return false;
  if (value.status !== 'ok' && value.status !== 'manual_required') {
    return false;
  }
  if (!isReason(value.reason)) return false;
  const pageCount = value.pageCount as number | null;
  if (pageCount !== null && (!Number.isInteger(pageCount) || pageCount < 1)) {
    return false;
  }
  if (pageCount !== null && !Number.isSafeInteger(pageCount)) return false;
  if (value.markdown !== null && typeof value.markdown !== 'string') return false;
  if (value.pdfType !== null && !isDetectionType(value.pdfType)) return false;
  if (value.confidence !== null && optionalConfidence(value.confidence) === null) return false;
  for (const key of ['pagesNeedingOcr', 'pagesWithTables', 'pagesWithColumns']) {
    const pages = value[key];
    if (
      !Array.isArray(pages) ||
      pages.some(
        (page) =>
          !Number.isSafeInteger(page) ||
          page < 1 ||
          pageCount === null ||
          page > pageCount ||
          page > PDF_INSPECTOR_MAX_PAGES,
      ) ||
      new Set(pages).size !== pages.length
    ) {
      return false;
    }
  }
  for (const key of ['isComplexLayout', 'hasEncodingIssues']) {
    if (value[key] !== null && typeof value[key] !== 'boolean') return false;
  }
  if (
    (value.pdfType === null && value.confidence !== null) ||
    (value.pdfType !== null && value.confidence === null)
  ) {
    return false;
  }

  const reason = value.reason as PdfInspectorReason;
  const markdown = value.markdown;
  const pageArrays = [
    value.pagesNeedingOcr as number[],
    value.pagesWithTables as number[],
    value.pagesWithColumns as number[],
  ];
  if (value.status === 'ok') {
    return (
      reason === 'text' &&
      pageCount !== null &&
      pageCount <= PDF_INSPECTOR_MAX_PAGES &&
      typeof markdown === 'string' &&
      normalizeText(markdown).length > 0 &&
      value.pdfType !== null &&
      value.confidence !== null &&
      value.isComplexLayout !== null &&
      value.hasEncodingIssues !== null
    );
  }
  if (reason === 'text') return false;
  if (reason === 'no_embedded_text') {
    return (
      pageCount !== null &&
      pageCount <= PDF_INSPECTOR_MAX_PAGES &&
      (typeof markdown !== 'string' || normalizeText(markdown).length === 0) &&
      value.pdfType !== null &&
      value.confidence !== null &&
      value.isComplexLayout !== null &&
      value.hasEncodingIssues !== null
    );
  }
  if (reason === 'too_many_pages' && (pageCount === null || pageCount <= PDF_INSPECTOR_MAX_PAGES))
    return false;
  if (reason === 'too_many_pages') {
    return (
      value.status === 'manual_required' &&
      typeof markdown !== 'string' &&
      pageArrays.every((pages) => pages.length === 0) &&
      value.pdfType === null &&
      value.confidence === null &&
      value.isComplexLayout === null &&
      value.hasEncodingIssues === null
    );
  }
  if (reason === 'too_large' && pageCount !== null && pageCount > PDF_INSPECTOR_MAX_PAGES)
    return false;
  if (reason !== 'too_large' && pageCount !== null) return false;
  return (
    value.status === 'manual_required' &&
    (typeof markdown !== 'string' || normalizeText(markdown).length === 0) &&
    pageArrays.every((pages) => pages.length === 0) &&
    value.pdfType === null &&
    value.confidence === null &&
    value.isComplexLayout === null &&
    value.hasEncodingIssues === null
  );
}

function emptyResult(
  reason: PdfInspectorReason,
  elapsedMs: number,
  pageCount: number | null = null,
): PdfInspectorResult {
  return {
    status: 'manual_required',
    reason,
    pageCount,
    markdown: null,
    pdfType: null,
    confidence: null,
    pagesNeedingOcr: [],
    pagesWithTables: [],
    pagesWithColumns: [],
    isComplexLayout: null,
    hasEncodingIssues: null,
    elapsedMs,
  };
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function normalizeChildResponse(value: unknown, elapsedMs: number): PdfInspectorResult {
  if (!validChildProtocol(value)) return emptyResult('parser_failure', elapsedMs);

  const pageCount = optionalPageCount(value.pageCount);
  const rawMarkdown = typeof value.markdown === 'string' ? normalizeText(value.markdown) : '';
  let reason: PdfInspectorReason = value.reason as PdfInspectorReason;

  if (
    reason === 'text' &&
    Buffer.byteLength(rawMarkdown, 'utf8') > PDF_INSPECTOR_MAX_OUTPUT_BYTES
  ) {
    return emptyResult('too_large', elapsedMs, pageCount);
  }

  const markdown =
    reason === 'text' &&
    rawMarkdown &&
    Buffer.byteLength(rawMarkdown, 'utf8') <= PDF_INSPECTOR_MAX_OUTPUT_BYTES
      ? rawMarkdown
      : null;

  return {
    status: value.status as 'ok' | 'manual_required',
    reason,
    pageCount,
    markdown,
    pdfType: isDetectionType(value.pdfType) ? value.pdfType : null,
    confidence: optionalConfidence(value.confidence),
    pagesNeedingOcr: pageList(value.pagesNeedingOcr),
    pagesWithTables: pageList(value.pagesWithTables),
    pagesWithColumns: pageList(value.pagesWithColumns),
    isComplexLayout: optionalBoolean(value.isComplexLayout),
    hasEncodingIssues: optionalBoolean(value.hasEncodingIssues),
    elapsedMs,
  };
}

function parseChildResponse(
  execution: PdfInspectorChildExecution,
  elapsedMs: number,
): PdfInspectorResult {
  if (execution.outputLimitExceeded) {
    return emptyResult('too_large', elapsedMs);
  }
  if (execution.exitCode !== 0 || execution.signal !== null) {
    return emptyResult('parser_failure', elapsedMs);
  }
  if (execution.stdout.byteLength > PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES) {
    return emptyResult('too_large', elapsedMs);
  }

  try {
    return normalizeChildResponse(JSON.parse(execution.stdout.toString('utf8')), elapsedMs);
  } catch {
    return emptyResult('parser_failure', elapsedMs);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (isRecord(error) && error.name === 'AbortError')
  );
}

export async function inspectPdf(
  buffer: Buffer,
  options: PdfInspectorOptions = {},
): Promise<PdfInspectorResult> {
  const startedAt = performance.now();

  if (buffer.byteLength > PDF_INSPECTOR_MAX_INPUT_BYTES) {
    return emptyResult('too_large', elapsedSince(startedAt));
  }
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return emptyResult('malformed', elapsedSince(startedAt));
  }
  if (options.signal?.aborted) {
    throw abortError();
  }

  const directory = await mkdtemp(join(tmpdir(), 'nava-pdf-inspector-'));
  try {
    await chmod(directory, 0o700);
    const inputPath = join(directory, 'document.pdf');
    await writeFile(inputPath, buffer, { mode: 0o600 });

    const command = buildPdfInspectorCommand(inputPath, options.commandPaths);
    const runner = options.runChild ?? runPdfInspectorChild;
    const deadline = AbortSignal.timeout(options.timeoutMs ?? PDF_INSPECTOR_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

    let execution: PdfInspectorChildExecution;
    try {
      execution = await runner(command, {
        signal,
        maxOutputBytes: PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (signal.aborted || isAbortError(error)) {
        return emptyResult('timeout', elapsedSince(startedAt));
      }
      return emptyResult('parser_failure', elapsedSince(startedAt));
    }

    return parseChildResponse(execution, elapsedSince(startedAt));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
