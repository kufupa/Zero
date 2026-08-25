import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type ExportThreadCorpusArgs = {
  outDir: string;
  asOf?: string;
};

export const ACTIVE_TRANSPORT_SCOPE_KEY = 'active_transport' as const;

export type ThreadCorpusScopeKey = typeof ACTIVE_TRANSPORT_SCOPE_KEY;

export type ThreadCorpusAddresses = {
  from: string[];
  to: string[];
  cc: string[];
  bcc: string[];
};

export type ThreadCorpusRawMime = {
  locator: string | null;
  status: string | null;
};

export type ThreadCorpusAttachmentDescriptor = {
  id: string;
  messageId: string;
  filename: string;
  contentType: string;
  byteSize: number;
};

export type ThreadCorpusAttachmentSourceDescriptor = {
  id: string;
  messageId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  s3Key: string;
};

export type ThreadCorpusAttachmentLocator = {
  attachmentId: string;
  messageId: string;
  s3Key: string;
  mimeType: string;
  sizeBytes: number;
};

export type ThreadCorpusDraftRevisionLink = {
  messageId: string;
  draftId: string | null;
  revisionId: string | null;
};

export type ThreadCorpusOutboundQueueState = {
  messageId: string;
  state: 'sent' | 'pending' | 'sending' | 'cancelled' | 'unknown';
};

export type ThreadCorpusOutboundDelivery = {
  queueState: ThreadCorpusOutboundQueueState['state'];
  deliveryStatus: 'smtp_accepted' | 'not_claimed';
};

export type ThreadCorpusPrivateMessage = {
  subject: string;
  direction: string;
  addresses: ThreadCorpusAddresses;
  originalAddresses: ThreadCorpusAddresses;
  canonicalHeaders: Record<string, string[]>;
  sentAt: string | null;
  rawMime: ThreadCorpusRawMime;
  attachments: ThreadCorpusAttachmentDescriptor[];
  draftRevisionLinks: ThreadCorpusDraftRevisionLink[];
  outboundDelivery: ThreadCorpusOutboundDelivery;
  sourceMetadata: {
    transportId: string;
  };
};

export type ActiveTransportScope = {
  asOf: string;
  transportIds: readonly string[];
};

export type ThreadCorpusMessageRow = {
  id: string;
  transportId: string;
  threadId: string | null;
  messageId: string | null;
  receivedAt: string;
  sentAt: string | null;
  subject: string;
  body: string;
  direction: string;
  from: readonly string[];
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  canonicalHeaders: Readonly<Record<string, readonly string[]>>;
  rawMime: ThreadCorpusRawMime;
};

export type ThreadCorpusSnapshotReadSession = {
  asOf: string;
  discoverActiveTransportScope(): Promise<ActiveTransportScope>;
  readMessages(): Promise<readonly ThreadCorpusMessageRow[]>;
  readAttachmentDescriptors(): Promise<readonly ThreadCorpusAttachmentSourceDescriptor[]>;
  readDraftRevisionLinks(): Promise<readonly ThreadCorpusDraftRevisionLink[]>;
  readOutboundQueueDeliveryStates(): Promise<readonly ThreadCorpusOutboundQueueState[]>;
};

export type ThreadCorpusSnapshotReader = {
  withRepeatableReadOnly<T>(
    load: (session: ThreadCorpusSnapshotReadSession) => Promise<T>,
  ): Promise<T>;
};

export type ThreadCorpusSnapshotLoadRequest = Record<never, never>;

export type ThreadCorpusSnapshotSafeSummary = {
  asOf: string;
  includedMessageCount: number;
  sourceRowCount: number;
  threadCount: number;
};

export type ThreadCorpusSourceRow = {
  sourceRowId: string;
  scopeMembership: readonly string[];
  receivedAt: string;
  threadId?: string | null;
  messageId?: string | null;
  contentFingerprint?: string | null;
  provenanceFingerprint?: string | null;
  body: string;
  privateMessage?: ThreadCorpusPrivateMessage;
};

export type ThreadCorpusSnapshotLoadResult = {
  asOf: string;
  activeTransportScope: ActiveTransportScope;
  formatted: FormattedLogicalMessages;
  attachmentLocators: ThreadCorpusAttachmentLocator[];
  safeSummary: ThreadCorpusSnapshotSafeSummary;
};

export type LogicalMessage = {
  normalizedMessageId: string | null;
  sourceRows: ThreadCorpusSourceRow[];
  scopeMembership: string[];
  annotations: Array<'unresolved_duplicate_candidate'>;
  threadId: string | null;
};

export type LogicalThread =
  | {
      kind: 'resolved';
      threadId: string;
      messages: LogicalMessage[];
    }
  | {
      kind: 'unresolved';
      threadId: null;
      messages: [LogicalMessage];
    };

export type FormattedLogicalMessages = {
  threads: LogicalThread[];
};

export const CENTURION_THREAD_CORPUS_SCHEMA_VERSION = 'centurion-thread-corpus-v3';

export type SnapshotScope = {
  scopeKeys: ThreadCorpusScopeKey[];
  transportIds: string[];
  messagePredicate: 'active_transport_before_as_of';
};

export type PrivateThreadCorpusSnapshotContext = {
  snapshotId: string;
  scope: SnapshotScope;
  asOf: string;
  exporterVersion: string;
};

export type ThreadCorpusArtifactKind = 'raw_mime' | 'attachment_text';

export type ThreadCorpusArtifactReference = {
  id: string;
  sha256: string;
  bytes: number;
};

export type ThreadCorpusHydrationPayload =
  | {
      kind: 'raw_mime';
      sourceRowId: string;
      status: 'available' | 'expired_or_missing' | 'too_large' | 'budget_exhausted' | 'read_failed';
      content?: Uint8Array;
    }
  | {
      kind: 'attachment_text';
      attachmentId: string;
      status:
        | 'available'
        | 'expired_or_missing'
        | 'too_large'
        | 'budget_exhausted'
        | 'unsupported'
        | 'encrypted'
        | 'no_embedded_text'
        | 'malformed'
        | 'too_many_pages'
        | 'timeout'
        | 'parser_failure'
        | 'read_failed';
      content?: Uint8Array;
    };

export type ThreadCorpusHydrationInput = {
  attachmentLocators: readonly ThreadCorpusAttachmentLocator[];
  payloads: readonly ThreadCorpusHydrationPayload[];
};

export type PrivateThreadCorpusArtifactFile = ThreadCorpusArtifactReference & {
  kind: ThreadCorpusArtifactKind;
  content: Uint8Array;
};

export type SnapshotRawMime = {
  status:
    | 'available'
    | 'missing'
    | 'expired_or_missing'
    | 'too_large'
    | 'budget_exhausted'
    | 'read_failed'
    | 'not_recorded'
    | 'not_recorded_outbound'
    | 'parse_failed'
    | 'not_applicable';
  artifact: ThreadCorpusArtifactReference | null;
};

export type SnapshotAttachmentTextArtifact = null | {
  status:
    | 'available'
    | 'expired_or_missing'
    | 'too_large'
    | 'budget_exhausted'
    | 'unsupported'
    | 'encrypted'
    | 'no_embedded_text'
    | 'malformed'
    | 'too_many_pages'
    | 'timeout'
    | 'parser_failure'
    | 'read_failed';
  artifact: ThreadCorpusArtifactReference | null;
};

export type SnapshotAttachmentDescriptor = ThreadCorpusAttachmentDescriptor & {
  textArtifact: SnapshotAttachmentTextArtifact;
};

export type SnapshotPrivateMessage = Omit<ThreadCorpusPrivateMessage, 'rawMime' | 'attachments'> & {
  rawMime: SnapshotRawMime;
  attachments: SnapshotAttachmentDescriptor[];
};

export type SnapshotSourceRow = {
  sourceRowId: string;
  scopeMembership: ThreadCorpusScopeKey[];
  receivedAt: string;
  threadId: string | null;
  messageId: string | null;
  contentFingerprint: string | null;
  provenanceFingerprint: string | null;
  body: string;
  privateMessage?: SnapshotPrivateMessage;
};

export type SnapshotMessage = {
  timestamp: string;
  messageId: string | null;
  sourceRows: SnapshotSourceRow[];
  scopeMembership: ThreadCorpusScopeKey[];
  annotations: Array<'unresolved_duplicate_candidate'>;
};

export type ThreadSnapshotRecord = {
  recordType: 'thread';
  schemaVersion: typeof CENTURION_THREAD_CORPUS_SCHEMA_VERSION;
  snapshotId: string;
  threadId: string | null;
  threadingStatus: 'resolved' | 'unresolved';
  threadFirstTimestamp: string;
  scopeMembership: ThreadCorpusScopeKey[];
  messages: SnapshotMessage[];
};

export type SnapshotRecord = ThreadSnapshotRecord;

export type SnapshotMetadataRecord = {
  recordType: 'metadata';
  schemaVersion: typeof CENTURION_THREAD_CORPUS_SCHEMA_VERSION;
  snapshotId: string;
  orderedRecordSha256: string;
  recordCount: number;
};

export type SnapshotManifestCounts = {
  sourceRows: number;
  logicalMessages: number;
  unresolvedDuplicateCandidates: number;
  threads: number;
  attachments: number;
  drafts: number;
  revisions: number;
  rawMimeAvailable: number;
  rawMimeUnavailable: number;
  attachmentTextAvailable: number;
  attachmentTextUnavailable: number;
  messagesByScope: Record<ThreadCorpusScopeKey, number>;
};

export type SnapshotManifestV2 = {
  schemaVersion: typeof CENTURION_THREAD_CORPUS_SCHEMA_VERSION;
  snapshotId: string;
  scope: SnapshotScope;
  window: {
    startInclusive: null;
    endExclusive: string;
  };
  exporterVersion: string;
  orderedRecordSha256: string;
  localObjectSha256: string;
  artifactInventorySha256: string;
  counts: SnapshotManifestCounts;
  sourceObject: {
    integrity: 'content_hash_only';
  };
};

export type PrivateThreadCorpusManifest = SnapshotManifestV2;

export type PrivateThreadCorpusSnapshot = {
  context: PrivateThreadCorpusSnapshotContext;
  corpusJsonl: string;
  manifestJson: string;
  manifest: PrivateThreadCorpusManifest;
  artifactFiles: PrivateThreadCorpusArtifactFile[];
};

export type PrivateThreadCorpusSnapshotBuildArgs = {
  context: PrivateThreadCorpusSnapshotContext;
  formatted: FormattedLogicalMessages;
  hydration: ThreadCorpusHydrationInput;
};

export type PrivateThreadCorpusPublishArgs = {
  repoRoot: string;
  outDir: string;
  context: PrivateThreadCorpusSnapshotContext;
  formatted: FormattedLogicalMessages;
  hydration: ThreadCorpusHydrationInput;
};

export type PrivateArtifactFileSystem = {
  chmod: typeof chmod;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  realpath: typeof realpath;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
};

type IndexedSourceRow = {
  row: ThreadCorpusSourceRow;
  normalizedMessageId: string | null;
  duplicateCandidateKey: string | null;
};

const REQUIRED_FLAGS = ['--out-dir'] as const;

const VALUE_FLAGS = new Set([...REQUIRED_FLAGS, '--as-of']);

const LOCAL_PRIVATE_ARTIFACT_FILE_SYSTEM: PrivateArtifactFileSystem = {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
};

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function privateCorpusRoot(repoRoot: string): string {
  return path.resolve(repoRoot, '.private', 'centurion-thread-corpus');
}

function resolvePrivateCorpusOutDir(repoRoot: string, outDir: string): string {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const root = privateCorpusRoot(resolvedRepoRoot);
  const resolvedOutDir = path.resolve(resolvedRepoRoot, outDir);
  if (!isPathWithin(resolvedOutDir, root) || path.dirname(resolvedOutDir) !== root) {
    throw new Error(
      '--out-dir must name a direct child directory inside .private/centurion-thread-corpus',
    );
  }
  return resolvedOutDir;
}

function isStrictIso(value: string): boolean {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/,
  );
  if (!match || Number.isNaN(Date.parse(value))) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;

  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

/**
 * Parses private corpus-export inputs without reading a file, environment, or live source.
 */
export function parseExportThreadCorpusArgs(
  argv: readonly string[],
  repoRoot: string,
): ExportThreadCorpusArgs {
  const values: Partial<Record<typeof VALUE_FLAGS extends Set<infer Flag> ? Flag : never, string>> =
    {};
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`Unknown flag: ${flag}`);
    }

    const value = requireValue(argv, index, flag);
    index += 1;

    if (seen.has(flag)) {
      throw new Error(`Duplicate flag: ${flag}`);
    }
    seen.add(flag);
    values[flag] = value;
  }

  for (const flag of REQUIRED_FLAGS) {
    if (!values[flag]) {
      throw new Error(`Missing required flag: ${flag}`);
    }
  }

  if (values['--as-of'] && !isStrictIso(values['--as-of'])) {
    throw new Error('Invalid --as-of ISO value');
  }

  const resolvedRepoRoot = path.resolve(repoRoot);
  const outDir = resolvePrivateCorpusOutDir(resolvedRepoRoot, values['--out-dir']!);

  return {
    outDir,
    asOf: values['--as-of'],
  };
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const wrapped = trimmed.match(
    /^<([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?))*)>$/,
  );
  return wrapped?.[1].toLowerCase() ?? null;
}

function duplicateCandidateKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

type CompleteFingerprint = {
  content: string;
  provenance: string;
};

function completeFingerprint(entry: IndexedSourceRow): CompleteFingerprint | null {
  const content = entry.row.contentFingerprint;
  const provenance = entry.row.provenanceFingerprint;
  return content && provenance ? { content, provenance } : null;
}

function cloneAddresses(addresses: ThreadCorpusAddresses): ThreadCorpusAddresses {
  return {
    from: [...addresses.from],
    to: [...addresses.to],
    cc: [...addresses.cc],
    bcc: [...addresses.bcc],
  };
}

function cloneCanonicalHeaders(
  canonicalHeaders: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const cloned: Record<string, string[]> = {};
  for (const name of Object.keys(canonicalHeaders).sort(compareText)) {
    cloned[name] = [...(canonicalHeaders[name] ?? [])];
  }
  return cloned;
}

function cloneAttachmentDescriptor(
  descriptor: ThreadCorpusAttachmentDescriptor,
): ThreadCorpusAttachmentDescriptor {
  return {
    id: descriptor.id,
    messageId: descriptor.messageId,
    filename: descriptor.filename,
    contentType: descriptor.contentType,
    byteSize: descriptor.byteSize,
  };
}

function attachmentDescriptorSortKey(descriptor: ThreadCorpusAttachmentDescriptor): string {
  return JSON.stringify([
    descriptor.id,
    descriptor.messageId,
    descriptor.filename,
    descriptor.contentType,
    descriptor.byteSize,
  ]);
}

function compareAttachmentDescriptors(
  left: ThreadCorpusAttachmentDescriptor,
  right: ThreadCorpusAttachmentDescriptor,
): number {
  return compareText(attachmentDescriptorSortKey(left), attachmentDescriptorSortKey(right));
}

function cloneDraftRevisionLink(
  link: ThreadCorpusDraftRevisionLink,
): ThreadCorpusDraftRevisionLink {
  return {
    messageId: link.messageId,
    draftId: link.draftId,
    revisionId: link.revisionId,
  };
}

function draftRevisionLinkSortKey(link: ThreadCorpusDraftRevisionLink): string {
  return JSON.stringify([link.messageId, link.draftId, link.revisionId]);
}

function compareDraftRevisionLinks(
  left: ThreadCorpusDraftRevisionLink,
  right: ThreadCorpusDraftRevisionLink,
): number {
  return compareText(draftRevisionLinkSortKey(left), draftRevisionLinkSortKey(right));
}

function clonePrivateMessage(message: ThreadCorpusPrivateMessage): ThreadCorpusPrivateMessage {
  return {
    subject: message.subject,
    direction: message.direction,
    addresses: cloneAddresses(message.addresses),
    originalAddresses: cloneAddresses(message.originalAddresses),
    canonicalHeaders: cloneCanonicalHeaders(message.canonicalHeaders),
    sentAt: message.sentAt,
    rawMime: {
      locator: message.rawMime.locator,
      status: message.rawMime.status,
    },
    attachments: message.attachments
      .map(cloneAttachmentDescriptor)
      .sort(compareAttachmentDescriptors),
    draftRevisionLinks: message.draftRevisionLinks
      .map(cloneDraftRevisionLink)
      .sort(compareDraftRevisionLinks),
    outboundDelivery: {
      queueState: message.outboundDelivery.queueState,
      deliveryStatus: message.outboundDelivery.deliveryStatus,
    },
    sourceMetadata: {
      transportId: message.sourceMetadata.transportId,
    },
  };
}

function privateMessageSortKey(message: ThreadCorpusPrivateMessage | undefined): string | null {
  return message ? JSON.stringify(clonePrivateMessage(message)) : null;
}

function cloneSourceRow(row: ThreadCorpusSourceRow): ThreadCorpusSourceRow {
  return {
    ...row,
    scopeMembership: [...row.scopeMembership],
    ...(row.privateMessage ? { privateMessage: clonePrivateMessage(row.privateMessage) } : {}),
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function normalizedThreadId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function sourceRowSortKey(row: ThreadCorpusSourceRow): string {
  return JSON.stringify([
    row.sourceRowId,
    row.receivedAt,
    normalizedThreadId(row.threadId),
    normalizeMessageId(row.messageId),
    row.contentFingerprint ?? null,
    row.provenanceFingerprint ?? null,
    row.body,
    [...row.scopeMembership].sort(compareText),
    privateMessageSortKey(row.privateMessage),
  ]);
}

function compareSourceRows(left: ThreadCorpusSourceRow, right: ThreadCorpusSourceRow): number {
  return compareText(sourceRowSortKey(left), sourceRowSortKey(right));
}

function logicalMessageSortKey(message: LogicalMessage): string {
  const firstReceivedAt =
    [...message.sourceRows].map((row) => row.receivedAt).sort(compareText)[0] ?? '';
  const firstSourceRowId =
    [...message.sourceRows].map((row) => row.sourceRowId).sort(compareText)[0] ?? '';
  return JSON.stringify([firstReceivedAt, message.normalizedMessageId ?? '', firstSourceRowId]);
}

function compareLogicalMessages(left: LogicalMessage, right: LogicalMessage): number {
  return compareText(logicalMessageSortKey(left), logicalMessageSortKey(right));
}

function toLogicalMessage(
  entries: readonly IndexedSourceRow[],
  annotations: Array<'unresolved_duplicate_candidate'> = [],
): LogicalMessage {
  const sourceRows = entries.map((entry) => cloneSourceRow(entry.row)).sort(compareSourceRows);
  const threadIds = sortedUnique(
    sourceRows
      .map((row) => normalizedThreadId(row.threadId))
      .filter((threadId): threadId is string => threadId !== null),
  );

  return {
    normalizedMessageId: entries[0]?.normalizedMessageId ?? null,
    sourceRows,
    scopeMembership: sortedUnique(sourceRows.flatMap((row) => [...row.scopeMembership])),
    annotations,
    threadId: threadIds.length === 1 ? threadIds[0]! : null,
  };
}

function formatRows(entries: readonly IndexedSourceRow[]): LogicalMessage[] {
  const byCandidateKey = new Map<string, IndexedSourceRow[]>();
  const withoutCandidateKey: IndexedSourceRow[] = [];

  for (const entry of entries) {
    if (entry.duplicateCandidateKey) {
      const candidates = byCandidateKey.get(entry.duplicateCandidateKey) ?? [];
      candidates.push(entry);
      byCandidateKey.set(entry.duplicateCandidateKey, candidates);
    } else {
      withoutCandidateKey.push(entry);
    }
  }

  const messages = withoutCandidateKey.map((entry) => toLogicalMessage([entry]));
  for (const candidateKey of [...byCandidateKey.keys()].sort(compareText)) {
    const candidates = byCandidateKey.get(candidateKey)!;
    const strongMessageId = candidates[0]?.normalizedMessageId ?? null;
    const fingerprint = completeFingerprint(candidates[0]!);
    const canStronglyMerge =
      candidates.length > 1 &&
      strongMessageId !== null &&
      fingerprint !== null &&
      candidates.every((candidate) => {
        const candidateFingerprint = completeFingerprint(candidate);
        return (
          candidate.normalizedMessageId === strongMessageId &&
          candidateFingerprint !== null &&
          candidateFingerprint.content === fingerprint.content &&
          candidateFingerprint.provenance === fingerprint.provenance
        );
      });

    if (canStronglyMerge) {
      messages.push(toLogicalMessage(candidates));
      continue;
    }

    const annotation = candidates.length > 1 ? (['unresolved_duplicate_candidate'] as const) : [];
    for (const candidate of candidates) {
      messages.push(toLogicalMessage([candidate], [...annotation]));
    }
  }

  return messages.sort(compareLogicalMessages);
}

/**
 * Builds deterministic logical messages from supplied rows only. Body text remains opaque data.
 */
export function formatLogicalMessages(
  rows: readonly ThreadCorpusSourceRow[],
): FormattedLogicalMessages {
  if (rows.some((row) => Object.hasOwn(row, 'isQuarantined'))) {
    invalidThreadCorpusSourceContract();
  }
  const indexed = rows.map((row) => ({
    row: cloneSourceRow(row),
    normalizedMessageId: normalizeMessageId(row.messageId),
    duplicateCandidateKey: duplicateCandidateKey(row.messageId),
  }));
  const messages = formatRows(indexed);
  const resolvedByThreadId = new Map<string, LogicalMessage[]>();
  const unresolved: LogicalMessage[] = [];

  for (const message of messages) {
    if (message.threadId) {
      const threadMessages = resolvedByThreadId.get(message.threadId) ?? [];
      threadMessages.push(message);
      resolvedByThreadId.set(message.threadId, threadMessages);
    } else {
      unresolved.push(message);
    }
  }

  const threads: LogicalThread[] = [
    ...[...resolvedByThreadId.entries()].map(([threadId, threadMessages]) => ({
      kind: 'resolved' as const,
      threadId,
      messages: threadMessages.sort(compareLogicalMessages),
    })),
    ...unresolved.map((message) => ({
      kind: 'unresolved' as const,
      threadId: null,
      messages: [message] as [LogicalMessage],
    })),
  ].sort((left, right) => {
    const leftFirst = left.messages[0]!;
    const rightFirst = right.messages[0]!;
    const messageOrder = compareLogicalMessages(leftFirst, rightFirst);
    if (messageOrder !== 0) return messageOrder;
    return compareText(left.threadId ?? '', right.threadId ?? '');
  });

  return { threads };
}

function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const bracketed = trimmed.match(/<\s*([^<>]+?)\s*>/);
  const candidate = (bracketed?.[1] ?? trimmed).trim();
  const email = candidate.match(
    /[A-Z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/i,
  )?.[0];
  return email?.toLowerCase() ?? null;
}

function normalizedAddresses(row: ThreadCorpusMessageRow): ThreadCorpusAddresses {
  const normalize = (values: readonly string[]): string[] =>
    sortedUnique(values.map(normalizeAddress).filter((value): value is string => value !== null));

  return {
    from: normalize(row.from),
    to: normalize(row.to),
    cc: normalize(row.cc),
    bcc: normalize(row.bcc),
  };
}

function originalAddresses(row: ThreadCorpusMessageRow): ThreadCorpusAddresses {
  return {
    from: [...row.from],
    to: [...row.to],
    cc: [...row.cc],
    bcc: [...row.bcc],
  };
}

function assertActiveTransportScope(
  value: ActiveTransportScope,
  asOf: string,
): ActiveTransportScope {
  if (
    !value ||
    value.asOf !== asOf ||
    !Array.isArray(value.transportIds) ||
    !value.transportIds.every(isNonEmptyString)
  ) {
    invalidThreadCorpusSourceContract();
  }
  const transportIds = sortedUnique(value.transportIds);
  if (transportIds.length === 0) {
    throw new Error('Active transport scope is empty');
  }
  if (JSON.stringify(transportIds) !== JSON.stringify(value.transportIds)) {
    invalidThreadCorpusSourceContract();
  }
  return { asOf, transportIds };
}

function scopeMembershipForMessage(
  row: ThreadCorpusMessageRow,
  activeTransportScope: ActiveTransportScope,
): ThreadCorpusScopeKey[] {
  if (!activeTransportScope.transportIds.includes(row.transportId)) {
    invalidThreadCorpusSourceContract();
  }
  return [ACTIVE_TRANSPORT_SCOPE_KEY];
}

function messageFingerprints(
  row: ThreadCorpusMessageRow,
  addresses: ThreadCorpusAddresses,
): CompleteFingerprint {
  const canonicalHeaders = cloneCanonicalHeaders(row.canonicalHeaders);
  return {
    content: sha256(
      JSON.stringify({
        body: row.body,
        subject: row.subject,
        direction: row.direction,
        addresses,
        canonicalHeaders,
      }),
    ),
    provenance: sha256(
      JSON.stringify({
        sentAt: row.sentAt,
        direction: row.direction,
        addresses,
        canonicalHeaders,
      }),
    ),
  };
}

function groupByMessageId<T extends { messageId: string }>(
  records: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const values = grouped.get(record.messageId) ?? [];
    values.push(record);
    grouped.set(record.messageId, values);
  }
  return grouped;
}

function assertUniqueMessageSourceIds(messages: readonly ThreadCorpusMessageRow[]): void {
  const sourceIds = new Set<string>();
  for (const row of messages) {
    if (sourceIds.has(row.id)) {
      throw new Error('Message source identity collision');
    }
    sourceIds.add(row.id);
  }
}

function resolvedQueueState(
  states: readonly ThreadCorpusOutboundQueueState[],
): ThreadCorpusOutboundQueueState['state'] {
  const distinctStates = new Set(states.map((state) => state.state));
  if (distinctStates.size !== 1) return 'unknown';
  return [...distinctStates][0]!;
}

function outboundDeliveryFor(
  row: ThreadCorpusMessageRow,
  queueStates: readonly ThreadCorpusOutboundQueueState[],
): ThreadCorpusOutboundDelivery {
  const queueState = resolvedQueueState(queueStates);
  return {
    queueState,
    deliveryStatus: row.sentAt !== null && queueState === 'sent' ? 'smtp_accepted' : 'not_claimed',
  };
}

function toThreadCorpusSourceRow(
  row: ThreadCorpusMessageRow,
  scopeMembership: readonly ThreadCorpusScopeKey[],
  attachmentsByMessageId: ReadonlyMap<string, ThreadCorpusAttachmentSourceDescriptor[]>,
  draftRevisionLinksByMessageId: ReadonlyMap<string, ThreadCorpusDraftRevisionLink[]>,
  queueStatesByMessageId: ReadonlyMap<string, ThreadCorpusOutboundQueueState[]>,
): ThreadCorpusSourceRow {
  if (!isSourceRawMime(row.rawMime)) invalidThreadCorpusSourceContract();
  const addresses = normalizedAddresses(row);
  const fingerprints = messageFingerprints(row, addresses);
  const attachments = attachmentsByMessageId.get(row.id) ?? [];
  if (attachments.some((attachment) => attachment.messageId !== row.id)) {
    invalidThreadCorpusSourceContract();
  }
  const draftRevisionLinks = draftRevisionLinksByMessageId.get(row.id) ?? [];
  const queueStates = queueStatesByMessageId.get(row.id) ?? [];

  return {
    sourceRowId: row.id,
    scopeMembership: sortedUnique(scopeMembership),
    receivedAt: row.receivedAt,
    threadId: row.threadId,
    messageId: row.messageId,
    contentFingerprint: fingerprints.content,
    provenanceFingerprint: fingerprints.provenance,
    body: row.body,
    privateMessage: {
      subject: row.subject,
      direction: row.direction,
      addresses,
      originalAddresses: originalAddresses(row),
      canonicalHeaders: cloneCanonicalHeaders(row.canonicalHeaders),
      sentAt: row.sentAt,
      rawMime: {
        locator: row.rawMime.locator,
        status: row.rawMime.status,
      },
      attachments: attachments.map(cloneAttachmentDescriptor).sort(compareAttachmentDescriptors),
      draftRevisionLinks: draftRevisionLinks
        .map(cloneDraftRevisionLink)
        .sort(compareDraftRevisionLinks),
      outboundDelivery: outboundDeliveryFor(row, queueStates),
      sourceMetadata: {
        transportId: row.transportId,
      },
    },
  };
}

/**
 * Loads a deterministic private corpus from an injected read-only snapshot reader.
 */
export function createThreadCorpusSnapshotLoader(
  reader: ThreadCorpusSnapshotReader,
): () => Promise<ThreadCorpusSnapshotLoadResult> {
  return async () =>
    reader.withRepeatableReadOnly(async (session) => {
      const activeTransportScope = assertActiveTransportScope(
        await session.discoverActiveTransportScope(),
        session.asOf,
      );
      const messages = await session.readMessages();
      assertUniqueMessageSourceIds(messages);
      const knownSourceRowIds = new Set(messages.map((row) => row.id));
      const scopeMembershipBySourceRowId = new Map(
        messages.map((row) => [row.id, scopeMembershipForMessage(row, activeTransportScope)]),
      );

      const attachments = await session.readAttachmentDescriptors();
      const draftRevisionLinks = await session.readDraftRevisionLinks();
      const queueStates = await session.readOutboundQueueDeliveryStates();
      const { attachmentsByMessageId, attachmentLocators } = selectIncludedAttachmentSources(
        attachments,
        knownSourceRowIds,
        knownSourceRowIds,
      );
      for (const link of draftRevisionLinks) {
        if (!isDraftRevisionLink(link) || !knownSourceRowIds.has(link.messageId)) {
          invalidThreadCorpusSourceContract();
        }
      }
      for (const queueState of queueStates) {
        if (!isOutboundQueueState(queueState) || !knownSourceRowIds.has(queueState.messageId)) {
          invalidThreadCorpusSourceContract();
        }
      }
      const draftRevisionLinksByMessageId = groupByMessageId(draftRevisionLinks);
      const queueStatesByMessageId = groupByMessageId(queueStates);
      const includedRows = messages.map((row) =>
        toThreadCorpusSourceRow(
          row,
          scopeMembershipBySourceRowId.get(row.id)!,
          attachmentsByMessageId,
          draftRevisionLinksByMessageId,
          queueStatesByMessageId,
        ),
      );
      const formatted = formatLogicalMessages(includedRows);
      return {
        asOf: session.asOf,
        activeTransportScope,
        formatted,
        attachmentLocators,
        safeSummary: {
          asOf: session.asOf,
          includedMessageCount: includedRows.length,
          sourceRowCount: includedRows.length,
          threadCount: formatted.threads.length,
        },
      };
    });
}

type HydrationPlan = {
  rawMimeBySourceRowId: ReadonlyMap<string, SnapshotRawMime>;
  textArtifactByAttachmentId: ReadonlyMap<string, SnapshotAttachmentTextArtifact>;
  artifactFiles: PrivateThreadCorpusArtifactFile[];
};

function formattedSourceRows(formatted: FormattedLogicalMessages): ThreadCorpusSourceRow[] {
  return [
    ...formatted.threads.flatMap((thread) =>
      thread.messages.flatMap((message) => message.sourceRows),
    ),
  ];
}

function assertNoLegacyQuarantineFields(formatted: FormattedLogicalMessages): void {
  if (Object.hasOwn(formatted, 'quarantineRecords')) invalidPrivateSnapshotContract();
  for (const thread of formatted.threads) {
    for (const message of thread.messages) {
      if (Object.hasOwn(message, 'quarantined')) invalidPrivateSnapshotContract();
      if (message.sourceRows.some((sourceRow) => Object.hasOwn(sourceRow, 'isQuarantined'))) {
        invalidPrivateSnapshotContract();
      }
    }
  }
}

function artifactId(snapshotId: string, kind: ThreadCorpusArtifactKind, ownerId: string): string {
  return sha256(`${CENTURION_THREAD_CORPUS_SCHEMA_VERSION}\0${snapshotId}\0${kind}\0${ownerId}`);
}

function artifactReference(
  context: PrivateThreadCorpusSnapshotContext,
  kind: ThreadCorpusArtifactKind,
  ownerId: string,
  content: Uint8Array,
): PrivateThreadCorpusArtifactFile {
  const copiedContent = new Uint8Array(content);
  return {
    kind,
    id: artifactId(context.snapshotId, kind, ownerId),
    sha256: sha256Bytes(copiedContent),
    bytes: copiedContent.byteLength,
    content: copiedContent,
  };
}

function compareArtifactFiles(
  left: Pick<PrivateThreadCorpusArtifactFile, 'kind' | 'id'>,
  right: Pick<PrivateThreadCorpusArtifactFile, 'kind' | 'id'>,
): number {
  return compareText(left.kind, right.kind) || compareText(left.id, right.id);
}

function createHydrationPlan(
  context: PrivateThreadCorpusSnapshotContext,
  formatted: FormattedLogicalMessages,
  hydration: ThreadCorpusHydrationInput,
): HydrationPlan {
  if (!isThreadCorpusHydrationInput(hydration)) invalidPrivateSnapshotContract();

  const sourceRows = formattedSourceRows(formatted);
  const sourceRowIds = new Set<string>();
  const expectedRawPayloads = new Map<string, 'available' | 'pending_hydration'>();
  const attachmentDescriptors = new Map<string, ThreadCorpusAttachmentDescriptor>();
  const sourceRawMime = new Map<string, ThreadCorpusRawMime>();

  for (const sourceRow of sourceRows) {
    if (!isNonEmptyString(sourceRow.sourceRowId) || sourceRowIds.has(sourceRow.sourceRowId)) {
      invalidPrivateSnapshotContract();
    }
    sourceRowIds.add(sourceRow.sourceRowId);

    const privateMessage = sourceRow.privateMessage;
    if (!privateMessage) continue;
    if (!isSourceRawMime(privateMessage.rawMime) || privateMessage.rawMime.status === null) {
      invalidPrivateSnapshotContract();
    }
    sourceRawMime.set(sourceRow.sourceRowId, privateMessage.rawMime);

    if (
      privateMessage.rawMime.status === 'available' ||
      privateMessage.rawMime.status === 'pending_hydration'
    ) {
      if (!isNonEmptyString(privateMessage.rawMime.locator)) invalidPrivateSnapshotContract();
      expectedRawPayloads.set(sourceRow.sourceRowId, privateMessage.rawMime.status);
    }

    for (const attachment of privateMessage.attachments) {
      if (
        !isAttachmentDescriptor(attachment) ||
        attachment.messageId !== sourceRow.sourceRowId ||
        attachmentDescriptors.has(attachment.id)
      ) {
        invalidPrivateSnapshotContract();
      }
      attachmentDescriptors.set(attachment.id, attachment);
    }
  }

  const attachmentLocators = new Map<string, ThreadCorpusAttachmentLocator>();
  for (const locator of hydration.attachmentLocators) {
    if (!isThreadCorpusAttachmentLocator(locator) || attachmentLocators.has(locator.attachmentId)) {
      invalidPrivateSnapshotContract();
    }
    const descriptor = attachmentDescriptors.get(locator.attachmentId);
    if (
      !descriptor ||
      descriptor.messageId !== locator.messageId ||
      descriptor.contentType !== locator.mimeType ||
      descriptor.byteSize !== locator.sizeBytes
    ) {
      invalidPrivateSnapshotContract();
    }
    attachmentLocators.set(locator.attachmentId, locator);
  }

  const rawPayloads = new Map<
    string,
    Extract<ThreadCorpusHydrationPayload, { kind: 'raw_mime' }>
  >();
  const attachmentPayloads = new Map<
    string,
    Extract<ThreadCorpusHydrationPayload, { kind: 'attachment_text' }>
  >();
  for (const payload of hydration.payloads) {
    if (!isThreadCorpusHydrationPayload(payload)) invalidPrivateSnapshotContract();
    if (payload.kind === 'raw_mime') {
      const sourceStatus = expectedRawPayloads.get(payload.sourceRowId);
      if (
        sourceStatus === undefined ||
        rawPayloads.has(payload.sourceRowId) ||
        (sourceStatus === 'available' && payload.status !== 'available')
      ) {
        invalidPrivateSnapshotContract();
      }
      rawPayloads.set(payload.sourceRowId, payload);
      continue;
    }

    if (
      !attachmentLocators.has(payload.attachmentId) ||
      attachmentPayloads.has(payload.attachmentId)
    ) {
      invalidPrivateSnapshotContract();
    }
    attachmentPayloads.set(payload.attachmentId, payload);
  }

  if (
    rawPayloads.size !== expectedRawPayloads.size ||
    attachmentPayloads.size !== attachmentLocators.size
  ) {
    invalidPrivateSnapshotContract();
  }

  const rawMimeBySourceRowId = new Map<string, SnapshotRawMime>();
  const textArtifactByAttachmentId = new Map<string, SnapshotAttachmentTextArtifact>();
  const artifactFiles: PrivateThreadCorpusArtifactFile[] = [];
  const artifactKeys = new Set<string>();
  const addArtifact = (
    kind: ThreadCorpusArtifactKind,
    ownerId: string,
    content: Uint8Array,
  ): ThreadCorpusArtifactReference => {
    const artifact = artifactReference(context, kind, ownerId, content);
    const key = `${artifact.kind}\0${artifact.id}`;
    if (artifactKeys.has(key)) invalidPrivateSnapshotContract();
    artifactKeys.add(key);
    artifactFiles.push(artifact);
    return {
      id: artifact.id,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    };
  };

  for (const [sourceRowId, rawMime] of sourceRawMime) {
    if (rawMime.status === 'available' || rawMime.status === 'pending_hydration') {
      const payload = rawPayloads.get(sourceRowId);
      if (!payload) invalidPrivateSnapshotContract();
      rawMimeBySourceRowId.set(sourceRowId, {
        status: payload.status,
        artifact:
          payload.status === 'available'
            ? addArtifact('raw_mime', sourceRowId, payload.content!)
            : null,
      });
      continue;
    }
    rawMimeBySourceRowId.set(sourceRowId, {
      status: rawMime.status as SnapshotRawMime['status'],
      artifact: null,
    });
  }

  for (const [attachmentId] of attachmentDescriptors) {
    if (!attachmentLocators.has(attachmentId)) {
      textArtifactByAttachmentId.set(attachmentId, null);
      continue;
    }
    const payload = attachmentPayloads.get(attachmentId);
    if (!payload) invalidPrivateSnapshotContract();
    textArtifactByAttachmentId.set(attachmentId, {
      status: payload.status,
      artifact:
        payload.status === 'available'
          ? addArtifact('attachment_text', attachmentId, payload.content!)
          : null,
    });
  }

  return {
    rawMimeBySourceRowId,
    textArtifactByAttachmentId,
    artifactFiles: artifactFiles.sort(compareArtifactFiles),
  };
}

function toSnapshotPrivateMessage(
  message: ThreadCorpusPrivateMessage,
  sourceRowId: string,
  plan: HydrationPlan,
): SnapshotPrivateMessage {
  const cloned = clonePrivateMessage(message);
  const rawMime = plan.rawMimeBySourceRowId.get(sourceRowId);
  if (!rawMime) invalidPrivateSnapshotContract();
  return {
    ...cloned,
    rawMime,
    attachments: cloned.attachments.map((attachment) => ({
      ...attachment,
      textArtifact: plan.textArtifactByAttachmentId.get(attachment.id) ?? null,
    })),
  };
}

function toSnapshotSourceRow(row: ThreadCorpusSourceRow, plan: HydrationPlan): SnapshotSourceRow {
  return {
    sourceRowId: row.sourceRowId,
    scopeMembership: sortedUnique(row.scopeMembership) as ThreadCorpusScopeKey[],
    receivedAt: row.receivedAt,
    threadId: row.threadId ?? null,
    messageId: row.messageId ?? null,
    contentFingerprint: row.contentFingerprint ?? null,
    provenanceFingerprint: row.provenanceFingerprint ?? null,
    body: row.body,
    ...(row.privateMessage
      ? { privateMessage: toSnapshotPrivateMessage(row.privateMessage, row.sourceRowId, plan) }
      : {}),
  };
}

function snapshotPrivateMessageSortKey(message: SnapshotPrivateMessage | undefined): string | null {
  return message ? JSON.stringify(message) : null;
}

function snapshotSourceRowSortKey(row: SnapshotSourceRow): string {
  return JSON.stringify([
    row.sourceRowId,
    row.receivedAt,
    row.threadId,
    row.messageId,
    row.contentFingerprint,
    row.provenanceFingerprint,
    row.body,
    row.scopeMembership,
    snapshotPrivateMessageSortKey(row.privateMessage),
  ]);
}

function compareSnapshotSourceRows(left: SnapshotSourceRow, right: SnapshotSourceRow): number {
  return compareText(snapshotSourceRowSortKey(left), snapshotSourceRowSortKey(right));
}

function toSnapshotMessage(message: LogicalMessage, plan: HydrationPlan): SnapshotMessage {
  const sourceRows = message.sourceRows
    .map((row) => toSnapshotSourceRow(row, plan))
    .sort(compareSnapshotSourceRows);
  const timestamp = sourceRows.map((row) => row.receivedAt).sort(compareText)[0] ?? '';

  return {
    timestamp,
    messageId: message.normalizedMessageId,
    sourceRows,
    scopeMembership: sortedUnique(message.scopeMembership) as ThreadCorpusScopeKey[],
    annotations: [...message.annotations].sort(compareText),
  };
}

function snapshotMessageSortKey(message: SnapshotMessage): string {
  return JSON.stringify([
    message.timestamp,
    message.messageId ?? '',
    message.sourceRows[0] ? snapshotSourceRowSortKey(message.sourceRows[0]) : '',
  ]);
}

function compareSnapshotMessages(left: SnapshotMessage, right: SnapshotMessage): number {
  return compareText(snapshotMessageSortKey(left), snapshotMessageSortKey(right));
}

function toThreadSnapshotRecord(
  thread: LogicalThread,
  context: PrivateThreadCorpusSnapshotContext,
  plan: HydrationPlan,
): ThreadSnapshotRecord {
  const messages = thread.messages
    .map((message) => toSnapshotMessage(message, plan))
    .sort(compareSnapshotMessages);
  return {
    recordType: 'thread',
    schemaVersion: CENTURION_THREAD_CORPUS_SCHEMA_VERSION,
    snapshotId: context.snapshotId,
    threadId: thread.threadId,
    threadingStatus: thread.threadId === null ? 'unresolved' : 'resolved',
    threadFirstTimestamp: messages[0]?.timestamp ?? '',
    scopeMembership: sortedUnique(
      messages.flatMap((message) => message.scopeMembership),
    ) as ThreadCorpusScopeKey[],
    messages,
  };
}

function threadSnapshotSortKey(record: ThreadSnapshotRecord): string {
  return JSON.stringify([
    record.threadFirstTimestamp,
    record.threadId ?? '',
    record.messages.map(snapshotMessageSortKey),
  ]);
}

function compareThreadSnapshotRecords(
  left: ThreadSnapshotRecord,
  right: ThreadSnapshotRecord,
): number {
  return compareText(threadSnapshotSortKey(left), threadSnapshotSortKey(right));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const FIXED_SNAPSHOT_SCOPE_KEYS: readonly ThreadCorpusScopeKey[] = [ACTIVE_TRANSPORT_SCOPE_KEY];

const TERMINAL_RAW_MIME_STATUSES = new Set([
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
]);

const SOURCE_RAW_MIME_STATUSES = new Set([...TERMINAL_RAW_MIME_STATUSES, 'pending_hydration']);

const RAW_MIME_HYDRATION_STATUSES = new Set([
  'available',
  'expired_or_missing',
  'too_large',
  'budget_exhausted',
  'read_failed',
]);

const ATTACHMENT_TEXT_HYDRATION_STATUSES = new Set([
  'available',
  'expired_or_missing',
  'too_large',
  'budget_exhausted',
  'unsupported',
  'encrypted',
  'no_embedded_text',
  'malformed',
  'too_many_pages',
  'timeout',
  'parser_failure',
  'read_failed',
]);

function invalidPrivateSnapshotContract(): never {
  throw new Error('Invalid private snapshot contract');
}

function invalidThreadCorpusSourceContract(): never {
  throw new Error('Invalid thread corpus source contract');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[],
): boolean {
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStrictIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    isStrictIso(value)
  );
}

type StrictIsoTimestampInstant = {
  wholeSecondMilliseconds: number;
  fractionalNanoseconds: string;
};

function parseStrictIsoTimestampInstant(value: string): StrictIsoTimestampInstant | null {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match || !isStrictIsoTimestamp(value)) return null;

  const wholeSecondMilliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(wholeSecondMilliseconds)) return null;
  return {
    wholeSecondMilliseconds,
    fractionalNanoseconds: (match[2] ?? '').padEnd(9, '0'),
  };
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function hasCanonicalStringOrder(values: readonly string[]): boolean {
  return JSON.stringify(values) === JSON.stringify(sortedUnique(values));
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isScopeKey(value: unknown): value is ThreadCorpusScopeKey {
  return value === ACTIVE_TRANSPORT_SCOPE_KEY;
}

function isCanonicalScopeMembership(value: unknown): value is ThreadCorpusScopeKey[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isScopeKey) &&
    hasCanonicalStringOrder(value)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSnapshotScope(value: unknown): value is SnapshotScope {
  if (!isRecord(value) || !hasExactKeys(value, ['scopeKeys', 'transportIds', 'messagePredicate'])) {
    return false;
  }

  const scopeKeys = value.scopeKeys;
  const transportIds = value.transportIds;
  return (
    Array.isArray(scopeKeys) &&
    scopeKeys.every(isScopeKey) &&
    sameStrings(scopeKeys, FIXED_SNAPSHOT_SCOPE_KEYS) &&
    isStringArray(transportIds) &&
    transportIds.length > 0 &&
    transportIds.every(isOpaqueIdentifier) &&
    hasCanonicalStringOrder(transportIds) &&
    value.messagePredicate === 'active_transport_before_as_of'
  );
}

function isSnapshotContext(value: unknown): value is PrivateThreadCorpusSnapshotContext {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['snapshotId', 'scope', 'asOf', 'exporterVersion']) &&
    isOpaqueIdentifier(value.snapshotId) &&
    isSnapshotScope(value.scope) &&
    isStrictIsoTimestamp(value.asOf) &&
    isOpaqueIdentifier(value.exporterVersion)
  );
}

function cloneSnapshotContext(
  context: PrivateThreadCorpusSnapshotContext,
): PrivateThreadCorpusSnapshotContext {
  return {
    snapshotId: context.snapshotId,
    scope: {
      scopeKeys: [...context.scope.scopeKeys],
      transportIds: [...context.scope.transportIds],
      messagePredicate: context.scope.messagePredicate,
    },
    asOf: context.asOf,
    exporterVersion: context.exporterVersion,
  };
}

function isThreadCorpusAddresses(value: unknown): value is ThreadCorpusAddresses {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['from', 'to', 'cc', 'bcc']) &&
    isStringArray(value.from) &&
    isStringArray(value.to) &&
    isStringArray(value.cc) &&
    isStringArray(value.bcc)
  );
}

function isCanonicalHeaders(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.values(value).every(isStringArray);
}

function isSourceRawMime(value: unknown): value is ThreadCorpusRawMime {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['locator', 'status']) ||
    !isStringOrNull(value.locator) ||
    !(
      value.status === null ||
      (typeof value.status === 'string' && SOURCE_RAW_MIME_STATUSES.has(value.status))
    )
  ) {
    return false;
  }

  if (value.status === 'pending_hydration') return isNonEmptyString(value.locator);
  if (value.status === 'missing') return value.locator === null;
  return true;
}

function isThreadCorpusAttachmentLocator(value: unknown): value is ThreadCorpusAttachmentLocator {
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

function isHydrationContent(
  value: Record<string, unknown>,
  status: string,
  availableStatuses: ReadonlySet<string>,
): boolean {
  if (!availableStatuses.has(status)) return false;
  if (status === 'available') {
    return (
      Object.hasOwn(value, 'content') &&
      value.content instanceof Uint8Array &&
      value.content.byteLength > 0
    );
  }
  return !Object.hasOwn(value, 'content');
}

function isThreadCorpusHydrationPayload(value: unknown): value is ThreadCorpusHydrationPayload {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'raw_mime') {
    return (
      hasOnlyKeys(
        value,
        ['kind', 'sourceRowId', 'status'],
        ['kind', 'sourceRowId', 'status', 'content'],
      ) &&
      isNonEmptyString(value.sourceRowId) &&
      typeof value.status === 'string' &&
      isHydrationContent(value, value.status, RAW_MIME_HYDRATION_STATUSES)
    );
  }
  if (value.kind === 'attachment_text') {
    return (
      hasOnlyKeys(
        value,
        ['kind', 'attachmentId', 'status'],
        ['kind', 'attachmentId', 'status', 'content'],
      ) &&
      isNonEmptyString(value.attachmentId) &&
      typeof value.status === 'string' &&
      isHydrationContent(value, value.status, ATTACHMENT_TEXT_HYDRATION_STATUSES)
    );
  }
  return false;
}

function isThreadCorpusHydrationInput(value: unknown): value is ThreadCorpusHydrationInput {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['attachmentLocators', 'payloads']) &&
    Array.isArray(value.attachmentLocators) &&
    Array.isArray(value.payloads)
  );
}

function isArtifactReference(value: unknown): value is ThreadCorpusArtifactReference {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'sha256', 'bytes']) &&
    typeof value.id === 'string' &&
    /^[a-f0-9]{64}$/.test(value.id) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    isNonNegativeSafeInteger(value.bytes) &&
    value.bytes > 0
  );
}

function isSnapshotRawMime(value: unknown): value is SnapshotRawMime {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['status', 'artifact']) &&
    typeof value.status === 'string' &&
    TERMINAL_RAW_MIME_STATUSES.has(value.status) &&
    ((value.status === 'available' && isArtifactReference(value.artifact)) ||
      (value.status !== 'available' && value.artifact === null))
  );
}

function isSnapshotAttachmentTextArtifact(value: unknown): value is SnapshotAttachmentTextArtifact {
  if (value === null) return true;
  return (
    isRecord(value) &&
    hasExactKeys(value, ['status', 'artifact']) &&
    typeof value.status === 'string' &&
    ATTACHMENT_TEXT_HYDRATION_STATUSES.has(value.status) &&
    ((value.status === 'available' && isArtifactReference(value.artifact)) ||
      (value.status !== 'available' && value.artifact === null))
  );
}

function isAttachmentDescriptor(value: unknown): value is ThreadCorpusAttachmentDescriptor {
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

function isAttachmentSourceDescriptor(
  value: unknown,
): value is ThreadCorpusAttachmentSourceDescriptor {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'messageId', 'filename', 'contentType', 'byteSize', 's3Key']) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.messageId) &&
    typeof value.filename === 'string' &&
    typeof value.contentType === 'string' &&
    isNonNegativeSafeInteger(value.byteSize) &&
    isNonEmptyString(value.s3Key)
  );
}

function selectIncludedAttachmentSources(
  descriptors: readonly ThreadCorpusAttachmentSourceDescriptor[],
  knownSourceRowIds: ReadonlySet<string>,
  includedSourceRowIds: ReadonlySet<string>,
): {
  attachmentsByMessageId: Map<string, ThreadCorpusAttachmentSourceDescriptor[]>;
  attachmentLocators: ThreadCorpusAttachmentLocator[];
} {
  const included: ThreadCorpusAttachmentSourceDescriptor[] = [];
  const attachmentIds = new Set<string>();

  for (const descriptor of descriptors) {
    const ownerId =
      isRecord(descriptor) && typeof descriptor.messageId === 'string'
        ? descriptor.messageId
        : null;
    if (!ownerId || !knownSourceRowIds.has(ownerId)) invalidThreadCorpusSourceContract();
    if (!includedSourceRowIds.has(ownerId)) continue;
    if (!isAttachmentSourceDescriptor(descriptor) || attachmentIds.has(descriptor.id)) {
      invalidThreadCorpusSourceContract();
    }
    attachmentIds.add(descriptor.id);
    included.push(descriptor);
  }

  const ordered = included.sort(compareAttachmentDescriptors);
  return {
    attachmentsByMessageId: groupByMessageId(ordered),
    attachmentLocators: ordered
      .map((descriptor) => ({
        attachmentId: descriptor.id,
        messageId: descriptor.messageId,
        s3Key: descriptor.s3Key,
        mimeType: descriptor.contentType,
        sizeBytes: descriptor.byteSize,
      }))
      .sort(
        (left, right) =>
          compareText(left.messageId, right.messageId) ||
          compareText(left.attachmentId, right.attachmentId),
      ),
  };
}

function isDraftRevisionLink(value: unknown): value is ThreadCorpusDraftRevisionLink {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['messageId', 'draftId', 'revisionId']) &&
    isNonEmptyString(value.messageId) &&
    isStringOrNull(value.draftId) &&
    isStringOrNull(value.revisionId)
  );
}

function isOutboundQueueState(value: unknown): value is ThreadCorpusOutboundQueueState {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['messageId', 'state']) &&
    isNonEmptyString(value.messageId) &&
    ['sent', 'pending', 'sending', 'cancelled', 'unknown'].includes(value.state as string)
  );
}

function isOutboundDelivery(value: unknown): value is ThreadCorpusOutboundDelivery {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['queueState', 'deliveryStatus']) &&
    ['sent', 'pending', 'sending', 'cancelled', 'unknown'].includes(value.queueState as string) &&
    ['smtp_accepted', 'not_claimed'].includes(value.deliveryStatus as string)
  );
}

function isSnapshotAttachmentDescriptor(value: unknown): value is SnapshotAttachmentDescriptor {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'id',
      'messageId',
      'filename',
      'contentType',
      'byteSize',
      'textArtifact',
    ]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.messageId) &&
    typeof value.filename === 'string' &&
    typeof value.contentType === 'string' &&
    isNonNegativeSafeInteger(value.byteSize) &&
    isSnapshotAttachmentTextArtifact(value.textArtifact)
  );
}

function isSnapshotPrivateMessage(value: unknown): value is SnapshotPrivateMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'subject',
      'direction',
      'addresses',
      'originalAddresses',
      'canonicalHeaders',
      'sentAt',
      'rawMime',
      'attachments',
      'draftRevisionLinks',
      'outboundDelivery',
      'sourceMetadata',
    ]) &&
    typeof value.subject === 'string' &&
    typeof value.direction === 'string' &&
    isThreadCorpusAddresses(value.addresses) &&
    isThreadCorpusAddresses(value.originalAddresses) &&
    isCanonicalHeaders(value.canonicalHeaders) &&
    (value.sentAt === null || isStrictIsoTimestamp(value.sentAt)) &&
    isSnapshotRawMime(value.rawMime) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isSnapshotAttachmentDescriptor) &&
    Array.isArray(value.draftRevisionLinks) &&
    value.draftRevisionLinks.every(isDraftRevisionLink) &&
    isOutboundDelivery(value.outboundDelivery) &&
    isRecord(value.sourceMetadata) &&
    hasExactKeys(value.sourceMetadata, ['transportId']) &&
    isOpaqueIdentifier(value.sourceMetadata.transportId)
  );
}

function isSnapshotSourceRow(value: unknown): value is SnapshotSourceRow {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'sourceRowId',
        'scopeMembership',
        'receivedAt',
        'threadId',
        'messageId',
        'contentFingerprint',
        'provenanceFingerprint',
        'body',
      ],
      [
        'sourceRowId',
        'scopeMembership',
        'receivedAt',
        'threadId',
        'messageId',
        'contentFingerprint',
        'provenanceFingerprint',
        'body',
        'privateMessage',
      ],
    )
  ) {
    return false;
  }

  return (
    isNonEmptyString(value.sourceRowId) &&
    isCanonicalScopeMembership(value.scopeMembership) &&
    isStrictIsoTimestamp(value.receivedAt) &&
    isStringOrNull(value.threadId) &&
    isStringOrNull(value.messageId) &&
    isStringOrNull(value.contentFingerprint) &&
    isStringOrNull(value.provenanceFingerprint) &&
    typeof value.body === 'string' &&
    (value.privateMessage === undefined || isSnapshotPrivateMessage(value.privateMessage))
  );
}

function isAnnotations(value: unknown): value is Array<'unresolved_duplicate_candidate'> {
  return (
    Array.isArray(value) &&
    value.every((annotation) => annotation === 'unresolved_duplicate_candidate') &&
    value.length <= 1
  );
}

function isSnapshotMessage(value: unknown): value is SnapshotMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'timestamp',
      'messageId',
      'sourceRows',
      'scopeMembership',
      'annotations',
    ]) &&
    isStrictIsoTimestamp(value.timestamp) &&
    isStringOrNull(value.messageId) &&
    Array.isArray(value.sourceRows) &&
    value.sourceRows.length > 0 &&
    value.sourceRows.every(isSnapshotSourceRow) &&
    isCanonicalScopeMembership(value.scopeMembership) &&
    isAnnotations(value.annotations)
  );
}

function isThreadSnapshotRecord(value: unknown): value is ThreadSnapshotRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'recordType',
      'schemaVersion',
      'snapshotId',
      'threadId',
      'threadingStatus',
      'threadFirstTimestamp',
      'scopeMembership',
      'messages',
    ]) &&
    value.recordType === 'thread' &&
    value.schemaVersion === CENTURION_THREAD_CORPUS_SCHEMA_VERSION &&
    isOpaqueIdentifier(value.snapshotId) &&
    isStringOrNull(value.threadId) &&
    (value.threadingStatus === 'resolved' || value.threadingStatus === 'unresolved') &&
    isStrictIsoTimestamp(value.threadFirstTimestamp) &&
    isCanonicalScopeMembership(value.scopeMembership) &&
    Array.isArray(value.messages) &&
    value.messages.length > 0 &&
    value.messages.every(isSnapshotMessage)
  );
}

function isSnapshotMetadataRecord(value: unknown): value is SnapshotMetadataRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'recordType',
      'schemaVersion',
      'snapshotId',
      'orderedRecordSha256',
      'recordCount',
    ]) &&
    value.recordType === 'metadata' &&
    value.schemaVersion === CENTURION_THREAD_CORPUS_SCHEMA_VERSION &&
    isOpaqueIdentifier(value.snapshotId) &&
    typeof value.orderedRecordSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.orderedRecordSha256) &&
    isNonNegativeSafeInteger(value.recordCount)
  );
}

function isSnapshotManifestCounts(value: unknown): value is SnapshotManifestCounts {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'sourceRows',
      'logicalMessages',
      'unresolvedDuplicateCandidates',
      'threads',
      'attachments',
      'drafts',
      'revisions',
      'rawMimeAvailable',
      'rawMimeUnavailable',
      'attachmentTextAvailable',
      'attachmentTextUnavailable',
      'messagesByScope',
    ])
  ) {
    return false;
  }

  const numericKeys = [
    'sourceRows',
    'logicalMessages',
    'unresolvedDuplicateCandidates',
    'threads',
    'attachments',
    'drafts',
    'revisions',
    'rawMimeAvailable',
    'rawMimeUnavailable',
    'attachmentTextAvailable',
    'attachmentTextUnavailable',
  ] as const;
  if (!numericKeys.every((key) => isNonNegativeSafeInteger(value[key]))) {
    return false;
  }

  const messagesByScope = value.messagesByScope;
  return (
    isRecord(messagesByScope) &&
    hasExactKeys(messagesByScope, FIXED_SNAPSHOT_SCOPE_KEYS) &&
    FIXED_SNAPSHOT_SCOPE_KEYS.every((key) => isNonNegativeSafeInteger(messagesByScope[key]))
  );
}

function isSnapshotManifest(value: unknown): value is SnapshotManifestV2 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'snapshotId',
      'scope',
      'window',
      'exporterVersion',
      'orderedRecordSha256',
      'localObjectSha256',
      'artifactInventorySha256',
      'counts',
      'sourceObject',
    ]) &&
    value.schemaVersion === CENTURION_THREAD_CORPUS_SCHEMA_VERSION &&
    isOpaqueIdentifier(value.snapshotId) &&
    isSnapshotScope(value.scope) &&
    isRecord(value.window) &&
    hasExactKeys(value.window, ['startInclusive', 'endExclusive']) &&
    value.window.startInclusive === null &&
    isStrictIsoTimestamp(value.window.endExclusive) &&
    isOpaqueIdentifier(value.exporterVersion) &&
    typeof value.orderedRecordSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.orderedRecordSha256) &&
    typeof value.localObjectSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.localObjectSha256) &&
    typeof value.artifactInventorySha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.artifactInventorySha256) &&
    isSnapshotManifestCounts(value.counts) &&
    isRecord(value.sourceObject) &&
    hasExactKeys(value.sourceObject, ['integrity']) &&
    value.sourceObject.integrity === 'content_hash_only'
  );
}

function scopesForRows(rows: readonly SnapshotSourceRow[]): ThreadCorpusScopeKey[] {
  return sortedUnique(rows.flatMap((row) => row.scopeMembership)) as ThreadCorpusScopeKey[];
}

function assertDerivedSnapshotTopology(
  records: readonly SnapshotRecord[],
  context: PrivateThreadCorpusSnapshotContext,
): void {
  const toTopologySourceRow = (sourceRow: SnapshotSourceRow): ThreadCorpusSourceRow => ({
    sourceRowId: sourceRow.sourceRowId,
    scopeMembership: [...sourceRow.scopeMembership],
    receivedAt: sourceRow.receivedAt,
    threadId: sourceRow.threadId,
    messageId: sourceRow.messageId,
    contentFingerprint: sourceRow.contentFingerprint,
    provenanceFingerprint: sourceRow.provenanceFingerprint,
    body: sourceRow.body,
  });
  const toTopologySnapshotSourceRow = (sourceRow: ThreadCorpusSourceRow): SnapshotSourceRow => ({
    sourceRowId: sourceRow.sourceRowId,
    scopeMembership: sortedUnique(sourceRow.scopeMembership) as ThreadCorpusScopeKey[],
    receivedAt: sourceRow.receivedAt,
    threadId: sourceRow.threadId ?? null,
    messageId: sourceRow.messageId ?? null,
    contentFingerprint: sourceRow.contentFingerprint ?? null,
    provenanceFingerprint: sourceRow.provenanceFingerprint ?? null,
    body: sourceRow.body,
  });
  const toTopologySnapshotMessage = (message: LogicalMessage): SnapshotMessage => {
    const sourceRows = message.sourceRows
      .map(toTopologySnapshotSourceRow)
      .sort(compareSnapshotSourceRows);
    return {
      timestamp: sourceRows.map((sourceRow) => sourceRow.receivedAt).sort(compareText)[0] ?? '',
      messageId: message.normalizedMessageId,
      sourceRows,
      scopeMembership: sortedUnique(message.scopeMembership) as ThreadCorpusScopeKey[],
      annotations: [...message.annotations].sort(compareText),
    };
  };
  const formatted = formatLogicalMessages(
    records.flatMap((record) =>
      record.messages.flatMap((message) => message.sourceRows.map(toTopologySourceRow)),
    ),
  );
  const expectedRecords: SnapshotRecord[] = [
    ...formatted.threads
      .map((thread) => {
        const messages = thread.messages
          .map(toTopologySnapshotMessage)
          .sort(compareSnapshotMessages);
        return {
          recordType: 'thread' as const,
          schemaVersion:
            CENTURION_THREAD_CORPUS_SCHEMA_VERSION as typeof CENTURION_THREAD_CORPUS_SCHEMA_VERSION,
          snapshotId: context.snapshotId,
          threadId: thread.threadId,
          threadingStatus:
            thread.threadId === null ? ('unresolved' as const) : ('resolved' as const),
          threadFirstTimestamp: messages[0]?.timestamp ?? '',
          scopeMembership: sortedUnique(
            messages.flatMap((message) => message.scopeMembership),
          ) as ThreadCorpusScopeKey[],
          messages,
        };
      })
      .sort(compareThreadSnapshotRecords),
  ];
  const withoutPrivateMessages = records.map((record) => ({
    ...record,
    messages: record.messages.map((message) => ({
      ...message,
      sourceRows: message.sourceRows.map(
        ({ privateMessage: _privateMessage, ...sourceRow }) => sourceRow,
      ),
    })),
  }));
  if (
    serializeJsonLines(withoutPrivateMessages as SnapshotRecord[]) !==
    serializeJsonLines(expectedRecords)
  ) {
    invalidPrivateSnapshotContract();
  }
}

type ReferencedArtifact = ThreadCorpusArtifactReference & {
  kind: ThreadCorpusArtifactKind;
};

function assertSnapshotRecordInvariants(
  records: readonly SnapshotRecord[],
  context: PrivateThreadCorpusSnapshotContext,
): ReferencedArtifact[] {
  const sourceRowIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const draftIds = new Set<string>();
  const revisionIds = new Set<string>();
  const threadIds = new Set<string>();
  const referencedArtifactKeys = new Set<string>();
  const referencedArtifacts: ReferencedArtifact[] = [];
  const asOf = parseStrictIsoTimestampInstant(context.asOf);
  const activeTransportIds = new Set(context.scope.transportIds);

  const assertBeforeAsOf = (timestamp: string): void => {
    const candidate = parseStrictIsoTimestampInstant(timestamp);
    if (
      asOf === null ||
      candidate === null ||
      candidate.wholeSecondMilliseconds > asOf.wholeSecondMilliseconds ||
      (candidate.wholeSecondMilliseconds === asOf.wholeSecondMilliseconds &&
        candidate.fractionalNanoseconds >= asOf.fractionalNanoseconds)
    ) {
      invalidPrivateSnapshotContract();
    }
  };
  const assertArtifact = (
    kind: ThreadCorpusArtifactKind,
    ownerId: string,
    reference: ThreadCorpusArtifactReference,
  ): void => {
    if (reference.id !== artifactId(context.snapshotId, kind, ownerId)) {
      invalidPrivateSnapshotContract();
    }
    const key = `${kind}\0${reference.id}`;
    if (referencedArtifactKeys.has(key)) invalidPrivateSnapshotContract();
    referencedArtifactKeys.add(key);
    referencedArtifacts.push({ kind, ...reference });
  };

  const assertSourceRows = (sourceRows: readonly SnapshotSourceRow[]): void => {
    if (
      JSON.stringify(sourceRows) !== JSON.stringify([...sourceRows].sort(compareSnapshotSourceRows))
    ) {
      invalidPrivateSnapshotContract();
    }
    for (const sourceRow of sourceRows) {
      if (sourceRowIds.has(sourceRow.sourceRowId)) {
        invalidPrivateSnapshotContract();
      }
      assertBeforeAsOf(sourceRow.receivedAt);
      sourceRowIds.add(sourceRow.sourceRowId);

      const privateMessage = sourceRow.privateMessage;
      if (!privateMessage) continue;
      if (!activeTransportIds.has(privateMessage.sourceMetadata.transportId)) {
        invalidPrivateSnapshotContract();
      }
      if (privateMessage.sentAt !== null) assertBeforeAsOf(privateMessage.sentAt);
      if (privateMessage.rawMime.status === 'available') {
        assertArtifact('raw_mime', sourceRow.sourceRowId, privateMessage.rawMime.artifact!);
      }
      for (const attachment of privateMessage.attachments) {
        if (attachmentIds.has(attachment.id) || attachment.messageId !== sourceRow.sourceRowId) {
          invalidPrivateSnapshotContract();
        }
        attachmentIds.add(attachment.id);
        const textArtifact = attachment.textArtifact;
        if (textArtifact?.status === 'available') {
          assertArtifact('attachment_text', attachment.id, textArtifact.artifact!);
        }
      }
      for (const link of privateMessage.draftRevisionLinks) {
        if (link.messageId !== sourceRow.sourceRowId) invalidPrivateSnapshotContract();
        if (link.draftId !== null) {
          if (draftIds.has(link.draftId)) invalidPrivateSnapshotContract();
          draftIds.add(link.draftId);
        }
        if (link.revisionId !== null) {
          if (revisionIds.has(link.revisionId)) invalidPrivateSnapshotContract();
          revisionIds.add(link.revisionId);
        }
      }
    }
  };

  for (const record of records) {
    if (
      (record.threadId === null && record.threadingStatus !== 'unresolved') ||
      (record.threadId !== null && record.threadingStatus !== 'resolved') ||
      (record.threadId !== null && threadIds.has(record.threadId))
    ) {
      invalidPrivateSnapshotContract();
    }
    if (record.threadId !== null) threadIds.add(record.threadId);
    if (
      JSON.stringify(record.messages) !==
      JSON.stringify([...record.messages].sort(compareSnapshotMessages))
    ) {
      invalidPrivateSnapshotContract();
    }
    assertBeforeAsOf(record.threadFirstTimestamp);
    if (record.threadFirstTimestamp !== record.messages[0]?.timestamp) {
      invalidPrivateSnapshotContract();
    }

    for (const message of record.messages) {
      assertBeforeAsOf(message.timestamp);
      const expectedTimestamp = [...message.sourceRows]
        .map((sourceRow) => sourceRow.receivedAt)
        .sort(compareText)[0];
      if (
        message.timestamp !== expectedTimestamp ||
        !sameStrings(message.scopeMembership, scopesForRows(message.sourceRows))
      ) {
        invalidPrivateSnapshotContract();
      }
      assertSourceRows(message.sourceRows);
    }
    if (
      !sameStrings(
        record.scopeMembership,
        sortedUnique(
          record.messages.flatMap((message) => message.scopeMembership),
        ) as ThreadCorpusScopeKey[],
      )
    ) {
      invalidPrivateSnapshotContract();
    }
  }
  assertDerivedSnapshotTopology(records, context);
  return referencedArtifacts.sort(compareArtifactFiles);
}

function deriveSnapshotManifestCounts(
  records: readonly SnapshotRecord[],
  _context: PrivateThreadCorpusSnapshotContext,
): SnapshotManifestCounts {
  const messagesByScope: Record<ThreadCorpusScopeKey, number> = {
    [ACTIVE_TRANSPORT_SCOPE_KEY]: 0,
  };
  let sourceRows = 0;
  let logicalMessages = 0;
  let unresolvedDuplicateCandidates = 0;
  let threads = 0;
  let attachments = 0;
  let drafts = 0;
  let revisions = 0;
  let rawMimeAvailable = 0;
  let rawMimeUnavailable = 0;
  let attachmentTextAvailable = 0;
  let attachmentTextUnavailable = 0;

  const countSourceRows = (rows: readonly SnapshotSourceRow[]): void => {
    for (const sourceRow of rows) {
      sourceRows += 1;
      const privateMessage = sourceRow.privateMessage;
      if (privateMessage?.rawMime.status === 'available') {
        rawMimeAvailable += 1;
      } else {
        rawMimeUnavailable += 1;
      }
      attachments += privateMessage?.attachments.length ?? 0;
      for (const attachment of privateMessage?.attachments ?? []) {
        if (attachment.textArtifact?.status === 'available') {
          attachmentTextAvailable += 1;
        } else {
          attachmentTextUnavailable += 1;
        }
      }
      drafts +=
        privateMessage?.draftRevisionLinks.filter((link) => link.draftId !== null).length ?? 0;
      revisions +=
        privateMessage?.draftRevisionLinks.filter((link) => link.revisionId !== null).length ?? 0;
    }
  };

  for (const record of records) {
    threads += 1;
    for (const message of record.messages) {
      logicalMessages += 1;
      if (message.annotations.includes('unresolved_duplicate_candidate')) {
        unresolvedDuplicateCandidates += 1;
      }
      for (const scopeKey of message.scopeMembership) {
        messagesByScope[scopeKey] += 1;
      }
      countSourceRows(message.sourceRows);
    }
  }

  return {
    sourceRows,
    logicalMessages,
    unresolvedDuplicateCandidates,
    threads,
    attachments,
    drafts,
    revisions,
    rawMimeAvailable,
    rawMimeUnavailable,
    attachmentTextAvailable,
    attachmentTextUnavailable,
    messagesByScope,
  };
}

function serializeJsonLines(records: readonly SnapshotRecord[]): string {
  return records.length === 0
    ? ''
    : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function isPrivateThreadCorpusArtifactFile(
  value: unknown,
): value is PrivateThreadCorpusArtifactFile {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'id', 'sha256', 'bytes', 'content']) &&
    (value.kind === 'raw_mime' || value.kind === 'attachment_text') &&
    typeof value.id === 'string' &&
    /^[a-f0-9]{64}$/.test(value.id) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    isNonNegativeSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    value.content instanceof Uint8Array &&
    value.content.byteLength === value.bytes &&
    sha256Bytes(value.content) === value.sha256
  );
}

function canonicalArtifactInventorySha256(
  artifactFiles: readonly Pick<
    PrivateThreadCorpusArtifactFile,
    'kind' | 'id' | 'sha256' | 'bytes'
  >[],
): string {
  return sha256(
    artifactFiles
      .map(
        (artifact) => `${artifact.kind}\t${artifact.id}\t${artifact.sha256}\t${artifact.bytes}\n`,
      )
      .join(''),
  );
}

function validateArtifactFiles(value: unknown): PrivateThreadCorpusArtifactFile[] {
  if (!Array.isArray(value) || !value.every(isPrivateThreadCorpusArtifactFile)) {
    invalidPrivateSnapshotContract();
  }
  const artifactFiles = value;
  const keys = new Set<string>();
  for (let index = 0; index < artifactFiles.length; index += 1) {
    const artifact = artifactFiles[index]!;
    if (
      (index > 0 && compareArtifactFiles(artifactFiles[index - 1]!, artifact) >= 0) ||
      keys.has(`${artifact.kind}\0${artifact.id}`)
    ) {
      invalidPrivateSnapshotContract();
    }
    keys.add(`${artifact.kind}\0${artifact.id}`);
  }
  return artifactFiles;
}

function parseJsonRecord(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalidPrivateSnapshotContract();
  }
}

function validatePrivateThreadCorpusSnapshotUnsafe(snapshot: unknown): void {
  if (
    !isRecord(snapshot) ||
    !hasExactKeys(snapshot, [
      'context',
      'corpusJsonl',
      'manifestJson',
      'manifest',
      'artifactFiles',
    ]) ||
    !isSnapshotContext(snapshot.context) ||
    typeof snapshot.corpusJsonl !== 'string' ||
    typeof snapshot.manifestJson !== 'string' ||
    !isSnapshotManifest(snapshot.manifest) ||
    !Array.isArray(snapshot.artifactFiles)
  ) {
    invalidPrivateSnapshotContract();
  }

  const context = cloneSnapshotContext(snapshot.context);
  const corpusJsonl = snapshot.corpusJsonl;
  const manifestJson = snapshot.manifestJson;
  const artifactFiles = validateArtifactFiles(snapshot.artifactFiles);
  if (!corpusJsonl.endsWith('\n') || !manifestJson.endsWith('\n')) {
    invalidPrivateSnapshotContract();
  }

  const corpusLines = corpusJsonl.slice(0, -1).split('\n');
  if (corpusLines.length === 0 || corpusLines.some((line) => line.length === 0)) {
    invalidPrivateSnapshotContract();
  }
  const metadataLine = corpusLines[0];
  if (metadataLine === undefined) invalidPrivateSnapshotContract();
  const metadata = parseJsonRecord(metadataLine);
  if (!isSnapshotMetadataRecord(metadata) || JSON.stringify(metadata) !== metadataLine) {
    invalidPrivateSnapshotContract();
  }

  const records: SnapshotRecord[] = [];
  for (const line of corpusLines.slice(1)) {
    const record = parseJsonRecord(line);
    if (isThreadSnapshotRecord(record)) {
      records.push(record);
      continue;
    }
    invalidPrivateSnapshotContract();
  }
  const suppliedOrderedRecordJsonl =
    records.length === 0 ? '' : `${corpusLines.slice(1).join('\n')}\n`;
  const orderedRecordJsonl = serializeJsonLines(records);
  if (
    orderedRecordJsonl !== suppliedOrderedRecordJsonl ||
    metadata.schemaVersion !== CENTURION_THREAD_CORPUS_SCHEMA_VERSION ||
    metadata.snapshotId !== context.snapshotId ||
    metadata.orderedRecordSha256 !== sha256(orderedRecordJsonl)
  ) {
    invalidPrivateSnapshotContract();
  }

  if (
    metadata.recordCount !== records.length ||
    records.some(
      (record) =>
        record.schemaVersion !== CENTURION_THREAD_CORPUS_SCHEMA_VERSION ||
        record.snapshotId !== context.snapshotId,
    )
  ) {
    invalidPrivateSnapshotContract();
  }

  const canonicalRecords: SnapshotRecord[] = [...records].sort(compareThreadSnapshotRecords);
  if (serializeJsonLines(canonicalRecords) !== orderedRecordJsonl) {
    invalidPrivateSnapshotContract();
  }
  const referencedArtifacts = assertSnapshotRecordInvariants(records, context);
  if (
    artifactFiles.length !== referencedArtifacts.length ||
    artifactFiles.some((artifact, index) => {
      const reference = referencedArtifacts[index];
      return (
        !reference ||
        artifact.kind !== reference.kind ||
        artifact.id !== reference.id ||
        artifact.sha256 !== reference.sha256 ||
        artifact.bytes !== reference.bytes
      );
    })
  ) {
    invalidPrivateSnapshotContract();
  }

  const manifestValue = parseJsonRecord(manifestJson);
  if (
    !isSnapshotManifest(manifestValue) ||
    manifestJson !== `${JSON.stringify(manifestValue, null, 2)}\n` ||
    JSON.stringify(snapshot.manifest) !== JSON.stringify(manifestValue)
  ) {
    invalidPrivateSnapshotContract();
  }

  const manifest = manifestValue;
  if (
    manifest.schemaVersion !== CENTURION_THREAD_CORPUS_SCHEMA_VERSION ||
    manifest.snapshotId !== context.snapshotId ||
    JSON.stringify(manifest.scope) !== JSON.stringify(context.scope) ||
    manifest.window.startInclusive !== null ||
    manifest.window.endExclusive !== context.asOf ||
    manifest.exporterVersion !== context.exporterVersion ||
    manifest.orderedRecordSha256 !== sha256(orderedRecordJsonl) ||
    manifest.localObjectSha256 !== sha256(corpusJsonl) ||
    manifest.artifactInventorySha256 !== canonicalArtifactInventorySha256(artifactFiles) ||
    JSON.stringify(manifest.counts) !==
      JSON.stringify(deriveSnapshotManifestCounts(records, context)) ||
    manifest.sourceObject.integrity !== 'content_hash_only'
  ) {
    invalidPrivateSnapshotContract();
  }
}

/**
 * Parses and reconciles private snapshot bytes without exposing record content in errors.
 */
export function validatePrivateThreadCorpusSnapshot(snapshot: PrivateThreadCorpusSnapshot): void {
  try {
    validatePrivateThreadCorpusSnapshotUnsafe(snapshot);
  } catch {
    invalidPrivateSnapshotContract();
  }
}

/**
 * Builds deterministic private corpus bytes from already formatted synthetic or local records.
 */
export function buildPrivateThreadCorpusSnapshot(
  args: PrivateThreadCorpusSnapshotBuildArgs,
): PrivateThreadCorpusSnapshot {
  try {
    if (!isSnapshotContext(args.context)) invalidPrivateSnapshotContract();
    assertNoLegacyQuarantineFields(args.formatted);
    const context = cloneSnapshotContext(args.context);
    const hydrationPlan = createHydrationPlan(context, args.formatted, args.hydration);
    const threadRecords = args.formatted.threads
      .map((thread) => toThreadSnapshotRecord(thread, context, hydrationPlan))
      .sort(compareThreadSnapshotRecords);
    const records: SnapshotRecord[] = threadRecords;
    const orderedRecordJsonl = serializeJsonLines(records);
    const orderedRecordSha256 = sha256(orderedRecordJsonl);
    const metadata: SnapshotMetadataRecord = {
      recordType: 'metadata',
      schemaVersion: CENTURION_THREAD_CORPUS_SCHEMA_VERSION,
      snapshotId: context.snapshotId,
      orderedRecordSha256,
      recordCount: threadRecords.length,
    };
    const corpusJsonl = `${JSON.stringify(metadata)}\n${orderedRecordJsonl}`;
    const manifest: PrivateThreadCorpusManifest = {
      schemaVersion: CENTURION_THREAD_CORPUS_SCHEMA_VERSION,
      snapshotId: context.snapshotId,
      scope: cloneSnapshotContext(context).scope,
      window: {
        startInclusive: null,
        endExclusive: context.asOf,
      },
      exporterVersion: context.exporterVersion,
      orderedRecordSha256,
      localObjectSha256: sha256(corpusJsonl),
      artifactInventorySha256: canonicalArtifactInventorySha256(hydrationPlan.artifactFiles),
      counts: deriveSnapshotManifestCounts(records, context),
      sourceObject: {
        integrity: 'content_hash_only',
      },
    };
    const snapshot: PrivateThreadCorpusSnapshot = {
      context,
      corpusJsonl,
      manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
      manifest,
      artifactFiles: hydrationPlan.artifactFiles,
    };
    validatePrivateThreadCorpusSnapshot(snapshot);
    return snapshot;
  } catch {
    return invalidPrivateSnapshotContract();
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
  );
}

async function assertTrustedDirectory(
  fileSystem: PrivateArtifactFileSystem,
  directory: string,
  label: string,
): Promise<void> {
  const entry = await fileSystem.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Trusted ${label} must be a non-symlink directory`);
  }
  if ((await fileSystem.realpath(directory)) !== directory) {
    throw new Error(`Trusted ${label} must not cross a symlink or junction`);
  }
}

async function ensureTrustedDirectory(
  fileSystem: PrivateArtifactFileSystem,
  directory: string,
  label: string,
): Promise<void> {
  try {
    await fileSystem.lstat(directory);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    try {
      await fileSystem.mkdir(directory, { recursive: false, mode: 0o700 });
    } catch (createError) {
      if (!isAlreadyExistsError(createError)) throw createError;
    }
  }
  await assertTrustedDirectory(fileSystem, directory, label);
}

type TrustedPrivateCorpusRoot = {
  repoRoot: string;
  corpusRoot: string;
};

async function canonicalTrustedPrivateCorpusRoot(
  fileSystem: PrivateArtifactFileSystem,
  repoRoot: string,
): Promise<TrustedPrivateCorpusRoot> {
  const requestedRepoRoot = path.resolve(repoRoot);
  const canonicalRepoRoot = await fileSystem.realpath(requestedRepoRoot);
  if (canonicalRepoRoot !== requestedRepoRoot) {
    throw new Error('Trusted repo root must not be a symlink or junction');
  }
  await assertTrustedDirectory(fileSystem, canonicalRepoRoot, 'repo root');

  const privateRoot = path.join(canonicalRepoRoot, '.private');
  await ensureTrustedDirectory(fileSystem, privateRoot, 'private root');
  const corpusRoot = path.join(privateRoot, 'centurion-thread-corpus');
  await ensureTrustedDirectory(fileSystem, corpusRoot, 'private corpus root');
  return { repoRoot: canonicalRepoRoot, corpusRoot };
}

function directSnapshotOutDir(trustedRoot: TrustedPrivateCorpusRoot, outDir: string): string {
  const resolvedOutDir = path.resolve(trustedRoot.repoRoot, outDir);
  if (path.dirname(resolvedOutDir) !== trustedRoot.corpusRoot) {
    throw new Error('--out-dir must name a direct child snapshot directory');
  }
  return resolvedOutDir;
}

async function setRestrictivePermissions(
  fileSystem: PrivateArtifactFileSystem,
  target: string,
  mode: number,
): Promise<void> {
  try {
    await fileSystem.chmod(target, mode);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EPERM') {
      return;
    }
    throw error;
  }
}

async function revalidateTrustedRoot(
  fileSystem: PrivateArtifactFileSystem,
  repoRoot: string,
  expectedRoot: TrustedPrivateCorpusRoot,
  requestedOutDir: string,
): Promise<void> {
  const revalidatedRoot = await canonicalTrustedPrivateCorpusRoot(fileSystem, repoRoot);
  if (
    revalidatedRoot.repoRoot !== expectedRoot.repoRoot ||
    revalidatedRoot.corpusRoot !== expectedRoot.corpusRoot ||
    directSnapshotOutDir(revalidatedRoot, requestedOutDir) !==
      directSnapshotOutDir(expectedRoot, requestedOutDir)
  ) {
    throw new Error('Trusted private corpus root changed before publication');
  }
}

function privateArtifactPath(
  snapshotDirectory: string,
  artifact: Pick<PrivateThreadCorpusArtifactFile, 'kind' | 'id'>,
): { directory: string; temporary: string; target: string } {
  if (!/^[a-f0-9]{64}$/.test(artifact.id)) invalidPrivateSnapshotContract();
  const directoryName = artifact.kind === 'raw_mime' ? 'raw-mime' : 'attachment-text';
  const extension = artifact.kind === 'raw_mime' ? 'eml' : 'txt';
  const filename = `${artifact.id}.${extension}`;
  if (path.basename(filename) !== filename) invalidPrivateSnapshotContract();
  const directory = path.join(snapshotDirectory, directoryName);
  const target = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.tmp`);
  if (
    path.dirname(directory) !== snapshotDirectory ||
    path.dirname(target) !== directory ||
    path.dirname(temporary) !== directory
  ) {
    invalidPrivateSnapshotContract();
  }
  return { directory, temporary, target };
}

async function writePrivateTextFile(
  fileSystem: PrivateArtifactFileSystem,
  temporary: string,
  target: string,
  content: string,
  revalidate: () => Promise<void>,
): Promise<void> {
  await fileSystem.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await setRestrictivePermissions(fileSystem, temporary, 0o600);
  await revalidate();
  await fileSystem.rename(temporary, target);
}

async function writePrivateArtifactFile(
  fileSystem: PrivateArtifactFileSystem,
  temporary: string,
  target: string,
  content: Uint8Array,
  revalidate: () => Promise<void>,
): Promise<void> {
  await fileSystem.writeFile(temporary, content, { mode: 0o600 });
  await setRestrictivePermissions(fileSystem, temporary, 0o600);
  await revalidate();
  await fileSystem.rename(temporary, target);
}

/**
 * Creates a testable publisher; snapshots allocate a unique immutable directory per request.
 * Trusted-local-filesystem limitation: permission changes do not provide hostile-process WORM.
 */
export function createPrivateThreadCorpusPublisher(
  fileSystem: PrivateArtifactFileSystem = LOCAL_PRIVATE_ARTIFACT_FILE_SYSTEM,
): (args: PrivateThreadCorpusPublishArgs) => Promise<{ outDir: string }> {
  return async (args) => {
    const snapshot = buildPrivateThreadCorpusSnapshot({
      context: args.context,
      formatted: args.formatted,
      hydration: args.hydration,
    });
    validatePrivateThreadCorpusSnapshot(snapshot);
    const trustedRoot = await canonicalTrustedPrivateCorpusRoot(fileSystem, args.repoRoot);
    const requestedOutDir = directSnapshotOutDir(trustedRoot, args.outDir);
    const snapshotStem = path.basename(requestedOutDir);
    let allocatedOutDir: string | undefined;

    try {
      await revalidateTrustedRoot(fileSystem, args.repoRoot, trustedRoot, args.outDir);
      allocatedOutDir = await fileSystem.mkdtemp(
        path.join(trustedRoot.corpusRoot, `${snapshotStem}-`),
      );
      if (path.dirname(allocatedOutDir) !== trustedRoot.corpusRoot) {
        throw new Error('Allocated snapshot directory escaped trusted private corpus root');
      }
      await setRestrictivePermissions(fileSystem, allocatedOutDir, 0o700);

      const corpusTemporaryPath = path.join(allocatedOutDir, '.corpus.jsonl.tmp');
      const corpusPath = path.join(allocatedOutDir, 'corpus.jsonl');
      const manifestTemporaryPath = path.join(allocatedOutDir, '.manifest.json.tmp');
      const manifestPath = path.join(allocatedOutDir, 'manifest.json');
      const revalidate = () =>
        revalidateTrustedRoot(fileSystem, args.repoRoot, trustedRoot, args.outDir);
      await writePrivateTextFile(
        fileSystem,
        corpusTemporaryPath,
        corpusPath,
        snapshot.corpusJsonl,
        revalidate,
      );

      const createdArtifactDirectories = new Set<string>();
      for (const artifact of snapshot.artifactFiles) {
        const paths = privateArtifactPath(allocatedOutDir, artifact);
        if (!createdArtifactDirectories.has(paths.directory)) {
          await fileSystem.mkdir(paths.directory, { recursive: false, mode: 0o700 });
          await setRestrictivePermissions(fileSystem, paths.directory, 0o700);
          createdArtifactDirectories.add(paths.directory);
        }
        await writePrivateArtifactFile(
          fileSystem,
          paths.temporary,
          paths.target,
          artifact.content,
          revalidate,
        );
      }

      await writePrivateTextFile(
        fileSystem,
        manifestTemporaryPath,
        manifestPath,
        snapshot.manifestJson,
        revalidate,
      );
      await revalidateTrustedRoot(fileSystem, args.repoRoot, trustedRoot, args.outDir);
      try {
        await setRestrictivePermissions(fileSystem, allocatedOutDir, 0o500);
      } catch {
        // Best effort only; local trusted filesystems cannot provide hostile-process WORM.
      }

      const publishedOutDir = allocatedOutDir;
      allocatedOutDir = undefined;
      return { outDir: publishedOutDir };
    } finally {
      if (allocatedOutDir) {
        await fileSystem.rm(allocatedOutDir, { recursive: true, force: true });
      }
    }
  };
}

/**
 * Publishes into a unique immutable snapshot directory derived from the requested stem.
 */
export async function publishPrivateThreadCorpusSnapshot(
  args: PrivateThreadCorpusPublishArgs,
): Promise<{ outDir: string }> {
  return createPrivateThreadCorpusPublisher()(args);
}
