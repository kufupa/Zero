import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareSemantics,
  type GoldGrade,
  type GoldOperation,
} from '../../scripts/compare-centurion-human-gold.js';

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

async function loadPromptfooEvaluate(): Promise<PromptfooEvaluate> {
  const mod = (await import('promptfoo')) as {
    evaluate?: PromptfooEvaluate;
    default?: { evaluate?: PromptfooEvaluate };
  };
  const evaluate = mod.evaluate ?? mod.default?.evaluate;
  if (typeof evaluate !== 'function') {
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
