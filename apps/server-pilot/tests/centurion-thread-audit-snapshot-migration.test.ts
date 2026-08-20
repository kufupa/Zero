import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  import.meta.dirname,
  '../drizzle/0016_thread_audit_snapshot.sql',
);
const journalPath = resolve(import.meta.dirname, '../drizzle/meta/_journal.json');
const schemaPath = resolve(import.meta.dirname, '../src/db/schema/mail.ts');

describe('thread audit snapshot migration artifact', () => {
  it('adds only Task 7A schema objects in dependency order', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    const candidateIndex = sql.indexOf('mail_thread_id_transport_uidx');
    const headerCandidate = sql.indexOf(
      'thread_audit_snapshot_id_transport_uidx',
    );
    const dependentForeignKeys = [
      'thread_audit_snapshot_component_snapshot_transport_fk',
      'thread_audit_snapshot_component_thread_component_fk',
      'thread_audit_snapshot_component_thread_thread_transport_fk',
    ];
    const header = sql.indexOf('CREATE TABLE IF NOT EXISTS "thread_audit_snapshot"');
    const component = sql.indexOf(
      'CREATE TABLE IF NOT EXISTS "thread_audit_snapshot_component"',
    );
    const mapping = sql.indexOf(
      'CREATE TABLE IF NOT EXISTS "thread_audit_snapshot_component_thread"',
    );
    const finalForeignKey = Math.max(
      ...dependentForeignKeys.map((foreignKey) => sql.indexOf(foreignKey)),
    );
    const nonCandidateIndexes = [
      'thread_audit_snapshot_transport_uidx',
      'thread_audit_snapshot_component_snapshot_sort_idx',
      'thread_audit_snapshot_component_thread_rank_uidx',
      'thread_audit_snapshot_component_thread_primary_uidx',
    ];

    expect(candidateIndex).toBeGreaterThanOrEqual(0);
    for (const foreignKey of dependentForeignKeys) {
      expect(sql.indexOf(foreignKey)).toBeGreaterThan(candidateIndex);
    }
    expect(header).toBeGreaterThan(candidateIndex);
    expect(headerCandidate).toBeGreaterThan(header);
    expect(headerCandidate).toBeLessThan(
      sql.indexOf('thread_audit_snapshot_component_snapshot_transport_fk'),
    );
    expect(component).toBeGreaterThan(header);
    expect(mapping).toBeGreaterThan(component);
    for (const index of nonCandidateIndexes) {
      expect(sql.indexOf(index)).toBeGreaterThan(finalForeignKey);
    }
    expect(sql).not.toContain(
      'thread_audit_snapshot_component_thread_component_idx',
    );
    expect(sql).toContain('jsonb_typeof("metrics_and_insights") = \'object\'');
    expect(sql).toMatch(
      /"metrics_and_insights"\s+IS NOT NULL\s+AND\s+jsonb_typeof\("metrics_and_insights"\)\s*=\s*'object'/u,
    );
    expect(sql).toContain('thread_audit_snapshot_trust_shape_check');
    expect(sql).toContain('"trust_status" = \'valid\'');
    expect(sql).toContain('"trust_reason_code" = \'verified\'');
    expect(sql).toContain('thread_audit_snapshot_reject_incomplete_children');
    expect(sql).toContain('FOR UPDATE');
    expect(readFileSync(schemaPath, 'utf8')).toContain(
      '"trust_reason_code" = \'verified\'',
    );
    expect(readFileSync(schemaPath, 'utf8')).toMatch(
      /"metrics_and_insights"\s+IS NOT NULL\s+AND\s+jsonb_typeof\("metrics_and_insights"\)\s*=\s*'object'/u,
    );
    expect(sql).not.toMatch(
      /\b(?:DROP|DELETE\s+FROM|UPDATE\s+\S+\s+SET|INSERT\s+INTO|TRUNCATE|ALTER\s+TABLE\s+"mail_thread"\s+DROP)\b/iu,
    );
    expect(sql).not.toContain('statement-breakpoint');
    expect(readFileSync(schemaPath, 'utf8')).not.toContain(
      'thread_audit_snapshot_component_thread_component_idx',
    );
  });

  it('records hand-authored migration in the journal', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.at(-1)).toMatchObject({
      idx: 16,
      tag: '0016_thread_audit_snapshot',
    });
  });
});
