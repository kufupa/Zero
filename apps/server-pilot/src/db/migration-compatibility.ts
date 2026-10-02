import {
  getTableConfig,
  PgDialect,
  PgEnumColumn,
  PgEnumObjectColumn,
  PgTable,
} from 'drizzle-orm/pg-core';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema/index.js';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { is } from 'drizzle-orm';

export class MigrationCompatibilityError extends Error {}

function normalizedType(type: string): string {
  // Existing committed SQL uses timestamptz for some ORM timestamp columns.
  // Both expose timestamps through the current postgres-js/Drizzle mapping.
  return type
    .replace(/\s+/g, '')
    .replaceAll('"', '')
    .replace(/^timestamp(?:with(?:out)?timezone)?$/, 'timestamp');
}

function normalizedPredicate(predicate: string, table: string): string {
  // pg_get_expr adds parentheses and literal casts, and omits table qualifiers.
  // Current ORM partial indexes use comparisons and IS NOT NULL, without parameters.
  return predicate
    .replaceAll(`"${table}".`, '')
    .replaceAll('"', '')
    .replace(/::[a-zA-Z_][a-zA-Z_0-9]*(?:\[\])?/g, '')
    .replace(/[()\s]/g, '');
}

/** Read-only activation gate. Unknown newer histories require a reviewed deployment route. */
export async function assertMigrationCompatibility(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  const migrations = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)),
  });
  await sql.begin('read only', async (tx) => {
    await tx`SET LOCAL statement_timeout = '10s'`;
    const [ledger] = await tx`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`;
    if (!ledger?.name) throw new MigrationCompatibilityError('Missing migration ledger');
    const applied = await tx<{ hash: string; created_at: string }[]>`
      SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
    `;
    for (let index = 0; index < Math.min(applied.length, migrations.length); index++) {
      if (
        applied[index].hash !== migrations[index].hash ||
        Number(applied[index].created_at) !== migrations[index].folderMillis
      ) {
        throw new MigrationCompatibilityError(`Migration mismatch at journal index ${index}`);
      }
    }
    if (applied.length < migrations.length) {
      throw new MigrationCompatibilityError(
        `${migrations.length - applied.length} pending committed migrations`,
      );
    }
    if (applied.length > migrations.length) {
      throw new MigrationCompatibilityError(
        'Database has newer migrations; reviewed deployment required',
      );
    }

    const columns = await tx<{ schema: string; table: string; column: string; type: string }[]>`
      SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
    `;
    const enumLabels = await tx<{ schema: string; name: string; label: string }[]>`
      SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS label
      FROM pg_catalog.pg_enum e
      JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    `;
    const indexes = await tx<
      {
        schema: string;
        table: string;
        name: string;
        columns: string[];
        unique: boolean;
        primary: boolean;
        valid: boolean;
        ready: boolean;
        predicate: string | null;
      }[]
    >`
      SELECT n.nspname AS schema, t.relname AS table, c.relname AS name,
             i.indisunique AS unique, i.indisprimary AS primary,
             i.indisvalid AS valid, i.indisready AS ready,
             pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate,
             ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY AS k(num, position)
                   JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.num
                   WHERE k.position <= i.indnkeyatts ORDER BY k.position) AS columns
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
      JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    `;
    const problems: string[] = [];
    for (const table of Object.values(schema).filter((value) => is(value, PgTable))) {
      const config = getTableConfig(table);
      const namespace = config.schema ?? 'public';
      const actual = columns.filter(
        (column) => column.schema === namespace && column.table === config.name,
      );
      if (actual.length === 0) {
        problems.push(`missing table ${namespace}.${config.name}`);
        continue;
      }
      for (const column of config.columns) {
        const found = actual.find((item) => item.column === column.name);
        const name = `${config.name}.${column.name}`;
        if (!found) problems.push(`missing column ${name}`);
        else if (normalizedType(found.type) !== normalizedType(column.getSQLType())) {
          problems.push(`type mismatch ${name}`);
        }
        if (is(column, PgEnumColumn) || is(column, PgEnumObjectColumn)) {
          const expected = column.enum;
          const labels = enumLabels.filter(
            (item) =>
              item.schema === (expected.schema ?? 'public') && item.name === expected.enumName,
          );
          for (const label of expected.enumValues) {
            if (!labels.some((item) => item.label === label))
              problems.push(`missing enum value ${expected.enumName}.${label}`);
          }
        }
      }
      const uniqueKeys = [
        ...config.indexes
          .filter((index) => index.config.unique)
          .map((index) => ({
            name: index.config.name,
            columns: index.config.columns.map((column) =>
              'name' in column ? column.name : undefined,
            ),
            primary: false,
            predicate: index.config.where
              ? new PgDialect().sqlToQuery(index.config.where).sql
              : null,
          })),
        ...config.primaryKeys.map((key) => ({
          columns: key.columns.map((column) => column.name),
          primary: true,
          predicate: null,
        })),
        ...config.uniqueConstraints.map((key) => ({
          columns: key.columns.map((column) => column.name),
          primary: false,
          predicate: null,
        })),
        ...config.columns
          .filter((column) => column.primary || column.isUnique)
          .map((column) => ({
            columns: [column.name],
            primary: column.primary,
            predicate: null,
          })),
      ];
      for (const key of uniqueKeys) {
        const found = indexes.some(
          (index) =>
            index.schema === namespace &&
            index.table === config.name &&
            index.unique &&
            index.valid &&
            index.ready &&
            ((index.predicate === null && key.predicate === null) ||
              (index.predicate !== null &&
                key.predicate !== null &&
                normalizedPredicate(index.predicate, config.name) ===
                  normalizedPredicate(key.predicate, config.name))) &&
            (!key.primary || index.primary) &&
            (!('name' in key) || !key.name || index.name === key.name) &&
            index.columns.length === key.columns.length &&
            index.columns.every((column, position) => column === key.columns[position]),
        );
        if (!found)
          problems.push(
            `missing compatible unique index ${'name' in key && key.name ? key.name : `${config.name}.${key.columns.join(',')}`}`,
          );
      }
    }
    if (problems.length)
      throw new MigrationCompatibilityError(`Schema incompatible: ${problems.join('; ')}`);
  });
}
