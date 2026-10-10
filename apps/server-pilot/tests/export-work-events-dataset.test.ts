import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GoldenRow } from '../src/ai/reservationist-backtest.js';
import type { DB } from '../src/db/client.js';
import { workEvent, workItem, type WorkEventType } from '../src/db/schema/work.js';
import {
  exportWorkEvents,
  hashSplit,
  main,
  type EvalRow,
} from '../scripts/export-work-events-dataset.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';
const STAY_A = 's_aaaa1111';
const STAY_B = 's_bbbb2222';
const ROW_A = 'r_aaaa1111';
const ROW_B = 'r_bbbb2222';
const T0 = Date.parse('2026-10-10T09:00:00Z');

type Edit = {
  type: WorkEventType;
  fieldPath: string;
  aiValue?: unknown;
  value?: unknown;
  /** Seconds after T0, so event order is explicit in every test. */
  at: number;
};

/** A thread with one inbound message and a quote work item on it. */
async function seedItem(db: DB, threadId: string, messageIds: string[] = [`msg-${threadId}`]) {
  for (const messageId of messageIds) {
    await seedInboxThread(db, {
      threadId,
      transportId: TRANSPORT_ID,
      transportEmail: TRANSPORT_EMAIL,
      messageId,
    });
  }
  const [item] = await db
    .insert(workItem)
    .values({ transportId: TRANSPORT_ID, threadId, sourceMessageId: messageIds[0], kind: 'quote' })
    .returning({ id: workItem.id });
  return item!.id;
}

async function addEvents(db: DB, workItemId: string, edits: Edit[]) {
  await db.insert(workEvent).values(
    edits.map((edit) => ({
      workItemId,
      actorKind: 'user',
      actorUserId: 'user-ropperman',
      type: edit.type,
      fieldPath: edit.fieldPath,
      aiValue: edit.aiValue ?? null,
      value: edit.value ?? null,
      at: new Date(T0 + edit.at * 1000),
    })),
  );
}

function goldenCase(id: string, split: 'dev' | 'holdout', triggerId: string, contextIds: string[] = []): GoldenRow {
  const email = (messageId: string) => ({
    id: messageId,
    direction: 'inbound',
    eventAt: null,
    from: 'guest@example.com',
    subject: 'Booking enquiry',
    text: 'Please book two rooms.',
  });
  return {
    id,
    split,
    type: 'create',
    trigger: email(triggerId),
    context: contextIds.map(email),
    expected: {},
    recordedReads: [],
  } as GoldenRow;
}

function byField(rows: readonly EvalRow[], fieldId: string): EvalRow {
  const row = rows.find((item) => item.field_id === fieldId);
  if (!row) throw new Error(`no row for ${fieldId}`);
  return row;
}

describe('work-event eval export', () => {
  it('exports one row per edited field with the first AI value and the final human value', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-edits');
      const count = `stays[${STAY_A}].rows[${ROW_A}].count`;
      const arrival = `stays[${STAY_A}].requested.arrival`;
      const departure = `stays[${STAY_A}].requested.departure`;
      await addEvents(db, item, [
        { type: 'field.edit', fieldPath: count, aiValue: 2, value: 3, at: 1 },
        { type: 'field.edit', fieldPath: count, aiValue: 3, value: 4, at: 2 },
        { type: 'field.edit', fieldPath: arrival, aiValue: '2027-10-26', value: '2027-10-27', at: 3 },
        // Accepted without an edit: the AI value stands, so the field is not a label.
        { type: 'field.accept', fieldPath: departure, aiValue: '2027-10-28', value: '2027-10-28', at: 4 },
      ]);

      const { rows } = await exportWorkEvents(db);

      expect(rows.map((row) => row.field_id).sort()).toEqual([arrival, count].sort());
      expect(byField(rows, count)).toMatchObject({
        schema_version: 'work-event-eval/v1',
        work_item_id: item,
        ai_value: 2,
        human_value: 4,
        label_status: 'candidate',
      });
      expect(byField(rows, count).event_ids).toHaveLength(2);
      expect(byField(rows, arrival)).toMatchObject({ ai_value: '2027-10-26', human_value: '2027-10-27' });
      expect(byField(rows, arrival).event_ids).toHaveLength(1);
    });
  });

  it('pairs by stable id after a stay is deleted', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-delete');
      const removedA = `stays[${STAY_A}].removed`;
      const arrivalB = `stays[${STAY_B}].requested.arrival`;
      const countB = `stays[${STAY_B}].rows[${ROW_B}].count`;
      // Stay A comes first in the extraction. Its deletion must not shift stay B's AI values onto A's pairs.
      await addEvents(db, item, [
        { type: 'field.edit', fieldPath: removedA, aiValue: false, value: true, at: 1 },
        { type: 'field.edit', fieldPath: arrivalB, aiValue: '2027-11-17', value: '2027-11-18', at: 2 },
        { type: 'field.edit', fieldPath: countB, aiValue: 4, value: 5, at: 3 },
      ]);

      const { rows } = await exportWorkEvents(db);

      expect(rows).toHaveLength(3);
      expect(byField(rows, removedA)).toMatchObject({ ai_value: false, human_value: true });
      expect(byField(rows, arrivalB)).toMatchObject({ ai_value: '2027-11-17', human_value: '2027-11-18' });
      expect(byField(rows, countB)).toMatchObject({ ai_value: 4, human_value: 5 });
    });
  });

  it('keeps a golden holdout thread in holdout and a golden dev thread in dev', async () => {
    await withIngestionDb(async ({ db }) => {
      const edit: Edit = { type: 'field.edit', fieldPath: `stays[${STAY_A}].requested.arrival`, aiValue: '2027-10-26', value: '2027-10-27', at: 1 };
      const holdout = await seedItem(db, 'thread-holdout');
      const dev = await seedItem(db, 'thread-dev');
      const free = await seedItem(db, 'thread-free');
      for (const item of [holdout, dev, free]) await addEvents(db, item, [edit]);
      const golden = [
        goldenCase('case-holdout', 'holdout', 'msg-thread-holdout'),
        goldenCase('case-dev', 'dev', 'msg-thread-dev'),
      ];

      const { rows, golden: stats } = await exportWorkEvents(db, { golden });

      expect(stats).toEqual({ matched: 2, total: 2 });
      expect(rows.find((row) => row.work_item_id === holdout)).toMatchObject({ split: 'holdout', split_source: 'golden' });
      expect(rows.find((row) => row.work_item_id === dev)).toMatchObject({ split: 'dev', split_source: 'golden' });
      expect(rows.find((row) => row.work_item_id === free)).toMatchObject({
        split: hashSplit('thread-free'),
        split_source: 'hash',
      });

      const holdoutOnly = await exportWorkEvents(db, { golden, split: 'holdout' });
      expect(holdoutOnly.rows.map((row) => row.work_item_id)).toContain(holdout);
      expect(holdoutOnly.rows.every((row) => row.split === 'holdout')).toBe(true);
    });
  });

  it('a thread with both dev and holdout golden cases is holdout', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-mixed', ['msg-mixed-1', 'msg-mixed-2']);
      await addEvents(db, item, [
        { type: 'field.edit', fieldPath: `stays[${STAY_A}].rows[${ROW_A}].count`, aiValue: 2, value: 3, at: 1 },
      ]);
      const golden = [
        goldenCase('case-dev', 'dev', 'msg-mixed-1'),
        goldenCase('case-holdout', 'holdout', 'msg-mixed-2', ['msg-mixed-1']),
      ];

      const { rows } = await exportWorkEvents(db, { golden });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ split: 'holdout', split_source: 'golden' });
    });
  });

  it('masks card numbers and security codes in both values', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-card');
      await addEvents(db, item, [
        {
          type: 'field.edit',
          fieldPath: 'contact.phone',
          aiValue: 'card 4111111111111111 on file',
          value: 'CVV: 123',
          at: 1,
        },
      ]);

      const { rows } = await exportWorkEvents(db);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ai_value: 'card [card ••••1111] on file',
        human_value: 'CVV: [code masked]',
      });
      expect(JSON.stringify(rows)).not.toContain('4111111111111111');
    });
  });

  it('main writes candidate JSONL to --out and refuses bad arguments', async () => {
    expect(await main(['--split', 'train'], { DATABASE_URL: 'postgres://unused' })).toBe(2);
    expect(await main(['--out', join(tmpdir(), 'unused.jsonl')], {})).toBe(2);

    await withIngestionDb(async ({ db, url }) => {
      const item = await seedItem(db, 'thread-cli');
      await addEvents(db, item, [
        { type: 'field.edit', fieldPath: `stays[${STAY_A}].requested.arrival`, aiValue: '2027-10-26', value: '2027-10-27', at: 1 },
      ]);
      const dir = mkdtempSync(join(tmpdir(), 'work-events-export-'));
      try {
        const golden = join(dir, 'golden.jsonl');
        writeFileSync(golden, '');
        const out = join(dir, 'nested', 'out.jsonl');

        expect(await main(['--out', out, '--golden-set', golden], { DATABASE_URL: url })).toBe(0);

        const lines = readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as EvalRow);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          schema_version: 'work-event-eval/v1',
          label_status: 'candidate',
          split_source: 'hash',
          ai_value: '2027-10-26',
          human_value: '2027-10-27',
        });
        expect(['dev', 'holdout']).toContain(lines[0]!.split);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
