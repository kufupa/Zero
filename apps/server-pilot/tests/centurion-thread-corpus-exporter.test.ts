import {
  buildPrivateThreadCorpusSnapshot,
  validatePrivateThreadCorpusSnapshot,
  type FormattedLogicalMessages,
  type ThreadCorpusHydrationInput,
  type ThreadCorpusSnapshotLoadResult,
} from '../src/ops/centurion-thread-corpus-snapshot';
import {
  createCenturionThreadCorpusExporter,
  type ClosableThreadCorpusReader,
  type ThreadCorpusExportRequest,
} from '../src/ops/centurion-thread-corpus-exporter';
import { describe, expect, it } from 'vitest';

const AS_OF = '2026-08-22T12:00:00.000Z';
const ACTIVE_TRANSPORT_IDS = ['transport-a', 'transport-z'];

function makeRequest(): ThreadCorpusExportRequest {
  return {
    repoRoot: '/synthetic/repo',
    outDir: '.private/centurion-thread-corpus/snapshot',
    snapshotId: 'connected-snapshot',
    exporterVersion: 'connected-mailbox-corpus-v1',
    hydration: { storage: {} } as ThreadCorpusExportRequest['hydration'],
  } as unknown as ThreadCorpusExportRequest;
}

function makeFormatted(): FormattedLogicalMessages {
  return {
    threads: [
      {
        kind: 'unresolved',
        threadId: null,
        messages: [
          {
            normalizedMessageId: null,
            sourceRows: [
              {
                sourceRowId: 'message-a',
                scopeMembership: ['active_transport'],
                receivedAt: '2026-08-22T11:00:00.000Z',
                threadId: null,
                messageId: null,
                contentFingerprint: null,
                provenanceFingerprint: null,
                body: 'Synthetic body',
                privateMessage: {
                  subject: 'Synthetic subject',
                  direction: 'inbound',
                  addresses: { from: [], to: [], cc: [], bcc: [] },
                  originalAddresses: { from: [], to: [], cc: [], bcc: [] },
                  canonicalHeaders: {},
                  sentAt: null,
                  rawMime: { locator: null, status: 'missing' },
                  attachments: [],
                  draftRevisionLinks: [],
                  outboundDelivery: {
                    queueState: 'unknown',
                    deliveryStatus: 'not_claimed',
                  },
                  sourceMetadata: { transportId: 'transport-a' },
                },
              },
            ],
            scopeMembership: ['active_transport'],
            annotations: [],
            threadId: null,
          },
        ],
      },
    ],
  } as unknown as FormattedLogicalMessages;
}

function makeHydration(): ThreadCorpusHydrationInput {
  return { attachmentLocators: [], payloads: [] };
}

function makeLoadedResult(
  input: {
    transportIds?: readonly string[];
    asOf?: string;
  } = {},
): ThreadCorpusSnapshotLoadResult {
  const asOf = input.asOf ?? AS_OF;
  return {
    asOf,
    activeTransportScope: {
      asOf,
      transportIds: [...(input.transportIds ?? ACTIVE_TRANSPORT_IDS)],
    },
    formatted: makeFormatted(),
    attachmentLocators: [],
    safeSummary: {
      asOf,
      includedMessageCount: 1,
      sourceRowCount: 1,
      threadCount: 1,
    },
  } as unknown as ThreadCorpusSnapshotLoadResult;
}

function makeReader(onClose: () => void = () => undefined): ClosableThreadCorpusReader {
  return {
    async withRepeatableReadOnly<T>(): Promise<T> {
      throw new Error('Unexpected reader call');
    },
    async close() {
      onClose();
    },
  };
}

describe('connected mailbox corpus exporter', () => {
  it('derives sealed active-transport context from loaded scope only', async () => {
    let publication:
      | {
          context: unknown;
        }
      | undefined;
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () => makeReader(),
      load: async () => makeLoadedResult(),
      hydrate: async () => makeHydration(),
      publish: async (args) => {
        publication = args;
        return { outDir: '/private/allocated/snapshot' };
      },
    });

    const result = await exporter(makeRequest());

    expect(publication?.context).toEqual({
      snapshotId: 'connected-snapshot',
      scope: {
        scopeKeys: ['active_transport'],
        transportIds: ACTIVE_TRANSPORT_IDS,
        messagePredicate: 'active_transport_before_as_of',
      },
      asOf: AS_OF,
      exporterVersion: 'connected-mailbox-corpus-v1',
    });
    expect(result).toEqual({
      outDir: '/private/allocated/snapshot',
      summary: {
        asOf: AS_OF,
        includedMessageCount: 1,
        sourceRowCount: 1,
        threadCount: 1,
      },
    });
    expect(JSON.stringify(publication?.context)).not.toMatch(
      /centurion|designated|ingest_mailbox|owner_header/i,
    );
  });

  it('rejects an empty active scope before hydration or output creation', async () => {
    let hydrated = 0;
    let published = 0;
    const exporter = createCenturionThreadCorpusExporter({
      createReader: () => makeReader(),
      load: async () => makeLoadedResult({ transportIds: [] }),
      hydrate: async () => {
        hydrated += 1;
        return makeHydration();
      },
      publish: async () => {
        published += 1;
        return { outDir: '/private/unreachable' };
      },
    });

    await expect(exporter(makeRequest())).rejects.toThrow('Invalid thread corpus snapshot result');
    expect(hydrated).toBe(0);
    expect(published).toBe(0);
  });

  it('rejects malformed quarantine artifacts under active-only snapshot schema', () => {
    const malformedFormatted = makeFormatted() as unknown as {
      threads: Array<{
        messages: Array<{ sourceRows: Array<Record<string, unknown>> }>;
      }>;
    };
    malformedFormatted.threads[0]!.messages[0]!.sourceRows[0]!.isQuarantined = true;

    expect(() =>
      buildPrivateThreadCorpusSnapshot({
        context: {
          snapshotId: 'connected-snapshot',
          scope: {
            scopeKeys: ['active_transport'],
            transportIds: ACTIVE_TRANSPORT_IDS,
            messagePredicate: 'active_transport_before_as_of',
          },
          asOf: AS_OF,
          exporterVersion: 'connected-mailbox-corpus-v1',
        },
        formatted: malformedFormatted,
        hydration: makeHydration(),
      } as Parameters<typeof buildPrivateThreadCorpusSnapshot>[0]),
    ).toThrow('Invalid private snapshot contract');

    const snapshot = buildPrivateThreadCorpusSnapshot({
      context: {
        snapshotId: 'connected-snapshot',
        scope: {
          scopeKeys: ['active_transport'],
          transportIds: ACTIVE_TRANSPORT_IDS,
          messagePredicate: 'active_transport_before_as_of',
        },
        asOf: AS_OF,
        exporterVersion: 'connected-mailbox-corpus-v1',
      },
      formatted: makeFormatted(),
      hydration: makeHydration(),
    } as Parameters<typeof buildPrivateThreadCorpusSnapshot>[0]);

    const corrupt = {
      ...snapshot,
      corpusJsonl: snapshot.corpusJsonl.replace(
        '"recordType":"thread"',
        '"recordType":"quarantine"',
      ),
    };

    expect(() => validatePrivateThreadCorpusSnapshot(corrupt)).toThrow(
      'Invalid private snapshot contract',
    );
    expect(snapshot.corpusJsonl).not.toContain('"isQuarantined"');
    expect(snapshot.corpusJsonl).not.toContain('"quarantined"');
    expect(snapshot.manifestJson).not.toContain('quarantine');
  });
});
