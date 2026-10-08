import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import type { ModelAdapter } from './bedrock/adapter.js';
import {
  analyseCachePath,
  analyseSyncedSelection,
  canonicalInternetMessageId,
  hashSyncedQuoteSelection,
  isReusableAnalyseCache,
  readAnalyseCache,
  resolveAnalyseCacheDir,
} from './quote-workflow-analyse-selection.js';
import { QUOTE_WORKFLOW_PROMPT_VERSION, quoteWorkflowLlmEnabled } from './quote-workflow-llm.js';
import {
  loadSyncedQuoteSelectionFromMailbox,
  type SyncedQuoteSelection,
} from './quote-workflow-synced-selection.js';

/**
 * Inbound triage warmer. After an admitted inbound triage succeeds, run the same
 * Luna analyse the pane route runs and write the same cache file, so the first
 * click on that mail is a cache hit.
 *
 * Off unless LUNA_ANALYSE_WARMER=on. Never throws into triage. Logs carry a code
 * and ms only, never mail bodies.
 */

const DEFAULT_MAX_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;
const MAX_IN_FLIGHT = 2;
const LOADER_TIMEOUT_MS = 15_000;

export type InboundTriageWarmRun = {
  runKind: string;
  admissionSnapshotId: string | null;
  executorLane: string;
  transportId: string;
  triggerMessageId: string;
};

export type InboundAnalyseWarmDeps = {
  loadSyncedSelection?: (input: {
    transportId: string;
    internetMessageId?: string;
    signal?: AbortSignal;
  }) => Promise<SyncedQuoteSelection | null>;
  adapter?: ModelAdapter | null;
  llmEnabled?: () => boolean;
  cacheDir?: string | null;
  promptVersion?: string;
};

export type InboundAnalyseWarmResult = 'stored' | 'cached' | 'failed' | 'skipped';

export function analyseWarmerEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.LUNA_ANALYSE_WARMER === 'on';
}

/** Model calls per rolling hour. Unset or unparseable means the default of 60. */
export function analyseWarmerMaxPerHour(env: NodeJS.ProcessEnv): number {
  const raw = env.LUNA_ANALYSE_WARMER_MAX_PER_HOUR?.trim();
  if (!raw) return DEFAULT_MAX_PER_HOUR;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_PER_HOUR;
}

/** Two-slot in-file semaphore. Each job holds one slot from load to write. */
let inFlight = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  // Hand the slot straight to the next waiter; inFlight stays the same.
  if (next) next();
  else inFlight -= 1;
}

/** Model-call start times in the last hour. Cache hits and skips do not count. */
let modelCallStarts: number[] = [];

function takeModelCallSlot(max: number, nowMs: number): boolean {
  modelCallStarts = modelCallStarts.filter((started) => nowMs - started < HOUR_MS);
  if (modelCallStarts.length >= max) return false;
  modelCallStarts.push(nowMs);
  return true;
}

function stored(started: number): 'stored' {
  console.info('luna_warm_ok', { code: 'stored', ms: Date.now() - started });
  return 'stored';
}

function cachedHit(started: number): 'cached' {
  console.info('luna_warm_skip_cached', { code: 'cache_hit', ms: Date.now() - started });
  return 'cached';
}

function failed(code: string, started: number): 'failed' {
  console.warn('luna_warm_failed', { code, ms: Date.now() - started });
  return 'failed';
}

async function runWarm(
  run: InboundTriageWarmRun,
  deps: InboundAnalyseWarmDeps,
  env: NodeJS.ProcessEnv,
  started: number,
): Promise<InboundAnalyseWarmResult> {
  const [trigger] = await getDb()
    .select({ direction: message.direction, messageIdHeader: message.messageIdHeader })
    .from(message)
    .where(and(eq(message.id, run.triggerMessageId), eq(message.transportId, run.transportId)))
    .limit(1);
  if (!trigger || trigger.direction !== 'inbound') return 'skipped';
  // Canonical form, the same key the pane route builds from the id it is sent.
  const internetMessageId = canonicalInternetMessageId(trigger.messageIdHeader);
  if (!internetMessageId) return failed('no_message_id', started);
  const cacheDir = resolveAnalyseCacheDir(deps.cacheDir ?? null);
  if (!cacheDir) return failed('no_cache_dir', started);
  const load = deps.loadSyncedSelection ?? loadSyncedQuoteSelectionFromMailbox;
  const synced = await load({
    transportId: run.transportId,
    internetMessageId,
    signal: AbortSignal.timeout(LOADER_TIMEOUT_MS),
  });
  if (!synced) return failed('unsynced', started);
  const promptVersion = deps.promptVersion ?? QUOTE_WORKFLOW_PROMPT_VERSION;
  // The file name needs the source hash, so the skip is decided after loading.
  const cacheFile = analyseCachePath({
    internetMessageId,
    sourceHash: hashSyncedQuoteSelection(synced),
    promptVersion,
    cacheDir,
  });
  if (isReusableAnalyseCache(await readAnalyseCache(cacheFile))) return cachedHit(started);
  // Disabled Luna makes no model call, so it must not spend a cap slot.
  const llmEnabled = deps.llmEnabled ?? (() => quoteWorkflowLlmEnabled(process.env));
  if (!llmEnabled()) return failed('disabled', started);
  if (!takeModelCallSlot(analyseWarmerMaxPerHour(env), Date.now())) {
    return failed('cap', started);
  }
  const { outcome } = await analyseSyncedSelection(synced, {
    internetMessageId,
    selectionEpoch: 0,
    cacheDir,
    promptVersion,
    adapter: deps.adapter,
    llmEnabled,
  });
  if (outcome.kind === 'cache_hit') return cachedHit(started);
  if (outcome.kind === 'luna') {
    return outcome.cached ? stored(started) : failed('cache_write', started);
  }
  return failed(outcome.reason, started);
}

/**
 * Warm the Luna analyse cache for one triaged inbound run. Resolves to a result
 * and never rejects.
 */
export async function warmInboundTriageAnalyse(
  run: InboundTriageWarmRun,
  deps: InboundAnalyseWarmDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<InboundAnalyseWarmResult> {
  if (!analyseWarmerEnabled(env)) return 'skipped';
  if (run.runKind !== 'inbound_triage' || !run.admissionSnapshotId) return 'skipped';
  if (run.executorLane !== 'default') return 'skipped';
  await acquireSlot();
  const started = Date.now();
  try {
    return await runWarm(run, deps, env, started);
  } catch {
    // Codes only: error text can echo mail content.
    return failed('error', started);
  } finally {
    releaseSlot();
  }
}

/** Fire-and-forget entry for the ai-worker, called after triage succeeds. */
export function scheduleInboundTriageAnalyseWarm(
  run: InboundTriageWarmRun,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!analyseWarmerEnabled(env)) return;
  void warmInboundTriageAnalyse(run, {}, env).catch(() => undefined);
}

export function __resetInboundTriageAnalyseWarmForTests(): void {
  inFlight = 0;
  waiting.length = 0;
  modelCallStarts = [];
}
