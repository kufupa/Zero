import {
  classifyRelayJournalReadFailure,
  createAwsRelayObjectStore,
  parseRelaySourceRuntimeConfig,
  parseRelaySourceRuntimeConfigSnapshot,
  stageCenturionThreadCorpusRelay,
  type FinalizeJournalV1,
  type RelayBucketConfig,
  type RelayJournalRead,
  type RelayObjectMetadata,
  type RelayObjectStore,
  type RelayPutInput,
  type RelaySourceRuntimeConfig,
  type RelaySourceRuntimePort,
  type ResumableStageDiscovery,
  type StageIntentV2,
} from '../src/ops/centurion-thread-corpus-relay-producer.js';
import {
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  buildCenturionThreadCorpusReadinessAttestation,
  type CenturionThreadCorpusReadinessAttestationV1,
  type ReadinessAttestationBindingInputV1,
} from '../src/ops/centurion-thread-corpus-readiness.js';
import {
  buildPrivateThreadCorpusSnapshot,
  formatLogicalMessages,
  type PrivateThreadCorpusSnapshot,
} from '../scripts/export-thread-corpus.js';
import {
  relayManifestKey,
  relayObjectKey,
  type CenturionRelayMember,
} from '../src/ops/centurion-thread-corpus-relay.js';
import type { CenturionThreadCorpusReadinessAssessment } from '../scripts/check-centurion-thread-corpus-readiness.js';
import { createStageCenturionThreadCorpusRelayCommand } from '../scripts/stage-centurion-thread-corpus-relay.js';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const TRANSFER_ID = '3479ca40-b5a1-4bb3-aef1-02fcbefc949c';
const SAFE_BODY_MARKER = 'SAFE_RELAY_FIXTURE_BODY';
const SAFE_ADDRESS_MARKER = 'safe-relay@example.test';
const SAFE_PATH_MARKER = '/synthetic/safe-relay-snapshot';
const SAFE_JOURNAL_MARKER = 'SAFE_RELAY_JOURNAL_DETAIL';
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
    mailboxIds: ['synthetic-mailbox-b', 'synthetic-mailbox-a'],
    addresses: [` ${SAFE_ADDRESS_MARKER.toUpperCase()} `],
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
    directChildName: 'safe-relay-snapshot',
  },
  readinessAttestationBinding: readinessBinding,
};

const rotatedRuntimeConfig: RelaySourceRuntimeConfig = {
  ...runtimeConfig,
  relay: {
    ...runtimeConfig.relay,
    literalRelayRoot: 'safe-rotated-relay-root',
  },
};

const readinessAttestation = buildCenturionThreadCorpusReadinessAttestation(
  allGreenReadinessReport,
  readinessBinding,
)!;

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function comparePath(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function member(path: string, content: Uint8Array): CenturionRelayMember {
  return {
    path,
    bytes: content.byteLength,
    sha256: sha256(content),
    content,
  };
}

function syntheticSnapshot(): PrivateThreadCorpusSnapshot {
  const formatted = formatLogicalMessages([
    {
      sourceRowId: 'safe-row-a',
      scopeMembership: ['centurion_transport'],
      receivedAt: '2026-08-22T11:00:00.000Z',
      threadId: 'safe-thread-a',
      messageId: '<safe-message-a@example.test>',
      contentFingerprint: 'safe-content-fingerprint-a',
      provenanceFingerprint: 'safe-provenance-fingerprint-a',
      body: SAFE_BODY_MARKER,
      privateMessage: {
        subject: 'Safe synthetic subject',
        direction: 'inbound',
        addresses: { from: [SAFE_ADDRESS_MARKER], to: [], cc: [], bcc: [] },
        originalAddresses: { from: [SAFE_ADDRESS_MARKER], to: [], cc: [], bcc: [] },
        canonicalHeaders: {},
        sentAt: null,
        rawMime: {
          locator: 'synthetic://safe-raw-mime',
          status: 'available',
        },
        attachments: [],
        draftRevisionLinks: [],
        outboundDelivery: {
          queueState: 'unknown',
          deliveryStatus: 'not_claimed',
        },
        sourceMetadata: {
          transportId: 'transport-centurion',
          ingestMailboxId: null,
          uidl: 'safe-uidl-a',
        },
      },
    },
    {
      sourceRowId: 'safe-row-b',
      scopeMembership: ['centurion_transport'],
      receivedAt: '2026-08-22T11:01:00.000Z',
      threadId: 'safe-thread-b',
      messageId: '<safe-message-b@example.test>',
      contentFingerprint: 'safe-content-fingerprint-b',
      provenanceFingerprint: 'safe-provenance-fingerprint-b',
      body: 'SAFE_RELAY_SECOND_BODY_MARKER',
      privateMessage: {
        subject: 'Safe second synthetic subject',
        direction: 'inbound',
        addresses: { from: [], to: [], cc: [], bcc: [] },
        originalAddresses: { from: [], to: [], cc: [], bcc: [] },
        canonicalHeaders: {},
        sentAt: null,
        rawMime: {
          locator: null,
          status: 'missing',
        },
        attachments: [],
        draftRevisionLinks: [],
        outboundDelivery: {
          queueState: 'unknown',
          deliveryStatus: 'not_claimed',
        },
        sourceMetadata: {
          transportId: 'transport-centurion',
          ingestMailboxId: null,
          uidl: 'safe-uidl-b',
        },
      },
    },
  ]);

  return buildPrivateThreadCorpusSnapshot({
    context: {
      snapshotId: 'safe-snapshot-001',
      scope: {
        scopeKeys: ['centurion_transport', 'designated_reservationist_mailbox'],
        transportIds: ['transport-centurion', 'transport-designated'],
        participantAddressRef: 'private_designated_reservationist_address',
        messagePredicate: 'selected_transports_or_private_designated_address_before_as_of',
        quarantinePredicate: 'selected_ingest_mailbox_or_owner_header_before_as_of',
      },
      asOf: '2026-08-22T12:00:00.000Z',
      exporterVersion: 'safe-relay-test-v1',
      unscopedQuarantineExcluded: 0,
    },
    formatted,
    hydration: {
      attachmentLocators: [],
      payloads: [
        {
          kind: 'raw_mime',
          sourceRowId: 'safe-row-a',
          status: 'available',
          content: textEncoder.encode('SAFE_RAW_MIME_FIXTURE'),
        },
      ],
    },
  });
}

function sourceMembers(snapshot = syntheticSnapshot()): CenturionRelayMember[] {
  return [
    member('corpus.jsonl', textEncoder.encode(snapshot.corpusJsonl)),
    member('manifest.json', textEncoder.encode(snapshot.manifestJson)),
    ...snapshot.artifactFiles.map((artifact) =>
      member(
        artifact.kind === 'raw_mime'
          ? `raw-mime/${artifact.id}.eml`
          : `attachment-text/${artifact.id}.txt`,
        new Uint8Array(artifact.content),
      ),
    ),
  ].sort((left, right) => comparePath(left.path, right.path));
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

function stagePrefix(): string {
  const manifestKey = relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID);
  return manifestKey.slice(0, -'relay-manifest.v1.json'.length);
}

type StoredObject = {
  content: Uint8Array;
  metadata: RelayObjectMetadata;
};

class FakeRelayStore implements RelayObjectStore {
  readonly calls: string[] = [];
  readonly objects = new Map<string, StoredObject>();
  readonly deleteCalls: string[][] = [];
  assertResult = true;
  deleteResult = true;
  extraListedObjects: RelayObjectMetadata[] = [];
  putOverride = new Map<string, 'created' | 'already_exists' | 'conflict'>();
  materializeConflict = new Set<string>();

  async assertRelayBucket(config: RelayBucketConfig): Promise<boolean> {
    this.calls.push('assert');
    expect(config).toEqual(relayConfig);
    return this.assertResult;
  }

  async putIfAbsent(input: RelayPutInput): Promise<'created' | 'already_exists' | 'conflict'> {
    this.calls.push(`put:${input.key}`);
    const override = this.putOverride.get(input.key);
    const existing = this.objects.get(input.key);
    if (existing && !override) return 'already_exists';
    if (override === 'conflict' && !this.materializeConflict.has(input.key)) return 'conflict';

    if (!existing) {
      this.objects.set(input.key, {
        content: new Uint8Array(input.content),
        metadata: {
          key: input.key,
          bytes: input.bytes,
          sha256: input.sha256,
          serverSideEncryption: 'aws:kms',
          sseKmsKeyId: input.kmsKeyArn,
        },
      });
    }
    return override ?? 'created';
  }

  async head(key: string): Promise<RelayObjectMetadata | null> {
    this.calls.push(`head:${key}`);
    const object = this.objects.get(key);
    return object ? { ...object.metadata } : null;
  }

  async listAll(prefix: string): Promise<readonly RelayObjectMetadata[] | null> {
    this.calls.push(`list:${prefix}`);
    return [
      ...[...this.objects.values()]
        .map((object) => object.metadata)
        .filter((candidate) => candidate.key.startsWith(prefix)),
      ...this.extraListedObjects,
    ].sort((left, right) => comparePath(left.key, right.key));
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
    return true;
  }
}

type FakeSourceRuntimeState = {
  stageIntents: Map<string, StageIntentV2>;
  finalizeJournals: Map<string, FinalizeJournalV1>;
  sourceStageLease: string | null;
  sourceStageLeaseConfigDigest: string | null;
  acquireCalls: number;
  releaseCalls: number;
  releaseResult: boolean;
};

function createFakeSourceRuntimeState(): FakeSourceRuntimeState {
  return {
    stageIntents: new Map(),
    finalizeJournals: new Map(),
    sourceStageLease: null,
    sourceStageLeaseConfigDigest: null,
    acquireCalls: 0,
    releaseCalls: 0,
    releaseResult: true,
  };
}

class FakeSourceRuntime implements RelaySourceRuntimePort {
  readonly calls: string[] = [];
  readonly stageIntents: Map<string, StageIntentV2>;
  readonly finalizeJournals: Map<string, FinalizeJournalV1>;
  readonly members = sourceMembers();
  private heldSourceStageLeaseId: string | null = null;
  protectedConfig = JSON.stringify(runtimeConfig);
  discoveryOverride: ResumableStageDiscovery | null = null;
  afterSourceStageLeaseAcquire: (() => void) | null = null;
  inspectResult: {
    canonicalPath: string;
    stableIdentity: string;
    totalBytes: number;
    members: readonly { path: string; bytes: number; stableIdentity: string }[];
  } | null = {
    canonicalPath: SAFE_PATH_MARKER,
    stableIdentity: 'safe-snapshot-identity',
    totalBytes: this.members.reduce((total, candidate) => total + candidate.bytes, 0),
    members: this.members.map((candidate, index) => ({
      path: candidate.path,
      bytes: candidate.bytes,
      stableIdentity: `safe-member-${String(index)}`,
    })),
  };
  readResult: readonly CenturionRelayMember[] | null = this.members;
  platformResult = 'linux';
  imdsResult = true;
  writeStageIntentResult = true;
  removeResult = true;
  stageReadOverride: RelayJournalRead<StageIntentV2> | null = null;
  finalizeReadOverride: RelayJournalRead<FinalizeJournalV1> | null = null;
  git = {
    revision: `${runtimeConfig.expectedEc2.revision}\n`,
    worktree: `${runtimeConfig.expectedEc2.worktree}\n`,
    status: '',
  };

  constructor(private readonly state: FakeSourceRuntimeState = createFakeSourceRuntimeState()) {
    this.stageIntents = state.stageIntents;
    this.finalizeJournals = state.finalizeJournals;
  }

  platform(): string {
    this.calls.push('platform');
    return this.platformResult;
  }

  async attestImdsV2(instanceId: string): Promise<boolean> {
    this.calls.push('imds');
    expect(instanceId).toBe(runtimeConfig.expectedEc2.instanceId);
    return this.imdsResult;
  }

  async readProtectedConfig(): Promise<string> {
    this.calls.push('config');
    return this.protectedConfig;
  }

  async assertSourceStageConfig(input: {
    config: RelaySourceRuntimeConfig;
    configDigest: string;
  }): Promise<boolean> {
    this.calls.push('assert-source-stage-config');
    const current = parseRelaySourceRuntimeConfigSnapshot(this.protectedConfig);
    return (
      current !== null &&
      current.digest === input.configDigest &&
      JSON.stringify(current.config) === JSON.stringify(input.config)
    );
  }

  inspectGit(check: 'revision' | 'worktree' | 'status'): string | null {
    this.calls.push(`git:${check}`);
    return this.git[check];
  }

  async inspectTrustedSnapshot(input: { name: string; maxTotalBytes: number }): Promise<{
    canonicalPath: string;
    stableIdentity: string;
    totalBytes: number;
    members: readonly { path: string; bytes: number; stableIdentity: string }[];
  } | null> {
    this.calls.push('inspect');
    expect(input).toEqual({
      name: runtimeConfig.sourceSnapshot.directChildName,
      maxTotalBytes: relayConfig.maxSnapshotBytes,
    });
    return this.inspectResult;
  }

  async readBoundedTrustedSnapshot(input: {
    canonicalPath: string;
    stableIdentity: string;
    members: readonly { path: string; bytes: number; stableIdentity: string }[];
    maxTotalBytes: number;
  }): Promise<readonly CenturionRelayMember[] | null> {
    this.calls.push('read');
    expect(input.maxTotalBytes).toBe(relayConfig.maxSnapshotBytes);
    return this.readResult;
  }

  async writeStageIntent(intent: StageIntentV2): Promise<boolean> {
    this.calls.push(`write-stage:${intent.state}:${intent.createdKeys.length}`);
    if (!this.writeStageIntentResult) return false;
    this.stageIntents.set(intent.transferId, structuredClone(intent));
    return true;
  }

  async readStageIntent(transferId: string): Promise<RelayJournalRead<StageIntentV2>> {
    this.calls.push('read-stage');
    if (this.stageReadOverride) return this.stageReadOverride;
    const intent = this.stageIntents.get(transferId);
    return intent ? { outcome: 'present', value: structuredClone(intent) } : { outcome: 'absent' };
  }

  async writeFinalizeJournal(journal: FinalizeJournalV1): Promise<boolean> {
    this.calls.push(`write-finalize:${journal.state}`);
    this.finalizeJournals.set(journal.stageIntent.transferId, structuredClone(journal));
    return true;
  }

  async readFinalizeJournal(transferId: string): Promise<RelayJournalRead<FinalizeJournalV1>> {
    this.calls.push('read-finalize');
    if (this.finalizeReadOverride) return this.finalizeReadOverride;
    const journal = this.finalizeJournals.get(transferId);
    return journal
      ? { outcome: 'present', value: structuredClone(journal) }
      : { outcome: 'absent' };
  }

  async findSingleResumableStage(input: {
    config: RelaySourceRuntimeConfig;
    configDigest: string;
  }): Promise<ResumableStageDiscovery> {
    this.calls.push('find-resumable-stage');
    if (
      this.heldSourceStageLeaseId === null ||
      this.state.sourceStageLease !== this.heldSourceStageLeaseId ||
      this.state.sourceStageLeaseConfigDigest !== input.configDigest
    ) {
      return { outcome: 'blocked' };
    }
    if (this.discoveryOverride) return this.discoveryOverride;
    const finalized = new Set<string>();
    for (const [transferId, journal] of this.finalizeJournals) {
      if (
        journal.schemaVersion !== 'centurion-thread-corpus-relay-finalize-journal-v1' ||
        journal.stageIntent.transferId !== transferId ||
        journal.stageIntent.state !== 'staged' ||
        JSON.stringify(journal.stageIntent) !== JSON.stringify(this.stageIntents.get(transferId))
      ) {
        return { outcome: 'blocked' };
      }
      if (journal.state !== 'complete') return { outcome: 'blocked' };
      finalized.add(transferId);
    }
    const candidates: string[] = [];
    for (const [transferId, intent] of this.stageIntents) {
      if (
        intent.schemaVersion !== 'centurion-thread-corpus-relay-stage-intent-v2' ||
        intent.transferId !== transferId ||
        (intent.state !== 'staging' && intent.state !== 'staged')
      ) {
        return { outcome: 'blocked' };
      }
      if (!finalized.has(transferId)) candidates.push(transferId);
    }
    return candidates.length === 0
      ? { outcome: 'none' }
      : candidates.length === 1
        ? { outcome: 'one', transferId: candidates[0]! }
        : { outcome: 'blocked' };
  }

  async acquireSourceStageLease(input: {
    configDigest: string;
  }): Promise<{ leaseId: string } | null> {
    this.calls.push('acquire-source-stage-lease');
    this.state.acquireCalls += 1;
    if (
      this.state.sourceStageLease !== null ||
      parseRelaySourceRuntimeConfigSnapshot(this.protectedConfig)?.digest !== input.configDigest
    ) {
      return null;
    }
    const leaseId = 'safe-source-stage-lease';
    this.state.sourceStageLease = leaseId;
    this.state.sourceStageLeaseConfigDigest = input.configDigest;
    this.heldSourceStageLeaseId = leaseId;
    this.afterSourceStageLeaseAcquire?.();
    return { leaseId };
  }

  async releaseSourceStageLease(input: { leaseId: string }): Promise<boolean> {
    this.calls.push('release-source-stage-lease');
    this.state.releaseCalls += 1;
    if (
      !this.state.releaseResult ||
      this.heldSourceStageLeaseId !== input.leaseId ||
      this.state.sourceStageLease === null ||
      input.leaseId !== this.state.sourceStageLease
    ) {
      return false;
    }
    this.state.sourceStageLease = null;
    this.state.sourceStageLeaseConfigDigest = null;
    this.heldSourceStageLeaseId = null;
    return true;
  }

  async removeTrustedSnapshot(): Promise<boolean> {
    this.calls.push('remove');
    return this.removeResult;
  }
}

function stage(
  store = new FakeRelayStore(),
  source = new FakeSourceRuntime(),
  transferId = TRANSFER_ID,
  attestation: unknown = readinessAttestation,
) {
  return stageCenturionThreadCorpusRelay({
    config: runtimeConfig,
    configDigest: parseRelaySourceRuntimeConfigSnapshot(JSON.stringify(runtimeConfig))!.digest,
    transferId,
    store,
    source,
    readinessAttestation: attestation as CenturionThreadCorpusReadinessAttestationV1,
  });
}

function stageCommand(input: {
  args: readonly string[];
  source: FakeSourceRuntime;
  store: FakeRelayStore;
  createTransferId?: () => string;
  objectStoreFor?: () => FakeRelayStore;
}) {
  const stdout: string[] = [];
  return {
    stdout,
    command: createStageCenturionThreadCorpusRelayCommand({
      args: () => input.args,
      createTransferId: input.createTransferId ?? (() => TRANSFER_ID),
      runtime: input.source,
      objectStoreFor: input.objectStoreFor ?? (() => input.store),
      assessReadiness: async () => ({
        report: allGreenReadinessReport,
        attestation: readinessAttestation,
      }),
      writeStdout: (value) => stdout.push(value),
    }),
  };
}

function expectedStageKeys(): string[] {
  const members = sourceMembers();
  return [
    ...members.map((candidate) =>
      relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, candidate.path),
    ),
    relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID),
  ];
}

function assertNoSafeFixtureLeak(value: unknown): void {
  const output = JSON.stringify(value);
  expect(output).not.toContain(SAFE_BODY_MARKER);
  expect(output).not.toContain(SAFE_ADDRESS_MARKER);
  expect(output).not.toContain(SAFE_PATH_MARKER);
  expect(output).not.toContain(SAFE_JOURNAL_MARKER);
}

function parseTypeScript(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function collectNodes<T extends ts.Node>(
  source: ts.SourceFile,
  predicate: (node: ts.Node) => node is T,
): T[];
function collectNodes(source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node[];
function collectNodes(source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

function identifierName(node: ts.Expression): string | null {
  return ts.isIdentifier(node) ? node.text : null;
}

function containingClassName(node: ts.Node): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isClassDeclaration(current)) return current.name?.text ?? null;
  }
  return null;
}

function importedModuleNames(source: ts.SourceFile): string[] {
  return collectNodes(source, ts.isImportDeclaration).flatMap((node) =>
    ts.isStringLiteral(node.moduleSpecifier) ? [node.moduleSpecifier.text] : [],
  );
}

type RelaySourceName = 'producer' | 'finalizer' | 'stage-script' | 'finalize-script';

type RelaySource = {
  name: RelaySourceName;
  file: ts.SourceFile;
};

const S3_MODULE = '@aws-sdk/client-s3';
const REQUIRED_S3_IMPORTS = new Set([
  'DeleteObjectsCommand',
  'GetBucketEncryptionCommand',
  'GetBucketLifecycleConfigurationCommand',
  'GetBucketOwnershipControlsCommand',
  'GetBucketVersioningCommand',
  'GetObjectCommand',
  'GetPublicAccessBlockCommand',
  'HeadBucketCommand',
  'HeadObjectCommand',
  'ListObjectsV2Command',
  'PutObjectCommand',
  'S3Client',
]);
const REQUIRED_S3_COMMANDS = new Set(
  [...REQUIRED_S3_IMPORTS].filter((name) => name.endsWith('Command')),
);
const S3_MUTATION_COMMAND = /^(Abort|Complete|Copy|Create|Delete|Put|Restore|Upload)/;

function dynamicAwsModuleNames(source: ts.SourceFile): string[] {
  return collectNodes(
    source,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword,
  ).flatMap((node) => {
    const argument = node.arguments[0];
    return argument && ts.isStringLiteral(argument) ? [argument.text] : [];
  });
}

function staticS3ImportNames(source: ts.SourceFile): string[] | null {
  const imports = collectNodes(
    source,
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === S3_MODULE,
  ) as ts.ImportDeclaration[];
  if (imports.length !== 1) return null;
  const clause = imports[0]?.importClause;
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return null;
  }
  return clause.namedBindings.elements.map((element) => element.name.text);
}

function sameSet(actual: readonly string[], expected: ReadonlySet<string>): boolean {
  return actual.length === expected.size && actual.every((value) => expected.has(value));
}

function commandConstructors(source: ts.SourceFile): ts.NewExpression[] {
  return collectNodes(
    source,
    (node): node is ts.NewExpression =>
      ts.isNewExpression(node) &&
      identifierName(node.expression) !== null &&
      REQUIRED_S3_COMMANDS.has(identifierName(node.expression)!),
  ) as ts.NewExpression[];
}

function mutationCalls(source: ts.SourceFile): Array<ts.CallExpression | ts.NewExpression> {
  return collectNodes(
    source,
    (node): node is ts.CallExpression | ts.NewExpression =>
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      identifierName(node.expression) !== null &&
      S3_MUTATION_COMMAND.test(identifierName(node.expression)!),
  ) as Array<ts.CallExpression | ts.NewExpression>;
}

function assertTask2RelaySourceBoundaries(sources: readonly RelaySource[]): void {
  const expectedNames = new Set<RelaySourceName>([
    'producer',
    'finalizer',
    'stage-script',
    'finalize-script',
  ]);
  if (
    sources.length !== expectedNames.size ||
    sources.some((source) => !expectedNames.has(source.name))
  ) {
    throw new Error('Task 2 relay source set changed');
  }

  const producer = sources.find((source) => source.name === 'producer');
  if (!producer) throw new Error('Missing relay producer source');
  for (const source of sources) {
    const staticAwsImports = importedModuleNames(source.file).filter((moduleName) =>
      moduleName.startsWith('@aws-sdk/'),
    );
    const dynamicAwsImports = dynamicAwsModuleNames(source.file).filter((moduleName) =>
      moduleName.startsWith('@aws-sdk/'),
    );
    if (source.name === 'producer') {
      if (!sameSet(staticAwsImports, new Set([S3_MODULE]))) {
        throw new Error('Unexpected AWS SDK import in relay producer');
      }
      if (dynamicAwsImports.length !== 0) {
        throw new Error('Dynamic AWS SDK import in relay producer');
      }
      continue;
    }
    if (staticAwsImports.length !== 0 || dynamicAwsImports.length !== 0) {
      throw new Error(`AWS SDK import outside relay adapter: ${source.name}`);
    }
  }

  const importedNames = staticS3ImportNames(producer.file);
  if (!importedNames || !sameSet(importedNames, REQUIRED_S3_IMPORTS)) {
    throw new Error('Unexpected S3 SDK import surface');
  }
  const constructors = commandConstructors(producer.file);
  if (constructors.some((node) => containingClassName(node) !== 'AwsRelayObjectStore')) {
    throw new Error('S3 command outside AwsRelayObjectStore');
  }
  if (
    !sameSet(
      constructors
        .map((node) => identifierName(node.expression))
        .filter((name): name is string => name !== null),
      REQUIRED_S3_COMMANDS,
    )
  ) {
    throw new Error('Unexpected S3 command construction');
  }
  if (
    mutationCalls(producer.file).some((node) => containingClassName(node) !== 'AwsRelayObjectStore')
  ) {
    throw new Error('S3 mutation outside AwsRelayObjectStore');
  }
}

describe('Centurion relay producer', () => {
  it('writes a durable staging intent, conditionally uploads sorted members, and writes commit marker last', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();

    const result = await stage(store, source);
    const expectedKeys = expectedStageKeys();

    expect(result).toMatchObject({
      outcome: 'staged',
      transferId: TRANSFER_ID,
    });
    expect(store.calls.filter((call) => call.startsWith('put:'))).toEqual(
      expectedKeys.map((key) => `put:${key}`),
    );
    expect(source.calls.filter((call) => call.startsWith('write-stage:'))).toEqual([
      'write-stage:staging:0',
      ...expectedKeys.map((_, index) => `write-stage:staging:${String(index + 1)}`),
      `write-stage:staged:${String(expectedKeys.length)}`,
    ]);
    expect(store.calls.at(-1)).toBe(`list:${stagePrefix()}`);
    expect(source.stageIntents.get(TRANSFER_ID)).toMatchObject({
      state: 'staged',
      createdKeys: expectedKeys,
      sourceSnapshot: {
        directChildName: runtimeConfig.sourceSnapshot.directChildName,
        stableIdentity: 'safe-snapshot-identity',
      },
      members: sourceMembers().map(({ path, bytes, sha256: digest }) => ({
        path,
        bytes,
        sha256: digest,
      })),
    });
    assertNoSafeFixtureLeak(result);
  });

  it.each([
    { name: 'missing', attestation: null },
    {
      name: 'malformed',
      attestation: {
        schemaVersion: 'centurion-thread-corpus-readiness-attestation-v1',
        bindingSha256: 'not-a-digest',
      },
    },
    {
      name: 'binding-mismatched',
      attestation: buildCenturionThreadCorpusReadinessAttestation(allGreenReadinessReport, {
        ...readinessBinding,
        expectedRevision: 'different-synthetic-revision',
      }),
    },
  ])('blocks $name readiness attestation before any runtime work', async ({ attestation }) => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();

    expect(await stage(store, source, TRANSFER_ID, attestation)).toEqual({ outcome: 'blocked' });
    expect(source.calls).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(source.stageIntents.size).toBe(0);
  });

  it('persists only a V2 intent with the PII-free readiness attestation', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();

    expect(await stage(store, source)).toMatchObject({ outcome: 'staged' });
    const intent = source.stageIntents.get(TRANSFER_ID)!;

    expect(intent.schemaVersion).toBe('centurion-thread-corpus-relay-stage-intent-v2');
    expect(intent.readinessAttestation).toEqual(readinessAttestation);
    const serialized = JSON.stringify(intent);
    expect(serialized).not.toContain(SAFE_BODY_MARKER);
    expect(serialized).not.toContain(SAFE_ADDRESS_MARKER);
    expect(serialized).not.toContain(SAFE_PATH_MARKER);
    expect(serialized).not.toContain('synthetic-centurion-transport');
  });

  it.each([
    'policy gate false',
    'invalid source',
    'source leaf symlink',
    'source leaf swap',
    'source leaf permissive mode',
  ])('blocks %s before reading source bytes', async (kind) => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    if (kind === 'policy gate false') {
      store.assertResult = false;
    } else {
      source.inspectResult = null;
    }

    const result = await stage(store, source);

    expect(result).toEqual({ outcome: 'blocked' });
    expect(source.calls).not.toContain('read');
    assertNoSafeFixtureLeak(result);
  });

  it('blocks oversized source before body-read', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    source.inspectResult = {
      ...source.inspectResult!,
      totalBytes: relayConfig.maxSnapshotBytes + 1,
    };

    expect(await stage(store, source)).toEqual({ outcome: 'blocked' });
    expect(source.calls).toContain('inspect');
    expect(source.calls).not.toContain('read');
  });

  it('blocks an unreadable stage journal before it can overwrite durable state', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    source.stageReadOverride = { outcome: 'blocked' };

    expect(await stage(store, source)).toEqual({ outcome: 'blocked' });
    expect(store.calls.filter((call) => call.startsWith('put:'))).toEqual([]);
    expect(source.calls.filter((call) => call.startsWith('write-stage:'))).toEqual([]);
  });

  it('blocks metadata-mismatched conditional collision without deleting unowned objects', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    const firstKey = expectedStageKeys()[0]!;
    const firstMember = sourceMembers()[0]!;
    store.objects.set(firstKey, {
      content: firstMember.content,
      metadata: {
        ...metadata(firstKey, firstMember.content),
        sseKmsKeyId: 'arn:aws:kms:synthetic-region-1:123456789012:key/wrong-key',
      },
    });

    expect(await stage(store, source)).toEqual({ outcome: 'blocked' });
    expect(store.deleteCalls).toEqual([[]]);
    expect(store.objects.has(firstKey)).toBe(true);
  });

  it('resumes a lost conditional PUT response only after exact head metadata match', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    const firstKey = expectedStageKeys()[0]!;
    store.putOverride.set(firstKey, 'conflict');
    store.materializeConflict.add(firstKey);

    const result = await stage(store, source);

    expect(result).toMatchObject({ outcome: 'staged' });
    expect(store.calls).toContain(`head:${firstKey}`);
  });

  it('rolls back only journaled keys after failed member upload and preserves staging intent for retry', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    const [firstKey, secondKey] = expectedStageKeys();
    store.putOverride.set(secondKey!, 'conflict');

    expect(await stage(store, source)).toEqual({ outcome: 'blocked' });
    expect(store.deleteCalls).toEqual([[firstKey!]]);
    expect(source.stageIntents.get(TRANSFER_ID)).toMatchObject({
      state: 'staging',
      createdKeys: [firstKey],
    });
  });

  it('preserves staging state when extra remote key prevents empty-prefix rollback proof', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    store.extraListedObjects = [
      {
        key: `${stagePrefix()}unknown-safe-object`,
        bytes: 1,
        sha256: '0'.repeat(64),
        serverSideEncryption: 'aws:kms',
        sseKmsKeyId: relayConfig.kmsKeyArn,
      },
    ];

    expect(await stage(store, source)).toEqual({ outcome: 'blocked' });
    expect(store.deleteCalls.flat()).not.toContain(`${stagePrefix()}unknown-safe-object`);
    expect(source.stageIntents.get(TRANSFER_ID)?.state).toBe('staging');
  });

  it('returns blocked when rollback delete itself fails', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    const [, secondKey] = expectedStageKeys();
    store.putOverride.set(secondKey!, 'conflict');
    store.deleteResult = false;

    expect(await stage(store, source)).toEqual({ outcome: 'blocked' });
    expect(store.deleteCalls).toHaveLength(1);
    expect(source.stageIntents.get(TRANSFER_ID)?.state).toBe('staging');
  });

  it('parses only strict source runtime configuration', () => {
    expect(parseRelaySourceRuntimeConfig(JSON.stringify(runtimeConfig))).toEqual(runtimeConfig);
    expect(
      parseRelaySourceRuntimeConfig(
        JSON.stringify({
          ...runtimeConfig,
          unexpected: 'SAFE_UNEXPECTED_FIELD',
        }),
      ),
    ).toBeNull();
    expect(
      parseRelaySourceRuntimeConfig(
        JSON.stringify(runtimeConfig).replace(
          '"version":"centurion-thread-corpus-relay-source-config-v1"',
          '"version":"centurion-thread-corpus-relay-source-config-v1","version":"centurion-thread-corpus-relay-source-config-v1"',
        ),
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: 'legacy V1 intent',
      tamper: (intent: StageIntentV2) => ({
        ...intent,
        schemaVersion: 'centurion-thread-corpus-relay-stage-intent-v1',
      }),
    },
    {
      name: 'tampered persisted attestation',
      tamper: (intent: StageIntentV2) => ({
        ...intent,
        readinessAttestation: {
          ...intent.readinessAttestation,
          bindingSha256: '0'.repeat(64),
        },
      }),
    },
  ])(
    'blocks $name before retry can read source bytes or write relay objects',
    async ({ tamper }) => {
      const store = new FakeRelayStore();
      const source = new FakeSourceRuntime();
      expect(await stage(store, source)).toMatchObject({ outcome: 'staged' });
      source.stageIntents.set(
        TRANSFER_ID,
        tamper(source.stageIntents.get(TRANSFER_ID)!) as StageIntentV2,
      );
      source.calls.length = 0;
      store.calls.length = 0;

      expect(await stage(store, source)).toEqual({ outcome: 'blocked' });
      expect(source.calls).toContain('read-stage');
      expect(source.calls).not.toContain('read');
      expect(store.calls.filter((call) => call.startsWith('put:'))).toEqual([]);
    },
  );

  it('treats only verified ENOENT as an absent durable stage journal', () => {
    expect(classifyRelayJournalReadFailure({ code: 'ENOENT' })).toBe('absent');
    expect(classifyRelayJournalReadFailure({ code: 'EACCES' })).toBe('blocked');
    expect(classifyRelayJournalReadFailure(new Error('safe synthetic parse failure'))).toBe(
      'blocked',
    );
  });
});

describe('Centurion relay S3 object-store adapter', () => {
  it('uses expected owner, exact bucket controls, conditional SSE-KMS PUT, and decoded checksum metadata', async () => {
    const calls: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        calls.push(command);
        if (command instanceof HeadBucketCommand) return {};
        if (command instanceof GetBucketOwnershipControlsCommand) {
          return { OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } };
        }
        if (command instanceof GetPublicAccessBlockCommand) {
          return {
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          };
        }
        if (command instanceof GetBucketVersioningCommand) return {};
        if (command instanceof GetBucketEncryptionCommand) {
          return {
            ServerSideEncryptionConfiguration: {
              Rules: [
                {
                  ApplyServerSideEncryptionByDefault: {
                    SSEAlgorithm: 'aws:kms',
                    KMSMasterKeyID: relayConfig.kmsKeyArn,
                  },
                },
              ],
            },
          };
        }
        if (command instanceof GetBucketLifecycleConfigurationCommand) {
          return {
            Rules: [
              {
                ID: relayConfig.lifecycleRuleId,
                Status: 'Enabled',
                Filter: { Prefix: `${relayConfig.literalRelayRoot}/` },
                Expiration: { Days: 1 },
              },
            ],
          };
        }
        if (command instanceof PutObjectCommand) return {};
        if (command instanceof HeadObjectCommand) {
          return {
            ContentLength: 4,
            ChecksumSHA256: Buffer.from('1'.repeat(64), 'hex').toString('base64'),
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: relayConfig.kmsKeyArn,
          };
        }
        throw new Error('unexpected synthetic command');
      }),
    };
    const store = createAwsRelayObjectStore(relayConfig, client);
    const content = textEncoder.encode('safe');

    expect(await store.assertRelayBucket(relayConfig)).toBe(true);
    expect(
      await store.putIfAbsent({
        key: 'private-relay/safe',
        content,
        bytes: content.byteLength,
        sha256: sha256(content),
        expectedBucketOwner: relayConfig.expectedBucketOwner,
        kmsKeyArn: relayConfig.kmsKeyArn,
      }),
    ).toBe('created');
    expect(await store.head('private-relay/safe')).toEqual({
      key: 'private-relay/safe',
      bytes: 4,
      sha256: '1'.repeat(64),
      serverSideEncryption: 'aws:kms',
      sseKmsKeyId: relayConfig.kmsKeyArn,
    });

    for (const command of calls as Array<{ input: { ExpectedBucketOwner?: string } }>) {
      expect(command.input.ExpectedBucketOwner).toBe(relayConfig.expectedBucketOwner);
    }
    const put = calls.find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input).toMatchObject({
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: Buffer.from(sha256(content), 'hex').toString('base64'),
      IfNoneMatch: '*',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: relayConfig.kmsKeyArn,
    });
  });

  it('rejects mismatched content and checksum before it can write a relay object', async () => {
    const client = {
      send: vi.fn(async () => ({})),
    };
    const store = createAwsRelayObjectStore(relayConfig, client);
    const content = textEncoder.encode('safe');

    expect(
      await store.putIfAbsent({
        key: 'private-relay/safe',
        content,
        bytes: content.byteLength,
        sha256: '0'.repeat(64),
        expectedBucketOwner: relayConfig.expectedBucketOwner,
        kmsKeyArn: relayConfig.kmsKeyArn,
      }),
    ).toBe('conflict');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('treats an omitted ListObjectsV2 Contents field as an empty relay prefix', async () => {
    const client = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof ListObjectsV2Command) return { IsTruncated: false };
        throw new Error('unexpected synthetic command');
      }),
    };
    const store = createAwsRelayObjectStore(relayConfig, client);

    expect(await store.listAll('private-relay/empty/')).toEqual([]);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('fully paginates over more than one thousand keys before returning metadata', async () => {
    const allKeys = Array.from({ length: 1_001 }, (_, index) => `private-relay/${String(index)}`);
    const client = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof ListObjectsV2Command) {
          const continuation = command.input.ContinuationToken;
          return continuation
            ? {
                IsTruncated: false,
                Contents: allKeys.slice(1_000).map((Key) => ({ Key, Size: 1 })),
              }
            : {
                IsTruncated: true,
                NextContinuationToken: 'safe-next-token',
                Contents: allKeys.slice(0, 1_000).map((Key) => ({ Key, Size: 1 })),
              };
        }
        if (command instanceof HeadObjectCommand) {
          return {
            ContentLength: 1,
            ChecksumSHA256: Buffer.from('2'.repeat(64), 'hex').toString('base64'),
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: relayConfig.kmsKeyArn,
          };
        }
        throw new Error('unexpected synthetic command');
      }),
    };
    const store = createAwsRelayObjectStore(relayConfig, client);

    const listed = await store.listAll('private-relay/');

    expect(listed).toHaveLength(1_001);
    expect(
      client.send.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command),
    ).toHaveLength(2);
    expect(listed?.every((candidate) => candidate.sha256 === '2'.repeat(64))).toBe(true);
  });
});

describe('stage Centurion relay command', () => {
  it('accepts no selectors and emits only fixed PII-free offer JSON', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    const stdout: string[] = [];
    const command = createStageCenturionThreadCorpusRelayCommand({
      args: () => [],
      createTransferId: () => TRANSFER_ID,
      runtime: source,
      objectStoreFor: () => store,
      assessReadiness: async () => ({
        report: allGreenReadinessReport,
        attestation: readinessAttestation,
      }),
      writeStdout: (value) => stdout.push(value),
    });

    expect(await command()).toBe(0);
    expect(stdout).toEqual([
      `${JSON.stringify({
        schemaVersion: 'centurion-thread-corpus-relay-stage-offer-v1',
        outcome: 'staged',
        transferId: TRANSFER_ID,
        sourceManifestSha256: source.stageIntents.get(TRANSFER_ID)!.sourceManifestSha256,
        memberSetSha256: source.stageIntents.get(TRANSFER_ID)!.memberSetSha256,
      })}\n`,
    ]);
    assertNoSafeFixtureLeak(stdout);
  });

  it.each([
    {
      name: 'missing',
      assessment: {
        report: allGreenReadinessReport,
        attestation: null,
      },
    },
    {
      name: 'blocked',
      assessment: {
        report: {
          ...allGreenReadinessReport,
          outcome: 'blocked',
          code: 'CENTURION_THREAD_CORPUS_BLOCKED',
          ready: false,
        },
        attestation: null,
      },
    },
    {
      name: 'malformed',
      assessment: {
        report: allGreenReadinessReport,
        attestation: {
          schemaVersion: 'centurion-thread-corpus-readiness-attestation-v1',
          bindingSha256: 'invalid',
        },
      },
    },
    {
      name: 'binding-mismatched',
      assessment: {
        report: allGreenReadinessReport,
        attestation: buildCenturionThreadCorpusReadinessAttestation(allGreenReadinessReport, {
          ...readinessBinding,
          expectedWorktree: '/synthetic/other-worktree',
        }),
      },
    },
  ])(
    'blocks $name readiness assessment before object-store or source runtime work',
    async ({ assessment }) => {
      const store = new FakeRelayStore();
      const source = new FakeSourceRuntime();
      const objectStoreFor = vi.fn(() => store);
      const stdout: string[] = [];
      const command = createStageCenturionThreadCorpusRelayCommand({
        args: () => [],
        createTransferId: () => TRANSFER_ID,
        runtime: source,
        objectStoreFor,
        assessReadiness: async () => assessment as CenturionThreadCorpusReadinessAssessment,
        writeStdout: (value) => stdout.push(value),
      });

      expect(await command()).toBe(3);
      expect(objectStoreFor).not.toHaveBeenCalled();
      expect(source.calls).toEqual(['config']);
      expect(stdout).toEqual([
        '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
      ]);
      assertNoSafeFixtureLeak(stdout);
    },
  );

  it('blocks arguments before reading protected configuration', async () => {
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime();
    const stdout: string[] = [];
    const command = createStageCenturionThreadCorpusRelayCommand({
      args: () => ['--source', SAFE_PATH_MARKER],
      createTransferId: () => TRANSFER_ID,
      runtime: source,
      objectStoreFor: () => store,
      writeStdout: (value) => stdout.push(value),
    });

    expect(await command()).toBe(2);
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
    ]);
    expect(source.calls).toEqual([]);
    assertNoSafeFixtureLeak(stdout);
  });

  it.each([
    ['missing transfer ID', ['--transfer-id']],
    ['invalid transfer ID', ['--transfer-id', 'safe-not-a-uuid']],
    ['duplicate transfer ID flag', ['--transfer-id', TRANSFER_ID, '--transfer-id', TRANSFER_ID]],
    ['unknown flag', ['--unexpected']],
    ['extra argument', ['--transfer-id', TRANSFER_ID, 'safe-extra']],
  ] as const)('blocks %s before protected configuration', async (_name, args) => {
    const source = new FakeSourceRuntime();
    const createTransferId = vi.fn(() => TRANSFER_ID);
    const { command, stdout } = stageCommand({
      args,
      source,
      store: new FakeRelayStore(),
      createTransferId,
    });

    expect(await command()).toBe(2);
    expect(source.calls).toEqual([]);
    expect(createTransferId).not.toHaveBeenCalled();
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
    ]);
  });

  it('suppresses raw discovery state from blocked stage output', async () => {
    const state = createFakeSourceRuntimeState();
    const source = new FakeSourceRuntime(state);
    source.discoveryOverride = {
      outcome: 'blocked',
      transferId: TRANSFER_ID,
      journal: SAFE_JOURNAL_MARKER,
    } as unknown as ResumableStageDiscovery;
    const { command, stdout } = stageCommand({
      args: [],
      source,
      store: new FakeRelayStore(),
    });

    expect(await command()).toBe(3);
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
    ]);
    expect(stdout.join('')).not.toContain(TRANSFER_ID);
    assertNoSafeFixtureLeak(stdout);
  });

  it('reuses exactly one durable staging intent from a fresh fake runtime without creating a UUID', async () => {
    const state = createFakeSourceRuntimeState();
    const store = new FakeRelayStore();
    const crashedRuntime = new FakeSourceRuntime(state);
    expect(await stage(store, crashedRuntime)).toMatchObject({ outcome: 'staged' });
    const persisted = state.stageIntents.get(TRANSFER_ID)!;
    state.stageIntents.set(TRANSFER_ID, {
      ...persisted,
      state: 'staging',
    });

    const recoveredRuntime = new FakeSourceRuntime(state);
    const createTransferId = vi.fn(() => {
      throw new Error('fresh transfer ID must not be created for a durable stage');
    });
    const { command, stdout } = stageCommand({
      args: [],
      source: recoveredRuntime,
      store,
      createTransferId,
    });

    expect(await command()).toBe(0);
    expect(createTransferId).not.toHaveBeenCalled();
    expect(recoveredRuntime.calls.indexOf('acquire-source-stage-lease')).toBeGreaterThan(-1);
    expect(recoveredRuntime.calls.indexOf('find-resumable-stage')).toBeGreaterThan(
      recoveredRuntime.calls.indexOf('acquire-source-stage-lease'),
    );
    expect(recoveredRuntime.calls).toContain('release-source-stage-lease');
    expect(stdout.join('')).toContain(`"transferId":"${TRANSFER_ID}"`);
  });

  it.each(['ambiguous', 'corrupt', 'finalizing'] as const)(
    'blocks %s discovery without generating a transfer ID or constructing an object store',
    async (kind) => {
      const state = createFakeSourceRuntimeState();
      const source = new FakeSourceRuntime(state);
      const store = new FakeRelayStore();
      if (kind === 'ambiguous') {
        expect(await stage(store, source)).toMatchObject({ outcome: 'staged' });
        const valid = source.stageIntents.get(TRANSFER_ID)!;
        state.stageIntents.set(
          'd36ad443-1c49-4d7e-8645-111111111111',
          structuredClone({
            ...valid,
            transferId: 'd36ad443-1c49-4d7e-8645-111111111111',
          }),
        );
      } else if (kind === 'corrupt') {
        state.stageIntents.set(TRANSFER_ID, {
          schemaVersion: 'centurion-thread-corpus-relay-stage-intent-v1',
          transferId: TRANSFER_ID,
        } as unknown as StageIntentV2);
      } else {
        expect(await stage(store, source)).toMatchObject({ outcome: 'staged' });
        const intent = source.stageIntents.get(TRANSFER_ID)!;
        state.finalizeJournals.set(TRANSFER_ID, {
          schemaVersion: 'centurion-thread-corpus-relay-finalize-journal-v1',
          stageIntent: intent,
          receiveReceiptSha256: '1'.repeat(64),
          acknowledgementSha256: '2'.repeat(64),
          state: 'ack_verified',
        });
      }
      const recoveredRuntime = new FakeSourceRuntime(state);
      const createTransferId = vi.fn(() => 'd36ad443-1c49-4d7e-8645-111111111111');
      const objectStoreFor = vi.fn(() => store);
      const stdout: string[] = [];
      const command = createStageCenturionThreadCorpusRelayCommand({
        args: () => [],
        createTransferId,
        runtime: recoveredRuntime,
        assessReadiness: async () => ({
          report: allGreenReadinessReport,
          attestation: readinessAttestation,
        }),
        objectStoreFor,
        writeStdout: (value) => stdout.push(value),
      });

      expect(await command()).toBe(3);
      expect(createTransferId).not.toHaveBeenCalled();
      expect(objectStoreFor).not.toHaveBeenCalled();
      expect(recoveredRuntime.calls).toContain('acquire-source-stage-lease');
      expect(recoveredRuntime.calls).toContain('find-resumable-stage');
      expect(recoveredRuntime.calls).toContain('release-source-stage-lease');
      expect(stdout).toEqual([
        '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
      ]);
    },
  );

  it('permits a completed finalization to discover none and generate a new transfer ID', async () => {
    const state = createFakeSourceRuntimeState();
    const store = new FakeRelayStore();
    const source = new FakeSourceRuntime(state);
    expect(await stage(store, source)).toMatchObject({ outcome: 'staged' });
    const intent = state.stageIntents.get(TRANSFER_ID)!;
    state.finalizeJournals.set(TRANSFER_ID, {
      schemaVersion: 'centurion-thread-corpus-relay-finalize-journal-v1',
      stageIntent: intent,
      receiveReceiptSha256: '1'.repeat(64),
      acknowledgementSha256: '2'.repeat(64),
      state: 'complete',
    });
    const recoveredRuntime = new FakeSourceRuntime(state);
    const freshTransferId = 'd36ad443-1c49-4d7e-8645-111111111111';
    const createTransferId = vi.fn(() => freshTransferId);
    const { command } = stageCommand({
      args: [],
      source: recoveredRuntime,
      store,
      createTransferId,
    });

    expect(await command()).toBe(0);
    expect(createTransferId).toHaveBeenCalledTimes(1);
    expect(state.stageIntents.get(freshTransferId)?.state).toBe('staged');
  });

  it('blocks a complete finalization whose valid stage intent differs from durable stage', async () => {
    const state = createFakeSourceRuntimeState();
    const source = new FakeSourceRuntime(state);
    const store = new FakeRelayStore();
    expect(await stage(store, source)).toMatchObject({ outcome: 'staged' });
    const intent = state.stageIntents.get(TRANSFER_ID)!;
    state.finalizeJournals.set(TRANSFER_ID, {
      schemaVersion: 'centurion-thread-corpus-relay-finalize-journal-v1',
      stageIntent: {
        ...intent,
        sourceSnapshot: {
          ...intent.sourceSnapshot,
          stableIdentity: 'safe-different-snapshot-identity',
        },
      },
      receiveReceiptSha256: '1'.repeat(64),
      acknowledgementSha256: '2'.repeat(64),
      state: 'complete',
    });
    const createTransferId = vi.fn(() => 'd36ad443-1c49-4d7e-8645-111111111111');
    const { command, stdout } = stageCommand({
      args: [],
      source: new FakeSourceRuntime(state),
      store,
      createTransferId,
    });

    expect(await command()).toBe(3);
    expect(createTransferId).not.toHaveBeenCalled();
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
    ]);
  });

  it('accepts an explicit UUID only when no competing durable stage exists', async () => {
    const state = createFakeSourceRuntimeState();
    const source = new FakeSourceRuntime(state);
    const store = new FakeRelayStore();
    expect(await stage(store, source)).toMatchObject({ outcome: 'staged' });
    const explicitTransferId = 'd36ad443-1c49-4d7e-8645-111111111111';
    const createTransferId = vi.fn(() => {
      throw new Error('explicit transfer ID must not generate another ID');
    });
    const { command, stdout } = stageCommand({
      args: ['--transfer-id', explicitTransferId],
      source: new FakeSourceRuntime(state),
      store,
      createTransferId,
    });

    expect(await command()).toBe(3);
    expect(createTransferId).not.toHaveBeenCalled();
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
    ]);
  });

  it('allows two fresh fake processes to acquire only one global source-stage lease', async () => {
    const state = createFakeSourceRuntimeState();
    const first = new FakeSourceRuntime(state);
    const second = new FakeSourceRuntime(state);
    const firstTransferId = vi.fn(() => TRANSFER_ID);
    const secondTransferId = vi.fn(() => 'd36ad443-1c49-4d7e-8645-111111111111');
    const firstCommand = stageCommand({
      args: [],
      source: first,
      store: new FakeRelayStore(),
      createTransferId: firstTransferId,
    }).command;
    const secondCommand = stageCommand({
      args: [],
      source: second,
      store: new FakeRelayStore(),
      createTransferId: secondTransferId,
    }).command;

    const outcomes = await Promise.all([firstCommand(), secondCommand()]);

    expect(outcomes.filter((outcome) => outcome === 0)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 3)).toHaveLength(1);
    expect(state.acquireCalls).toBe(2);
    expect(state.releaseCalls).toBe(1);
    expect(firstTransferId.mock.calls.length + secondTransferId.mock.calls.length).toBe(1);
    expect(
      [...first.calls, ...second.calls].filter((call) => call === 'find-resumable-stage'),
    ).toHaveLength(1);
  });

  it('blocks an unreleased stale source-stage lease rather than stealing it', async () => {
    const state = createFakeSourceRuntimeState();
    state.sourceStageLease = 'safe-stale-source-stage-lease';
    const source = new FakeSourceRuntime(state);
    const createTransferId = vi.fn(() => TRANSFER_ID);
    const { command, stdout } = stageCommand({
      args: [],
      source,
      store: new FakeRelayStore(),
      createTransferId,
    });

    expect(await command()).toBe(3);
    expect(source.calls).toContain('acquire-source-stage-lease');
    expect(source.calls).not.toContain('find-resumable-stage');
    expect(createTransferId).not.toHaveBeenCalled();
    expect(state.sourceStageLease).toBe('safe-stale-source-stage-lease');
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
    ]);
  });

  it('blocks before discovery when source-stage lease ownership changes', async () => {
    const state = createFakeSourceRuntimeState();
    const source = new FakeSourceRuntime(state);
    source.afterSourceStageLeaseAcquire = () => {
      state.sourceStageLease = 'safe-competing-source-stage-lease';
    };
    const createTransferId = vi.fn(() => TRANSFER_ID);
    const objectStoreFor = vi.fn(() => new FakeRelayStore());
    const { command, stdout } = stageCommand({
      args: [],
      source,
      store: new FakeRelayStore(),
      createTransferId,
      objectStoreFor,
    });

    expect(await command()).toBe(3);
    expect(source.calls).toContain('find-resumable-stage');
    expect(source.calls).not.toContain('platform');
    expect(createTransferId).not.toHaveBeenCalled();
    expect(objectStoreFor).not.toHaveBeenCalled();
    expect(state.sourceStageLease).toBe('safe-competing-source-stage-lease');
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
    ]);
  });

  it('pins protected config through lease and blocks rotation before staging', async () => {
    const source = new FakeSourceRuntime();
    source.afterSourceStageLeaseAcquire = () => {
      source.protectedConfig = JSON.stringify(rotatedRuntimeConfig);
    };
    const createTransferId = vi.fn(() => TRANSFER_ID);
    const objectStoreFor = vi.fn(() => new FakeRelayStore());
    const { command, stdout } = stageCommand({
      args: [],
      source,
      store: new FakeRelayStore(),
      createTransferId,
      objectStoreFor,
    });

    expect(await command()).toBe(3);
    expect(source.calls.filter((call) => call === 'config')).toHaveLength(1);
    expect(source.calls).toContain('find-resumable-stage');
    expect(source.calls).toContain('assert-source-stage-config');
    expect(source.calls).not.toContain('platform');
    expect(createTransferId).toHaveBeenCalledTimes(1);
    expect(objectStoreFor).not.toHaveBeenCalled();
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
    ]);
  });

  it('blocks a staged result when exact source-stage lease release cannot be verified', async () => {
    const state = createFakeSourceRuntimeState();
    state.releaseResult = false;
    const source = new FakeSourceRuntime(state);
    const { command, stdout } = stageCommand({
      args: [],
      source,
      store: new FakeRelayStore(),
    });

    expect(await command()).toBe(3);
    expect(state.releaseCalls).toBe(1);
    expect(state.sourceStageLease).toBe('safe-source-stage-lease');
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-stage-offer-v1","outcome":"blocked"}\n',
    ]);
  });
});

describe('producer source boundaries', () => {
  function relaySources(): RelaySource[] {
    const producerPath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-relay-producer.ts', import.meta.url),
    );
    const finalizerPath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-relay-finalizer.ts', import.meta.url),
    );
    const stageScriptPath = fileURLToPath(
      new URL('../scripts/stage-centurion-thread-corpus-relay.ts', import.meta.url),
    );
    const finalizeScriptPath = fileURLToPath(
      new URL('../scripts/finalize-centurion-thread-corpus-relay.ts', import.meta.url),
    );
    return [
      { name: 'producer', file: parseTypeScript(producerPath) },
      { name: 'finalizer', file: parseTypeScript(finalizerPath) },
      { name: 'stage-script', file: parseTypeScript(stageScriptPath) },
      { name: 'finalize-script', file: parseTypeScript(finalizeScriptPath) },
    ];
  }

  it('keeps S3 command construction in object-store adapter across all Task 2 sources', () => {
    expect(() => assertTask2RelaySourceBoundaries(relaySources())).not.toThrow();
  });

  it('uses canonical V2 validation when discovering durable resumable state', () => {
    const producer = relaySources().find((source) => source.name === 'producer')!.file;

    expect(producer.text).toContain(
      'return validateStageIntent(value, config, transferId)?.intent ?? null;',
    );
    expect(producer.text).toContain('!sameStageIntent(staged, finalized.stageIntent)');
    expect(producer.text).not.toContain('parseRelaySourceRuntimeConfig(readTrustedConfig(layout))');
  });

  it('rejects an out-of-adapter S3 mutation constructor fixture', () => {
    const sources = relaySources();
    const producer = sources.find((source) => source.name === 'producer')!;
    const injected = ts.createSourceFile(
      producer.file.fileName,
      `${producer.file.text}\nnew PutObjectCommand({});\n`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(() =>
      assertTask2RelaySourceBoundaries(
        sources.map((source) =>
          source.name === 'producer' ? { ...source, file: injected } : source,
        ),
      ),
    ).toThrow('S3 command outside AwsRelayObjectStore');
  });

  it('rejects a dynamic S3 import fixture outside adapter boundary', () => {
    const sources = relaySources();
    const finalizer = sources.find((source) => source.name === 'finalizer')!;
    const injected = ts.createSourceFile(
      finalizer.file.fileName,
      `${finalizer.file.text}\nvoid import('@aws-sdk/client-s3');\n`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(() =>
      assertTask2RelaySourceBoundaries(
        sources.map((source) =>
          source.name === 'finalizer' ? { ...source, file: injected } : source,
        ),
      ),
    ).toThrow('AWS SDK import outside relay adapter: finalizer');
  });

  it('keeps stage assessment before object-store construction with no execution bypass', () => {
    const stage = relaySources().find((source) => source.name === 'stage-script')!.file;
    const dynamicImports = collectNodes(
      stage,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword,
    );
    const forbiddenIdentifiers = collectNodes(
      stage,
      (node): node is ts.Identifier =>
        ts.isIdentifier(node) && ['eval', 'Function', 'require'].includes(node.text),
    );
    const forbiddenModules = importedModuleNames(stage).filter(
      (moduleName) =>
        moduleName === 'node:child_process' ||
        moduleName === 'node:fs' ||
        moduleName.startsWith('@aws-sdk/'),
    );
    const stdoutCalls = collectNodes(
      stage,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'writeStdout',
    );
    const offerCalls = collectNodes(
      stage,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'writeOffer',
    );

    expect(dynamicImports).toEqual([]);
    expect(forbiddenIdentifiers).toEqual([]);
    expect(forbiddenModules).toEqual([]);
    expect(stdoutCalls).toHaveLength(1);
    expect(stage.text).not.toContain('process.stderr');
    expect(stage.text).not.toContain('console.');
    expect(
      offerCalls.every((call) => {
        const value = call.arguments[1];
        return (
          (value !== undefined && ts.isIdentifier(value) && value.text === 'offer') ||
          (value !== undefined &&
            ts.isCallExpression(value) &&
            ts.isIdentifier(value.expression) &&
            value.expression.text === 'blockedOffer')
        );
      }),
    ).toBe(true);
    expect(stage.text.indexOf('const expectedAttestation')).toBeGreaterThan(
      stage.text.indexOf('const config'),
    );
    expect(stage.text.indexOf('objectStoreFor(config.relay)')).toBeGreaterThan(
      stage.text.indexOf('const expectedAttestation'),
    );
    expect(
      stage.text.indexOf('const lease = await recovery.acquireSourceStageLease({ configDigest })'),
    ).toBeGreaterThan(stage.text.indexOf('const config'));
    expect(
      stage.text.indexOf(
        'const discovery = await recovery.findSingleResumableStage({ config, configDigest })',
      ),
    ).toBeGreaterThan(stage.text.indexOf('const lease = await recovery.acquireSourceStageLease()'));
    expect(stage.text.indexOf('dependencies.createTransferId()')).toBeGreaterThan(
      stage.text.indexOf(
        'const discovery = await recovery.findSingleResumableStage({ config, configDigest })',
      ),
    );
    expect(
      stage.text.indexOf('recovery.releaseSourceStageLease({ leaseId: lease.leaseId })'),
    ).toBeGreaterThan(stage.text.indexOf('stageCenturionThreadCorpusRelay({'));
  });
});
