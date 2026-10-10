/**
 * Work-event eval export (R17, U27). Candidate labels from human field edits on Nava pane work items.
 *
 *   export-work-events-dataset.ts [--out FILE] [--split dev|holdout] [--golden-set FILE]
 *
 * One row per (work item, stable field id) that a person edited (field.edit or field.reject). ai_value is the first
 * event's AI value and human_value the last event's value, both card-masked. Pairing is by field_id. The ids carry the
 * extraction's stable stay and row ids, so deleting a stay never shifts another stay's pair. A removed stay or row still
 * exports its own `removed` pair (false to true). Fields only accepted, and fields with no event, are not exported.
 * rate.* events are not exported: their AI side is the HMS quote rate, not an extraction value.
 *
 * Split: a thread that holds a golden-set case takes that case's split (holdout wins when its cases disagree). Any other
 * thread is holdout when sha256(thread id) mod 3 is 0, else dev, about one in three like the golden set's 40 of 120.
 * split_source says which rule applied. The golden set is read from .private/reservationist-backtest/golden-set.jsonl when
 * that file exists. --golden-set names another file, and then it must exist.
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
 * One pair per edited field id on each work item: the first event's AI value, the last event's value and every event
 * id for that field. Input must be ordered by work item, time and id. A field without a person's edit is dropped.
 */
export function pairEditedFields(events: readonly FieldEvent[]) {
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
    return [
      {
        workItemId: first.workItemId,
        threadId: first.threadId,
        fieldId: first.fieldPath,
        aiValue: first.aiValue,
        humanValue: last.value,
        eventIds: group.map((event) => event.id),
      },
    ];
  });
}

export async function exportWorkEvents(
  db: DB,
  options: { golden?: readonly GoldenRow[]; split?: Split } = {},
): Promise<{ rows: EvalRow[]; golden: { matched: number; total: number } }> {
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

      // The SQL filter already drops null field paths; the check narrows the type for the pairing.
      const fieldEvents: FieldEvent[] = [];
      for (const event of events) {
        if (event.fieldPath !== null) fieldEvents.push({ ...event, fieldPath: event.fieldPath });
      }
      const rows: EvalRow[] = [];
      for (const pair of pairEditedFields(fieldEvents)) {
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
      return { rows, golden: { matched, total: golden.length } };
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
  if (!useGolden) console.error(`no golden set at ${goldenPath}: every thread takes its hash split`);
  const golden = useGolden ? readGoldenSet(goldenPath) : [];

  const { db, conn } = createDb(url);
  let result: Awaited<ReturnType<typeof exportWorkEvents>>;
  try {
    result = await exportWorkEvents(db, { golden, split: values.split as Split | undefined });
  } finally {
    await conn.end();
  }
  const out = resolve(values.out ?? DEFAULT_OUT);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, result.rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  const bySplit = { dev: 0, holdout: 0 };
  for (const row of result.rows) bySplit[row.split] += 1;
  console.log(JSON.stringify({ out, rows: result.rows.length, bySplit, golden: result.golden }));
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
