import {
  createCenturionThreadCorpusLiveExportCommand,
  type LiveCenturionThreadCorpusDependencies,
} from '../scripts/export-centurion-thread-corpus-live';
import type {
  ClosableThreadCorpusReader,
  ThreadCorpusExportRequest,
  ThreadCorpusExportSafeResult,
} from '../src/ops/centurion-thread-corpus-exporter';
import type { ThreadCorpusPostgresReaderOptions } from '../src/ops/centurion-thread-corpus-postgres-reader';
import type { S3Storage } from '../src/storage/s3';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const REPO_ROOT = '/synthetic/zero';
const SCRIPT_PATH =
  '/synthetic/zero/apps/server-pilot/scripts/export-centurion-thread-corpus-live.ts';
const SNAPSHOT_ID = 'live-123e4567-e89b-12d3-a456-426614174000';
const ALLOCATED_DIR =
  '/synthetic/zero/.private/connected-mailbox-corpus/live-123e4567-e89b-12d3-a456-426614174000-allocated';
const SNAPSHOT_DIR =
  '.private/connected-mailbox-corpus/live-123e4567-e89b-12d3-a456-426614174000-allocated';
const PRIVATE_DATABASE_MARKER = 'PRIVATE_DATABASE_MARKER';
const PRIVATE_DOWNSTREAM_MARKER = 'PRIVATE_DOWNSTREAM_MARKER';

const SAFE_SUMMARY = {
  asOf: '2026-08-22T12:00:00.000Z',
  includedMessageCount: 3,
  sourceRowCount: 3,
  threadCount: 2,
} as const;

type LiveStorage = Pick<S3Storage, 'kind' | 'getObjectBounded'>;

type Harness = {
  calls: string[];
  deps: LiveCenturionThreadCorpusDependencies;
  stderr: string[];
  stdout: string[];
  readonly readerOptions: ThreadCorpusPostgresReaderOptions | undefined;
  readonly request: ThreadCorpusExportRequest | undefined;
};

function makeReader(): ClosableThreadCorpusReader {
  return {
    async withRepeatableReadOnly<T>(): Promise<T> {
      throw new Error('Unexpected reader call');
    },
    async close() {},
  };
}

function makeHarness(): Harness {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let readerOptions: ThreadCorpusPostgresReaderOptions | undefined;
  let request: ThreadCorpusExportRequest | undefined;
  const storage: LiveStorage = {
    kind: 'real',
    async getObjectBounded() {
      return null;
    },
  };
  const deps = {
    args: () => {
      calls.push('args');
      return [];
    },
    platform: () => {
      calls.push('platform');
      return 'linux';
    },
    scriptPath: () => {
      calls.push('scriptPath');
      return SCRIPT_PATH;
    },
    attestImdsV2: async () => {
      calls.push('attest');
      return true;
    },
    preflightOutputDestination: async (repoRoot: string, outDir: string) => {
      calls.push('preflight');
      expect({ repoRoot, outDir }).toEqual({
        repoRoot: REPO_ROOT,
        outDir: `${REPO_ROOT}/.private/connected-mailbox-corpus/${SNAPSHOT_ID}`,
      });
    },
    uuid: () => {
      calls.push('uuid');
      return SNAPSHOT_ID.slice('live-'.length);
    },
    environment: () => {
      calls.push('environment');
      return {
        DATABASE_URL: PRIVATE_DATABASE_MARKER,
        AWS_REGION: 'synthetic-region-1',
        S3_BUCKET: 'synthetic-private-bucket',
      };
    },
    createReader: (input: ThreadCorpusPostgresReaderOptions) => {
      calls.push('createReader');
      readerOptions = input;
      return makeReader();
    },
    createRealStorage: () => {
      calls.push('createStorage');
      return storage;
    },
    createExporter: (input: { createReader(): ClosableThreadCorpusReader }) => {
      calls.push('createExporter');
      return async (
        nextRequest: ThreadCorpusExportRequest,
      ): Promise<ThreadCorpusExportSafeResult> => {
        calls.push('export');
        request = nextRequest;
        input.createReader();
        return {
          outDir: ALLOCATED_DIR,
          summary: { ...SAFE_SUMMARY },
        } as ThreadCorpusExportSafeResult;
      };
    },
    validateAllocatedDir: () => {
      calls.push('validate');
    },
    writeStdout: (value: string) => {
      calls.push('stdout');
      stdout.push(value);
    },
    writeStderr: (value: string) => {
      calls.push('stderr');
      stderr.push(value);
    },
  } as unknown as LiveCenturionThreadCorpusDependencies;

  return {
    calls,
    deps,
    stderr,
    stdout,
    get readerOptions() {
      return readerOptions;
    },
    get request() {
      return request;
    },
  };
}

function failedLine(code: 'invalid_arguments' | 'preflight_failed' | 'export_failed'): string {
  return `${JSON.stringify({
    event: 'centurion_thread_corpus_export.failed',
    code,
  })}\n`;
}

async function run(harness: Harness): Promise<number> {
  return await createCenturionThreadCorpusLiveExportCommand(harness.deps)();
}

describe('connected mailbox live corpus export command', () => {
  it('checks the generic trusted output root before source setup', async () => {
    const harness = makeHarness();
    let preflightRequest: { repoRoot: string; outDir: string } | undefined;
    harness.deps.preflightOutputDestination = async (repoRoot, outDir) => {
      harness.calls.push('preflight');
      preflightRequest = { repoRoot, outDir };
      throw new Error('unsafe private output root');
    };

    expect(await run(harness)).toBe(1);
    expect(preflightRequest).toEqual({
      repoRoot: REPO_ROOT,
      outDir: `${REPO_ROOT}/.private/connected-mailbox-corpus/${SNAPSHOT_ID}`,
    });
    expect(harness.calls).toEqual([
      'args',
      'platform',
      'scriptPath',
      'attest',
      'uuid',
      'preflight',
      'stderr',
    ]);
  });

  it('writes only integer counts on successful stdout', async () => {
    const harness = makeHarness();

    expect(await run(harness)).toBe(0);
    expect(harness.stdout).toEqual([
      `${JSON.stringify({
        includedMessageCount: SAFE_SUMMARY.includedMessageCount,
        sourceRowCount: SAFE_SUMMARY.sourceRowCount,
        threadCount: SAFE_SUMMARY.threadCount,
      })}\n`,
    ]);
    expect(harness.stdout.join('')).not.toContain(SNAPSHOT_ID);
    expect(harness.stdout.join('')).not.toContain(SAFE_SUMMARY.asOf);
    expect(harness.stdout.join('')).not.toContain(ALLOCATED_DIR);
    expect(harness.stdout.join('')).not.toContain(SNAPSHOT_DIR);
  });

  it('runs without protected source configuration and passes no source map to reader or exporter', async () => {
    const harness = makeHarness();

    expect(await run(harness)).toBe(0);
    expect(harness.readerOptions).toEqual({
      databaseUrl: PRIVATE_DATABASE_MARKER,
      transportIds: ['transport-centurion'],
    });
    expect(harness.request).toMatchObject({
      repoRoot: REPO_ROOT,
      snapshotId: SNAPSHOT_ID,
      exporterVersion: 'connected-mailbox-corpus-live-v1',
    });
    expect(Object.keys(harness.request ?? {})).not.toContain('source');
    expect(harness.calls).not.toContain('config');
    expect(harness.stderr).toEqual([]);
    expect(harness.stdout).toEqual([
      `${JSON.stringify({
        includedMessageCount: SAFE_SUMMARY.includedMessageCount,
        sourceRowCount: SAFE_SUMMARY.sourceRowCount,
        threadCount: SAFE_SUMMARY.threadCount,
      })}\n`,
    ]);
    const output = `${harness.stdout}${harness.stderr}`;
    expect(output).not.toContain(PRIVATE_DATABASE_MARKER);
    expect(output).not.toContain(SNAPSHOT_ID);
    expect(output).not.toContain(SNAPSHOT_DIR);
    expect(output).not.toContain(ALLOCATED_DIR);
    expect(output).not.toContain(SAFE_SUMMARY.asOf);
  });

  it('contains private downstream errors behind fixed count-only failure output', async () => {
    const harness = makeHarness();
    harness.deps.createExporter = () => async () => {
      throw new Error(PRIVATE_DOWNSTREAM_MARKER);
    };

    expect(await run(harness)).toBe(1);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([failedLine('export_failed')]);
    expect(`${harness.stdout}${harness.stderr}`).not.toContain(PRIVATE_DOWNSTREAM_MARKER);
  });

  it('rejects arguments before any preflight or client creation', async () => {
    const harness = makeHarness();
    harness.deps.args = () => ['--unexpected'];

    expect(await run(harness)).toBe(1);
    expect(harness.calls).toEqual(['stderr']);
    expect(harness.stderr).toEqual([failedLine('invalid_arguments')]);
  });

  it('removes named-source configuration code from live command', () => {
    const sourcePath = fileURLToPath(
      new URL('../scripts/export-centurion-thread-corpus-live.ts', import.meta.url),
    );
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toMatch(
      /operator-config|readProtectedConfig|centurionTransportId|designatedTransportId|designatedAddresses|designatedIngestMailboxIds/i,
    );
  });
});
