import {
  validatePrivateThreadCorpusSnapshot,
  type PrivateThreadCorpusArtifactFile,
  type PrivateThreadCorpusSnapshot,
  type PrivateThreadCorpusSnapshotContext,
  type ThreadCorpusArtifactKind,
} from '../../scripts/export-thread-corpus.js';
import { createHash } from 'node:crypto';

export const CENTURION_THREAD_CORPUS_RELAY_VERSION = 'centurion-thread-corpus-relay-v1';

export type CenturionRelayMember = {
  path: string;
  bytes: number;
  sha256: string;
  content: Uint8Array;
};

export type CenturionRelayManifestV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_RELAY_VERSION;
  transferId: string;
  snapshotId: string;
  sourceManifestSha256: string;
  memberSetSha256: string;
  members: Array<Omit<CenturionRelayMember, 'content'>>;
};

export type CenturionRelayVerification =
  | {
      outcome: 'verified';
      snapshotId: string;
      sourceManifestSha256: string;
      memberSetSha256: string;
      relayManifestSha256: string;
    }
  | { outcome: 'blocked' };

export type ReceiveReceiptV1 = {
  schemaVersion: 'centurion-thread-corpus-relay-receipt-v1';
  transferId: string;
  snapshotId: string;
  sourceManifestSha256: string;
  relayManifestSha256: string;
  memberSetSha256: string;
};

export type ReceiverAcknowledgementV1 = {
  schemaVersion: 'centurion-thread-corpus-relay-ack-v1';
  transferId: string;
  snapshotId: string;
  sourceManifestSha256: string;
  relayManifestSha256: string;
  memberSetSha256: string;
  receiveReceiptSha256: string;
};

type CenturionRelayMemberMetadata = Omit<CenturionRelayMember, 'content'>;

type SourceMemberPath =
  | { kind: 'corpus' }
  | { kind: 'manifest' }
  | {
      kind: 'artifact';
      artifactKind: ThreadCorpusArtifactKind;
      artifactId: string;
    };

type ValidatedRelayMember = {
  member: CenturionRelayMember;
  path: SourceMemberPath;
};

type ValidatedArtifactMember = ValidatedRelayMember & {
  path: Extract<SourceMemberPath, { kind: 'artifact' }>;
};

type ValidatedSourceMembers = {
  members: ValidatedRelayMember[];
  corpus: ValidatedRelayMember;
  manifest: ValidatedRelayMember;
  artifacts: ValidatedArtifactMember[];
};

type ReceiptInput = Omit<ReceiveReceiptV1, 'schemaVersion'>;
type AcknowledgementInput = Omit<ReceiverAcknowledgementV1, 'schemaVersion'>;

const RELAY_MANIFEST_FILENAME = 'relay-manifest.v1.json';
const RECEIVER_ACKNOWLEDGEMENT_FILENAME = 'receiver-ack.v1.json';
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LITERAL_ROOT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RAW_MIME_MEMBER = /^raw-mime\/([a-f0-9]{64})\.eml$/;
const ATTACHMENT_TEXT_MEMBER = /^attachment-text\/([a-f0-9]{64})\.txt$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function invalidRelayInput(): never {
  throw new Error('Invalid Centurion relay input');
}

function runOrThrow<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalidRelayInput();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasCanonicalKeyOrder(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key, index) => key === keys[index]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_IDENTIFIER.test(value);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sha256Bytes(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function canonicalMemberSetSha256(members: readonly CenturionRelayMemberMetadata[]): string {
  return sha256Text(
    members.map(({ path, bytes, sha256 }) => `${path}\t${bytes}\t${sha256}\n`).join(''),
  );
}

function memberMetadata(member: CenturionRelayMember): CenturionRelayMemberMetadata {
  return {
    path: member.path,
    bytes: member.bytes,
    sha256: member.sha256,
  };
}

function parseSourceMemberPath(path: unknown): SourceMemberPath {
  if (path === 'corpus.jsonl') return { kind: 'corpus' };
  if (path === 'manifest.json') return { kind: 'manifest' };
  if (typeof path !== 'string' || path.includes('\\')) invalidRelayInput();

  const rawMime = RAW_MIME_MEMBER.exec(path);
  if (rawMime?.[1]) {
    return {
      kind: 'artifact',
      artifactKind: 'raw_mime',
      artifactId: rawMime[1],
    };
  }

  const attachmentText = ATTACHMENT_TEXT_MEMBER.exec(path);
  if (attachmentText?.[1]) {
    return {
      kind: 'artifact',
      artifactKind: 'attachment_text',
      artifactId: attachmentText[1],
    };
  }

  return invalidRelayInput();
}

function validateRelayMember(value: unknown): ValidatedRelayMember {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['path', 'bytes', 'sha256', 'content']) ||
    typeof value.path !== 'string' ||
    !isPositiveSafeInteger(value.bytes) ||
    !isSha256Digest(value.sha256) ||
    !(value.content instanceof Uint8Array)
  ) {
    return invalidRelayInput();
  }

  const path = parseSourceMemberPath(value.path);
  if (value.content.byteLength !== value.bytes || sha256Bytes(value.content) !== value.sha256) {
    return invalidRelayInput();
  }

  return {
    member: {
      path: value.path,
      bytes: value.bytes,
      sha256: value.sha256,
      content: value.content,
    },
    path,
  };
}

function validateRelayMemberMetadata(value: unknown): CenturionRelayMemberMetadata {
  if (
    !isRecord(value) ||
    !hasCanonicalKeyOrder(value, ['path', 'bytes', 'sha256']) ||
    typeof value.path !== 'string' ||
    !isPositiveSafeInteger(value.bytes) ||
    !isSha256Digest(value.sha256)
  ) {
    return invalidRelayInput();
  }

  parseSourceMemberPath(value.path);
  return {
    path: value.path,
    bytes: value.bytes,
    sha256: value.sha256,
  };
}

function validateSourceMembers(value: unknown, maxTotalBytes: unknown): ValidatedSourceMembers {
  if (!isNonNegativeSafeInteger(maxTotalBytes) || !Array.isArray(value)) {
    return invalidRelayInput();
  }

  const members: ValidatedRelayMember[] = [];
  const artifacts: ValidatedArtifactMember[] = [];
  let corpus: ValidatedRelayMember | undefined;
  let manifest: ValidatedRelayMember | undefined;
  let totalBytes = 0;
  let previousPath: string | undefined;

  for (const candidate of value) {
    const member = validateRelayMember(candidate);
    if (
      (previousPath !== undefined && compareText(previousPath, member.member.path) >= 0) ||
      member.member.bytes > maxTotalBytes - totalBytes
    ) {
      return invalidRelayInput();
    }

    previousPath = member.member.path;
    totalBytes += member.member.bytes;
    members.push(member);

    if (member.path.kind === 'corpus') {
      if (corpus) return invalidRelayInput();
      corpus = member;
      continue;
    }
    if (member.path.kind === 'manifest') {
      if (manifest) return invalidRelayInput();
      manifest = member;
      continue;
    }
    artifacts.push(member as ValidatedArtifactMember);
  }

  if (!corpus || !manifest) return invalidRelayInput();
  return { members, corpus, manifest, artifacts };
}

function decodeUtf8(content: Uint8Array): string {
  if (
    content.byteLength >= 3 &&
    content[0] === 0xef &&
    content[1] === 0xbb &&
    content[2] === 0xbf
  ) {
    return invalidRelayInput();
  }
  return textDecoder.decode(content);
}

function contextFromV2Manifest(value: Record<string, unknown>): PrivateThreadCorpusSnapshotContext {
  if (
    typeof value.snapshotId !== 'string' ||
    !isRecord(value.scope) ||
    !isRecord(value.window) ||
    typeof value.window.endExclusive !== 'string' ||
    typeof value.exporterVersion !== 'string' ||
    !isRecord(value.counts) ||
    !isNonNegativeSafeInteger(value.counts.unscopedQuarantineExcluded)
  ) {
    return invalidRelayInput();
  }

  return {
    snapshotId: value.snapshotId,
    scope: value.scope as PrivateThreadCorpusSnapshotContext['scope'],
    asOf: value.window.endExclusive,
    exporterVersion: value.exporterVersion,
    unscopedQuarantineExcluded: value.counts.unscopedQuarantineExcluded,
  };
}

function reconstructV2Snapshot(members: ValidatedSourceMembers): PrivateThreadCorpusSnapshot {
  const manifestJson = decodeUtf8(members.manifest.member.content);
  const manifestValue = JSON.parse(manifestJson) as unknown;
  if (!isRecord(manifestValue) || manifestJson !== `${JSON.stringify(manifestValue, null, 2)}\n`) {
    return invalidRelayInput();
  }

  const snapshot: PrivateThreadCorpusSnapshot = {
    context: contextFromV2Manifest(manifestValue),
    corpusJsonl: decodeUtf8(members.corpus.member.content),
    manifestJson,
    manifest: manifestValue as unknown as PrivateThreadCorpusSnapshot['manifest'],
    artifactFiles: members.artifacts.map(
      ({ member, path }): PrivateThreadCorpusArtifactFile => ({
        kind: path.artifactKind,
        id: path.artifactId,
        sha256: member.sha256,
        bytes: member.bytes,
        content: new Uint8Array(member.content),
      }),
    ),
  };

  validatePrivateThreadCorpusSnapshot(snapshot);
  return snapshot;
}

function validateRelayManifest(value: unknown): CenturionRelayManifestV1 {
  if (
    !isRecord(value) ||
    !hasCanonicalKeyOrder(value, [
      'schemaVersion',
      'transferId',
      'snapshotId',
      'sourceManifestSha256',
      'memberSetSha256',
      'members',
    ]) ||
    value.schemaVersion !== CENTURION_THREAD_CORPUS_RELAY_VERSION ||
    !isCanonicalUuidV4(value.transferId) ||
    !isOpaqueIdentifier(value.snapshotId) ||
    !isSha256Digest(value.sourceManifestSha256) ||
    !isSha256Digest(value.memberSetSha256) ||
    !Array.isArray(value.members)
  ) {
    return invalidRelayInput();
  }

  const members: CenturionRelayMemberMetadata[] = [];
  let previousPath: string | undefined;
  for (const candidate of value.members) {
    const member = validateRelayMemberMetadata(candidate);
    if (previousPath !== undefined && compareText(previousPath, member.path) >= 0) {
      return invalidRelayInput();
    }
    previousPath = member.path;
    members.push(member);
  }

  return {
    schemaVersion: CENTURION_THREAD_CORPUS_RELAY_VERSION,
    transferId: value.transferId,
    snapshotId: value.snapshotId,
    sourceManifestSha256: value.sourceManifestSha256,
    memberSetSha256: value.memberSetSha256,
    members,
  };
}

function parseCanonicalRelayManifest(content: unknown): {
  manifest: CenturionRelayManifestV1;
  sha256: string;
} {
  if (!(content instanceof Uint8Array)) return invalidRelayInput();
  const manifestJson = decodeUtf8(content);
  const value = JSON.parse(manifestJson) as unknown;
  if (!isRecord(value) || manifestJson !== `${JSON.stringify(value, null, 2)}\n`) {
    return invalidRelayInput();
  }

  return {
    manifest: validateRelayManifest(value),
    sha256: sha256Bytes(content),
  };
}

function assertMatchingMembers(
  expected: readonly ValidatedRelayMember[],
  actual: readonly CenturionRelayMemberMetadata[],
): void {
  if (expected.length !== actual.length) invalidRelayInput();
  for (let index = 0; index < expected.length; index += 1) {
    const source = expected[index]?.member;
    const relay = actual[index];
    if (
      !source ||
      !relay ||
      source.path !== relay.path ||
      source.bytes !== relay.bytes ||
      source.sha256 !== relay.sha256
    ) {
      invalidRelayInput();
    }
  }
}

function validateLiteralRelayRoot(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    return invalidRelayInput();
  }

  const segments = value.split('/');
  if (segments.some((segment) => !LITERAL_ROOT_SEGMENT.test(segment))) {
    return invalidRelayInput();
  }
  return value;
}

function validateReceiptInput(value: unknown): ReceiptInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'transferId',
      'snapshotId',
      'sourceManifestSha256',
      'relayManifestSha256',
      'memberSetSha256',
    ]) ||
    !isCanonicalUuidV4(value.transferId) ||
    !isOpaqueIdentifier(value.snapshotId) ||
    !isSha256Digest(value.sourceManifestSha256) ||
    !isSha256Digest(value.relayManifestSha256) ||
    !isSha256Digest(value.memberSetSha256)
  ) {
    return invalidRelayInput();
  }

  return {
    transferId: value.transferId,
    snapshotId: value.snapshotId,
    sourceManifestSha256: value.sourceManifestSha256,
    relayManifestSha256: value.relayManifestSha256,
    memberSetSha256: value.memberSetSha256,
  };
}

function validateAcknowledgementInput(value: unknown): AcknowledgementInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'transferId',
      'snapshotId',
      'sourceManifestSha256',
      'relayManifestSha256',
      'memberSetSha256',
      'receiveReceiptSha256',
    ]) ||
    !isCanonicalUuidV4(value.transferId) ||
    !isOpaqueIdentifier(value.snapshotId) ||
    !isSha256Digest(value.sourceManifestSha256) ||
    !isSha256Digest(value.relayManifestSha256) ||
    !isSha256Digest(value.memberSetSha256) ||
    !isSha256Digest(value.receiveReceiptSha256)
  ) {
    return invalidRelayInput();
  }

  return {
    transferId: value.transferId,
    snapshotId: value.snapshotId,
    sourceManifestSha256: value.sourceManifestSha256,
    relayManifestSha256: value.relayManifestSha256,
    memberSetSha256: value.memberSetSha256,
    receiveReceiptSha256: value.receiveReceiptSha256,
  };
}

export function buildCenturionRelayManifest(
  transferId: string,
  members: readonly CenturionRelayMember[],
  maxTotalBytes: number,
): {
  manifest: CenturionRelayManifestV1;
  manifestJson: string;
  manifestBytes: Uint8Array;
} {
  return runOrThrow(() => {
    if (!isCanonicalUuidV4(transferId)) return invalidRelayInput();
    const sourceMembers = validateSourceMembers(members, maxTotalBytes);
    const snapshot = reconstructV2Snapshot(sourceMembers);
    const sourceManifestSha256 = sha256Bytes(sourceMembers.manifest.member.content);
    const memberRows = sourceMembers.members.map(({ member }) => memberMetadata(member));
    const manifest: CenturionRelayManifestV1 = {
      schemaVersion: CENTURION_THREAD_CORPUS_RELAY_VERSION,
      transferId,
      snapshotId: snapshot.context.snapshotId,
      sourceManifestSha256,
      memberSetSha256: canonicalMemberSetSha256(memberRows),
      members: memberRows,
    };
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    return {
      manifest,
      manifestJson,
      manifestBytes: textEncoder.encode(manifestJson),
    };
  });
}

export function relayObjectKey(
  literalRelayRoot: string,
  transferId: string,
  memberPath: string,
): string {
  return runOrThrow(() => {
    const root = validateLiteralRelayRoot(literalRelayRoot);
    if (!isCanonicalUuidV4(transferId)) return invalidRelayInput();
    parseSourceMemberPath(memberPath);
    return `${root}/${transferId}/${memberPath}`;
  });
}

export function relayManifestKey(literalRelayRoot: string, transferId: string): string {
  return runOrThrow(() => {
    const root = validateLiteralRelayRoot(literalRelayRoot);
    if (!isCanonicalUuidV4(transferId)) return invalidRelayInput();
    return `${root}/${transferId}/${RELAY_MANIFEST_FILENAME}`;
  });
}

export function receiverAcknowledgementKey(literalRelayRoot: string, transferId: string): string {
  return runOrThrow(() => {
    const root = validateLiteralRelayRoot(literalRelayRoot);
    if (!isCanonicalUuidV4(transferId)) return invalidRelayInput();
    return `${root}/${transferId}/${RECEIVER_ACKNOWLEDGEMENT_FILENAME}`;
  });
}

export function buildReceiveReceipt(input: Omit<ReceiveReceiptV1, 'schemaVersion'>): string {
  return runOrThrow(() => {
    const fields = validateReceiptInput(input);
    const receipt: ReceiveReceiptV1 = {
      schemaVersion: 'centurion-thread-corpus-relay-receipt-v1',
      ...fields,
    };
    return `${JSON.stringify(receipt, null, 2)}\n`;
  });
}

export function buildReceiverAcknowledgement(
  input: Omit<ReceiverAcknowledgementV1, 'schemaVersion'>,
): string {
  return runOrThrow(() => {
    const fields = validateAcknowledgementInput(input);
    const acknowledgement: ReceiverAcknowledgementV1 = {
      schemaVersion: 'centurion-thread-corpus-relay-ack-v1',
      ...fields,
    };
    return `${JSON.stringify(acknowledgement, null, 2)}\n`;
  });
}

export function verifyCenturionRelaySnapshot(
  relayManifestBytes: Uint8Array,
  members: readonly CenturionRelayMember[],
  maxTotalBytes: number,
): CenturionRelayVerification {
  try {
    const relayManifest = parseCanonicalRelayManifest(relayManifestBytes);
    const candidate = relayManifest.manifest;
    const sourceMembers = validateSourceMembers(members, maxTotalBytes);
    const memberRows = sourceMembers.members.map(({ member }) => memberMetadata(member));
    const sourceManifestSha256 = sha256Bytes(sourceMembers.manifest.member.content);

    assertMatchingMembers(sourceMembers.members, candidate.members);
    if (
      candidate.sourceManifestSha256 !== sourceManifestSha256 ||
      candidate.memberSetSha256 !== canonicalMemberSetSha256(memberRows)
    ) {
      return { outcome: 'blocked' };
    }

    const snapshot = reconstructV2Snapshot(sourceMembers);
    if (candidate.snapshotId !== snapshot.context.snapshotId) {
      return { outcome: 'blocked' };
    }

    return {
      outcome: 'verified',
      snapshotId: snapshot.context.snapshotId,
      sourceManifestSha256,
      memberSetSha256: candidate.memberSetSha256,
      relayManifestSha256: relayManifest.sha256,
    };
  } catch {
    return { outcome: 'blocked' };
  }
}
