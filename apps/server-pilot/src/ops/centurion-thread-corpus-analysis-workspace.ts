import {
  CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
  preparePrivateAnalysis,
  reconcileAnalystDecisionBundle,
  type AnalystDecisionBundleV1,
  type PreparedPrivateAnalysisV1,
  type PrivateAnalysisPacketV1,
  type ReconciledAnalystDecisionsV1,
} from './centurion-thread-corpus-analysis.js';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  validatePrivateThreadCorpusSnapshot,
  type PrivateThreadCorpusArtifactFile,
  type PrivateThreadCorpusSnapshot,
} from '../../scripts/export-thread-corpus.js';
import {
  createWindowsPrivateAcl,
  readExactBoundedDescriptor,
  type WindowsPrivateAcl,
} from './centurion-thread-corpus-relay-receiver.js';
import { buildCenturionCorpusEvidenceReport } from './centurion-thread-corpus-evidence.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type AnalysisWorkspaceConfigV1 = {
  version: 'centurion-thread-corpus-analysis-workspace-config-v1';
  checkoutRoot: string;
  receivedCorpusRoot: string;
  analysisRoot: string;
  maxPacketBytes: number;
  maxTotalPacketBytes: number;
  maxDecisionBytes: number;
};

export type VerifiedReceivedAnalysisInput = {
  snapshot: PrivateThreadCorpusSnapshot;
  snapshotDigest: string;
  receiveReceiptSha256: string;
  canonicalPath: string;
  stableIdentity: string;
  volumeId: string;
};

export type AnalysisWorkspaceStateV1 = {
  schemaVersion: 'centurion-thread-corpus-analysis-workspace-state-v1';
  transferId: string;
  snapshotDigest: string;
  receiveReceiptSha256: string;
  preparedManifestSha256: string;
  state: 'prepared' | 'decision_written' | 'reconciled';
  decisionBundleSha256: string | null;
  reportSha256: string | null;
};

export type AnalysisWorkspacePort = {
  platform(): string;
  readProtectedConfig(): Promise<string>;
  inspectCheckout(input: {
    checkoutRoot: string;
    receivedCorpusRoot: string;
    analysisRoot: string;
  }): Promise<{ gitignored: boolean; stableIdentity: string; volumeId: string } | null>;
  readVerifiedReceivedSnapshot(transferId: string): Promise<VerifiedReceivedAnalysisInput | null>;
  createProtectedWorkspace(input: {
    snapshotDigest: string;
    receiveReceiptSha256: string;
    expectedVolumeId: string;
  }): Promise<{ path: string; stableIdentity: string; volumeId: string } | null>;
  writeCreateNewProtected(path: string, content: Uint8Array): Promise<boolean>;
  readBoundedProtected(path: string, maxBytes: number): Promise<Uint8Array | null>;
  writeAtomicProtectedState(state: AnalysisWorkspaceStateV1): Promise<boolean>;
  readProtectedState(transferId: string): Promise<AnalysisWorkspaceStateV1 | null>;
  acl: WindowsPrivateAcl;
};

export type AnalysisCliResult =
  | { outcome: 'prepared' }
  | { outcome: 'reconciled' }
  | { outcome: 'blocked' };

export type GitIgnoreProcessRunner = {
  run(input: {
    executable: typeof WINDOWS_GIT;
    args: readonly ['check-ignore', '--no-index', '--quiet', '--', string];
    cwd: string;
    env: Readonly<Record<string, string>>;
    shell: false;
  }): { failed: boolean; status: number | null };
};

export type GitIgnoreRunner = {
  isIgnored(input: { checkoutRoot: string; candidate: string }): Promise<boolean>;
};

export type TrustedExecutableInspection = {
  path: string;
  stableIdentity: string;
  regularFile: true;
  symbolicLink: false;
  owner: 'root' | 'trusted-system';
  writableByOthers: false;
};

export type TrustedExecutableInspector = {
  inspect(executable: string, cwd: string): Promise<TrustedExecutableInspection | null>;
};

type TrustedPath = {
  stableIdentity: string;
  volumeId: string;
};

type LocalIdentity = {
  stableIdentity: string;
  volumeId: string;
};

type ArtifactReference = {
  kind: PrivateThreadCorpusArtifactFile['kind'];
  id: string;
  sha256: string;
  bytes: number;
};

const CONFIG_VERSION = 'centurion-thread-corpus-analysis-workspace-config-v1';
const STATE_VERSION = 'centurion-thread-corpus-analysis-workspace-state-v1';
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_PACKET_BYTES = 128 * 1024 * 1024;
const MAX_DECISION_BYTES = 4 * 1024 * 1024;
const MAX_RECEIVED_BYTES = 256 * 1024 * 1024;
const MAX_PACKET_FILES = 100_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
export const WINDOWS_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const WINDOWS_GIT_ENV = Object.freeze({
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_GLOBAL: 'NUL',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_KEY_2: 'core.excludesFile',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_VALUE_1: 'NUL',
  GIT_CONFIG_VALUE_2: 'NUL',
  GIT_OPTIONAL_LOCKS: '0',
});
const REQUIRED_GIT_IGNORE_CANDIDATES = [
  '.private/centurion-thread-corpus/',
  '.private/centurion-thread-analysis/',
] as const;

function blocked(): AnalysisCliResult {
  return { outcome: 'blocked' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
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

function isBoundedPositiveSafeInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sameWindowsPath(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function isCanonicalWindowsPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > 4_096 ||
    value.includes('/') ||
    value.includes('\0') ||
    value.endsWith('\\') ||
    !/^[A-Za-z]:\\/.test(value)
  ) {
    return false;
  }
  return path.win32.normalize(value) === value && !value.split('\\').includes('..');
}

function isRequiredGitIgnoreCandidate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    REQUIRED_GIT_IGNORE_CANDIDATES.some((candidate) => candidate === value)
  );
}

function sameWindowsGitExecutablePath(left: string, right: string): boolean {
  return (
    path.win32.isAbsolute(left) &&
    path.win32.isAbsolute(right) &&
    path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()
  );
}

function trustedWindowsGitExecutable(
  inspection: TrustedExecutableInspection | null,
): inspection is TrustedExecutableInspection {
  return (
    inspection !== null &&
    sameWindowsGitExecutablePath(inspection.path, WINDOWS_GIT) &&
    inspection.stableIdentity.length > 0 &&
    inspection.regularFile === true &&
    inspection.symbolicLink === false &&
    inspection.owner === 'trusted-system' &&
    inspection.writableByOthers === false
  );
}

const defaultWindowsGitExecutableInspector: TrustedExecutableInspector = {
  async inspect() {
    // Node does not expose NTFS owner or effective DACL information. Never
    // substitute reparse-point checks for an OS-native executable trust proof.
    return null;
  },
};

function exactGitIgnoreArgs(
  args: readonly ['check-ignore', '--no-index', '--quiet', '--', string],
): boolean {
  return (
    args.length === 5 &&
    args[0] === 'check-ignore' &&
    args[1] === '--no-index' &&
    args[2] === '--quiet' &&
    args[3] === '--' &&
    isRequiredGitIgnoreCandidate(args[4])
  );
}

function validWindowsGitEnvironment(environment: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(environment);
  return (
    entries.length === Object.keys(WINDOWS_GIT_ENV).length &&
    entries.every(([key, value]) => WINDOWS_GIT_ENV[key as keyof typeof WINDOWS_GIT_ENV] === value)
  );
}

class WindowsGitIgnoreProcessAdapter implements GitIgnoreProcessRunner {
  run(input: {
    executable: typeof WINDOWS_GIT;
    args: readonly ['check-ignore', '--no-index', '--quiet', '--', string];
    cwd: string;
    env: Readonly<Record<string, string>>;
    shell: false;
  }): { failed: boolean; status: number | null } {
    if (
      input.executable !== WINDOWS_GIT ||
      input.shell !== false ||
      !isCanonicalWindowsPath(input.cwd) ||
      !exactGitIgnoreArgs(input.args) ||
      !validWindowsGitEnvironment(input.env)
    ) {
      return { failed: true, status: null };
    }
    try {
      const result = spawnSync(WINDOWS_GIT, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      return {
        failed: result.error !== undefined || result.signal !== null || result.status === null,
        status: result.status,
      };
    } catch {
      return { failed: true, status: null };
    }
  }
}

export function createFixedGitIgnoreRunner(
  processRunner: GitIgnoreProcessRunner = new WindowsGitIgnoreProcessAdapter(),
  inspector: TrustedExecutableInspector = defaultWindowsGitExecutableInspector,
): GitIgnoreRunner {
  return {
    async isIgnored(input): Promise<boolean> {
      if (
        !isCanonicalWindowsPath(input.checkoutRoot) ||
        !isRequiredGitIgnoreCandidate(input.candidate) ||
        !trustedWindowsGitExecutable(
          await inspector.inspect(WINDOWS_GIT, input.checkoutRoot).catch(() => null),
        )
      ) {
        return false;
      }
      const result = processRunner.run({
        executable: WINDOWS_GIT,
        args: ['check-ignore', '--no-index', '--quiet', '--', input.candidate],
        cwd: input.checkoutRoot,
        env: WINDOWS_GIT_ENV,
        shell: false,
      });
      return !result.failed && result.status === 0;
    },
  };
}

export function requiredAnalysisRootsAreIgnored(
  checkoutRoot: string,
  runner: GitIgnoreRunner,
): Promise<boolean> {
  return Promise.all(
    REQUIRED_GIT_IGNORE_CANDIDATES.map((candidate) =>
      runner.isIgnored({ checkoutRoot, candidate }),
    ),
  ).then((results) => results.every(Boolean));
}

function expectedReceivedRoot(checkoutRoot: string): string {
  return path.win32.join(checkoutRoot, '.private', 'centurion-thread-corpus');
}

function expectedAnalysisRoot(checkoutRoot: string): string {
  return path.win32.join(checkoutRoot, '.private', 'centurion-thread-analysis');
}

function workspaceBindingId(snapshotDigest: string, receiveReceiptSha256: string): string {
  return sha256(`${snapshotDigest}\n${receiveReceiptSha256}`);
}

function expectedWorkspacePath(
  analysisRoot: string,
  snapshotDigest: string,
  receiveReceiptSha256: string,
): string {
  return path.win32.join(
    analysisRoot,
    'workspaces',
    workspaceBindingId(snapshotDigest, receiveReceiptSha256),
  );
}

function workspaceFilePath(workspace: string, relative: string): string {
  return path.win32.join(workspace, ...relative.split('/'));
}

function statePath(analysisRoot: string, transferId: string): string {
  return path.win32.join(analysisRoot, 'state', `${transferId}.v1.json`);
}

type StateTemporaryReservation = 'reserved' | 'collision' | 'blocked';

export function reserveUniqueStateTemporaryPath(input: {
  finalPath: string;
  nextUuid: () => string;
  reserve: (candidate: string) => StateTemporaryReservation;
  maximumAttempts?: number;
}): string | null {
  const maximumAttempts = input.maximumAttempts ?? 8;
  if (
    !isCanonicalWindowsPath(input.finalPath) ||
    !Number.isSafeInteger(maximumAttempts) ||
    maximumAttempts < 1 ||
    maximumAttempts > 64
  ) {
    return null;
  }
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const uuid = input.nextUuid();
    if (!isUuidV4(uuid)) return null;
    const candidate = `${input.finalPath}.partial-${uuid}`;
    const result = input.reserve(candidate);
    if (result === 'reserved') return candidate;
    if (result !== 'collision') return null;
  }
  return null;
}

function packetRelativePath(index: number): string {
  return `packets/packet-${String(index).padStart(6, '0')}.v1.json`;
}

function decodeUtf8(content: Uint8Array): string | null {
  try {
    if (
      content.byteLength >= 3 &&
      content[0] === 0xef &&
      content[1] === 0xbb &&
      content[2] === 0xbf
    ) {
      return null;
    }
    return textDecoder.decode(content);
  } catch {
    return null;
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isWorkspaceState(value: unknown): value is AnalysisWorkspaceStateV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'transferId',
      'snapshotDigest',
      'receiveReceiptSha256',
      'preparedManifestSha256',
      'state',
      'decisionBundleSha256',
      'reportSha256',
    ]) ||
    value.schemaVersion !== STATE_VERSION ||
    !isUuidV4(value.transferId) ||
    !isSha256(value.snapshotDigest) ||
    !isSha256(value.receiveReceiptSha256) ||
    !isSha256(value.preparedManifestSha256) ||
    (value.state !== 'prepared' &&
      value.state !== 'decision_written' &&
      value.state !== 'reconciled')
  ) {
    return false;
  }
  if (value.state === 'prepared') {
    return value.decisionBundleSha256 === null && value.reportSha256 === null;
  }
  if (value.state === 'decision_written') {
    return isSha256(value.decisionBundleSha256) && value.reportSha256 === null;
  }
  return isSha256(value.decisionBundleSha256) && isSha256(value.reportSha256);
}

function trustedPath(value: unknown, expectedVolumeId: string): TrustedPath | null {
  if (
    !isRecord(value) ||
    !isOpaqueIdentifier(value.stableIdentity) ||
    !isOpaqueIdentifier(value.volumeId) ||
    value.volumeId !== expectedVolumeId
  ) {
    return null;
  }
  return {
    stableIdentity: value.stableIdentity,
    volumeId: value.volumeId,
  };
}

function sameTrustedPath(left: TrustedPath, right: TrustedPath): boolean {
  return left.stableIdentity === right.stableIdentity && left.volumeId === right.volumeId;
}

function completePacketBytes(packet: PrivateAnalysisPacketV1): Uint8Array | null {
  return packet.packetState === 'complete' ? packet.privatePacketBytes : null;
}

function preparedManifestBytes(prepared: PreparedPrivateAnalysisV1): Uint8Array {
  return textEncoder.encode(JSON.stringify(prepared.manifest));
}

function worstCaseDecisionBundleBytes(prepared: PreparedPrivateAnalysisV1): Uint8Array {
  const decisionBundle = {
    schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
    preparedManifestSha256: prepared.manifestSha256,
    decisions: prepared.packets.map((packet) => ({
      schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
      analysisItemId: packet.analysisItemId,
      workflow: 'reservation_change',
      risk: 'cancellation_fee',
      confidence: 'medium',
      attention: 'human_review',
    })),
  } satisfies AnalystDecisionBundleV1;
  return textEncoder.encode(JSON.stringify(decisionBundle));
}

function stateFor(
  transferId: string,
  prepared: PreparedPrivateAnalysisV1,
  receiveReceiptSha256: string,
  state: AnalysisWorkspaceStateV1['state'],
  decisionBundleSha256: string | null,
  reportSha256: string | null,
): AnalysisWorkspaceStateV1 {
  return {
    schemaVersion: STATE_VERSION,
    transferId,
    snapshotDigest: prepared.manifest.snapshotDigest,
    receiveReceiptSha256,
    preparedManifestSha256: prepared.manifestSha256,
    state,
    decisionBundleSha256,
    reportSha256,
  };
}

function stateMatches(
  state: AnalysisWorkspaceStateV1,
  transferId: string,
  prepared: PreparedPrivateAnalysisV1,
  receiveReceiptSha256: string,
): boolean {
  return (
    isWorkspaceState(state) &&
    state.transferId === transferId &&
    state.snapshotDigest === prepared.manifest.snapshotDigest &&
    state.receiveReceiptSha256 === receiveReceiptSha256 &&
    state.preparedManifestSha256 === prepared.manifestSha256
  );
}

async function writeAndConfirmState(
  port: AnalysisWorkspacePort,
  state: AnalysisWorkspaceStateV1,
): Promise<boolean> {
  if (!(await port.writeAtomicProtectedState(state))) return false;
  const confirmed = await port.readProtectedState(state.transferId);
  return confirmed !== null && JSON.stringify(confirmed) === JSON.stringify(state);
}

async function lockAndReassertDirectory(
  acl: WindowsPrivateAcl,
  pathValue: string,
  expectedVolumeId: string,
  expectedIdentity?: TrustedPath,
): Promise<TrustedPath | null> {
  const before = trustedPath(await acl.assertTrustedPath(pathValue), expectedVolumeId);
  if (!before || (expectedIdentity && !sameTrustedPath(before, expectedIdentity))) return null;
  if (!(await acl.lockDownDirectory(pathValue))) return null;
  const after = trustedPath(await acl.assertTrustedPath(pathValue), expectedVolumeId);
  return after && sameTrustedPath(before, after) ? after : null;
}

async function lockAndReassertFile(
  acl: WindowsPrivateAcl,
  pathValue: string,
  expectedVolumeId: string,
): Promise<boolean> {
  const before = trustedPath(await acl.assertTrustedPath(pathValue), expectedVolumeId);
  if (!before || !(await acl.lockDownFiles([pathValue]))) return false;
  const after = trustedPath(await acl.assertTrustedPath(pathValue), expectedVolumeId);
  return after !== null && sameTrustedPath(before, after);
}

async function readExactPrivateFile(
  port: AnalysisWorkspacePort,
  acl: WindowsPrivateAcl,
  pathValue: string,
  expected: Uint8Array,
  expectedVolumeId: string,
): Promise<boolean> {
  const before = trustedPath(await acl.assertTrustedPath(pathValue), expectedVolumeId);
  if (!before) return false;
  const content = await port.readBoundedProtected(pathValue, expected.byteLength);
  const after = trustedPath(await acl.assertTrustedPath(pathValue), expectedVolumeId);
  return (
    content !== null &&
    after !== null &&
    sameTrustedPath(before, after) &&
    sha256(content) === sha256(expected) &&
    equalBytes(content, expected)
  );
}

async function writeOrVerifyPrivateFile(
  port: AnalysisWorkspacePort,
  pathValue: string,
  content: Uint8Array,
  expectedVolumeId: string,
): Promise<boolean> {
  await port.writeCreateNewProtected(pathValue, content);
  return (
    (await lockAndReassertFile(port.acl, pathValue, expectedVolumeId)) &&
    (await readExactPrivateFile(port, port.acl, pathValue, content, expectedVolumeId))
  );
}

async function verifyPreparedWorkspace(
  port: AnalysisWorkspacePort,
  workspace: string,
  prepared: PreparedPrivateAnalysisV1,
  expectedVolumeId: string,
): Promise<boolean> {
  const manifest = preparedManifestBytes(prepared);
  if (
    !(await readExactPrivateFile(
      port,
      port.acl,
      workspaceFilePath(workspace, 'prepared-manifest.v1.json'),
      manifest,
      expectedVolumeId,
    ))
  ) {
    return false;
  }

  for (const [index, packet] of prepared.packets.entries()) {
    const packetBytes = completePacketBytes(packet);
    if (!packetBytes) continue;
    if (
      packet.packetBytes !== packetBytes.byteLength ||
      packet.packetSha256 !== sha256(packetBytes) ||
      !(await readExactPrivateFile(
        port,
        port.acl,
        workspaceFilePath(workspace, packetRelativePath(index)),
        packetBytes,
        expectedVolumeId,
      ))
    ) {
      return false;
    }
  }
  return true;
}

async function readDecisionBundle(input: {
  port: AnalysisWorkspacePort;
  workspace: string;
  prepared: PreparedPrivateAnalysisV1;
  snapshot: PrivateThreadCorpusSnapshot;
  maxDecisionBytes: number;
  expectedVolumeId: string;
}): Promise<{ digest: string; reconciled: ReconciledAnalystDecisionsV1 } | null> {
  try {
    const decisionPath = workspaceFilePath(input.workspace, 'decision-bundle.v1.json');
    if (!(await lockAndReassertFile(input.port.acl, decisionPath, input.expectedVolumeId))) {
      return null;
    }
    const content = await input.port.readBoundedProtected(decisionPath, input.maxDecisionBytes);
    const after = trustedPath(
      await input.port.acl.assertTrustedPath(decisionPath),
      input.expectedVolumeId,
    );
    if (!content || !after) return null;
    const decoded = decodeUtf8(content);
    if (decoded === null) return null;
    const reconciled = reconcileAnalystDecisionBundle(
      input.snapshot,
      input.prepared.manifest,
      JSON.parse(decoded),
    );
    return reconciled ? { digest: sha256(content), reconciled } : null;
  } catch {
    return null;
  }
}

function isRelativeWorkspaceFile(relative: string, writable: boolean): boolean {
  if (
    relative === 'prepared-manifest.v1.json' ||
    relative === 'decision-bundle.v1.json' ||
    relative === 'aggregate-report.v1.json'
  ) {
    return !writable || relative !== 'decision-bundle.v1.json';
  }
  return /^packets\\packet-\d{6}\.v1\.json$/.test(relative);
}

function localIdentity(value: { dev: number; ino: number }): LocalIdentity {
  return {
    stableIdentity: `${String(value.dev)}:${String(value.ino)}`,
    volumeId: String(value.dev),
  };
}

function sameLocalIdentity(left: LocalIdentity, right: LocalIdentity): boolean {
  return left.stableIdentity === right.stableIdentity && left.volumeId === right.volumeId;
}

function assertLocalDirectory(directory: string): LocalIdentity {
  const stats = lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !sameWindowsPath(realpathSync.native(directory), directory)
  ) {
    throw new Error('unsafe private directory');
  }
  return localIdentity(stats);
}

function assertLocalFile(filePath: string): LocalIdentity & { bytes: number } {
  const stats = lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    !Number.isSafeInteger(stats.size) ||
    stats.size < 1 ||
    !sameWindowsPath(realpathSync.native(filePath), filePath)
  ) {
    throw new Error('unsafe private file');
  }
  return { ...localIdentity(stats), bytes: stats.size };
}

function readLocalBoundedFile(filePath: string, maxBytes: number): Uint8Array | null {
  let descriptor: number | undefined;
  try {
    if (!isBoundedPositiveSafeInteger(maxBytes, MAX_RECEIVED_BYTES)) return null;
    const before = assertLocalFile(filePath);
    if (before.bytes > maxBytes) return null;
    descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size !== before.bytes ||
      !sameLocalIdentity(before, localIdentity(opened))
    ) {
      return null;
    }
    const content = readExactBoundedDescriptor(descriptor, before.bytes);
    const after = assertLocalFile(filePath);
    const afterOpen = fstatSync(descriptor);
    if (
      !content ||
      !sameLocalIdentity(before, after) ||
      !sameLocalIdentity(before, localIdentity(afterOpen)) ||
      afterOpen.size !== before.bytes
    ) {
      return null;
    }
    return content;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function ensureLocalDirectory(directory: string): LocalIdentity {
  try {
    return assertLocalDirectory(directory);
  } catch {
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    return assertLocalDirectory(directory);
  }
}

function listSafeRelativeFiles(root: string): string[] | null {
  try {
    const result: string[] = [];
    const visit = (directory: string, prefix: string): void => {
      assertLocalDirectory(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('unsafe private entry');
        const absolute = path.win32.join(directory, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          visit(absolute, relative);
        } else if (entry.isFile()) {
          assertLocalFile(absolute);
          result.push(relative);
        } else {
          throw new Error('unsupported private entry');
        }
      }
    };
    visit(root, '');
    return result.sort(compareText);
  } catch {
    return null;
  }
}

function artifactReferencesFromCorpus(corpusJsonl: string): ArtifactReference[] | null {
  try {
    const lines = corpusJsonl.slice(0, -1).split('\n');
    if (lines.length === 0 || lines.some((line) => line.length === 0)) return null;
    JSON.parse(lines[0]!);
    const references: ArtifactReference[] = [];
    const add = (value: unknown, kind: ArtifactReference['kind']): boolean => {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ['id', 'sha256', 'bytes']) ||
        !isSha256(value.id) ||
        !isSha256(value.sha256) ||
        !isBoundedPositiveSafeInteger(value.bytes, MAX_RECEIVED_BYTES)
      ) {
        return false;
      }
      references.push({
        kind,
        id: value.id,
        sha256: value.sha256,
        bytes: value.bytes,
      });
      return true;
    };
    const inspectRows = (rows: unknown): boolean => {
      if (!Array.isArray(rows)) return false;
      for (const row of rows) {
        if (!isRecord(row)) return false;
        const privateMessage = row.privateMessage;
        if (privateMessage === undefined) continue;
        if (!isRecord(privateMessage) || !isRecord(privateMessage.rawMime)) return false;
        const rawArtifact = privateMessage.rawMime.artifact;
        if (rawArtifact !== null && !add(rawArtifact, 'raw_mime')) return false;
        if (!Array.isArray(privateMessage.attachments)) return false;
        for (const attachment of privateMessage.attachments) {
          if (!isRecord(attachment)) return false;
          const textArtifact = attachment.textArtifact;
          if (textArtifact === null) continue;
          if (!isRecord(textArtifact)) return false;
          const artifact = textArtifact.artifact;
          if (artifact !== null && !add(artifact, 'attachment_text')) return false;
        }
      }
      return true;
    };
    for (const line of lines.slice(1)) {
      const record: unknown = JSON.parse(line);
      if (!isRecord(record)) return null;
      if (record.recordType === 'thread') {
        if (!Array.isArray(record.messages)) return null;
        for (const message of record.messages) {
          if (!isRecord(message) || !inspectRows(message.sourceRows)) return null;
        }
      } else if (record.recordType === 'quarantine') {
        if (!inspectRows(record.sourceRows)) return null;
      } else {
        return null;
      }
    }
    references.sort((left, right) => {
      const leftKey = `${left.kind}\0${left.id}`;
      const rightKey = `${right.kind}\0${right.id}`;
      return compareText(leftKey, rightKey);
    });
    if (
      references.some(
        (reference, index) =>
          index > 0 &&
          reference.kind === references[index - 1]!.kind &&
          reference.id === references[index - 1]!.id,
      )
    ) {
      return null;
    }
    return references;
  } catch {
    return null;
  }
}

function artifactRelativePath(reference: ArtifactReference): string {
  return reference.kind === 'raw_mime'
    ? `raw-mime/${reference.id}.eml`
    : `attachment-text/${reference.id}.txt`;
}

function receiptMatches(input: {
  content: Uint8Array;
  transferId: string;
  snapshotId: string;
  sourceManifestSha256: string;
  memberSetSha256: string;
}): boolean {
  try {
    const decoded = decodeUtf8(input.content);
    if (decoded === null) return false;
    const parsed: unknown = JSON.parse(decoded);
    return (
      isRecord(parsed) &&
      hasExactKeys(parsed, [
        'schemaVersion',
        'transferId',
        'snapshotId',
        'sourceManifestSha256',
        'relayManifestSha256',
        'memberSetSha256',
      ]) &&
      parsed.schemaVersion === 'centurion-thread-corpus-relay-receipt-v1' &&
      parsed.transferId === input.transferId &&
      parsed.snapshotId === input.snapshotId &&
      parsed.sourceManifestSha256 === input.sourceManifestSha256 &&
      isSha256(parsed.relayManifestSha256) &&
      parsed.memberSetSha256 === input.memberSetSha256 &&
      decoded === `${JSON.stringify(parsed, null, 2)}\n`
    );
  } catch {
    return false;
  }
}

function receivedMemberSetSha256(
  corpus: Uint8Array,
  manifest: Uint8Array,
  artifacts: readonly PrivateThreadCorpusArtifactFile[],
): string {
  const members = [
    {
      path: 'corpus.jsonl',
      bytes: corpus.byteLength,
      sha256: sha256(corpus),
    },
    {
      path: 'manifest.json',
      bytes: manifest.byteLength,
      sha256: sha256(manifest),
    },
    ...artifacts.map((artifact) => ({
      path:
        artifact.kind === 'raw_mime'
          ? `raw-mime/${artifact.id}.eml`
          : `attachment-text/${artifact.id}.txt`,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
  ].sort((left, right) => compareText(left.path, right.path));
  return sha256(
    textEncoder.encode(
      members.map((member) => `${member.path}\t${member.bytes}\t${member.sha256}\n`).join(''),
    ),
  );
}

function contextFromManifest(
  manifest: Record<string, unknown>,
): PrivateThreadCorpusSnapshot['context'] | null {
  if (
    typeof manifest.snapshotId !== 'string' ||
    !isRecord(manifest.scope) ||
    !isRecord(manifest.window) ||
    typeof manifest.window.endExclusive !== 'string' ||
    typeof manifest.exporterVersion !== 'string' ||
    !isRecord(manifest.counts) ||
    typeof manifest.counts.unscopedQuarantineExcluded !== 'number' ||
    !Number.isSafeInteger(manifest.counts.unscopedQuarantineExcluded)
  ) {
    return null;
  }
  return {
    snapshotId: manifest.snapshotId,
    scope: manifest.scope as PrivateThreadCorpusSnapshot['context']['scope'],
    asOf: manifest.window.endExclusive,
    exporterVersion: manifest.exporterVersion,
    unscopedQuarantineExcluded: manifest.counts.unscopedQuarantineExcluded,
  };
}

export function parseAnalysisWorkspaceConfig(value: string): AnalysisWorkspaceConfigV1 | null {
  try {
    if (textEncoder.encode(value).byteLength > MAX_CONFIG_BYTES) return null;
    const parsed: unknown = JSON.parse(value);
    if (
      value !== JSON.stringify(parsed) ||
      !isRecord(parsed) ||
      !hasExactKeys(parsed, [
        'version',
        'checkoutRoot',
        'receivedCorpusRoot',
        'analysisRoot',
        'maxPacketBytes',
        'maxTotalPacketBytes',
        'maxDecisionBytes',
      ]) ||
      parsed.version !== CONFIG_VERSION ||
      !isCanonicalWindowsPath(parsed.checkoutRoot) ||
      !isCanonicalWindowsPath(parsed.receivedCorpusRoot) ||
      !isCanonicalWindowsPath(parsed.analysisRoot) ||
      !isBoundedPositiveSafeInteger(parsed.maxPacketBytes, MAX_PACKET_BYTES) ||
      !isBoundedPositiveSafeInteger(parsed.maxTotalPacketBytes, MAX_TOTAL_PACKET_BYTES) ||
      !isBoundedPositiveSafeInteger(parsed.maxDecisionBytes, MAX_DECISION_BYTES) ||
      !sameWindowsPath(parsed.receivedCorpusRoot, expectedReceivedRoot(parsed.checkoutRoot)) ||
      !sameWindowsPath(parsed.analysisRoot, expectedAnalysisRoot(parsed.checkoutRoot))
    ) {
      return null;
    }
    return {
      version: CONFIG_VERSION,
      checkoutRoot: parsed.checkoutRoot,
      receivedCorpusRoot: parsed.receivedCorpusRoot,
      analysisRoot: parsed.analysisRoot,
      maxPacketBytes: parsed.maxPacketBytes,
      maxTotalPacketBytes: parsed.maxTotalPacketBytes,
      maxDecisionBytes: parsed.maxDecisionBytes,
    };
  } catch {
    return null;
  }
}

export async function runCenturionThreadCorpusAnalysis(input: {
  command: unknown;
  transferId: unknown;
  port: AnalysisWorkspacePort;
}): Promise<AnalysisCliResult> {
  try {
    if (
      (input.command !== 'prepare' && input.command !== 'reconcile') ||
      !isUuidV4(input.transferId)
    ) {
      return blocked();
    }
    if (input.port.platform() !== 'win32') return blocked();
    const config = parseAnalysisWorkspaceConfig(await input.port.readProtectedConfig());
    if (!config) return blocked();
    const inspection = await input.port.inspectCheckout({
      checkoutRoot: config.checkoutRoot,
      receivedCorpusRoot: config.receivedCorpusRoot,
      analysisRoot: config.analysisRoot,
    });
    const inspected = trustedPath(inspection, inspection?.volumeId ?? '');
    if (!inspection || !inspection.gitignored || !inspected) return blocked();
    const root = await lockAndReassertDirectory(
      input.port.acl,
      config.analysisRoot,
      inspected.volumeId,
      inspected,
    );
    if (!root) return blocked();

    const existing = await input.port.readProtectedState(input.transferId);
    if (existing !== null && !isWorkspaceState(existing)) return blocked();
    if (input.command === 'reconcile' && existing === null) return blocked();

    const received = await input.port.readVerifiedReceivedSnapshot(input.transferId);
    const expectedReceivedPath = path.win32.join(config.receivedCorpusRoot, input.transferId);
    if (
      !received ||
      !isSha256(received.snapshotDigest) ||
      !isSha256(received.receiveReceiptSha256) ||
      !isCanonicalWindowsPath(received.canonicalPath) ||
      !sameWindowsPath(received.canonicalPath, expectedReceivedPath) ||
      !isOpaqueIdentifier(received.stableIdentity) ||
      !isOpaqueIdentifier(received.volumeId) ||
      received.volumeId !== root.volumeId
    ) {
      return blocked();
    }
    const receivedBefore = trustedPath(
      await input.port.acl.assertTrustedPath(received.canonicalPath),
      root.volumeId,
    );
    if (
      !receivedBefore ||
      receivedBefore.stableIdentity !== received.stableIdentity ||
      !(await input.port.acl.lockDownDirectory(received.canonicalPath))
    ) {
      return blocked();
    }
    const receivedAfter = trustedPath(
      await input.port.acl.assertTrustedPath(received.canonicalPath),
      root.volumeId,
    );
    if (!receivedAfter || !sameTrustedPath(receivedBefore, receivedAfter)) return blocked();

    const prepared = preparePrivateAnalysis(received.snapshot, {
      maxPacketBytes: config.maxPacketBytes,
      maxTotalPacketBytes: config.maxTotalPacketBytes,
    });
    if (
      !prepared ||
      prepared.packets.length > MAX_PACKET_FILES ||
      prepared.manifest.snapshotDigest !== received.snapshotDigest ||
      preparedManifestBytes(prepared).byteLength > MAX_MANIFEST_BYTES ||
      worstCaseDecisionBundleBytes(prepared).byteLength > config.maxDecisionBytes
    ) {
      return blocked();
    }

    if (
      existing &&
      !stateMatches(existing, input.transferId, prepared, received.receiveReceiptSha256)
    ) {
      return blocked();
    }
    const workspace = await input.port.createProtectedWorkspace({
      snapshotDigest: received.snapshotDigest,
      receiveReceiptSha256: received.receiveReceiptSha256,
      expectedVolumeId: root.volumeId,
    });
    const expectedWorkspace = expectedWorkspacePath(
      config.analysisRoot,
      received.snapshotDigest,
      received.receiveReceiptSha256,
    );
    if (
      !workspace ||
      !isCanonicalWindowsPath(workspace.path) ||
      !sameWindowsPath(workspace.path, expectedWorkspace) ||
      !isOpaqueIdentifier(workspace.stableIdentity) ||
      workspace.volumeId !== root.volumeId
    ) {
      return blocked();
    }
    const trustedWorkspace = await lockAndReassertDirectory(
      input.port.acl,
      workspace.path,
      root.volumeId,
      {
        stableIdentity: workspace.stableIdentity,
        volumeId: workspace.volumeId,
      },
    );
    if (!trustedWorkspace) return blocked();

    if (input.command === 'prepare') {
      if (existing) {
        if (existing.state !== 'prepared') return blocked();
        return (await verifyPreparedWorkspace(input.port, workspace.path, prepared, root.volumeId))
          ? { outcome: 'prepared' }
          : blocked();
      }

      for (const [index, packet] of prepared.packets.entries()) {
        const packetBytes = completePacketBytes(packet);
        if (!packetBytes) continue;
        if (
          packet.packetBytes !== packetBytes.byteLength ||
          packet.packetSha256 !== sha256(packetBytes) ||
          !(await writeOrVerifyPrivateFile(
            input.port,
            workspaceFilePath(workspace.path, packetRelativePath(index)),
            packetBytes,
            root.volumeId,
          ))
        ) {
          return blocked();
        }
      }
      if (
        !(await writeOrVerifyPrivateFile(
          input.port,
          workspaceFilePath(workspace.path, 'prepared-manifest.v1.json'),
          preparedManifestBytes(prepared),
          root.volumeId,
        )) ||
        !(await writeAndConfirmState(
          input.port,
          stateFor(
            input.transferId,
            prepared,
            received.receiveReceiptSha256,
            'prepared',
            null,
            null,
          ),
        ))
      ) {
        return blocked();
      }
      return { outcome: 'prepared' };
    }

    if (
      !existing ||
      !(await verifyPreparedWorkspace(input.port, workspace.path, prepared, root.volumeId))
    ) {
      return blocked();
    }
    const decision = await readDecisionBundle({
      port: input.port,
      workspace: workspace.path,
      prepared,
      snapshot: received.snapshot,
      maxDecisionBytes: config.maxDecisionBytes,
      expectedVolumeId: root.volumeId,
    });
    if (!decision) return blocked();

    if (existing.state === 'prepared') {
      if (
        !(await writeAndConfirmState(
          input.port,
          stateFor(
            input.transferId,
            prepared,
            received.receiveReceiptSha256,
            'decision_written',
            decision.digest,
            null,
          ),
        ))
      ) {
        return blocked();
      }
    } else if (existing.decisionBundleSha256 !== decision.digest) {
      return blocked();
    }

    const report = buildCenturionCorpusEvidenceReport(received.snapshot, decision.reconciled);
    if (!report) return blocked();
    const reportBytes = textEncoder.encode(JSON.stringify(report));
    const reportDigest = sha256(reportBytes);
    const reportPath = workspaceFilePath(workspace.path, 'aggregate-report.v1.json');
    if (existing.state === 'reconciled') {
      return existing.reportSha256 === reportDigest &&
        (await readExactPrivateFile(
          input.port,
          input.port.acl,
          reportPath,
          reportBytes,
          root.volumeId,
        ))
        ? { outcome: 'reconciled' }
        : blocked();
    }
    if (
      !(await writeOrVerifyPrivateFile(input.port, reportPath, reportBytes, root.volumeId)) ||
      !(await writeAndConfirmState(
        input.port,
        stateFor(
          input.transferId,
          prepared,
          received.receiveReceiptSha256,
          'reconciled',
          decision.digest,
          reportDigest,
        ),
      ))
    ) {
      return blocked();
    }
    return { outcome: 'reconciled' };
  } catch {
    return blocked();
  }
}

class WindowsAnalysisWorkspacePort implements AnalysisWorkspacePort {
  readonly acl: WindowsPrivateAcl;
  private readonly workspaces = new Set<string>();

  constructor(
    private readonly checkoutRoot: string,
    acl: WindowsPrivateAcl = createWindowsPrivateAcl(),
    private readonly gitIgnoreRunner: GitIgnoreRunner = createFixedGitIgnoreRunner(),
  ) {
    this.acl = acl;
  }

  platform(): string {
    return process.platform;
  }

  async readProtectedConfig(): Promise<string> {
    try {
      if (process.platform !== 'win32' || !isCanonicalWindowsPath(this.checkoutRoot)) {
        throw new Error('unsupported platform');
      }
      const analysisRoot = expectedAnalysisRoot(this.checkoutRoot);
      const configPath = path.win32.join(analysisRoot, 'analysis-workspace-config.v1.json');
      const checkoutBefore = assertLocalDirectory(this.checkoutRoot);
      const privateBefore = assertLocalDirectory(path.win32.join(this.checkoutRoot, '.private'));
      const analysisBefore = assertLocalDirectory(analysisRoot);
      const content = readLocalBoundedFile(configPath, MAX_CONFIG_BYTES);
      if (
        !content ||
        !sameLocalIdentity(checkoutBefore, assertLocalDirectory(this.checkoutRoot)) ||
        !sameLocalIdentity(
          privateBefore,
          assertLocalDirectory(path.win32.join(this.checkoutRoot, '.private')),
        ) ||
        !sameLocalIdentity(analysisBefore, assertLocalDirectory(analysisRoot))
      ) {
        throw new Error('protected config unavailable');
      }
      const decoded = decodeUtf8(content);
      if (decoded === null) throw new Error('protected config unavailable');
      return decoded;
    } catch {
      throw new Error('protected config unavailable');
    }
  }

  async inspectCheckout(input: {
    checkoutRoot: string;
    receivedCorpusRoot: string;
    analysisRoot: string;
  }): Promise<{ gitignored: boolean; stableIdentity: string; volumeId: string } | null> {
    try {
      if (
        process.platform !== 'win32' ||
        !sameWindowsPath(input.checkoutRoot, this.checkoutRoot) ||
        !sameWindowsPath(input.receivedCorpusRoot, expectedReceivedRoot(this.checkoutRoot)) ||
        !sameWindowsPath(input.analysisRoot, expectedAnalysisRoot(this.checkoutRoot))
      ) {
        return null;
      }
      const checkout = assertLocalDirectory(input.checkoutRoot);
      const privateRoot = assertLocalDirectory(path.win32.join(input.checkoutRoot, '.private'));
      const received = assertLocalDirectory(input.receivedCorpusRoot);
      const analysis = assertLocalDirectory(input.analysisRoot);
      if (
        checkout.volumeId !== privateRoot.volumeId ||
        checkout.volumeId !== received.volumeId ||
        checkout.volumeId !== analysis.volumeId ||
        !(await this.hasRequiredIgnoredRoots(input.checkoutRoot))
      ) {
        return null;
      }
      return { gitignored: true, ...analysis };
    } catch {
      return null;
    }
  }

  async readVerifiedReceivedSnapshot(
    transferId: string,
  ): Promise<VerifiedReceivedAnalysisInput | null> {
    try {
      if (process.platform !== 'win32' || !isUuidV4(transferId)) return null;
      const receivedRoot = expectedReceivedRoot(this.checkoutRoot);
      const transferPath = path.win32.join(receivedRoot, transferId);
      if (path.win32.dirname(transferPath) !== receivedRoot) return null;
      const rootLocal = assertLocalDirectory(receivedRoot);
      const beforeLocal = assertLocalDirectory(transferPath);
      const rootAcl = await this.acl.assertTrustedPath(receivedRoot);
      const beforeAcl = await this.acl.assertTrustedPath(transferPath);
      if (
        !rootAcl ||
        !beforeAcl ||
        rootAcl.volumeId !== beforeAcl.volumeId ||
        beforeAcl.volumeId !== rootLocal.volumeId
      ) {
        return null;
      }

      const manifestPath = path.win32.join(transferPath, 'manifest.json');
      const corpusPath = path.win32.join(transferPath, 'corpus.jsonl');
      const receiptPath = path.win32.join(transferPath, 'receive-receipt.v1.json');
      const manifestBytes = readLocalBoundedFile(manifestPath, MAX_MANIFEST_BYTES);
      const corpusBytes = readLocalBoundedFile(corpusPath, MAX_RECEIVED_BYTES);
      const receiptBytes = readLocalBoundedFile(receiptPath, MAX_RECEIPT_BYTES);
      if (!manifestBytes || !corpusBytes || !receiptBytes) return null;
      const manifestText = decodeUtf8(manifestBytes);
      const corpusText = decodeUtf8(corpusBytes);
      if (manifestText === null || corpusText === null) return null;
      const manifest: unknown = JSON.parse(manifestText);
      if (!isRecord(manifest)) return null;
      const context = contextFromManifest(manifest);
      const references = artifactReferencesFromCorpus(corpusText);
      if (!context || !references) return null;

      let usedBytes = manifestBytes.byteLength + corpusBytes.byteLength + receiptBytes.byteLength;
      const artifacts: PrivateThreadCorpusArtifactFile[] = [];
      for (const reference of references) {
        if (reference.bytes > MAX_RECEIVED_BYTES - usedBytes) return null;
        const artifactPath = path.win32.join(
          transferPath,
          ...artifactRelativePath(reference).split('/'),
        );
        const content = readLocalBoundedFile(artifactPath, reference.bytes);
        if (
          !content ||
          content.byteLength !== reference.bytes ||
          sha256(content) !== reference.sha256
        ) {
          return null;
        }
        usedBytes += content.byteLength;
        artifacts.push({
          kind: reference.kind,
          id: reference.id,
          sha256: reference.sha256,
          bytes: reference.bytes,
          content,
        });
      }
      const expectedInventory = [
        'corpus.jsonl',
        'manifest.json',
        'receive-receipt.v1.json',
        ...references.map(artifactRelativePath),
      ].sort(compareText);
      const actualInventory = listSafeRelativeFiles(transferPath);
      if (
        !actualInventory ||
        actualInventory.length !== expectedInventory.length ||
        actualInventory.some((entry, index) => entry !== expectedInventory[index])
      ) {
        return null;
      }
      const sourceManifestSha256 = sha256(manifestBytes);
      const memberSetSha256 = receivedMemberSetSha256(corpusBytes, manifestBytes, artifacts);
      if (
        !receiptMatches({
          content: receiptBytes,
          transferId,
          snapshotId: context.snapshotId,
          sourceManifestSha256,
          memberSetSha256,
        })
      ) {
        return null;
      }

      const snapshot: PrivateThreadCorpusSnapshot = {
        context,
        corpusJsonl: corpusText,
        manifestJson: manifestText,
        manifest: manifest as PrivateThreadCorpusSnapshot['manifest'],
        artifactFiles: artifacts,
      };
      validatePrivateThreadCorpusSnapshot(snapshot);
      const prepared = preparePrivateAnalysis(snapshot, {
        maxPacketBytes: 1,
        maxTotalPacketBytes: 1,
      });
      if (!prepared) return null;
      const afterLocal = assertLocalDirectory(transferPath);
      const afterAcl = await this.acl.assertTrustedPath(transferPath);
      if (
        !sameLocalIdentity(beforeLocal, afterLocal) ||
        !afterAcl ||
        afterAcl.stableIdentity !== beforeAcl.stableIdentity ||
        afterAcl.volumeId !== beforeAcl.volumeId
      ) {
        return null;
      }
      return {
        snapshot,
        snapshotDigest: prepared.manifest.snapshotDigest,
        receiveReceiptSha256: sha256(receiptBytes),
        canonicalPath: transferPath,
        stableIdentity: beforeAcl.stableIdentity,
        volumeId: beforeAcl.volumeId,
      };
    } catch {
      return null;
    }
  }

  async createProtectedWorkspace(input: {
    snapshotDigest: string;
    receiveReceiptSha256: string;
    expectedVolumeId: string;
  }): Promise<{ path: string; stableIdentity: string; volumeId: string } | null> {
    try {
      if (
        process.platform !== 'win32' ||
        !isSha256(input.snapshotDigest) ||
        !isSha256(input.receiveReceiptSha256) ||
        !isOpaqueIdentifier(input.expectedVolumeId)
      ) {
        return null;
      }
      const analysisRoot = expectedAnalysisRoot(this.checkoutRoot);
      const rootAcl = await this.acl.assertTrustedPath(analysisRoot);
      if (!rootAcl || rootAcl.volumeId !== input.expectedVolumeId) return null;
      const workspacesRoot = path.win32.join(analysisRoot, 'workspaces');
      ensureLocalDirectory(workspacesRoot);
      const workspacesAcl = await this.acl.assertTrustedPath(workspacesRoot);
      if (
        !workspacesAcl ||
        workspacesAcl.volumeId !== rootAcl.volumeId ||
        !(await this.acl.lockDownDirectory(workspacesRoot))
      ) {
        return null;
      }
      const workspace = expectedWorkspacePath(
        analysisRoot,
        input.snapshotDigest,
        input.receiveReceiptSha256,
      );
      if (path.win32.dirname(workspace) !== workspacesRoot) return null;
      ensureLocalDirectory(workspace);
      const before = await this.acl.assertTrustedPath(workspace);
      if (
        !before ||
        before.volumeId !== rootAcl.volumeId ||
        !(await this.acl.lockDownDirectory(workspace))
      ) {
        return null;
      }
      const after = await this.acl.assertTrustedPath(workspace);
      if (
        !after ||
        after.stableIdentity !== before.stableIdentity ||
        after.volumeId !== before.volumeId
      ) {
        return null;
      }
      this.workspaces.add(workspace);
      return { path: workspace, stableIdentity: after.stableIdentity, volumeId: after.volumeId };
    } catch {
      return null;
    }
  }

  async writeCreateNewProtected(pathValue: string, content: Uint8Array): Promise<boolean> {
    let descriptor: number | undefined;
    try {
      const workspace = this.workspaceForPath(pathValue);
      const relative = path.win32.relative(workspace, pathValue);
      if (
        !content.byteLength ||
        !isRelativeWorkspaceFile(relative, true) ||
        !this.ensurePrivateParent(workspace, pathValue)
      ) {
        return false;
      }
      descriptor = openSync(
        pathValue,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size !== content.byteLength) return false;
      closeSync(descriptor);
      descriptor = undefined;
      return (
        assertLocalFile(pathValue).bytes === content.byteLength &&
        (await this.lockAndReassertLocalFile(pathValue))
      );
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {}
      }
    }
  }

  async readBoundedProtected(pathValue: string, maxBytes: number): Promise<Uint8Array | null> {
    try {
      const workspace = this.workspaceForPath(pathValue);
      const relative = path.win32.relative(workspace, pathValue);
      if (
        !isBoundedPositiveSafeInteger(maxBytes, MAX_RECEIVED_BYTES) ||
        !isRelativeWorkspaceFile(relative, false)
      ) {
        return null;
      }
      const before = await this.acl.assertTrustedPath(pathValue);
      if (!before) return null;
      const content = readLocalBoundedFile(pathValue, maxBytes);
      const after = await this.acl.assertTrustedPath(pathValue);
      return content &&
        after &&
        before.stableIdentity === after.stableIdentity &&
        before.volumeId === after.volumeId
        ? content
        : null;
    } catch {
      return null;
    }
  }

  async writeAtomicProtectedState(state: AnalysisWorkspaceStateV1): Promise<boolean> {
    let descriptor: number | undefined;
    try {
      if (!isWorkspaceState(state)) return false;
      const analysisRoot = expectedAnalysisRoot(this.checkoutRoot);
      const stateRoot = path.win32.join(analysisRoot, 'state');
      ensureLocalDirectory(stateRoot);
      const stateRootAcl = await this.acl.assertTrustedPath(stateRoot);
      if (!stateRootAcl || !(await this.acl.lockDownDirectory(stateRoot))) return false;
      const finalPath = statePath(analysisRoot, state.transferId);
      if (path.win32.dirname(finalPath) !== stateRoot) return false;
      const content = textEncoder.encode(JSON.stringify(state));
      const temporaryPath = reserveUniqueStateTemporaryPath({
        finalPath,
        nextUuid: randomUUID,
        reserve: (candidate) => {
          try {
            descriptor = openSync(
              candidate,
              fsConstants.O_WRONLY |
                fsConstants.O_CREAT |
                fsConstants.O_EXCL |
                fsConstants.O_NOFOLLOW,
              0o600,
            );
            return 'reserved';
          } catch (error) {
            return isRecord(error) && error.code === 'EEXIST' ? 'collision' : 'blocked';
          }
        },
      });
      if (!temporaryPath || descriptor === undefined) return false;
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size !== content.byteLength) return false;
      closeSync(descriptor);
      descriptor = undefined;
      if (
        assertLocalFile(temporaryPath).bytes !== content.byteLength ||
        !(await this.lockAndReassertLocalFile(temporaryPath))
      ) {
        return false;
      }
      renameSync(temporaryPath, finalPath);
      if (
        assertLocalFile(finalPath).bytes !== content.byteLength ||
        !(await this.lockAndReassertLocalFile(finalPath)) ||
        !(await this.acl.fsyncReceipt(finalPath))
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {}
      }
    }
  }

  async readProtectedState(transferId: string): Promise<AnalysisWorkspaceStateV1 | null> {
    try {
      if (!isUuidV4(transferId)) throw new Error('invalid state key');
      const finalPath = statePath(expectedAnalysisRoot(this.checkoutRoot), transferId);
      let content: Uint8Array | null;
      try {
        content = readLocalBoundedFile(finalPath, MAX_MANIFEST_BYTES);
      } catch {
        throw new Error('unsafe state');
      }
      if (!content) {
        try {
          lstatSync(finalPath);
        } catch {
          return null;
        }
        throw new Error('unsafe state');
      }
      const trusted = await this.acl.assertTrustedPath(finalPath);
      const decoded = decodeUtf8(content);
      if (!trusted || decoded === null) throw new Error('unsafe state');
      const parsed: unknown = JSON.parse(decoded);
      if (!isWorkspaceState(parsed) || decoded !== JSON.stringify(parsed)) {
        throw new Error('unsafe state');
      }
      return parsed;
    } catch {
      throw new Error('unsafe state');
    }
  }

  private async hasRequiredIgnoredRoots(checkoutRoot: string): Promise<boolean> {
    return await requiredAnalysisRootsAreIgnored(checkoutRoot, this.gitIgnoreRunner);
  }

  private workspaceForPath(pathValue: string): string {
    for (const workspace of this.workspaces) {
      const relative = path.win32.relative(workspace, pathValue);
      if (relative.length > 0 && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative)) {
        return workspace;
      }
    }
    throw new Error('unknown private workspace');
  }

  private ensurePrivateParent(workspace: string, filePath: string): boolean {
    const parent = path.win32.dirname(filePath);
    const relative = path.win32.relative(workspace, parent);
    if (relative === '') return true;
    if (relative !== 'packets') return false;
    ensureLocalDirectory(parent);
    return true;
  }

  private async lockAndReassertLocalFile(filePath: string): Promise<boolean> {
    const before = await this.acl.assertTrustedPath(filePath);
    if (!before || !(await this.acl.lockDownFiles([filePath]))) return false;
    const after = await this.acl.assertTrustedPath(filePath);
    return (
      after !== null &&
      after.stableIdentity === before.stableIdentity &&
      after.volumeId === before.volumeId
    );
  }
}

function defaultCheckoutRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

export function createDefaultAnalysisWorkspacePort(
  checkoutRoot = defaultCheckoutRoot(),
  acl?: WindowsPrivateAcl,
  gitIgnoreRunner?: GitIgnoreRunner,
): AnalysisWorkspacePort {
  return new WindowsAnalysisWorkspacePort(checkoutRoot, acl, gitIgnoreRunner);
}
