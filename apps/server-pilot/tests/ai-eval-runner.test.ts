import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertQualityCliRuntime,
  createQualityModelAdapter,
  parseEvalCliArgs,
  runSpikeEval,
} from '../src/ai/eval-runner.js';
import { BedrockModelAdapter } from '../src/ai/bedrock/bedrock.js';
import { AzureLunaModelAdapter } from '../src/ai/bedrock/luna.js';
import { applyDurableTriageResult } from '../src/ai/triage.js';

const here = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it('parses quality CLI args for inputs/labels/out/repeat-id', () => {
    const args = parseEvalCliArgs([
      '--mode=quality',
      '--inputs=../../.tmp/triage-quality/inputs.jsonl',
      '--labels=../../.tmp/triage-quality/labels.jsonl',
      '--out=../../.tmp/triage-quality/reports/report.json',
      '--repeat-id=baseline-1',
    ]);
    expect(args).toEqual({
      mode: 'quality',
      inputsPath: '../../.tmp/triage-quality/inputs.jsonl',
      labelsPath: '../../.tmp/triage-quality/labels.jsonl',
      outPath: '../../.tmp/triage-quality/reports/report.json',
      repeatId: 'baseline-1',
    });
  });

  it('quality CLI aborts unless production + AI enabled + Azure Luna by default', () => {
    expect(() =>
      assertQualityCliRuntime({
        NODE_ENV: 'test',
        AI_ENABLED: true,
      }),
    ).toThrow(/production/i);
    expect(() =>
      assertQualityCliRuntime({
        NODE_ENV: 'production',
        AI_ENABLED: false,
      }),
    ).toThrow(/AI_ENABLED|disabled/i);

    vi.stubEnv('AZURE_OPENAI_BASE_URL', 'https://example.invalid/openai/v1');
    vi.stubEnv('AZURE_FOUNDRY_API_KEY', 'test-key');
    const adapter = createQualityModelAdapter({
      NODE_ENV: 'production',
      AI_ENABLED: true,
    });
    expect(adapter).toBeInstanceOf(AzureLunaModelAdapter);
    expect(adapter).not.toBeInstanceOf(BedrockModelAdapter);

    const nova = createQualityModelAdapter({
      NODE_ENV: 'production',
      AI_ENABLED: true,
      AI_MODEL_ID: 'amazon.nova-lite-v1:0',
      BEDROCK_REGION: 'us-east-1',
      AI_TRIAGE_MODEL_PROFILE: 'nova_lite',
    });
    expect(nova).toBeInstanceOf(BedrockModelAdapter);

    vi.stubEnv('AZURE_OPENAI_BASE_URL', '');
    vi.stubEnv('AZURE_FOUNDRY_API_KEY', '');
    expect(() =>
      createQualityModelAdapter({
        NODE_ENV: 'production',
        AI_ENABLED: true,
      }),
    ).toThrow(/AZURE_OPENAI_BASE_URL|AZURE_FOUNDRY_API_KEY|refusing silent Bedrock fallback/i);

    const src = readFileSync(join(here, '../src/ai/eval-runner.ts'), 'utf8');
    expect(src).toMatch(/resolveModelAdapter/);
    expect(src).toMatch(/mode === 'quality'|mode=quality|mode: 'quality'/);
    expect(src).not.toMatch(/createFakeModelAdapter\(\).*quality|quality.*createFakeModelAdapter/);
  });

  it('parses hms-shadow CLI mode', async () => {
    expect(parseEvalCliArgs(['--mode=hms-shadow', '--denominators=evals/hms/denominators.v1.json'])).toEqual({
      mode: 'hms-shadow',
      denominators: 'evals/hms/denominators.v1.json',
    });
  });

  it('hms-shadow eval fails closed on empty denominator and scores fixed metrics', async () => {
    const { runHmsShadowEval } = await import('../src/ai/eval-runner.js');
    const empty = await runHmsShadowEval({
      denominatorsPath: 'evals/hms/does-not-exist.json',
    });
    expect(empty.passed).toBe(false);
    expect(empty.hardGates.denominatorNonEmpty).toBe(false);

    const ok = await runHmsShadowEval({
      denominatorsPath: 'evals/hms/denominators.v1.json',
    });
    expect(ok.mode).toBe('hms-shadow');
    expect(ok.denominatorVersion).toBe(1);
    expect(ok.metrics.denominatorSize).toBeGreaterThan(0);
    expect(ok.hardGates.partialNeverScoresFull).toBe(true);
    expect(ok.hardGates.zeroInventedFacts).toBe(true);
    expect(ok.hardGates.zeroFalseCandidates).toBe(true);
    expect(ok.passed).toBe(true);
    expect(ok.metrics.strictFullRate + ok.metrics.usefulPartialRate).toBeLessThanOrEqual(1);
  });
});
