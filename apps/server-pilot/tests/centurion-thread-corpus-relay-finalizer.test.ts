import {
  type FinalizeJournalV1,
  type RelayBucketConfig,
  type RelayJournalRead,
  type RelayObjectMetadata,
  type RelayObjectStore,
  type RelaySourceRuntimeConfig,
  type RelaySourceRuntimePort,
  type StageIntentV2,
} from '../src/ops/centurion-thread-corpus-relay-producer.js';
import {
  buildReceiverAcknowledgement,
  receiverAcknowledgementKey,
  relayManifestKey,
  relayObjectKey,
} from '../src/ops/centurion-thread-corpus-relay.js';
import {
  buildCenturionThreadCorpusReadinessAttestation,
  type ReadinessAttestationBindingInputV1,
} from '../src/ops/centurion-thread-corpus-readiness.js';
import { createFinalizeCenturionThreadCorpusRelayCommand } from '../scripts/finalize-centurion-thread-corpus-relay.js';
import { finalizeCenturionThreadCorpusRelay } from '../src/ops/centurion-thread-corpus-relay-finalizer.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

const TRANSFER_ID = '3479ca40-b5a1-4bb3-aef1-02fcbefc949c';
const SAFE_SOURCE_PATH = '/synthetic/safe-finalize-snapshot';
const SAFE_ERROR_MARKER = 'SAFE_FINALIZE_ERROR_MARKER';
const textEncoder = new TextEncoder();

const relayConfig: RelayBucketConfig = {
  region: 'synthetic-region-1',
  bucket: 'synthetic-private-relay',
  expectedBucketOwner: '123456789012',
  literalRelayRoot: 'private-relay',
  kmsKeyArn: 'arn:aws:kms:synthetic-region-1:123456789012:key/12345678-1234-1234-1234-123456789abc',
  lifecycleRuleId: 'private-relay-one-day',
  lifecycleExpirationDays: 1,
  maxSnapshotBytes: 1_000_000,
};

const readinessBinding: ReadinessAttestationBindingInputV1 = {
  corpusContractId: 'centurion-thread-corpus-v2',
  expectedInstanceId: 'i-synthetic-approved',
  expectedRevision: 'f4581cf6',
  expectedWorktree: '/synthetic/zero',
  designatedSourceScope: {
    centurionTransportId: 'synthetic-centurion-transport',
    designatedTransportId: 'synthetic-designated-transport',
    mailboxIds: ['synthetic-mailbox'],
    addresses: [' safe-finalize@example.test '],
  },
};

const allGreenReadinessReport = {
  schemaVersion: 'centurion-thread-corpus-readiness-report-v1',
  outcome: 'ready',
  code: 'CENTURION_THREAD_CORPUS_READY',
  ready: true,
  checks: {
    exactEc2RevisionWorktree: true,
    imdsV2Identity: true,
    protectedConfig: true,
    designatedMailboxScope: true,
    regionBucketPrefixAllowlist: true,
    readOnlyDbS3KmsCapabilities: true,
    sourceDiskHeadroom: true,
    privateDestinationIgnored: true,
    windowsLocalAclTarget: true,
    v2Semantics: true,
  },
} as const;

const runtimeConfig: RelaySourceRuntimeConfig = {
  version: 'centurion-thread-corpus-relay-source-config-v1',
  expectedEc2: {
    instanceId: 'i-synthetic-approved',
    revision: 'f4581cf6',
    worktree: '/synthetic/zero',
  },
  relay: relayConfig,
  sourceSnapshot: {
    directChildName: 'safe-finalize-snapshot',
  },
  readinessAttestationBinding: readinessBinding,
};

const readinessAttestation = buildCenturionThreadCorpusReadinessAttestation(
  allGreenReadinessReport,
  readinessBinding,
)!;

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function metadata(key: string, content: Uint8Array): RelayObjectMetadata {
  return {
    key,
    bytes: content.byteLength,
    sha256: sha256(content),
    serverSideEncryption: 'aws:kms',
    sseKmsKeyId: relayConfig.kmsKeyArn,
  };
}

type StoredObject = {
  content: Uint8Array;
  metadata: RelayObjectMetadata;
};

function relayPrefix(): string {
  const key = relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID);
  return key.slice(0, -'relay-manifest.v1.json'.length);
}

function stageIntent(): StageIntentV2 {
  const corpus = textEncoder.encode('SAFE_FINALIZE_CORPUS');
  const manifest = textEncoder.encode('SAFE_FINALIZE_MANIFEST');
  const members = [
    { path: 'corpus.jsonl', bytes: corpus.byteLength, sha256: sha256(corpus) },
    { path: 'manifest.json', bytes: manifest.byteLength, sha256: sha256(manifest) },
  ];
  return {
    schemaVersion: 'centurion-thread-corpus-relay-stage-intent-v2',
    transferId: TRANSFER_ID,
    literalRelayRoot: relayConfig.literalRelayRoot,
    sourceSnapshot: {
      directChildName: runtimeConfig.sourceSnapshot.directChildName,
      stableIdentity: 'safe-source-identity',
    },
    snapshotId: 'safe-snapshot-001',
    sourceManifestSha256: members[1]!.sha256,
    memberSetSha256: sha256(
      textEncoder.encode(
        members
          .map((candidate) => `${candidate.path}\t${candidate.bytes}\t${candidate.sha256}\n`)
          .join(''),
      ),
    ),
    members,
    createdKeys: [
      ...members.map((candidate) =>
        relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, candidate.path),
      ),
      relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID),
    ],
    state: 'staged',
    readinessAttestation,
  };
}

class FakeRelayStore implements RelayObjectStore {
  readonly calls: string[] = [];
  readonly objects = new Map<string, StoredObject>();
  readonly deleteCalls: string[][] = [];
  assertResult = true;
  deleteResult = true;
  postDeleteExtra: RelayObjectMetadata | null = null;
  deleted = false;

  async assertRelayBucket(config: RelayBucketConfig): Promise<boolean> {
    this.calls.push('assert');
    expect(config).toEqual(relayConfig);
    return this.assertResult;
  }

  async putIfAbsent(): Promise<'created' | 'already_exists' | 'conflict'> {
    throw new Error('finalizer must not PUT');
  }

  async head(key: string): Promise<RelayObjectMetadata | null> {
    this.calls.push(`head:${key}`);
    const object = this.objects.get(key);
    return object ? { ...object.metadata } : null;
  }

  async listAll(prefix: string): Promise<readonly RelayObjectMetadata[] | null> {
    this.calls.push(`list:${prefix}`);
    const listed = [...this.objects.values()]
      .map((object) => object.metadata)
      .filter((candidate) => candidate.key.startsWith(prefix));
    if (this.deleted && this.postDeleteExtra) listed.push(this.postDeleteExtra);
    return listed.sort((left, right) => left.key.localeCompare(right.key));
  }

  async getBounded(key: string): Promise<Uint8Array | null> {
    this.calls.push(`get:${key}`);
    const object = this.objects.get(key);
    return object ? new Uint8Array(object.content) : null;
  }

  async deleteExact(keys: readonly string[]): Promise<boolean> {
    this.calls.push(`delete:${keys.join(',')}`);
    this.deleteCalls.push([...keys]);
    if (!this.deleteResult) return false;
    for (const key of keys) this.objects.delete(key);
    this.deleted = true;
    return true;
  }
}

class FakeSourceRuntime implements RelaySourceRuntimePort {
  readonly calls: string[] = [];
  readonly journalWrites: FinalizeJournalV1[] = [];
  stage: StageIntentV2 | null = stageIntent();
  journal: FinalizeJournalV1 | null = null;
  removeResult = true;
  platformResult = 'linux';
  imdsResult = true;
  stageReadOverride: RelayJournalRead<StageIntentV2> | null = null;
  journalReadOverride: RelayJournalRead<FinalizeJournalV1> | null = null;
  git = {
    revision: `${runtimeConfig.expectedEc2.revision}\n`,
    worktree: `${runtimeConfig.expectedEc2.worktree}\n`,
    status: '',
  };

  platform(): string {
    this.calls.push('platform');
    return this.platformResult;
  }

  async attestImdsV2(): Promise<boolean> {
    this.calls.push('imds');
    return this.imdsResult;
  }

  async readProtectedConfig(): Promise<string> {
    this.calls.push('config');
    return JSON.stringify(runtimeConfig);
  }

  inspectGit(check: 'revision' | 'worktree' | 'status'): string | null {
    this.calls.push(`git:${check}`);
    return this.git[check];
  }

  async inspectTrustedSnapshot(): Promise<null> {
    throw new Error('finalizer must not inspect or read source bytes');
  }

  async readBoundedTrustedSnapshot(): Promise<null> {
    throw new Error('finalizer must not read source bytes');
  }

  async writeStageIntent(): Promise<boolean> {
    throw new Error('finalizer must not rewrite stage intent');
  }

  async readStageIntent(transferId: string): Promise<RelayJournalRead<StageIntentV2>> {
    this.calls.push('read-stage');
    expect(transferId).toBe(TRANSFER_ID);
    if (this.stageReadOverride) return this.stageReadOverride;
    return this.stage
      ? { outcome: 'present', value: structuredClone(this.stage) }
      : { outcome: 'absent' };
  }

  async writeFinalizeJournal(journal: FinalizeJournalV1): Promise<boolean> {
    this.calls.push(`write-journal:${journal.state}`);
    this.journal = structuredClone(journal);
    this.journalWrites.push(structuredClone(journal));
    return true;
  }

  async readFinalizeJournal(transferId: string): Promise<RelayJournalRead<FinalizeJournalV1>> {
    this.calls.push('read-journal');
    expect(transferId).toBe(TRANSFER_ID);
    if (this.journalReadOverride) return this.journalReadOverride;
    return this.journal
      ? { outcome: 'present', value: structuredClone(this.journal) }
      : { outcome: 'absent' };
  }

  async removeTrustedSnapshot(snapshot: StageIntentV2['sourceSnapshot']): Promise<boolean> {
    this.calls.push('remove-source');
    expect(snapshot).toEqual(
      this.stage?.sourceSnapshot ?? this.journal?.stageIntent.sourceSnapshot,
    );
    return this.removeResult;
  }
}

function acknowledgedHarness(): {
  store: FakeRelayStore;
  source: FakeSourceRuntime;
  acknowledgementKey: string;
  acknowledgementSha256: string;
  receiveReceiptSha256: string;
} {
  const store = new FakeRelayStore();
  const source = new FakeSourceRuntime();
  const intent = source.stage!;
  const memberContents = [
    textEncoder.encode('SAFE_FINALIZE_CORPUS'),
    textEncoder.encode('SAFE_FINALIZE_MANIFEST'),
  ];
  for (const [index, candidate] of intent.members.entries()) {
    const key = relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, candidate.path);
    const content = memberContents[index]!;
    store.objects.set(key, { content, metadata: metadata(key, content) });
  }

  const relayManifest = textEncoder.encode('{\n  "safe": "relay-manifest"\n}\n');
  const relayManifestObjectKey = relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID);
  store.objects.set(relayManifestObjectKey, {
    content: relayManifest,
    metadata: metadata(relayManifestObjectKey, relayManifest),
  });

  const receiveReceiptSha256 = '3'.repeat(64);
  const acknowledgement = textEncoder.encode(
    buildReceiverAcknowledgement({
      transferId: TRANSFER_ID,
      snapshotId: intent.snapshotId,
      sourceManifestSha256: intent.sourceManifestSha256,
      relayManifestSha256: sha256(relayManifest),
      memberSetSha256: intent.memberSetSha256,
      receiveReceiptSha256,
    }),
  );
  const acknowledgementKey = receiverAcknowledgementKey(relayConfig.literalRelayRoot, TRANSFER_ID);
  store.objects.set(acknowledgementKey, {
    content: acknowledgement,
    metadata: metadata(acknowledgementKey, acknowledgement),
  });
  return {
    store,
    source,
    acknowledgementKey,
    acknowledgementSha256: sha256(acknowledgement),
    receiveReceiptSha256,
  };
}

function journalFor(
  source: FakeSourceRuntime,
  acknowledgementSha256: string,
  receiveReceiptSha256: string,
  state: FinalizeJournalV1['state'],
): FinalizeJournalV1 {
  return {
    schemaVersion: 'centurion-thread-corpus-relay-finalize-journal-v1',
    stageIntent: source.stage!,
    receiveReceiptSha256,
    acknowledgementSha256,
    state,
  };
}

function finalize(store: FakeRelayStore, source: FakeSourceRuntime) {
  return finalizeCenturionThreadCorpusRelay({
    config: runtimeConfig,
    transferId: TRANSFER_ID,
    store,
    source,
  });
}

function assertNoFixtureLeak(value: unknown): void {
  const output = JSON.stringify(value);
  expect(output).not.toContain(SAFE_SOURCE_PATH);
  expect(output).not.toContain(SAFE_ERROR_MARKER);
}

describe('Centurion relay finalizer', () => {
  it('verifies encrypted acknowledgement, journals every transition, proves empty relay, then removes source', async () => {
    const { store, source, acknowledgementKey } = acknowledgedHarness();
    const intent = source.stage!;

    const result = await finalize(store, source);

    expect(result).toEqual({ outcome: 'complete', transferId: TRANSFER_ID });
    expect(source.journalWrites.map((journal) => journal.state)).toEqual([
      'ack_verified',
      'relay_delete_started',
      'relay_empty',
      'source_delete_started',
      'complete',
    ]);
    expect(store.deleteCalls).toEqual([[...intent.createdKeys, acknowledgementKey]]);
    const emptyListIndex = store.calls.lastIndexOf(`list:${relayPrefix()}`);
    expect(emptyListIndex).toBeGreaterThan(
      store.calls.indexOf(`delete:${[...intent.createdKeys, acknowledgementKey].join(',')}`),
    );
    expect(source.calls).toContain('write-journal:source_delete_started');
    expect(source.calls.indexOf('remove-source')).toBeGreaterThan(
      source.calls.indexOf('write-journal:source_delete_started'),
    );
    assertNoFixtureLeak(result);
  });

  it.each(['missing acknowledgement', 'wrong KMS metadata', 'noncanonical acknowledgement'])(
    'blocks %s before deleting relay or source',
    async (kind) => {
      const { store, source, acknowledgementKey } = acknowledgedHarness();
      if (kind === 'missing acknowledgement') {
        store.objects.delete(acknowledgementKey);
      } else if (kind === 'wrong KMS metadata') {
        const object = store.objects.get(acknowledgementKey)!;
        object.metadata = {
          ...object.metadata,
          sseKmsKeyId: 'arn:aws:kms:synthetic-region-1:123456789012:key/wrong-key',
        };
      } else {
        const object = store.objects.get(acknowledgementKey)!;
        object.content = textEncoder.encode(`{ "${SAFE_ERROR_MARKER}": true }`);
        object.metadata = metadata(acknowledgementKey, object.content);
      }

      expect(await finalize(store, source)).toEqual({ outcome: 'blocked' });
      expect(store.deleteCalls).toEqual([]);
      expect(source.calls).not.toContain('remove-source');
    },
  );

  it.each([
    {
      name: 'legacy V1 stage intent',
      configure: (source: FakeSourceRuntime) => {
        source.stage = {
          ...source.stage!,
          schemaVersion: 'centurion-thread-corpus-relay-stage-intent-v1',
        } as unknown as StageIntentV2;
      },
    },
    {
      name: 'tampered persisted stage attestation',
      configure: (source: FakeSourceRuntime) => {
        source.stage = {
          ...source.stage!,
          readinessAttestation: {
            ...source.stage!.readinessAttestation,
            bindingSha256: '0'.repeat(64),
          },
        };
      },
    },
    {
      name: 'tampered durable finalization attestation',
      configure: (source: FakeSourceRuntime) => {
        source.journal = {
          ...journalFor(source, '4'.repeat(64), '3'.repeat(64), 'ack_verified'),
          stageIntent: {
            ...source.stage!,
            readinessAttestation: {
              ...source.stage!.readinessAttestation,
              bindingSha256: '0'.repeat(64),
            },
          },
        };
      },
    },
  ])('blocks $name before relay or source deletion', async ({ configure }) => {
    const { store, source } = acknowledgedHarness();
    configure(source);

    expect(await finalize(store, source)).toEqual({ outcome: 'blocked' });
    expect(store.deleteCalls).toEqual([]);
    expect(source.calls).not.toContain('remove-source');
  });

  it('blocks an unreadable finalize journal before relay or source deletion', async () => {
    const { store, source } = acknowledgedHarness();
    source.journalReadOverride = { outcome: 'blocked' };

    expect(await finalize(store, source)).toEqual({ outcome: 'blocked' });
    expect(store.deleteCalls).toEqual([]);
    expect(source.calls).not.toContain('remove-source');
  });

  it('persists delete-start before a failed delete and never removes source', async () => {
    const { store, source } = acknowledgedHarness();
    store.deleteResult = false;

    expect(await finalize(store, source)).toEqual({ outcome: 'blocked' });
    expect(source.journalWrites.map((journal) => journal.state)).toEqual([
      'ack_verified',
      'relay_delete_started',
    ]);
    expect(source.calls).not.toContain('remove-source');
  });

  it('blocks when prefix remains nonempty after exact delete and never removes source', async () => {
    const { store, source } = acknowledgedHarness();
    store.postDeleteExtra = {
      key: `${relayPrefix()}unexpected-safe-object`,
      bytes: 1,
      sha256: '0'.repeat(64),
      serverSideEncryption: 'aws:kms',
      sseKmsKeyId: relayConfig.kmsKeyArn,
    };

    expect(await finalize(store, source)).toEqual({ outcome: 'blocked' });
    expect(source.journalWrites.map((journal) => journal.state)).toEqual([
      'ack_verified',
      'relay_delete_started',
    ]);
    expect(source.calls).not.toContain('remove-source');
  });

  it('persists source-delete-start before source deletion failure', async () => {
    const { store, source } = acknowledgedHarness();
    source.removeResult = false;

    expect(await finalize(store, source)).toEqual({ outcome: 'blocked' });
    expect(source.journalWrites.map((journal) => journal.state)).toEqual([
      'ack_verified',
      'relay_delete_started',
      'relay_empty',
      'source_delete_started',
    ]);
    expect(source.calls).toContain('remove-source');
  });

  it.each([
    'ack_verified',
    'relay_delete_started',
    'relay_empty',
    'source_delete_started',
    'complete',
  ] as const)('retries deterministically from persisted %s state', async (state) => {
    const { store, source, acknowledgementSha256, receiveReceiptSha256 } = acknowledgedHarness();
    source.journal = journalFor(source, acknowledgementSha256, receiveReceiptSha256, state);
    if (state === 'relay_empty' || state === 'source_delete_started' || state === 'complete') {
      store.objects.clear();
    }

    expect(await finalize(store, source)).toEqual({ outcome: 'complete', transferId: TRANSFER_ID });
    if (state === 'complete') {
      expect(store.deleteCalls).toEqual([]);
      expect(source.calls).not.toContain('remove-source');
    } else {
      expect(source.journal?.state).toBe('complete');
    }
  });
});

describe('finalize Centurion relay command', () => {
  it('accepts exactly one UUID and emits only fixed PII-free cleanup receipt JSON', async () => {
    const { store, source } = acknowledgedHarness();
    const stdout: string[] = [];
    const command = createFinalizeCenturionThreadCorpusRelayCommand({
      args: () => ['--transfer-id', TRANSFER_ID],
      runtime: source,
      objectStoreFor: () => store,
      writeStdout: (value) => stdout.push(value),
    });

    expect(await command()).toBe(0);
    expect(stdout).toEqual([
      `${JSON.stringify({
        schemaVersion: 'centurion-thread-corpus-relay-cleanup-receipt-v1',
        outcome: 'complete',
        transferId: TRANSFER_ID,
      })}\n`,
    ]);
    assertNoFixtureLeak(stdout);
  });

  it('blocks malformed or extra finalizer arguments before protected configuration access', async () => {
    const { store, source } = acknowledgedHarness();
    const stdout: string[] = [];
    const command = createFinalizeCenturionThreadCorpusRelayCommand({
      args: () => ['--transfer-id', 'not-a-uuid', '--extra'],
      runtime: source,
      objectStoreFor: () => store,
      writeStdout: (value) => stdout.push(value),
    });

    expect(await command()).toBe(2);
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-cleanup-receipt-v1","outcome":"blocked"}\n',
    ]);
    expect(source.calls).toEqual([]);
    assertNoFixtureLeak(stdout);
  });
});
