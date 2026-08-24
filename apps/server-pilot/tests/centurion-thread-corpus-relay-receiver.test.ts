import {
  WINDOWS_POWERSHELL,
  WINDOWS_PRIVATE_ACL_ENCODED_COMMAND,
  createWindowsPrivateAcl,
  parseRelayReceiverRuntimeConfig,
  receiveCenturionThreadCorpusRelay,
  type RelayReceiverRuntimeConfig,
  type RelayReceiverRuntimePort,
  type ReceiverFileSystem,
  type WindowsCommandRunner,
  type WindowsPrivateAcl,
} from '../src/ops/centurion-thread-corpus-relay-receiver.js';
import {
  buildCenturionRelayManifest,
  buildReceiveReceipt,
  receiverAcknowledgementKey,
  relayManifestKey,
  relayObjectKey,
  type CenturionRelayMember,
} from '../src/ops/centurion-thread-corpus-relay.js';
import {
  type RelayBucketConfig,
  type RelayObjectMetadata,
  type RelayObjectStore,
  type RelayPutInput,
} from '../src/ops/centurion-thread-corpus-relay-producer.js';
import {
  buildPrivateThreadCorpusSnapshot,
  formatLogicalMessages,
  type PrivateThreadCorpusSnapshot,
} from '../scripts/export-thread-corpus.js';
import { createReceiveCenturionThreadCorpusRelayCommand } from '../scripts/receive-centurion-thread-corpus-relay.js';
import * as receiverModule from '../src/ops/centurion-thread-corpus-relay-receiver.js';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const TRANSFER_ID = '3479ca40-b5a1-4bb3-aef1-02fcbefc949c';
const CHECKOUT_ROOT = 'C:\\synthetic\\zero';
const PRIVATE_ROOT = `${CHECKOUT_ROOT}\\.private\\centurion-thread-corpus`;
const PARTIAL_ROOT = `${PRIVATE_ROOT}\\.partial`;
const PARTIAL_PATH = `${PARTIAL_ROOT}\\${TRANSFER_ID}`;
const FINAL_PATH = `${PRIVATE_ROOT}\\${TRANSFER_ID}`;
const SAFE_BODY_MARKER = 'SAFE_RECEIVER_BODY_MARKER';
const SAFE_PATH_MARKER = 'C:\\synthetic\\safe-private-path';
const SAFE_CONFIG_MARKER = 'synthetic-private-relay';
const textEncoder = new TextEncoder();

function trustedWindowsPowerShellInspector() {
  return {
    inspect: async () => ({
      path: WINDOWS_POWERSHELL,
      stableIdentity: 'safe-powershell-identity',
      regularFile: true as const,
      symbolicLink: false as const,
      owner: 'trusted-system' as const,
      writableByOthers: false as const,
    }),
  };
}

const relayConfig: RelayBucketConfig = {
  region: 'synthetic-region-1',
  bucket: SAFE_CONFIG_MARKER,
  expectedBucketOwner: '123456789012',
  literalRelayRoot: 'private-relay',
  kmsKeyArn: 'arn:aws:kms:synthetic-region-1:123456789012:key/12345678-1234-1234-1234-123456789abc',
  lifecycleRuleId: 'private-relay-one-day',
  lifecycleExpirationDays: 1,
  maxSnapshotBytes: 1_000_000,
};

const runtimeConfig: RelayReceiverRuntimeConfig = {
  version: 'centurion-thread-corpus-relay-receiver-config-v1',
  relay: relayConfig,
  privateDestination: {
    checkoutRoot: CHECKOUT_ROOT,
    destinationRoot: PRIVATE_ROOT,
  },
};

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function comparePath(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function member(memberPath: string, content: Uint8Array): CenturionRelayMember {
  return {
    path: memberPath,
    bytes: content.byteLength,
    sha256: sha256(content),
    content,
  };
}

function syntheticSnapshot(): PrivateThreadCorpusSnapshot {
  const formatted = formatLogicalMessages([
    {
      sourceRowId: 'safe-receiver-row',
      scopeMembership: ['centurion_transport'],
      receivedAt: '2026-08-22T11:00:00.000Z',
      threadId: 'safe-receiver-thread',
      messageId: '<safe-receiver-message>',
      contentFingerprint: 'safe-receiver-content-fingerprint',
      provenanceFingerprint: 'safe-receiver-provenance-fingerprint',
      body: SAFE_BODY_MARKER,
      privateMessage: {
        subject: 'Safe receiver synthetic subject',
        direction: 'inbound',
        addresses: { from: [], to: [], cc: [], bcc: [] },
        originalAddresses: { from: [], to: [], cc: [], bcc: [] },
        canonicalHeaders: {},
        sentAt: null,
        rawMime: {
          locator: 'synthetic://safe-receiver-raw-mime',
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
          uidl: 'safe-receiver-uidl',
        },
      },
    },
  ]);

  return buildPrivateThreadCorpusSnapshot({
    context: {
      snapshotId: 'safe-receiver-snapshot-001',
      scope: {
        scopeKeys: ['centurion_transport', 'designated_reservationist_mailbox'],
        transportIds: ['transport-centurion', 'transport-designated'],
        participantAddressRef: 'private_designated_reservationist_address',
        messagePredicate: 'selected_transports_or_private_designated_address_before_as_of',
        quarantinePredicate: 'selected_ingest_mailbox_or_owner_header_before_as_of',
      },
      asOf: '2026-08-22T12:00:00.000Z',
      exporterVersion: 'safe-receiver-test-v1',
      unscopedQuarantineExcluded: 0,
    },
    formatted,
    hydration: {
      attachmentLocators: [],
      payloads: [
        {
          kind: 'raw_mime',
          sourceRowId: 'safe-receiver-row',
          status: 'available',
          content: textEncoder.encode('SAFE_RECEIVER_RAW_MIME'),
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

function cloneBytes(content: Uint8Array): Uint8Array {
  return new Uint8Array(content);
}

type StoredObject = {
  content: Uint8Array;
  metadata: RelayObjectMetadata;
};

class FakeRelayStore implements RelayObjectStore {
  readonly calls: string[] = [];
  readonly objects = new Map<string, StoredObject>();
  readonly putInputs: RelayPutInput[] = [];
  readonly headOverrides = new Map<string, RelayObjectMetadata | null>();
  assertResult = true;
  acknowledgementPutResult: 'created' | 'already_exists' | 'conflict' = 'created';
  materializeAcknowledgementOnPut = true;
  paginationPages = 1;
  paginationReads = 0;

  set(key: string, content: Uint8Array, override?: Partial<RelayObjectMetadata>): void {
    this.objects.set(key, {
      content: cloneBytes(content),
      metadata: { ...metadata(key, content), ...override },
    });
  }

  async assertRelayBucket(config: RelayBucketConfig): Promise<boolean> {
    this.calls.push('assert');
    expect(config).toEqual(relayConfig);
    return this.assertResult;
  }

  async putIfAbsent(input: RelayPutInput): Promise<'created' | 'already_exists' | 'conflict'> {
    this.calls.push(`put:${input.key}`);
    this.putInputs.push({
      ...input,
      content: cloneBytes(input.content),
    });
    if (
      input.content.byteLength !== input.bytes ||
      input.sha256 !== sha256(input.content) ||
      input.expectedBucketOwner !== relayConfig.expectedBucketOwner ||
      input.kmsKeyArn !== relayConfig.kmsKeyArn
    ) {
      return 'conflict';
    }
    if (this.materializeAcknowledgementOnPut && !this.objects.has(input.key)) {
      this.set(input.key, input.content);
    }
    return this.acknowledgementPutResult;
  }

  async head(key: string): Promise<RelayObjectMetadata | null> {
    this.calls.push(`head:${key}`);
    if (this.headOverrides.has(key)) {
      const overridden = this.headOverrides.get(key);
      return overridden ? { ...overridden } : null;
    }
    const object = this.objects.get(key);
    return object ? { ...object.metadata } : null;
  }

  async listAll(prefix: string): Promise<readonly RelayObjectMetadata[] | null> {
    this.calls.push(`list:${prefix}`);
    this.paginationReads += this.paginationPages;
    return [...this.objects.values()]
      .map((object) => object.metadata)
      .filter((candidate) => candidate.key.startsWith(prefix))
      .sort((left, right) => comparePath(left.key, right.key))
      .map((candidate) => ({ ...candidate }));
  }

  async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> {
    this.calls.push(`get:${key}`);
    const object = this.objects.get(key);
    return object && object.content.byteLength <= maxBytes ? cloneBytes(object.content) : null;
  }

  async deleteExact(): Promise<boolean> {
    throw new Error('receiver must not delete remote objects');
  }
}

type FakeReceiverFileSystemState = {
  roots: Map<string, Map<string, Uint8Array>>;
  partialLease: string | null;
  partialLeaseAcquireCalls: number;
  partialLeaseReleaseCalls: number;
  partialLeaseReleaseResult: boolean;
};

function createFakeReceiverFileSystemState(): FakeReceiverFileSystemState {
  return {
    roots: new Map(),
    partialLease: null,
    partialLeaseAcquireCalls: 0,
    partialLeaseReleaseCalls: 0,
    partialLeaseReleaseResult: true,
  };
}

class FakeReceiverFileSystem implements ReceiverFileSystem {
  readonly calls: string[] = [];
  readonly timeline: string[] = [];
  readonly roots: Map<string, Map<string, Uint8Array>>;
  readonly listingOverrides = new Map<string, readonly string[] | null>();
  readonly directoryOverrides = new Map<string, readonly string[] | null>();
  checkoutResult = {
    root: PRIVATE_ROOT,
    stableIdentity: 'safe-private-root-identity',
    volumeId: 'safe-volume-a',
  };
  acquirePartialDirectoryResult = true;
  currentPartial: string | null = null;
  failMemberWriteAt: number | null = null;
  memberWriteAttempts = 0;
  receiptWriteResult = true;
  beforeReadFile: ((filePath: string) => void) | null = null;
  afterPartialLeaseAssertion: (() => void) | null = null;

  constructor(
    private readonly state: FakeReceiverFileSystemState = createFakeReceiverFileSystemState(),
  ) {
    this.roots = state.roots;
  }

  async assertGitignoredPrivateRoot(): Promise<{
    root: string;
    stableIdentity: string;
    volumeId: string;
  } | null> {
    this.calls.push('assert-private-root');
    return { ...this.checkoutResult };
  }

  async acquirePartialLease(transferId: string): Promise<{ leaseId: string } | null> {
    this.calls.push(`acquire-partial-lease:${transferId}`);
    this.timeline.push('acquire-partial-lease');
    this.state.partialLeaseAcquireCalls += 1;
    if (transferId !== TRANSFER_ID || this.state.partialLease !== null) return null;
    this.state.partialLease = 'safe-partial-lease';
    return { leaseId: this.state.partialLease };
  }

  async assertPartialLease(input: { transferId: string; leaseId: string }): Promise<boolean> {
    this.calls.push(`assert-partial-lease:${input.transferId}`);
    const owned = input.transferId === TRANSFER_ID && input.leaseId === this.state.partialLease;
    this.afterPartialLeaseAssertion?.();
    return owned;
  }

  replacePartialLease(): void {
    this.state.partialLease = 'safe-replacement-partial-lease';
  }

  async releasePartialLease(input: { transferId: string; leaseId: string }): Promise<boolean> {
    this.calls.push(`release-partial-lease:${input.transferId}`);
    this.state.partialLeaseReleaseCalls += 1;
    if (
      input.transferId !== TRANSFER_ID ||
      !this.state.partialLeaseReleaseResult ||
      this.state.partialLease === null ||
      input.leaseId !== this.state.partialLease
    ) {
      return false;
    }
    this.state.partialLease = null;
    return true;
  }

  async acquirePartialDirectory(transferId: string): Promise<{
    path: string;
    created: boolean;
    stableIdentity: string;
    volumeId: string;
  } | null> {
    this.calls.push(`acquire-partial-directory:${transferId}`);
    this.timeline.push('acquire-partial-directory');
    if (!this.acquirePartialDirectoryResult || transferId !== TRANSFER_ID) return null;
    const created = !this.roots.has(PARTIAL_PATH);
    if (created) this.roots.set(PARTIAL_PATH, new Map());
    this.currentPartial = PARTIAL_PATH;
    return {
      path: PARTIAL_PATH,
      created,
      stableIdentity: 'safe-partial-identity',
      volumeId: 'safe-volume-a',
    };
  }

  async writeCreateNew(filePath: string, content: Uint8Array): Promise<boolean> {
    this.calls.push(`write:${filePath}`);
    this.memberWriteAttempts += 1;
    if (this.failMemberWriteAt === this.memberWriteAttempts) return false;
    const relative = this.relative(PARTIAL_PATH, filePath);
    const files = this.roots.get(PARTIAL_PATH);
    if (!relative || !files || files.has(relative)) return false;
    files.set(relative, cloneBytes(content));
    return true;
  }

  async readFile(filePath: string, maxBytes: number): Promise<Uint8Array | null> {
    this.calls.push(`read:${filePath}`);
    this.beforeReadFile?.(filePath);
    for (const [root, files] of [...this.roots.entries()].sort(
      ([left], [right]) => right.length - left.length,
    )) {
      const relative = this.relative(root, filePath);
      const content = relative ? files.get(relative) : undefined;
      if (content) return content.byteLength <= maxBytes ? cloneBytes(content) : null;
    }
    return null;
  }

  async listRelativePaths(root: string): Promise<readonly string[] | null> {
    this.calls.push(`list:${root}`);
    if (this.listingOverrides.has(root)) return this.listingOverrides.get(root) ?? null;
    const files = this.roots.get(root);
    return files ? [...files.keys()].sort(comparePath) : null;
  }

  async listRelativeDirectories(root: string): Promise<readonly string[] | null> {
    if (this.directoryOverrides.has(root)) return this.directoryOverrides.get(root) ?? null;
    const files = this.roots.get(root);
    return files
      ? [
          ...new Set(
            [...files.keys()].flatMap((filePath) => {
              const parts = filePath.split('/');
              return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
            }),
          ),
        ].sort(comparePath)
      : null;
  }

  async writeReceiveReceipt(receiptJson: string): Promise<{ path: string; sha256: string } | null> {
    this.calls.push('write-receipt');
    if (!this.receiptWriteResult || !this.currentPartial) return null;
    const files = this.roots.get(this.currentPartial);
    if (!files || files.has('receive-receipt.v1.json')) return null;
    const content = textEncoder.encode(receiptJson);
    files.set('receive-receipt.v1.json', content);
    return {
      path: path.win32.join(this.currentPartial, 'receive-receipt.v1.json'),
      sha256: sha256(content),
    };
  }

  promote(): boolean {
    const partial = this.roots.get(PARTIAL_PATH);
    if (!partial || this.roots.has(FINAL_PATH)) return false;
    this.roots.set(
      FINAL_PATH,
      new Map([...partial.entries()].map(([name, content]) => [name, cloneBytes(content)])),
    );
    this.roots.delete(PARTIAL_PATH);
    this.currentPartial = null;
    return true;
  }

  seedFinal(files: readonly [string, Uint8Array][]): void {
    this.roots.set(
      FINAL_PATH,
      new Map(files.map(([memberPath, content]) => [memberPath, cloneBytes(content)])),
    );
  }

  seedPartial(files: readonly [string, Uint8Array][]): void {
    this.roots.set(
      PARTIAL_PATH,
      new Map(files.map(([memberPath, content]) => [memberPath, cloneBytes(content)])),
    );
  }

  private relative(root: string, candidate: string): string | null {
    const relative = path.win32.relative(root, candidate).replaceAll('\\', '/');
    return relative.length > 0 && !relative.startsWith('../') && !path.win32.isAbsolute(relative)
      ? relative
      : null;
  }
}

class FakeWindowsPrivateAcl implements WindowsPrivateAcl {
  readonly calls: string[] = [];
  readonly trusted = new Map<string, { stableIdentity: string; volumeId: string }>([
    [
      PRIVATE_ROOT,
      {
        stableIdentity: 'safe-private-root-identity',
        volumeId: 'safe-volume-a',
      },
    ],
    [
      PARTIAL_ROOT,
      {
        stableIdentity: 'safe-partial-root-identity',
        volumeId: 'safe-volume-a',
      },
    ],
    [
      PARTIAL_PATH,
      {
        stableIdentity: 'safe-partial-identity',
        volumeId: 'safe-volume-a',
      },
    ],
  ]);
  readonly rejectedPaths = new Set<string>();
  readonly deniedDirectories = new Set<string>();
  readonly deniedFilePaths = new Set<string>();
  directoryResult = true;
  filesResult = true;
  promoteResult = true;
  fsyncResult = true;

  constructor(private readonly fileSystem: FakeReceiverFileSystem) {}

  async assertTrustedPath(
    pathValue: string,
  ): Promise<{ stableIdentity: string; volumeId: string } | null> {
    this.calls.push(`assert:${pathValue}`);
    if (this.rejectedPaths.has(pathValue)) return null;
    const trusted = this.trusted.get(pathValue);
    if (trusted) return { ...trusted };
    const partialMember = path.win32.relative(PARTIAL_PATH, pathValue).replaceAll('\\', '/');
    const partialDirectory = [...(this.fileSystem.roots.get(PARTIAL_PATH)?.keys() ?? [])].some(
      (member) => member.startsWith(`${partialMember}/`),
    );
    if (partialDirectory) {
      return {
        stableIdentity: `safe-partial-directory-${partialMember.replaceAll('/', '-')}`,
        volumeId: 'safe-volume-a',
      };
    }
    if (this.fileSystem.roots.get(PARTIAL_PATH)?.has(partialMember)) {
      return {
        stableIdentity: `safe-partial-file-${partialMember.replaceAll('/', '-')}`,
        volumeId: 'safe-volume-a',
      };
    }
    const finalMember = path.win32.relative(FINAL_PATH, pathValue).replaceAll('\\', '/');
    const finalDirectory = [...(this.fileSystem.roots.get(FINAL_PATH)?.keys() ?? [])].some(
      (member) => member.startsWith(`${finalMember}/`),
    );
    if (finalDirectory) {
      return {
        stableIdentity: `safe-final-directory-${finalMember.replaceAll('/', '-')}`,
        volumeId: 'safe-volume-a',
      };
    }
    return this.fileSystem.roots.get(FINAL_PATH)?.has(finalMember)
      ? {
          stableIdentity: `safe-final-file-${finalMember.replaceAll('/', '-')}`,
          volumeId: 'safe-volume-a',
        }
      : null;
  }

  async lockDownDirectory(pathValue: string): Promise<boolean> {
    this.calls.push(`lock-directory:${pathValue}`);
    this.fileSystem.timeline.push(`lock-directory:${pathValue}`);
    return this.directoryResult && !this.deniedDirectories.has(pathValue);
  }

  async lockDownFiles(paths: readonly string[]): Promise<boolean> {
    this.calls.push(`lock-files:${paths.join(',')}`);
    return this.filesResult && !paths.some((pathValue) => this.deniedFilePaths.has(pathValue));
  }

  async promoteNoReplace(partialPath: string, finalPath: string): Promise<boolean> {
    this.calls.push(`promote:${partialPath}:${finalPath}`);
    if (!this.promoteResult || partialPath !== PARTIAL_PATH || finalPath !== FINAL_PATH)
      return false;
    if (!this.fileSystem.promote()) return false;
    this.trusted.set(FINAL_PATH, {
      stableIdentity: 'safe-final-identity',
      volumeId: 'safe-volume-a',
    });
    return true;
  }

  async fsyncReceipt(pathValue: string): Promise<boolean> {
    this.calls.push(`fsync:${pathValue}`);
    return this.fsyncResult;
  }
}

class FakeReceiverRuntime implements RelayReceiverRuntimePort {
  readonly calls: string[] = [];
  platformResult = 'win32';
  configResult = JSON.stringify(runtimeConfig);
  checkoutResult: { gitignored: boolean; stableIdentity: string; volumeId: string } | null = {
    gitignored: true,
    stableIdentity: 'safe-private-root-identity',
    volumeId: 'safe-volume-a',
  };

  platform(): string {
    this.calls.push('platform');
    return this.platformResult;
  }

  async readProtectedConfig(): Promise<string> {
    this.calls.push('config');
    return this.configResult;
  }

  async inspectCheckout(input: {
    checkoutRoot: string;
    destinationRoot: string;
  }): Promise<{ gitignored: boolean; stableIdentity: string; volumeId: string } | null> {
    this.calls.push('inspect-checkout');
    expect(input).toEqual(runtimeConfig.privateDestination);
    return this.checkoutResult ? { ...this.checkoutResult } : null;
  }
}

type ReceiverHarness = {
  snapshot: PrivateThreadCorpusSnapshot;
  members: CenturionRelayMember[];
  relayManifestBytes: Uint8Array;
  manifest: ReturnType<typeof buildCenturionRelayManifest>['manifest'];
  store: FakeRelayStore;
  fileSystem: FakeReceiverFileSystem;
  acl: FakeWindowsPrivateAcl;
  runtime: FakeReceiverRuntime;
};

function relayPrefix(): string {
  const key = relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID);
  return key.slice(0, -'relay-manifest.v1.json'.length);
}

function createHarness(): ReceiverHarness {
  const snapshot = syntheticSnapshot();
  const members = sourceMembers(snapshot);
  const built = buildCenturionRelayManifest(TRANSFER_ID, members, relayConfig.maxSnapshotBytes);
  const store = new FakeRelayStore();
  for (const candidate of members) {
    store.set(
      relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, candidate.path),
      candidate.content,
    );
  }
  store.set(relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID), built.manifestBytes);

  const fileSystem = new FakeReceiverFileSystem();
  return {
    snapshot,
    members,
    relayManifestBytes: built.manifestBytes,
    manifest: built.manifest,
    store,
    fileSystem,
    acl: new FakeWindowsPrivateAcl(fileSystem),
    runtime: new FakeReceiverRuntime(),
  };
}

function receive(harness: ReceiverHarness) {
  return receiveCenturionThreadCorpusRelay({
    config: runtimeConfig,
    transferId: TRANSFER_ID,
    store: harness.store,
    fileSystem: harness.fileSystem,
    acl: harness.acl,
    runtime: harness.runtime,
  });
}

function useFreshReceiverFileSystem(
  harness: ReceiverHarness,
  state: FakeReceiverFileSystemState,
): FakeReceiverFileSystem {
  const fileSystem = new FakeReceiverFileSystem(state);
  harness.fileSystem = fileSystem;
  harness.acl = new FakeWindowsPrivateAcl(fileSystem);
  return fileSystem;
}

function expectedReceipt(harness: ReceiverHarness): string {
  return buildReceiveReceipt({
    transferId: TRANSFER_ID,
    snapshotId: harness.snapshot.context.snapshotId,
    sourceManifestSha256: harness.manifest.sourceManifestSha256,
    relayManifestSha256: sha256(harness.relayManifestBytes),
    memberSetSha256: harness.manifest.memberSetSha256,
  });
}

function seedVerifiedFinal(harness: ReceiverHarness, receipt = expectedReceipt(harness)): void {
  harness.fileSystem.seedFinal([
    ...harness.members.map(
      (candidate) => [candidate.path, candidate.content] as [string, Uint8Array],
    ),
    ['receive-receipt.v1.json', textEncoder.encode(receipt)],
  ]);
  harness.acl.trusted.set(FINAL_PATH, {
    stableIdentity: 'safe-final-identity',
    volumeId: 'safe-volume-a',
  });
}

function replaceRemoteMemberAndRelayManifest(
  harness: ReceiverHarness,
  memberPath: string,
  replacement: Uint8Array,
): void {
  harness.members = harness.members.map((candidate) =>
    candidate.path === memberPath ? member(memberPath, replacement) : candidate,
  );
  const sourceManifest = harness.members.find((candidate) => candidate.path === 'manifest.json');
  if (!sourceManifest) throw new Error('synthetic manifest member missing');
  const memberSet = sha256(
    textEncoder.encode(
      harness.members
        .map((candidate) => `${candidate.path}\t${candidate.bytes}\t${candidate.sha256}\n`)
        .join(''),
    ),
  );
  const forgedManifest: ReceiverHarness['manifest'] = {
    schemaVersion: 'centurion-thread-corpus-relay-v1',
    transferId: TRANSFER_ID,
    snapshotId: harness.snapshot.context.snapshotId,
    sourceManifestSha256: sourceManifest.sha256,
    memberSetSha256: memberSet,
    members: harness.members.map(({ path: memberPathValue, bytes, sha256: digest }) => ({
      path: memberPathValue,
      bytes,
      sha256: digest,
    })),
  };
  harness.relayManifestBytes = textEncoder.encode(`${JSON.stringify(forgedManifest, null, 2)}\n`);
  harness.manifest = forgedManifest;
  for (const candidate of harness.members) {
    harness.store.set(
      relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, candidate.path),
      candidate.content,
    );
  }
  harness.store.set(
    relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID),
    harness.relayManifestBytes,
  );
}

function assertNoFixtureLeak(value: unknown): void {
  const output = JSON.stringify(value);
  expect(output).not.toContain(SAFE_BODY_MARKER);
  expect(output).not.toContain(SAFE_PATH_MARKER);
  expect(output).not.toContain(SAFE_CONFIG_MARKER);
  expect(output).not.toContain(PRIVATE_ROOT);
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

function containingClassName(node: ts.Node): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isClassDeclaration(current)) return current.name?.text ?? null;
  }
  return null;
}

function sourceImports(source: ts.SourceFile): string[] {
  return collectNodes(source, ts.isImportDeclaration).flatMap((node) =>
    ts.isStringLiteral(node.moduleSpecifier) ? [node.moduleSpecifier.text] : [],
  );
}

describe('Centurion relay receiver', () => {
  it('downloads an exact verified relay into an ACL-protected partial directory, fsyncs receipt, promotes without replacement, and conditionally acknowledges', async () => {
    const harness = createHarness();

    const result = await receive(harness);

    expect(result).toEqual({
      outcome: 'received',
      transferId: TRANSFER_ID,
      sourceManifestSha256: harness.manifest.sourceManifestSha256,
      memberSetSha256: harness.manifest.memberSetSha256,
    });
    expect(await harness.fileSystem.listRelativePaths(FINAL_PATH)).toEqual([
      ...harness.members.map((candidate) => candidate.path),
      'receive-receipt.v1.json',
    ]);
    expect(harness.acl.calls).toContain(`lock-directory:${PARTIAL_PATH}`);
    expect(harness.acl.calls).toContain(`lock-directory:${FINAL_PATH}`);
    expect(
      harness.acl.calls.indexOf(
        `fsync:${path.win32.join(PARTIAL_PATH, 'receive-receipt.v1.json')}`,
      ),
    ).toBeLessThan(harness.acl.calls.indexOf(`promote:${PARTIAL_PATH}:${FINAL_PATH}`));
    expect(harness.store.putInputs).toHaveLength(1);
    expect(harness.store.putInputs[0]).toMatchObject({
      key: receiverAcknowledgementKey(relayConfig.literalRelayRoot, TRANSFER_ID),
      expectedBucketOwner: relayConfig.expectedBucketOwner,
      kmsKeyArn: relayConfig.kmsKeyArn,
    });
    assertNoFixtureLeak(result);
  });

  it('validates remote manifest, heads, and inventory before acquiring the partial lease', async () => {
    const harness = createHarness();
    const order: string[] = [];
    const originalAssert = harness.store.assertRelayBucket.bind(harness.store);
    const originalHead = harness.store.head.bind(harness.store);
    const originalGet = harness.store.getBounded.bind(harness.store);
    const originalList = harness.store.listAll.bind(harness.store);
    const originalAcquire = harness.fileSystem.acquirePartialLease.bind(harness.fileSystem);
    vi.spyOn(harness.store, 'assertRelayBucket').mockImplementation(async (config) => {
      order.push('remote-bucket');
      return originalAssert(config);
    });
    vi.spyOn(harness.store, 'head').mockImplementation(async (key) => {
      order.push(`remote-head:${key}`);
      return originalHead(key);
    });
    vi.spyOn(harness.store, 'getBounded').mockImplementation(async (key, maxBytes) => {
      order.push(`remote-get:${key}`);
      return originalGet(key, maxBytes);
    });
    vi.spyOn(harness.store, 'listAll').mockImplementation(async (prefix) => {
      order.push(`remote-list:${prefix}`);
      return originalList(prefix);
    });
    vi.spyOn(harness.fileSystem, 'acquirePartialLease').mockImplementation(async (transferId) => {
      expect(order).toContain('remote-bucket');
      expect(order).toContain(
        `remote-head:${relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID)}`,
      );
      expect(order).toContain(
        `remote-get:${relayManifestKey(relayConfig.literalRelayRoot, TRANSFER_ID)}`,
      );
      expect(order).toContain(`remote-list:${relayPrefix()}`);
      for (const candidate of harness.members) {
        expect(order).toContain(
          `remote-head:${relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, candidate.path)}`,
        );
      }
      order.push('partial-lease');
      return originalAcquire(transferId);
    });

    expect(await receive(harness)).toMatchObject({ outcome: 'received' });
    expect(order).toContain('partial-lease');
  });

  it('resumes exact cached members from a fresh fake filesystem after a mid-download interruption', async () => {
    const state = createFakeReceiverFileSystemState();
    const harness = createHarness();
    const interruptedFileSystem = useFreshReceiverFileSystem(harness, state);
    interruptedFileSystem.failMemberWriteAt = 2;

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    const cached = harness.members[0]!;
    expect(state.roots.get(PARTIAL_PATH)?.get(cached.path)).toEqual(cached.content);

    const recoveredFileSystem = useFreshReceiverFileSystem(harness, state);
    harness.store.calls.length = 0;
    expect(await receive(harness)).toMatchObject({ outcome: 'received' });
    expect(recoveredFileSystem.calls).toContain(`acquire-partial-lease:${TRANSFER_ID}`);
    expect(recoveredFileSystem.calls).toContain(`acquire-partial-directory:${TRANSFER_ID}`);
    expect(harness.store.calls).not.toContain(
      `get:${relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, cached.path)}`,
    );
    expect(await recoveredFileSystem.listRelativePaths(FINAL_PATH)).toEqual([
      ...harness.members.map((candidate) => candidate.path),
      'receive-receipt.v1.json',
    ]);
  });

  it.each([
    'extra partial member',
    'tampered cached member',
    'incomplete receipt',
    'bad complete receipt',
    'wrong partial ACL',
    'wrong partial volume',
  ] as const)('blocks %s without deleting private state or acknowledging', async (kind) => {
    const state = createFakeReceiverFileSystemState();
    const harness = createHarness();
    const fileSystem = useFreshReceiverFileSystem(harness, state);
    const first = harness.members[0]!;
    if (kind === 'extra partial member') {
      fileSystem.seedPartial([
        [first.path, first.content],
        ['safe-extra-partial-member', textEncoder.encode('SAFE_EXTRA_PARTIAL')],
      ]);
    } else if (kind === 'tampered cached member') {
      fileSystem.seedPartial([[first.path, textEncoder.encode('SAFE_TAMPERED_PARTIAL')]]);
    } else if (kind === 'incomplete receipt') {
      fileSystem.seedPartial([
        [first.path, first.content],
        ['receive-receipt.v1.json', textEncoder.encode('{"safe":"incomplete"}\n')],
      ]);
    } else if (kind === 'bad complete receipt') {
      fileSystem.seedPartial([
        ...harness.members.map(
          (candidate) => [candidate.path, candidate.content] as [string, Uint8Array],
        ),
        ['receive-receipt.v1.json', textEncoder.encode('{"safe":"wrong"}\n')],
      ]);
    } else {
      fileSystem.seedPartial([[first.path, first.content]]);
      if (kind === 'wrong partial ACL') {
        harness.acl.rejectedPaths.add(PARTIAL_PATH);
      } else {
        harness.acl.trusted.set(PARTIAL_PATH, {
          stableIdentity: 'safe-partial-identity',
          volumeId: 'safe-volume-b',
        });
      }
    }

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(fileSystem.calls).toContain(`acquire-partial-lease:${TRANSFER_ID}`);
    expect(harness.store.putInputs).toEqual([]);
    expect(state.roots.has(PARTIAL_PATH)).toBe(true);
  });

  it('blocks a cached partial member whose identity changes after ACL verification', async () => {
    const state = createFakeReceiverFileSystemState();
    const harness = createHarness();
    const fileSystem = useFreshReceiverFileSystem(harness, state);
    const cached = harness.members[0]!;
    const cachedPath = path.win32.join(PARTIAL_PATH, ...cached.path.split('/'));
    fileSystem.seedPartial([[cached.path, cached.content]]);
    let swapped = false;
    fileSystem.beforeReadFile = (filePath) => {
      if (swapped || filePath !== cachedPath) return;
      swapped = true;
      harness.acl.trusted.set(cachedPath, {
        stableIdentity: 'safe-swapped-partial-member',
        volumeId: 'safe-volume-a',
      });
    };

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(swapped).toBe(true);
    expect(harness.store.putInputs).toEqual([]);
    expect(state.roots.has(PARTIAL_PATH)).toBe(true);
  });

  it('blocks an unreleased stale partial lease without inspecting or acknowledging private state', async () => {
    const state = createFakeReceiverFileSystemState();
    state.partialLease = 'safe-stale-partial-lease';
    const harness = createHarness();
    const fileSystem = useFreshReceiverFileSystem(harness, state);

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(fileSystem.calls).toContain(`acquire-partial-lease:${TRANSFER_ID}`);
    expect(fileSystem.calls).not.toContain(`acquire-partial-directory:${TRANSFER_ID}`);
    expect(harness.store.putInputs).toEqual([]);
    expect(state.partialLease).toBe('safe-stale-partial-lease');
  });

  it('allows only one concurrent fake receiver to acquire a fresh partial lease', async () => {
    const state = createFakeReceiverFileSystemState();
    const first = createHarness();
    const second = createHarness();
    useFreshReceiverFileSystem(first, state);
    useFreshReceiverFileSystem(second, state);

    const outcomes = await Promise.all([receive(first), receive(second)]);

    expect(outcomes.filter((outcome) => outcome.outcome === 'received')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === 'blocked')).toHaveLength(1);
    expect(state.partialLeaseAcquireCalls).toBe(2);
    expect(state.partialLeaseReleaseCalls).toBe(1);
    expect(first.store.putInputs.length + second.store.putInputs.length).toBe(1);
  });

  it('retries receipt writing from a complete trusted partial without re-downloading members', async () => {
    const state = createFakeReceiverFileSystemState();
    const harness = createHarness();
    const failedFileSystem = useFreshReceiverFileSystem(harness, state);
    failedFileSystem.receiptWriteResult = false;

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(state.roots.get(PARTIAL_PATH)?.size).toBe(harness.members.length);

    const retryFileSystem = useFreshReceiverFileSystem(harness, state);
    harness.store.calls.length = 0;
    expect(await receive(harness)).toMatchObject({ outcome: 'received' });
    expect(retryFileSystem.calls).toContain('write-receipt');
    for (const candidate of harness.members) {
      expect(harness.store.calls).not.toContain(
        `get:${relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, candidate.path)}`,
      );
    }
  });

  it('retries promotion from a receipt-bound trusted partial without rewriting receipt or members', async () => {
    const state = createFakeReceiverFileSystemState();
    const harness = createHarness();
    useFreshReceiverFileSystem(harness, state);
    harness.acl.promoteResult = false;

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(state.roots.get(PARTIAL_PATH)?.has('receive-receipt.v1.json')).toBe(true);

    const retryFileSystem = useFreshReceiverFileSystem(harness, state);
    harness.store.calls.length = 0;
    expect(await receive(harness)).toMatchObject({ outcome: 'received' });
    expect(retryFileSystem.calls).not.toContain('write-receipt');
    for (const candidate of harness.members) {
      expect(harness.store.calls).not.toContain(
        `get:${relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, candidate.path)}`,
      );
    }
  });

  it('blocks after acknowledgement when exact partial-lease release cannot be verified', async () => {
    const state = createFakeReceiverFileSystemState();
    state.partialLeaseReleaseResult = false;
    const harness = createHarness();
    useFreshReceiverFileSystem(harness, state);

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.store.putInputs).toHaveLength(1);
    expect(state.partialLeaseReleaseCalls).toBe(1);
    expect(state.partialLease).toBe('safe-partial-lease');
  });

  it.each([
    'non-Windows platform',
    'unsafe private root',
    'unignored destination',
    'wrong partial volume',
    'partial directory ACL failure',
  ])('blocks %s before source-member download or promotion', async (kind) => {
    const harness = createHarness();
    if (kind === 'non-Windows platform') {
      harness.runtime.platformResult = 'linux';
    } else if (kind === 'unsafe private root') {
      harness.acl.rejectedPaths.add(PRIVATE_ROOT);
    } else if (kind === 'unignored destination') {
      harness.runtime.checkoutResult = {
        stableIdentity: 'safe-private-root-identity',
        volumeId: 'safe-volume-a',
        gitignored: false,
      };
    } else if (kind === 'wrong partial volume') {
      harness.acl.trusted.set(PARTIAL_PATH, {
        stableIdentity: 'safe-partial-identity',
        volumeId: 'safe-volume-b',
      });
    } else {
      harness.acl.directoryResult = false;
    }

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(
      harness.store.calls.filter((call) =>
        harness.members.some(
          (candidate) =>
            call ===
            `get:${relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, candidate.path)}`,
        ),
      ),
    ).toEqual([]);
    expect(harness.acl.calls).not.toContain(`promote:${PARTIAL_PATH}:${FINAL_PATH}`);
    expect(harness.store.putInputs).toEqual([]);
  });

  it.each([
    'missing remote member',
    'extra remote key',
    'wrong expected owner gate',
    'wrong KMS metadata',
    'wrong checksum metadata',
    'wrong downloaded hash',
  ])('blocks %s without deleting local or remote state', async (kind) => {
    const harness = createHarness();
    const first = harness.members[0]!;
    const firstKey = relayObjectKey(relayConfig.literalRelayRoot, TRANSFER_ID, first.path);
    if (kind === 'missing remote member') {
      harness.store.objects.delete(firstKey);
    } else if (kind === 'extra remote key') {
      harness.store.set(`${relayPrefix()}unexpected-safe-member`, textEncoder.encode('SAFE_EXTRA'));
    } else if (kind === 'wrong expected owner gate') {
      harness.store.assertResult = false;
    } else if (kind === 'wrong KMS metadata') {
      const object = harness.store.objects.get(firstKey)!;
      object.metadata = {
        ...object.metadata,
        sseKmsKeyId: 'arn:aws:kms:synthetic-region-1:123456789012:key/wrong-key',
      };
    } else if (kind === 'wrong checksum metadata') {
      const object = harness.store.objects.get(firstKey)!;
      object.metadata = { ...object.metadata, sha256: '0'.repeat(64) };
    } else {
      const object = harness.store.objects.get(firstKey)!;
      object.content = textEncoder.encode('SAFE_ALTERED_DOWNLOAD');
    }

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.acl.calls).not.toContain(`promote:${PARTIAL_PATH}:${FINAL_PATH}`);
    expect(harness.store.putInputs).toEqual([]);
  });

  it('uses complete paginated relay inventory before downloading any source member', async () => {
    const harness = createHarness();
    harness.store.paginationPages = 2;

    expect(await receive(harness)).toMatchObject({ outcome: 'received' });
    expect(harness.store.paginationReads).toBe(2);
    expect(harness.store.calls).toContain(`list:${relayPrefix()}`);
  });

  it('blocks a transport-valid member set that fails V2 reconciliation', async () => {
    const harness = createHarness();
    replaceRemoteMemberAndRelayManifest(
      harness,
      'manifest.json',
      textEncoder.encode('{\n  "safe": "but-not-v2"\n}\n'),
    );

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.acl.calls).not.toContain(`promote:${PARTIAL_PATH}:${FINAL_PATH}`);
    expect(harness.store.putInputs).toEqual([]);
  });

  it('blocks when receipt cannot be fsynced before no-replace promotion', async () => {
    const harness = createHarness();
    harness.acl.fsyncResult = false;

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.acl.calls).toContain(
      `fsync:${path.win32.join(PARTIAL_PATH, 'receive-receipt.v1.json')}`,
    );
    expect(harness.acl.calls).not.toContain(`promote:${PARTIAL_PATH}:${FINAL_PATH}`);
    expect(harness.store.putInputs).toEqual([]);
  });

  it('takes partial lease before locking root and acquiring partial directory', async () => {
    const harness = createHarness();

    expect(await receive(harness)).toMatchObject({ outcome: 'received' });
    expect(harness.fileSystem.timeline.slice(0, 4)).toEqual([
      'acquire-partial-lease',
      `lock-directory:${PRIVATE_ROOT}`,
      `lock-directory:${PARTIAL_ROOT}`,
      'acquire-partial-directory',
    ]);
  });

  it('blocks before partial creation when private root or partial parent lockdown fails', async () => {
    const harness = createHarness();
    harness.acl.deniedDirectories.add(PARTIAL_ROOT);

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.store.putInputs).toEqual([]);
  });

  it('blocks an existing final-path collision with an extra local path', async () => {
    const harness = createHarness();
    seedVerifiedFinal(harness);
    harness.fileSystem.listingOverrides.set(FINAL_PATH, [
      ...harness.members.map((candidate) => candidate.path),
      'receive-receipt.v1.json',
      'unexpected-safe-local-file',
    ]);

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.acl.calls).not.toContain(`promote:${PARTIAL_PATH}:${FINAL_PATH}`);
    expect(harness.store.putInputs).toEqual([]);
  });

  it('blocks acknowledgement retry when a final member ACL cannot be restricted', async () => {
    const harness = createHarness();
    seedVerifiedFinal(harness);
    harness.acl.deniedFilePaths.add(path.win32.join(FINAL_PATH, harness.members[0]!.path));

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.store.putInputs).toEqual([]);
  });

  it('retries after promotion-before-acknowledgement interruption from verified final state only', async () => {
    const harness = createHarness();
    harness.store.acknowledgementPutResult = 'conflict';
    harness.store.materializeAcknowledgementOnPut = false;

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(await harness.fileSystem.listRelativePaths(FINAL_PATH)).toEqual([
      ...harness.members.map((candidate) => candidate.path),
      'receive-receipt.v1.json',
    ]);
    const promotion = `promote:${PARTIAL_PATH}:${FINAL_PATH}`;
    expect(harness.acl.calls.filter((call) => call === promotion)).toHaveLength(1);

    harness.store.acknowledgementPutResult = 'created';
    harness.store.materializeAcknowledgementOnPut = true;
    expect(await receive(harness)).toMatchObject({ outcome: 'received' });
    expect(harness.acl.calls.filter((call) => call === promotion)).toHaveLength(1);
  });

  it('accepts acknowledgement response loss only after exact acknowledgement head verification', async () => {
    const harness = createHarness();
    harness.store.acknowledgementPutResult = 'conflict';
    harness.store.materializeAcknowledgementOnPut = true;

    expect(await receive(harness)).toMatchObject({ outcome: 'received' });
    const acknowledgementKey = receiverAcknowledgementKey(
      relayConfig.literalRelayRoot,
      TRANSFER_ID,
    );
    expect(harness.store.calls).toContain(`put:${acknowledgementKey}`);
    expect(harness.store.calls).toContain(`head:${acknowledgementKey}`);
  });

  it('blocks existing final state when receive receipt does not exactly match verified bindings', async () => {
    const harness = createHarness();
    seedVerifiedFinal(
      harness,
      `${JSON.stringify({ schemaVersion: 'safe-wrong-receipt', marker: 'SAFE_WRONG_RECEIPT' })}\n`,
    );

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.store.putInputs).toEqual([]);
  });

  it('blocks acknowledgement when acknowledgement head metadata does not exactly match', async () => {
    const harness = createHarness();
    const acknowledgementKey = receiverAcknowledgementKey(
      relayConfig.literalRelayRoot,
      TRANSFER_ID,
    );
    harness.store.headOverrides.set(acknowledgementKey, {
      key: acknowledgementKey,
      bytes: 1,
      sha256: '0'.repeat(64),
      serverSideEncryption: 'aws:kms',
      sseKmsKeyId: relayConfig.kmsKeyArn,
    });

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(await harness.fileSystem.listRelativePaths(FINAL_PATH)).not.toBeNull();
  });

  it('does not acknowledge an unsafe final reparse-path collision', async () => {
    const harness = createHarness();
    seedVerifiedFinal(harness);
    harness.acl.rejectedPaths.add(FINAL_PATH);

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.store.putInputs).toEqual([]);
  });

  it('parses only exact receiver configuration and never returns config values in outcome', async () => {
    expect(parseRelayReceiverRuntimeConfig(JSON.stringify(runtimeConfig))).toEqual(runtimeConfig);
    expect(
      parseRelayReceiverRuntimeConfig(
        JSON.stringify({
          ...runtimeConfig,
          privateDestination: {
            ...runtimeConfig.privateDestination,
            destinationRoot: SAFE_PATH_MARKER,
          },
        }),
      ),
    ).toBeNull();
    assertNoFixtureLeak({ outcome: 'blocked' });
  });
});

describe('Windows private ACL process adapter', () => {
  it('uses one static encoded PowerShell invocation with shell disabled and a bounded environment', async () => {
    const runner: WindowsCommandRunner = {
      run: vi.fn(async () => ({
        status: 0,
        stdout: '{"ok":true,"stableIdentity":"safe-handle-identity","volumeId":"safe-volume-a"}',
      })),
    };
    const acl = createWindowsPrivateAcl(runner, trustedWindowsPowerShellInspector());

    expect(await acl.assertTrustedPath(SAFE_PATH_MARKER)).toEqual({
      stableIdentity: 'safe-handle-identity',
      volumeId: 'safe-volume-a',
    });
    expect(runner.run).toHaveBeenCalledWith({
      executable: WINDOWS_POWERSHELL,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        WINDOWS_PRIVATE_ACL_ENCODED_COMMAND,
      ],
      options: {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: 'C:\\Windows\\System32',
        env: {
          CENTURION_RELAY_OPERATION: 'assert',
          CENTURION_RELAY_PATH: SAFE_PATH_MARKER,
        },
      },
    });
  });

  it('keeps hostile path characters only in bounded environment values, never PowerShell arguments or script text', async () => {
    const hostilePath = 'C:\\synthetic\\safe";Write-Output SAFE_INTERPOLATION_MARKER;#';
    const runner: WindowsCommandRunner = {
      run: vi.fn(async () => ({ status: 1, stdout: null })),
    };
    const acl = createWindowsPrivateAcl(runner, trustedWindowsPowerShellInspector());

    expect(await acl.assertTrustedPath(hostilePath)).toBeNull();
    const invocation = vi.mocked(runner.run).mock.calls[0]?.[0];
    expect(invocation).toBeDefined();
    expect(invocation!.args.join(' ')).not.toContain('SAFE_INTERPOLATION_MARKER');
    expect(
      Buffer.from(WINDOWS_PRIVATE_ACL_ENCODED_COMMAND, 'base64').toString('utf16le'),
    ).not.toContain('SAFE_INTERPOLATION_MARKER');
    expect(Object.keys(invocation!.options.env)).toEqual([
      'CENTURION_RELAY_OPERATION',
      'CENTURION_RELAY_PATH',
    ]);
    expect(invocation!.options.env.CENTURION_RELAY_PATH).toBe(hostilePath);
  });

  it('opens a writable receipt handle before forcing its durable flush', () => {
    const script = Buffer.from(WINDOWS_PRIVATE_ACL_ENCODED_COMMAND, 'base64').toString('utf16le');

    expect(script).toContain(
      'New-Object IO.FileStream($PathValue, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)',
    );
    expect(script).toContain('$stream.Flush($true)');
  });
});

describe('bounded descriptor reads', () => {
  it('rejects a file that grows beyond its checked length without an oversized read', () => {
    type DescriptorReader = (
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => number;
    type BoundedReader = (
      descriptor: number,
      expectedBytes: number,
      reader: DescriptorReader,
    ) => Uint8Array | null;
    const exported = receiverModule as unknown as {
      readExactBoundedDescriptor?: BoundedReader;
    };
    const reads: Array<readonly [number, number]> = [];
    const reader: DescriptorReader = (_descriptor, buffer, offset, length, position) => {
      reads.push([position, length]);
      const source = position === 0 ? new Uint8Array([1, 2]) : new Uint8Array([3]);
      const copied = Math.min(length, source.byteLength);
      buffer.set(source.subarray(0, copied), offset);
      return copied;
    };

    expect(exported.readExactBoundedDescriptor).toEqual(expect.any(Function));
    expect(exported.readExactBoundedDescriptor!(17, 2, reader)).toBeNull();
    expect(reads).toEqual([
      [0, 2],
      [2, 1],
    ]);
  });
});

describe('final retry ACL batches', () => {
  it('locks and reasserts 4,097 files in stable 4,096-path batches', async () => {
    type TrustedFile = {
      path: string;
      identity: { stableIdentity: string; volumeId: string };
    };
    type LockAndReassert = (
      acl: WindowsPrivateAcl,
      expectedVolume: string,
      files: readonly TrustedFile[],
    ) => Promise<boolean>;
    const exported = receiverModule as unknown as {
      lockAndReassertFileAclBatches?: LockAndReassert;
    };
    const files = Array.from({ length: 4_097 }, (_, index) => ({
      path: `C:\\synthetic\\safe-final\\member-${String(index).padStart(4, '0')}`,
      identity: {
        stableIdentity: `safe-identity-${String(index)}`,
        volumeId: 'safe-volume-a',
      },
    }));
    const identities = new Map(files.map((file) => [file.path, file.identity]));
    const batches: string[][] = [];
    const acl: WindowsPrivateAcl = {
      assertTrustedPath: async (pathValue) => {
        const identity = identities.get(pathValue);
        return identity ? { ...identity } : null;
      },
      lockDownDirectory: async () => true,
      lockDownFiles: async (paths) => {
        batches.push([...paths]);
        return batches.length === 1;
      },
      promoteNoReplace: async () => true,
      fsyncReceipt: async () => true,
    };

    expect(exported.lockAndReassertFileAclBatches).toEqual(expect.any(Function));
    expect(await exported.lockAndReassertFileAclBatches!(acl, 'safe-volume-a', files)).toBe(false);
    expect(batches.map((batch) => batch.length)).toEqual([4_096, 1]);
    expect(batches[0]![0]).toBe(files[0]!.path);
    expect(batches[1]![0]).toBe(files[4_096]!.path);
  });
});

describe('receive Centurion relay command', () => {
  it('takes exactly one UUID and emits only fixed PII-free receipt JSON', async () => {
    const harness = createHarness();
    const stdout: string[] = [];
    const command = createReceiveCenturionThreadCorpusRelayCommand({
      args: () => ['--transfer-id', TRANSFER_ID],
      runtime: harness.runtime,
      objectStoreFor: () => harness.store,
      fileSystemFor: () => harness.fileSystem,
      acl: harness.acl,
      writeStdout: (value) => stdout.push(value),
    });

    expect(await command()).toBe(0);
    expect(stdout).toEqual([
      `${JSON.stringify({
        schemaVersion: 'centurion-thread-corpus-relay-receive-receipt-v1',
        outcome: 'received',
        transferId: TRANSFER_ID,
        sourceManifestSha256: harness.manifest.sourceManifestSha256,
        memberSetSha256: harness.manifest.memberSetSha256,
      })}\n`,
    ]);
    assertNoFixtureLeak(stdout);
  });

  it('blocks invalid or extra arguments before it reads protected configuration', async () => {
    const harness = createHarness();
    const stdout: string[] = [];
    const command = createReceiveCenturionThreadCorpusRelayCommand({
      args: () => ['--transfer-id', 'not-a-uuid', SAFE_PATH_MARKER],
      runtime: harness.runtime,
      objectStoreFor: () => harness.store,
      fileSystemFor: () => harness.fileSystem,
      acl: harness.acl,
      writeStdout: (value) => stdout.push(value),
    });

    expect(await command()).toBe(2);
    expect(stdout).toEqual([
      '{"schemaVersion":"centurion-thread-corpus-relay-receive-receipt-v1","outcome":"blocked"}\n',
    ]);
    expect(harness.runtime.calls).toEqual([]);
    assertNoFixtureLeak(stdout);
  });
  it('blocks replacement partial lease before promotion or acknowledgement', async () => {
    const harness = createHarness();
    let replaced = false;
    harness.fileSystem.afterPartialLeaseAssertion = () => {
      if (!replaced) {
        replaced = true;
        harness.fileSystem.replacePartialLease();
      }
    };

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.acl.calls).not.toContain(`promote:${PARTIAL_PATH}:${FINAL_PATH}`);
    expect(harness.store.putInputs).toHaveLength(0);
  });

  it('blocks extra writable partial directory before promotion or acknowledgement', async () => {
    const harness = createHarness();
    harness.fileSystem.directoryOverrides.set(PARTIAL_PATH, ['safe-extra-directory']);

    expect(await receive(harness)).toEqual({ outcome: 'blocked' });
    expect(harness.acl.calls).not.toContain(`promote:${PARTIAL_PATH}:${FINAL_PATH}`);
    expect(harness.store.putInputs).toHaveLength(0);
  });
});

describe('receiver source boundaries', () => {
  it('keeps direct process behavior inside narrow Windows adapters and keeps relay scripts free of cloud imports', () => {
    const receiverPath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-relay-receiver.ts', import.meta.url),
    );
    const scriptPath = fileURLToPath(
      new URL('../scripts/receive-centurion-thread-corpus-relay.ts', import.meta.url),
    );
    const receiver = parseTypeScript(receiverPath);
    const script = parseTypeScript(scriptPath);
    const processCalls = collectNodes(
      receiver,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'spawnSync',
    ) as ts.CallExpression[];

    expect(
      sourceImports(receiver).filter((moduleName) => moduleName.startsWith('@aws-sdk/')),
    ).toEqual([]);
    expect(
      sourceImports(script).filter((moduleName) => moduleName.startsWith('@aws-sdk/')),
    ).toEqual([]);
    expect(processCalls).not.toHaveLength(0);
    expect(
      processCalls.every((call) =>
        ['WindowsPrivateAclProcessAdapter', 'WindowsGitIgnoreProcessAdapter'].includes(
          containingClassName(call) ?? '',
        ),
      ),
    ).toBe(true);
    expect(script.text).not.toContain('process.stderr');
    expect(script.text).not.toContain('console.');
  });

  it('orders remote validation, partial recovery, and acknowledgement without cleanup escape hatches', () => {
    const receiverPath = fileURLToPath(
      new URL('../src/ops/centurion-thread-corpus-relay-receiver.ts', import.meta.url),
    );
    const receiver = parseTypeScript(receiverPath);
    const partialLeaseCalls = collectNodes(
      receiver,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'acquirePartialLease',
    );
    const partialDirectoryCalls = collectNodes(
      receiver,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'acquirePartialDirectory',
    );
    const acknowledgementCalls = collectNodes(
      receiver,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'acknowledge',
    );

    expect(partialLeaseCalls).toHaveLength(1);
    expect(partialDirectoryCalls).toHaveLength(1);
    expect(acknowledgementCalls).toHaveLength(2);
    expect(receiver.text).not.toContain('removePartial');
    expect(
      receiver.text.indexOf('const lease = await input.fileSystem.acquirePartialLease'),
    ).toBeGreaterThan(receiver.text.indexOf('const remoteInventory = await input.store.listAll'));
    expect(receiver.text.indexOf('const result = await receiveWithPartialLease')).toBeGreaterThan(
      receiver.text.indexOf('const lease = await input.fileSystem.acquirePartialLease'),
    );
    expect(receiver.text.indexOf('!(await input.acl.promoteNoReplace')).toBeGreaterThan(
      receiver.text.indexOf(
        'const acquiredPartial = await input.fileSystem.acquirePartialDirectory',
      ),
    );
    expect(
      acknowledgementCalls.every(
        (call) =>
          call.getStart(receiver) >
          receiver.text.indexOf('const final = await verifyFinalSnapshot'),
      ),
    ).toBe(true);
  });
});
