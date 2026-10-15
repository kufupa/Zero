import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareSemantics,
  type GoldGrade,
  type GoldOperation,
} from './same-move-ops.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAME_MOVE_FIXTURES_DIR = path.resolve(here, '../../evals/same-move/fixtures');

const MAIL_PII_KEYS = new Set([
  'textBody',
  'htmlBody',
  'body',
  'bodySnippet',
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'rawMime',
  'eml',
]);

export type SameMoveScore = {
  grade: GoldGrade;
  mismatchReasons: string[];
  pass: boolean;
  score: number;
};

export type SameMoveFixture = {
  id: string;
  expectPass: boolean;
  predicted: GoldOperation[];
  claimed: GoldOperation[];
};

/** Joined ops JSONL row — same shape as a fixture. */
export type SameMoveOpsRow = SameMoveFixture;

export type SameMoveEvalCli = { mode: 'promptfoo' } | { mode: 'ops'; opsPath: string };

export type SameMoveOpsPairCount = {
  pair: string;
  n: number;
};

export type SameMoveOpsReport = {
  n: number;
  match: number;
  mismatch: number;
  not_scored: number;
  rate: number;
  grades: Record<GoldGrade, number>;
  claimedOps: Record<string, number>;
  predOps: Record<string, number>;
  pairTop: SameMoveOpsPairCount[];
};

export type SameMovePromptfooCase = {
  id: string;
  grade: GoldGrade;
  sameMovePass: boolean;
  harnessPass: boolean;
};

export type SameMovePromptfooReport = {
  sharing: false;
  remote: false;
  passed: boolean;
  cases: SameMovePromptfooCase[];
};

export function scoreSameMove(input: {
  predicted: readonly GoldOperation[];
  claimed: readonly GoldOperation[];
  predictionError?: string | null;
}): SameMoveScore {
  const { grade, mismatchReasons } = compareSemantics(
    input.predicted,
    input.claimed,
    input.predictionError ?? null,
  );
  const pass = grade === 'match';
  return { grade, mismatchReasons, pass, score: pass ? 1 : 0 };
}

function assertNoMailPii(value: unknown, trail: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoMailPii(item, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (MAIL_PII_KEYS.has(key)) {
      throw new Error(`same-move fixture ${trail} forbids mail field ${key}`);
    }
    assertNoMailPii(child, `${trail}.${key}`);
  }
}

function emptyGrades(): Record<GoldGrade, number> {
  return {
    match: 0,
    partial: 0,
    mismatch: 0,
    prediction_error: 0,
    unavailable: 0,
    not_scored: 0,
  };
}

function bumpCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function opsKey(ops: readonly GoldOperation[]): string {
  if (ops.length === 0) return 'none';
  return [...new Set(ops.map((row) => row.operation))].sort().join('+');
}

function parseOpsRow(raw: unknown, trail: string): SameMoveOpsRow {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`invalid same-move ops row ${trail}`);
  }
  const row = raw as SameMoveOpsRow;
  if (!row.id || !Array.isArray(row.predicted) || !Array.isArray(row.claimed)) {
    throw new Error(`invalid same-move ops row ${trail}`);
  }
  assertNoMailPii(row, row.id);
  return row;
}

export function parseSameMoveEvalCli(argv: readonly string[]): SameMoveEvalCli {
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--ops') {
      if (!value || value.startsWith('--')) {
        throw new Error('same-move --ops requires a jsonl path');
      }
      return { mode: 'ops', opsPath: path.resolve(value) };
    }
  }
  return { mode: 'promptfoo' };
}

export function loadSameMoveOpsJsonl(opsPath: string): SameMoveOpsRow[] {
  const lines = readFileSync(opsPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`no same-move ops rows in ${opsPath}`);
  return lines.map((line, index) => parseOpsRow(JSON.parse(line), `${opsPath}:${index + 1}`));
}

export function scoreSameMoveOps(rows: readonly SameMoveOpsRow[]): SameMoveOpsReport {
  const grades = emptyGrades();
  const claimedOps: Record<string, number> = {};
  const predOps: Record<string, number> = {};
  const pairCounts = new Map<string, number>();
  for (const row of rows) {
    const scored = scoreSameMove({
      predicted: row.predicted,
      claimed: row.claimed,
    });
    grades[scored.grade] += 1;
    for (const claimed of row.claimed) bumpCount(claimedOps, claimed.operation);
    for (const predicted of row.predicted) bumpCount(predOps, predicted.operation);
    const pair = `${opsKey(row.claimed)}→${opsKey(row.predicted)}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }
  const n = rows.length;
  const pairTop = [...pairCounts.entries()]
    .map(([pair, count]) => ({ pair, n: count }))
    .sort((left, right) => right.n - left.n || left.pair.localeCompare(right.pair))
    .slice(0, 10);
  return {
    n,
    match: grades.match,
    mismatch: grades.mismatch,
    not_scored: grades.not_scored,
    rate: n === 0 ? 0 : grades.match / n,
    grades,
    claimedOps,
    predOps,
    pairTop,
  };
}

export function runSameMoveOpsEval(opsPath: string): SameMoveOpsReport {
  return scoreSameMoveOps(loadSameMoveOpsJsonl(opsPath));
}

export function loadSameMoveFixtures(
  fixturesDir: string = SAME_MOVE_FIXTURES_DIR,
): SameMoveFixture[] {
  const files = readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`no same-move fixtures in ${fixturesDir}`);
  return files.map((name) => {
    const raw = JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as SameMoveFixture;
    if (!raw.id || !Array.isArray(raw.predicted) || !Array.isArray(raw.claimed)) {
      throw new Error(`invalid same-move fixture ${name}`);
    }
    assertNoMailPii(raw, raw.id);
    return raw;
  });
}

export function assertLocalOnlyPromptfooEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PROMPTFOO_SHARE === '1' || env.PROMPTFOO_SHARE === 'true') {
    throw new Error('same-move eval is local-only; do not share to Promptfoo Cloud');
  }
  env.PROMPTFOO_DISABLE_TELEMETRY = '1';
  env.PROMPTFOO_DISABLE_REMOTE_GENERATION = 'true';
  env.PROMPTFOO_SELF_HOSTED = 'true';
  env.LOG_LEVEL ??= 'error';
}

type PromptfooEvaluate = (
  config: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<unknown>;

function isPromptfooEvaluate(value: unknown): value is PromptfooEvaluate {
  return typeof value === 'function';
}

function readNamedEvaluate(value: unknown): PromptfooEvaluate | null {
  if (!value || typeof value !== 'object' || !('evaluate' in value)) return null;
  return isPromptfooEvaluate(value.evaluate) ? value.evaluate : null;
}

function readPromptfooEvaluate(mod: unknown): PromptfooEvaluate | null {
  const direct = readNamedEvaluate(mod);
  if (direct) return direct;
  if (!mod || typeof mod !== 'object' || !('default' in mod)) return null;
  return readNamedEvaluate(mod.default);
}

async function loadPromptfooEvaluate(): Promise<PromptfooEvaluate> {
  const evaluate = readPromptfooEvaluate(await import('promptfoo'));
  if (!evaluate) {
    throw new Error('promptfoo.evaluate missing; add promptfoo as a local MIT CLI devDependency');
  }
  return evaluate;
}

async function evaluateWithPromptfoo(fixtures: readonly SameMoveFixture[]): Promise<void> {
  const evaluate = await loadPromptfooEvaluate();
  const result = await evaluate(
    {
      description: 'same-move gold (ops JSON; local MIT CLI; no cloud)',
      sharing: false,
      prompts: ['same-move {{id}}'],
      providers: [
        {
          id: () => 'echo-predicted',
          callApi: async (_prompt: string, context: { vars?: Record<string, unknown> }) => ({
            output: context.vars?.predicted,
          }),
        },
      ],
      tests: fixtures.map((fixture) => ({
        vars: {
          id: fixture.id,
          predicted: fixture.predicted,
          claimed: fixture.claimed,
          expectPass: fixture.expectPass,
        },
        assert: [
          {
            type: 'javascript' as const,
            value: (output: unknown, context: { vars?: Record<string, unknown> }) => {
              const scored = scoreSameMove({
                predicted: output as GoldOperation[],
                claimed: (context.vars?.claimed ?? []) as GoldOperation[],
              });
              const expectPass = context.vars?.expectPass === true;
              const harnessPass = expectPass ? scored.pass : !scored.pass;
              return {
                pass: harnessPass,
                score: harnessPass ? 1 : 0,
                reason: scored.grade,
              };
            },
          },
        ],
      })),
    },
    {
      maxConcurrency: 1,
      showProgressBar: false,
      cache: false,
      writeLatestResults: false,
    },
  );
  if (result && typeof result === 'object' && 'shareableUrl' in result) {
    const url = (result as { shareableUrl?: unknown }).shareableUrl;
    if (url) throw new Error('promptfoo attempted to share results; local-only eval forbids sharing');
  }
}

export async function runSameMovePromptfooEval(options?: {
  fixturesDir?: string;
}): Promise<SameMovePromptfooReport> {
  assertLocalOnlyPromptfooEnv();
  const fixtures = loadSameMoveFixtures(options?.fixturesDir);
  const cases: SameMovePromptfooCase[] = fixtures.map((fixture) => {
    const scored = scoreSameMove({
      predicted: fixture.predicted,
      claimed: fixture.claimed,
    });
    const harnessPass = fixture.expectPass ? scored.pass : !scored.pass;
    return {
      id: fixture.id,
      grade: scored.grade,
      sameMovePass: scored.pass,
      harnessPass,
    };
  });
  await evaluateWithPromptfoo(fixtures);
  return {
    sharing: false,
    remote: false,
    passed: cases.every((row) => row.harnessPass),
    cases,
  };
}
