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
      expect.arrayContaining(['spam', 'group', 'individual', 'internal', 'travel-agents']),
    );
  });

  it('red-team fixtures fail safe', async () => {
    const report = await runSpikeEval({ passThreshold: 0.01 });
    const redteamFailures = report.failures.filter((failure) =>
      failure.id.startsWith('prompt-injection') || failure.id.startsWith('forbidden-send'),
    );
    expect(redteamFailures).toHaveLength(0);
  });

  it('spike gate blocks durable writes when threshold fails', async () => {
    const report = await runSpikeEval({ passThreshold: 1.01 });
    expect(report.passed).toBe(false);
    expect(report.writeGateEnabled).toBe(false);

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
      writeGateEnabled: report.writeGateEnabled,
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

  it('spike gate enables write gate when threshold passes', async () => {
    const report = await runSpikeEval({ passThreshold: 0.8 });
    expect(report.passed).toBe(true);
    expect(report.writeGateEnabled).toBe(true);
    expect(report.traceIds.length).toBeGreaterThan(0);
    expect(report.scorerIds.length).toBeGreaterThan(0);
  });

  it('includes draft skeleton and failure safety eval cases', async () => {
    const report = await runSpikeEval({ passThreshold: 0.8 });
    expect(report.metrics.totalCases).toBeGreaterThanOrEqual(8);
    expect(report.metrics.draftSchemaCases).toBeGreaterThanOrEqual(1);
    expect(report.metrics.failureSafetyCases).toBeGreaterThanOrEqual(1);
    expect(report.failures.find((failure) => failure.id.includes('draft-skeleton'))).toBeUndefined();
    expect(report.failures.find((failure) => failure.id.includes('failure-no-mutation'))).toBeUndefined();
  });
});
