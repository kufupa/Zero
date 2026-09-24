/**
 * Ingest Bongi Centurion Sent catchup gold (.eml) into pilot as outbound
 * transport-centurion messages. Skips AI enqueue. Dedupes by catchup UIDL and
 * by subject+sent-minute against existing Centurion outbound.
 *
 * EC2:
 *   set -a && source .env.production && set +a
 *   export INGEST_REQUIRE_OWNER_HEADER=false
 *   pnpm --filter @zero/server exec tsx scripts/ingest-centurion-catchup-gold.ts \
 *     --dir /tmp/catchup-gold-eml --manifest /tmp/catchup-gold-eml/manifest.json
 *   … --dry-run | --limit N
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { message } from '../src/db/schema/mail.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { parseEnv } from '../src/env.js';
import {
  candidateMessageIdForPop3Uidl,
  parseRawMessage,
  uploadedAttachmentsFromParseFailure,
} from '../src/mail/ingest/parse-message.js';
import {
  cleanupPartialParseFailureAttachments,
  persistInboundMessage,
} from '../src/mail/ingest/store.js';
import { getS3Storage } from '../src/storage/s3.js';

export const CATCHUP_GOLD_INGEST_MAILBOX_ID = 'ingest-nava-legacy';
export const CENTURION_TRANSPORT_ID = 'transport-centurion';
/** UIDL namespace so catchup rows never collide with live POP3 uidls. */
export const CATCHUP_GOLD_UIDL_PREFIX = 'catchup-gold-';

export interface CatchupEmlManifestRecord {
  file?: string;
  eml: string;
  fp: string;
  subject?: string | null;
  date_iso?: string | null;
  to?: string | null;
  error?: string;
}

export interface CatchupGoldCliArgs {
  dir: string;
  manifest?: string;
  skipFpsPath?: string;
  dryRun: boolean;
  limit?: number;
}

export interface CatchupGoldIngestResult {
  scanned: number;
  stored: number;
  duplicateUidl: number;
  duplicateContent: number;
  quarantined: number;
  errors: number;
  skippedManifestError: number;
  skippedFp: number;
  errorFiles: string[];
}

function normSubject(s: string | null | undefined): string {
  let out = (s ?? '').trim().toLowerCase();
  for (;;) {
    const next = out.replace(/^(re|fw|fwd)\s*:\s*/i, '');
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function sentMinuteIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

export function parseCatchupGoldCliArgs(argv: string[]): CatchupGoldCliArgs {
  let dir = '';
  let manifest: string | undefined;
  let skipFpsPath: string | undefined;
  let dryRun = false;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--dir') dir = argv[++i] ?? '';
    else if (a === '--manifest') manifest = argv[++i];
    else if (a === '--skip-fps') skipFpsPath = argv[++i];
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) throw new Error('--limit must be positive int');
      limit = Math.floor(n);
    } else if (a === '--help') {
      throw new Error(
        'usage: ingest-centurion-catchup-gold.ts --dir DIR [--manifest FILE] [--skip-fps FILE] [--dry-run] [--limit N]',
      );
    }
  }
  if (!dir) throw new Error('--dir required');
  return { dir, manifest, skipFpsPath, dryRun, limit };
}

export function formatCatchupGoldSummary(r: CatchupGoldIngestResult): string {
  return [
    `scanned=${r.scanned}`,
    `stored=${r.stored}`,
    `dupUidl=${r.duplicateUidl}`,
    `dupContent=${r.duplicateContent}`,
    `quarantined=${r.quarantined}`,
    `errors=${r.errors}`,
    `skippedManifestError=${r.skippedManifestError}`,
    `skippedFp=${r.skippedFp}`,
  ].join(' ');
}

/** Real MIME Message-ID wins; synthetic only when header absent/empty. */
export function resolveCatchupMessageId(
  parsedMessageId: string | null | undefined,
  fp: string,
): string {
  const real = (parsedMessageId ?? '').trim();
  if (real) return real;
  return `catchup-gold-${fp}@catchup.legacyhotels.co.za`;
}

export async function loadSkipFps(skipFpsPath?: string): Promise<Set<string>> {
  if (!skipFpsPath) return new Set();
  const raw = JSON.parse(await readFile(skipFpsPath, 'utf8')) as
    | string[]
    | { skip_fps?: string[]; skipFps?: string[] };
  const list = Array.isArray(raw) ? raw : (raw.skip_fps ?? raw.skipFps ?? []);
  if (!Array.isArray(list)) throw new Error('--skip-fps must be string[] or {skip_fps:string[]}');
  return new Set(list.map(String));
}

async function loadManifest(
  dir: string,
  manifestPath?: string,
): Promise<CatchupEmlManifestRecord[]> {
  if (manifestPath) {
    const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      records?: CatchupEmlManifestRecord[];
    };
    if (!Array.isArray(raw.records)) throw new Error('manifest missing records[]');
    return raw.records;
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith('.eml')).sort();
  return files.map((eml) => ({
    eml,
    fp: eml.replace(/\.eml$/i, ''),
  }));
}

async function findByUidl(
  db: ReturnType<typeof drizzle>,
  ingestMailboxId: string,
  pop3Uidl: string,
): Promise<{ id: string } | undefined> {
  const rows = await db
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.ingestMailboxId, ingestMailboxId), eq(message.pop3Uidl, pop3Uidl)))
    .limit(1);
  return rows[0];
}

async function findContentDuplicate(
  db: ReturnType<typeof drizzle>,
  subject: string | null | undefined,
  dateIso: string | null | undefined,
): Promise<{ id: string } | undefined> {
  const subjRaw = (subject ?? '').trim().toLowerCase();
  const subjNorm = normSubject(subject);
  const minute = sentMinuteIso(dateIso);
  if ((!subjRaw && !subjNorm) || !minute) return undefined;
  const rows = await db.execute(sql`
    SELECT id
    FROM message
    WHERE transport_id = ${CENTURION_TRANSPORT_ID}
      AND direction = 'outbound'
      AND lower(from_address) LIKE '%centurion@legacyhotels.co.za%'
      AND (
        lower(coalesce(subject, '')) = ${subjRaw}
        OR lower(coalesce(subject, '')) = ${subjNorm}
      )
      AND date_trunc('minute', coalesce(sent_at, received_at) AT TIME ZONE 'UTC')
          = date_trunc('minute', ${minute}::timestamptz AT TIME ZONE 'UTC')
    LIMIT 1
  `);
  const list = rows as unknown as { id: string }[];
  return list[0];
}

export async function ingestCenturionCatchupGold(opts: {
  db: ReturnType<typeof drizzle>;
  dir: string;
  manifestPath?: string;
  skipFpsPath?: string;
  dryRun?: boolean;
  limit?: number;
}): Promise<CatchupGoldIngestResult> {
  const storage = getS3Storage();
  const records = await loadManifest(opts.dir, opts.manifestPath);
  const skipFps = await loadSkipFps(opts.skipFpsPath);
  const result: CatchupGoldIngestResult = {
    scanned: 0,
    stored: 0,
    duplicateUidl: 0,
    duplicateContent: 0,
    quarantined: 0,
    errors: 0,
    skippedManifestError: 0,
    skippedFp: 0,
    errorFiles: [],
  };

  let processed = 0;
  for (const rec of records) {
    if (opts.limit !== undefined && processed >= opts.limit) break;
    if (rec.error || !rec.eml || !rec.fp) {
      result.skippedManifestError += 1;
      continue;
    }
    processed += 1;
    result.scanned += 1;
    if (skipFps.has(rec.fp)) {
      result.skippedFp += 1;
      continue;
    }
    const pop3Uidl = `${CATCHUP_GOLD_UIDL_PREFIX}${rec.fp}`;
    const emlPath = path.join(opts.dir, rec.eml);

    try {
      const existingUidl = await findByUidl(opts.db, CATCHUP_GOLD_INGEST_MAILBOX_ID, pop3Uidl);
      if (existingUidl) {
        result.duplicateUidl += 1;
        continue;
      }

      const contentDup = await findContentDuplicate(opts.db, rec.subject, rec.date_iso);
      if (contentDup) {
        result.duplicateContent += 1;
        continue;
      }

      if (opts.dryRun) continue;

      const raw = await readFile(emlPath);
      const messageId = candidateMessageIdForPop3Uidl(CATCHUP_GOLD_INGEST_MAILBOX_ID, pop3Uidl);
      const meta = {
        ingestMailboxId: CATCHUP_GOLD_INGEST_MAILBOX_ID,
        pop3Uidl,
        messageId,
      };
      let parsed;
      try {
        parsed = await parseRawMessage(raw, { messageId, storage });
      } catch (err) {
        const uploaded = uploadedAttachmentsFromParseFailure(err);
        if (uploaded.length > 0) {
          await cleanupPartialParseFailureAttachments({
            db: opts.db as never,
            storage,
            attachments: uploaded,
            meta,
          });
        }
        throw err;
      }

      // Outlook .msg → eml often lacks Subject / bare From display-name.
      if (!parsed.subject && rec.subject) {
        parsed = { ...parsed, subject: rec.subject };
      }
      if (
        !parsed.fromAddress ||
        !parsed.fromAddress.toLowerCase().includes('centurion@legacyhotels.co.za')
      ) {
        parsed = {
          ...parsed,
          fromAddress: 'centurion@legacyhotels.co.za',
        };
      } else if (parsed.fromAddress.includes('<')) {
        // Normalize to bare email for hotel-sent heuristics / actor queries.
        parsed = { ...parsed, fromAddress: 'centurion@legacyhotels.co.za' };
      }
      // Preserve real SMTP Message-ID when present (Nava AI Sent); synthesize only if absent.
      parsed = {
        ...parsed,
        messageId: resolveCatchupMessageId(parsed.messageId, rec.fp),
      };

      const persistResult = await persistInboundMessage(parsed, raw, meta, {
        db: opts.db as never,
        storage,
        transportOverride: CENTURION_TRANSPORT_ID,
        directionOverride: 'outbound',
        skipAiEnqueue: true,
      });

      if (persistResult.kind === 'stored') result.stored += 1;
      else if (persistResult.kind === 'duplicate') result.duplicateUidl += 1;
      else if (persistResult.kind === 'quarantined') result.quarantined += 1;
      else {
        result.errors += 1;
        result.errorFiles.push(rec.eml);
      }
    } catch (err) {
      result.errors += 1;
      result.errorFiles.push(rec.eml);
      console.error('catchup-gold ingest error', rec.eml, err instanceof Error ? err.message : err);
    }
  }

  if (opts.dryRun) {
    // dry-run counted scans + dups; estimate would-store
    const wouldStore =
      result.scanned -
      result.duplicateUidl -
      result.duplicateContent -
      result.skippedFp;
    console.log(`dry-run wouldStore≈${wouldStore}`);
  }

  return result;
}

async function main(): Promise<void> {
  const cli = parseCatchupGoldCliArgs(process.argv.slice(2));
  const env = parseEnv(process.env);
  const conn = postgres(env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: getPostgresSslOptions(),
  });
  const db = drizzle(conn, { schema });

  try {
    const result = await ingestCenturionCatchupGold({
      db,
      dir: cli.dir,
      manifestPath: cli.manifest,
      skipFpsPath: cli.skipFpsPath,
      dryRun: cli.dryRun,
      limit: cli.limit,
    });
    console.log(
      cli.dryRun ? 'catchup-gold dry-run:' : 'catchup-gold complete:',
      formatCatchupGoldSummary(result),
    );
    if (result.errorFiles.length) {
      console.log('errorFiles:', result.errorFiles.slice(0, 20).join(', '));
    }
    if (result.errors > 0) process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('ingest-centurion-catchup-gold.ts') ||
    process.argv[1].endsWith('ingest-centurion-catchup-gold.js'));

if (isDirectRun) {
  main().catch((err) => {
    console.error('catchup-gold ingest failed:', err);
    process.exit(1);
  });
}
