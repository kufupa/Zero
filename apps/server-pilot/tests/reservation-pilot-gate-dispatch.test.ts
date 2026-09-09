import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPilot = path.join(here, '..');
const repoRoot = path.join(serverPilot, '..', '..');
const gatePath = path.join(serverPilot, 'scripts', 'reservation-pilot-gate.sh');
const gateLibPath = path.join(serverPilot, 'scripts', 'reservation-pilot-gate-lib.mjs');

function runGate(mode: string, slice: string) {
  return spawnSync('bash', [gatePath, mode, slice], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      NAVA_TEST_DATABASE_PROFILE: 'pg16',
      NAVA_TEST_DATABASE_URL: undefined,
      CONFIRM_DISPOSABLE_TEST_DB: undefined,
      DATABASE_URL: undefined,
    },
    encoding: 'utf8',
  });
}

describe('candidate-drafting DB gate dispatch', () => {
  it('dispatches the library-known named tests instead of reaching unconditional PASS', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');

    expect(gate.getServerTestFiles('db', 'candidate-drafting')).toEqual([
      'tests/ai-candidate-draft-contract.test.ts',
      'tests/ai-worker-contract.test.ts',
    ]);
    expect(readFileSync(gatePath, 'utf8')).toContain('run_db_planned_slice candidate-drafting');

    const result = runGate('db', 'candidate-drafting');
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/NAVA_TEST_DATABASE_URL|disposable database/i);
    expect(output).not.toContain('reservation-pilot-gate: PASS mode=db slice=candidate-drafting');
  });

  it('rejects empty, failed, skipped, and missing Vitest reports', async () => {
    const gate = await import('../scripts/reservation-pilot-gate-lib.mjs');

    expect(
      gate.validateVitestReport({
        numTotalTests: 2,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        numSkippedTests: 0,
        testResults: [],
      }),
    ).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
    expect(() => gate.validateVitestReport({})).toThrow(/zero tests/i);
    expect(() =>
      gate.validateVitestReport({
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        numSkippedTests: 0,
        testResults: [{ assertionResults: [{ status: 'skipped' }] }],
      }),
    ).toThrow(/fully green|skipped/i);
    expect(() =>
      gate.validateVitestReport({
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 0,
        numTodoTests: 0,
        numSkippedTests: 0,
        testResults: [],
      }),
    ).toThrow(/fully green|failed/i);

    const missing = spawnSync(
      process.execPath,
      [
        gateLibPath,
        'validate-vitest-report',
        path.join(serverPilot, 'tests', '__missing-vitest-report__.json'),
      ],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
      },
    );
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).toMatch(/missing|invalid/i);
  });

  it('serializes DB test files when cleanup uses relation-locking truncation', () => {
    const source = readFileSync(gatePath, 'utf8');
    const start = source.indexOf('run_db_slice()');
    const end = source.indexOf('run_db_planned_slice()');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain('--no-file-parallelism');
  });
});
