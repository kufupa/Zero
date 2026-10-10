/**
 * Work-event eval export (R17, U27). Candidate labels from human field edits and rate choices on Nava pane work items.
 *
 *   export-work-events-dataset.ts [--out FILE] [--split dev|holdout] [--golden-set FILE]
 *
 * One row per (work item, stable extraction field id) that a person edited (field.edit or field.reject). Only extraction
 * paths (stays[...] and contact.*) count: follow-up draft decisions reuse one path across different drafts, and rate.*
 * events are not labels, since a later quote that keeps the HMS price writes no event and the last custom price would
 * read as final. ai_value is the first event's AI value. human_value is the value saved in
 * work_item.state, which follows the row-locked update order; event time is the transaction start, so two concurrent
 * edits can log out of order. Both values are card-masked. Pairing is by field_id. The ids carry the extraction's stable stay and
 * row ids, so deleting a stay never shifts another stay's pair. A removed stay or row still exports its own `removed`
 * pair (false to true). Fields only accepted, and fields with no event, are not exported.
 *
 * Split: a thread that holds a golden-set case takes that case's split (holdout wins when its cases disagree). Any other
 * thread is holdout when sha256(thread id) mod 3 is 0, else dev, about one in three like the golden set's 40 of 120.
 * split_source says which rule applied. The golden set is read from .private/reservationist-backtest/golden-set.jsonl when
 * that file exists. --golden-set names another file, and then it must exist. A missing default file, or golden cases whose
 * messages are not in this database, add a warning to the summary: those holdout threads fall back to the hash split.
 *
 * Read-only: every query runs in one REPEATABLE READ READ ONLY transaction on DATABASE_URL. The only write is the JSONL
 * file, under apps/server-pilot/.private/ by default (gitignored, no auto-delete).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { maskCardNumbers } from '../src/ai/card-mask.js';
import { readGoldenSet, type GoldenRow } from '../src/ai/reservationist-backtest.js';
import { contactFieldOf, parseFieldPath } from '../src/ai/work-items.js';
import { createDb, type DB } from '../src/db/client.js';
import { message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';

export const EVAL_SCHEMA_VERSION = 'work-event-eval/v1';
export type Split = GoldenRow['split'];
export type SplitSource = 'golden' | 'hash';

export type EvalRow = {
  schema_version: typeof EVAL_SCHEMA_VERSION;
  work_item_id: string;
  field_id: string;
  ai_value: unknown;
  human_value: unknown;
  event_ids: string[];
  label_status: 'candidate';
  split: Split;
  split_source: SplitSource;
};

export type FieldEvent = {
  id: string;
  workItemId: string;
  threadId: string | null;
  type: string;
  fieldPath: string;
  aiValue: unknown;
  value: unknown;
};

const PRIVATE_ROOT = fileURLToPath(new URL('../.private/', import.meta.url));
const DEFAULT_OUT = join(PRIVATE_ROOT, 'work-events-eval', 'work-events-v1.jsonl');
const DEFAULT_GOLDEN_SET = join(PRIVATE_ROOT, 'reservationist-backtest', 'golden-set.jsonl');
const HOLDOUT_MODULUS = 3;
const EDIT_TYPES: ReadonlySet<string> = new Set(['field.edit', 'field.reject']);
const SEQUENCE_TYPES = ['field.edit', 'field.accept', 'field.reject'] as const;
/** An extraction field the pane edits, as recordFieldEvent accepts it. */
const isExtractionField = (path: string) => contactFieldOf(path) !== null || parseFieldPath(path) !== null;
const USAGE = 'usage: export-work-events-dataset.ts [--out FILE] [--split dev|holdout] [--golden-set FILE]';

/** Deterministic split for a thread with no golden case. */
export function hashSplit(threadKey: string): Split {
  const bucket = createHash('sha256').update(threadKey).digest().readUInt32BE(0);
  return bucket % HOLDOUT_MODULUS === 0 ? 'holdout' : 'dev';
}

/** Card-masks every string inside a value, so no card number leaves the export unmasked. */
export function maskValue(value: unknown): unknown {
  if (typeof value === 'string') return maskCardNumbers(value);
  if (Array.isArray(value)) return value.map(maskValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskValue(inner)]));
  }
  return value;
}

/** Thread id to split for the golden cases. `threadOf` maps a message id to its thread, from the database. */
export function goldenThreadSplits(
  golden: readonly GoldenRow[],
  threadOf: ReadonlyMap<string, string | null>,
): { splits: Map<string, Split>; matched: number } {
  const splits = new Map<string, Split>();
  let matched = 0;
  for (const row of golden) {
    const threads = [row.trigger.id, ...row.context.map((item) => item.id)].flatMap((id) => {
      const thread = threadOf.get(id);
      return thread ? [thread] : [];
    });
    if (threads.length) matched += 1;
    for (const thread of threads) {
      const prior = splits.get(thread);
      splits.set(thread, prior !== undefined && prior !== row.split ? 'holdout' : row.split);
    }
  }
  return { splits, matched };
}

/**
 * One pair per edited field id on each work item: the first event's AI value, the final value and every event id for
 * that field. Input must be ordered by work item, time and id. The final value is the field's key in the item's saved
 * state when it has one, else the last event's value. A field without a person's edit is dropped.
 */
export function pairEditedFields(
  events: readonly FieldEvent[],
  stateOf: ReadonlyMap<string, Record<string, unknown>> = new Map(),
) {
  const byField = new Map<string, FieldEvent[]>();
  for (const event of events) {
    const key = `${event.workItemId}\u0000${event.fieldPath}`;
    const group = byField.get(key);
    if (group) group.push(event);
    else byField.set(key, [event]);
  }
  return [...byField.values()].flatMap((group) => {
    if (!group.some((event) => EDIT_TYPES.has(event.type))) return [];
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const state = stateOf.get(first.workItemId);
    return [
      {
        workItemId: first.workItemId,
        threadId: first.threadId,
        fieldId: first.fieldPath,
        aiValue: first.aiValue,
        humanValue: state && Object.hasOwn(state, first.fieldPath) ? state[first.fieldPath] : last.value,
        eventIds: group.map((event) => event.id),
      },
    ];
  });
}

export async function exportWorkEvents(
  db: DB,
  options: { golden?: readonly GoldenRow[]; split?: Split } = {},
): Promise<{ rows: EvalRow[]; golden: { matched: number; total: number }; warnings: string[] }> {
  return db.transaction(
    async (tx) => {
      const events = await tx
        .select({
          id: workEvent.id,
          workItemId: workEvent.workItemId,
          threadId: workItem.threadId,
          type: workEvent.type,
          fieldPath: workEvent.fieldPath,
          aiValue: workEvent.aiValue,
          value: workEvent.value,
        })
        .from(workEvent)
        .innerJoin(workItem, eq(workItem.id, workEvent.workItemId))
        .where(and(inArray(workEvent.type, [...SEQUENCE_TYPES]), isNotNull(workEvent.fieldPath)))
        .orderBy(asc(workEvent.workItemId), asc(workEvent.at), asc(workEvent.id));

      const golden = options.golden ?? [];
      const messageIds = [
        ...new Set(golden.flatMap((row) => [row.trigger.id, ...row.context.map((item) => item.id)])),
      ];
      const threadOf = new Map<string, string | null>();
      if (messageIds.length) {
        const found = await tx
          .select({ id: message.id, threadId: message.threadId })
          .from(message)
          .where(inArray(message.id, messageIds));
        for (const row of found) threadOf.set(row.id, row.threadId);
      }
      const { splits: goldenSplits, matched } = goldenThreadSplits(golden, threadOf);
      const warnings =
        matched < golden.length
          ? [
              `${golden.length - matched} of ${golden.length} golden cases have no message in this database: their threads take the hash split`,
            ]
          : [];

      // The SQL filter already drops null field paths; the check narrows the type and keeps extraction fields only.
      const fieldEvents: FieldEvent[] = [];
      for (const event of events) {
        if (event.fieldPath !== null && isExtractionField(event.fieldPath)) fieldEvents.push({ ...event, fieldPath: event.fieldPath });
      }
      const itemIds = [...new Set(fieldEvents.map((event) => event.workItemId))];
      const stateOf = new Map<string, Record<string, unknown>>();
      if (itemIds.length) {
        const items = await tx
          .select({ id: workItem.id, state: workItem.state })
          .from(workItem)
          .where(inArray(workItem.id, itemIds));
        for (const item of items) stateOf.set(item.id, item.state);
      }
      const rows: EvalRow[] = [];
      for (const pair of pairEditedFields(fieldEvents, stateOf)) {
        const fromGolden = pair.threadId ? goldenSplits.get(pair.threadId) : undefined;
        const split = fromGolden ?? hashSplit(pair.threadId ?? pair.workItemId);
        if (options.split && split !== options.split) continue;
        rows.push({
          schema_version: EVAL_SCHEMA_VERSION,
          work_item_id: pair.workItemId,
          field_id: pair.fieldId,
          ai_value: maskValue(pair.aiValue),
          human_value: maskValue(pair.humanValue),
          event_ids: pair.eventIds,
          label_status: 'candidate',
          split,
          split_source: fromGolden ? 'golden' : 'hash',
        });
      }
      return { rows, golden: { matched, total: golden.length }, warnings };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, split: { type: 'string' }, 'golden-set': { type: 'string' } },
  });
  if (positionals.length || (values.split !== undefined && values.split !== 'dev' && values.split !== 'holdout')) {
    console.error(USAGE);
    return 2;
  }
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is not set. The export reads work_item and work_event from it.');
    return 2;
  }
  const goldenPath = values['golden-set'] ?? DEFAULT_GOLDEN_SET;
  const useGolden = values['golden-set'] !== undefined || existsSync(goldenPath);
  const golden = useGolden ? readGoldenSet(goldenPath) : [];

  const { db, conn } = createDb(url);
  let result: Awaited<ReturnType<typeof exportWorkEvents>>;
  try {
    result = await exportWorkEvents(db, { golden, split: values.split as Split | undefined });
  } finally {
    await conn.end();
  }
  const warnings = [
    ...(useGolden ? [] : [`no golden set at ${goldenPath}: every thread takes its hash split, golden holdout included`]),
    ...result.warnings,
  ];
  for (const warning of warnings) console.error(`warning: ${warning}`);
  const out = resolve(values.out ?? DEFAULT_OUT);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, result.rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  const bySplit = { dev: 0, holdout: 0 };
  for (const row of result.rows) bySplit[row.split] += 1;
  console.log(JSON.stringify({ out, rows: result.rows.length, bySplit, golden: result.golden, warnings }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`export failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
