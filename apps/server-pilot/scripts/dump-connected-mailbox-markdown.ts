#!/usr/bin/env node
import {
  createConnectedMailboxMarkdownDump,
  type ConnectedMailboxDumpPostgresClient,
  type ConnectedMailboxMarkdownDumpResult,
} from '../src/ops/connected-mailbox-markdown-dump.js';
import {
  prepareTrustedPrivateOutputRoot,
  type PrivateOutputWriterConfig,
} from '../src/ops/private-output.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import path from 'node:path';

const DEFAULT_OUTPUT_NAME = 'connected-mailbox-inbox.md';
const PRIVATE_DUMP_DIRECTORY_NAME = 'connected-mailbox-corpus';
const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'AUX',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'CON',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'NUL',
  'PRN',
]);

type ConnectedMailboxDumpConnection = ConnectedMailboxDumpPostgresClient & {
  end(): Promise<void>;
};

type DumpFactory = (input: {
  client: ConnectedMailboxDumpPostgresClient;
  repoRoot: string;
}) => (request: {
  outputName: string;
  transportIds: readonly string[];
}) => Promise<ConnectedMailboxMarkdownDumpResult>;

export type ConnectedMailboxMarkdownDumpCommandDependencies = {
  args(): readonly string[];
  environment(): Readonly<{ DATABASE_URL?: string }>;
  repoRoot(): string;
  preflightOutputRoot(config: PrivateOutputWriterConfig): Promise<void>;
  createClient(databaseUrl: string): ConnectedMailboxDumpConnection;
  createDump: DumpFactory;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
};

function isSafeOutputName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    OUTPUT_NAME_PATTERN.test(value) &&
    !path.isAbsolute(value) &&
    path.basename(value) === value &&
    !WINDOWS_RESERVED_DEVICE_NAMES.has(value.split('.', 1)[0]!.toUpperCase())
  );
}

function sortedDistinctTransportIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
}

function parseArgs(argv: readonly string[]): { outputName: string; transportIds: readonly string[] } {
  let outputName = DEFAULT_OUTPUT_NAME;
  const transportIds: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--out') {
      const value = argv[index + 1];
      if (!isSafeOutputName(value)) throw new Error('Invalid arguments');
      outputName = value!;
      index += 1;
      continue;
    }
    if (token === '--transport-id') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid arguments');
      transportIds.push(value.trim());
      index += 1;
      continue;
    }
    throw new Error('Invalid arguments');
  }
  const normalizedTransportIds = sortedDistinctTransportIds(transportIds);
  if (normalizedTransportIds.length === 0) throw new Error('Invalid arguments');
  if (normalizedTransportIds.length !== transportIds.length) {
    throw new Error('Invalid arguments');
  }
  for (let index = 0; index < transportIds.length; index += 1) {
    if (transportIds[index] !== normalizedTransportIds[index]) {
      throw new Error('Invalid arguments');
    }
  }
  return { outputName, transportIds: normalizedTransportIds };
}

function nonBlank(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing configuration');
  return value;
}

function safeCountMetadata(
  result: ConnectedMailboxMarkdownDumpResult,
): Pick<
  ConnectedMailboxMarkdownDumpResult,
  'activeMailboxCount' | 'messageCount' | 'inboundCount' | 'outboundCount'
> {
  const counts = {
    activeMailboxCount: result.activeMailboxCount,
    messageCount: result.messageCount,
    inboundCount: result.inboundCount,
    outboundCount: result.outboundCount,
  };
  if (!Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Invalid dump result');
  }
  return counts;
}

function failureJson(code: 'invalid_arguments' | 'dump_failed'): string {
  return `${JSON.stringify({ event: 'connected_mailbox_markdown_dump.failed', code })}\n`;
}

function writeFailure(
  dependencies: ConnectedMailboxMarkdownDumpCommandDependencies,
  code: 'invalid_arguments' | 'dump_failed',
): number {
  try {
    dependencies.writeStderr(failureJson(code));
  } catch {}
  return 1;
}

function defaultDependencies(): ConnectedMailboxMarkdownDumpCommandDependencies {
  return {
    args: () => process.argv.slice(2),
    environment: () => ({ DATABASE_URL: process.env.DATABASE_URL }),
    repoRoot: () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
    preflightOutputRoot: async (config) => {
      await prepareTrustedPrivateOutputRoot(config);
    },
    createClient: (databaseUrl) =>
      postgres(databaseUrl, {
        ssl: getPostgresSslOptions(databaseUrl),
        max: 1,
        connect_timeout: 30,
      }) as unknown as ConnectedMailboxDumpConnection,
    createDump: ({ client, repoRoot }) => createConnectedMailboxMarkdownDump({ client, repoRoot }),
    writeStdout: (value) => {
      process.stdout.write(value);
    },
    writeStderr: (value) => {
      process.stderr.write(value);
    },
  };
}

export function createConnectedMailboxMarkdownDumpCommand(
  overrides: Partial<ConnectedMailboxMarkdownDumpCommandDependencies> = {},
): () => Promise<number> {
  const dependencies: ConnectedMailboxMarkdownDumpCommandDependencies = {
    ...defaultDependencies(),
    ...overrides,
  };

  return async () => {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(dependencies.args());
    } catch {
      return writeFailure(dependencies, 'invalid_arguments');
    }

    let client: ConnectedMailboxDumpConnection | undefined;
    try {
      const repoRoot = dependencies.repoRoot();
      await dependencies.preflightOutputRoot({
        repoRoot,
        privateDirectoryName: PRIVATE_DUMP_DIRECTORY_NAME,
        allowedExtensions: ['.md'],
      });
      const databaseUrl = nonBlank(dependencies.environment().DATABASE_URL);
      client = dependencies.createClient(databaseUrl);
      const dump = dependencies.createDump({ client, repoRoot });
      const result = await dump({
        outputName: parsed.outputName,
        transportIds: parsed.transportIds,
      });
      dependencies.writeStdout(`${JSON.stringify(safeCountMetadata(result))}\n`);
      return 0;
    } catch {
      return writeFailure(dependencies, 'dump_failed');
    } finally {
      if (client) {
        try {
          await client.end();
        } catch {}
      }
    }
  };
}

export async function runConnectedMailboxMarkdownDump(
  overrides: Partial<ConnectedMailboxMarkdownDumpCommandDependencies> = {},
): Promise<number> {
  return await createConnectedMailboxMarkdownDumpCommand(overrides)();
}

function isEntryScript(): boolean {
  const entryPath = process.argv[1];
  return (
    typeof entryPath === 'string' && fileURLToPath(import.meta.url) === path.resolve(entryPath)
  );
}

if (isEntryScript()) {
  void runConnectedMailboxMarkdownDump().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
