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
  '/synthetic/zero/.private/centurion-thread-corpus/live-123e4567-e89b-12d3-a456-426614174000-allocated';
const SNAPSHOT_DIR =
  '.private/centurion-thread-corpus/live-123e4567-e89b-12d3-a456-426614174000-allocated';
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
    isIgnored: async (input: { repoRoot: string; relativePath: string }) => {
      calls.push('ignored');
      expect(input).toEqual({
        repoRoot: REPO_ROOT,
        relativePath: `.private/centurion-thread-corpus/${SNAPSHOT_ID}`,
      });
      return true;
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
      return SNAPSHOT_DIR;
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
  it('runs without protected source configuration and passes no source map to reader or exporter', async () => {
    const harness = makeHarness();

    expect(await run(harness)).toBe(0);
    expect(harness.readerOptions).toEqual({
      databaseUrl: PRIVATE_DATABASE_MARKER,
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
        event: 'centurion_thread_corpus_export.completed',
        snapshotId: SNAPSHOT_ID,
        snapshotDir: SNAPSHOT_DIR,
        summary: SAFE_SUMMARY,
      })}\n`,
    ]);
    expect(`${harness.stdout}${harness.stderr}`).not.toContain(PRIVATE_DATABASE_MARKER);
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
