import postgres from 'postgres';
import { getPostgresSslOptions } from '../db/ssl-config.js';

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
  transportId: string | null;
  ingestMailboxId: string | null;
  uidl: string | null;
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

type ThreadCorpusSourceScope = {
  kind: 'transport' | 'ingest_mailbox';
  id: string;
  active: boolean;
};

type ThreadCorpusSnapshotReadSession = {
  asOf: string;
  discoverSourceScopes(): Promise<readonly ThreadCorpusSourceScope[]>;
  readMessages(): Promise<readonly ThreadCorpusMessageRow[]>;
  readAttachmentDescriptors(): Promise<readonly ThreadCorpusAttachmentSourceDescriptor[]>;
  readDraftRevisionLinks(): Promise<readonly ThreadCorpusDraftRevisionLink[]>;
  readOutboundQueueDeliveryStates(): Promise<readonly ThreadCorpusOutboundQueueState[]>;
  readQuarantineRows(): Promise<readonly ThreadCorpusMessageRow[]>;
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
  centurionTransportId: string;
  designatedTransportId: string;
  designatedIngestMailboxIds: readonly string[];
  designatedAddresses: readonly string[];
  asOf?: string;
  clientFactory?: ThreadCorpusPostgresClientFactory;
};

export type ThreadCorpusPostgresReader = ThreadCorpusSnapshotReader & {
  close(): Promise<void>;
};

type TransportScopeRow = {
  id?: unknown;
  email?: unknown;
  ownerHeaderValue?: unknown;
  active?: unknown;
};

type IngestScopeRow = {
  id?: unknown;
  active?: unknown;
};

type MessageRow = {
  id?: unknown;
  transportId?: unknown;
  ingestMailboxId?: unknown;
  uidl?: unknown;
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
  ownerHeaderValue?: unknown;
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

type QuarantineRow = {
  id?: unknown;
  ingestMailboxId?: unknown;
  ownerHeaderValue?: unknown;
  createdAt?: unknown;
  rawMimeLocator?: unknown;
};

type SourceDiscovery = {
  scopes: ThreadCorpusSourceScope[];
  addressCandidates: string[];
  ownerTransportIds: Map<string, string | null>;
};

type Selection = {
  centurionTransportId: string;
  designatedTransportId: string;
  transportIds: string[];
  designatedIngestMailboxIds: string[];
  designatedAddresses: string[];
  asOf: string | undefined;
};

type SessionLifecycle = {
  assertActive(): void;
  register<T>(operation: () => Promise<T>): Promise<T>;
  settle(): Promise<void>;
  invalidate(): void;
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

function normalizedIdentity(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  const bracketed = text.match(/<\s*([^<>]+?)\s*>/);
  const candidate = (bracketed?.[1] ?? text).trim();
  const email = candidate.match(
    /[A-Z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/i,
  )?.[0];
  return (email ?? candidate).toLowerCase();
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

function optionalId(value: unknown): string | null {
  return textOrNull(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalHeaders(row: MessageRow): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  const messageId = textOrNull(row.messageId);
  const inReplyTo = textOrNull(row.inReplyTo);
  const ownerHeaderValue = textOrNull(row.ownerHeaderValue);
  const references = stringArray(row.references);
  if (messageId) headers['Message-ID'] = [messageId];
  if (inReplyTo) headers['In-Reply-To'] = [inReplyTo];
  if (references.length > 0) headers.References = references;
  if (ownerHeaderValue) headers['X-Zero-Mailbox'] = [ownerHeaderValue];
  return headers;
}

function mapMessageRow(row: MessageRow): ThreadCorpusMessageRow | null {
  const id = optionalId(row.id);
  const receivedAt = timestampOrNull(row.receivedAt);
  if (!id || !receivedAt) return null;
  const transportId = optionalId(row.transportId);
  const messageThreadId = optionalId(row.messageThreadId);
  const resolvedThreadId = optionalId(row.resolvedThreadId);
  const threadTransportId = optionalId(row.threadTransportId);
  if (
    resolvedThreadId &&
    transportId &&
    threadTransportId &&
    threadTransportId !== transportId
  ) {
    return null;
  }
  const locator = textOrNull(row.rawMimeLocator);
  return {
    id,
    transportId,
    ingestMailboxId: optionalId(row.ingestMailboxId),
    uidl: optionalId(row.uidl),
    threadId:
      resolvedThreadId &&
      messageThreadId &&
      transportId &&
      threadTransportId === transportId
        ? messageThreadId
        : null,
    messageId: optionalId(row.messageId),
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
  const id = optionalId(row.id);
  const messageId = optionalId(row.messageId);
  const filename = textOrNull(row.filename);
  const contentType = textOrNull(row.contentType);
  const byteSize = nonNegativeInteger(row.byteSize);
  const s3Key = textOrNull(row.s3Key);
  if (!id || !messageId || !filename || !contentType || byteSize === null || !s3Key) return null;
  return { id, messageId, filename, contentType, byteSize, s3Key };
}

function mapDraftRevisionRow(row: DraftRevisionRow): ThreadCorpusDraftRevisionLink | null {
  const messageId = optionalId(row.messageId);
  const draftId = optionalId(row.draftId);
  const revisionId = optionalId(row.revisionId);
  if (!messageId || (!draftId && !revisionId)) return null;
  return { messageId, draftId, revisionId };
}

function mapQueueRow(
  row: QueueRow,
  transportIdByMessageId: ReadonlyMap<string, string | null>,
): ThreadCorpusOutboundQueueState | null {
  const messageId = optionalId(row.messageId);
  const transportId = optionalId(row.transportId);
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

function mapQuarantineRow(
  row: QuarantineRow,
  designatedIngestMailboxIds: ReadonlySet<string>,
  ownerTransportIds: ReadonlyMap<string, string | null>,
): ThreadCorpusMessageRow | null {
  const id = optionalId(row.id);
  const receivedAt = timestampOrNull(row.createdAt);
  if (!id || !receivedAt) return null;
  const ingestMailboxId = optionalId(row.ingestMailboxId);
  const scopedIngestMailboxId =
    ingestMailboxId && designatedIngestMailboxIds.has(ingestMailboxId) ? ingestMailboxId : null;
  const ownerHeaderValue = normalizedIdentity(row.ownerHeaderValue);
  const transportId = ownerHeaderValue ? ownerTransportIds.get(ownerHeaderValue) ?? null : null;
  const locator = textOrNull(row.rawMimeLocator);
  const header = textOrNull(row.ownerHeaderValue);
  return {
    id: `quarantine:${id}`,
    transportId,
    ingestMailboxId: scopedIngestMailboxId,
    uidl: null,
    threadId: null,
    messageId: null,
    receivedAt,
    sentAt: null,
    subject: '',
    body: '',
    direction: 'inbound',
    from: [],
    to: [],
    cc: [],
    bcc: [],
    canonicalHeaders: header ? { 'X-Zero-Mailbox': [header] } : {},
    rawMime: {
      locator,
      status: locator ? 'pending_hydration' : 'missing',
    },
  };
}

function selectionFrom(options: ThreadCorpusPostgresReaderOptions): Selection {
  const databaseUrl = textOrNull(options.databaseUrl);
  const centurionTransportId = textOrNull(options.centurionTransportId);
  const designatedTransportId = textOrNull(options.designatedTransportId);
  if (!databaseUrl || !centurionTransportId || !designatedTransportId) {
    throw new Error('Reader configuration is incomplete');
  }
  const suppliedAsOf =
    options.asOf === undefined ? undefined : timestampOrNull(options.asOf);
  if (options.asOf !== undefined && !suppliedAsOf) {
    throw new Error('Snapshot timestamp is invalid');
  }
  return {
    centurionTransportId,
    designatedTransportId,
    transportIds: distinctText([centurionTransportId, designatedTransportId]),
    designatedIngestMailboxIds: distinctText(options.designatedIngestMailboxIds),
    designatedAddresses: distinctText(
      options.designatedAddresses
        .map(normalizedIdentity)
        .filter((value): value is string => value !== null),
    ),
    asOf: suppliedAsOf ?? undefined,
  };
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

async function discoverSources(
  connection: ThreadCorpusPostgresClient,
  selection: Selection,
): Promise<SourceDiscovery> {
  const transportRows = await connection<TransportScopeRow>`
    SELECT
      id,
      email,
      owner_header_value AS "ownerHeaderValue",
      is_active AS "active"
    FROM mailbox_transport
    WHERE id = ANY(${selection.transportIds})
  `;
  const ingestRows = await connection<IngestScopeRow>`
    SELECT
      id,
      is_active AS "active"
    FROM mail_ingest_mailbox
    WHERE id = ANY(${selection.designatedIngestMailboxIds})
  `;
  const requestedTransportIds = new Set(selection.transportIds);
  const requestedIngestMailboxIds = new Set(selection.designatedIngestMailboxIds);
  const scopes: ThreadCorpusSourceScope[] = [];
  const identities = [...selection.designatedAddresses];
  const ownerTransportIds = new Map<string, string | null>();

  for (const row of transportRows) {
    const id = optionalId(row.id);
    if (!id || !requestedTransportIds.has(id)) continue;
    scopes.push({ kind: 'transport', id, active: row.active === true });
    const email = normalizedIdentity(row.email);
    const ownerHeaderValue = normalizedIdentity(row.ownerHeaderValue);
    if (email) identities.push(email);
    if (ownerHeaderValue) {
      identities.push(ownerHeaderValue);
      const previous = ownerTransportIds.get(ownerHeaderValue);
      ownerTransportIds.set(
        ownerHeaderValue,
        previous === undefined || previous === id ? id : null,
      );
    }
  }
  for (const row of ingestRows) {
    const id = optionalId(row.id);
    if (!id || !requestedIngestMailboxIds.has(id)) continue;
    scopes.push({ kind: 'ingest_mailbox', id, active: row.active === true });
  }

  return {
    scopes,
    addressCandidates: distinctText(identities),
    ownerTransportIds,
  };
}

async function readMessages(
  connection: ThreadCorpusPostgresClient,
  selection: Selection,
  discovery: SourceDiscovery,
  asOf: string,
): Promise<ThreadCorpusMessageRow[]> {
  const rows = await connection<MessageRow>`
    SELECT
      m.id,
      m.transport_id AS "transportId",
      m.ingest_mailbox_id AS "ingestMailboxId",
      m.pop3_uidl AS "uidl",
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
      m.owner_header_value AS "ownerHeaderValue",
      m.in_reply_to AS "inReplyTo",
      m."references" AS "references",
      m.raw_mime_s3_key AS "rawMimeLocator"
    FROM message AS m
    LEFT JOIN mail_thread AS t ON t.id = m.thread_id
    WHERE COALESCE(m.received_at, m.sent_at, m.created_at) <= ${asOf}
      AND (t.id IS NULL OR m.transport_id IS NULL OR t.transport_id IS NULL OR t.transport_id = m.transport_id)
      AND (
        m.transport_id = ANY(${selection.transportIds})
        OR m.ingest_mailbox_id = ANY(${selection.designatedIngestMailboxIds})
        OR lower(btrim(COALESCE(
          substring(m.from_address FROM '<[[:space:]]*([^<>]+)[[:space:]]*>'),
          m.from_address
        ))) = ANY(${discovery.addressCandidates})
        OR lower(m.owner_header_value) = ANY(${discovery.addressCandidates})
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(m.to_addresses, '[]'::jsonb)) AS address(value)
          WHERE lower(btrim(COALESCE(
            substring(address.value FROM '<[[:space:]]*([^<>]+)[[:space:]]*>'),
            address.value
          ))) = ANY(${discovery.addressCandidates})
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(m.cc_addresses, '[]'::jsonb)) AS address(value)
          WHERE lower(btrim(COALESCE(
            substring(address.value FROM '<[[:space:]]*([^<>]+)[[:space:]]*>'),
            address.value
          ))) = ANY(${discovery.addressCandidates})
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(m.bcc_addresses, '[]'::jsonb)) AS address(value)
          WHERE lower(btrim(COALESCE(
            substring(address.value FROM '<[[:space:]]*([^<>]+)[[:space:]]*>'),
            address.value
          ))) = ANY(${discovery.addressCandidates})
        )
      )
    ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at), m.id
  `;
  return rows.map(mapMessageRow).filter((row): row is ThreadCorpusMessageRow => row !== null);
}

async function readAttachmentDescriptors(
  connection: ThreadCorpusPostgresClient,
  messageIds: readonly string[],
): Promise<ThreadCorpusAttachmentSourceDescriptor[]> {
  if (messageIds.length === 0) return [];
  const rows = await connection<AttachmentRow>`
    SELECT
      a.id,
      a.message_id AS "messageId",
      a.filename,
      a.mime_type AS "contentType",
      a.size_bytes AS "byteSize",
      a.s3_key AS "s3Key"
    FROM attachment AS a
    WHERE a.message_id = ANY(${messageIds})
    ORDER BY a.message_id, a.id
  `;
  const selectedMessageIds = new Set(messageIds);
  return rows
    .map(mapAttachmentRow)
    .filter((row): row is ThreadCorpusAttachmentSourceDescriptor => row !== null)
    .filter((row) => selectedMessageIds.has(row.messageId));
}

async function readDraftRevisionLinks(
  connection: ThreadCorpusPostgresClient,
  messageIds: readonly string[],
): Promise<ThreadCorpusDraftRevisionLink[]> {
  if (messageIds.length === 0) return [];
  const rows = await connection<DraftRevisionRow>`
    SELECT
      d.sent_message_id AS "messageId",
      d.id AS "draftId",
      r.id AS "revisionId"
    FROM mail_draft AS d
    LEFT JOIN mail_draft_revision AS r ON r.draft_id = d.id
    WHERE d.sent_message_id = ANY(${messageIds})
    UNION
    SELECT
      r.sent_message_id AS "messageId",
      r.draft_id AS "draftId",
      r.id AS "revisionId"
    FROM mail_draft_revision AS r
    WHERE r.sent_message_id = ANY(${messageIds})
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
  transportIds: readonly string[],
  transportIdByMessageId: ReadonlyMap<string, string | null>,
): Promise<ThreadCorpusOutboundQueueState[]> {
  if (messageIds.length === 0 || transportIds.length === 0) return [];
  const rows = await connection<QueueRow>`
    SELECT
      q.message_id AS "messageId",
      q.transport_id AS "transportId",
      q.status AS "status"
    FROM outbound_send_queue AS q
    WHERE q.message_id = ANY(${messageIds})
      AND q.transport_id = ANY(${transportIds})
    ORDER BY q.message_id, q.id
  `;
  return rows
    .map((row) => mapQueueRow(row, transportIdByMessageId))
    .filter((row): row is ThreadCorpusOutboundQueueState => row !== null);
}

async function readQuarantineRows(
  connection: ThreadCorpusPostgresClient,
  selection: Selection,
  discovery: SourceDiscovery,
  asOf: string,
): Promise<ThreadCorpusMessageRow[]> {
  const ownerHeaderValues = [...discovery.ownerTransportIds.keys()];
  const rows = await connection<QuarantineRow>`
    SELECT
      q.id,
      CASE
        WHEN q.ingest_mailbox_id = ANY(${selection.designatedIngestMailboxIds})
          THEN q.ingest_mailbox_id
        ELSE NULL
      END AS "ingestMailboxId",
      q.owner_header_value AS "ownerHeaderValue",
      q.created_at AS "createdAt",
      q.raw_mime_s3_key AS "rawMimeLocator"
    FROM mail_ingest_quarantine AS q
    WHERE q.created_at <= ${asOf}
      AND (
        q.ingest_mailbox_id = ANY(${selection.designatedIngestMailboxIds})
        OR lower(q.owner_header_value) = ANY(${ownerHeaderValues})
      )
    ORDER BY q.created_at, q.id
  `;
  const designatedIngestMailboxIds = new Set(selection.designatedIngestMailboxIds);
  return rows
    .map((row) =>
      mapQuarantineRow(row, designatedIngestMailboxIds, discovery.ownerTransportIds),
    )
    .filter((row): row is ThreadCorpusMessageRow => row !== null);
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
  selection: Selection,
  asOf: string,
  lifecycle: SessionLifecycle,
): ThreadCorpusSnapshotReadSession {
  let discovery: Promise<SourceDiscovery> | undefined;
  let messages: Promise<ThreadCorpusMessageRow[]> | undefined;
  let attachments: Promise<ThreadCorpusAttachmentSourceDescriptor[]> | undefined;
  let draftRevisionLinks: Promise<ThreadCorpusDraftRevisionLink[]> | undefined;
  let queueStates: Promise<ThreadCorpusOutboundQueueState[]> | undefined;
  let quarantineRows: Promise<ThreadCorpusMessageRow[]> | undefined;

  const assertActive = (): void => {
    lifecycle.assertActive();
  };
  const loadDiscovery = (): Promise<SourceDiscovery> => {
    assertActive();
    discovery ??= discoverSources(connection, selection);
    return discovery;
  };
  const loadMessages = async (): Promise<ThreadCorpusMessageRow[]> => {
    assertActive();
    messages ??= loadDiscovery().then((resolvedDiscovery) =>
      readMessages(connection, selection, resolvedDiscovery, asOf),
    );
    return messages;
  };

  return {
    asOf,
    discoverSourceScopes() {
      return lifecycle.register(async () => (await loadDiscovery()).scopes);
    },
    readMessages() {
      return lifecycle.register(loadMessages);
    },
    readAttachmentDescriptors() {
      return lifecycle.register(() => {
        attachments ??= loadMessages().then((loadedMessages) =>
          readAttachmentDescriptors(
            connection,
            distinctText(loadedMessages.map((message) => message.id)),
          ),
        );
        return attachments;
      });
    },
    readDraftRevisionLinks() {
      return lifecycle.register(() => {
        draftRevisionLinks ??= loadMessages().then((loadedMessages) =>
          readDraftRevisionLinks(
            connection,
            distinctText(loadedMessages.map((message) => message.id)),
          ),
        );
        return draftRevisionLinks;
      });
    },
    readOutboundQueueDeliveryStates() {
      return lifecycle.register(() => {
        queueStates ??= loadMessages().then((loadedMessages) => {
          const messageIds = distinctText(loadedMessages.map((message) => message.id));
          const transportIdByMessageId = new Map(
            loadedMessages.map((message) => [message.id, message.transportId]),
          );
          const transportIds = distinctText(
            loadedMessages
              .map((message) => message.transportId)
              .filter((transportId): transportId is string => transportId !== null),
          );
          return readQueueStates(
            connection,
            messageIds,
            transportIds,
            transportIdByMessageId,
          );
        });
        return queueStates;
      });
    },
    readQuarantineRows() {
      return lifecycle.register(() => {
        quarantineRows ??= loadDiscovery().then((resolvedDiscovery) =>
          readQuarantineRows(connection, selection, resolvedDiscovery, asOf),
        );
        return quarantineRows;
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
            const session = sessionFor(transaction, selection, asOf, lifecycle);
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
