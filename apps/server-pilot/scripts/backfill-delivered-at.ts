/**
 * Backfill the trusted top-most Received stamp for POP3 messages tied to open work items.
 *
 * Dry-run is the default. --apply is required to merge deliveredAt into sourceProvenance; each changed
 * message and its append-only work_event audit row commit in one transaction. Re-running is idempotent.
 * Output contains message/work-item ids and counts only.
 *
 * Run from apps/server-pilot:
 *   pnpm exec tsx scripts/backfill-delivered-at.ts [--dry-run | --apply]
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseTopReceivedDate } from '../src/mail/ingest/parse-message.js';
import { closeDb, getDb, type DB } from '../src/db/client.js';
import { message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { OUTLOOK_SYNCED } from '../src/ai/work-items.js';
import { getS3Storage, rawMimeKey, RealS3Storage, type S3Storage } from '../src/storage/s3.js';

export const RAW_MIME_PREFIX_BYTES = 256 * 1024;
const OPEN_STATUSES = ['needs_you', 'review'] as const;
const AUDIT_EVENT_TYPE = 'source.delivered_at.backfilled' as const;
const USAGE = 'usage: pnpm exec tsx scripts/backfill-delivered-at.ts [--dry-run | --apply]';

export type DeliveredAtBackfillArgs = { apply: boolean; help: boolean };

/** Throws on unknown flags or conflicting run modes. */
export function parseDeliveredAtArgs(argv: readonly string[]): DeliveredAtBackfillArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      apply: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.apply && values['dry-run']) throw new Error('conflicting run modes');
  return { apply: values.apply === true, help: values.help === true };
}

export type RawMimePrefixReader = (key: string) => Promise<Buffer | null>;

/** Read only the initial raw MIME range needed for headers. No S3 write is issued. */
export async function readRawMimePrefixFromS3(storage: S3Storage, key: string): Promise<Buffer | null> {
  if (!(storage instanceof RealS3Storage)) {
    const result = await storage.getObjectBounded(key, RAW_MIME_PREFIX_BYTES);
    return result?.body ?? null;
  }

  try {
    const response = await storage.client.send(
      new GetObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Range: `bytes=0-${RAW_MIME_PREFIX_BYTES - 1}`,
      }),
    );
    if (!response.Body) return null;
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    if (isS3NotFound(error)) return null;
    throw error;
  }
}

export type DeliveredAtBackfillCounts = {
  apply: boolean;
  /** Unique POP3 messages tied to an open, non-spam work item and not already stamped. */
  candidates: number;
  /** Candidates whose top Received date parsed successfully. */
  planned: number;
  /** Changes committed with --apply. */
  stamped: number;
  skippedMissingRawMime: number;
  skippedMissingReceived: number;
  messageIds: string[];
};

type DeliveredAtCandidate = {
  workItemId: string;
  messageId: string;
  rawMimeS3Key: string | null;
  ingestMailboxId: string | null;
  pop3Uidl: string | null;
};

/** Open Needs You/review work items with a POP3 source row that has no deliveredAt key. */
export async function selectDeliveredAtBackfillCandidates(db: DB): Promise<DeliveredAtCandidate[]> {
  return db
    .selectDistinct({
      workItemId: workItem.id,
      messageId: message.id,
      rawMimeS3Key: message.rawMimeS3Key,
      ingestMailboxId: message.ingestMailboxId,
      pop3Uidl: message.pop3Uidl,
    })
    .from(message)
    .innerJoin(workItem, eq(workItem.sourceMessageId, message.id))
    .where(
      and(
        eq(message.direction, 'inbound'),
        isNotNull(message.pop3Uidl),
        inArray(workItem.status, [...OPEN_STATUSES]),
        ne(workItem.kind, 'spam'),
        sql`${OUTLOOK_SYNCED} is not true`,
        sql`(
          ${message.sourceProvenance} is null or (
            jsonb_typeof(${message.sourceProvenance}) = 'object'
            and not (${message.sourceProvenance} ? 'deliveredAt')
          )
        )`,
      ),
    );
}

/** Plans or applies one idempotent provenance stamp per eligible source message. */
export async function runDeliveredAtBackfill(input: {
  db?: DB;
  apply: boolean;
  readRawMimePrefix: RawMimePrefixReader;
}): Promise<DeliveredAtBackfillCounts> {
  const db = input.db ?? getDb();
  const selected = await selectDeliveredAtBackfillCandidates(db);
  const groups = groupByMessage(selected);
  const counts: DeliveredAtBackfillCounts = {
    apply: input.apply,
    candidates: groups.size,
    planned: 0,
    stamped: 0,
    skippedMissingRawMime: 0,
    skippedMissingReceived: 0,
    messageIds: [],
  };

  for (const [messageId, candidates] of groups) {
    const candidate = candidates[0]!;
    const key = rawMimeS3Key(candidate);
    if (!key) {
      counts.skippedMissingRawMime += 1;
      continue;
    }
    const prefix = await input.readRawMimePrefix(key);
    if (!prefix) {
      counts.skippedMissingRawMime += 1;
      continue;
    }
    const deliveredAt = parseTopReceivedDate(prefix);
    if (!deliveredAt) {
      counts.skippedMissingReceived += 1;
      continue;
    }

    counts.planned += 1;
    if (!input.apply) {
      counts.messageIds.push(messageId);
      continue;
    }

    for (const eligible of candidates) {
      if (await stampDeliveredAt(db, eligible, deliveredAt)) {
        counts.stamped += 1;
        counts.messageIds.push(messageId);
        break;
      }
    }
  }

  counts.messageIds.sort();
  return counts;
}

function groupByMessage(candidates: DeliveredAtCandidate[]): Map<string, DeliveredAtCandidate[]> {
  const sorted = [...candidates].sort(
    (a, b) => a.messageId.localeCompare(b.messageId) || a.workItemId.localeCompare(b.workItemId),
  );
  const groups = new Map<string, DeliveredAtCandidate[]>();
  for (const candidate of sorted) {
    const group = groups.get(candidate.messageId) ?? [];
    group.push(candidate);
    groups.set(candidate.messageId, group);
  }
  return groups;
}

function rawMimeS3Key(candidate: DeliveredAtCandidate): string | null {
  const directKey = candidate.rawMimeS3Key?.trim();
  if (directKey) return directKey;
  if (!candidate.ingestMailboxId || !candidate.pop3Uidl) return null;
  return rawMimeKey({ ingestMailboxId: candidate.ingestMailboxId, pop3Uidl: candidate.pop3Uidl });
}

async function stampDeliveredAt(
  db: DB,
  candidate: DeliveredAtCandidate,
  deliveredAt: Date,
): Promise<boolean> {
  if (!candidate.pop3Uidl) return false;
  return db.transaction(async (tx) => {
    const [openItem] = await tx
      .select({ id: workItem.id })
      .from(workItem)
      .where(
        and(
          eq(workItem.id, candidate.workItemId),
          eq(workItem.sourceMessageId, candidate.messageId),
          inArray(workItem.status, [...OPEN_STATUSES]),
          ne(workItem.kind, 'spam'),
        ),
      )
      .for('update')
      .limit(1);
    if (!openItem) return false;

    const iso = deliveredAt.toISOString();
    const [updated] = await tx
      .update(message)
      .set({
        sourceProvenance: sql`coalesce(${message.sourceProvenance}, '{}'::jsonb) || jsonb_build_object('deliveredAt', ${iso}::text)`,
      })
      .where(
        and(
          eq(message.id, candidate.messageId),
          eq(message.direction, 'inbound'),
          eq(message.pop3Uidl, candidate.pop3Uidl),
          sql`${OUTLOOK_SYNCED} is not true`,
          sql`(
            ${message.sourceProvenance} is null or (
              jsonb_typeof(${message.sourceProvenance}) = 'object'
              and not (${message.sourceProvenance} ? 'deliveredAt')
            )
          )`,
        ),
      )
      .returning({ id: message.id });
    if (!updated) return false;

    await tx.insert(workEvent).values({
      workItemId: openItem.id,
      actorKind: 'system',
      type: AUDIT_EVENT_TYPE,
      fieldPath: 'sourceProvenance.deliveredAt',
      value: { messageId: candidate.messageId, deliveredAt: iso },
    });
    return true;
  });
}

function isS3NotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name) : '';
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

export async function runDeliveredAtCli(argv: readonly string[]): Promise<number> {
  let args: DeliveredAtBackfillArgs;
  try {
    args = parseDeliveredAtArgs(argv);
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  let storage: S3Storage | undefined;
  try {
    storage = getS3Storage();
    if (!(storage instanceof RealS3Storage)) throw new Error('s3_storage_unavailable');
    const result = await runDeliveredAtBackfill({
      apply: args.apply,
      readRawMimePrefix: (key) => readRawMimePrefixFromS3(storage!, key),
    });
    console.log(JSON.stringify({ event: 'delivered_at_backfill_done', ...result }));
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.log(
      JSON.stringify({
        event: 'delivered_at_backfill_failed',
        code: typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'error',
      }),
    );
    return 1;
  } finally {
    await closeDb().catch(() => undefined);
    if (storage instanceof RealS3Storage) storage.client.destroy();
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryHref) {
  void runDeliveredAtCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
