import { describe, expect, it } from 'vitest';
import { partyIndexFileSchema, type PartyIndexFile } from '../src/ai/party-index.js';
import {
  runPartyIndexSweep,
  SweepStopped,
  type SweepOptions,
  type SweepProgress,
  type SweepSeams,
} from '../src/ai/party-index-sweep.js';
import type { PanePartyKind } from '../src/ai/pane-party-lookup.js';

type Answer = { outcome?: string; truncated?: boolean; candidates?: Array<{ nativeId: string; name: string }> };

/** The runner's CLI shape: HMS kinds, and the grid's rows. */
function runner(answer: (kind: PanePartyKind, name: string) => Answer, calls: Array<{ kind: PanePartyKind; name: string }> = []) {
  return async (input: { kind: PanePartyKind; name: string }) => {
    calls.push(input);
    const picked = answer(input.kind, input.name);
    const hmsKind = input.kind === 'company' ? 'organization' : 'bookingAgency';
    return {
      outcome: picked.outcome ?? 'no_match',
      truncated: picked.truncated ?? false,
      candidates: (picked.candidates ?? []).map((row) => ({
        nativeId: row.nativeId,
        displayName: row.name,
        kind: hmsKind,
        matchedOn: ['store'],
      })),
    };
  };
}

const quiet = (answer: (kind: PanePartyKind, name: string) => Answer = () => ({})) => answer;

function options(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return {
    kinds: ['company', 'agency'],
    delayMs: 1000,
    maxRuns: 1000,
    lockRetries: 3,
    lockRetryMs: 500,
    fresh: false,
    ...overrides,
  };
}

function harness(lookup: ReturnType<typeof runner>, lockBusyTimes = 0) {
  let saved: SweepProgress | null = null;
  const writes: PartyIndexFile[] = [];
  const delays: number[] = [];
  let cleared = false;
  let busyLeft = lockBusyTimes;
  const seams: SweepSeams = {
    lookup,
    underLock: async <T,>(run: () => Promise<T>): Promise<T> => {
      if (busyLeft > 0) {
        busyLeft -= 1;
        throw Object.assign(new Error('lock busy'), { busy: true });
      }
      return run();
    },
    isLockBusy: (error: unknown) => (error as { busy?: boolean } | undefined)?.busy === true,
    loadProgress: async () => (saved ? structuredClone(saved) : null),
    saveProgress: async (progress: SweepProgress) => {
      saved = structuredClone(progress);
    },
    clearProgress: async () => {
      saved = null;
      cleared = true;
    },
    writeIndex: async (index: PartyIndexFile) => {
      writes.push(structuredClone(index));
    },
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    now: () => new Date('2026-10-10T12:00:00Z'),
  };
  return {
    seams,
    writes,
    delays,
    saved: () => saved,
    cleared: () => cleared,
  };
}

describe('the sweep plan', () => {
  it('asks A to Z of each picker, then completes and writes an empty valid index when nothing matches', async () => {
    const calls: Array<{ kind: PanePartyKind; name: string }> = [];
    const h = harness(runner(quiet(), calls));
    const result = await runPartyIndexSweep(options(), h.seams);
    expect(result).toEqual({ status: 'complete', entries: 0, runs: 52, incomplete: 0 });
    expect(calls).toHaveLength(52);
    expect(calls[0]).toEqual({ kind: 'company', name: 'A' });
    expect(calls[25]).toEqual({ kind: 'company', name: 'Z' });
    expect(calls[26]).toEqual({ kind: 'agency', name: 'A' });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.entries).toEqual([]);
    expect(partyIndexFileSchema.safeParse(h.writes[0]).success).toBe(true);
    expect(h.cleared()).toBe(true);
  });

  it('sends only the kind and the prefix to HMS: the sweep reads, it never writes', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = harness(
      async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return { outcome: 'no_match', truncated: false, candidates: [] };
      },
    );
    await runPartyIndexSweep(options({ kinds: ['company'] }), h.seams);
    expect(calls.every((call) => Object.keys(call).sort().join(',') === 'kind,name')).toBe(true);
  });

  it('a letter whose grid is truncated gets its two-letter prefixes, and only that letter does', async () => {
    const calls: Array<{ kind: PanePartyKind; name: string }> = [];
    const h = harness(
      runner((kind, name) => ({ truncated: kind === 'company' && (name === 'A' || name === 'AB') }), calls),
    );
    const result = await runPartyIndexSweep(options(), h.seams);
    const companyPrefixes = calls.filter((call) => call.kind === 'company').map((call) => call.name);
    expect(companyPrefixes.filter((name) => name.length === 2)).toEqual(
      Array.from({ length: 26 }, (_, i) => `A${String.fromCharCode(65 + i)}`),
    );
    expect(companyPrefixes.filter((name) => name.startsWith('B') && name.length === 2)).toEqual([]);
    // 26 company letters, 26 children of the truncated A, and 26 agency letters. AB is two letters, so it has no children.
    expect(result).toMatchObject({ status: 'complete', runs: 78, incomplete: 1 });
  });

  it('dedupes by kind and HMS id across prefixes, and sorts the index by kind then name', async () => {
    const h = harness(
      runner((kind, name) => {
        if (kind !== 'company') return {};
        if (name === 'A') return { candidates: [{ nativeId: '206', name: 'Tourvest' }] };
        if (name === 'B') {
          return {
            candidates: [
              { nativeId: '206', name: 'Tourvest' },
              { nativeId: '207', name: 'Bidvest' },
            ],
          };
        }
        return {};
      }),
    );
    await runPartyIndexSweep(options({ kinds: ['company'] }), h.seams);
    expect(h.writes[0]!.entries).toEqual([
      { kind: 'company', nativeId: '207', name: 'Bidvest' },
      { kind: 'company', nativeId: '206', name: 'Tourvest' },
    ]);
  });
});

describe('stopping and resuming', () => {
  it('stops on the first execution_failure, keeps that prefix first in line, and writes no index', async () => {
    const h = harness(runner((kind, name) => (kind === 'company' && name === 'C' ? { outcome: 'execution_failure' } : {})));
    await expect(runPartyIndexSweep(options({ kinds: ['company'] }), h.seams)).rejects.toBeInstanceOf(SweepStopped);
    expect(h.writes).toHaveLength(0);
    expect(h.cleared()).toBe(false);
    expect(h.saved()!.queue[0]).toEqual({ kind: 'company', prefix: 'C' });
    expect(h.saved()!.done.map((row) => row.prefix)).toEqual(['A', 'B']);
  });

  it('a stopped sweep resumes at the stopped prefix, with no letter asked twice', async () => {
    const calls: Array<{ kind: PanePartyKind; name: string }> = [];
    let failing = true;
    const h = harness(
      runner((kind, name) => (failing && kind === 'company' && name === 'C' ? { outcome: 'execution_failure' } : {}), calls),
    );
    await expect(runPartyIndexSweep(options({ kinds: ['company'] }), h.seams)).rejects.toBeInstanceOf(SweepStopped);
    failing = false;
    calls.length = 0;
    const result = await runPartyIndexSweep(options({ kinds: ['company'] }), h.seams);
    expect(calls[0]).toEqual({ kind: 'company', name: 'C' });
    // The failed C run counts as a run, so the resumed session adds C..Z to the three already made.
    expect(result).toMatchObject({ status: 'complete', runs: 27 });
    expect(h.saved()).toBeNull();
    expect(h.cleared()).toBe(true);
  });

  it('pauses at the run cap with its place saved, and the next session finishes the same sweep', async () => {
    const h = harness(runner(quiet()));
    const first = await runPartyIndexSweep(options({ maxRuns: 5 }), h.seams);
    expect(first).toEqual({ status: 'paused', reason: 'max_runs', runs: 5, pending: 47 });
    expect(h.writes).toHaveLength(0);
    const second = await runPartyIndexSweep(options(), h.seams);
    expect(second).toMatchObject({ status: 'complete', runs: 52 });
    expect(h.writes).toHaveLength(1);
  });

  it('the run cap counts this session, so a re-run with the same cap resumes and finishes the sweep', async () => {
    const h = harness(runner(quiet()));
    let result = await runPartyIndexSweep(options({ maxRuns: 5 }), h.seams);
    const pauses: number[] = [];
    for (let session = 0; result.status === 'paused' && session < 20; session += 1) {
      pauses.push(result.runs);
      result = await runPartyIndexSweep(options({ maxRuns: 5 }), h.seams);
    }
    expect(pauses).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
    expect(result).toMatchObject({ status: 'complete', runs: 52 });
    expect(h.writes).toHaveLength(1);
  });

  it('a fresh run ignores the saved progress and starts from A again', async () => {
    const calls: Array<{ kind: PanePartyKind; name: string }> = [];
    const h = harness(runner(quiet(), calls));
    await expect(runPartyIndexSweep(options({ kinds: ['company'], maxRuns: 2 }), h.seams)).resolves.toMatchObject({
      status: 'paused',
    });
    calls.length = 0;
    await runPartyIndexSweep(options({ kinds: ['company'], fresh: true }), h.seams);
    expect(calls[0]).toEqual({ kind: 'company', name: 'A' });
    expect(calls).toHaveLength(26);
  });
});

describe('the rate limit and the lock', () => {
  it('pauses for the delay between runs, but not after the last one', async () => {
    const h = harness(runner(quiet()));
    await runPartyIndexSweep(options({ kinds: ['company'], delayMs: 2000 }), h.seams);
    expect(h.delays).toHaveLength(25);
    expect(h.delays.every((ms) => ms === 2000)).toBe(true);
  });

  it('a busy property lock is retried after the retry wait, then the run goes on', async () => {
    const h = harness(runner(quiet()), 2);
    const result = await runPartyIndexSweep(options({ kinds: ['company'], lockRetries: 3, lockRetryMs: 700 }), h.seams);
    expect(result).toMatchObject({ status: 'complete', runs: 26 });
    expect(h.delays.filter((ms) => ms === 700)).toHaveLength(2);
  });

  it('a lock that stays busy past the retries stops the sweep with the lock reason, and keeps its place', async () => {
    const h = harness(runner(quiet()), 10);
    const stop = await runPartyIndexSweep(options({ kinds: ['company'], lockRetries: 2 }), h.seams).catch(
      (error: unknown) => error,
    );
    expect(stop).toBeInstanceOf(SweepStopped);
    expect((stop as SweepStopped).reason).toBe('lock_busy');
    expect(h.saved()!.queue[0]).toEqual({ kind: 'company', prefix: 'A' });
  });
});
