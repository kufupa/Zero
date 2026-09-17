/**
 * Exhaustive, private Centurion message classification and daily reporting.
 *
 * This module deliberately has no database, object-storage, mail, or PMS
 * dependency. It reads the sealed U1/U2 JSONL snapshots from local paths and
 * exposes an injectable worker transport. The default transport is a fail-closed
 * boundary: until an approved Luna-Max runtime is supplied, records are emitted
 * as explicit worker errors rather than receiving invented labels.
 */
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const CLASSIFICATION_SCHEMA_VERSION = 'centurion-classification-v1' as const;
export const DAILY_TABLES_SCHEMA_VERSION = 'centurion-daily-tables-v1' as const;
export const COVERAGE_AUDIT_SCHEMA_VERSION = 'centurion-coverage-audit-v1' as const;
export const DEFAULT_LUNA_MODEL_ID = 'gpt-5.6-luna-max' as const;
export const DEFAULT_MAX_WORKERS = 5 as const;
export const DEFAULT_MAX_RETRIES = 2 as const;

const CENTURION_TRANSPORT_ID = 'transport-centurion' as const;
const CENTURION_WINDOW_TIMEZONE = 'Africa/Johannesburg' as const;
const CENTURION_WINDOW_START = '2026-09-07T22:00:00.000Z' as const;
const CENTURION_WINDOW_END = '2026-09-16T22:00:00.000Z' as const;
const CENTURION_SPILLOVER_END = '2026-09-17T22:00:00.000Z' as const;

export const WORKFLOW_CLASSES = [
  'booking_quote',
  'servicing',
  'reconciliation',
  'money_proof_of_payment',
  'delivery_documents',
  'recovery',
  'guest_experience',
  'partner_channel',
  'automated_channel',
  'unknown_review',
  'other',
] as const;

export type WorkflowClass = (typeof WORKFLOW_CLASSES)[number];
export type BusinessDirection = 'inbound' | 'outbound' | 'ambiguous';
export type MessageOrigin = 'human' | 'automated' | 'unknown';
export type ClassificationPartition = 'core' | 'spillover';
export type ClassificationStatus =
  | 'classified'
  | 'worker_error'
  | 'parse_error'
  | 'context_incomplete'
  | 'spillover_excluded';

export type EvidenceLocation = {
  field: 'subject' | 'body' | 'html' | 'header' | 'participant' | 'attachment';
  start: number;
  end: number;
};

export type WorkerUncertainty = {
  level: 'low' | 'medium' | 'high';
  reasons: string[];
  contextIncomplete?: boolean;
};

export type WorkerProvenance = {
  source: string;
  direction: string;
  origin: string;
  workflow: string;
};

export type CenturionClassificationWorkerMessage = {
  /** The worker receives the unmodified message body through this local seam. */
  source: 'normal' | 'quarantine';
  sourceRecordId: string;
  recordPath: string;
  recordIndex: number;
  messageId: string | null;
  subject: string;
  textBody: string;
  htmlBody: string;
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  eventAt: string | null;
  messageDate: string | null;
  attachmentCount: number;
  sourceDisposition: string | null;
};

export type CenturionClassificationWorkerRequest = {
  workerId: string;
  modelId: string;
  modelVersion: string;
  promptVersion: string;
  promptHash: string;
  schemaVersion: typeof CLASSIFICATION_SCHEMA_VERSION;
  schemaHash: string;
  inputHash: string;
  message: CenturionClassificationWorkerMessage;
};

/**
 * The primary class is checked against the complete label set and fixed
 * priority before it is persisted.
 */
export type CenturionClassificationWorkerResponse = {
  opaqueId: string;
  businessDirection: BusinessDirection;
  origin: MessageOrigin;
  labels: WorkflowClass[];
  primaryWorkflow: WorkflowClass;
  secondaryLabels?: WorkflowClass[];
  secondaryWorkflows?: WorkflowClass[];
  evidenceLocations: EvidenceLocation[];
  provenance: WorkerProvenance;
  uncertainty: WorkerUncertainty;
};

export type CenturionClassificationWorkerTransport = {
  classify(request: CenturionClassificationWorkerRequest): Promise<unknown>;
};

export type ClassificationRecord = {
  schemaVersion: typeof CLASSIFICATION_SCHEMA_VERSION;
  recordKey: string;
  sourceRecordId: string;
  source: 'normal' | 'quarantine';
  partition: ClassificationPartition;
  day: string | null;
  eventAt: string | null;
  messageDate: string | null;
  sourceDisposition: string | null;
  sourceDuplicateUidl: boolean | null;
  sourceDuplicateRawHash: boolean | null;
  status: ClassificationStatus;
  errorCode: string | null;
  opaqueWorkerId: string | null;
  businessDirection: BusinessDirection | null;
  origin: MessageOrigin | null;
  primaryWorkflow: WorkflowClass | null;
  secondaryWorkflows: WorkflowClass[];
  evidenceLocations: EvidenceLocation[];
  provenance: WorkerProvenance | null;
  uncertainty: WorkerUncertainty | null;
  modelId: string;
  modelVersion: string;
  promptVersion: string;
  promptHash: string;
  schemaHash: string;
  inputHash: string;
  attempts: number;
  retries: number;
};

export type DailyBucket = {
  total: number;
  classified: number;
  workerErrors: number;
  parseErrors: number;
  contextIncomplete: number;
  inbound: number;
  outbound: number;
  ambiguous: number;
  origins: Record<MessageOrigin, number>;
  primaryWorkflows: Record<WorkflowClass, number>;
};

export type DailyTables = {
  schemaVersion: typeof DAILY_TABLES_SCHEMA_VERSION;
  snapshotId: string;
  metadata: {
    modelId: string;
    modelVersion: string;
    promptVersion: string;
    promptHash: string;
    schemaHash: string;
    normalManifestHash: string;
    quarantineManifestHash: string;
  };
  sourceCounts: {
    normalSourceRows: number;
    quarantineSourceRows: number;
    coreIncluded: number;
    spilloverExcluded: number;
    otherExcluded: number;
  };
  coreTotals: DailyBucket;
  days: Record<string, DailyBucket>;
  spillover: DailyBucket;
  quarantineDispositionCounts: Record<string, number>;
  statusCounts: Record<ClassificationStatus, number>;
};

export type CoverageAudit = {
  schemaVersion: typeof COVERAGE_AUDIT_SCHEMA_VERSION;
  snapshotId: string;
  sourceManifests: {
    normal: {
      schemaVersion: string;
      snapshotId: string;
      orderedHash: string;
      manifestHash: string;
      counts: Record<string, number>;
    };
    quarantine: {
      schemaVersion: string;
      snapshotId: string;
      orderedHash: string;
      manifestHash: string;
      counts: Record<string, number>;
    };
  };
  sourceRows: {
    normal: number;
    quarantine: number;
    total: number;
  };
  normal: {
    dailyIncluded: number;
    contextOnly: number;
    missingEventAt: number;
    excluded: number;
  };
  quarantine: {
    core: number;
    spillover: number;
    otherPartitions: number;
    parseStatuses: Record<string, number>;
    dispositions: Record<string, number>;
  };
  core: {
    sourceCandidateCount: number;
    classificationRecordCount: number;
    missingClassificationIdCount: number;
    unexpectedClassificationIdCount: number;
    duplicateSourceCandidateIdCount: number;
    includedUniqueIdCount: number;
    classifiedCount: number;
    unresolvedCount: number;
    dailyTotal: number;
    dailyReconciles: boolean;
    duplicateRecordKeyCount: number;
    includedIdsSha256: string;
    sourceCandidateIdsSha256: string;
    classificationIdsSha256: string;
  };
  spillover: {
    excludedCount: number;
    uniqueIdCount: number;
    idsSha256: string;
  };
  statusCounts: Record<ClassificationStatus, number>;
  worker: {
    modelId: string;
    modelVersion: string;
    promptVersion: string;
    promptHash: string;
    schemaHash: string;
    attempts: number;
    retries: number;
    workerErrorCount: number;
    parseErrorCount: number;
    contextIncompleteCount: number;
    runtimeBlockers: string[];
  };
};

export type CenturionClassificationRun = {
  snapshotId: string;
  outputDir: string;
  records: ClassificationRecord[];
  dailyTables: DailyTables;
  coverageAudit: CoverageAudit;
};

export type ClassifyCenturionNineDayCorpusOptions = {
  normalSnapshotDir: string;
  quarantineSnapshotDir: string;
  outputDir: string;
  snapshotId: string;
  workerTransport?: CenturionClassificationWorkerTransport;
  modelId?: string;
  modelVersion?: string;
  promptVersion?: string;
  maxWorkers?: number;
  maxRetries?: number;
};

const WINDOW_START_MS = Date.parse(CENTURION_WINDOW_START);
const WINDOW_END_MS = Date.parse(CENTURION_WINDOW_END);
const SPILLOVER_END_MS = Date.parse(CENTURION_SPILLOVER_END);
const CENTURION_TIME_ZONE = CENTURION_WINDOW_TIMEZONE;
export const DEFAULT_PROMPT_VERSION = 'centurion-message-classification-prompt-v1' as const;
const PROMPT_TEXT = [
  'Classify one complete recovered Centurion message.',
  'Return only opaque id, direction, origin, workflow labels, evidence locations, provenance and uncertainty.',
  'Use the canonical workflow vocabulary and never infer from current labels or unread state.',
].join('\n');
const SCHEMA_DEFINITION = JSON.stringify({
  version: CLASSIFICATION_SCHEMA_VERSION,
  direction: ['inbound', 'outbound', 'ambiguous'],
  origin: ['human', 'automated', 'unknown'],
  workflows: WORKFLOW_CLASSES,
  evidence: ['subject', 'body', 'html', 'header', 'participant', 'attachment'],
});

export const PROMPT_HASH = sha256(PROMPT_TEXT);
export const CLASSIFICATION_SCHEMA_HASH = sha256(SCHEMA_DEFINITION);

const PRIMARY_WORKFLOW_PRIORITY: readonly WorkflowClass[] = [
  'booking_quote',
  'servicing',
  'reconciliation',
  'money_proof_of_payment',
  'delivery_documents',
  'recovery',
  'guest_experience',
  'partner_channel',
  'automated_channel',
  'unknown_review',
  'other',
];

type SnapshotKind = 'normal' | 'quarantine';
type JsonRecord = Record<string, unknown>;

type LoadedSnapshot = {
  kind: SnapshotKind;
  directory: string;
  recordPath: string;
  records: JsonRecord[];
  schemaVersion: string;
  snapshotId: string;
  counts: Record<string, number>;
  orderedHash: string;
  manifestHash: string;
};

type CandidateMessage = {
  source: SnapshotKind;
  sourceRecordId: string;
  recordPath: string;
  recordIndex: number;
  messageId: string | null;
  subject: string;
  textBody: string;
  htmlBody: string;
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  eventAt: string | null;
  messageDate: string | null;
  attachmentCount: number;
  sourceDisposition: string | null;
  sourceDuplicateUidl: boolean | null;
  sourceDuplicateRawHash: boolean | null;
  partition: ClassificationPartition | null;
  day: string | null;
  eligible: boolean;
  initialStatus: ClassificationStatus | null;
  initialErrorCode: string | null;
  inputHash: string;
};

type WorkerNormalizedResponse = CenturionClassificationWorkerResponse;

class WorkerResponseValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'WorkerResponseValidationError';
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Ids(ids: readonly string[]): string {
  return sha256([...ids].sort().join('\n'));
}

function fail(code: string): never {
  throw new Error(code);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredText(value: unknown, code: string): string {
  const result = text(value);
  if (!result) return fail(code);
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function validIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredRecordText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fail(code);
  return value;
}

function nullableRecordText(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return fail(code);
  return value;
}

function recordStringArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return fail(code);
  }
  return value as string[];
}

function recordBoolean(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') return fail(code);
  return value;
}

function recordNullableIso(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return fail(code);
  return value;
}

function recordNonNegativeInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(code);
  return value;
}

function recordEnum<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return fail(code);
  return value as T;
}

function validateNormalRecord(record: JsonRecord): void {
  requiredRecordText(record.id, 'normal_record_id_missing');
  if (record.transportId !== CENTURION_TRANSPORT_ID)
    return fail('normal_record_transport_mismatch');
  nullableRecordText(record.threadId, 'normal_record_thread_id_invalid');
  nullableRecordText(record.messageId, 'normal_record_message_id_invalid');
  requiredRecordText(record.direction, 'normal_record_direction_invalid');
  requiredRecordText(record.messageDirection, 'normal_record_message_direction_invalid');
  if (record.direction !== record.messageDirection) return fail('normal_record_direction_mismatch');
  recordEnum(
    record.businessDirection,
    ['inbound', 'outbound', 'unknown'],
    'normal_record_business_direction_invalid',
  );
  recordEnum(
    record.businessDirectionSource,
    ['transport_identity', 'message_direction', 'unknown'],
    'normal_record_business_direction_source_invalid',
  );
  if (typeof record.subject !== 'string') return fail('normal_record_subject_invalid');
  if (typeof record.textBody !== 'string') return fail('normal_record_text_body_invalid');
  if (typeof record.htmlBody !== 'string') return fail('normal_record_html_body_invalid');
  recordStringArray(record.from, 'normal_record_from_invalid');
  recordStringArray(record.to, 'normal_record_to_invalid');
  recordStringArray(record.cc, 'normal_record_cc_invalid');
  recordStringArray(record.bcc, 'normal_record_bcc_invalid');
  recordNullableIso(record.receivedAt, 'normal_record_received_at_invalid');
  recordNullableIso(record.sentAt, 'normal_record_sent_at_invalid');
  recordNullableIso(record.createdAt, 'normal_record_created_at_invalid');
  const eventAt = recordNullableIso(record.eventAt, 'normal_record_event_at_invalid');
  recordEnum(
    record.eventAtSource,
    ['sent_at_confirmed_outbound', 'received_at', 'sent_at_fallback', 'created_at', 'missing'],
    'normal_record_event_at_source_invalid',
  );
  recordBoolean(record.eventAtFallback, 'normal_record_event_at_fallback_invalid');
  nullableRecordText(record.inReplyTo, 'normal_record_in_reply_to_invalid');
  recordStringArray(record.references, 'normal_record_references_invalid');
  nullableRecordText(record.rawMimeLocator, 'normal_record_raw_mime_locator_invalid');
  if (!Array.isArray(record.attachmentDescriptors))
    return fail('normal_record_attachments_invalid');
  for (const descriptor of record.attachmentDescriptors) {
    if (!isJsonRecord(descriptor)) return fail('normal_record_attachment_invalid');
    requiredRecordText(descriptor.id, 'normal_record_attachment_id_invalid');
    requiredRecordText(descriptor.messageId, 'normal_record_attachment_message_id_invalid');
    requiredRecordText(descriptor.filename, 'normal_record_attachment_filename_invalid');
    requiredRecordText(descriptor.contentType, 'normal_record_attachment_content_type_invalid');
    requiredRecordText(descriptor.s3Key, 'normal_record_attachment_s3_key_invalid');
    recordNonNegativeInteger(descriptor.byteSize, 'normal_record_attachment_byte_size_invalid');
    if (descriptor.inline !== undefined)
      recordBoolean(descriptor.inline, 'normal_record_attachment_inline_invalid');
    if (descriptor.contentId !== undefined)
      nullableRecordText(descriptor.contentId, 'normal_record_attachment_content_id_invalid');
  }
  recordBoolean(record.confirmedOutbound, 'normal_record_confirmed_outbound_invalid');
  nullableRecordText(record.queueState, 'normal_record_queue_state_invalid');
  const scope = recordEnum(
    record.scope,
    ['in_window', 'context_only', 'missing_event_at'],
    'normal_record_scope_invalid',
  );
  const contextOnly = recordBoolean(record.contextOnly, 'normal_record_context_only_invalid');
  const dailyIncluded = recordBoolean(record.dailyIncluded, 'normal_record_daily_included_invalid');
  if (contextOnly !== (scope === 'context_only'))
    return fail('normal_record_context_scope_mismatch');
  if (dailyIncluded !== (scope === 'in_window')) return fail('normal_record_daily_scope_mismatch');
  if (contextOnly && dailyIncluded) return fail('normal_record_scope_overlap');
  if ((scope === 'missing_event_at') !== (eventAt === null))
    return fail('normal_record_missing_event_scope_mismatch');
  if ((record.eventAtSource === 'missing') !== (eventAt === null))
    return fail('normal_record_event_source_mismatch');
}

const QUARANTINE_RAW_MIME_STATUSES = [
  'available',
  'missing',
  'oversized',
  'read_error',
  'not_attempted',
] as const;
const QUARANTINE_PARSE_STATUSES = [
  'parsed',
  'parse_error',
  'missing_object',
  'not_attempted',
] as const;
const QUARANTINE_REPORT_PARTITIONS = [
  'core',
  'september17_spillover',
  'outside_window',
  'undated',
] as const;

function validateQuarantineRecord(record: JsonRecord): void {
  if (record.recordType !== 'quarantine') return fail('quarantine_record_type_invalid');
  if (record.schemaVersion !== 'centurion-quarantine-v1')
    return fail('quarantine_record_schema_mismatch');
  requiredRecordText(record.id, 'quarantine_record_id_missing');
  requiredRecordText(record.ingestMailboxId, 'quarantine_record_ingest_mailbox_id_invalid');
  requiredRecordText(record.pop3Uidl, 'quarantine_record_pop3_uidl_invalid');
  requiredRecordText(record.reason, 'quarantine_record_reason_invalid');
  nullableRecordText(record.ingestMailboxEmail, 'quarantine_record_ingest_mailbox_email_invalid');
  nullableRecordText(record.ownerHeaderValue, 'quarantine_record_owner_header_invalid');
  nullableRecordText(record.quarantineCreatedAt, 'quarantine_record_created_at_invalid');
  nullableRecordText(record.dateHeader, 'quarantine_record_date_header_invalid');
  recordNullableIso(record.quarantineCreatedAt, 'quarantine_record_created_at_invalid');
  const messageDate = recordNullableIso(
    record.messageDate,
    'quarantine_record_message_date_invalid',
  );
  const dateStatus = recordEnum(
    record.dateStatus,
    ['valid', 'invalid', 'missing'],
    'quarantine_record_date_status_invalid',
  );
  const reportPartition = recordEnum(
    record.reportPartition,
    QUARANTINE_REPORT_PARTITIONS,
    'quarantine_record_report_partition_invalid',
  );
  recordEnum(
    record.quarantineCreatedPartition,
    QUARANTINE_REPORT_PARTITIONS,
    'quarantine_record_created_partition_invalid',
  );
  recordEnum(
    record.status,
    ['inbound', 'outbound', 'ambiguous', 'unattributed', 'missing_object', 'parse_error'],
    'quarantine_record_status_invalid',
  );
  recordEnum(
    record.routingStatus,
    ['centurion', 'owner_mismatch', 'unrelated_mailbox', 'missing_object', 'parse_error'],
    'quarantine_record_routing_status_invalid',
  );
  recordEnum(
    record.parseStatus,
    QUARANTINE_PARSE_STATUSES,
    'quarantine_record_parse_status_invalid',
  );
  nullableRecordText(record.parseError, 'quarantine_record_parse_error_invalid');
  if (dateStatus === 'missing' && messageDate !== null)
    return fail('quarantine_record_date_status_mismatch');
  if (reportPartition === 'undated' && messageDate !== null && dateStatus === 'valid')
    return fail('quarantine_record_partition_date_mismatch');
  if (!isJsonRecord(record.rawMime)) return fail('quarantine_record_raw_mime_invalid');
  const rawMime = record.rawMime;
  requiredRecordText(rawMime.primaryKey, 'quarantine_record_raw_mime_primary_key_invalid');
  requiredRecordText(rawMime.archiveKey, 'quarantine_record_raw_mime_archive_key_invalid');
  recordEnum(
    rawMime.primaryStatus,
    QUARANTINE_RAW_MIME_STATUSES,
    'quarantine_record_raw_mime_primary_status_invalid',
  );
  recordEnum(
    rawMime.archiveStatus,
    QUARANTINE_RAW_MIME_STATUSES,
    'quarantine_record_raw_mime_archive_status_invalid',
  );
  recordEnum(
    rawMime.status,
    QUARANTINE_RAW_MIME_STATUSES,
    'quarantine_record_raw_mime_status_invalid',
  );
  if (rawMime.source !== null && rawMime.source !== 'primary' && rawMime.source !== 'archive')
    return fail('quarantine_record_raw_mime_source_invalid');
  nullableRecordText(rawMime.selectedKey, 'quarantine_record_raw_mime_selected_key_invalid');
  if (rawMime.byteLength !== null)
    recordNonNegativeInteger(rawMime.byteLength, 'quarantine_record_raw_mime_byte_length_invalid');
  nullableRecordText(rawMime.sha256, 'quarantine_record_raw_mime_sha256_invalid');
  nullableRecordText(rawMime.contentType, 'quarantine_record_raw_mime_content_type_invalid');
  nullableRecordText(rawMime.artifactPath, 'quarantine_record_raw_mime_artifact_path_invalid');
  nullableRecordText(record.messageId, 'quarantine_record_message_id_invalid');
  nullableRecordText(record.inReplyTo, 'quarantine_record_in_reply_to_invalid');
  recordStringArray(record.references, 'quarantine_record_references_invalid');
  nullableRecordText(record.subject, 'quarantine_record_subject_invalid');
  if (typeof record.textBody !== 'string') return fail('quarantine_record_text_body_invalid');
  if (typeof record.htmlBody !== 'string') return fail('quarantine_record_html_body_invalid');
  if (!isJsonRecord(record.headers)) return fail('quarantine_record_headers_invalid');
  for (const value of Object.values(record.headers))
    recordStringArray(value, 'quarantine_record_headers_invalid');
  if (!Array.isArray(record.rawHeaders)) return fail('quarantine_record_raw_headers_invalid');
  for (const header of record.rawHeaders) {
    if (!isJsonRecord(header)) return fail('quarantine_record_raw_header_invalid');
    requiredRecordText(header.key, 'quarantine_record_raw_header_invalid');
    if (typeof header.line !== 'string') return fail('quarantine_record_raw_header_invalid');
  }
  recordStringArray(record.from, 'quarantine_record_from_invalid');
  recordStringArray(record.to, 'quarantine_record_to_invalid');
  recordStringArray(record.cc, 'quarantine_record_cc_invalid');
  recordStringArray(record.bcc, 'quarantine_record_bcc_invalid');
  nullableRecordText(record.effectiveSender, 'quarantine_record_effective_sender_invalid');
  if (!Array.isArray(record.attachments)) return fail('quarantine_record_attachments_invalid');
  for (const attachment of record.attachments) {
    if (!isJsonRecord(attachment)) return fail('quarantine_record_attachment_invalid');
    requiredRecordText(attachment.filename, 'quarantine_record_attachment_filename_invalid');
    requiredRecordText(attachment.contentType, 'quarantine_record_attachment_content_type_invalid');
    nullableRecordText(
      attachment.contentDisposition,
      'quarantine_record_attachment_disposition_invalid',
    );
    nullableRecordText(attachment.contentId, 'quarantine_record_attachment_content_id_invalid');
    recordBoolean(attachment.inline, 'quarantine_record_attachment_inline_invalid');
    recordNonNegativeInteger(attachment.byteSize, 'quarantine_record_attachment_byte_size_invalid');
    nullableRecordText(attachment.sha256, 'quarantine_record_attachment_sha256_invalid');
    recordEnum(
      attachment.contentStatus,
      ['available', 'unsupported', 'oversized', 'malformed', 'unavailable'],
      'quarantine_record_attachment_status_invalid',
    );
  }
  if (!isJsonRecord(record.evidence)) return fail('quarantine_record_evidence_invalid');
  const evidence = record.evidence;
  nullableRecordText(evidence.effectiveSender, 'quarantine_record_evidence_invalid');
  nullableRecordText(evidence.ownerHeaderValue, 'quarantine_record_evidence_invalid');
  for (const key of [
    'ownerHeaderMatches',
    'ownerHeaderMismatch',
    'ownerHeaderConflict',
    'senderMatchesCenturion',
    'recipientMatchesCenturion',
    'bccMirror',
    'selfLoopback',
    'queueCorrelated',
  ]) {
    recordBoolean(evidence[key], 'quarantine_record_evidence_invalid');
  }
  nullableRecordText(evidence.queueStatus, 'quarantine_record_evidence_invalid');
  recordBoolean(record.duplicateUidl, 'quarantine_record_duplicate_uidl_invalid');
  recordBoolean(record.duplicateRawHash, 'quarantine_record_duplicate_hash_invalid');
}

function validateManifestWindow(manifest: JsonRecord, kind: SnapshotKind): void {
  if (!isJsonRecord(manifest.window)) return fail(`${kind}_manifest_window_invalid`);
  const expected = {
    startInclusive: CENTURION_WINDOW_START,
    endExclusive: CENTURION_WINDOW_END,
    timezone: CENTURION_WINDOW_TIMEZONE,
    ...(kind === 'quarantine'
      ? {
          spilloverStartInclusive: CENTURION_WINDOW_END,
          spilloverEndExclusive: CENTURION_SPILLOVER_END,
        }
      : {}),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest.window[key] !== value) return fail(`${kind}_manifest_window_mismatch`);
  }
  if (kind === 'normal') {
    if ('spilloverStartInclusive' in manifest.window || 'spilloverEndExclusive' in manifest.window)
      return fail('normal_manifest_window_mismatch');
  }
}

function validateManifestCounts(
  manifest: JsonRecord,
  records: readonly JsonRecord[],
  kind: SnapshotKind,
): Record<string, number> {
  if (!isJsonRecord(manifest.counts)) return fail(`${kind}_manifest_counts_invalid`);
  const countNames =
    kind === 'normal'
      ? ['sourceRowCount', 'includedMessageCount', 'contextOnlyMessageCount', 'missingEventAtCount']
      : [
          'sourceRowCount',
          'quarantineRowCount',
          'centurionRowCount',
          'parseFailureCount',
          'coreCount',
          'september17SpilloverCount',
          'undatedCount',
          'outsideWindowCount',
          'parseErrorCount',
          'missingObjectCount',
          'duplicateUidGroupCount',
          'duplicateRawHashGroupCount',
        ];
  const counts: Record<string, number> = {};
  for (const name of countNames) {
    counts[name] = recordNonNegativeInteger(
      manifest.counts[name],
      `${kind}_manifest_count_invalid`,
    );
  }
  if (counts.sourceRowCount !== records.length)
    return fail(`${kind}_manifest_source_count_mismatch`);
  if (kind === 'normal') {
    const included = records.filter((record) => record.dailyIncluded === true).length;
    const contextOnly = records.filter((record) => record.contextOnly === true).length;
    const missingEventAt = records.filter((record) => record.eventAt === null).length;
    if (
      counts.includedMessageCount !== included ||
      counts.contextOnlyMessageCount !== contextOnly ||
      counts.missingEventAtCount !== missingEventAt
    ) {
      return fail('normal_manifest_counts_mismatch');
    }
  } else {
    const centurion = records.filter((record) => record.routingStatus !== 'unrelated_mailbox');
    const expected: Record<string, number> = {
      centurionRowCount: centurion.length,
      parseFailureCount: centurion.filter(
        (record) => String(record.reason).toLowerCase() === 'parse_failure',
      ).length,
      coreCount: records.filter((record) => record.reportPartition === 'core').length,
      september17SpilloverCount: records.filter(
        (record) => record.reportPartition === 'september17_spillover',
      ).length,
      undatedCount: records.filter((record) => record.reportPartition === 'undated').length,
      outsideWindowCount: records.filter((record) => record.reportPartition === 'outside_window')
        .length,
      parseErrorCount: records.filter((record) => record.parseStatus === 'parse_error').length,
      missingObjectCount: records.filter((record) => record.parseStatus === 'missing_object')
        .length,
    };
    for (const [name, value] of Object.entries(expected)) {
      if (counts[name] !== value) return fail('quarantine_manifest_counts_mismatch');
    }
    if (counts.quarantineRowCount < records.length)
      return fail('quarantine_manifest_source_count_mismatch');
  }
  return counts;
}

function isCoreInstant(value: string | null): boolean {
  if (!value) return false;
  const instant = Date.parse(value);
  return instant >= WINDOW_START_MS && instant < WINDOW_END_MS;
}

function dayForInstant(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CENTURION_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function isWorkflowClass(value: unknown): value is WorkflowClass {
  return typeof value === 'string' && (WORKFLOW_CLASSES as readonly string[]).includes(value);
}

function isDirection(value: unknown): value is BusinessDirection {
  return value === 'inbound' || value === 'outbound' || value === 'ambiguous';
}

function isOrigin(value: unknown): value is MessageOrigin {
  return value === 'human' || value === 'automated' || value === 'unknown';
}

function isUncertaintyLevel(value: unknown): value is WorkerUncertainty['level'] {
  return value === 'low' || value === 'medium' || value === 'high';
}

function normalizeJsonl(raw: string, fileName: string): JsonRecord[] {
  if (!raw.endsWith('\n')) return fail(`${fileName}_missing_terminal_newline`);
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  return lines.map((line, index) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return fail(`${fileName}_record_${index}_not_object`);
      }
      return value as JsonRecord;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${fileName}_`)) throw error;
      return fail(`${fileName}_record_${index}_invalid_json`);
    }
  });
}

async function readSealedSnapshot(directory: string, kind: SnapshotKind): Promise<LoadedSnapshot> {
  const absoluteDirectory = path.resolve(directory);
  const manifestPath = path.join(absoluteDirectory, 'manifest.json');
  const recordFileName = kind === 'normal' ? 'messages.jsonl' : 'quarantine.jsonl';
  const recordPath = path.join(absoluteDirectory, recordFileName);
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const recordRaw = await readFile(recordPath, 'utf8');
  let manifest: JsonRecord;
  try {
    const parsed: unknown = JSON.parse(manifestRaw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail(`${kind}_manifest_not_object`);
    }
    manifest = parsed as JsonRecord;
  } catch {
    return fail(`${kind}_manifest_invalid_json`);
  }
  const expectedSchema =
    kind === 'normal' ? 'centurion-nine-day-corpus-v1' : 'centurion-quarantine-v1';
  if (manifest.schemaVersion !== expectedSchema) return fail(`${kind}_manifest_schema_mismatch`);
  const records = normalizeJsonl(recordRaw, recordFileName);
  const snapshotId = requiredRecordText(
    manifest.snapshotId,
    `${kind}_manifest_snapshot_id_invalid`,
  );
  if (!/^[A-Za-z0-9._-]+$/.test(snapshotId)) return fail(`${kind}_manifest_snapshot_id_invalid`);
  if (manifest.transportId !== CENTURION_TRANSPORT_ID)
    return fail(`${kind}_manifest_transport_mismatch`);
  if (typeof manifest.asOf !== 'string' || Number.isNaN(Date.parse(manifest.asOf)))
    return fail(`${kind}_manifest_as_of_invalid`);
  validateManifestWindow(manifest, kind);
  for (const record of records) {
    if (kind === 'normal') validateNormalRecord(record);
    else validateQuarantineRecord(record);
  }
  const counts = validateManifestCounts(manifest, records, kind);
  const orderedHash = sha256(records.map((record) => JSON.stringify(record)).join('\n'));
  const manifestOrderedHash =
    kind === 'normal' ? text(manifest.orderedMessageSha256) : text(manifest.orderedRecordSha256);
  if (!manifestOrderedHash || manifestOrderedHash !== orderedHash) {
    return fail(`${kind}_ordered_hash_mismatch`);
  }
  return {
    kind,
    directory: absoluteDirectory,
    recordPath,
    records,
    schemaVersion: expectedSchema,
    snapshotId,
    counts,
    orderedHash,
    manifestHash: sha256(manifestRaw),
  };
}

function candidateFromNormal(
  record: JsonRecord,
  input: LoadedSnapshot,
  index: number,
): CandidateMessage {
  const sourceRecordId = requiredText(record.id, 'normal_record_id_missing');
  const textBody = text(record.textBody);
  const htmlBody = text(record.htmlBody);
  if (textBody === null || htmlBody === null) return fail('normal_record_body_missing');
  const eventAt = validIsoOrNull(record.eventAt);
  const contextOnly = record.contextOnly === true || record.scope === 'context_only';
  const dailyIncluded = record.dailyIncluded === true && record.scope === 'in_window';
  const eligible = dailyIncluded && isCoreInstant(eventAt) && !contextOnly;
  const initialErrorCode = contextOnly
    ? 'context_only'
    : !dailyIncluded
      ? 'not_daily_included'
      : !eventAt
        ? 'missing_event_at'
        : !isCoreInstant(eventAt)
          ? 'outside_window'
          : null;
  return {
    source: 'normal',
    sourceRecordId,
    recordPath: input.recordPath,
    recordIndex: index,
    messageId: text(record.messageId),
    subject: text(record.subject) ?? '',
    textBody,
    htmlBody,
    from: stringArray(record.from),
    to: stringArray(record.to),
    cc: stringArray(record.cc),
    bcc: stringArray(record.bcc),
    eventAt,
    messageDate: eventAt,
    attachmentCount: Array.isArray(record.attachmentDescriptors)
      ? record.attachmentDescriptors.length
      : 0,
    sourceDisposition: text(record.businessDirection),
    sourceDuplicateUidl: null,
    sourceDuplicateRawHash: null,
    partition: eligible ? 'core' : null,
    day: eligible ? dayForInstant(eventAt) : null,
    eligible,
    initialStatus: null,
    initialErrorCode,
    inputHash: sha256(JSON.stringify(record)),
  };
}

function candidateFromQuarantine(
  record: JsonRecord,
  input: LoadedSnapshot,
  index: number,
): CandidateMessage {
  const sourceRecordId = requiredText(record.id, 'quarantine_record_id_missing');
  const reportPartition = text(record.reportPartition);
  const partition: ClassificationPartition | null =
    reportPartition === 'core'
      ? 'core'
      : reportPartition === 'september17_spillover'
        ? 'spillover'
        : null;
  const messageDate = validIsoOrNull(record.messageDate);
  const textBody = text(record.textBody) ?? '';
  const htmlBody = text(record.htmlBody) ?? '';
  const parseStatus = text(record.parseStatus);
  const coreDateValid = partition === 'core' && isCoreInstant(messageDate);
  const spilloverDateValid =
    partition === 'spillover' &&
    messageDate !== null &&
    Date.parse(messageDate) >= WINDOW_END_MS &&
    Date.parse(messageDate) < SPILLOVER_END_MS;
  const eligible = coreDateValid && parseStatus === 'parsed';
  let initialStatus: ClassificationStatus | null = null;
  let initialErrorCode: string | null = null;
  if (partition === 'spillover') {
    initialStatus = 'spillover_excluded';
    initialErrorCode = spilloverDateValid ? 'september17_spillover' : 'partition_mismatch';
  } else if (!coreDateValid) {
    initialStatus = 'context_incomplete';
    initialErrorCode = partition === 'core' ? 'partition_mismatch' : 'outside_window';
  } else if (parseStatus !== 'parsed') {
    initialStatus = 'context_incomplete';
    initialErrorCode = parseStatus === 'missing_object' ? 'missing_object' : 'parse_error';
  }
  return {
    source: 'quarantine',
    sourceRecordId,
    recordPath: input.recordPath,
    recordIndex: index,
    messageId: text(record.messageId),
    subject: text(record.subject) ?? '',
    textBody,
    htmlBody,
    from: stringArray(record.from),
    to: stringArray(record.to),
    cc: stringArray(record.cc),
    bcc: stringArray(record.bcc),
    eventAt: messageDate,
    messageDate,
    attachmentCount: Array.isArray(record.attachments) ? record.attachments.length : 0,
    sourceDisposition: text(record.status),
    sourceDuplicateUidl: booleanOrNull(record.duplicateUidl),
    sourceDuplicateRawHash: booleanOrNull(record.duplicateRawHash),
    partition,
    day: coreDateValid || spilloverDateValid ? dayForInstant(messageDate) : null,
    eligible,
    initialStatus,
    initialErrorCode,
    inputHash: sha256(JSON.stringify(record)),
  };
}

function candidateRecordKey(candidate: CandidateMessage): string {
  return `${candidate.source}:${candidate.sourceRecordId}`;
}

function workerErrorRecord(
  candidate: CandidateMessage,
  metadata: {
    modelId: string;
    modelVersion: string;
    promptVersion: string;
    promptHash: string;
    schemaHash: string;
  },
  status: ClassificationStatus,
  errorCode: string | null,
  attempts = 0,
  retries = 0,
): ClassificationRecord {
  return {
    schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    recordKey: candidateRecordKey(candidate),
    sourceRecordId: candidate.sourceRecordId,
    source: candidate.source,
    partition: candidate.partition ?? 'core',
    day: candidate.day,
    eventAt: candidate.eventAt,
    messageDate: candidate.messageDate,
    sourceDisposition: candidate.sourceDisposition,
    sourceDuplicateUidl: candidate.sourceDuplicateUidl,
    sourceDuplicateRawHash: candidate.sourceDuplicateRawHash,
    status,
    errorCode,
    opaqueWorkerId: null,
    businessDirection: null,
    origin: null,
    primaryWorkflow: null,
    secondaryWorkflows: [],
    evidenceLocations: [],
    provenance: null,
    uncertainty: null,
    modelId: metadata.modelId,
    modelVersion: metadata.modelVersion,
    promptVersion: metadata.promptVersion,
    promptHash: metadata.promptHash,
    schemaHash: metadata.schemaHash,
    inputHash: candidate.inputHash,
    attempts,
    retries,
  };
}

function metadataFor(options: { modelId: string; modelVersion: string; promptVersion: string }): {
  modelId: string;
  modelVersion: string;
  promptVersion: string;
  promptHash: string;
  schemaHash: string;
} {
  return {
    modelId: options.modelId,
    modelVersion: options.modelVersion,
    promptVersion: options.promptVersion,
    promptHash: PROMPT_HASH,
    schemaHash: CLASSIFICATION_SCHEMA_HASH,
  };
}

function normalizeEvidenceLocations(
  value: unknown,
  candidate: CandidateMessage,
): EvidenceLocation[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new WorkerResponseValidationError('evidence_invalid');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new WorkerResponseValidationError('evidence_invalid');
    }
    const row = entry as JsonRecord;
    const field = row.field;
    const start = numberOrNull(row.start);
    const end = numberOrNull(row.end);
    const fields = ['subject', 'body', 'html', 'header', 'participant', 'attachment'] as const;
    if (!fields.includes(field as (typeof fields)[number]) || start === null || end === null) {
      throw new WorkerResponseValidationError('evidence_invalid');
    }
    const fieldLength =
      field === 'subject'
        ? candidate.subject.length
        : field === 'body'
          ? candidate.textBody.length
          : field === 'html'
            ? candidate.htmlBody.length
            : Number.MAX_SAFE_INTEGER;
    if (start < 0 || end < start || end > fieldLength) {
      throw new WorkerResponseValidationError('evidence_out_of_bounds');
    }
    return { field: field as EvidenceLocation['field'], start, end };
  });
}

function normalizeProvenance(value: unknown): WorkerProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerResponseValidationError('provenance_invalid');
  }
  const row = value as JsonRecord;
  const source = text(row.source);
  const direction = text(row.direction);
  const origin = text(row.origin);
  const workflow = text(row.workflow);
  if (!source || !direction || !origin || !workflow) {
    throw new WorkerResponseValidationError('provenance_invalid');
  }
  return { source, direction, origin, workflow };
}

function normalizeUncertainty(value: unknown): WorkerUncertainty {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerResponseValidationError('uncertainty_invalid');
  }
  const row = value as JsonRecord;
  const level = row.level;
  if (!isUncertaintyLevel(level)) {
    throw new WorkerResponseValidationError('uncertainty_invalid');
  }
  if (!Array.isArray(row.reasons) || row.reasons.length > 20) {
    throw new WorkerResponseValidationError('uncertainty_reasons_invalid');
  }
  if (
    row.reasons.some(
      (reason) => typeof reason !== 'string' || reason.trim() === '' || reason.length > 512,
    )
  ) {
    throw new WorkerResponseValidationError('uncertainty_reasons_invalid');
  }
  if (row.contextIncomplete !== undefined && typeof row.contextIncomplete !== 'boolean') {
    throw new WorkerResponseValidationError('uncertainty_context_invalid');
  }
  const reasons = row.reasons as string[];
  return {
    level,
    reasons,
    ...(row.contextIncomplete === true ? { contextIncomplete: true } : {}),
  };
}

function normalizeWorkerResponse(
  value: unknown,
  candidate: CandidateMessage,
): WorkerNormalizedResponse {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new WorkerResponseValidationError('response_invalid_json');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkerResponseValidationError('response_not_object');
  }
  const row = parsed as JsonRecord;
  const opaqueId = text(row.opaqueId);
  const businessDirection = row.businessDirection ?? row.direction;
  const origin = row.origin;
  const uncertainty = normalizeUncertainty(row.uncertainty);
  if (!Array.isArray(row.labels) || row.labels.length === 0) {
    throw new WorkerResponseValidationError('workflow_labels_missing');
  }
  const rawLabels = row.labels;
  if (rawLabels.some((label) => !isWorkflowClass(label))) {
    throw new WorkerResponseValidationError('workflow_label_unknown');
  }
  if (new Set(rawLabels).size !== rawLabels.length) {
    throw new WorkerResponseValidationError('workflow_label_duplicate');
  }
  const labels = rawLabels as WorkflowClass[];
  const primaryFromResponse = row.primaryWorkflow ?? row.primaryClass;
  if (!isWorkflowClass(primaryFromResponse)) {
    throw new WorkerResponseValidationError('primary_workflow_invalid');
  }
  if (!opaqueId || opaqueId.length > 256)
    throw new WorkerResponseValidationError('opaque_id_invalid');
  if (!isDirection(businessDirection)) throw new WorkerResponseValidationError('direction_invalid');
  if (!isOrigin(origin)) throw new WorkerResponseValidationError('origin_invalid');
  if (!labels.includes(primaryFromResponse)) {
    throw new WorkerResponseValidationError('primary_workflow_inconsistent');
  }
  const primaryWorkflow = choosePrimaryWorkflow(labels);
  if (primaryWorkflow !== primaryFromResponse) {
    throw new WorkerResponseValidationError('primary_workflow_inconsistent');
  }
  const secondaryValue = row.secondaryWorkflows ?? row.secondaryLabels;
  if (secondaryValue !== undefined) {
    if (!Array.isArray(secondaryValue)) {
      throw new WorkerResponseValidationError('secondary_workflows_invalid');
    }
    if (secondaryValue.some((label) => !isWorkflowClass(label))) {
      throw new WorkerResponseValidationError('secondary_workflow_unknown');
    }
    if (new Set(secondaryValue).size !== secondaryValue.length) {
      throw new WorkerResponseValidationError('secondary_workflow_duplicate');
    }
    const expectedSecondary = labels
      .filter((label) => label !== primaryWorkflow)
      .sort(
        (left, right) =>
          PRIMARY_WORKFLOW_PRIORITY.indexOf(left) - PRIMARY_WORKFLOW_PRIORITY.indexOf(right),
      );
    const actualSecondary = [...(secondaryValue as WorkflowClass[])].sort(
      (left, right) =>
        PRIMARY_WORKFLOW_PRIORITY.indexOf(left) - PRIMARY_WORKFLOW_PRIORITY.indexOf(right),
    );
    if (
      actualSecondary.length !== expectedSecondary.length ||
      actualSecondary.some((label, index) => label !== expectedSecondary[index])
    ) {
      throw new WorkerResponseValidationError('secondary_workflows_inconsistent');
    }
  }
  if (
    (businessDirection === 'ambiguous' ||
      origin === 'unknown' ||
      labels.some((label) => label === 'unknown_review' || label === 'other')) &&
    uncertainty.reasons.length === 0
  ) {
    throw new WorkerResponseValidationError('uncertainty_reason_required');
  }
  const evidenceLocations = normalizeEvidenceLocations(row.evidenceLocations, candidate);
  const provenance = normalizeProvenance(row.provenance);
  return {
    opaqueId,
    businessDirection,
    origin,
    labels,
    primaryWorkflow,
    evidenceLocations,
    provenance,
    uncertainty,
  };
}

export function choosePrimaryWorkflow(labels: readonly WorkflowClass[]): WorkflowClass {
  const present = new Set(labels);
  const primary = PRIMARY_WORKFLOW_PRIORITY.find((label) => present.has(label));
  return primary ?? 'unknown_review';
}

function classifiedRecord(
  candidate: CandidateMessage,
  response: WorkerNormalizedResponse,
  metadata: ReturnType<typeof metadataFor>,
  attempts: number,
): ClassificationRecord {
  return {
    schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    recordKey: candidateRecordKey(candidate),
    sourceRecordId: candidate.sourceRecordId,
    source: candidate.source,
    partition: candidate.partition ?? 'core',
    day: candidate.day,
    eventAt: candidate.eventAt,
    messageDate: candidate.messageDate,
    sourceDisposition: candidate.sourceDisposition,
    sourceDuplicateUidl: candidate.sourceDuplicateUidl,
    sourceDuplicateRawHash: candidate.sourceDuplicateRawHash,
    status: response.uncertainty.contextIncomplete ? 'context_incomplete' : 'classified',
    errorCode: response.uncertainty.contextIncomplete ? 'context_incomplete' : null,
    opaqueWorkerId: response.opaqueId,
    businessDirection: response.uncertainty.contextIncomplete ? null : response.businessDirection,
    origin: response.uncertainty.contextIncomplete ? null : response.origin,
    primaryWorkflow: response.uncertainty.contextIncomplete ? null : response.primaryWorkflow,
    secondaryWorkflows: response.uncertainty.contextIncomplete
      ? []
      : response.labels
          .filter((label) => label !== response.primaryWorkflow)
          .sort(
            (left, right) =>
              PRIMARY_WORKFLOW_PRIORITY.indexOf(left) - PRIMARY_WORKFLOW_PRIORITY.indexOf(right),
          ),
    evidenceLocations: response.evidenceLocations,
    provenance: response.provenance,
    uncertainty: response.uncertainty,
    modelId: metadata.modelId,
    modelVersion: metadata.modelVersion,
    promptVersion: metadata.promptVersion,
    promptHash: metadata.promptHash,
    schemaHash: metadata.schemaHash,
    inputHash: candidate.inputHash,
    attempts,
    retries: Math.max(0, attempts - 1),
  };
}

async function classifyOne(
  candidate: CandidateMessage,
  metadata: ReturnType<typeof metadataFor>,
  transport: CenturionClassificationWorkerTransport,
  maxRetries: number,
): Promise<ClassificationRecord> {
  if (candidate.initialStatus) {
    return workerErrorRecord(
      candidate,
      metadata,
      candidate.initialStatus,
      candidate.initialErrorCode,
      0,
      0,
    );
  }
  let attempts = 0;
  let lastErrorCode = 'worker_error';
  while (attempts <= maxRetries) {
    attempts += 1;
    const request: CenturionClassificationWorkerRequest = {
      workerId: `luna-worker-${randomUUID()}`,
      modelId: metadata.modelId,
      modelVersion: metadata.modelVersion,
      promptVersion: metadata.promptVersion,
      promptHash: metadata.promptHash,
      schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
      schemaHash: metadata.schemaHash,
      inputHash: candidate.inputHash,
      message: {
        source: candidate.source,
        sourceRecordId: candidate.sourceRecordId,
        recordPath: candidate.recordPath,
        recordIndex: candidate.recordIndex,
        messageId: candidate.messageId,
        subject: candidate.subject,
        textBody: candidate.textBody,
        htmlBody: candidate.htmlBody,
        from: candidate.from,
        to: candidate.to,
        cc: candidate.cc,
        bcc: candidate.bcc,
        eventAt: candidate.eventAt,
        messageDate: candidate.messageDate,
        attachmentCount: candidate.attachmentCount,
        sourceDisposition: candidate.sourceDisposition,
      },
    };
    try {
      const rawResponse = await transport.classify(request);
      let response: WorkerNormalizedResponse;
      try {
        response = normalizeWorkerResponse(rawResponse, candidate);
      } catch (error) {
        if (error instanceof WorkerResponseValidationError) {
          lastErrorCode = error.code;
        } else {
          lastErrorCode = 'response_parse_error';
        }
        if (lastErrorCode === 'uncertainty_reason_required' || attempts > maxRetries) break;
        continue;
      }
      return classifiedRecord(candidate, response, metadata, attempts);
    } catch (error) {
      lastErrorCode =
        error instanceof Error && error.message === 'luna_worker_transport_unavailable'
          ? 'luna_worker_transport_unavailable'
          : 'worker_error';
      if (lastErrorCode === 'luna_worker_transport_unavailable' || attempts > maxRetries) break;
    }
  }
  const status: ClassificationStatus =
    lastErrorCode === 'worker_error' || lastErrorCode === 'luna_worker_transport_unavailable'
      ? 'worker_error'
      : 'parse_error';
  return workerErrorRecord(
    candidate,
    metadata,
    status,
    lastErrorCode,
    attempts,
    Math.max(0, attempts - 1),
  );
}

function emptyBucket(): DailyBucket {
  return {
    total: 0,
    classified: 0,
    workerErrors: 0,
    parseErrors: 0,
    contextIncomplete: 0,
    inbound: 0,
    outbound: 0,
    ambiguous: 0,
    origins: { human: 0, automated: 0, unknown: 0 },
    primaryWorkflows: Object.fromEntries(WORKFLOW_CLASSES.map((label) => [label, 0])) as Record<
      WorkflowClass,
      number
    >,
  };
}

function addRecordToBucket(bucket: DailyBucket, record: ClassificationRecord): void {
  bucket.total += 1;
  if (record.status === 'classified') bucket.classified += 1;
  if (record.status === 'worker_error') bucket.workerErrors += 1;
  if (record.status === 'parse_error') bucket.parseErrors += 1;
  if (record.status === 'context_incomplete') bucket.contextIncomplete += 1;
  if (record.businessDirection === 'inbound') bucket.inbound += 1;
  if (record.businessDirection === 'outbound') bucket.outbound += 1;
  if (record.businessDirection === 'ambiguous') bucket.ambiguous += 1;
  if (record.origin) bucket.origins[record.origin] += 1;
  if (record.primaryWorkflow) bucket.primaryWorkflows[record.primaryWorkflow] += 1;
}

function countValues(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

export type CoverageReconciliation = {
  sourceCandidateCount: number;
  classificationRecordCount: number;
  missingClassificationIdCount: number;
  unexpectedClassificationIdCount: number;
  duplicateSourceCandidateIdCount: number;
  duplicateClassificationIdCount: number;
  dailyReconciles: boolean;
  sourceCandidateIdsSha256: string;
  classificationIdsSha256: string;
};

/** Reconcile source-ledger IDs against emitted classification IDs independently. */
export function reconcileCoverage(input: {
  sourceCandidateIds: readonly string[];
  classificationRecordIds: readonly string[];
  dailyTotal: number;
}): CoverageReconciliation {
  const sourceIds = [...input.sourceCandidateIds];
  const classificationIds = [...input.classificationRecordIds];
  const sourceSet = new Set(sourceIds);
  const classificationSet = new Set(classificationIds);
  const missingClassificationIdCount = [...sourceSet].filter(
    (id) => !classificationSet.has(id),
  ).length;
  const unexpectedClassificationIdCount = [...classificationSet].filter(
    (id) => !sourceSet.has(id),
  ).length;
  const duplicateSourceCandidateIdCount = sourceIds.length - sourceSet.size;
  const duplicateClassificationIdCount = classificationIds.length - classificationSet.size;
  return {
    sourceCandidateCount: sourceIds.length,
    classificationRecordCount: classificationIds.length,
    missingClassificationIdCount,
    unexpectedClassificationIdCount,
    duplicateSourceCandidateIdCount,
    duplicateClassificationIdCount,
    dailyReconciles:
      input.dailyTotal === sourceSet.size &&
      duplicateSourceCandidateIdCount === 0 &&
      sourceSet.size === classificationSet.size &&
      missingClassificationIdCount === 0 &&
      unexpectedClassificationIdCount === 0 &&
      duplicateClassificationIdCount === 0,
    sourceCandidateIdsSha256: sha256Ids(sourceIds),
    classificationIdsSha256: sha256Ids(classificationIds),
  };
}

function statusCounts(
  records: readonly ClassificationRecord[],
): Record<ClassificationStatus, number> {
  const result: Record<ClassificationStatus, number> = {
    classified: 0,
    worker_error: 0,
    parse_error: 0,
    context_incomplete: 0,
    spillover_excluded: 0,
  };
  for (const record of records) result[record.status] += 1;
  return result;
}

function buildDailyTables(
  snapshotId: string,
  normal: LoadedSnapshot,
  quarantine: LoadedSnapshot,
  candidates: readonly CandidateMessage[],
  records: readonly ClassificationRecord[],
  metadata: ReturnType<typeof metadataFor>,
): DailyTables {
  const coreRecords = records.filter((record) => record.partition === 'core');
  const spilloverRecords = records.filter((record) => record.partition === 'spillover');
  const coreTotals = emptyBucket();
  const spillover = emptyBucket();
  const days: Record<string, DailyBucket> = {};
  for (const record of coreRecords) {
    addRecordToBucket(coreTotals, record);
    if (record.day) {
      days[record.day] ??= emptyBucket();
      addRecordToBucket(days[record.day]!, record);
    }
  }
  for (const record of spilloverRecords) addRecordToBucket(spillover, record);
  const quarantineDispositionCounts = countValues(
    quarantine.records.map((record) => text(record.status) ?? 'unknown'),
  );
  const normalExcluded = candidates.filter(
    (candidate) => candidate.source === 'normal' && !candidate.eligible,
  ).length;
  const spilloverExcluded = candidates.filter(
    (candidate) => candidate.source === 'quarantine' && candidate.partition === 'spillover',
  ).length;
  return {
    schemaVersion: DAILY_TABLES_SCHEMA_VERSION,
    snapshotId,
    metadata: {
      modelId: metadata.modelId,
      modelVersion: metadata.modelVersion,
      promptVersion: metadata.promptVersion,
      promptHash: metadata.promptHash,
      schemaHash: metadata.schemaHash,
      normalManifestHash: normal.manifestHash,
      quarantineManifestHash: quarantine.manifestHash,
    },
    sourceCounts: {
      normalSourceRows: normal.records.length,
      quarantineSourceRows: quarantine.records.length,
      coreIncluded: coreRecords.length,
      spilloverExcluded,
      otherExcluded:
        normalExcluded +
        candidates.filter(
          (candidate) => candidate.source === 'quarantine' && candidate.partition === null,
        ).length,
    },
    coreTotals,
    days,
    spillover,
    quarantineDispositionCounts,
    statusCounts: statusCounts(records),
  };
}

function buildCoverageAudit(
  snapshotId: string,
  normal: LoadedSnapshot,
  quarantine: LoadedSnapshot,
  candidates: readonly CandidateMessage[],
  records: readonly ClassificationRecord[],
  dailyTables: DailyTables,
  workerTransportUnavailable: boolean,
  metadata: ReturnType<typeof metadataFor>,
): CoverageAudit {
  const normalCandidates = candidates.filter((candidate) => candidate.source === 'normal');
  const quarantineCandidates = candidates.filter((candidate) => candidate.source === 'quarantine');
  const coreRecords = records.filter((record) => record.partition === 'core');
  const spilloverRecords = records.filter((record) => record.partition === 'spillover');
  const sourceCoreIds = candidates
    .filter((candidate) => candidate.partition === 'core')
    .map(candidateRecordKey);
  const sourceSpilloverIds = candidates
    .filter((candidate) => candidate.partition === 'spillover')
    .map(candidateRecordKey);
  const classificationCoreIds = coreRecords.map((record) => record.recordKey);
  const coreReconciliation = reconcileCoverage({
    sourceCandidateIds: sourceCoreIds,
    classificationRecordIds: classificationCoreIds,
    dailyTotal: dailyTables.coreTotals.total,
  });
  const uniqueSpilloverIds = new Set(sourceSpilloverIds);
  if (sourceCoreIds.length !== normal.counts.includedMessageCount + quarantine.counts.coreCount) {
    return fail('source_manifest_candidate_count_mismatch');
  }
  if (sourceSpilloverIds.length !== quarantine.counts.september17SpilloverCount) {
    return fail('spillover_manifest_candidate_count_mismatch');
  }
  const statuses = statusCounts(records);
  const attempts = records.reduce((sum, record) => sum + record.attempts, 0);
  const retries = records.reduce((sum, record) => sum + record.retries, 0);
  return {
    schemaVersion: COVERAGE_AUDIT_SCHEMA_VERSION,
    snapshotId,
    sourceManifests: {
      normal: {
        schemaVersion: normal.schemaVersion,
        snapshotId: normal.snapshotId,
        orderedHash: normal.orderedHash,
        manifestHash: normal.manifestHash,
        counts: normal.counts,
      },
      quarantine: {
        schemaVersion: quarantine.schemaVersion,
        snapshotId: quarantine.snapshotId,
        orderedHash: quarantine.orderedHash,
        manifestHash: quarantine.manifestHash,
        counts: quarantine.counts,
      },
    },
    sourceRows: {
      normal: normal.records.length,
      quarantine: quarantine.records.length,
      total: normal.records.length + quarantine.records.length,
    },
    normal: {
      dailyIncluded: normalCandidates.filter((candidate) => candidate.eligible).length,
      contextOnly: normal.records.filter(
        (record) => record.contextOnly === true || record.scope === 'context_only',
      ).length,
      missingEventAt: normal.records.filter((record) => !validIsoOrNull(record.eventAt)).length,
      excluded: normalCandidates.filter((candidate) => !candidate.eligible).length,
    },
    quarantine: {
      core: quarantineCandidates.filter((candidate) => candidate.partition === 'core').length,
      spillover: quarantineCandidates.filter((candidate) => candidate.partition === 'spillover')
        .length,
      otherPartitions: quarantineCandidates.filter((candidate) => candidate.partition === null)
        .length,
      parseStatuses: countValues(
        quarantine.records.map((record) => text(record.parseStatus) ?? 'unknown'),
      ),
      dispositions: countValues(
        quarantine.records.map((record) => text(record.status) ?? 'unknown'),
      ),
    },
    core: {
      sourceCandidateCount: coreReconciliation.sourceCandidateCount,
      classificationRecordCount: coreReconciliation.classificationRecordCount,
      missingClassificationIdCount: coreReconciliation.missingClassificationIdCount,
      unexpectedClassificationIdCount: coreReconciliation.unexpectedClassificationIdCount,
      duplicateSourceCandidateIdCount: coreReconciliation.duplicateSourceCandidateIdCount,
      includedUniqueIdCount: new Set(sourceCoreIds).size,
      classifiedCount: coreRecords.filter((record) => record.status === 'classified').length,
      unresolvedCount: coreRecords.filter((record) => record.status !== 'classified').length,
      dailyTotal: dailyTables.coreTotals.total,
      dailyReconciles: coreReconciliation.dailyReconciles,
      duplicateRecordKeyCount: coreReconciliation.duplicateClassificationIdCount,
      includedIdsSha256: coreReconciliation.sourceCandidateIdsSha256,
      sourceCandidateIdsSha256: coreReconciliation.sourceCandidateIdsSha256,
      classificationIdsSha256: coreReconciliation.classificationIdsSha256,
    },
    spillover: {
      excludedCount: spilloverRecords.length,
      uniqueIdCount: uniqueSpilloverIds.size,
      idsSha256: sha256Ids(sourceSpilloverIds),
    },
    statusCounts: statuses,
    worker: {
      modelId: metadata.modelId,
      modelVersion: metadata.modelVersion,
      promptVersion: metadata.promptVersion,
      promptHash: metadata.promptHash,
      schemaHash: metadata.schemaHash,
      attempts,
      retries,
      workerErrorCount: statuses.worker_error,
      parseErrorCount: statuses.parse_error,
      contextIncompleteCount: statuses.context_incomplete,
      runtimeBlockers: workerTransportUnavailable ? ['luna_worker_transport_unavailable'] : [],
    },
  };
}

function buildDailyMarkdown(tables: DailyTables, audit: CoverageAudit): string {
  const lines = [
    '# Centurion daily classification',
    '',
    `Snapshot: \`${tables.snapshotId}\``,
    `Model: \`${tables.metadata.modelId}\` (${tables.metadata.modelVersion})`,
    `Prompt/schema: \`${tables.metadata.promptHash}\` / \`${tables.metadata.schemaHash}\``,
    '',
    '## Core totals',
    '',
    '| total | classified | worker errors | parse errors | context incomplete | inbound | outbound | ambiguous |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${tables.coreTotals.total} | ${tables.coreTotals.classified} | ${tables.coreTotals.workerErrors} | ${tables.coreTotals.parseErrors} | ${tables.coreTotals.contextIncomplete} | ${tables.coreTotals.inbound} | ${tables.coreTotals.outbound} | ${tables.coreTotals.ambiguous} |`,
    '',
    '## Daily core totals',
    '',
    '| Johannesburg day | total | classified | inbound | outbound | ambiguous |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const day of Object.keys(tables.days).sort()) {
    const bucket = tables.days[day]!;
    lines.push(
      `| ${day} | ${bucket.total} | ${bucket.classified} | ${bucket.inbound} | ${bucket.outbound} | ${bucket.ambiguous} |`,
    );
  }
  lines.push('', '## Quarantine disposition', '', '| disposition | count |', '| --- | ---: |');
  for (const [disposition, count] of Object.entries(tables.quarantineDispositionCounts).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    lines.push(`| ${disposition} | ${count} |`);
  }
  lines.push(
    '',
    '## September 17 spillover',
    '',
    `Excluded spillover records: **${tables.spillover.total}**`,
    '',
    '## Coverage',
    '',
    `Core unique IDs: **${audit.core.includedUniqueIdCount}**; daily reconciliation: **${audit.core.dailyReconciles ? 'PASS' : 'FAIL'}**`,
    `Unresolved classification records: **${audit.core.unresolvedCount}**`,
    '',
  );
  if (audit.worker.runtimeBlockers.length > 0) {
    lines.push(`Runtime blockers: **${audit.worker.runtimeBlockers.join(', ')}**`, '');
  }
  return `${lines.join('\n')}\n`;
}

async function ensurePrivateDirectory(
  directory: string,
  code: string,
  create: boolean,
): Promise<string> {
  let entry;
  try {
    entry = await lstat(directory);
  } catch (error) {
    if (
      !create ||
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      return fail(code);
    }
    await mkdir(directory, { mode: 0o700 });
    entry = await lstat(directory);
  }
  if (entry.isSymbolicLink()) return fail(code);
  if (!entry.isDirectory()) return fail(code);
  await chmod(directory, 0o700);
  return realpath(directory);
}

export async function writePrivateOutputs(
  run: Omit<CenturionClassificationRun, 'outputDir'> & { outputDir: string },
): Promise<void> {
  const outputDir = path.resolve(run.outputDir);
  const corpusRoot = path.dirname(outputDir);
  const privateRoot = path.dirname(corpusRoot);
  const repoRoot = path.dirname(privateRoot);
  if (
    path.basename(privateRoot) !== '.private' ||
    path.basename(corpusRoot) !== 'centurion-corpus' ||
    path.basename(outputDir) !== run.snapshotId ||
    !/^[A-Za-z0-9._-]+$/.test(run.snapshotId)
  ) {
    return fail('output_private_root_invalid');
  }
  const repoEntry = await lstat(repoRoot).catch(() => null);
  if (!repoEntry || repoEntry.isSymbolicLink() || !repoEntry.isDirectory())
    return fail('private_parent_symlink');
  const canonicalRepoRoot = await realpath(repoRoot).catch(() => null);
  if (!canonicalRepoRoot) return fail('private_parent_invalid');
  const canonicalPrivateRoot = await ensurePrivateDirectory(
    privateRoot,
    'private_root_symlink',
    true,
  );
  if (canonicalPrivateRoot !== path.join(canonicalRepoRoot, '.private'))
    return fail('private_root_symlink');
  const canonicalCorpusRoot = await ensurePrivateDirectory(
    corpusRoot,
    'private_parent_symlink',
    true,
  );
  if (canonicalCorpusRoot !== path.join(canonicalPrivateRoot, 'centurion-corpus'))
    return fail('private_parent_symlink');
  const canonicalOutputDir = await ensurePrivateDirectory(
    outputDir,
    'output_directory_invalid',
    true,
  );
  if (canonicalOutputDir !== path.join(canonicalCorpusRoot, run.snapshotId))
    return fail('output_parent_invalid');
  const files: Array<[string, string]> = [
    [
      'daily-classification.jsonl',
      `${run.records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    ],
    ['daily-tables.md', buildDailyMarkdown(run.dailyTables, run.coverageAudit)],
    ['daily-tables.json', `${JSON.stringify(run.dailyTables, null, 2)}\n`],
    ['coverage-audit.json', `${JSON.stringify(run.coverageAudit, null, 2)}\n`],
  ];
  for (const [name, contents] of files) {
    const filePath = path.join(canonicalOutputDir, name);
    await writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(filePath, 0o600);
  }
}

export function createUnavailableLunaWorkerTransport(): CenturionClassificationWorkerTransport {
  return {
    async classify(): Promise<never> {
      throw new Error('luna_worker_transport_unavailable');
    },
  };
}

export async function classifyCenturionNineDayCorpus(
  options: ClassifyCenturionNineDayCorpusOptions,
): Promise<CenturionClassificationRun> {
  const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > DEFAULT_MAX_WORKERS) {
    return fail('maxWorkers must be an integer from 1 through 5');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    return fail('maxRetries must be a non-negative integer no greater than 10');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.snapshotId)) return fail('snapshot_id_invalid');
  const modelId = options.modelId ?? DEFAULT_LUNA_MODEL_ID;
  const modelVersion = options.modelVersion ?? modelId;
  const promptVersion = options.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const metadata = metadataFor({ modelId, modelVersion, promptVersion });
  const normal = await readSealedSnapshot(options.normalSnapshotDir, 'normal');
  const quarantine = await readSealedSnapshot(options.quarantineSnapshotDir, 'quarantine');
  const candidates = [
    ...normal.records.map((record, index) => candidateFromNormal(record, normal, index)),
    ...quarantine.records.map((record, index) =>
      candidateFromQuarantine(record, quarantine, index),
    ),
  ];
  const recordKeys = candidates
    .filter((candidate) => candidate.eligible || candidate.partition === 'spillover')
    .map(candidateRecordKey);
  if (new Set(recordKeys).size !== recordKeys.length) return fail('duplicate_included_record_key');
  const transport = options.workerTransport ?? createUnavailableLunaWorkerTransport();
  const records: ClassificationRecord[] = [];
  const candidatesForClassification = candidates.filter(
    (candidate) =>
      candidate.eligible ||
      (candidate.partition === 'core' && candidate.initialStatus !== null) ||
      candidate.partition === 'spillover',
  );
  for (let offset = 0; offset < candidatesForClassification.length; offset += maxWorkers) {
    const batch = candidatesForClassification.slice(offset, offset + maxWorkers);
    const results = await Promise.all(
      batch.map((candidate) => classifyOne(candidate, metadata, transport, maxRetries)),
    );
    records.push(
      ...results.filter(
        (record) => record.partition === 'core' || record.partition === 'spillover',
      ),
    );
  }
  const dailyTables = buildDailyTables(
    snapshotIdOrFail(options.snapshotId),
    normal,
    quarantine,
    candidates,
    records,
    metadata,
  );
  const workerTransportUnavailable =
    options.workerTransport === undefined ||
    records.some((record) => record.errorCode === 'luna_worker_transport_unavailable');
  const coverageAudit = buildCoverageAudit(
    snapshotIdOrFail(options.snapshotId),
    normal,
    quarantine,
    candidates,
    records,
    dailyTables,
    workerTransportUnavailable,
    metadata,
  );
  const run: CenturionClassificationRun = {
    snapshotId: options.snapshotId,
    outputDir: path.resolve(options.outputDir),
    records,
    dailyTables,
    coverageAudit,
  };
  await writePrivateOutputs(run);
  return run;
}

function snapshotIdOrFail(value: string): string {
  if (!value) return fail('snapshot_id_missing');
  return value;
}

function parseCliArgs(argv: readonly string[]): {
  normalSnapshotDir: string;
  quarantineSnapshotDir: string;
  outputDir: string;
  snapshotId: string;
  maxWorkers?: number;
  maxRetries?: number;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith('--')) return fail('invalid_arguments');
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) return fail('invalid_arguments');
    values.set(key, value);
    index += 1;
  }
  const normalSnapshotDir = values.get('normal');
  const quarantineSnapshotDir = values.get('quarantine');
  const outputDir = values.get('out');
  const snapshotId = values.get('snapshot');
  if (!normalSnapshotDir || !quarantineSnapshotDir || !outputDir || !snapshotId)
    return fail('invalid_arguments');
  const maxWorkersValue = values.get('max-workers');
  const maxRetriesValue = values.get('max-retries');
  return {
    normalSnapshotDir,
    quarantineSnapshotDir,
    outputDir,
    snapshotId,
    ...(maxWorkersValue ? { maxWorkers: Number(maxWorkersValue) } : {}),
    ...(maxRetriesValue ? { maxRetries: Number(maxRetriesValue) } : {}),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return (
    typeof entry === 'string' &&
    path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  );
}

function assertCliOutputPath(outputDir: string, snapshotId: string, repoRoot: string): void {
  const expectedRoot = path.join(path.resolve(repoRoot), '.private', 'centurion-corpus');
  const expectedOutput = path.join(expectedRoot, snapshotId);
  if (path.resolve(outputDir) !== expectedOutput)
    return fail('output_must_be_root_private_centurion_corpus');
}

export type CenturionClassificationCliDependencies = {
  repoRoot?: string;
  workerTransport?: CenturionClassificationWorkerTransport;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
};

export async function runCenturionClassificationCli(
  argv: readonly string[],
  dependencies: CenturionClassificationCliDependencies = {},
): Promise<number> {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(dependencies.repoRoot ?? path.resolve(scriptDirectory, '../../..'));
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));
  try {
    const cliArgs = parseCliArgs(argv);
    assertCliOutputPath(cliArgs.outputDir, cliArgs.snapshotId, repoRoot);
    const run = await classifyCenturionNineDayCorpus({
      ...cliArgs,
      ...(dependencies.workerTransport ? { workerTransport: dependencies.workerTransport } : {}),
    });
    const blocked =
      run.coverageAudit.worker.runtimeBlockers.length > 0 ||
      run.coverageAudit.core.unresolvedCount > 0;
    writeStdout(
      `${JSON.stringify({
        event: blocked ? 'centurion_classification.blocked' : 'centurion_classification.complete',
        status: blocked ? 'blocked' : 'complete',
        snapshotId: run.snapshotId,
        coreCount: run.coverageAudit.core.includedUniqueIdCount,
        spilloverCount: run.coverageAudit.spillover.excludedCount,
        classifiedCount: run.coverageAudit.core.classifiedCount,
        unresolvedCount: run.coverageAudit.core.unresolvedCount,
        runtimeBlockers: run.coverageAudit.worker.runtimeBlockers,
      })}\n`,
    );
    return blocked ? 2 : 0;
  } catch {
    writeStderr(
      `${JSON.stringify({ event: 'centurion_classification.failed', code: 'classification_failed' })}\n`,
    );
    return 1;
  }
}

if (isMainModule()) {
  process.exitCode = await runCenturionClassificationCli(process.argv.slice(2));
}
