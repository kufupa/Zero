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
 * The primary class in this response is advisory. The pipeline derives its
 * persisted primary class from the complete label set and a fixed priority.
 */
export type CenturionClassificationWorkerResponse = {
  opaqueId: string;
  businessDirection: BusinessDirection;
  origin: MessageOrigin;
  labels: WorkflowClass[];
  primaryWorkflow: WorkflowClass;
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
    normal: { schemaVersion: string; orderedHash: string; manifestHash: string };
    quarantine: { schemaVersion: string; orderedHash: string; manifestHash: string };
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
    includedUniqueIdCount: number;
    classifiedCount: number;
    unresolvedCount: number;
    dailyTotal: number;
    dailyReconciles: boolean;
    duplicateRecordKeyCount: number;
    includedIdsSha256: string;
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

const WINDOW_START_MS = Date.parse('2026-09-07T22:00:00.000Z');
const WINDOW_END_MS = Date.parse('2026-09-16T22:00:00.000Z');
const SPILLOVER_END_MS = Date.parse('2026-09-17T22:00:00.000Z');
const CENTURION_TIME_ZONE = 'Africa/Johannesburg';
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
  const reasons = stringArray(row.reasons);
  if (!isUncertaintyLevel(level) || reasons.length > 20) {
    throw new WorkerResponseValidationError('uncertainty_invalid');
  }
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
  const rawLabels = Array.isArray(row.labels)
    ? row.labels
    : Array.isArray(row.secondaryLabels)
      ? row.secondaryLabels
      : [];
  const labels = [...new Set(rawLabels.filter(isWorkflowClass))];
  const primaryFromResponse = row.primaryWorkflow ?? row.primaryClass;
  if (isWorkflowClass(primaryFromResponse)) labels.push(primaryFromResponse);
  const uniqueLabels = [...new Set(labels)];
  if (!opaqueId || opaqueId.length > 256)
    throw new WorkerResponseValidationError('opaque_id_invalid');
  if (!isDirection(businessDirection)) throw new WorkerResponseValidationError('direction_invalid');
  if (!isOrigin(origin)) throw new WorkerResponseValidationError('origin_invalid');
  if (uniqueLabels.length === 0) throw new WorkerResponseValidationError('workflow_labels_missing');
  const primaryWorkflow = choosePrimaryWorkflow(uniqueLabels);
  if (
    (businessDirection === 'ambiguous' ||
      origin === 'unknown' ||
      primaryWorkflow === 'unknown_review' ||
      primaryWorkflow === 'other') &&
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
    labels: uniqueLabels,
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
    } catch {
      lastErrorCode = 'worker_error';
      if (attempts > maxRetries) break;
    }
  }
  const status: ClassificationStatus =
    lastErrorCode === 'worker_error' ? 'worker_error' : 'parse_error';
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
  const coreIds = coreRecords.map((record) => record.recordKey);
  const spilloverIds = spilloverRecords.map((record) => record.recordKey);
  const uniqueCoreIds = new Set(coreIds);
  const uniqueSpilloverIds = new Set(spilloverIds);
  const duplicateRecordKeyCount = coreIds.length - uniqueCoreIds.size;
  const statuses = statusCounts(records);
  const attempts = records.reduce((sum, record) => sum + record.attempts, 0);
  const retries = records.reduce((sum, record) => sum + record.retries, 0);
  return {
    schemaVersion: COVERAGE_AUDIT_SCHEMA_VERSION,
    snapshotId,
    sourceManifests: {
      normal: {
        schemaVersion: normal.schemaVersion,
        orderedHash: normal.orderedHash,
        manifestHash: normal.manifestHash,
      },
      quarantine: {
        schemaVersion: quarantine.schemaVersion,
        orderedHash: quarantine.orderedHash,
        manifestHash: quarantine.manifestHash,
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
      includedUniqueIdCount: uniqueCoreIds.size,
      classifiedCount: coreRecords.filter((record) => record.status === 'classified').length,
      unresolvedCount: coreRecords.filter((record) => record.status !== 'classified').length,
      dailyTotal: dailyTables.coreTotals.total,
      dailyReconciles: dailyTables.coreTotals.total === uniqueCoreIds.size,
      duplicateRecordKeyCount,
      includedIdsSha256: sha256Ids(coreIds),
    },
    spillover: {
      excludedCount: spilloverRecords.length,
      uniqueIdCount: uniqueSpilloverIds.size,
      idsSha256: sha256Ids(spilloverIds),
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

async function writePrivateOutputs(
  run: Omit<CenturionClassificationRun, 'outputDir'> & { outputDir: string },
): Promise<void> {
  const outputDir = path.resolve(run.outputDir);
  const parent = path.dirname(outputDir);
  const privateRoot = path.dirname(parent);
  const isCenturionPrivateLayout =
    path.basename(parent) === 'centurion-corpus' && path.basename(privateRoot) === '.private';
  if (isCenturionPrivateLayout) {
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    await chmod(privateRoot, 0o700);
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const directoryStat = await lstat(outputDir);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
    return fail('output_directory_invalid');
  if ((await realpath(path.dirname(outputDir))) !== (await realpath(parent)))
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
    const filePath = path.join(outputDir, name);
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
  const workerTransportUnavailable = options.workerTransport === undefined;
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

function assertCliOutputPath(outputDir: string, snapshotId: string): void {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDirectory, '../../..');
  const expectedRoot = path.join(repoRoot, '.private', 'centurion-corpus');
  const expectedOutput = path.join(expectedRoot, snapshotId);
  if (path.resolve(outputDir) !== expectedOutput)
    return fail('output_must_be_root_private_centurion_corpus');
}

if (isMainModule()) {
  try {
    const cliArgs = parseCliArgs(process.argv.slice(2));
    assertCliOutputPath(cliArgs.outputDir, cliArgs.snapshotId);
    const run = await classifyCenturionNineDayCorpus({
      ...cliArgs,
      workerTransport: createUnavailableLunaWorkerTransport(),
    });
    process.stdout.write(
      `${JSON.stringify({
        event: 'centurion_classification.complete',
        snapshotId: run.snapshotId,
        coreCount: run.coverageAudit.core.includedUniqueIdCount,
        spilloverCount: run.coverageAudit.spillover.excludedCount,
        classifiedCount: run.coverageAudit.core.classifiedCount,
        unresolvedCount: run.coverageAudit.core.unresolvedCount,
        runtimeBlockers: run.coverageAudit.worker.runtimeBlockers,
      })}\n`,
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({ event: 'centurion_classification.failed', code: 'classification_failed' })}\n`,
    );
    process.exitCode = 1;
  }
}
