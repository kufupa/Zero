import {
  CONNECTED_MAILBOX_CORPUS_SCHEMA_VERSION,
  buildPrivateThreadCorpusSnapshot,
  createPrivateThreadCorpusPublisher,
  createThreadCorpusSnapshotLoader,
  formatLogicalMessages,
  parseExportThreadCorpusArgs,
  validatePrivateThreadCorpusSnapshot,
  type ActiveTransportScope,
  type FormattedLogicalMessages,
  type PrivateArtifactFileSystem,
  type PrivateThreadCorpusSnapshot,
  type PrivateThreadCorpusSnapshotContext,
  type ThreadCorpusAttachmentSourceDescriptor,
  type ThreadCorpusDraftRevisionLink,
  type ThreadCorpusHydrationInput,
  type ThreadCorpusHydrationPayload,
  type ThreadCorpusMessageRow,
  type ThreadCorpusOutboundQueueState,
  type ThreadCorpusPrivateMessage,
  type ThreadCorpusSnapshotReadSession,
  type ThreadCorpusSnapshotReader,
  type ThreadCorpusSourceRow,
} from '../src/ops/centurion-thread-corpus-snapshot';
import { createThreadCorpusPostgresReader } from '../src/ops/centurion-thread-corpus-postgres-reader';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const AS_OF = '2026-08-22T12:00:00.000Z';
const ACTIVE_TRANSPORT_IDS = ['transport-a', 'transport-z'] as const;
const repoRoot = path.resolve(process.cwd(), '..', '..');
const corpusRoot = path.join(repoRoot, '.private', 'connected-mailbox-corpus');

function privateMessage(
  overrides: Partial<ThreadCorpusPrivateMessage> = {},
): ThreadCorpusPrivateMessage {
  return {
    subject: 'Synthetic subject',
    direction: 'inbound',
    addresses: { from: [], to: [], cc: [], bcc: [] },
    originalAddresses: { from: [], to: [], cc: [], bcc: [] },
    canonicalHeaders: {},
    sentAt: null,
    rawMime: { locator: null, status: 'missing' },
    attachments: [],
    draftRevisionLinks: [],
    outboundDelivery: { queueState: 'unknown', deliveryStatus: 'not_claimed' },
    sourceMetadata: { transportId: 'transport-a' },
    ...overrides,
  };
}

function sourceRow(overrides: Partial<ThreadCorpusSourceRow> = {}): ThreadCorpusSourceRow {
  return {
    sourceRowId: 'source-row',
    scopeMembership: ['active_transport'],
    receivedAt: '2026-08-22T09:00:00.000Z',
    threadId: 'thread-a',
    messageId: '<message-a@example.test>',
    contentFingerprint: 'content-a',
    provenanceFingerprint: 'provenance-a',
    body: 'Synthetic message body.',
    privateMessage: privateMessage(),
    ...overrides,
  };
}

function snapshotContext(): PrivateThreadCorpusSnapshotContext {
  return {
    snapshotId: 'snapshot-opaque-001',
    scope: {
      scopeKeys: ['active_transport'],
      transportIds: [...ACTIVE_TRANSPORT_IDS],
      messagePredicate: 'active_transport_before_as_of',
    },
    asOf: AS_OF,
    exporterVersion: 'connected-mailbox-corpus-test-v3',
  };
}

function formattedSourceRows(formatted: FormattedLogicalMessages): ThreadCorpusSourceRow[] {
  return formatted.threads.flatMap((thread) =>
    thread.messages.flatMap((message) => message.sourceRows),
  );
}

function defaultSnapshotHydration(formatted: FormattedLogicalMessages): ThreadCorpusHydrationInput {
  const payloads: ThreadCorpusHydrationPayload[] = [];
  for (const row of formattedSourceRows(formatted)) {
    const rawMime = row.privateMessage?.rawMime;
    if (rawMime?.status === 'available' && rawMime.locator) {
      payloads.push({
        kind: 'raw_mime',
        sourceRowId: row.sourceRowId,
        status: 'available',
        content: new Uint8Array([row.sourceRowId.length]),
      });
    }
  }
  return { attachmentLocators: [], payloads };
}

function buildSnapshot(
  rows: readonly ThreadCorpusSourceRow[],
  context: PrivateThreadCorpusSnapshotContext = snapshotContext(),
  hydration?: ThreadCorpusHydrationInput,
): PrivateThreadCorpusSnapshot {
  const formatted = formatLogicalMessages(rows);
  return buildPrivateThreadCorpusSnapshot({
    context,
    formatted,
    hydration: hydration ?? defaultSnapshotHydration(formatted),
  });
}

type JsonObject = Record<string, unknown>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifactId(
  snapshotId: string,
  kind: 'raw_mime' | 'attachment_text',
  ownerId: string,
): string {
  return sha256(`${CONNECTED_MAILBOX_CORPUS_SCHEMA_VERSION}\0${snapshotId}\0${kind}\0${ownerId}`);
}

function parseSnapshotCorpus(snapshot: PrivateThreadCorpusSnapshot): {
  metadata: JsonObject;
  records: JsonObject[];
} {
  const lines = snapshot.corpusJsonl.trimEnd().split('\n');
  return {
    metadata: JSON.parse(lines[0]!) as JsonObject,
    records: lines.slice(1).map((line) => JSON.parse(line) as JsonObject),
  };
}

function resealSnapshot(
  snapshot: PrivateThreadCorpusSnapshot,
  records: readonly JsonObject[],
): PrivateThreadCorpusSnapshot {
  const { metadata } = parseSnapshotCorpus(snapshot);
  const orderedRecordJsonl =
    records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const corpusJsonl = `${JSON.stringify({
    ...metadata,
    orderedRecordSha256: sha256(orderedRecordJsonl),
  })}\n${orderedRecordJsonl}`;
  const manifest = {
    ...snapshot.manifest,
    orderedRecordSha256: sha256(orderedRecordJsonl),
    localObjectSha256: sha256(corpusJsonl),
  };
  return {
    ...snapshot,
    corpusJsonl,
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function resealSnapshotContract(
  snapshot: PrivateThreadCorpusSnapshot,
  input: {
    manifest?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): PrivateThreadCorpusSnapshot {
  const { metadata, records } = parseSnapshotCorpus(snapshot);
  const orderedRecordJsonl =
    records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const sealedMetadata = {
    ...metadata,
    orderedRecordSha256: sha256(orderedRecordJsonl),
    ...input.metadata,
  };
  const corpusJsonl = `${JSON.stringify(sealedMetadata)}\n${orderedRecordJsonl}`;
  const manifest = {
    ...snapshot.manifest,
    orderedRecordSha256: sha256(orderedRecordJsonl),
    localObjectSha256: sha256(corpusJsonl),
    ...input.manifest,
  };
  return {
    ...snapshot,
    corpusJsonl,
    manifest: manifest as PrivateThreadCorpusSnapshot['manifest'],
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function sourceRowFromRecords(records: readonly JsonObject[], sourceRowId: string): JsonObject {
  for (const record of records) {
    for (const message of record.messages as JsonObject[]) {
      const row = (message.sourceRows as JsonObject[]).find(
        (candidate) => candidate.sourceRowId === sourceRowId,
      );
      if (row) return row;
    }
  }
  throw new Error('Missing synthetic source row');
}

type SealedFixture = {
  attachmentTextBytes: Uint8Array;
  formatted: FormattedLogicalMessages;
  hydration: ThreadCorpusHydrationInput;
  markers: Record<string, string>;
  rawMimeBytes: Uint8Array;
  rows: ThreadCorpusSourceRow[];
};

function sealedArtifactFixture(): SealedFixture {
  const markers = {
    body: 'SYNTHETIC_PRIVATE_BODY',
    subject: 'SYNTHETIC_PRIVATE_SUBJECT',
    address: 'synthetic-private@example.test',
    filename: 'SYNTHETIC_PRIVATE_FILENAME.txt',
    rawPendingLocator: 'SYNTHETIC_RAW_PENDING_LOCATOR',
    rawAvailableLocator: 'SYNTHETIC_RAW_AVAILABLE_LOCATOR',
    attachmentAvailableLocator: 'SYNTHETIC_ATTACHMENT_AVAILABLE_LOCATOR',
    attachmentFailedLocator: 'SYNTHETIC_ATTACHMENT_FAILED_LOCATOR',
  };
  const rawMimeBytes = new Uint8Array([1, 2, 3, 4]);
  const attachmentTextBytes = new Uint8Array([5, 6, 7]);
  const rows = [
    sourceRow({
      sourceRowId: 'pending-row',
      threadId: 'thread-pending',
      messageId: '<pending@example.test>',
      body: markers.body,
      privateMessage: privateMessage({
        subject: markers.subject,
        addresses: { from: [markers.address], to: [], cc: [], bcc: [] },
        originalAddresses: { from: [markers.address], to: [], cc: [], bcc: [] },
        rawMime: { locator: markers.rawPendingLocator, status: 'pending_hydration' },
        attachments: [
          {
            id: 'attachment-available',
            messageId: 'pending-row',
            filename: markers.filename,
            contentType: 'text/plain',
            byteSize: 3,
          },
          {
            id: 'attachment-failed',
            messageId: 'pending-row',
            filename: 'synthetic-failed.txt',
            contentType: 'text/plain',
            byteSize: 4,
          },
        ],
      }),
    }),
    sourceRow({
      sourceRowId: 'available-row',
      threadId: 'thread-available',
      messageId: '<available@example.test>',
      privateMessage: privateMessage({
        rawMime: { locator: markers.rawAvailableLocator, status: 'available' },
        sourceMetadata: { transportId: 'transport-z' },
        attachments: [
          {
            id: 'attachment-no-locator',
            messageId: 'available-row',
            filename: 'synthetic-no-locator.txt',
            contentType: 'text/plain',
            byteSize: 5,
          },
        ],
      }),
    }),
    sourceRow({
      sourceRowId: 'terminal-row',
      threadId: 'thread-terminal',
      messageId: '<terminal@example.test>',
      privateMessage: privateMessage({ rawMime: { locator: null, status: 'missing' } }),
    }),
  ];
  const formatted = formatLogicalMessages(rows);
  const hydration: ThreadCorpusHydrationInput = {
    attachmentLocators: [
      {
        attachmentId: 'attachment-available',
        messageId: 'pending-row',
        s3Key: markers.attachmentAvailableLocator,
        mimeType: 'text/plain',
        sizeBytes: 3,
      },
      {
        attachmentId: 'attachment-failed',
        messageId: 'pending-row',
        s3Key: markers.attachmentFailedLocator,
        mimeType: 'text/plain',
        sizeBytes: 4,
      },
    ],
    payloads: [
      { kind: 'raw_mime', sourceRowId: 'pending-row', status: 'read_failed' },
      {
        kind: 'raw_mime',
        sourceRowId: 'available-row',
        status: 'available',
        content: rawMimeBytes,
      },
      {
        kind: 'attachment_text',
        attachmentId: 'attachment-available',
        status: 'available',
        content: attachmentTextBytes,
      },
      {
        kind: 'attachment_text',
        attachmentId: 'attachment-failed',
        status: 'unsupported',
      },
    ],
  };
  return { attachmentTextBytes, formatted, hydration, markers, rawMimeBytes, rows };
}

const localPrivateArtifactFileSystem: PrivateArtifactFileSystem = {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
};

const testWindowsAclOptions =
  process.platform === 'win32'
    ? {
        windowsPrivateAclEnforcer: async () => undefined,
      }
    : {};

async function withTemporaryRepo<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'connected-mailbox-corpus-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createTestPublisher(
  fileSystem: PrivateArtifactFileSystem = localPrivateArtifactFileSystem,
) {
  return createPrivateThreadCorpusPublisher(fileSystem, {
    ...testWindowsAclOptions,
    verifyIgnoredPrivateOutputDirectory: (_repoRoot, privateDirectoryName) =>
      privateDirectoryName === 'connected-mailbox-corpus',
  });
}

async function tryCreateDirectoryLink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return false;
    throw error;
  }
}

function requiredArgs(extra: readonly string[] = []): string[] {
  return ['--out-dir', path.join(corpusRoot, 'run-001'), ...extra];
}

describe('export thread corpus CLI contract', () => {
  it('parses only private output and optional as-of values', () => {
    expect(
      parseExportThreadCorpusArgs(requiredArgs(['--as-of', '2026-08-22T10:15:30.000Z']), repoRoot),
    ).toEqual({
      outDir: path.join(corpusRoot, 'run-001'),
      asOf: '2026-08-22T10:15:30.000Z',
    });
  });

  it('rejects retired source-selection flags', () => {
    for (const flag of [
      '--centurion-transport-id',
      '--designated-transport-id',
      '--designated-address',
      '--designated-address-file',
      '--designated-ingest-mailbox-id',
    ]) {
      expect(() =>
        parseExportThreadCorpusArgs(requiredArgs([flag, 'synthetic']), repoRoot),
      ).toThrow(/unknown flag/i);
    }
  });

  it('rejects outside or nested output paths and malformed flags', () => {
    expect(() =>
      parseExportThreadCorpusArgs(
        ['--out-dir', path.join(repoRoot, '.private', 'other-corpus')],
        repoRoot,
      ),
    ).toThrow(/out-dir/i);
    expect(() =>
      parseExportThreadCorpusArgs(
        ['--out-dir', path.join(corpusRoot, 'run-001', 'nested')],
        repoRoot,
      ),
    ).toThrow(/out-dir/i);
    expect(() => parseExportThreadCorpusArgs([], repoRoot)).toThrow(/required/i);
    expect(() =>
      parseExportThreadCorpusArgs(
        requiredArgs(['--out-dir', path.join(corpusRoot, 'run-002')]),
        repoRoot,
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseExportThreadCorpusArgs(requiredArgs(['--as-of', 'not-an-iso-date']), repoRoot),
    ).toThrow(/as-of/i);
  });
});

describe('active transport logical messages', () => {
  it('strongly merges matching IDs while retaining active-only membership', () => {
    const formatted = formatLogicalMessages([
      sourceRow({
        sourceRowId: 'row-a',
        messageId: '<MERGE@example.test>',
        contentFingerprint: 'merge-content',
        provenanceFingerprint: 'merge-provenance',
      }),
      sourceRow({
        sourceRowId: 'row-z',
        messageId: ' <merge@example.test> ',
        contentFingerprint: 'merge-content',
        provenanceFingerprint: 'merge-provenance',
        privateMessage: privateMessage({ sourceMetadata: { transportId: 'transport-z' } }),
      }),
    ]);

    expect(formatted.threads).toHaveLength(1);
    expect(formatted.threads[0]?.messages[0]).toMatchObject({
      normalizedMessageId: 'merge@example.test',
      scopeMembership: ['active_transport'],
    });
    expect(formatted.threads[0]?.messages[0]?.sourceRows.map((row) => row.sourceRowId)).toEqual([
      'row-a',
      'row-z',
    ]);
    expect(formatted).not.toHaveProperty('quarantineRecords');
  });

  it('keeps weak duplicate candidates separate and deterministic', () => {
    const rows = [
      sourceRow({
        sourceRowId: 'weak-z',
        messageId: '<weak@example.test>',
        contentFingerprint: 'same-content',
        provenanceFingerprint: '',
      }),
      sourceRow({
        sourceRowId: 'weak-a',
        messageId: '<weak@example.test>',
        contentFingerprint: 'same-content',
        provenanceFingerprint: 'known-provenance',
      }),
    ];
    const formatted = formatLogicalMessages(rows);

    expect(formatLogicalMessages([...rows].reverse())).toEqual(formatted);
    const messages = formatted.threads.flatMap((thread) => thread.messages);
    expect(messages).toHaveLength(2);
    expect(
      messages.every((message) => message.annotations.includes('unresolved_duplicate_candidate')),
    ).toBe(true);
  });

  it('rejects quarantined rows instead of emitting a quarantine record', () => {
    expect(() => formatLogicalMessages([sourceRow({ isQuarantined: true })])).toThrow(
      'Invalid thread corpus source contract',
    );
  });
});

describe('active transport snapshot contract', () => {
  it('builds deterministic v3 output with aggregate-only manifest', () => {
    const markers = {
      body: 'SYNTHETIC_PRIVATE_BODY_TOKEN',
      subject: 'SYNTHETIC_PRIVATE_SUBJECT_TOKEN',
      address: 'synthetic-private-address@example.test',
      locator: 'SYNTHETIC_PRIVATE_RAW_MIME_LOCATOR',
    };
    const rows = [
      sourceRow({
        sourceRowId: 'row-a',
        body: markers.body,
        privateMessage: privateMessage({
          subject: markers.subject,
          addresses: { from: [markers.address], to: [], cc: [], bcc: [] },
          originalAddresses: { from: [markers.address], to: [], cc: [], bcc: [] },
          rawMime: { locator: markers.locator, status: 'available' },
        }),
      }),
      sourceRow({
        sourceRowId: 'row-z',
        threadId: 'thread-z',
        messageId: '<message-z@example.test>',
        receivedAt: '2026-08-22T10:00:00.000Z',
        privateMessage: privateMessage({ sourceMetadata: { transportId: 'transport-z' } }),
      }),
    ];
    const snapshot = buildSnapshot(rows);
    const repeated = buildSnapshot([...rows].reverse());
    const { metadata, records } = parseSnapshotCorpus(snapshot);

    expect(repeated).toEqual(snapshot);
    expect(snapshot.manifest).toMatchObject({
      schemaVersion: 'connected-mailbox-corpus-v4',
      scope: {
        scopeKeys: ['active_transport'],
        transportIds: ACTIVE_TRANSPORT_IDS,
        messagePredicate: 'active_transport_before_as_of',
      },
      window: { startInclusive: null, endExclusive: AS_OF },
      sourceObject: { integrity: 'content_hash_only' },
      counts: {
        sourceRows: 2,
        logicalMessages: 2,
        threads: 2,
        messagesByScope: { active_transport: 2 },
      },
    });
    expect(metadata.recordType).toBe('metadata');
    expect(records.every((record) => record.recordType === 'thread')).toBe(true);
    expect(snapshot.corpusJsonl).not.toContain(markers.locator);
    expect(JSON.stringify([snapshot.manifest, metadata, records])).not.toMatch(
      /quarantine|quarantined|owner_header|ingest_mailbox/i,
    );
    for (const marker of Object.values(markers)) {
      expect(snapshot.manifestJson).not.toContain(marker);
      expect(JSON.stringify(snapshot.manifest)).not.toContain(marker);
    }
    expect(() => validatePrivateThreadCorpusSnapshot(snapshot)).not.toThrow();
  });

  it('accepts only nonempty sorted active-transport context without quarantine fields', () => {
    const formatted = formatLogicalMessages([sourceRow()]);
    const hydration = defaultSnapshotHydration(formatted);
    const valid = snapshotContext();
    const invalidContexts: unknown[] = [
      {
        ...valid,
        scope: { ...valid.scope, transportIds: [] },
      },
      {
        ...valid,
        scope: { ...valid.scope, transportIds: ['transport-z', 'transport-a'] },
      },
      {
        ...valid,
        scope: {
          ...valid.scope,
          scopeKeys: ['active_transport', 'designated_reservationist_mailbox'],
        },
      },
      {
        ...valid,
        scope: {
          ...valid.scope,
          messagePredicate: 'selected_transports_or_private_designated_address_before_as_of',
        },
      },
      {
        ...valid,
        scope: {
          ...valid.scope,
          quarantinePredicate: 'selected_ingest_mailbox_or_owner_header_before_as_of',
        },
      },
    ];

    expect(() =>
      buildPrivateThreadCorpusSnapshot({ context: valid, formatted, hydration }),
    ).not.toThrow();
    for (const context of invalidContexts) {
      expect(() =>
        buildPrivateThreadCorpusSnapshot({
          context: context as PrivateThreadCorpusSnapshotContext,
          formatted,
          hydration,
        }),
      ).toThrow('Invalid private snapshot contract');
    }
    expect(() =>
      buildPrivateThreadCorpusSnapshot({
        context: valid,
        formatted: {
          threads: [],
          quarantineRecords: [{ sourceRows: [sourceRow()] }],
        } as unknown as FormattedLogicalMessages,
        hydration: { attachmentLocators: [], payloads: [] },
      }),
    ).toThrow('Invalid private snapshot contract');
  });

  it('rejects re-sealed record topology and artifact-byte corruption', () => {
    const fixture = sealedArtifactFixture();
    const context = { ...snapshotContext(), snapshotId: 'corruption-snapshot' };
    const snapshot = buildPrivateThreadCorpusSnapshot({
      context,
      formatted: fixture.formatted,
      hydration: fixture.hydration,
    });
    const { records } = parseSnapshotCorpus(snapshot);
    const quarantinedRecords = structuredClone(records) as JsonObject[];
    sourceRowFromRecords(quarantinedRecords, 'pending-row').isQuarantined = true;
    const foreignTransportRecords = structuredClone(records) as JsonObject[];
    const foreignPrivateMessage = sourceRowFromRecords(foreignTransportRecords, 'pending-row')
      .privateMessage as JsonObject;
    (foreignPrivateMessage.sourceMetadata as JsonObject).transportId = 'transport-foreign';
    const corruptedArtifact = {
      ...snapshot,
      artifactFiles: snapshot.artifactFiles.map((artifact) =>
        artifact.kind === 'raw_mime'
          ? { ...artifact, content: new Uint8Array([0, 0, 0, 0]) }
          : artifact,
      ),
    } as PrivateThreadCorpusSnapshot;

    expect(() =>
      validatePrivateThreadCorpusSnapshot(resealSnapshot(snapshot, quarantinedRecords)),
    ).toThrow('Invalid private snapshot contract');
    expect(() =>
      validatePrivateThreadCorpusSnapshot(resealSnapshot(snapshot, foreignTransportRecords)),
    ).toThrow('Invalid private snapshot contract');
    expect(() => validatePrivateThreadCorpusSnapshot(corruptedArtifact)).toThrow(
      'Invalid private snapshot contract',
    );
  });

  it('rejects resealed manifest and metadata contract tampering', () => {
    const snapshot = buildSnapshot([sourceRow()]);
    const corruptedSnapshots = [
      resealSnapshotContract(snapshot, {
        metadata: { schemaVersion: 'connected-mailbox-corpus-v3' },
      }),
      resealSnapshotContract(snapshot, {
        metadata: { recordCount: 99 },
      }),
      resealSnapshotContract(snapshot, {
        metadata: { orderedRecordSha256: '0'.repeat(64) },
      }),
      resealSnapshotContract(snapshot, {
        manifest: { schemaVersion: 'connected-mailbox-corpus-v3' },
      }),
      resealSnapshotContract(snapshot, {
        manifest: {
          scope: {
            scopeKeys: ['active_transport'],
            transportIds: ['transport-a'],
            messagePredicate: 'active_transport_before_as_of',
          },
        },
      }),
      resealSnapshotContract(snapshot, {
        manifest: {
          counts: {
            ...snapshot.manifest.counts,
            sourceRows: snapshot.manifest.counts.sourceRows + 1,
          },
        },
      }),
      resealSnapshotContract(snapshot, {
        manifest: { orderedRecordSha256: '0'.repeat(64) },
      }),
    ];

    for (const corrupted of corruptedSnapshots) {
      expect(() => validatePrivateThreadCorpusSnapshot(corrupted)).toThrow(
        'Invalid private snapshot contract',
      );
    }
  });

  it('rejects invalid hydration before creating output directories', async () => {
    const fixture = sealedArtifactFixture();
    let mkdirCalls = 0;
    let allocationCalls = 0;
    let writeCalls = 0;
    const publisher = createTestPublisher({
      ...localPrivateArtifactFileSystem,
      async mkdir(...args: Parameters<typeof mkdir>) {
        mkdirCalls += 1;
        return mkdir(...args);
      },
      async mkdtemp(...args: Parameters<typeof mkdtemp>) {
        allocationCalls += 1;
        return mkdtemp(...args);
      },
      async writeFile(...args: Parameters<typeof writeFile>) {
        writeCalls += 1;
        return writeFile(...args);
      },
    });

    await withTemporaryRepo(async (temporaryRoot) => {
      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(
            temporaryRoot,
            '.private',
            'connected-mailbox-corpus',
            'invalid-hydration',
          ),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: {
            ...fixture.hydration,
            payloads: fixture.hydration.payloads.filter(
              (payload) =>
                !(payload.kind === 'raw_mime' && payload.sourceRowId === 'available-row'),
            ),
          },
        }),
      ).rejects.toThrow('Invalid private snapshot contract');
    });
    expect(mkdirCalls).toBe(0);
    expect(allocationCalls).toBe(0);
    expect(writeCalls).toBe(0);
  });
});

describe('private snapshot publication', () => {
  it('rejects an unverified generic root before filesystem root creation', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      let mkdirCalls = 0;
      const publisher = createPrivateThreadCorpusPublisher(
        {
          ...localPrivateArtifactFileSystem,
          async mkdir(...args: Parameters<typeof mkdir>) {
            mkdirCalls += 1;
            return mkdir(...args);
          },
        },
        testWindowsAclOptions,
      );

      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(temporaryRoot, '.private', 'connected-mailbox-corpus', 'snapshot'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow(
        'Private corpus output root must be an ignored direct child of a Git repository',
      );
      expect(mkdirCalls).toBe(0);
    });
  });

  it('revalidates the injected generic root verifier before private file writes', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      let verifierCalls = 0;
      let writeCalls = 0;
      const publisher = createPrivateThreadCorpusPublisher(
        {
          ...localPrivateArtifactFileSystem,
          async writeFile(...args: Parameters<typeof writeFile>) {
            writeCalls += 1;
            return writeFile(...args);
          },
        },
        {
          ...testWindowsAclOptions,
          verifyIgnoredPrivateOutputDirectory: () => {
            verifierCalls += 1;
            return verifierCalls < 4;
          },
        },
      );

      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(temporaryRoot, '.private', 'connected-mailbox-corpus', 'snapshot'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow(
        'Private corpus output root must be an ignored direct child of a Git repository',
      );
      expect(verifierCalls).toBe(4);
      expect(writeCalls).toBe(0);
    });
  });

  it('fails before snapshot content writes when Windows ACL enforcement rejects', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      let writeCalls = 0;
      const publisher = createPrivateThreadCorpusPublisher(
        {
          ...localPrivateArtifactFileSystem,
          async writeFile(...args: Parameters<typeof writeFile>) {
            writeCalls += 1;
            return writeFile(...args);
          },
        },
        {
          platform: 'win32',
          verifyIgnoredPrivateOutputDirectory: () => true,
          windowsPrivateAclEnforcer: async () => {
            throw new Error('mismatch');
          },
        } as unknown as Parameters<typeof createPrivateThreadCorpusPublisher>[1],
      );

      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(temporaryRoot, '.private', 'connected-mailbox-corpus', 'snapshot'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow(/^Private output root preflight failed$/);
      expect(writeCalls).toBe(0);
    });
  });

  it('publishes sealed artifacts, finalizes manifest last, and keeps restrictive modes', async () => {
    const fixture = sealedArtifactFixture();
    const context = { ...snapshotContext(), snapshotId: 'publish-snapshot' };
    const snapshot = buildPrivateThreadCorpusSnapshot({
      context,
      formatted: fixture.formatted,
      hydration: fixture.hydration,
    });

    await withTemporaryRepo(async (temporaryRoot) => {
      const events: string[] = [];
      const publisher = createTestPublisher({
        ...localPrivateArtifactFileSystem,
        async writeFile(...args: Parameters<typeof writeFile>) {
          events.push(`write:${path.basename(String(args[0]))}`);
          return writeFile(...args);
        },
        async rename(...args: Parameters<typeof rename>) {
          events.push(`rename:${path.basename(String(args[1]))}`);
          return rename(...args);
        },
      });
      const outDir = path.join(temporaryRoot, '.private', 'connected-mailbox-corpus', 'snapshot');
      const published = await publisher({
        repoRoot: temporaryRoot,
        outDir,
        context,
        formatted: fixture.formatted,
        hydration: fixture.hydration,
      });

      expect(path.dirname(published.outDir)).toBe(path.dirname(outDir));
      expect(path.basename(published.outDir)).toMatch(/^snapshot-/);
      expect(await readdir(published.outDir)).toEqual([
        'attachment-text',
        'corpus.jsonl',
        'manifest.json',
        'raw-mime',
      ]);
      expect(events.findLast((event) => event.startsWith('rename:'))).toBe('rename:manifest.json');
      await expect(readFile(path.join(published.outDir, 'corpus.jsonl'), 'utf8')).resolves.toBe(
        snapshot.corpusJsonl,
      );
      await expect(readFile(path.join(published.outDir, 'manifest.json'), 'utf8')).resolves.toBe(
        snapshot.manifestJson,
      );
      for (const artifact of snapshot.artifactFiles) {
        const artifactPath = path.join(
          published.outDir,
          artifact.kind === 'raw_mime' ? 'raw-mime' : 'attachment-text',
          `${artifact.id}.${artifact.kind === 'raw_mime' ? 'eml' : 'txt'}`,
        );
        await expect(readFile(artifactPath)).resolves.toEqual(Buffer.from(artifact.content));
      }
      if (process.platform !== 'win32') {
        const [privateDirectory, corpusDirectory, directory, corpus, manifest] = await Promise.all([
          stat(path.join(temporaryRoot, '.private')),
          stat(path.join(temporaryRoot, '.private', 'connected-mailbox-corpus')),
          stat(published.outDir),
          stat(path.join(published.outDir, 'corpus.jsonl')),
          stat(path.join(published.outDir, 'manifest.json')),
        ]);
        expect(privateDirectory.mode & 0o777).toBe(0o700);
        expect(corpusDirectory.mode & 0o777).toBe(0o700);
        expect(directory.mode & 0o777).toBe(0o700);
        expect(corpus.mode & 0o777).toBe(0o600);
        expect(manifest.mode & 0o777).toBe(0o600);
      }
    });
  });

  it('tightens weak pre-existing private and corpus root modes before publication', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      const privateRoot = path.join(temporaryRoot, '.private');
      const corpusRoot = path.join(privateRoot, 'connected-mailbox-corpus');
      await mkdir(corpusRoot, { recursive: true });
      await chmod(privateRoot, 0o755);
      await chmod(corpusRoot, 0o755);

      await createTestPublisher()({
        repoRoot: temporaryRoot,
        outDir: path.join(corpusRoot, 'weak-mode'),
        context: snapshotContext(),
        formatted: fixture.formatted,
        hydration: fixture.hydration,
      });

      if (process.platform !== 'win32') {
        const [privateStats, corpusStats] = await Promise.all([
          stat(privateRoot),
          stat(corpusRoot),
        ]);
        expect(privateStats.mode & 0o777).toBe(0o700);
        expect(corpusStats.mode & 0o777).toBe(0o700);
      }
    });
  });

  it('rejects outside and nested targets without overwriting an existing stem', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      const privateRoot = path.join(temporaryRoot, '.private', 'connected-mailbox-corpus');
      const existing = path.join(privateRoot, 'existing');
      const sentinel = path.join(existing, 'sentinel.txt');
      await mkdir(existing, { recursive: true });
      await writeFile(sentinel, 'preserve-synthetic-output', 'utf8');
      const publisher = createTestPublisher();

      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(temporaryRoot, 'outside'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow(/direct child/i);
      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(existing, 'nested'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow(/direct child/i);
      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: existing,
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).resolves.toMatchObject({
        outDir: expect.stringMatching(/existing-/),
      });
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve-synthetic-output');
    });
  });

  it('rejects a symlinked private corpus root when links are available', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      const privateRoot = path.join(temporaryRoot, '.private');
      const corpusRoot = path.join(privateRoot, 'connected-mailbox-corpus');
      const outsideRoot = path.join(temporaryRoot, 'outside');
      await mkdir(privateRoot, { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      if (!(await tryCreateDirectoryLink(outsideRoot, corpusRoot))) return;

      await expect(
        createTestPublisher()({
          repoRoot: temporaryRoot,
          outDir: path.join(corpusRoot, 'snapshot'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow(/symlink|trusted|preflight/i);
      await expect(readdir(outsideRoot)).resolves.toEqual([]);
    });
  });

  it('revalidates allocated snapshot identity before every content rename', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      const corpusRoot = path.join(temporaryRoot, '.private', 'connected-mailbox-corpus');
      let allocatedOutDir = '';
      let wroteTemporaryContent = false;
      let renameCalls = 0;
      const publisher = createTestPublisher({
        ...localPrivateArtifactFileSystem,
        async mkdtemp(...args: Parameters<typeof mkdtemp>) {
          allocatedOutDir = await mkdtemp(...args);
          return allocatedOutDir;
        },
        async writeFile(...args: Parameters<typeof writeFile>) {
          const result = await writeFile(...args);
          wroteTemporaryContent = true;
          return result;
        },
        async realpath(target: Parameters<typeof realpath>[0]) {
          if (
            wroteTemporaryContent &&
            path.resolve(String(target)) === path.resolve(allocatedOutDir)
          ) {
            return path.join(temporaryRoot, 'swapped-allocation');
          }
          return realpath(target);
        },
        async rename(...args: Parameters<typeof rename>) {
          renameCalls += 1;
          return rename(...args);
        },
      });

      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(corpusRoot, 'allocation-race'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow(/trusted|allocation|changed/i);

      expect(renameCalls).toBe(0);
      await expect(readdir(corpusRoot)).resolves.toEqual([]);
    });
  });

  it('rejects a replaced artifact directory before writing artifact bytes', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      const corpusRoot = path.join(temporaryRoot, '.private', 'connected-mailbox-corpus');
      const outsideRoot = path.join(temporaryRoot, 'outside-artifacts');
      const probeLink = path.join(temporaryRoot, 'artifact-link-probe');
      await mkdir(outsideRoot, { recursive: true });
      if (!(await tryCreateDirectoryLink(outsideRoot, probeLink))) return;
      await rm(probeLink, { recursive: true, force: true });

      const publisher = createTestPublisher({
        ...localPrivateArtifactFileSystem,
        async mkdir(...args: Parameters<typeof mkdir>) {
          const directory = String(args[0]);
          const result = await mkdir(...args);
          if (path.basename(directory) === 'raw-mime') {
            await rm(directory, { recursive: true, force: true });
            await tryCreateDirectoryLink(outsideRoot, directory);
          }
          return result;
        },
      });

      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(corpusRoot, 'artifact-link'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow(/symlink|trusted|artifact/i);

      await expect(readdir(outsideRoot)).resolves.toEqual([]);
      await expect(readdir(corpusRoot)).resolves.toEqual([]);
    });
  });

  it('removes temporary output after a controlled artifact write failure', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      const privateRoot = path.join(temporaryRoot, '.private', 'connected-mailbox-corpus');
      const publisher = createTestPublisher({
        ...localPrivateArtifactFileSystem,
        async writeFile(...args: Parameters<typeof writeFile>) {
          if (String(args[0]).includes('raw-mime')) {
            throw new Error('synthetic artifact write failure');
          }
          return writeFile(...args);
        },
      });

      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(privateRoot, 'failure'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow('synthetic artifact write failure');
      await expect(readdir(privateRoot)).resolves.toEqual([]);
    });
  });

  it('removes temporary output after a controlled artifact rename failure', async () => {
    const fixture = sealedArtifactFixture();
    await withTemporaryRepo(async (temporaryRoot) => {
      const privateRoot = path.join(temporaryRoot, '.private', 'connected-mailbox-corpus');
      const publisher = createTestPublisher({
        ...localPrivateArtifactFileSystem,
        async rename(...args: Parameters<typeof rename>) {
          if (String(args[1]).endsWith('.eml')) {
            throw new Error('synthetic artifact rename failure');
          }
          return rename(...args);
        },
      });

      await expect(
        publisher({
          repoRoot: temporaryRoot,
          outDir: path.join(privateRoot, 'rename-failure'),
          context: snapshotContext(),
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ).rejects.toThrow('synthetic artifact rename failure');
      await expect(readdir(privateRoot)).resolves.toEqual([]);
    });
  });

  it('allocates distinct immutable output directories for concurrent same-stem publication', async () => {
    const fixture = sealedArtifactFixture();
    const context = { ...snapshotContext(), snapshotId: 'concurrent-snapshot' };
    const expected = buildPrivateThreadCorpusSnapshot({
      context,
      formatted: fixture.formatted,
      hydration: fixture.hydration,
    });

    await withTemporaryRepo(async (temporaryRoot) => {
      const privateRoot = path.join(temporaryRoot, '.private', 'connected-mailbox-corpus');
      const outDir = path.join(privateRoot, 'same-stem');
      const publisher = createTestPublisher();
      const [first, second] = await Promise.all([
        publisher({
          repoRoot: temporaryRoot,
          outDir,
          context,
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
        publisher({
          repoRoot: temporaryRoot,
          outDir,
          context,
          formatted: fixture.formatted,
          hydration: fixture.hydration,
        }),
      ]);

      expect(first.outDir).not.toBe(second.outDir);
      for (const published of [first, second]) {
        expect(path.dirname(published.outDir)).toBe(privateRoot);
        expect(path.basename(published.outDir)).toMatch(/^same-stem-/);
        await expect(readFile(path.join(published.outDir, 'corpus.jsonl'), 'utf8')).resolves.toBe(
          expected.corpusJsonl,
        );
        await expect(readFile(path.join(published.outDir, 'manifest.json'), 'utf8')).resolves.toBe(
          expected.manifestJson,
        );
      }
      expect(await readdir(privateRoot)).toHaveLength(2);
    });
  });
});

function messageRow(overrides: Partial<ThreadCorpusMessageRow> = {}): ThreadCorpusMessageRow {
  return {
    id: 'message-a',
    transportId: 'transport-a',
    threadId: 'thread-a',
    messageId: '<message-a@example.test>',
    receivedAt: '2026-08-22T09:00:00.000Z',
    sentAt: null,
    subject: 'Synthetic subject',
    body: 'Synthetic body',
    direction: 'inbound',
    from: ['Guest <guest@example.test>'],
    to: ['Desk <desk@example.test>'],
    cc: [],
    bcc: [],
    canonicalHeaders: { 'Message-ID': ['<message-a@example.test>'] },
    rawMime: { locator: null, status: 'missing' },
    ...overrides,
  };
}

type SyntheticReaderInput = {
  asOf?: string;
  activeTransportScope?: ActiveTransportScope;
  attachments?: readonly ThreadCorpusAttachmentSourceDescriptor[];
  draftRevisionLinks?: readonly ThreadCorpusDraftRevisionLink[];
  messages?: readonly ThreadCorpusMessageRow[];
  outboundQueueStates?: readonly ThreadCorpusOutboundQueueState[];
};

function createSyntheticSnapshotReader(input: SyntheticReaderInput = {}): {
  calls: string[];
  reader: ThreadCorpusSnapshotReader;
} {
  const calls: string[] = [];
  const asOf = input.asOf ?? AS_OF;
  const session: ThreadCorpusSnapshotReadSession = {
    asOf,
    async discoverActiveTransportScope() {
      calls.push('scope');
      return input.activeTransportScope ?? { asOf, transportIds: [...ACTIVE_TRANSPORT_IDS] };
    },
    async readMessages() {
      calls.push('messages');
      return input.messages ?? [];
    },
    async readAttachmentDescriptors() {
      calls.push('attachments');
      return input.attachments ?? [];
    },
    async readDraftRevisionLinks() {
      calls.push('draft-revisions');
      return input.draftRevisionLinks ?? [];
    },
    async readOutboundQueueDeliveryStates() {
      calls.push('queue');
      return input.outboundQueueStates ?? [];
    },
  };
  return {
    calls,
    reader: {
      async withRepeatableReadOnly<T>(
        load: (transaction: ThreadCorpusSnapshotReadSession) => Promise<T>,
      ): Promise<T> {
        calls.push('begin');
        try {
          return await load(session);
        } finally {
          calls.push('end');
        }
      },
    },
  };
}

describe('active transport snapshot loader', () => {
  it('propagates only active context and runtime artifact locators', async () => {
    const locatorMarkers = {
      first: 'SYNTHETIC_ATTACHMENT_LOCATOR_A',
      second: 'SYNTHETIC_ATTACHMENT_LOCATOR_Z',
    };
    const { calls, reader } = createSyntheticSnapshotReader({
      messages: [
        messageRow({
          id: 'message-z',
          transportId: 'transport-z',
          threadId: 'thread-z',
          messageId: '<message-z@example.test>',
          receivedAt: '2026-08-22T10:00:00.000Z',
        }),
        messageRow(),
      ],
      attachments: [
        {
          id: 'attachment-z',
          messageId: 'message-z',
          filename: 'z.txt',
          contentType: 'text/plain',
          byteSize: 2,
          s3Key: locatorMarkers.second,
        },
        {
          id: 'attachment-a',
          messageId: 'message-a',
          filename: 'a.txt',
          contentType: 'text/plain',
          byteSize: 1,
          s3Key: locatorMarkers.first,
        },
      ],
    });

    const result = await createThreadCorpusSnapshotLoader(reader)();
    const rows = formattedSourceRows(result.formatted);
    const snapshot = buildPrivateThreadCorpusSnapshot({
      context: snapshotContext(),
      formatted: result.formatted,
      hydration: {
        attachmentLocators: result.attachmentLocators,
        payloads: result.attachmentLocators.map((locator) => ({
          kind: 'attachment_text' as const,
          attachmentId: locator.attachmentId,
          status: 'unsupported' as const,
        })),
      },
    });

    expect(calls).toEqual([
      'begin',
      'scope',
      'messages',
      'attachments',
      'draft-revisions',
      'queue',
      'end',
    ]);
    expect(result.activeTransportScope).toEqual({
      asOf: AS_OF,
      transportIds: ACTIVE_TRANSPORT_IDS,
    });
    expect(rows.map((row) => row.scopeMembership)).toEqual([
      ['active_transport'],
      ['active_transport'],
    ]);
    expect(rows.map((row) => row.privateMessage?.sourceMetadata)).toEqual([
      { transportId: 'transport-a' },
      { transportId: 'transport-z' },
    ]);
    expect(result.attachmentLocators.map((locator) => locator.attachmentId)).toEqual([
      'attachment-a',
      'attachment-z',
    ]);
    for (const marker of Object.values(locatorMarkers)) {
      expect(snapshot.corpusJsonl).not.toContain(marker);
      expect(snapshot.manifestJson).not.toContain(marker);
    }
  });

  it('preserves draft history while counting distinct drafts and revisions', async () => {
    const revisionLinks: ThreadCorpusDraftRevisionLink[] = [
      { messageId: 'message-a', draftId: 'draft-a', revisionId: 'revision-created' },
      { messageId: 'message-a', draftId: 'draft-a', revisionId: 'revision-edited' },
      { messageId: 'message-a', draftId: 'draft-a', revisionId: 'revision-sent' },
    ];
    const { reader } = createSyntheticSnapshotReader({
      messages: [messageRow()],
      draftRevisionLinks: revisionLinks,
    });

    const result = await createThreadCorpusSnapshotLoader(reader)();
    const rows = formattedSourceRows(result.formatted);
    const snapshot = buildPrivateThreadCorpusSnapshot({
      context: snapshotContext(),
      formatted: result.formatted,
      hydration: { attachmentLocators: [], payloads: [] },
    });

    expect(rows[0]?.privateMessage?.draftRevisionLinks).toEqual(revisionLinks);
    expect(snapshot.manifest.counts.drafts).toBe(1);
    expect(snapshot.manifest.counts.revisions).toBe(3);
  });

  it('rejects a revision linked to more than one source message', async () => {
    const { reader } = createSyntheticSnapshotReader({
      messages: [
        messageRow(),
        messageRow({ id: 'message-z', threadId: 'thread-z', messageId: '<message-z@example.test>' }),
      ],
      draftRevisionLinks: [
        { messageId: 'message-a', draftId: 'draft-a', revisionId: 'revision-sent' },
        { messageId: 'message-z', draftId: 'draft-a', revisionId: 'revision-sent' },
      ],
    });
    const result = await createThreadCorpusSnapshotLoader(reader)();

    expect(() =>
      buildPrivateThreadCorpusSnapshot({
        context: snapshotContext(),
        formatted: result.formatted,
        hydration: { attachmentLocators: [], payloads: [] },
      }),
    ).toThrow('Invalid private snapshot contract');
  });

  it.each([
    {
      description: 'a missing raw source with locator',
      input: {
        messages: [
          messageRow({
            rawMime: { locator: 'SYNTHETIC_INVALID_RAW_LOCATOR', status: 'missing' },
          }),
        ],
      },
      marker: 'SYNTHETIC_INVALID_RAW_LOCATOR',
    },
    {
      description: 'a malformed included attachment descriptor',
      input: {
        attachments: [
          {
            id: 'attachment-malformed',
            messageId: 'message-a',
            filename: 'SYNTHETIC_INVALID_ATTACHMENT_FILENAME',
            contentType: 'text/plain',
            byteSize: 1,
            s3Key: '',
          },
        ],
      },
      marker: 'SYNTHETIC_INVALID_ATTACHMENT_FILENAME',
    },
  ])('fails closed for $description without leaking fixture values', async ({ input, marker }) => {
    let message = '';
    try {
      await createThreadCorpusSnapshotLoader(createSyntheticSnapshotReader(input).reader)();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Invalid thread corpus source contract');
    expect(message).not.toContain(marker);
  });

  it.each([
    {
      description: 'an attachment with an unknown owner',
      input: {
        attachments: [
          {
            id: 'attachment-unknown-owner',
            messageId: 'unknown-owner',
            filename: 'synthetic.txt',
            contentType: 'text/plain',
            byteSize: 1,
            s3Key: 'SYNTHETIC_UNKNOWN_OWNER_LOCATOR',
          },
        ],
      },
    },
    {
      description: 'duplicate attachment IDs across active source rows',
      input: {
        messages: [
          messageRow(),
          messageRow({
            id: 'message-z',
            transportId: 'transport-z',
            threadId: 'thread-z',
            messageId: '<message-z@example.test>',
          }),
        ],
        attachments: [
          {
            id: 'attachment-duplicate',
            messageId: 'message-a',
            filename: 'a.txt',
            contentType: 'text/plain',
            byteSize: 1,
            s3Key: 'SYNTHETIC_DUPLICATE_A',
          },
          {
            id: 'attachment-duplicate',
            messageId: 'message-z',
            filename: 'z.txt',
            contentType: 'text/plain',
            byteSize: 1,
            s3Key: 'SYNTHETIC_DUPLICATE_Z',
          },
        ],
      },
    },
  ])('fails closed for $description', async ({ input }) => {
    await expect(
      createThreadCorpusSnapshotLoader(createSyntheticSnapshotReader(input).reader)(),
    ).rejects.toThrow('Invalid thread corpus source contract');
  });

  it('rejects an attachment descriptor associated with a different source row', () => {
    const formatted = formatLogicalMessages([
      sourceRow({
        sourceRowId: 'message-a',
        privateMessage: privateMessage({
          attachments: [
            {
              id: 'attachment-wrong-owner',
              messageId: 'message-z',
              filename: 'wrong-owner.txt',
              contentType: 'text/plain',
              byteSize: 1,
            },
          ],
        }),
      }),
    ]);

    expect(() =>
      buildPrivateThreadCorpusSnapshot({
        context: snapshotContext(),
        formatted,
        hydration: {
          attachmentLocators: [
            {
              attachmentId: 'attachment-wrong-owner',
              messageId: 'message-a',
              s3Key: 'SYNTHETIC_WRONG_OWNER_LOCATOR',
              mimeType: 'text/plain',
              sizeBytes: 1,
            },
          ],
          payloads: [
            {
              kind: 'attachment_text',
              attachmentId: 'attachment-wrong-owner',
              status: 'unsupported',
            },
          ],
        },
      }),
    ).toThrow('Invalid private snapshot contract');
  });
});

function sourceGuardViolations(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    'centurion-thread-corpus-snapshot.ts',
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const expectedImports = new Map<string, { defaultName?: string; named?: readonly string[] }>([
    ['node:crypto', { named: ['createHash'] }],
    [
      'node:fs/promises',
      {
        named: [
          'chmod',
          'lstat',
          'mkdir',
          'mkdtemp',
          'realpath',
          'rename',
          'rm',
          'stat',
          'writeFile',
        ],
      },
    ],
    ['node:path', { defaultName: 'path' }],
    [
      './private-output.js',
      {
        named: [
          'assertTrustedPrivateDirectory',
          'ensureTrustedPrivateDirectory',
          'prepareExistingTrustedPrivateOutputRoot',
          'prepareTrustedPrivateOutputRoot',
          'samePrivateOutputPath',
          'setPrivateOutputMode',
          'PrivateOutputRootVerifier',
          'PrivateOutputWindowsAclEnforcer',
          'TrustedPrivateOutputRoot',
        ],
      },
    ],
  ]);
  const violations: string[] = [];

  for (const statement of sourceFile.statements) {
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
    if (!clause || clause.name?.text !== expected.defaultName) {
      violations.push(`Import ${moduleName} has invalid default binding`);
    }
    if (!expected.defaultName && clause?.name) {
      violations.push(`Import ${moduleName} must not have a default binding`);
    }
    const actual =
      clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.map((element) => {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported !== element.name.text) {
              violations.push(`Import ${moduleName} must not alias ${imported}`);
            }
            return imported;
          })
        : [];
    if (JSON.stringify([...actual].sort()) !== JSON.stringify([...(expected.named ?? [])].sort())) {
      violations.push(`Import ${moduleName} bindings are not exact`);
    }
  }

  const forbiddenIdentifiers = new Set([
    'Function',
    'console',
    'eval',
    'fetch',
    'global',
    'globalThis',
    'process',
    'require',
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
      violations.push(`${node.text} capability identifier is prohibited`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.push('Dynamic import is prohibited');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('snapshot source boundary', () => {
  it('keeps source limited to local private-artifact capabilities', () => {
    const sourcePath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-snapshot.ts', import.meta.url),
    );
    expect(sourceGuardViolations(readFileSync(sourcePath, 'utf8'))).toEqual([]);
  });

  it('rejects alias imports and prohibited runtime capability references', () => {
    expect(
      sourceGuardViolations(
        "import { readFile as harmless } from 'node:fs/promises';\nharmless('synthetic');",
      ),
    ).toContain('Import node:fs/promises must not alias readFile');
    for (const fixture of [
      "console.log('SYNTHETIC_LOCATOR_MARKER');",
      'globalThis.process.env.DATABASE_URL;',
      "globalThis.fetch('https://synthetic.invalid');",
      "const load = require; load('synthetic');",
    ]) {
      expect(sourceGuardViolations(fixture)).not.toEqual([]);
    }
  });
});

describe('sealed active transport hydration artifacts', () => {
  it('rejects available raw MIME bytes when raw MIME retention is disabled', () => {
    const fixture = sealedArtifactFixture();

    expect(() =>
      buildPrivateThreadCorpusSnapshot({
        context: snapshotContext(),
        formatted: fixture.formatted,
        hydration: {
          ...fixture.hydration,
          retainRawMime: false,
        },
      }),
    ).toThrow('Invalid private snapshot contract');
  });

  it('builds deterministic opaque artifact references without locators', () => {
    const fixture = sealedArtifactFixture();
    const context = { ...snapshotContext(), snapshotId: 'artifact-snapshot' };
    const snapshot = buildPrivateThreadCorpusSnapshot({
      context,
      formatted: fixture.formatted,
      hydration: fixture.hydration,
    });
    const repeated = buildPrivateThreadCorpusSnapshot({
      context,
      formatted: formatLogicalMessages([...fixture.rows].reverse()),
      hydration: {
        attachmentLocators: [...fixture.hydration.attachmentLocators].reverse(),
        payloads: [...fixture.hydration.payloads].reverse(),
      },
    });
    const { records } = parseSnapshotCorpus(snapshot);
    const availableRow = sourceRowFromRecords(records, 'available-row');
    const pendingRow = sourceRowFromRecords(records, 'pending-row');
    const availableRawMime = (availableRow.privateMessage as JsonObject).rawMime;
    const pendingRawMime = (pendingRow.privateMessage as JsonObject).rawMime;

    expect(repeated).toEqual(snapshot);
    expect(pendingRawMime).toEqual({ status: 'read_failed', artifact: null });
    expect(availableRawMime).toEqual({
      status: 'available',
      artifact: {
        id: artifactId(context.snapshotId, 'raw_mime', 'available-row'),
        sha256: sha256Bytes(fixture.rawMimeBytes),
        bytes: fixture.rawMimeBytes.byteLength,
      },
    });
    expect(snapshot.artifactFiles.map(({ content: _content, ...artifact }) => artifact)).toEqual([
      {
        kind: 'attachment_text',
        id: artifactId(context.snapshotId, 'attachment_text', 'attachment-available'),
        sha256: sha256Bytes(fixture.attachmentTextBytes),
        bytes: fixture.attachmentTextBytes.byteLength,
      },
      {
        kind: 'raw_mime',
        id: artifactId(context.snapshotId, 'raw_mime', 'available-row'),
        sha256: sha256Bytes(fixture.rawMimeBytes),
        bytes: fixture.rawMimeBytes.byteLength,
      },
    ]);
    for (const marker of [
      fixture.markers.rawPendingLocator,
      fixture.markers.rawAvailableLocator,
      fixture.markers.attachmentAvailableLocator,
      fixture.markers.attachmentFailedLocator,
    ]) {
      expect(snapshot.corpusJsonl).not.toContain(marker);
      expect(snapshot.manifestJson).not.toContain(marker);
    }
    expect(() => validatePrivateThreadCorpusSnapshot(snapshot)).not.toThrow();
  });

  it('seals budget exhaustion without bytes and rejects malformed hydration coverage', () => {
    const fixture = sealedArtifactFixture();
    const context = { ...snapshotContext(), snapshotId: 'budget-snapshot' };
    const budgetHydration: ThreadCorpusHydrationInput = {
      ...fixture.hydration,
      payloads: fixture.hydration.payloads.map((payload) => {
        if (payload.kind === 'raw_mime' && payload.sourceRowId === 'pending-row') {
          return {
            kind: 'raw_mime' as const,
            sourceRowId: payload.sourceRowId,
            status: 'budget_exhausted' as const,
          };
        }
        if (payload.kind === 'attachment_text' && payload.attachmentId === 'attachment-failed') {
          return {
            kind: 'attachment_text' as const,
            attachmentId: payload.attachmentId,
            status: 'budget_exhausted' as const,
          };
        }
        return payload;
      }),
    };
    const snapshot = buildPrivateThreadCorpusSnapshot({
      context,
      formatted: fixture.formatted,
      hydration: budgetHydration,
    });
    const { records } = parseSnapshotCorpus(snapshot);
    const pendingPrivateMessage = sourceRowFromRecords(records, 'pending-row')
      .privateMessage as JsonObject;
    const budgetAttachment = (pendingPrivateMessage.attachments as JsonObject[]).find(
      (attachment) => attachment.id === 'attachment-failed',
    );

    expect((pendingPrivateMessage.rawMime as JsonObject).status).toBe('budget_exhausted');
    expect(budgetAttachment).toBeDefined();
    expect((budgetAttachment!.textArtifact as JsonObject).status).toBe('budget_exhausted');
    expect(() =>
      buildPrivateThreadCorpusSnapshot({
        context,
        formatted: fixture.formatted,
        hydration: {
          ...budgetHydration,
          payloads: [
            ...budgetHydration.payloads,
            { kind: 'raw_mime', sourceRowId: 'orphan-row', status: 'read_failed' },
          ],
        },
      }),
    ).toThrow('Invalid private snapshot contract');
    expect(() =>
      buildPrivateThreadCorpusSnapshot({
        context,
        formatted: fixture.formatted,
        hydration: {
          ...budgetHydration,
          payloads: budgetHydration.payloads.map((payload) =>
            payload.kind === 'raw_mime' && payload.sourceRowId === 'pending-row'
              ? { ...payload, content: new Uint8Array([1]) }
              : payload,
          ),
        },
      }),
    ).toThrow('Invalid private snapshot contract');
  });
});

describe('corpus postgres reader explicit transport scope', () => {
  it('rejects omitted or empty transport IDs at reader construction', () => {
    expect(() =>
      createThreadCorpusPostgresReader({
        databaseUrl: 'postgresql://localhost/synthetic',
      }),
    ).toThrow('Explicit transport scope is required');
    expect(() =>
      createThreadCorpusPostgresReader({
        databaseUrl: 'postgresql://localhost/synthetic',
        transportIds: [],
      }),
    ).toThrow('Explicit transport scope is required');
  });
});
