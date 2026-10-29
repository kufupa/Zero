import {
  createThreadCorpusPostgresReader,
  type ThreadCorpusPostgresClient,
} from '../src/ops/centurion-thread-corpus-postgres-reader';
import {
  createThreadCorpusSnapshotLoader,
  type ThreadCorpusSnapshotLoadResult,
} from '../src/ops/centurion-thread-corpus-snapshot';
import { describe, expect, it } from 'vitest';

const AS_OF = '2026-08-22T12:00:00.000Z';
const ACTIVE_TRANSPORT_IDS = ['transport-a', 'transport-z'] as const;
const INACTIVE_TRANSPORT_ID = 'transport-disabled';

type Query = {
  text: string;
  values: unknown[];
  insideTransaction: boolean;
};

type FakePostgres = {
  client: ThreadCorpusPostgresClient;
  beginOptions: string[];
  queries: Query[];
};

type FakeRow = Record<string, unknown>;

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
  receivedAt?: string;
}): FakeRow {
  const threadId = `thread-${input.id}`;
  return {
    id: input.id,
    transportId: input.transportId,
    messageThreadId: threadId,
    resolvedThreadId: threadId,
    threadTransportId: input.threadTransportId ?? input.transportId,
    messageId: `<${input.id}@example.test>`,
    receivedAt: input.receivedAt ?? '2026-08-22T11:00:00.000Z',
    sentAt: '2026-08-22T11:01:00.000Z',
    subject: 'Synthetic subject',
    body: 'Synthetic body',
    direction: 'outbound',
    fromAddress: 'desk@example.test',
    toAddresses: ['guest@example.test'],
    ccAddresses: [],
    bccAddresses: [],
    inReplyTo: null,
    references: [],
    rawMimeLocator: null,
  };
}

function createFakePostgres(
  input: {
    activeTransportRows?: readonly FakeRow[];
    attachments?: readonly FakeRow[];
    messages?: readonly FakeRow[];
  } = {},
): FakePostgres {
  const beginOptions: string[] = [];
  const queries: Query[] = [];
  let insideTransaction = false;
  let client: ThreadCorpusPostgresClient;
  const activeTransportRows = input.activeTransportRows ?? [
    { id: 'transport-z' },
    { id: 'transport-a' },
  ];
  const messages = input.messages ?? [
    messageRow({ id: 'message-z', transportId: 'transport-z' }),
    messageRow({ id: 'message-a', transportId: 'transport-a' }),
    messageRow({
      id: 'message-thread-mismatch',
      transportId: 'transport-a',
      threadTransportId: 'transport-z',
    }),
  ];
  const attachments = input.attachments ?? [];

  const query = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<readonly FakeRow[]> => {
    const text = queryText(strings);
    queries.push({ text, values, insideTransaction });
    if (/CURRENT_TIMESTAMP/i.test(text)) return [{ asOf: AS_OF }];
    if (/FROM mailbox_transport/i.test(text)) {
      const requestedIds = values
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .filter((entry): entry is string => typeof entry === 'string');
      if (requestedIds.length === 0) return activeTransportRows;
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
    if (/FROM attachment AS a/i.test(text)) return attachments;
    if (/FROM mail_draft AS d/i.test(text)) return [];
    if (/FROM outbound_send_queue AS q/i.test(text)) return [];
    throw new Error('Unexpected synthetic query');
  };

  const begin = async <T>(
    options: string,
    load: (connection: ThreadCorpusPostgresClient) => Promise<T>,
  ): Promise<T> => {
    beginOptions.push(options);
    insideTransaction = true;
    try {
      return await load(client);
    } finally {
      insideTransaction = false;
    }
  };

  client = Object.assign(query, {
    begin,
    async end() {},
  }) as unknown as ThreadCorpusPostgresClient;

  return { client, beginOptions, queries };
}

function createReader(
  fake: FakePostgres,
  transportIds: readonly string[] = ACTIVE_TRANSPORT_IDS,
) {
  return createThreadCorpusPostgresReader({
    databaseUrl: 'postgresql://localhost:5432/synthetic',
    transportIds: [...transportIds],
    clientFactory: () => fake.client,
  });
}

async function loadSnapshot(fake: FakePostgres): Promise<ThreadCorpusSnapshotLoadResult> {
  const reader = createReader(fake);
  const load = createThreadCorpusSnapshotLoader(
    reader,
  ) as unknown as () => Promise<ThreadCorpusSnapshotLoadResult>;
  return await load();
}

function queryContaining(queries: readonly Query[], fragment: string): Query {
  const query = queries.find((candidate) => candidate.text.includes(fragment));
  if (!query) throw new Error(`Missing query for ${fragment}`);
  return query;
}

function sourceRows(result: ThreadCorpusSnapshotLoadResult): Array<Record<string, unknown>> {
  const formatted = result.formatted as unknown as {
    threads: Array<{
      messages: Array<{ sourceRows: Array<Record<string, unknown>> }>;
    }>;
  };
  return formatted.threads.flatMap((thread) =>
    thread.messages.flatMap((message) => message.sourceRows),
  );
}

describe('connected mailbox corpus PostgreSQL reader', () => {
  it('rejects reader construction when explicit transport IDs are omitted', () => {
    expect(() =>
      createThreadCorpusPostgresReader({
        databaseUrl: 'postgresql://localhost:5432/synthetic',
      }),
    ).toThrow('Explicit transport scope is required');
  });

  it('seals only requested active transport IDs, excludes inactive membership, and preserves each row transport ID', async () => {
    const fake = createFakePostgres();

    const result = await loadSnapshot(fake);
    const activeScope = queryContaining(fake.queries, 'FROM mailbox_transport');
    const messages = queryContaining(fake.queries, 'FROM message AS m');
    const rows = sourceRows(result);

    expect(fake.beginOptions).toEqual(['isolation level repeatable read read only']);
    expect(fake.queries.every((query) => query.insideTransaction)).toBe(true);
    expect((result as unknown as { activeTransportScope: unknown }).activeTransportScope).toEqual({
      asOf: AS_OF,
      transportIds: ACTIVE_TRANSPORT_IDS,
    });
    expect(activeScope.text).toMatch(/WHERE\s+is_active\s*=\s*true/i);
    expect(activeScope.text).toMatch(/id\s*=\s*ANY/i);
    expect(activeScope.values).toContainEqual([...ACTIVE_TRANSPORT_IDS]);
    expect(activeScope.text).toMatch(/ORDER BY\s+id/i);
    expect(activeScope.text).not.toMatch(/\b(email|owner_header_value|ingest_mailbox)\b/i);
    expect(messages.values).toContainEqual([...ACTIVE_TRANSPORT_IDS]);
    expect(messages.values.flat()).not.toContain(INACTIVE_TRANSPORT_ID);
    expect(messages.text).toMatch(/m\.transport_id = ANY\(\$\d+\)/i);
    expect(messages.text).toMatch(/COALESCE\(m\.received_at, m\.sent_at, m\.created_at\) < \$\d+/i);
    expect(messages.text).not.toMatch(/\b(ingest_mailbox_id|owner_header_value)\b/i);
    expect(messages.text).toMatch(
      /\(t\.id IS NULL OR m\.transport_id IS NULL OR t\.transport_id IS NULL OR t\.transport_id = m\.transport_id\)/i,
    );
    expect(fake.queries.some((query) => /mail_ingest_quarantine/i.test(query.text))).toBe(false);
    expect(rows.map((row) => row.sourceRowId).sort()).toEqual(['message-a', 'message-z']);
    expect(rows.map((row) => row.scopeMembership)).toEqual([
      ['active_transport'],
      ['active_transport'],
    ]);
    expect(rows.find((row) => row.sourceRowId === 'message-z')?.privateMessage).toMatchObject({
      sourceMetadata: { transportId: 'transport-z' },
    });
  });

  it('propagates attachment filename, inline, and content ID metadata through the reader', async () => {
    const fake = createFakePostgres({
      attachments: [
        {
          id: 'attachment-inline',
          messageId: 'message-a',
          filename: 'inline.png',
          contentType: 'image/png',
          byteSize: 12,
          s3Key: 'attachments/message-a/inline.png',
          inline: true,
          contentId: '<inline@example.test>',
        },
      ],
    });

    const result = await loadSnapshot(fake);
    const message = sourceRows(result).find((row) => row.sourceRowId === 'message-a');
    const attachmentsQuery = queryContaining(fake.queries, 'FROM attachment AS a');

    expect(attachmentsQuery.text).toMatch(/a\.is_inline\s+AS\s+"inline"/i);
    expect(attachmentsQuery.text).toMatch(/a\.content_id\s+AS\s+"contentId"/i);

    expect(message?.privateMessage).toMatchObject({
      attachments: [
        {
          id: 'attachment-inline',
          messageId: 'message-a',
          filename: 'inline.png',
          contentType: 'image/png',
          byteSize: 12,
          inline: true,
          contentId: '<inline@example.test>',
        },
      ],
    });
    expect(result.attachmentLocators).toEqual([
      {
        attachmentId: 'attachment-inline',
        messageId: 'message-a',
        s3Key: 'attachments/message-a/inline.png',
        mimeType: 'image/png',
        sizeBytes: 12,
        filename: 'inline.png',
        inline: true,
        contentId: '<inline@example.test>',
      },
    ]);
  });

  it('keeps valid attachment descriptors and reports malformed rows opaquely', async () => {
    const fake = createFakePostgres({
      attachments: [
        {
          id: 'attachment-valid',
          messageId: 'message-a',
          filename: 'valid.txt',
          contentType: 'text/plain',
          byteSize: '12',
          s3Key: 'attachments/message-a/valid.txt',
        },
        {
          id: 'attachment-malformed',
          messageId: 'message-a',
          filename: 'malformed.txt',
          contentType: 'text/plain',
          byteSize: 12,
          s3Key: '',
        },
      ],
    });

    const result = await loadSnapshot(fake);

    expect(result.attachmentLocators).toEqual([
      {
        attachmentId: 'attachment-valid',
        messageId: 'message-a',
        s3Key: 'attachments/message-a/valid.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
        filename: 'valid.txt',
      },
    ]);
    expect(
      (result.safeSummary as unknown as Record<string, unknown>)
        .malformedAttachmentDescriptorCount,
    ).toBe(1);
  });

  it('constrains every relation query by sealed transports and snapshot asOf', async () => {
    const fake = createFakePostgres();

    await loadSnapshot(fake);

    const attachments = queryContaining(fake.queries, 'FROM attachment AS a');
    const drafts = queryContaining(fake.queries, 'FROM mail_draft AS d');
    const queue = queryContaining(fake.queries, 'FROM outbound_send_queue AS q');

    for (const relation of [attachments, drafts, queue]) {
      expect(relation.values).toContainEqual([...ACTIVE_TRANSPORT_IDS]);
      expect(relation.values).toContain(AS_OF);
      expect(relation.text).toMatch(/transport_id = ANY\(\$\d+\)/i);
      expect(relation.text).toMatch(/created_at < \$\d+/i);
      expect(relation.text).toMatch(/message_id = ANY\(\$\d+\)/i);
    }
    expect(queue.text).toMatch(/q\.transport_id = m\.transport_id/i);
    expect(drafts.text).toMatch(/mail_draft_revision/i);
  });

  it('exports only transport-a when transport-a is the explicit reader scope', async () => {
    const fake = createFakePostgres({
      messages: [messageRow({ id: 'message-a', transportId: 'transport-a' })],
    });
    const reader = createReader(fake, ['transport-a']);
    const load = createThreadCorpusSnapshotLoader(reader);
    const result = await load();
    const rows = sourceRows(result);
    const messages = queryContaining(fake.queries, 'FROM message AS m');

    expect(messages.values).toContainEqual(['transport-a']);
    expect(rows.map((row) => row.sourceRowId)).toEqual(['message-a']);
    expect(rows.every((row) => row.privateMessage?.sourceMetadata?.transportId === 'transport-a')).toBe(
      true,
    );
  });

  it('rejects unknown requested transport IDs before message, relation, or corpus reads', async () => {
    const fake = createFakePostgres();
    const reader = createReader(fake, ['transport-a', 'transport-missing']);

    await expect(createThreadCorpusSnapshotLoader(reader)()).rejects.toThrow(
      'Requested transport scope is not active',
    );

    expect(fake.queries.some((query) => /FROM message AS m/i.test(query.text))).toBe(false);
  });

  it('rejects empty active scope before message, relation, or corpus reads', async () => {
    const fake = createFakePostgres({ activeTransportRows: [] });
    const reader = createReader(fake, ['transport-a']);

    await expect(createThreadCorpusSnapshotLoader(reader)()).rejects.toThrow(
      'Requested transport scope is not active',
    );

    expect(fake.queries.some((query) => /FROM message AS m/i.test(query.text))).toBe(false);
    expect(fake.queries.some((query) => /FROM attachment AS a/i.test(query.text))).toBe(false);
    expect(fake.queries.some((query) => /FROM mail_draft AS d/i.test(query.text))).toBe(false);
    expect(fake.queries.some((query) => /FROM outbound_send_queue AS q/i.test(query.text))).toBe(
      false,
    );
  });

  it('excludes known thread-transport mismatches from returned source rows', async () => {
    const fake = createFakePostgres();

    const result = await loadSnapshot(fake);

    expect(sourceRows(result).map((row) => row.sourceRowId)).not.toContain(
      'message-thread-mismatch',
    );
  });
});
