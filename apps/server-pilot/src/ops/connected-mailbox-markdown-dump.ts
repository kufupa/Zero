import {
  createPrivateOutputWriter,
  prepareTrustedPrivateOutputRoot,
  type PrivateOutputWriter,
  type PrivateOutputWriterConfig,
} from './private-output.js';

type DatabaseRow = Record<string, unknown>;

type ActiveTransportScope = {
  asOf: string;
  transportIds: readonly string[];
};

type MessageRow = {
  id?: unknown;
  transportId?: unknown;
  messageThreadId?: unknown;
  resolvedThreadId?: unknown;
  threadTransportId?: unknown;
  direction?: unknown;
  subject?: unknown;
  fromAddress?: unknown;
  toAddresses?: unknown;
  ccAddresses?: unknown;
  bccAddresses?: unknown;
  receivedAt?: unknown;
  sentAt?: unknown;
  createdAt?: unknown;
  textBody?: unknown;
  htmlBody?: unknown;
  messageIdHeader?: unknown;
  inReplyTo?: unknown;
  references?: unknown;
};

type ConnectedMailboxMessage = {
  id: string;
  transportId: string;
  threadId: string | null;
  direction: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  receivedAt: string | null;
  sentAt: string | null;
  createdAt: string | null;
  textBody: string;
  htmlBody: string;
  messageIdHeader: string;
  inReplyTo: string;
  references: string;
};

type PrivateWriter = Pick<PrivateOutputWriter, 'write'>;

export type ConnectedMailboxDumpPostgresClient = {
  <TRow extends DatabaseRow = DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromiseLike<readonly TRow[]>;
  begin<T>(
    options: string,
    load: (connection: ConnectedMailboxDumpPostgresClient) => Promise<T>,
  ): Promise<T>;
};

export type ConnectedMailboxMarkdownDumpRequest = {
  outputName: string;
  transportIds: readonly string[];
};

export type ConnectedMailboxMarkdownDumpResult = {
  asOf: string;
  activeMailboxCount: number;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
};

export type ConnectedMailboxMarkdownDumpDependencies = {
  client: ConnectedMailboxDumpPostgresClient;
  repoRoot: string;
  createWriter?: (config: PrivateOutputWriterConfig) => PrivateWriter;
  preflightOutputRoot?: (config: PrivateOutputWriterConfig) => Promise<void>;
};

const PRIVATE_DIRECTORY_NAME = 'connected-mailbox-corpus';
const DEFAULT_WRITER = (config: PrivateOutputWriterConfig): PrivateWriter =>
  createPrivateOutputWriter(config);
const DEFAULT_OUTPUT_ROOT_PREFLIGHT = async (config: PrivateOutputWriterConfig): Promise<void> => {
  await prepareTrustedPrivateOutputRoot(config);
};

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
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
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function sortedDistinctText(values: readonly unknown[]): string[] {
  return [
    ...new Set(values.map(textOrNull).filter((value): value is string => value !== null)),
  ].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}

function addressText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { email?: unknown }).email === 'string'
      ) {
        const email = (entry as { email: string }).email;
        const name = (entry as { name?: unknown }).name;
        return typeof name === 'string' && name.trim() ? `${name} <${email}>` : email;
      }
      return '';
    })
    .filter(Boolean)
    .join(', ');
}

function referencesText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .join(', ');
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function inlineMarkdown(value: string): string {
  return normalizeMarkdown(value).replace(/\n+/g, ' ').trim();
}

function code(value: string): string {
  return `\`${inlineMarkdown(value).replace(/`/g, '\\`')}\``;
}

function fence(value: string, language: 'text' | 'html'): string {
  const body = normalizeMarkdown(value).replace(/```/g, '``\u200b`');
  return `\`\`\`${language}\n${body}${body.endsWith('\n') ? '' : '\n'}\`\`\``;
}

function displayTimestamp(value: string | null): string {
  return value ?? '';
}

function mapMessageRow(
  row: MessageRow,
  activeTransportIds: ReadonlySet<string>,
): ConnectedMailboxMessage | null {
  const id = textOrNull(row.id);
  const transportId = textOrNull(row.transportId);
  if (!id || !transportId || !activeTransportIds.has(transportId)) return null;

  const resolvedThreadId = textOrNull(row.resolvedThreadId);
  const threadTransportId = textOrNull(row.threadTransportId);
  if (resolvedThreadId && threadTransportId && threadTransportId !== transportId) return null;

  return {
    id,
    transportId,
    threadId:
      resolvedThreadId && textOrNull(row.messageThreadId) && threadTransportId === transportId
        ? textOrNull(row.messageThreadId)
        : null,
    direction: textOrNull(row.direction) ?? 'unknown',
    subject: textOrEmpty(row.subject),
    from: addressText(row.fromAddress),
    to: addressText(row.toAddresses),
    cc: addressText(row.ccAddresses),
    bcc: addressText(row.bccAddresses),
    receivedAt: timestampOrNull(row.receivedAt),
    sentAt: timestampOrNull(row.sentAt),
    createdAt: timestampOrNull(row.createdAt),
    textBody: textOrEmpty(row.textBody),
    htmlBody: textOrEmpty(row.htmlBody),
    messageIdHeader: textOrEmpty(row.messageIdHeader),
    inReplyTo: textOrEmpty(row.inReplyTo),
    references: referencesText(row.references),
  };
}

async function captureAsOf(client: ConnectedMailboxDumpPostgresClient): Promise<string> {
  const rows = await client<{ asOf?: unknown }>`
    SELECT CURRENT_TIMESTAMP AS "asOf"
  `;
  const asOf = timestampOrNull(rows[0]?.asOf);
  if (!asOf) throw new Error('Snapshot timestamp unavailable');
  return asOf;
}

function assertExplicitTransportIds(transportIds: readonly unknown[]): readonly string[] {
  if (!Array.isArray(transportIds) || transportIds.length === 0) {
    throw new Error('Explicit transport scope is required');
  }
  const normalized = sortedDistinctText(transportIds);
  if (normalized.length === 0) {
    throw new Error('Explicit transport scope is required');
  }
  if (normalized.length !== transportIds.length) {
    throw new Error('Explicit transport scope is required');
  }
  for (let index = 0; index < transportIds.length; index += 1) {
    const value = transportIds[index];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Explicit transport scope is required');
    }
    if (value !== normalized[index]) {
      throw new Error('Explicit transport scope must be sorted');
    }
  }
  return normalized;
}

async function resolveExplicitTransportScope(
  client: ConnectedMailboxDumpPostgresClient,
  asOf: string,
  requestedTransportIds: readonly string[],
): Promise<ActiveTransportScope> {
  const transportIds = assertExplicitTransportIds(requestedTransportIds);
  const rows = await client<{ id?: unknown }>`
    SELECT id
    FROM mailbox_transport
    WHERE is_active = true
      AND id = ANY(${transportIds})
    ORDER BY id
  `;
  const activeIds = sortedDistinctText(rows.map((row) => row.id));
  if (
    activeIds.length !== transportIds.length ||
    activeIds.some((id, index) => id !== transportIds[index])
  ) {
    throw new Error('Requested transport scope is not active');
  }
  return { asOf, transportIds };
}

async function readMessages(
  client: ConnectedMailboxDumpPostgresClient,
  scope: ActiveTransportScope,
): Promise<ConnectedMailboxMessage[]> {
  const rows = await client<MessageRow>`
    SELECT
      m.id,
      m.transport_id AS "transportId",
      m.thread_id AS "messageThreadId",
      t.id AS "resolvedThreadId",
      t.transport_id AS "threadTransportId",
      m.direction::text AS "direction",
      m.subject,
      m.from_address AS "fromAddress",
      m.to_addresses AS "toAddresses",
      m.cc_addresses AS "ccAddresses",
      m.bcc_addresses AS "bccAddresses",
      m.received_at AS "receivedAt",
      m.sent_at AS "sentAt",
      m.created_at AS "createdAt",
      m.text_body AS "textBody",
      m.html_body AS "htmlBody",
      m.message_id_header AS "messageIdHeader",
      m.in_reply_to AS "inReplyTo",
      m.references AS "references"
    FROM message AS m
    LEFT JOIN mail_thread AS t ON t.id = m.thread_id
    WHERE COALESCE(m.received_at, m.sent_at, m.created_at) < ${scope.asOf}
      AND m.transport_id = ANY(${scope.transportIds})
      AND (t.id IS NULL OR m.transport_id IS NULL OR t.transport_id IS NULL OR t.transport_id = m.transport_id)
    ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at), m.id
  `;
  const activeTransportIds = new Set(scope.transportIds);
  return rows
    .map((row) => mapMessageRow(row, activeTransportIds))
    .filter((row): row is ConnectedMailboxMessage => row !== null);
}

function renderMessage(message: ConnectedMailboxMessage, index: number): string {
  const parts = [
    '---',
    '',
    `## Message ${index + 1}: ${inlineMarkdown(message.subject) || '(no subject)'}`,
    '',
    `- **Message ID:** ${code(message.id)}`,
    `- **Thread ID:** ${message.threadId ? code(message.threadId) : '(unthreaded)'}`,
    `- **Transport ID:** ${code(message.transportId)}`,
    `- **Direction:** ${inlineMarkdown(message.direction)}`,
    `- **From:** ${inlineMarkdown(message.from)}`,
    `- **To:** ${inlineMarkdown(message.to)}`,
    `- **CC:** ${inlineMarkdown(message.cc)}`,
    `- **BCC:** ${inlineMarkdown(message.bcc)}`,
    `- **Received:** ${displayTimestamp(message.receivedAt)}`,
    `- **Sent:** ${displayTimestamp(message.sentAt)}`,
    `- **Created:** ${displayTimestamp(message.createdAt)}`,
    `- **Message-ID (header):** ${message.messageIdHeader ? code(message.messageIdHeader) : ''}`,
    `- **In-Reply-To:** ${message.inReplyTo ? code(message.inReplyTo) : ''}`,
    `- **References:** ${
      message.references
        ? message.references
            .split(', ')
            .filter(Boolean)
            .map((reference) => code(reference))
            .join(', ')
        : ''
    }`,
    '',
    '### Text body',
    '',
    message.textBody.trim() ? fence(message.textBody, 'text') : '_(empty)_',
    '',
    '### HTML body',
    '',
    message.htmlBody.trim() ? fence(message.htmlBody, 'html') : '_(empty)_',
  ];
  return parts.join('\n');
}

function renderMarkdown(snapshot: {
  asOf: string;
  scope: ActiveTransportScope;
  messages: readonly ConnectedMailboxMessage[];
}): string {
  const inboundCount = snapshot.messages.filter(
    (message) => message.direction === 'inbound',
  ).length;
  const outboundCount = snapshot.messages.filter(
    (message) => message.direction === 'outbound',
  ).length;
  return [
    '# Connected mailbox message dump',
    '',
    'Reservationist inbox archive for active connected mailboxes.',
    '',
    `- Snapshot as of: ${snapshot.asOf}`,
    `- Active mailboxes: ${snapshot.scope.transportIds.length}`,
    `- Messages: ${snapshot.messages.length} (${inboundCount} inbound, ${outboundCount} outbound)`,
    '',
    ...snapshot.messages.map(renderMessage),
    '',
  ].join('\n');
}

/**
 * Reads active connected-mailbox messages and publishes their Markdown only through the scoped
 * private-output writer.
 */
export function createConnectedMailboxMarkdownDump(
  dependencies: ConnectedMailboxMarkdownDumpDependencies,
): (request: ConnectedMailboxMarkdownDumpRequest) => Promise<ConnectedMailboxMarkdownDumpResult> {
  const createWriter = dependencies.createWriter ?? DEFAULT_WRITER;
  const preflightOutputRoot =
    dependencies.preflightOutputRoot ?? DEFAULT_OUTPUT_ROOT_PREFLIGHT;
  const outputConfig: PrivateOutputWriterConfig = {
    repoRoot: dependencies.repoRoot,
    privateDirectoryName: PRIVATE_DIRECTORY_NAME,
    allowedExtensions: ['.md'],
  };

  return async (request) => {
    const requestedTransportIds = assertExplicitTransportIds(request.transportIds);
    await preflightOutputRoot(outputConfig);

    const snapshot = await dependencies.client.begin(
      'isolation level repeatable read read only',
      async (client) => {
        const asOf = await captureAsOf(client);
        const scope = await resolveExplicitTransportScope(client, asOf, requestedTransportIds);
        const messages = await readMessages(client, scope);
        return { asOf, scope, messages };
      },
    );
    const writer = createWriter(outputConfig);
    await writer.write(request.outputName, renderMarkdown(snapshot));

    return {
      asOf: snapshot.asOf,
      activeMailboxCount: snapshot.scope.transportIds.length,
      messageCount: snapshot.messages.length,
      inboundCount: snapshot.messages.filter((message) => message.direction === 'inbound').length,
      outboundCount: snapshot.messages.filter((message) => message.direction === 'outbound').length,
    };
  };
}
