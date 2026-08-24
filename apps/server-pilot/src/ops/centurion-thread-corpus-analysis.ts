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

const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();
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

function sha256Bytes(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function canonicalPacketJson(value: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (candidate: unknown): string => {
    if (candidate === null) return 'null';
    if (typeof candidate === 'string' || typeof candidate === 'boolean') {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === 'number') {
      if (!Number.isSafeInteger(candidate) || Object.is(candidate, -0)) {
        return invalidPrivateAnalysisInput();
      }
      return JSON.stringify(candidate);
    }
    if (candidate instanceof Uint8Array) {
      return `{"$centurionUint8Array":${serialize([...candidate])}}`;
    }
    if (Array.isArray(candidate)) {
      if (
        ancestors.has(candidate) ||
        Object.getOwnPropertySymbols(candidate).length > 0 ||
        Object.keys(candidate).length !== candidate.length ||
        [...candidate.keys()].some((index) => !Object.hasOwn(candidate, index))
      ) {
        return invalidPrivateAnalysisInput();
      }
      ancestors.add(candidate);
      try {
        return `[${candidate.map(serialize).join(',')}]`;
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
      return invalidPrivateAnalysisInput();
    }

    ancestors.add(candidate);
    try {
      return `{${Object.keys(candidate)
        .sort(compareText)
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            return invalidPrivateAnalysisInput();
          }
          return `${JSON.stringify(key)}:${serialize(descriptor.value)}`;
        })
        .join(',')}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return serialize(value);
}

function canonicalPacketBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalPacketJson(value));
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
    content: new Uint8Array(artifact.content),
  };
}

function canonicalSnapshotDigest(
  snapshot: PrivateThreadCorpusSnapshot,
  records: readonly SnapshotRecord[],
): string {
  return sha256Bytes(
    canonicalPacketBytes({
      schemaVersion: snapshot.manifest.schemaVersion,
      context: snapshot.context,
      records,
      artifactFiles: snapshot.artifactFiles,
    }),
  );
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

function selectedArtifactFiles(
  selectedSourceRows: readonly SnapshotSourceRow[],
  artifactFiles: readonly PrivateThreadCorpusArtifactFile[],
): Array<{
  kind: PrivateThreadCorpusArtifactFile['kind'];
  id: string;
  sha256: string;
  bytes: number;
  content: number[];
}> {
  const selectedArtifactKeys = new Set<string>();
  for (const sourceRow of selectedSourceRows) {
    const privateMessage = sourceRow.privateMessage;
    if (!privateMessage) continue;
    if (privateMessage.rawMime.artifact) {
      selectedArtifactKeys.add(`raw_mime\u0000${privateMessage.rawMime.artifact.id}`);
    }
    for (const attachment of privateMessage.attachments) {
      if (attachment.textArtifact?.artifact) {
        selectedArtifactKeys.add(`attachment_text\u0000${attachment.textArtifact.artifact.id}`);
      }
    }
  }

  return artifactFiles
    .filter((artifact) => selectedArtifactKeys.has(`${artifact.kind}\u0000${artifact.id}`))
    .map((artifact) => ({
      kind: artifact.kind,
      id: artifact.id,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      content: [...artifact.content],
    }));
}

function privatePacketBytes(
  reconstructed: ReconstructedV2Snapshot,
  descriptor: AnalysisDescriptor,
): Uint8Array {
  return canonicalPacketBytes({
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
  });
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

function completePacket(item: AnalysisItemV1, packetBytes: Uint8Array): PrivateAnalysisPacketV1 {
  return {
    ...item,
    packetState: 'complete',
    packetBytes: packetBytes.byteLength,
    packetSha256: sha256Bytes(packetBytes),
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
    !isNonNegativeSafeInteger(value.maxPacketBytes) ||
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

export function preparePrivateAnalysis(
  snapshot: PrivateThreadCorpusSnapshot,
  limits: { maxPacketBytes: number; maxTotalPacketBytes: number },
): PreparedPrivateAnalysisV1 | null {
  try {
    if (
      !isRecord(limits) ||
      !isNonNegativeSafeInteger(limits.maxPacketBytes) ||
      !isNonNegativeSafeInteger(limits.maxTotalPacketBytes)
    ) {
      return null;
    }
    const reconstructed = reconstructV2Snapshot(snapshot);
    if (!reconstructed) return null;

    let totalPacketBytes = 0;
    const packets = analysisDescriptors(reconstructed).map((descriptor) => {
      const candidateBytes = privatePacketBytes(reconstructed, descriptor);
      if (candidateBytes.byteLength > limits.maxPacketBytes) {
        return truncatedPacket(descriptor.item, 'per_packet_limit');
      }
      if (descriptor.item.artifactState === 'unknown') {
        return unavailablePacket(descriptor.item);
      }
      if (candidateBytes.byteLength > limits.maxTotalPacketBytes - totalPacketBytes) {
        return truncatedPacket(descriptor.item, 'aggregate_packet_limit');
      }
      totalPacketBytes += candidateBytes.byteLength;
      return completePacket(descriptor.item, candidateBytes);
    });
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
    const prepared = preparePrivateAnalysis(snapshot, {
      maxPacketBytes: suppliedManifest.maxPacketBytes,
      maxTotalPacketBytes: suppliedManifest.maxTotalPacketBytes,
    });
    if (!prepared || !samePreparedManifest(suppliedManifest, prepared.manifest)) {
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

    const reconstructed = reconstructV2Snapshot(snapshot);
    if (!reconstructed) return null;
    const items = analysisDescriptors(reconstructed).map((descriptor) => descriptor.item);
    const decisions = prepared.packets.map(
      (packet) => decisionsByItemId.get(packet.analysisItemId)!,
    );
    return {
      snapshotId: prepared.manifest.snapshotId,
      snapshotDigest: prepared.manifest.snapshotDigest,
      preparedManifestSha256: prepared.manifestSha256,
      items,
      decisions,
    };
  } catch {
    return null;
  }
}
