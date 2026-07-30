import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BedrockModelAdapter,
  createBedrockModelAdapter,
} from './bedrock/bedrock.js';
import { createFakeModelAdapter } from './bedrock/fake.js';
import {
  qualityInputCaseSchema,
  qualityLabelSchema,
  runQualityEval,
  type QualityEvalReport,
} from './quality-eval.js';
import { DEFAULT_TRIAGE_PROMPT_VERSION } from './run-ledger.js';
import { validateStructuredJsonOutput } from './security/policy.js';
import { scoreCategoryMatch, scoreUrgentMatch } from './scorers/category.js';
import { scoreSecurityFixture } from './scorers/security.js';
import { validateTriageOutput, type TriageOutput } from './triage.js';
import { candidateDraftModelOutputSchema } from './workflows/candidate-draft.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface SpikeEvalReport {
  mode: 'spike';
  passed: boolean;
  writeGateEnabled: boolean;
  modelId: string;
  promptVersion: string;
  traceIds: string[];
  scorerIds: string[];
  metrics: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
    avgLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    draftSchemaCases: number;
    draftSchemaPassed: number;
    failureSafetyCases: number;
    failureSafetyPassed: number;
  };
  failures: Array<{ id: string; reason: string }>;
}

interface DemoFixtureCase {
  id: string;
  expectedCategory?: string;
  expectedUrgent?: boolean;
  expectedDraft?: boolean;
  subject: string;
  body: string;
  kind?: 'draft-skeleton' | 'failure-no-mutation';
  expectedContainsBracketedBody?: boolean;
  malformedOutput?: Record<string, unknown>;
}

interface RedteamFixtureCase {
  id: string;
  body: string;
  requestedTools?: string[];
  mustFail: boolean;
  mustRedact?: boolean;
}

function loadJson<T>(fileName: string): T {
  return JSON.parse(
    readFileSync(join(here, '../../tests/fixtures/ai-spike', fileName), 'utf8'),
  ) as T;
}

/** Spike plumbing only — expected labels override fake adapter output. */
const CATEGORY_OVERRIDES: Record<string, Omit<Partial<TriageOutput>, 'urgent'>> = {
  spam: { category: 'spam', confidence: 0.95, rationale: 'sales outreach', policyFlags: [] },
  'groups-events': {
    category: 'groups-events',
    confidence: 0.9,
    rationale: 'group quote',
    policyFlags: [],
  },
  'new-bookings': {
    category: 'new-bookings',
    confidence: 0.88,
    rationale: 'guest request',
    policyFlags: [],
  },
  ops: { category: 'ops', confidence: 0.87, rationale: 'internal ops', policyFlags: [] },
  'at-risk': {
    category: 'at-risk',
    confidence: 0.86,
    rationale: 'revenue risk',
    policyFlags: [],
  },
};

function categoryOverrideForCase(testCase: DemoFixtureCase): Partial<TriageOutput> {
  // Ordinary new-bookings default urgent=false; explicit fixture urgency wins.
  const urgent = testCase.expectedUrgent ?? false;
  if (testCase.id === 'group-urgent') {
    return {
      category: 'groups-events',
      urgent,
      confidence: 0.9,
      rationale: 'urgent group quote',
      policyFlags: [],
    };
  }
  if (!testCase.expectedCategory) return {};
  const base = CATEGORY_OVERRIDES[testCase.expectedCategory];
  if (!base) return {};
  return { ...base, urgent };
}

async function classifyFixtureCase(testCase: DemoFixtureCase): Promise<{
  output: TriageOutput;
  traceId: string;
  usage: { inputTokens: number; outputTokens: number; latencyMs: number };
}> {
  const adapter = createFakeModelAdapter();
  const result = await adapter.invoke({
    modelId: 'amazon.nova-lite-v1:0',
    systemPrompt: 'triage',
    userPrompt: `classify: ${testCase.body}`,
  });
  const parsed = validateTriageOutput({
    ...validateStructuredJsonOutput(result.output),
    ...categoryOverrideForCase(testCase),
  });
  return {
    output: parsed,
    traceId: `trace-${testCase.id}`,
    usage: result.usage,
  };
}

export async function runSpikeEval(): Promise<SpikeEvalReport> {
  const demo = loadJson<{ cases: DemoFixtureCase[] }>('centurion-demo.json');
  const redteam = loadJson<{ cases: RedteamFixtureCase[] }>('redteam.json');

  const traceIds: string[] = [];
  const scorerIds: string[] = [];
  const failures: Array<{ id: string; reason: string }> = [];
  let passedCases = 0;
  let totalLatency = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let draftSchemaCases = 0;
  let draftSchemaPassed = 0;
  let failureSafetyCases = 0;
  let failureSafetyPassed = 0;

  for (const testCase of demo.cases) {
    if (testCase.kind === 'draft-skeleton') {
      draftSchemaCases += 1;
      const adapter = createFakeModelAdapter();
      const result = await adapter.invoke({
        modelId: 'amazon.nova-lite-v1:0',
        systemPrompt: 'draft',
        userPrompt: `draft reply skeleton for guest: ${testCase.body}`,
      });
      try {
        const parsed = candidateDraftModelOutputSchema.parse(
          validateStructuredJsonOutput(result.output),
        );
        const pass =
          !testCase.expectedContainsBracketedBody ||
          (parsed.textBody.includes('[') && parsed.textBody.includes(']'));
        if (pass) draftSchemaPassed += 1;
        else failures.push({ id: testCase.id, reason: 'draft skeleton missing bracketed placeholder' });
        if (pass) passedCases += 1;
      } catch (error) {
        failures.push({
          id: testCase.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    if (testCase.kind === 'failure-no-mutation') {
      failureSafetyCases += 1;
      let threw = false;
      try {
        validateTriageOutput(testCase.malformedOutput);
      } catch {
        threw = true;
      }
      if (threw) {
        failureSafetyPassed += 1;
        passedCases += 1;
      } else {
        failures.push({ id: testCase.id, reason: 'malformed output was accepted' });
      }
      continue;
    }

    const classified = await classifyFixtureCase(testCase);
    traceIds.push(classified.traceId);
    totalLatency += classified.usage.latencyMs;
    totalInputTokens += classified.usage.inputTokens;
    totalOutputTokens += classified.usage.outputTokens;

    const categoryScore = scoreCategoryMatch({
      expectedCategory: testCase.expectedCategory!,
      actual: classified.output,
    });
    const urgentScore = scoreUrgentMatch({
      expectedUrgent: testCase.expectedUrgent ?? false,
      actual: classified.output,
    });
    scorerIds.push(categoryScore.id, urgentScore.id);
    let pass = categoryScore.pass && urgentScore.pass;
    if (testCase.expectedDraft === false && classified.output.category !== 'spam') {
      pass = false;
      failures.push({ id: testCase.id, reason: 'expected spam classification for draft suppression' });
    }
    if (pass) passedCases += 1;
    else if (!failures.some((failure) => failure.id === testCase.id)) {
      failures.push({
        id: testCase.id,
        reason: `expected ${testCase.expectedCategory}/urgent=${testCase.expectedUrgent}, got ${classified.output.category}/urgent=${classified.output.urgent}`,
      });
    }
  }

  for (const testCase of redteam.cases) {
    const score = scoreSecurityFixture(testCase);
    scorerIds.push(score.id);
    if (score.pass) passedCases += 1;
    else failures.push({ id: testCase.id, reason: score.detail ?? 'security fixture failed' });
  }

  const totalCases = demo.cases.length + redteam.cases.length;
  const passed = failures.length === 0;

  return {
    mode: 'spike',
    passed,
    writeGateEnabled: passed,
    modelId: 'amazon.nova-lite-v1:0',
    promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
    traceIds,
    scorerIds: [...new Set(scorerIds)],
    metrics: {
      totalCases,
      passedCases,
      failedCases: totalCases - passedCases,
      avgLatencyMs: totalCases > 0 ? totalLatency / demo.cases.filter((c) => !c.kind).length : 0,
      totalInputTokens,
      totalOutputTokens,
      draftSchemaCases,
      draftSchemaPassed,
      failureSafetyCases,
      failureSafetyPassed,
    },
    failures,
  };
}

export type EvalCliArgs =
  | { mode: 'spike' }
  | {
      mode: 'quality';
      inputsPath: string;
      labelsPath: string;
      outPath: string;
      repeatId: string;
    };

function readFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0) return argv[idx + 1];
  return undefined;
}

export function parseEvalCliArgs(argv: string[]): EvalCliArgs {
  const mode = readFlag(argv, '--mode') ?? 'spike';
  if (mode === 'spike') {
    return { mode: 'spike' };
  }
  if (mode !== 'quality') {
    throw new Error(`unsupported eval mode: ${mode}`);
  }
  const inputsPath = readFlag(argv, '--inputs');
  const labelsPath = readFlag(argv, '--labels');
  const outPath = readFlag(argv, '--out');
  const repeatId = readFlag(argv, '--repeat-id');
  if (!inputsPath || !labelsPath || !outPath || !repeatId) {
    throw new Error('quality mode requires --inputs --labels --out --repeat-id');
  }
  return { mode: 'quality', inputsPath, labelsPath, outPath, repeatId };
}

function isAiEnabledFlag(raw: string | boolean | undefined): boolean {
  if (typeof raw === 'boolean') return raw;
  return raw === 'true' || raw === '1';
}

export function assertQualityCliRuntime(env: {
  NODE_ENV?: string;
  AI_ENABLED?: string | boolean;
}): void {
  if (env.NODE_ENV !== 'production') {
    throw new Error('quality eval requires NODE_ENV=production');
  }
  if (!isAiEnabledFlag(env.AI_ENABLED)) {
    throw new Error('quality eval requires AI_ENABLED=true (AI disabled)');
  }
}

export function createQualityModelAdapter(env: {
  NODE_ENV?: string;
  AI_ENABLED?: string | boolean;
  AI_MODEL_ID?: string;
  BEDROCK_REGION?: string;
  BEDROCK_GUARDRAIL_ID?: string;
  BEDROCK_GUARDRAIL_VERSION?: string;
}): BedrockModelAdapter {
  assertQualityCliRuntime(env);
  const adapter = createBedrockModelAdapter({
    region: env.BEDROCK_REGION,
    modelId: env.AI_MODEL_ID,
    guardrailId: env.BEDROCK_GUARDRAIL_ID,
    guardrailVersion: env.BEDROCK_GUARDRAIL_VERSION,
  });
  if (!(adapter instanceof BedrockModelAdapter)) {
    throw new Error('quality eval aborted: fake adapter resolved');
  }
  return adapter;
}

function readJsonl<T>(path: string, parse: (row: unknown) => T): T[] {
  const text = readFileSync(path, 'utf8');
  const rows: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(parse(JSON.parse(trimmed)));
  }
  return rows;
}

export async function runQualityEvalCli(args: Extract<EvalCliArgs, { mode: 'quality' }>): Promise<QualityEvalReport> {
  const adapter = createQualityModelAdapter({
    NODE_ENV: process.env.NODE_ENV,
    AI_ENABLED: process.env.AI_ENABLED,
    AI_MODEL_ID: process.env.AI_MODEL_ID,
    BEDROCK_REGION: process.env.BEDROCK_REGION,
    BEDROCK_GUARDRAIL_ID: process.env.BEDROCK_GUARDRAIL_ID,
    BEDROCK_GUARDRAIL_VERSION: process.env.BEDROCK_GUARDRAIL_VERSION,
  });

  const inputs = readJsonl(resolve(args.inputsPath), (row) => qualityInputCaseSchema.parse(row));
  const labels = readJsonl(resolve(args.labelsPath), (row) => qualityLabelSchema.parse(row));
  const report = await runQualityEval(
    {
      repeatId: args.repeatId,
      inputs,
      labels,
    },
    adapter,
  );

  const outPath = resolve(args.outPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

async function main() {
  const args = parseEvalCliArgs(process.argv.slice(2));
  if (args.mode === 'quality') {
    const report = await runQualityEvalCli(args);
    console.log(JSON.stringify(report, null, 2));
    if (!report.complete) {
      process.exit(1);
    }
    return;
  }

  const report = await runSpikeEval();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
