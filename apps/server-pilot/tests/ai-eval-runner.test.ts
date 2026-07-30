import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSpikeEval } from '../src/ai/eval-runner.js';
import { applyDurableTriageResult } from '../src/ai/triage.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('AI eval runner', () => {
  it('loads demo fixtures with expected hotel labels', () => {
    const demo = JSON.parse(
      readFileSync(join(here, 'fixtures/ai-spike/centurion-demo.json'), 'utf8'),
    ) as { cases: Array<{ expectedCategory: string }> };
    const categories = demo.cases.map((testCase) => testCase.expectedCategory);
    expect(categories).toEqual(
      expect.arrayContaining(['spam', 'groups-events', 'new-bookings', 'ops']),
    );
  });

  it('ordinary new-bookings defaults to urgent=false', async () => {
    const report = await runSpikeEval();
    const ordinary = report.failures.filter((failure) =>
      failure.id === 'travel-agent' || failure.id === 'travel-agent-normal',
    );
    expect(ordinary).toEqual([]);
    expect(report.failures.some((failure) => /urgent=true/.test(failure.reason))).toBe(false);
  });

  it('explicit fixture urgency wins for urgent new-bookings and group-urgent', async () => {
    const report = await runSpikeEval();
    expect(report.failures.find((failure) => failure.id === 'individual-booking')).toBeUndefined();
    expect(report.failures.find((failure) => failure.id === 'group-urgent')).toBeUndefined();
  });

  it('spike passes only with zero failures', async () => {
    const report = await runSpikeEval();
    expect(report.metrics.failedCases).toBe(0);
    expect(report.failures).toHaveLength(0);
    expect(report.passed).toBe(true);
    expect(report.writeGateEnabled).toBe(true);
  });

  it('red-team fixtures fail safe', async () => {
    const report = await runSpikeEval();
    const redteamFailures = report.failures.filter((failure) =>
      failure.id.startsWith('prompt-injection') || failure.id.startsWith('forbidden-send'),
    );
    expect(redteamFailures).toHaveLength(0);
  });

  it('spike gate blocks durable writes when gate fails', async () => {
    const writes: string[] = [];
    const db = {
      update: () => ({
        set: () => ({
          where: async () => {
            writes.push('thread');
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
      delete: () => ({
        where: async () => undefined,
      }),
      insert: () => ({
        values: async () => undefined,
      }),
    };

    await applyDurableTriageResult({
      db: db as never,
      transportId: 't1',
      threadId: 'th1',
      writeGateEnabled: false,
      output: {
        category: 'spam',
        urgent: false,
        confidence: 0.9,
        rationale: 'test',
        policyFlags: [],
      },
    });
    expect(writes).toHaveLength(0);
  });

  it('spike gate enables write gate when all fixtures pass', async () => {
    const report = await runSpikeEval();
    expect(report.passed).toBe(true);
    expect(report.writeGateEnabled).toBe(true);
    expect(report.traceIds.length).toBeGreaterThan(0);
    expect(report.scorerIds.length).toBeGreaterThan(0);
  });

  it('includes draft skeleton and failure safety eval cases', async () => {
    const report = await runSpikeEval();
    expect(report.metrics.totalCases).toBeGreaterThanOrEqual(8);
    expect(report.metrics.draftSchemaCases).toBeGreaterThanOrEqual(1);
    expect(report.metrics.failureSafetyCases).toBeGreaterThanOrEqual(1);
    expect(report.failures.find((failure) => failure.id.includes('draft-skeleton'))).toBeUndefined();
    expect(report.failures.find((failure) => failure.id.includes('failure-no-mutation'))).toBeUndefined();
  });
});
