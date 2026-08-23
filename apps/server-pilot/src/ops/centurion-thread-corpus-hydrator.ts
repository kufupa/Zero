import {
  ARTIFACT_MAX_INPUT_BYTES,
  ARTIFACT_MAX_OUTPUT_BYTES,
  extractEmbeddedPdfText,
  type SandboxRunner,
} from '../mail/artifacts/read-artifact.js';
import { DEFAULT_MAX_MESSAGE_BYTES } from '../mail/ingest/limits.js';
import { S3ObjectTooLargeError, type S3Storage } from '../storage/s3.js';
import type {
  FormattedLogicalMessages,
  ThreadCorpusAttachmentLocator,
  ThreadCorpusHydrationInput,
  ThreadCorpusHydrationPayload,
} from '../../scripts/export-thread-corpus.js';

export type ThreadCorpusHydrationLimits = Readonly<{
  maxRawMimeBytes: number;
  maxAttachmentInputBytes: number;
  maxAttachmentTextBytes: number;
  maxTotalArtifactBytes: number;
  perObjectTimeoutMs: number;
  perObjectAbortGraceMs: number;
}>;

export const DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS = Object.freeze({
  maxRawMimeBytes: DEFAULT_MAX_MESSAGE_BYTES,
  maxAttachmentInputBytes: ARTIFACT_MAX_INPUT_BYTES,
  maxAttachmentTextBytes: ARTIFACT_MAX_OUTPUT_BYTES,
  maxTotalArtifactBytes: 256 * 1024 * 1024,
  perObjectTimeoutMs: 15_000,
  perObjectAbortGraceMs: 250,
} as const);

type RawMimeSource = {
  sourceRowId: string;
  locator: string;
  status: 'pending_hydration' | 'available';
};

type ValidatedRequest = {
  attachmentLocators: ThreadCorpusAttachmentLocator[];
  limits: ThreadCorpusHydrationLimits;
  pdfExtractor: typeof extractEmbeddedPdfText;
  pdfRunner: SandboxRunner | undefined;
  rawMimeSources: RawMimeSource[];
  storage: Pick<S3Storage, 'getObjectBounded'>;
};

type BoundedResult<T> =
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; error: unknown }
  | { state: 'deadline' };

type RawMimeResult = {
  payload: Extract<ThreadCorpusHydrationPayload, { kind: 'raw_mime' }>;
  retainedBytes: number;
};

type AttachmentResult = {
  payload: Extract<ThreadCorpusHydrationPayload, { kind: 'attachment_text' }>;
  retainedBytes: number;
};

const INVALID_INPUT_ERROR = 'Invalid thread corpus hydration input';
const STOPPED_ERROR = 'Thread corpus hydration stopped';

const RAW_MIME_SOURCE_STATUSES = new Set([
  'available',
  'missing',
  'expired_or_missing',
  'too_large',
  'budget_exhausted',
  'read_failed',
  'not_recorded',
  'not_recorded_outbound',
  'parse_failed',
  'not_applicable',
  'pending_hydration',
]);

const ATTACHMENT_TEXT_STATUSES = new Set([
  'expired_or_missing',
  'too_large',
  'unsupported',
  'encrypted',
  'no_embedded_text',
  'malformed',
  'too_many_pages',
  'timeout',
  'parser_failure',
  'read_failed',
  'budget_exhausted',
]);

const LIMIT_KEYS = [
  'maxRawMimeBytes',
  'maxAttachmentInputBytes',
  'maxAttachmentTextBytes',
  'maxTotalArtifactBytes',
  'perObjectTimeoutMs',
  'perObjectAbortGraceMs',
] as const;

type LimitKey = (typeof LIMIT_KEYS)[number];

function invalidHydrationInput(): never {
  throw new Error(INVALID_INPUT_ERROR);
}

function hydrationStopped(): never {
  throw new Error(STOPPED_ERROR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function cloneLocator(locator: ThreadCorpusAttachmentLocator): ThreadCorpusAttachmentLocator {
  return {
    attachmentId: locator.attachmentId,
    messageId: locator.messageId,
    s3Key: locator.s3Key,
    mimeType: locator.mimeType,
    sizeBytes: locator.sizeBytes,
  };
}

function isAttachmentLocator(value: unknown): value is ThreadCorpusAttachmentLocator {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['attachmentId', 'messageId', 's3Key', 'mimeType', 'sizeBytes']) &&
    isNonEmptyString(value.attachmentId) &&
    isNonEmptyString(value.messageId) &&
    isNonEmptyString(value.s3Key) &&
    typeof value.mimeType === 'string' &&
    isNonNegativeSafeInteger(value.sizeBytes)
  );
}

function isAttachmentDescriptor(value: unknown): value is {
  id: string;
  messageId: string;
  filename: string;
  contentType: string;
  byteSize: number;
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'messageId', 'filename', 'contentType', 'byteSize']) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.messageId) &&
    typeof value.filename === 'string' &&
    typeof value.contentType === 'string' &&
    isNonNegativeSafeInteger(value.byteSize)
  );
}

function formattedSourceRows(formatted: unknown): unknown[] {
  if (!isRecord(formatted) || !Array.isArray(formatted.threads) || !Array.isArray(formatted.quarantineRecords)) {
    return invalidHydrationInput();
  }

  const rows: unknown[] = [];
  for (const thread of formatted.threads) {
    if (!isRecord(thread) || !Array.isArray(thread.messages)) invalidHydrationInput();
    for (const message of thread.messages) {
      if (!isRecord(message) || !Array.isArray(message.sourceRows)) invalidHydrationInput();
      rows.push(...message.sourceRows);
    }
  }
  for (const record of formatted.quarantineRecords) {
    if (!isRecord(record) || !Array.isArray(record.sourceRows)) invalidHydrationInput();
    rows.push(...record.sourceRows);
  }
  return rows;
}

function resolveLimits(value: unknown): ThreadCorpusHydrationLimits {
  try {
    if (value === undefined) {
      return Object.freeze({ ...DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS });
    }
    if (!isPlainRecord(value)) return invalidHydrationInput();

    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' || !LIMIT_KEYS.includes(key as LimitKey),
      )
    ) {
      return invalidHydrationInput();
    }

    const overrides: Partial<Record<LimitKey, number>> = {};
    for (const key of LIMIT_KEYS) {
      if (!Object.hasOwn(value, key)) continue;
      if (!isPositiveSafeInteger(value[key])) return invalidHydrationInput();
      overrides[key] = value[key] as number;
    }

    return Object.freeze({
      maxRawMimeBytes: overrides.maxRawMimeBytes ?? DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS.maxRawMimeBytes,
      maxAttachmentInputBytes:
        overrides.maxAttachmentInputBytes ??
        DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS.maxAttachmentInputBytes,
      maxAttachmentTextBytes:
        overrides.maxAttachmentTextBytes ??
        DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS.maxAttachmentTextBytes,
      maxTotalArtifactBytes:
        overrides.maxTotalArtifactBytes ??
        DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS.maxTotalArtifactBytes,
      perObjectTimeoutMs:
        overrides.perObjectTimeoutMs ?? DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS.perObjectTimeoutMs,
      perObjectAbortGraceMs:
        overrides.perObjectAbortGraceMs ??
        DEFAULT_THREAD_CORPUS_HYDRATION_LIMITS.perObjectAbortGraceMs,
    });
  } catch {
    return invalidHydrationInput();
  }
}

function normalizeMimeToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function normalizeText(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .split('\u0000')
    .join('')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function waitFor(milliseconds: number): Promise<'grace_elapsed'> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('grace_elapsed'), milliseconds);
  });
}

async function runBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  limits: ThreadCorpusHydrationLimits,
): Promise<BoundedResult<T>> {
  const controller = new AbortController();
  const deadlineSignal = AbortSignal.timeout(limits.perObjectTimeoutMs);
  const signal = AbortSignal.any([controller.signal, deadlineSignal]);
  const pending = Promise.resolve().then(() => operation(signal));
  void pending.catch(() => undefined);
  const settled = pending.then(
    (value): BoundedResult<T> => ({ state: 'fulfilled', value }),
    (error): BoundedResult<T> => ({ state: 'rejected', error }),
  );
  const deadline = new Promise<'deadline_elapsed'>((resolve) => {
    if (deadlineSignal.aborted) {
      resolve('deadline_elapsed');
      return;
    }
    deadlineSignal.addEventListener('abort', () => resolve('deadline_elapsed'), { once: true });
  });
  const first = await Promise.race([settled, deadline]);
  if (first !== 'deadline_elapsed' && !deadlineSignal.aborted) return first;

  controller.abort();
  const afterAbort = await Promise.race([settled, waitFor(limits.perObjectAbortGraceMs)]);
  if (afterAbort === 'grace_elapsed') {
    void pending.catch(() => undefined);
    return hydrationStopped();
  }
  return { state: 'deadline' };
}

function bytesFrom(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? new Uint8Array(value) : null;
}

function rawMimePayload(
  sourceRowId: string,
  status: Exclude<Extract<ThreadCorpusHydrationPayload, { kind: 'raw_mime' }>['status'], 'available'>,
): RawMimeResult {
  return {
    payload: { kind: 'raw_mime', sourceRowId, status },
    retainedBytes: 0,
  };
}

function attachmentPayload(
  attachmentId: string,
  status: Exclude<
    Extract<ThreadCorpusHydrationPayload, { kind: 'attachment_text' }>['status'],
    'available'
  >,
): AttachmentResult {
  return {
    payload: { kind: 'attachment_text', attachmentId, status },
    retainedBytes: 0,
  };
}

function availableAttachmentText(
  attachmentId: string,
  text: string,
  remainingBytes: number,
  limits: ThreadCorpusHydrationLimits,
): AttachmentResult {
  const normalized = normalizeText(text);
  if (!normalized) return attachmentPayload(attachmentId, 'no_embedded_text');
  const content = new Uint8Array(Buffer.from(normalized, 'utf8'));
  if (content.byteLength > limits.maxAttachmentTextBytes) {
    return attachmentPayload(attachmentId, 'too_large');
  }
  if (content.byteLength > remainingBytes) {
    return attachmentPayload(attachmentId, 'budget_exhausted');
  }
  return {
    payload: { kind: 'attachment_text', attachmentId, status: 'available', content },
    retainedBytes: content.byteLength,
  };
}

function isRawMimeKey(value: string): boolean {
  return value.startsWith('raw-mime/') || value.startsWith('quarantine-archive/');
}

function isAttachmentKey(locator: ThreadCorpusAttachmentLocator): boolean {
  return locator.s3Key.startsWith(`attachments/${locator.messageId}/`);
}

function validatedRequest(input: unknown): ValidatedRequest {
  try {
    if (!isRecord(input)) return invalidHydrationInput();
    if (
      !isRecord(input.storage) ||
      typeof input.storage.getObjectBounded !== 'function' ||
      !Array.isArray(input.attachmentLocators) ||
      (input.pdfRunner !== undefined && typeof input.pdfRunner !== 'function') ||
      (input.pdfExtractor !== undefined && typeof input.pdfExtractor !== 'function')
    ) {
      return invalidHydrationInput();
    }

    const limits = resolveLimits(input.limits);
    const sourceRows = formattedSourceRows(input.formatted);
    const sourceRowIds = new Set<string>();
    const rawLocators = new Set<string>();
    const rawMimeSources: RawMimeSource[] = [];
    const attachmentDescriptors = new Map<
      string,
      { messageId: string; contentType: string; byteSize: number }
    >();

    for (const sourceRow of sourceRows) {
      if (!isRecord(sourceRow) || !isNonEmptyString(sourceRow.sourceRowId)) {
        return invalidHydrationInput();
      }
      if (sourceRowIds.has(sourceRow.sourceRowId)) return invalidHydrationInput();
      sourceRowIds.add(sourceRow.sourceRowId);
      if (!Object.hasOwn(sourceRow, 'privateMessage')) continue;
      if (!isRecord(sourceRow.privateMessage)) return invalidHydrationInput();

      const rawMime = sourceRow.privateMessage.rawMime;
      if (
        !isRecord(rawMime) ||
        !hasExactKeys(rawMime, ['locator', 'status']) ||
        (typeof rawMime.locator !== 'string' && rawMime.locator !== null) ||
        typeof rawMime.status !== 'string' ||
        !RAW_MIME_SOURCE_STATUSES.has(rawMime.status) ||
        (rawMime.status === 'missing' && rawMime.locator !== null) ||
        !Array.isArray(sourceRow.privateMessage.attachments)
      ) {
        return invalidHydrationInput();
      }
      if (rawMime.status === 'pending_hydration' || rawMime.status === 'available') {
        if (!isNonEmptyString(rawMime.locator) || rawLocators.has(rawMime.locator)) {
          return invalidHydrationInput();
        }
        rawLocators.add(rawMime.locator);
        rawMimeSources.push({
          sourceRowId: sourceRow.sourceRowId,
          locator: rawMime.locator,
          status: rawMime.status,
        });
      }

      for (const descriptor of sourceRow.privateMessage.attachments) {
        if (
          !isAttachmentDescriptor(descriptor) ||
          descriptor.messageId !== sourceRow.sourceRowId ||
          attachmentDescriptors.has(descriptor.id)
        ) {
          return invalidHydrationInput();
        }
        attachmentDescriptors.set(descriptor.id, {
          messageId: descriptor.messageId,
          contentType: descriptor.contentType,
          byteSize: descriptor.byteSize,
        });
      }
    }

    const attachmentIds = new Set<string>();
    const attachmentKeys = new Set<string>();
    const attachmentLocators = input.attachmentLocators.map((locator) => {
      if (
        !isAttachmentLocator(locator) ||
        attachmentIds.has(locator.attachmentId) ||
        attachmentKeys.has(locator.s3Key)
      ) {
        return invalidHydrationInput();
      }
      const descriptor = attachmentDescriptors.get(locator.attachmentId);
      if (
        !descriptor ||
        descriptor.messageId !== locator.messageId ||
        descriptor.contentType !== locator.mimeType ||
        descriptor.byteSize !== locator.sizeBytes
      ) {
        return invalidHydrationInput();
      }
      attachmentIds.add(locator.attachmentId);
      attachmentKeys.add(locator.s3Key);
      return cloneLocator(locator);
    });

    return {
      attachmentLocators: attachmentLocators.sort(
        (left, right) =>
          compareText(left.messageId, right.messageId) ||
          compareText(left.attachmentId, right.attachmentId),
      ),
      limits,
      pdfExtractor: (input.pdfExtractor as typeof extractEmbeddedPdfText | undefined) ?? extractEmbeddedPdfText,
      pdfRunner: input.pdfRunner as SandboxRunner | undefined,
      rawMimeSources: rawMimeSources.sort((left, right) =>
        compareText(left.sourceRowId, right.sourceRowId),
      ),
      storage: input.storage as Pick<S3Storage, 'getObjectBounded'>,
    };
  } catch {
    return invalidHydrationInput();
  }
}

async function hydrateRawMime(
  source: RawMimeSource,
  storage: Pick<S3Storage, 'getObjectBounded'>,
  remainingBytes: number,
  limits: ThreadCorpusHydrationLimits,
): Promise<RawMimeResult> {
  if (!isRawMimeKey(source.locator)) return rawMimePayload(source.sourceRowId, 'read_failed');
  if (remainingBytes <= 0) return rawMimePayload(source.sourceRowId, 'budget_exhausted');

  const readLimit = Math.min(limits.maxRawMimeBytes, remainingBytes);
  const tooLargeStatus = (observedBytes: number): 'budget_exhausted' | 'too_large' =>
    readLimit < limits.maxRawMimeBytes && observedBytes <= limits.maxRawMimeBytes
      ? 'budget_exhausted'
      : 'too_large';
  const bounded = await runBounded(
    (signal) => storage.getObjectBounded(source.locator, readLimit, signal),
    limits,
  );
  if (bounded.state === 'deadline') return rawMimePayload(source.sourceRowId, 'read_failed');
  if (bounded.state === 'rejected') {
    if (bounded.error instanceof S3ObjectTooLargeError) {
      return rawMimePayload(
        source.sourceRowId,
        tooLargeStatus(bounded.error.observedBytes),
      );
    }
    return rawMimePayload(source.sourceRowId, 'read_failed');
  }
  if (bounded.value === null) return rawMimePayload(source.sourceRowId, 'expired_or_missing');

  const content = bytesFrom(bounded.value.body);
  if (content === null || content.byteLength === 0) {
    return rawMimePayload(source.sourceRowId, 'read_failed');
  }
  if (content.byteLength > readLimit) {
    return rawMimePayload(
      source.sourceRowId,
      tooLargeStatus(content.byteLength),
    );
  }
  return {
    payload: { kind: 'raw_mime', sourceRowId: source.sourceRowId, status: 'available', content },
    retainedBytes: content.byteLength,
  };
}

async function hydrateAttachment(
  locator: ThreadCorpusAttachmentLocator,
  storage: Pick<S3Storage, 'getObjectBounded'>,
  remainingBytes: number,
  limits: ThreadCorpusHydrationLimits,
  pdfRunner: SandboxRunner | undefined,
  pdfExtractor: typeof extractEmbeddedPdfText,
): Promise<AttachmentResult> {
  if (!isAttachmentKey(locator)) return attachmentPayload(locator.attachmentId, 'read_failed');
  const declaredMime = normalizeMimeToken(locator.mimeType);
  if (declaredMime !== 'text/plain' && declaredMime !== 'application/pdf') {
    return attachmentPayload(locator.attachmentId, 'unsupported');
  }
  if (locator.sizeBytes > limits.maxAttachmentInputBytes) {
    return attachmentPayload(locator.attachmentId, 'too_large');
  }
  if (remainingBytes <= 0) return attachmentPayload(locator.attachmentId, 'budget_exhausted');

  const bounded = await runBounded(
    (signal) => storage.getObjectBounded(locator.s3Key, limits.maxAttachmentInputBytes, signal),
    limits,
  );
  if (bounded.state === 'deadline') return attachmentPayload(locator.attachmentId, 'timeout');
  if (bounded.state === 'rejected') {
    if (bounded.error instanceof S3ObjectTooLargeError) {
      return attachmentPayload(locator.attachmentId, 'too_large');
    }
    return attachmentPayload(
      locator.attachmentId,
      isAbortError(bounded.error) ? 'timeout' : 'read_failed',
    );
  }
  if (bounded.value === null) return attachmentPayload(locator.attachmentId, 'expired_or_missing');

  const body = bytesFrom(bounded.value.body);
  if (body === null || body.byteLength !== locator.sizeBytes) {
    return attachmentPayload(locator.attachmentId, 'malformed');
  }
  const objectMime = normalizeMimeToken(bounded.value.contentType);
  if (objectMime !== declaredMime) return attachmentPayload(locator.attachmentId, 'unsupported');
  if (declaredMime === 'text/plain') {
    return availableAttachmentText(
      locator.attachmentId,
      Buffer.from(body).toString('utf8'),
      remainingBytes,
      limits,
    );
  }

  const extracted = await runBounded(
    (signal) =>
      pdfExtractor(
        {
          body: Buffer.from(body),
          declaredSize: locator.sizeBytes,
          declaredMime,
          objectMime,
        },
        {
          runner: pdfRunner,
          signal,
          attachmentId: locator.attachmentId,
        },
      ),
    limits,
  );
  if (extracted.state === 'deadline') return attachmentPayload(locator.attachmentId, 'timeout');
  if (extracted.state === 'rejected') {
    return attachmentPayload(
      locator.attachmentId,
      isAbortError(extracted.error) ? 'timeout' : 'parser_failure',
    );
  }

  const data = extracted.value?.data;
  if (!data || typeof data.reason !== 'string') {
    return attachmentPayload(locator.attachmentId, 'parser_failure');
  }
  if (data.reason === 'text') {
    if (typeof data.text !== 'string') return attachmentPayload(locator.attachmentId, 'parser_failure');
    return availableAttachmentText(locator.attachmentId, data.text, remainingBytes, limits);
  }
  if (ATTACHMENT_TEXT_STATUSES.has(data.reason)) {
    return attachmentPayload(
      locator.attachmentId,
      data.reason as Exclude<
        Extract<ThreadCorpusHydrationPayload, { kind: 'attachment_text' }>['status'],
        'available'
      >,
    );
  }
  return attachmentPayload(locator.attachmentId, 'parser_failure');
}

/**
 * Hydrates only Task 6 runtime locators into Task 7's sealed in-memory payload contract.
 */
export async function hydrateThreadCorpusArtifacts(input: {
  formatted: FormattedLogicalMessages;
  attachmentLocators: readonly ThreadCorpusAttachmentLocator[];
  storage: Pick<S3Storage, 'getObjectBounded'>;
  limits?: Partial<ThreadCorpusHydrationLimits>;
  pdfRunner?: SandboxRunner;
  pdfExtractor?: typeof extractEmbeddedPdfText;
}): Promise<ThreadCorpusHydrationInput> {
  const request = validatedRequest(input);
  let retainedBytes = 0;
  const payloads: ThreadCorpusHydrationPayload[] = [];

  for (const source of request.rawMimeSources) {
    const result = await hydrateRawMime(
      source,
      request.storage,
      request.limits.maxTotalArtifactBytes - retainedBytes,
      request.limits,
    );
    if (source.status === 'available' && result.payload.status !== 'available') {
      return invalidHydrationInput();
    }
    retainedBytes += result.retainedBytes;
    payloads.push(result.payload);
  }

  for (const locator of request.attachmentLocators) {
    const result = await hydrateAttachment(
      locator,
      request.storage,
      request.limits.maxTotalArtifactBytes - retainedBytes,
      request.limits,
      request.pdfRunner,
      request.pdfExtractor,
    );
    retainedBytes += result.retainedBytes;
    payloads.push(result.payload);
  }

  return {
    attachmentLocators: request.attachmentLocators.map(cloneLocator),
    payloads: payloads.sort((left, right) => {
      const kindOrder = compareText(left.kind, right.kind);
      if (kindOrder !== 0) return kindOrder;
      const leftOwnerId = left.kind === 'raw_mime' ? left.sourceRowId : left.attachmentId;
      const rightOwnerId = right.kind === 'raw_mime' ? right.sourceRowId : right.attachmentId;
      return compareText(leftOwnerId, rightOwnerId);
    }),
  };
}
