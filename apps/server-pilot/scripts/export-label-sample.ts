/**
 * Stratified label sample (v5 B5). Picks succeeded inbound mail extractions for human labelling: every cancellation, and
 * up to --per-kind (default 65) of every other kind. A seeded md5 order picks the rows, so the same seed picks the same
 * rows again.
 *
 * Sender domains are split by hash (20% holdout). Every mail from one domain lands in one split, so a holdout domain never
 * appears in dev. The output keeps a sha256 of the sender domain, never the address. Subject, text and the AI payload go
 * through maskMailText / maskMailValue (card numbers, security codes, e-mail addresses, phone numbers). Names and URLs are
 * not masked.
 *
 *   export-label-sample.ts [--per-kind 65] [--seed ID] [--write] [--out FILE]
 *
 * Dry run by default: it prints the counts and writes nothing. --write writes the JSONL, by default under
 * apps/server-pilot/.private/label-sample/ (gitignored, mode 0600). The database is only read. Point DATABASE_URL at a
 * lane or test database; this script is not run against production.
 */
import { senderDomainOf } from '../src/ai/reservationist-backtest.js';
import { MAIL_KINDS, mailExtraction } from '../src/db/schema/work.js';
import { maskMailText, maskMailValue } from '../src/ai/card-mask.js';
import { createDb, type DB } from '../src/db/client.js';
import { message } from '../src/db/schema/mail.js';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const SAMPLE_SCHEMA_VERSION = 'label-sample/v1';
export type SampleSplit = 'dev' | 'holdout';
export const DEFAULT_PER_KIND = 65;
export const DEFAULT_SEED = 'v5-label-sample-1';
export const HOLDOUT_PERCENT = 20;
const PRIVATE_ROOT = fileURLToPath(new URL('../.private/', import.meta.url));
export const DEFAULT_OUT = join(PRIVATE_ROOT, 'label-sample', 'label-sample-v1.jsonl');
const USAGE = 'usage: export-label-sample.ts [--per-kind N] [--seed ID] [--write] [--out FILE]';

/** One succeeded inbound extraction, with its message. */
export type PickedRow = {
  kind: string;
  extractionId: string;
  messageId: string;
  extractorVersion: string;
  payload: unknown;
  fromAddress: string;
  subject: string | null;
  textBody: string | null;
};

export type SampleRow = {
  schema_version: typeof SAMPLE_SCHEMA_VERSION;
  extraction_id: string;
  message_id: string;
  stratum: string;
  split: SampleSplit;
  sender_domain_sha256: string;
  subject: string;
  text: string;
  ai: { kind: string; extractor_version: string; payload: unknown };
};

const domainDigest = (domain: string) => createHash('sha256').update(domain).digest();

/** Holdout by sender domain: every mail from one domain takes the same split. */
export function sampleSplitOf(domain: string): SampleSplit {
  return domainDigest(domain).readUInt32BE(0) % 100 < HOLDOUT_PERCENT ? 'holdout' : 'dev';
}

/** Every succeeded inbound extraction, by kind: all cancellations, the other kinds up to perKind, in seeded order. */
export async function selectSample(
  db: DB,
  options: { perKind: number; seed: string },
): Promise<{ available: Record<string, number>; picked: PickedRow[] }> {
  const counts = await db
    .select({ kind: mailExtraction.kind, n: sql<number>`count(*)::int` })
    .from(mailExtraction)
    .innerJoin(message, eq(message.id, mailExtraction.messageId))
    .where(and(eq(mailExtraction.status, 'succeeded'), eq(message.direction, 'inbound')))
    .groupBy(mailExtraction.kind);
  const available: Record<string, number> = Object.fromEntries(MAIL_KINDS.map((kind) => [kind, 0]));
  for (const row of counts) if (row.kind) available[row.kind] = row.n;

  const picked: PickedRow[] = [];
  for (const kind of MAIL_KINDS) {
    const query = db
      .select({
        extractionId: mailExtraction.id,
        messageId: mailExtraction.messageId,
        extractorVersion: mailExtraction.extractorVersion,
        payload: mailExtraction.payload,
        fromAddress: message.fromAddress,
        subject: message.subject,
        textBody: message.textBody,
      })
      .from(mailExtraction)
      .innerJoin(message, eq(message.id, mailExtraction.messageId))
      .where(
        and(
          eq(mailExtraction.status, 'succeeded'),
          eq(message.direction, 'inbound'),
          eq(mailExtraction.kind, kind),
        ),
      )
      .orderBy(sql`md5(${mailExtraction.id}::text || ${options.seed}::text)`);
    const rows = kind === 'cancellation' ? await query : await query.limit(options.perKind);
    picked.push(...rows.map((row) => ({ ...row, kind })));
  }
  return { available, picked };
}

export function toSampleRow(row: PickedRow): SampleRow {
  const domain = senderDomainOf(row.fromAddress);
  return {
    schema_version: SAMPLE_SCHEMA_VERSION,
    extraction_id: row.extractionId,
    message_id: row.messageId,
    stratum: row.kind,
    split: sampleSplitOf(domain),
    sender_domain_sha256: domainDigest(domain).toString('hex'),
    subject: maskMailText(row.subject ?? ''),
    text: maskMailText(row.textBody ?? ''),
    ai: {
      kind: row.kind,
      extractor_version: row.extractorVersion,
      payload: maskMailValue(row.payload),
    },
  };
}

function parseCli(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'per-kind': { type: 'string' },
        seed: { type: 'string' },
        write: { type: 'boolean' },
        out: { type: 'string' },
      },
    });
  } catch {
    return null;
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const cli = parseCli(argv);
  if (!cli) {
    console.error(USAGE);
    return 2;
  }
  const { positionals, values } = cli;
  const perKind = values['per-kind'] === undefined ? DEFAULT_PER_KIND : Number(values['per-kind']);
  const seed = values.seed ?? DEFAULT_SEED;
  if (
    positionals.length > 0 ||
    !Number.isInteger(perKind) ||
    perKind < 1 ||
    !seed.trim() ||
    (values.out !== undefined && !values.write)
  ) {
    console.error(USAGE);
    return 2;
  }
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is not set. The sample reads mail_extraction and message from it.');
    return 2;
  }

  const { db, conn } = createDb(url);
  let picked: Awaited<ReturnType<typeof selectSample>>;
  try {
    picked = await selectSample(db, { perKind, seed });
  } finally {
    await conn.end();
  }

  const rows = picked.picked.map(toSampleRow);
  const selected: Record<string, number> = Object.fromEntries(MAIL_KINDS.map((kind) => [kind, 0]));
  const splits: Record<SampleSplit, number> = { dev: 0, holdout: 0 };
  const holdoutDomains = new Set<string>();
  for (const row of rows) {
    selected[row.stratum] = (selected[row.stratum] ?? 0) + 1;
    splits[row.split] += 1;
    if (row.split === 'holdout') holdoutDomains.add(row.sender_domain_sha256);
  }
  const summary = {
    dryRun: !values.write,
    seed,
    perKind,
    available: picked.available,
    selected,
    total: rows.length,
    splits,
    holdoutDomains: holdoutDomains.size,
  };

  if (!values.write) {
    console.log(JSON.stringify(summary));
    return 0;
  }
  const out = resolve(values.out ?? DEFAULT_OUT);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, out }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`sample failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
