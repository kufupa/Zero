/**
 * Post-freeze semantic comparison of Centurion predictions with human gold.
 *
 * The comparator is deliberately local and read-only. It verifies the U1/U2
 * sealed source ledgers, the U3 classification input hashes, and both U4
 * freeze files before it gives an injected gold transport access to an actual
 * outbound body. It never treats a mail claim as a PMS receipt or read.
 */
import {
  CENTURION_TRANSPORT_ID,
  CENTURION_WINDOW_END_UTC,
  CENTURION_WINDOW_START_UTC,
  CENTURION_WINDOW_TIMEZONE,
} from '../src/ops/centurion-thread-corpus-postgres-reader.js';
import {
  HUMAN_RESPONSE_OPERATIONS,
  choosePrimaryOperation,
  type HumanResponseNeedLevel,
  type HumanResponseOperation,
} from './analyse-centurion-human-responses.js';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export {
  CENTURION_TRANSPORT_ID,
  CENTURION_WINDOW_END_UTC,
  CENTURION_WINDOW_START_UTC,
  CENTURION_WINDOW_TIMEZONE,
} from '../src/ops/centurion-thread-corpus-postgres-reader.js';

export const GOLD_COMPARISON_SCHEMA_VERSION = 'centurion-gold-comparison-v1' as const;
export const GOLD_AUDIT_SCHEMA_VERSION = 'centurion-gold-audit-v1' as const;
export const TOOL_DEMAND_REPORT_SCHEMA_VERSION = 'centurion-tool-demand-report-v1' as const;
export const GOLD_COMPARATOR_PROMPT_VERSION = 'centurion-human-gold-comparator-v1' as const;
export const GOLD_COMPARATOR_MODEL_ID = 'gpt-5.6-luna-max' as const;
export const DEFAULT_MAX_WORKERS = 5 as const;
export const DEFAULT_MAX_RETRIES = 1 as const;

const ANALYSIS_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TARGET_STATUSES = ['paired', 'ambiguous', 'no_eligible_inbound', 'outbound_only'] as const;
const STRATA = [
  'paired',
  'answered',
  'unanswered',
  'ambiguous',
  'no_eligible_inbound',
  'outbound_only',
  'late',
  'context_incomplete',
  'prediction_error',
  'automated',
  'unavailable',
] as const;
const GRADES = [
  'match',
  'partial',
  'mismatch',
  'prediction_error',
  'unavailable',
  'not_scored',
] as const;

type JsonRecord = Record<string, unknown>;
type SourceKind = 'normal' | 'quarantine';
type TargetStatus = (typeof TARGET_STATUSES)[number];
export type GoldStratum = (typeof STRATA)[number];
export type GoldGrade = (typeof GRADES)[number];

export type GoldOperation = {
  operation: HumanResponseOperation;
  needLevel: HumanResponseNeedLevel;
  requiredFields: string[];
  candidateTool: string | null;
  unknownReason: string | null;
};

export type GoldComparatorTarget = {
  targetKey: string;
  source: SourceKind;
  sourceRecordId: string;
  eventAt: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: GoldAttachment[];
  bodyHash: string;
  headerHash: string;
  attachmentHash: string;
};

export type GoldAttachment = {
  attachmentId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  contentId: string | null;
  availability: 'available' | 'unsupported' | 'oversized' | 'malformed' | 'unavailable';
  sourceRecordId: string;
};

export type HumanGoldComparatorRequest = {
  comparatorId: string;
  modelId: string;
  modelVersion: string;
  promptVersion: typeof GOLD_COMPARATOR_PROMPT_VERSION;
  target: GoldComparatorTarget;
};

export type HumanGoldComparatorResponse = {
  opaqueId: string;
  operations: GoldOperation[];
  primaryOperation: HumanResponseOperation;
  needLevel: HumanResponseNeedLevel;
  requiredFields: string[];
  candidateTool: string | null;
  unknownReason: string | null;
};

export type HumanGoldComparatorTransport = {
  compare(request: HumanGoldComparatorRequest): Promise<unknown>;
};

export type VerifiedPmsAction = {
  status: 'observed' | 'not_observed';
  operations: GoldOperation[];
  evidenceIds: string[];
  authority: 'pms_receipt' | 'pms_read' | 'none';
};

export type GoldClaimedAction = {
  status: 'observed' | 'unavailable' | 'not_applicable';
  operations: GoldOperation[];
  comparatorId: string | null;
  errorCode: string | null;
};

export type GoldComparisonRecord = {
  schemaVersion: typeof GOLD_COMPARISON_SCHEMA_VERSION;
  taskId: string;
  targetKey: string;
  source: SourceKind | null;
  sourceRecordId: string | null;
  eventAt: string | null;
  targetStatus: TargetStatus | null;
  strata: GoldStratum[];
  workflow: string | null;
  secondaryWorkflows: string[];
  predicted_operations: GoldOperation[];
  claimed_action: GoldClaimedAction;
  verified_pms_action: VerifiedPmsAction;
  grade: GoldGrade;
  mismatchReasons: string[];
  evidenceIds: string[];
  predictionError: string | null;
  lateResponse: boolean;
  contextIncomplete: boolean;
};

export type ToolDemandRanking = {
  operation: HumanResponseOperation;
  candidateTool: string | null;
  workflow: string | null;
  distinctTaskCount: number;
  answeredCount: number;
  unansweredCount: number;
  ambiguousCount: number;
  unavailableCount: number;
  automatedCount: number;
  contextIncompleteCount: number;
  predictionErrorCount: number;
  evidenceIds: string[];
};

export type ToolDemandReport = {
  schemaVersion: typeof TOOL_DEMAND_REPORT_SCHEMA_VERSION;
  snapshotId: string;
  sourceSnapshotIds: { normal: string; quarantine: string };
  taskCount: number;
  comparisonRecordCount: number;
  rankings: ToolDemandRanking[];
  stratumCounts: Record<GoldStratum, number>;
  gradeCounts: Record<GoldGrade, number>;
};

export type GoldAudit = {
  schemaVersion: typeof GOLD_AUDIT_SCHEMA_VERSION;
  snapshotId: string;
  sourceManifests: {
    normal: { snapshotId: string; manifestHash: string; orderedHash: string };
    quarantine: { snapshotId: string; manifestHash: string; orderedHash: string };
  };
  classification: {
    snapshotId: string;
    orderedHash: string;
    recordCount: number;
    inputHashesVerified: boolean;
  };
  targetManifestHash: string;
  predictionFreezeHash: string;
  targetCount: number;
  comparisonRecordCount: number;
  supplementalRecordCount: number;
  stratumCounts: Record<GoldStratum, number>;
  gradeCounts: Record<GoldGrade, number>;
  claimedObservedCount: number;
  claimedUnavailableCount: number;
  verifiedObservedCount: number;
  verifiedNotObservedCount: number;
  comparatorRuntimeBlockers: string[];
  privacy: {
    targetBodiesPersisted: false;
    addressesPersisted: false;
    attachmentsPersisted: false;
    stagehandHandoffSanitized: true;
  };
};

export type CompareCenturionHumanGoldRun = {
  snapshotId: string;
  outputDir: string;
  records: GoldComparisonRecord[];
  report: ToolDemandReport;
  audit: GoldAudit;
};

export type CompareCenturionHumanGoldOptions = {
  normalSnapshotDir: string;
  quarantineSnapshotDir: string;
  classificationPath?: string;
  classificationOutputDir?: string;
  classificationAuditPath?: string;
  targetManifestPath?: string;
  predictionFreezePath?: string;
  humanAnalysisDir?: string;
  outputDir: string;
  snapshotId: string;
  goldTransport?: HumanGoldComparatorTransport;
  modelId?: string;
  modelVersion?: string;
  maxWorkers?: number;
  maxRetries?: number;
  cutoffAt?: string;
  verifiedPmsActions?: Record<string, VerifiedPmsAction>;
};

type LoadedSnapshot = {
  kind: SourceKind;
  records: JsonRecord[];
  snapshotId: string;
  manifestRaw: string;
  manifestHash: string;
  orderedHash: string;
  manifest: JsonRecord;
};

type LoadedClassifications = {
  records: JsonRecord[];
  byKey: Map<string, JsonRecord>;
  audit: JsonRecord;
  orderedHash: string;
  raw: string;
};

type LoadedU4 = {
  targets: JsonRecord[];
  predictions: JsonRecord[];
  targetRaw: string;
  predictionRaw: string;
  targetHash: string;
  predictionHash: string;
};

type SourceMessage = {
  source: SourceKind;
  sourceRecordId: string;
  recordKey: string;
  raw: JsonRecord;
  eventAt: string | null;
  body: string;
  htmlBody: string;
  subject: string;
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadId: string | null;
  attachments: GoldAttachment[];
  classification: JsonRecord | null;
};

type PreparedInputs = {
  normal: LoadedSnapshot;
  quarantine: LoadedSnapshot;
  classifications: LoadedClassifications;
  u4: LoadedU4;
  messages: Map<string, SourceMessage>;
};

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function objectHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fail(code);
  return value;
}

function nullableText(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return fail(code);
  return value;
}

function strictStrings(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return fail(code);
  return [...(value as string[])];
}

function looseStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function iso(value: unknown, code: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return fail(code);
  return value;
}

function validHash(value: unknown, code: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) return fail(code);
  return value;
}

function normalizeJsonl(raw: string, fileName: string): JsonRecord[] {
  if (raw === '') return [];
  if (!raw.endsWith('\n')) return fail(`${fileName}_missing_terminal_newline`);
  const lines = raw.slice(0, -1).split('\n');
  return lines.map((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return fail(`${fileName}_record_${index}_not_object`);
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${fileName}_`)) throw error;
      return fail(`${fileName}_record_${index}_invalid_json`);
    }
  });
}

async function readFileJson(pathName: string, code: string): Promise<JsonRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pathName, 'utf8'));
  } catch {
    return fail(code);
  }
  if (!isRecord(parsed)) return fail(code);
  return parsed;
}

function validateManifestWindow(manifest: JsonRecord, kind: SourceKind): void {
  if (!isRecord(manifest.window)) return fail(`${kind}_manifest_window_invalid`);
  if (
    manifest.window.startInclusive !== CENTURION_WINDOW_START_UTC ||
    manifest.window.endExclusive !== CENTURION_WINDOW_END_UTC ||
    manifest.window.timezone !== CENTURION_WINDOW_TIMEZONE
  )
    return fail(`${kind}_manifest_window_mismatch`);
}

async function readSealedSnapshot(directory: string, kind: SourceKind): Promise<LoadedSnapshot> {
  const absolute = path.resolve(directory);
  const manifestPath = path.join(absolute, 'manifest.json');
  const recordPath = path.join(absolute, kind === 'normal' ? 'messages.jsonl' : 'quarantine.jsonl');
  const manifestRaw = await readFile(manifestPath, 'utf8').catch(() =>
    fail(`${kind}_manifest_missing`),
  );
  const manifest = await readFileJson(manifestPath, `${kind}_manifest_invalid_json`);
  const expectedSchema =
    kind === 'normal' ? 'centurion-nine-day-corpus-v1' : 'centurion-quarantine-v1';
  if (manifest.schemaVersion !== expectedSchema) return fail(`${kind}_manifest_schema_mismatch`);
  if (manifest.transportId !== CENTURION_TRANSPORT_ID)
    return fail(`${kind}_manifest_transport_mismatch`);
  const snapshotId = requiredText(manifest.snapshotId, `${kind}_snapshot_id_missing`);
  if (!/^[A-Za-z0-9._-]+$/.test(snapshotId)) return fail(`${kind}_snapshot_id_invalid`);
  iso(manifest.asOf, `${kind}_manifest_as_of_invalid`);
  validateManifestWindow(manifest, kind);
  const recordsRaw = await readFile(recordPath, 'utf8').catch(() =>
    fail(`${kind}_records_missing`),
  );
  const records = normalizeJsonl(
    recordsRaw,
    kind === 'normal' ? 'messages.jsonl' : 'quarantine.jsonl',
  );
  const orderedHash = sha256(records.map((record) => JSON.stringify(record)).join('\n'));
  const expectedOrdered =
    kind === 'normal' ? manifest.orderedMessageSha256 : manifest.orderedRecordSha256;
  if (expectedOrdered !== orderedHash) return fail(`${kind}_ordered_hash_mismatch`);
  const seen = new Set<string>();
  for (const record of records) {
    if (kind === 'quarantine' && record.recordType !== 'quarantine')
      return fail('quarantine_record_schema_mismatch');
    const id = requiredText(record.id, `${kind}_record_id_missing`);
    if (seen.has(id)) return fail(`${kind}_record_id_duplicate`);
    seen.add(id);
  }
  return {
    kind,
    records,
    snapshotId,
    manifestRaw,
    manifestHash: sha256(manifestRaw),
    orderedHash,
    manifest,
  };
}

function sourceRecordKey(source: SourceKind, id: string): string {
  return `${source}:${id}`;
}

function attachmentAvailability(value: unknown): GoldAttachment['availability'] {
  return value === 'available' ||
    value === 'unsupported' ||
    value === 'oversized' ||
    value === 'malformed' ||
    value === 'unavailable'
    ? value
    : 'available';
}

function normalAttachments(record: JsonRecord, sourceRecordId: string): GoldAttachment[] {
  if (!Array.isArray(record.attachmentDescriptors)) return [];
  return record.attachmentDescriptors.filter(isRecord).map((attachment) => ({
    attachmentId: text(attachment.id),
    filename: text(attachment.filename) ?? '',
    contentType: text(attachment.contentType) ?? 'application/octet-stream',
    byteSize:
      typeof attachment.byteSize === 'number' && Number.isSafeInteger(attachment.byteSize)
        ? attachment.byteSize
        : 0,
    contentId: nullableText(attachment.contentId, 'normal_attachment_content_id_invalid'),
    availability: 'available',
    sourceRecordId,
  }));
}

function quarantineAttachments(record: JsonRecord, sourceRecordId: string): GoldAttachment[] {
  if (!Array.isArray(record.attachments)) return [];
  return record.attachments.filter(isRecord).map((attachment) => ({
    attachmentId: null,
    filename: text(attachment.filename) ?? '',
    contentType: text(attachment.contentType) ?? 'application/octet-stream',
    byteSize:
      typeof attachment.byteSize === 'number' && Number.isSafeInteger(attachment.byteSize)
        ? attachment.byteSize
        : 0,
    contentId: nullableText(attachment.contentId, 'quarantine_attachment_content_id_invalid'),
    availability: attachmentAvailability(attachment.contentStatus),
    sourceRecordId,
  }));
}

function sourceMessage(
  record: JsonRecord,
  source: SourceKind,
  classification: JsonRecord | null,
): SourceMessage {
  const sourceRecordId = requiredText(record.id, `${source}_record_id_missing`);
  const eventAt =
    source === 'normal'
      ? nullableText(record.eventAt, `${source}_event_at_invalid`)
      : nullableText(record.messageDate, `${source}_message_date_invalid`);
  return {
    source,
    sourceRecordId,
    recordKey: sourceRecordKey(source, sourceRecordId),
    raw: record,
    eventAt,
    body: text(record.textBody) ?? '',
    htmlBody: text(record.htmlBody) ?? '',
    subject: text(record.subject) ?? '',
    from: looseStrings(record.from),
    to: looseStrings(record.to),
    cc: looseStrings(record.cc),
    bcc: looseStrings(record.bcc),
    messageId: nullableText(record.messageId, `${source}_message_id_invalid`),
    inReplyTo: nullableText(record.inReplyTo, `${source}_in_reply_to_invalid`),
    references: strictStrings(record.references ?? [], `${source}_references_invalid`),
    threadId: nullableText(record.threadId, `${source}_thread_id_invalid`),
    attachments:
      source === 'normal'
        ? normalAttachments(record, sourceRecordId)
        : quarantineAttachments(record, sourceRecordId),
    classification,
  };
}

function bodyHash(message: SourceMessage): string {
  return objectHash({ textBody: message.body, htmlBody: message.htmlBody });
}

function headerHash(message: SourceMessage): string {
  return objectHash({
    eventAt: message.eventAt,
    subject: message.subject,
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    threadId: message.threadId,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
  });
}

function attachmentHash(message: SourceMessage): string {
  return objectHash(message.attachments);
}

function classificationRecordHash(record: JsonRecord): string {
  return objectHash(record);
}

function classificationRecordKey(record: JsonRecord): string {
  const source =
    record.source === 'normal' || record.source === 'quarantine' ? record.source : null;
  const id = text(record.sourceRecordId);
  if (!source || !id) return fail('classification_source_identity_invalid');
  return sourceRecordKey(source, id);
}

async function loadClassifications(
  pathOrDirectory: string,
  auditPath: string | undefined,
  snapshots: { normal: LoadedSnapshot; quarantine: LoadedSnapshot },
): Promise<LoadedClassifications> {
  const resolved = path.resolve(pathOrDirectory);
  const entry = await lstat(resolved).catch(() => fail('classification_path_missing'));
  const recordsPath = entry.isDirectory()
    ? path.join(resolved, 'daily-classification.jsonl')
    : resolved;
  const resolvedAudit = auditPath
    ? path.resolve(auditPath)
    : path.join(entry.isDirectory() ? resolved : path.dirname(resolved), 'coverage-audit.json');
  const raw = await readFile(recordsPath, 'utf8').catch(() =>
    fail('classification_records_missing'),
  );
  const records = normalizeJsonl(raw, 'daily-classification.jsonl');
  const audit = await readFileJson(resolvedAudit, 'classification_audit_missing');
  if (audit.schemaVersion !== 'centurion-coverage-audit-v1')
    return fail('classification_audit_schema_mismatch');
  if (!isRecord(audit.sourceManifests)) return fail('classification_source_manifests_missing');
  const expected = { normal: snapshots.normal, quarantine: snapshots.quarantine } as const;
  for (const kind of ['normal', 'quarantine'] as const) {
    const manifest = audit.sourceManifests[kind];
    if (!isRecord(manifest)) return fail(`classification_${kind}_manifest_missing`);
    if (
      manifest.snapshotId !== expected[kind].snapshotId ||
      manifest.orderedHash !== expected[kind].orderedHash ||
      manifest.manifestHash !== expected[kind].manifestHash
    )
      return fail(`classification_${kind}_manifest_mismatch`);
  }
  const sourceMessages = new Map<string, JsonRecord>();
  for (const kind of ['normal', 'quarantine'] as const) {
    for (const record of expected[kind].records) {
      sourceMessages.set(
        sourceRecordKey(kind, requiredText(record.id, 'source_id_missing')),
        record,
      );
    }
  }
  const byKey = new Map<string, JsonRecord>();
  for (const record of records) {
    if (record.schemaVersion !== 'centurion-classification-v1')
      return fail('classification_schema_mismatch');
    const key = classificationRecordKey(record);
    if (record.recordKey !== key) return fail('classification_record_key_identity_mismatch');
    if (byKey.has(key)) return fail('classification_record_key_duplicate');
    const sourceRecord = sourceMessages.get(key);
    if (!sourceRecord) return fail('classification_unexpected_record_key');
    const inputHash = validHash(record.inputHash, 'classification_input_hash_invalid');
    if (inputHash !== classificationRecordHash(sourceRecord))
      return fail('classification_input_hash_mismatch');
    byKey.set(key, record);
  }
  for (const key of sourceMessages.keys()) {
    if (!byKey.has(key)) return fail('classification_missing_record_key');
  }
  const orderedHash = sha256(records.map((record) => JSON.stringify(record)).join('\n'));
  return { records, byKey, audit, orderedHash, raw };
}

async function loadU4(
  analysisDirectory: string | undefined,
  targetPath: string | undefined,
  predictionPath: string | undefined,
): Promise<LoadedU4> {
  const directory = analysisDirectory ? path.resolve(analysisDirectory) : null;
  const targetFile = path.resolve(
    targetPath ?? (directory ? path.join(directory, 'target-manifest.jsonl') : ''),
  );
  const predictionFile = path.resolve(
    predictionPath ?? (directory ? path.join(directory, 'prediction-freeze.jsonl') : ''),
  );
  if (!targetPath && !analysisDirectory) return fail('target_manifest_path_missing');
  const targetRaw = await readFile(targetFile, 'utf8').catch(() => fail('target_manifest_missing'));
  const predictionRaw = await readFile(predictionFile, 'utf8').catch(() =>
    fail('prediction_freeze_missing'),
  );
  const targets = normalizeJsonl(targetRaw, 'target-manifest.jsonl');
  const predictions = normalizeJsonl(predictionRaw, 'prediction-freeze.jsonl');
  if (targets.length !== predictions.length) return fail('target_prediction_count_mismatch');
  const targetKeys = new Set<string>();
  for (const target of targets) {
    if (target.schemaVersion !== 'centurion-target-manifest-v1')
      return fail('target_manifest_schema_mismatch');
    const key = requiredText(target.targetKey, 'target_key_missing');
    if (targetKeys.has(key)) return fail('target_key_duplicate');
    targetKeys.add(key);
    if (!TARGET_STATUSES.includes(target.targetStatus as TargetStatus))
      return fail('target_status_invalid');
    if (target.status !== target.targetStatus) return fail('target_status_alias_mismatch');
    validHash(target.targetBodyHash, 'target_body_hash_invalid');
    validHash(target.targetHeaderHash, 'target_header_hash_invalid');
    validHash(target.targetAttachmentHash, 'target_attachment_hash_invalid');
    if (target.preTargetInputHash !== null && target.preTargetInputHash !== undefined)
      validHash(target.preTargetInputHash, 'target_input_hash_invalid');
    if (
      !Array.isArray(target.preTargetBodyHashes) ||
      target.preTargetBodyHashes.some((hash) => !HASH_PATTERN.test(String(hash)))
    )
      return fail('target_pre_target_body_hashes_invalid');
  }
  for (let index = 0; index < predictions.length; index += 1) {
    const prediction = predictions[index]!;
    if (prediction.schemaVersion !== 'centurion-prediction-freeze-v1')
      return fail('prediction_freeze_schema_mismatch');
    if (prediction.targetKey !== targets[index]!.targetKey)
      return fail('target_prediction_key_mismatch');
    for (const [key, label] of [
      ['targetBodyHash', 'target_body_hash'],
      ['targetHeaderHash', 'target_header_hash'],
      ['targetAttachmentHash', 'target_attachment_hash'],
    ] as const) {
      if (prediction[key] !== targets[index]![key]) return fail(`prediction_${label}_mismatch`);
    }
    if (
      prediction.targetStatus !== targets[index]!.targetStatus ||
      prediction.status !== targets[index]!.status
    )
      return fail('prediction_target_status_mismatch');
    if (prediction.inputHash !== targets[index]!.preTargetInputHash)
      return fail('prediction_input_hash_mismatch');
    if (
      JSON.stringify(prediction.preTargetBodyHashes) !==
      JSON.stringify(targets[index]!.preTargetBodyHashes)
    )
      return fail('prediction_pre_target_body_hashes_mismatch');
    if (
      !Array.isArray(prediction.preTargetBodyHashes) ||
      prediction.preTargetBodyHashes.some((hash) => !HASH_PATTERN.test(String(hash)))
    )
      return fail('prediction_pre_target_body_hashes_invalid');
    validHash(prediction.targetBodyHash, 'prediction_target_body_hash_invalid');
    validHash(prediction.targetHeaderHash, 'prediction_target_header_hash_invalid');
    validHash(prediction.targetAttachmentHash, 'prediction_target_attachment_hash_invalid');
  }
  return {
    targets,
    predictions,
    targetRaw,
    predictionRaw,
    targetHash: sha256(targetRaw),
    predictionHash: sha256(predictionRaw),
  };
}

function prepareMessageMap(
  normal: LoadedSnapshot,
  quarantine: LoadedSnapshot,
  classifications: LoadedClassifications,
): Map<string, SourceMessage> {
  const messages = new Map<string, SourceMessage>();
  for (const kind of ['normal', 'quarantine'] as const) {
    const snapshot = kind === 'normal' ? normal : quarantine;
    for (const record of snapshot.records) {
      const id = requiredText(record.id, `${kind}_record_id_missing`);
      const key = sourceRecordKey(kind, id);
      messages.set(key, sourceMessage(record, kind, classifications.byKey.get(key) ?? null));
    }
  }
  return messages;
}

function normalizeOperation(value: unknown, code: string): GoldOperation {
  if (!isRecord(value)) return fail(`${code}_operation_invalid`);
  rejectUnknownKeys(
    value,
    new Set([
      'operation',
      'op',
      'needLevel',
      'need_level',
      'requiredFields',
      'required_fields',
      'candidateTool',
      'candidate_tool',
      'unknownReason',
      'unknown_reason',
    ]),
    `${code}_unknown_key`,
  );
  const operation = text(aliasValue(value, 'operation', 'op', `${code}_operation_alias_conflict`));
  const needLevel = text(
    aliasValue(value, 'needLevel', 'need_level', `${code}_need_level_alias_conflict`),
  );
  const requiredFields = aliasValue(
    value,
    'requiredFields',
    'required_fields',
    `${code}_required_fields_alias_conflict`,
  );
  const candidateTool = aliasValue(
    value,
    'candidateTool',
    'candidate_tool',
    `${code}_candidate_tool_alias_conflict`,
  );
  const unknownReason = aliasValue(
    value,
    'unknownReason',
    'unknown_reason',
    `${code}_unknown_reason_alias_conflict`,
  );
  if (!operation || !(HUMAN_RESPONSE_OPERATIONS as readonly string[]).includes(operation))
    return fail(`${code}_operation_invalid`);
  if (
    !needLevel ||
    !['required', 'likely', 'optional', 'not_needed', 'unknown'].includes(needLevel)
  )
    return fail(`${code}_need_level_invalid`);
  const fields = strictStrings(requiredFields, `${code}_required_fields_invalid`);
  if (fields.length > 32 || fields.some((field) => field.trim() === '' || field.length > 256))
    return fail(`${code}_required_fields_invalid`);
  if (candidateTool !== null && candidateTool !== undefined && typeof candidateTool !== 'string')
    return fail(`${code}_candidate_tool_invalid`);
  if (unknownReason !== null && unknownReason !== undefined && typeof unknownReason !== 'string')
    return fail(`${code}_unknown_reason_invalid`);
  if (
    (operation === 'unknown' || needLevel === 'unknown') &&
    (!unknownReason || !String(unknownReason).trim())
  )
    return fail(`${code}_unknown_reason_required`);
  return {
    operation: operation as HumanResponseOperation,
    needLevel: needLevel as HumanResponseNeedLevel,
    requiredFields: fields,
    candidateTool: typeof candidateTool === 'string' ? candidateTool : null,
    unknownReason: typeof unknownReason === 'string' ? unknownReason : null,
  };
}

function rejectUnknownKeys(record: JsonRecord, allowed: ReadonlySet<string>, code: string): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) return fail(code);
}

function aliasValue(record: JsonRecord, canonical: string, alias: string, code: string): unknown {
  const hasCanonical = Object.prototype.hasOwnProperty.call(record, canonical);
  const hasAlias = Object.prototype.hasOwnProperty.call(record, alias);
  if (
    hasCanonical &&
    hasAlias &&
    JSON.stringify(record[canonical]) !== JSON.stringify(record[alias])
  )
    return fail(code);
  return hasCanonical ? record[canonical] : hasAlias ? record[alias] : undefined;
}

function normalizeGoldResponse(value: unknown): HumanGoldComparatorResponse {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return fail('gold_prediction_parse_error');
    }
  }
  if (!isRecord(parsed)) return fail('gold_prediction_parse_error');
  rejectUnknownKeys(
    parsed,
    new Set([
      'opaqueId',
      'operations',
      'primaryOperation',
      'primary_operation',
      'needLevel',
      'need_level',
      'requiredFields',
      'required_fields',
      'candidateTool',
      'candidate_tool',
      'unknownReason',
      'unknown_reason',
    ]),
    'gold_unknown_key',
  );
  const operationsValue = parsed.operations;
  if (
    !Array.isArray(operationsValue) ||
    operationsValue.length === 0 ||
    operationsValue.length > HUMAN_RESPONSE_OPERATIONS.length
  )
    return fail('gold_operations_missing');
  const operations = operationsValue.map((item) => normalizeOperation(item, 'gold'));
  if (new Set(operations.map((item) => item.operation)).size !== operations.length)
    return fail('gold_operation_duplicate');
  const primary = text(
    aliasValue(
      parsed,
      'primaryOperation',
      'primary_operation',
      'gold_primary_operation_alias_conflict',
    ),
  );
  const expectedPrimary = choosePrimaryOperation(operations.map((item) => item.operation));
  if (primary !== expectedPrimary) return fail('gold_primary_operation_mismatch');
  const primaryAction = operations.find((item) => item.operation === expectedPrimary)!;
  const needLevel = text(
    aliasValue(parsed, 'needLevel', 'need_level', 'gold_need_level_alias_conflict'),
  );
  if (needLevel !== primaryAction.needLevel) return fail('gold_need_level_mismatch');
  const fields = strictStrings(
    aliasValue(parsed, 'requiredFields', 'required_fields', 'gold_required_fields_alias_conflict'),
    'gold_required_fields_invalid',
  );
  if (fields.length > 32 || fields.some((field) => field.trim() === '' || field.length > 256))
    return fail('gold_required_fields_invalid');
  if (JSON.stringify(fields) !== JSON.stringify(primaryAction.requiredFields))
    return fail('gold_required_fields_mismatch');
  const candidateTool = aliasValue(
    parsed,
    'candidateTool',
    'candidate_tool',
    'gold_candidate_tool_alias_conflict',
  );
  if (candidateTool !== primaryAction.candidateTool) return fail('gold_candidate_tool_mismatch');
  const unknownReason = aliasValue(
    parsed,
    'unknownReason',
    'unknown_reason',
    'gold_unknown_reason_alias_conflict',
  );
  if (unknownReason !== primaryAction.unknownReason) return fail('gold_unknown_reason_mismatch');
  const opaqueId = requiredText(parsed.opaqueId, 'gold_opaque_id_missing');
  return {
    opaqueId,
    operations,
    primaryOperation: expectedPrimary,
    needLevel: primaryAction.needLevel,
    requiredFields: [...primaryAction.requiredFields],
    candidateTool: primaryAction.candidateTool,
    unknownReason: primaryAction.unknownReason,
  };
}

function sanitizeSafeToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 160 || /[@\r\n]/.test(trimmed)) return '[redacted]';
  return trimmed.replace(/[^A-Za-z0-9_.:/-]+/g, '_');
}

function normalizedLeakageText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/gi, ' ')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function assertPredictionFreezeIsUnleaked(prediction: JsonRecord, message: SourceMessage): void {
  const predictorInput = prediction.predictorInput;
  if (predictorInput === null || predictorInput === undefined) return;
  if (!isRecord(predictorInput)) return fail('prediction_input_invalid');
  const inputHash = validHash(prediction.inputHash, 'prediction_input_hash_invalid');
  if (objectHash(predictorInput) !== inputHash)
    return fail('prediction_input_hash_recomputed_mismatch');
  const serialized = normalizedLeakageText(JSON.stringify(predictorInput));
  const forbidden = [
    message.body,
    message.htmlBody,
    message.messageId,
    message.eventAt,
    message.subject,
    message.inReplyTo,
    ...message.references,
    ...message.from,
    ...message.to,
    ...message.cc,
    ...message.bcc,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map(normalizedLeakageText)
    .filter((value) => value.length >= 8);
  if (forbidden.some((fragment) => serialized.includes(fragment)))
    return fail('prediction_freeze_target_payload_leakage');
}

function sanitizeOperation(operation: GoldOperation): GoldOperation {
  return {
    ...operation,
    requiredFields: operation.requiredFields.map(sanitizeSafeToken).filter(Boolean),
    candidateTool: operation.candidateTool ? sanitizeSafeToken(operation.candidateTool) : null,
    unknownReason: operation.unknownReason ? sanitizeSafeToken(operation.unknownReason) : null,
  };
}

function taskIdFor(keys: readonly string[]): string {
  return `task-${sha256([...new Set(keys)].sort().join('|')).slice(0, 24)}`;
}

function evidenceIdFor(taskId: string, targetKey: string): string {
  return `evidence-${sha256(`${taskId}|${targetKey}`).slice(0, 20)}`;
}

function classificationDirection(record: JsonRecord | null): string | null {
  return text(record?.businessDirection);
}

function classificationOrigin(record: JsonRecord | null): string | null {
  return text(record?.origin);
}

function classificationWorkflow(record: JsonRecord | null): string | null {
  return text(record?.primaryWorkflow);
}

function classificationSecondaryWorkflows(record: JsonRecord | null): string[] {
  return looseStrings(record?.secondaryWorkflows);
}

function matchingCoreMessage(message: SourceMessage): boolean {
  if (!message.eventAt) return false;
  const at = Date.parse(message.eventAt);
  if (at < Date.parse(CENTURION_WINDOW_START_UTC) || at >= Date.parse(CENTURION_WINDOW_END_UTC))
    return false;
  if (message.source === 'normal')
    return message.raw.dailyIncluded === true && message.raw.contextOnly !== true;
  return message.raw.reportPartition === 'core';
}

function operationMap(operations: readonly GoldOperation[]): Map<string, GoldOperation> {
  return new Map(operations.map((operation) => [operation.operation, operation]));
}

function compareSemantics(
  predicted: readonly GoldOperation[],
  claimed: readonly GoldOperation[],
  predictionError: string | null,
): { grade: GoldGrade; mismatchReasons: string[] } {
  if (predictionError) return { grade: 'prediction_error', mismatchReasons: ['prediction_error'] };
  if (predicted.length === 0 || claimed.length === 0)
    return { grade: 'not_scored', mismatchReasons: [] };
  const predictedMap = operationMap(predicted);
  const claimedMap = operationMap(claimed);
  const reasons: string[] = [];
  for (const operation of predictedMap.keys()) {
    if (!claimedMap.has(operation)) reasons.push('missing_operation');
  }
  for (const operation of claimedMap.keys()) {
    if (!predictedMap.has(operation)) reasons.push('unexpected_operation');
  }
  for (const operation of predictedMap.keys()) {
    const expected = predictedMap.get(operation);
    const actual = claimedMap.get(operation);
    if (!expected || !actual) continue;
    for (const field of expected.requiredFields) {
      if (!actual.requiredFields.includes(field)) reasons.push('missing_required_field');
    }
    for (const field of actual.requiredFields) {
      if (!expected.requiredFields.includes(field)) reasons.push('unexpected_required_field');
    }
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  if (uniqueReasons.length === 0) return { grade: 'match', mismatchReasons: [] };
  const overlap = [...predictedMap.keys()].some((operation) => claimedMap.has(operation));
  return { grade: overlap ? 'partial' : 'mismatch', mismatchReasons: uniqueReasons };
}

function defaultVerifiedAction(supplied: VerifiedPmsAction | undefined): VerifiedPmsAction {
  if (
    !supplied ||
    supplied.status !== 'observed' ||
    (supplied.authority !== 'pms_receipt' && supplied.authority !== 'pms_read') ||
    !Array.isArray(supplied.operations) ||
    !Array.isArray(supplied.evidenceIds) ||
    supplied.evidenceIds.length === 0
  ) {
    return { status: 'not_observed', operations: [], evidenceIds: [], authority: 'none' };
  }
  return {
    status: 'observed',
    operations: supplied.operations.map(sanitizeOperation),
    evidenceIds: supplied.evidenceIds.map(sanitizeSafeToken).filter(Boolean),
    authority: supplied.authority,
  };
}

function initialStrata(
  target: JsonRecord,
  prediction: JsonRecord,
  claimStatus: GoldClaimedAction['status'],
): GoldStratum[] {
  const status = target.targetStatus as TargetStatus;
  const strata: GoldStratum[] = [status];
  if (status === 'paired') strata.push('answered');
  if (
    target.lateResponse === true ||
    target.late_response === true ||
    prediction.lateResponse === true ||
    prediction.late_response === true
  )
    strata.push('late');
  if (
    target.contextIncomplete === true ||
    target.context_incomplete === true ||
    prediction.contextIncomplete === true ||
    prediction.context_incomplete === true
  )
    strata.push('context_incomplete');
  const error = text(prediction.predictionError) ?? text(target.predictionError);
  if (error) strata.push('prediction_error');
  if (
    error === 'luna_worker_transport_unavailable' ||
    error === 'worker_error' ||
    error === 'prediction_parse_error' ||
    error === 'context_incomplete' ||
    error === 'target_payload_leakage' ||
    target.contextIncomplete === true ||
    target.context_incomplete === true ||
    claimStatus === 'unavailable'
  )
    strata.push('unavailable');
  return [...new Set(strata)];
}

function predictionOperations(prediction: JsonRecord): GoldOperation[] {
  if (!Array.isArray(prediction.operations)) return [];
  return prediction.operations
    .map((item) => normalizeOperation(item, 'prediction'))
    .map(sanitizeOperation);
}

function goldTarget(message: SourceMessage, targetKey: string): GoldComparatorTarget {
  return {
    targetKey,
    source: message.source,
    sourceRecordId: message.sourceRecordId,
    eventAt: message.eventAt ?? fail('target_event_at_missing'),
    subject: message.subject,
    textBody: message.body,
    htmlBody: message.htmlBody,
    from: [...message.from],
    to: [...message.to],
    cc: [...message.cc],
    bcc: [...message.bcc],
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: [...message.references],
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
    bodyHash: bodyHash(message),
    headerHash: headerHash(message),
    attachmentHash: attachmentHash(message),
  };
}

function emptyClaim(
  status: GoldClaimedAction['status'],
  errorCode: string | null = null,
): GoldClaimedAction {
  return { status, operations: [], comparatorId: null, errorCode };
}

async function compareOneTarget(
  target: JsonRecord,
  prediction: JsonRecord,
  message: SourceMessage,
  transport: HumanGoldComparatorTransport,
  metadata: { modelId: string; modelVersion: string },
  maxRetries: number,
): Promise<GoldClaimedAction> {
  let attempts = 0;
  while (attempts <= maxRetries) {
    attempts += 1;
    const comparatorId = `gold-comparator-${randomUUID()}`;
    try {
      const response = normalizeGoldResponse(
        await transport.compare({
          comparatorId,
          modelId: metadata.modelId,
          modelVersion: metadata.modelVersion,
          promptVersion: GOLD_COMPARATOR_PROMPT_VERSION,
          target: goldTarget(message, requiredText(target.targetKey, 'target_key_missing')),
        }),
      );
      return {
        status: 'observed',
        operations: response.operations.map(sanitizeOperation),
        comparatorId: sanitizeSafeToken(response.opaqueId),
        errorCode: null,
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'gold_comparator_error';
      if (code === 'gold_comparator_transport_unavailable') return emptyClaim('unavailable', code);
      if (attempts <= maxRetries) continue;
      return emptyClaim('unavailable', sanitizeSafeToken(code.slice(0, 120)));
    }
  }
  return emptyClaim('unavailable', 'gold_comparator_error');
}

export function createUnavailableHumanGoldComparatorTransport(): HumanGoldComparatorTransport {
  return {
    async compare(): Promise<never> {
      throw new Error('gold_comparator_transport_unavailable');
    },
  };
}

function supplementalRecord(
  message: SourceMessage,
  strata: GoldStratum[],
  workflow: string | null,
  secondaryWorkflows: string[],
): GoldComparisonRecord {
  const taskId = taskIdFor([message.recordKey]);
  return {
    schemaVersion: GOLD_COMPARISON_SCHEMA_VERSION,
    taskId,
    targetKey: message.recordKey,
    source: message.source,
    sourceRecordId: message.sourceRecordId,
    eventAt: message.eventAt,
    targetStatus: null,
    strata: [...new Set(strata)],
    workflow,
    secondaryWorkflows,
    predicted_operations: [],
    claimed_action: emptyClaim('not_applicable'),
    verified_pms_action: defaultVerifiedAction(undefined),
    grade: 'not_scored',
    mismatchReasons: [],
    evidenceIds: [evidenceIdFor(taskId, message.recordKey)],
    predictionError: null,
    lateResponse: false,
    contextIncomplete: strata.includes('context_incomplete'),
  };
}

function stratumCounts(records: readonly GoldComparisonRecord[]): Record<GoldStratum, number> {
  const counts = Object.fromEntries(STRATA.map((stratum) => [stratum, 0])) as Record<
    GoldStratum,
    number
  >;
  for (const record of records) for (const stratum of record.strata) counts[stratum] += 1;
  return counts;
}

function gradeCounts(records: readonly GoldComparisonRecord[]): Record<GoldGrade, number> {
  const counts = Object.fromEntries(GRADES.map((grade) => [grade, 0])) as Record<GoldGrade, number>;
  for (const record of records) counts[record.grade] += 1;
  return counts;
}

function demandOperations(record: GoldComparisonRecord): GoldOperation[] {
  if (record.predicted_operations.length > 0) return record.predicted_operations;
  if (record.claimed_action.status === 'observed' && record.claimed_action.operations.length > 0)
    return record.claimed_action.operations;
  if (record.strata.includes('unanswered') || record.strata.includes('unavailable')) {
    return [
      {
        operation: 'unknown',
        needLevel: 'unknown',
        requiredFields: [],
        candidateTool: null,
        unknownReason: 'no_frozen_semantic_operation',
      },
    ];
  }
  return [];
}

export function aggregateToolDemand(
  records: readonly GoldComparisonRecord[],
  snapshotId: string,
  sourceSnapshotIds: { normal: string; quarantine: string },
): ToolDemandReport {
  type Mutable = ToolDemandRanking & { tasks: Set<string>; evidence: Set<string> };
  const rows = new Map<string, Mutable>();
  for (const record of records) {
    for (const operation of demandOperations(record)) {
      const key = `${operation.operation}|${operation.candidateTool ?? ''}|${record.workflow ?? ''}`;
      const row = rows.get(key) ?? {
        operation: operation.operation,
        candidateTool: operation.candidateTool,
        workflow: record.workflow,
        distinctTaskCount: 0,
        answeredCount: 0,
        unansweredCount: 0,
        ambiguousCount: 0,
        unavailableCount: 0,
        automatedCount: 0,
        contextIncompleteCount: 0,
        predictionErrorCount: 0,
        evidenceIds: [],
        tasks: new Set<string>(),
        evidence: new Set<string>(),
      };
      row.tasks.add(record.taskId);
      for (const evidenceId of record.evidenceIds) row.evidence.add(evidenceId);
      if (record.strata.includes('answered')) row.answeredCount += 1;
      if (record.strata.includes('unanswered')) row.unansweredCount += 1;
      if (record.strata.includes('ambiguous')) row.ambiguousCount += 1;
      if (record.strata.includes('unavailable')) row.unavailableCount += 1;
      if (record.strata.includes('automated')) row.automatedCount += 1;
      if (record.strata.includes('context_incomplete')) row.contextIncompleteCount += 1;
      if (record.strata.includes('prediction_error')) row.predictionErrorCount += 1;
      rows.set(key, row);
    }
  }
  const rankings = [...rows.values()]
    .map((row) => ({
      operation: row.operation,
      candidateTool: row.candidateTool,
      workflow: row.workflow,
      distinctTaskCount: row.tasks.size,
      answeredCount: row.answeredCount,
      unansweredCount: row.unansweredCount,
      ambiguousCount: row.ambiguousCount,
      unavailableCount: row.unavailableCount,
      automatedCount: row.automatedCount,
      contextIncompleteCount: row.contextIncompleteCount,
      predictionErrorCount: row.predictionErrorCount,
      evidenceIds: [...row.evidence].sort(),
    }))
    .sort(
      (left, right) =>
        right.distinctTaskCount - left.distinctTaskCount ||
        left.operation.localeCompare(right.operation) ||
        (left.candidateTool ?? '').localeCompare(right.candidateTool ?? ''),
    );
  return {
    schemaVersion: TOOL_DEMAND_REPORT_SCHEMA_VERSION,
    snapshotId,
    sourceSnapshotIds,
    taskCount: new Set(records.map((record) => record.taskId)).size,
    comparisonRecordCount: records.length,
    rankings,
    stratumCounts: stratumCounts(records),
    gradeCounts: gradeCounts(records),
  };
}

function markdownCell(value: string | number | null): string {
  return String(value ?? '—').replace(/[|\r\n]/g, ' ');
}

function buildToolDemandMarkdown(report: ToolDemandReport, audit: GoldAudit): string {
  const lines = [
    '# Centurion PMS tool-demand report',
    '',
    `Snapshot: \`${report.snapshotId}\``,
    `Distinct tasks: **${report.taskCount}**; comparison records: **${report.comparisonRecordCount}**`,
    `Source snapshots: normal \`${report.sourceSnapshotIds.normal}\`; quarantine \`${report.sourceSnapshotIds.quarantine}\``,
    '',
    'This report ranks semantic operation demand by distinct task IDs. It does not score prose similarity and it makes no PMS execution claim from email alone.',
    '',
    '## Strata',
    '',
    '| stratum | records |',
    '| --- | ---: |',
  ];
  for (const stratum of STRATA) lines.push(`| ${stratum} | ${report.stratumCounts[stratum]} |`);
  lines.push(
    '',
    '## Candidate tool ranking',
    '',
    '| operation | candidate tool | workflow | distinct tasks | answered | unanswered | ambiguous | unavailable | automated | context incomplete | prediction error | evidence IDs |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  for (const row of report.rankings) {
    lines.push(
      `| ${markdownCell(row.operation)} | ${markdownCell(row.candidateTool)} | ${markdownCell(row.workflow)} | ${row.distinctTaskCount} | ${row.answeredCount} | ${row.unansweredCount} | ${row.ambiguousCount} | ${row.unavailableCount} | ${row.automatedCount} | ${row.contextIncompleteCount} | ${row.predictionErrorCount} | ${row.evidenceIds.join(', ')} |`,
    );
  }
  lines.push(
    '',
    '## Verification boundary',
    '',
    `Claimed semantic actions observed: **${audit.claimedObservedCount}**`,
    `Authoritative PMS actions observed: **${audit.verifiedObservedCount}**`,
    `PMS actions not observed: **${audit.verifiedNotObservedCount}**`,
    '',
    'Candidate tools are demand hypotheses. Endpoint support, PMS reads, receipts, and writes require separate live proof and authorization.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function buildStagehandHandoff(
  report: ToolDemandReport,
  records: readonly GoldComparisonRecord[],
  audit: GoldAudit,
): string {
  const lines = [
    '# Stagehand handoff — Centurion semantic demand',
    '',
    'Sanitized handoff for the running “Analyze Stagehand tool costs” work. It contains aggregate demand and opaque evidence references only; no message bodies, addresses, attachments, message IDs, raw headers, secrets, or PMS execution claims.',
    '',
    '## Task frequencies',
    '',
    '| operation | candidate tool | workflow | distinct tasks | answered | unanswered | ambiguous | unavailable |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of report.rankings) {
    lines.push(
      `| ${markdownCell(row.operation)} | ${markdownCell(row.candidateTool)} | ${markdownCell(row.workflow)} | ${row.distinctTaskCount} | ${row.answeredCount} | ${row.unansweredCount} | ${row.ambiguousCount} | ${row.unavailableCount} |`,
    );
  }
  lines.push(
    '',
    '## Required PMS inputs/outputs',
    '',
    'The following are semantic field names emitted by the frozen predictor or fresh comparator. They are requirements to validate, not evidence that an endpoint exists:',
    '',
  );
  const fields = new Map<string, Set<string>>();
  for (const record of records) {
    for (const operation of [
      ...record.predicted_operations,
      ...(record.claimed_action.status === 'observed' ? record.claimed_action.operations : []),
    ]) {
      const key = operation.operation;
      const existing = fields.get(key) ?? new Set<string>();
      for (const field of operation.requiredFields) {
        const safe = sanitizeSafeToken(field);
        if (safe && safe !== '[redacted]') existing.add(safe);
      }
      fields.set(key, existing);
    }
  }
  for (const [operation, requiredFields] of [...fields.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(
      `- \`${operation}\`: ${
        [...requiredFields]
          .sort()
          .map((field) => `\`${field}\``)
          .join(', ') || 'no fields emitted'
      }`,
    );
  }
  if (fields.size === 0)
    lines.push(
      '- No semantic fields were available; prediction/comparator runtime was unavailable.',
    );
  lines.push(
    '',
    '## Candidate tool boundaries',
    '',
    '- Read-only discovery and proof first; candidate tool names above are hypotheses only.',
    '- Each candidate needs an explicit authorized input schema, output schema, evidence ID/hash, and failure state before Stagehand cost testing.',
    '- Do not infer endpoint, authorization, receipt, or mutation support from an email claim.',
    '- Keep all create/amend/cancel/payment/refund/document actions human-gated until live PMS proof exists.',
    '',
    '## Live-proof gaps',
    '',
    `- Source/classification/target/prediction hashes were checked: **${audit.privacy.stagehandHandoffSanitized ? 'yes' : 'no'}**.`,
    `- Authoritative PMS action receipts/reads observed: **${audit.verifiedObservedCount}**.`,
    `- Comparator runtime blockers: **${audit.comparatorRuntimeBlockers.join(', ') || 'none'}**.`,
    '- Need live read manifests, authorization-boundary evidence, latency/cost measurements, and explicit failure/rollback proof for each candidate.',
    '',
    'Opaque exemplars are available only through private evidence IDs in the owner-only gold comparison output.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

async function ensurePrivateOutputDirectory(
  outputDir: string,
  snapshotId: string,
): Promise<string> {
  const absolute = path.resolve(outputDir);
  const corpusRoot = path.dirname(absolute);
  const privateRoot = path.dirname(corpusRoot);
  if (
    path.basename(privateRoot) !== '.private' ||
    path.basename(corpusRoot) !== 'centurion-corpus' ||
    path.basename(absolute) !== snapshotId ||
    !/^[A-Za-z0-9._-]+$/.test(snapshotId)
  )
    return fail('output_private_root_invalid');
  const repoEntry = await lstat(ANALYSIS_REPO_ROOT).catch(() => null);
  if (!repoEntry || repoEntry.isSymbolicLink() || !repoEntry.isDirectory())
    return fail('private_parent_invalid');
  const canonicalRepo = await realpath(ANALYSIS_REPO_ROOT);
  if (path.dirname(privateRoot) !== canonicalRepo) return fail('output_private_root_invalid');
  const privateEntry = await lstat(privateRoot).catch(() => null);
  if (!privateEntry || privateEntry.isSymbolicLink() || !privateEntry.isDirectory())
    return fail('private_root_symlink');
  await chmod(privateRoot, 0o700);
  const ignore = await readFile(path.join(privateRoot, '.gitignore'), 'utf8').catch(() => '');
  if (!ignore.split(/\r?\n/).some((line) => line.trim() === '*'))
    return fail('private_root_not_ignored');
  async function ensureDirectory(directory: string, code: string): Promise<string> {
    const entry = await lstat(directory).catch(() => null);
    if (!entry) await mkdir(directory, { mode: 0o700 });
    const checked = await lstat(directory);
    if (checked.isSymbolicLink() || !checked.isDirectory()) return fail(code);
    await chmod(directory, 0o700);
    return realpath(directory);
  }
  const corpus = await ensureDirectory(corpusRoot, 'private_parent_symlink');
  if (corpus !== path.join(privateRoot, 'centurion-corpus')) return fail('private_parent_symlink');
  const output = await ensureDirectory(absolute, 'output_directory_invalid');
  if (output !== path.join(corpus, snapshotId)) return fail('output_parent_invalid');
  return output;
}

async function writeCreateOnly(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(filePath, 0o600);
}

async function assertCreateOnlyOutputFilesAbsent(outputDir: string): Promise<void> {
  for (const name of [
    'gold-comparison.jsonl',
    'tool-demand-report.md',
    'stagehand-handoff.md',
    'gold-audit.json',
  ]) {
    if (await lstat(path.join(outputDir, name)).catch(() => null))
      return fail(`output_file_exists:${name}`);
  }
}

function normalizeCutoff(value: string | undefined): number {
  const parsed = Date.parse(value ?? CENTURION_WINDOW_END_UTC);
  if (Number.isNaN(parsed)) return fail('cutoff_at_invalid');
  return parsed;
}

function normalizeSnapshotId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value.length === 0) return fail('snapshot_id_invalid');
  return value;
}

function verifiedFor(
  options: CompareCenturionHumanGoldOptions,
  targetKey: string,
): VerifiedPmsAction {
  return defaultVerifiedAction(options.verifiedPmsActions?.[targetKey]);
}

function buildTargetRecord(
  target: JsonRecord,
  prediction: JsonRecord,
  message: SourceMessage,
  claim: GoldClaimedAction,
  verified: VerifiedPmsAction,
  cutoffAt: number,
): GoldComparisonRecord {
  const targetStatus = target.targetStatus as TargetStatus;
  const predicted = predictionOperations(prediction);
  const error = text(prediction.predictionError) ?? text(target.predictionError);
  const baseStrata = initialStrata(target, prediction, claim.status);
  const lateResponse =
    target.lateResponse === true ||
    target.late_response === true ||
    prediction.lateResponse === true ||
    prediction.late_response === true ||
    (message.eventAt !== null && Date.parse(message.eventAt) > cutoffAt);
  if (lateResponse && !baseStrata.includes('late')) baseStrata.push('late');
  const comparison =
    claim.status === 'unavailable'
      ? { grade: 'unavailable' as const, mismatchReasons: ['gold_comparator_unavailable'] }
      : targetStatus !== 'paired'
        ? { grade: 'not_scored' as const, mismatchReasons: [] }
        : compareSemantics(predicted, claim.operations, error);
  const taskKeys = target.triggeringInboundRecordId
    ? [String(target.triggeringInboundRecordId)]
    : looseStrings(target.candidateInboundRecordIds).length > 0
      ? looseStrings(target.candidateInboundRecordIds)
      : [requiredText(target.targetKey, 'target_key_missing')];
  const taskId = taskIdFor(taskKeys);
  const targetKey = requiredText(target.targetKey, 'target_key_missing');
  return {
    schemaVersion: GOLD_COMPARISON_SCHEMA_VERSION,
    taskId,
    targetKey,
    source: message.source,
    sourceRecordId: message.sourceRecordId,
    eventAt: message.eventAt,
    targetStatus,
    strata: [...new Set(baseStrata)],
    workflow: classificationWorkflow(message.classification),
    secondaryWorkflows: classificationSecondaryWorkflows(message.classification),
    predicted_operations: predicted,
    claimed_action: claim,
    verified_pms_action: verified,
    grade: comparison.grade,
    mismatchReasons: comparison.mismatchReasons,
    evidenceIds: [evidenceIdFor(taskId, targetKey)],
    predictionError: error,
    lateResponse,
    contextIncomplete: target.contextIncomplete === true || target.context_incomplete === true,
  };
}

function buildSupplementalRecords(
  inputs: PreparedInputs,
  targetRecords: readonly JsonRecord[],
  cutoffAt: number,
): GoldComparisonRecord[] {
  const matchedInbound = new Set<string>();
  const targetKeys = new Set(
    targetRecords.map((target) => requiredText(target.targetKey, 'target_key_missing')),
  );
  for (const target of targetRecords) {
    for (const key of looseStrings(target.candidateInboundRecordIds)) matchedInbound.add(key);
    const trigger = text(target.triggeringInboundRecordId);
    if (trigger) matchedInbound.add(trigger);
  }
  const supplements: GoldComparisonRecord[] = [];
  for (const message of inputs.messages.values()) {
    if (
      !matchingCoreMessage(message) ||
      !message.classification ||
      !message.eventAt ||
      Date.parse(message.eventAt) > cutoffAt
    )
      continue;
    const direction = classificationDirection(message.classification);
    const origin = classificationOrigin(message.classification);
    if (message.source === 'quarantine' && message.raw.parseStatus !== 'parsed') {
      supplements.push(
        supplementalRecord(
          message,
          ['unavailable'],
          classificationWorkflow(message.classification),
          classificationSecondaryWorkflows(message.classification),
        ),
      );
      continue;
    }
    if (text(message.classification.status) !== 'classified') {
      supplements.push(
        supplementalRecord(
          message,
          ['unavailable'],
          classificationWorkflow(message.classification),
          classificationSecondaryWorkflows(message.classification),
        ),
      );
      continue;
    }
    if (direction === 'inbound' || direction === 'ambiguous') {
      if (matchedInbound.has(message.recordKey)) continue;
      const strata: GoldStratum[] = [origin === 'automated' ? 'automated' : 'unanswered'];
      if (direction === 'ambiguous') strata.push('ambiguous');
      supplements.push(
        supplementalRecord(
          message,
          strata,
          classificationWorkflow(message.classification),
          classificationSecondaryWorkflows(message.classification),
        ),
      );
    } else if (
      direction === 'outbound' &&
      origin === 'automated' &&
      !targetKeys.has(message.recordKey)
    ) {
      supplements.push(
        supplementalRecord(
          message,
          ['automated'],
          classificationWorkflow(message.classification),
          classificationSecondaryWorkflows(message.classification),
        ),
      );
    }
  }
  return supplements;
}

export async function compareCenturionHumanGold(
  options: CompareCenturionHumanGoldOptions,
): Promise<CompareCenturionHumanGoldRun> {
  const snapshotId = normalizeSnapshotId(options.snapshotId);
  const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > DEFAULT_MAX_WORKERS)
    return fail('maxWorkers must be an integer from 1 through 5');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10)
    return fail('maxRetries must be a non-negative integer no greater than 10');
  const normal = await readSealedSnapshot(options.normalSnapshotDir, 'normal');
  const quarantine = await readSealedSnapshot(options.quarantineSnapshotDir, 'quarantine');
  const cutoffAt = normalizeCutoff(options.cutoffAt);
  const classificationPath = options.classificationOutputDir ?? options.classificationPath;
  if (!classificationPath) return fail('classification_path_missing');
  const classifications = await loadClassifications(
    classificationPath,
    options.classificationAuditPath,
    { normal, quarantine },
  );
  const u4 = await loadU4(
    options.humanAnalysisDir,
    options.targetManifestPath,
    options.predictionFreezePath,
  );
  const messages = prepareMessageMap(normal, quarantine, classifications);
  const inputs: PreparedInputs = { normal, quarantine, classifications, u4, messages };

  // Freeze validation is complete before any target body is handed to gold.
  const validatedTargets: Array<{
    target: JsonRecord;
    prediction: JsonRecord;
    message: SourceMessage;
  }> = [];
  for (let index = 0; index < u4.targets.length; index += 1) {
    const target = u4.targets[index]!;
    const prediction = u4.predictions[index]!;
    const source =
      target.source === 'normal' || target.source === 'quarantine' ? target.source : null;
    const sourceRecordId = requiredText(target.sourceRecordId, 'target_source_record_id_missing');
    if (!source) return fail('target_source_invalid');
    if (sourceRecordKey(source, sourceRecordId) !== target.targetKey)
      return fail('target_key_source_identity_mismatch');
    const message = messages.get(sourceRecordKey(source, sourceRecordId));
    if (!message) return fail('target_source_record_missing');
    if (message.eventAt !== target.eventAt) return fail('target_event_at_mismatch');
    if (bodyHash(message) !== target.targetBodyHash) return fail('target_body_hash_mismatch');
    if (headerHash(message) !== target.targetHeaderHash) return fail('target_header_hash_mismatch');
    if (attachmentHash(message) !== target.targetAttachmentHash)
      return fail('target_attachment_hash_mismatch');
    if (bodyHash(message) !== prediction.targetBodyHash)
      return fail('prediction_target_body_hash_mismatch');
    if (headerHash(message) !== prediction.targetHeaderHash)
      return fail('prediction_target_header_hash_mismatch');
    if (attachmentHash(message) !== prediction.targetAttachmentHash)
      return fail('prediction_target_attachment_hash_mismatch');
    assertPredictionFreezeIsUnleaked(prediction, message);
    if (
      text(message.classification?.status) !== 'classified' ||
      classificationOrigin(message.classification) !== 'human' ||
      classificationDirection(message.classification) !== 'outbound'
    )
      return fail('target_not_classified_human_outbound');
    validatedTargets.push({ target, prediction, message });
  }

  const outputDir = await ensurePrivateOutputDirectory(options.outputDir, snapshotId);
  await assertCreateOnlyOutputFilesAbsent(outputDir);
  const transport = options.goldTransport ?? createUnavailableHumanGoldComparatorTransport();
  const modelId = options.modelId ?? GOLD_COMPARATOR_MODEL_ID;
  const modelVersion = options.modelVersion ?? modelId;
  const comparisonRecords: GoldComparisonRecord[] = [];
  for (let offset = 0; offset < validatedTargets.length; offset += maxWorkers) {
    const batch = validatedTargets.slice(offset, offset + maxWorkers);
    const batchResults = await Promise.all(
      batch.map(async ({ target, prediction, message }) => {
        const claim = await compareOneTarget(
          target,
          prediction,
          message,
          transport,
          { modelId, modelVersion },
          maxRetries,
        );
        return buildTargetRecord(
          target,
          prediction,
          message,
          claim,
          verifiedFor(options, requiredText(target.targetKey, 'target_key_missing')),
          cutoffAt,
        );
      }),
    );
    comparisonRecords.push(...batchResults);
  }
  const supplements = buildSupplementalRecords(inputs, u4.targets, cutoffAt);
  const records = [...comparisonRecords, ...supplements];
  const sourceSnapshotIds = { normal: normal.snapshotId, quarantine: quarantine.snapshotId };
  const report = aggregateToolDemand(records, snapshotId, sourceSnapshotIds);
  const stratum = stratumCounts(records);
  const grades = gradeCounts(records);
  const comparatorRuntimeBlockers = [
    ...new Set(
      records
        .map((record) => record.claimed_action.errorCode)
        .filter((code): code is string => code !== null && code.includes('unavailable')),
    ),
  ].sort();
  const audit: GoldAudit = {
    schemaVersion: GOLD_AUDIT_SCHEMA_VERSION,
    snapshotId,
    sourceManifests: {
      normal: {
        snapshotId: normal.snapshotId,
        manifestHash: normal.manifestHash,
        orderedHash: normal.orderedHash,
      },
      quarantine: {
        snapshotId: quarantine.snapshotId,
        manifestHash: quarantine.manifestHash,
        orderedHash: quarantine.orderedHash,
      },
    },
    classification: {
      snapshotId: requiredText(
        classifications.audit.snapshotId,
        'classification_snapshot_id_missing',
      ),
      orderedHash: classifications.orderedHash,
      recordCount: classifications.records.length,
      inputHashesVerified: true,
    },
    targetManifestHash: u4.targetHash,
    predictionFreezeHash: u4.predictionHash,
    targetCount: u4.targets.length,
    comparisonRecordCount: records.length,
    supplementalRecordCount: supplements.length,
    stratumCounts: stratum,
    gradeCounts: grades,
    claimedObservedCount: records.filter((record) => record.claimed_action.status === 'observed')
      .length,
    claimedUnavailableCount: records.filter(
      (record) => record.claimed_action.status === 'unavailable',
    ).length,
    verifiedObservedCount: records.filter(
      (record) => record.verified_pms_action.status === 'observed',
    ).length,
    verifiedNotObservedCount: records.filter(
      (record) => record.verified_pms_action.status === 'not_observed',
    ).length,
    comparatorRuntimeBlockers,
    privacy: {
      targetBodiesPersisted: false,
      addressesPersisted: false,
      attachmentsPersisted: false,
      stagehandHandoffSanitized: true,
    },
  };
  await writeCreateOnly(
    path.join(outputDir, 'gold-comparison.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  await writeCreateOnly(
    path.join(outputDir, 'tool-demand-report.md'),
    buildToolDemandMarkdown(report, audit),
  );
  await writeCreateOnly(
    path.join(outputDir, 'stagehand-handoff.md'),
    buildStagehandHandoff(report, records, audit),
  );
  await writeCreateOnly(
    path.join(outputDir, 'gold-audit.json'),
    `${JSON.stringify(audit, null, 2)}\n`,
  );
  return { snapshotId, outputDir, records, report, audit };
}

export const analyseCenturionHumanGold = compareCenturionHumanGold;

function parseCliArgs(argv: readonly string[]): CompareCenturionHumanGoldOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--') || !argv[index + 1] || argv[index + 1]!.startsWith('--'))
      return fail('invalid_arguments');
    values.set(arg.slice(2), argv[index + 1]!);
    index += 1;
  }
  const normalSnapshotDir = values.get('normal');
  const quarantineSnapshotDir = values.get('quarantine');
  const classificationOutputDir = values.get('classification-dir');
  const classificationPath = values.get('classification') ?? values.get('classifications');
  const humanAnalysisDir = values.get('human-analysis');
  const targetManifestPath = values.get('target-manifest');
  const predictionFreezePath = values.get('prediction-freeze');
  const outputDir = values.get('out');
  const snapshotId = values.get('snapshot');
  if (
    !normalSnapshotDir ||
    !quarantineSnapshotDir ||
    (!classificationPath && !classificationOutputDir) ||
    (!humanAnalysisDir && (!targetManifestPath || !predictionFreezePath)) ||
    !outputDir ||
    !snapshotId
  )
    return fail('invalid_arguments');
  return {
    normalSnapshotDir,
    quarantineSnapshotDir,
    ...(classificationPath ? { classificationPath } : {}),
    ...(classificationOutputDir ? { classificationOutputDir } : {}),
    ...(values.has('classification-audit')
      ? { classificationAuditPath: values.get('classification-audit') }
      : {}),
    ...(targetManifestPath ? { targetManifestPath } : {}),
    ...(predictionFreezePath ? { predictionFreezePath } : {}),
    ...(humanAnalysisDir ? { humanAnalysisDir } : {}),
    outputDir,
    snapshotId,
    ...(values.has('max-workers') ? { maxWorkers: Number(values.get('max-workers')) } : {}),
    ...(values.has('max-retries') ? { maxRetries: Number(values.get('max-retries')) } : {}),
    ...(values.has('cutoff-at') ? { cutoffAt: values.get('cutoff-at') } : {}),
  };
}

export type HumanGoldComparisonCliDependencies = {
  goldTransport?: HumanGoldComparatorTransport;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
};

export async function runCenturionHumanGoldComparisonCli(
  argv: readonly string[],
  dependencies: HumanGoldComparisonCliDependencies = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));
  try {
    const args = parseCliArgs(argv);
    const run = await compareCenturionHumanGold({
      ...args,
      ...(dependencies.goldTransport ? { goldTransport: dependencies.goldTransport } : {}),
    });
    const blocked =
      run.audit.comparatorRuntimeBlockers.length > 0 ||
      run.audit.gradeCounts.prediction_error > 0 ||
      run.audit.gradeCounts.unavailable > 0;
    writeStdout(
      `${JSON.stringify({ event: blocked ? 'centurion_human_gold.blocked' : 'centurion_human_gold.complete', status: blocked ? 'blocked' : 'complete', snapshotId: run.snapshotId, targetCount: run.audit.targetCount, comparisonRecordCount: run.audit.comparisonRecordCount, claimedObservedCount: run.audit.claimedObservedCount, verifiedObservedCount: run.audit.verifiedObservedCount, comparatorRuntimeBlockers: run.audit.comparatorRuntimeBlockers })}\n`,
    );
    return blocked ? 2 : 0;
  } catch {
    writeStderr(
      `${JSON.stringify({ event: 'centurion_human_gold.failed', code: 'comparison_failed' })}\n`,
    );
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return (
    typeof entry === 'string' &&
    path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  );
}

if (isMainModule())
  process.exitCode = await runCenturionHumanGoldComparisonCli(process.argv.slice(2));
