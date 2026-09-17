/**
 * Offline, blinded analysis of Centurion human outbound replies.
 *
 * This module only reads sealed U1/U2 snapshots and the sealed U3 classification
 * JSONL.  It has no database, object-store, mail, PMS, deployment, or network
 * dependency.  A predictor sees a redacted pre-target context; target payloads
 * are represented by hashes in the target manifest and are never sent to a
 * worker or written to the predictor input.
 */
import {
  CENTURION_TRANSPORT_ID,
  CENTURION_WINDOW_END_UTC,
  CENTURION_WINDOW_START_UTC,
  CENTURION_WINDOW_TIMEZONE,
} from '../src/ops/centurion-thread-corpus-postgres-reader.js';
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
import { DEFAULT_LUNA_MODEL_ID } from './classify-centurion-nine-day-corpus.js';

const ANALYSIS_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const HUMAN_RESPONSE_ANALYSIS_SCHEMA_VERSION =
  'centurion-human-response-analysis-v1' as const;
export const TARGET_MANIFEST_SCHEMA_VERSION = 'centurion-target-manifest-v1' as const;
export const PREDICTION_FREEZE_SCHEMA_VERSION = 'centurion-prediction-freeze-v1' as const;
export const HUMAN_RESPONSE_PROMPT_VERSION = 'centurion-human-response-prompt-v1' as const;

export const HUMAN_RESPONSE_OPERATIONS = [
  'read',
  'create',
  'amend',
  'cancel',
  'post_payment',
  'refund',
  'document',
  'attachment',
  'partner',
  'channel',
  'none',
  'unknown',
] as const;

export type HumanResponseOperation = (typeof HUMAN_RESPONSE_OPERATIONS)[number];

export const TARGET_STATUSES = [
  'paired',
  'ambiguous',
  'no_eligible_inbound',
  'outbound_only',
] as const;

export type TargetStatus = (typeof TARGET_STATUSES)[number];

export const HUMAN_RESPONSE_NEED_LEVELS = [
  'required',
  'likely',
  'optional',
  'not_needed',
  'unknown',
] as const;

export type HumanResponseNeedLevel = (typeof HUMAN_RESPONSE_NEED_LEVELS)[number];

export const HUMAN_RESPONSE_PREDICTION_LIMITS = {
  opaqueIdMaxLength: 256,
  operationCountMax: HUMAN_RESPONSE_OPERATIONS.length,
  requiredFieldCountMax: 32,
  requiredFieldMaxLength: 256,
  candidateToolMaxLength: 256,
  unknownReasonMaxLength: 2048,
} as const;

/**
 * The hash covers the complete wire contract, including canonical names,
 * compatibility aliases, required/nullability rules, and validation bounds.
 * A vocabulary-only hash is not sufficient to bind a worker to this parser.
 */
export const HUMAN_RESPONSE_PREDICTION_SCHEMA = {
  schemaVersion: PREDICTION_FREEZE_SCHEMA_VERSION,
  request: {
    required: [
      'workerId',
      'modelId',
      'modelVersion',
      'promptVersion',
      'promptHash',
      'schemaVersion',
      'schemaHash',
      'inputHash',
      'input',
    ],
  },
  response: {
    required: [
      'opaqueId',
      'operations',
      'primaryOperation',
      'needLevel',
      'requiredFields',
      'candidateTool',
      'unknownReason',
    ],
    aliases: {
      primaryOperation: 'primary_operation',
      needLevel: 'need_level',
      requiredFields: 'required_fields',
      candidateTool: 'candidate_tool',
      unknownReason: 'unknown_reason',
    },
    optional: ['contextIncomplete'],
  },
  operation: {
    required: ['operation', 'needLevel', 'requiredFields', 'candidateTool', 'unknownReason'],
    aliases: {
      operation: 'op',
      needLevel: 'need_level',
      requiredFields: 'required_fields',
      candidateTool: 'candidate_tool',
      unknownReason: 'unknown_reason',
    },
  },
  vocabularies: {
    operations: HUMAN_RESPONSE_OPERATIONS,
    needLevels: HUMAN_RESPONSE_NEED_LEVELS,
  },
  limits: HUMAN_RESPONSE_PREDICTION_LIMITS,
} as const;

export const DEFAULT_MAX_WORKERS = 5 as const;
export const DEFAULT_MAX_RETRIES = 2 as const;
export const DEFAULT_CAUSAL_WINDOW_DAYS = 30 as const;
export const DEFAULT_CAUSAL_WINDOW_MS = DEFAULT_CAUSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const HUMAN_RESPONSE_PROMPT_HASH = sha256(
  [
    HUMAN_RESPONSE_PROMPT_VERSION,
    'Predict semantic operations from a complete, redacted pre-target Centurion context.',
    'Never assume target, later, quoted, or post-target evidence is available.',
    `Operations: ${HUMAN_RESPONSE_OPERATIONS.join(',')}.`,
  ].join('\n'),
);

export const HUMAN_RESPONSE_SCHEMA_HASH = sha256(JSON.stringify(HUMAN_RESPONSE_PREDICTION_SCHEMA));

type JsonRecord = Record<string, unknown>;

export type HumanResponseAttachmentEvidence = {
  attachmentId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  contentId: string | null;
  availability: 'available' | 'unsupported' | 'oversized' | 'malformed' | 'unavailable';
  sourceRecordId: string;
};

export type HumanResponsePredictorMessage = {
  role: 'triggering_inbound' | 'earlier_context';
  source: 'normal' | 'quarantine';
  sourceRecordId: string;
  messageId: string | null;
  threadId: string | null;
  eventAt: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  inReplyTo: string | null;
  references: string[];
  attachments: HumanResponseAttachmentEvidence[];
  bodyHash: string;
  headerHash: string;
  attachmentHash: string;
};

export type HumanResponsePredictorInput = {
  schemaVersion: typeof HUMAN_RESPONSE_ANALYSIS_SCHEMA_VERSION;
  triggeringInbound: HumanResponsePredictorMessage;
  earlierContext: HumanResponsePredictorMessage[];
  contextIncomplete: boolean;
  contextIncompleteReasons: string[];
};

export type HumanResponseWorkerRequest = {
  workerId: string;
  modelId: string;
  modelVersion: string;
  promptVersion: typeof HUMAN_RESPONSE_PROMPT_VERSION;
  promptHash: string;
  schemaVersion: typeof PREDICTION_FREEZE_SCHEMA_VERSION;
  schemaHash: string;
  inputHash: string;
  input: HumanResponsePredictorInput;
};

export type HumanResponsePredictionOperation = {
  operation: HumanResponseOperation;
  needLevel: HumanResponseNeedLevel;
  requiredFields: string[];
  candidateTool: string | null;
  unknownReason: string | null;
  need_level?: HumanResponseNeedLevel;
  required_fields?: string[];
  candidate_tool?: string | null;
  unknown_reason?: string | null;
};

export type HumanResponseWorkerResponse = {
  opaqueId: string;
  operations: HumanResponsePredictionOperation[];
  primaryOperation: HumanResponseOperation;
  needLevel: HumanResponseNeedLevel;
  requiredFields: string[];
  candidateTool: string | null;
  unknownReason: string | null;
  contextIncomplete?: boolean;
};

export type HumanResponseWorkerTransport = {
  predict(request: HumanResponseWorkerRequest): Promise<unknown>;
};

export type HumanResponsePredictionErrorCode =
  | 'target_status_ambiguous'
  | 'target_status_no_eligible_inbound'
  | 'target_status_outbound_only'
  | 'target_payload_leakage'
  | 'luna_worker_transport_unavailable'
  | 'worker_error'
  | 'prediction_parse_error'
  | 'context_incomplete';

export type HumanResponseTargetManifestRecord = {
  schemaVersion: typeof TARGET_MANIFEST_SCHEMA_VERSION;
  targetKey: string;
  source: 'normal' | 'quarantine';
  sourceRecordId: string;
  eventAt: string;
  messageId: string | null;
  targetStatus: TargetStatus;
  status: TargetStatus;
  candidateInboundRecordIds: string[];
  eligibleInboundRecordIds: string[];
  triggeringInboundRecordId: string | null;
  matchMethod: 'in_reply_to' | 'reference' | 'thread' | null;
  targetBodyHash: string;
  targetHeaderHash: string;
  targetAttachmentHash: string;
  preTargetInputHash: string | null;
  preTargetBodyHashes: string[];
  pendingAtCutoff: boolean;
  lateResponse: boolean;
  contextIncomplete: boolean;
  contextIncompleteReasons: string[];
  predictionError: HumanResponsePredictionErrorCode | null;
  /** Snake-case aliases make the audit contract easy to consume without changing semantics. */
  pending_at_cutoff: boolean;
  late_response: boolean;
  context_incomplete: boolean;
};

export type HumanResponsePredictionFreezeRecord = {
  schemaVersion: typeof PREDICTION_FREEZE_SCHEMA_VERSION;
  targetKey: string;
  targetStatus: TargetStatus;
  status: TargetStatus;
  frozenAt: string;
  modelId: string;
  modelVersion: string;
  promptVersion: typeof HUMAN_RESPONSE_PROMPT_VERSION;
  promptHash: string;
  schemaHash: string;
  inputHash: string | null;
  targetBodyHash: string;
  targetHeaderHash: string;
  targetAttachmentHash: string;
  preTargetBodyHashes: string[];
  predictorInput: HumanResponsePredictorInput | null;
  predictionStatus: 'frozen' | 'context_incomplete' | 'prediction_error' | 'not_attempted';
  predictionError: HumanResponsePredictionErrorCode | null;
  opaqueWorkerId: string | null;
  attempts: number;
  retries: number;
  operations: HumanResponsePredictionOperation[];
  primaryOperation: HumanResponseOperation | null;
  primary_operation: HumanResponseOperation | null;
  needLevel: HumanResponseNeedLevel | null;
  need_level: HumanResponseNeedLevel | null;
  requiredFields: string[];
  required_fields: string[];
  candidateTool: string | null;
  candidate_tool: string | null;
  unknownReason: string | null;
  unknown_reason: string | null;
  pendingAtCutoff: boolean;
  lateResponse: boolean;
  contextIncomplete: boolean;
  pending_at_cutoff: boolean;
  late_response: boolean;
  context_incomplete: boolean;
};

export type HumanResponseAnalysisAudit = {
  schemaVersion: typeof HUMAN_RESPONSE_ANALYSIS_SCHEMA_VERSION;
  snapshotId: string;
  normalSourceRows: number;
  quarantineSourceRows: number;
  inWindowHumanOutboundCount: number;
  targetCount: number;
  targetStatusCounts: Record<TargetStatus, number>;
  pairedCount: number;
  ambiguousCount: number;
  noEligibleInboundCount: number;
  outboundOnlyCount: number;
  pendingAtCutoffCount: number;
  lateResponseCount: number;
  contextIncompleteCount: number;
  predictionErrorCount: number;
  unansweredInboundCount: number;
  unansweredInboundRecordIds: string[];
  excludedAtCutoffOutboundCount: number;
  workerRuntimeBlockers: string[];
  causalWindowDays: number;
  leakageViolations: string[];
};

export type HumanResponseAnalysisRun = {
  snapshotId: string;
  outputDir: string;
  targets: HumanResponseTargetManifestRecord[];
  predictions: HumanResponsePredictionFreezeRecord[];
  audit: HumanResponseAnalysisAudit;
};

export type AnalyseCenturionHumanResponsesOptions = {
  normalSnapshotDir: string;
  quarantineSnapshotDir: string;
  /** Path to U3 daily-classification.jsonl or its containing output directory. */
  classificationPath?: string;
  classificationOutputDir?: string;
  classificationRecordsPath?: string;
  outputDir: string;
  snapshotId: string;
  workerTransport?: HumanResponseWorkerTransport;
  modelId?: string;
  modelVersion?: string;
  maxWorkers?: number;
  maxRetries?: number;
  causalWindowDays?: number;
  cutoffAt?: string;
};

type SnapshotKind = 'normal' | 'quarantine';

type LoadedSnapshot = {
  kind: SnapshotKind;
  directory: string;
  recordPath: string;
  records: JsonRecord[];
  snapshotId: string;
  asOf: string;
  orderedHash: string;
};

type ClassificationInfo = {
  recordKey: string;
  sourceRecordId: string;
  source: 'normal' | 'quarantine';
  status: string;
  inputHash: string;
  eventAt: string | null;
  businessDirection: string | null;
  origin: string | null;
};

type CorpusMessage = {
  source: 'normal' | 'quarantine';
  sourceRecordId: string;
  recordKey: string;
  raw: JsonRecord;
  messageId: string | null;
  threadId: string | null;
  eventAt: string | null;
  body: string;
  htmlBody: string;
  subject: string;
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  inReplyTo: string | null;
  references: string[];
  sourceDirection: 'inbound' | 'outbound' | 'ambiguous' | 'unknown';
  attachments: HumanResponseAttachmentEvidence[];
  available: boolean;
  coreIncluded: boolean;
  contextOnly: boolean;
  classification: ClassificationInfo | null;
};

type TargetMatch = {
  status: TargetStatus;
  candidates: CorpusMessage[];
  eligible: CorpusMessage[];
  triggeringInbound: CorpusMessage | null;
  method: 'in_reply_to' | 'reference' | 'thread' | null;
  contextIncomplete: boolean;
  contextIncompleteReasons: string[];
};

type NormalizedPrediction = HumanResponseWorkerResponse;

class PredictionResponseError extends Error {
  readonly code: 'prediction_parse_error' | 'context_incomplete';

  constructor(code: 'prediction_parse_error' | 'context_incomplete') {
    super(code);
    this.name = 'PredictionResponseError';
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function objectHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code: string): never {
  throw new Error(code);
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

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function strictStrings(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return fail(code);
  return value as string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function iso(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function canonicalMessageId(value: string | null): string | null {
  if (!value) return null;
  return value.trim().replace(/^<|>$/g, '').toLowerCase() || null;
}

function messageIdSet(message: CorpusMessage): Set<string> {
  const ids = new Set<string>();
  const messageId = canonicalMessageId(message.messageId);
  if (messageId) ids.add(messageId);
  for (const value of message.references) {
    const id = canonicalMessageId(value);
    if (id) ids.add(id);
  }
  const inReplyTo = canonicalMessageId(message.inReplyTo);
  if (inReplyTo) ids.add(inReplyTo);
  return ids;
}

function recordSourceDirection(
  record: JsonRecord,
  source: SnapshotKind,
): CorpusMessage['sourceDirection'] {
  const value =
    source === 'normal' ? (record.businessDirection ?? record.direction) : record.status;
  return value === 'inbound' || value === 'outbound' || value === 'ambiguous' ? value : 'unknown';
}

function attachmentStatus(value: unknown): HumanResponseAttachmentEvidence['availability'] {
  return value === 'available' ||
    value === 'unsupported' ||
    value === 'oversized' ||
    value === 'malformed' ||
    value === 'unavailable'
    ? value
    : 'available';
}

function normalAttachments(
  record: JsonRecord,
  sourceRecordId: string,
): HumanResponseAttachmentEvidence[] {
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

function quarantineAttachments(
  record: JsonRecord,
  sourceRecordId: string,
): HumanResponseAttachmentEvidence[] {
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
    availability: attachmentStatus(attachment.contentStatus),
    sourceRecordId,
  }));
}

function normalizeCorpusMessage(
  record: JsonRecord,
  source: SnapshotKind,
  classification: ClassificationInfo | null,
): CorpusMessage {
  const sourceRecordId = requiredText(record.id, `${source}_record_id_missing`);
  const body = text(record.textBody) ?? '';
  const htmlBody = text(record.htmlBody) ?? '';
  const reportPartition = text(record.reportPartition);
  const parseStatus = text(record.parseStatus);
  const contextOnly = source === 'normal' && record.contextOnly === true;
  const coreIncluded =
    source === 'normal'
      ? record.dailyIncluded === true &&
        iso(record.eventAt) !== null &&
        isCoreInstant(iso(record.eventAt))
      : reportPartition === 'core' &&
        parseStatus === 'parsed' &&
        isCoreInstant(iso(record.messageDate));
  const references = strictStrings(record.references ?? [], `${source}_references_invalid`);
  const inReplyTo = nullableText(record.inReplyTo, `${source}_in_reply_to_invalid`);
  const messageId = nullableText(record.messageId, `${source}_message_id_invalid`);
  return {
    source,
    sourceRecordId,
    recordKey: `${source}:${sourceRecordId}`,
    raw: record,
    messageId,
    threadId: nullableText(record.threadId, `${source}_thread_id_invalid`),
    eventAt: iso(source === 'normal' ? record.eventAt : record.messageDate),
    body,
    htmlBody,
    subject: text(record.subject) ?? '',
    from: strings(record.from),
    to: strings(record.to),
    cc: strings(record.cc),
    bcc: strings(record.bcc),
    inReplyTo,
    references,
    sourceDirection: recordSourceDirection(record, source),
    attachments:
      source === 'normal'
        ? normalAttachments(record, sourceRecordId)
        : quarantineAttachments(record, sourceRecordId),
    available: source === 'normal' || parseStatus === 'parsed',
    coreIncluded,
    contextOnly,
    classification,
  };
}

function normalizeJsonl(raw: string, fileName: string): JsonRecord[] {
  if (raw === '') return [];
  if (!raw.endsWith('\n')) return fail(`${fileName}_missing_terminal_newline`);
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
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

async function readSealedSnapshot(directory: string, kind: SnapshotKind): Promise<LoadedSnapshot> {
  const absoluteDirectory = path.resolve(directory);
  const fileName = kind === 'normal' ? 'messages.jsonl' : 'quarantine.jsonl';
  const manifestRaw = await readFile(path.join(absoluteDirectory, 'manifest.json'), 'utf8');
  const recordsRaw = await readFile(path.join(absoluteDirectory, fileName), 'utf8');
  let manifest: JsonRecord;
  try {
    const value: unknown = JSON.parse(manifestRaw);
    if (!isRecord(value)) return fail(`${kind}_manifest_not_object`);
    manifest = value;
  } catch {
    return fail(`${kind}_manifest_invalid_json`);
  }
  const expectedSchema =
    kind === 'normal' ? 'centurion-nine-day-corpus-v1' : 'centurion-quarantine-v1';
  if (manifest.schemaVersion !== expectedSchema) return fail(`${kind}_manifest_schema_mismatch`);
  if (manifest.transportId !== CENTURION_TRANSPORT_ID)
    return fail(`${kind}_manifest_transport_mismatch`);
  if (!isRecord(manifest.window)) return fail(`${kind}_manifest_window_invalid`);
  if (
    manifest.window.startInclusive !== CENTURION_WINDOW_START_UTC ||
    manifest.window.endExclusive !== CENTURION_WINDOW_END_UTC ||
    manifest.window.timezone !== CENTURION_WINDOW_TIMEZONE
  )
    return fail(`${kind}_manifest_window_mismatch`);
  const snapshotId = requiredText(manifest.snapshotId, `${kind}_manifest_snapshot_id_invalid`);
  const asOf = requiredText(manifest.asOf, `${kind}_manifest_as_of_invalid`);
  if (!iso(asOf)) return fail(`${kind}_manifest_as_of_invalid`);
  const records = normalizeJsonl(recordsRaw, fileName);
  const orderedHash = sha256(records.map((record) => JSON.stringify(record)).join('\n'));
  const expectedHash =
    kind === 'normal' ? manifest.orderedMessageSha256 : manifest.orderedRecordSha256;
  if (typeof expectedHash !== 'string' || expectedHash !== orderedHash)
    return fail(`${kind}_ordered_hash_mismatch`);
  for (const record of records) {
    requiredText(record.id, `${kind}_record_id_missing`);
    if (kind === 'normal') {
      if (record.transportId !== CENTURION_TRANSPORT_ID)
        return fail('normal_record_transport_mismatch');
      if (typeof record.textBody !== 'string' || typeof record.htmlBody !== 'string')
        return fail('normal_record_body_invalid');
    } else if (
      record.recordType !== 'quarantine' ||
      record.schemaVersion !== 'centurion-quarantine-v1'
    ) {
      return fail('quarantine_record_schema_mismatch');
    }
  }
  return {
    kind,
    directory: absoluteDirectory,
    recordPath: path.join(absoluteDirectory, fileName),
    records,
    snapshotId,
    asOf,
    orderedHash,
  };
}

async function readClassificationRecords(fileOrDirectory: string): Promise<ClassificationInfo[]> {
  const resolved = path.resolve(fileOrDirectory);
  const entry = await lstat(resolved);
  const filePath = entry.isDirectory()
    ? path.join(resolved, 'daily-classification.jsonl')
    : resolved;
  const records = normalizeJsonl(await readFile(filePath, 'utf8'), 'daily-classification.jsonl');
  const seen = new Set<string>();
  return records.map((record) => {
    if (record.schemaVersion !== 'centurion-classification-v1')
      return fail('classification_schema_mismatch');
    const recordKey = requiredText(record.recordKey, 'classification_record_key_missing');
    if (seen.has(recordKey)) return fail('classification_record_key_duplicate');
    seen.add(recordKey);
    const source =
      record.source === 'normal' || record.source === 'quarantine' ? record.source : null;
    if (!source) return fail('classification_source_invalid');
    const sourceRecordId = requiredText(
      record.sourceRecordId,
      'classification_source_record_id_missing',
    );
    const inputHash = requiredText(record.inputHash, 'classification_input_hash_missing');
    if (!/^[a-f0-9]{64}$/.test(inputHash)) return fail('classification_input_hash_invalid');
    return {
      recordKey,
      sourceRecordId,
      source,
      status: text(record.status) ?? 'unknown',
      inputHash,
      eventAt: iso(record.eventAt),
      businessDirection: text(record.businessDirection),
      origin: text(record.origin),
    };
  });
}

function isCoreInstant(value: string | null): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return (
    timestamp >= Date.parse(CENTURION_WINDOW_START_UTC) &&
    timestamp < Date.parse(CENTURION_WINDOW_END_UTC)
  );
}

function chooseClassificationMap(
  records: readonly JsonRecord[],
  classifications: readonly ClassificationInfo[],
): Map<string, ClassificationInfo> {
  const byKey = new Map(classifications.map((record) => [record.recordKey, record]));
  const expectedKeys = new Set(
    records
      .map((record) => {
        const source = record.recordType === 'quarantine' ? 'quarantine' : 'normal';
        const id = text(record.id);
        return id ? `${source}:${id}` : null;
      })
      .filter((key): key is string => key !== null),
  );
  for (const key of byKey.keys()) {
    if (!expectedKeys.has(key)) return fail('classification_unexpected_record_key');
  }
  for (const record of records) {
    const source = record.recordType === 'quarantine' ? 'quarantine' : 'normal';
    const id = text(record.id);
    if (!id) continue;
    const key = `${source}:${id}`;
    const classification = byKey.get(key);
    if (!classification) continue;
    if (classification.sourceRecordId !== id || classification.source !== source)
      return fail('classification_source_identity_mismatch');
    if (classification.inputHash !== objectHash(record))
      return fail('classification_input_hash_mismatch');
  }
  return byKey;
}

function normalizedTargetIds(target: CorpusMessage): Set<string> {
  const ids = messageIdSet(target);
  return ids;
}

type MatchingDirection = 'inbound' | 'outbound' | 'ambiguous' | 'unknown';

/**
 * Preserve ambiguity when source evidence and the U3 classification disagree.
 * A linked ambiguous row is a candidate, never an eligible predictor trigger.
 */
function matchingDirection(message: CorpusMessage): MatchingDirection {
  const classified = message.classification?.businessDirection;
  const directions = new Set<MatchingDirection>([message.sourceDirection]);
  if (classified === 'inbound' || classified === 'outbound' || classified === 'ambiguous')
    directions.add(classified);
  if (directions.has('ambiguous')) return 'ambiguous';
  if (directions.has('inbound') && directions.has('outbound')) return 'ambiguous';
  if (directions.has('inbound')) return 'inbound';
  if (directions.has('outbound')) return 'outbound';
  return 'unknown';
}

function matchStrength(
  target: CorpusMessage,
  inbound: CorpusMessage,
): 'in_reply_to' | 'reference' | 'thread' | null {
  const inboundId = canonicalMessageId(inbound.messageId);
  const targetInReplyTo = canonicalMessageId(target.inReplyTo);
  if (inboundId && targetInReplyTo === inboundId) return 'in_reply_to';
  if (
    inboundId &&
    target.references.some((reference) => canonicalMessageId(reference) === inboundId)
  )
    return 'reference';
  if (target.threadId && inbound.threadId && target.threadId === inbound.threadId) return 'thread';
  return null;
}

function compareMessages(left: CorpusMessage, right: CorpusMessage): number {
  const leftAt = left.eventAt ? Date.parse(left.eventAt) : Number.POSITIVE_INFINITY;
  const rightAt = right.eventAt ? Date.parse(right.eventAt) : Number.POSITIVE_INFINITY;
  return leftAt - rightAt || left.recordKey.localeCompare(right.recordKey);
}

function matchTarget(
  target: CorpusMessage,
  inboundMessages: readonly CorpusMessage[],
  causalWindowMs: number,
): TargetMatch {
  const targetAt = target.eventAt ? Date.parse(target.eventAt) : NaN;
  const relatedInbound = inboundMessages.filter(
    (candidate) => matchStrength(target, candidate) !== null,
  );
  const causalCandidates = relatedInbound.filter((candidate) => {
    if (!candidate.eventAt || Number.isNaN(targetAt)) return false;
    const candidateAt = Date.parse(candidate.eventAt);
    return candidateAt < targetAt && candidateAt >= targetAt - causalWindowMs;
  });
  const unknownTimeCandidates = relatedInbound.filter((candidate) => candidate.eventAt === null);
  const candidates = [...causalCandidates, ...unknownTimeCandidates].sort(compareMessages);
  const contextIncompleteReasons = unknownTimeCandidates.map(
    (candidate) => `${candidate.recordKey}:event_time_unknown`,
  );
  const contextIncomplete = contextIncompleteReasons.length > 0;
  const availableCandidates = causalCandidates.filter(
    (candidate) => candidate.available && matchingDirection(candidate) === 'inbound',
  );
  const ambiguousCandidates = causalCandidates.filter(
    (candidate) => matchingDirection(candidate) === 'ambiguous',
  );
  const result = (
    status: TargetStatus,
    triggeringInbound: CorpusMessage | null = null,
    method: TargetMatch['method'] = null,
  ): TargetMatch => ({
    status,
    candidates,
    eligible: availableCandidates,
    triggeringInbound,
    method,
    contextIncomplete,
    contextIncompleteReasons,
  });
  if (ambiguousCandidates.length > 0) return result('ambiguous');
  if (availableCandidates.length === 0) {
    return result(relatedInbound.length === 0 ? 'outbound_only' : 'no_eligible_inbound');
  }
  const inReplyTo = candidates.filter(
    (candidate) =>
      matchStrength(target, candidate) === 'in_reply_to' &&
      matchingDirection(candidate) === 'inbound' &&
      candidate.eventAt !== null,
  );
  if (inReplyTo.length > 1) {
    return result('ambiguous');
  }
  if (inReplyTo.length === 1 && inReplyTo[0]!.available) {
    return result('paired', inReplyTo[0]!, 'in_reply_to');
  }
  if (inReplyTo.length === 1) {
    return result('no_eligible_inbound');
  }
  const references = candidates.filter(
    (candidate) =>
      matchStrength(target, candidate) === 'reference' &&
      matchingDirection(candidate) === 'inbound' &&
      candidate.eventAt !== null,
  );
  if (references.length > 1) {
    return result('ambiguous');
  }
  if (references.length === 1 && references[0]!.available) {
    return result('paired', references[0]!, 'reference');
  }
  if (references.length === 1) {
    return result('no_eligible_inbound');
  }
  const threadCandidates = candidates.filter(
    (candidate) =>
      matchStrength(target, candidate) === 'thread' &&
      matchingDirection(candidate) === 'inbound' &&
      candidate.eventAt !== null,
  );
  if (threadCandidates.length === 1 && threadCandidates[0]!.available) {
    const candidate = threadCandidates[0]!;
    return result('paired', candidate, 'thread');
  }
  if (threadCandidates.length === 1) {
    return result('no_eligible_inbound');
  }
  return result('ambiguous');
}

function stripQuotedText(value: string): string {
  const lines = value.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    // A marker without `>` is still a quote boundary. Drop its complete
    // suffix; resuming on the next unprefixed line would leak quoted replies.
    if (/^\s*(on .+wrote:|-----original message-----|begin forwarded message:?)\s*$/i.test(line))
      break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function stripQuotedHtml(value: string): string {
  return value
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(
      /<div[^>]*(?:id|class)=["'][^"']*(?:gmail_quote|yahoo_quoted|moz-cite-prefix)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      '',
    )
    .replace(
      /<div[^>]*class=["'][^"']*(?:gmail_quote|yahoo_quoted)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      '',
    )
    .replace(
      /<(?:p|div)[^>]*>\s*(?:on .+wrote:|-----original message-----|begin forwarded message:?)\s*<\/(?:p|div)>[\s\S]*$/i,
      '',
    )
    .trim();
}

function safeAttachmentEvidence(message: CorpusMessage): HumanResponseAttachmentEvidence[] {
  return message.attachments.map((attachment) => ({ ...attachment }));
}

function attachmentHash(message: CorpusMessage): string {
  return objectHash(safeAttachmentEvidence(message));
}

function headerHash(message: CorpusMessage): string {
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

function bodyHash(message: CorpusMessage): string {
  return objectHash({ textBody: message.body, htmlBody: message.htmlBody });
}

function normalizedLeakageText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/gi, ' ')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

type ForbiddenPredictorMaterial = {
  ids: ReadonlySet<string>;
  values: ReadonlySet<string>;
};

function forbiddenHeaderValues(messages: readonly CorpusMessage[]): Set<string> {
  const values = new Set<string>();
  for (const message of messages) {
    const candidates = [
      message.sourceRecordId,
      message.recordKey,
      message.messageId,
      message.threadId,
      message.eventAt,
      message.subject,
      message.inReplyTo,
      ...message.references,
      ...message.from,
      ...message.to,
      ...message.cc,
      ...message.bcc,
      ...message.attachments.flatMap((attachment) => [attachment.filename, attachment.contentId]),
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') values.add(candidate);
    }
  }
  return values;
}

function isForbiddenPredictorValue(value: string, forbidden: ForbiddenPredictorMaterial): boolean {
  if (forbidden.values.has(value)) return true;
  const normalized = normalizedLeakageText(value);
  return (
    normalized.length >= 8 &&
    [...forbidden.values].some((item) => {
      const normalizedItem = normalizedLeakageText(item);
      return normalizedItem.length >= 8 && normalizedItem === normalized;
    })
  );
}

function contextMessage(
  message: CorpusMessage,
  role: HumanResponsePredictorMessage['role'],
  forbidden: ForbiddenPredictorMaterial,
): HumanResponsePredictorMessage {
  const references = message.references
    .filter((reference) => !forbidden.ids.has(canonicalMessageId(reference) ?? ''))
    .map((reference) => reference);
  const inReplyTo = forbidden.ids.has(canonicalMessageId(message.inReplyTo) ?? '')
    ? null
    : message.inReplyTo;
  return {
    role,
    source: message.source,
    sourceRecordId: isForbiddenPredictorValue(message.sourceRecordId, forbidden)
      ? 'redacted'
      : message.sourceRecordId,
    messageId: forbidden.ids.has(canonicalMessageId(message.messageId) ?? '')
      ? null
      : message.messageId,
    threadId:
      message.threadId && !isForbiddenPredictorValue(message.threadId, forbidden)
        ? message.threadId
        : null,
    eventAt: message.eventAt!,
    subject: isForbiddenPredictorValue(message.subject, forbidden) ? '' : message.subject,
    textBody: stripQuotedText(message.body),
    htmlBody: stripQuotedHtml(message.htmlBody),
    from: message.from.filter((value) => !isForbiddenPredictorValue(value, forbidden)),
    to: message.to.filter((value) => !isForbiddenPredictorValue(value, forbidden)),
    cc: message.cc.filter((value) => !isForbiddenPredictorValue(value, forbidden)),
    bcc: message.bcc.filter((value) => !isForbiddenPredictorValue(value, forbidden)),
    inReplyTo,
    references,
    attachments: safeAttachmentEvidence(message).map((attachment) =>
      isForbiddenPredictorValue(attachment.filename, forbidden)
        ? { ...attachment, filename: '', contentId: null }
        : attachment,
    ),
    bodyHash: bodyHash(message),
    headerHash: headerHash(message),
    attachmentHash: attachmentHash(message),
  };
}

function contextBelongsToTarget(
  message: CorpusMessage,
  target: CorpusMessage,
  trigger: CorpusMessage,
): boolean {
  if (message.recordKey === trigger.recordKey) return true;
  if (target.threadId && message.threadId === target.threadId) return true;
  if (trigger.threadId && message.threadId === trigger.threadId) return true;
  const messageIds = messageIdSet(message);
  const targetIds = normalizedTargetIds(target);
  const triggerIds = messageIdSet(trigger);
  return [...messageIds].some((id) => targetIds.has(id) || triggerIds.has(id));
}

function buildPredictorInput(
  target: CorpusMessage,
  trigger: CorpusMessage,
  allMessages: readonly CorpusMessage[],
  causalWindowMs: number,
): { input: HumanResponsePredictorInput; leakage: string | null } {
  const targetAt = Date.parse(target.eventAt!);
  const contextCandidates = allMessages
    .filter((message) => {
      if (!message.eventAt || Date.parse(message.eventAt) >= targetAt) return false;
      if (Date.parse(message.eventAt) < targetAt - causalWindowMs) return false;
      return contextBelongsToTarget(message, target, trigger);
    })
    .sort(compareMessages);
  const contextIncompleteReasons: string[] = [];
  for (const message of contextCandidates) {
    if (!message.available) contextIncompleteReasons.push(`${message.recordKey}:unavailable`);
    if (message.attachments.some((attachment) => attachment.availability !== 'available')) {
      contextIncompleteReasons.push(`${message.recordKey}:attachment_unavailable`);
    }
  }
  const forbiddenMessages = allMessages.filter(
    (message) => message.eventAt && Date.parse(message.eventAt) >= targetAt,
  );
  const forbiddenIds = new Set<string>();
  for (const message of [target, ...forbiddenMessages]) {
    for (const id of messageIdSet(message)) forbiddenIds.add(id);
  }
  const forbidden: ForbiddenPredictorMaterial = {
    ids: forbiddenIds,
    values: forbiddenHeaderValues([target, ...forbiddenMessages]),
  };
  const triggerInput = contextMessage(trigger, 'triggering_inbound', forbidden);
  const earlierContext = contextCandidates
    .filter((message) => message.recordKey !== trigger.recordKey && message.available)
    .map((message) => contextMessage(message, 'earlier_context', forbidden));
  const input: HumanResponsePredictorInput = {
    schemaVersion: HUMAN_RESPONSE_ANALYSIS_SCHEMA_VERSION,
    triggeringInbound: triggerInput,
    earlierContext,
    contextIncomplete: contextIncompleteReasons.length > 0,
    contextIncompleteReasons: [...new Set(contextIncompleteReasons)].sort(),
  };
  const serialized = JSON.stringify(input);
  const forbiddenFragments = [
    target.body,
    target.htmlBody,
    ...forbiddenMessages
      .filter((message) => message.recordKey !== target.recordKey)
      .flatMap((message) => [message.body, message.htmlBody]),
    ...forbidden.values,
  ]
    .map((value) => normalizedLeakageText(value))
    .filter((value) => value.length >= 8);
  const normalizedSerialized = normalizedLeakageText(serialized);
  const leakage = forbiddenFragments.some((fragment) => normalizedSerialized.includes(fragment))
    ? 'target_or_post_target_payload_detected'
    : null;
  return { input: deepFreeze(input), leakage };
}

function operation(value: unknown): value is HumanResponseOperation {
  return (
    typeof value === 'string' && (HUMAN_RESPONSE_OPERATIONS as readonly string[]).includes(value)
  );
}

function needLevel(value: unknown): value is HumanResponseNeedLevel {
  return (
    typeof value === 'string' && (HUMAN_RESPONSE_NEED_LEVELS as readonly string[]).includes(value)
  );
}

const OPERATION_PRIORITY: readonly HumanResponseOperation[] = HUMAN_RESPONSE_OPERATIONS;

export function choosePrimaryOperation(
  operations: readonly HumanResponseOperation[],
): HumanResponseOperation {
  const present = new Set(operations);
  return OPERATION_PRIORITY.find((item) => present.has(item)) ?? 'unknown';
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function aliasedValue(record: JsonRecord, canonical: string, alias: string): unknown {
  const hasCanonical = hasOwn(record, canonical);
  const hasAlias = hasOwn(record, alias);
  if (hasCanonical && hasAlias && !jsonEqual(record[canonical], record[alias]))
    throw new PredictionResponseError('prediction_parse_error');
  if (hasCanonical) return record[canonical];
  if (hasAlias) return record[alias];
  throw new PredictionResponseError('prediction_parse_error');
}

function rejectUnknownKeys(record: JsonRecord, allowed: ReadonlySet<string>): void {
  if (Object.keys(record).some((key) => !allowed.has(key)))
    throw new PredictionResponseError('prediction_parse_error');
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maxLength) return null;
  return value;
}

function normalizePredictionOperation(value: unknown): HumanResponsePredictionOperation {
  if (!isRecord(value)) throw new PredictionResponseError('prediction_parse_error');
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
  );
  const rawOperation = aliasedValue(value, 'operation', 'op');
  const rawNeedLevel = aliasedValue(value, 'needLevel', 'need_level');
  const rawRequiredFields = aliasedValue(value, 'requiredFields', 'required_fields');
  const rawCandidateTool = aliasedValue(value, 'candidateTool', 'candidate_tool');
  const rawUnknownReason = aliasedValue(value, 'unknownReason', 'unknown_reason');
  if (!operation(rawOperation) || !needLevel(rawNeedLevel))
    throw new PredictionResponseError('prediction_parse_error');
  let requiredFields: string[];
  try {
    requiredFields = strictStrings(rawRequiredFields, 'prediction_required_fields_invalid');
  } catch {
    throw new PredictionResponseError('prediction_parse_error');
  }
  if (
    requiredFields.length > HUMAN_RESPONSE_PREDICTION_LIMITS.requiredFieldCountMax ||
    requiredFields.some(
      (field) =>
        field.trim() === '' ||
        field.length > HUMAN_RESPONSE_PREDICTION_LIMITS.requiredFieldMaxLength,
    )
  )
    throw new PredictionResponseError('prediction_parse_error');
  const candidateTool = boundedString(
    rawCandidateTool,
    HUMAN_RESPONSE_PREDICTION_LIMITS.candidateToolMaxLength,
  );
  const unknownReason = boundedString(
    rawUnknownReason,
    HUMAN_RESPONSE_PREDICTION_LIMITS.unknownReasonMaxLength,
  );
  if (candidateTool === null && rawCandidateTool !== null)
    throw new PredictionResponseError('prediction_parse_error');
  if (unknownReason === null && rawUnknownReason !== null)
    throw new PredictionResponseError('prediction_parse_error');
  if (
    (rawOperation === 'unknown' || rawNeedLevel === 'unknown') &&
    (!unknownReason || unknownReason.trim() === '')
  )
    throw new PredictionResponseError('prediction_parse_error');
  return {
    operation: rawOperation,
    needLevel: rawNeedLevel,
    requiredFields,
    candidateTool,
    unknownReason,
    need_level: rawNeedLevel,
    required_fields: [...requiredFields],
    candidate_tool: candidateTool,
    unknown_reason: unknownReason,
  };
}

function normalizePrediction(value: unknown): NormalizedPrediction {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new PredictionResponseError('prediction_parse_error');
    }
  }
  if (!isRecord(parsed)) throw new PredictionResponseError('prediction_parse_error');
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
      'contextIncomplete',
    ]),
  );
  const opaqueId = boundedString(
    parsed.opaqueId,
    HUMAN_RESPONSE_PREDICTION_LIMITS.opaqueIdMaxLength,
  );
  if (!opaqueId || opaqueId.trim() === '')
    throw new PredictionResponseError('prediction_parse_error');
  if (!hasOwn(parsed, 'operations') || !Array.isArray(parsed.operations))
    throw new PredictionResponseError('prediction_parse_error');
  if (
    parsed.operations.length === 0 ||
    parsed.operations.length > HUMAN_RESPONSE_PREDICTION_LIMITS.operationCountMax
  )
    throw new PredictionResponseError('prediction_parse_error');
  const operations = parsed.operations.map(normalizePredictionOperation);
  if (new Set(operations.map((item) => item.operation)).size !== operations.length)
    throw new PredictionResponseError('prediction_parse_error');
  const primaryOperation = aliasedValue(parsed, 'primaryOperation', 'primary_operation');
  if (!operation(primaryOperation)) throw new PredictionResponseError('prediction_parse_error');
  const expectedPrimary = choosePrimaryOperation(operations.map((item) => item.operation));
  if (primaryOperation !== expectedPrimary)
    throw new PredictionResponseError('prediction_parse_error');
  const primary = operations.find((item) => item.operation === expectedPrimary)!;
  const topNeed = aliasedValue(parsed, 'needLevel', 'need_level');
  const topRequired = aliasedValue(parsed, 'requiredFields', 'required_fields');
  const topCandidate = aliasedValue(parsed, 'candidateTool', 'candidate_tool');
  const topUnknown = aliasedValue(parsed, 'unknownReason', 'unknown_reason');
  if (topNeed !== primary.needLevel || !needLevel(topNeed))
    throw new PredictionResponseError('prediction_parse_error');
  let normalizedTopRequired: string[];
  try {
    normalizedTopRequired = strictStrings(topRequired, 'prediction_required_fields_invalid');
  } catch {
    throw new PredictionResponseError('prediction_parse_error');
  }
  if (
    normalizedTopRequired.length > HUMAN_RESPONSE_PREDICTION_LIMITS.requiredFieldCountMax ||
    JSON.stringify(normalizedTopRequired) !== JSON.stringify(primary.requiredFields)
  )
    throw new PredictionResponseError('prediction_parse_error');
  if (topCandidate !== primary.candidateTool || topUnknown !== primary.unknownReason)
    throw new PredictionResponseError('prediction_parse_error');
  const contextIncomplete = parsed.contextIncomplete;
  if (contextIncomplete !== undefined && typeof contextIncomplete !== 'boolean')
    throw new PredictionResponseError('prediction_parse_error');
  return {
    opaqueId,
    operations,
    primaryOperation: expectedPrimary,
    needLevel: primary.needLevel,
    requiredFields: [...primary.requiredFields],
    candidateTool: primary.candidateTool,
    unknownReason: primary.unknownReason,
    ...(contextIncomplete === true ? { contextIncomplete: true } : {}),
  };
}

function statusError(status: TargetStatus): HumanResponsePredictionErrorCode {
  if (status === 'ambiguous') return 'target_status_ambiguous';
  if (status === 'no_eligible_inbound') return 'target_status_no_eligible_inbound';
  return 'target_status_outbound_only';
}

function targetHashRecord(
  message: CorpusMessage,
): Pick<
  HumanResponseTargetManifestRecord,
  'targetBodyHash' | 'targetHeaderHash' | 'targetAttachmentHash'
> {
  return {
    targetBodyHash: bodyHash(message),
    targetHeaderHash: headerHash(message),
    targetAttachmentHash: attachmentHash(message),
  };
}

function createUnavailableLunaTransport(): HumanResponseWorkerTransport {
  return {
    async predict(): Promise<never> {
      throw new Error('luna_worker_transport_unavailable');
    },
  };
}

export function createUnavailableHumanResponseWorkerTransport(): HumanResponseWorkerTransport {
  return createUnavailableLunaTransport();
}

export const createUnavailableLunaWorkerTransport = createUnavailableHumanResponseWorkerTransport;

async function ensurePrivateOutputDirectory(
  outputDir: string,
  snapshotId: string,
): Promise<string> {
  const absoluteOutput = path.resolve(outputDir);
  const corpusRoot = path.dirname(absoluteOutput);
  const privateRoot = path.dirname(corpusRoot);
  if (
    path.basename(privateRoot) !== '.private' ||
    path.basename(corpusRoot) !== 'centurion-corpus' ||
    path.basename(absoluteOutput) !== snapshotId ||
    !/^[A-Za-z0-9._-]+$/.test(snapshotId)
  )
    return fail('output_private_root_invalid');
  const expectedRepoEntry = await lstat(ANALYSIS_REPO_ROOT).catch(() => null);
  if (!expectedRepoEntry || expectedRepoEntry.isSymbolicLink() || !expectedRepoEntry.isDirectory())
    return fail('private_parent_invalid');
  const canonicalRepo = await realpath(ANALYSIS_REPO_ROOT);
  if (path.resolve(path.dirname(privateRoot)) !== ANALYSIS_REPO_ROOT)
    return fail('output_private_root_invalid');
  const expectedPrivate = path.join(canonicalRepo, '.private');
  if (path.resolve(privateRoot) !== path.resolve(path.join(ANALYSIS_REPO_ROOT, '.private')))
    return fail('output_private_root_invalid');
  const privateEntry = await lstat(privateRoot).catch(() => null);
  if (!privateEntry || privateEntry.isSymbolicLink() || !privateEntry.isDirectory())
    return fail('private_root_symlink');
  async function ensure(directory: string, code: string): Promise<string> {
    const current = await lstat(directory).catch(() => null);
    if (!current) await mkdir(directory, { mode: 0o700 });
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return fail(code);
    await chmod(directory, 0o700);
    return realpath(directory);
  }
  const canonicalPrivate = await ensure(privateRoot, 'private_root_symlink');
  if (canonicalPrivate !== expectedPrivate) return fail('private_root_symlink');
  const privateIgnore = await readFile(path.join(canonicalPrivate, '.gitignore'), 'utf8').catch(
    () => '',
  );
  if (!privateIgnore.split(/\r?\n/).some((line) => line.trim() === '*'))
    return fail('private_root_not_ignored');
  const canonicalCorpus = await ensure(corpusRoot, 'private_parent_symlink');
  if (canonicalCorpus !== path.join(canonicalPrivate, 'centurion-corpus'))
    return fail('private_parent_symlink');
  const canonicalOutput = await ensure(absoluteOutput, 'output_directory_invalid');
  if (canonicalOutput !== path.join(canonicalCorpus, snapshotId))
    return fail('output_parent_invalid');
  return canonicalOutput;
}

async function writeImmutableJsonl(filePath: string, records: readonly unknown[]): Promise<void> {
  const contents =
    records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(filePath, 0o600);
}

function basePredictionRecord(
  target: HumanResponseTargetManifestRecord,
  modelId: string,
  modelVersion: string,
  predictorInput: HumanResponsePredictorInput | null = null,
): HumanResponsePredictionFreezeRecord {
  const error = target.predictionError;
  return {
    schemaVersion: PREDICTION_FREEZE_SCHEMA_VERSION,
    targetKey: target.targetKey,
    targetStatus: target.targetStatus,
    status: target.targetStatus,
    frozenAt: new Date().toISOString(),
    modelId,
    modelVersion,
    promptVersion: HUMAN_RESPONSE_PROMPT_VERSION,
    promptHash: HUMAN_RESPONSE_PROMPT_HASH,
    schemaHash: HUMAN_RESPONSE_SCHEMA_HASH,
    inputHash: target.preTargetInputHash,
    targetBodyHash: target.targetBodyHash,
    targetHeaderHash: target.targetHeaderHash,
    targetAttachmentHash: target.targetAttachmentHash,
    preTargetBodyHashes: [...target.preTargetBodyHashes],
    predictorInput,
    predictionStatus: error
      ? error === 'context_incomplete'
        ? 'context_incomplete'
        : 'not_attempted'
      : target.contextIncomplete
        ? 'context_incomplete'
        : 'prediction_error',
    predictionError: error ?? (target.contextIncomplete ? 'context_incomplete' : null),
    opaqueWorkerId: null,
    attempts: 0,
    retries: 0,
    operations: [],
    primaryOperation: null,
    primary_operation: null,
    needLevel: null,
    need_level: null,
    requiredFields: [],
    required_fields: [],
    candidateTool: null,
    candidate_tool: null,
    unknownReason: null,
    unknown_reason: null,
    pendingAtCutoff: target.pendingAtCutoff,
    lateResponse: target.lateResponse,
    contextIncomplete: target.contextIncomplete,
    pending_at_cutoff: target.pendingAtCutoff,
    late_response: target.lateResponse,
    context_incomplete: target.contextIncomplete,
  };
}

function isHumanOutbound(message: CorpusMessage): boolean {
  return (
    message.eventAt !== null &&
    matchingDirection(message) === 'outbound' &&
    message.classification?.status === 'classified' &&
    message.classification.businessDirection === 'outbound' &&
    message.classification.origin === 'human'
  );
}

function directionIsInbound(message: CorpusMessage): boolean {
  return matchingDirection(message) === 'inbound' || matchingDirection(message) === 'ambiguous';
}

function targetManifestRecord(
  target: CorpusMessage,
  match: TargetMatch,
  input: HumanResponsePredictorInput | null,
  leakage: string | null,
  cutoffAt: number,
): HumanResponseTargetManifestRecord {
  const hashes = targetHashRecord(target);
  const pendingAtCutoff = Date.parse(target.eventAt!) > cutoffAt;
  const lateResponse = pendingAtCutoff;
  const contextIncompleteReasons = [
    ...match.contextIncompleteReasons,
    ...(input?.contextIncompleteReasons ?? []),
    ...(leakage ? ['target_or_post_target_payload_detected'] : []),
  ];
  const contextIncomplete = Boolean(match.contextIncomplete || input?.contextIncomplete || leakage);
  const predictionError = leakage
    ? 'target_payload_leakage'
    : contextIncomplete
      ? 'context_incomplete'
      : match.status === 'paired'
        ? null
        : statusError(match.status);
  return {
    schemaVersion: TARGET_MANIFEST_SCHEMA_VERSION,
    targetKey: target.recordKey,
    source: target.source,
    sourceRecordId: target.sourceRecordId,
    eventAt: target.eventAt!,
    messageId: target.messageId,
    targetStatus: match.status,
    status: match.status,
    candidateInboundRecordIds: match.candidates.map((candidate) => candidate.recordKey).sort(),
    eligibleInboundRecordIds: match.eligible.map((candidate) => candidate.recordKey).sort(),
    triggeringInboundRecordId: match.triggeringInbound?.recordKey ?? null,
    matchMethod: match.method,
    ...hashes,
    preTargetInputHash: input ? objectHash(input) : null,
    preTargetBodyHashes: input
      ? [input.triggeringInbound, ...input.earlierContext].map((message) => message.bodyHash)
      : [],
    pendingAtCutoff,
    lateResponse,
    contextIncomplete,
    contextIncompleteReasons: [...new Set(contextIncompleteReasons)].sort(),
    predictionError,
    pending_at_cutoff: pendingAtCutoff,
    late_response: lateResponse,
    context_incomplete: contextIncomplete,
  };
}

async function predictTarget(
  target: HumanResponseTargetManifestRecord,
  input: HumanResponsePredictorInput | null,
  transport: HumanResponseWorkerTransport,
  metadata: { modelId: string; modelVersion: string },
  maxRetries: number,
): Promise<HumanResponsePredictionFreezeRecord> {
  const base = basePredictionRecord(target, metadata.modelId, metadata.modelVersion, input);
  if (target.targetStatus !== 'paired' || !input || target.predictionError) return base;
  const frozenInput = deepFreeze(deepClone(input));
  const inputHash = objectHash(frozenInput);
  if (target.preTargetInputHash !== inputHash) {
    return {
      ...base,
      frozenAt: new Date().toISOString(),
      inputHash,
      predictorInput: frozenInput,
      predictionStatus: 'prediction_error',
      predictionError: 'worker_error',
    };
  }
  let attempts = 0;
  let lastError: HumanResponsePredictionErrorCode = 'worker_error';
  let lastWorkerId: string | null = null;
  while (attempts <= maxRetries) {
    attempts += 1;
    const workerId = `luna-worker-${randomUUID()}`;
    lastWorkerId = workerId;
    const request: HumanResponseWorkerRequest = {
      workerId,
      modelId: metadata.modelId,
      modelVersion: metadata.modelVersion,
      promptVersion: HUMAN_RESPONSE_PROMPT_VERSION,
      promptHash: HUMAN_RESPONSE_PROMPT_HASH,
      schemaVersion: PREDICTION_FREEZE_SCHEMA_VERSION,
      schemaHash: HUMAN_RESPONSE_SCHEMA_HASH,
      inputHash,
      // The transport receives a separate mutable boundary. The frozen copy
      // below is the only input retained for the manifest/hash record.
      input: deepClone(frozenInput),
    };
    try {
      const response = normalizePrediction(await transport.predict(request));
      return {
        ...base,
        frozenAt: new Date().toISOString(),
        inputHash,
        predictorInput: frozenInput,
        predictionStatus:
          response.contextIncomplete || frozenInput.contextIncomplete
            ? 'context_incomplete'
            : 'frozen',
        predictionError:
          response.contextIncomplete || frozenInput.contextIncomplete ? 'context_incomplete' : null,
        opaqueWorkerId: response.opaqueId,
        attempts,
        retries: attempts - 1,
        operations: response.operations,
        primaryOperation: response.primaryOperation,
        primary_operation: response.primaryOperation,
        needLevel: response.needLevel,
        need_level: response.needLevel,
        requiredFields: response.requiredFields,
        required_fields: response.requiredFields,
        candidateTool: response.candidateTool,
        candidate_tool: response.candidateTool,
        unknownReason: response.unknownReason,
        unknown_reason: response.unknownReason,
        contextIncomplete: response.contextIncomplete === true || frozenInput.contextIncomplete,
        context_incomplete: response.contextIncomplete === true || frozenInput.contextIncomplete,
      };
    } catch (error) {
      if (error instanceof PredictionResponseError) lastError = error.code;
      else if (error instanceof Error && error.message === 'luna_worker_transport_unavailable') {
        lastError = 'luna_worker_transport_unavailable';
        break;
      } else lastError = 'worker_error';
      if (lastError === 'prediction_parse_error' && attempts <= maxRetries) continue;
      if (lastError === 'worker_error' && attempts <= maxRetries) continue;
      break;
    }
  }
  return {
    ...base,
    frozenAt: new Date().toISOString(),
    inputHash,
    predictorInput: frozenInput,
    predictionStatus:
      lastError === 'context_incomplete' ? 'context_incomplete' : 'prediction_error',
    predictionError: lastError,
    opaqueWorkerId: lastWorkerId,
    attempts,
    retries: Math.max(0, attempts - 1),
    contextIncomplete: frozenInput.contextIncomplete,
    context_incomplete: frozenInput.contextIncomplete,
  };
}

function responseCutoff(value: string | undefined, fallback: string): number {
  const parsed = value ?? fallback;
  const timestamp = Date.parse(parsed);
  if (Number.isNaN(timestamp)) return fail('cutoff_at_invalid');
  return timestamp;
}

function outputSnapshotId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value.length === 0) return fail('snapshot_id_invalid');
  return value;
}

export async function analyseCenturionHumanResponses(
  options: AnalyseCenturionHumanResponsesOptions,
): Promise<HumanResponseAnalysisRun> {
  const snapshotId = outputSnapshotId(options.snapshotId);
  const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const causalWindowDays = options.causalWindowDays ?? DEFAULT_CAUSAL_WINDOW_DAYS;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > DEFAULT_MAX_WORKERS)
    return fail('maxWorkers must be an integer from 1 through 5');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10)
    return fail('maxRetries must be a non-negative integer no greater than 10');
  if (!Number.isSafeInteger(causalWindowDays) || causalWindowDays < 1 || causalWindowDays > 365)
    return fail('causalWindowDays must be an integer from 1 through 365');
  const normal = await readSealedSnapshot(options.normalSnapshotDir, 'normal');
  const quarantine = await readSealedSnapshot(options.quarantineSnapshotDir, 'quarantine');
  const classificationPath =
    options.classificationPath ??
    options.classificationOutputDir ??
    options.classificationRecordsPath;
  if (!classificationPath) return fail('classification_path_missing');
  const classifications = await readClassificationRecords(classificationPath);
  const classificationMap = chooseClassificationMap(
    [...normal.records, ...quarantine.records],
    classifications,
  );
  const messages = [
    ...normal.records.map((record) =>
      normalizeCorpusMessage(
        record,
        'normal',
        classificationMap.get(`normal:${String(record.id)}`) ?? null,
      ),
    ),
    ...quarantine.records.map((record) =>
      normalizeCorpusMessage(
        record,
        'quarantine',
        classificationMap.get(`quarantine:${String(record.id)}`) ?? null,
      ),
    ),
  ];
  const allInbound = messages.filter(directionIsInbound);
  const humanTargets = messages.filter(isHumanOutbound).sort(compareMessages);
  const cutoff = responseCutoff(options.cutoffAt, CENTURION_WINDOW_END_UTC);
  const causalWindowMs = causalWindowDays * 24 * 60 * 60 * 1000;
  const skeletonTargets: HumanResponseTargetManifestRecord[] = [];
  const inputs = new Map<string, HumanResponsePredictorInput | null>();
  const leakageByTarget = new Map<string, string | null>();
  let excludedAtCutoffOutboundCount = 0;
  for (const target of humanTargets) {
    const targetAt = target.eventAt ? Date.parse(target.eventAt) : NaN;
    if (!Number.isFinite(targetAt) || targetAt < Date.parse(CENTURION_WINDOW_START_UTC)) {
      continue;
    }
    if (targetAt >= Date.parse(CENTURION_WINDOW_END_UTC)) {
      excludedAtCutoffOutboundCount += 1;
      continue;
    }
    const match = matchTarget(target, allInbound, causalWindowMs);
    let input: HumanResponsePredictorInput | null = null;
    let leakage: string | null = null;
    if (match.status === 'paired' && match.triggeringInbound && !match.contextIncomplete) {
      const built = buildPredictorInput(target, match.triggeringInbound, messages, causalWindowMs);
      input = built.input;
      leakage = built.leakage;
    }
    const manifest = targetManifestRecord(target, match, input, leakage, cutoff);
    skeletonTargets.push(manifest);
    inputs.set(manifest.targetKey, input);
    leakageByTarget.set(manifest.targetKey, leakage);
  }
  const outputDir = await ensurePrivateOutputDirectory(options.outputDir, snapshotId);
  // This file is written before any transport invocation: it is the hash freeze boundary.
  await writeImmutableJsonl(path.join(outputDir, 'target-manifest.jsonl'), skeletonTargets);
  const transport = options.workerTransport ?? createUnavailableLunaTransport();
  const modelId = options.modelId ?? DEFAULT_LUNA_MODEL_ID;
  const modelVersion = options.modelVersion ?? modelId;
  const predictions: HumanResponsePredictionFreezeRecord[] = [];
  for (let offset = 0; offset < skeletonTargets.length; offset += maxWorkers) {
    const batch = skeletonTargets.slice(offset, offset + maxWorkers);
    const batchResults = await Promise.all(
      batch.map((target) =>
        predictTarget(
          target,
          inputs.get(target.targetKey) ?? null,
          transport,
          { modelId, modelVersion },
          maxRetries,
        ),
      ),
    );
    predictions.push(...batchResults);
  }
  await writeImmutableJsonl(path.join(outputDir, 'prediction-freeze.jsonl'), predictions);
  const targetStatusCounts: Record<TargetStatus, number> = {
    paired: 0,
    ambiguous: 0,
    no_eligible_inbound: 0,
    outbound_only: 0,
  };
  for (const target of skeletonTargets) targetStatusCounts[target.targetStatus] += 1;
  const responsesByInbound = new Map<string, CorpusMessage[]>();
  for (const target of skeletonTargets) {
    if (!target.triggeringInboundRecordId) continue;
    const response = messages.find((message) => message.recordKey === target.targetKey);
    if (!response) continue;
    const existing = responsesByInbound.get(target.triggeringInboundRecordId) ?? [];
    existing.push(response);
    responsesByInbound.set(target.triggeringInboundRecordId, existing);
  }
  const unansweredInbound = allInbound
    .filter((inbound) => inbound.eventAt && Date.parse(inbound.eventAt) <= cutoff)
    .filter((inbound) => {
      const responses = responsesByInbound.get(inbound.recordKey) ?? [];
      return !responses.some(
        (response) => response.eventAt && Date.parse(response.eventAt) <= cutoff,
      );
    })
    .map((inbound) => inbound.recordKey)
    .sort();
  const pendingAtCutoffCount = skeletonTargets.filter((target) => target.pendingAtCutoff).length;
  const lateResponseCount = skeletonTargets.filter((target) => target.lateResponse).length;
  const contextIncompleteCount = skeletonTargets.filter(
    (target) => target.contextIncomplete,
  ).length;
  const predictionErrorCount = predictions.filter(
    (prediction) => prediction.predictionError !== null,
  ).length;
  const workerRuntimeBlockers = [
    ...new Set(
      predictions
        .map((prediction) => prediction.predictionError)
        .filter(
          (error): error is HumanResponsePredictionErrorCode =>
            error === 'luna_worker_transport_unavailable',
        ),
    ),
  ];
  const audit: HumanResponseAnalysisAudit = {
    schemaVersion: HUMAN_RESPONSE_ANALYSIS_SCHEMA_VERSION,
    snapshotId,
    normalSourceRows: normal.records.length,
    quarantineSourceRows: quarantine.records.length,
    inWindowHumanOutboundCount: humanTargets.filter(
      (target) => target.eventAt && isCoreInstant(target.eventAt),
    ).length,
    targetCount: skeletonTargets.length,
    targetStatusCounts,
    pairedCount: targetStatusCounts.paired,
    ambiguousCount: targetStatusCounts.ambiguous,
    noEligibleInboundCount: targetStatusCounts.no_eligible_inbound,
    outboundOnlyCount: targetStatusCounts.outbound_only,
    pendingAtCutoffCount,
    lateResponseCount,
    contextIncompleteCount,
    predictionErrorCount,
    unansweredInboundCount: unansweredInbound.length,
    unansweredInboundRecordIds: unansweredInbound,
    excludedAtCutoffOutboundCount,
    workerRuntimeBlockers,
    causalWindowDays,
    leakageViolations: [...leakageByTarget.entries()]
      .filter(([, leakage]) => leakage !== null)
      .map(([targetKey, leakage]) => `${targetKey}:${leakage}`),
  };
  return { snapshotId, outputDir, targets: skeletonTargets, predictions, audit };
}

export const analyzeCenturionHumanResponses = analyseCenturionHumanResponses;

function parseCliArgs(argv: readonly string[]): {
  normalSnapshotDir: string;
  quarantineSnapshotDir: string;
  classificationPath: string;
  outputDir: string;
  snapshotId: string;
  maxWorkers?: number;
  maxRetries?: number;
  causalWindowDays?: number;
  cutoffAt?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) return fail('invalid_arguments');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) return fail('invalid_arguments');
    values.set(arg.slice(2), value);
    index += 1;
  }
  const normalSnapshotDir = values.get('normal');
  const quarantineSnapshotDir = values.get('quarantine');
  const classificationPath = values.get('classification') ?? values.get('classifications');
  const outputDir = values.get('out');
  const snapshotId = values.get('snapshot');
  if (
    !normalSnapshotDir ||
    !quarantineSnapshotDir ||
    !classificationPath ||
    !outputDir ||
    !snapshotId
  )
    return fail('invalid_arguments');
  return {
    normalSnapshotDir,
    quarantineSnapshotDir,
    classificationPath,
    outputDir,
    snapshotId,
    ...(values.has('max-workers') ? { maxWorkers: Number(values.get('max-workers')) } : {}),
    ...(values.has('max-retries') ? { maxRetries: Number(values.get('max-retries')) } : {}),
    ...(values.has('causal-window-days')
      ? { causalWindowDays: Number(values.get('causal-window-days')) }
      : {}),
    ...(values.has('cutoff-at') ? { cutoffAt: values.get('cutoff-at') } : {}),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return (
    typeof entry === 'string' &&
    path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  );
}

export type HumanResponseAnalysisCliDependencies = {
  workerTransport?: HumanResponseWorkerTransport;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
};

export async function runCenturionHumanResponseAnalysisCli(
  argv: readonly string[],
  dependencies: HumanResponseAnalysisCliDependencies = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));
  try {
    const args = parseCliArgs(argv);
    const run = await analyseCenturionHumanResponses({
      ...args,
      ...(dependencies.workerTransport ? { workerTransport: dependencies.workerTransport } : {}),
    });
    const blocked =
      run.audit.workerRuntimeBlockers.length > 0 || run.audit.predictionErrorCount > 0;
    writeStdout(
      `${JSON.stringify({
        event: blocked
          ? 'centurion_human_response_analysis.blocked'
          : 'centurion_human_response_analysis.complete',
        status: blocked ? 'blocked' : 'complete',
        snapshotId: run.snapshotId,
        targetCount: run.audit.targetCount,
        pairedCount: run.audit.pairedCount,
        predictionErrorCount: run.audit.predictionErrorCount,
        workerRuntimeBlockers: run.audit.workerRuntimeBlockers,
      })}\n`,
    );
    return blocked ? 2 : 0;
  } catch {
    writeStderr(
      `${JSON.stringify({ event: 'centurion_human_response_analysis.failed', code: 'analysis_failed' })}\n`,
    );
    return 1;
  }
}

if (isMainModule())
  process.exitCode = await runCenturionHumanResponseAnalysisCli(process.argv.slice(2));
