/**
 * Read-only comparison sample for mail-extraction kinds and origins. Prints message IDs, kinds and origins only.
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/kind-drift-sample.ts message-id-1 message-id-2
 *   DATABASE_URL=... pnpm exec tsx scripts/kind-drift-sample.ts --file message-ids.txt
 *
 * The file format is one message ID per line. File IDs are followed by any positional IDs; duplicates are removed.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { desc, inArray, sql } from 'drizzle-orm';
import { createDb, type DB } from '../src/db/client.js';
import { mailExtraction } from '../src/db/schema/work.js';

const USAGE =
  'usage: DATABASE_URL=... pnpm exec tsx scripts/kind-drift-sample.ts [--file <message-ids.txt>] <message-id>...';

export type KindDriftRow = {
  messageId: string;
  kind: string | null;
  origin: string | null;
};

export type KindOriginCount = {
  kind: string | null;
  origin: string | null;
  count: number;
  messageIds: string[];
};

export type KindDriftArgs = {
  help: boolean;
  messageIds: string[];
};

export function parseKindDriftArgs(
  argv: readonly string[],
  readIdsFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): KindDriftArgs {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      file: { type: 'string', short: 'f' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (parsed.values.help) return { help: true, messageIds: [] };

  const fileIds = parsed.values.file ? readIdsFile(parsed.values.file).split(/\r?\n/) : [];
  const messageIds = [
    ...new Set([...fileIds, ...parsed.positionals].map((id) => id.trim()).filter(Boolean)),
  ];
  if (messageIds.length === 0) throw new Error('message_ids_required');
  return { help: false, messageIds };
}

/** Select each requested message's latest extraction, including null kind/origin for missing or failed reads. */
export async function selectLatestKindDriftRows(
  db: DB,
  inputIds: readonly string[],
): Promise<KindDriftRow[]> {
  const messageIds = [...new Set(inputIds.map((id) => id.trim()).filter(Boolean))];
  if (messageIds.length === 0) return [];

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const latest = await tx
      .selectDistinctOn([mailExtraction.messageId], {
        messageId: mailExtraction.messageId,
        kind: mailExtraction.kind,
        origin: sql<string | null>`${mailExtraction.payload}->>'origin'`,
      })
      .from(mailExtraction)
      .where(inArray(mailExtraction.messageId, messageIds))
      .orderBy(mailExtraction.messageId, desc(mailExtraction.createdAt), desc(mailExtraction.id));
    const byMessageId = new Map(latest.map((row) => [row.messageId, row]));
    return messageIds.map((messageId) => {
      const row = byMessageId.get(messageId);
      return row
        ? { messageId, kind: row.kind, origin: row.origin }
        : { messageId, kind: null, origin: null };
    });
  });
}

export function summarizeKindDriftRows(rows: readonly KindDriftRow[]): KindOriginCount[] {
  const groups = new Map<string, KindOriginCount>();
  for (const row of rows) {
    const key = JSON.stringify([row.kind, row.origin]);
    let group = groups.get(key);
    if (!group) {
      group = { kind: row.kind, origin: row.origin, count: 0, messageIds: [] };
      groups.set(key, group);
    }
    group.count += 1;
    group.messageIds.push(row.messageId);
  }
  return [...groups.values()];
}

function cell(value: string | null): string {
  return (value ?? '(none)').replace(/[\t\r\n]/g, ' ');
}

export function formatKindDriftReport(rows: readonly KindDriftRow[]): string {
  return [
    'message_id\tkind\torigin',
    ...rows.map((row) => `${cell(row.messageId)}\t${cell(row.kind)}\t${cell(row.origin)}`),
    '',
    'kind\torigin\tcount\tmessage_ids',
    ...summarizeKindDriftRows(rows).map(
      (group) =>
        `${cell(group.kind)}\t${cell(group.origin)}\t${group.count}\t${group.messageIds.map((id) => cell(id)).join(',')}`,
    ),
  ].join('\n');
}

export async function runKindDriftSampleCli(argv: readonly string[]): Promise<number> {
  let args: KindDriftArgs;
  try {
    args = parseKindDriftArgs(argv);
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    console.error(USAGE);
    return 2;
  }

  let connection: ReturnType<typeof createDb> | null = null;
  try {
    connection = createDb(databaseUrl);
    const rows = await selectLatestKindDriftRows(connection.db, args.messageIds);
    console.log(formatKindDriftReport(rows));
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(
      JSON.stringify({
        event: 'kind_drift_sample_failed',
        code: typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'error',
      }),
    );
    return 1;
  } finally {
    await connection?.conn.end().catch(() => undefined);
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryHref) {
  void runKindDriftSampleCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
