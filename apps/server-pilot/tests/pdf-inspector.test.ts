import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const adapterPath = fileURLToPath(
  new URL('../src/mail/artifacts/pdf-inspector.ts', import.meta.url),
);
const childPath = fileURLToPath(new URL('../scripts/pdf-inspector-child.mjs', import.meta.url));
const networkProbePath = fileURLToPath(
  new URL('../scripts/pdf-inspector-network-probe.mjs', import.meta.url),
);
const gatePath = fileURLToPath(new URL('../deploy/pdf-inspector-gate.sh', import.meta.url));

const syntheticPdf = Buffer.from('%PDF-1.7\n% synthetic fixture\n', 'ascii');

async function loadAdapter() {
  expect(existsSync(adapterPath), 'Task 1 adapter is missing').toBe(true);
  return import('../src/mail/artifacts/pdf-inspector.js');
}

type FakeChildOptions = {
  stdout?: Buffer | string;
  exitCode?: number | null;
  signal?: string | null;
  outputLimitExceeded?: boolean;
  throwMessage?: string;
  hang?: boolean;
};

function fakeChild(options: FakeChildOptions = {}) {
  let seenCommand:
    | {
        executable: string;
        args: string[];
        env: Record<string, string>;
      }
    | undefined;
  let killed = false;

  const run = async (
    command: typeof seenCommand,
    context: { signal: AbortSignal; maxOutputBytes: number },
  ) => {
    seenCommand = command ?? undefined;
    if (options.throwMessage) throw new Error(options.throwMessage);
    if (options.hang) {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          killed = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (context.signal.aborted) {
          abort();
          return;
        }
        context.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return {
      stdout: Buffer.from(options.stdout ?? '{}'),
      stderr: Buffer.from('synthetic stderr must not escape'),
      exitCode: options.exitCode ?? 0,
      signal: options.signal ?? null,
      outputLimitExceeded: options.outputLimitExceeded ?? false,
      maxOutputBytes: context.maxOutputBytes,
    };
  };

  return {
    run,
    command: () => seenCommand,
    killed: () => killed,
  };
}

function childJson(value: unknown): string {
  return JSON.stringify(value);
}

const controlledChildSource = `
import { createConnection } from 'node:net';

const mode = process.argv[2];
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
} else if (mode === 'stdout') {
  process.stdout.write('x'.repeat(3 * 1024 * 1024));
  setInterval(() => {}, 1000);
} else if (mode === 'stderr') {
  process.stderr.write('e'.repeat(512 * 1024));
  process.stdout.write('{}');
} else if (mode === 'network') {
  const port = Number(process.argv[3]);
  let finished = false;
  const finish = (connected) => {
    if (finished) return;
    finished = true;
    process.stdout.write(JSON.stringify({ connected }));
    process.exitCode = connected ? 1 : 0;
  };
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(300);
  socket.on('connect', () => {
    socket.destroy();
    finish(true);
  });
  socket.on('error', () => finish(false));
  socket.on('timeout', () => {
    socket.destroy();
    finish(false);
  });
} else {
  process.stdout.write('{}');
}
`;

async function runControlledLinuxChild(mode: string, timeoutMs = 2_000, childArgs: string[] = []) {
  const {
    buildPdfInspectorCommand,
    runPdfInspectorChild,
    PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES,
  } = await loadAdapter();
  const directory = await mkdtemp(join(tmpdir(), 'pdf-inspector-linux-'));
  const scriptPath = join(directory, 'controlled-child.mjs');
  const modulesPath = join(directory, 'node_modules');
  const inputPath = join(directory, 'input.pdf');
  await mkdir(modulesPath);
  await writeFile(scriptPath, controlledChildSource, { mode: 0o700 });
  await writeFile(inputPath, syntheticPdf, { mode: 0o600 });

  try {
    const command = buildPdfInspectorCommand(inputPath, {
      childArgs: [mode, ...childArgs],
      childScriptPath: scriptPath,
      nodeModulesPath: modulesPath,
      nodePath: process.execPath,
      bwrapPath: '/usr/bin/bwrap',
      prlimitPath: '/usr/bin/prlimit',
    });
    return await runPdfInspectorChild(command, {
      maxOutputBytes: PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('PDF Inspector local boundary', () => {
  it('pins exact existing artifact limits and separate protocol headroom', async () => {
    const {
      PDF_INSPECTOR_MAX_INPUT_BYTES,
      PDF_INSPECTOR_MAX_PAGES,
      PDF_INSPECTOR_MAX_OUTPUT_BYTES,
      PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES,
      PDF_INSPECTOR_TIMEOUT_MS,
    } = await loadAdapter();

    expect(PDF_INSPECTOR_MAX_INPUT_BYTES).toBe(20 * 1024 * 1024);
    expect(PDF_INSPECTOR_MAX_PAGES).toBe(50);
    expect(PDF_INSPECTOR_MAX_OUTPUT_BYTES).toBe(256 * 1024);
    expect(PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES).toBe(2 * 1024 * 1024);
    expect(PDF_INSPECTOR_TIMEOUT_MS).toBe(10_000);
  });

  it('builds a no-network, resource-limited Bubblewrap command', async () => {
    const { buildPdfInspectorCommand } = await loadAdapter();
    const command = buildPdfInspectorCommand('/fixture/document.pdf', {
      bwrapPath: '/usr/bin/bwrap',
      childScriptPath: '/srv/scripts/pdf-inspector-child.mjs',
      nodeModulesPath: '/srv/node_modules',
      nodePath: '/opt/node/bin/node',
      prlimitPath: '/usr/bin/prlimit',
    });

    expect(command.executable).toBe('/usr/bin/bwrap');
    expect(command.env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(command.args).toEqual(
      expect.arrayContaining([
        '--clearenv',
        '--unshare-net',
        '--unshare-pid',
        '--unshare-user',
        '--unshare-ipc',
        '--unshare-uts',
        '--ro-bind',
        '/fixture/document.pdf',
        '/input/document.pdf',
        '/opt/node/bin',
        '/srv/node_modules',
        '/node_modules',
        '/node_modules/.pnpm',
        '--tmpfs',
        '/tmp',
        '/runtime',
        '/runtime/node',
        '--',
        '/usr/bin/prlimit',
        '--cpu=5:5',
        '--as=1073741824:1073741824',
        '--fsize=2097152:2097152',
        '--nofile=32:32',
        '--nproc=16:16',
        '--core=0:0',
        '/runtime/node/node',
        '/app/pdf-inspector-child.mjs',
        '/input/document.pdf',
      ]),
    );
    expect(command.args).not.toContain('--share-net');
    expect(command.args).toEqual(
      expect.arrayContaining(['--setenv', 'NAPI_RS_ENFORCE_VERSION_CHECK', '1']),
    );
    expect(command.args).not.toContain('NODE_PATH');
  });

  it('mounts an explicit staged pnpm store', async () => {
    const { buildPdfInspectorCommand } = await loadAdapter();
    const command = buildPdfInspectorCommand('/fixture/document.pdf', {
      nodeModulesPath: '/stage/node_modules',
      pnpmStorePath: '/stage/pnpm-store',
    });

    expect(command.args).toEqual(
      expect.arrayContaining([
        '--ro-bind-try',
        '/stage/pnpm-store',
        '/node_modules/.pnpm',
      ]),
    );
    expect(
      command.args.filter((value) => value === '/node_modules/.pnpm'),
    ).toHaveLength(1);
  });

  it('normalizes text response and preserves detection metadata', async () => {
    const { inspectPdf } = await loadAdapter();
    const child = fakeChild({
      stdout: childJson({
        status: 'ok',
        reason: 'text',
        pageCount: 2,
        markdown: '\uFEFFBooking\r\nReference\u0000 REF-1 ',
        pdfType: 'TextBased',
        confidence: 0.98,
        pagesNeedingOcr: [],
        pagesWithTables: [1],
        pagesWithColumns: [2],
        isComplexLayout: true,
        hasEncodingIssues: false,
      }),
    });

    const result = await inspectPdf(syntheticPdf, { runChild: child.run });

    expect(result).toMatchObject({
      status: 'ok',
      reason: 'text',
      pageCount: 2,
      markdown: 'Booking\nReference REF-1',
      pdfType: 'TextBased',
      confidence: 0.98,
      pagesNeedingOcr: [],
      pagesWithTables: [1],
      pagesWithColumns: [2],
      isComplexLayout: true,
      hasEncodingIssues: false,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(child.command()?.args).toContain('/input/document.pdf');
  });

  it('maps scanned no-text response to bounded manual result', async () => {
    const { inspectPdf } = await loadAdapter();
    const result = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({
        stdout: childJson({
          status: 'manual_required',
          reason: 'no_embedded_text',
          pageCount: 3,
          markdown: '',
          pdfType: 'Scanned',
          confidence: 0.91,
          pagesNeedingOcr: [1, 2, 3],
          pagesWithTables: [],
          pagesWithColumns: [],
          isComplexLayout: false,
          hasEncodingIssues: false,
        }),
      }).run,
    });

    expect(result).toMatchObject({
      status: 'manual_required',
      reason: 'no_embedded_text',
      pageCount: 3,
      markdown: null,
      pdfType: 'Scanned',
      pagesNeedingOcr: [1, 2, 3],
    });
  });

  it('preserves mixed-page OCR and layout indicators', async () => {
    const { inspectPdf } = await loadAdapter();
    const result = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({
        stdout: childJson({
          status: 'ok',
          reason: 'text',
          pageCount: 4,
          markdown: '# Text page\n\nVisible fixture text',
          pdfType: 'Mixed',
          confidence: 0.76,
          pagesNeedingOcr: [2, 4],
          pagesWithTables: [1],
          pagesWithColumns: [3],
          isComplexLayout: true,
          hasEncodingIssues: true,
        }),
      }).run,
    });

    expect(result).toMatchObject({
      status: 'ok',
      reason: 'text',
      pdfType: 'Mixed',
      pagesNeedingOcr: [2, 4],
      pagesWithTables: [1],
      pagesWithColumns: [3],
      isComplexLayout: true,
      hasEncodingIssues: true,
    });
  });

  it.each([
    ['encrypted', 'encrypted'],
    ['malformed', 'malformed'],
  ] as const)('preserves %s child failure reason', async (_name, reason) => {
    const { inspectPdf } = await loadAdapter();
    const result = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({
        stdout: childJson({
          status: 'manual_required',
          reason,
          pageCount: null,
          markdown: null,
          pdfType: null,
          confidence: null,
          pagesNeedingOcr: [],
          pagesWithTables: [],
          pagesWithColumns: [],
          isComplexLayout: null,
          hasEncodingIssues: null,
        }),
      }).run,
    });

    expect(result).toMatchObject({
      status: 'manual_required',
      reason,
      markdown: null,
    });
  });

  it('rejects malformed input before child execution', async () => {
    const { inspectPdf } = await loadAdapter();
    const child = fakeChild();

    const result = await inspectPdf(Buffer.from('not a PDF', 'ascii'), {
      runChild: child.run,
    });

    expect(result).toMatchObject({
      status: 'manual_required',
      reason: 'malformed',
      pageCount: null,
      markdown: null,
    });
    expect(child.command()).toBeUndefined();
  });

  it('maps input and child output overrun to too_large', async () => {
    const {
      inspectPdf,
      PDF_INSPECTOR_MAX_INPUT_BYTES,
      PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES,
    } = await loadAdapter();

    const oversizedInput = Buffer.alloc(PDF_INSPECTOR_MAX_INPUT_BYTES + 1, 0x41);
    oversizedInput.write('%PDF-', 0, 'ascii');
    const inputResult = await inspectPdf(oversizedInput, {
      runChild: fakeChild().run,
    });
    expect(inputResult.reason).toBe('too_large');

    const outputResult = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({ outputLimitExceeded: true }).run,
    });
    expect(outputResult.reason).toBe('too_large');

    const jsonOverrun = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({
        stdout: 'x'.repeat(PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES + 1),
      }).run,
    });
    expect(jsonOverrun.reason).toBe('too_large');
  });

  it('allows exact Markdown cap with protocol headroom and rejects one byte over', async () => {
    const { inspectPdf, PDF_INSPECTOR_MAX_OUTPUT_BYTES, PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES } =
      await loadAdapter();
    const metadata = {
      status: 'ok',
      reason: 'text',
      pageCount: 1,
      pdfType: 'TextBased',
      confidence: 1,
      pagesNeedingOcr: [],
      pagesWithTables: [],
      pagesWithColumns: [],
      isComplexLayout: false,
      hasEncodingIssues: false,
    };
    const exactMarkdown = 'x'.repeat(PDF_INSPECTOR_MAX_OUTPUT_BYTES);
    const exactPayload = childJson({ ...metadata, markdown: exactMarkdown });
    expect(Buffer.byteLength(exactPayload)).toBeLessThan(PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES);

    const exact = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({ stdout: exactPayload }).run,
    });
    expect(exact.reason).toBe('text');
    expect(exact.markdown).toHaveLength(PDF_INSPECTOR_MAX_OUTPUT_BYTES);

    const over = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({
        stdout: childJson({
          ...metadata,
          markdown: `${exactMarkdown}x`,
        }),
      }).run,
    });
    expect(over.reason).toBe('too_large');
  });

  it('allows exact Markdown cap with worst-case control-character escaping', async () => {
    const { inspectPdf, PDF_INSPECTOR_MAX_OUTPUT_BYTES, PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES } =
      await loadAdapter();
    const payload = {
      status: 'ok',
      reason: 'text',
      pageCount: 1,
      markdown: '\u0001'.repeat(PDF_INSPECTOR_MAX_OUTPUT_BYTES),
      pdfType: 'TextBased',
      confidence: 1,
      pagesNeedingOcr: [],
      pagesWithTables: [],
      pagesWithColumns: [],
      isComplexLayout: false,
      hasEncodingIssues: false,
    };
    const encoded = childJson(payload);

    expect(Buffer.byteLength(payload.markdown)).toBe(PDF_INSPECTOR_MAX_OUTPUT_BYTES);
    expect(Buffer.byteLength(encoded)).toBeLessThan(PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES);
    const result = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({ stdout: encoded }).run,
    });
    expect(result.reason).toBe('text');
    expect(result.markdown).toHaveLength(PDF_INSPECTOR_MAX_OUTPUT_BYTES);
  });

  it('maps pageCount 51 to too_many_pages', async () => {
    const { inspectPdf } = await loadAdapter();
    const result = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({
        stdout: childJson({
          status: 'manual_required',
          reason: 'too_many_pages',
          pageCount: 51,
          markdown: null,
          pdfType: null,
          confidence: null,
          pagesNeedingOcr: [],
          pagesWithTables: [],
          pagesWithColumns: [],
          isComplexLayout: null,
          hasEncodingIssues: null,
        }),
      }).run,
    });
    expect(result).toMatchObject({
      status: 'manual_required',
      reason: 'too_many_pages',
      pageCount: 51,
    });
  });

  it.each([
    ['empty object', {}],
    ['missing page count', { status: 'ok', reason: 'text', markdown: 'text' }],
    ['wrong status type', { status: true, reason: 'text', pageCount: 1, markdown: 'text' }],
    ['wrong page count type', { status: 'ok', reason: 'text', pageCount: '1', markdown: 'text' }],
    ['contradictory success', { status: 'ok', reason: 'text', pageCount: 1, markdown: '' }],
    [
      'contradictory no-text',
      {
        status: 'manual_required',
        reason: 'no_embedded_text',
        pageCount: null,
        markdown: null,
      },
    ],
  ])('rejects invalid child protocol: %s', async (_name, payload) => {
    const { inspectPdf } = await loadAdapter();
    const result = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({ stdout: childJson(payload) }).run,
    });
    expect(result).toMatchObject({
      status: 'manual_required',
      reason: 'parser_failure',
      markdown: null,
    });
  });

  it.each([
    [
      'missing required metadata',
      {
        status: 'ok',
        reason: 'text',
        pageCount: 1,
        markdown: 'text',
      },
    ],
    [
      'duplicate page metadata',
      {
        status: 'ok',
        reason: 'text',
        pageCount: 2,
        markdown: 'text',
        pdfType: 'TextBased',
        confidence: 1,
        pagesNeedingOcr: [1, 1],
        pagesWithTables: [],
        pagesWithColumns: [],
        isComplexLayout: false,
        hasEncodingIssues: false,
      },
    ],
    [
      'page metadata beyond page count',
      {
        status: 'ok',
        reason: 'text',
        pageCount: 1,
        markdown: 'text',
        pdfType: 'TextBased',
        confidence: 1,
        pagesNeedingOcr: [2],
        pagesWithTables: [],
        pagesWithColumns: [],
        isComplexLayout: false,
        hasEncodingIssues: false,
      },
    ],
    [
      'unsafe page count',
      {
        status: 'manual_required',
        reason: 'malformed',
        pageCount: Number.MAX_SAFE_INTEGER + 1,
        markdown: null,
        pdfType: null,
        confidence: null,
        pagesNeedingOcr: [],
        pagesWithTables: [],
        pagesWithColumns: [],
        isComplexLayout: null,
        hasEncodingIssues: null,
      },
    ],
  ])('rejects strict protocol invariant: %s', async (_name, payload) => {
    const { inspectPdf } = await loadAdapter();
    const result = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({ stdout: childJson(payload) }).run,
    });
    expect(result.reason).toBe('parser_failure');
  });

  it('rejects missing required success and no-text metadata', async () => {
    const { inspectPdf } = await loadAdapter();
    const valid = {
      status: 'ok',
      reason: 'text',
      pageCount: 1,
      markdown: 'text',
      pdfType: 'TextBased',
      confidence: 1,
      pagesNeedingOcr: [],
      pagesWithTables: [],
      pagesWithColumns: [],
      isComplexLayout: false,
      hasEncodingIssues: false,
    };
    for (const field of ['pdfType', 'confidence', 'isComplexLayout', 'hasEncodingIssues']) {
      const payload = { ...valid };
      delete payload[field as keyof typeof payload];
      const result = await inspectPdf(syntheticPdf, {
        runChild: fakeChild({ stdout: childJson(payload) }).run,
      });
      expect(result.reason, field).toBe('parser_failure');
    }
    const validNoText = {
      ...valid,
      status: 'manual_required',
      reason: 'no_embedded_text',
      markdown: '',
      pdfType: 'Scanned',
      pagesNeedingOcr: [1],
    };
    for (const field of ['pdfType', 'confidence', 'isComplexLayout', 'hasEncodingIssues']) {
      const payload = { ...validNoText };
      delete payload[field as keyof typeof payload];
      const result = await inspectPdf(syntheticPdf, {
        runChild: fakeChild({ stdout: childJson(payload) }).run,
      });
      expect(result.reason, `no-text ${field}`).toBe('parser_failure');
    }
  });

  it('rejects contradictory failure metadata', async () => {
    const { inspectPdf } = await loadAdapter();
    const result = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({
        stdout: childJson({
          status: 'manual_required',
          reason: 'encrypted',
          pageCount: null,
          markdown: null,
          pdfType: 'TextBased',
          confidence: 1,
          pagesNeedingOcr: [],
          pagesWithTables: [],
          pagesWithColumns: [],
          isComplexLayout: null,
          hasEncodingIssues: null,
        }),
      }).run,
    });
    expect(result.reason).toBe('parser_failure');
  });

  it('maps deadline abort to timeout and signals child kill', async () => {
    const { inspectPdf, PDF_INSPECTOR_TIMEOUT_MS } = await loadAdapter();
    const child = fakeChild({ hang: true });

    const result = await inspectPdf(syntheticPdf, {
      runChild: child.run,
      timeoutMs: Math.min(10, PDF_INSPECTOR_TIMEOUT_MS),
    });

    expect(result).toMatchObject({
      status: 'manual_required',
      reason: 'timeout',
      markdown: null,
    });
    expect(child.killed()).toBe(true);
  });

  it('maps malformed JSON, signal exits, and crashes without stderr leakage', async () => {
    const { inspectPdf } = await loadAdapter();

    const malformedJson = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({ stdout: '{"status":' }).run,
    });
    expect(malformedJson.reason).toBe('parser_failure');

    const signalExit = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({ exitCode: null, signal: 'SIGKILL' }).run,
    });
    expect(signalExit.reason).toBe('parser_failure');

    const crash = await inspectPdf(syntheticPdf, {
      runChild: fakeChild({ throwMessage: 'private synthetic crash payload' }).run,
    });
    expect(crash.reason).toBe('parser_failure');
    expect(JSON.stringify(crash)).not.toContain('private synthetic crash payload');
    expect(JSON.stringify(crash)).not.toContain('synthetic stderr must not escape');
  });

  it('parses lockfile resolution through top-level package boundaries', () => {
    const gateSource = readFileSync(gatePath, 'utf8');
    const lock = [
      "  '@firecrawl/pdf-inspector@1.12.0':",
      '    resolution: {integrity: sha512-main}',
      "  '@firecrawl/pdf-inspector-linux-x64-gnu@1.12.0':",
      '    resolution: {integrity: sha512-platform}',
    ].join('\r\n');
    const marker = "  '@firecrawl/pdf-inspector@1.12.0':";
    const start = lock.indexOf(marker);
    const remainder = lock.slice(start + marker.length);
    const boundary = remainder.search(/\r?\n  \S/);
    const end = start + marker.length + boundary;
    const block = lock.slice(start, end);

    expect(block).toContain('sha512-main');
    expect(block).not.toContain('sha512-platform');
    expect(gateSource).toMatch(/remainder\.search\(\/\\r\?\\n  \\S\/\)/);
    expect(gateSource).not.toContain('lock.indexOf("\\n  ", start + marker.length)');
  });

  it('preserves candidate gate status through cleanup', () => {
    const gateSource = readFileSync(gatePath, 'utf8');
    const candidateGateSource = gateSource.slice(
      gateSource.indexOf('candidate_gate()'),
      gateSource.indexOf('if [[ -z "$NODE_BIN" ]]'),
    );

    expect(candidateGateSource).toContain('local exit_status=$?');
    expect(candidateGateSource).toContain('rm -rf "$tmp" || true');
    expect(candidateGateSource).toContain('trap - EXIT');
    expect(candidateGateSource).toContain('return "$exit_status"');
    expect(candidateGateSource).toMatch(/candidate_cleanup\r?\n}/);
    expect(candidateGateSource).not.toContain('wait "$listener_pid"');
    expect(candidateGateSource).toContain('trusted_app_root');
    expect(candidateGateSource).toContain('trusted_child_script');
    expect(candidateGateSource).toContain('trusted_network_probe_script');
    expect(candidateGateSource).not.toContain('gate_script="$(assert_stage_path');
  });

  it('keeps native import in child and gate, never parent adapter', () => {
    const parentSource = readFileSync(adapterPath, 'utf8');
    const childSource = readFileSync(childPath, 'utf8');
    const networkProbeSource = readFileSync(networkProbePath, 'utf8');
    const gateSource = readFileSync(gatePath, 'utf8');

    expect(parentSource).not.toMatch(/@firecrawl\/pdf-inspector/);
    expect(gateSource.split(/\r?\n/u)[0]).toBe(
      '#!/usr/bin/env -S -i PATH=/usr/bin:/bin LC_ALL=C LANG=C /usr/bin/bash',
    );
    expect(childSource).toMatch(/@firecrawl\/pdf-inspector/);
    expect(childSource).toMatch(/processPdf/);
    expect(gateSource).toMatch(/@firecrawl\/pdf-inspector/);
    expect(gateSource).toMatch(/1\.12\.0/);
    expect(gateSource).toMatch(/0\.41\.0/);
    expect(gateSource).toMatch(
      /EXPECTED_PUBLISHED_GIT_HEAD='98990cc55028a83aa8c712df938dd5dc19523350'/,
    );
    expect(gateSource).toMatch(/PACKAGE_SCOPE_DIR="\$\(dirname "\$PACKAGE_DIR"\)"/);
    expect(gateSource).toMatch(/pdf-inspector-provenance\.json/);
    expect(gateSource).toMatch(/pnpm-lock\.yaml/);
    expect(gateSource).toMatch(/publishedGitHead/);
    expect(gateSource).toMatch(/PLATFORM_MANIFEST_INTEGRITY/);
    expect(gateSource).toMatch(/--unshare-net/);
    expect(gateSource).toMatch(/--clearenv/);
    expect(gateSource).toMatch(/MAX_PROTOCOL_OUTPUT_BYTES=\$\(\(2 \* 1024 \* 1024\)\)/);
    expect(gateSource).toMatch(/NAPI_RS_ENFORCE_VERSION_CHECK/);
    expect(gateSource).toMatch(/NATIVE_PACKAGE_VERSION/);
    expect(gateSource).toMatch(/pdf-inspector-network-probe\.mjs/);
    expect(gateSource).toMatch(/--expect-connected/);
    expect(gateSource).toMatch(/--expect-blocked/);
    expect(gateSource).toMatch(/network-probe\.mjs --probe "\$listener_port" --expect-blocked/);
    expect(gateSource).toMatch(/--source-tree-sha256/);
    expect(gateSource).toMatch(
      /const lopdfOrder = compare\(process\.argv\[2\], "0\.42\.0"\)/,
    );
    expect(gateSource).toMatch(/!Number\.isFinite\(lopdfOrder\)/);
    expect(networkProbeSource).toMatch(/server\.listen\(0, '127\.0\.0\.1'/);
    expect(networkProbeSource).toMatch(/--expect-connected/);
    expect(networkProbeSource).toMatch(/--expect-blocked/);
    expect(networkProbeSource).not.toMatch(/console\.(error|log)/);
    expect(childSource).not.toMatch(/permission.*encrypted/i);
  });
});

const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describeLinux('PDF Inspector Linux containment', () => {
  it('kills hanging child at deadline', async () => {
    await expect(runControlledLinuxChild('hang', 100)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('reports signal/crash child exit', async () => {
    const result = await runControlledLinuxChild('signal');
    expect(result.exitCode).toBeNull();
    expect(result.signal).not.toBeNull();
  });

  it('kills stdout-overrun child', async () => {
    const { PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES } = await loadAdapter();
    const result = await runControlledLinuxChild('stdout');
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout.byteLength).toBeLessThanOrEqual(PDF_INSPECTOR_MAX_PROTOCOL_OUTPUT_BYTES);
  });

  it('bounds stderr flood without leaking it', async () => {
    const result = await runControlledLinuxChild('stderr');
    expect(result.exitCode).toBe(0);
    expect(result.stderr.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(result.stderr.toString()).not.toContain('synthetic');
  });

  it('blocks network probe inside namespace', async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('listener did not receive an allocated TCP port');
    }

    try {
      const hostConnected = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port: address.port });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      expect(hostConnected).toBe(true);

      const result = await runControlledLinuxChild('network', 2_000, [String(address.port)]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString('utf8'))).toEqual({
        connected: false,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
