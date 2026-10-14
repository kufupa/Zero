import { importActionLabels } from '../scripts/import-action-labels.js';
import { TEST_DB_AVAILABLE, withTestDb } from './helpers/test-db.js';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '../src/db/schema/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const EXPECTED_ACTIONS = [
  'no_action',
  'quote_availability',
  'new_booking',
  'amend',
  'cancel',
  'payment_proof',
  'billing',
  'group_event',
  'other_actionable',
] as const;
const EXPECTED_SOURCES = ['model', 'agent', 'owner'] as const;
const migrationUrl = new URL('../drizzle/0049_mail_action_label.sql', import.meta.url);
const dialect = new PgDialect();

function migrationDdl() {
  expect(existsSync(migrationUrl), '0049 migration must exist').toBe(true);
  return readFileSync(migrationUrl, 'utf8');
}

function sqlKey(value: string) {
  return value
    .replace(/"/g, '')
    .replace(/\b[a-z_]+\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Required routing metadata only: no subject, snippet, body, or real addresses. */
async function seedMessage(db: DB, existingTransportId?: string) {
  const suffix = randomUUID();
  const transportId = existingTransportId ?? `action-label-transport-${suffix}`;
  const threadId = `action-label-thread-${suffix}`;
  const messageId = `action-label-message-${suffix}`;
  if (!existingTransportId)
    await db.insert(schema.mailboxTransport).values({
      id: transportId,
      email: `${suffix}@example.invalid`,
      ownerHeaderValue: transportId,
    });
  await db.insert(schema.mailThread).values({ id: threadId, transportId, threadRootId: threadId });
  await db.insert(schema.message).values({
    id: messageId,
    transportId,
    threadId,
    direction: 'inbound',
    fromAddress: 'fixture@example.invalid',
  });
  return { transportId, messageId };
}

describe('mail_action_label schema and migration', () => {
  it('exports the full durable table and one shared action vocabulary', async () => {
    expect(schema.mailActionLabel).toBeDefined();
    const vocabulary = await import('../src/mail/action-labels.js');
    expect(vocabulary.MAIL_ACTIONS).toEqual(EXPECTED_ACTIONS);
    expect(vocabulary.MAIL_ACTION_LABEL_SOURCES).toEqual(EXPECTED_SOURCES);
    const table = getTableConfig(schema.mailActionLabel);
    expect(table.name).toBe('mail_action_label');
    expect(
      table.columns.map((column) => [
        column.name,
        column.getSQLType(),
        column.notNull,
        column.primary,
        column.hasDefault,
      ]),
    ).toEqual([
      ['id', 'uuid', true, true, true],
      ['transport_id', 'text', true, false, false],
      ['message_id', 'text', true, false, false],
      ['source', 'text', true, false, false],
      ['action', 'text', true, false, false],
      ['needs_action', 'boolean', true, false, false],
      ['version', 'text', true, false, false],
      ['labelled_by', 'text', false, false, false],
      ['created_at', 'timestamp', true, false, true],
      ['updated_at', 'timestamp', true, false, true],
    ]);
    expect(dialect.sqlToQuery(schema.mailActionLabel.id.default as SQL).sql).toBe(
      'gen_random_uuid()',
    );
    for (const column of [schema.mailActionLabel.createdAt, schema.mailActionLabel.updatedAt]) {
      expect(dialect.sqlToQuery(column.default as SQL).sql).toBe('now()');
    }
    expect(
      table.foreignKeys.map((key) => {
        const reference = key.reference();
        return [
          reference.columns[0]?.name,
          getTableConfig(reference.foreignTable).name,
          key.onDelete,
        ];
      }),
    ).toEqual([
      ['transport_id', 'mailbox_transport', 'cascade'],
      ['message_id', 'message', 'cascade'],
    ]);
    expect(
      table.indexes.map(({ config }) => [
        config.name,
        config.unique,
        config.columns.map((column) => ('name' in column ? column.name : null)),
      ]),
    ).toEqual([
      ['mail_action_label_message_source_version_uidx', true, ['message_id', 'source', 'version']],
      [
        'mail_action_label_transport_source_action_idx',
        false,
        ['transport_id', 'source', 'action'],
      ],
    ]);
  });

  it('keeps migration columns, foreign keys, indexes and CHECKs aligned with Drizzle', () => {
    expect(schema.mailActionLabel).toBeDefined();
    const ddl = migrationDdl();
    const normalized = sqlKey(ddl);
    const table = getTableConfig(schema.mailActionLabel);
    for (const column of table.columns) {
      const line = ddl.split('\n').find((entry) => entry.startsWith(`  "${column.name}" `));
      expect(line, column.name).toBeDefined();
      expect(line).toContain(`"${column.name}" ${column.getSQLType()}`);
      expect(line?.includes('NOT NULL')).toBe(column.notNull);
      expect(line?.includes('PRIMARY KEY')).toBe(column.primary);
      expect(line?.includes('DEFAULT')).toBe(column.hasDefault);
    }
    for (const check of table.checks) {
      expect(normalized).toContain(
        `constraint ${check.name} check (${sqlKey(dialect.sqlToQuery(check.value).sql)})`,
      );
    }
    expect(table.checks.map((check) => check.name)).toEqual([
      'mail_action_label_source_check',
      'mail_action_label_action_check',
      'mail_action_label_needs_action_check',
    ]);
    for (const [name, values] of [
      ['mail_action_label_action_check', EXPECTED_ACTIONS],
      ['mail_action_label_source_check', EXPECTED_SOURCES],
    ] as const) {
      const line = ddl.split('\n').find((entry) => entry.includes(`CONSTRAINT "${name}"`));
      expect([...(line ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual(values);
    }
    expect(normalized).toContain(
      'transport_id text not null references mailbox_transport(id) on delete cascade',
    );
    expect(normalized).toContain(
      'message_id text not null references message(id) on delete cascade',
    );
    expect(normalized).toContain(
      'create unique index if not exists mail_action_label_message_source_version_uidx on mail_action_label (message_id, source, version)',
    );
    expect(normalized).toContain(
      'create index if not exists mail_action_label_transport_source_action_idx on mail_action_label (transport_id, source, action)',
    );
  });

  it('registers additive 0049 directly after 0048 with statement breakpoints', () => {
    const ddl = migrationDdl();
    expect(ddl).not.toMatch(/\b(DROP|ALTER)\s+/i);
    expect(ddl.match(/--> statement-breakpoint/g)).toHaveLength(2);
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as {
      entries: Array<{
        idx: number;
        tag: string;
        when: number;
        version: string;
        breakpoints: boolean;
      }>;
    };
    const previous = journal.entries.find((entry) => entry.idx === 48);
    expect(journal.entries.filter((entry) => entry.idx === 49)).toEqual([
      {
        idx: 49,
        version: '7',
        when: (previous?.when ?? 0) + 1000,
        tag: '0049_mail_action_label',
        breakpoints: true,
      },
    ]);
  });
});

describe.skipIf(!TEST_DB_AVAILABLE)('mail_action_label PostgreSQL constraints', () => {
  it('imports two synthetic pairs, defaults to dry run, and reruns without duplicates', async () => {
    await withTestDb(async (db) => {
      const first = await seedMessage(db);
      const second = await seedMessage(db, first.transportId);
      const fixture = [first.messageId, second.messageId, `unknown-${randomUUID()}`]
        .map((messageId) =>
          JSON.stringify({
            messageId,
            expected: { action: 'amend', needsAction: true },
            predictions: [{ action: 'no_action', needsAction: false }],
          }),
        )
        .join('\n');
      const options = { transportId: first.transportId, version: 'synthetic-import-v1' };
      const counts = { parsed: 3, matched: 2, missing: 1, invalid: 0, inserted: 0 };
      expect(await importActionLabels(db, fixture, options)).toEqual(counts);
      expect(
        await db
          .select()
          .from(schema.mailActionLabel)
          .where(eq(schema.mailActionLabel.transportId, first.transportId)),
      ).toEqual([]);
      expect(await importActionLabels(db, fixture, { ...options, write: true })).toEqual({
        ...counts,
        inserted: 4,
      });
      expect(await importActionLabels(db, fixture, { ...options, write: true })).toEqual(counts);
      const rows = await db
        .select()
        .from(schema.mailActionLabel)
        .where(eq(schema.mailActionLabel.transportId, first.transportId));
      expect(rows).toHaveLength(4);
      for (const messageId of [first.messageId, second.messageId]) {
        expect(rows.filter((row) => row.messageId === messageId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source: 'agent',
              action: 'amend',
              needsAction: true,
              version: options.version,
            }),
            expect.objectContaining({
              source: 'model',
              action: 'no_action',
              needsAction: false,
              version: options.version,
            }),
          ]),
        );
      }
    });
  });

  it('counts another transport message as missing and skips whole invalid pairs', async () => {
    await withTestDb(async (db) => {
      const selected = await seedMessage(db);
      const other = await seedMessage(db);
      const fixture = [
        {
          messageId: other.messageId,
          expected: { action: 'amend', needsAction: true },
          predictions: [{ action: 'cancel', needsAction: true }],
        },
        {
          messageId: selected.messageId,
          expected: { action: 'unknown', needsAction: true },
          predictions: [{ action: 'cancel', needsAction: true }],
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n');
      expect(
        await importActionLabels(db, fixture, {
          transportId: selected.transportId,
          version: 'synthetic-import-v1',
          write: true,
        }),
      ).toEqual({ parsed: 2, matched: 0, missing: 1, invalid: 1, inserted: 0 });
      expect(
        await db
          .select()
          .from(schema.mailActionLabel)
          .where(eq(schema.mailActionLabel.transportId, selected.transportId)),
      ).toEqual([]);
    });
  });

  it('accepts every action from each label source with generated IDs and timestamps', async () => {
    await withTestDb(async (db) => {
      for (const action of EXPECTED_ACTIONS) {
        const ids = await seedMessage(db);
        const rows = await db
          .insert(schema.mailActionLabel)
          .values(
            EXPECTED_SOURCES.map((source) => ({
              ...ids,
              source,
              action,
              needsAction: action !== 'no_action',
              version: source === 'owner' ? 'owner' : 'fixture-v1',
            })),
          )
          .returning();
        expect(rows).toHaveLength(EXPECTED_SOURCES.length);
        for (const row of rows) {
          expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
          expect(row.createdAt).toBeInstanceOf(Date);
          expect(row.updatedAt).toBeInstanceOf(Date);
          expect(row.labelledBy).toBeNull();
        }
      }
    });
  });

  it('rejects a duplicate message/source/version', async () => {
    await withTestDb(async (db) => {
      const ids = await seedMessage(db);
      const label = {
        ...ids,
        source: 'model' as const,
        action: 'amend' as const,
        needsAction: true,
        version: 'fixture-v1',
      };
      await db.insert(schema.mailActionLabel).values(label);
      await expect(db.insert(schema.mailActionLabel).values(label)).rejects.toMatchObject({
        cause: { code: '23505', constraint_name: 'mail_action_label_message_source_version_uidx' },
      });
    });
  });

  it('upserts one owner row while preserving ID and creation time', async () => {
    await withTestDb(async (db) => {
      const ids = await seedMessage(db);
      const [first] = await db
        .insert(schema.mailActionLabel)
        .values({
          ...ids,
          source: 'owner',
          action: 'cancel',
          needsAction: true,
          version: 'owner',
          labelledBy: 'fixture-owner-a',
        })
        .returning();
      const updatedAt = new Date('2026-10-14T12:00:00.000Z');
      await db
        .insert(schema.mailActionLabel)
        .values({
          ...ids,
          source: 'owner',
          action: 'no_action',
          needsAction: false,
          version: 'owner',
          labelledBy: 'fixture-owner-b',
        })
        .onConflictDoUpdate({
          target: [
            schema.mailActionLabel.messageId,
            schema.mailActionLabel.source,
            schema.mailActionLabel.version,
          ],
          set: {
            action: 'no_action',
            needsAction: false,
            labelledBy: 'fixture-owner-b',
            updatedAt,
          },
        });
      const rows = await db
        .select()
        .from(schema.mailActionLabel)
        .where(eq(schema.mailActionLabel.messageId, ids.messageId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: first!.id,
        createdAt: first!.createdAt,
        action: 'no_action',
        needsAction: false,
        version: 'owner',
        labelledBy: 'fixture-owner-b',
        updatedAt,
      });
    });
  });

  it.each([
    ['invalid_action', 'model', true, 'mail_action_label_action_check'],
    ['amend', 'invalid_source', true, 'mail_action_label_source_check'],
    ['no_action', 'model', true, 'mail_action_label_needs_action_check'],
    ['amend', 'model', false, 'mail_action_label_needs_action_check'],
  ] as const)(
    'rejects action=%s source=%s needs_action=%s',
    async (action, source, needsAction, constraint) => {
      await withTestDb(async (db) => {
        const ids = await seedMessage(db);
        await expect(
          db.execute(sql`
        INSERT INTO ${schema.mailActionLabel}
          (transport_id, message_id, source, action, needs_action, version)
        VALUES (${ids.transportId}, ${ids.messageId}, ${source}, ${action}, ${needsAction}, 'fixture-v1')
      `),
        ).rejects.toMatchObject({ cause: { code: '23514', constraint_name: constraint } });
      });
    },
  );

  it('deletes all source labels when their message is deleted', async () => {
    await withTestDb(async (db) => {
      const ids = await seedMessage(db);
      await db.insert(schema.mailActionLabel).values(
        EXPECTED_SOURCES.map((source) => ({
          ...ids,
          source,
          action: 'amend' as const,
          needsAction: true,
          version: source === 'owner' ? 'owner' : 'fixture-v1',
        })),
      );
      await db.delete(schema.message).where(eq(schema.message.id, ids.messageId));
      expect(
        await db
          .select()
          .from(schema.mailActionLabel)
          .where(eq(schema.mailActionLabel.messageId, ids.messageId)),
      ).toEqual([]);
    });
  });

  it('deletes labels when their transport is deleted', async () => {
    await withTestDb(async (db) => {
      const ids = await seedMessage(db);
      await db
        .insert(schema.mailActionLabel)
        .values({ ...ids, source: 'owner', action: 'amend', needsAction: true, version: 'owner' });
      await db
        .delete(schema.mailboxTransport)
        .where(eq(schema.mailboxTransport.id, ids.transportId));
      expect(
        await db
          .select()
          .from(schema.mailActionLabel)
          .where(eq(schema.mailActionLabel.transportId, ids.transportId)),
      ).toEqual([]);
    });
  });
});
