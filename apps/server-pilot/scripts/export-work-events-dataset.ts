/**
 * Work-event label export (v5 B3). Derives eval labels from the append-only work_event log:
 *   field.edit, field.reject  -> correction    (ai_value -> the value the person kept)
 *   field.accept              -> confirmation  (the AI value, kept as it was)
 *   review.flag               -> run_flag      (a reviewer flagged the run; the note stays in human_value)
 *   note.staff                -> note          (the "Tell Nava" text)
 * Field events count only for extraction fields (stays[...] and contact.*). Follow-up draft decisions reuse one path for
 * different drafts, and rate.* events are not labels.
 *
 *   export-work-events-dataset.ts [--out FILE] [--split dev|holdout|test] [--time-split] [--write-labels]
 *
 * The dataset JSONL has one row per labelled work item: its masked source mail, the staff-accepted kind and its labels.
 * The default run is read-only. --write-labels also inserts the eval_label rows (one per source event, ON CONFLICT DO
 * NOTHING on source_event_id, so a re-run adds nothing). Every value and mail text is masked: card numbers, security
 * codes, e-mail addresses and phone numbers.
 *
 * Split, per work item: sha256(work item id) bucket 0-59 dev, 60-79 holdout, 80-99 test. A work item keeps the split its
 * eval_label rows already carry, so a holdout item never moves. --time-split: an item whose latest label event is within
 * 30 days is test; older items split dev/holdout 3:1 by the same hash.
 *
 * Writes only the JSONL file (apps/server-pilot/.private/ by default, gitignored) and, with --write-labels, eval_label.
 */
import {
  EVAL_LABEL_KINDS,
  EVAL_LABEL_SPLITS,
  evalLabel,
  mailExtraction,
  workEvent,
  workItem,
} from '../src/db/schema/work.js';
import { EVAL_SCHEMA_VERSION, type LabelCase, type Split } from '../src/ai/label-scorers.js';
import { maskMailText, maskMailValue as maskValue } from '../src/ai/card-mask.js';
import { contactFieldOf, parseFieldPath } from '../src/ai/work-items.js';
import { mailboxTransport, message } from '../src/db/schema/mail.js';
import { createDb, type DB } from '../src/db/client.js';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { asc, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export type LabelKind = (typeof EVAL_LABEL_KINDS)[number];
export type SplitSource = 'stored' | 'hash' | 'time';

export type LabelEvent = {
  id: string;
  workItemId: string;
  type: string;
  fieldPath: string | null;
  aiValue: unknown;
  value: unknown;
  aiSource: string | null;
  at: Date;
};

/** One label: what the AI said (aiValue) and what the person kept (humanValue), from one work event. */
export type Label = {
  sourceEventId: string;
  workItemId: string;
  labelKind: LabelKind;
  fieldPath: string;
  aiValue: unknown;
  humanValue: unknown;
  aiSource: string | null;
  at: Date;
};

/** An eval_label row, values masked. */
export type LabelRecord = {
  workItemId: string;
  messageId: string | null;
  fieldPath: string;
  aiValue: unknown;
  humanValue: unknown;
  labelKind: LabelKind;
  sourceEventId: string;
  extractorVersion: string | null;
  split: Split;
};

const PRIVATE_ROOT = fileURLToPath(new URL('../.private/', import.meta.url));
const DEFAULT_OUT = join(PRIVATE_ROOT, 'work-events-eval', 'work-events-v2.jsonl');
const LABEL_EVENT_TYPES = [
  'field.edit',
  'field.accept',
  'field.reject',
  'review.flag',
  'note.staff',
] as const;
const CORRECTION_TYPES: ReadonlySet<string> = new Set(['field.edit', 'field.reject']);
const DAY_MS = 86_400_000;
const TIME_TEST_DAYS = 30;
const USAGE =
  'usage: export-work-events-dataset.ts [--out FILE] [--split dev|holdout|test] [--time-split] [--write-labels]';

/** An extraction field the pane edits, as recordFieldEvent accepts it. */
const isExtractionField = (path: string) =>
  contactFieldOf(path) !== null || parseFieldPath(path) !== null;

/** The label one work event carries, or null when it carries none. */
export function labelOf(event: LabelEvent): Label | null {
  const base = {
    sourceEventId: event.id,
    workItemId: event.workItemId,
    aiSource: event.aiSource,
    at: event.at,
  };
  if (CORRECTION_TYPES.has(event.type) || event.type === 'field.accept') {
    if (!event.fieldPath || !isExtractionField(event.fieldPath)) return null;
    const labelKind = event.type === 'field.accept' ? 'confirmation' : 'correction';
    return {
      ...base,
      labelKind,
      fieldPath: event.fieldPath,
      aiValue: event.aiValue,
      humanValue: event.value,
    };
  }
  if (event.type === 'review.flag') {
    return {
      ...base,
      labelKind: 'run_flag',
      fieldPath: event.fieldPath ?? 'review.flag',
      aiValue: null,
      humanValue: event.value,
    };
  }
  if (event.type === 'note.staff') {
    return {
      ...base,
      labelKind: 'note',
      fieldPath: event.fieldPath ?? 'note.staff',
      aiValue: null,
      humanValue: event.value,
    };
  }
  return null;
}

/** An address with its local part masked. The domain stays, since the extraction reads staff by domain. */
export const maskAddress = (address: string | null): string | null =>
  address === null ? null : maskMailText(address.replace(/^[^@\s]*@/, '[email]@'));

/** Stable bucket 0-99 for a work item. */
export function splitBucket(workItemId: string): number {
  return createHash('sha256').update(workItemId).digest().readUInt32BE(0) % 100;
}

/** The split a work item gets from its id, with --time-split's 30-day test window when set. */
export function splitFor(
  workItemId: string,
  options: { timeSplit?: boolean; latestAt?: Date; now?: Date } = {},
): Split {
  const bucket = splitBucket(workItemId);
  if (options.timeSplit) {
    const now = options.now ?? new Date();
    if (options.latestAt && now.getTime() - options.latestAt.getTime() <= TIME_TEST_DAYS * DAY_MS)
      return 'test';
    return bucket % 4 === 0 ? 'holdout' : 'dev';
  }
  if (bucket < 60) return 'dev';
  return bucket < 80 ? 'holdout' : 'test';
}

/**
 * Labels for every labelled work item, and the dataset cases. A work item's split is its stored eval_label split when it
 * has one, else splitFor. `split` filters the cases only; the labels are always complete, so --write-labels never
 * depends on the filter.
 */
export async function exportLabels(
  db: DB,
  options: { split?: Split; timeSplit?: boolean; now?: Date } = {},
): Promise<{ cases: LabelCase[]; records: LabelRecord[] }> {
  return db.transaction(
    async (tx) => {
      const events = await tx
        .select({
          id: workEvent.id,
          workItemId: workEvent.workItemId,
          type: workEvent.type,
          fieldPath: workEvent.fieldPath,
          aiValue: workEvent.aiValue,
          value: workEvent.value,
          aiSource: workEvent.aiSource,
          at: workEvent.at,
        })
        .from(workEvent)
        .where(inArray(workEvent.type, [...LABEL_EVENT_TYPES]))
        .orderBy(asc(workEvent.workItemId), asc(workEvent.at), asc(workEvent.id));
      const labels = events.flatMap((event) => {
        const label = labelOf(event);
        return label ? [label] : [];
      });
      const itemIds = [...new Set(labels.map((label) => label.workItemId))];
      if (!itemIds.length) return { cases: [], records: [] };

      const items = await tx
        .select({
          id: workItem.id,
          kind: workItem.kind,
          transportId: workItem.transportId,
          sourceMessageId: workItem.sourceMessageId,
          extractionId: workItem.extractionId,
        })
        .from(workItem)
        .where(inArray(workItem.id, itemIds));
      const transportIds = [...new Set(items.map((item) => item.transportId))];
      const messageIds = [
        ...new Set(items.flatMap((item) => (item.sourceMessageId ? [item.sourceMessageId] : []))),
      ];
      const extractionIds = [
        ...new Set(items.flatMap((item) => (item.extractionId ? [item.extractionId] : []))),
      ];
      const [transports, mails, extractions, stored] = await Promise.all([
        tx
          .select({ id: mailboxTransport.id, email: mailboxTransport.email })
          .from(mailboxTransport)
          .where(inArray(mailboxTransport.id, transportIds)),
        messageIds.length
          ? tx
              .select({
                id: message.id,
                fromAddress: message.fromAddress,
                subject: message.subject,
                textBody: message.textBody,
              })
              .from(message)
              .where(inArray(message.id, messageIds))
          : [],
        extractionIds.length
          ? tx
              .select({ id: mailExtraction.id, version: mailExtraction.extractorVersion })
              .from(mailExtraction)
              .where(inArray(mailExtraction.id, extractionIds))
          : [],
        tx
          .select({ workItemId: evalLabel.workItemId, split: evalLabel.split })
          .from(evalLabel)
          .where(inArray(evalLabel.workItemId, itemIds)),
      ]);
      const mailboxOf = new Map(transports.map((row) => [row.id, row.email]));
      const mailOf = new Map(mails.map((row) => [row.id, row]));
      const versionOf = new Map(extractions.map((row) => [row.id, row.version]));
      const storedSplit = new Map(stored.map((row) => [row.workItemId, row.split as Split]));
      const latestAt = new Map<string, Date>();
      for (const label of labels) {
        const prior = latestAt.get(label.workItemId);
        if (!prior || label.at > prior) latestAt.set(label.workItemId, label.at);
      }

      const labelsOf = new Map<string, Label[]>();
      for (const label of labels)
        labelsOf.set(label.workItemId, [...(labelsOf.get(label.workItemId) ?? []), label]);
      const cases: LabelCase[] = [];
      const records: LabelRecord[] = [];
      for (const item of items) {
        const itemLabels = labelsOf.get(item.id) ?? [];
        const mail = item.sourceMessageId ? mailOf.get(item.sourceMessageId) : undefined;
        const extractionVersion = item.extractionId
          ? (versionOf.get(item.extractionId) ?? null)
          : null;
        const stored = storedSplit.get(item.id);
        const split =
          stored ??
          splitFor(item.id, {
            timeSplit: options.timeSplit,
            latestAt: latestAt.get(item.id),
            now: options.now,
          });
        const splitSource: SplitSource = stored ? 'stored' : options.timeSplit ? 'time' : 'hash';
        for (const label of itemLabels) {
          records.push({
            workItemId: item.id,
            messageId: item.sourceMessageId,
            fieldPath: label.fieldPath,
            aiValue: maskValue(label.aiValue),
            humanValue: maskValue(label.humanValue),
            labelKind: label.labelKind,
            sourceEventId: label.sourceEventId,
            extractorVersion: label.aiSource ?? extractionVersion,
            split,
          });
        }
        if (options.split && split !== options.split) continue;
        cases.push({
          schema_version: EVAL_SCHEMA_VERSION,
          work_item_id: item.id,
          message_id: item.sourceMessageId,
          kind: item.kind,
          extractor_version: extractionVersion,
          mailbox: maskAddress(mailboxOf.get(item.transportId) ?? null),
          from: maskAddress(mail?.fromAddress ?? null),
          subject: maskMailText(mail?.subject ?? ''),
          text: maskMailText(mail?.textBody ?? ''),
          split,
          split_source: splitSource,
          labels: itemLabels.map((label) => ({
            event_id: label.sourceEventId,
            field_id: label.fieldPath,
            label_kind: label.labelKind,
            ai_source: label.aiSource,
            ai_value: maskValue(label.aiValue),
            human_value: maskValue(label.humanValue),
          })),
        });
      }
      return { cases, records };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Inserts eval_label rows. A source event already labelled is skipped, so a re-run returns 0 for the same events. */
export async function writeEvalLabels(db: DB, records: readonly LabelRecord[]): Promise<number> {
  if (!records.length) return 0;
  const inserted = await db
    .insert(evalLabel)
    .values(
      records.map((record) => ({
        workItemId: record.workItemId,
        messageId: record.messageId,
        fieldPath: record.fieldPath,
        aiValue: record.aiValue,
        humanValue: record.humanValue,
        labelKind: record.labelKind,
        sourceEventId: record.sourceEventId,
        extractorVersion: record.extractorVersion,
        modelRoute: null,
        split: record.split,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: evalLabel.id });
  return inserted.length;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      split: { type: 'string' },
      'time-split': { type: 'boolean' },
      'write-labels': { type: 'boolean' },
    },
  });
  if (
    positionals.length ||
    (values.split !== undefined && !(EVAL_LABEL_SPLITS as readonly string[]).includes(values.split))
  ) {
    console.error(USAGE);
    return 2;
  }
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is not set. The export reads work_item and work_event from it.');
    return 2;
  }

  const { db, conn } = createDb(url);
  let result: Awaited<ReturnType<typeof exportLabels>>;
  let inserted: number | null = null;
  try {
    result = await exportLabels(db, {
      split: values.split as Split | undefined,
      timeSplit: values['time-split'] === true,
    });
    if (values['write-labels']) inserted = await writeEvalLabels(db, result.records);
  } finally {
    await conn.end();
  }

  const out = resolve(values.out ?? DEFAULT_OUT);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, result.cases.map((row) => `${JSON.stringify(row)}\n`).join(''), {
    mode: 0o600,
  });
  const bySplit: Record<Split, number> = { dev: 0, holdout: 0, test: 0 };
  for (const row of result.cases) bySplit[row.split] += 1;
  const labelsBySplit: Record<Split, number> = { dev: 0, holdout: 0, test: 0 };
  for (const row of result.records) labelsBySplit[row.split] += 1;
  console.log(
    JSON.stringify({
      out,
      cases: result.cases.length,
      bySplit,
      labels: result.records.length,
      labelsBySplit,
      evalLabelInserted: inserted,
    }),
  );
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
