/**
 * Private Playwright HMS capture spool: traces always, video for live_proof only.
 * Credential-grade — digests/paths only in receipts; never guest/mail/credential values.
 */
import {
  collectHmsStorageStateSecretValues,
  HMS_TRACE_SANITIZER_VERSION,
  HmsTracePrivacyError,
  removeNewTraceFiles,
  sanitizePlaywrightTraceFile,
  unzipBoundedTraceArchive,
  type HmsTraceSanitizationResult,
} from './trace-privacy.js';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import {
  hmsBrowserArtifactReceiptV2Schema,
  type HmsBrowserArtifactReceiptV2,
} from './release-kernel.js';
import { ExclusiveReceiptError, resolveExclusiveReceiptFile } from './receipt-exclusivity.js';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import type { DiscoveryOperationId, HmsReadToolId } from './read-tools.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { platform } from 'node:os';

export {
  collectHmsStorageStateSecretValues,
  HMS_TRACE_SANITIZER_VERSION,
  sanitizePlaywrightTraceFile,
};
export type { HmsTraceSanitizationResult };

export const HMS_BROWSER_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
export const HMS_BROWSER_CAPTURE_FINALIZE_TIMEOUT_MS = 30_000;
export const HMS_BROWSER_LIVE_PROOF_FINALIZE_TIMEOUT_MS = 120_000;
export const HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES = 256 * 1024 ** 2;
export const HMS_BROWSER_ARTIFACT_MIN_FREE_BYTES = 2 * 1024 ** 3;
export const HMS_BROWSER_ARTIFACT_MIN_LIVE_FREE_BYTES = 1 * 1024 ** 3;
export const HMS_BROWSER_CAPACITY_WATCHDOG_MS = 2_000;

export const CENTURION_HMS_PRODUCTION_ORIGIN = 'https://appsrv-1.legacyhotels.co.za' as const;

/** Infor host per browser slot. Both live hotels share appsrv-1 until a property gets its own origin. */
const HMS_PRODUCTION_ORIGIN_BY_SLOT = {
  centurion: CENTURION_HMS_PRODUCTION_ORIGIN,
  davinci: CENTURION_HMS_PRODUCTION_ORIGIN,
} as const;

export function hmsProductionOriginForSlot(slot: string): string | null {
  if (slot !== 'centurion' && slot !== 'davinci') return null;
  return HMS_PRODUCTION_ORIGIN_BY_SLOT[slot];
}

export type HmsExecutionClass = 'normal' | 'live_proof';

export type HmsBrowserAuditSpec = {
  operationId: string;
  toolId: HmsReadToolId;
  toolVersion: string;
  dependencyRevision: string;
  /** Exact source revision expected in the finalized capture receipt. */
  sourceRevision?: string;
  executionClass: HmsExecutionClass;
  inputClass: 'authorized_exact' | 'synthetic_not_found';
  roleProofSha256?: string;
  roleProofExpiresAt?: string;
  /** Closed branch identity for multi-branch audited readers. */
  requestBranchId?: string;
};

// V1 capture receipts are emitted by the registered normal browser read drivers that
// currently supply an audit spec. Keep this closed to the registered read
// shapes; a typed HmsReadToolId alone must not widen capture to other tools.
const HMS_BROWSER_V1_CAPTURE_TOOL_IDS = [
  'hms_find_reservation',
  'hms_quote_stay',
  'hms_read_folio',
  'hms_group_block_read',
] as const satisfies readonly HmsReadToolId[];
type HmsBrowserV1CaptureToolId = (typeof HMS_BROWSER_V1_CAPTURE_TOOL_IDS)[number];

function isSupportedHmsBrowserV1Tool(toolId: HmsReadToolId): toolId is HmsBrowserV1CaptureToolId {
  return (HMS_BROWSER_V1_CAPTURE_TOOL_IDS as readonly string[]).includes(toolId);
}

export type HmsBrowserArtifactReceiptBaseV1 = {
  schemaVersion: 1;
  artifactId: string;
  operationId: string;
  sourceRevision: string;
  toolId: HmsBrowserV1CaptureToolId;
  toolVersion: string;
  dependencyRevision: string;
  playwrightRevision: string;
  chromiumRevision: string;
  executionClass: HmsExecutionClass;
  inputClass: 'authorized_exact' | 'synthetic_not_found';
  credentialMode: 'view_only';
  roleProofSha256: string | null;
  roleProofExpiresAt: string | null;
  requestBranchId?: string | null;
  operationOutcome:
    | 'succeeded'
    | 'unverified_negative'
    | 'business_not_found'
    | 'failed'
    | 'timed_out'
    | 'aborted'
    | 'policy_blocked';
  requestRules: Array<{
    ruleId: string;
    count: number;
  }>;
  blockedRequests: number;
  mutationRequests: number;
  popupCount: number;
  downloadCount: number;
  webSocketCount: number;
  milestones: Partial<
    Record<
      | 'traceStartedAt'
      | 'loginStartedAt'
      | 'toolStartedAt'
      | 'toolFinishedAt'
      | 'traceStoppedAt'
      | 'contextClosedAt',
      string
    >
  >;
  terminalCode:
    | 'OK'
    | 'UNVERIFIED_NEGATIVE'
    | 'BUSINESS_NOT_FOUND'
    | 'TOOL_ERROR'
    | 'ABORTED'
    | 'TIMEOUT'
    | 'POLICY_BLOCK'
    | 'CAPTURE_CAPACITY_EXCEEDED'
    | 'TRACE_START_FAILED'
    | 'TRACE_FINALIZE_FAILED'
    | 'VIDEO_FINALIZE_FAILED'
    | 'CONTEXT_CLOSE_FAILED';
  terminalStage:
    | 'preflight'
    | 'context_create'
    | 'trace_start'
    | 'login'
    | 'tool'
    | 'trace_stop'
    | 'context_close'
    | 'video_finalize'
    | 'receipt_finalize';
  expiresAt: string;
};

export type HmsBrowserArtifactReceiptV1 =
  | (HmsBrowserArtifactReceiptBaseV1 & {
      artifactState: 'complete';
      trace: { sha256: string; bytes: number };
      video: { sha256: string; bytes: number } | null;
    })
  | (HmsBrowserArtifactReceiptBaseV1 & {
      artifactState: 'incomplete';
      trace: { sha256: string; bytes: number } | null;
      video: { sha256: string; bytes: number } | null;
    });

export type { HmsBrowserArtifactReceiptV2 };

type ReceiptV2CommonInput = {
  artifactId: string;
  operationId: string;
  toolId: HmsReadToolId;
  discoveryOperationId: DiscoveryOperationId;
  toolVersion: string;
  sourceRevision: string;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  privateDigestKeyVersion: string;
  traceSha256: string;
  videoSha256: string | null;
  operationOutcome: HmsBrowserArtifactReceiptV2['operationOutcome'];
  expiresAt: string;
};

/** Build/validate discovery receipt v2 — Phase A find writers stay on v1. */
export function buildDiscoveryReceiptV2(
  input: ReceiptV2CommonInput & {
    structuralSignatureSha256: string;
    candidateSnapshotSha256: string | null;
  },
): HmsBrowserArtifactReceiptV2 {
  return hmsBrowserArtifactReceiptV2Schema.parse({
    schemaVersion: 2,
    executionClass: 'discovery',
    artifactId: input.artifactId,
    operationId: input.operationId,
    toolId: input.toolId,
    discoveryOperationId: input.discoveryOperationId,
    toolVersion: input.toolVersion,
    sourceRevision: input.sourceRevision,
    credentialVersionHmacSha256: input.credentialVersionHmacSha256,
    runtimeFingerprintSha256: input.runtimeFingerprintSha256,
    privateDigestKeyVersion: input.privateDigestKeyVersion,
    traceSha256: input.traceSha256,
    videoSha256: input.videoSha256,
    operationOutcome: input.operationOutcome,
    expiresAt: input.expiresAt,
    structuralSignatureSha256: input.structuralSignatureSha256,
    candidateSnapshotSha256: input.candidateSnapshotSha256,
  });
}

/** Build/validate proof receipt v2 — requires proof-only fields. */
export function buildProofReceiptV2(
  input: ReceiptV2CommonInput & {
    requestBranchId: string;
    candidateSnapshotSha256: string;
    candidateHmacSha256: string;
    scopeHmacSha256: string;
    resultHmacSha256: string;
    sourceRefHmacSha256: string;
    roleProofSha256: string;
    discoveryReceiptSha256: string;
    oracleArtifactSha256: string;
  },
): HmsBrowserArtifactReceiptV2 {
  return hmsBrowserArtifactReceiptV2Schema.parse({
    schemaVersion: 2,
    executionClass: 'proof',
    artifactId: input.artifactId,
    operationId: input.operationId,
    toolId: input.toolId,
    discoveryOperationId: input.discoveryOperationId,
    toolVersion: input.toolVersion,
    sourceRevision: input.sourceRevision,
    credentialVersionHmacSha256: input.credentialVersionHmacSha256,
    runtimeFingerprintSha256: input.runtimeFingerprintSha256,
    privateDigestKeyVersion: input.privateDigestKeyVersion,
    traceSha256: input.traceSha256,
    videoSha256: input.videoSha256,
    operationOutcome: input.operationOutcome,
    expiresAt: input.expiresAt,
    requestBranchId: input.requestBranchId,
    candidateSnapshotSha256: input.candidateSnapshotSha256,
    candidateHmacSha256: input.candidateHmacSha256,
    scopeHmacSha256: input.scopeHmacSha256,
    resultHmacSha256: input.resultHmacSha256,
    sourceRefHmacSha256: input.sourceRefHmacSha256,
    roleProofSha256: input.roleProofSha256,
    discoveryReceiptSha256: input.discoveryReceiptSha256,
    oracleArtifactSha256: input.oracleArtifactSha256,
  });
}

/** Persist receipt.v2.json beside an artifact directory (exclusive with v1). */
export async function writeBrowserArtifactReceiptV2(
  artifactDir: string,
  receipt: HmsBrowserArtifactReceiptV2,
): Promise<string> {
  const parsed = hmsBrowserArtifactReceiptV2Schema.parse(receipt);
  // Match exclusivity contract: refuse dual receipt at write if v1 already present.
  const v1Path = join(artifactDir, 'receipt.v1.json');
  const v1Info = await lstat(v1Path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (v1Info) {
    throw new ExclusiveReceiptError('dual');
  }
  const receiptPath = join(artifactDir, 'receipt.v2.json');
  const body = `${JSON.stringify(parsed)}\n`;
  const fh = await open(receiptPath, 'w', 0o600);
  try {
    await fh.writeFile(body, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (platform() !== 'win32') {
    await chmod(receiptPath, 0o600);
  }
  return receiptPath;
}

export class HmsBrowserArtifactError extends Error {
  readonly code:
    | 'TRACE_STORAGE_UNAVAILABLE'
    | 'TRACE_START_FAILED'
    | 'TRACE_FINALIZE_FAILED'
    | 'VIDEO_FINALIZE_FAILED'
    | 'TRACE_PRIVACY_FAILED'
    | 'CAPTURE_CAPACITY_EXCEEDED'
    | 'PRODUCTION_ORIGIN_MISMATCH';

  constructor(code: HmsBrowserArtifactError['code'], message?: string) {
    super(message ?? code);
    this.name = 'HmsBrowserArtifactError';
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORBIDDEN_RECEIPT_KEYS = new Set([
  'username',
  'password',
  'candidate',
  'candidateId',
  'guest',
  'email',
  'threadId',
  'messageId',
  'confirmation',
  'loginUrl',
  'postData',
  'cookie',
  'authorization',
]);

export type HmsBrowserArtifactStore = {
  root: string;
  intermediateDir: string;
  beginCapture(spec: HmsBrowserAuditSpec): Promise<HmsBrowserCaptureHandle>;
  purgeExpired(now?: Date): Promise<number>;
};

export type HmsBrowserCaptureHandle = {
  artifactId: string;
  stagingDir: string;
  videoDir: string | null;
  /** Operation-owned offline/native staging namespace. */
  tracesDir: string;
  /** Launch-level native namespace used by the reused browser process. */
  nativeTracesDir: string;
  /** Stable per-capture native trace name used to claim launch-level files. */
  nativeTraceName: string;
  addSecretValues(values: readonly string[]): void;
  /** Synchronously poison publication before a timed-out producer can win. */
  invalidate(): void;
  markMilestone(key: keyof HmsBrowserArtifactReceiptBaseV1['milestones'], at?: Date): void;
  observeStagedBytes(): Promise<number>;
  observeFreeBytes(): Promise<number>;
  finalize(input: {
    signal?: AbortSignal;
    outcome: HmsBrowserArtifactReceiptBaseV1['operationOutcome'];
    terminalCode: HmsBrowserArtifactReceiptBaseV1['terminalCode'];
    terminalStage: HmsBrowserArtifactReceiptBaseV1['terminalStage'];
    sourceRevision: string;
    playwrightRevision: string;
    chromiumRevision: string;
    requestRules: Array<{ ruleId: string; count: number }>;
    blockedRequests: number;
    mutationRequests: number;
    popupCount: number;
    downloadCount: number;
    webSocketCount: number;
    complete: boolean;
  }): Promise<HmsBrowserArtifactReceiptV1>;
  abandon(): Promise<void>;
};

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE', `invalid ${label}`);
  }
}

async function fileDigest(path: string): Promise<{
  sha256: string;
  bytes: number;
}> {
  const info = await stat(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), bytes: info.size };
}

async function assertSafeRoot(root: string): Promise<string> {
  const lexicalRoot = isAbsolute(root) ? root : `${process.cwd()}${sep}${root}`;
  const parsedRoot = parse(lexicalRoot).root;
  let lexicalCurrent = parsedRoot;
  for (const segment of lexicalRoot
    .slice(parsedRoot.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    if (segment === '.') continue;
    if (segment === '..') {
      lexicalCurrent = dirname(lexicalCurrent);
      continue;
    }
    lexicalCurrent = join(lexicalCurrent, segment);
    let component;
    try {
      component = await lstat(lexicalCurrent);
    } catch {
      throw new HmsBrowserArtifactError(
        'TRACE_STORAGE_UNAVAILABLE',
        'artifact path component missing',
      );
    }
    if (component.isSymbolicLink()) {
      throw new HmsBrowserArtifactError(
        'TRACE_STORAGE_UNAVAILABLE',
        'artifact path contains symlink',
      );
    }
  }
  let st;
  try {
    st = await lstat(root);
  } catch {
    throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE', 'artifact root missing');
  }
  if (st.isSymbolicLink()) {
    throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE', 'artifact root is symlink');
  }
  if (!st.isDirectory()) {
    throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE', 'artifact root not directory');
  }
  const resolved = await realpath(root);
  if (platform() !== 'win32') {
    const currentUid = process.getuid?.();
    let current = resolved;
    while (true) {
      const currentStat = await lstat(current);
      if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
        throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE', 'unsafe artifact ancestor');
      }
      if (currentUid != null && currentStat.uid !== currentUid && currentStat.uid !== 0) {
        throw new HmsBrowserArtifactError(
          'TRACE_STORAGE_UNAVAILABLE',
          'artifact ancestor owner mismatch',
        );
      }
      const ancestorMode = currentStat.mode & 0o7777;
      const trustedSticky = (ancestorMode & 0o1000) !== 0 && currentStat.uid === 0;
      if (current !== resolved && (ancestorMode & 0o022) !== 0 && !trustedSticky) {
        throw new HmsBrowserArtifactError(
          'TRACE_STORAGE_UNAVAILABLE',
          'artifact ancestor is group/world writable',
        );
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const mode = st.mode & 0o777;
    if (mode !== 0o700) {
      throw new HmsBrowserArtifactError(
        'TRACE_STORAGE_UNAVAILABLE',
        `artifact root mode ${mode.toString(8)} != 700`,
      );
    }
  }
  return resolved;
}

async function directoryBytes(dir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === '.capture-owner.v1.json') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(full);
    } else if (entry.isFile()) {
      const s = await stat(full);
      total += s.size;
    }
  }
  return total;
}

async function directoryFileSizes(
  dir: string,
  out = new Map<string, number>(),
): Promise<Map<string, number>> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await directoryFileSizes(full, out);
    } else if (entry.isFile()) {
      out.set(full, (await stat(full)).size);
    }
  }
  return out;
}

type TraceFileFingerprint = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

async function directoryFileFingerprints(
  dir: string,
  out = new Map<string, TraceFileFingerprint>(),
): Promise<Map<string, TraceFileFingerprint>> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await directoryFileFingerprints(full, out);
    } else if (entry.isFile()) {
      const info = await lstat(full);
      out.set(full, {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    } else if (entry.isSymbolicLink()) {
      throw new HmsBrowserArtifactError(
        'TRACE_STORAGE_UNAVAILABLE',
        'symbolic link in native trace namespace',
      );
    }
  }
  return out;
}

function sameTraceFileFingerprint(
  left: TraceFileFingerprint | undefined,
  right: TraceFileFingerprint | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs,
  );
}

async function removeOwnedCaptureFiles(input: {
  operationDir: string;
  nativeDir: string;
  artifactId: string;
  baseline: ReadonlyMap<string, TraceFileFingerprint>;
  activeOwnerIds: ReadonlySet<string>;
  allowOtherOwners: boolean;
}): Promise<void> {
  // The operation namespace is exclusively owned. A missing namespace is a
  // failed cleanup proof, not an empty directory to silently accept.
  await removeNewTraceFiles(input.operationDir, new Map());
  await rm(input.operationDir, { recursive: true, force: false });

  const current = await directoryFileFingerprints(input.nativeDir);
  const operationPrefix = `${input.operationDir}${sep}`;
  for (const [path, fingerprint] of current) {
    if (path.startsWith(operationPrefix)) continue;
    const baseline = input.baseline.get(path);
    const changed = baseline !== undefined && !sameTraceFileFingerprint(baseline, fingerprint);
    const created = baseline === undefined;
    const ownerMatch = path.includes(input.artifactId);
    if (ownerMatch && (created || changed)) {
      await rm(path, { force: false });
      continue;
    }
    if (!created && !changed) continue;

    const belongsToAnotherOwner = [...input.activeOwnerIds].some(
      (ownerId) => ownerId !== input.artifactId && path.includes(ownerId),
    );
    if (belongsToAnotherOwner || input.allowOtherOwners) continue;
    throw new HmsBrowserArtifactError(
      'TRACE_FINALIZE_FAILED',
      'native trace ownership or cleanup could not be proven',
    );
  }

  const remaining = await directoryFileFingerprints(input.nativeDir);
  for (const path of remaining.keys()) {
    if (path.includes(input.artifactId)) {
      throw new HmsBrowserArtifactError(
        'TRACE_FINALIZE_FAILED',
        'owned native trace remained after cleanup',
      );
    }
  }
}

async function directoryGrowthBytes(
  dir: string,
  baseline: ReadonlyMap<string, number>,
): Promise<number> {
  const current = await directoryFileSizes(dir);
  let growth = 0;
  for (const [path, bytes] of current) {
    growth += Math.max(0, bytes - (baseline.get(path) ?? 0));
  }
  return growth;
}

function hasBytes(haystack: Buffer, needle: readonly number[]): boolean {
  return haystack.indexOf(Buffer.from(needle)) >= 0;
}

async function isTraceZip(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const info = await fh.stat();
    if (info.size < 26) return false;
    const first = Buffer.alloc(4);
    await fh.read(first, 0, first.length, 0);
    const tailLength = Math.min(info.size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await fh.read(tail, 0, tail.length, info.size - tailLength);
    return (
      first.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
      hasBytes(tail, [0x50, 0x4b, 0x05, 0x06])
    );
  } finally {
    await fh.close();
  }
}

type EbmlElement = {
  id: number;
  dataStart: number;
  dataEnd: number;
  declaredEnd: number;
  complete: boolean;
  unknownSize: boolean;
};

function readEbmlVint(
  bytes: Buffer,
  offset: number,
  preserveMarker: boolean,
  maxLength: number,
): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[offset];
  if (first == null || first === 0) return null;
  let marker = 0x80;
  let length = 1;
  while ((first & marker) === 0 && length <= maxLength) {
    marker >>= 1;
    length += 1;
  }
  if (length > maxLength || offset + length > bytes.length) return null;
  let value = preserveMarker ? first : first & (marker - 1);
  let unknown = !preserveMarker && (first & (marker - 1)) === marker - 1;
  for (let index = 1; index < length; index += 1) {
    const next = bytes[offset + index]!;
    value = value * 256 + next;
    unknown = unknown && next === 0xff;
    if (!Number.isSafeInteger(value)) return null;
  }
  return { value, length, unknown };
}

function readEbmlElement(
  bytes: Buffer,
  offset: number,
  parentEnd = bytes.length,
): EbmlElement | null {
  const id = readEbmlVint(bytes, offset, true, 4);
  if (!id) return null;
  const size = readEbmlVint(bytes, offset + id.length, false, 8);
  if (!size) return null;
  const dataStart = offset + id.length + size.length;
  if (dataStart > parentEnd) return null;
  const declaredEnd = size.unknown ? parentEnd : dataStart + size.value;
  if (!Number.isSafeInteger(declaredEnd) || declaredEnd < dataStart) return null;
  return {
    id: id.value,
    dataStart,
    dataEnd: Math.min(declaredEnd, parentEnd),
    declaredEnd,
    complete: size.unknown || declaredEnd <= parentEnd,
    unknownSize: size.unknown,
  };
}

function parseEbmlChildren(
  bytes: Buffer,
  start: number,
  end: number,
): { elements: EbmlElement[]; complete: boolean } {
  const children: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    const element = readEbmlElement(bytes, offset, end);
    if (!element) return { elements: children, complete: false };
    children.push(element);
    if (!element.complete || element.declaredEnd <= offset) {
      return { elements: children, complete: false };
    }
    offset = element.declaredEnd;
  }
  return { elements: children, complete: offset === end };
}

function ebmlChildren(bytes: Buffer, start: number, end: number): EbmlElement[] {
  return parseEbmlChildren(bytes, start, end).elements;
}

function parseVp8Block(
  bytes: Buffer,
  block: EbmlElement,
): { keyframe: boolean; relativeTimecode: number } | null {
  if (!block.complete) return null;
  const track = readEbmlVint(bytes, block.dataStart, true, 4);
  if (!track) return null;
  const timecodeOffset = block.dataStart + track.length;
  const frameStart = block.dataStart + track.length + 3;
  if (frameStart + 10 >= block.dataEnd) return null;
  const keyframe =
    (bytes[frameStart]! & 0x01) === 0 &&
    bytes[frameStart + 3] === 0x9d &&
    bytes[frameStart + 4] === 0x01 &&
    bytes[frameStart + 5] === 0x2a;
  if (keyframe) {
    const width = (bytes[frameStart + 6]! | (bytes[frameStart + 7]! << 8)) & 0x3fff;
    const height = (bytes[frameStart + 8]! | (bytes[frameStart + 9]! << 8)) & 0x3fff;
    if (width === 0 || height === 0) return null;
  }
  return {
    keyframe,
    relativeTimecode: bytes.readInt16BE(timecodeOffset),
  };
}

function readEbmlUnsigned(bytes: Buffer, element: EbmlElement): number | null {
  const length = element.dataEnd - element.dataStart;
  if (!element.complete || length < 1 || length > 6) return null;
  let value = 0;
  for (let index = element.dataStart; index < element.dataEnd; index += 1) {
    value = value * 256 + bytes[index]!;
  }
  return Number.isSafeInteger(value) ? value : null;
}

export async function validateWebmFile(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const info = await fh.stat();
    if (info.size < 64 || info.size >= HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES) {
      return false;
    }
    const media = await readFile(path);
    if (media.length !== info.size) return false;
    const header = readEbmlElement(media, 0);
    if (!header?.complete || header.id !== 0x1a45dfa3) return false;
    const headerChildren = parseEbmlChildren(media, header.dataStart, header.dataEnd);
    if (!headerChildren.complete) return false;
    const docType = headerChildren.elements.find(
      (element) => element.id === 0x4282 && element.complete,
    );
    if (
      !docType ||
      media.subarray(docType.dataStart, docType.dataEnd).toString('ascii').toLowerCase() !== 'webm'
    ) {
      return false;
    }

    const topLevel = parseEbmlChildren(media, header.declaredEnd, media.length);
    if (!topLevel.complete) return false;
    const segment = topLevel.elements.find((element) => element.id === 0x18538067);
    if (!segment?.complete || segment.unknownSize || segment.declaredEnd !== media.length) {
      return false;
    }
    const parsedSegment = parseEbmlChildren(media, segment.dataStart, segment.dataEnd);
    if (!parsedSegment.complete) return false;
    const segmentChildren = parsedSegment.elements;
    const infoElement = segmentChildren.find(
      (element) => element.id === 0x1549a966 && element.complete,
    );
    const tracks = segmentChildren.find((element) => element.id === 0x1654ae6b && element.complete);
    const clusters = segmentChildren.filter((element) => element.id === 0x1f43b675);
    const cues = segmentChildren.at(-1);
    if (
      !infoElement ||
      !tracks ||
      clusters.length === 0 ||
      cues?.id !== 0x1c53bb6b ||
      !cues.complete ||
      cues.dataEnd !== segment.dataEnd
    ) {
      return false;
    }
    const parsedCues = parseEbmlChildren(media, cues.dataStart, cues.dataEnd);
    if (
      !parsedCues.complete ||
      !parsedCues.elements.some((element) => {
        if (element.id !== 0xbb || !element.complete) return false;
        const cuePoint = parseEbmlChildren(media, element.dataStart, element.dataEnd);
        return (
          cuePoint.complete &&
          cuePoint.elements.some((child) => child.id === 0xb3) &&
          cuePoint.elements.some((child) => child.id === 0xb7)
        );
      })
    ) {
      return false;
    }

    const parsedTracks = parseEbmlChildren(media, tracks.dataStart, tracks.dataEnd);
    if (!parsedTracks.complete) return false;
    const trackEntries = parsedTracks.elements.filter(
      (element) => element.id === 0xae && element.complete,
    );
    const hasVp8Track = trackEntries.some((entry) =>
      ebmlChildren(media, entry.dataStart, entry.dataEnd).some(
        (element) =>
          element.id === 0x86 &&
          element.complete &&
          media.subarray(element.dataStart, element.dataEnd).toString('ascii') === 'V_VP8',
      ),
    );
    if (!hasVp8Track) return false;

    let blockCount = 0;
    let hasKeyframe = false;
    let firstTimecode = Number.POSITIVE_INFINITY;
    let lastTimecode = Number.NEGATIVE_INFINITY;
    for (const cluster of clusters) {
      const parsedCluster = parseEbmlChildren(media, cluster.dataStart, cluster.dataEnd);
      if (!parsedCluster.complete) return false;
      const clusterTimecodeElement = parsedCluster.elements.find((element) => element.id === 0xe7);
      const clusterTimecode = clusterTimecodeElement
        ? readEbmlUnsigned(media, clusterTimecodeElement)
        : 0;
      if (clusterTimecode == null) return false;
      for (const child of parsedCluster.elements) {
        let block = child.id === 0xa3 ? child : null;
        if (child.id === 0xa0 && child.complete) {
          const parsedGroup = parseEbmlChildren(media, child.dataStart, child.dataEnd);
          if (!parsedGroup.complete) return false;
          block = parsedGroup.elements.find((element) => element.id === 0xa1) ?? null;
        }
        if (!block) continue;
        const parsedBlock = parseVp8Block(media, block);
        if (!parsedBlock) return false;
        const absoluteTimecode = clusterTimecode + parsedBlock.relativeTimecode;
        blockCount += 1;
        hasKeyframe ||= parsedBlock.keyframe;
        firstTimecode = Math.min(firstTimecode, absoluteTimecode);
        lastTimecode = Math.max(lastTimecode, absoluteTimecode);
      }
    }
    return (
      hasKeyframe &&
      blockCount >= 2 &&
      Number.isFinite(firstTimecode) &&
      lastTimecode - firstTimecode >= 100
    );
  } finally {
    await fh.close();
  }
}

export async function validatePlaywrightTraceFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (info.size <= 0 || info.size > HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES) return false;
    const archive = unzipBoundedTraceArchive(await readFile(path));
    for (const name of ['trace.trace', 'trace.network'] as const) {
      const bytes = archive[name];
      if (!bytes || bytes.byteLength > 32 * 1024 ** 2) return false;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return false;
      }
      let seenEvent = false;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: { type?: unknown; version?: unknown } | null;
        try {
          event = JSON.parse(trimmed) as { type?: unknown; version?: unknown };
        } catch {
          return false;
        }
        if (
          !event ||
          typeof event !== 'object' ||
          (typeof event.type !== 'string' &&
            !(name === 'trace.trace' && typeof event.version === 'number'))
        ) {
          return false;
        }
        seenEvent = true;
      }
      if (!seenEvent) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function defaultGetFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

function assertNoForbiddenKeys(value: unknown, path = ''): void {
  if (value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      assertNoForbiddenKeys(item, `${path}[${i}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (FORBIDDEN_RECEIPT_KEYS.has(key)) {
      throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED', `forbidden receipt key: ${next}`);
    }
    assertNoForbiddenKeys(child, next);
  }
}

export async function purgeExpiredHmsBrowserArtifacts(
  inputRoot: string,
  now = new Date(),
): Promise<number> {
  const root = await assertSafeRoot(inputRoot);
  const entries = await readdir(root, { withFileTypes: true });
  let removed = 0;
  const staleBefore = now.getTime() - HMS_BROWSER_ARTIFACT_TTL_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (entry.name === '.playwright-intermediate') {
      const intermediateEntries = await readdir(dir, {
        withFileTypes: true,
      }).catch(() => []);
      for (const intermediate of intermediateEntries) {
        const path = join(dir, intermediate.name);
        const info = await lstat(path).catch(() => null);
        if (!info || info.isSymbolicLink()) continue;
        if (info.mtimeMs <= staleBefore) {
          await rm(path, { recursive: true, force: true });
          removed += 1;
        }
      }
      continue;
    }
    if (entry.name.startsWith('.partial-') || entry.name.startsWith('.incomplete-')) {
      const info = await lstat(dir).catch(() => null);
      if (info && !info.isSymbolicLink() && info.mtimeMs <= staleBefore) {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
      continue;
    }
    if (entry.name.startsWith('.')) continue;
    const info = await lstat(dir).catch(() => null);

    let receiptPath: string | null = null;
    try {
      receiptPath = (await resolveExclusiveReceiptFile(dir)).path;
    } catch (error) {
      // Dual receipts are ambiguous: never destroy them, even when stale.
      if (error instanceof ExclusiveReceiptError && error.reason === 'dual') {
        continue;
      }
    }

    const staleDirectory =
      UUID_RE.test(entry.name) &&
      info !== null &&
      !info.isSymbolicLink() &&
      info.mtimeMs <= staleBefore;

    if (staleDirectory) {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
      continue;
    }
    if (!receiptPath) continue;
    try {
      const raw = await readFile(receiptPath, 'utf8');
      const receipt = JSON.parse(raw) as { expiresAt?: string };
      if (
        typeof receipt.expiresAt === 'string' &&
        new Date(receipt.expiresAt).getTime() <= now.getTime()
      ) {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Unreadable receipt on a fresh directory: leave for the next TTL sweep.
    }
  }
  return removed;
}

export async function createHmsBrowserArtifactStore(input: {
  root: string;
  getFreeBytes?: (path: string) => Promise<number>;
  validateTraceFile?: (path: string) => Promise<boolean>;
  validateVideoFile?: (path: string) => Promise<boolean>;
}): Promise<HmsBrowserArtifactStore> {
  const root = await assertSafeRoot(input.root);
  const getFreeBytes = input.getFreeBytes ?? defaultGetFreeBytes;
  const validateTraceFile = input.validateTraceFile ?? validatePlaywrightTraceFile;
  const validateVideoFile = input.validateVideoFile ?? validateWebmFile;
  if ((await getFreeBytes(root)) < HMS_BROWSER_ARTIFACT_MIN_FREE_BYTES) {
    throw new HmsBrowserArtifactError('CAPTURE_CAPACITY_EXCEEDED');
  }
  const rootInfo = await stat(root);
  const intermediateDir = join(root, '.playwright-intermediate');
  const existingIntermediate = await lstat(intermediateDir).catch(() => null);
  if (
    existingIntermediate?.isSymbolicLink() ||
    (existingIntermediate && !existingIntermediate.isDirectory())
  ) {
    throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE');
  }
  await mkdir(intermediateDir, { recursive: true, mode: 0o700 });
  const intermediateInfo = await lstat(intermediateDir);
  const intermediateReal = await realpath(intermediateDir);
  if (
    intermediateInfo.isSymbolicLink() ||
    intermediateInfo.dev !== rootInfo.dev ||
    relative(root, intermediateReal).startsWith('..')
  ) {
    throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE');
  }
  if (platform() !== 'win32') {
    await chmod(intermediateDir, 0o700);
  }
  const assertCaptureStorageReady = async (): Promise<void> => {
    const currentRoot = await assertSafeRoot(root);
    const currentRootInfo = await stat(currentRoot);
    const currentIntermediateInfo = await lstat(intermediateDir).catch(() => null);
    const currentIntermediateReal = currentIntermediateInfo
      ? await realpath(intermediateDir).catch(() => '')
      : '';
    if (
      currentRoot !== root ||
      currentRootInfo.dev !== rootInfo.dev ||
      !currentIntermediateInfo?.isDirectory() ||
      currentIntermediateInfo.isSymbolicLink() ||
      currentIntermediateInfo.dev !== rootInfo.dev ||
      !currentIntermediateReal ||
      relative(root, currentIntermediateReal).startsWith('..')
    ) {
      throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE');
    }
    if ((await getFreeBytes(root)) < HMS_BROWSER_ARTIFACT_MIN_FREE_BYTES) {
      throw new HmsBrowserArtifactError('CAPTURE_CAPACITY_EXCEEDED');
    }
  };
  const activeCaptureIds = new Set<string>();

  return {
    root,
    intermediateDir,

    async purgeExpired(now = new Date()) {
      return purgeExpiredHmsBrowserArtifacts(root, now);
    },

    async beginCapture(spec) {
      await assertCaptureStorageReady();
      assertUuid(spec.operationId, 'operationId');
      if (!isSupportedHmsBrowserV1Tool(spec.toolId)) {
        throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE', 'unsupported toolId');
      }
      const captureToolId = spec.toolId;
      if (spec.executionClass !== 'normal' && spec.executionClass !== 'live_proof') {
        throw new HmsBrowserArtifactError(
          'TRACE_STORAGE_UNAVAILABLE',
          'unsupported executionClass',
        );
      }
      if (
        spec.executionClass === 'live_proof' &&
        (!/^[a-f0-9]{64}$/i.test(spec.roleProofSha256 ?? '') ||
          !Number.isFinite(Date.parse(spec.roleProofExpiresAt ?? '')))
      ) {
        throw new HmsBrowserArtifactError(
          'TRACE_STORAGE_UNAVAILABLE',
          'live proof role attestation missing',
        );
      }

      const artifactId = randomUUID();
      const stagingDir = join(root, `.partial-${artifactId}`);
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      if ((await stat(stagingDir)).dev !== rootInfo.dev) {
        await rm(stagingDir, { recursive: true, force: true });
        throw new HmsBrowserArtifactError('TRACE_STORAGE_UNAVAILABLE');
      }
      if (platform() !== 'win32') {
        await chmod(stagingDir, 0o700);
      }
      await writeFile(
        join(stagingDir, '.capture-owner.v1.json'),
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`,
        { mode: 0o600 },
      );

      const videoDir = spec.executionClass === 'live_proof' ? join(stagingDir, 'video-raw') : null;
      if (videoDir) {
        await mkdir(videoDir, { recursive: true, mode: 0o700 });
        if (platform() !== 'win32') {
          await chmod(videoDir, 0o700);
        }
      }
      // Playwright's launch-level tracesDir is shared by the reused browser.
      // Keep a private operation namespace for offline/native producers while
      // claiming the launch-level files with this capture's stable name.
      const tracesDir = join(intermediateDir, `.capture-${artifactId}`);
      await mkdir(tracesDir, { recursive: true, mode: 0o700 });
      if (platform() !== 'win32') await chmod(tracesDir, 0o700);
      await writeFile(
        join(tracesDir, '.capture-owner.v1.json'),
        `${JSON.stringify({ schemaVersion: 1, artifactId, pid: process.pid })}\n`,
        { mode: 0o600 },
      );
      const intermediateFilesAtStart = await directoryFileFingerprints(intermediateDir);
      const intermediateSizesAtStart = new Map(
        [...intermediateFilesAtStart].map(([path, fingerprint]) => [path, fingerprint.size]),
      );
      activeCaptureIds.add(artifactId);
      const secretValues = new Set<string>();
      let publicationInvalidated = false;
      let retainedDir: string | null = null;
      let committedDir: string | null = null;
      let committedReceipt: HmsBrowserArtifactReceiptV1 | null = null;
      // Installed before publication and retained for late abandon retries.
      let quarantineCommittedTarget: (
        receipt: HmsBrowserArtifactReceiptV1,
      ) => Promise<{ receipt: HmsBrowserArtifactReceiptV1; targetDir: string }>;
      let finalized = false;

      const milestones: HmsBrowserArtifactReceiptBaseV1['milestones'] = {};

      const handle: HmsBrowserCaptureHandle = {
        artifactId,
        stagingDir,
        videoDir,
        tracesDir,
        nativeTracesDir: intermediateDir,
        nativeTraceName: artifactId,

        invalidate() {
          publicationInvalidated = true;
        },

        addSecretValues(values) {
          for (const value of values) {
            if (typeof value === 'string' && value.length > 0) secretValues.add(value);
          }
        },

        markMilestone(key, at = new Date()) {
          milestones[key] = at.toISOString();
        },

        async observeStagedBytes() {
          const staged = await directoryBytes(stagingDir);
          const intermediate = await directoryGrowthBytes(
            intermediateDir,
            intermediateSizesAtStart,
          );
          return staged + intermediate;
        },

        async observeFreeBytes() {
          return getFreeBytes(root);
        },

        async finalize(input) {
          if (retainedDir) {
            try {
              const body = await readFile(join(retainedDir, 'receipt.v1.json'), 'utf8');
              return JSON.parse(body) as HmsBrowserArtifactReceiptV1;
            } catch {
              throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
            }
          }
          const expiresAt = new Date(Date.now() + HMS_BROWSER_ARTIFACT_TTL_MS).toISOString();
          const currentInput = (): typeof input =>
            publicationInvalidated
              ? {
                  ...input,
                  complete: false,
                  outcome: input.outcome === 'succeeded' ? 'aborted' as const : input.outcome,
                  terminalCode: 'ABORTED' as const,
                  terminalStage: 'context_close' as const,
                }
              : input;
          const tracePath = join(stagingDir, 'trace.zip');
          const reviewTracePath = join(stagingDir, '.trace-review.zip');
          let traceDigest: { sha256: string; bytes: number } | null = null;
          let videoDigest: { sha256: string; bytes: number } | null = null;
          let traceProvenance: HmsTraceSanitizationResult | null = null;

          const removeIfPresent = async (path: string): Promise<void> => {
            try {
              await rm(path, { force: false });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          };

          const cleanupNative = async (allowOtherOwners: boolean): Promise<void> => {
            try {
              await removeOwnedCaptureFiles({
                operationDir: tracesDir,
                nativeDir: intermediateDir,
                artifactId,
                baseline: intermediateFilesAtStart,
                activeOwnerIds: activeCaptureIds,
                allowOtherOwners,
              });
              activeCaptureIds.delete(artifactId);
            } catch (error) {
              if (error instanceof HmsBrowserArtifactError) throw error;
              throw new HmsBrowserArtifactError(
                'TRACE_FINALIZE_FAILED',
                'native trace cleanup could not be verified',
              );
            }
          };

          const buildBase = (
            effectiveInput = currentInput(),
          ): HmsBrowserArtifactReceiptBaseV1 => ({
            schemaVersion: 1,
            artifactId,
            operationId: spec.operationId,
            sourceRevision: effectiveInput.sourceRevision,
            toolId: captureToolId,
            toolVersion: spec.toolVersion,
            dependencyRevision: spec.dependencyRevision,
            playwrightRevision: effectiveInput.playwrightRevision,
            chromiumRevision: effectiveInput.chromiumRevision,
            executionClass: spec.executionClass,
            inputClass: spec.inputClass,
            credentialMode: 'view_only',
            roleProofSha256: spec.roleProofSha256 ?? null,
            roleProofExpiresAt: spec.roleProofExpiresAt ?? null,
            requestBranchId: spec.requestBranchId ?? null,
            operationOutcome: effectiveInput.outcome,
            requestRules: effectiveInput.requestRules,
            blockedRequests: effectiveInput.blockedRequests,
            mutationRequests: effectiveInput.mutationRequests,
            popupCount: effectiveInput.popupCount,
            downloadCount: effectiveInput.downloadCount,
            webSocketCount: effectiveInput.webSocketCount,
            milestones: { ...milestones },
            terminalCode: effectiveInput.terminalCode,
            terminalStage: effectiveInput.terminalStage,
            expiresAt,
          });

          const writeReceiptAt = async (
            receiptPath: string,
            receipt: HmsBrowserArtifactReceiptV1,
          ): Promise<void> => {
            const body = `${JSON.stringify(receipt)}\n`;
            const fh = await open(receiptPath, 'w', 0o600);
            try {
              await fh.writeFile(body, 'utf8');
              await fh.sync();
            } finally {
              await fh.close();
            }
          };
          const writeReceiptFile = async (
            directory: string,
            receipt: HmsBrowserArtifactReceiptV1,
          ): Promise<void> => writeReceiptAt(join(directory, 'receipt.v1.json'), receipt);
          const rewritePrivateReceipt = async (
            directory: string,
            receipt: HmsBrowserArtifactReceiptV1,
          ): Promise<void> => {
            const receiptPath = join(directory, 'receipt.v1.json');
            try {
              await writeReceiptFile(directory, receipt);
              if (platform() !== 'win32') await chmod(receiptPath, 0o600);
              return;
            } catch {
              const temporaryPath = `${receiptPath}.tmp-${randomUUID()}`;
              try {
                await writeReceiptAt(temporaryPath, receipt);
                await rename(temporaryPath, receiptPath);
                if (platform() !== 'win32') await chmod(receiptPath, 0o600);
              } finally {
                await rm(temporaryPath, { force: true }).catch(() => undefined);
              }
            }
          };
          quarantineCommittedTarget = async (
            receipt: HmsBrowserArtifactReceiptV1,
          ): Promise<{
            receipt: HmsBrowserArtifactReceiptV1;
            targetDir: string;
          }> => {
            const sourceDir = committedDir;
            if (!sourceDir) throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
            const incompleteTarget = join(root, `.incomplete-${artifactId}`);
            try {
              if (sourceDir !== incompleteTarget) {
                await rename(sourceDir, incompleteTarget);
                committedDir = incompleteTarget;
              }
              const invalidated = publicationInvalidated;
              const retainedInput = {
                ...currentInput(),
                complete: false,
                outcome: invalidated || currentInput().outcome === 'aborted'
                  ? 'aborted' as const
                  : 'failed' as const,
                terminalCode: invalidated ? 'ABORTED' as const : 'TRACE_FINALIZE_FAILED' as const,
                terminalStage: invalidated ? 'context_close' as const : 'receipt_finalize' as const,
              };
              const incompleteReceipt: HmsBrowserArtifactReceiptV1 = {
                ...buildBase(retainedInput),
                artifactState: 'incomplete',
                trace: receipt.trace,
                video: receipt.video,
              };
              assertNoForbiddenKeys(incompleteReceipt);
              await rewritePrivateReceipt(incompleteTarget, incompleteReceipt);
              committedReceipt = incompleteReceipt;
              retainedDir = incompleteTarget;
              return { receipt: incompleteReceipt, targetDir: incompleteTarget };
            } catch (error) {
              await rm(join(committedDir ?? sourceDir, 'receipt.v1.json'), { force: false }).catch(
                () => undefined,
              );
              throw error;
            }
          };

          const writeReceipt = async (
            receipt: HmsBrowserArtifactReceiptV1,
            targetDir: string,
            allowIncompleteCleanup = false,
          ): Promise<{
            receipt: HmsBrowserArtifactReceiptV1;
            targetDir: string;
            cleanupError: unknown;
          }> => {
            let writeCleanupError: unknown;
            let publicationReceipt = receipt;
            const makeIncomplete = (): void => {
              if (publicationReceipt.artifactState !== 'complete') return;
              publicationReceipt = {
                ...buildBase(currentInput()),
                artifactState: 'incomplete',
                trace: publicationReceipt.trace,
                video: publicationReceipt.video,
              };
            };
            // Cancellation is monotonic. Re-check before writing and again at
            // the publication boundary so an in-flight finalizer cannot rename
            // a complete capture after invalidation.
            if (publicationInvalidated) makeIncomplete();
            if (traceProvenance) {
              const provenancePath = join(stagingDir, '.trace-provenance.v1.json');
              const provenance = {
                schemaVersion: 1,
                sanitizerVersion: traceProvenance.sanitizerVersion,
                raw: traceProvenance.raw,
                review: traceProvenance.review,
              } as const;
              try {
                await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`, {
                  mode: 0o600,
                });
                if (platform() !== 'win32') await chmod(provenancePath, 0o600);
              } catch (error) {
                if (!allowIncompleteCleanup) throw error;
                writeCleanupError = error;
              }
            }
            try {
              await removeIfPresent(join(stagingDir, '.capture-owner.v1.json'));
            } catch (error) {
              if (!allowIncompleteCleanup) throw error;
              writeCleanupError ??= error;
            }
            if (allowIncompleteCleanup && writeCleanupError) {
              publicationReceipt = {
                ...buildBase({
                  ...currentInput(),
                  complete: false,
                  outcome: currentInput().outcome === 'aborted' ? 'aborted' : 'failed',
                  terminalCode: 'TRACE_FINALIZE_FAILED',
                  terminalStage: 'receipt_finalize',
                }),
                artifactState: 'incomplete',
                trace: null,
                video: publicationReceipt.video,
              };
            }
            assertNoForbiddenKeys(publicationReceipt);
            const receiptPath = join(stagingDir, 'receipt.v1.json');
            await writeReceiptFile(stagingDir, publicationReceipt);
            if (publicationInvalidated) {
              makeIncomplete();
              assertNoForbiddenKeys(publicationReceipt);
              await writeReceiptFile(stagingDir, publicationReceipt);
            }
            if (platform() !== 'win32') {
              try {
                await chmod(receiptPath, 0o600);
              } catch (error) {
                if (!allowIncompleteCleanup) throw error;
                writeCleanupError ??= error;
                publicationReceipt = {
                  ...buildBase({
                    ...currentInput(),
                    complete: false,
                    outcome: currentInput().outcome === 'aborted' ? 'aborted' : 'failed',
                    terminalCode: 'TRACE_FINALIZE_FAILED',
                    terminalStage: 'receipt_finalize',
                  }),
                  artifactState: 'incomplete',
                  trace: null,
                  video: publicationReceipt.video,
                };
                assertNoForbiddenKeys(publicationReceipt);
                await writeReceiptFile(stagingDir, publicationReceipt);
              }
            }
            if (publicationInvalidated) {
              makeIncomplete();
              assertNoForbiddenKeys(publicationReceipt);
              await writeReceiptFile(stagingDir, publicationReceipt);
            }
            const finalTarget =
              publicationReceipt.artifactState === 'complete' && !publicationInvalidated
                ? targetDir
                : join(root, `.incomplete-${artifactId}`);
            await rename(stagingDir, finalTarget);
            committedDir = finalTarget;
            committedReceipt = publicationReceipt;
            // Failed-complete retention also crosses this asynchronous boundary;
            // its already-incomplete receipt must reflect a late invalidation.
            if (input.complete && publicationInvalidated) {
              const quarantined = await quarantineCommittedTarget(publicationReceipt);
              return {
                receipt: quarantined.receipt,
                targetDir: quarantined.targetDir,
                cleanupError: writeCleanupError,
              };
            }
            return {
              receipt: publicationReceipt,
              targetDir: finalTarget,
              cleanupError: writeCleanupError,
            };
          };

          const retainIncomplete = async (): Promise<HmsBrowserArtifactReceiptV1> => {
            if (retainedDir) {
              try {
                const body = await readFile(join(retainedDir, 'receipt.v1.json'), 'utf8');
                return JSON.parse(body) as HmsBrowserArtifactReceiptV1;
              } catch {
                throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
              }
            }
            if (committedDir && committedReceipt) {
              try {
                const quarantined = await quarantineCommittedTarget(committedReceipt);
                activeCaptureIds.delete(artifactId);
                finalized = true;
                return quarantined.receipt;
              } catch {
                throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
              }
            }
            const cleanupErrors: unknown[] = [];
            const attemptCleanup = async (operation: () => Promise<void>): Promise<void> => {
              try {
                await operation();
              } catch (error) {
                cleanupErrors.push(error);
              }
            };
            await attemptCleanup(() => removeIfPresent(reviewTracePath));
            // The trace is removed from staging on every incomplete path. Its
            // digest must never describe bytes no longer retained.
            traceDigest = null;
            await attemptCleanup(() => removeIfPresent(tracePath));
            await attemptCleanup(() => cleanupNative(false));
            const retentionFailedComplete = input.complete && !publicationInvalidated;
            const retentionAborted = publicationInvalidated || currentInput().outcome === 'aborted';
            const receiptInput = cleanupErrors.length > 0 || retentionFailedComplete
              ? {
                  ...currentInput(),
                  complete: false,
                  outcome: retentionAborted ? 'aborted' as const : 'failed' as const,
                  terminalCode: retentionAborted ? 'ABORTED' as const : 'TRACE_FINALIZE_FAILED' as const,
                  terminalStage: retentionAborted ? 'context_close' as const : 'receipt_finalize' as const,
                }
              : currentInput();
            const receipt: HmsBrowserArtifactReceiptV1 = {
              ...buildBase(receiptInput),
              artifactState: 'incomplete',
              trace: null,
              video: videoDigest,
            };
            const targetDir = join(root, `.incomplete-${artifactId}`);
            let published: {
              receipt: HmsBrowserArtifactReceiptV1;
              targetDir: string;
              cleanupError: unknown;
            };
            try {
              published = await writeReceipt(receipt, targetDir, true);
            } catch (writeError) {
              cleanupErrors.push(writeError);
              throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
            }
            activeCaptureIds.delete(artifactId);
            retainedDir = published.targetDir;
            finalized = true;
            if (cleanupErrors.length > 0 || published.cleanupError) {
              throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
            }
            return published.receipt;
          };

          try {
            try {
              const traceInfo = await stat(tracePath);
              if (traceInfo.size >= HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES) {
                throw new HmsBrowserArtifactError('CAPTURE_CAPACITY_EXCEEDED');
              }
              try {
                traceProvenance = await sanitizePlaywrightTraceFile(
                  tracePath,
                  reviewTracePath,
                  [...secretValues],
                  { signal: input.signal },
                );
              } catch (error) {
                if (error instanceof HmsTracePrivacyError) {
                  throw new HmsBrowserArtifactError('TRACE_PRIVACY_FAILED');
                }
                throw error;
              }
              await removeIfPresent(tracePath);
              await rename(reviewTracePath, tracePath);
              traceDigest = await fileDigest(tracePath);
              if (traceDigest.bytes >= HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES) {
                throw new HmsBrowserArtifactError('CAPTURE_CAPACITY_EXCEEDED');
              }
              const traceValid =
                (await isTraceZip(tracePath)) && (await validateTraceFile(tracePath));
              if (!traceValid) {
                await removeIfPresent(tracePath);
                traceDigest = null;
                if (currentInput().complete) {
                  throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
                }
              } else if (platform() !== 'win32') {
                await chmod(tracePath, 0o600);
              }
            } catch (error) {
              traceDigest = null;
              await removeIfPresent(tracePath);
              if (error instanceof HmsBrowserArtifactError) throw error;
              if (currentInput().complete) {
                throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
              }
            }

            const videoPath = join(stagingDir, 'video.webm');
            try {
              const videoInfo = await stat(videoPath);
              if (
                (traceDigest?.bytes ?? 0) + videoInfo.size >=
                HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES
              ) {
                throw new HmsBrowserArtifactError('CAPTURE_CAPACITY_EXCEEDED');
              }
              videoDigest = await fileDigest(videoPath);
              if (
                spec.executionClass === 'live_proof' &&
                currentInput().complete &&
                (!(await validateWebmFile(videoPath)) || !(await validateVideoFile(videoPath)))
              ) {
                throw new HmsBrowserArtifactError('VIDEO_FINALIZE_FAILED');
              }
              if (platform() !== 'win32') await chmod(videoPath, 0o600);
            } catch (error) {
              if (error instanceof HmsBrowserArtifactError) throw error;
              if (spec.executionClass === 'live_proof' && currentInput().complete) {
                throw new HmsBrowserArtifactError('VIDEO_FINALIZE_FAILED');
              }
            }

            const effectiveInput = currentInput();
            const receipt: HmsBrowserArtifactReceiptV1 = effectiveInput.complete
              ? {
                  ...buildBase(),
                  artifactState: 'complete',
                  trace: traceDigest!,
                  video: spec.executionClass === 'live_proof' ? videoDigest : null,
                }
              : {
                  ...buildBase(),
                  artifactState: 'incomplete',
                  trace: traceDigest,
                  video: videoDigest,
                };
            assertNoForbiddenKeys(receipt);
            await removeIfPresent(reviewTracePath);
            await cleanupNative(false);
            const targetDir = effectiveInput.complete
              ? join(root, artifactId)
              : join(root, `.incomplete-${artifactId}`);
            const published = await writeReceipt(receipt, targetDir);
            retainedDir = published.receipt.artifactState === 'complete' ? null : published.targetDir;
            finalized = true;
            return published.receipt;
          } catch (error) {
            if (finalized) throw error;
            await retainIncomplete();
            if (error instanceof HmsBrowserArtifactError) throw error;
            throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
          }
        },

        async abandon() {
          publicationInvalidated = true;
          if (retainedDir) return;
          if (committedDir && committedReceipt) {
            try {
              try {
                await quarantineCommittedTarget(committedReceipt);
              } catch {
                await quarantineCommittedTarget(committedReceipt);
              }
              activeCaptureIds.delete(artifactId);
              finalized = true;
              return;
            } catch {
              throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
            }
          }
          const expiresAt = new Date(Date.now() + HMS_BROWSER_ARTIFACT_TTL_MS).toISOString();
          const tracePath = join(stagingDir, 'trace.zip');
          const reviewTracePath = join(stagingDir, '.trace-review.zip');
          const removeIfPresent = async (path: string): Promise<void> => {
            try {
              await rm(path, { force: false });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          };
          let cleanupError: unknown;
          const attemptCleanup = async (operation: () => Promise<void>): Promise<void> => {
            try {
              await operation();
            } catch (error) {
              cleanupError ??= error;
            }
          };
          await attemptCleanup(() => removeIfPresent(reviewTracePath));
          await attemptCleanup(() => removeIfPresent(tracePath));
          await attemptCleanup(async () => {
            try {
              await removeOwnedCaptureFiles({
                operationDir: tracesDir,
                nativeDir: intermediateDir,
                artifactId,
                baseline: intermediateFilesAtStart,
                activeOwnerIds: activeCaptureIds,
                allowOtherOwners: true,
              });
            } catch (error) {
              if (error instanceof HmsBrowserArtifactError) throw error;
              throw new HmsBrowserArtifactError(
                'TRACE_FINALIZE_FAILED',
                'native trace cleanup could not be verified',
              );
            }
          });
          activeCaptureIds.delete(artifactId);
          let receipt: HmsBrowserArtifactReceiptV1 = {
            schemaVersion: 1,
            artifactId,
            operationId: spec.operationId,
            sourceRevision: 'unknown',
            toolId: captureToolId,
            toolVersion: spec.toolVersion,
            dependencyRevision: spec.dependencyRevision,
            playwrightRevision: 'unknown',
            chromiumRevision: 'unknown',
            executionClass: spec.executionClass,
            inputClass: spec.inputClass,
            credentialMode: 'view_only',
            roleProofSha256: spec.roleProofSha256 ?? null,
            roleProofExpiresAt: spec.roleProofExpiresAt ?? null,
            requestBranchId: spec.requestBranchId ?? null,
            operationOutcome: 'aborted',
            requestRules: [],
            blockedRequests: 0,
            mutationRequests: 0,
            popupCount: 0,
            downloadCount: 0,
            webSocketCount: 0,
            milestones: { ...milestones },
            terminalCode: cleanupError ? 'TRACE_FINALIZE_FAILED' : 'ABORTED',
            terminalStage: cleanupError ? 'receipt_finalize' : 'context_close',
            expiresAt,
            artifactState: 'incomplete',
            trace: null,
            video: null,
          };
          assertNoForbiddenKeys(receipt);
          await attemptCleanup(() => removeIfPresent(join(stagingDir, '.capture-owner.v1.json')));
          if (cleanupError) {
            receipt = {
              ...receipt,
              terminalCode: 'TRACE_FINALIZE_FAILED',
              terminalStage: 'receipt_finalize',
            };
            assertNoForbiddenKeys(receipt);
          }
          const receiptPath = join(stagingDir, 'receipt.v1.json');
          let writeError: unknown;
          try {
            const fh = await open(receiptPath, 'w', 0o600);
            try {
              await fh.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
              await fh.sync();
            } finally {
              await fh.close();
            }
          } catch (error) {
            writeError = error;
          }
          if (!writeError && platform() !== 'win32') {
            await attemptCleanup(() => chmod(receiptPath, 0o600));
            if (cleanupError) {
              receipt = {
                ...receipt,
                terminalCode: 'TRACE_FINALIZE_FAILED',
                terminalStage: 'receipt_finalize',
              };
              try {
                const fh = await open(receiptPath, 'w', 0o600);
                try {
                  await fh.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
                  await fh.sync();
                } finally {
                  await fh.close();
                }
              } catch (error) {
                writeError = error;
              }
            }
          }
          const targetDir = join(root, `.incomplete-${artifactId}`);
          if (!writeError) {
            try {
              await rename(stagingDir, targetDir);
              retainedDir = targetDir;
            } catch (error) {
              writeError = error;
            }
          }
          if (writeError) {
            throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
          }
          finalized = true;
          if (cleanupError) throw new HmsBrowserArtifactError('TRACE_FINALIZE_FAILED');
        },
      };

      return handle;
    },
  };
}

/** Test helper: create root with required mode when platform supports it. */
export async function ensureHmsBrowserArtifactRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (platform() !== 'win32') {
    await chmod(root, 0o700);
  }
  return root;
}
