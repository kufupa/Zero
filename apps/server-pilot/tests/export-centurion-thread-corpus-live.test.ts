import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  createCenturionThreadCorpusLiveExportCommand,
  directImdsRequest,
  type DirectImdsRequestDependencies,
  type LiveCenturionThreadCorpusDependencies,
  type OperatorConfig,
} from '../scripts/export-centurion-thread-corpus-live.js';
import type {
  ClosableThreadCorpusReader,
  ThreadCorpusExportDependencies,
  ThreadCorpusExportRequest,
  ThreadCorpusExportSafeResult,
} from '../src/ops/centurion-thread-corpus-exporter.js';
import type { ThreadCorpusPostgresReaderOptions } from '../src/ops/centurion-thread-corpus-postgres-reader.js';
import type { S3Storage } from '../src/storage/s3.js';

const REPO_ROOT = '/synthetic/zero';
const SCRIPT_PATH =
  '/synthetic/zero/apps/server-pilot/scripts/export-centurion-thread-corpus-live.ts';
const CORPUS_ROOT = `${REPO_ROOT}/.private/centurion-thread-corpus`;
const CONFIG_PATH = `${CORPUS_ROOT}/operator-config.json`;
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const SNAPSHOT_ID = `live-${UUID}`;
const ALLOCATED_DIR = `${CORPUS_ROOT}/${SNAPSHOT_ID}-allocated`;
const SNAPSHOT_DIR = `.private/centurion-thread-corpus/${SNAPSHOT_ID}-allocated`;
const DATABASE_URL_MARKER = 'TASK10_PRIVATE_DATABASE_URL_MARKER';
const PRIVATE_ADDRESS_MARKER = 'TASK10_PRIVATE_ADDRESS_MARKER';
const PRIVATE_CONFIG_MARKER = 'TASK10_PRIVATE_CONFIG_MARKER';
const PRIVATE_IMDS_MARKER = 'TASK10_PRIVATE_IMDS_MARKER';
const PRIVATE_PATH_MARKER = 'TASK10_PRIVATE_PATH_MARKER';
const PRIVATE_DOWNSTREAM_MARKER = 'TASK10_PRIVATE_DOWNSTREAM_MARKER';

const SAFE_SUMMARY = {
  asOf: '2026-08-22T12:00:00.000Z',
  includedMessageCount: 3,
  sourceRowCount: 4,
  threadCount: 2,
  quarantineRecordCount: 1,
  unscopedQuarantineCount: 0,
} as const;

type LiveStorage = Pick<S3Storage, 'kind' | 'getObjectBounded'>;

type Harness = {
  calls: string[];
  deps: LiveCenturionThreadCorpusDependencies;
  stderr: string[];
  stdout: string[];
  readonly exporterDependencies: Pick<ThreadCorpusExportDependencies, 'createReader'> | undefined;
  readonly readerCloseCalls: number;
  readonly readerOptions: ThreadCorpusPostgresReaderOptions | undefined;
  readonly request: ThreadCorpusExportRequest | undefined;
  readonly storage: LiveStorage;
  readonly storageReceiver: unknown;
};

function operatorConfig(input: {
  source?: Partial<OperatorConfig['source']>;
  root?: Record<string, unknown>;
} = {}): OperatorConfig {
  return {
    version: 1,
    source: {
      centurionTransportId: 'transport-centurion',
      designatedTransportId: 'transport-reservationist',
      designatedIngestMailboxIds: ['mailbox-reservationist'],
      designatedAddresses: [PRIVATE_ADDRESS_MARKER],
      ...input.source,
    },
    ...input.root,
  } as OperatorConfig;
}

function configText(value: unknown = operatorConfig()): string {
  return JSON.stringify(value);
}

function failedLine(code: 'invalid_arguments' | 'preflight_failed' | 'export_failed'): string {
  return `${JSON.stringify({
    event: 'centurion_thread_corpus_export.failed',
    code,
  })}\n`;
}

function makeReader(onClose: () => void): ClosableThreadCorpusReader {
  return {
    async withRepeatableReadOnly<T>(): Promise<T> {
      throw new Error('Unexpected reader use in Task 10 command test');
    },
    async close(): Promise<void> {
      onClose();
    },
  };
}

function makeHarness(): Harness {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let readerOptions: ThreadCorpusPostgresReaderOptions | undefined;
  let readerCloseCalls = 0;
  let exporterDependencies: Pick<ThreadCorpusExportDependencies, 'createReader'> | undefined;
  let request: ThreadCorpusExportRequest | undefined;
  let storageReceiver: unknown;
  const reader = makeReader(() => {
    readerCloseCalls += 1;
    calls.push('reader.close');
  });
  const storage: LiveStorage = {
    kind: 'real',
    async getObjectBounded() {
      storageReceiver = this;
      return null;
    },
  };
  const deps: LiveCenturionThreadCorpusDependencies = {
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
    readProtectedConfig: async (input) => {
      calls.push('config');
      expect(input).toEqual({
        repoRoot: REPO_ROOT,
        corpusRoot: CORPUS_ROOT,
        configPath: CONFIG_PATH,
      });
      return configText();
    },
    isIgnored: async (input) => {
      calls.push('ignored');
      expect(input).toEqual({
        repoRoot: REPO_ROOT,
        relativePath: `.private/centurion-thread-corpus/${SNAPSHOT_ID}`,
      });
      return true;
    },
    uuid: () => {
      calls.push('uuid');
      return UUID;
    },
    environment: () => {
      calls.push('environment');
      return {
        DATABASE_URL: DATABASE_URL_MARKER,
        AWS_REGION: 'synthetic-region-1',
        S3_BUCKET: 'synthetic-private-bucket',
      };
    },
    createReader: (input) => {
      calls.push('createReader');
      readerOptions = input;
      return reader;
    },
    createRealStorage: (input) => {
      calls.push('createStorage');
      expect(input).toEqual({
        region: 'synthetic-region-1',
        bucket: 'synthetic-private-bucket',
      });
      return storage;
    },
    createExporter: (input) => {
      calls.push('createExporter');
      exporterDependencies = input;
      return async (nextRequest) => {
        calls.push('export');
        request = nextRequest;
        input.createReader();
        return {
          outDir: ALLOCATED_DIR,
          summary: { ...SAFE_SUMMARY },
        };
      };
    },
    validateAllocatedDir: (input) => {
      calls.push('validate');
      expect(input).toEqual({
        repoRoot: REPO_ROOT,
        corpusRoot: CORPUS_ROOT,
        snapshotId: SNAPSHOT_ID,
        outDir: ALLOCATED_DIR,
      });
      return SNAPSHOT_DIR;
    },
    writeStdout: (value) => {
      calls.push('stdout');
      stdout.push(value);
    },
    writeStderr: (value) => {
      calls.push('stderr');
      stderr.push(value);
    },
  };

  return {
    calls,
    deps,
    stderr,
    stdout,
    get exporterDependencies() {
      return exporterDependencies;
    },
    get readerCloseCalls() {
      return readerCloseCalls;
    },
    get readerOptions() {
      return readerOptions;
    },
    get request() {
      return request;
    },
    storage,
    get storageReceiver() {
      return storageReceiver;
    },
  };
}

async function run(harness: Harness): Promise<number> {
  return await createCenturionThreadCorpusLiveExportCommand(harness.deps)();
}

async function expectFailure(
  harness: Harness,
  code: 'invalid_arguments' | 'preflight_failed' | 'export_failed',
): Promise<void> {
  expect(await run(harness)).toBe(1);
  expect(harness.stdout).toEqual([]);
  expect(harness.stderr).toEqual([failedLine(code)]);
}

function expectNoPrivateOutput(harness: Harness, markers: readonly string[]): void {
  const visible = `${harness.stdout.join('')}${harness.stderr.join('')}`;
  for (const marker of markers) expect(visible).not.toContain(marker);
}

function expectNoClients(harness: Harness): void {
  expect(harness.calls).not.toContain('createReader');
  expect(harness.calls).not.toContain('createStorage');
  expect(harness.calls).not.toContain('createExporter');
  expect(harness.calls).not.toContain('export');
}

describe('export-centurion-thread-corpus-live command', () => {
  it('rejects every positional argument or flag before config, environment, IDs, clients, or output', async () => {
    const harness = makeHarness();
    harness.deps.args = () => {
      harness.calls.push('args');
      return ['--unexpected'];
    };

    await expectFailure(harness, 'invalid_arguments');

    expect(harness.calls).toEqual(['args', 'stderr']);
    expectNoClients(harness);
  });

  it.each([
    {
      name: 'nonapproved instance ID',
      configure: (harness: Harness) => {
        harness.deps.attestImdsV2 = async () => {
          harness.calls.push('attest');
          return false;
        };
      },
      expectsAttest: true,
    },
    {
      name: 'unavailable metadata response',
      configure: (harness: Harness) => {
        harness.deps.attestImdsV2 = async () => {
          harness.calls.push('attest');
          throw new Error(PRIVATE_IMDS_MARKER);
        };
      },
      expectsAttest: true,
    },
    {
      name: 'non-Linux host',
      configure: (harness: Harness) => {
        harness.deps.platform = () => {
          harness.calls.push('platform');
          return 'win32';
        };
      },
      expectsAttest: false,
    },
  ])('fails preflight for $name before config, environment, or clients', async ({ configure, expectsAttest }) => {
    const harness = makeHarness();
    configure(harness);

    await expectFailure(harness, 'preflight_failed');

    expect(harness.calls.includes('attest')).toBe(expectsAttest);
    expect(harness.calls).not.toContain('config');
    expect(harness.calls).not.toContain('uuid');
    expect(harness.calls).not.toContain('ignored');
    expect(harness.calls).not.toContain('environment');
    expectNoClients(harness);
    expectNoPrivateOutput(harness, [PRIVATE_IMDS_MARKER]);
  });

  it.each([
    {
      name: 'symlink leaf',
      config: async () => {
        throw new Error(`${PRIVATE_CONFIG_MARKER}:symlink`);
      },
    },
    {
      name: 'nonregular leaf',
      config: async () => {
        throw new Error(`${PRIVATE_CONFIG_MARKER}:nonregular`);
      },
    },
    {
      name: 'untrusted parent owner',
      config: async () => {
        throw new Error(`${PRIVATE_CONFIG_MARKER}:parent-owner`);
      },
    },
    {
      name: 'group-writable parent',
      config: async () => {
        throw new Error(`${PRIVATE_CONFIG_MARKER}:parent-mode`);
      },
    },
    {
      name: 'leaf permissions',
      config: async () => {
        throw new Error(`${PRIVATE_CONFIG_MARKER}:leaf-mode`);
      },
    },
    {
      name: 'descriptor identity mismatch',
      config: async () => {
        throw new Error(`${PRIVATE_CONFIG_MARKER}:inode-mismatch`);
      },
    },
    {
      name: 'malformed JSON',
      config: async () => '{ malformed',
    },
    {
      name: 'unknown root key',
      config: async () =>
        configText({
          ...operatorConfig(),
          unexpected: PRIVATE_CONFIG_MARKER,
        }),
    },
    {
      name: 'unknown source key',
      config: async () =>
        configText({
          version: 1,
          source: {
            ...operatorConfig().source,
            storage: PRIVATE_CONFIG_MARKER,
          },
        }),
    },
  ])('fails protected-config preflight for $name without leaking config detail', async ({ config }) => {
    const harness = makeHarness();
    harness.deps.readProtectedConfig = async (input) => {
      harness.calls.push('config');
      expect(input.configPath).toBe(CONFIG_PATH);
      return await config();
    };

    await expectFailure(harness, 'preflight_failed');

    expect(harness.calls).toContain('config');
    expect(harness.calls).not.toContain('uuid');
    expect(harness.calls).not.toContain('ignored');
    expect(harness.calls).not.toContain('environment');
    expectNoClients(harness);
    expectNoPrivateOutput(harness, [PRIVATE_CONFIG_MARKER]);
  });

  it.each([
    ['missing DATABASE_URL', { AWS_REGION: 'synthetic-region-1', S3_BUCKET: 'synthetic-private-bucket' }],
    [
      'blank DATABASE_URL',
      {
        DATABASE_URL: '   ',
        AWS_REGION: 'synthetic-region-1',
        S3_BUCKET: 'synthetic-private-bucket',
      },
    ],
    [
      'missing AWS_REGION',
      { DATABASE_URL: DATABASE_URL_MARKER, S3_BUCKET: 'synthetic-private-bucket' },
    ],
    [
      'blank AWS_REGION',
      {
        DATABASE_URL: DATABASE_URL_MARKER,
        AWS_REGION: ' ',
        S3_BUCKET: 'synthetic-private-bucket',
      },
    ],
    [
      'missing S3_BUCKET',
      { DATABASE_URL: DATABASE_URL_MARKER, AWS_REGION: 'synthetic-region-1' },
    ],
    [
      'blank S3_BUCKET',
      {
        DATABASE_URL: DATABASE_URL_MARKER,
        AWS_REGION: 'synthetic-region-1',
        S3_BUCKET: '\t',
      },
    ],
  ])('fails preflight for %s before reader, storage, or exporter', async (_name, environment) => {
    const harness = makeHarness();
    harness.deps.environment = () => {
      harness.calls.push('environment');
      return environment;
    };

    await expectFailure(harness, 'preflight_failed');

    expect(harness.calls).toContain('uuid');
    expect(harness.calls).toContain('ignored');
    expect(harness.calls).toContain('environment');
    expectNoClients(harness);
    expectNoPrivateOutput(harness, [DATABASE_URL_MARKER]);
  });

  it('fails an unignored destination before environment or external client construction', async () => {
    const harness = makeHarness();
    harness.deps.isIgnored = async () => {
      harness.calls.push('ignored');
      return false;
    };

    await expectFailure(harness, 'preflight_failed');

    expect(harness.calls).toContain('uuid');
    expect(harness.calls).not.toContain('environment');
    expectNoClients(harness);
  });

  it('fails a malformed UUID before ignored-destination, environment, or clients', async () => {
    const harness = makeHarness();
    harness.deps.uuid = () => {
      harness.calls.push('uuid');
      return PRIVATE_CONFIG_MARKER;
    };

    await expectFailure(harness, 'preflight_failed');

    expect(harness.calls).not.toContain('ignored');
    expect(harness.calls).not.toContain('environment');
    expectNoClients(harness);
    expectNoPrivateOutput(harness, [PRIVATE_CONFIG_MARKER]);
  });

  it('passes exact source only to reader factory and uses a frozen read-only storage facade', async () => {
    const harness = makeHarness();
    const configured = operatorConfig();

    expect(await run(harness)).toBe(0);

    expect(harness.readerOptions).toEqual({
      databaseUrl: DATABASE_URL_MARKER,
      ...configured.source,
    });
    expect(harness.exporterDependencies).toBeDefined();
    expect(Object.keys(harness.exporterDependencies ?? {})).toEqual(['createReader']);
    expect(harness.readerCloseCalls).toBe(0);
    expect(harness.request).toMatchObject({
      repoRoot: REPO_ROOT,
      outDir: `${CORPUS_ROOT}/${SNAPSHOT_ID}`,
      snapshotId: SNAPSHOT_ID,
      exporterVersion: 'centurion-thread-corpus-live-v1',
      source: configured.source,
    });
    expect(Object.keys(harness.request?.hydration ?? {})).toEqual(['storage']);
    const storage = harness.request?.hydration.storage;
    expect(Object.isFrozen(storage)).toBe(true);
    expect(Object.keys(storage ?? {})).toEqual(['getObjectBounded']);
    await storage?.getObjectBounded('raw-mime/synthetic', 1);
    expect(harness.storageReceiver).toBe(harness.storage);
    expect(harness.calls.filter((call) => call === 'export')).toHaveLength(1);
  });

  it('rejects non-real storage before creating Task 9 exporter', async () => {
    const harness = makeHarness();
    harness.deps.createRealStorage = () => {
      harness.calls.push('createStorage');
      return {
        kind: 'fake',
        async getObjectBounded() {
          return null;
        },
      };
    };

    await expectFailure(harness, 'preflight_failed');

    expect(harness.calls).toContain('createStorage');
    expect(harness.calls).not.toContain('createExporter');
    expect(harness.calls).not.toContain('export');
  });

  it.each([
    {
      name: 'storage override',
      value: {
        ...operatorConfig(),
        storage: { kind: 'fake' },
      },
    },
    {
      name: 'hydration override',
      value: {
        ...operatorConfig(),
        hydration: { maxRawMimeBytes: 1 },
      },
    },
  ])('rejects poisoned $name config before clients', async ({ value }) => {
    const harness = makeHarness();
    harness.deps.readProtectedConfig = async () => {
      harness.calls.push('config');
      return configText(value);
    };

    await expectFailure(harness, 'preflight_failed');

    expectNoClients(harness);
  });

  it.each([
    ['outside directory', '/synthetic/outside/live-123e4567-e89b-12d3-a456-426614174000-allocated'],
    ['wrong corpus parent', '/synthetic/zero/.private/wrong/live-123e4567-e89b-12d3-a456-426614174000-allocated'],
    ['wrong prefix', `${CORPUS_ROOT}/other-allocated`],
    ['traversal spelling', `${CORPUS_ROOT}/../escape/${SNAPSHOT_ID}-allocated`],
    ['Windows separator spelling', `.private\\centurion-thread-corpus\\${SNAPSHOT_ID}-allocated`],
  ])('maps invalid allocated Task 7 result (%s) to safe export failure', async (_name, poisonedOutDir) => {
    const harness = makeHarness();
    harness.deps.createExporter = (dependencies) => {
      harness.calls.push('createExporter');
      return async (_request) => {
        harness.calls.push('export');
        dependencies.createReader();
        return {
          outDir: poisonedOutDir,
          summary: { ...SAFE_SUMMARY },
        };
      };
    };
    harness.deps.validateAllocatedDir = (input) => {
      harness.calls.push('validate');
      expect(input.outDir).toBe(poisonedOutDir);
      throw new Error(`${PRIVATE_PATH_MARKER}:${poisonedOutDir}`);
    };

    await expectFailure(harness, 'export_failed');

    expect(harness.calls).toContain('validate');
    expectNoPrivateOutput(harness, [PRIVATE_PATH_MARKER, poisonedOutDir]);
  });

  it('writes one exact safe success JSON object with a cloned six-field summary', async () => {
    const harness = makeHarness();

    expect(await run(harness)).toBe(0);

    const expected = {
      event: 'centurion_thread_corpus_export.completed',
      snapshotId: SNAPSHOT_ID,
      snapshotDir: SNAPSHOT_DIR,
      summary: { ...SAFE_SUMMARY },
    };
    expect(harness.stderr).toEqual([]);
    expect(harness.stdout).toEqual([`${JSON.stringify(expected)}\n`]);
    const rendered = JSON.parse(harness.stdout[0]!) as Record<string, unknown>;
    expect(Object.keys(rendered)).toEqual(['event', 'snapshotId', 'snapshotDir', 'summary']);
    expect(Object.keys(rendered.summary as Record<string, unknown>).sort()).toEqual([
      'asOf',
      'includedMessageCount',
      'quarantineRecordCount',
      'sourceRowCount',
      'threadCount',
      'unscopedQuarantineCount',
    ]);
    expect(rendered.snapshotDir).toBe(SNAPSHOT_DIR);
    expect(String(rendered.snapshotDir)).not.toContain('\\');
    expectNoPrivateOutput(harness, [
      DATABASE_URL_MARKER,
      PRIVATE_ADDRESS_MARKER,
      PRIVATE_CONFIG_MARKER,
    ]);
  });

  it('rejects exporter results with unsafe summary fields before output', async () => {
    const harness = makeHarness();
    harness.deps.createExporter = (dependencies) => {
      harness.calls.push('createExporter');
      return async (_request): Promise<ThreadCorpusExportSafeResult> => {
        harness.calls.push('export');
        dependencies.createReader();
        return {
          outDir: ALLOCATED_DIR,
          summary: {
            ...SAFE_SUMMARY,
            privateMarker: PRIVATE_DOWNSTREAM_MARKER,
          } as unknown as ThreadCorpusExportSafeResult['summary'],
        };
      };
    };

    await expectFailure(harness, 'export_failed');

    expect(harness.calls).not.toContain('validate');
    expectNoPrivateOutput(harness, [PRIVATE_DOWNSTREAM_MARKER]);
  });

  it('rejects a noncanonical summary asOf without leaking private text', async () => {
    const harness = makeHarness();
    harness.deps.createExporter = (dependencies) => {
      harness.calls.push('createExporter');
      return async (): Promise<ThreadCorpusExportSafeResult> => {
        harness.calls.push('export');
        dependencies.createReader();
        return {
          outDir: ALLOCATED_DIR,
          summary: {
            ...SAFE_SUMMARY,
            asOf: PRIVATE_DOWNSTREAM_MARKER,
          },
        };
      };
    };

    await expectFailure(harness, 'export_failed');

    expect(harness.calls).not.toContain('validate');
    expectNoPrivateOutput(harness, [PRIVATE_DOWNSTREAM_MARKER]);
  });

  it('emits only fixed export-failed JSON when downstream errors contain private text', async () => {
    const harness = makeHarness();
    harness.deps.createExporter = () => {
      harness.calls.push('createExporter');
      return async () => {
        harness.calls.push('export');
        throw new Error(PRIVATE_DOWNSTREAM_MARKER);
      };
    };

    await expectFailure(harness, 'export_failed');

    expectNoPrivateOutput(harness, [PRIVATE_DOWNSTREAM_MARKER]);
  });
});

function makeImdsErrorHarness(): {
  dependencies: DirectImdsRequestDependencies;
  emitRequestError(): void;
  emitResponseError(): void;
  readonly cleared: number;
  readonly destroyed: number;
} {
  const timer = {};
  let cleared = 0;
  let destroyed = 0;
  let respond: (() => void) | undefined;
  let requestError: (() => void) | undefined;
  let responseError: (() => void) | undefined;
  const response = {
    statusCode: 200,
    resume() {},
    on(event: string, listener: () => void) {
      if (event === 'error') responseError = listener;
      return response;
    },
  };
  const request = {
    on(event: string, listener: () => void) {
      if (event === 'error') requestError = listener;
      return request;
    },
    setTimeout() {
      return request;
    },
    end() {
      return request;
    },
    destroy() {
      destroyed += 1;
      return request;
    },
  };
  return {
    dependencies: {
      request: (_options, onResponse) => {
        respond = () => onResponse(response as never);
        return request as never;
      },
      setTimeout: () => timer,
      clearTimeout: (value) => {
        expect(value).toBe(timer);
        cleared += 1;
      },
    },
    emitRequestError() {
      requestError?.();
    },
    emitResponseError() {
      respond?.();
      responseError?.();
    },
    get cleared() {
      return cleared;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

describe('direct IMDS request deadline', () => {
  it('destroys and clears deadline after a response error', async () => {
    const harness = makeImdsErrorHarness();
    const pending = directImdsRequest('GET', '/synthetic', {}, harness.dependencies);

    harness.emitResponseError();

    await expect(pending).resolves.toBeNull();
    expect(harness.destroyed).toBe(1);
    expect(harness.cleared).toBe(1);
  });

  it('destroys and clears deadline after a request error', async () => {
    const harness = makeImdsErrorHarness();
    const pending = directImdsRequest('GET', '/synthetic', {}, harness.dependencies);

    harness.emitRequestError();

    await expect(pending).resolves.toBeNull();
    expect(harness.destroyed).toBe(1);
    expect(harness.cleared).toBe(1);
  });

  it('destroys a non-200 response that never ends before clearing its deadline', async () => {
    const timer = {};
    let respond: (() => void) | undefined;
    let cleared = 0;
    let destroyed = 0;
    let resumed = 0;
    const response = {
      statusCode: 503,
      resume() {
        resumed += 1;
      },
      on() {
        return response;
      },
    };
    const request = {
      on() {
        return request;
      },
      setTimeout() {
        return request;
      },
      end() {
        return request;
      },
      destroy() {
        destroyed += 1;
        return request;
      },
    };
    const dependencies: DirectImdsRequestDependencies = {
      request: (_options, onResponse) => {
        respond = () => onResponse(response as never);
        return request as never;
      },
      setTimeout: () => timer,
      clearTimeout: (value) => {
        expect(value).toBe(timer);
        cleared += 1;
      },
    };

    const pending = directImdsRequest('GET', '/synthetic', {}, dependencies);
    respond?.();

    await expect(pending).resolves.toBeNull();
    expect(resumed).toBe(1);
    expect(destroyed).toBe(1);
    expect(cleared).toBe(1);
  });

  it('ends a slow-drip response at the absolute one-second deadline', async () => {
    const events: string[] = [];
    const timer = {};
    let absoluteDeadline: (() => void) | undefined;
    let dataListener: ((chunk: Buffer | string) => void) | undefined;
    let destroyed = 0;
    let cleared = 0;
    const response = {
      statusCode: 200,
      resume() {},
      on(event: string, listener: (chunk?: Buffer | string) => void) {
        if (event === 'data') dataListener = listener as (chunk: Buffer | string) => void;
        return response;
      },
    };
    const request = {
      on() {
        return request;
      },
      setTimeout() {
        return request;
      },
      end() {
        return request;
      },
      destroy() {
        destroyed += 1;
        return request;
      },
    };
    const dependencies: DirectImdsRequestDependencies = {
      request: (_options, onResponse) => {
        events.push('request');
        onResponse(response as never);
        return request as never;
      },
      setTimeout: (callback, milliseconds) => {
        events.push('deadline');
        expect(milliseconds).toBe(1_000);
        absoluteDeadline = callback;
        return timer;
      },
      clearTimeout: (value) => {
        expect(value).toBe(timer);
        cleared += 1;
      },
    };

    const pending = directImdsRequest('GET', '/synthetic', {}, dependencies);
    expect(events).toEqual(['deadline', 'request']);
    dataListener?.('a');
    dataListener?.('b');
    absoluteDeadline?.();

    await expect(pending).resolves.toBeNull();
    expect(destroyed).toBe(1);
    expect(cleared).toBe(1);
  });
});

function liveCliSourceGuardViolations(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'export-centurion-thread-corpus-live.ts',
    source,
    ts.ScriptTarget.ESNext,
    true,
  );
  const violations: string[] = [];
  const outputWriterNames = new Set(['writeStdout', 'writeStderr']);
  const forbiddenS3Members = new Set(['putObject', 'copyObject', 'deleteObject', 'removeObject']);
  const textOf = (node: ts.Expression | undefined): string | null =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const propertyName = (
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): string | null => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    return textOf(node.argumentExpression);
  };
  const callName = (node: ts.CallExpression): string | null => {
    if (ts.isIdentifier(node.expression)) return node.expression.text;
    if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
    return null;
  };
  const isUnsafeOutputArgument = (node: ts.Expression): boolean => {
    if (ts.isTemplateExpression(node)) return true;
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return true;
    if (ts.isBinaryExpression(node)) {
      return (
        isUnsafeOutputArgument(node.left) ||
        (node.right.kind !== ts.SyntaxKind.StringLiteral &&
          node.right.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral)
      );
    }
    return false;
  };
  const isFixedGitIgnore = (node: ts.CallExpression): boolean => {
    if (callName(node) !== 'spawnSync') return false;
    if (textOf(node.arguments[0]) !== 'git') return false;
    const argv = node.arguments[1];
    if (!argv || !ts.isArrayLiteralExpression(argv) || argv.elements.length !== 4) return false;
    return (
      textOf(argv.elements[0] as ts.Expression) === 'check-ignore' &&
      textOf(argv.elements[1] as ts.Expression) === '-q' &&
      textOf(argv.elements[2] as ts.Expression) === '--no-index'
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text.toLowerCase();
      if (
        specifier.includes('dotenv') ||
        specifier.includes('ssm') ||
        specifier.includes('deploy') ||
        specifier.includes('vitest') ||
        specifier.includes('jest')
      ) {
        violations.push(`prohibited import: ${specifier}`);
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text.toLowerCase();
      if (
        text.includes('.env') ||
        text.includes('dotenv') ||
        text.includes('ssm') ||
        text.includes('deploy') ||
        text === 'vitest' ||
        text === 'jest' ||
        text === 'mocha'
      ) {
        violations.push(`prohibited literal: ${text}`);
      }
    }
    if (ts.isIdentifier(node)) {
      if (node.text === 'console' || node.text === 'getS3Storage') {
        violations.push(`prohibited capability: ${node.text}`);
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = propertyName(node);
      if (name && forbiddenS3Members.has(name)) {
        violations.push(`S3 write capability: ${name}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (name === 'spawnSync' && !isFixedGitIgnore(node)) {
        violations.push('unapproved child-process invocation');
      }
      if (
        name &&
        outputWriterNames.has(name) &&
        node.arguments[0] &&
        isUnsafeOutputArgument(node.arguments[0])
      ) {
        violations.push('interpolated output is prohibited');
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'write' &&
        node.expression.expression.getText(sourceFile).includes('console')
      ) {
        violations.push('console output is prohibited');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('export-centurion-thread-corpus-live source boundary', () => {
  it('contains required attestation, protected-config, destination, and read-only S3 guards', () => {
    const sourcePath = fileURLToPath(
      new URL('../scripts/export-centurion-thread-corpus-live.ts', import.meta.url),
    );
    const source = readFileSync(sourcePath, 'utf8');

    expect(liveCliSourceGuardViolations(source)).toEqual([]);
    expect(source).toContain('i-008f737974a9ba9b3');
    expect(source).toContain('169.254.169.254');
    expect(source).toContain('agent: false');
    expect(source).toContain('O_NOFOLLOW');
    expect(source).toContain('lstatSync');
    expect(source).toContain('fstatSync');
    expect(source).toContain('realpathSync');
    expect(source).toContain('check-ignore');
    expect(source).toContain('--no-index');
    expect(source).toContain('new RealS3Storage');
    expect(source).toContain('Object.freeze');
    expect(source).toContain('preOpen.dev');
    expect(source).toContain('preOpen.ino');
    expect(source).not.toContain('getS3Storage');
  });

  it.each([
    "import 'dotenv/config';",
    "import { SSMClient } from '@aws-sdk/client-ssm';",
    "import { deploy } from './deploy.js';",
    "spawnSync('pnpm', ['exec', 'vitest', 'run']);",
    "spawnSync('git', ['status']);",
    "readFileSync('.env.production', 'utf8');",
    "console.log('synthetic');",
    'writeStdout(`address ${address}`);',
    'getS3Storage();',
    'storage.putObject({});',
    'storage.copyObject({});',
    'storage.deleteObject({});',
    'storage.removeObject({});',
  ])('rejects prohibited live capability: %s', (fixture) => {
    expect(liveCliSourceGuardViolations(fixture)).not.toEqual([]);
  });
});
