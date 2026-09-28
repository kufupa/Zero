import { getPostgresSslOptions } from '../db/ssl-config.js';
import postgres from 'postgres';

type DatabaseRow = Record<string, unknown>;

type ThreadCorpusRawMime = {
  locator: string | null;
  status: string | null;
};

export type ThreadCorpusAttachmentSourceDescriptor = {
  id: string;
  messageId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  s3Key: string;
  inline?: boolean;
  contentId?: string | null;
};

type ThreadCorpusDraftRevisionLink = {
  messageId: string;
  draftId: string | null;
  revisionId: string | null;
};

type ThreadCorpusOutboundQueueState = {
  messageId: string;
  state: 'sent' | 'pending' | 'sending' | 'cancelled' | 'unknown';
};

type ThreadCorpusMessageRow = {
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

/** Fixed production scope for the nine-day Centurion evidence snapshot. */
export const CENTURION_TRANSPORT_ID = 'transport-centurion' as const;
export const CENTURION_WINDOW_TIMEZONE = 'Africa/Johannesburg' as const;
export const CENTURION_WINDOW_START_UTC = '2026-09-07T22:00:00.000Z' as const;
export const CENTURION_WINDOW_END_UTC = '2026-09-16T22:00:00.000Z' as const;
/** 26-28 Sep 2026 Johannesburg, the reservationist backtest window. */
export const CENTURION_BACKTEST_WINDOW = {
  transportId: CENTURION_TRANSPORT_ID,
  startInclusive: '2026-09-25T22:00:00.000Z',
  endExclusive: '2026-09-28T22:00:00.000Z',
} as const;

export type CenturionCorpusWindow = {
  startInclusive: string;
  endExclusive: string;
  timezone: typeof CENTURION_WINDOW_TIMEZONE;
};

export type CenturionEventAtSource =
  | 'sent_at_confirmed_outbound'
  | 'received_at'
  | 'sent_at_fallback'
  | 'created_at'
  | 'missing';

export type CenturionBusinessDirection = 'inbound' | 'outbound' | 'unknown';

export type CenturionBusinessDirectionSource =
  | 'transport_identity'
  | 'message_direction'
  | 'unknown';

export type CenturionCorpusMessageScope = 'in_window' | 'context_only' | 'missing_event_at';

/**
 * Complete message evidence used by the fixed Centurion snapshot. `direction` and
 * `messageDirection` intentionally retain the persisted message value; business direction is
 * a separate inference and must not overwrite it.
 */
export type CenturionCorpusMessageRow = {
  id: string;
  transportId: string;
  threadId: string | null;
  messageId: string | null;
  direction: string;
  messageDirection: string;
  businessDirection: CenturionBusinessDirection;
  businessDirectionSource: CenturionBusinessDirectionSource;
  subject: string;
  textBody: string;
  htmlBody: string;
  from: readonly string[];
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  receivedAt: string | null;
  sentAt: string | null;
  createdAt: string | null;
  eventAt: string | null;
  eventAtSource: CenturionEventAtSource;
  eventAtFallback: boolean;
  inReplyTo: string | null;
  references: readonly string[];
  rawMimeLocator: string | null;
  attachmentDescriptors: readonly ThreadCorpusAttachmentSourceDescriptor[];
  confirmedOutbound: boolean;
  queueState: string | null;
  scope: CenturionCorpusMessageScope;
  contextOnly: boolean;
  dailyIncluded: boolean;
};

export type CenturionCorpusSnapshot = {
  asOf: string;
  transportId: typeof CENTURION_TRANSPORT_ID;
  window: CenturionCorpusWindow;
  messages: readonly CenturionCorpusMessageRow[];
  counts: {
    sourceRowCount: number;
    includedMessageCount: number;
    contextOnlyMessageCount: number;
    missingEventAtCount: number;
  };
};

export type CenturionCorpusSnapshotRequest = {
  transportId?: typeof CENTURION_TRANSPORT_ID;
  startInclusive?: string;
  endExclusive?: string;
};

type UnscopedCenturionCorpusMessage = Omit<
  CenturionCorpusMessageRow,
  'attachmentDescriptors' | 'scope' | 'contextOnly' | 'dailyIncluded'
>;

type ActiveTransportScope = {
  asOf: string;
  transportIds: readonly string[];
};

type ThreadCorpusSnapshotReadSession = {
  asOf: string;
  discoverActiveTransportScope(): Promise<ActiveTransportScope>;
  readMessages(): Promise<readonly ThreadCorpusMessageRow[]>;
  readAttachmentDescriptors(): Promise<readonly ThreadCorpusAttachmentSourceDescriptor[]>;
  readMalformedAttachmentDescriptorCount?(): Promise<number>;
  readDraftRevisionLinks(): Promise<readonly ThreadCorpusDraftRevisionLink[]>;
  readOutboundQueueDeliveryStates(): Promise<readonly ThreadCorpusOutboundQueueState[]>;
};

type ThreadCorpusSnapshotReader = {
  withRepeatableReadOnly<T>(
    load: (session: ThreadCorpusSnapshotReadSession) => Promise<T>,
  ): Promise<T>;
};

export type ThreadCorpusPostgresClient = {
  <TRow extends DatabaseRow = DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromiseLike<readonly TRow[]>;
  begin<T>(
    options: string,
    load: (connection: ThreadCorpusPostgresClient) => Promise<T>,
  ): Promise<T>;
  end(): Promise<void>;
};

export type ThreadCorpusPostgresClientOptions = {
  max: 1;
  ssl: ReturnType<typeof getPostgresSslOptions>;
};

export type ThreadCorpusPostgresClientFactory = (
  databaseUrl: string,
  options: ThreadCorpusPostgresClientOptions,
) => ThreadCorpusPostgresClient;

export type ThreadCorpusPostgresReaderOptions = {
  databaseUrl: string;
  asOf?: string;
  clientFactory?: ThreadCorpusPostgresClientFactory;
};

export type ThreadCorpusPostgresReader = ThreadCorpusSnapshotReader & {
  readCenturionSnapshot(request?: CenturionCorpusSnapshotRequest): Promise<CenturionCorpusSnapshot>;
  close(): Promise<void>;
};

type ActiveTransportRow = {
  id?: unknown;
};

type MessageRow = {
  id?: unknown;
  transportId?: unknown;
  messageThreadId?: unknown;
  resolvedThreadId?: unknown;
  threadTransportId?: unknown;
  messageId?: unknown;
  receivedAt?: unknown;
  sentAt?: unknown;
  subject?: unknown;
  body?: unknown;
  direction?: unknown;
  fromAddress?: unknown;
  toAddresses?: unknown;
  ccAddresses?: unknown;
  bccAddresses?: unknown;
  inReplyTo?: unknown;
  references?: unknown;
  rawMimeLocator?: unknown;
};

type AttachmentRow = {
  id?: unknown;
  messageId?: unknown;
  filename?: unknown;
  contentType?: unknown;
  byteSize?: unknown;
  s3Key?: unknown;
  inline?: unknown;
  contentId?: unknown;
};

type DraftRevisionRow = {
  messageId?: unknown;
  draftId?: unknown;
  revisionId?: unknown;
};

type QueueRow = {
  messageId?: unknown;
  transportId?: unknown;
  status?: unknown;
};

type CenturionTransportRow = {
  id?: unknown;
  email?: unknown;
  ownerHeaderValue?: unknown;
  sendFromConfig?: unknown;
  isActive?: unknown;
};

type CenturionMessageRow = {
  id?: unknown;
  transportId?: unknown;
  messageThreadId?: unknown;
  resolvedThreadId?: unknown;
  threadTransportId?: unknown;
  messageId?: unknown;
  direction?: unknown;
  subject?: unknown;
  textBody?: unknown;
  htmlBody?: unknown;
  fromAddress?: unknown;
  toAddresses?: unknown;
  ccAddresses?: unknown;
  bccAddresses?: unknown;
  receivedAt?: unknown;
  sentAt?: unknown;
  createdAt?: unknown;
  inReplyTo?: unknown;
  references?: unknown;
  rawMimeLocator?: unknown;
  confirmedQueueStatus?: unknown;
  queueStatus?: unknown;
};

type Selection = {
  asOf: string | undefined;
};

type SessionLifecycle = {
  assertActive(): void;
  register<T>(operation: () => Promise<T>): Promise<T>;
  settle(): Promise<void>;
  invalidate(): void;
};

type AttachmentDescriptorReadResult = {
  descriptors: ThreadCorpusAttachmentSourceDescriptor[];
  malformedCount: number;
};

const KNOWN_QUEUE_STATES = new Set<ThreadCorpusOutboundQueueState['state']>([
  'sent',
  'pending',
  'sending',
  'cancelled',
  'unknown',
]);

function defaultClientFactory(
  databaseUrl: string,
  options: ThreadCorpusPostgresClientOptions,
): ThreadCorpusPostgresClient {
  return postgres(databaseUrl, options) as unknown as ThreadCorpusPostgresClient;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function timestampOrNull(value: unknown): string | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' && value.trim()
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function distinctText(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = textOrNull(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function sortedDistinctText(values: readonly string[]): string[] {
  return distinctText(values).sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
    return typeof parsed === 'string' ? [parsed] : [];
  } catch {
    return [value];
  }
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalHeaders(row: MessageRow): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  const messageId = textOrNull(row.messageId);
  const inReplyTo = textOrNull(row.inReplyTo);
  const references = stringArray(row.references);
  if (messageId) headers['Message-ID'] = [messageId];
  if (inReplyTo) headers['In-Reply-To'] = [inReplyTo];
  if (references.length > 0) headers.References = references;
  return headers;
}

function mapMessageRow(row: MessageRow): ThreadCorpusMessageRow | null {
  const id = textOrNull(row.id);
  const transportId = textOrNull(row.transportId);
  const receivedAt = timestampOrNull(row.receivedAt);
  if (!id || !transportId || !receivedAt) return null;

  const messageThreadId = textOrNull(row.messageThreadId);
  const resolvedThreadId = textOrNull(row.resolvedThreadId);
  const threadTransportId = textOrNull(row.threadTransportId);
  if (resolvedThreadId && threadTransportId && threadTransportId !== transportId) {
    return null;
  }

  const locator = textOrNull(row.rawMimeLocator);
  return {
    id,
    transportId,
    threadId:
      resolvedThreadId && messageThreadId && threadTransportId === transportId
        ? messageThreadId
        : null,
    messageId: textOrNull(row.messageId),
    receivedAt,
    sentAt: timestampOrNull(row.sentAt),
    subject: textOrEmpty(row.subject),
    body: textOrEmpty(row.body),
    direction: textOrNull(row.direction) ?? 'unknown',
    from: stringArray(row.fromAddress),
    to: stringArray(row.toAddresses),
    cc: stringArray(row.ccAddresses),
    bcc: stringArray(row.bccAddresses),
    canonicalHeaders: canonicalHeaders(row),
    rawMime: {
      locator,
      status: locator ? 'pending_hydration' : 'missing',
    },
  };
}

function mapAttachmentRow(row: AttachmentRow): ThreadCorpusAttachmentSourceDescriptor | null {
  const id = textOrNull(row.id);
  const messageId = textOrNull(row.messageId);
  const filename = textOrNull(row.filename);
  const contentType = textOrNull(row.contentType);
  const byteSize = nonNegativeInteger(row.byteSize);
  const s3Key = textOrNull(row.s3Key);
  if (!id || !messageId || !filename || !contentType || byteSize === null || !s3Key) return null;
  const inline = typeof row.inline === 'boolean' ? row.inline : undefined;
  const contentId = row.contentId === null || typeof row.contentId === 'string' ? row.contentId : undefined;
  return {
    id,
    messageId,
    filename,
    contentType,
    byteSize,
    s3Key,
    ...(inline !== undefined ? { inline } : {}),
    ...(contentId !== undefined ? { contentId } : {}),
  };
}

function mapDraftRevisionRow(row: DraftRevisionRow): ThreadCorpusDraftRevisionLink | null {
  const messageId = textOrNull(row.messageId);
  const draftId = textOrNull(row.draftId);
  const revisionId = textOrNull(row.revisionId);
  if (!messageId || (!draftId && !revisionId)) return null;
  return { messageId, draftId, revisionId };
}

function mapQueueRow(
  row: QueueRow,
  transportIdByMessageId: ReadonlyMap<string, string>,
): ThreadCorpusOutboundQueueState | null {
  const messageId = textOrNull(row.messageId);
  const transportId = textOrNull(row.transportId);
  const expectedTransportId = messageId ? transportIdByMessageId.get(messageId) : undefined;
  if (!messageId || !transportId || !expectedTransportId || transportId !== expectedTransportId) {
    return null;
  }
  const status = textOrNull(row.status);
  return {
    messageId,
    state:
      status && KNOWN_QUEUE_STATES.has(status as ThreadCorpusOutboundQueueState['state'])
        ? (status as ThreadCorpusOutboundQueueState['state'])
        : 'unknown',
  };
}

function selectionFrom(options: ThreadCorpusPostgresReaderOptions): Selection {
  const databaseUrl = textOrNull(options.databaseUrl);
  if (!databaseUrl) throw new Error('Reader configuration is incomplete');
  if (options.asOf === undefined) {
    return { asOf: undefined };
  }
  const asOf = timestampOrNull(options.asOf);
  if (!asOf) throw new Error('Snapshot timestamp is invalid');
  return { asOf };
}

async function resolveAsOf(
  connection: ThreadCorpusPostgresClient,
  suppliedAsOf: string | undefined,
): Promise<string> {
  if (suppliedAsOf) return suppliedAsOf;
  const rows = await connection<{ asOf?: unknown }>`
    SELECT CURRENT_TIMESTAMP AS "asOf"
  `;
  const asOf = timestampOrNull(rows[0]?.asOf);
  if (!asOf) throw new Error('Snapshot timestamp unavailable');
  return asOf;
}

async function discoverActiveTransportScope(
  connection: ThreadCorpusPostgresClient,
  asOf: string,
): Promise<ActiveTransportScope> {
  const rows = await connection<ActiveTransportRow>`
    SELECT id
    FROM mailbox_transport
    WHERE is_active = true
    ORDER BY id
  `;
  return {
    asOf,
    transportIds: sortedDistinctText(rows.map((row) => textOrNull(row.id) ?? '')),
  };
}

function assertNonEmptyActiveTransportScope(scope: ActiveTransportScope): void {
  if (scope.transportIds.length === 0) {
    throw new Error('Active transport scope is empty');
  }
}

async function readMessages(
  connection: ThreadCorpusPostgresClient,
  scope: ActiveTransportScope,
): Promise<ThreadCorpusMessageRow[]> {
  const rows = await connection<MessageRow>`
    SELECT
      m.id,
      m.transport_id AS "transportId",
      m.thread_id AS "messageThreadId",
      t.id AS "resolvedThreadId",
      t.transport_id AS "threadTransportId",
      m.message_id_header AS "messageId",
      COALESCE(m.received_at, m.sent_at, m.created_at) AS "receivedAt",
      m.sent_at AS "sentAt",
      m.subject,
      COALESCE(NULLIF(m.text_body, ''), m.html_body, '') AS "body",
      m.direction::text AS "direction",
      m.from_address AS "fromAddress",
      m.to_addresses AS "toAddresses",
      m.cc_addresses AS "ccAddresses",
      m.bcc_addresses AS "bccAddresses",
      m.in_reply_to AS "inReplyTo",
      m."references" AS "references",
      m.raw_mime_s3_key AS "rawMimeLocator"
    FROM message AS m
    LEFT JOIN mail_thread AS t ON t.id = m.thread_id
    WHERE COALESCE(m.received_at, m.sent_at, m.created_at) < ${scope.asOf}
      AND m.transport_id = ANY(${scope.transportIds})
      AND (t.id IS NULL OR m.transport_id IS NULL OR t.transport_id IS NULL OR t.transport_id = m.transport_id)
    ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at), m.id
  `;
  return rows.map(mapMessageRow).filter((row): row is ThreadCorpusMessageRow => row !== null);
}

async function readAttachmentDescriptors(
  connection: ThreadCorpusPostgresClient,
  messageIds: readonly string[],
  scope: ActiveTransportScope,
): Promise<AttachmentDescriptorReadResult> {
  if (messageIds.length === 0) return { descriptors: [], malformedCount: 0 };
  const rows = await connection<AttachmentRow>`
    SELECT
      a.id,
      a.message_id AS "messageId",
      a.filename,
      a.mime_type AS "contentType",
      a.size_bytes AS "byteSize",
      a.s3_key AS "s3Key",
      a.is_inline AS "inline",
      a.content_id AS "contentId"
    FROM attachment AS a
    INNER JOIN message AS m ON m.id = a.message_id
    WHERE a.message_id = ANY(${messageIds})
      AND m.transport_id = ANY(${scope.transportIds})
      AND COALESCE(m.received_at, m.sent_at, m.created_at) < ${scope.asOf}
      AND a.created_at < ${scope.asOf}
    ORDER BY a.message_id, a.id
  `;
  const selectedMessageIds = new Set(messageIds);
  const mapped = rows.map(mapAttachmentRow);
  const malformedCount = mapped.reduce((count, row) => count + (row === null ? 1 : 0), 0);
  return {
    descriptors: mapped
      .filter((row): row is ThreadCorpusAttachmentSourceDescriptor => row !== null)
      .filter((row) => selectedMessageIds.has(row.messageId)),
    malformedCount,
  };
}

function centurionWindowFrom(
  request: CenturionCorpusSnapshotRequest = {},
): CenturionCorpusWindow {
  if (request.transportId !== undefined && request.transportId !== CENTURION_TRANSPORT_ID) {
    throw new Error('Centurion transport scope is fixed');
  }
  if (
    request.startInclusive === CENTURION_BACKTEST_WINDOW.startInclusive &&
    request.endExclusive === CENTURION_BACKTEST_WINDOW.endExclusive
  ) {
    return {
      startInclusive: CENTURION_BACKTEST_WINDOW.startInclusive,
      endExclusive: CENTURION_BACKTEST_WINDOW.endExclusive,
      timezone: CENTURION_WINDOW_TIMEZONE,
    };
  }
  if (
    (request.startInclusive !== undefined &&
      request.startInclusive !== CENTURION_WINDOW_START_UTC) ||
    (request.endExclusive !== undefined && request.endExclusive !== CENTURION_WINDOW_END_UTC)
  ) {
    throw new Error('Centurion window is fixed');
  }
  return {
    startInclusive: CENTURION_WINDOW_START_UTC,
    endExclusive: CENTURION_WINDOW_END_UTC,
    timezone: CENTURION_WINDOW_TIMEZONE,
  };
}

function utcNaiveTimestamp(value: string): string {
  return value.endsWith('Z') ? value.slice(0, -1) : value;
}

function normalizedAddress(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  const bracketed = text.match(/<\s*([^<>]+?)\s*>/);
  return (bracketed?.[1] ?? text).trim().toLowerCase() || null;
}

function nestedIdentityValues(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const parsed = stringArray(value);
    return parsed.length > 0 ? parsed : [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => nestedIdentityValues(item, depth + 1));
  }
  if (typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap((item) =>
    nestedIdentityValues(item, depth + 1),
  );
}

function transportIdentitySet(row: CenturionTransportRow): ReadonlySet<string> {
  return new Set(
    [row.email, row.ownerHeaderValue, ...nestedIdentityValues(row.sendFromConfig)]
      .map(normalizedAddress)
      .filter((value): value is string => value !== null),
  );
}

function centurionTransportRow(row: CenturionTransportRow): ReadonlySet<string> {
  if (textOrNull(row.id) !== CENTURION_TRANSPORT_ID || row.isActive === false) {
    throw new Error('Centurion transport is unavailable');
  }
  return transportIdentitySet(row);
}

async function readCenturionTransport(
  connection: ThreadCorpusPostgresClient,
): Promise<ReadonlySet<string>> {
  const rows = await connection<CenturionTransportRow>`
    SELECT
      id,
      email,
      owner_header_value AS "ownerHeaderValue",
      send_from_config AS "sendFromConfig",
      is_active AS "isActive"
    FROM mailbox_transport
    WHERE id = ${CENTURION_TRANSPORT_ID}
      AND is_active = true
  `;
  const row = rows.find((candidate) => textOrNull(candidate.id) === CENTURION_TRANSPORT_ID);
  if (!row) throw new Error('Centurion transport is unavailable');
  return centurionTransportRow(row);
}

function eventAtForCenturionMessage(row: CenturionMessageRow): {
  eventAt: string | null;
  eventAtSource: CenturionEventAtSource;
  eventAtFallback: boolean;
  confirmedOutbound: boolean;
} {
  const direction = textOrNull(row.direction) ?? 'unknown';
  const sentAt = timestampOrNull(row.sentAt);
  const confirmedOutbound = direction === 'outbound' && textOrNull(row.confirmedQueueStatus ?? row.queueStatus) === 'sent' && sentAt !== null;
  if (confirmedOutbound) {
    return {
      eventAt: sentAt,
      eventAtSource: 'sent_at_confirmed_outbound',
      eventAtFallback: false,
      confirmedOutbound: true,
    };
  }
  const receivedAt = timestampOrNull(row.receivedAt);
  if (receivedAt) {
    return {
      eventAt: receivedAt,
      eventAtSource: 'received_at',
      eventAtFallback: false,
      confirmedOutbound: false,
    };
  }
  if (sentAt) {
    return {
      eventAt: sentAt,
      eventAtSource: 'sent_at_fallback',
      eventAtFallback: true,
      confirmedOutbound: false,
    };
  }
  const createdAt = timestampOrNull(row.createdAt);
  if (createdAt) {
    return {
      eventAt: createdAt,
      eventAtSource: 'created_at',
      eventAtFallback: true,
      confirmedOutbound: false,
    };
  }
  return {
    eventAt: null,
    eventAtSource: 'missing',
    eventAtFallback: true,
    confirmedOutbound: false,
  };
}

function inferCenturionBusinessDirection(
  row: CenturionMessageRow,
  identities: ReadonlySet<string>,
): {
  direction: CenturionBusinessDirection;
  source: CenturionBusinessDirectionSource;
} {
  const from = stringArray(row.fromAddress);
  const recipients = [
    ...stringArray(row.toAddresses),
    ...stringArray(row.ccAddresses),
    ...stringArray(row.bccAddresses),
  ];
  const fromMatches = from.some((value) => {
    const normalized = normalizedAddress(value);
    return normalized !== null && identities.has(normalized);
  });
  const recipientMatches = recipients.some((value) => {
    const normalized = normalizedAddress(value);
    return normalized !== null && identities.has(normalized);
  });
  if (fromMatches) return { direction: 'outbound', source: 'transport_identity' };
  if (recipientMatches) return { direction: 'inbound', source: 'transport_identity' };

  const persistedDirection = textOrNull(row.direction);
  if (persistedDirection === 'inbound' || persistedDirection === 'outbound') {
    return { direction: persistedDirection, source: 'message_direction' };
  }
  return { direction: 'unknown', source: 'unknown' };
}

function mapCenturionMessageRow(
  row: CenturionMessageRow,
  identities: ReadonlySet<string>,
): {
  message: UnscopedCenturionCorpusMessage;
  eventAt: string | null;
} | null {
  const id = textOrNull(row.id);
  const transportId = textOrNull(row.transportId);
  if (!id || transportId !== CENTURION_TRANSPORT_ID) return null;
  const resolvedThreadId = textOrNull(row.resolvedThreadId);
  const messageThreadId = textOrNull(row.messageThreadId);
  const threadTransportId = textOrNull(row.threadTransportId);
  if (resolvedThreadId && threadTransportId && threadTransportId !== transportId) return null;
  const direction = textOrNull(row.direction) ?? 'unknown';
  const event = eventAtForCenturionMessage(row);
  const business = inferCenturionBusinessDirection(row, identities);
  return {
    eventAt: event.eventAt,
    message: {
      id,
      transportId,
      threadId:
        resolvedThreadId && messageThreadId && threadTransportId === transportId
          ? messageThreadId
          : null,
      messageId: textOrNull(row.messageId),
      direction,
      messageDirection: direction,
      businessDirection: business.direction,
      businessDirectionSource: business.source,
      subject: textOrEmpty(row.subject),
      textBody: textOrEmpty(row.textBody),
      htmlBody: textOrEmpty(row.htmlBody),
      from: stringArray(row.fromAddress),
      to: stringArray(row.toAddresses),
      cc: stringArray(row.ccAddresses),
      bcc: stringArray(row.bccAddresses),
      receivedAt: timestampOrNull(row.receivedAt),
      sentAt: timestampOrNull(row.sentAt),
      createdAt: timestampOrNull(row.createdAt),
      eventAt: event.eventAt,
      eventAtSource: event.eventAtSource,
      eventAtFallback: event.eventAtFallback,
      inReplyTo: textOrNull(row.inReplyTo),
      references: stringArray(row.references),
      rawMimeLocator: textOrNull(row.rawMimeLocator),
      confirmedOutbound: event.confirmedOutbound,
      queueState: textOrNull(row.confirmedQueueStatus ?? row.queueStatus),
    },
  };
}

async function readCenturionMessages(
  connection: ThreadCorpusPostgresClient,
  asOf: string,
  window: CenturionCorpusWindow,
  identities: ReadonlySet<string>,
): Promise<UnscopedCenturionCorpusMessage[]> {
  const snapshotAsOf = utcNaiveTimestamp(asOf);
  const startInclusive = utcNaiveTimestamp(window.startInclusive);
  const endExclusive = utcNaiveTimestamp(window.endExclusive);
  const rows = await connection<CenturionMessageRow>`
    WITH candidates AS (
      SELECT
        m.id,
        m.thread_id AS "messageThreadId",
        CASE
          WHEN m.direction::text = 'outbound'
            AND m.sent_at IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM outbound_send_queue AS q
              WHERE q.message_id = m.id
                AND q.transport_id = m.transport_id
                AND q.status = 'sent'
                AND q.created_at < ${snapshotAsOf}
            ) THEN m.sent_at
          WHEN m.received_at IS NOT NULL THEN m.received_at
          WHEN m.sent_at IS NOT NULL THEN m.sent_at
          ELSE m.created_at
        END AS "eventAt"
      FROM message AS m
      LEFT JOIN mail_thread AS t ON t.id = m.thread_id
      WHERE m.transport_id = ${CENTURION_TRANSPORT_ID}
        AND (m.created_at < ${snapshotAsOf} OR m.created_at IS NULL)
        AND (t.id IS NULL OR t.transport_id IS NULL OR t.transport_id = m.transport_id)
    ),
    in_window_threads AS (
      SELECT DISTINCT c."messageThreadId" AS thread_id
      FROM candidates AS c
      WHERE c."eventAt" >= ${startInclusive}
        AND c."eventAt" < ${endExclusive}
        AND c."eventAt" < ${snapshotAsOf}
        AND c."messageThreadId" IS NOT NULL
    ),
    selected_candidates AS (
      SELECT c.id, c."messageThreadId", c."eventAt"
      FROM candidates AS c
      WHERE (
        c."eventAt" >= ${startInclusive}
        AND c."eventAt" < ${endExclusive}
        AND c."eventAt" < ${snapshotAsOf}
      )
        OR (
          c."eventAt" < ${startInclusive}
          AND c."messageThreadId" IN (SELECT thread_id FROM in_window_threads)
        )
        OR c."eventAt" IS NULL
    )
    SELECT
      m.id,
      m.transport_id AS "transportId",
      m.thread_id AS "messageThreadId",
      t.id AS "resolvedThreadId",
      t.transport_id AS "threadTransportId",
      m.message_id_header AS "messageId",
      m.direction::text AS "direction",
      m.subject,
      m.text_body AS "textBody",
      m.html_body AS "htmlBody",
      m.from_address AS "fromAddress",
      m.to_addresses AS "toAddresses",
      m.cc_addresses AS "ccAddresses",
      m.bcc_addresses AS "bccAddresses",
      m.received_at AS "receivedAt",
      m.sent_at AS "sentAt",
      m.created_at AS "createdAt",
      m.in_reply_to AS "inReplyTo",
      m."references" AS "references",
      m.raw_mime_s3_key AS "rawMimeLocator",
      (
        SELECT q.status
        FROM outbound_send_queue AS q
        WHERE q.message_id = m.id
          AND q.transport_id = m.transport_id
          AND q.status = 'sent'
          AND q.created_at < ${snapshotAsOf}
        ORDER BY q.created_at DESC, q.id DESC
        LIMIT 1
      ) AS "confirmedQueueStatus"
    FROM selected_candidates AS selected
    INNER JOIN message AS m ON m.id = selected.id
    LEFT JOIN mail_thread AS t ON t.id = m.thread_id
    WHERE m.transport_id = ${CENTURION_TRANSPORT_ID}
      AND (m.created_at < ${snapshotAsOf} OR m.created_at IS NULL)
      AND (t.id IS NULL OR t.transport_id IS NULL OR t.transport_id = m.transport_id)
    ORDER BY selected."eventAt" NULLS LAST, m.id
  `;
  return rows
    .map((row) => mapCenturionMessageRow(row, identities))
    .filter((row): row is NonNullable<ReturnType<typeof mapCenturionMessageRow>> => row !== null)
    .map((row) => ({
      ...row.message,
      attachmentDescriptors: [],
      scope: 'missing_event_at' as const,
      contextOnly: false,
      dailyIncluded: false,
    }));
}

async function readCenturionAttachmentDescriptors(
  connection: ThreadCorpusPostgresClient,
  messageIds: readonly string[],
  asOf: string,
): Promise<ThreadCorpusAttachmentSourceDescriptor[]> {
  if (messageIds.length === 0) return [];
  const rows = await connection<AttachmentRow>`
    SELECT
      a.id,
      a.message_id AS "messageId",
      a.filename,
      a.mime_type AS "contentType",
      a.size_bytes AS "byteSize",
      a.s3_key AS "s3Key",
      a.is_inline AS "inline",
      a.content_id AS "contentId"
    FROM attachment AS a
    INNER JOIN message AS m ON m.id = a.message_id
    WHERE a.message_id = ANY(${messageIds})
      AND m.transport_id = ${CENTURION_TRANSPORT_ID}
      AND m.created_at < ${asOf}
      AND a.created_at < ${asOf}
    ORDER BY a.message_id, a.id
  `;
  const selected = new Set(messageIds);
  return rows
    .map(mapAttachmentRow)
    .filter((row): row is ThreadCorpusAttachmentSourceDescriptor => row !== null)
    .filter((row) => selected.has(row.messageId));
}

function classifyCenturionMessages(
  messages: readonly UnscopedCenturionCorpusMessage[],
  window: CenturionCorpusWindow,
): CenturionCorpusMessageRow[] {
  const mainThreadIds = new Set(
    messages
      .filter(
        (message) =>
          message.eventAt !== null &&
          message.eventAt >= window.startInclusive &&
          message.eventAt < window.endExclusive,
      )
      .map((message) => message.threadId)
      .filter((threadId): threadId is string => threadId !== null),
  );
  const classified = messages.flatMap((message) => {
    const inWindow =
      message.eventAt !== null &&
      message.eventAt >= window.startInclusive &&
      message.eventAt < window.endExclusive;
    const contextOnly =
      !inWindow &&
      message.eventAt !== null &&
      message.eventAt < window.startInclusive &&
      message.threadId !== null &&
      mainThreadIds.has(message.threadId);
    const missingEventAt = message.eventAt === null;
    if (!inWindow && !contextOnly && !missingEventAt) return [];
    return [
      {
        ...message,
        scope: inWindow ? ('in_window' as const) : contextOnly ? ('context_only' as const) : ('missing_event_at' as const),
        contextOnly,
        dailyIncluded: inWindow,
        attachmentDescriptors: [],
      },
    ];
  });
  const scopeRank: Record<CenturionCorpusMessageScope, number> = {
    in_window: 0,
    context_only: 1,
    missing_event_at: 2,
  };
  return classified.sort((left, right) => {
    const scopeOrder = scopeRank[left.scope] - scopeRank[right.scope];
    if (scopeOrder !== 0) return scopeOrder;
    if (left.eventAt === null && right.eventAt !== null) return 1;
    if (left.eventAt !== null && right.eventAt === null) return -1;
    const eventOrder = (left.eventAt ?? '').localeCompare(right.eventAt ?? '');
    return eventOrder || left.id.localeCompare(right.id);
  });
}

async function readCenturionSnapshotInTransaction(
  connection: ThreadCorpusPostgresClient,
  asOf: string,
  window: CenturionCorpusWindow,
): Promise<CenturionCorpusSnapshot> {
  const identities = await readCenturionTransport(connection);
  const messages = classifyCenturionMessages(
    await readCenturionMessages(connection, asOf, window, identities),
    window,
  );
  const descriptors = await readCenturionAttachmentDescriptors(
    connection,
    messages.map((message) => message.id),
    asOf,
  );
  const descriptorsByMessageId = new Map<string, ThreadCorpusAttachmentSourceDescriptor[]>();
  for (const descriptor of descriptors) {
    const existing = descriptorsByMessageId.get(descriptor.messageId) ?? [];
    existing.push(descriptor);
    descriptorsByMessageId.set(descriptor.messageId, existing);
  }
  const completedMessages = messages.map((message) => ({
    ...message,
    attachmentDescriptors: (descriptorsByMessageId.get(message.id) ?? []).map((descriptor) => ({
      ...descriptor,
    })),
  }));
  return {
    asOf,
    transportId: CENTURION_TRANSPORT_ID,
    window,
    messages: completedMessages,
    counts: {
      sourceRowCount: completedMessages.length,
      includedMessageCount: completedMessages.filter((message) => message.dailyIncluded).length,
      contextOnlyMessageCount: completedMessages.filter((message) => message.contextOnly).length,
      missingEventAtCount: completedMessages.filter((message) => message.eventAt === null).length,
    },
  };
}

async function readDraftRevisionLinks(
  connection: ThreadCorpusPostgresClient,
  messageIds: readonly string[],
  scope: ActiveTransportScope,
): Promise<ThreadCorpusDraftRevisionLink[]> {
  if (messageIds.length === 0) return [];
  const rows = await connection<DraftRevisionRow>`
    SELECT
      d.sent_message_id AS "messageId",
      d.id AS "draftId",
      r.id AS "revisionId"
    FROM mail_draft AS d
    LEFT JOIN mail_draft_revision AS r ON r.draft_id = d.id
    INNER JOIN message AS m ON m.id = d.sent_message_id
    WHERE d.sent_message_id = ANY(${messageIds})
      AND d.transport_id = ANY(${scope.transportIds})
      AND m.transport_id = ANY(${scope.transportIds})
      AND d.transport_id = m.transport_id
      AND COALESCE(m.received_at, m.sent_at, m.created_at) < ${scope.asOf}
      AND d.created_at < ${scope.asOf}
      AND (r.id IS NULL OR r.created_at < ${scope.asOf})
    UNION
    SELECT
      r.sent_message_id AS "messageId",
      r.draft_id AS "draftId",
      r.id AS "revisionId"
    FROM mail_draft_revision AS r
    INNER JOIN mail_draft AS d ON d.id = r.draft_id
    INNER JOIN message AS m ON m.id = r.sent_message_id
    WHERE r.sent_message_id = ANY(${messageIds})
      AND d.transport_id = ANY(${scope.transportIds})
      AND m.transport_id = ANY(${scope.transportIds})
      AND d.transport_id = m.transport_id
      AND COALESCE(m.received_at, m.sent_at, m.created_at) < ${scope.asOf}
      AND d.created_at < ${scope.asOf}
      AND r.created_at < ${scope.asOf}
    ORDER BY "messageId", "draftId", "revisionId"
  `;
  const selectedMessageIds = new Set(messageIds);
  return rows
    .map(mapDraftRevisionRow)
    .filter((row): row is ThreadCorpusDraftRevisionLink => row !== null)
    .filter((row) => selectedMessageIds.has(row.messageId));
}

async function readQueueStates(
  connection: ThreadCorpusPostgresClient,
  messageIds: readonly string[],
  scope: ActiveTransportScope,
  transportIdByMessageId: ReadonlyMap<string, string>,
): Promise<ThreadCorpusOutboundQueueState[]> {
  if (messageIds.length === 0) return [];
  const rows = await connection<QueueRow>`
    SELECT
      q.message_id AS "messageId",
      q.transport_id AS "transportId",
      q.status AS "status"
    FROM outbound_send_queue AS q
    INNER JOIN message AS m ON m.id = q.message_id
    WHERE q.message_id = ANY(${messageIds})
      AND q.transport_id = ANY(${scope.transportIds})
      AND m.transport_id = ANY(${scope.transportIds})
      AND q.transport_id = m.transport_id
      AND COALESCE(m.received_at, m.sent_at, m.created_at) < ${scope.asOf}
      AND q.created_at < ${scope.asOf}
    ORDER BY q.message_id, q.id
  `;
  return rows
    .map((row) => mapQueueRow(row, transportIdByMessageId))
    .filter((row): row is ThreadCorpusOutboundQueueState => row !== null);
}

function makeSessionLifecycle(): SessionLifecycle {
  let active = true;
  let pending = 0;
  const waiters = new Set<() => void>();
  const complete = (): void => {
    pending -= 1;
    if (pending !== 0) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  return {
    assertActive(): void {
      if (!active) throw new Error('Snapshot session is inactive');
    },
    register<T>(operation: () => Promise<T>): Promise<T> {
      if (!active) return Promise.reject(new Error('Snapshot session is inactive'));
      pending += 1;
      let result: Promise<T>;
      try {
        result = Promise.resolve(operation());
      } catch (error) {
        complete();
        return Promise.reject(error);
      }
      void result.then(complete, complete);
      return result;
    },
    settle(): Promise<void> {
      if (pending === 0) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.add(resolve);
      });
    },
    invalidate(): void {
      active = false;
    },
  };
}

function sessionFor(
  connection: ThreadCorpusPostgresClient,
  asOf: string,
  lifecycle: SessionLifecycle,
): ThreadCorpusSnapshotReadSession {
  let activeTransportScope: Promise<ActiveTransportScope> | undefined;
  let messages: Promise<ThreadCorpusMessageRow[]> | undefined;
  let attachmentRead: Promise<AttachmentDescriptorReadResult> | undefined;
  let attachments: Promise<ThreadCorpusAttachmentSourceDescriptor[]> | undefined;
  let draftRevisionLinks: Promise<ThreadCorpusDraftRevisionLink[]> | undefined;
  let queueStates: Promise<ThreadCorpusOutboundQueueState[]> | undefined;

  const assertActive = (): void => {
    lifecycle.assertActive();
  };
  const loadActiveTransportScope = (): Promise<ActiveTransportScope> => {
    assertActive();
    activeTransportScope ??= discoverActiveTransportScope(connection, asOf).then((scope) => {
      assertNonEmptyActiveTransportScope(scope);
      return scope;
    });
    return activeTransportScope;
  };
  const loadMessages = async (): Promise<ThreadCorpusMessageRow[]> => {
    assertActive();
    messages ??= loadActiveTransportScope().then((scope) => readMessages(connection, scope));
    return messages;
  };
  const loadAttachmentRead = async (): Promise<AttachmentDescriptorReadResult> => {
    assertActive();
    attachmentRead ??= Promise.all([loadMessages(), loadActiveTransportScope()]).then(
      ([loadedMessages, scope]) =>
        readAttachmentDescriptors(
          connection,
          distinctText(loadedMessages.map((message) => message.id)),
          scope,
        ),
    );
    return attachmentRead;
  };

  return {
    asOf,
    discoverActiveTransportScope() {
      return lifecycle.register(loadActiveTransportScope);
    },
    readMessages() {
      return lifecycle.register(loadMessages);
    },
    readAttachmentDescriptors() {
      return lifecycle.register(() => {
        attachments ??= loadAttachmentRead().then((result) => result.descriptors);
        return attachments;
      });
    },
    readMalformedAttachmentDescriptorCount() {
      return lifecycle.register(() => loadAttachmentRead().then((result) => result.malformedCount));
    },
    readDraftRevisionLinks() {
      return lifecycle.register(() => {
        draftRevisionLinks ??= Promise.all([loadMessages(), loadActiveTransportScope()]).then(
          ([loadedMessages, scope]) =>
            readDraftRevisionLinks(
              connection,
              distinctText(loadedMessages.map((message) => message.id)),
              scope,
            ),
        );
        return draftRevisionLinks;
      });
    },
    readOutboundQueueDeliveryStates() {
      return lifecycle.register(() => {
        queueStates ??= Promise.all([loadMessages(), loadActiveTransportScope()]).then(
          ([loadedMessages, scope]) =>
            readQueueStates(
              connection,
              distinctText(loadedMessages.map((message) => message.id)),
              scope,
              new Map(loadedMessages.map((message) => [message.id, message.transportId])),
            ),
        );
        return queueStates;
      });
    },
  };
}

export function createThreadCorpusPostgresReader(
  options: ThreadCorpusPostgresReaderOptions,
): ThreadCorpusPostgresReader {
  const selection = selectionFrom(options);
  const databaseUrl = textOrNull(options.databaseUrl);
  if (!databaseUrl) throw new Error('Reader configuration is incomplete');
  const connection = (options.clientFactory ?? defaultClientFactory)(databaseUrl, {
    max: 1,
    ssl: getPostgresSslOptions(options.databaseUrl),
  });
  let activeSnapshots = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  return {
    async readCenturionSnapshot(
      request: CenturionCorpusSnapshotRequest = {},
    ): Promise<CenturionCorpusSnapshot> {
      if (closed || closing) throw new Error('Reader is closed');
      const window = centurionWindowFrom(request);
      activeSnapshots += 1;
      try {
        return await connection.begin(
          'isolation level repeatable read read only',
          async (transaction) => {
            const asOf = await resolveAsOf(transaction, selection.asOf);
            return await readCenturionSnapshotInTransaction(transaction, asOf, window);
          },
        );
      } finally {
        activeSnapshots -= 1;
      }
    },
    async withRepeatableReadOnly<T>(
      load: (session: ThreadCorpusSnapshotReadSession) => Promise<T>,
    ): Promise<T> {
      if (closed || closing) throw new Error('Reader is closed');
      activeSnapshots += 1;
      try {
        return await connection.begin(
          'isolation level repeatable read read only',
          async (transaction) => {
            const asOf = await resolveAsOf(transaction, selection.asOf);
            const lifecycle = makeSessionLifecycle();
            const session = sessionFor(transaction, asOf, lifecycle);
            try {
              return await load(session);
            } finally {
              await lifecycle.settle();
              lifecycle.invalidate();
            }
          },
        );
      } finally {
        activeSnapshots -= 1;
      }
    },
    close(): Promise<void> {
      if (activeSnapshots > 0) {
        return Promise.reject(new Error('Cannot close an active snapshot'));
      }
      if (!closing) {
        closed = true;
        closing = connection.end();
      }
      return closing;
    },
  };
}
