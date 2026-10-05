/**
 * Read-only triage quality exporter for explicitly scoped connected mailboxes.
 *
 * Raw inputs and model-shaped outputs stay inside one verified private root.
 * Expected labels never enter model input or command output.
 */
import {
  buildAllInboundExportCases,
  buildLabelScopedExportCases,
  buildTargetsExportCases,
  parseQualityExportArgs,
  parseQualityLabelsJsonl,
  type QualityInputCase,
  type QualityLabel,
} from '../src/ai/quality-eval.js';
import {
  createPrivateInputReader,
  createPrivateOutputWriter,
  isAllowedDirectChildOutputName,
  prepareExistingTrustedPrivateOutputRoot,
  prepareTrustedPrivateOutputRoot,
  type PrivateInputReader,
  type PrivateOutputWriter,
  type PrivateOutputWriterConfig,
} from '../src/ops/private-output.js';
import { DEFAULT_AI_MODEL_ID, DEFAULT_TRIAGE_PROMPT_VERSION } from '../src/ai/run-ledger.js';
import type { TriageMessageRow } from '../src/ai/triage-input.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import path from 'node:path';
import { z } from 'zod';

const PRIVATE_DIRECTORY_NAME = 'connected-mailbox-corpus';
const QUALITY_OUTPUT_EXTENSIONS = ['.jsonl'] as const;
const QUALITY_OUTPUT_EXTENSION_SET = new Set<string>(QUALITY_OUTPUT_EXTENSIONS);
const READ_ONLY_REPEATABLE_SNAPSHOT = 'isolation level repeatable read read only';
const COMPLETED_EVENT = 'triage_quality_export.completed';
const FAILED_EVENT = 'triage_quality_export.failed';

const targetsManifestSchema = z
  .object({
    generatedAt: z.string().datetime(),
    targets: z
      .array(
        z
          .object({
            threadId: z.string().min(1),
            triggerMessageId: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

type DatabaseRow = Record<string, unknown>;

export type QualityActiveTransportScope = {
  asOf: string;
  transportIds: readonly string[];
};

export type QualityTriggerRow = {
  id: string;
  transportId: string;
  threadId: string;
  threadTransportId: string;
};

export type QualityScopedMessageRow = TriageMessageRow & {
  transportId: string;
  threadId: string;
  threadTransportId: string;
};

export type QualitySnapshotSession = {
  asOf: string;
  discoverActiveTransportScope(): Promise<QualityActiveTransportScope>;
  loadTriggers(triggerMessageIds: readonly string[]): Promise<readonly QualityTriggerRow[]>;
  loadThreadMessages(
    transportId: string,
    threadId: string,
  ): Promise<readonly QualityScopedMessageRow[]>;
  loadNormalRunAsOfByTrigger(triggerMessageIds: readonly string[]): Promise<Map<string, string>>;
  loadAllMessages(): Promise<readonly QualityScopedMessageRow[]>;
};

export type QualitySnapshotReader = {
  withRepeatableReadOnly<T>(load: (session: QualitySnapshotSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export type QualityPostgresClient = {
  <TRow extends DatabaseRow = DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromiseLike<readonly TRow[]>;
  begin<T>(options: string, load: (connection: QualityPostgresClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
};

export type TriageQualityPostgresReaderOptions = {
  databaseUrl: string;
  explicitTransportIds: readonly string[];
  clientFactory?: (
    databaseUrl: string,
    options: {
      max: 1;
      ssl: ReturnType<typeof getPostgresSslOptions>;
    },
  ) => QualityPostgresClient;
};

export type TriageQualityExportDependencies = {
  repoRoot(): string;
  databaseUrl(): string;
  preflightInputRoot(config: PrivateOutputWriterConfig): Promise<void>;
  preflightOutputRoot(config: PrivateOutputWriterConfig): Promise<void>;
  createReader(options: TriageQualityPostgresReaderOptions): QualitySnapshotReader;
  createPrivateInputReader(config: PrivateOutputWriterConfig): PrivateInputReader;
  createPrivateOutputWriter(config: PrivateOutputWriterConfig): PrivateOutputWriter;
  modelId(): string;
  promptVersion(): string;
};

export type TriageQualityExportCommandDependencies = TriageQualityExportDependencies & {
  args(): readonly string[];
  writeStdout(line: string): void;
  writeStderr(line: string): void;
};

export type TriageQualityExportResult = {
  mode: 'labels' | 'targets' | 'all-inbound-triggers';
  count: number;
  transportCount: number;
};

type ActiveTransportRow = {
  id?: unknown;
};

type TriggerDatabaseRow = {
  id?: unknown;
  transportId?: unknown;
  threadId?: unknown;
  threadTransportId?: unknown;
};

type MessageDatabaseRow = TriggerDatabaseRow & {
  fromAddress?: unknown;
  subject?: unknown;
  body?: unknown;
  direction?: unknown;
  createdAt?: unknown;
  receivedAt?: unknown;
  sentAt?: unknown;
};

type WorkflowRunRow = {
  triggerMessageId?: unknown;
  createdAt?: unknown;
};

function exportFailure(message: string): never {
  throw new Error(message);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function dateOrNull(value: unknown): Date | null {
  const valueAsDate =
    value instanceof Date
      ? value
      : typeof value === 'string' && value.trim()
        ? new Date(value)
        : null;
  return valueAsDate && !Number.isNaN(valueAsDate.getTime()) ? valueAsDate : null;
}

function isoTimestamp(value: unknown): string | null {
  return dateOrNull(value)?.toISOString() ?? null;
}

function sortedDistinctTransportIds(values: readonly unknown[]): string[] {
  return [
    ...new Set(values.map(textOrNull).filter((value): value is string => value !== null)),
  ].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}

function assertActiveTransportScope(
  scope: QualityActiveTransportScope,
  asOf: string,
): QualityActiveTransportScope {
  if (!scope || scope.asOf !== asOf || !Array.isArray(scope.transportIds)) {
    return exportFailure('Active transport scope is invalid');
  }
  const transportIds = sortedDistinctTransportIds(scope.transportIds);
  if (transportIds.length === 0) {
    return exportFailure('Active transport scope is empty');
  }
  return { asOf, transportIds };
}

function assertScopedTrigger(
  trigger: QualityTriggerRow | undefined,
  scope: QualityActiveTransportScope,
): QualityTriggerRow {
  if (
    !trigger ||
    !scope.transportIds.includes(trigger.transportId) ||
    !scope.transportIds.includes(trigger.threadTransportId)
  ) {
    return exportFailure('Quality export target is not active');
  }
  if (trigger.transportId !== trigger.threadTransportId) {
    return exportFailure('Quality export target has thread transport mismatch');
  }
  return trigger;
}

function assertScopedMessage(
  row: QualityScopedMessageRow,
  scope: QualityActiveTransportScope,
  expected: Pick<QualityTriggerRow, 'transportId' | 'threadId'>,
): void {
  if (
    !scope.transportIds.includes(row.transportId) ||
    !scope.transportIds.includes(row.threadTransportId) ||
    row.transportId !== row.threadTransportId ||
    row.transportId !== expected.transportId ||
    row.threadId !== expected.threadId ||
    row.createdAt.getTime() >= Date.parse(scope.asOf)
  ) {
    exportFailure('Quality export thread context is invalid');
  }
}

function assertTargetWithinSnapshot(timestamp: string, asOf: string): void {
  const candidate = Date.parse(timestamp);
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(candidate) || !Number.isFinite(cutoff) || candidate > cutoff) {
    exportFailure('Quality export target timestamp is outside snapshot');
  }
}

function toTriggerRow(row: TriggerDatabaseRow): QualityTriggerRow {
  const id = textOrNull(row.id);
  const transportId = textOrNull(row.transportId);
  const threadId = textOrNull(row.threadId);
  const threadTransportId = textOrNull(row.threadTransportId);
  if (!id || !transportId || !threadId || !threadTransportId) {
    return exportFailure('Quality export trigger row is invalid');
  }
  return { id, transportId, threadId, threadTransportId };
}

function toMessageRow(row: MessageDatabaseRow): QualityScopedMessageRow {
  const trigger = toTriggerRow(row);
  const createdAt = dateOrNull(row.createdAt);
  const receivedAt = dateOrNull(row.receivedAt);
  const sentAt = dateOrNull(row.sentAt);
  if (!createdAt || (row.direction !== 'inbound' && row.direction !== 'outbound')) {
    return exportFailure('Quality export message row is invalid');
  }
  return {
    ...trigger,
    from: textOrEmpty(row.fromAddress),
    subject: typeof row.subject === 'string' ? row.subject : undefined,
    body: textOrEmpty(row.body),
    direction: row.direction,
    createdAt,
    receivedAt,
    sentAt,
  };
}

function toTriageMessageRow(row: QualityScopedMessageRow): TriageMessageRow {
  return {
    id: row.id,
    from: row.from,
    subject: row.subject,
    body: row.body,
    direction: row.direction,
    createdAt: row.createdAt,
    receivedAt: row.receivedAt,
    sentAt: row.sentAt,
  };
}

function defaultClientFactory(
  databaseUrl: string,
  options: { max: 1; ssl: ReturnType<typeof getPostgresSslOptions> },
): QualityPostgresClient {
  return postgres(databaseUrl, options) as unknown as QualityPostgresClient;
}

async function resolveSnapshotAsOf(connection: QualityPostgresClient): Promise<string> {
  const rows = await connection<{ asOf?: unknown }>`
    SELECT CURRENT_TIMESTAMP AS "asOf"
  `;
  const asOf = isoTimestamp(rows[0]?.asOf);
  if (!asOf) return exportFailure('Quality export snapshot timestamp is unavailable');
  return asOf;
}

async function discoverExplicitTransportScope(
  connection: QualityPostgresClient,
  asOf: string,
  explicitTransportIds: readonly string[],
): Promise<QualityActiveTransportScope> {
  const transportIds = sortedDistinctTransportIds(explicitTransportIds);
  if (transportIds.length === 0) {
    return exportFailure('Active transport scope is empty');
  }
  const rows = await connection<ActiveTransportRow>`
    SELECT id
    FROM mailbox_transport
    WHERE is_active = true
      AND id = ANY(${transportIds})
    ORDER BY id
  `;
  const found = sortedDistinctTransportIds(rows.map((row) => row.id));
  if (found.length !== transportIds.length) {
    return exportFailure('Quality export transport scope is not active');
  }
  return { asOf, transportIds: found };
}

function qualitySnapshotSession(
  connection: QualityPostgresClient,
  asOf: string,
  explicitTransportIds: readonly string[],
): QualitySnapshotSession {
  let activeTransportScope: Promise<QualityActiveTransportScope> | undefined;
  const loadScope = (): Promise<QualityActiveTransportScope> => {
    activeTransportScope ??= discoverExplicitTransportScope(
      connection,
      asOf,
      explicitTransportIds,
    ).then((scope) => assertActiveTransportScope(scope, asOf));
    return activeTransportScope;
  };

  return {
    asOf,
    discoverActiveTransportScope: loadScope,
    async loadTriggers(triggerMessageIds) {
      if (triggerMessageIds.length === 0) return [];
      const scope = await loadScope();
      const rows = await connection<TriggerDatabaseRow>`
        SELECT
          m.id,
          m.transport_id AS "transportId",
          m.thread_id AS "threadId",
          t.transport_id AS "threadTransportId"
        FROM message AS m
        INNER JOIN mail_thread AS t ON t.id = m.thread_id
        WHERE m.id = ANY(${triggerMessageIds})
          AND m.transport_id = ANY(${scope.transportIds})
          AND t.transport_id = ANY(${scope.transportIds})
          AND m.created_at < ${scope.asOf}
          AND t.created_at < ${scope.asOf}
        ORDER BY m.id
      `;
      return rows.map(toTriggerRow);
    },
    async loadThreadMessages(transportId, threadId) {
      const scope = await loadScope();
      const rows = await connection<MessageDatabaseRow>`
        SELECT
          m.id,
          m.transport_id AS "transportId",
          m.thread_id AS "threadId",
          t.transport_id AS "threadTransportId",
          m.from_address AS "fromAddress",
          m.subject,
          COALESCE(NULLIF(m.text_body, ''), m.html_body, '') AS "body",
          m.direction::text AS "direction",
          m.created_at AS "createdAt",
          m.received_at AS "receivedAt",
          m.sent_at AS "sentAt"
        FROM message AS m
        INNER JOIN mail_thread AS t ON t.id = m.thread_id
        WHERE m.thread_id = ${threadId}
          AND m.transport_id = ${transportId}
          AND m.transport_id = ANY(${scope.transportIds})
          AND t.transport_id = ANY(${scope.transportIds})
          AND m.created_at < ${scope.asOf}
          AND t.created_at < ${scope.asOf}
        ORDER BY m.created_at, m.id
      `;
      return rows.map(toMessageRow);
    },
    async loadNormalRunAsOfByTrigger(triggerMessageIds) {
      if (triggerMessageIds.length === 0) return new Map();
      const scope = await loadScope();
      const rows = await connection<WorkflowRunRow>`
        SELECT
          r.trigger_message_id AS "triggerMessageId",
          r.created_at AS "createdAt"
        FROM ai_workflow_run AS r
        INNER JOIN message AS m ON m.id = r.trigger_message_id
        INNER JOIN mail_thread AS t ON t.id = m.thread_id
        WHERE r.run_kind = 'inbound_triage'
          AND r.trigger_message_id = ANY(${triggerMessageIds})
          AND r.transport_id = ANY(${scope.transportIds})
          AND m.transport_id = ANY(${scope.transportIds})
          AND t.transport_id = ANY(${scope.transportIds})
          AND r.transport_id = m.transport_id
          AND m.transport_id = t.transport_id
          AND r.created_at < ${scope.asOf}
          AND m.created_at < ${scope.asOf}
          AND t.created_at < ${scope.asOf}
        ORDER BY r.trigger_message_id, r.created_at
      `;
      const byTrigger = new Map<string, string>();
      for (const row of rows) {
        const triggerMessageId = textOrNull(row.triggerMessageId);
        const runAsOf = isoTimestamp(row.createdAt);
        if (!triggerMessageId || !runAsOf || byTrigger.has(triggerMessageId)) continue;
        byTrigger.set(triggerMessageId, runAsOf);
      }
      return byTrigger;
    },
    async loadAllMessages() {
      const scope = await loadScope();
      const rows = await connection<MessageDatabaseRow>`
        SELECT
          m.id,
          m.transport_id AS "transportId",
          m.thread_id AS "threadId",
          t.transport_id AS "threadTransportId",
          m.from_address AS "fromAddress",
          m.subject,
          COALESCE(NULLIF(m.text_body, ''), m.html_body, '') AS "body",
          m.direction::text AS "direction",
          m.created_at AS "createdAt",
          m.received_at AS "receivedAt",
          m.sent_at AS "sentAt"
        FROM message AS m
        INNER JOIN mail_thread AS t ON t.id = m.thread_id
        WHERE m.transport_id = ANY(${scope.transportIds})
          AND t.transport_id = ANY(${scope.transportIds})
          AND m.transport_id = t.transport_id
          AND m.created_at < ${scope.asOf}
          AND t.created_at < ${scope.asOf}
        ORDER BY m.transport_id, m.thread_id, m.created_at, m.id
      `;
      return rows.map(toMessageRow);
    },
  };
}

export function createTriageQualityPostgresReader(
  options: TriageQualityPostgresReaderOptions,
): QualitySnapshotReader {
  const databaseUrl = textOrNull(options.databaseUrl);
  if (!databaseUrl) return exportFailure('Quality export reader configuration is incomplete');
  const explicitTransportIds = sortedDistinctTransportIds(options.explicitTransportIds ?? []);
  if (explicitTransportIds.length === 0) {
    return exportFailure('Quality export transport scope is empty');
  }
  const connection = (options.clientFactory ?? defaultClientFactory)(databaseUrl, {
    max: 1,
    ssl: getPostgresSslOptions(databaseUrl),
  });
  let closed = false;
  let activeSnapshots = 0;
  let closing: Promise<void> | undefined;

  return {
    async withRepeatableReadOnly<T>(
      load: (session: QualitySnapshotSession) => Promise<T>,
    ): Promise<T> {
      if (closed || closing) return exportFailure('Quality export reader is closed');
      activeSnapshots += 1;
      try {
        return await connection.begin(READ_ONLY_REPEATABLE_SNAPSHOT, async (transaction) => {
          const asOf = await resolveSnapshotAsOf(transaction);
          return await load(qualitySnapshotSession(transaction, asOf, explicitTransportIds));
        });
      } finally {
        activeSnapshots -= 1;
      }
    },
    close(): Promise<void> {
      if (activeSnapshots > 0) {
        return Promise.reject(new Error('Quality export reader has an active snapshot'));
      }
      if (!closing) {
        closed = true;
        closing = connection.end();
      }
      return closing;
    },
  };
}

function privateInputConfig(repoRoot: string): PrivateOutputWriterConfig {
  return {
    repoRoot,
    privateDirectoryName: PRIVATE_DIRECTORY_NAME,
    allowedExtensions: ['.json', '.jsonl'],
  };
}

function privateOutputConfig(repoRoot: string): PrivateOutputWriterConfig {
  return {
    repoRoot,
    privateDirectoryName: PRIVATE_DIRECTORY_NAME,
    allowedExtensions: QUALITY_OUTPUT_EXTENSIONS,
  };
}

function assertExtension(inputName: string, extension: '.json' | '.jsonl'): void {
  if (path.extname(inputName) !== extension) {
    exportFailure('Quality export private input name is invalid');
  }
}

function serializeJsonl(rows: readonly QualityInputCase[]): string {
  return rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function assertNoExpectedLabels(rows: readonly QualityInputCase[]): void {
  for (const row of rows) {
    if (Object.keys(row).some((key) => /expected|label|adjudication|policyReason/i.test(key))) {
      exportFailure('Quality export model input includes labels');
    }
  }
}

function triggerMap(
  triggers: readonly QualityTriggerRow[],
  requestedIds: readonly string[],
  scope: QualityActiveTransportScope,
): Map<string, QualityTriggerRow> {
  const byId = new Map<string, QualityTriggerRow>();
  for (const trigger of triggers) {
    if (byId.has(trigger.id)) exportFailure('Quality export trigger identity is ambiguous');
    byId.set(trigger.id, assertScopedTrigger(trigger, scope));
  }
  for (const id of requestedIds) {
    if (!byId.has(id)) exportFailure('Quality export target is not active');
  }
  return byId;
}

async function loadThreadContext(
  session: QualitySnapshotSession,
  scope: QualityActiveTransportScope,
  trigger: QualityTriggerRow,
): Promise<TriageMessageRow[]> {
  const rows = await session.loadThreadMessages(trigger.transportId, trigger.threadId);
  if (rows.length === 0) exportFailure('Quality export thread context is unavailable');
  for (const row of rows) {
    assertScopedMessage(row, scope, trigger);
  }
  if (!rows.some((row) => row.id === trigger.id)) {
    exportFailure('Quality export thread context is missing trigger');
  }
  return rows.map(toTriageMessageRow);
}

async function exportLabels(
  session: QualitySnapshotSession,
  scope: QualityActiveTransportScope,
  inputReader: PrivateInputReader,
  args: Extract<ReturnType<typeof parseQualityExportArgs>, { mode: 'labels' }>,
  modelId: string,
  promptVersion: string,
): Promise<QualityInputCase[]> {
  assertExtension(args.labelsPath, '.jsonl');
  const labels = parseQualityLabelsJsonl(await inputReader.read(args.labelsPath));
  for (const label of labels) {
    assertTargetWithinSnapshot(label.asOf, scope.asOf);
  }

  const triggers = triggerMap(
    await session.loadTriggers(labels.map((label) => label.triggerMessageId)),
    labels.map((label) => label.triggerMessageId),
    scope,
  );
  const labelsByThread = new Map<string, { trigger: QualityTriggerRow; labels: QualityLabel[] }>();
  for (const label of labels) {
    const trigger = assertScopedTrigger(triggers.get(label.triggerMessageId), scope);
    const key = `${trigger.transportId}\0${trigger.threadId}`;
    const group = labelsByThread.get(key) ?? { trigger, labels: [] };
    group.labels.push(label);
    labelsByThread.set(key, group);
  }

  const exported: QualityInputCase[] = [];
  for (const { trigger, labels: threadLabels } of labelsByThread.values()) {
    exported.push(
      ...buildLabelScopedExportCases({
        transportId: trigger.transportId,
        threadId: trigger.threadId,
        messages: await loadThreadContext(session, scope, trigger),
        labels: threadLabels,
        modelId,
        promptVersion,
      }),
    );
  }
  return exported;
}

async function exportTargets(
  session: QualitySnapshotSession,
  scope: QualityActiveTransportScope,
  inputReader: PrivateInputReader,
  args: Extract<ReturnType<typeof parseQualityExportArgs>, { mode: 'targets' }>,
  modelId: string,
  promptVersion: string,
): Promise<QualityInputCase[]> {
  assertExtension(args.targetsPath, '.json');
  let manifest: z.infer<typeof targetsManifestSchema>;
  try {
    manifest = targetsManifestSchema.parse(JSON.parse(await inputReader.read(args.targetsPath)));
  } catch {
    return exportFailure('Quality export targets manifest is invalid');
  }
  assertTargetWithinSnapshot(manifest.generatedAt, scope.asOf);

  const triggers = triggerMap(
    await session.loadTriggers(manifest.targets.map((target) => target.triggerMessageId)),
    manifest.targets.map((target) => target.triggerMessageId),
    scope,
  );
  const threadIds = new Set<string>();
  const exported: QualityInputCase[] = [];
  for (const target of manifest.targets) {
    if (threadIds.has(target.threadId)) exportFailure('Quality export target thread is duplicated');
    threadIds.add(target.threadId);
    const trigger = assertScopedTrigger(triggers.get(target.triggerMessageId), scope);
    if (trigger.threadId !== target.threadId) {
      exportFailure('Quality export target thread does not match trigger');
    }
    exported.push(
      ...buildTargetsExportCases({
        transportId: trigger.transportId,
        threadId: trigger.threadId,
        messages: await loadThreadContext(session, scope, trigger),
        triggerMessageId: trigger.id,
        generatedAt: manifest.generatedAt,
        modelId,
        promptVersion,
      }),
    );
  }
  return exported;
}

async function exportAllInboundTriggers(
  session: QualitySnapshotSession,
  scope: QualityActiveTransportScope,
  modelId: string,
  promptVersion: string,
): Promise<QualityInputCase[]> {
  const rows = await session.loadAllMessages();
  const rowsByThread = new Map<string, QualityScopedMessageRow[]>();
  for (const row of rows) {
    assertScopedMessage(row, scope, row);
    const key = `${row.transportId}\0${row.threadId}`;
    const threadRows = rowsByThread.get(key) ?? [];
    threadRows.push(row);
    rowsByThread.set(key, threadRows);
  }

  const inboundTriggerIds = rows.filter((row) => row.direction === 'inbound').map((row) => row.id);
  const normalRunAsOfByTrigger = await session.loadNormalRunAsOfByTrigger(inboundTriggerIds);
  const exported: QualityInputCase[] = [];
  for (const threadRows of rowsByThread.values()) {
    const first = threadRows[0];
    if (!first) continue;
    const asOfByTriggerId: Record<
      string,
      { asOf: string; asOfSource: 'normal-run-created-at' | 'message-created-at' }
    > = {};
    for (const row of threadRows) {
      if (row.direction !== 'inbound') continue;
      const normalRunAsOf = normalRunAsOfByTrigger.get(row.id);
      if (normalRunAsOf) {
        assertTargetWithinSnapshot(normalRunAsOf, scope.asOf);
        asOfByTriggerId[row.id] = {
          asOf: normalRunAsOf,
          asOfSource: 'normal-run-created-at',
        };
      } else {
        asOfByTriggerId[row.id] = {
          asOf: row.createdAt.toISOString(),
          asOfSource: 'message-created-at',
        };
      }
    }
    exported.push(
      ...buildAllInboundExportCases({
        transportId: first.transportId,
        threadId: first.threadId,
        messages: threadRows.map(toTriageMessageRow),
        asOfByTriggerId,
        modelId,
        promptVersion,
      }),
    );
  }
  return exported;
}

function requiredDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return exportFailure('Quality export database is not configured');
  return databaseUrl;
}

function defaultDependencies(): TriageQualityExportCommandDependencies {
  return {
    args: () => process.argv.slice(2),
    repoRoot: () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
    databaseUrl: requiredDatabaseUrl,
    preflightInputRoot: async (config) => {
      await prepareExistingTrustedPrivateOutputRoot(config);
    },
    preflightOutputRoot: async (config) => {
      await prepareTrustedPrivateOutputRoot(config);
    },
    createReader: createTriageQualityPostgresReader,
    createPrivateInputReader,
    createPrivateOutputWriter,
    modelId: () => process.env.AI_MODEL_ID?.trim() || DEFAULT_AI_MODEL_ID,
    promptVersion: () =>
      process.env.AI_TRIAGE_PROMPT_VERSION?.trim() || DEFAULT_TRIAGE_PROMPT_VERSION,
    writeStdout: (line) => {
      process.stdout.write(line);
    },
    writeStderr: (line) => {
      process.stderr.write(line);
    },
  };
}

export function createTriageQualityExporter(
  overrides: Partial<TriageQualityExportDependencies> = {},
): (argv: readonly string[]) => Promise<TriageQualityExportResult> {
  const defaults = defaultDependencies();
  const dependencies: TriageQualityExportDependencies = {
    repoRoot: overrides.repoRoot ?? defaults.repoRoot,
    databaseUrl: overrides.databaseUrl ?? defaults.databaseUrl,
    preflightInputRoot: overrides.preflightInputRoot ?? defaults.preflightInputRoot,
    preflightOutputRoot: overrides.preflightOutputRoot ?? defaults.preflightOutputRoot,
    createReader: overrides.createReader ?? defaults.createReader,
    createPrivateInputReader:
      overrides.createPrivateInputReader ?? defaults.createPrivateInputReader,
    createPrivateOutputWriter:
      overrides.createPrivateOutputWriter ?? defaults.createPrivateOutputWriter,
    modelId: overrides.modelId ?? defaults.modelId,
    promptVersion: overrides.promptVersion ?? defaults.promptVersion,
  };

  return async (argv) => {
    const args = parseQualityExportArgs([...argv]);
    if (!isAllowedDirectChildOutputName(args.outPath, QUALITY_OUTPUT_EXTENSION_SET)) {
      exportFailure('Quality export private output name is invalid');
    }
    const repoRoot = path.resolve(dependencies.repoRoot());
    const inputConfig = privateInputConfig(repoRoot);
    const outputConfig = privateOutputConfig(repoRoot);
    await dependencies.preflightOutputRoot(outputConfig);
    await dependencies.preflightInputRoot(inputConfig);
    const inputReader = dependencies.createPrivateInputReader(inputConfig);
    const outputWriter = dependencies.createPrivateOutputWriter(outputConfig);
    const reader = dependencies.createReader({
      databaseUrl: dependencies.databaseUrl(),
      explicitTransportIds: args.transportIds,
    });
    const modelId = dependencies.modelId();
    const promptVersion = dependencies.promptVersion();

    try {
      return await reader.withRepeatableReadOnly(async (session) => {
        const scope = assertActiveTransportScope(
          await session.discoverActiveTransportScope(),
          session.asOf,
        );
        let exported: QualityInputCase[];
        if (args.mode === 'labels') {
          exported = await exportLabels(session, scope, inputReader, args, modelId, promptVersion);
        } else if (args.mode === 'targets') {
          exported = await exportTargets(session, scope, inputReader, args, modelId, promptVersion);
        } else {
          exported = await exportAllInboundTriggers(session, scope, modelId, promptVersion);
        }

        assertNoExpectedLabels(exported);
        await outputWriter.write(args.outPath, serializeJsonl(exported));
        return {
          mode: args.mode,
          count: exported.length,
          transportCount: new Set(exported.map((row) => row.transportId)).size,
        };
      });
    } finally {
      await reader.close();
    }
  };
}

export async function exportCenturionTriageQuality(
  argv: readonly string[],
  overrides: Partial<TriageQualityExportDependencies> = {},
): Promise<TriageQualityExportResult> {
  return await createTriageQualityExporter(overrides)(argv);
}

function failureLine(): string {
  return `${JSON.stringify({ event: FAILED_EVENT, code: 'export_failed' })}\n`;
}

export function createTriageQualityExportCommand(
  overrides: Partial<TriageQualityExportCommandDependencies> = {},
): () => Promise<number> {
  const defaults = defaultDependencies();
  const dependencies: TriageQualityExportCommandDependencies = {
    ...defaults,
    ...overrides,
  };
  const exporter = createTriageQualityExporter(dependencies);

  return async () => {
    try {
      const result = await exporter(dependencies.args());
      dependencies.writeStdout(
        `${JSON.stringify({
          event: COMPLETED_EVENT,
          mode: result.mode,
          count: result.count,
          transportCount: result.transportCount,
        })}\n`,
      );
      return 0;
    } catch {
      try {
        dependencies.writeStderr(failureLine());
      } catch {}
      return 1;
    }
  };
}

export async function runTriageQualityExport(
  overrides: Partial<TriageQualityExportCommandDependencies> = {},
): Promise<number> {
  return await createTriageQualityExportCommand(overrides)();
}

function isEntryScript(): boolean {
  const entryPath = process.argv[1];
  return (
    typeof entryPath === 'string' && fileURLToPath(import.meta.url) === path.resolve(entryPath)
  );
}

if (isEntryScript()) {
  void runTriageQualityExport().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
