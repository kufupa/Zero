import {
  validatePrivateThreadCorpusSnapshot,
  type PrivateThreadCorpusArtifactFile,
  type PrivateThreadCorpusSnapshot,
  type QuarantineSnapshotRecord,
  type SnapshotManifestV2,
  type SnapshotRecord,
  type SnapshotSourceRow,
  type ThreadSnapshotRecord,
} from '../../scripts/export-thread-corpus.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CENTURION_THREAD_CORPUS_ANALYSIS_VERSION = 'centurion-thread-corpus-analysis-v1';

export type AnalysisUnitType = 'logical_message' | 'quarantine';

export type AnalysisWorkflow =
  | 'reservation_new'
  | 'reservation_change'
  | 'reservation_cancel'
  | 'group_or_event'
  | 'guest_service'
  | 'operations'
  | 'payment'
  | 'document'
  | 'security'
  | 'system_routine'
  | 'system_failure'
  | 'feedback'
  | 'unknown';

export type AnalysisRisk =
  | 'none'
  | 'human_review'
  | 'failure'
  | 'payment'
  | 'policy'
  | 'cancellation_fee'
  | 'complaint'
  | 'security'
  | 'document'
  | 'vip_or_privacy';

export type AnalysisConfidence = 'low' | 'medium' | 'high';

export type ResponseEvidenceState = 'smtp_accepted' | 'not_claimed' | 'not_applicable' | 'unknown';

export type AnalysisItemV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_ANALYSIS_VERSION;
  analysisItemId: string;
  unitType: AnalysisUnitType;
  sourceMembership: Array<'centurion_transport' | 'designated_reservationist_mailbox'>;
  artifactState: 'complete' | 'partial' | 'unavailable' | 'not_applicable' | 'unknown';
  responseEvidenceState: ResponseEvidenceState;
};

export type PrivateAnalysisPacketV1 =
  | (AnalysisItemV1 & {
      packetState: 'complete';
      packetBytes: number;
      packetSha256: string;
      privatePacketBytes: Uint8Array;
    })
  | (AnalysisItemV1 & {
      packetState: 'truncated' | 'unavailable';
      packetBytes: 0;
      packetSha256: null;
      omissionReason: 'per_packet_limit' | 'aggregate_packet_limit' | 'unavailable_evidence';
    });

export type PreparedAnalysisManifestV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_ANALYSIS_VERSION;
  snapshotId: string;
  snapshotDigest: string;
  maxPacketBytes: number;
  maxTotalPacketBytes: number;
  packets: Array<{
    analysisItemId: string;
    unitType: AnalysisUnitType;
    packetState: 'complete' | 'truncated' | 'unavailable';
    packetSha256: string | null;
  }>;
};

export type PreparedPrivateAnalysisV1 = {
  manifest: PreparedAnalysisManifestV1;
  manifestSha256: string;
  packets: PrivateAnalysisPacketV1[];
};

export type AnalystDecisionV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_ANALYSIS_VERSION;
  analysisItemId: string;
  workflow: AnalysisWorkflow;
  risk: AnalysisRisk;
  confidence: AnalysisConfidence;
  attention: 'human_review' | 'routine' | 'unknown';
};

export type AnalystDecisionBundleV1 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_ANALYSIS_VERSION;
  preparedManifestSha256: string;
  decisions: AnalystDecisionV1[];
};

export type ReconciledAnalystDecisionsV1 = {
  snapshotId: string;
  snapshotDigest: string;
  preparedManifestSha256: string;
  preparedManifest: PreparedAnalysisManifestV1;
  items: AnalysisItemV1[];
  decisions: AnalystDecisionV1[];
};

type AnalysisDescriptor = {
  item: AnalysisItemV1;
  sourceRowIds: string[];
  record: ThreadSnapshotRecord | QuarantineSnapshotRecord;
  selectedSourceRows: SnapshotSourceRow[];
};

type ReconstructedV2Snapshot = {
  snapshot: PrivateThreadCorpusSnapshot;
  records: SnapshotRecord[];
  snapshotDigest: string;
};

type SuppliedReconciledAnalystDecisions = {
  snapshotId: string;
  snapshotDigest: string;
  preparedManifestSha256: string;
  preparedManifest: PreparedAnalysisManifestV1;
  items: unknown[];
  decisions: unknown[];
};

const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();
export const MAX_PRIVATE_ANALYSIS_PACKET_BYTES = 16 * 1024 * 1024;
export const MAX_CANONICAL_JSON_CHUNK_BYTES = 1024;
const MIN_PRIVATE_ANALYSIS_PACKET_BYTES = 256;
const BYTE_VALUE_TOKENS = Array.from({ length: 256 }, (_, value) => String(value));
const ANALYSIS_SOURCE_MEMBERSHIP = [
  'centurion_transport',
  'designated_reservationist_mailbox',
] as const;

const analysisWorkflowSchema = z.enum([
  'reservation_new',
  'reservation_change',
  'reservation_cancel',
  'group_or_event',
  'guest_service',
  'operations',
  'payment',
  'document',
  'security',
  'system_routine',
  'system_failure',
  'feedback',
  'unknown',
]);

const analysisRiskSchema = z.enum([
  'none',
  'human_review',
  'failure',
  'payment',
  'policy',
  'cancellation_fee',
  'complaint',
  'security',
  'document',
  'vip_or_privacy',
]);

const analystDecisionSchema = z
  .object({
    schemaVersion: z.literal(CENTURION_THREAD_CORPUS_ANALYSIS_VERSION),
    analysisItemId: z.string().regex(SHA256_DIGEST),
    workflow: analysisWorkflowSchema,
    risk: analysisRiskSchema,
    confidence: z.enum(['low', 'medium', 'high']),
    attention: z.enum(['human_review', 'routine', 'unknown']),
  })
  .strict();

const analystDecisionBundleSchema = z
  .object({
    schemaVersion: z.literal(CENTURION_THREAD_CORPUS_ANALYSIS_VERSION),
    preparedManifestSha256: z.string().regex(SHA256_DIGEST),
    decisions: z.array(analystDecisionSchema),
  })
  .strict();

function invalidPrivateAnalysisInput(): never {
  throw new Error('Invalid private analysis input');
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

type CanonicalWriteResult = 'ok' | 'exceeded' | 'invalid';

export type CanonicalByteSink = {
  writeAscii(token: string): CanonicalWriteResult;
  writeJsonString(value: string): CanonicalWriteResult;
  writeByteValue(value: number): CanonicalWriteResult;
  digestHex(): string;
  finishBytes(): Uint8Array | null;
};

class BoundedCanonicalByteSink implements CanonicalByteSink {
  private readonly chunks: Uint8Array[] = [];
  private readonly hash = createHash('sha256');
  private byteLength = 0;
  private pendingText = '';
  private pendingByteLength = 0;
  private digest: string | null = null;
  private state: CanonicalWriteResult = 'ok';

  constructor(
    private readonly maxBytes: number | null,
    private readonly retainBytes: boolean,
  ) {}

  writeAscii(token: string): CanonicalWriteResult {
    if (typeof token !== 'string') return this.fail('invalid');
    let start = 0;
    while (start < token.length) {
      const end = Math.min(start + MAX_CANONICAL_JSON_CHUNK_BYTES, token.length);
      const chunk = token.slice(start, end);
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk.charCodeAt(index) > 0x7f) return this.fail('invalid');
      }
      const result = this.appendUtf8Chunk(chunk, chunk.length);
      if (result !== 'ok') return result;
      start = end;
    }
    return token.length === 0 ? this.flushPending() : this.state;
  }

  writeJsonString(value: string): CanonicalWriteResult {
    if (typeof value !== 'string') return this.fail('invalid');
    let result = this.appendUtf8Chunk('"', 1);
    if (result !== 'ok') return result;

    let rangeStart = 0;
    let rangeByteLength = 0;
    const flushRange = (end: number): CanonicalWriteResult => {
      if (end === rangeStart) return 'ok';
      const currentRange = value.slice(rangeStart, end);
      const currentRangeByteLength = rangeByteLength;
      rangeStart = end;
      rangeByteLength = 0;
      return this.appendUtf8Chunk(currentRange, currentRangeByteLength);
    };

    for (let index = 0; index < value.length; ) {
      const codeUnit = value.charCodeAt(index);
      let escapedToken: string | null = null;
      let tokenByteLength: number;
      let tokenLength = 1;
      if (codeUnit === 0x22) {
        escapedToken = '\\"';
        tokenByteLength = 2;
      } else if (codeUnit === 0x5c) {
        escapedToken = '\\\\';
        tokenByteLength = 2;
      } else if (codeUnit === 0x08) {
        escapedToken = '\\b';
        tokenByteLength = 2;
      } else if (codeUnit === 0x09) {
        escapedToken = '\\t';
        tokenByteLength = 2;
      } else if (codeUnit === 0x0a) {
        escapedToken = '\\n';
        tokenByteLength = 2;
      } else if (codeUnit === 0x0c) {
        escapedToken = '\\f';
        tokenByteLength = 2;
      } else if (codeUnit === 0x0d) {
        escapedToken = '\\r';
        tokenByteLength = 2;
      } else if (codeUnit < 0x20) {
        escapedToken = `\\u${codeUnit.toString(16).padStart(4, '0')}`;
        tokenByteLength = 6;
      } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
          tokenByteLength = 4;
          tokenLength = 2;
        } else {
          escapedToken = `\\u${codeUnit.toString(16).padStart(4, '0')}`;
          tokenByteLength = 6;
        }
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        escapedToken = `\\u${codeUnit.toString(16).padStart(4, '0')}`;
        tokenByteLength = 6;
      } else {
        tokenByteLength = codeUnit <= 0x7f ? 1 : codeUnit <= 0x7ff ? 2 : 3;
      }

      if (escapedToken !== null) {
        result = flushRange(index);
        if (result !== 'ok') return result;
        result = this.appendUtf8Chunk(escapedToken, tokenByteLength);
        if (result !== 'ok') return result;
        index += tokenLength;
        rangeStart = index;
        continue;
      }

      if (rangeByteLength > MAX_CANONICAL_JSON_CHUNK_BYTES - tokenByteLength) {
        result = flushRange(index);
        if (result !== 'ok') return result;
      }
      rangeByteLength += tokenByteLength;
      index += tokenLength;
    }

    result = flushRange(value.length);
    if (result !== 'ok') return result;
    return this.appendUtf8Chunk('"', 1);
  }

  writeByteValue(value: number): CanonicalWriteResult {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
      return this.fail('invalid');
    }
    return this.writeAscii(String(value));
  }

  digestHex(): string {
    this.flushPending();
    this.digest ??= this.hash.digest('hex');
    return this.digest;
  }

  finishBytes(): Uint8Array | null {
    if (this.flushPending() !== 'ok' || !this.retainBytes) return null;
    const result = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  private appendUtf8Chunk(value: string, expectedByteLength: number): CanonicalWriteResult {
    if (this.state !== 'ok') return this.state;
    if (
      !Number.isSafeInteger(expectedByteLength) ||
      expectedByteLength < 0 ||
      expectedByteLength > MAX_CANONICAL_JSON_CHUNK_BYTES
    ) {
      return this.fail('invalid');
    }
    const bufferedByteLength = this.byteLength + this.pendingByteLength;
    if (
      !Number.isSafeInteger(bufferedByteLength) ||
      bufferedByteLength > Number.MAX_SAFE_INTEGER - expectedByteLength
    ) {
      return this.fail('invalid');
    }
    if (this.maxBytes !== null) {
      const remainingBytes = this.maxBytes - bufferedByteLength;
      if (expectedByteLength > remainingBytes) return this.fail('exceeded');
    }

    if (this.pendingByteLength > MAX_CANONICAL_JSON_CHUNK_BYTES - expectedByteLength) {
      const result = this.flushPending();
      if (result !== 'ok') return result;
    }
    this.pendingText += value;
    this.pendingByteLength += expectedByteLength;
    return 'ok';
  }

  private flushPending(): CanonicalWriteResult {
    if (this.state !== 'ok') return this.state;
    if (this.pendingText.length === 0) return 'ok';
    const bytes = textEncoder.encode(this.pendingText);
    if (
      bytes.byteLength !== this.pendingByteLength ||
      bytes.byteLength > MAX_CANONICAL_JSON_CHUNK_BYTES
    ) {
      return this.fail('invalid');
    }
    this.hash.update(bytes);
    if (this.retainBytes) this.chunks.push(bytes);
    this.byteLength += bytes.byteLength;
    this.pendingText = '';
    this.pendingByteLength = 0;
    return 'ok';
  }

  private fail(result: Exclude<CanonicalWriteResult, 'ok'>): CanonicalWriteResult {
    if (this.state === 'ok') this.state = result;
    return this.state;
  }
}

function serializeByteValues(value: Uint8Array, sink: CanonicalByteSink): CanonicalWriteResult {
  let token = '[';
  let tokenByteLength = 1;
  for (let index = 0; index < value.byteLength; index += 1) {
    const byteToken = BYTE_VALUE_TOKENS[value[index]!]!;
    const separatorByteLength = index === 0 ? 0 : 1;
    const nextByteLength = separatorByteLength + byteToken.length;
    if (tokenByteLength > MAX_CANONICAL_JSON_CHUNK_BYTES - nextByteLength) {
      const result = sink.writeAscii(token);
      if (result !== 'ok') return result;
      token = '';
      tokenByteLength = 0;
    }
    if (separatorByteLength > 0) token += ',';
    token += byteToken;
    tokenByteLength += nextByteLength;
  }
  if (tokenByteLength === MAX_CANONICAL_JSON_CHUNK_BYTES) {
    const result = sink.writeAscii(token);
    if (result !== 'ok') return result;
    token = '';
  }
  return sink.writeAscii(`${token}]`);
}

export function serializeCanonicalToSink(
  value: unknown,
  sink: CanonicalByteSink,
): CanonicalWriteResult {
  const ancestors = new Set<object>();
  const serialize = (candidate: unknown): CanonicalWriteResult => {
    if (candidate === null) return sink.writeAscii('null');
    if (typeof candidate === 'string') {
      return sink.writeJsonString(candidate);
    }
    if (typeof candidate === 'boolean') {
      return sink.writeAscii(candidate ? 'true' : 'false');
    }
    if (typeof candidate === 'number') {
      if (!Number.isSafeInteger(candidate) || Object.is(candidate, -0)) {
        return 'invalid';
      }
      return sink.writeAscii(String(candidate));
    }
    if (candidate instanceof CanonicalSelectedArtifactFiles) {
      return serializeSelectedArtifactFiles(candidate, sink);
    }
    if (candidate instanceof Uint8Array) {
      let result = sink.writeAscii('{');
      if (result !== 'ok') return result;
      result = sink.writeJsonString('$centurionUint8Array');
      if (result !== 'ok') return result;
      result = sink.writeAscii(':');
      if (result !== 'ok') return result;
      result = serializeByteValues(candidate, sink);
      if (result !== 'ok') return result;
      return sink.writeAscii('}');
    }
    if (Array.isArray(candidate)) {
      if (ancestors.has(candidate) || Object.getOwnPropertySymbols(candidate).length > 0) {
        return 'invalid';
      }
      ancestors.add(candidate);
      try {
        for (const key in candidate) {
          const index = Number(key);
          if (
            !Object.hasOwn(candidate, key) ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= candidate.length ||
            String(index) !== key
          ) {
            return 'invalid';
          }
        }

        let result = sink.writeAscii('[');
        if (result !== 'ok') return result;
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            return 'invalid';
          }
          if (index > 0) {
            result = sink.writeAscii(',');
            if (result !== 'ok') return result;
          }
          result = serialize(descriptor.value);
          if (result !== 'ok') return result;
        }
        return sink.writeAscii(']');
      } finally {
        ancestors.delete(candidate);
      }
    }
    if (
      typeof candidate !== 'object' ||
      candidate === undefined ||
      ancestors.has(candidate) ||
      (Object.getPrototypeOf(candidate) !== Object.prototype &&
        Object.getPrototypeOf(candidate) !== null) ||
      Object.getOwnPropertySymbols(candidate).length > 0 ||
      Object.getOwnPropertyNames(candidate).length !== Object.keys(candidate).length
    ) {
      return 'invalid';
    }

    ancestors.add(candidate);
    try {
      let result = sink.writeAscii('{');
      if (result !== 'ok') return result;
      const keys = Object.keys(candidate).sort(compareText);
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          return 'invalid';
        }
        if (index > 0) {
          result = sink.writeAscii(',');
          if (result !== 'ok') return result;
        }
        result = sink.writeJsonString(key);
        if (result !== 'ok') return result;
        result = sink.writeAscii(':');
        if (result !== 'ok') return result;
        result = serialize(descriptor.value);
        if (result !== 'ok') return result;
      }
      return sink.writeAscii('}');
    } finally {
      ancestors.delete(candidate);
    }
  };

  const result = serialize(value);
  return result === 'ok' ? sink.writeAscii('') : result;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPacketByteLimit(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= MAX_PRIVATE_ANALYSIS_PACKET_BYTES;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function isAnalysisUnitType(value: unknown): value is AnalysisUnitType {
  return value === 'logical_message' || value === 'quarantine';
}

function isPacketState(value: unknown): value is 'complete' | 'truncated' | 'unavailable' {
  return value === 'complete' || value === 'truncated' || value === 'unavailable';
}

function normalizeSourceRowIds(sourceRowIds: readonly string[]): string[] {
  if (!Array.isArray(sourceRowIds) || sourceRowIds.length === 0) {
    return invalidPrivateAnalysisInput();
  }

  const normalized = [...sourceRowIds];
  if (
    normalized.some((sourceRowId) => typeof sourceRowId !== 'string' || sourceRowId.length === 0)
  ) {
    return invalidPrivateAnalysisInput();
  }

  normalized.sort(compareText);
  if (normalized.some((sourceRowId, index) => index > 0 && normalized[index - 1] === sourceRowId)) {
    return invalidPrivateAnalysisInput();
  }
  return normalized;
}

function snapshotContextFromManifest(
  manifest: SnapshotManifestV2,
): PrivateThreadCorpusSnapshot['context'] {
  return {
    snapshotId: manifest.snapshotId,
    scope: {
      scopeKeys: [...manifest.scope.scopeKeys],
      transportIds: [...manifest.scope.transportIds],
      participantAddressRef: manifest.scope.participantAddressRef,
      messagePredicate: manifest.scope.messagePredicate,
      quarantinePredicate: manifest.scope.quarantinePredicate,
    },
    asOf: manifest.window.endExclusive,
    exporterVersion: manifest.exporterVersion,
    unscopedQuarantineExcluded: manifest.counts.unscopedQuarantineExcluded,
  };
}

function cloneArtifactFile(
  artifact: PrivateThreadCorpusArtifactFile,
): PrivateThreadCorpusArtifactFile {
  return {
    kind: artifact.kind,
    id: artifact.id,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    content: artifact.content,
  };
}

function canonicalSnapshotDigest(
  snapshot: PrivateThreadCorpusSnapshot,
  records: readonly SnapshotRecord[],
): string {
  const sink = new BoundedCanonicalByteSink(null, false);
  if (
    serializeCanonicalToSink(
      {
        schemaVersion: snapshot.manifest.schemaVersion,
        context: snapshot.context,
        records,
        artifactFiles: snapshot.artifactFiles,
      },
      sink,
    ) !== 'ok'
  ) {
    return invalidPrivateAnalysisInput();
  }
  return sink.digestHex();
}

function reconstructV2Snapshot(
  suppliedSnapshot: PrivateThreadCorpusSnapshot,
): ReconstructedV2Snapshot | null {
  try {
    validatePrivateThreadCorpusSnapshot(suppliedSnapshot);
    const manifest = JSON.parse(suppliedSnapshot.manifestJson) as SnapshotManifestV2;
    const corpusLines = suppliedSnapshot.corpusJsonl.slice(0, -1).split('\n');
    const records = corpusLines.slice(1).map((line) => JSON.parse(line) as SnapshotRecord);
    const snapshot: PrivateThreadCorpusSnapshot = {
      context: snapshotContextFromManifest(manifest),
      corpusJsonl: suppliedSnapshot.corpusJsonl,
      manifestJson: suppliedSnapshot.manifestJson,
      manifest,
      artifactFiles: suppliedSnapshot.artifactFiles.map(cloneArtifactFile),
    };
    validatePrivateThreadCorpusSnapshot(snapshot);
    return {
      snapshot,
      records,
      snapshotDigest: canonicalSnapshotDigest(snapshot, records),
    };
  } catch {
    return null;
  }
}

function sourceMembership(
  sourceRows: readonly SnapshotSourceRow[],
): Array<'centurion_transport' | 'designated_reservationist_mailbox'> {
  const membership = new Set<'centurion_transport' | 'designated_reservationist_mailbox'>();
  for (const sourceRow of sourceRows) {
    for (const sourceScope of sourceRow.scopeMembership) {
      if (
        sourceScope === 'centurion_transport' ||
        sourceScope === 'designated_reservationist_mailbox'
      ) {
        membership.add(sourceScope);
      }
    }
  }

  return ANALYSIS_SOURCE_MEMBERSHIP.filter((sourceScope) => membership.has(sourceScope));
}

function artifactStateFor(
  unitType: AnalysisUnitType,
  sourceRows: readonly SnapshotSourceRow[],
): AnalysisItemV1['artifactState'] {
  if (unitType === 'quarantine') return 'not_applicable';

  let hasAvailable = false;
  let hasUnavailable = false;
  let hasUnknown = false;
  for (const sourceRow of sourceRows) {
    const privateMessage = sourceRow.privateMessage;
    if (!privateMessage) {
      hasUnknown = true;
      continue;
    }

    if (privateMessage.rawMime.status === 'available') {
      hasAvailable = true;
    } else if (privateMessage.rawMime.status !== 'not_applicable') {
      hasUnavailable = true;
    }

    for (const attachment of privateMessage.attachments) {
      if (attachment.textArtifact === null) continue;
      if (attachment.textArtifact.status === 'available') {
        hasAvailable = true;
      } else {
        hasUnavailable = true;
      }
    }
  }

  if (hasAvailable && (hasUnavailable || hasUnknown)) return 'partial';
  if (hasAvailable) return 'complete';
  if (hasUnavailable) return 'unavailable';
  return 'unknown';
}

function responseEvidenceStateFor(
  unitType: AnalysisUnitType,
  sourceRows: readonly SnapshotSourceRow[],
): ResponseEvidenceState {
  if (unitType === 'quarantine') return 'not_applicable';

  const deliveryStates = sourceRows.flatMap((sourceRow) =>
    sourceRow.privateMessage ? [sourceRow.privateMessage.outboundDelivery.deliveryStatus] : [],
  );
  if (deliveryStates.includes('smtp_accepted')) return 'smtp_accepted';
  if (deliveryStates.length > 0 && deliveryStates.every((state) => state === 'not_claimed')) {
    return 'not_claimed';
  }
  return 'unknown';
}

function descriptorFor(
  snapshotId: string,
  unitType: AnalysisUnitType,
  record: ThreadSnapshotRecord | QuarantineSnapshotRecord,
  selectedSourceRows: SnapshotSourceRow[],
): AnalysisDescriptor {
  const sourceRowIds = normalizeSourceRowIds(
    selectedSourceRows.map((sourceRow) => sourceRow.sourceRowId),
  );
  return {
    item: {
      schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
      analysisItemId: deriveAnalysisItemId(snapshotId, unitType, sourceRowIds),
      unitType,
      sourceMembership: sourceMembership(selectedSourceRows),
      artifactState: artifactStateFor(unitType, selectedSourceRows),
      responseEvidenceState: responseEvidenceStateFor(unitType, selectedSourceRows),
    },
    sourceRowIds,
    record,
    selectedSourceRows,
  };
}

function analysisDescriptors(reconstructed: ReconstructedV2Snapshot): AnalysisDescriptor[] {
  const descriptors: AnalysisDescriptor[] = [];
  for (const record of reconstructed.records) {
    if (record.recordType === 'thread') {
      for (const message of record.messages) {
        descriptors.push(
          descriptorFor(
            reconstructed.snapshot.context.snapshotId,
            'logical_message',
            record,
            message.sourceRows,
          ),
        );
      }
      continue;
    }
    descriptors.push(
      descriptorFor(
        reconstructed.snapshot.context.snapshotId,
        'quarantine',
        record,
        record.sourceRows,
      ),
    );
  }
  return descriptors;
}

class CanonicalSelectedArtifactFiles {
  constructor(
    readonly selectedSourceRows: readonly SnapshotSourceRow[],
    readonly artifactFiles: readonly PrivateThreadCorpusArtifactFile[],
  ) {}
}

function isSelectedArtifact(
  artifact: PrivateThreadCorpusArtifactFile,
  selectedSourceRows: readonly SnapshotSourceRow[],
): boolean {
  for (let sourceRowIndex = 0; sourceRowIndex < selectedSourceRows.length; sourceRowIndex += 1) {
    const privateMessage = selectedSourceRows[sourceRowIndex]!.privateMessage;
    if (!privateMessage) continue;
    const rawMimeArtifact = privateMessage.rawMime.artifact;
    if (rawMimeArtifact && artifact.kind === 'raw_mime' && artifact.id === rawMimeArtifact.id) {
      return true;
    }
    for (
      let attachmentIndex = 0;
      attachmentIndex < privateMessage.attachments.length;
      attachmentIndex += 1
    ) {
      const textArtifact = privateMessage.attachments[attachmentIndex]!.textArtifact?.artifact;
      if (textArtifact && artifact.kind === 'attachment_text' && artifact.id === textArtifact.id) {
        return true;
      }
    }
  }
  return false;
}

function serializeSelectedArtifactFiles(
  selection: CanonicalSelectedArtifactFiles,
  sink: CanonicalByteSink,
): CanonicalWriteResult {
  let result = sink.writeAscii('[');
  if (result !== 'ok') return result;
  let selectedCount = 0;
  for (let index = 0; index < selection.artifactFiles.length; index += 1) {
    const artifact = selection.artifactFiles[index]!;
    if (!isSelectedArtifact(artifact, selection.selectedSourceRows)) continue;
    if (selectedCount > 0) {
      result = sink.writeAscii(',');
      if (result !== 'ok') return result;
    }
    result = sink.writeAscii('{');
    if (result !== 'ok') return result;
    result = sink.writeJsonString('bytes');
    if (result !== 'ok') return result;
    result = sink.writeAscii(':');
    if (result !== 'ok') return result;
    result = sink.writeAscii(String(artifact.bytes));
    if (result !== 'ok') return result;
    result = sink.writeAscii(',');
    if (result !== 'ok') return result;
    result = sink.writeJsonString('content');
    if (result !== 'ok') return result;
    result = sink.writeAscii(':');
    if (result !== 'ok') return result;
    result = serializeByteValues(artifact.content, sink);
    if (result !== 'ok') return result;
    result = sink.writeAscii(',');
    if (result !== 'ok') return result;
    result = sink.writeJsonString('id');
    if (result !== 'ok') return result;
    result = sink.writeAscii(':');
    if (result !== 'ok') return result;
    result = sink.writeJsonString(artifact.id);
    if (result !== 'ok') return result;
    result = sink.writeAscii(',');
    if (result !== 'ok') return result;
    result = sink.writeJsonString('kind');
    if (result !== 'ok') return result;
    result = sink.writeAscii(':');
    if (result !== 'ok') return result;
    result = sink.writeJsonString(artifact.kind);
    if (result !== 'ok') return result;
    result = sink.writeAscii(',');
    if (result !== 'ok') return result;
    result = sink.writeJsonString('sha256');
    if (result !== 'ok') return result;
    result = sink.writeAscii(':');
    if (result !== 'ok') return result;
    result = sink.writeJsonString(artifact.sha256);
    if (result !== 'ok') return result;
    result = sink.writeAscii('}');
    if (result !== 'ok') return result;
    selectedCount += 1;
  }
  return sink.writeAscii(']');
}

function selectedArtifactFiles(
  selectedSourceRows: readonly SnapshotSourceRow[],
  artifactFiles: readonly PrivateThreadCorpusArtifactFile[],
): CanonicalSelectedArtifactFiles {
  return new CanonicalSelectedArtifactFiles(selectedSourceRows, artifactFiles);
}

type SerializedPrivatePacket =
  | { state: 'complete'; packetBytes: Uint8Array; packetSha256: string }
  | { state: 'exceeded' }
  | { state: 'invalid' };

function serializePrivatePacket(
  reconstructed: ReconstructedV2Snapshot,
  descriptor: AnalysisDescriptor,
  maxPacketBytes: number,
): SerializedPrivatePacket {
  if (maxPacketBytes < MIN_PRIVATE_ANALYSIS_PACKET_BYTES) return { state: 'exceeded' };
  const sink = new BoundedCanonicalByteSink(maxPacketBytes, true);
  const result = serializeCanonicalToSink(
    {
      schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
      snapshotId: reconstructed.snapshot.context.snapshotId,
      unit: {
        unitType: descriptor.item.unitType,
        sourceRowIds: descriptor.sourceRowIds,
      },
      record: descriptor.record,
      artifactFiles: selectedArtifactFiles(
        descriptor.selectedSourceRows,
        reconstructed.snapshot.artifactFiles,
      ),
    },
    sink,
  );
  if (result === 'exceeded') return { state: 'exceeded' };
  if (result !== 'ok') return { state: 'invalid' };
  const packetBytes = sink.finishBytes();
  if (!packetBytes) return { state: 'invalid' };
  return {
    state: 'complete',
    packetBytes,
    packetSha256: sink.digestHex(),
  };
}

function unavailablePacket(item: AnalysisItemV1): PrivateAnalysisPacketV1 {
  return {
    ...item,
    packetState: 'unavailable',
    packetBytes: 0,
    packetSha256: null,
    omissionReason: 'unavailable_evidence',
  };
}

function truncatedPacket(
  item: AnalysisItemV1,
  omissionReason: 'per_packet_limit' | 'aggregate_packet_limit',
): PrivateAnalysisPacketV1 {
  return {
    ...item,
    packetState: 'truncated',
    packetBytes: 0,
    packetSha256: null,
    omissionReason,
  };
}

function completePacket(
  item: AnalysisItemV1,
  packetBytes: Uint8Array,
  packetSha256: string,
): PrivateAnalysisPacketV1 {
  return {
    ...item,
    packetState: 'complete',
    packetBytes: packetBytes.byteLength,
    packetSha256,
    privatePacketBytes: packetBytes,
  };
}

function preparedManifestJson(manifest: PreparedAnalysisManifestV1): string {
  return canonicalJson({
    schemaVersion: manifest.schemaVersion,
    snapshotId: manifest.snapshotId,
    snapshotDigest: manifest.snapshotDigest,
    maxPacketBytes: manifest.maxPacketBytes,
    maxTotalPacketBytes: manifest.maxTotalPacketBytes,
    packets: manifest.packets.map((packet) => ({
      analysisItemId: packet.analysisItemId,
      unitType: packet.unitType,
      packetState: packet.packetState,
      packetSha256: packet.packetSha256,
    })),
  });
}

function parsePreparedManifest(value: unknown): PreparedAnalysisManifestV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'snapshotId',
      'snapshotDigest',
      'maxPacketBytes',
      'maxTotalPacketBytes',
      'packets',
    ]) ||
    value.schemaVersion !== CENTURION_THREAD_CORPUS_ANALYSIS_VERSION ||
    typeof value.snapshotId !== 'string' ||
    !isSha256Digest(value.snapshotDigest) ||
    !isPacketByteLimit(value.maxPacketBytes) ||
    !isNonNegativeSafeInteger(value.maxTotalPacketBytes) ||
    !Array.isArray(value.packets)
  ) {
    return null;
  }

  const packets: PreparedAnalysisManifestV1['packets'] = [];
  for (const packet of value.packets) {
    if (
      !isRecord(packet) ||
      !hasExactKeys(packet, ['analysisItemId', 'unitType', 'packetState', 'packetSha256']) ||
      !isSha256Digest(packet.analysisItemId) ||
      !isAnalysisUnitType(packet.unitType) ||
      !isPacketState(packet.packetState)
    ) {
      return null;
    }
    const packetSha256 = packet.packetSha256;
    if (packet.packetState === 'complete') {
      if (!isSha256Digest(packetSha256)) return null;
      packets.push({
        analysisItemId: packet.analysisItemId,
        unitType: packet.unitType,
        packetState: packet.packetState,
        packetSha256,
      });
      continue;
    }
    if (packetSha256 !== null) return null;
    packets.push({
      analysisItemId: packet.analysisItemId,
      unitType: packet.unitType,
      packetState: packet.packetState,
      packetSha256: null,
    });
  }

  return {
    schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
    snapshotId: value.snapshotId,
    snapshotDigest: value.snapshotDigest,
    maxPacketBytes: value.maxPacketBytes,
    maxTotalPacketBytes: value.maxTotalPacketBytes,
    packets,
  };
}

function samePreparedManifest(
  left: PreparedAnalysisManifestV1,
  right: PreparedAnalysisManifestV1,
): boolean {
  return preparedManifestJson(left) === preparedManifestJson(right);
}

function analysisItemForPacket(packet: AnalysisItemV1): AnalysisItemV1 {
  return {
    schemaVersion: packet.schemaVersion,
    analysisItemId: packet.analysisItemId,
    unitType: packet.unitType,
    sourceMembership: [...packet.sourceMembership],
    artifactState: packet.artifactState,
    responseEvidenceState: packet.responseEvidenceState,
  };
}

function matchesAnalysisItem(value: unknown, expected: AnalysisItemV1): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'analysisItemId',
      'unitType',
      'sourceMembership',
      'artifactState',
      'responseEvidenceState',
    ]) &&
    value.schemaVersion === expected.schemaVersion &&
    value.analysisItemId === expected.analysisItemId &&
    value.unitType === expected.unitType &&
    Array.isArray(value.sourceMembership) &&
    value.sourceMembership.every((sourceMembership) => typeof sourceMembership === 'string') &&
    value.sourceMembership.length === expected.sourceMembership.length &&
    value.sourceMembership.every(
      (sourceMembership, index) => sourceMembership === expected.sourceMembership[index],
    ) &&
    value.artifactState === expected.artifactState &&
    value.responseEvidenceState === expected.responseEvidenceState
  );
}

function parseReconciledAnalystDecisions(
  value: unknown,
): SuppliedReconciledAnalystDecisions | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'snapshotId',
      'snapshotDigest',
      'preparedManifestSha256',
      'preparedManifest',
      'items',
      'decisions',
    ]) ||
    typeof value.snapshotId !== 'string' ||
    !isSha256Digest(value.snapshotDigest) ||
    !isSha256Digest(value.preparedManifestSha256) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.decisions)
  ) {
    return null;
  }

  const preparedManifest = parsePreparedManifest(value.preparedManifest);
  if (!preparedManifest) return null;
  return {
    snapshotId: value.snapshotId,
    snapshotDigest: value.snapshotDigest,
    preparedManifestSha256: value.preparedManifestSha256,
    preparedManifest,
    items: value.items,
    decisions: value.decisions,
  };
}

export function deriveAnalysisItemId(
  snapshotId: string,
  unitType: AnalysisUnitType,
  sourceRowIds: readonly string[],
): string {
  if (typeof snapshotId !== 'string' || snapshotId.length === 0 || !isAnalysisUnitType(unitType)) {
    return invalidPrivateAnalysisInput();
  }
  const normalizedSourceRowIds = normalizeSourceRowIds(sourceRowIds);
  return sha256Text(
    canonicalJson({
      schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
      snapshotId,
      unitType,
      sourceRowIds: normalizedSourceRowIds,
    }),
  );
}

export function createAnalysisItems(snapshot: PrivateThreadCorpusSnapshot): AnalysisItemV1[] {
  const reconstructed = reconstructV2Snapshot(snapshot);
  if (!reconstructed) return invalidPrivateAnalysisInput();
  return analysisDescriptors(reconstructed).map((descriptor) => descriptor.item);
}

function preparePrivateAnalysisFromReconstructed(
  reconstructed: ReconstructedV2Snapshot,
  limits: { maxPacketBytes: number; maxTotalPacketBytes: number },
): PreparedPrivateAnalysisV1 | null {
  let totalPacketBytes = 0;
  const packets: PrivateAnalysisPacketV1[] = [];
  for (const descriptor of analysisDescriptors(reconstructed)) {
    const candidate = serializePrivatePacket(reconstructed, descriptor, limits.maxPacketBytes);
    if (candidate.state === 'invalid') return null;
    if (candidate.state === 'exceeded') {
      packets.push(truncatedPacket(descriptor.item, 'per_packet_limit'));
      continue;
    }
    if (descriptor.item.artifactState === 'unknown') {
      packets.push(unavailablePacket(descriptor.item));
      continue;
    }
    const remainingTotalBytes = limits.maxTotalPacketBytes - totalPacketBytes;
    if (candidate.packetBytes.byteLength > remainingTotalBytes) {
      packets.push(truncatedPacket(descriptor.item, 'aggregate_packet_limit'));
      continue;
    }
    totalPacketBytes += candidate.packetBytes.byteLength;
    packets.push(completePacket(descriptor.item, candidate.packetBytes, candidate.packetSha256));
  }
  const manifest: PreparedAnalysisManifestV1 = {
    schemaVersion: CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
    snapshotId: reconstructed.snapshot.context.snapshotId,
    snapshotDigest: reconstructed.snapshotDigest,
    maxPacketBytes: limits.maxPacketBytes,
    maxTotalPacketBytes: limits.maxTotalPacketBytes,
    packets: packets.map((packet) => ({
      analysisItemId: packet.analysisItemId,
      unitType: packet.unitType,
      packetState: packet.packetState,
      packetSha256: packet.packetSha256,
    })),
  };

  return {
    manifest,
    manifestSha256: sha256Text(preparedManifestJson(manifest)),
    packets,
  };
}

export function preparePrivateAnalysis(
  snapshot: PrivateThreadCorpusSnapshot,
  limits: { maxPacketBytes: number; maxTotalPacketBytes: number },
): PreparedPrivateAnalysisV1 | null {
  try {
    if (
      !isRecord(limits) ||
      !isPacketByteLimit(limits.maxPacketBytes) ||
      !isNonNegativeSafeInteger(limits.maxTotalPacketBytes)
    ) {
      return null;
    }
    const reconstructed = reconstructV2Snapshot(snapshot);
    if (!reconstructed) return null;
    return preparePrivateAnalysisFromReconstructed(reconstructed, limits);
  } catch {
    return null;
  }
}

function validateReconciledAnalystDecisionsForPrepared(
  supplied: SuppliedReconciledAnalystDecisions,
  prepared: PreparedPrivateAnalysisV1,
): ReconciledAnalystDecisionsV1 | null {
  if (
    supplied.snapshotId !== prepared.manifest.snapshotId ||
    supplied.snapshotDigest !== prepared.manifest.snapshotDigest ||
    supplied.preparedManifestSha256 !== prepared.manifestSha256 ||
    !samePreparedManifest(supplied.preparedManifest, prepared.manifest) ||
    supplied.items.length !== prepared.packets.length ||
    supplied.decisions.length !== prepared.packets.length
  ) {
    return null;
  }

  const decisions: AnalystDecisionV1[] = [];
  for (const [index, packet] of prepared.packets.entries()) {
    if (!matchesAnalysisItem(supplied.items[index], analysisItemForPacket(packet))) {
      return null;
    }

    const parsedDecision = analystDecisionSchema.safeParse(supplied.decisions[index]);
    if (
      !parsedDecision.success ||
      parsedDecision.data.analysisItemId !== packet.analysisItemId ||
      (packet.packetState !== 'complete' &&
        (parsedDecision.data.workflow !== 'unknown' ||
          parsedDecision.data.risk !== 'human_review' ||
          parsedDecision.data.confidence !== 'low' ||
          parsedDecision.data.attention !== 'human_review'))
    ) {
      return null;
    }
    decisions.push(parsedDecision.data);
  }

  return {
    snapshotId: prepared.manifest.snapshotId,
    snapshotDigest: prepared.manifest.snapshotDigest,
    preparedManifestSha256: prepared.manifestSha256,
    preparedManifest: prepared.manifest,
    items: prepared.packets.map(analysisItemForPacket),
    decisions,
  };
}

export function validateReconciledAnalystDecisions(
  snapshot: PrivateThreadCorpusSnapshot,
  reconciled: unknown,
): ReconciledAnalystDecisionsV1 | null {
  try {
    const reconstructed = reconstructV2Snapshot(snapshot);
    if (!reconstructed) return null;
    const supplied = parseReconciledAnalystDecisions(reconciled);
    if (!supplied) return null;

    const prepared = preparePrivateAnalysisFromReconstructed(reconstructed, {
      maxPacketBytes: supplied.preparedManifest.maxPacketBytes,
      maxTotalPacketBytes: supplied.preparedManifest.maxTotalPacketBytes,
    });
    if (!prepared) return null;
    return validateReconciledAnalystDecisionsForPrepared(supplied, prepared);
  } catch {
    return null;
  }
}

export function reconcileAnalystDecisionBundle(
  snapshot: PrivateThreadCorpusSnapshot,
  preparedManifest: PreparedAnalysisManifestV1,
  decisionBundle: unknown,
): ReconciledAnalystDecisionsV1 | null {
  try {
    const suppliedManifest = parsePreparedManifest(preparedManifest);
    if (!suppliedManifest) return null;
    const reconstructed = reconstructV2Snapshot(snapshot);
    if (!reconstructed) return null;
    const prepared = preparePrivateAnalysisFromReconstructed(reconstructed, {
      maxPacketBytes: suppliedManifest.maxPacketBytes,
      maxTotalPacketBytes: suppliedManifest.maxTotalPacketBytes,
    });
    if (!prepared) return null;
    if (!samePreparedManifest(suppliedManifest, prepared.manifest)) {
      return null;
    }

    const parsedDecisionBundle = analystDecisionBundleSchema.safeParse(decisionBundle);
    if (
      !parsedDecisionBundle.success ||
      parsedDecisionBundle.data.preparedManifestSha256 !== prepared.manifestSha256
    ) {
      return null;
    }

    const decisionsByItemId = new Map<string, AnalystDecisionV1>();
    for (const decision of parsedDecisionBundle.data.decisions) {
      const packet = prepared.packets.find(
        (candidate) => candidate.analysisItemId === decision.analysisItemId,
      );
      if (
        !packet ||
        decisionsByItemId.has(decision.analysisItemId) ||
        (packet.packetState !== 'complete' &&
          (decision.workflow !== 'unknown' ||
            decision.risk !== 'human_review' ||
            decision.confidence !== 'low' ||
            decision.attention !== 'human_review'))
      ) {
        return null;
      }
      decisionsByItemId.set(decision.analysisItemId, decision);
    }
    if (decisionsByItemId.size !== prepared.packets.length) return null;

    const items = analysisDescriptors(reconstructed).map((descriptor) => descriptor.item);
    const decisions = prepared.packets.map(
      (packet) => decisionsByItemId.get(packet.analysisItemId)!,
    );
    const suppliedReconciled = parseReconciledAnalystDecisions({
      snapshotId: prepared.manifest.snapshotId,
      snapshotDigest: prepared.manifest.snapshotDigest,
      preparedManifestSha256: prepared.manifestSha256,
      preparedManifest: prepared.manifest,
      items,
      decisions,
    });
    return suppliedReconciled
      ? validateReconciledAnalystDecisionsForPrepared(suppliedReconciled, prepared)
      : null;
  } catch {
    return null;
  }
}
