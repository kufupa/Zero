import { describe, expect, it } from 'vitest';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from '../src/db/schema';
import {
  AGENT_RUN_CACHE_STATUSES,
  AGENT_RUN_SOURCES,
  AGENT_RUN_TRIGGERS,
  HITL_EPISODE_OUTCOMES,
  HITL_EVENT_KINDS,
  HITL_LABEL_STRENGTHS,
  HITL_TOOL_RUN_KINDS,
  HITL_TOOL_RUN_STATUSES,
} from '../src/db/schema/hitl.js';
import {
  MAIL_EXTRACTION_STATUSES,
  MAIL_KINDS,
  WORK_EVENT_ACTOR_KINDS,
  WORK_EVENT_TYPES,
  WORK_ITEM_STATUSES,
} from '../src/db/schema/work.js';

describe('v4 production mail schema', () => {
  it('uses mailbox access for owner/member/admin', () => {
    expect(schema.mailboxAccess).toBeDefined();
    expect(schema.mailboxTransport).toBeDefined();
  });

  it('has aggregate ingest and quarantine', () => {
    expect(schema.mailIngestMailbox).toBeDefined();
    expect(schema.mailIngestQuarantine).toBeDefined();
  });

  it('exports durable candidate attachment cleanup tasks', () => {
    expect(schema.mailIngestCandidateAttachmentCleanup).toBeDefined();
    expect(schema.mailIngestCandidateAttachmentCleanup.s3Key).toBeDefined();
    expect(schema.mailIngestCandidateAttachmentCleanup.candidateMessageId).toBeDefined();
    expect(schema.mailIngestCandidateAttachmentCleanup.ingestMailboxId).toBeDefined();
    expect(schema.mailIngestCandidateAttachmentCleanup.pop3Uidl).toBeDefined();
  });

  it('cuts stale table shapes', () => {
    expect((schema as Record<string, unknown>).staffMember).toBeUndefined();
    expect((schema as Record<string, unknown>).mailSnooze).toBeUndefined();
    expect((schema as Record<string, unknown>).mailPrompt).toBeUndefined();
    expect((schema as Record<string, unknown>).messageRecipient).toBeUndefined();
  });

  it('exposes required context columns on mail tables', () => {
    expect(schema.mailboxAccess.userId).toBeDefined();
    expect(schema.mailboxAccess.transportId).toBeDefined();
    expect(schema.mailboxAccess.role).toBeDefined();
    expect(schema.mailboxTransport.email).toBeDefined();
    expect(schema.mailboxTransport.ownerHeaderValue).toBeDefined();
    expect(schema.mailboxTransport.mailboxType).toBeDefined();
    expect(schema.mailThread.transportId).toBeDefined();
    expect(schema.mailThread.snoozedUntil).toBeDefined();
    expect(schema.mailThread.searchVector).toBeDefined();
    expect(schema.message.transportId).toBeDefined();
    expect(schema.message.ingestMailboxId).toBeDefined();
    expect(schema.message.pop3Uidl).toBeDefined();
    expect(schema.message.ownerHeaderValue).toBeDefined();
    expect(schema.mailDraft.createdByUserId).toBeDefined();
  });

  it('keeps auth and frontend-compat tables', () => {
    expect(schema.user).toBeDefined();
    expect(schema.session).toBeDefined();
    expect(schema.account).toBeDefined();
    expect(schema.verification).toBeDefined();
    expect(schema.note).toBeDefined();
    expect(schema.userSettings).toBeDefined();
    expect(schema.emailTemplate).toBeDefined();
    expect(schema.jwks).toBeDefined();
  });

  it('drops connection-era and de-scoped tables', () => {
    expect((schema as Record<string, unknown>).connection).toBeUndefined();
    expect((schema as Record<string, unknown>).summary).toBeUndefined();
    expect((schema as Record<string, unknown>).writingStyleMatrix).toBeUndefined();
    expect((schema as Record<string, unknown>).oauthApplication).toBeUndefined();
    expect((schema as Record<string, unknown>).oauthAccessToken).toBeUndefined();
    expect((schema as Record<string, unknown>).oauthConsent).toBeUndefined();
    expect((schema as Record<string, unknown>).earlyAccess).toBeUndefined();
    expect((schema as Record<string, unknown>).userHotkeys).toBeUndefined();
  });

  it('exports draft lifecycle and eval schema tables', () => {
    expect(schema.aiDraftGeneration.contextMessageIds).toBeDefined();
    expect(schema.aiDraftGeneration.promptVersion).toBeDefined();
    expect(schema.mailDraft.status).toBeDefined();
    expect(schema.mailDraft.origin).toBeDefined();
    expect(schema.mailDraft.replyToMessageId).toBeDefined();
    expect(schema.mailDraft.generationId).toBeDefined();
    expect(schema.mailDraftRevision.kind).toBeDefined();
    expect(schema.aiWorkflowRun).toBeDefined();
    expect(schema.aiWorkflowRun.idempotencyKey).toBeDefined();
    expect(schema.aiWorkflowRun.state).toBeDefined();
    expect(schema.aiWorkflowRun.runKind).toBeDefined();
  });
});

import { mailCategory, mailThreadCategory } from '../src/db/schema/mail.js';

describe('mail category schema', () => {
  it('exports mailbox-scoped categories and thread membership tables', () => {
    expect(mailCategory).toBeDefined();
    expect(mailThreadCategory).toBeDefined();
    expect(mailCategory.id.name).toBe('id');
    expect(mailCategory.slug.name).toBe('slug');
    expect(mailThreadCategory.categoryId.name).toBe('category_id');
    expect(mailThreadCategory.threadId.name).toBe('thread_id');
  });
});

const hitlMigrationDdl = readFileSync(
  fileURLToPath(new URL('../drizzle/0046_hitl_ledger.sql', import.meta.url)),
  'utf8',
);

/** The CREATE TABLE body for one table in the hand-written migration. */
function createTableBody(ddl: string, table: string): string {
  const start = ddl.indexOf(`CREATE TABLE IF NOT EXISTS "${table}" (`);
  if (start < 0) return '';
  const end = ddl.indexOf('\n);', start);
  return ddl.slice(start, end);
}

const ledgerDialect = new PgDialect();

/** Collapses SQL text for comparison: no quotes, no table qualifiers, one case, single spaces. */
function sqlKey(text: string): string {
  return text
    .replace(/"/g, '')
    .replace(/\b[a-z_]+\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A Drizzle column's default as the SQL default would read: 'text' literals quoted, SQL rendered. */
function drizzleDefault(column: unknown): string | null {
  const { hasDefault, default: value } = column as { hasDefault: boolean; default?: unknown };
  if (!hasDefault) return null;
  if (value === undefined) return '<function>';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'object' && value !== null) {
    return ledgerDialect.sqlToQuery(value as SQL).sql.replace(/\s+/g, ' ').trim();
  }
  return String(value);
}

type DdlColumn = { type: string; notNull: boolean; primary: boolean; defaultExpr: string | null };

function ddlColumns(tableBody: string): Map<string, DdlColumn> {
  const columns = new Map<string, DdlColumn>();
  for (const line of tableBody.split('\n')) {
    const match = /^  "([^"]+)" (.+?),?$/.exec(line);
    if (!match) continue;
    const [, name = '', rest = ''] = match;
    const primary = / PRIMARY KEY/.test(rest);
    columns.set(name, {
      type: (rest.split(/ DEFAULT | NOT NULL| PRIMARY KEY| REFERENCES /)[0] ?? '')
        .replace(/\s+/g, '')
        .toLowerCase(),
      notNull: primary || / NOT NULL/.test(rest),
      primary,
      defaultExpr:
        rest.match(/ DEFAULT (.+?)(?= NOT NULL| PRIMARY KEY| REFERENCES |$)/)?.[1]?.trim() ?? null,
    });
  }
  return columns;
}

type DdlIndex = { unique: boolean; columns: string[]; where: string | null };

function ddlIndexes(ddl: string, table: string): Map<string, DdlIndex> {
  const indexes = new Map<string, DdlIndex>();
  const pattern =
    /CREATE (UNIQUE )?INDEX IF NOT EXISTS "([^"]+)" ON "([^"]+)" \(([^)]*)\)(?: WHERE (.*?))?;/g;
  for (const match of ddl.matchAll(pattern)) {
    if (match[3] !== table) continue;
    indexes.set(match[2] ?? '', {
      unique: Boolean(match[1]),
      columns: (match[4] ?? '').split(',').map((column) => column.trim().replace(/"/g, '')),
      where: match[5] ?? null,
    });
  }
  return indexes;
}

/** Foreign keys from inline REFERENCES and from ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY. */
function ddlForeignKeys(ddl: string): Array<{ table: string; column: string; target: string; onDelete: string }> {
  const keys: Array<{ table: string; column: string; target: string; onDelete: string }> = [];
  const onDelete = (action: string | undefined) => action ?? 'no action';
  for (const match of ddl.matchAll(
    /ALTER TABLE "([^"]+)"\s+ADD CONSTRAINT "[^"]+"\s+FOREIGN KEY \("([^"]+)"\) REFERENCES "([^"]+)"\("[^"]+"\)(?: ON DELETE (\w+(?: \w+)?))?/g,
  )) {
    keys.push({ table: match[1] ?? '', column: match[2] ?? '', target: match[3] ?? '', onDelete: onDelete(match[4]) });
  }
  let table = '';
  for (const line of ddl.split('\n')) {
    const created = /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(line);
    if (created) table = created[1] ?? '';
    const column = /^  "([^"]+)" .*REFERENCES "([^"]+)"\("[^"]+"\)(?: ON DELETE (\w+(?: \w+)?))?/.exec(line);
    if (column && table) {
      keys.push({ table, column: column[1] ?? '', target: column[2] ?? '', onDelete: onDelete(column[3]) });
    }
  }
  return keys;
}

/**
 * Every definition a hand-written migration's DDL must carry for the given Drizzle tables: the column set, each
 * column's type, nullability, primary flag and default, the index set with each index's uniqueness, columns
 * and predicate, and the foreign keys with their targets and delete actions. Empty when they agree.
 */
function definitionDrift(ddl: string, tables: PgTable[]): string[] {
  const drift: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const body = createTableBody(ddl, config.name);
    if (!body) {
      drift.push(`${config.name}: no CREATE TABLE`);
      continue;
    }
    const columns = ddlColumns(body);
    const drizzleNames = config.columns.map((column) => column.name).sort();
    if (JSON.stringify(drizzleNames) !== JSON.stringify([...columns.keys()].sort())) {
      drift.push(`${config.name}: column set ${drizzleNames} vs ${[...columns.keys()].sort()}`);
    }
    for (const column of config.columns) {
      const ddlColumn = columns.get(column.name);
      if (!ddlColumn) continue;
      const where = `${config.name}.${column.name}`;
      const drizzleType = column.getSQLType().replace(/\s+/g, '').toLowerCase();
      if (drizzleType !== ddlColumn.type) drift.push(`${where}: type ${drizzleType} vs ${ddlColumn.type}`);
      if (column.notNull !== ddlColumn.notNull) drift.push(`${where}: notNull ${column.notNull} vs ${ddlColumn.notNull}`);
      if (Boolean(column.primary) !== ddlColumn.primary) drift.push(`${where}: primary key`);
      const drizzleDefaultText = drizzleDefault(column);
      if ((drizzleDefaultText ?? null) !== (ddlColumn.defaultExpr ?? null)) {
        drift.push(`${where}: default ${drizzleDefaultText} vs ${ddlColumn.defaultExpr}`);
      }
    }
    const ddlIdx = ddlIndexes(ddl, config.name);
    const drizzleIdx = new Map(config.indexes.map((index) => [index.config.name, index.config]));
    if (JSON.stringify([...drizzleIdx.keys()].sort()) !== JSON.stringify([...ddlIdx.keys()].sort())) {
      drift.push(`${config.name}: index set ${[...drizzleIdx.keys()].sort()} vs ${[...ddlIdx.keys()].sort()}`);
    }
    for (const [name, index] of drizzleIdx) {
      const ddlIndex = ddlIdx.get(name);
      if (!ddlIndex) continue;
      if (Boolean(index.unique) !== ddlIndex.unique) drift.push(`${name}: unique`);
      const drizzleCols = index.columns.map((column: { name: string }) => column.name);
      if (JSON.stringify(drizzleCols) !== JSON.stringify(ddlIndex.columns)) {
        drift.push(`${name}: columns ${drizzleCols} vs ${ddlIndex.columns}`);
      }
      const drizzleWhere = index.where ? sqlKey(ledgerDialect.sqlToQuery(index.where).sql) : null;
      const ddlWhere = ddlIndex.where ? sqlKey(ddlIndex.where) : null;
      if (drizzleWhere !== ddlWhere) drift.push(`${name}: predicate ${drizzleWhere} vs ${ddlWhere}`);
    }
    const drizzleKeys = config.foreignKeys
      .map((foreignKey) => {
        const reference = foreignKey.reference();
        return `${reference.columns[0]?.name}->${getTableConfig(reference.foreignTable).name}:${foreignKey.onDelete ?? 'no action'}`;
      })
      .sort();
    const ddlKeys = ddlForeignKeys(ddl)
      .filter((key) => key.table === config.name)
      .map((key) => `${key.column}->${key.target}:${key.onDelete}`)
      .sort();
    if (JSON.stringify(drizzleKeys) !== JSON.stringify(ddlKeys)) {
      drift.push(`${config.name}: foreign keys ${drizzleKeys} vs ${ddlKeys}`);
    }
  }
  return drift;
}

describe('HITL decision ledger schema', () => {
  const ledgerTables = {
    aiAgentRun: schema.aiAgentRun,
    hitlEpisode: schema.hitlEpisode,
    hitlEvent: schema.hitlEvent,
    hitlToolRun: schema.hitlToolRun,
  };

  it('exports the four ledger tables with their key columns', () => {
    expect(schema.aiAgentRun.cachedFromRunId).toBeDefined();
    expect(schema.aiAgentRun.retentionExpiresAt).toBeDefined();
    expect(schema.aiAgentRun.inputKey).toBeDefined();
    expect(schema.hitlEpisode.firstRunId).toBeDefined();
    expect(schema.hitlEpisode.latestRunId).toBeDefined();
    expect(schema.hitlEpisode.outcome).toBeDefined();
    expect(schema.hitlEpisode.labelStrength).toBeDefined();
    expect(schema.hitlEvent.kind).toBeDefined();
    expect(schema.hitlEvent.fieldPath).toBeDefined();
    expect(schema.hitlToolRun.status).toBeDefined();
    expect(schema.hitlToolRun.confirmationNo).toBeDefined();
  });

  it('keeps the hand-written migration in step with every Drizzle table, definition by definition', () => {
    expect(definitionDrift(hitlMigrationDdl, Object.values(ledgerTables))).toEqual([]);
    for (const table of Object.values(ledgerTables)) {
      const config = getTableConfig(table);
      for (const check of config.checks) {
        expect(createTableBody(hitlMigrationDdl, config.name), check.name).toContain(
          `CONSTRAINT "${check.name}"`,
        );
      }
    }
  });

  it('reports drift in types, nullability, defaults, index columns, predicates and uniqueness', () => {
    const mutations: Array<[string, string, string]> = [
      ['column type', '"trace_id" text NOT NULL', '"trace_id" varchar NOT NULL'],
      ['nullability', '"source" text NOT NULL', '"source" text'],
      ['default', `"agent" text DEFAULT 'luna' NOT NULL`, `"agent" text DEFAULT 'codex' NOT NULL`],
      [
        'index columns',
        '"ai_agent_run_input_key_idx" ON "ai_agent_run" ("input_key")',
        '"ai_agent_run_input_key_idx" ON "ai_agent_run" ("input_hash")',
      ],
      ['index predicate', 'WHERE "field_path" IS NOT NULL', 'WHERE "field_path" IS NULL'],
      [
        'index uniqueness',
        'CREATE UNIQUE INDEX IF NOT EXISTS "hitl_episode_message_user_uidx"',
        'CREATE INDEX IF NOT EXISTS "hitl_episode_message_user_uidx"',
      ],
    ];
    for (const [label, from, to] of mutations) {
      expect(hitlMigrationDdl.includes(from), label).toBe(true);
      expect(
        definitionDrift(hitlMigrationDdl.replace(from, to), Object.values(ledgerTables)),
        label,
      ).not.toEqual([]);
    }
  });

  it('keeps CHECK vocabularies in step with the TypeScript lists', () => {
    const lines = hitlMigrationDdl.split('\n');
    const expected: Array<[string, readonly string[]]> = [
      ['ai_agent_run_trigger_check', AGENT_RUN_TRIGGERS],
      ['ai_agent_run_cache_status_check', AGENT_RUN_CACHE_STATUSES],
      ['ai_agent_run_source_check', AGENT_RUN_SOURCES],
      ['hitl_episode_outcome_check', HITL_EPISODE_OUTCOMES],
      ['hitl_episode_label_strength_check', HITL_LABEL_STRENGTHS],
      ['hitl_event_kind_check', HITL_EVENT_KINDS],
      ['hitl_tool_run_kind_check', HITL_TOOL_RUN_KINDS],
      ['hitl_tool_run_status_check', HITL_TOOL_RUN_STATUSES],
    ];
    for (const [name, values] of expected) {
      const line = lines.find((item) => item.includes(`CONSTRAINT "${name}"`));
      expect(line, name).toBeDefined();
      const listed = [...(line ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
      expect(listed, name).toEqual([...values]);
    }
  });

  it('keeps the migration additive: only new tables are altered', () => {
    expect(hitlMigrationDdl).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
    const altered = [...hitlMigrationDdl.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
    expect(altered).toEqual(['ai_agent_run']);
  });

  it('keeps ledger rows independent of the ai_workflow_run queue', () => {
    // A FK into ai_workflow_run pins its pkey, and migration-compatibility drops that pkey.
    const allowed = [
      'ai_agent_run',
      'hitl_episode',
      'mail_thread',
      'mailbox_transport',
      'message',
      'user',
    ];
    const drizzleTargets = Object.values(ledgerTables).flatMap((table) =>
      getTableConfig(table).foreignKeys.map(
        (foreignKey) => getTableConfig(foreignKey.reference().foreignTable).name,
      ),
    );
    const ddlTargets = [...hitlMigrationDdl.matchAll(/REFERENCES "([^"]+)"/g)].map((m) => m[1]);
    expect([...new Set(drizzleTargets)].sort()).toEqual(allowed);
    expect([...new Set(ddlTargets)].sort()).toEqual(allowed);
    expect(hitlMigrationDdl).not.toMatch(/ai_workflow_run/);
  });

  it('keeps decision rows when a thread or message is deleted, instead of erasing them', () => {
    // Mail rows are deleted by fixture cleanup today. A cascade would erase the recorded answer with them.
    expect(hitlMigrationDdl).toMatch(/"thread_id" text REFERENCES "mail_thread"\("id"\) ON DELETE set null/);
    expect(hitlMigrationDdl).toMatch(/"message_id" text REFERENCES "message"\("id"\) ON DELETE set null/);
    expect(hitlMigrationDdl).not.toMatch(/REFERENCES "(mail_thread|message)"\("id"\) ON DELETE cascade/);
    expect(schema.aiAgentRun.threadId.notNull).toBe(false);
    expect(schema.aiAgentRun.messageId.notNull).toBe(false);
    expect(schema.hitlEpisode.messageId.notNull).toBe(false);
  });

  it('registers 0046 in the journal directly after 0045 on a +1000ms clock', () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url)),
        'utf8',
      ),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const previous = journal.entries.find((entry) => entry.idx === 45);
    const next = journal.entries.find((entry) => entry.idx === 46);
    expect(previous?.tag).toBe('0045_message_thread_transport_fk');
    expect(next?.tag).toBe('0046_hitl_ledger');
    expect(next?.when).toBe((previous?.when ?? 0) + 1000);
  });
});

const workMigrationDdl = readFileSync(
  fileURLToPath(new URL('../drizzle/0047_nava_work_items.sql', import.meta.url)),
  'utf8',
);

describe('Nava work item schema', () => {
  const workTables = {
    mailExtraction: schema.mailExtraction,
    workItem: schema.workItem,
    workEvent: schema.workEvent,
    customRate: schema.customRate,
  };

  it('keeps the 0047 DDL in step with every new Drizzle table, definition by definition', () => {
    expect(definitionDrift(workMigrationDdl, Object.values(workTables))).toEqual([]);
    for (const table of Object.values(workTables)) {
      const config = getTableConfig(table);
      for (const check of config.checks) {
        expect(createTableBody(workMigrationDdl, config.name), check.name).toContain(
          `CONSTRAINT "${check.name}"`,
        );
      }
    }
  });

  it('reports drift in the 0047 tables when a default or predicate changes', () => {
    const mutations: Array<[string, string, string]> = [
      [
        'default',
        `"status" text DEFAULT 'needs_you' NOT NULL`,
        `"status" text DEFAULT 'review' NOT NULL`,
      ],
      ['index predicate', 'WHERE "archived_at" IS NULL', 'WHERE "archived_at" IS NOT NULL'],
      [
        'approval index predicate',
        `WHERE "type" = 'approval.consumed'`,
        `WHERE "type" = 'approval.granted'`,
      ],
      [
        'mail link action',
        '"source_message_id" text REFERENCES "message"("id") ON DELETE set null',
        '"source_message_id" text REFERENCES "message"("id") ON DELETE cascade',
      ],
      [
        'foreign key action',
        '"work_item_id" uuid NOT NULL REFERENCES "work_item"("id") ON DELETE restrict',
        '"work_item_id" uuid NOT NULL REFERENCES "work_item"("id") ON DELETE cascade',
      ],
    ];
    const tables = Object.values(workTables);
    for (const [label, from, to] of mutations) {
      expect(workMigrationDdl.includes(from), label).toBe(true);
      expect(definitionDrift(workMigrationDdl.replace(from, to), tables), label).not.toEqual([]);
    }
  });

  it('keeps 0047 CHECK vocabularies in step with the TypeScript lists', () => {
    const lines = workMigrationDdl.split('\n');
    const expected: Array<[string, readonly string[]]> = [
      ['mail_extraction_status_check', MAIL_EXTRACTION_STATUSES],
      ['mail_extraction_kind_check', MAIL_KINDS],
      ['work_item_kind_check', MAIL_KINDS],
      ['work_item_status_check', WORK_ITEM_STATUSES],
      ['work_event_actor_kind_check', WORK_EVENT_ACTOR_KINDS],
    ];
    for (const [name, values] of expected) {
      const line = lines.find((item) => item.includes(`CONSTRAINT "${name}"`));
      expect(line, name).toBeDefined();
      const listed = [...(line ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
      expect(listed, name).toEqual([...values]);
    }
    // Event types are validated in app code, so a new type never needs a migration.
    expect(workMigrationDdl).not.toContain('work_event_type_check');
    expect(WORK_EVENT_TYPES).toContain('approval.consumed');
  });

  it('extends ai_workflow_run with a nullable work item link and a smallint priority defaulting to 0', () => {
    expect(workMigrationDdl).toContain('ADD COLUMN IF NOT EXISTS "work_item_id" uuid,');
    expect(workMigrationDdl).toContain(
      'ADD COLUMN IF NOT EXISTS "priority" smallint DEFAULT 0 NOT NULL;',
    );
    expect(workMigrationDdl).toContain(
      'FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE set null;',
    );
    expect(workMigrationDdl).toContain(
      'CREATE INDEX IF NOT EXISTS "ai_workflow_run_work_item_created_idx" ON "ai_workflow_run" ("work_item_id", "created_at");',
    );
    expect(schema.aiWorkflowRun.workItemId.notNull).toBe(false);
    expect(schema.aiWorkflowRun.priority.notNull).toBe(true);
    expect(schema.aiWorkflowRun.priority.default).toBe(0);
    const workItemKey = getTableConfig(schema.aiWorkflowRun).foreignKeys.find(
      (foreignKey) => foreignKey.reference().columns[0]?.name === 'work_item_id',
    );
    expect(workItemKey?.onDelete).toBe('set null');
  });

  it('adds three run kinds to the enum without using them inside the migration', () => {
    const kinds = ['inbound_extraction', 'quote_followup', 'hms_write'];
    expect(schema.aiWorkflowRunKindEnum.enumValues).toEqual(expect.arrayContaining(kinds));
    const addValues = [...workMigrationDdl.matchAll(/ADD VALUE IF NOT EXISTS '([a-z_]+)';/g)];
    expect(addValues.map((match) => match[1])).toEqual(kinds);
    const outsideAddValue = workMigrationDdl.replace(/ADD VALUE IF NOT EXISTS '[a-z_]+';/g, '');
    for (const kind of kinds) expect(outsideAddValue, kind).not.toContain(`'${kind}'`);
  });

  it('keeps 0047 additive: nothing dropped, and only ai_workflow_run is altered', () => {
    expect(workMigrationDdl).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
    const altered = new Set(
      [...workMigrationDdl.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]),
    );
    expect([...altered]).toEqual(['ai_workflow_run']);
  });

  it('registers 0047 in the journal directly after 0046 on a +1000ms clock', () => {
    const journal = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url)),
        'utf8',
      ),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const previous = journal.entries.find((entry) => entry.idx === 46);
    const next = journal.entries.find((entry) => entry.idx === 47);
    expect(previous?.tag).toBe('0046_hitl_ledger');
    expect(next?.tag).toBe('0047_nava_work_items');
    expect(next?.when).toBe((previous?.when ?? 0) + 1000);
  });
});
