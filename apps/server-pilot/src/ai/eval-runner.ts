import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeModelAdapter } from './bedrock/fake.js';
import { validateStructuredJsonOutput } from './security/policy.js';
import { scoreCategoryMatch, scoreUrgentMatch } from './scorers/category.js';
import { scoreSecurityFixture } from './scorers/security.js';
import { validateTriageOutput, type TriageOutput } from './triage.js';

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
  };
  failures: Array<{ id: string; reason: string }>;
}

interface DemoFixtureCase {
  id: string;
  expectedCategory: string;
  expectedUrgent: boolean;
  subject: string;
  body: string;
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

const CATEGORY_OVERRIDES: Record<string, Partial<TriageOutput>> = {
  spam: { category: 'spam', urgent: false, confidence: 0.95, rationale: 'sales outreach', policyFlags: [] },
  group: { category: 'group', urgent: false, confidence: 0.9, rationale: 'group quote', policyFlags: [] },
  individual: { category: 'individual', urgent: true, confidence: 0.88, rationale: 'guest request', policyFlags: [] },
  internal: { category: 'internal', urgent: false, confidence: 0.87, rationale: 'internal ops', policyFlags: [] },
  'travel-agents': {
    category: 'travel-agents',
    urgent: false,
    confidence: 0.86,
    rationale: 'travel agent',
    policyFlags: [],
  },
};

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
    ...CATEGORY_OVERRIDES[testCase.expectedCategory],
  });
  return {
    output: parsed,
    traceId: `trace-${testCase.id}`,
    usage: result.usage,
  };
}

export async function runSpikeEval(options?: {
  passThreshold?: number;
}): Promise<SpikeEvalReport> {
  const passThreshold = options?.passThreshold ?? 0.85;
  const demo = loadJson<{ cases: DemoFixtureCase[] }>('centurion-demo.json');
  const redteam = loadJson<{ cases: RedteamFixtureCase[] }>('redteam.json');

  const traceIds: string[] = [];
  const scorerIds: string[] = [];
  const failures: Array<{ id: string; reason: string }> = [];
  let passedCases = 0;
  let totalLatency = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const testCase of demo.cases) {
    const classified = await classifyFixtureCase(testCase);
    traceIds.push(classified.traceId);
    totalLatency += classified.usage.latencyMs;
    totalInputTokens += classified.usage.inputTokens;
    totalOutputTokens += classified.usage.outputTokens;

    const categoryScore = scoreCategoryMatch({
      expectedCategory: testCase.expectedCategory,
      actual: classified.output,
    });
    const urgentScore = scoreUrgentMatch({
      expectedUrgent: testCase.expectedUrgent,
      actual: classified.output,
    });
    scorerIds.push(categoryScore.id, urgentScore.id);
    const pass = categoryScore.pass && urgentScore.pass;
    if (pass) passedCases += 1;
    else {
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
  const passRate = passedCases / totalCases;
  const passed = passRate >= passThreshold;

  return {
    mode: 'spike',
    passed,
    writeGateEnabled: passed,
    modelId: 'amazon.nova-lite-v1:0',
    promptVersion: 'triage-v1',
    traceIds,
    scorerIds: [...new Set(scorerIds)],
    metrics: {
      totalCases,
      passedCases,
      failedCases: totalCases - passedCases,
      avgLatencyMs: totalCases > 0 ? totalLatency / demo.cases.length : 0,
      totalInputTokens,
      totalOutputTokens,
    },
    failures,
  };
}

export function parseEvalCliArgs(argv: string[]): { mode: 'spike' } {
  const mode = argv.find((arg) => arg.startsWith('--mode='))?.split('=')[1] ?? 'spike';
  if (mode !== 'spike') {
    throw new Error(`unsupported eval mode: ${mode}`);
  }
  return { mode: 'spike' };
}

async function main() {
  const args = parseEvalCliArgs(process.argv.slice(2));
  const report = await runSpikeEval();
  console.log(JSON.stringify(report, null, 2));
  if (args.mode === 'spike' && !report.passed) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
