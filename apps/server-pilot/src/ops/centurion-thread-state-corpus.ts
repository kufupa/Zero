import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CENTURION_THREAD_STATE_CORPUS_SCHEMA =
  'centurion_thread_state_corpus_v1' as const;
export const CENTURION_THREAD_STATE_SOURCE_SCHEMA_VERSION =
  'centurion_message_projection_v1' as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).nullable();

const sourceSchema = z
  .object({
    schemaVersion: z.literal(CENTURION_THREAD_STATE_SOURCE_SCHEMA_VERSION),
    transportId: z.string().min(1),
    eventCutoff: z.string().datetime({ offset: true }),
    ingestCutoff: z.string().datetime({ offset: true }),
  })
  .strict();

const sourceManifestSchema = z
  .object({
    messageCount: z.number().int().nonnegative(),
    threadCount: z.number().int().nonnegative(),
    messageIdsSha256: sha256Schema,
    messageThreadPairsSha256: sha256Schema,
    sourceRowsSha256: sha256Schema,
  })
  .strict();

const sourceMessageSchema = z
  .object({
    messageId: z.string(),
    threadId: z.string(),
    transportId: z.string(),
    direction: z.string(),
    createdAt: timestampSchema,
    sentAt: timestampSchema,
    receivedAt: timestampSchema,
    fromAddress: z.string(),
    toAddresses: z.array(z.string()),
    ccAddresses: z.array(z.string()),
    bccAddresses: z.array(z.string()),
    subject: z.string().nullable(),
    textBody: z.string().nullable(),
    htmlBody: z.string().nullable(),
    messageIdHeader: z.string().nullable(),
    inReplyTo: z.string().nullable(),
    references: z.array(z.string()).nullable(),
  })
  .strict();

const inputSchema = z
  .object({
    source: z.unknown(),
    manifest: z.unknown(),
    messages: z.array(z.unknown()),
  })
  .strict();

type SourceMessage = z.infer<typeof sourceMessageSchema>;

export type CenturionThreadStateSourceManifest = z.infer<
  typeof sourceManifestSchema
>;

const canonicalMessageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    transportId: z.string().min(1),
    direction: z.enum(['inbound', 'outbound']),
    eventAt: z.string().datetime({ offset: true }),
    timestamps: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        sentAt: timestampSchema,
        receivedAt: timestampSchema,
      })
      .strict(),
    participants: z
      .object({
        from: z.string().min(1),
        to: z.array(z.string()),
        cc: z.array(z.string()),
        bcc: z.array(z.string()),
      })
      .strict(),
    subject: z.string(),
    textBody: z.string().nullable(),
    htmlBody: z.string().nullable(),
    headers: z
      .object({
        messageId: z.string().min(1).nullable(),
        inReplyTo: z.string().min(1).nullable(),
        references: z.array(z.string().min(1)),
        linkageConflict: z.boolean().optional().default(false),
        malformedReferences: z.boolean().optional().default(false),
      })
      .strict(),
    sourceDigest: sha256Schema,
  })
  .strict();

const canonicalCorpusSchema = z
  .object({
    schema: z.literal(CENTURION_THREAD_STATE_CORPUS_SCHEMA),
    source: sourceSchema,
    manifest: sourceManifestSchema
      .extend({ corpusSha256: sha256Schema })
      .strict(),
    messages: z.array(canonicalMessageSchema),
  })
  .strict();

export type CenturionThreadStateCorpusMessage = {
  id: string;
  threadId: string;
  transportId: string;
  direction: 'inbound' | 'outbound';
  eventAt: string;
  timestamps: {
    createdAt: string;
    sentAt: string | null;
    receivedAt: string | null;
  };
  participants: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
  };
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  headers: {
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    linkageConflict: boolean;
    malformedReferences: boolean;
  };
  sourceDigest: string;
};

export type CenturionThreadStateCorpus = {
  schema: typeof CENTURION_THREAD_STATE_CORPUS_SCHEMA;
  source: {
    schemaVersion: typeof CENTURION_THREAD_STATE_SOURCE_SCHEMA_VERSION;
    transportId: string;
    eventCutoff: string;
    ingestCutoff: string;
  };
  manifest: CenturionThreadStateSourceManifest & {
    corpusSha256: string;
  };
  messages: CenturionThreadStateCorpusMessage[];
};

export type CenturionThreadStateOutputRootInspection = {
  path: string;
  realPath: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  uid: number;
};

export type CenturionThreadStateOutputFileInspection = {
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  uid: number;
};

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CENTURION_THREAD_STATE_NON_JSON_VALUE');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  fail('CENTURION_THREAD_STATE_NON_JSON_VALUE');
}

function normalizedIdentifier(value: string, code: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) fail(code);
  return normalized;
}

function normalizedTimestamp(
  value: string | null,
  code: string,
): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(code);
  return date.toISOString();
}

function normalizedText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .trim();
}

function normalizedSubject(value: string | null): string {
  if (value === null) return '';
  return normalizedText(value).replace(/\s+/gu, ' ');
}

function normalizedParticipant(value: string): string {
  const normalized = normalizedText(value).replace(/\s+/gu, ' ');
  if (!normalized) fail('CENTURION_THREAD_STATE_PARTICIPANT_INVALID');
  return normalized.toLocaleLowerCase('en-US');
}

function normalizedParticipants(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const value of values) {
    const normalized = normalizedParticipant(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    participants.push(normalized);
  }
  return participants;
}

function normalizedHeader(value: string | null, code: string): string | null {
  const normalized = normalizedHeaderIfValid(value);
  if (value !== null && normalized === null) fail(code);
  return normalized;
}

function normalizedHeaderIfValid(value: string | null): string | null {
  if (value === null) return null;
  const header = normalizedText(value);
  if (!header) return null;
  const wrapped = header.startsWith('<') || header.endsWith('>');
  if (wrapped) {
    if (!/^<[^<>\s]+>$/u.test(header)) return null;
    return header.slice(1, -1);
  }
  if (/[<>\s]/u.test(header)) return null;
  return header;
}

function normalizedReferences(values: readonly string[] | null): {
  references: string[];
  malformed: boolean;
} {
  const seen = new Set<string>();
  const references: string[] = [];
  let malformed = false;
  for (const value of values ?? []) {
    const normalized = normalizedHeaderIfValid(value);
    if (!normalized) {
      malformed = true;
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    references.push(normalized);
  }
  return { references, malformed };
}

function sourceMessageIdForManifest(value: unknown, index: number): string {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).messageId === 'string'
  ) {
    return (value as Record<string, string>).messageId.normalize('NFKC').trim();
  }
  return `!invalid-message-${index}`;
}

function sourceThreadIdForManifest(value: unknown, index: number): string {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).threadId === 'string'
  ) {
    return (value as Record<string, string>).threadId.normalize('NFKC').trim();
  }
  return `!invalid-thread-${index}`;
}

function messageIdsSha256(messages: readonly unknown[]): string {
  return sha256(
    messages
      .map(sourceMessageIdForManifest)
      .sort(compareStrings)
      .join('\n'),
  );
}

function messageThreadPairsSha256(messages: readonly unknown[]): string {
  return sha256(
    messages
      .map(
        (message, index) =>
          `${sourceMessageIdForManifest(message, index)}\u0000${sourceThreadIdForManifest(message, index)}`,
      )
      .sort(compareStrings)
      .join('\n'),
  );
}

function sourceRowsSha256(messages: readonly unknown[]): string {
  return sha256(stableJson(messages));
}

export function createCenturionThreadStateSourceManifest(
  messages: readonly unknown[],
): CenturionThreadStateSourceManifest {
  const threadIds = new Set(
    messages.map(sourceThreadIdForManifest),
  );
  return {
    messageCount: messages.length,
    threadCount: threadIds.size,
    messageIdsSha256: messageIdsSha256(messages),
    messageThreadPairsSha256: messageThreadPairsSha256(messages),
    sourceRowsSha256: sourceRowsSha256(messages),
  };
}

function parseSource(value: unknown): z.infer<typeof sourceSchema> {
  const parsed = sourceSchema.safeParse(value);
  if (!parsed.success) fail('CENTURION_THREAD_STATE_INVALID_SOURCE');
  return {
    ...parsed.data,
    transportId: normalizedIdentifier(
      parsed.data.transportId,
      'CENTURION_THREAD_STATE_TRANSPORT_INVALID',
    ),
    eventCutoff: normalizedTimestamp(
      parsed.data.eventCutoff,
      'CENTURION_THREAD_STATE_EVENT_CUTOFF_INVALID',
    )!,
    ingestCutoff: normalizedTimestamp(
      parsed.data.ingestCutoff,
      'CENTURION_THREAD_STATE_INGEST_CUTOFF_INVALID',
    )!,
  };
}

function parseManifest(value: unknown): CenturionThreadStateSourceManifest {
  const parsed = sourceManifestSchema.safeParse(value);
  if (!parsed.success) fail('CENTURION_THREAD_STATE_MANIFEST_INCOMPLETE');
  return parsed.data;
}

function normalizeMessage(
  value: unknown,
  source: z.infer<typeof sourceSchema>,
): CenturionThreadStateCorpusMessage {
  const parsed = sourceMessageSchema.safeParse(value);
  if (!parsed.success) fail('CENTURION_THREAD_STATE_INVALID_MESSAGE');
  return normalizeParsedMessage(parsed.data, source);
}

function normalizeParsedMessage(
  message: SourceMessage,
  source: z.infer<typeof sourceSchema>,
  persistedHeaderStatus?: {
    linkageConflict: boolean;
    malformedReferences: boolean;
  },
): CenturionThreadStateCorpusMessage {
  const id = normalizedIdentifier(
    message.messageId,
    'CENTURION_THREAD_STATE_MESSAGE_ID_INVALID',
  );
  const threadId = normalizedIdentifier(
    message.threadId,
    'CENTURION_THREAD_STATE_THREAD_ID_INVALID',
  );
  const transportId = normalizedIdentifier(
    message.transportId,
    'CENTURION_THREAD_STATE_TRANSPORT_INVALID',
  );
  if (transportId !== source.transportId) {
    fail('CENTURION_THREAD_STATE_TRANSPORT_MISMATCH');
  }
  const direction = normalizedText(message.direction).toLowerCase();
  if (direction !== 'inbound' && direction !== 'outbound') {
    fail('CENTURION_THREAD_STATE_DIRECTION_INVALID');
  }

  const createdAt = normalizedTimestamp(
    message.createdAt,
    'CENTURION_THREAD_STATE_TIMESTAMP_INVALID',
  );
  const sentAt = normalizedTimestamp(
    message.sentAt,
    'CENTURION_THREAD_STATE_TIMESTAMP_INVALID',
  );
  const receivedAt = normalizedTimestamp(
    message.receivedAt,
    'CENTURION_THREAD_STATE_TIMESTAMP_INVALID',
  );
  if (!createdAt) fail('CENTURION_THREAD_STATE_TIMESTAMP_REQUIRED');
  const eventAt =
    direction === 'inbound'
      ? receivedAt ?? createdAt
      : sentAt ?? createdAt;
  if (eventAt > source.eventCutoff) {
    fail('CENTURION_THREAD_STATE_EVENT_CUTOFF_EXCEEDED');
  }
  if (createdAt > source.ingestCutoff) {
    fail('CENTURION_THREAD_STATE_INGEST_CUTOFF_EXCEEDED');
  }

  const inReplyTo = normalizedHeader(
    message.inReplyTo,
    'CENTURION_THREAD_STATE_IN_REPLY_TO_INVALID',
  );
  const normalizedReferenceHeaders = normalizedReferences(message.references);
  const references = normalizedReferenceHeaders.references;
  const calculatedLinkageConflict =
    inReplyTo !== null &&
    references.length > 0 &&
    references[references.length - 1] !== inReplyTo;
  if (
    persistedHeaderStatus &&
    persistedHeaderStatus.linkageConflict !== calculatedLinkageConflict
  ) {
    fail('CENTURION_THREAD_STATE_LINKAGE_CONFLICT_MISMATCH');
  }
  const linkageConflict =
    persistedHeaderStatus?.linkageConflict ?? calculatedLinkageConflict;
  const malformedReferences =
    persistedHeaderStatus?.malformedReferences ??
    normalizedReferenceHeaders.malformed;

  const canonical = {
    id,
    threadId,
    transportId,
    direction,
    eventAt,
    timestamps: { createdAt, sentAt, receivedAt },
    participants: {
      from: normalizedParticipant(message.fromAddress),
      to: normalizedParticipants(message.toAddresses),
      cc: normalizedParticipants(message.ccAddresses),
      bcc: normalizedParticipants(message.bccAddresses),
    },
    subject: normalizedSubject(message.subject),
    textBody: message.textBody === null ? null : normalizedText(message.textBody),
    htmlBody: message.htmlBody === null ? null : normalizedText(message.htmlBody),
    headers: {
      messageId: normalizedHeader(
        message.messageIdHeader,
        'CENTURION_THREAD_STATE_MESSAGE_HEADER_INVALID',
      ),
      inReplyTo,
      references,
      linkageConflict,
      malformedReferences,
    },
  } as const;
  return {
    ...canonical,
    direction,
    sourceDigest: sha256(stableJson(canonical)),
  };
}

function assertUniqueMessages(
  messages: readonly CenturionThreadStateCorpusMessage[],
): void {
  const ids = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.id)) {
      fail('CENTURION_THREAD_STATE_DUPLICATE_MESSAGE_ID');
    }
    ids.add(message.id);
  }
}

function sortedMessages(
  messages: readonly CenturionThreadStateCorpusMessage[],
): CenturionThreadStateCorpusMessage[] {
  return [...messages].sort(
    (left, right) =>
      compareStrings(left.eventAt, right.eventAt) ||
      compareStrings(left.id, right.id),
  );
}

function assertManifest(
  manifest: CenturionThreadStateSourceManifest,
  rawMessages: readonly unknown[],
  messages: readonly CenturionThreadStateCorpusMessage[],
): void {
  if (
    manifest.messageThreadPairsSha256 !==
    messageThreadPairsSha256(rawMessages)
  ) {
    fail('CENTURION_THREAD_STATE_KEYSET_MISMATCH');
  }
  if (
    manifest.messageCount !== rawMessages.length ||
    manifest.threadCount !== new Set(messages.map((message) => message.threadId)).size
  ) {
    fail('CENTURION_THREAD_STATE_CARDINALITY_MISMATCH');
  }
  if (manifest.messageIdsSha256 !== messageIdsSha256(rawMessages)) {
    fail('CENTURION_THREAD_STATE_KEYSET_MISMATCH');
  }
  if (manifest.sourceRowsSha256 !== sourceRowsSha256(rawMessages)) {
    fail('CENTURION_THREAD_STATE_SOURCE_DIGEST_MISMATCH');
  }
}

export function parseCenturionThreadStateCorpus(
  value: unknown,
): CenturionThreadStateCorpus {
  const input = inputSchema.safeParse(value);
  if (!input.success) fail('CENTURION_THREAD_STATE_INVALID_SNAPSHOT');

  const source = parseSource(input.data.source);
  const manifest = parseManifest(input.data.manifest);
  const messages = input.data.messages.map((message) =>
    normalizeMessage(message, source),
  );
  assertUniqueMessages(messages);
  assertManifest(manifest, input.data.messages, messages);
  const canonicalMessages = sortedMessages(messages);

  return parsePersistedCenturionThreadStateCorpus({
    schema: CENTURION_THREAD_STATE_CORPUS_SCHEMA,
    source,
    manifest: {
      ...manifest,
      corpusSha256: sha256(stableJson({ source, messages: canonicalMessages })),
    },
    messages: canonicalMessages,
  });
}

export function parsePersistedCenturionThreadStateCorpus(
  value: unknown,
): CenturionThreadStateCorpus {
  const parsed = canonicalCorpusSchema.safeParse(value);
  if (!parsed.success) {
    fail('CENTURION_THREAD_STATE_CANONICAL_ARTIFACT_INVALID');
  }
  const source = parseSource(parsed.data.source);
  const messages = parsed.data.messages.map((message) => {
    const reconstructed = normalizeParsedMessage(
      {
        messageId: message.id,
        threadId: message.threadId,
        transportId: message.transportId,
        direction: message.direction,
        createdAt: message.timestamps.createdAt,
        sentAt: message.timestamps.sentAt,
        receivedAt: message.timestamps.receivedAt,
        fromAddress: message.participants.from,
        toAddresses: message.participants.to,
        ccAddresses: message.participants.cc,
        bccAddresses: message.participants.bcc,
        subject: message.subject,
        textBody: message.textBody,
        htmlBody: message.htmlBody,
        messageIdHeader: message.headers.messageId,
        inReplyTo: message.headers.inReplyTo,
        references: message.headers.references,
      },
      source,
      {
        linkageConflict: message.headers.linkageConflict,
        malformedReferences: message.headers.malformedReferences,
      },
    );
    if (message.sourceDigest !== reconstructed.sourceDigest) {
      fail('CENTURION_THREAD_STATE_MESSAGE_DIGEST_MISMATCH');
    }
    return reconstructed;
  });
  assertUniqueMessages(messages);
  if (
    parsed.data.manifest.corpusSha256 !==
    sha256(stableJson({ source, messages }))
  ) {
    fail('CENTURION_THREAD_STATE_CORPUS_DIGEST_MISMATCH');
  }
  return {
    ...parsed.data,
    source,
    messages: sortedMessages(messages),
  };
}

export function validateCenturionThreadStateOutputRoot(input: {
  platform: string;
  currentUid: number;
  root: CenturionThreadStateOutputRootInspection;
}): void {
  if (input.platform !== 'linux') {
    fail('CENTURION_THREAD_STATE_OUTPUT_PLATFORM_UNSUPPORTED');
  }
  if (input.root.isSymbolicLink || input.root.path !== input.root.realPath) {
    fail('CENTURION_THREAD_STATE_OUTPUT_ROOT_SYMLINK');
  }
  if (!input.root.isDirectory) {
    fail('CENTURION_THREAD_STATE_OUTPUT_ROOT_TYPE_INVALID');
  }
  if (input.root.uid !== input.currentUid) {
    fail('CENTURION_THREAD_STATE_OUTPUT_ROOT_OWNER_INVALID');
  }
  if ((input.root.mode & 0o777) !== 0o700) {
    fail('CENTURION_THREAD_STATE_OUTPUT_ROOT_PERMISSIONS');
  }
}

export function validateCenturionThreadStateOutputTarget(input: {
  platform: string;
  currentUid: number;
  root: CenturionThreadStateOutputRootInspection;
  output: CenturionThreadStateOutputFileInspection;
}): void {
  validateCenturionThreadStateOutputRoot(input);
  if (input.output.isSymbolicLink) {
    fail('CENTURION_THREAD_STATE_OUTPUT_FILE_SYMLINK');
  }
  if (!input.output.isFile) {
    fail('CENTURION_THREAD_STATE_OUTPUT_FILE_TYPE_INVALID');
  }
  if (input.output.uid !== input.currentUid) {
    fail('CENTURION_THREAD_STATE_OUTPUT_FILE_OWNER_INVALID');
  }
  if ((input.output.mode & 0o777) !== 0o600) {
    fail('CENTURION_THREAD_STATE_OUTPUT_FILE_PERMISSIONS');
  }
}
