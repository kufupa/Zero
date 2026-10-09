import { panePartyFindResultFromCli, type PanePartyKind } from './pane-party-lookup.js';
import { partyIndexFileSchema, type PartyIndexEntry, type PartyIndexFile } from './party-index.js';

/**
 * The sweep behind the typeahead index. It asks the fail-closed runner for every A–Z prefix of each picker, and for the
 * two-letter prefixes under a letter whose grid came back truncated (50 rows). Every run holds the property lock. The
 * sweep never writes to HMS. It stops on the first run that is not a clean answer, keeps its place, and resumes from
 * that place next time. The index is written only when every queued prefix has been answered.
 */

export const SWEEP_LETTERS: readonly string[] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export type SweepItem = { kind: PanePartyKind; prefix: string };
export type SweepDone = { kind: PanePartyKind; prefix: string; outcome: string; count: number; truncated: boolean };
export type SweepProgress = {
  version: 1;
  startedAt: string;
  queue: SweepItem[];
  done: SweepDone[];
  entries: PartyIndexEntry[];
  runs: number;
};

/** A run that is not a clean answer. The item stays first in the queue, so the next session retries it. */
export class SweepStopped extends Error {
  constructor(
    readonly item: SweepItem,
    readonly outcome: string,
    readonly reason: string,
  ) {
    super(`party index sweep stopped at ${item.kind} "${item.prefix}": ${reason} (${outcome})`);
    this.name = 'SweepStopped';
  }
}

export type SweepOptions = {
  kinds: PanePartyKind[];
  /** Pause between runs. The rate limit on HMS. */
  delayMs: number;
  /** Runs per session. The rest waits for the next session, and the progress is kept. */
  maxRuns: number;
  lockRetries: number;
  lockRetryMs: number;
  /** Ignore saved progress and sweep from the first letter. */
  fresh: boolean;
};

export type SweepSeams = {
  /** One runner run: the raw CLI result for one kind and name. */
  lookup: (input: { kind: PanePartyKind; name: string }) => Promise<unknown>;
  /** Runs one step under the property lock. Throws whatever the lock throws when it is busy or cannot be taken. */
  underLock: <T>(run: () => Promise<T>) => Promise<T>;
  isLockBusy: (error: unknown) => boolean;
  loadProgress: () => Promise<SweepProgress | null>;
  saveProgress: (progress: SweepProgress) => Promise<void>;
  clearProgress: () => Promise<void>;
  writeIndex: (index: PartyIndexFile) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
};

export type SweepResult =
  | { status: 'complete'; entries: number; runs: number; incomplete: number }
  | { status: 'paused'; reason: 'max_runs'; runs: number; pending: number };

const CLEAN_OUTCOMES: ReadonlySet<string> = new Set(['resolved', 'ambiguous', 'no_match']);

export function initialSweepProgress(kinds: PanePartyKind[], startedAt: string): SweepProgress {
  return {
    version: 1,
    startedAt,
    queue: kinds.flatMap((kind) => SWEEP_LETTERS.map((prefix) => ({ kind, prefix }))),
    done: [],
    entries: [],
    runs: 0,
  };
}

function sortEntries(entries: readonly PartyIndexEntry[]): PartyIndexEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind, 'en') ||
      left.name.localeCompare(right.name, 'en') ||
      left.nativeId.localeCompare(right.nativeId, 'en'),
  );
}

async function runOnce(item: SweepItem, options: SweepOptions, seams: SweepSeams): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await seams.underLock(() => seams.lookup({ kind: item.kind, name: item.prefix }));
    } catch (error) {
      if (!seams.isLockBusy(error)) throw new SweepStopped(item, 'execution_failure', 'run_failed');
      if (attempt >= options.lockRetries) throw new SweepStopped(item, 'refused_lock_busy', 'lock_busy');
      await seams.sleep(options.lockRetryMs);
    }
  }
}

export async function runPartyIndexSweep(options: SweepOptions, seams: SweepSeams): Promise<SweepResult> {
  const saved = options.fresh ? null : await seams.loadProgress();
  const progress = saved ?? initialSweepProgress(options.kinds, seams.now().toISOString());
  const seen = new Set(progress.entries.map((entry) => `${entry.kind}:${entry.nativeId}`));
  await seams.saveProgress(progress);

  // The cap counts this session's runs. Runs saved by earlier sessions do not count, so re-running with the same cap resumes.
  let sessionRuns = 0;
  while (progress.queue.length > 0) {
    if (sessionRuns >= options.maxRuns) {
      await seams.saveProgress(progress);
      return { status: 'paused', reason: 'max_runs', runs: progress.runs, pending: progress.queue.length };
    }
    const item = progress.queue[0]!;
    let raw: unknown;
    try {
      raw = await runOnce(item, options, seams);
    } catch (error) {
      await seams.saveProgress(progress);
      throw error;
    }
    progress.runs += 1;
    sessionRuns += 1;
    const result = panePartyFindResultFromCli(item.kind, raw);
    if (!CLEAN_OUTCOMES.has(result.outcome)) {
      await seams.saveProgress(progress);
      throw new SweepStopped(item, result.outcome, 'runner_outcome');
    }
    progress.queue.shift();
    progress.done.push({
      kind: item.kind,
      prefix: item.prefix,
      outcome: result.outcome,
      count: result.results.length,
      truncated: result.truncated,
    });
    for (const candidate of result.results) {
      const key = `${candidate.kind}:${candidate.nativeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      progress.entries.push({ kind: candidate.kind, nativeId: candidate.nativeId, name: candidate.name });
    }
    if (result.truncated && item.prefix.length === 1) {
      for (const letter of SWEEP_LETTERS) progress.queue.push({ kind: item.kind, prefix: item.prefix + letter });
    }
    await seams.saveProgress(progress);
    if (progress.queue.length > 0) await seams.sleep(options.delayMs);
  }

  const index: PartyIndexFile = {
    generatedAt: seams.now().toISOString(),
    entries: sortEntries(progress.entries),
  };
  partyIndexFileSchema.parse(index);
  await seams.writeIndex(index);
  await seams.clearProgress();
  return {
    status: 'complete',
    entries: index.entries.length,
    runs: progress.runs,
    incomplete: progress.done.filter((row) => row.truncated && row.prefix.length === 2).length,
  };
}
