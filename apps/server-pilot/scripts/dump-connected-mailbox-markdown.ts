#!/usr/bin/env node
import {
  createConnectedMailboxMarkdownDump,
  type ConnectedMailboxDumpPostgresClient,
  type ConnectedMailboxMarkdownDumpResult,
} from '../src/ops/connected-mailbox-markdown-dump.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import path from 'node:path';

const DEFAULT_OUTPUT_NAME = 'connected-mailbox-inbox.md';
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
}) => (request: { outputName: string }) => Promise<ConnectedMailboxMarkdownDumpResult>;

export type ConnectedMailboxMarkdownDumpCommandDependencies = {
  args(): readonly string[];
  environment(): Readonly<{ DATABASE_URL?: string }>;
  repoRoot(): string;
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

function parseArgs(argv: readonly string[]): { outputName: string } {
  if (argv.length === 0) return { outputName: DEFAULT_OUTPUT_NAME };
  if (argv.length !== 2 || argv[0] !== '--out' || !isSafeOutputName(argv[1])) {
    throw new Error('Invalid arguments');
  }
  return { outputName: argv[1]! };
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
    let outputName: string;
    try {
      outputName = parseArgs(dependencies.args()).outputName;
    } catch {
      return writeFailure(dependencies, 'invalid_arguments');
    }

    let client: ConnectedMailboxDumpConnection | undefined;
    try {
      const databaseUrl = nonBlank(dependencies.environment().DATABASE_URL);
      client = dependencies.createClient(databaseUrl);
      const dump = dependencies.createDump({ client, repoRoot: dependencies.repoRoot() });
      const result = await dump({ outputName });
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
