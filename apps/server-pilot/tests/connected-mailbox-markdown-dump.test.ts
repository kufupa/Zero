import {
  createConnectedMailboxMarkdownDumpCommand,
  type ConnectedMailboxMarkdownDumpCommandDependencies,
} from '../scripts/dump-connected-mailbox-markdown';
import {
  createConnectedMailboxMarkdownDump,
  type ConnectedMailboxDumpPostgresClient,
} from '../src/ops/connected-mailbox-markdown-dump';
import { describe, expect, it } from 'vitest';

const AS_OF = '2026-08-25T10:00:00.000Z';
const PRIVATE_BODY_MARKER = 'SYNTHETIC_PRIVATE_BODY_MARKER';

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
    if (/FROM mailbox_transport/i.test(text)) return activeTransportRows;
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

function createDumpHarness(fake: FakePostgres) {
  const writes: Array<{ outputName: string; content: string }> = [];
  const writerConfigurations: Array<{
    repoRoot: string;
    privateDirectoryName: string;
    allowedExtensions: readonly string[];
  }> = [];
  const dump = createConnectedMailboxMarkdownDump({
    client: fake.client,
    repoRoot: '/synthetic/zero',
    createWriter: (configuration) => {
      writerConfigurations.push(configuration);
      return {
        async write(outputName, content) {
          writes.push({ outputName, content: String(content) });
          return `/synthetic/zero/.private/connected-mailbox-corpus/${outputName}`;
        },
      };
    },
  });

  return { dump, writes, writerConfigurations };
}

describe('connected mailbox Markdown dump', () => {
  it('seals sorted active transports in one read-only snapshot and renders each row transport ID', async () => {
    const fake = createFakePostgres();
    const harness = createDumpHarness(fake);

    const result = await harness.dump({ outputName: 'reservationist-inbox.md' });
    const scopeQuery = queryContaining(fake.queries, 'FROM mailbox_transport');
    const messageQuery = queryContaining(fake.queries, 'FROM message AS m');

    expect(fake.beginOptions).toEqual(['isolation level repeatable read read only']);
    expect(fake.queries.every((query) => query.insideTransaction)).toBe(true);
    expect(scopeQuery.text).toMatch(/WHERE\s+is_active\s*=\s*true/i);
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
        repoRoot: '/synthetic/zero',
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

  it('rejects an empty active scope before reading messages or creating private output', async () => {
    const fake = createFakePostgres({ activeTransportRows: [] });
    const harness = createDumpHarness(fake);

    await expect(harness.dump({ outputName: 'reservationist-inbox.md' })).rejects.toThrow(
      'Active transport scope is empty',
    );

    expect(fake.queries.some((query) => /FROM message AS m/i.test(query.text))).toBe(false);
    expect(harness.writerConfigurations).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('uses no quarantine or source-specific mailbox selector', async () => {
    const fake = createFakePostgres();
    const harness = createDumpHarness(fake);

    await harness.dump({ outputName: 'reservationist-inbox.md' });

    const scopeQuery = queryContaining(fake.queries, 'FROM mailbox_transport');
    const messageQuery = queryContaining(fake.queries, 'FROM message AS m');
    expect(fake.queries.some((query) => /mail_ingest_quarantine/i.test(query.text))).toBe(false);
    expect(scopeQuery.text).not.toMatch(/\b(email|owner_header_value|ingest_mailbox_id)\b/i);
    expect(messageQuery.text).not.toMatch(/\b(owner_header_value|ingest_mailbox_id)\b/i);
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

    await harness.dump({ outputName: 'reservationist-inbox.md' });

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
    const harness = createCommandHarness(['--out', 'reservationist-inbox.md']);

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
    const harness = createCommandHarness(['--out', 'reservationist-inbox.md']);
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
