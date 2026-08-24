import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  createThreadCorpusPostgresReader,
  type ThreadCorpusPostgresClient,
} from '../src/ops/centurion-thread-corpus-postgres-reader';
import { createThreadCorpusSnapshotLoader } from '../src/ops/centurion-thread-corpus-snapshot';

type QueryRecord = {
  text: string;
  values: unknown[];
  insideTransaction: boolean;
};

type FakePostgresClient = {
  client: ThreadCorpusPostgresClient;
  beginOptions: string[];
  endCalls: number;
  queries: QueryRecord[];
};

type FakeRow = Record<string, unknown>;

type SnapshotRows = {
  messages?: readonly FakeRow[];
  queue?: readonly FakeRow[];
};

const snapshotAsOf = '2026-08-22T12:34:56.000Z';
const centurionTransportId = 'transport-centurion';
const designatedTransportId = 'transport-designated';
const designatedIngestMailboxId = 'mailbox-designated';
const designatedAddress = 'designated-address@example.test';

function queryText(strings: TemplateStringsArray): string {
  return strings.reduce(
    (text, fragment, index) =>
      `${text}${fragment}${index < strings.length - 1 ? `$${index + 1}` : ''}`,
    '',
  );
}

function createFakePostgresClient(
  respond: (
    text: string,
    values: readonly unknown[],
  ) => readonly FakeRow[] | Promise<readonly FakeRow[]>,
): FakePostgresClient {
  const beginOptions: string[] = [];
  const queries: QueryRecord[] = [];
  let endCalls = 0;
  let transactionDepth = 0;
  let client: ThreadCorpusPostgresClient;

  const query = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<readonly FakeRow[]> => {
    const text = queryText(strings);
    queries.push({ text, values, insideTransaction: transactionDepth > 0 });
    return respond(text, values);
  };

  const begin = async <T>(
    options: string,
    load: (connection: ThreadCorpusPostgresClient) => Promise<T>,
  ): Promise<T> => {
    beginOptions.push(options);
    transactionDepth += 1;
    try {
      return await load(client);
    } finally {
      transactionDepth -= 1;
    }
  };

  const end = async (): Promise<void> => {
    endCalls += 1;
  };

  client = Object.assign(query, { begin, end }) as unknown as ThreadCorpusPostgresClient;
  return {
    client,
    beginOptions,
    get endCalls() {
      return endCalls;
    },
    queries,
  };
}

function rowsForSnapshot(text: string, overrides: SnapshotRows = {}): readonly FakeRow[] {
  if (/CURRENT_TIMESTAMP/i.test(text)) {
    return [{ asOf: snapshotAsOf }];
  }
  if (/FROM mailbox_transport/i.test(text)) {
    return [
      {
        id: centurionTransportId,
        email: 'centurion@example.test',
        ownerHeaderValue: 'centurion-owner@example.test',
        active: false,
      },
      {
        id: designatedTransportId,
        email: 'designated@example.test',
        ownerHeaderValue: 'designated-owner@example.test',
        active: true,
      },
    ];
  }
  if (/FROM mail_ingest_mailbox/i.test(text)) {
    return [{ id: designatedIngestMailboxId, active: false }];
  }
  if (/FROM message AS m/i.test(text)) {
    return [
      {
        id: 'message-a',
        transportId: centurionTransportId,
        ingestMailboxId: null,
        uidl: 'uidl-a',
        threadId: 'thread-a',
        messageThreadId: 'thread-a',
        resolvedThreadId: 'thread-a',
        threadTransportId: centurionTransportId,
        messageId: '<message-a@example.test>',
        receivedAt: '2026-08-22T09:00:00+00:00',
        sentAt: '2026-08-22T09:01:00.000Z',
        subject: 'Synthetic subject A',
        body: 'Synthetic body A',
        direction: 'outbound',
        fromAddress: 'Desk <desk@example.test>',
        toAddresses: '["Guest <guest@example.test>"]',
        ccAddresses: ['cc@example.test', 42],
        bccAddresses: { malformed: true },
        ownerHeaderValue: 'centurion-owner@example.test',
        inReplyTo: '<parent@example.test>',
        references: '["<root@example.test>","<parent@example.test>"]',
        rawMimeLocator: 'raw/synthetic-a',
      },
      {
        id: 'message-b',
        transportId: designatedTransportId,
        ingestMailboxId: designatedIngestMailboxId,
        uidl: 'uidl-b',
        threadId: 'thread-b',
        messageThreadId: 'thread-b',
        resolvedThreadId: 'thread-b',
        threadTransportId: designatedTransportId,
        messageId: '<message-b@example.test>',
        receivedAt: '2026-08-22T10:00:00.000Z',
        sentAt: '2026-08-22T10:01:00.000Z',
        subject: null,
        body: null,
        direction: 'outbound',
        fromAddress: 'Desk <desk@example.test>',
        toAddresses: [],
        ccAddresses: [],
        bccAddresses: [],
        ownerHeaderValue: 'designated-owner@example.test',
        inReplyTo: null,
        references: [],
        rawMimeLocator: null,
      },
      ...(overrides.messages ?? []),
    ];
  }
  if (/FROM mail_ingest_quarantine AS q/i.test(text)) {
    return [
      {
        id: 'quarantine-ingest',
        ingestMailboxId: designatedIngestMailboxId,
        ownerHeaderValue: null,
        createdAt: '2026-08-22T08:00:00.000Z',
        rawMimeLocator: 'raw/quarantine-ingest',
      },
      {
        id: 'quarantine-owner',
        ingestMailboxId: 'other-ingest',
        ownerHeaderValue: 'centurion-owner@example.test',
        createdAt: '2026-08-22T08:30:00.000Z',
        rawMimeLocator: 'raw/quarantine-owner',
      },
      {
        id: 'quarantine-uncertain',
        ingestMailboxId: 'other-ingest',
        ownerHeaderValue: 'unmatched-owner@example.test',
        createdAt: '2026-08-22T08:45:00.000Z',
        rawMimeLocator: 'raw/quarantine-uncertain',
      },
    ];
  }
  if (/FROM attachment AS a/i.test(text)) {
    return [
      {
        id: 'attachment-a',
        messageId: 'message-a',
        filename: 'synthetic-a.pdf',
        contentType: 'application/pdf',
        byteSize: 42,
        s3Key: 's3/synthetic-attachment-a',
      },
      {
        id: 'attachment-b',
        messageId: 'message-a',
        filename: 'synthetic-b.txt',
        contentType: 'text/plain',
        byteSize: 7,
        s3Key: 's3/synthetic-attachment-b',
      },
      {
        id: 'attachment-malformed',
        messageId: null,
        filename: 'ignored.bin',
        contentType: 'application/octet-stream',
        byteSize: 1,
        s3Key: null,
      },
    ];
  }
  if (/FROM mail_draft AS d/i.test(text)) {
    return [
      {
        messageId: 'message-a',
        draftId: 'draft-a',
        revisionId: 'revision-a',
      },
      {
        messageId: 'message-a',
        draftId: null,
        revisionId: null,
      },
    ];
  }
  if (/FROM outbound_send_queue AS q/i.test(text)) {
    return overrides.queue ?? [
      {
        messageId: 'message-a',
        transportId: centurionTransportId,
        status: 'sent',
      },
      {
        messageId: 'message-b',
        transportId: designatedTransportId,
        status: 'unexpected-status',
      },
    ];
  }
  throw new Error(`Unexpected synthetic query: ${text}`);
}

function createReader(
  fake: FakePostgresClient,
  overrides: Partial<Parameters<typeof createThreadCorpusPostgresReader>[0]> = {},
) {
  let created:
    | {
        databaseUrl: string;
        options: unknown;
      }
    | undefined;
  const reader = createThreadCorpusPostgresReader({
    databaseUrl: 'postgresql://localhost:5432/centurion-test',
    centurionTransportId,
    designatedTransportId,
    designatedIngestMailboxIds: [designatedIngestMailboxId],
    designatedAddresses: [designatedAddress],
    clientFactory(databaseUrl, options) {
      created = { databaseUrl, options };
      return fake.client;
    },
    ...overrides,
  });
  return { created, reader };
}

async function loadSnapshot(fake: FakePostgresClient) {
  const { created, reader } = createReader(fake);
  const result = await createThreadCorpusSnapshotLoader(reader)({
    centurionTransportId,
    designatedTransportId,
    designatedIngestMailboxIds: [designatedIngestMailboxId],
    designatedAddresses: [designatedAddress],
  });
  return { created, reader, result };
}

function sourceRows(result: Awaited<ReturnType<typeof loadSnapshot>>['result']) {
  return result.formatted.threads.flatMap((thread) =>
    thread.messages.flatMap((message) => message.sourceRows),
  );
}

function queryContaining(queries: readonly QueryRecord[], value: string): QueryRecord {
  const query = queries.find((candidate) => candidate.text.includes(value));
  if (!query) throw new Error(`Missing synthetic query containing ${value}`);
  return query;
}

function readerSourceGuardViolations(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    'centurion-thread-corpus-postgres-reader.ts',
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const expectedImports = new Map<string, { defaultName?: string; named?: readonly string[] }>([
    ['postgres', { defaultName: 'postgres' }],
    ['../db/ssl-config.js', { named: ['getPostgresSslOptions'] }],
  ]);
  const violations: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      violations.push('CommonJS import assignment is prohibited');
      continue;
    }
    if (!ts.isImportDeclaration(statement)) continue;

    const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : '';
    const expected = expectedImports.get(moduleName);
    if (!expected) {
      violations.push(`Import ${moduleName || '<dynamic>'} is not allowed`);
      continue;
    }
    const clause = statement.importClause;
    if (!clause) {
      violations.push(`Import ${moduleName} must name allowed bindings`);
      continue;
    }
    if (clause.name?.text !== expected.defaultName) {
      violations.push(`Import ${moduleName} has an invalid default binding`);
    }
    if (!expected.defaultName && clause.name) {
      violations.push(`Import ${moduleName} must not have a default binding`);
    }
    if (!expected.named) {
      if (clause.namedBindings) violations.push(`Import ${moduleName} has invalid named bindings`);
      continue;
    }
    if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
      violations.push(`Import ${moduleName} must use named bindings`);
      continue;
    }
    const actual = clause.namedBindings.elements.map((element) => {
      const imported = element.propertyName?.text ?? element.name.text;
      if (element.propertyName || element.name.text !== imported) {
        violations.push(`Import ${moduleName} must not alias ${imported}`);
      }
      return imported;
    });
    if (
      actual.length !== expected.named.length ||
      [...actual].sort().join(',') !== [...expected.named].sort().join(',')
    ) {
      violations.push(`Import ${moduleName} bindings are not exact`);
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'console'
    ) {
      violations.push('console output is prohibited');
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.push('Dynamic import is prohibited');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('centurion thread corpus PostgreSQL reader', () => {
  it('uses one repeatable read-only snapshot and derives asOf before source reads', async () => {
    const fake = createFakePostgresClient((text) => rowsForSnapshot(text));

    const { result } = await loadSnapshot(fake);
    const asOfQueries = fake.queries.filter((query) => /CURRENT_TIMESTAMP/i.test(query.text));
    const messageIndex = fake.queries.findIndex((query) => /FROM message AS m/i.test(query.text));
    const relationIndex = fake.queries.findIndex((query) => /FROM attachment AS a/i.test(query.text));

    expect(result.asOf).toBe(snapshotAsOf);
    expect(fake.beginOptions).toEqual(['isolation level repeatable read read only']);
    expect(asOfQueries).toHaveLength(1);
    expect(fake.queries.indexOf(asOfQueries[0]!)).toBeLessThan(messageIndex);
    expect(fake.queries.indexOf(asOfQueries[0]!)).toBeLessThan(relationIndex);
    expect(fake.queries.every((query) => query.insideTransaction)).toBe(true);
    expect(fake.endCalls).toBe(0);
  });

  it('uses bound SELECTs for inactive retained scopes and historical address candidates', async () => {
    const fake = createFakePostgresClient((text) => rowsForSnapshot(text));

    const { result } = await loadSnapshot(fake);
    const transportScopes = queryContaining(fake.queries, 'FROM mailbox_transport');
    const ingestScopes = queryContaining(fake.queries, 'FROM mail_ingest_mailbox');
    const messages = queryContaining(fake.queries, 'FROM message AS m');

    for (const query of fake.queries) {
      expect(query.text.trimStart()).toMatch(/^SELECT\b/i);
      expect(Array.isArray(query.values)).toBe(true);
      expect(query.text).not.toContain(centurionTransportId);
      expect(query.text).not.toContain(designatedIngestMailboxId);
      expect(query.text).not.toContain(designatedAddress);
    }
    expect(transportScopes.text).toContain('is_active AS "active"');
    expect(transportScopes.text).not.toMatch(/is_active\s*=\s*true/i);
    expect(ingestScopes.text).toContain('is_active AS "active"');
    expect(messages.values).toContainEqual([centurionTransportId, designatedTransportId]);
    expect(messages.values).toContainEqual([designatedIngestMailboxId]);
    expect(messages.values).toContainEqual(
      expect.arrayContaining([
        designatedAddress,
        'centurion@example.test',
        'centurion-owner@example.test',
      ]),
    );
    expect(messages.text).toMatch(/LEFT JOIN mail_thread AS t ON t\.id = m\.thread_id/i);
    expect(messages.text).toMatch(
      /\(t\.id IS NULL OR m\.transport_id IS NULL OR t\.transport_id IS NULL OR t\.transport_id = m\.transport_id\)/i,
    );
    expect(messages.text).toMatch(/m\.ingest_mailbox_id = ANY\(\$\d+\)/i);
    expect(messages.text).toMatch(/lower\(m\.owner_header_value\) = ANY\(\$\d+\)/i);
    expect(messages.text).toContain(
      "substring(m.from_address FROM '<[[:space:]]*([^<>]+)[[:space:]]*>')",
    );
    expect(messages.text).not.toMatch(/\b(position|unnest)\b/i);
    expect(messages.text).toMatch(/jsonb_array_elements_text/i);
    expect(
      result.formatted.threads.flatMap((thread) => thread.messages).flatMap((message) => message.sourceRows),
    ).toHaveLength(2);
  });

  it('uses exact normalized candidates without selecting address substrings', async () => {
    const designatedExactAddress = 'ann@example.test';
    const fake = createFakePostgresClient((text) =>
      rowsForSnapshot(text, {
        messages: [
          {
            id: 'message-display-address',
            transportId: 'transport-historical',
            ingestMailboxId: null,
            uidl: 'uidl-display-address',
            threadId: null,
            messageThreadId: null,
            resolvedThreadId: null,
            threadTransportId: null,
            messageId: '<display-address@example.test>',
            receivedAt: '2026-08-22T10:29:00.000Z',
            sentAt: null,
            subject: 'Synthetic display candidate',
            body: 'Synthetic display body',
            direction: 'inbound',
            fromAddress: 'Name <ann@example.test>',
            toAddresses: [],
            ccAddresses: [],
            bccAddresses: [],
            ownerHeaderValue: null,
            inReplyTo: null,
            references: [],
            rawMimeLocator: null,
          },
          {
            id: 'message-substring',
            transportId: 'transport-historical',
            ingestMailboxId: null,
            uidl: 'uidl-substring',
            threadId: null,
            messageThreadId: null,
            resolvedThreadId: null,
            threadTransportId: null,
            messageId: '<substring@example.test>',
            receivedAt: '2026-08-22T10:30:00.000Z',
            sentAt: null,
            subject: 'Synthetic substring candidate',
            body: 'Synthetic substring body',
            direction: 'inbound',
            fromAddress: 'joann@example.test',
            toAddresses: [],
            ccAddresses: [],
            bccAddresses: [],
            ownerHeaderValue: null,
            inReplyTo: null,
            references: [],
            rawMimeLocator: null,
          },
        ],
      }),
    );
    const { reader } = createReader(fake, {
      designatedAddresses: [designatedExactAddress],
    });
    const result = await createThreadCorpusSnapshotLoader(reader)({
      centurionTransportId,
      designatedTransportId,
      designatedIngestMailboxIds: [designatedIngestMailboxId],
      designatedAddresses: [designatedExactAddress],
    });
    const messages = queryContaining(fake.queries, 'FROM message AS m');

    expect(messages.values).toContainEqual(
      expect.arrayContaining([designatedExactAddress]),
    );
    expect(messages.values.flat()).not.toContain('joann@example.test');
    expect(messages.text).toContain(
      "substring(m.from_address FROM '<[[:space:]]*([^<>]+)[[:space:]]*>')",
    );
    expect(messages.text).toContain(
      "substring(address.value FROM '<[[:space:]]*([^<>]+)[[:space:]]*>')",
    );
    expect(messages.text).not.toMatch(/\b(position|unnest|like)\b/i);
    expect(sourceRows(result).map((row) => row.sourceRowId)).toContain('message-display-address');
    expect(sourceRows(result).map((row) => row.sourceRowId)).not.toContain('message-substring');
  });

  it('uses selected historical message transports for queue evidence', async () => {
    const historicalTransportId = 'transport-historical';
    const fake = createFakePostgresClient((text) =>
      rowsForSnapshot(text, {
        messages: [
          {
            id: 'message-historical',
            transportId: historicalTransportId,
            ingestMailboxId: null,
            uidl: 'uidl-historical',
            threadId: 'thread-historical',
            messageThreadId: 'thread-historical',
            resolvedThreadId: 'thread-historical',
            threadTransportId: historicalTransportId,
            messageId: '<historical@example.test>',
            receivedAt: '2026-08-22T10:45:00.000Z',
            sentAt: '2026-08-22T10:46:00.000Z',
            subject: 'Synthetic historical subject',
            body: 'Synthetic historical body',
            direction: 'outbound',
            fromAddress: 'Desk <desk@example.test>',
            toAddresses: [designatedAddress],
            ccAddresses: [],
            bccAddresses: [],
            ownerHeaderValue: null,
            inReplyTo: null,
            references: [],
            rawMimeLocator: null,
          },
        ],
        queue: [
          {
            messageId: 'message-historical',
            transportId: historicalTransportId,
            status: 'sent',
          },
        ],
      }),
    );

    const { result } = await loadSnapshot(fake);
    const queue = queryContaining(fake.queries, 'FROM outbound_send_queue AS q');
    const historical = sourceRows(result).find(
      (row) => row.sourceRowId === 'message-historical',
    );

    expect(queue.values).toContainEqual(expect.arrayContaining([historicalTransportId]));
    expect(historical?.privateMessage?.outboundDelivery).toEqual({
      queueState: 'sent',
      deliveryStatus: 'smtp_accepted',
    });
  });

  it('rejects retained snapshot sessions after their callback exits', async () => {
    const fake = createFakePostgresClient((text) => rowsForSnapshot(text));
    const { reader } = createReader(fake);
    let retainedRead: (() => Promise<unknown>) | undefined;

    await reader.withRepeatableReadOnly(async (session) => {
      await session.discoverSourceScopes();
      retainedRead = () => session.readMessages();
    });
    const queryCount = fake.queries.length;

    await expect(retainedRead!()).rejects.toThrow(/^Snapshot session is inactive$/);
    expect(fake.queries).toHaveLength(queryCount);
  });

  it('keeps transaction open for unawaited registered reads', async () => {
    let resolveMessageRows: ((rows: readonly FakeRow[]) => void) | undefined;
    let signalMessageQuery: (() => void) | undefined;
    const messageQueryStarted = new Promise<void>((resolve) => {
      signalMessageQuery = resolve;
    });
    const messageRows = new Promise<readonly FakeRow[]>((resolve) => {
      resolveMessageRows = resolve;
    });
    const fake = createFakePostgresClient((text) => {
      if (/FROM message AS m/i.test(text)) {
        signalMessageQuery!();
        return messageRows;
      }
      return rowsForSnapshot(text);
    });
    const { reader } = createReader(fake);
    let retainedRead: (() => Promise<unknown>) | undefined;
    let unawaitedRead: Promise<unknown> | undefined;

    const snapshot = reader.withRepeatableReadOnly(async (session) => {
      retainedRead = () => session.readMessages();
      unawaitedRead = session.readMessages();
    });
    await messageQueryStarted;
    const messageQuery = queryContaining(fake.queries, 'FROM message AS m');
    let snapshotSettled = false;
    void snapshot.then(() => {
      snapshotSettled = true;
    });

    expect(messageQuery.insideTransaction).toBe(true);
    await Promise.resolve();
    expect(snapshotSettled).toBe(false);

    resolveMessageRows!(rowsForSnapshot('FROM message AS m'));
    await snapshot;
    await unawaitedRead;
    await expect(retainedRead!()).rejects.toThrow(/^Snapshot session is inactive$/);
  });

  it('uses HTML body when text body is blank', async () => {
    const fake = createFakePostgresClient((text) => rowsForSnapshot(text));

    await loadSnapshot(fake);
    const messages = queryContaining(fake.queries, 'FROM message AS m');

    expect(messages.text).toContain(
      `COALESCE(NULLIF(m.text_body, ''), m.html_body, '') AS "body"`,
    );
  });

  it('keeps missing threads unresolved and rejects known cross-transport ownership', async () => {
    const fake = createFakePostgresClient((text) =>
      rowsForSnapshot(text, {
        messages: [
          {
            id: 'message-unthreaded',
            transportId: centurionTransportId,
            ingestMailboxId: null,
            uidl: 'uidl-unthreaded',
            threadId: null,
            messageThreadId: null,
            resolvedThreadId: null,
            threadTransportId: null,
            messageId: '<unthreaded@example.test>',
            receivedAt: '2026-08-22T10:50:00.000Z',
            sentAt: null,
            subject: 'Synthetic unthreaded subject',
            body: 'Synthetic unthreaded body',
            direction: 'inbound',
            fromAddress: 'guest@example.test',
            toAddresses: [],
            ccAddresses: [],
            bccAddresses: [],
            ownerHeaderValue: null,
            inReplyTo: null,
            references: [],
            rawMimeLocator: null,
          },
          {
            id: 'message-missing-thread',
            transportId: centurionTransportId,
            ingestMailboxId: null,
            uidl: 'uidl-missing-thread',
            threadId: 'thread-missing',
            messageThreadId: 'thread-missing',
            resolvedThreadId: null,
            threadTransportId: null,
            messageId: '<missing-thread@example.test>',
            receivedAt: '2026-08-22T10:51:00.000Z',
            sentAt: null,
            subject: 'Synthetic missing thread subject',
            body: 'Synthetic missing thread body',
            direction: 'inbound',
            fromAddress: 'guest@example.test',
            toAddresses: [],
            ccAddresses: [],
            bccAddresses: [],
            ownerHeaderValue: null,
            inReplyTo: null,
            references: [],
            rawMimeLocator: null,
          },
          {
            id: 'message-cross-transport',
            transportId: centurionTransportId,
            ingestMailboxId: null,
            uidl: 'uidl-cross-transport',
            threadId: 'thread-cross-transport',
            messageThreadId: 'thread-cross-transport',
            resolvedThreadId: 'thread-cross-transport',
            threadTransportId: 'transport-other',
            messageId: '<cross-transport@example.test>',
            receivedAt: '2026-08-22T10:52:00.000Z',
            sentAt: null,
            subject: 'Synthetic cross transport subject',
            body: 'Synthetic cross transport body',
            direction: 'inbound',
            fromAddress: 'guest@example.test',
            toAddresses: [],
            ccAddresses: [],
            bccAddresses: [],
            ownerHeaderValue: null,
            inReplyTo: null,
            references: [],
            rawMimeLocator: null,
          },
        ],
      }),
    );

    const { result } = await loadSnapshot(fake);
    const messages = queryContaining(fake.queries, 'FROM message AS m');
    const retained = sourceRows(result);

    expect(messages.text).toMatch(/LEFT JOIN mail_thread AS t ON t\.id = m\.thread_id/i);
    expect(messages.text).toMatch(
      /\(t\.id IS NULL OR m\.transport_id IS NULL OR t\.transport_id IS NULL OR t\.transport_id = m\.transport_id\)/i,
    );
    expect(retained.map((row) => row.sourceRowId).sort()).toEqual([
      'message-a',
      'message-b',
      'message-missing-thread',
      'message-unthreaded',
    ]);
    expect(
      retained
        .filter((row) =>
          ['message-missing-thread', 'message-unthreaded'].includes(row.sourceRowId),
        )
        .every((row) => row.threadId === null),
    ).toBe(true);
  });

  it('retains null ownership as unresolved and excludes only known mismatches', async () => {
    const fake = createFakePostgresClient((text) =>
      rowsForSnapshot(text, {
        messages: [
          {
            id: 'message-null-message-owner',
            transportId: null,
            ingestMailboxId: null,
            uidl: 'uidl-null-message-owner',
            threadId: 'thread-null-message-owner',
            messageThreadId: 'thread-null-message-owner',
            resolvedThreadId: 'thread-null-message-owner',
            threadTransportId: centurionTransportId,
            messageId: '<null-message-owner@example.test>',
            receivedAt: '2026-08-22T10:53:00.000Z',
            sentAt: null,
            subject: 'Synthetic null message owner',
            body: 'Synthetic null message owner body',
            direction: 'inbound',
            fromAddress: 'guest@example.test',
            toAddresses: [designatedAddress],
            ccAddresses: [],
            bccAddresses: [],
            ownerHeaderValue: null,
            inReplyTo: null,
            references: [],
            rawMimeLocator: null,
          },
          {
            id: 'message-null-thread-owner',
            transportId: centurionTransportId,
            ingestMailboxId: null,
            uidl: 'uidl-null-thread-owner',
            threadId: 'thread-null-thread-owner',
            messageThreadId: 'thread-null-thread-owner',
            resolvedThreadId: 'thread-null-thread-owner',
            threadTransportId: null,
            messageId: '<null-thread-owner@example.test>',
            receivedAt: '2026-08-22T10:54:00.000Z',
            sentAt: null,
            subject: 'Synthetic null thread owner',
            body: 'Synthetic null thread owner body',
            direction: 'inbound',
            fromAddress: 'guest@example.test',
            toAddresses: [],
            ccAddresses: [],
            bccAddresses: [],
            ownerHeaderValue: null,
            inReplyTo: null,
            references: [],
            rawMimeLocator: null,
          },
        ],
      }),
    );

    const { result } = await loadSnapshot(fake);
    const messages = queryContaining(fake.queries, 'FROM message AS m');
    const nullOwnershipRows = sourceRows(result).filter((row) =>
      ['message-null-message-owner', 'message-null-thread-owner'].includes(row.sourceRowId),
    );

    expect(messages.text).toMatch(
      /\(t\.id IS NULL OR m\.transport_id IS NULL OR t\.transport_id IS NULL OR t\.transport_id = m\.transport_id\)/i,
    );
    expect(nullOwnershipRows.map((row) => row.sourceRowId).sort()).toEqual([
      'message-null-message-owner',
      'message-null-thread-owner',
    ]);
    expect(nullOwnershipRows.every((row) => row.threadId === null)).toBe(true);
  });

  it('keeps message relations separate and maps malformed delivery evidence conservatively', async () => {
    const fake = createFakePostgresClient((text) => rowsForSnapshot(text));

    const { result } = await loadSnapshot(fake);
    const attachments = queryContaining(fake.queries, 'FROM attachment AS a');
    const draftRevisions = queryContaining(fake.queries, 'FROM mail_draft AS d');
    const queue = queryContaining(fake.queries, 'FROM outbound_send_queue AS q');
    const byId = new Map(sourceRows(result).map((row) => [
      row.sourceRowId,
      row,
    ]));

    expect(attachments.text).not.toMatch(/\bJOIN\b/i);
    expect(attachments.text).toMatch(/a\.s3_key AS "s3Key"/i);
    expect(attachments.values).toContainEqual(['message-a', 'message-b']);
    expect(draftRevisions.text).not.toMatch(
      /\b(to_addresses|cc_addresses|bcc_addresses|text_body|html_body|attachments|s3_key)\b/i,
    );
    expect(queue.text).toMatch(/q\.message_id AS "messageId"/i);
    expect(queue.text).toMatch(/q\.transport_id AS "transportId"/i);
    expect(queue.text).toMatch(/q\.status AS "status"/i);
    expect(queue.text).not.toMatch(/\b(smtp_payload|last_error)\b/i);

    expect(byId.size).toBe(2);
    expect(byId.get('message-a')?.privateMessage?.attachments).toEqual([
      {
        id: 'attachment-a',
        messageId: 'message-a',
        filename: 'synthetic-a.pdf',
        contentType: 'application/pdf',
        byteSize: 42,
      },
      {
        id: 'attachment-b',
        messageId: 'message-a',
        filename: 'synthetic-b.txt',
        contentType: 'text/plain',
        byteSize: 7,
      },
    ]);
    expect(byId.get('message-b')?.privateMessage?.attachments).toEqual([]);
    expect(byId.get('message-a')?.privateMessage?.draftRevisionLinks).toEqual([
      {
        messageId: 'message-a',
        draftId: 'draft-a',
        revisionId: 'revision-a',
      },
    ]);
    expect(byId.get('message-a')?.privateMessage?.outboundDelivery).toEqual({
      queueState: 'sent',
      deliveryStatus: 'smtp_accepted',
    });
    expect(byId.get('message-b')?.privateMessage?.outboundDelivery).toEqual({
      queueState: 'unknown',
      deliveryStatus: 'not_claimed',
    });
    expect(byId.get('message-a')?.receivedAt).toBe('2026-08-22T09:00:00.000Z');
    expect(byId.get('message-a')?.privateMessage?.addresses).toEqual({
      from: ['desk@example.test'],
      to: ['guest@example.test'],
      cc: ['cc@example.test'],
      bcc: [],
    });
    expect(byId.get('message-a')?.privateMessage?.originalAddresses).toEqual({
      from: ['Desk <desk@example.test>'],
      to: ['Guest <guest@example.test>'],
      cc: ['cc@example.test'],
      bcc: [],
    });
    expect(byId.get('message-a')?.privateMessage?.rawMime).toEqual({
      locator: 'raw/synthetic-a',
      status: 'pending_hydration',
    });
    expect(byId.get('message-b')?.privateMessage?.rawMime).toEqual({
      locator: null,
      status: 'missing',
    });
    expect(
      (
        result as unknown as {
          attachmentLocators: Array<{
            attachmentId: string;
            messageId: string;
            s3Key: string;
            mimeType: string;
            sizeBytes: number;
          }>;
        }
      ).attachmentLocators,
    ).toEqual([
      {
        attachmentId: 'attachment-a',
        messageId: 'message-a',
        s3Key: 's3/synthetic-attachment-a',
        mimeType: 'application/pdf',
        sizeBytes: 42,
      },
      {
        attachmentId: 'attachment-b',
        messageId: 'message-a',
        s3Key: 's3/synthetic-attachment-b',
        mimeType: 'text/plain',
        sizeBytes: 7,
      },
    ]);
  });

  it('keeps quarantine route evidence separate and leaves uncertain rows unscoped', async () => {
    const fake = createFakePostgresClient((text) => rowsForSnapshot(text));

    const { result } = await loadSnapshot(fake);
    const quarantine = queryContaining(fake.queries, 'FROM mail_ingest_quarantine AS q');
    const quarantineIds = [
      ...result.formatted.quarantineRecords.flatMap((record) =>
        record.sourceRows.map((row) => row.sourceRowId),
      ),
      ...result.unscopedQuarantineRows.map((row) => row.id),
    ];

    expect(quarantine.text).toMatch(/q\.ingest_mailbox_id = ANY\(\$\d+\)/i);
    expect(quarantine.text).toMatch(/lower\(q\.owner_header_value\) = ANY\(\$\d+\)/i);
    expect(quarantine.text).not.toMatch(/\bJOIN\s+message\b/i);
    expect(quarantineIds.sort()).toEqual([
      'quarantine:quarantine-ingest',
      'quarantine:quarantine-owner',
      'quarantine:quarantine-uncertain',
    ]);
    expect(result.formatted.quarantineRecords).toHaveLength(2);
    expect(result.unscopedQuarantineRows).toHaveLength(1);
    expect(result.unscopedQuarantineRows[0]).toMatchObject({
      id: 'quarantine:quarantine-uncertain',
      transportId: null,
      ingestMailboxId: null,
      threadId: null,
      messageId: null,
      body: '',
    });
  });

  it('enforces max-one strict SSL construction and caller-controlled close', async () => {
    const fake = createFakePostgresClient((text) => rowsForSnapshot(text));
    const { created, reader } = createReader(fake, { asOf: snapshotAsOf });

    expect(created).toMatchObject({
      databaseUrl: 'postgresql://localhost:5432/centurion-test',
      options: {
        max: 1,
        ssl: false,
      },
    });
    await reader.withRepeatableReadOnly(async () => {
      await expect(reader.close()).rejects.toThrow(/active snapshot/i);
    });
    expect(fake.endCalls).toBe(0);
    await reader.close();
    await reader.close();
    expect(fake.endCalls).toBe(1);
  });

  it('keeps adapter source read-only and free of external capability calls', () => {
    const sourcePath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-postgres-reader.ts', import.meta.url),
    );
    const source = readFileSync(sourcePath, 'utf8');

    expect(readerSourceGuardViolations(source)).toEqual([]);
    expect(source).toContain('getPostgresSslOptions(options.databaseUrl)');
    expect(source).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|LOCK|COPY|CALL|DO)\b/i,
    );
    expect(source).not.toMatch(/\b(fetch|require|eval|getS3Storage|rehydrateRawMime)\b/i);
    expect(source).not.toMatch(/console\.(log|error|warn)/);
    expect(source).not.toContain('.unsafe');
  });

  it('uses the same AST import guard to reject dynamic S3 imports', () => {
    expect(readerSourceGuardViolations("import('@aws-sdk/client-s3');")).toContain(
      'Dynamic import is prohibited',
    );
  });

  it.each([
    "console.info('synthetic');",
    'console.table({ synthetic: true });',
    'console.dir({ synthetic: true });',
    "console['info']('synthetic');",
  ])('rejects console member output access: %s', (fixture) => {
    expect(readerSourceGuardViolations(fixture)).toContain('console output is prohibited');
  });
});
