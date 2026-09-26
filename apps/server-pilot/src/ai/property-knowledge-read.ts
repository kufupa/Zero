import {
  PROPERTY_KNOWLEDGE_CONTRACT_VERSION,
  PROPERTY_KNOWLEDGE_MAX_FILE_BYTES,
  PROPERTY_KNOWLEDGE_MAX_CONTENT_CHARS,
  PROPERTY_KNOWLEDGE_MAX_ENTRIES,
  PROPERTY_KNOWLEDGE_MAX_ISSUES,
  PROPERTY_KNOWLEDGE_SCOPE,
  PROPERTY_KNOWLEDGE_TOOL_ID,
  propertyKnowledgeDataSchema,
  propertyKnowledgeFileSchema,
  propertyKnowledgeIssueSchema,
  propertyKnowledgeReadRequestSchema,
  propertyKnowledgeReadResultSchema,
  propertyKnowledgeSourceRecordSchema,
  type PropertyKnowledgeAudience,
  type PropertyKnowledgeData,
  type PropertyKnowledgeDetail,
  type PropertyKnowledgeEntry,
  type PropertyKnowledgeEvidence,
  type PropertyKnowledgeIssue,
  type PropertyKnowledgeIssueCode,
  type PropertyKnowledgeReadContext,
  type PropertyKnowledgeReadRequest,
  type PropertyKnowledgeReadResult,
  type PropertyKnowledgeSourceRecord,
  type PropertyKnowledgeTopic,
} from './property-knowledge-contract.js';
import { documentValidationIsUsable } from '../mail/artifacts/existing-document-contracts.js';
import type { ExistingDocumentService } from '../mail/artifacts/existing-document-service.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';

export type PropertyKnowledgeSourceListInput = {
  propertyRef: string;
  topic: PropertyKnowledgeTopic;
  detail: PropertyKnowledgeDetail;
  now: Date;
  signal: AbortSignal;
};

/**
 * Source records are resolved by the caller from local approved files or
 * authorized attachments.  The reader never accepts a path, URL, locator,
 * credential or arbitrary search expression from a model.
 */
export interface PropertyKnowledgeSource {
  list(input: PropertyKnowledgeSourceListInput): Promise<readonly PropertyKnowledgeSourceRecord[]>;
}

export type PropertyKnowledgeFileRead = (input: {
  filePath: string;
  allowedRoot?: string;
  signal: AbortSignal;
  maxBytes: number;
  deadlineMs?: number;
}) => Promise<AsyncIterable<Uint8Array>>;

export type PropertyKnowledgeFileSourceOptions = {
  /** Server configuration only; never accepted from a model request. */
  filePath: string;
  /** Optional server-owned root that must contain filePath. */
  allowedRoot?: string;
  maxBytes?: number;
  /** Server-owned filesystem/object-read response bound; never model supplied. */
  deadlineMs?: number;
  /** Test/object-storage seam; production defaults to bounded local fs read. */
  readFile?: PropertyKnowledgeFileRead;
};

export type PropertyKnowledgeAuthorizationInput = PropertyKnowledgeSourceListInput & {
  audience: PropertyKnowledgeAudience;
};

export type PropertyKnowledgeAuthorization =
  | ((input: PropertyKnowledgeAuthorizationInput) => Promise<{ granted: boolean; reason?: string }>)
  | {
      authorize(
        input: PropertyKnowledgeAuthorizationInput,
      ): Promise<{ granted: boolean; reason?: string }>;
    };

export type PropertyKnowledgeDocumentCheckStatus =
  | 'current'
  | 'changed'
  | 'expired'
  | 'unauthorized'
  | 'blocked'
  | 'missing';

export type PropertyKnowledgeDocumentCheck = {
  status: PropertyKnowledgeDocumentCheckStatus;
  expiresAt?: string | null;
  detail?: string | null;
};

export interface PropertyKnowledgeDocumentRevalidator {
  revalidate(input: {
    documentRef: string;
    propertyRef: string;
    sourceRef: string;
    now: Date;
    signal: AbortSignal;
  }): Promise<PropertyKnowledgeDocumentCheck>;
}

type ExistingDocumentServiceLike = Pick<ExistingDocumentService, 'documents_read_existing'>;

export type PropertyKnowledgeReaderOptions = {
  source: PropertyKnowledgeSource;
  authorization?: PropertyKnowledgeAuthorization;
  /** Short callback spelling retained for small local adapters. */
  authorize?: PropertyKnowledgeAuthorization;
  revalidateDocument?: PropertyKnowledgeDocumentRevalidator['revalidate'];
  /** Existing mail/document authority may be used to revalidate linked refs. */
  existingDocumentService?: ExistingDocumentServiceLike;
  now?: () => Date;
  defaultPropertyRef?: string;
  defaultAudience?: PropertyKnowledgeAudience;
};

export type PropertyKnowledgeReadContextInput = Partial<PropertyKnowledgeReadContext> & {
  now?: Date;
  signal?: AbortSignal;
};

export interface PropertyKnowledgeReader {
  read(
    request: PropertyKnowledgeReadRequest,
    context?: PropertyKnowledgeReadContextInput,
  ): Promise<PropertyKnowledgeReadResult>;
}

const DEFAULT_FRESHNESS_MS = 5 * 60 * 1_000;
const DEFAULT_SOURCE_DEADLINE_MS = 5_000;

const PAYMENT_SECRET_PATTERNS = [
  /\b(?:credit|debit|payment|card)\s*(?:card\s*)?(?:number|no\.?|#)\s*[:=-]?\s*(?:\d[ -]?){13,19}\b/i,
  /\b(?:cvv|cvc|security\s+code|password|passcode|room\s+pin|api\s+key|access\s+token|secret)\b/i,
  /\bBearer\s+\S+/i,
  /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk_(?:live|test)_|ghp_|github_pat_|glpat-|xox[baprs]-|pypi-)[A-Za-z0-9_-]{8,}\b/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*\S+/i,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}\b/i,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/,
];

const PAN_CANDIDATE_PATTERN = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;

function isLuhnValid(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasPaymentSecret(content: string): boolean {
  if (PAYMENT_SECRET_PATTERNS.some((pattern) => pattern.test(content))) return true;
  PAN_CANDIDATE_PATTERN.lastIndex = 0;
  return [...content.matchAll(PAN_CANDIDATE_PATTERN)].some((match) =>
    isLuhnValid(match[0].replace(/[ -]/g, '')),
  );
}

function digestContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function readAbortedError(): Error {
  const error = new Error('property knowledge source read aborted');
  error.name = 'AbortError';
  return error;
}

function readDeadlineError(): Error {
  const error = new Error('property knowledge source read deadline exceeded');
  error.name = 'TimeoutError';
  return error;
}

function withReadDeadline<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
  onLateResolution?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(readAbortedError());
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return Promise.reject(readDeadlineError());

  let pending: Promise<T>;
  try {
    pending = operation();
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      reject(readDeadlineError());
    }, remainingMs);
    timer.unref?.();
    const onAbort = () => {
      settled = true;
      cleanup();
      reject(readAbortedError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        if (settled) {
          if (onLateResolution)
            void Promise.resolve(onLateResolution(value)).catch(() => undefined);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function closeAsyncIterator(source: AsyncIterable<Uint8Array>): void {
  try {
    const iterator = source[Symbol.asyncIterator]();
    const closing = iterator.return?.();
    if (closing) void Promise.resolve(closing).catch(() => undefined);
  } catch {
    // A late source result is already outside the response deadline.
  }
}

function boundedFilePath(options: PropertyKnowledgeFileSourceOptions): string {
  if (!options.filePath || options.filePath.includes('\0') || !isAbsolute(options.filePath)) {
    throw new Error('property knowledge source path must be an absolute server path');
  }
  const filePath = resolve(options.filePath);
  if (!options.allowedRoot) return filePath;

  if (options.allowedRoot.includes('\0') || !isAbsolute(options.allowedRoot)) {
    throw new Error('property knowledge source root must be an absolute server path');
  }
  const root = resolve(options.allowedRoot);
  const withinRoot = relative(root, filePath);
  if (
    !withinRoot ||
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  ) {
    throw new Error('property knowledge source path is outside its server-owned root');
  }
  return filePath;
}

function issue(
  code: PropertyKnowledgeIssueCode,
  detail: string | null = null,
): PropertyKnowledgeIssue {
  return propertyKnowledgeIssueSchema.parse({ code, detail });
}

function uniqueIssues(issues: readonly PropertyKnowledgeIssue[]): PropertyKnowledgeIssue[] {
  const seen = new Set<string>();
  return issues.filter((entry) => {
    const key = `${entry.code}\0${entry.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedIssues(issues: readonly PropertyKnowledgeIssue[]): PropertyKnowledgeIssue[] {
  const unique = uniqueIssues(issues);
  if (unique.length <= PROPERTY_KNOWLEDGE_MAX_ISSUES) return unique;
  return [
    ...unique.slice(0, PROPERTY_KNOWLEDGE_MAX_ISSUES - 1),
    issue('RESULT_TRUNCATED', 'additional result issues were omitted'),
  ];
}

function result(input: {
  propertyRef: string;
  status: PropertyKnowledgeReadResult['status'];
  data: PropertyKnowledgeData | null;
  evidence?: readonly PropertyKnowledgeEvidence[];
  issues?: readonly PropertyKnowledgeIssue[];
}): PropertyKnowledgeReadResult {
  return propertyKnowledgeReadResultSchema.parse({
    toolId: PROPERTY_KNOWLEDGE_TOOL_ID,
    schemaVersion: PROPERTY_KNOWLEDGE_CONTRACT_VERSION,
    status: input.status,
    scopeRef: input.propertyRef,
    data: input.data,
    evidence: input.evidence ?? [],
    issues: boundedIssues(input.issues ?? []),
  });
}

function safeDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeExpiry(now: Date, effectiveUntil: string | null): string {
  if (effectiveUntil !== null) return effectiveUntil;
  return new Date(now.getTime() + DEFAULT_FRESHNESS_MS).toISOString();
}

function audienceAllows(
  requested: PropertyKnowledgeAudience,
  entry: PropertyKnowledgeSourceRecord,
): boolean {
  return requested === 'staff' || entry.audience === 'customer_disclosable';
}

function documentIssue(status: PropertyKnowledgeDocumentCheckStatus): PropertyKnowledgeIssue {
  switch (status) {
    case 'changed':
      return issue('DOCUMENT_CHANGED');
    case 'expired':
      return issue('DOCUMENT_EXPIRED');
    case 'unauthorized':
      return issue('DOCUMENT_UNAUTHORIZED');
    case 'missing':
      return issue('DOCUMENT_MISSING');
    case 'blocked':
      return issue('DOCUMENT_REVALIDATION_UNAVAILABLE');
    case 'current':
      return issue('DOCUMENT_REVALIDATION_UNAVAILABLE', 'unexpected current-document blocker');
  }
}

async function revalidateWithExistingDocumentService(input: {
  service: ExistingDocumentServiceLike;
  documentRef: string;
  propertyRef: string;
  sourceKind: PropertyKnowledgeSourceRecord['sourceKind'];
  sourceHash: string;
  now: Date;
}): Promise<PropertyKnowledgeDocumentCheck> {
  try {
    const read = await input.service.documents_read_existing({
      documentRef: input.documentRef,
      format: 'text',
    });
    if (read.blocker === 'DOCUMENT_CHANGED') return { status: 'changed' };
    if (read.blocker === 'SCOPE_DENIED') return { status: 'unauthorized' };
    const data = read.data;
    if (!data) return { status: 'blocked', detail: read.blocker ?? 'document data unavailable' };

    const expectedSource =
      input.sourceKind === 'mail_attachment' ? 'mail_attachment' : 'approved_property_document';
    if (
      data.document.documentRef !== input.documentRef ||
      data.document.source !== expectedSource ||
      data.document.propertyRef !== input.propertyRef
    ) {
      return { status: 'unauthorized', detail: 'linked document identity is not bound' };
    }
    if (data.validation.identity === 'mismatch') {
      return { status: 'unauthorized', detail: 'linked document property identity mismatched' };
    }
    if (data.validation.version !== 'current' || !data.document.currentVersion) {
      return { status: 'expired' };
    }
    if (read.status !== 'ok' || read.blocker !== null || read.issues.length > 0) {
      return { status: 'blocked', detail: read.blocker ?? 'linked document read was not current' };
    }
    if (data.document.sha256 !== input.sourceHash || data.sourceHash !== input.sourceHash) {
      return { status: 'changed', detail: 'linked document bytes no longer match source hash' };
    }
    if (
      data.validation.priceVisibility !== 'allowed' ||
      !documentValidationIsUsable(data.validation) ||
      data.document.retrievalBlocker !== null ||
      data.extractionState !== 'complete' ||
      data.text === null
    ) {
      return { status: 'blocked', detail: read.blocker ?? 'linked document disclosure is blocked' };
    }
    return {
      status: 'current',
      expiresAt:
        data.artifactExpiresAt ??
        new Date(input.now.getTime() + DEFAULT_FRESHNESS_MS).toISOString(),
    };
  } catch {
    return { status: 'blocked', detail: 'linked document validation failed' };
  }
}

type PathIdentity = { dev: number; ino: number };

type LocalPathCheck = {
  file: PathIdentity;
  resolvedFile: string;
  root?: PathIdentity;
  resolvedRoot?: string;
};

function pathIdentity(stat: { dev: number; ino: number }): PathIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertWithinRoot(resolvedRoot: string, resolvedFile: string): void {
  const withinRoot = relative(resolvedRoot, resolvedFile);
  if (
    !withinRoot ||
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  ) {
    throw new Error('property knowledge source file resolves outside its server-owned root');
  }
}

async function assertLocalKnowledgeFilePath(
  filePath: string,
  allowedRoot: string | undefined,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<LocalPathCheck> {
  const fileStat = await withReadDeadline(() => lstat(filePath), signal, deadlineAt);
  if (fileStat.isSymbolicLink()) {
    throw new Error('property knowledge source file must not be a symbolic link');
  }
  const resolvedFile = await withReadDeadline(() => realpath(filePath), signal, deadlineAt);
  if (!allowedRoot) return { file: pathIdentity(fileStat), resolvedFile };
  const resolvedRoot = await withReadDeadline(() => realpath(allowedRoot), signal, deadlineAt);
  assertWithinRoot(resolvedRoot, resolvedFile);
  const rootStat = await withReadDeadline(() => lstat(resolvedRoot), signal, deadlineAt);
  return {
    file: pathIdentity(fileStat),
    resolvedFile,
    root: pathIdentity(rootStat),
    resolvedRoot,
  };
}

async function assertOpenedKnowledgeFileIdentity(
  filePath: string,
  allowedRoot: string | undefined,
  openedFile: PathIdentity,
  initial: LocalPathCheck,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<void> {
  const currentFile = await withReadDeadline(() => lstat(filePath), signal, deadlineAt);
  if (currentFile.isSymbolicLink() || !samePathIdentity(pathIdentity(currentFile), openedFile)) {
    throw new Error('property knowledge source file changed during open');
  }
  const currentResolvedFile = await withReadDeadline(() => realpath(filePath), signal, deadlineAt);
  if (currentResolvedFile !== initial.resolvedFile) {
    throw new Error('property knowledge source file path changed during open');
  }
  if (!allowedRoot || !initial.resolvedRoot || !initial.root) return;
  const currentResolvedRoot = await withReadDeadline(
    () => realpath(allowedRoot),
    signal,
    deadlineAt,
  );
  if (currentResolvedRoot !== initial.resolvedRoot) {
    throw new Error('property knowledge source root changed during open');
  }
  const currentRoot = await withReadDeadline(() => lstat(currentResolvedRoot), signal, deadlineAt);
  if (!samePathIdentity(pathIdentity(currentRoot), initial.root)) {
    throw new Error('property knowledge source root identity changed during open');
  }
  assertWithinRoot(currentResolvedRoot, currentResolvedFile);
}

async function* readLocalKnowledgeFile(
  filePath: string,
  allowedRoot: string | undefined,
  signal: AbortSignal,
  maxBytes: number,
  deadlineMs: number,
): AsyncGenerator<Uint8Array> {
  if (signal.aborted) throw readAbortedError();
  const deadlineAt = Date.now() + deadlineMs;
  const initialPath = await assertLocalKnowledgeFilePath(filePath, allowedRoot, signal, deadlineAt);
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await withReadDeadline(
    () => open(filePath, flags),
    signal,
    deadlineAt,
    (late) => late.close(),
  );
  try {
    const stat = await withReadDeadline(() => handle.stat(), signal, deadlineAt);
    if (!stat.isFile()) {
      throw new Error('property knowledge source file exceeds the bounded size');
    }
    const openedIdentity = pathIdentity(stat);
    if (!samePathIdentity(openedIdentity, initialPath.file)) {
      throw new Error('property knowledge source file changed before read');
    }
    await assertOpenedKnowledgeFileIdentity(
      filePath,
      allowedRoot,
      openedIdentity,
      initialPath,
      signal,
      deadlineAt,
    );
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
    let total = 0;
    while (true) {
      if (signal.aborted) throw readAbortedError();
      const { bytesRead } = await withReadDeadline(
        () => handle.read(buffer, 0, buffer.length, null),
        signal,
        deadlineAt,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error('property knowledge source file exceeds the bounded size');
      }
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  } finally {
    const closing = handle.close();
    try {
      await withReadDeadline(() => closing, signal, deadlineAt);
    } catch {
      void closing.catch(() => undefined);
      // The close was still initiated; a pathological filesystem close must
      // not extend the bounded response beyond the source deadline.
    }
  }
}

async function collectBoundedKnowledgeSource(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  maxBytes: number,
  deadlineAt: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await withReadDeadline(() => iterator.next(), signal, deadlineAt);
      if (next.done) {
        completed = true;
        break;
      }
      const chunk = next.value;
      if (signal.aborted) throw readAbortedError();
      if (!(chunk instanceof Uint8Array)) {
        throw new Error('property knowledge source did not return byte chunks');
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error('property knowledge source exceeds the bounded size');
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    if (!completed) {
      try {
        const closing = iterator.return?.();
        if (closing) void Promise.resolve(closing).catch(() => undefined);
      } catch {
        // The source may be a late/failed adapter; the bounded result is already closed.
      }
    }
  }
  if (signal.aborted) throw readAbortedError();
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Load a closed, versioned property source from a server-owned local file.
 * The path and optional object-reader are captured during server composition;
 * neither can be supplied by the model-facing request.
 */
export function createPropertyKnowledgeFileSource(
  options: PropertyKnowledgeFileSourceOptions,
): PropertyKnowledgeSource {
  const filePath = boundedFilePath(options);
  const maxBytes = options.maxBytes ?? PROPERTY_KNOWLEDGE_MAX_FILE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > PROPERTY_KNOWLEDGE_MAX_FILE_BYTES) {
    throw new Error('property knowledge source maxBytes is outside the bounded limit');
  }
  const deadlineMs = options.deadlineMs ?? DEFAULT_SOURCE_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DEFAULT_SOURCE_DEADLINE_MS) {
    throw new Error('property knowledge source deadline is outside the bounded limit');
  }
  const readFile =
    options.readFile ??
    (async (input) =>
      readLocalKnowledgeFile(
        input.filePath,
        input.allowedRoot,
        input.signal,
        input.maxBytes,
        input.deadlineMs ?? DEFAULT_SOURCE_DEADLINE_MS,
      ));

  return {
    async list(input) {
      if (input.signal.aborted) throw readAbortedError();
      const deadlineAt = Date.now() + deadlineMs;
      const stream = await withReadDeadline(
        () =>
          readFile({
            filePath,
            allowedRoot: options.allowedRoot,
            signal: input.signal,
            maxBytes,
            deadlineMs,
          }),
        input.signal,
        deadlineAt,
        closeAsyncIterator,
      );
      const raw = await collectBoundedKnowledgeSource(stream, input.signal, maxBytes, deadlineAt);

      let parsedFile: ReturnType<typeof propertyKnowledgeFileSchema.parse>;
      try {
        parsedFile = propertyKnowledgeFileSchema.parse(JSON.parse(raw));
      } catch {
        throw new Error('property knowledge source file is invalid');
      }
      if (parsedFile.entries.some((entry) => entry.propertyRef !== parsedFile.propertyRef)) {
        throw new Error('property knowledge source file has inconsistent property binding');
      }
      return parsedFile.entries.filter((record) => record.topic === input.topic);
    },
  };
}

function toEntry(record: PropertyKnowledgeSourceRecord): PropertyKnowledgeEntry {
  return {
    entryRef: record.entryRef,
    topic: record.topic,
    content: record.content,
    sourceKind: record.sourceKind,
    sourceRef: record.sourceRef,
    sourceHash: record.sourceHash,
    version: record.version,
    ownerRef: record.ownerRef,
    approval: record.approval,
    approvedAt: record.approvedAt ?? record.approval.approvedAt!,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
    propertyRef: record.propertyRef,
    audience: record.audience,
    documentRefs: [...record.documentRefs],
  };
}

function toEvidence(
  record: PropertyKnowledgeSourceRecord,
  now: Date,
  expiresAt: string,
): PropertyKnowledgeEvidence {
  // The reader only calls this after proving approvedAt is present.
  return {
    sourceRef: record.sourceRef,
    sourceHash: record.sourceHash,
    version: record.version,
    ownerRef: record.ownerRef,
    approvedAt: record.approval.approvedAt!,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
    observedAt: now.toISOString(),
    expiresAt,
    documentRefs: [...record.documentRefs],
  };
}

function makeData(input: {
  propertyRef: string;
  audience: PropertyKnowledgeAudience;
  topic: PropertyKnowledgeTopic;
  entries: readonly PropertyKnowledgeEntry[];
  conflicts?: readonly PropertyKnowledgeData['conflicts'][number][];
}): PropertyKnowledgeData {
  return propertyKnowledgeDataSchema.parse({
    scope: PROPERTY_KNOWLEDGE_SCOPE,
    propertyRef: input.propertyRef,
    audience: input.audience,
    topic: input.topic,
    entries: input.entries,
    conflicts: input.conflicts ?? [],
  });
}

/**
 * Adapt already-resolved local records to the reader source interface. This
 * helper has no network/storage behavior and is intended for deterministic
 * local fixtures or a caller's existing storage adapter.
 */
export function createPropertyKnowledgeSource(
  records: readonly PropertyKnowledgeSourceRecord[],
): PropertyKnowledgeSource {
  const parsed = records.map((record) => propertyKnowledgeSourceRecordSchema.parse(record));
  return {
    async list(input) {
      if (input.signal.aborted) {
        throw readAbortedError();
      }
      // Keep property filtering in the reader so an unauthorized cross-property
      // row can become an explicit scope mismatch rather than a guessed absence.
      return parsed.filter((record) => record.topic === input.topic);
    },
  };
}

export function createPropertyKnowledgeReader(
  options: PropertyKnowledgeReaderOptions,
): PropertyKnowledgeReader {
  const nowFactory = options.now ?? (() => new Date());
  const defaultPropertyRef = options.defaultPropertyRef;
  const defaultAudience = options.defaultAudience ?? 'customer';
  const authorizationAdapter = options.authorization ?? options.authorize;

  return {
    async read(rawRequest, rawContext = {}) {
      const request = propertyKnowledgeReadRequestSchema.parse(rawRequest);
      const propertyRef = rawContext.propertyRef ?? defaultPropertyRef;
      const audience = rawContext.audience ?? defaultAudience;
      const now = rawContext.now ?? nowFactory();
      const signal = rawContext.signal ?? new AbortController().signal;
      if (!propertyRef) {
        return result({
          propertyRef: 'unknown-property',
          status: 'unavailable',
          data: null,
          issues: [issue('AUTHORIZATION_UNAVAILABLE', 'property scope was not supplied')],
        });
      }
      if (!Number.isFinite(now.getTime())) {
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: [issue('SOURCE_UNAVAILABLE', 'invalid observation time')],
        });
      }
      if (signal.aborted) {
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: [issue('READ_ABORTED')],
        });
      }

      let authorizationResult: { granted: boolean; reason?: string };
      if (!authorizationAdapter) {
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: [issue('AUTHORIZATION_UNAVAILABLE', 'no server authorization adapter')],
        });
      }
      try {
        const authorize =
          typeof authorizationAdapter === 'function'
            ? authorizationAdapter
            : authorizationAdapter.authorize.bind(authorizationAdapter);
        authorizationResult = await authorize({
          propertyRef,
          topic: request.topic,
          detail: request.detail,
          audience,
          now,
          signal,
        });
      } catch {
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: [issue('AUTHORIZATION_UNAVAILABLE')],
        });
      }
      if (!authorizationResult.granted) {
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: [issue('AUTHORIZATION_DENIED', authorizationResult.reason ?? null)],
        });
      }

      let rawRecords: readonly PropertyKnowledgeSourceRecord[];
      try {
        rawRecords = await options.source.list({
          propertyRef,
          topic: request.topic,
          detail: request.detail,
          now,
          signal,
        });
      } catch (error) {
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: [
            issue(
              error instanceof Error && error.name === 'AbortError'
                ? 'READ_ABORTED'
                : 'SOURCE_UNAVAILABLE',
            ),
          ],
        });
      }
      if (!Array.isArray(rawRecords)) {
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: [issue('SOURCE_UNAVAILABLE', 'source returned a non-list result')],
        });
      }

      const records: PropertyKnowledgeSourceRecord[] = [];
      const validationIssues: PropertyKnowledgeIssue[] = [];
      for (const rawRecord of rawRecords) {
        const parsed = propertyKnowledgeSourceRecordSchema.safeParse(rawRecord);
        if (!parsed.success) {
          validationIssues.push(issue('INVALID_SOURCE_RECORD'));
          continue;
        }
        if (digestContent(parsed.data.content) !== parsed.data.sourceHash) {
          validationIssues.push(issue('SOURCE_HASH_MISMATCH', parsed.data.sourceRef));
          continue;
        }
        records.push(parsed.data);
      }
      if (records.length === 0) {
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: [...validationIssues, issue('TOPIC_UNAVAILABLE')],
        });
      }

      const propertyRecords = records.filter((record) => record.propertyRef === propertyRef);
      if (propertyRecords.length === 0) {
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: [...validationIssues, issue('PROPERTY_SCOPE_MISMATCH')],
        });
      }

      const currentApproved: Array<{
        record: PropertyKnowledgeSourceRecord;
        documentExpiry: string;
      }> = [];
      const issues: PropertyKnowledgeIssue[] = [...validationIssues];
      const deferredIssues: PropertyKnowledgeIssue[] = [];
      for (const record of propertyRecords) {
        if (record.approval.status !== 'approved' || record.approval.approvedAt === null) {
          deferredIssues.push(issue('POLICY_UNAPPROVED', record.sourceRef));
          continue;
        }
        const approvedAt = safeDate(record.approval.approvedAt);
        const effectiveFrom = safeDate(record.effectiveFrom);
        const effectiveUntil =
          record.effectiveUntil === null ? null : safeDate(record.effectiveUntil);
        if (
          approvedAt === null ||
          approvedAt > now.getTime() ||
          effectiveFrom === null ||
          effectiveFrom > now.getTime()
        ) {
          deferredIssues.push(issue('KNOWLEDGE_NOT_YET_EFFECTIVE', record.sourceRef));
          continue;
        }
        if (effectiveUntil !== null && effectiveUntil <= now.getTime()) {
          deferredIssues.push(issue('KNOWLEDGE_EXPIRED', record.sourceRef));
          continue;
        }
        if (!audienceAllows(audience, record)) {
          deferredIssues.push(issue('AUDIENCE_NOT_AUTHORIZED', record.sourceRef));
          continue;
        }
        if (record.content.length > PROPERTY_KNOWLEDGE_MAX_CONTENT_CHARS) {
          deferredIssues.push(issue('CONTENT_LIMIT', record.sourceRef));
          continue;
        }
        if (hasPaymentSecret(record.content)) {
          deferredIssues.push(issue('PAYMENT_SECRET_REDACTED', record.sourceRef));
          continue;
        }

        let documentExpiry = safeExpiry(now, record.effectiveUntil);
        let documentBlocked = false;
        for (const documentRef of record.documentRefs) {
          let check: PropertyKnowledgeDocumentCheck;
          try {
            // The configured ExistingDocumentService is the authoritative
            // document path. A callback is only a local adapter when no
            // native authority was composed; it can never override a native
            // blocked/changed result.
            if (options.existingDocumentService) {
              check = await revalidateWithExistingDocumentService({
                service: options.existingDocumentService,
                documentRef,
                propertyRef,
                sourceKind: record.sourceKind,
                sourceHash: record.sourceHash,
                now,
              });
            } else if (options.revalidateDocument) {
              check = await options.revalidateDocument({
                documentRef,
                propertyRef,
                sourceRef: record.sourceRef,
                now,
                signal,
              });
            } else {
              check = { status: 'missing' };
              issues.push(issue('DOCUMENT_REVALIDATION_UNAVAILABLE', documentRef));
            }
          } catch {
            check = { status: 'missing' };
          }
          if (check.status !== 'current') {
            issues.push(documentIssue(check.status));
            documentBlocked = true;
            continue;
          }
          if (check.expiresAt) {
            const expiry = safeDate(check.expiresAt);
            if (expiry === null || expiry <= now.getTime()) {
              issues.push(issue('DOCUMENT_EXPIRED', documentRef));
              documentBlocked = true;
              continue;
            }
            if (expiry < Date.parse(documentExpiry)) documentExpiry = check.expiresAt;
          }
        }
        if (!documentBlocked) currentApproved.push({ record, documentExpiry });
      }

      if (currentApproved.length === 0) {
        const unavailableIssues = [...issues, ...deferredIssues];
        const hasTemporalOrPolicyEvidence = unavailableIssues.some((entry) =>
          [
            'POLICY_UNAPPROVED',
            'KNOWLEDGE_NOT_YET_EFFECTIVE',
            'KNOWLEDGE_EXPIRED',
            'AUDIENCE_NOT_AUTHORIZED',
            'PAYMENT_SECRET_REDACTED',
            'DOCUMENT_REVALIDATION_UNAVAILABLE',
            'DOCUMENT_CHANGED',
            'DOCUMENT_EXPIRED',
            'DOCUMENT_UNAUTHORIZED',
            'DOCUMENT_MISSING',
          ].includes(entry.code),
        );
        return result({
          propertyRef,
          status: 'unavailable',
          data: null,
          issues: hasTemporalOrPolicyEvidence
            ? unavailableIssues
            : [...unavailableIssues, issue('TOPIC_UNAVAILABLE')],
        });
      }

      const orderedApproved = [...currentApproved].sort((left, right) => {
        const entryOrder = left.record.entryRef.localeCompare(right.record.entryRef);
        return entryOrder !== 0
          ? entryOrder
          : left.record.sourceRef.localeCompare(right.record.sourceRef);
      });
      const byContent = new Map<string, typeof currentApproved>();
      for (const candidate of orderedApproved) {
        const key = digestContent(candidate.record.content);
        const group = byContent.get(key) ?? [];
        group.push(candidate);
        byContent.set(key, group);
      }
      if (byContent.size > 1) {
        const conflictTruncated = orderedApproved.length > PROPERTY_KNOWLEDGE_MAX_ENTRIES;
        const conflict = {
          topic: request.topic,
          entryRefs: orderedApproved
            .slice(0, PROPERTY_KNOWLEDGE_MAX_ENTRIES)
            .map(({ record }) => record.entryRef),
          sourceRefs: orderedApproved
            .slice(0, PROPERTY_KNOWLEDGE_MAX_ENTRIES)
            .map(({ record }) => record.sourceRef),
        };
        const data = makeData({
          propertyRef,
          audience,
          topic: request.topic,
          entries: [],
          conflicts: [conflict],
        });
        return result({
          propertyRef,
          status: 'ambiguous',
          data,
          evidence: [],
          issues: [
            ...issues,
            issue('CONFLICTING_APPROVED_SOURCES'),
            ...(conflictTruncated ? [issue('RESULT_TRUNCATED')] : []),
          ],
        });
      }

      const entriesTruncated = orderedApproved.length > PROPERTY_KNOWLEDGE_MAX_ENTRIES;
      const entries = orderedApproved
        .slice(0, PROPERTY_KNOWLEDGE_MAX_ENTRIES)
        .map(({ record: entry }) => toEntry(entry));
      const evidence = orderedApproved
        .slice(0, PROPERTY_KNOWLEDGE_MAX_ENTRIES)
        .map(({ record: entry, documentExpiry }) => toEvidence(entry, now, documentExpiry));
      const data = makeData({ propertyRef, audience, topic: request.topic, entries });
      const outputIssues = [...issues, ...(entriesTruncated ? [issue('RESULT_TRUNCATED')] : [])];
      return result({
        propertyRef,
        status: outputIssues.length > 0 ? 'partial' : 'ok',
        data,
        evidence,
        issues: outputIssues,
      });
    },
  };
}

/** Small functional adapter useful to non-class callers and tests. */
export function readPropertyKnowledge(
  reader: PropertyKnowledgeReader,
  request: PropertyKnowledgeReadRequest,
  context?: PropertyKnowledgeReadContextInput,
): Promise<PropertyKnowledgeReadResult> {
  return reader.read(request, context);
}
