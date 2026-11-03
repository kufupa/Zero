import { describe, expect, it, vi } from 'vitest';
import { runLabtestAmendOnce } from '../src/ai/hms-labtest-amend-worker.js';
import { HMS_LABTEST_AMEND_PROMPT_VERSION, HMS_LABTEST_AMEND_RUN_DEADLINE_MS, labtestAmendWorkerEnabled } from '../src/ai/pane-cloud-amend-readiness.js';
import { claimNextAiRun, HMS_WRITE_RUN_KIND } from '../src/ai/run-ledger.js';
import type { DB } from '../src/db/client.js';

// Keep the pilot DB URL unset while exercising the ledger with a fake transaction.
vi.mock('../src/env.js', async (load) => ({
  ...await load<typeof import('../src/env.js')>(),
  parseEnv: () => ({ HMS_LANE_PAUSED: false, HMS_READ_SERVICE_ENABLED: false,
    AI_STALE_RUN_TIMEOUT_MS: 900_000, HMS_RUN_DEADLINE_MS: 150_000 }),
}));

const env = { PANE_HMS_LAB_AMEND_WORKER: 'on', PANE_WRITE_AMEND: 'lab' };

describe('dedicated Labtest amend worker', () => {
  it('extends only the amend claim budget and preserves any existing earlier deadline', async () => {
    const now = new Date('2026-11-03T20:00:00Z');
    vi.stubEnv('HMS_DEV_GATE', 'off');
    try {
      const claim = async (promptVersion: string, lane: 'hms' | 'default', deadlineAt: Date | null) => {
        const candidate = { id: 'run', runKind: HMS_WRITE_RUN_KIND, executorLane: lane, promptVersion,
          state: 'queued', deadlineAt, readRequest: null, metrics: null };
        const selected = { from: () => selected, where: () => selected, orderBy: () => selected,
          limit: () => selected, for: async () => [candidate] };
        const tx = { select: () => selected, update: () => ({ set: (values: object) => ({
          where: () => ({ returning: async () => [{ ...candidate, ...values }] }),
        }) }) };
        const db = { transaction: async (run: (inner: typeof tx) => Promise<unknown>) => run(tx) } as unknown as DB;
        return claimNextAiRun({ ownerId: 'worker', lane, runKind: HMS_WRITE_RUN_KIND, promptVersion, db, now });
      };
      const extended = await claim(HMS_LABTEST_AMEND_PROMPT_VERSION, 'hms', null);
      expect(extended?.deadlineAt).toEqual(new Date(now.getTime() + HMS_LABTEST_AMEND_RUN_DEADLINE_MS));
      const earlier = new Date(now.getTime() + 60_000);
      expect((await claim(HMS_LABTEST_AMEND_PROMPT_VERSION, 'hms', earlier))?.deadlineAt).toEqual(earlier);
      expect((await claim('hms-write/other', 'hms', null))?.deadlineAt).toEqual(new Date(now.getTime() + 150_000));
      expect((await claim(HMS_LABTEST_AMEND_PROMPT_VERSION, 'default', null))?.deadlineAt)
        .toEqual(new Date(now.getTime() + 150_000));
    } finally { vi.unstubAllEnvs(); }
  });

  it('requires both exact Labtest flags and a recovered worker before claiming', async () => {
    const claim = vi.fn<typeof claimNextAiRun>(async () => null);
    for (const flags of [{}, { ...env, PANE_WRITE_AMEND: 'on' }, { ...env, PANE_HMS_LAB_AMEND_WORKER: 'off' }]) {
      expect(labtestAmendWorkerEnabled(flags)).toBe(false);
      expect(await runLabtestAmendOnce({ ownerId: 'worker', env: flags, claim })).toBe(false);
    }
    expect(await runLabtestAmendOnce({ ownerId: 'worker', env, claim,
      recovery: { mayClaim: async () => false } })).toBe(false);
    expect(await runLabtestAmendOnce({ ownerId: 'worker', env, claim, signal: AbortSignal.abort() })).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it('claims only the amend prompt and passes its exact lease to the runner', async () => {
    const claimed = { id: 'run', claimOwner: 'worker', claimToken: 'token',
      deadlineAt: new Date('2027-01-01T00:00:00Z') } as Awaited<ReturnType<typeof claimNextAiRun>>;
    const claim = vi.fn<typeof claimNextAiRun>(async () => claimed);
    const run = vi.fn(async () => ({ status: 'lease_lost' as const }));
    expect(await runLabtestAmendOnce({ ownerId: 'worker', env, claim, run })).toBe(true);
    expect(claim).toHaveBeenCalledWith({ ownerId: 'worker', lane: 'hms', runKind: HMS_WRITE_RUN_KIND,
      promptVersion: HMS_LABTEST_AMEND_PROMPT_VERSION });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run', fence: {
      runId: 'run', claimOwner: 'worker', claimToken: 'token', deadlineAt: claimed!.deadlineAt,
    } }));
  });

  it('never executes an unusable claim or retries a failed runner', async () => {
    const claimed = { id: 'run', claimOwner: null, claimToken: null, deadlineAt: null } as Awaited<ReturnType<typeof claimNextAiRun>>;
    const claim = vi.fn<typeof claimNextAiRun>(async () => claimed);
    const run = vi.fn(async () => ({ status: 'lease_lost' as const }));
    expect(await runLabtestAmendOnce({ ownerId: 'worker', env, claim, run })).toBe(true);
    expect(run).not.toHaveBeenCalled();
    const usable = { id: 'run', claimOwner: 'worker', claimToken: 'token', deadlineAt: new Date() } as Awaited<ReturnType<typeof claimNextAiRun>>;
    claim.mockResolvedValueOnce(usable);
    run.mockRejectedValueOnce(new Error('runner failed'));
    await expect(runLabtestAmendOnce({ ownerId: 'worker', env, claim, run })).rejects.toThrow('runner failed');
    expect(claim).toHaveBeenCalledTimes(2);
  });
});
