import { getPostgresSslOptions } from '../db/ssl-config.js';
import postgres from 'postgres';

type DatabaseRow = Record<string, unknown>;

type ThreadCorpusRawMime = {
  locator: string | null;
  status: string | null;
};

type ThreadCorpusAttachmentSourceDescriptor = {
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
