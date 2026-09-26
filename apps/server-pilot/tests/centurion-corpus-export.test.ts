import {
  CENTURION_TRANSPORT_ID,
  CENTURION_WINDOW_END_UTC,
  CENTURION_WINDOW_START_UTC,
  createThreadCorpusPostgresReader,
  type CenturionCorpusMessageRow,
  type CenturionCorpusSnapshot,
  type ThreadCorpusPostgresClient,
} from '../src/ops/centurion-thread-corpus-postgres-reader';
import {
  createCenturionNineDayCorpusExportCommand,
  type LiveCenturionNineDayCorpusDependencies,
} from '../scripts/export-centurion-nine-day-corpus-live';
import { describe, expect, it } from 'vitest';

const AS_OF = '2026-09-17T01:00:00.000Z';
const SCRIPT_PATH =
  '/synthetic/zero/apps/server-pilot/scripts/export-centurion-nine-day-corpus-live.ts';
const REPO_ROOT = '/synthetic/zero';
const SNAPSHOT_ID = 'centurion-nine-day-123e4567-e89b-12d3-a456-426614174000';
const OUT_DIR = `${REPO_ROOT}/.private/connected-mailbox-corpus/${SNAPSHOT_ID}`;

type Query = {
  text: string;
  values: unknown[];
  insideTransaction: boolean;
};

type FakeRow = Record<string, unknown>;

function queryText(strings: TemplateStringsArray): string {
  return strings.reduce(
    (text, fragment, index) =>
      `${text}${fragment}${index < strings.length - 1 ? `$${index + 1}` : ''}`,
    '',
  );
}

function messageRow(
  input: Partial<{
    id: string;
    transportId: string;
    threadId: string | null;
    messageId: string | null;
    direction: string;
    receivedAt: string | null;
    sentAt: string | null;
    createdAt: string | null;
    fromAddress: string;
    toAddresses: string[];
    queueStatus: string | null;
  }> = {},
): FakeRow {
  const id = input.id ?? 'message-main';
  return {
    id,
    transportId: input.transportId ?? CENTURION_TRANSPORT_ID,
    messageThreadId: input.threadId ?? 'thread-main',
    resolvedThreadId: input.threadId === null ? null : (input.threadId ?? 'thread-main'),
    threadTransportId: input.transportId ?? CENTURION_TRANSPORT_ID,
    messageId: input.messageId === undefined ? `<${id}@example.test>` : input.messageId,
    direction: input.direction ?? 'inbound',
    subject: 'Synthetic subject',
    textBody: `complete text body for ${id}`,
    htmlBody: `<p>complete html body for ${id}</p>`,
    fromAddress: input.fromAddress ?? 'guest@example.test',
    toAddresses: input.toAddresses ?? ['centurion@example.test'],
    ccAddresses: ['copy@example.test'],
    bccAddresses: [],
    receivedAt: input.receivedAt === undefined ? '2026-09-10T10:00:00.000Z' : input.receivedAt,
    sentAt: input.sentAt === undefined ? null : input.sentAt,
    createdAt: input.createdAt === undefined ? '2026-09-10T09:00:00.000Z' : input.createdAt,
    inReplyTo: '<parent@example.test>',
    references: ['<parent@example.test>'],
    rawMimeLocator: `raw/${id}`,
    queueStatus: input.queueStatus ?? null,
  };
}

function createFakePostgres(
  input: {
    messages?: readonly FakeRow[];
    attachments?: readonly FakeRow[];
    transportRows?: readonly FakeRow[];
  } = {},
): {
  client: ThreadCorpusPostgresClient;
  queries: Query[];
  beginOptions: string[];
} {
  const queries: Query[] = [];
  const beginOptions: string[] = [];
  let insideTransaction = false;
  let client: ThreadCorpusPostgresClient;
  const messages = input.messages ?? [messageRow()];
  const attachments = input.attachments ?? [];
  const transportRows = input.transportRows ?? [
    {
      id: CENTURION_TRANSPORT_ID,
      email: 'centurion@example.test',
      ownerHeaderValue: 'centurion@example.test',
      sendFromConfig: null,
      isActive: true,
    },
  ];

  const query = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<readonly FakeRow[]> => {
    const text = queryText(strings);
    queries.push({ text, values, insideTransaction });
    if (/CURRENT_TIMESTAMP/i.test(text)) return [{ asOf: AS_OF }];
    if (/FROM mailbox_transport/i.test(text)) return transportRows;
    if (/FROM message AS m/i.test(text)) return messages;
    if (/FROM attachment AS a/i.test(text)) return attachments;
    throw new Error(`Unexpected synthetic query: ${text}`);
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

  client = Object.assign(query, { begin, async end() {} }) as unknown as ThreadCorpusPostgresClient;
  return { client, queries, beginOptions };
}

async function readCenturionSnapshot(fake: {
  client: ThreadCorpusPostgresClient;
  queries: Query[];
  beginOptions: string[];
}): Promise<CenturionCorpusSnapshot> {
  const reader = createThreadCorpusPostgresReader({
    databaseUrl: 'fixture://non-production',
    clientFactory: () => fake.client,
  });
  try {
    return await reader.readCenturionSnapshot({
      transportId: CENTURION_TRANSPORT_ID,
      startInclusive: CENTURION_WINDOW_START_UTC,
      endExclusive: CENTURION_WINDOW_END_UTC,
    });
  } finally {
    await reader.close();
  }
}

function messageById(snapshot: CenturionCorpusSnapshot, id: string): CenturionCorpusMessageRow {
  const row = snapshot.messages.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`missing synthetic row ${id}`);
  return row;
}

describe('Centurion nine-day corpus reader', () => {
  it('uses the Johannesburg-converted half-open UTC window, isolates the transport, and marks linked history context-only', async () => {
    const fake = createFakePostgres({
      messages: [
        messageRow({
          id: 'at-start',
          receivedAt: CENTURION_WINDOW_START_UTC,
          createdAt: '2026-09-07T21:59:00.000Z',
        }),
        messageRow({
          id: 'at-end',
          receivedAt: CENTURION_WINDOW_END_UTC,
        }),
        messageRow({
          id: 'older-linked',
          receivedAt: '2026-09-07T21:59:59.000Z',
          threadId: 'thread-main',
        }),
        messageRow({
          id: 'other-transport',
          transportId: 'transport-other',
          receivedAt: '2026-09-10T10:00:00.000Z',
        }),
      ],
    });

    const snapshot = await readCenturionSnapshot(fake);

    expect(fake.beginOptions).toEqual(['isolation level repeatable read read only']);
    expect(fake.queries.every((query) => query.insideTransaction)).toBe(true);
    expect(snapshot.window).toEqual({
      startInclusive: CENTURION_WINDOW_START_UTC,
      endExclusive: CENTURION_WINDOW_END_UTC,
      timezone: 'Africa/Johannesburg',
    });
    expect(snapshot.messages.map((row) => row.id)).toEqual(['at-start', 'older-linked']);
    expect(messageById(snapshot, 'at-start')).toMatchObject({
      eventAt: CENTURION_WINDOW_START_UTC,
      eventAtSource: 'received_at',
      contextOnly: false,
      dailyIncluded: true,
    });
    expect(messageById(snapshot, 'older-linked')).toMatchObject({
      contextOnly: true,
      dailyIncluded: false,
      eventAtSource: 'received_at',
    });

    const messageQuery = fake.queries.find((query) => /FROM message AS m/i.test(query.text));
    expect(messageQuery?.values).toContain(CENTURION_TRANSPORT_ID);
    expect(messageQuery?.text).toMatch(/m\.transport_id\s*=\s*\$\d+/i);
    expect(messageQuery?.values).toContain('2026-09-07T22:00:00.000');
    expect(messageQuery?.values).toContain('2026-09-16T22:00:00.000');
    expect(messageQuery?.text).toMatch(/WITH\s+candidates\s+AS/i);
    expect(messageQuery?.text).toMatch(/in_window_threads/i);
    expect(messageQuery?.text).toMatch(/"eventAt"\s*>=/i);
    expect(messageQuery?.text).toMatch(/"eventAt"\s*<\s*\$\d+/i);
    expect(messageQuery?.text).toMatch(/selected_candidates/i);
    expect(messageQuery?.text).toMatch(/JOIN\s+message\s+AS\s+m\s+ON\s+m\.id\s*=\s*selected\.id/i);
    const candidateSql = messageQuery?.text.match(
      /WITH\s+candidates\s+AS\s*\(([\s\S]*?)\),\s*in_window_threads/i,
    )?.[1];
    expect(candidateSql).toMatch(/m\.id|m\.thread_id|m\.received_at|m\.sent_at|m\.created_at/i);
    expect(candidateSql).not.toMatch(
      /m\.(?:text_body|html_body|from_address|to_addresses|cc_addresses|bcc_addresses|in_reply_to|raw_mime_s3_key)\b/i,
    );
    for (const query of fake.queries) {
      expect(query.text.trim()).toMatch(/^(?:SELECT|WITH\b)/i);
      expect(query.text).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/i,
      );
    }
  });

  it('rejects caller-supplied Centurion bounds that differ from the fixed plan window', async () => {
    const fake = createFakePostgres();
    const reader = createThreadCorpusPostgresReader({
      databaseUrl: 'fixture://non-production',
      clientFactory: () => fake.client,
    });

    await expect(
      reader.readCenturionSnapshot({
        transportId: CENTURION_TRANSPORT_ID,
        startInclusive: '2026-09-08T22:00:00.000Z',
        endExclusive: CENTURION_WINDOW_END_UTC,
      }),
    ).rejects.toThrow(/fixed|window/i);
    expect(fake.beginOptions).toEqual([]);
    expect(fake.queries).toEqual([]);
    await reader.close();
  });

  it('records event timestamp fallback provenance, including missing timestamps', async () => {
    const fake = createFakePostgres({
      messages: [
        messageRow({
          id: 'confirmed-outbound',
          direction: 'outbound',
          sentAt: '2026-09-10T12:00:00.000Z',
          receivedAt: '2026-09-10T11:00:00.000Z',
          queueStatus: 'sent',
          fromAddress: 'centurion@example.test',
          toAddresses: ['guest@example.test'],
        }),
        messageRow({
          id: 'received-preferred',
          receivedAt: '2026-09-10T13:00:00.000Z',
          sentAt: '2026-09-10T14:00:00.000Z',
        }),
        messageRow({
          id: 'sent-fallback',
          receivedAt: null,
          sentAt: '2026-09-10T15:00:00.000Z',
        }),
        messageRow({
          id: 'created-fallback',
          receivedAt: null,
          sentAt: null,
          createdAt: '2026-09-10T16:00:00.000Z',
        }),
        messageRow({
          id: 'missing-event',
          receivedAt: null,
          sentAt: null,
          createdAt: null,
        }),
      ],
    });

    const snapshot = await readCenturionSnapshot(fake);

    expect(messageById(snapshot, 'confirmed-outbound')).toMatchObject({
      eventAt: '2026-09-10T12:00:00.000Z',
      eventAtSource: 'sent_at_confirmed_outbound',
      eventAtFallback: false,
      messageDirection: 'outbound',
      businessDirection: 'outbound',
    });
    expect(messageById(snapshot, 'received-preferred')).toMatchObject({
      eventAt: '2026-09-10T13:00:00.000Z',
      eventAtSource: 'received_at',
      eventAtFallback: false,
    });
    expect(messageById(snapshot, 'sent-fallback')).toMatchObject({
      eventAt: '2026-09-10T15:00:00.000Z',
      eventAtSource: 'sent_at_fallback',
      eventAtFallback: true,
    });
    expect(messageById(snapshot, 'created-fallback')).toMatchObject({
      eventAt: '2026-09-10T16:00:00.000Z',
      eventAtSource: 'created_at',
      eventAtFallback: true,
    });
    expect(messageById(snapshot, 'missing-event')).toMatchObject({
      eventAt: null,
      eventAtSource: 'missing',
      eventAtFallback: true,
      dailyIncluded: false,
    });
  });

  it('preserves duplicate physical rows and complete body, participant, reply, thread, and attachment evidence', async () => {
    const fake = createFakePostgres({
      messages: [
        messageRow({ id: 'physical-a', messageId: '<same@example.test>' }),
        messageRow({ id: 'physical-b', messageId: '<same@example.test>' }),
      ],
      attachments: [
        {
          id: 'attachment-a',
          messageId: 'physical-a',
          filename: 'quote.pdf',
          contentType: 'application/pdf',
          byteSize: 42,
          s3Key: 'attachments/physical-a/quote.pdf',
          inline: false,
          contentId: null,
        },
      ],
    });

    const snapshot = await readCenturionSnapshot(fake);

    expect(snapshot.messages.map((row) => row.id)).toEqual(['physical-a', 'physical-b']);
    expect(messageById(snapshot, 'physical-a')).toMatchObject({
      textBody: 'complete text body for physical-a',
      htmlBody: '<p>complete html body for physical-a</p>',
      from: ['guest@example.test'],
      to: ['centurion@example.test'],
      cc: ['copy@example.test'],
      bcc: [],
      inReplyTo: '<parent@example.test>',
      references: ['<parent@example.test>'],
      threadId: 'thread-main',
      attachmentDescriptors: [
        {
          id: 'attachment-a',
          messageId: 'physical-a',
          filename: 'quote.pdf',
          contentType: 'application/pdf',
          byteSize: 42,
          s3Key: 'attachments/physical-a/quote.pdf',
        },
      ],
    });
  });
});

function makeExportSnapshot(): CenturionCorpusSnapshot {
  return {
    asOf: AS_OF,
    transportId: CENTURION_TRANSPORT_ID,
    window: {
      startInclusive: CENTURION_WINDOW_START_UTC,
      endExclusive: CENTURION_WINDOW_END_UTC,
      timezone: 'Africa/Johannesburg',
    },
    messages: [
      {
        id: 'synthetic-message',
        transportId: CENTURION_TRANSPORT_ID,
        threadId: 'synthetic-thread',
        messageId: '<synthetic@example.test>',
        direction: 'inbound',
        messageDirection: 'inbound',
        businessDirection: 'inbound',
        businessDirectionSource: 'transport_identity',
        subject: 'Synthetic subject',
        textBody: 'Synthetic body',
        htmlBody: '<p>Synthetic body</p>',
        from: ['guest@example.test'],
        to: ['centurion@example.test'],
        cc: [],
        bcc: [],
        receivedAt: '2026-09-10T10:00:00.000Z',
        sentAt: null,
        createdAt: '2026-09-10T09:00:00.000Z',
        eventAt: '2026-09-10T10:00:00.000Z',
        eventAtSource: 'received_at',
        eventAtFallback: false,
        inReplyTo: null,
        references: [],
        rawMimeLocator: 'raw/synthetic-message',
        attachmentDescriptors: [],
        contextOnly: false,
        dailyIncluded: true,
        scope: 'in_window',
      },
    ],
    counts: {
      sourceRowCount: 1,
      includedMessageCount: 1,
      contextOnlyMessageCount: 0,
      missingEventAtCount: 0,
    },
  };
}

function makeExportHarness(
  input: {
    args?: readonly string[];
    preflight?: () => Promise<void>;
    snapshot?: CenturionCorpusSnapshot;
  } = {},
): {
  deps: LiveCenturionNineDayCorpusDependencies;
  calls: string[];
  stdout: string[];
  stderr: string[];
  readerOptions: unknown[];
  writes: unknown[];
} {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const readerOptions: unknown[] = [];
  const writes: unknown[] = [];
  const snapshot = input.snapshot ?? makeExportSnapshot();
  const deps = {
    args: () => input.args ?? [],
    platform: () => 'linux',
    scriptPath: () => SCRIPT_PATH,
    attestImdsV2: async () => true,
    preflightOutputDestination: async (repoRoot: string, outDir: string) => {
      calls.push(`preflight:${repoRoot}:${outDir}`);
      await input.preflight?.();
    },
    uuid: () => SNAPSHOT_ID.slice('centurion-nine-day-'.length),
    environment: () => ({ DATABASE_URL: 'fixture://non-production' }),
    createReader: (options: unknown) => {
      calls.push('createReader');
      readerOptions.push(options);
      return {
        async readCenturionSnapshot(): Promise<CenturionCorpusSnapshot> {
          calls.push('readSnapshot');
          return snapshot;
        },
        async close() {
          calls.push('close');
        },
      };
    },
    writeSnapshot: async (request: unknown) => {
      calls.push('writeSnapshot');
      writes.push(request);
    },
    validateAllocatedDir: () => calls.push('validate'),
    writeStdout: (value: string) => stdout.push(value),
    writeStderr: (value: string) => stderr.push(value),
  } as unknown as LiveCenturionNineDayCorpusDependencies;
  return { deps, calls, stdout, stderr, readerOptions, writes };
}

describe('Centurion nine-day guarded export command', () => {
  it('preflights private output and host attestation before source setup, then passes fixed scope', async () => {
    const harness = makeExportHarness();

    const code = await createCenturionNineDayCorpusExportCommand(harness.deps)();

    expect(code).toBe(0);
    expect(harness.calls).toEqual([
      `preflight:${REPO_ROOT}:${OUT_DIR}`,
      'validate',
      'createReader',
      'readSnapshot',
      'close',
      'writeSnapshot',
    ]);
    expect(harness.readerOptions).toEqual([{ databaseUrl: 'fixture://non-production' }]);
    expect(harness.writes[0]).toMatchObject({
      repoRoot: REPO_ROOT,
      outDir: OUT_DIR,
      snapshotId: SNAPSHOT_ID,
      transportId: CENTURION_TRANSPORT_ID,
      window: {
        startInclusive: CENTURION_WINDOW_START_UTC,
        endExclusive: CENTURION_WINDOW_END_UTC,
        timezone: 'Africa/Johannesburg',
      },
    });
    expect(harness.stderr).toEqual([]);
    expect(harness.stdout.join('')).not.toContain('Synthetic body');
    expect(harness.stdout.join('')).toContain('"includedMessageCount":1');
  });

  it('fails closed at private-output preflight without creating a reader', async () => {
    const harness = makeExportHarness({
      preflight: async () => {
        throw new Error('unsafe private output');
      },
    });

    const code = await createCenturionNineDayCorpusExportCommand(harness.deps)();

    expect(code).toBe(1);
    expect(harness.calls).toEqual([`preflight:${REPO_ROOT}:${OUT_DIR}`]);
    expect(harness.readerOptions).toEqual([]);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.join('')).toContain('preflight_failed');
    expect(harness.stderr.join('')).not.toContain('unsafe private output');
  });

  it('rejects arguments before host, private-output, or database setup', async () => {
    const harness = makeExportHarness({ args: ['--window', 'other'] });

    const code = await createCenturionNineDayCorpusExportCommand(harness.deps)();

    expect(code).toBe(1);
    expect(harness.calls).toEqual([]);
    expect(harness.stderr.join('')).toContain('invalid_arguments');
  });
});
