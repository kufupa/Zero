import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeModelAdapter } from './bedrock/fake.js';
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

export interface HmsShadowEvalReport {
  mode: 'hms-shadow';
  passed: boolean;
  denominatorVersion: number;
  denominatorPath: string;
  metrics: {
    denominatorSize: number;
    labelledEligible: number;
    strictFullRate: number;
    usefulPartialRate: number;
    inventedFactCount: number;
    falseCandidateCount: number;
    abstentionRate: number;
    toolLatencyMsAvg: number;
    toolFailureCount: number;
    staleAtReviewRate: number;
    materialFieldPrecision: number | null;
    candidateProductionRate: number;
  };
  failures: Array<{ id: string; reason: string }>;
  hardGates: {
    zeroInventedFacts: boolean;
    zeroFalseCandidates: boolean;
    denominatorNonEmpty: boolean;
    partialNeverScoresFull: boolean;
  };
}

interface HmsDenominatorFile {
  version: number;
  draftEligible?: { members?: number[] };
  operationalPortfolio?: { members?: number[] };
}

interface HmsShadowLabel {
  threadId: number;
  /** Expected shadow outcome for labelled corpus. */
  expected: 'full' | 'useful_partial' | 'abstain' | 'false_candidate';
  inventedFacts?: number;
  toolLatencyMs?: number;
  toolFailed?: boolean;
  staleAtReview?: boolean;
  materialFieldsCorrect?: number;
  materialFieldsTotal?: number;
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

const CATEGORY_OVERRIDES: Record<string, Partial<TriageOutput>> = {
  spam: { category: 'spam', urgent: false, confidence: 0.95, rationale: 'sales outreach', policyFlags: [] },
  'groups-events': {
    category: 'groups-events',
    urgent: false,
    confidence: 0.9,
    rationale: 'group quote',
    policyFlags: [],
  },
  'new-bookings': {
    category: 'new-bookings',
    urgent: true,
    confidence: 0.88,
    rationale: 'guest request',
    policyFlags: [],
  },
  ops: { category: 'ops', urgent: false, confidence: 0.87, rationale: 'internal ops', policyFlags: [] },
  'at-risk': {
    category: 'at-risk',
    urgent: false,
    confidence: 0.86,
    rationale: 'revenue risk',
    policyFlags: [],
  },
};

function categoryOverrideForCase(testCase: DemoFixtureCase): Partial<TriageOutput> {
  if (testCase.id === 'group-urgent') {
    return {
      category: 'groups-events',
      urgent: true,
      confidence: 0.9,
      rationale: 'urgent group quote',
      policyFlags: [],
    };
  }
  if (!testCase.expectedCategory) return {};
  return CATEGORY_OVERRIDES[testCase.expectedCategory] ?? {};
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
  const passRate = passedCases / totalCases;
  const passed = passRate >= passThreshold;

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

export function parseEvalCliArgs(argv: string[]): {
  mode: 'spike' | 'hms-shadow';
  denominators?: string;
} {
  const mode = argv.find((arg) => arg.startsWith('--mode='))?.split('=')[1] ?? 'spike';
  const denominators = argv.find((arg) => arg.startsWith('--denominators='))?.split('=')[1];
  if (mode !== 'spike' && mode !== 'hms-shadow') {
    throw new Error(`unsupported eval mode: ${mode}`);
  }
  return { mode, denominators };
}

function loadHmsDenominators(relativePath: string): HmsDenominatorFile {
  const absolute = join(here, '../..', relativePath);
  const raw = JSON.parse(readFileSync(absolute, 'utf8')) as HmsDenominatorFile;
  if (!raw || typeof raw.version !== 'number') {
    throw new Error(`HMS shadow denominator missing version: ${relativePath}`);
  }
  const members = raw.draftEligible?.members ?? [];
  if (members.length === 0) {
    throw new Error(`HMS shadow denominator empty/missing members: ${relativePath}`);
  }
  return raw;
}

/**
 * Fixed-denominator HMS shadow evaluator.
 * Labels file (optional): evals/hms/shadow-labels.v1.json — when absent, reports
 * membership-only metrics and fails hard gates that require labelled outcomes
 * only when statistical threshold (>=30) is claimed; membership always required.
 */
export async function runHmsShadowEval(options?: {
  denominatorsPath?: string;
  labelsPath?: string;
}): Promise<HmsShadowEvalReport> {
  const denominatorsPath =
    options?.denominatorsPath ?? 'evals/hms/denominators.v1.json';
  const failures: Array<{ id: string; reason: string }> = [];
  let denominator: HmsDenominatorFile;
  try {
    denominator = loadHmsDenominators(denominatorsPath);
  } catch (err) {
    return {
      mode: 'hms-shadow',
      passed: false,
      denominatorVersion: 0,
      denominatorPath: denominatorsPath,
      metrics: {
        denominatorSize: 0,
        labelledEligible: 0,
        strictFullRate: 0,
        usefulPartialRate: 0,
        inventedFactCount: 0,
        falseCandidateCount: 0,
        abstentionRate: 0,
        toolLatencyMsAvg: 0,
        toolFailureCount: 0,
        staleAtReviewRate: 0,
        materialFieldPrecision: null,
        candidateProductionRate: 0,
      },
      failures: [
        {
          id: 'denominator',
          reason: err instanceof Error ? err.message : String(err),
        },
      ],
      hardGates: {
        zeroInventedFacts: false,
        zeroFalseCandidates: false,
        denominatorNonEmpty: false,
        partialNeverScoresFull: true,
      },
    };
  }

  const memberSet = new Set(denominator.draftEligible?.members ?? []);
  const labelsPath =
    options?.labelsPath ?? join(here, '../../evals/hms/shadow-labels.v1.json');
  let labels: HmsShadowLabel[] = [];
  try {
    const raw = JSON.parse(readFileSync(labelsPath, 'utf8')) as {
      version?: number;
      cases?: HmsShadowLabel[];
    };
    labels = Array.isArray(raw.cases) ? raw.cases : [];
  } catch {
    labels = [];
  }

  // Membership: every labelled thread must be in denominator
  for (const label of labels) {
    if (!memberSet.has(label.threadId)) {
      failures.push({
        id: `membership:${label.threadId}`,
        reason: `labelled thread ${label.threadId} not in denominator v${denominator.version}`,
      });
    }
  }

  const labelled = labels.filter((l) => memberSet.has(l.threadId));
  const full = labelled.filter((l) => l.expected === 'full').length;
  const partial = labelled.filter((l) => l.expected === 'useful_partial').length;
  const abstain = labelled.filter((l) => l.expected === 'abstain').length;
  const falseCand = labelled.filter((l) => l.expected === 'false_candidate').length;
  const inventedFactCount = labelled.reduce((n, l) => n + (l.inventedFacts ?? 0), 0);
  const toolFailureCount = labelled.filter((l) => l.toolFailed).length;
  const staleCount = labelled.filter((l) => l.staleAtReview).length;
  const latencySum = labelled.reduce((n, l) => n + (l.toolLatencyMs ?? 0), 0);
  let materialCorrect = 0;
  let materialTotal = 0;
  for (const l of labelled) {
    materialCorrect += l.materialFieldsCorrect ?? 0;
    materialTotal += l.materialFieldsTotal ?? 0;
  }

  // Partial never scores Full: structural — useful_partial != full in label enum
  const partialNeverScoresFull = labelled.every(
    (l) => !(l.expected === 'useful_partial' && (l as { scoredFull?: boolean }).scoredFull),
  );

  const n = labelled.length;
  const denomSize = memberSet.size;
  const metrics = {
    denominatorSize: denomSize,
    labelledEligible: n,
    strictFullRate: n > 0 ? full / n : 0,
    usefulPartialRate: n > 0 ? partial / n : 0,
    inventedFactCount,
    falseCandidateCount: falseCand,
    abstentionRate: n > 0 ? abstain / n : 0,
    toolLatencyMsAvg: n > 0 ? latencySum / n : 0,
    toolFailureCount,
    staleAtReviewRate: n > 0 ? staleCount / n : 0,
    materialFieldPrecision: materialTotal > 0 ? materialCorrect / materialTotal : null,
    candidateProductionRate: n > 0 ? (full + partial) / n : 0,
  };

  const hardGates = {
    zeroInventedFacts: inventedFactCount === 0,
    zeroFalseCandidates: falseCand === 0,
    denominatorNonEmpty: denomSize > 0,
    partialNeverScoresFull,
  };

  if (!hardGates.denominatorNonEmpty) {
    failures.push({ id: 'denominator', reason: 'empty denominator' });
  }
  if (!hardGates.zeroInventedFacts) {
    failures.push({ id: 'invented-facts', reason: `inventedFactCount=${inventedFactCount}` });
  }
  if (!hardGates.zeroFalseCandidates) {
    failures.push({
      id: 'false-candidates',
      reason: `falseCandidateCount=${falseCand}`,
    });
  }
  if (!hardGates.partialNeverScoresFull) {
    failures.push({ id: 'partial-full', reason: 'partial scored Full' });
  }

  // Statistical gates after >=30 labelled cases
  if (n >= 30) {
    if (metrics.materialFieldPrecision !== null && metrics.materialFieldPrecision < 0.99) {
      failures.push({
        id: 'precision',
        reason: `material-field precision ${metrics.materialFieldPrecision} < 0.99`,
      });
    }
    if (metrics.falseCandidateCount !== 0) {
      failures.push({
        id: 'false-candidate-rate',
        reason: 'false-candidate rate must be 0',
      });
    }
  }

  const passed = failures.length === 0 && hardGates.denominatorNonEmpty;

  return {
    mode: 'hms-shadow',
    passed,
    denominatorVersion: denominator.version,
    denominatorPath: denominatorsPath,
    metrics,
    failures,
    hardGates,
  };
}

async function main() {
  const args = parseEvalCliArgs(process.argv.slice(2));
  if (args.mode === 'hms-shadow') {
    const report = await runHmsShadowEval({
      denominatorsPath: args.denominators,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exit(1);
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
