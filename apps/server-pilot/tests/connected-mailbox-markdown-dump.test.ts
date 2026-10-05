import {
  createConnectedMailboxMarkdownDumpCommand,
  type ConnectedMailboxMarkdownDumpCommandDependencies,
} from '../scripts/dump-connected-mailbox-markdown';
import {
  createConnectedMailboxMarkdownDump,
  type ConnectedMailboxDumpPostgresClient,
} from '../src/ops/connected-mailbox-markdown-dump';
import { prepareTrustedPrivateOutputRoot } from '../src/ops/private-output';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const AS_OF = '2026-08-25T10:00:00.000Z';
const PRIVATE_BODY_MARKER = 'SYNTHETIC_PRIVATE_BODY_MARKER';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EXPLICIT_TRANSPORT_SCOPE = ['transport-a', 'transport-z'] as const;

type FakeRow = Record<string, unknown>;

type Query = {
  text: string;
  values: unknown[];
  insideTransaction: boolean;
};

type FakePostgres = {
  client: ConnectedMailboxDumpPostgresClient;
  beginOptions: string[];
  queries: Query[];
};

function queryText(strings: TemplateStringsArray): string {
  return strings.reduce(
    (text, fragment, index) =>
      `${text}${fragment}${index < strings.length - 1 ? `$${index + 1}` : ''}`,
    '',
  );
}

function messageRow(input: {
  id: string;
  transportId: string;
  threadTransportId?: string | null;
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  references?: readonly string[] | null;
  textBody?: string;
  htmlBody?: string;
}): FakeRow {
  const threadId = `thread-${input.id}`;
  return {
    id: input.id,
    transportId: input.transportId,
    messageThreadId: threadId,
    resolvedThreadId: threadId,
    threadTransportId: input.threadTransportId ?? input.transportId,
    direction: 'inbound',
    subject: 'Synthetic subject',
    fromAddress: 'sender@example.test',
    toAddresses: ['desk@example.test'],
    ccAddresses: [],
    bccAddresses: [],
    receivedAt: '2026-08-25T09:00:00.000Z',
    sentAt: null,
    createdAt: '2026-08-25T09:00:01.000Z',
    messageIdHeader: input.messageIdHeader ?? 'synthetic-message-id@example.test',
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? [],
    textBody: input.textBody ?? 'Synthetic text',
    htmlBody: input.htmlBody ?? '<p>Synthetic html</p>',
  };
}

function createFakePostgres(
  input: {
    activeTransportRows?: readonly FakeRow[];
    messages?: readonly FakeRow[];
  } = {},
): FakePostgres {
  const beginOptions: string[] = [];
  const queries: Query[] = [];
  let insideTransaction = false;
  let client: ConnectedMailboxDumpPostgresClient;
  const activeTransportRows = input.activeTransportRows ?? [
    { id: 'transport-z' },
    { id: 'transport-a' },
    { id: 'transport-z' },
  ];
  const messages = input.messages ?? [
    messageRow({ id: 'message-z', transportId: 'transport-z' }),
    messageRow({ id: 'message-a', transportId: 'transport-a' }),
    messageRow({ id: 'message-disabled', transportId: 'transport-disabled' }),
    messageRow({
      id: 'message-thread-mismatch',
      transportId: 'transport-a',
      threadTransportId: 'transport-z',
    }),
  ];

  const query = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<readonly FakeRow[]> => {
    const text = queryText(strings);
    queries.push({ text, values, insideTransaction });
    if (/CURRENT_TIMESTAMP/i.test(text)) return [{ asOf: AS_OF }];
    if (/FROM mailbox_transport/i.test(text)) {
      const requestedIds = values.find(
        (value): value is string[] =>
          Array.isArray(value) && value.every((entry) => typeof entry === 'string'),
      );
      if (!requestedIds) return activeTransportRows;
      const activeIds = new Set(
        activeTransportRows
          .map((row) => (typeof row.id === 'string' ? row.id : null))
          .filter((id): id is string => id !== null),
      );
      return requestedIds
        .filter((id) => activeIds.has(id))
        .sort()
        .map((id) => ({ id }));
    }
    if (/FROM message AS m/i.test(text)) return messages;
    throw new Error('Unexpected synthetic query');
  };

  const begin = async <T>(
    options: string,
    load: (connection: ConnectedMailboxDumpPostgresClient) => Promise<T>,
  ): Promise<T> => {
    beginOptions.push(options);
    insideTransaction = true;
    try {
      return await load(client);
    } finally {
      insideTransaction = false;
    }
  };

  client = Object.assign(query, { begin }) as unknown as ConnectedMailboxDumpPostgresClient;
  return { client, beginOptions, queries };
}

function queryContaining(queries: readonly Query[], fragment: string): Query {
  const query = queries.find((candidate) => candidate.text.includes(fragment));
  if (!query) throw new Error(`Missing query for ${fragment}`);
  return query;
}

async function withTemporaryGitRoot<T>(run: (repoRoot: string) => Promise<T>): Promise<T> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'connected-mailbox-dump-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot, stdio: 'ignore' });
    return await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function createDumpHarness(fake: FakePostgres) {
  const writes: Array<{ outputName: string; content: string }> = [];
  const writerConfigurations: Array<{
    repoRoot: string;
    privateDirectoryName: string;
    allowedExtensions: readonly string[];
  }> = [];
  const dump = createConnectedMailboxMarkdownDump({
    client: fake.client,
    repoRoot: REPO_ROOT,
    preflightOutputRoot: async () => undefined,
    createWriter: (configuration) => {
      writerConfigurations.push(configuration);
      return {
        async write(outputName, content) {
          writes.push({ outputName, content: String(content) });
          return path.join(REPO_ROOT, '.private', 'connected-mailbox-corpus', outputName);
        },
      };
    },
  });

  return { dump, writes, writerConfigurations };
}

describe('connected mailbox Markdown dump', () => {
  it('fails before transaction or writer output when private root is unignored', async () => {
    await withTemporaryGitRoot(async (repoRoot) => {
      const fake = createFakePostgres();
      let writerCreateCalls = 0;
      let writerOutputCalls = 0;
      const dump = createConnectedMailboxMarkdownDump({
        client: fake.client,
        repoRoot,
        createWriter: () => {
          writerCreateCalls += 1;
          return {
            async write() {
              writerOutputCalls += 1;
              return path.join(repoRoot, '.private', 'connected-mailbox-corpus', 'output.md');
            },
          };
        },
      });

      await expect(
        dump({
          outputName: 'reservationist-inbox.md',
          transportIds: [...EXPLICIT_TRANSPORT_SCOPE],
        }),
      ).rejects.toThrow('Private output root is not ignored');

      expect(fake.beginOptions).toEqual([]);
      expect(fake.queries).toEqual([]);
      expect(writerCreateCalls).toBe(0);
      expect(writerOutputCalls).toBe(0);
    });
  });

  it('fails unsafe physical output roots before opening a database snapshot or writer output', async () => {
    await withTemporaryGitRoot(async (repoRoot) => {
      await writeFile(
        path.join(repoRoot, '.gitignore'),
        '/.private/connected-mailbox-corpus/\n',
        'utf8',
      );
      await writeFile(path.join(repoRoot, '.private'), 'not-a-directory', 'utf8');
      const fake = createFakePostgres();
      let writerCreateCalls = 0;
      let writerOutputCalls = 0;
      const dump = createConnectedMailboxMarkdownDump({
        client: fake.client,
        repoRoot,
        createWriter: () => {
          writerCreateCalls += 1;
          return {
            async write() {
              writerOutputCalls += 1;
              return path.join(repoRoot, '.private', 'connected-mailbox-corpus', 'output.md');
            },
          };
        },
      });

      await expect(
        dump({
          outputName: 'reservationist-inbox.md',
          transportIds: [...EXPLICIT_TRANSPORT_SCOPE],
        }),
      ).rejects.toThrow();

      expect(fake.beginOptions).toEqual([]);
      expect(fake.queries).toEqual([]);
      expect(writerCreateCalls).toBe(0);
      expect(writerOutputCalls).toBe(0);
    });
  });

  it('rejects omitted or empty transport IDs before opening a database snapshot', async () => {
    const fake = createFakePostgres();
    const harness = createDumpHarness(fake);

    await expect(harness.dump({ outputName: 'reservationist-inbox.md' })).rejects.toThrow(
      'Explicit transport scope is required',
    );
    await expect(
      harness.dump({ outputName: 'reservationist-inbox.md', transportIds: [] }),
    ).rejects.toThrow('Explicit transport scope is required');

    expect(fake.beginOptions).toEqual([]);
    expect(fake.queries).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('rejects unsorted explicit transport IDs before reading messages', async () => {
    const fake = createFakePostgres();
    const harness = createDumpHarness(fake);

    await expect(
      harness.dump({
        outputName: 'reservationist-inbox.md',
        transportIds: ['transport-z', 'transport-a'],
      }),
    ).rejects.toThrow('Explicit transport scope must be sorted');

    expect(fake.queries.some((query) => /FROM message AS m/i.test(query.text))).toBe(false);
    expect(harness.writes).toEqual([]);
  });

  it('seals only requested active transports in one read-only snapshot and renders each row transport ID', async () => {
    const fake = createFakePostgres();
    const harness = createDumpHarness(fake);

    const result = await harness.dump({
      outputName: 'reservationist-inbox.md',
      transportIds: [...EXPLICIT_TRANSPORT_SCOPE],
    });
    const scopeQuery = queryContaining(fake.queries, 'FROM mailbox_transport');
    const messageQuery = queryContaining(fake.queries, 'FROM message AS m');

    expect(fake.beginOptions).toEqual(['isolation level repeatable read read only']);
    expect(fake.queries.every((query) => query.insideTransaction)).toBe(true);
    expect(scopeQuery.text).toMatch(/WHERE\s+is_active\s*=\s*true/i);
    expect(scopeQuery.text).toMatch(/id\s*=\s*ANY/i);
    expect(scopeQuery.values).toContainEqual([...EXPLICIT_TRANSPORT_SCOPE]);
    expect(scopeQuery.text).toMatch(/ORDER BY\s+id/i);
    expect(messageQuery.values).toContainEqual(['transport-a', 'transport-z']);
    expect(messageQuery.values).toContain(AS_OF);
    expect(messageQuery.text).toMatch(/m\.transport_id = ANY\(\$\d+\)/i);
    expect(messageQuery.text).toMatch(
      /COALESCE\(m\.received_at, m\.sent_at, m\.created_at\) < \$\d+/i,
    );
    expect(messageQuery.text).toMatch(
      /\(t\.id IS NULL OR m\.transport_id IS NULL OR t\.transport_id IS NULL OR t\.transport_id = m\.transport_id\)/i,
    );
    expect(result).toEqual({
      asOf: AS_OF,
      activeMailboxCount: 2,
      messageCount: 2,
      inboundCount: 2,
      outboundCount: 0,
    });
    expect(harness.writerConfigurations).toEqual([
      {
        repoRoot: REPO_ROOT,
        privateDirectoryName: 'connected-mailbox-corpus',
        allowedExtensions: ['.md'],
      },
    ]);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.outputName).toBe('reservationist-inbox.md');
    expect(harness.writes[0]?.content).toContain('**Transport ID:** `transport-a`');
    expect(harness.writes[0]?.content).toContain('**Transport ID:** `transport-z`');
    expect(harness.writes[0]?.content).not.toContain('transport-disabled');
    expect(harness.writes[0]?.content).not.toContain('message-thread-mismatch');
  });

  it('rejects unknown or inactive requested transport IDs before reading messages', async () => {
    const fake = createFakePostgres();
    const harness = createDumpHarness(fake);

    await expect(
      harness.dump({
        outputName: 'reservationist-inbox.md',
        transportIds: ['transport-a', 'transport-missing'],
      }),
    ).rejects.toThrow('Requested transport scope is not active');

    expect(fake.queries.some((query) => /FROM message AS m/i.test(query.text))).toBe(false);
    expect(harness.writerConfigurations).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('exports only transport-a rows when transport-a is the explicit scope', async () => {
    const fake = createFakePostgres();
    const harness = createDumpHarness(fake);

    await harness.dump({
      outputName: 'reservationist-inbox.md',
      transportIds: ['transport-a'],
    });

    const messageQuery = queryContaining(fake.queries, 'FROM message AS m');
    expect(messageQuery.values).toContainEqual(['transport-a']);
    const markdown = harness.writes[0]?.content ?? '';
    expect(markdown).toContain('**Transport ID:** `transport-a`');
    expect(markdown).not.toContain('**Transport ID:** `transport-z`');
  });

  it('rejects an empty active scope before reading messages or creating private output', async () => {
    const fake = createFakePostgres({ activeTransportRows: [] });
    const harness = createDumpHarness(fake);

    await expect(
      harness.dump({
        outputName: 'reservationist-inbox.md',
        transportIds: ['transport-a'],
      }),
    ).rejects.toThrow('Requested transport scope is not active');

    expect(fake.queries.some((query) => /FROM message AS m/i.test(query.text))).toBe(false);
    expect(harness.writerConfigurations).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('uses no quarantine or source-specific mailbox selector', async () => {
    const fake = createFakePostgres();
    const harness = createDumpHarness(fake);

    await harness.dump({
      outputName: 'reservationist-inbox.md',
      transportIds: [...EXPLICIT_TRANSPORT_SCOPE],
    });

    const scopeQuery = queryContaining(fake.queries, 'FROM mailbox_transport');
    const messageQuery = queryContaining(fake.queries, 'FROM message AS m');
    expect(fake.queries.some((query) => /mail_ingest_quarantine/i.test(query.text))).toBe(false);
    expect(scopeQuery.text).not.toMatch(/\b(email|owner_header_value|ingest_mailbox_id)\b/i);
    expect(messageQuery.text).not.toMatch(/\b(owner_header_value|ingest_mailbox_id)\b/i);
  });

  it('selects and renders Message-ID, In-Reply-To, and References headers', async () => {
    const fake = createFakePostgres({
      messages: [
        messageRow({
          id: 'message-headers',
          transportId: 'transport-a',
          messageIdHeader: 'child@example.test',
          inReplyTo: 'parent@example.test',
          references: ['root@example.test', 'parent@example.test'],
        }),
      ],
    });
    const harness = createDumpHarness(fake);

    await harness.dump({
      outputName: 'reservationist-inbox.md',
      transportIds: [...EXPLICIT_TRANSPORT_SCOPE],
    });

    const messageQuery = queryContaining(fake.queries, 'FROM message AS m');
    expect(messageQuery.text).toMatch(/m\.message_id_header AS "messageIdHeader"/i);
    expect(messageQuery.text).toMatch(/m\.in_reply_to AS "inReplyTo"/i);
    expect(messageQuery.text).toMatch(/m\.references AS "references"/i);

    const markdown = harness.writes[0]?.content ?? '';
    expect(markdown).toContain('**Message-ID (header):** `child@example.test`');
    expect(markdown).toContain('**In-Reply-To:** `parent@example.test`');
    expect(markdown).toContain(
      '**References:** `root@example.test`, `parent@example.test`',
    );
  });

  it('renders generic reservationist wording and keeps message bodies inside safe fences', async () => {
    const fake = createFakePostgres({
      messages: [
        messageRow({
          id: 'message-fenced',
          transportId: 'transport-a',
          textBody: `${PRIVATE_BODY_MARKER}\n\`\`\``,
          htmlBody: '<p>Synthetic html</p>',
        }),
      ],
    });
    const harness = createDumpHarness(fake);

    await harness.dump({
      outputName: 'reservationist-inbox.md',
      transportIds: [...EXPLICIT_TRANSPORT_SCOPE],
    });

    const markdown = harness.writes[0]?.content ?? '';
    expect(markdown).toMatch(/reservationist inbox/i);
    expect(markdown).toContain(`\`\`\`text\n${PRIVATE_BODY_MARKER}\n\`\`\u200b\`\n\`\`\``);
    expect(markdown).toContain('```html\n<p>Synthetic html</p>\n```');
    expect(markdown).not.toMatch(/centurion|penny|owner_header_value|ingest_mailbox/i);
  });
});

function createCommandHarness(args: readonly string[] = []) {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fake = createFakePostgres();
  const dependencies = {
    args: () => args,
    environment: () => ({ DATABASE_URL: 'postgresql://localhost/synthetic' }),
    repoRoot: () => '/synthetic/zero',
    preflightOutputRoot: async () => {
      calls.push('preflight');
    },
    createClient: () => {
      calls.push('createClient');
      return Object.assign(fake.client, {
        async end() {
          calls.push('end');
        },
      });
    },
    createDump: () => async () => {
      calls.push('dump');
      return {
        asOf: AS_OF,
        activeMailboxCount: 2,
        messageCount: 3,
        inboundCount: 2,
        outboundCount: 1,
      };
    },
    writeStdout: (value: string) => {
      calls.push('stdout');
      stdout.push(value);
    },
    writeStderr: (value: string) => {
      calls.push('stderr');
      stderr.push(value);
    },
  } as unknown as ConnectedMailboxMarkdownDumpCommandDependencies;

  return { calls, dependencies, stderr, stdout };
}

describe('connected mailbox Markdown dump command', () => {
  it('fails closed before environment, client, or dump when output preflight rejects', async () => {
    const harness = createCommandHarness([
      '--transport-id',
      'transport-a',
      '--transport-id',
      'transport-z',
      '--out',
      'reservationist-inbox.md',
    ]);
    let environmentCalls = 0;
    let createClientCalls = 0;
    let createDumpCalls = 0;
    const dependencies = {
      ...harness.dependencies,
      preflightOutputRoot: async () => {
        harness.calls.push('preflight');
        throw new Error('unsafe output root');
      },
      environment: () => {
        environmentCalls += 1;
        return { DATABASE_URL: 'postgresql://localhost/synthetic' };
      },
      createClient: () => {
        createClientCalls += 1;
        throw new Error('client must not be created');
      },
      createDump: () => {
        createDumpCalls += 1;
        throw new Error('dump must not be created');
      },
    } as unknown as ConnectedMailboxMarkdownDumpCommandDependencies;

    const code = await createConnectedMailboxMarkdownDumpCommand(dependencies)();

    expect(code).toBe(1);
    expect(environmentCalls).toBe(0);
    expect(createClientCalls).toBe(0);
    expect(createDumpCalls).toBe(0);
    expect(harness.calls).toEqual(['preflight', 'stderr']);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      `${JSON.stringify({ event: 'connected_mailbox_markdown_dump.failed', code: 'dump_failed' })}\n`,
    ]);
  });

  it('fails unsafe physical output roots before environment, client, or dump setup', async () => {
    await withTemporaryGitRoot(async (repoRoot) => {
      await writeFile(
        path.join(repoRoot, '.gitignore'),
        '/.private/connected-mailbox-corpus/\n',
        'utf8',
      );
      await writeFile(path.join(repoRoot, '.private'), 'not-a-directory', 'utf8');
      const harness = createCommandHarness([
      '--transport-id',
      'transport-a',
      '--transport-id',
      'transport-z',
      '--out',
      'reservationist-inbox.md',
    ]);
      let environmentCalls = 0;
      let createClientCalls = 0;
      let createDumpCalls = 0;
      const dependencies = {
        ...harness.dependencies,
        repoRoot: () => repoRoot,
        preflightOutputRoot: async (config) => {
          await prepareTrustedPrivateOutputRoot(config);
        },
        environment: () => {
          environmentCalls += 1;
          return { DATABASE_URL: 'postgresql://localhost/synthetic' };
        },
        createClient: () => {
          createClientCalls += 1;
          throw new Error('client must not be created');
        },
        createDump: () => {
          createDumpCalls += 1;
          throw new Error('dump must not be created');
        },
      } as unknown as ConnectedMailboxMarkdownDumpCommandDependencies;

      const code = await createConnectedMailboxMarkdownDumpCommand(dependencies)();

      expect(code).toBe(1);
      expect(environmentCalls).toBe(0);
      expect(createClientCalls).toBe(0);
      expect(createDumpCalls).toBe(0);
      expect(harness.stdout).toEqual([]);
      expect(harness.stderr).toEqual([
        `${JSON.stringify({ event: 'connected_mailbox_markdown_dump.failed', code: 'dump_failed' })}\n`,
      ]);
    });
  });

  it('rejects missing --transport-id before creating a client or private output', async () => {
    const harness = createCommandHarness(['--out', 'reservationist-inbox.md']);

    const code = await createConnectedMailboxMarkdownDumpCommand(harness.dependencies)();

    expect(code).toBe(1);
    expect(harness.calls).toEqual(['stderr']);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      `${JSON.stringify({ event: 'connected_mailbox_markdown_dump.failed', code: 'invalid_arguments' })}\n`,
    ]);
  });

  it('rejects unsafe --out before creating a client or private output', async () => {
    const harness = createCommandHarness(['--out', '../outside.md']);

    const code = await createConnectedMailboxMarkdownDumpCommand(harness.dependencies)();

    expect(code).toBe(1);
    expect(harness.calls).toEqual(['stderr']);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      `${JSON.stringify({ event: 'connected_mailbox_markdown_dump.failed', code: 'invalid_arguments' })}\n`,
    ]);
  });

  it('writes count-only metadata to stdout', async () => {
    const harness = createCommandHarness([
      '--transport-id',
      'transport-a',
      '--transport-id',
      'transport-z',
      '--out',
      'reservationist-inbox.md',
    ]);

    const code = await createConnectedMailboxMarkdownDumpCommand(harness.dependencies)();

    expect(code).toBe(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.stdout).toEqual([
      `${JSON.stringify({
        activeMailboxCount: 2,
        messageCount: 3,
        inboundCount: 2,
        outboundCount: 1,
      })}\n`,
    ]);
    const metadata = JSON.parse(harness.stdout[0] ?? '') as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      'activeMailboxCount',
      'inboundCount',
      'messageCount',
      'outboundCount',
    ]);
    expect(Object.values(metadata).every((value) => Number.isSafeInteger(value))).toBe(true);
  });

  it('does not echo private downstream content in errors', async () => {
    const harness = createCommandHarness([
      '--transport-id',
      'transport-a',
      '--transport-id',
      'transport-z',
      '--out',
      'reservationist-inbox.md',
    ]);
    harness.dependencies.createDump = () => async () => {
      throw new Error(PRIVATE_BODY_MARKER);
    };

    const code = await createConnectedMailboxMarkdownDumpCommand(harness.dependencies)();

    expect(code).toBe(1);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      `${JSON.stringify({ event: 'connected_mailbox_markdown_dump.failed', code: 'dump_failed' })}\n`,
    ]);
    expect(`${harness.stdout}${harness.stderr}`).not.toContain(PRIVATE_BODY_MARKER);
  });
});
