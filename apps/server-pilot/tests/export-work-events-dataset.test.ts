import {
  exportLabels,
  labelOf,
  main,
  splitFor,
  writeEvalLabels,
  type LabelEvent,
} from '../scripts/export-work-events-dataset.js';
import { evalLabel, workEvent, workItem, type WorkEventType } from '../src/db/schema/work.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { parseLabelCases, type LabelCase } from '../src/ai/label-scorers.js';
import type { GoldenRow } from '../src/ai/reservationist-backtest.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const TRANSPORT_ID = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';
const STAY_A = 's_aaaa1111';
const ROW_A = 'r_aaaa1111';
const T0 = Date.parse('2026-10-10T09:00:00Z');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type Edit = {
  type: WorkEventType;
  fieldPath?: string | null;
  aiValue?: unknown;
  value?: unknown;
  /** Seconds after T0, so event order is explicit in every test. */
  at: number;
};

/** A thread with an inbound mail and a quote work item on it. */
async function seedItem(db: DB, threadId: string, textBody = 'Please book two rooms.') {
  const messageId = `msg-${threadId}`;
  await seedInboxThread(db, {
    threadId,
    transportId: TRANSPORT_ID,
    transportEmail: TRANSPORT_EMAIL,
    messageId,
    fromAddress: 'guest@example.com',
    textBody,
  });
  const [item] = await db
    .insert(workItem)
    .values({ transportId: TRANSPORT_ID, threadId, sourceMessageId: messageId, kind: 'quote' })
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
      fieldPath: edit.fieldPath ?? null,
      aiValue: edit.aiValue ?? null,
      value: edit.value ?? null,
      aiSource: 'extractor-v3',
      at: new Date(T0 + edit.at * 1000),
    })),
  );
}

function event(overrides: Partial<LabelEvent>): LabelEvent {
  return {
    id: 'e-1',
    workItemId: 'w-1',
    type: 'field.edit',
    fieldPath: `stays[${STAY_A}].requested.arrival`,
    aiValue: '2027-10-26',
    value: '2027-10-27',
    aiSource: 'extractor-v3',
    at: new Date(T0),
    ...overrides,
  };
}

describe('labelOf', () => {
  it('maps edits and rejects to corrections, accepts to confirmations, and flags and notes to their own kinds', () => {
    expect(labelOf(event({}))).toMatchObject({
      labelKind: 'correction',
      humanValue: '2027-10-27',
      aiValue: '2027-10-26',
    });
    expect(
      labelOf(event({ type: 'field.reject', fieldPath: 'contact.name', value: null })),
    ).toMatchObject({
      labelKind: 'correction',
      humanValue: null,
    });
    expect(labelOf(event({ type: 'field.accept', value: '2027-10-26' }))).toMatchObject({
      labelKind: 'confirmation',
    });
    expect(
      labelOf(
        event({
          type: 'review.flag',
          fieldPath: null,
          aiValue: null,
          value: { note: 'dates wrong' },
        }),
      ),
    ).toMatchObject({
      labelKind: 'run_flag',
      fieldPath: 'review.flag',
    });
    expect(
      labelOf(
        event({ type: 'note.staff', fieldPath: null, aiValue: null, value: 'Ask about parking' }),
      ),
    ).toMatchObject({
      labelKind: 'note',
      fieldPath: 'note.staff',
    });
  });

  it('gives no label to draft decisions, rate choices or non-extraction fields', () => {
    expect(labelOf(event({ type: 'field.edit', fieldPath: 'followUp.draft' }))).toBeNull();
    expect(labelOf(event({ type: 'field.accept', fieldPath: 'followUp.draft' }))).toBeNull();
    expect(labelOf(event({ type: 'field.edit', fieldPath: null }))).toBeNull();
    expect(
      labelOf(event({ type: 'rate.one_off', fieldPath: 'quote.rows[g_room1].rate' })),
    ).toBeNull();
  });
});

describe('splitFor', () => {
  it('is stable and about 60/20/20 over work item ids', () => {
    const ids = Array.from(
      { length: 2000 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const first = ids.map((id) => splitFor(id));
    expect(ids.map((id) => splitFor(id))).toEqual(first);
    const count = (split: string) => first.filter((value) => value === split).length / ids.length;
    expect(count('dev')).toBeCloseTo(0.6, 1);
    expect(count('holdout')).toBeCloseTo(0.2, 1);
    expect(count('test')).toBeCloseTo(0.2, 1);
  });

  it('with the time split, an item whose latest label is within 30 days is test and older items never are', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    const recent = new Date('2026-09-25T00:00:00Z');
    const old = new Date('2026-08-01T00:00:00Z');
    expect(splitFor('any-item', { timeSplit: true, latestAt: recent, now })).toBe('test');
    expect(['dev', 'holdout']).toContain(
      splitFor('any-item', { timeSplit: true, latestAt: old, now }),
    );
  });
});

describe('work-event label export', () => {
  it('derives one label per label event and skips drafts, rates and reads of non-extraction fields', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-labels');
      const count = `stays[${STAY_A}].rows[${ROW_A}].count`;
      const arrival = `stays[${STAY_A}].requested.arrival`;
      await addEvents(db, item, [
        { type: 'field.edit', fieldPath: count, aiValue: 2, value: 3, at: 1 },
        {
          type: 'field.accept',
          fieldPath: arrival,
          aiValue: '2027-10-26',
          value: '2027-10-26',
          at: 2,
        },
        {
          type: 'field.edit',
          fieldPath: 'followUp.draft',
          aiValue: 'Draft one',
          value: 'Draft two',
          at: 3,
        },
        {
          type: 'rate.one_off',
          fieldPath: 'quote.rows[g_room1].rate',
          aiValue: { rateCode: 'RACK' },
          value: { amountMinor: 1 },
          at: 4,
        },
        { type: 'field.reject', fieldPath: 'contact.name', aiValue: 'J Smith', value: null, at: 5 },
        {
          type: 'review.flag',
          aiValue: null,
          value: { runId: 'run-1', note: 'Wrong count' },
          at: 6,
        },
        { type: 'note.staff', aiValue: null, value: 'Guest prefers a high floor', at: 7 },
      ]);

      const { cases, records } = await exportLabels(db);

      expect(records.map((record) => [record.labelKind, record.fieldPath]).sort()).toEqual(
        [
          ['confirmation', arrival],
          ['correction', count],
          ['correction', 'contact.name'],
          ['note', 'note.staff'],
          ['run_flag', 'review.flag'],
        ].sort(),
      );
      expect(records.every((record) => record.extractorVersion === 'extractor-v3')).toBe(true);
      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({
        work_item_id: item,
        kind: 'quote',
        extractor_version: null,
        split_source: 'hash',
      });
      expect(cases[0]!.labels).toHaveLength(5);
    });
  });

  it('masks card numbers, addresses and phone numbers in the case text, the labels and the eval_label rows, and keeps the sender and mailbox domains as digests', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(
        db,
        'thread-mask',
        'Card 4111111111111111 for the room. Ring Jane on 082 555 1234 or jane.smith@example.com. Two rooms on 2027-10-26.',
      );
      await addEvents(db, item, [
        {
          type: 'field.edit',
          fieldPath: 'contact.email',
          aiValue: 'jane@hotel.co.za',
          value: 'jane.smith@example.com',
          at: 1,
        },
        {
          type: 'field.edit',
          fieldPath: 'contact.phone',
          aiValue: 'x',
          value: '082 555 1234',
          at: 2,
        },
      ]);

      const { cases, records } = await exportLabels(db);
      await writeEvalLabels(db, records);
      const exported = JSON.stringify({ cases, rows: await db.select().from(evalLabel) });

      const row = cases[0] as LabelCase;
      expect(row.text).toContain('[card ••••1111]');
      expect(row.text).toContain('[phone]');
      expect(row.text).toContain('[email]');
      expect(row.sender_domain_sha256).toBe(sha256('example.com'));
      expect(row.mailbox_domain_sha256).toBe(sha256('legacyhotels.co.za'));
      expect(row.labels.find((label) => label.field_id === 'contact.email')?.human_value).toBe(
        '[email]',
      );
      expect(exported).not.toContain('4111111111111111');
      expect(exported).not.toContain('jane.smith@example.com');
      expect(exported).not.toContain('082 555 1234');
      expect(exported).not.toContain('example.com');
      expect(exported).not.toContain('legacyhotels.co.za');
    });
  });

  it('a work item keeps a stored eval_label split; one without a stored label takes its hash split', async () => {
    await withIngestionDb(async ({ db }) => {
      const stored = await seedItem(db, 'thread-stored');
      const fresh = await seedItem(db, 'thread-fresh');
      const edit: Edit = {
        type: 'field.edit',
        fieldPath: `stays[${STAY_A}].requested.departure`,
        aiValue: '2027-10-28',
        value: '2027-10-29',
        at: 1,
      };
      await addEvents(db, stored, [edit]);
      await addEvents(db, fresh, [edit]);
      // The stored item's holdout label was written earlier, so the rule does not move it.
      await db.insert(evalLabel).values({
        workItemId: stored,
        fieldPath: `stays[${STAY_A}].requested.departure`,
        labelKind: 'correction',
        split: 'holdout',
      });

      const { cases, records } = await exportLabels(db);

      expect(cases.find((row) => row.work_item_id === stored)).toMatchObject({
        split: 'holdout',
        split_source: 'stored',
      });
      expect(cases.find((row) => row.work_item_id === fresh)).toMatchObject({
        split: splitFor(fresh),
        split_source: 'hash',
      });
      expect(records.find((row) => row.workItemId === stored)?.split).toBe('holdout');
    });
  });

  it('--write-labels inserts each source event once: a re-run adds no rows', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-idempotent');
      await addEvents(db, item, [
        {
          type: 'field.edit',
          fieldPath: `stays[${STAY_A}].requested.arrival`,
          aiValue: '2027-10-26',
          value: '2027-10-27',
          at: 1,
        },
        { type: 'note.staff', aiValue: null, value: 'Late arrival', at: 2 },
      ]);

      const first = await writeEvalLabels(db, (await exportLabels(db)).records);
      const second = await writeEvalLabels(db, (await exportLabels(db)).records);

      expect(first).toBe(2);
      expect(second).toBe(0);
      const rows = await db.select().from(evalLabel).where(eq(evalLabel.workItemId, item));
      expect(rows.map((row) => row.labelKind).sort()).toEqual(['correction', 'note']);
    });
  });

  it('the time split marks a recently labelled item as test and an old one as dev or holdout', async () => {
    await withIngestionDb(async ({ db }) => {
      const recent = await seedItem(db, 'thread-recent');
      const old = await seedItem(db, 'thread-old');
      const field = `stays[${STAY_A}].requested.arrival`;
      await addEvents(db, recent, [
        { type: 'field.edit', fieldPath: field, aiValue: '2027-10-26', value: '2027-10-27', at: 1 },
      ]);
      // Sixty days before T0: outside the 30-day test window when the export runs five days after T0.
      await addEvents(db, old, [
        {
          type: 'field.edit',
          fieldPath: field,
          aiValue: '2027-10-26',
          value: '2027-10-27',
          at: -60 * 86_400,
        },
      ]);

      const { cases } = await exportLabels(db, {
        timeSplit: true,
        now: new Date(T0 + 5 * 86_400_000),
      });
      const { cases: later } = await exportLabels(db, {
        timeSplit: true,
        now: new Date(T0 + 90 * 86_400_000),
      });

      expect(cases.find((row) => row.work_item_id === recent)).toMatchObject({
        split: 'test',
        split_source: 'time',
      });
      expect(cases.find((row) => row.work_item_id === old)?.split).not.toBe('test');
      expect(later.some((row) => row.split === 'test')).toBe(false);
    });
  });

  it('main refuses bad arguments, writes the dataset to --out, and inserts labels only with --write-labels', async () => {
    expect(await main(['--split', 'train'], { DATABASE_URL: 'postgres://unused' })).toBe(2);
    expect(await main(['--out', join(tmpdir(), 'unused.jsonl')], {})).toBe(2);

    await withIngestionDb(async ({ db, url }) => {
      const item = await seedItem(db, 'thread-cli');
      await addEvents(db, item, [
        {
          type: 'field.edit',
          fieldPath: `stays[${STAY_A}].requested.arrival`,
          aiValue: '2027-10-26',
          value: '2027-10-27',
          at: 1,
        },
      ]);
      const dir = mkdtempSync(join(tmpdir(), 'work-events-export-'));
      const out = join(dir, 'nested', 'out.jsonl');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await main(['--out', out], { DATABASE_URL: url })).toBe(0);
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          cases: 1,
          labels: 1,
          evalLabelInserted: null,
        });
        expect(await db.select().from(evalLabel)).toHaveLength(0);

        expect(await main(['--out', out, '--write-labels'], { DATABASE_URL: url })).toBe(0);
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          evalLabelInserted: 1,
        });
        expect(await main(['--out', out, '--write-labels'], { DATABASE_URL: url })).toBe(0);
        expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
          evalLabelInserted: 0,
        });
        expect(await db.select().from(evalLabel)).toHaveLength(1);

        const lines = readFileSync(out, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as LabelCase);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          schema_version: 'work-event-label/v2',
          kind: 'quote',
          labels: [
            {
              label_kind: 'correction',
              ai_value: '2027-10-26',
              human_value: '2027-10-27',
              ai_source: 'extractor-v3',
            },
          ],
        });
      } finally {
        log.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

function goldenCase(
  id: string,
  split: 'dev' | 'holdout',
  triggerId: string,
  contextIds: string[] = [],
): GoldenRow {
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

describe('golden-set pinning and contact hashes', () => {
  it('keeps a golden holdout thread in holdout and a golden dev thread in dev, and the rest on the hash split', async () => {
    await withIngestionDb(async ({ db }) => {
      const edit: Edit = {
        type: 'field.edit',
        fieldPath: `stays[${STAY_A}].requested.arrival`,
        aiValue: '2027-10-26',
        value: '2027-10-27',
        at: 1,
      };
      const holdout = await seedItem(db, 'thread-holdout');
      const dev = await seedItem(db, 'thread-dev');
      const free = await seedItem(db, 'thread-free');
      for (const item of [holdout, dev, free]) await addEvents(db, item, [edit]);
      const golden = [
        goldenCase('case-holdout', 'holdout', 'msg-thread-holdout'),
        goldenCase('case-dev', 'dev', 'msg-thread-dev'),
      ];

      const { cases, golden: stats, warnings } = await exportLabels(db, { golden });

      expect(stats).toEqual({ matched: 2, total: 2 });
      expect(warnings).toEqual([]);
      expect(cases.find((row) => row.work_item_id === holdout)).toMatchObject({
        split: 'holdout',
        split_source: 'golden',
      });
      expect(cases.find((row) => row.work_item_id === dev)).toMatchObject({
        split: 'dev',
        split_source: 'golden',
      });
      expect(cases.find((row) => row.work_item_id === free)).toMatchObject({
        split: splitFor(free),
        split_source: 'hash',
      });

      const holdoutOnly = await exportLabels(db, { golden, split: 'holdout' });
      expect(holdoutOnly.cases.map((row) => row.work_item_id)).toContain(holdout);
      expect(holdoutOnly.cases.every((row) => row.split === 'holdout')).toBe(true);
    });
  });

  it('a thread with both dev and holdout golden cases is holdout', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-mixed');
      await seedInboxThread(db, {
        threadId: 'thread-mixed',
        transportId: TRANSPORT_ID,
        transportEmail: TRANSPORT_EMAIL,
        messageId: 'msg-mixed-2',
        messageIdHeader: 'mixed-2@example.com',
        fromAddress: 'guest@example.com',
        textBody: 'Please book two rooms.',
      });
      await addEvents(db, item, [
        { type: 'field.edit', fieldPath: `stays[${STAY_A}].rows[${ROW_A}].count`, aiValue: 2, value: 3, at: 1 },
      ]);
      const golden = [
        goldenCase('case-dev', 'dev', 'msg-thread-mixed'),
        goldenCase('case-holdout', 'holdout', 'msg-mixed-2', ['msg-thread-mixed']),
      ];

      const { cases } = await exportLabels(db, { golden });

      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({ split: 'holdout', split_source: 'golden' });
    });
  });

  it('a golden split beats a stored eval_label split, so a holdout thread never lands in dev', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-pinned');
      await addEvents(db, item, [
        {
          type: 'field.edit',
          fieldPath: `stays[${STAY_A}].requested.departure`,
          aiValue: '2027-10-28',
          value: '2027-10-29',
          at: 1,
        },
      ]);
      await db.insert(evalLabel).values({
        workItemId: item,
        fieldPath: `stays[${STAY_A}].requested.departure`,
        labelKind: 'correction',
        split: 'dev',
      });

      const { cases } = await exportLabels(db, {
        golden: [goldenCase('case-pinned', 'holdout', 'msg-thread-pinned')],
      });

      expect(cases[0]).toMatchObject({ split: 'holdout', split_source: 'golden' });
    });
  });

  it('a stored holdout or test split beats a golden split, so a stored holdout or test thread never moves', async () => {
    await withIngestionDb(async ({ db }) => {
      const field = `stays[${STAY_A}].requested.departure`;
      const edit: Edit = {
        type: 'field.edit',
        fieldPath: field,
        aiValue: '2027-10-28',
        value: '2027-10-29',
        at: 1,
      };
      const heldOut = await seedItem(db, 'thread-stored-holdout');
      const tested = await seedItem(db, 'thread-stored-test');
      await addEvents(db, heldOut, [edit]);
      await addEvents(db, tested, [edit]);
      await db.insert(evalLabel).values([
        { workItemId: heldOut, fieldPath: field, labelKind: 'correction', split: 'holdout' },
        { workItemId: tested, fieldPath: field, labelKind: 'correction', split: 'test' },
      ]);

      const { cases } = await exportLabels(db, {
        golden: [
          goldenCase('case-dev', 'dev', 'msg-thread-stored-holdout'),
          goldenCase('case-holdout', 'holdout', 'msg-thread-stored-test'),
        ],
      });

      expect(cases.find((row) => row.work_item_id === heldOut)).toMatchObject({
        split: 'holdout',
        split_source: 'stored',
      });
      expect(cases.find((row) => row.work_item_id === tested)).toMatchObject({
        split: 'test',
        split_source: 'stored',
      });
    });
  });

  it('fails the export when one work item has eval_label rows under two splits, rather than picking one', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-conflict');
      await addEvents(db, item, [
        {
          type: 'field.edit',
          fieldPath: `stays[${STAY_A}].requested.arrival`,
          aiValue: '2027-10-26',
          value: '2027-10-27',
          at: 1,
        },
      ]);
      await db.insert(evalLabel).values([
        {
          workItemId: item,
          fieldPath: `stays[${STAY_A}].requested.arrival`,
          labelKind: 'correction',
          split: 'dev',
        },
        {
          workItemId: item,
          fieldPath: `stays[${STAY_A}].requested.departure`,
          labelKind: 'correction',
          split: 'holdout',
        },
      ]);

      await expect(exportLabels(db)).rejects.toThrow(
        `eval_label rows for work item ${item} disagree on split (dev, holdout)`,
      );
    });
  });

  it('a golden case whose message is not in this database warns, and its thread keeps the hash split', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-elsewhere');
      await addEvents(db, item, [
        {
          type: 'field.edit',
          fieldPath: `stays[${STAY_A}].requested.arrival`,
          aiValue: '2027-10-26',
          value: '2027-10-27',
          at: 1,
        },
      ]);

      const result = await exportLabels(db, {
        golden: [goldenCase('case-elsewhere', 'holdout', 'msg-not-here')],
      });

      expect(result.golden).toEqual({ matched: 0, total: 1 });
      expect(result.warnings).toEqual([expect.stringContaining('1 of 1 golden cases have no message')]);
      expect(result.cases[0]).toMatchObject({ split: splitFor(item), split_source: 'hash' });
    });
  });

  it('records the transport and a salted hash of each address and phone, taken before masking, and no raw value', async () => {
    await withIngestionDb(async ({ db }) => {
      const item = await seedItem(db, 'thread-contact');
      await addEvents(db, item, [
        { type: 'field.edit', fieldPath: 'contact.email', aiValue: 'jane@hotel.co.za', value: 'Jen@Hotel.co.za', at: 1 },
        { type: 'field.edit', fieldPath: 'contact.phone', aiValue: '082 555 1234', value: '+27 82 555 1234', at: 2 },
      ]);

      const { cases } = await exportLabels(db);
      const [row] = cases;
      expect(row!.transport_id).toBe(TRANSPORT_ID);
      const email = row!.labels.find((label) => label.field_id === 'contact.email')!;
      expect(email.human_value).toBe('[email]');
      expect(email.value_hash).toEqual({
        salt: expect.any(String),
        ai: expect.any(String),
        human: expect.any(String),
      });
      expect(email.value_hash!.ai).not.toBe(email.value_hash!.human);
      const phone = row!.labels.find((label) => label.field_id === 'contact.phone')!;
      expect(phone.value_hash!.salt).not.toBe(email.value_hash!.salt);
      expect(JSON.stringify(cases)).not.toMatch(/jane@hotel|jen@hotel|555 1234/i);
      expect(parseLabelCases(cases.map((c) => JSON.stringify(c)).join('\n'))).toHaveLength(1);
    });
  });

  it('re-exporting unchanged labels writes the same file, and each label gets its own salt', async () => {
    await withIngestionDb(async ({ db, url }) => {
      const item = await seedItem(db, 'thread-stable-salt');
      await addEvents(db, item, [
        {
          type: 'field.edit',
          fieldPath: 'contact.email',
          aiValue: 'jane@hotel.co.za',
          value: 'Jen@Hotel.co.za',
          at: 1,
        },
        {
          type: 'field.edit',
          fieldPath: 'contact.phone',
          aiValue: '082 555 1234',
          value: '+27 82 555 1234',
          at: 2,
        },
      ]);
      const dir = mkdtempSync(join(tmpdir(), 'work-events-stable-'));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await main(['--out', join(dir, 'first.jsonl')], { DATABASE_URL: url })).toBe(0);
        expect(await main(['--out', join(dir, 'second.jsonl')], { DATABASE_URL: url })).toBe(0);
        const first = readFileSync(join(dir, 'first.jsonl'), 'utf8');
        expect(readFileSync(join(dir, 'second.jsonl'), 'utf8')).toBe(first);

        const [row] = parseLabelCases(first);
        const salts = row!.labels.map((label) => label.value_hash!.salt);
        expect(salts).toHaveLength(2);
        expect(new Set(salts).size).toBe(2);
      } finally {
        log.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('main reads --golden-set and reports a golden case whose message is not in the database', async () => {
    await withIngestionDb(async ({ url }) => {
      const dir = mkdtempSync(join(tmpdir(), 'work-events-golden-'));
      const golden = join(dir, 'golden.jsonl');
      writeFileSync(golden, `${JSON.stringify(goldenCase('case-elsewhere', 'holdout', 'msg-not-here'))}\n`);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await main(['--out', join(dir, 'out.jsonl'), '--golden-set', golden], { DATABASE_URL: url })).toBe(0);
        const summary = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { golden: unknown; warnings: string[] };
        expect(summary.golden).toEqual({ matched: 0, total: 1 });
        expect(summary.warnings).toEqual([expect.stringContaining('1 of 1 golden cases have no message')]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('warning: 1 of 1 golden cases'));
      } finally {
        log.mockRestore();
        warn.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
