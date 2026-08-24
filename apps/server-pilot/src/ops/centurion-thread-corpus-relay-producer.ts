import {
  DeleteObjectsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  buildCenturionRelayManifest,
  relayManifestKey,
  relayObjectKey,
  type CenturionRelayMember,
} from './centurion-thread-corpus-relay.js';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type RelayObjectMetadata = {
  key: string;
  bytes: number;
  sha256: string;
  serverSideEncryption: 'aws:kms';
  sseKmsKeyId: string;
};

export type RelayBucketConfig = {
  region: string;
  bucket: string;
  expectedBucketOwner: string;
  literalRelayRoot: string;
  kmsKeyArn: string;
  lifecycleRuleId: string;
  lifecycleExpirationDays: 1;
  maxSnapshotBytes: number;
};

export type RelayPutInput = {
  key: string;
  content: Uint8Array;
  bytes: number;
  sha256: string;
  expectedBucketOwner: string;
  kmsKeyArn: string;
};

export type RelayObjectStore = {
  assertRelayBucket(config: RelayBucketConfig): Promise<boolean>;
  putIfAbsent(input: RelayPutInput): Promise<'created' | 'already_exists' | 'conflict'>;
  head(key: string): Promise<RelayObjectMetadata | null>;
  listAll(prefix: string): Promise<readonly RelayObjectMetadata[] | null>;
  getBounded(key: string, maxBytes: number): Promise<Uint8Array | null>;
  deleteExact(keys: readonly string[]): Promise<boolean>;
};

export type StageIntentV1 = {
  schemaVersion: 'centurion-thread-corpus-relay-stage-intent-v1';
  transferId: string;
  literalRelayRoot: string;
  sourceSnapshot: {
    directChildName: string;
    canonicalPath: string;
    stableIdentity: string;
  };
  snapshotId: string;
  sourceManifestSha256: string;
  memberSetSha256: string;
  members: Array<{ path: string; sha256: string; bytes: number }>;
  createdKeys: string[];
  state: 'staging' | 'staged';
};

export type FinalizeJournalV1 = {
  schemaVersion: 'centurion-thread-corpus-relay-finalize-journal-v1';
  stageIntent: StageIntentV1;
  receiveReceiptSha256: string;
  acknowledgementSha256: string;
  state:
    | 'ack_verified'
    | 'relay_delete_started'
    | 'relay_empty'
    | 'source_delete_started'
    | 'complete';
};

export type RelayJournalRead<T> =
  | { outcome: 'absent' }
  | { outcome: 'present'; value: T }
  | { outcome: 'blocked' };

export type RelaySourceRuntimeConfig = {
  version: 'centurion-thread-corpus-relay-source-config-v1';
  expectedEc2: { instanceId: string; revision: string; worktree: string };
  relay: RelayBucketConfig;
  sourceSnapshot: { directChildName: string };
};

export type RelaySourceRuntimePort = {
  platform(): string;
  attestImdsV2(instanceId: string): Promise<boolean>;
  readProtectedConfig(): Promise<string>;
  inspectGit(check: 'revision' | 'worktree' | 'status'): string | null;
  inspectTrustedSnapshot(input: { name: string; maxTotalBytes: number }): Promise<{
    canonicalPath: string;
    stableIdentity: string;
    totalBytes: number;
    members: readonly { path: string; bytes: number; stableIdentity: string }[];
  } | null>;
  readBoundedTrustedSnapshot(input: {
    canonicalPath: string;
    stableIdentity: string;
    members: readonly { path: string; bytes: number; stableIdentity: string }[];
    maxTotalBytes: number;
  }): Promise<readonly CenturionRelayMember[] | null>;
  writeStageIntent(intent: StageIntentV1): Promise<boolean>;
  readStageIntent(transferId: string): Promise<RelayJournalRead<StageIntentV1>>;
  writeFinalizeJournal(journal: FinalizeJournalV1): Promise<boolean>;
  readFinalizeJournal(transferId: string): Promise<RelayJournalRead<FinalizeJournalV1>>;
  removeTrustedSnapshot(snapshot: StageIntentV1['sourceSnapshot']): Promise<boolean>;
};

export type StageRelayResult =
  | {
      outcome: 'staged';
      transferId: string;
      sourceManifestSha256: string;
      memberSetSha256: string;
    }
  | { outcome: 'blocked' };

export type RelayS3Client = {
  send(command: unknown): Promise<unknown>;
};

const STAGE_INTENT_VERSION = 'centurion-thread-corpus-relay-stage-intent-v1';
const SOURCE_CONFIG_VERSION = 'centurion-thread-corpus-relay-source-config-v1';
const RELAY_MANIFEST_FILENAME = 'relay-manifest.v1.json';
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const DIRECT_CHILD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LITERAL_ROOT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RAW_MIME_MEMBER = /^raw-mime\/[a-f0-9]{64}\.eml$/;
const ATTACHMENT_TEXT_MEMBER = /^attachment-text\/[a-f0-9]{64}\.txt$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IMDS_HOST = '169.254.169.254';
const IMDS_TIMEOUT_MS = 1_000;
const IMDS_MAX_RESPONSE_BYTES = 1_024;
export const EC2_GIT = '/usr/bin/git';
const EC2_GIT_ENV = Object.freeze({
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_KEY_2: 'core.excludesFile',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_VALUE_1: '/dev/null',
  GIT_CONFIG_VALUE_2: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
});

export type TrustedExecutableInspection = {
  path: string;
  stableIdentity: string;
  regularFile: true;
  symbolicLink: false;
  owner: 'root' | 'trusted-system';
  writableByOthers: false;
};

export type TrustedExecutableInspector = {
  inspect(executable: string): Promise<TrustedExecutableInspection | null>;
};

type Ec2GitInspectionArgs =
  | readonly ['rev-parse', 'HEAD']
  | readonly ['rev-parse', '--show-toplevel']
  | readonly ['status', '--porcelain=v1', '--untracked-files=all'];

export type Ec2GitProcessInvocation = {
  executable: typeof EC2_GIT;
  args: Ec2GitInspectionArgs;
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
};

export type Ec2GitProcessRunner = {
  run(invocation: Ec2GitProcessInvocation): {
    failed: boolean;
    status: number | null;
    stdout: string | null;
  };
};

type TrustedIdentity = {
  dev: number;
  ino: number;
};

type TrustedSnapshotInventory = {
  canonicalPath: string;
  stableIdentity: string;
  totalBytes: number;
  members: Array<{ path: string; bytes: number; stableIdentity: string }>;
};

type TrustedPathLayout = {
  repoRoot: string;
  privateRoot: string;
  corpusRoot: string;
  snapshotsRoot: string;
  stateRoot: string;
  configPath: string;
};

type NormalizedStage = {
  intent: StageIntentV1;
  expectedKeys: string[];
};

function blockedStage(): StageRelayResult {
  return { outcome: 'blocked' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_IDENTIFIER.test(value);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function memberSetSha256(
  members: readonly { path: string; bytes: number; sha256: string }[],
): string {
  return createHash('sha256')
    .update(
      members.map((member) => `${member.path}\t${member.bytes}\t${member.sha256}\n`).join(''),
      'utf8',
    )
    .digest('hex');
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    !value.split('/').includes('..')
  );
}

function isDirectChildName(value: unknown): value is string {
  return (
    typeof value === 'string' && DIRECT_CHILD_NAME.test(value) && value !== '.' && value !== '..'
  );
}

function isLiteralRelayRoot(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    return false;
  }
  return value.split('/').every((segment) => LITERAL_ROOT_SEGMENT.test(segment));
}

function isKmsKeyArn(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(value)
  );
}

function isBucketName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z0-9](?:[a-z0-9.-]{1,61})?[a-z0-9]$/.test(value) &&
    !value.includes('..')
  );
}

function validateRelayBucketConfig(value: unknown): RelayBucketConfig | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'region',
      'bucket',
      'expectedBucketOwner',
      'literalRelayRoot',
      'kmsKeyArn',
      'lifecycleRuleId',
      'lifecycleExpirationDays',
      'maxSnapshotBytes',
    ]) ||
    typeof value.region !== 'string' ||
    !/^[a-z0-9-]{3,32}$/.test(value.region) ||
    !isBucketName(value.bucket) ||
    typeof value.expectedBucketOwner !== 'string' ||
    !/^\d{12}$/.test(value.expectedBucketOwner) ||
    !isLiteralRelayRoot(value.literalRelayRoot) ||
    !isKmsKeyArn(value.kmsKeyArn) ||
    typeof value.lifecycleRuleId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value.lifecycleRuleId) ||
    value.lifecycleExpirationDays !== 1 ||
    !isSafeInteger(value.maxSnapshotBytes, 1)
  ) {
    return null;
  }
  return {
    region: value.region,
    bucket: value.bucket,
    expectedBucketOwner: value.expectedBucketOwner,
    literalRelayRoot: value.literalRelayRoot,
    kmsKeyArn: value.kmsKeyArn,
    lifecycleRuleId: value.lifecycleRuleId,
    lifecycleExpirationDays: 1,
    maxSnapshotBytes: value.maxSnapshotBytes,
  };
}

export function parseRelaySourceRuntimeConfig(value: string): RelaySourceRuntimeConfig | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, ['version', 'expectedEc2', 'relay', 'sourceSnapshot']) ||
      parsed.version !== SOURCE_CONFIG_VERSION ||
      !isRecord(parsed.expectedEc2) ||
      !hasExactKeys(parsed.expectedEc2, ['instanceId', 'revision', 'worktree']) ||
      !isOpaqueIdentifier(parsed.expectedEc2.instanceId) ||
      typeof parsed.expectedEc2.revision !== 'string' ||
      !/^[a-f0-9]{7,64}$/i.test(parsed.expectedEc2.revision) ||
      !isCanonicalAbsolutePath(parsed.expectedEc2.worktree) ||
      !isRecord(parsed.sourceSnapshot) ||
      !hasExactKeys(parsed.sourceSnapshot, ['directChildName']) ||
      !isDirectChildName(parsed.sourceSnapshot.directChildName)
    ) {
      return null;
    }
    const relay = validateRelayBucketConfig(parsed.relay);
    if (!relay) return null;
    return {
      version: SOURCE_CONFIG_VERSION,
      expectedEc2: {
        instanceId: parsed.expectedEc2.instanceId,
        revision: parsed.expectedEc2.revision,
        worktree: parsed.expectedEc2.worktree,
      },
      relay,
      sourceSnapshot: { directChildName: parsed.sourceSnapshot.directChildName },
    };
  } catch {
    return null;
  }
}

function relayPrefix(literalRelayRoot: string, transferId: string): string {
  const manifestKey = relayManifestKey(literalRelayRoot, transferId);
  return manifestKey.slice(0, -RELAY_MANIFEST_FILENAME.length);
}

function expectedObjectKeys(
  literalRelayRoot: string,
  transferId: string,
  members: readonly { path: string }[],
): string[] {
  return [
    ...members.map((member) => relayObjectKey(literalRelayRoot, transferId, member.path)),
    relayManifestKey(literalRelayRoot, transferId),
  ];
}

function sameMetadata(
  metadata: RelayObjectMetadata | null,
  expected: {
    key: string;
    bytes: number;
    sha256: string;
    kmsKeyArn: string;
  },
): boolean {
  return (
    metadata !== null &&
    metadata.key === expected.key &&
    metadata.bytes === expected.bytes &&
    metadata.sha256 === expected.sha256 &&
    metadata.serverSideEncryption === 'aws:kms' &&
    metadata.sseKmsKeyId === expected.kmsKeyArn
  );
}

function exactMetadataInventory(
  actual: readonly RelayObjectMetadata[] | null,
  expected: readonly {
    key: string;
    bytes: number;
    sha256: string;
    kmsKeyArn: string;
  }[],
): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  const byKey = new Map(actual.map((metadata) => [metadata.key, metadata]));
  if (byKey.size !== actual.length) return false;
  return expected.every((candidate) => sameMetadata(byKey.get(candidate.key) ?? null, candidate));
}

function validateStageIntent(
  value: unknown,
  config: RelaySourceRuntimeConfig,
  transferId: string,
): NormalizedStage | null {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'transferId',
        'literalRelayRoot',
        'sourceSnapshot',
        'snapshotId',
        'sourceManifestSha256',
        'memberSetSha256',
        'members',
        'createdKeys',
        'state',
      ]) ||
      value.schemaVersion !== STAGE_INTENT_VERSION ||
      value.transferId !== transferId ||
      !isUuidV4(value.transferId) ||
      value.literalRelayRoot !== config.relay.literalRelayRoot ||
      !isOpaqueIdentifier(value.snapshotId) ||
      !isSha256(value.sourceManifestSha256) ||
      !isSha256(value.memberSetSha256) ||
      !Array.isArray(value.members) ||
      !Array.isArray(value.createdKeys) ||
      (value.state !== 'staging' && value.state !== 'staged') ||
      !isRecord(value.sourceSnapshot) ||
      !hasExactKeys(value.sourceSnapshot, ['directChildName', 'canonicalPath', 'stableIdentity']) ||
      value.sourceSnapshot.directChildName !== config.sourceSnapshot.directChildName ||
      !isCanonicalAbsolutePath(value.sourceSnapshot.canonicalPath) ||
      !isOpaqueIdentifier(value.sourceSnapshot.stableIdentity)
    ) {
      return null;
    }

    const members: Array<{ path: string; bytes: number; sha256: string }> = [];
    let previousPath: string | undefined;
    for (const candidate of value.members) {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, ['path', 'sha256', 'bytes']) ||
        typeof candidate.path !== 'string' ||
        !isSafeInteger(candidate.bytes, 1) ||
        !isSha256(candidate.sha256) ||
        (previousPath !== undefined && compareText(previousPath, candidate.path) >= 0)
      ) {
        return null;
      }
      relayObjectKey(config.relay.literalRelayRoot, transferId, candidate.path);
      previousPath = candidate.path;
      members.push({
        path: candidate.path,
        bytes: candidate.bytes,
        sha256: candidate.sha256,
      });
    }

    const manifest = members.find((member) => member.path === 'manifest.json');
    if (
      !manifest ||
      manifest.sha256 !== value.sourceManifestSha256 ||
      memberSetSha256(members) !== value.memberSetSha256
    ) {
      return null;
    }
    const expectedKeys = expectedObjectKeys(config.relay.literalRelayRoot, transferId, members);
    if (
      value.createdKeys.some((key) => typeof key !== 'string') ||
      value.createdKeys.length > expectedKeys.length ||
      value.createdKeys.some((key, index) => key !== expectedKeys[index]) ||
      (value.state === 'staged' && value.createdKeys.length !== expectedKeys.length)
    ) {
      return null;
    }
    return {
      intent: {
        schemaVersion: STAGE_INTENT_VERSION,
        transferId,
        literalRelayRoot: config.relay.literalRelayRoot,
        sourceSnapshot: {
          directChildName: config.sourceSnapshot.directChildName,
          canonicalPath: value.sourceSnapshot.canonicalPath,
          stableIdentity: value.sourceSnapshot.stableIdentity,
        },
        snapshotId: value.snapshotId,
        sourceManifestSha256: value.sourceManifestSha256,
        memberSetSha256: value.memberSetSha256,
        members,
        createdKeys: [...value.createdKeys],
        state: value.state,
      },
      expectedKeys,
    };
  } catch {
    return null;
  }
}

export function validateRelayStageIntent(
  value: unknown,
  config: RelaySourceRuntimeConfig,
  transferId: string,
): StageIntentV1 | null {
  return validateStageIntent(value, config, transferId)?.intent ?? null;
}

function sameIntentSource(intent: StageIntentV1, inventory: TrustedSnapshotInventory): boolean {
  return (
    intent.sourceSnapshot.canonicalPath === inventory.canonicalPath &&
    intent.sourceSnapshot.stableIdentity === inventory.stableIdentity
  );
}

function exactGitState(source: RelaySourceRuntimePort, config: RelaySourceRuntimeConfig): boolean {
  return (
    source.inspectGit('revision') === `${config.expectedEc2.revision}\n` &&
    source.inspectGit('worktree') === `${config.expectedEc2.worktree}\n` &&
    source.inspectGit('status') === ''
  );
}

function validateInventory(value: unknown, maxTotalBytes: number): TrustedSnapshotInventory | null {
  if (
    !isRecord(value) ||
    !isCanonicalAbsolutePath(value.canonicalPath) ||
    !isOpaqueIdentifier(value.stableIdentity) ||
    !isSafeInteger(value.totalBytes, 0) ||
    value.totalBytes > maxTotalBytes ||
    !Array.isArray(value.members)
  ) {
    return null;
  }
  const members: Array<{ path: string; bytes: number; stableIdentity: string }> = [];
  let total = 0;
  let previousPath: string | undefined;
  for (const candidate of value.members) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['path', 'bytes', 'stableIdentity']) ||
      typeof candidate.path !== 'string' ||
      !isSafeInteger(candidate.bytes, 1) ||
      !isOpaqueIdentifier(candidate.stableIdentity) ||
      (previousPath !== undefined && compareText(previousPath, candidate.path) >= 0) ||
      candidate.bytes > maxTotalBytes - total
    ) {
      return null;
    }
    try {
      relayObjectKey('safe-root', '3479ca40-b5a1-4bb3-aef1-02fcbefc949c', candidate.path);
    } catch {
      return null;
    }
    previousPath = candidate.path;
    total += candidate.bytes;
    members.push({
      path: candidate.path,
      bytes: candidate.bytes,
      stableIdentity: candidate.stableIdentity,
    });
  }
  if (total !== value.totalBytes) return null;
  return {
    canonicalPath: value.canonicalPath,
    stableIdentity: value.stableIdentity,
    totalBytes: total,
    members,
  };
}

function sameMemberRows(
  actual: readonly CenturionRelayMember[],
  expected: readonly { path: string; bytes: number }[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every(
    (member, index) =>
      member.path === expected[index]?.path &&
      member.bytes === expected[index]?.bytes &&
      member.content.byteLength === member.bytes,
  );
}

async function rollbackKnownStage(
  store: RelayObjectStore,
  intent: StageIntentV1 | undefined,
): Promise<void> {
  if (!intent) return;
  try {
    await store.deleteExact(intent.createdKeys);
    const remaining = await store.listAll(relayPrefix(intent.literalRelayRoot, intent.transferId));
    if (remaining === null || remaining.length !== 0) return;
  } catch {
    return;
  }
}

export async function stageCenturionThreadCorpusRelay(input: {
  config: RelaySourceRuntimeConfig;
  transferId: string;
  store: RelayObjectStore;
  source: RelaySourceRuntimePort;
}): Promise<StageRelayResult> {
  let currentIntent: StageIntentV1 | undefined;
  try {
    const config = parseRelaySourceRuntimeConfig(JSON.stringify(input.config));
    if (!config || !isUuidV4(input.transferId)) return blockedStage();
    if (input.source.platform() !== 'linux') return blockedStage();
    if (!(await input.source.attestImdsV2(config.expectedEc2.instanceId))) return blockedStage();
    if (!exactGitState(input.source, config)) return blockedStage();
    if (!(await input.store.assertRelayBucket(config.relay))) return blockedStage();

    const inspected = validateInventory(
      await input.source.inspectTrustedSnapshot({
        name: config.sourceSnapshot.directChildName,
        maxTotalBytes: config.relay.maxSnapshotBytes,
      }),
      config.relay.maxSnapshotBytes,
    );
    if (!inspected) return blockedStage();

    const previousRead = await input.source.readStageIntent(input.transferId);
    if (previousRead.outcome === 'blocked') return blockedStage();
    const previous = previousRead.outcome === 'present' ? previousRead.value : null;
    const normalizedPrevious = previous
      ? validateStageIntent(previous, config, input.transferId)
      : null;
    if (previous && !normalizedPrevious) return blockedStage();
    if (normalizedPrevious && !sameIntentSource(normalizedPrevious.intent, inspected)) {
      return blockedStage();
    }

    const members = await input.source.readBoundedTrustedSnapshot({
      canonicalPath: inspected.canonicalPath,
      stableIdentity: inspected.stableIdentity,
      members: inspected.members,
      maxTotalBytes: config.relay.maxSnapshotBytes,
    });
    if (!members || !sameMemberRows(members, inspected.members)) return blockedStage();
    const built = buildCenturionRelayManifest(
      input.transferId,
      members,
      config.relay.maxSnapshotBytes,
    );
    const memberRows = built.manifest.members.map(
      ({ path: memberPath, bytes, sha256: digest }) => ({
        path: memberPath,
        bytes,
        sha256: digest,
      }),
    );
    const expectedKeys = expectedObjectKeys(
      config.relay.literalRelayRoot,
      input.transferId,
      memberRows,
    );
    const sourceSnapshot = {
      directChildName: config.sourceSnapshot.directChildName,
      canonicalPath: inspected.canonicalPath,
      stableIdentity: inspected.stableIdentity,
    };

    if (normalizedPrevious) {
      currentIntent = normalizedPrevious.intent;
      if (
        currentIntent.snapshotId !== built.manifest.snapshotId ||
        currentIntent.sourceManifestSha256 !== built.manifest.sourceManifestSha256 ||
        currentIntent.memberSetSha256 !== built.manifest.memberSetSha256 ||
        JSON.stringify(currentIntent.members) !== JSON.stringify(memberRows) ||
        JSON.stringify(currentIntent.sourceSnapshot) !== JSON.stringify(sourceSnapshot) ||
        JSON.stringify(normalizedPrevious.expectedKeys) !== JSON.stringify(expectedKeys)
      ) {
        return blockedStage();
      }
      if (currentIntent.state === 'staged') {
        const expectedMetadata = [
          ...members.map((member) => ({
            key: relayObjectKey(config.relay.literalRelayRoot, input.transferId, member.path),
            bytes: member.bytes,
            sha256: member.sha256,
            kmsKeyArn: config.relay.kmsKeyArn,
          })),
          {
            key: relayManifestKey(config.relay.literalRelayRoot, input.transferId),
            bytes: built.manifestBytes.byteLength,
            sha256: sha256(built.manifestBytes),
            kmsKeyArn: config.relay.kmsKeyArn,
          },
        ];
        if (
          !exactMetadataInventory(
            await input.store.listAll(relayPrefix(config.relay.literalRelayRoot, input.transferId)),
            expectedMetadata,
          )
        ) {
          return blockedStage();
        }
        return {
          outcome: 'staged',
          transferId: input.transferId,
          sourceManifestSha256: built.manifest.sourceManifestSha256,
          memberSetSha256: built.manifest.memberSetSha256,
        };
      }
    } else {
      currentIntent = {
        schemaVersion: STAGE_INTENT_VERSION,
        transferId: input.transferId,
        literalRelayRoot: config.relay.literalRelayRoot,
        sourceSnapshot,
        snapshotId: built.manifest.snapshotId,
        sourceManifestSha256: built.manifest.sourceManifestSha256,
        memberSetSha256: built.manifest.memberSetSha256,
        members: memberRows,
        createdKeys: [],
        state: 'staging',
      };
      if (!(await input.source.writeStageIntent(currentIntent))) return blockedStage();
    }

    const stagedObjects = [
      ...members.map((member) => ({
        key: relayObjectKey(config.relay.literalRelayRoot, input.transferId, member.path),
        content: member.content,
        bytes: member.bytes,
        sha256: member.sha256,
      })),
      {
        key: relayManifestKey(config.relay.literalRelayRoot, input.transferId),
        content: built.manifestBytes,
        bytes: built.manifestBytes.byteLength,
        sha256: sha256(built.manifestBytes),
      },
    ];
    for (const object of stagedObjects) {
      await input.store.putIfAbsent({
        ...object,
        expectedBucketOwner: config.relay.expectedBucketOwner,
        kmsKeyArn: config.relay.kmsKeyArn,
      });
      if (
        !sameMetadata(await input.store.head(object.key), {
          ...object,
          kmsKeyArn: config.relay.kmsKeyArn,
        })
      ) {
        await rollbackKnownStage(input.store, currentIntent);
        return blockedStage();
      }
      if (!currentIntent.createdKeys.includes(object.key)) {
        currentIntent = {
          ...currentIntent,
          createdKeys: [...currentIntent.createdKeys, object.key],
        };
        if (!(await input.source.writeStageIntent(currentIntent))) return blockedStage();
      }
    }

    if (
      !exactMetadataInventory(
        await input.store.listAll(relayPrefix(config.relay.literalRelayRoot, input.transferId)),
        stagedObjects.map((object) => ({ ...object, kmsKeyArn: config.relay.kmsKeyArn })),
      )
    ) {
      await rollbackKnownStage(input.store, currentIntent);
      return blockedStage();
    }
    currentIntent = { ...currentIntent, state: 'staged' };
    if (!(await input.source.writeStageIntent(currentIntent))) return blockedStage();
    return {
      outcome: 'staged',
      transferId: input.transferId,
      sourceManifestSha256: built.manifest.sourceManifestSha256,
      memberSetSha256: built.manifest.memberSetSha256,
    };
  } catch {
    await rollbackKnownStage(input.store, currentIntent);
    return blockedStage();
  }
}

function awsErrorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : '';
}

function awsErrorStatus(error: unknown): number | null {
  const status =
    error &&
    typeof error === 'object' &&
    '$metadata' in error &&
    (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : null;
}

function notFound(error: unknown): boolean {
  const name = awsErrorName(error);
  return name === 'NotFound' || name === 'NoSuchKey' || awsErrorStatus(error) === 404;
}

function preconditionFailed(error: unknown): boolean {
  return awsErrorName(error) === 'PreconditionFailed' || awsErrorStatus(error) === 412;
}

function decodedChecksumSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.byteLength !== 32) return null;
    return bytes.toString('hex');
  } catch {
    return null;
  }
}

async function readBoundedS3Body(body: unknown, maxBytes: number): Promise<Uint8Array | null> {
  if (!isSafeInteger(maxBytes, 0)) return null;
  if (body instanceof Uint8Array) return body.byteLength <= maxBytes ? new Uint8Array(body) : null;
  if (
    !body ||
    typeof body !== 'object' ||
    !(Symbol.asyncIterator in body) ||
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function'
  ) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of body as AsyncIterable<unknown>) {
      const bytes =
        chunk instanceof Uint8Array ? chunk : Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : null;
      if (!bytes || bytes.byteLength > maxBytes - total) return null;
      total += bytes.byteLength;
      chunks.push(bytes);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch {
    return null;
  }
}

class AwsRelayObjectStore implements RelayObjectStore {
  constructor(
    private readonly config: RelayBucketConfig,
    private readonly client: RelayS3Client,
  ) {}

  async assertRelayBucket(config: RelayBucketConfig): Promise<boolean> {
    if (JSON.stringify(config) !== JSON.stringify(this.config)) return false;
    const input = {
      Bucket: config.bucket,
      ExpectedBucketOwner: config.expectedBucketOwner,
    };
    try {
      await this.client.send(new HeadBucketCommand(input));
      const ownership = (await this.client.send(new GetBucketOwnershipControlsCommand(input))) as {
        OwnershipControls?: { Rules?: Array<{ ObjectOwnership?: unknown }> };
      };
      const publicAccess = (await this.client.send(new GetPublicAccessBlockCommand(input))) as {
        PublicAccessBlockConfiguration?: Record<string, unknown>;
      };
      const versioning = (await this.client.send(new GetBucketVersioningCommand(input))) as {
        Status?: unknown;
      };
      const encryption = (await this.client.send(new GetBucketEncryptionCommand(input))) as {
        ServerSideEncryptionConfiguration?: {
          Rules?: Array<{
            ApplyServerSideEncryptionByDefault?: {
              SSEAlgorithm?: unknown;
              KMSMasterKeyID?: unknown;
            };
          }>;
        };
      };
      const lifecycle = (await this.client.send(
        new GetBucketLifecycleConfigurationCommand(input),
      )) as {
        Rules?: Array<{
          ID?: unknown;
          Status?: unknown;
          Filter?: { Prefix?: unknown };
          Expiration?: { Days?: unknown };
        }>;
      };
      const ownershipRules = ownership.OwnershipControls?.Rules;
      const publicBlock = publicAccess.PublicAccessBlockConfiguration;
      const encryptionRules = encryption.ServerSideEncryptionConfiguration?.Rules;
      const lifecycleRules = lifecycle.Rules;
      return (
        ownershipRules?.length === 1 &&
        ownershipRules[0]?.ObjectOwnership === 'BucketOwnerEnforced' &&
        publicBlock?.BlockPublicAcls === true &&
        publicBlock.IgnorePublicAcls === true &&
        publicBlock.BlockPublicPolicy === true &&
        publicBlock.RestrictPublicBuckets === true &&
        versioning.Status === undefined &&
        encryptionRules?.length === 1 &&
        encryptionRules[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === 'aws:kms' &&
        encryptionRules[0]?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID ===
          config.kmsKeyArn &&
        lifecycleRules?.length === 1 &&
        lifecycleRules[0]?.ID === config.lifecycleRuleId &&
        lifecycleRules[0]?.Status === 'Enabled' &&
        lifecycleRules[0]?.Filter?.Prefix === `${config.literalRelayRoot}/` &&
        lifecycleRules[0]?.Expiration?.Days === config.lifecycleExpirationDays
      );
    } catch {
      return false;
    }
  }

  async putIfAbsent(input: RelayPutInput): Promise<'created' | 'already_exists' | 'conflict'> {
    if (
      input.content.byteLength !== input.bytes ||
      !isSafeInteger(input.bytes, 1) ||
      !isSha256(input.sha256) ||
      sha256(input.content) !== input.sha256 ||
      input.expectedBucketOwner !== this.config.expectedBucketOwner ||
      input.kmsKeyArn !== this.config.kmsKeyArn
    ) {
      return 'conflict';
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.key,
          Body: input.content,
          ContentLength: input.bytes,
          ExpectedBucketOwner: input.expectedBucketOwner,
          ChecksumAlgorithm: 'SHA256',
          ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: input.kmsKeyArn,
          IfNoneMatch: '*',
        }),
      );
      return 'created';
    } catch (error) {
      return preconditionFailed(error) ? 'already_exists' : 'conflict';
    }
  }

  async head(key: string): Promise<RelayObjectMetadata | null> {
    try {
      const response = (await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ExpectedBucketOwner: this.config.expectedBucketOwner,
          ChecksumMode: 'ENABLED',
        }),
      )) as {
        ContentLength?: unknown;
        ChecksumSHA256?: unknown;
        ServerSideEncryption?: unknown;
        SSEKMSKeyId?: unknown;
      };
      const checksum = decodedChecksumSha256(response.ChecksumSHA256);
      if (
        !isSafeInteger(response.ContentLength, 0) ||
        !checksum ||
        response.ServerSideEncryption !== 'aws:kms' ||
        typeof response.SSEKMSKeyId !== 'string'
      ) {
        return null;
      }
      return {
        key,
        bytes: response.ContentLength,
        sha256: checksum,
        serverSideEncryption: 'aws:kms',
        sseKmsKeyId: response.SSEKMSKeyId,
      };
    } catch (error) {
      if (notFound(error)) return null;
      return null;
    }
  }

  async listAll(prefix: string): Promise<readonly RelayObjectMetadata[] | null> {
    const keys: string[] = [];
    const seenTokens = new Set<string>();
    let continuationToken: string | undefined;
    try {
      do {
        const response = (await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
            ExpectedBucketOwner: this.config.expectedBucketOwner,
          }),
        )) as {
          IsTruncated?: unknown;
          NextContinuationToken?: unknown;
          Contents?: Array<{ Key?: unknown; Size?: unknown }>;
        };
        if (response.Contents !== undefined && !Array.isArray(response.Contents)) return null;
        for (const object of response.Contents ?? []) {
          if (typeof object.Key !== 'string' || !isSafeInteger(object.Size, 0)) return null;
          keys.push(object.Key);
        }
        if (response.IsTruncated !== true) {
          continuationToken = undefined;
          continue;
        }
        if (
          typeof response.NextContinuationToken !== 'string' ||
          response.NextContinuationToken.length === 0 ||
          seenTokens.has(response.NextContinuationToken)
        ) {
          return null;
        }
        seenTokens.add(response.NextContinuationToken);
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
      if (new Set(keys).size !== keys.length) return null;
      const metadata: RelayObjectMetadata[] = [];
      for (const key of keys.sort(compareText)) {
        const object = await this.head(key);
        if (!object) return null;
        metadata.push(object);
      }
      return metadata;
    } catch {
      return null;
    }
  }

  async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> {
    if (!isSafeInteger(maxBytes, 0)) return null;
    try {
      const response = (await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ExpectedBucketOwner: this.config.expectedBucketOwner,
          ChecksumMode: 'ENABLED',
        }),
      )) as {
        ContentLength?: unknown;
        Body?: unknown;
      };
      if (
        (response.ContentLength !== undefined && !isSafeInteger(response.ContentLength, 0)) ||
        (typeof response.ContentLength === 'number' && response.ContentLength > maxBytes)
      ) {
        return null;
      }
      return await readBoundedS3Body(response.Body, maxBytes);
    } catch {
      return null;
    }
  }

  async deleteExact(keys: readonly string[]): Promise<boolean> {
    if (keys.length === 0) return true;
    if (
      keys.some((key) => typeof key !== 'string' || key.length === 0) ||
      new Set(keys).size !== keys.length
    ) {
      return false;
    }
    try {
      for (let start = 0; start < keys.length; start += 1_000) {
        const chunk = keys.slice(start, start + 1_000);
        const response = (await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.config.bucket,
            ExpectedBucketOwner: this.config.expectedBucketOwner,
            Delete: {
              Objects: chunk.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        )) as { Errors?: unknown[] };
        if (Array.isArray(response.Errors) && response.Errors.length > 0) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}

export function createAwsRelayObjectStore(
  config: RelayBucketConfig,
  client: RelayS3Client = new S3Client({ region: config.region }),
): RelayObjectStore {
  return new AwsRelayObjectStore(config, client);
}

function sameIdentity(left: TrustedIdentity, right: TrustedIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableIdentity(value: TrustedIdentity): string {
  return `${String(value.dev)}:${String(value.ino)}`;
}

function currentEffectiveUid(): number {
  const uid = process.geteuid?.();
  if (typeof uid !== 'number') throw new Error('unsupported runtime');
  return uid;
}

function trustedDirectory(directory: string): TrustedIdentity {
  const stats = lstatSync(directory);
  const uid = currentEffectiveUid();
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.uid !== uid && stats.uid !== 0) ||
    (stats.mode & 0o022) !== 0 ||
    realpathSync(directory) !== directory
  ) {
    throw new Error('untrusted directory');
  }
  return { dev: stats.dev, ino: stats.ino };
}

function trustedLeaf(filePath: string): TrustedIdentity & { bytes: number } {
  const stats = lstatSync(filePath);
  const uid = currentEffectiveUid();
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.uid !== uid && stats.uid !== 0) ||
    (stats.mode & 0o077) !== 0 ||
    !isSafeInteger(stats.size, 1)
  ) {
    throw new Error('untrusted source leaf');
  }
  return { dev: stats.dev, ino: stats.ino, bytes: stats.size };
}

function trustedConfigLeaf(filePath: string): TrustedIdentity {
  const stats = lstatSync(filePath);
  const uid = currentEffectiveUid();
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (stats.uid !== uid && stats.uid !== 0) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error('untrusted config leaf');
  }
  return { dev: stats.dev, ino: stats.ino };
}

function sourceMemberPath(value: string): boolean {
  return (
    value === 'corpus.jsonl' ||
    value === 'manifest.json' ||
    RAW_MIME_MEMBER.test(value) ||
    ATTACHMENT_TEXT_MEMBER.test(value)
  );
}

function sourcePathLayout(repoRoot: string): TrustedPathLayout {
  if (!isCanonicalAbsolutePath(repoRoot)) throw new Error('unsafe repo root');
  const privateRoot = path.posix.join(repoRoot, '.private');
  const corpusRoot = path.posix.join(privateRoot, 'centurion-thread-corpus');
  return {
    repoRoot,
    privateRoot,
    corpusRoot,
    snapshotsRoot: path.posix.join(corpusRoot, 'snapshots'),
    stateRoot: path.posix.join(corpusRoot, 'relay-state'),
    configPath: path.posix.join(corpusRoot, 'relay-source-config.json'),
  };
}

function defaultRepoRoot(): string {
  return path.posix.resolve(path.posix.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function trustedParents(
  layout: TrustedPathLayout,
): Array<{ path: string; identity: TrustedIdentity }> {
  return [layout.repoRoot, layout.privateRoot, layout.corpusRoot, layout.snapshotsRoot].map(
    (parent) => ({
      path: parent,
      identity: trustedDirectory(parent),
    }),
  );
}

function revalidateParents(parents: readonly { path: string; identity: TrustedIdentity }[]): void {
  for (const parent of parents) {
    if (!sameIdentity(parent.identity, trustedDirectory(parent.path))) {
      throw new Error('parent identity changed');
    }
  }
}

function readTrustedConfig(layout: TrustedPathLayout): string {
  const parents = [layout.repoRoot, layout.privateRoot, layout.corpusRoot].map((parent) => ({
    path: parent,
    identity: trustedDirectory(parent),
  }));
  const preOpen = trustedConfigLeaf(layout.configPath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(layout.configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(preOpen, opened)) {
      throw new Error('config identity changed');
    }
    const content = readFileSync(descriptor, 'utf8');
    if (!sameIdentity(preOpen, trustedConfigLeaf(layout.configPath))) {
      throw new Error('config leaf replaced');
    }
    revalidateParents(parents);
    return content;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function listTrustedSnapshot(
  snapshotPath: string,
  maxTotalBytes: number,
): TrustedSnapshotInventory {
  if (!isSafeInteger(maxTotalBytes, 1)) throw new Error('invalid bound');
  const snapshotIdentity = trustedDirectory(snapshotPath);
  const rootEntries = readdirSync(snapshotPath, { withFileTypes: true });
  const expectedRootNames = new Set([
    'corpus.jsonl',
    'manifest.json',
    'raw-mime',
    'attachment-text',
  ]);
  if (rootEntries.some((entry) => !expectedRootNames.has(entry.name))) {
    throw new Error('unexpected source member');
  }
  const leaves: Array<{ path: string; absolutePath: string }> = [];
  for (const filename of ['corpus.jsonl', 'manifest.json']) {
    const entry = rootEntries.find((candidate) => candidate.name === filename);
    if (!entry || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('missing source member');
    }
    leaves.push({ path: filename, absolutePath: path.posix.join(snapshotPath, filename) });
  }
  for (const directoryName of ['raw-mime', 'attachment-text']) {
    const entry = rootEntries.find((candidate) => candidate.name === directoryName);
    if (!entry) continue;
    const directoryPath = path.posix.join(snapshotPath, directoryName);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe member directory');
    trustedDirectory(directoryPath);
    for (const child of readdirSync(directoryPath, { withFileTypes: true })) {
      const relativePath = `${directoryName}/${child.name}`;
      if (!child.isFile() || child.isSymbolicLink() || !sourceMemberPath(relativePath)) {
        throw new Error('unsafe nested source member');
      }
      leaves.push({ path: relativePath, absolutePath: path.posix.join(directoryPath, child.name) });
    }
  }
  leaves.sort((left, right) => compareText(left.path, right.path));
  const members: TrustedSnapshotInventory['members'] = [];
  let totalBytes = 0;
  let previousPath: string | undefined;
  for (const leaf of leaves) {
    if (
      !sourceMemberPath(leaf.path) ||
      (previousPath !== undefined && compareText(previousPath, leaf.path) >= 0)
    ) {
      throw new Error('unsafe member ordering');
    }
    const identity = trustedLeaf(leaf.absolutePath);
    if (identity.bytes > maxTotalBytes - totalBytes) throw new Error('source exceeds bound');
    totalBytes += identity.bytes;
    previousPath = leaf.path;
    members.push({
      path: leaf.path,
      bytes: identity.bytes,
      stableIdentity: stableIdentity(identity),
    });
  }
  if (
    !members.some((member) => member.path === 'corpus.jsonl') ||
    !members.some((member) => member.path === 'manifest.json')
  ) {
    throw new Error('source members incomplete');
  }
  if (!sameIdentity(snapshotIdentity, trustedDirectory(snapshotPath))) {
    throw new Error('source snapshot replaced');
  }
  return {
    canonicalPath: snapshotPath,
    stableIdentity: stableIdentity(snapshotIdentity),
    totalBytes,
    members,
  };
}

function inspectTrustedSnapshot(
  layout: TrustedPathLayout,
  input: { name: string; maxTotalBytes: number },
): TrustedSnapshotInventory | null {
  try {
    if (!isDirectChildName(input.name) || !isSafeInteger(input.maxTotalBytes, 1)) return null;
    const parents = trustedParents(layout);
    const snapshotPath = path.posix.join(layout.snapshotsRoot, input.name);
    if (
      path.posix.dirname(snapshotPath) !== layout.snapshotsRoot ||
      realpathSync(snapshotPath) !== snapshotPath
    ) {
      return null;
    }
    const inventory = listTrustedSnapshot(snapshotPath, input.maxTotalBytes);
    revalidateParents(parents);
    return inventory;
  } catch {
    return null;
  }
}

function trustedRelativePath(root: string, relativePath: string): string | null {
  if (!sourceMemberPath(relativePath)) return null;
  const absolutePath = path.posix.join(root, relativePath);
  return path.posix.relative(root, absolutePath) === relativePath ? absolutePath : null;
}

function readBoundedTrustedSnapshot(
  layout: TrustedPathLayout,
  input: {
    canonicalPath: string;
    stableIdentity: string;
    members: readonly { path: string; bytes: number; stableIdentity: string }[];
    maxTotalBytes: number;
  },
): readonly CenturionRelayMember[] | null {
  try {
    if (
      !isCanonicalAbsolutePath(input.canonicalPath) ||
      path.posix.dirname(input.canonicalPath) !== layout.snapshotsRoot ||
      !isDirectChildName(path.posix.basename(input.canonicalPath)) ||
      !isOpaqueIdentifier(input.stableIdentity) ||
      !isSafeInteger(input.maxTotalBytes, 1)
    ) {
      return null;
    }
    const parents = trustedParents(layout);
    const snapshot = trustedDirectory(input.canonicalPath);
    if (stableIdentity(snapshot) !== input.stableIdentity) return null;
    const preflight = listTrustedSnapshot(input.canonicalPath, input.maxTotalBytes);
    if (
      preflight.totalBytes > input.maxTotalBytes ||
      JSON.stringify(preflight.members) !== JSON.stringify(input.members)
    ) {
      return null;
    }
    const members: CenturionRelayMember[] = [];
    let totalBytes = 0;
    for (const candidate of input.members) {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, ['path', 'bytes', 'stableIdentity']) ||
        typeof candidate.path !== 'string' ||
        !isSafeInteger(candidate.bytes, 1) ||
        !isOpaqueIdentifier(candidate.stableIdentity) ||
        candidate.bytes > input.maxTotalBytes - totalBytes
      ) {
        return null;
      }
      const filePath = trustedRelativePath(input.canonicalPath, candidate.path);
      if (!filePath) return null;
      const before = trustedLeaf(filePath);
      if (before.bytes !== candidate.bytes || stableIdentity(before) !== candidate.stableIdentity) {
        return null;
      }
      let descriptor: number | undefined;
      try {
        descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const opened = fstatSync(descriptor);
        if (
          !opened.isFile() ||
          !sameIdentity(before, opened) ||
          opened.size !== candidate.bytes ||
          (opened.mode & 0o077) !== 0
        ) {
          return null;
        }
        const content = new Uint8Array(readFileSync(descriptor));
        const after = trustedLeaf(filePath);
        const afterOpen = fstatSync(descriptor);
        if (
          content.byteLength !== candidate.bytes ||
          !sameIdentity(before, after) ||
          !sameIdentity(before, afterOpen) ||
          after.bytes !== candidate.bytes ||
          (afterOpen.mode & 0o077) !== 0
        ) {
          return null;
        }
        totalBytes += content.byteLength;
        members.push({
          path: candidate.path,
          bytes: content.byteLength,
          sha256: sha256(content),
          content,
        });
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    const postflight = listTrustedSnapshot(input.canonicalPath, input.maxTotalBytes);
    if (
      totalBytes > input.maxTotalBytes ||
      !sameIdentity(snapshot, trustedDirectory(input.canonicalPath)) ||
      JSON.stringify(postflight.members) !== JSON.stringify(input.members)
    ) {
      return null;
    }
    revalidateParents(parents);
    return members;
  } catch {
    return null;
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureTrustedStateRoot(layout: TrustedPathLayout): void {
  trustedDirectory(layout.repoRoot);
  trustedDirectory(layout.privateRoot);
  trustedDirectory(layout.corpusRoot);
  mkdirSync(layout.stateRoot, { recursive: true, mode: 0o700 });
  trustedDirectory(layout.stateRoot);
}

function stateFilePath(
  layout: TrustedPathLayout,
  kind: 'stage' | 'finalize',
  transferId: string,
): string {
  if (!isUuidV4(transferId)) throw new Error('invalid transfer');
  return path.posix.join(layout.stateRoot, `${kind}-${transferId}.json`);
}

function writeAtomicJson(destination: string, value: unknown): boolean {
  let descriptor: number | undefined;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    fsyncDirectory(path.posix.dirname(destination));
    return true;
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {}
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function readAtomicJson(destination: string): RelayJournalRead<unknown> {
  let descriptor: number | undefined;
  try {
    const before = trustedConfigLeaf(destination);
    descriptor = openSync(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) return { outcome: 'blocked' };
    const content = readFileSync(descriptor, 'utf8');
    if (!sameIdentity(before, trustedConfigLeaf(destination))) return { outcome: 'blocked' };
    return { outcome: 'present', value: JSON.parse(content) as unknown };
  } catch (error) {
    return { outcome: classifyRelayJournalReadFailure(error) };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function isMissingFilesystemEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export function classifyRelayJournalReadFailure(error: unknown): 'absent' | 'blocked' {
  return isMissingFilesystemEntry(error) ? 'absent' : 'blocked';
}

function snapshotIsAbsent(snapshotPath: string): boolean {
  try {
    lstatSync(snapshotPath);
    return false;
  } catch (error) {
    if (isMissingFilesystemEntry(error)) return true;
    throw error;
  }
}

function requestImds(
  method: 'GET' | 'PUT',
  requestPath: string,
  headers: Record<string, string>,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = httpRequest(
        {
          agent: false,
          headers,
          host: IMDS_HOST,
          method,
          path: requestPath,
          port: 80,
          protocol: 'http:',
          timeout: IMDS_TIMEOUT_MS,
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            finish(null);
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer | string) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += value.byteLength;
            if (bytes > IMDS_MAX_RESPONSE_BYTES) {
              request.destroy();
              finish(null);
              return;
            }
            chunks.push(value);
          });
          response.on('error', () => finish(null));
          response.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        },
      );
      request.on('error', () => finish(null));
      request.setTimeout(IMDS_TIMEOUT_MS, () => {
        request.destroy();
        finish(null);
      });
      request.end();
    } catch {
      finish(null);
    }
  });
}

async function attestImdsV2(instanceId: string): Promise<boolean> {
  const token = await requestImds('PUT', '/latest/api/token', {
    'X-aws-ec2-metadata-token-ttl-seconds': '60',
  });
  if (!token || token.length > IMDS_MAX_RESPONSE_BYTES) return false;
  const actual = await requestImds('GET', '/latest/meta-data/instance-id', {
    'X-aws-ec2-metadata-token': token,
  });
  return actual === instanceId;
}

function trustedEc2GitExecutable(
  inspection: TrustedExecutableInspection | null,
): inspection is TrustedExecutableInspection {
  return (
    inspection !== null &&
    inspection.path === EC2_GIT &&
    inspection.stableIdentity.length > 0 &&
    inspection.regularFile === true &&
    inspection.symbolicLink === false &&
    inspection.owner === 'root' &&
    inspection.writableByOthers === false &&
    path.posix.isAbsolute(inspection.path) &&
    path.posix.normalize(inspection.path) === inspection.path
  );
}

function inspectDefaultEc2GitExecutable(executable: string): TrustedExecutableInspection | null {
  try {
    if (executable !== EC2_GIT || !path.posix.isAbsolute(executable)) return null;
    let current = executable;
    let executableStats: ReturnType<typeof lstatSync> | null = null;
    while (true) {
      const stats = lstatSync(current);
      if (
        stats.isSymbolicLink() ||
        stats.uid !== 0 ||
        (stats.mode & 0o022) !== 0 ||
        realpathSync(current) !== current
      ) {
        return null;
      }
      if (current === executable) {
        if (!stats.isFile()) return null;
        executableStats = stats;
      } else if (!stats.isDirectory()) {
        return null;
      }
      if (current === '/') break;
      current = path.posix.dirname(current);
    }
    if (!executableStats) return null;
    return {
      path: executable,
      stableIdentity: `${String(executableStats.dev)}:${String(executableStats.ino)}`,
      regularFile: true,
      symbolicLink: false,
      owner: 'root',
      writableByOthers: false,
    };
  } catch {
    return null;
  }
}

const defaultEc2GitExecutableInspector: TrustedExecutableInspector = {
  async inspect(executable) {
    return inspectDefaultEc2GitExecutable(executable);
  },
};

function exactEc2GitInspectionArgs(args: Ec2GitInspectionArgs): boolean {
  return (
    (args.length === 2 && args[0] === 'rev-parse' && args[1] === 'HEAD') ||
    (args.length === 2 && args[0] === 'rev-parse' && args[1] === '--show-toplevel') ||
    (args.length === 3 &&
      args[0] === 'status' &&
      args[1] === '--porcelain=v1' &&
      args[2] === '--untracked-files=all')
  );
}

function sameEc2GitEnvironment(environment: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(environment);
  return (
    entries.length === Object.keys(EC2_GIT_ENV).length &&
    entries.every(([key, value]) => EC2_GIT_ENV[key as keyof typeof EC2_GIT_ENV] === value)
  );
}

class Ec2GitProcessAdapter implements Ec2GitProcessRunner {
  run(invocation: Ec2GitProcessInvocation): {
    failed: boolean;
    status: number | null;
    stdout: string | null;
  } {
    if (
      invocation.executable !== EC2_GIT ||
      invocation.shell !== false ||
      !isCanonicalAbsolutePath(invocation.cwd) ||
      !exactEc2GitInspectionArgs(invocation.args) ||
      !sameEc2GitEnvironment(invocation.env)
    ) {
      return { failed: true, status: null, stdout: null };
    }
    try {
      const result = spawnSync(EC2_GIT, invocation.args, {
        cwd: invocation.cwd,
        encoding: 'utf8',
        env: invocation.env,
        maxBuffer: 64 * 1024,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return {
        failed: result.error !== undefined || result.signal !== null,
        status: result.status,
        stdout: typeof result.stdout === 'string' ? result.stdout : null,
      };
    } catch {
      return { failed: true, status: null, stdout: null };
    }
  }
}

function createEc2GitInspectionBoundary(
  inspector: TrustedExecutableInspector = defaultEc2GitExecutableInspector,
  processRunner: Ec2GitProcessRunner = new Ec2GitProcessAdapter(),
  defaultTrustCheck?: () => boolean,
): {
  assertTrustedExecutable(): Promise<boolean>;
  inspect(request: { check: 'revision' | 'worktree' | 'status'; cwd: string }): string | null;
} {
  let trusted = defaultTrustCheck?.() ?? false;
  return {
    async assertTrustedExecutable(): Promise<boolean> {
      trusted = trustedEc2GitExecutable(await inspector.inspect(EC2_GIT).catch(() => null));
      return trusted;
    },
    inspect(request): string | null {
      if (
        !trusted ||
        (defaultTrustCheck !== undefined && !defaultTrustCheck()) ||
        !isCanonicalAbsolutePath(request.cwd)
      ) {
        return null;
      }
      const args: Ec2GitInspectionArgs =
        request.check === 'revision'
          ? ['rev-parse', 'HEAD']
          : request.check === 'worktree'
            ? ['rev-parse', '--show-toplevel']
            : ['status', '--porcelain=v1', '--untracked-files=all'];
      const result = processRunner.run({
        executable: EC2_GIT,
        args,
        cwd: request.cwd,
        env: EC2_GIT_ENV,
        shell: false,
      });
      return !result.failed && result.status === 0 && typeof result.stdout === 'string'
        ? result.stdout
        : null;
    },
  };
}

export function createFixedEc2GitInspectionBoundary(
  inspector: TrustedExecutableInspector = defaultEc2GitExecutableInspector,
  processRunner: Ec2GitProcessRunner = new Ec2GitProcessAdapter(),
): {
  assertTrustedExecutable(): Promise<boolean>;
  inspect(request: { check: 'revision' | 'worktree' | 'status'; cwd: string }): string | null;
} {
  return createEc2GitInspectionBoundary(inspector, processRunner);
}

export function createDefaultRelaySourceRuntime(
  repoRoot = defaultRepoRoot(),
): RelaySourceRuntimePort {
  const layout = sourcePathLayout(repoRoot);
  const gitBoundary = createEc2GitInspectionBoundary(
    defaultEc2GitExecutableInspector,
    new Ec2GitProcessAdapter(),
    () => trustedEc2GitExecutable(inspectDefaultEc2GitExecutable(EC2_GIT)),
  );
  return {
    platform: () => process.platform,
    attestImdsV2,
    readProtectedConfig: async () => {
      try {
        return readTrustedConfig(layout);
      } catch {
        throw new Error('protected config unavailable');
      }
    },
    inspectGit: (check) => gitBoundary.inspect({ check, cwd: layout.repoRoot }),
    inspectTrustedSnapshot: async (input) => inspectTrustedSnapshot(layout, input),
    readBoundedTrustedSnapshot: async (input) => readBoundedTrustedSnapshot(layout, input),
    writeStageIntent: async (intent) => {
      try {
        ensureTrustedStateRoot(layout);
        return writeAtomicJson(stateFilePath(layout, 'stage', intent.transferId), intent);
      } catch {
        return false;
      }
    },
    readStageIntent: async (transferId) => {
      try {
        ensureTrustedStateRoot(layout);
        const read = readAtomicJson(stateFilePath(layout, 'stage', transferId));
        return read.outcome === 'present' && isRecord(read.value)
          ? { outcome: 'present', value: read.value as StageIntentV1 }
          : read.outcome === 'present'
            ? { outcome: 'blocked' }
            : read;
      } catch {
        return { outcome: 'blocked' };
      }
    },
    writeFinalizeJournal: async (journal) => {
      try {
        ensureTrustedStateRoot(layout);
        return writeAtomicJson(
          stateFilePath(layout, 'finalize', journal.stageIntent.transferId),
          journal,
        );
      } catch {
        return false;
      }
    },
    readFinalizeJournal: async (transferId) => {
      try {
        ensureTrustedStateRoot(layout);
        const read = readAtomicJson(stateFilePath(layout, 'finalize', transferId));
        return read.outcome === 'present' && isRecord(read.value)
          ? { outcome: 'present', value: read.value as FinalizeJournalV1 }
          : read.outcome === 'present'
            ? { outcome: 'blocked' }
            : read;
      } catch {
        return { outcome: 'blocked' };
      }
    },
    removeTrustedSnapshot: async (snapshot) => {
      try {
        if (
          !isDirectChildName(snapshot.directChildName) ||
          !isCanonicalAbsolutePath(snapshot.canonicalPath) ||
          !isOpaqueIdentifier(snapshot.stableIdentity) ||
          snapshot.canonicalPath !== path.posix.join(layout.snapshotsRoot, snapshot.directChildName)
        ) {
          return false;
        }
        const parents = trustedParents(layout);
        if (snapshotIsAbsent(snapshot.canonicalPath)) return true;
        const inspected = inspectTrustedSnapshot(layout, {
          name: snapshot.directChildName,
          maxTotalBytes: Number.MAX_SAFE_INTEGER,
        });
        if (
          !inspected ||
          inspected.canonicalPath !== snapshot.canonicalPath ||
          inspected.stableIdentity !== snapshot.stableIdentity
        ) {
          return false;
        }
        try {
          rmSync(snapshot.canonicalPath, { recursive: true, force: false, maxRetries: 0 });
        } catch (error) {
          if (!isMissingFilesystemEntry(error) || !snapshotIsAbsent(snapshot.canonicalPath)) {
            return false;
          }
        }
        fsyncDirectory(layout.snapshotsRoot);
        revalidateParents(parents);
        return true;
      } catch {
        return false;
      }
    },
  };
}
