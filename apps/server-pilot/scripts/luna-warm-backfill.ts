/**
 * Luna analyse cache backfill for recent inbound mail on the pilot transport.
 *
 * Pre-warms the same cache files the live warmer and the pane route read, so the
 * first click on yesterday's mail is a cache hit. Every warm goes through
 * warmInboundTriageAnalyse, so transportId, canonical messageId, sourceHash and
 * promptVersion match the live key exactly.
 *
 * Database: read-only (one candidate SELECT, plus the warmer's per-message trigger
 * lookup). Cache files are the only output.
 * Logs carry counts, codes and ms only. Errors are reduced to a code before they
 * are logged, so no message text, body, subject, name or connection string is printed.
 *
 * Run on EC2 from apps/server-pilot:
 *   pnpm exec tsx scripts/luna-warm-backfill.ts [--hours 1-72] [--max 1-200] [--dry-run]
 */
import {
  warmInboundTriageAnalyse,
  type InboundAnalyseWarmDeps,
  type InboundAnalyseWarmResult,
  type InboundTriageWarmRun,
} from '../src/ai/quote-workflow-warmer.js';
import { quoteWorkflowLlmEnabled } from '../src/ai/quote-workflow-llm.js';
import { closeDb, getDb, type DB } from '../src/db/client.js';
import { message } from '../src/db/schema/mail.js';
import { and, desc, eq, gte } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { join } from 'node:path';

export const PILOT_TRANSPORT_ID = 'transport-centurion';
export const DEFAULT_HOURS = 48;
export const MAX_HOURS = 72;
export const DEFAULT_MAX = 150;
/** Selection bound. Also the largest value --max accepts. */
export const SELECTION_LIMIT = 200;
/** Concurrent warms. Matches the warmer's own two-slot limit. */
export const CONCURRENCY = 2;

const HOUR_MS = 60 * 60 * 1000;
const USAGE =
  'usage: pnpm exec tsx scripts/luna-warm-backfill.ts [--hours 1-72, default 48] [--max 1-200, default 150] [--dry-run]';

export type BackfillArgs = { hours: number; max: number; dryRun: boolean; help: boolean };

export type BackfillCandidate = { id: string; messageIdHeader: string | null };

export type BackfillCounts = {
  selected: number;
  /** Uncached items that count against --max, failures included: any of them may have made a Luna call. */
  attempted: number;
  stored: number;
  cached: number;
  failed: number;
  skipped: number;
};

export type BackfillCliIo = {
  log: (line: string) => void;
  loadCandidates?: (input: { since: Date; limit: number }) => Promise<BackfillCandidate[]>;
  deps?: InboundAnalyseWarmDeps;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

function integerArg(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error('bad_args');
  const value = Number(raw);
  if (value < min || value > max) throw new Error('bad_args');
  return value;
}

/** Throws on unknown flags or out-of-range values. The message is never printed. */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      hours: { type: 'string' },
      max: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    hours: integerArg(values.hours, DEFAULT_HOURS, 1, MAX_HOURS),
    max: integerArg(values.max, DEFAULT_MAX, 1, SELECTION_LIMIT),
    dryRun: values['dry-run'] === true,
    help: values.help === true,
  };
}

/**
 * Read-only selection: inbound rows on one transport, received inside the window,
 * newest first, capped at `limit`. Returns the query builder; callers await it.
 */
export function selectBackfillCandidates(
  db: DB,
  input: { transportId: string; since: Date; limit: number },
) {
  return db
    .select({ id: message.id, messageIdHeader: message.messageIdHeader })
    .from(message)
    .where(
      and(
        eq(message.transportId, input.transportId),
        eq(message.direction, 'inbound'),
        gte(message.receivedAt, input.since),
      ),
    )
    .orderBy(desc(message.receivedAt), desc(message.id))
    .limit(input.limit);
}

/** Same directory the live worker gets from LUNA_ANALYSE_CACHE_DIR (pm2 config). */
export function resolveBackfillCacheDir(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): string {
  const explicit = env.LUNA_ANALYSE_CACHE_DIR?.trim();
  return explicit ? explicit : join(cwd, '.private', 'luna-analyse-cache');
}

/** Only a short upper-case token leaves the process. Messages can echo connection strings. */
export function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'error';
}

/**
 * The warmer requires a triage-shaped run with a snapshot id. The marker below is
 * never read or logged, and everything else the warmer does is unchanged.
 */
function triageRunFor(candidate: BackfillCandidate, transportId: string): InboundTriageWarmRun {
  return {
    runKind: 'inbound_triage',
    admissionSnapshotId: `luna-backfill:${candidate.id}`,
    executorLane: 'default',
    transportId,
    triggerMessageId: candidate.id,
  };
}

async function warmOne(
  candidate: BackfillCandidate,
  input: { transportId: string; deps: InboundAnalyseWarmDeps; env: NodeJS.ProcessEnv },
): Promise<InboundAnalyseWarmResult> {
  try {
    return await warmInboundTriageAnalyse(
      triageRunFor(candidate, input.transportId),
      input.deps,
      input.env,
    );
  } catch {
    return 'failed';
  }
}

/**
 * Warms candidates with CONCURRENCY workers. `max` caps uncached attempts. Cached and
 * skipped results release their reservation, so a cache hit never uses up the cap.
 * The reservation happens before the await, so two workers cannot both pass the check.
 */
export async function runBackfill(input: {
  candidates: readonly BackfillCandidate[];
  transportId: string;
  max: number;
  deps: InboundAnalyseWarmDeps;
  env: NodeJS.ProcessEnv;
  concurrency?: number;
}): Promise<BackfillCounts> {
  const counts: BackfillCounts = {
    selected: input.candidates.length,
    attempted: 0,
    stored: 0,
    cached: 0,
    failed: 0,
    skipped: 0,
  };
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < input.candidates.length && counts.attempted < input.max) {
      const candidate = input.candidates[cursor];
      cursor += 1;
      if (!candidate) return;
      counts.attempted += 1;
      const result = await warmOne(candidate, input);
      if (result === 'cached' || result === 'skipped') counts.attempted -= 1;
      counts[result] += 1;
    }
  };
  await Promise.all(Array.from({ length: input.concurrency ?? CONCURRENCY }, () => worker()));
  return counts;
}

async function defaultLoadCandidates(input: {
  since: Date;
  limit: number;
}): Promise<BackfillCandidate[]> {
  return await selectBackfillCandidates(getDb(), {
    transportId: PILOT_TRANSPORT_ID,
    since: input.since,
    limit: input.limit,
  });
}

/** Returns the process exit code. Never throws. */
export async function runBackfillCli(argv: readonly string[], io: BackfillCliIo): Promise<number> {
  const now = io.now ?? Date.now;
  const started = now();
  const env = io.env ?? process.env;
  let args: BackfillArgs;
  try {
    args = parseBackfillArgs(argv);
  } catch {
    io.log(JSON.stringify({ event: 'luna_backfill_usage', code: 'bad_args' }));
    return 2;
  }
  if (args.help) {
    io.log(USAGE);
    return 0;
  }
  try {
    if (!args.dryRun && !quoteWorkflowLlmEnabled(env)) {
      io.log(JSON.stringify({ event: 'luna_backfill_skipped', code: 'llm_disabled' }));
      return 2;
    }
    const since = new Date(started - args.hours * HOUR_MS);
    const load = io.loadCandidates ?? defaultLoadCandidates;
    const candidates = await load({ since, limit: SELECTION_LIMIT });
    if (args.dryRun) {
      const withMessageId = candidates.filter(
        (c) => (c.messageIdHeader ?? '').trim() !== '',
      ).length;
      io.log(
        JSON.stringify({
          event: 'luna_backfill_dry_run',
          hours: args.hours,
          max: args.max,
          selected: candidates.length,
          withMessageId,
          wouldAttemptAtMost: Math.min(withMessageId, args.max),
          ms: now() - started,
        }),
      );
      return 0;
    }
    const deps = io.deps ?? { cacheDir: resolveBackfillCacheDir(env) };
    // The live default is 60 model calls per hour per process. This process is the
    // backfill, so its own hourly guard is raised to --max and --max is the real cap.
    const warmEnv = {
      ...env,
      LUNA_ANALYSE_WARMER: 'on',
      LUNA_ANALYSE_WARMER_MAX_PER_HOUR: String(args.max),
    };
    const counts = await runBackfill({
      candidates,
      transportId: PILOT_TRANSPORT_ID,
      max: args.max,
      deps,
      env: warmEnv,
    });
    io.log(
      JSON.stringify({
        event: 'luna_backfill_done',
        hours: args.hours,
        max: args.max,
        ...counts,
        ms: now() - started,
      }),
    );
    return 0;
  } catch (error) {
    io.log(
      JSON.stringify({
        event: 'luna_backfill_failed',
        code: safeErrorCode(error),
        ms: now() - started,
      }),
    );
    return 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryHref) {
  void runBackfillCli(process.argv.slice(2), { log: (line) => console.log(line) }).then((code) => {
    process.exitCode = code;
  });
}
