import {
  createTriageQualityExportCommand,
  createTriageQualityExporter,
  createTriageQualityPostgresReader,
} from '../scripts/export-centurion-triage-quality';
import {
  createPrivateInputReader,
  createPrivateOutputWriter,
  prepareExistingTrustedPrivateOutputRoot,
  prepareTrustedPrivateOutputRoot,
} from '../src/ops/private-output';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const AS_OF = '2026-08-25T10:00:00.000Z';
const CREATED_AT = new Date('2026-08-25T09:00:00.000Z');
const PRIVATE_MARKER = 'SYNTHETIC_PRIVATE_BODY_MARKER';
const privateOutputWindowsAclTestOptions =
  process.platform === 'win32'
    ? {
        windowsPrivateAclEnforcer: async () => undefined,
      }
    : {};

type FixtureMessage = {
  id: string;
  transportId: string;
  threadId: string;
  threadTransportId: string;
  from: string;
  subject?: string;
  body: string;
  direction: 'inbound' | 'outbound';
  createdAt: Date;
  receivedAt: Date | null;
  sentAt: Date | null;
};

function label(triggerMessageId: string) {
  return {
    triggerMessageId,
    asOf: '2026-08-25T09:00:00.000Z',
    asOfSource: 'message-created-at' as const,
    expectedCategory: 'ops' as const,
    expectedUrgent: false,
    evidenceScope: 'text-visible' as const,
    adjudication: 'locked' as const,
    policyReason: 'synthetic test label',
    tags: ['integration'] as const,
  };
}

function message(overrides: Partial<FixtureMessage> = {}): FixtureMessage {
  return {
    id: 'in-a',
    transportId: 'transport-a',
    threadId: 'thread-a',
    threadTransportId: 'transport-a',
    from: 'synthetic sender',
    subject: 'synthetic subject',
    body: PRIVATE_MARKER,
    direction: 'inbound',
    createdAt: CREATED_AT,
    receivedAt: CREATED_AT,
    sentAt: null,
    ...overrides,
  };
}

type ReaderFixture = {
  asOf?: string;
  activeTransportIds?: string[];
  explicitTransportIds?: readonly string[];
  triggers?: FixtureMessage[];
  messagesByThread?: Map<string, FixtureMessage[]>;
  allMessages?: FixtureMessage[];
  normalRunAsOfByTrigger?: Map<string, string>;
};

function withExplicitTransportIds(
  argv: readonly string[],
  transportIds: readonly string[] = ['transport-a'],
): string[] {
  return [...argv, ...transportIds.flatMap((id) => ['--transport-id', id])];
}

function scopedTransportIds(fixture: ReaderFixture): string[] {
  const requested =
    fixture.explicitTransportIds && fixture.explicitTransportIds.length > 0
      ? [...fixture.explicitTransportIds]
      : (fixture.activeTransportIds ?? ['transport-a']);
  return [...new Set(requested.map((id) => id.trim()).filter(Boolean))].sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
}

function createReaderFixture(fixture: ReaderFixture = {}) {
  const calls: string[] = [];
  const session = {
    asOf: fixture.asOf ?? AS_OF,
    async discoverActiveTransportScope() {
      calls.push('scope');
      const transportIds = scopedTransportIds(fixture);
      if (transportIds.length === 0) {
        throw new Error('Active transport scope is empty');
      }
      const active = new Set(fixture.activeTransportIds ?? ['transport-a']);
      for (const id of transportIds) {
        if (!active.has(id)) {
          throw new Error('Quality export target is not active');
        }
      }
      return {
        asOf: fixture.asOf ?? AS_OF,
        transportIds,
      };
    },
    async loadTriggers(ids: readonly string[]) {
      calls.push(`triggers:${ids.join(',')}`);
      return fixture.triggers ?? [message()];
    },
    async loadThreadMessages(transportId: string, threadId: string) {
      calls.push(`thread:${transportId}:${threadId}`);
      return fixture.messagesByThread?.get(`${transportId}\0${threadId}`) ?? [message()];
    },
    async loadNormalRunAsOfByTrigger(ids: readonly string[]) {
      calls.push(`runs:${ids.join(',')}`);
      return fixture.normalRunAsOfByTrigger ?? new Map();
    },
    async loadAllMessages() {
      calls.push('all');
      const allowed = new Set(scopedTransportIds(fixture));
      return (fixture.allMessages ?? [message()]).filter((row) => allowed.has(row.transportId));
    },
  };

  return {
    calls,
    reader: {
      async withRepeatableReadOnly<T>(load: (next: typeof session) => Promise<T>): Promise<T> {
        calls.push('snapshot');
        return await load(session);
      },
      async close() {
        calls.push('close');
      },
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

function createHarness(fixture: ReaderFixture = {}, input = `${JSON.stringify(label('in-a'))}\n`) {
  const fixtureState: ReaderFixture = { ...fixture };
  const { calls, reader } = createReaderFixture(fixtureState);
  const inputReads: string[] = [];
  const writes: Array<{ name: string; content: string | Uint8Array }> = [];
  const inputPreflights: Array<{
    repoRoot: string;
    privateDirectoryName: string;
    allowedExtensions: readonly string[];
  }> = [];
  const outputPreflights: Array<{
    repoRoot: string;
    privateDirectoryName: string;
    allowedExtensions: readonly string[];
  }> = [];

  return {
    calls,
    inputReads,
    writes,
    inputPreflights,
    outputPreflights,
    exporter: createTriageQualityExporter({
      repoRoot: () => '/synthetic/zero',
      databaseUrl: () => 'postgres://synthetic.invalid/zero',
      preflightInputRoot: async (config) => {
        inputPreflights.push(config);
      },
      preflightOutputRoot: async (config) => {
        outputPreflights.push(config);
      },
      createReader: (options) => {
        fixtureState.explicitTransportIds = options.explicitTransportIds;
        return reader;
      },
      createPrivateInputReader: () => ({
        async read(name: string) {
          inputReads.push(name);
          return input;
        },
      }),
      createPrivateOutputWriter: () => ({
        async write(name: string, content: string | Uint8Array) {
          writes.push({ name, content });
          return `/synthetic/zero/.private/connected-mailbox-corpus/${name}`;
        },
      }),
    }),
  };
}

function privateOutputRows(harness: Harness): Array<Record<string, unknown>> {
  const payload = harness.writes[0]?.content;
  expect(typeof payload).toBe('string');
  return String(payload)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function withTemporaryRepo<T>(run: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'triage-quality-export-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.private/connected-mailbox-corpus/\n', 'utf8');
    return await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

describe('active connected-mailbox triage quality exporter', () => {
  it('rejects unsafe output before private-root, reader, snapshot, input, or writer setup', async () => {
    const { calls, reader } = createReaderFixture();
    const sideEffects: string[] = [];
    const exporter = createTriageQualityExporter({
      repoRoot: () => '/synthetic/zero',
      databaseUrl: () => {
        sideEffects.push('database-url');
        return 'postgres://synthetic.invalid/zero';
      },
      preflightInputRoot: async () => {
        sideEffects.push('input-preflight');
      },
      preflightOutputRoot: async () => {
        sideEffects.push('output-preflight');
      },
      createReader: () => {
        sideEffects.push('reader');
        return reader;
      },
      createPrivateInputReader: () => {
        sideEffects.push('input-reader');
        return {
          async read() {
            sideEffects.push('input-read');
            return '';
          },
        };
      },
      createPrivateOutputWriter: () => {
        sideEffects.push('output-writer');
        return {
          async write() {
            sideEffects.push('output-write');
            return '';
          },
        };
      },
    });

    await expect(
      exporter(
        withExplicitTransportIds(['--all-inbound-triggers', '--out', '../outside.jsonl']),
      ),
    ).rejects.toThrow(/private output name is invalid/i);

    expect(sideEffects).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('fails closed when transport ids are omitted', async () => {
    const harness = createHarness({ activeTransportIds: ['transport-a'] });

    await expect(
      harness.exporter(['--labels', 'labels.jsonl', '--out', 'cases.jsonl']),
    ).rejects.toThrow(/transport-id|transport scope/i);

    expect(harness.calls).toEqual([]);
    expect(harness.inputReads).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('explicit transport-a scope excludes transport-b in all-inbound export', async () => {
    const first = message();
    const second = message({
      id: 'in-b',
      transportId: 'transport-b',
      threadId: 'thread-b',
      threadTransportId: 'transport-b',
    });
    const harness = createHarness({
      activeTransportIds: ['transport-a', 'transport-b'],
      allMessages: [first, second],
    });

    const result = await harness.exporter(
      withExplicitTransportIds(['--all-inbound-triggers', '--out', 'cases.jsonl'], ['transport-a']),
    );

    expect(result).toEqual({ mode: 'all-inbound-triggers', count: 1, transportCount: 1 });
    expect(privateOutputRows(harness).map((row) => row.transportId)).toEqual(['transport-a']);
  });

  it('fails empty active scope before reading raw inputs or publishing output', async () => {
    const harness = createHarness({ activeTransportIds: [] });

    await expect(
      harness.exporter(
        withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl'], [
          'transport-a',
        ]),
      ),
    ).rejects.toThrow(/active transport scope|not active/i);

    expect(harness.inputReads).toEqual([]);
    expect(harness.writes).toEqual([]);
    expect(harness.calls).toEqual(['snapshot', 'scope', 'close']);
  });

  it('rejects inactive label targets without publishing output', async () => {
    const harness = createHarness({
      activeTransportIds: ['transport-a'],
      triggers: [
        message({ transportId: 'transport-inactive', threadTransportId: 'transport-inactive' }),
      ],
    });

    await expect(
      harness.exporter(
        withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl']),
      ),
    ).rejects.toThrow(/not active/i);

    expect(harness.inputReads).toEqual(['labels.jsonl']);
    expect(harness.writes).toEqual([]);
  });

  it('rejects thread and trigger transport mismatch without wrong context', async () => {
    const harness = createHarness({
      activeTransportIds: ['transport-a', 'transport-b'],
      triggers: [message({ threadTransportId: 'transport-b' })],
    });

    await expect(
      harness.exporter(
        withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl'], [
          'transport-a',
          'transport-b',
        ]),
      ),
    ).rejects.toThrow(/thread.*transport|transport.*thread/i);

    expect(harness.writes).toEqual([]);
  });

  it('keeps each actual trigger transport in label-scoped quality input cases', async () => {
    const first = message();
    const second = message({
      id: 'in-b',
      transportId: 'transport-b',
      threadId: 'thread-b',
      threadTransportId: 'transport-b',
    });
    const harness = createHarness(
      {
        activeTransportIds: ['transport-b', 'transport-a'],
        triggers: [first, second],
        messagesByThread: new Map([
          ['transport-a\0thread-a', [first]],
          ['transport-b\0thread-b', [second]],
        ]),
      },
      `${JSON.stringify(label('in-a'))}\n${JSON.stringify(label('in-b'))}\n`,
    );

    const result = await harness.exporter(
      withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl'], [
        'transport-a',
        'transport-b',
      ]),
    );

    expect(result).toEqual({ mode: 'labels', count: 2, transportCount: 2 });
    expect(
      privateOutputRows(harness)
        .map((row) => row.transportId)
        .sort(),
    ).toEqual(['transport-a', 'transport-b']);
    expect(harness.writes.map((write) => write.name)).toEqual(['cases.jsonl']);
    expect(harness.outputPreflights).toEqual([
      {
        repoRoot: path.resolve('/synthetic/zero'),
        privateDirectoryName: 'connected-mailbox-corpus',
        allowedExtensions: ['.jsonl'],
      },
    ]);
    expect(harness.inputPreflights).toEqual([
      {
        repoRoot: path.resolve('/synthetic/zero'),
        privateDirectoryName: 'connected-mailbox-corpus',
        allowedExtensions: ['.json', '.jsonl'],
      },
    ]);
  });

  it('keeps actual trigger transport for private targets manifests', async () => {
    const target = message({
      id: 'in-b',
      transportId: 'transport-b',
      threadId: 'thread-b',
      threadTransportId: 'transport-b',
    });
    const harness = createHarness(
      {
        activeTransportIds: ['transport-a', 'transport-b'],
        triggers: [target],
        messagesByThread: new Map([['transport-b\0thread-b', [target]]]),
      },
      JSON.stringify({
        generatedAt: '2026-08-25T09:30:00.000Z',
        targets: [{ threadId: 'thread-b', triggerMessageId: 'in-b' }],
      }),
    );

    const result = await harness.exporter(
      withExplicitTransportIds(['--targets', 'targets.json', '--out', 'cases.jsonl'], [
        'transport-b',
      ]),
    );

    expect(result).toEqual({ mode: 'targets', count: 1, transportCount: 1 });
    expect(privateOutputRows(harness).map((row) => row.transportId)).toEqual(['transport-b']);
  });

  it('uses actual active transport for each all-inbound trigger', async () => {
    const first = message();
    const second = message({
      id: 'in-b',
      transportId: 'transport-b',
      threadId: 'thread-b',
      threadTransportId: 'transport-b',
    });
    const harness = createHarness({
      activeTransportIds: ['transport-b', 'transport-a'],
      allMessages: [second, first],
    });

    const result = await harness.exporter(
      withExplicitTransportIds(['--all-inbound-triggers', '--out', 'cases.jsonl'], [
        'transport-a',
        'transport-b',
      ]),
    );

    expect(result).toEqual({ mode: 'all-inbound-triggers', count: 2, transportCount: 2 });
    expect(
      privateOutputRows(harness)
        .map((row) => row.transportId)
        .sort(),
    ).toEqual(['transport-a', 'transport-b']);
  });

  it('uses strict quality-label JSONL parsing and does not publish malformed labels', async () => {
    const malformed = `${JSON.stringify({ ...label('in-a'), unexpected: 'forbidden' })}\n`;
    const harness = createHarness({}, malformed);

    await expect(
      harness.exporter(
        withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl']),
      ),
    ).rejects.toThrow(/quality label JSONL/i);

    expect(harness.writes).toEqual([]);
  });

  it('only accepts private direct-child inputs and outputs', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const privateRoot = path.join(repoRoot, '.private', 'connected-mailbox-corpus');
      await mkdir(privateRoot, { recursive: true });
      await writeFile(
        path.join(privateRoot, 'labels.jsonl'),
        `${JSON.stringify(label('in-a'))}\n`,
        'utf8',
      );
      await writeFile(
        path.join(privateRoot, 'targets.json'),
        JSON.stringify({
          generatedAt: '2026-08-25T09:30:00.000Z',
          targets: [{ threadId: 'thread-a', triggerMessageId: 'in-a' }],
        }),
        'utf8',
      );
      const rootEntriesAfterFixtureSetup = await readdir(repoRoot);

      const fixtureState: ReaderFixture = { activeTransportIds: ['transport-a'] };
      const { reader } = createReaderFixture(fixtureState);
      const exporter = createTriageQualityExporter({
        repoRoot: () => repoRoot,
        databaseUrl: () => 'postgres://synthetic.invalid/zero',
        preflightInputRoot: async (config) => {
          await prepareExistingTrustedPrivateOutputRoot(config, privateOutputWindowsAclTestOptions);
        },
        preflightOutputRoot: async (config) => {
          await prepareTrustedPrivateOutputRoot(config, privateOutputWindowsAclTestOptions);
        },
        createReader: (options) => {
          fixtureState.explicitTransportIds = options.explicitTransportIds;
          return reader;
        },
        createPrivateInputReader: (config) =>
          createPrivateInputReader(config, {
            verifyIgnoredPrivateOutputDirectory: () => true,
            ...privateOutputWindowsAclTestOptions,
          }),
        createPrivateOutputWriter: (config) =>
          createPrivateOutputWriter(config, {
            verifyIgnoredPrivateOutputDirectory: () => true,
            ...privateOutputWindowsAclTestOptions,
          }),
      });

      await expect(
        exporter(
          withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl']),
        ),
      ).resolves.toEqual({ mode: 'labels', count: 1, transportCount: 1 });
      await expect(readdir(privateRoot)).resolves.toEqual([
        'cases.jsonl',
        'labels.jsonl',
        'targets.json',
      ]);
      await expect(readFile(path.join(privateRoot, 'cases.jsonl'), 'utf8')).resolves.toContain(
        PRIVATE_MARKER,
      );
      await expect(
        exporter(
          withExplicitTransportIds(['--targets', 'targets.json', '--out', 'target-cases.jsonl'], [
            'transport-a',
          ]),
        ),
      ).resolves.toEqual({ mode: 'targets', count: 1, transportCount: 1 });
      await expect(readdir(privateRoot)).resolves.toEqual([
        'cases.jsonl',
        'labels.jsonl',
        'target-cases.jsonl',
        'targets.json',
      ]);

      await expect(
        exporter(
          withExplicitTransportIds(['--labels', '../tracked.jsonl', '--out', 'nested/cases.jsonl']),
        ),
      ).rejects.toThrow();
      await expect(readdir(repoRoot)).resolves.toEqual(rootEntriesAfterFixtureSetup);
    });
  });

  it('requires ignored private root before reading private content', async () => {
    const { reader } = createReaderFixture();
    let reads = 0;
    const exporter = createTriageQualityExporter({
      repoRoot: () => '/synthetic/zero',
      databaseUrl: () => 'postgres://synthetic.invalid/zero',
      preflightOutputRoot: async () => {
        throw new Error('private output root is not ignored');
      },
      preflightInputRoot: async () => {
        throw new Error('unexpected input preflight');
      },
      createReader: () => reader,
      createPrivateInputReader: () => ({
        async read() {
          reads += 1;
          return `${JSON.stringify(label('in-a'))}\n`;
        },
      }),
      createPrivateOutputWriter: () => ({
        async write() {
          throw new Error('unexpected write');
        },
      }),
    });

    await expect(
      exporter(
        withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl']),
      ),
    ).rejects.toThrow(/private/i);
    expect(reads).toBe(0);
  });

  it('fails unsafe physical private roots before database reader, snapshot, or private I/O setup', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      await writeFile(path.join(repoRoot, '.private'), 'not-a-directory', 'utf8');
      const { calls, reader } = createReaderFixture();
      let databaseUrlCalls = 0;
      let inputReaderCreations = 0;
      let outputWriterCreations = 0;
      let readerCreations = 0;
      const exporter = createTriageQualityExporter({
        repoRoot: () => repoRoot,
        databaseUrl: () => {
          databaseUrlCalls += 1;
          return 'postgres://synthetic.invalid/zero';
        },
        preflightOutputRoot: async (config) => {
          await prepareTrustedPrivateOutputRoot(config, privateOutputWindowsAclTestOptions);
        },
        preflightInputRoot: async (config) => {
          await prepareExistingTrustedPrivateOutputRoot(config, privateOutputWindowsAclTestOptions);
        },
        createReader: () => {
          readerCreations += 1;
          return reader;
        },
        createPrivateInputReader: () => {
          inputReaderCreations += 1;
          return {
            async read() {
              throw new Error('private input must not be read');
            },
          };
        },
        createPrivateOutputWriter: () => {
          outputWriterCreations += 1;
          return {
            async write() {
              throw new Error('private output must not be written');
            },
          };
        },
      });

      await expect(
        exporter(
          withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl']),
        ),
      ).rejects.toThrow();

      expect(databaseUrlCalls).toBe(0);
      expect(inputReaderCreations).toBe(0);
      expect(outputWriterCreations).toBe(0);
      expect(readerCreations).toBe(0);
      expect(calls).toEqual([]);
    });
  });

  it('emits count-only CLI metadata and never private payload or paths', async () => {
    const fixtureState: ReaderFixture = { activeTransportIds: ['transport-a'] };
    const { reader } = createReaderFixture(fixtureState);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const command = createTriageQualityExportCommand({
      args: () =>
        withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl']),
      repoRoot: () => '/synthetic/zero',
      databaseUrl: () => 'postgres://synthetic.invalid/zero',
      preflightInputRoot: async () => undefined,
      preflightOutputRoot: async () => undefined,
      createReader: (options) => {
        fixtureState.explicitTransportIds = options.explicitTransportIds;
        return reader;
      },
      createPrivateInputReader: () => ({
        async read() {
          return `${JSON.stringify(label('in-a'))}\n`;
        },
      }),
      createPrivateOutputWriter: () => ({
        async write() {
          return '/synthetic/zero/.private/connected-mailbox-corpus/cases.jsonl';
        },
      }),
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    });

    expect(await command()).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0]!)).toEqual({
      event: 'triage_quality_export.completed',
      mode: 'labels',
      count: 1,
      transportCount: 1,
    });
    expect(`${stdout}${stderr}`).not.toContain(PRIVATE_MARKER);
    expect(`${stdout}${stderr}`).not.toContain('/synthetic/zero/.private');
  });

  it('hides private parser failures behind fixed stderr metadata', async () => {
    const fixtureState: ReaderFixture = { activeTransportIds: ['transport-a'] };
    const { reader } = createReaderFixture(fixtureState);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const command = createTriageQualityExportCommand({
      args: () =>
        withExplicitTransportIds(['--labels', 'labels.jsonl', '--out', 'cases.jsonl']),
      repoRoot: () => '/synthetic/zero',
      databaseUrl: () => 'postgres://synthetic.invalid/zero',
      preflightInputRoot: async () => undefined,
      preflightOutputRoot: async () => undefined,
      createReader: (options) => {
        fixtureState.explicitTransportIds = options.explicitTransportIds;
        return reader;
      },
      createPrivateInputReader: () => ({
        async read() {
          return PRIVATE_MARKER;
        },
      }),
      createPrivateOutputWriter: () => ({
        async write() {
          throw new Error('unexpected write');
        },
      }),
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    });

    expect(await command()).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      `${JSON.stringify({ event: 'triage_quality_export.failed', code: 'export_failed' })}\n`,
    ]);
    expect(`${stdout}${stderr}`).not.toContain(PRIVATE_MARKER);
  });

  it('opens one repeatable-read snapshot and validates explicit transport IDs before content reads', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    let beginOptions: string | undefined;
    const client = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      const text = strings.join('?');
      queries.push({ text, values });
      if (text.includes('CURRENT_TIMESTAMP')) {
        return Promise.resolve([{ asOf: new Date(AS_OF) }]);
      }
      if (text.includes('FROM mailbox_transport')) {
        return Promise.resolve([{ id: 'transport-a' }, { id: 'transport-z' }]);
      }
      throw new Error('unexpected query');
    }) as {
      (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<readonly unknown[]>;
      begin<T>(options: string, load: (connection: typeof client) => Promise<T>): Promise<T>;
      end(): Promise<void>;
    };
    client.begin = async (options, load) => {
      beginOptions = options;
      return await load(client);
    };
    client.end = async () => {};

    const reader = createTriageQualityPostgresReader({
      databaseUrl: 'postgres://synthetic.invalid/zero',
      explicitTransportIds: ['transport-z', 'transport-a'],
      clientFactory: () => client,
    });
    await reader.withRepeatableReadOnly(async (session) => {
      await expect(session.discoverActiveTransportScope()).resolves.toEqual({
        asOf: AS_OF,
        transportIds: ['transport-a', 'transport-z'],
      });
    });
    await reader.close();

    expect(beginOptions).toBe('isolation level repeatable read read only');
    expect(queries).toHaveLength(2);
    expect(queries[1]?.text).toMatch(/FROM mailbox_transport/);
    expect(queries[1]?.text).toMatch(/is_active = true/);
    expect(queries[1]?.text).toMatch(/id = ANY/);
    expect(queries[1]?.text).not.toMatch(/from_address|text_body|html_body|owner_header/i);
  });

  it('has no fixed named source or routing fallback in exporter source', () => {
    const sourcePath = fileURLToPath(
      new URL('../scripts/export-centurion-triage-quality.ts', import.meta.url),
    );
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toMatch(
      /transport-centurion|owner_header|quarantine|dump-centurion-emails-md/i,
    );
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(source).toContain('mailbox_transport');
    expect(source).toContain('isolation level repeatable read read only');
  });
});
