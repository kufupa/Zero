import { z } from 'zod';
import type { ModelAdapter } from './bedrock/adapter.js';
import {
  assertTriageAsOf,
  buildCausalTriageMessages,
  hashTriageInput,
  hashTriagePrompt,
  type TriageInput,
  type TriageMessageRow,
} from './triage-input.js';
import {
  TRIAGE_CATEGORIES,
  toLegacyTriageOutput,
  type TriageCategory,
  type TriageOutput,
  type WorkflowTriageOutput,
} from './triage.js';
import { buildSystemPrompt, classifyWorkflowMailTriage } from './workflows/mail-triage.js';

export const QUALITY_TAGS = [
  'group',
  'voucher',
  'forward',
  'calendar',
  'integration',
  'urgency',
  'spam',
] as const;

export const AS_OF_SOURCES = [
  'normal-run-created-at',
  'message-created-at',
  'frozen-manifest',
] as const;

export const qualityLabelSchema = z.object({
  triggerMessageId: z.string().min(1),
  asOf: z.string().datetime(),
  asOfSource: z.enum(AS_OF_SOURCES),
  expectedCategory: z.enum(TRIAGE_CATEGORIES),
  expectedUrgent: z.boolean(),
  evidenceScope: z.enum(['text-visible', 'attachment-informed']),
  adjudication: z.enum(['locked', 'ambiguous']),
  policyReason: z.string().min(1),
  tags: z.array(z.enum(QUALITY_TAGS)),
});

export type QualityLabel = z.infer<typeof qualityLabelSchema>;

/**
 * Parses strict JSONL quality labels. One final LF or CRLF terminator is allowed
 * and does not create a blank record; every other blank line is rejected.
 */
export function parseQualityLabelsJsonl(jsonl: string): QualityLabel[] {
  if (jsonl.endsWith('\r')) {
    throw new Error('invalid quality label JSONL terminator');
  }

  const lines = jsonl.split(/\r?\n/);
  const recordLines = jsonl.endsWith('\n') ? lines.slice(0, -1) : lines;

  return recordLines.map((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === '') {
      throw new Error(`blank quality label JSONL line ${lineNumber}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSON in quality label JSONL line ${lineNumber}`);
    }

    const parsed = qualityLabelSchema.strict().safeParse(value);
    if (!parsed.success) {
      throw new Error(`invalid quality label JSONL line ${lineNumber}`);
    }
    return parsed.data;
  });
}

const qualityMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string(),
  subject: z.string().optional(),
  body: z.string(),
  direction: z.enum(['inbound', 'outbound']),
  createdAt: z.coerce.date(),
  receivedAt: z.coerce.date().nullable().optional(),
  sentAt: z.coerce.date().nullable().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
});

export const qualityInputCaseSchema = z.object({
  transportId: z.string().min(1),
  threadId: z.string().min(1),
  triggerMessageId: z.string().min(1),
  asOf: z.string().datetime({ offset: true }),
  asOfSource: z.enum(AS_OF_SOURCES),
  modelId: z.string().min(1),
  promptVersion: z.string().min(1),
  messages: z.array(qualityMessageSchema).min(1),
});

export type QualityInputCase = z.infer<typeof qualityInputCaseSchema>;

export interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface QualityCaseOutcome {
  caseId: string;
  triggerMessageId: string;
  sourceHash: string;
  promptHash?: string;
  inputHash?: string;
  status: 'complete' | 'incomplete';
  incompleteReason?: string;
  evidenceScope: QualityLabel['evidenceScope'];
  adjudication: QualityLabel['adjudication'];
  expectedCategory: TriageCategory;
  expectedUrgent: boolean;
  actualCategory?: TriageCategory;
  actualUrgent?: boolean;
  /** Canonical v6 output retained for workflow/apply harnesses. */
  actualWorkflow?: WorkflowTriageOutput;
  /** Diagnostic only — never used for scoring or release. */
  confidence?: number;
  categoryMatch?: boolean;
  urgentMatch?: boolean;
  jointMatch?: boolean;
  protectedRegression?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    latencyMs: number;
    estimatedCostUsd: number;
    rateTableVersion: string;
  };
}

export interface QualityEvalReport {
  mode: 'quality';
  repeatId: string;
  modelId: string;
  promptVersion: string;
  promptHash: string;
  complete: boolean;
  metrics: {
    totalCases: number;
    completeCases: number;
    incompleteCases: number;
    primaryTextVisibleCases: number;
    attachmentInformedCases: number;
    categoryErrors: number;
    urgentErrors: number;
    jointErrors: number;
    categoryAccuracy: number;
    perCategory: Record<TriageCategory, ClassMetrics>;
    confusion: Record<string, Record<string, number>>;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalEstimatedCostUsd: number;
    avgLatencyMs: number;
  };
  cases: QualityCaseOutcome[];
  protectedRegressions: Array<{ caseId: string; reason: string }>;
  failures: Array<{ id: string; reason: string }>;
}

export interface PairedComparisonReport {
  eligible: boolean;
  baselineBest: { categoryErrors: number; urgentErrors: number; jointErrors: number };
  candidateWorst: { categoryErrors: number; urgentErrors: number; jointErrors: number };
  protectedRegressions: Array<{ caseId: string; reason: string }>;
  caseIds: string[];
  sourceHashes: string[];
  disagreements: Array<{
    caseId: string;
    sourceHash: string;
    baselineCategories: Array<TriageCategory | undefined>;
    candidateCategories: Array<TriageCategory | undefined>;
  }>;
  reasons: string[];
}

export interface QualityEvalOptions {
  repeatId: string;
  inputs: QualityInputCase[];
  labels: QualityLabel[];
}

function toTriageInput(input: QualityInputCase): TriageInput {
  return {
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    asOf: assertTriageAsOf(input.asOf),
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    messages: input.messages.map((m) => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      body: m.body,
      direction: m.direction,
      createdAt: m.createdAt,
      receivedAt: m.receivedAt ?? null,
      sentAt: m.sentAt ?? null,
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
    })),
  };
}

export function hashQualitySource(input: QualityInputCase): string {
  const triage = toTriageInput(input);
  const causal = buildCausalTriageMessages(triage.messages, triage.triggerMessageId);
  return hashTriageInput({ ...triage, messages: causal });
}

function indexByTriggerId<T extends { triggerMessageId: string }>(
  rows: T[],
  kind: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (map.has(row.triggerMessageId)) {
      throw new Error(`duplicate ${kind} triggerMessageId: ${row.triggerMessageId}`);
    }
    map.set(row.triggerMessageId, row);
  }
  return map;
}

function alignInputsAndLabels(
  inputs: QualityInputCase[],
  labels: QualityLabel[],
): Array<{ input: QualityInputCase; label: QualityLabel }> {
  const inputMap = indexByTriggerId(inputs, 'input');
  const labelMap = indexByTriggerId(labels, 'label');

  for (const id of inputMap.keys()) {
    if (!labelMap.has(id)) {
      throw new Error(`unmatched input: missing label for triggerMessageId ${id}`);
    }
  }
  for (const id of labelMap.keys()) {
    if (!inputMap.has(id)) {
      throw new Error(`unmatched label: missing input for triggerMessageId ${id}`);
    }
  }

  return [...inputMap.keys()]
    .sort()
    .map((id) => ({ input: inputMap.get(id)!, label: labelMap.get(id)! }));
}

function detectCausalLeakage(input: QualityInputCase): string | null {
  try {
    const causal = buildCausalTriageMessages(
      input.messages.map((m) => ({
        id: m.id,
        from: m.from,
        subject: m.subject,
        body: m.body,
        direction: m.direction,
        createdAt: m.createdAt,
        receivedAt: m.receivedAt ?? null,
        sentAt: m.sentAt ?? null,
        to: m.to,
        cc: m.cc,
        bcc: m.bcc,
      })),
      input.triggerMessageId,
    );
    if (causal.length !== input.messages.length) {
      return 'causal-leakage: input messages include rows after trigger';
    }
    const causalIds = new Set(causal.map((m) => m.id));
    for (const m of input.messages) {
      if (!causalIds.has(m.id)) {
        return 'causal-leakage: input messages include rows after trigger';
      }
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function classifyIncompleteReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/trigger message not found|missing trigger/i.test(message)) return 'missing-trigger';
  if (/not valid JSON|model output was not valid JSON|JSON/i.test(message)) return 'invalid-json';
  if (/Bedrock|adapter|AccessDenied|Throttling|ECONN|timeout|bedrock down/i.test(message)) {
    return 'adapter';
  }
  if (/invalid|enum|required|expected|validation|Zod|parse/i.test(message)) return 'schema';
  return `adapter: ${message}`;
}

function protectedRegressionFor(outcome: {
  label: QualityLabel;
  status: 'complete' | 'incomplete';
  incompleteReason?: string;
  actual?: TriageOutput;
  actualWorkflow?: WorkflowTriageOutput;
}): string | null {
  if (outcome.status === 'incomplete') {
    return `incomplete:${outcome.incompleteReason ?? 'unknown'}`;
  }
  const actual = outcome.actual!;
  const { label } = outcome;
  const actualIsSpam = outcome.actualWorkflow?.isSpam ?? actual.category === 'spam';
  if (label.expectedCategory !== 'spam' && actualIsSpam) {
    return 'legitimate-mail-marked-spam';
  }
  if (label.expectedCategory === 'at-risk' && actual.category !== 'at-risk') {
    return 'newly-wrong-at-risk';
  }
  if (
    label.expectedUrgent === true &&
    actual.urgent === false &&
    label.tags.includes('urgency')
  ) {
    return 'lost-explicit-urgency';
  }
  if (outcome.incompleteReason?.includes('causal-leakage')) {
    return 'causal-leakage';
  }
  return null;
}

function prf1(tp: number, fp: number, fn: number, support: number): ClassMetrics {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision: Number.isFinite(precision) ? precision : 0,
    recall: Number.isFinite(recall) ? recall : 0,
    f1: Number.isFinite(f1) ? f1 : 0,
    support,
  };
}

function buildPerCategoryMetrics(
  primary: QualityCaseOutcome[],
): Record<TriageCategory, ClassMetrics> {
  const out = {} as Record<TriageCategory, ClassMetrics>;
  for (const cat of TRIAGE_CATEGORIES) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (const c of primary) {
      if (c.status !== 'complete') continue;
      if (c.expectedCategory === cat) support += 1;
      if (c.expectedCategory === cat && c.actualCategory === cat) tp += 1;
      if (c.expectedCategory !== cat && c.actualCategory === cat) fp += 1;
      if (c.expectedCategory === cat && c.actualCategory !== cat) fn += 1;
    }
    out[cat] = prf1(tp, fp, fn, support);
  }
  return out;
}

function buildConfusion(primary: QualityCaseOutcome[]): Record<string, Record<string, number>> {
  const confusion: Record<string, Record<string, number>> = {};
  for (const expected of TRIAGE_CATEGORIES) {
    confusion[expected] = {};
    for (const actual of TRIAGE_CATEGORIES) {
      confusion[expected]![actual] = 0;
    }
  }
  for (const c of primary) {
    if (c.status !== 'complete' || !c.actualCategory) continue;
    confusion[c.expectedCategory]![c.actualCategory] =
      (confusion[c.expectedCategory]![c.actualCategory] ?? 0) + 1;
  }
  return confusion;
}

export async function runQualityEval(
  options: QualityEvalOptions,
  adapter: ModelAdapter,
): Promise<QualityEvalReport> {
  const pairs = alignInputsAndLabels(
    options.inputs.map((row) => qualityInputCaseSchema.parse(row)),
    options.labels.map((row) => qualityLabelSchema.parse(row)),
  );

  const promptHash = hashTriagePrompt(buildSystemPrompt());
  const cases: QualityCaseOutcome[] = [];
  const protectedRegressions: Array<{ caseId: string; reason: string }> = [];
  const failures: Array<{ id: string; reason: string }> = [];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedCostUsd = 0;
  let totalLatencyMs = 0;
  let latencyN = 0;
  let modelId = pairs[0]?.input.modelId ?? '';
  let promptVersion = pairs[0]?.input.promptVersion ?? '';

  for (const { input, label } of pairs) {
    modelId = input.modelId;
    promptVersion = input.promptVersion;
    const caseId = input.triggerMessageId;
    let sourceHash = '';
    try {
      sourceHash = hashQualitySource(input);
    } catch {
      sourceHash = 'unhashed';
    }

    if (label.adjudication === 'ambiguous') {
      const outcome: QualityCaseOutcome = {
        caseId,
        triggerMessageId: caseId,
        sourceHash,
        status: 'incomplete',
        incompleteReason: 'ambiguous-label',
        evidenceScope: label.evidenceScope,
        adjudication: label.adjudication,
        expectedCategory: label.expectedCategory,
        expectedUrgent: label.expectedUrgent,
        protectedRegression: 'incomplete:ambiguous-label',
      };
      cases.push(outcome);
      protectedRegressions.push({ caseId, reason: outcome.protectedRegression! });
      continue;
    }

    const leakage = detectCausalLeakage(input);
    if (leakage) {
      const outcome: QualityCaseOutcome = {
        caseId,
        triggerMessageId: caseId,
        sourceHash,
        status: 'incomplete',
        incompleteReason: leakage,
        evidenceScope: label.evidenceScope,
        adjudication: label.adjudication,
        expectedCategory: label.expectedCategory,
        expectedUrgent: label.expectedUrgent,
        protectedRegression: 'causal-leakage',
      };
      cases.push(outcome);
      protectedRegressions.push({ caseId, reason: 'causal-leakage' });
      continue;
    }

    try {
      const classification = await classifyWorkflowMailTriage(
        toTriageInput(input),
        adapter,
        input.promptVersion,
      );
      const actualWorkflow = classification.output;
      const actual = toLegacyTriageOutput(actualWorkflow);
      const categoryMatch = actual.category === label.expectedCategory;
      const urgentMatch = actual.urgent === label.expectedUrgent;
      const jointMatch = categoryMatch && urgentMatch;
      const outcome: QualityCaseOutcome = {
        caseId,
        triggerMessageId: caseId,
        sourceHash,
        promptHash: classification.promptHash,
        inputHash: classification.inputHash,
        status: 'complete',
        evidenceScope: label.evidenceScope,
        adjudication: label.adjudication,
        expectedCategory: label.expectedCategory,
        expectedUrgent: label.expectedUrgent,
        actualCategory: actual.category,
        actualUrgent: actual.urgent,
        actualWorkflow,
        confidence: actual.confidence,
        categoryMatch,
        urgentMatch,
        jointMatch,
        usage: classification.usage,
      };
      outcome.protectedRegression = protectedRegressionFor({
        label,
        status: 'complete',
        actual,
        actualWorkflow,
      });
      if (outcome.protectedRegression) {
        protectedRegressions.push({ caseId, reason: outcome.protectedRegression });
      }
      totalInputTokens += classification.usage.inputTokens;
      totalOutputTokens += classification.usage.outputTokens;
      totalEstimatedCostUsd += classification.usage.estimatedCostUsd;
      totalLatencyMs += classification.usage.latencyMs;
      latencyN += 1;
      cases.push(outcome);
    } catch (error) {
      const incompleteReason = classifyIncompleteReason(error);
      const outcome: QualityCaseOutcome = {
        caseId,
        triggerMessageId: caseId,
        sourceHash,
        promptHash,
        status: 'incomplete',
        incompleteReason,
        evidenceScope: label.evidenceScope,
        adjudication: label.adjudication,
        expectedCategory: label.expectedCategory,
        expectedUrgent: label.expectedUrgent,
        protectedRegression: `incomplete:${incompleteReason}`,
      };
      cases.push(outcome);
      protectedRegressions.push({ caseId, reason: outcome.protectedRegression! });
      failures.push({
        id: caseId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const primary = cases.filter(
    (c) => c.evidenceScope === 'text-visible' && c.adjudication === 'locked',
  );
  const primaryComplete = primary.filter((c) => c.status === 'complete');
  const categoryErrors = primaryComplete.filter((c) => !c.categoryMatch).length;
  const urgentErrors = primaryComplete.filter((c) => !c.urgentMatch).length;
  const jointErrors = primaryComplete.filter((c) => !c.jointMatch).length;
  const completeCases = cases.filter((c) => c.status === 'complete').length;
  const incompleteCases = cases.length - completeCases;

  return {
    mode: 'quality',
    repeatId: options.repeatId,
    modelId,
    promptVersion,
    promptHash,
    complete: incompleteCases === 0,
    metrics: {
      totalCases: cases.length,
      completeCases,
      incompleteCases,
      primaryTextVisibleCases: primary.length,
      attachmentInformedCases: cases.filter((c) => c.evidenceScope === 'attachment-informed')
        .length,
      categoryErrors,
      urgentErrors,
      jointErrors,
      categoryAccuracy:
        primaryComplete.length === 0 ? 0 : (primaryComplete.length - categoryErrors) / primaryComplete.length,
      perCategory: buildPerCategoryMetrics(primary),
      confusion: buildConfusion(primary),
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedCostUsd,
      avgLatencyMs: latencyN === 0 ? 0 : totalLatencyMs / latencyN,
    },
    cases,
    protectedRegressions,
    failures,
  };
}

export function compareQualityReports(input: {
  baseline: QualityEvalReport[];
  candidate: QualityEvalReport[];
}): PairedComparisonReport {
  if (input.baseline.length === 0 || input.candidate.length === 0) {
    throw new Error('baseline and candidate reports required');
  }

  const baselineBest = {
    categoryErrors: Math.min(...input.baseline.map((r) => r.metrics.categoryErrors)),
    urgentErrors: Math.min(...input.baseline.map((r) => r.metrics.urgentErrors)),
    jointErrors: Math.min(...input.baseline.map((r) => r.metrics.jointErrors)),
  };
  const candidateWorst = {
    categoryErrors: Math.max(...input.candidate.map((r) => r.metrics.categoryErrors)),
    urgentErrors: Math.max(...input.candidate.map((r) => r.metrics.urgentErrors)),
    jointErrors: Math.max(...input.candidate.map((r) => r.metrics.jointErrors)),
  };

  const caseIds = new Set<string>();
  const sourceHashes = new Set<string>();
  for (const report of [...input.baseline, ...input.candidate]) {
    for (const c of report.cases) {
      caseIds.add(c.caseId);
      sourceHashes.add(c.sourceHash);
    }
  }

  const disagreements: PairedComparisonReport['disagreements'] = [];
  for (const caseId of [...caseIds].sort()) {
    const baselineCats = input.baseline.map(
      (r) => r.cases.find((c) => c.caseId === caseId)?.actualCategory,
    );
    const candidateCats = input.candidate.map(
      (r) => r.cases.find((c) => c.caseId === caseId)?.actualCategory,
    );
    const baselineHash = input.baseline[0]?.cases.find((c) => c.caseId === caseId)?.sourceHash;
    const candidateHash = input.candidate[0]?.cases.find((c) => c.caseId === caseId)?.sourceHash;
    if (baselineHash && candidateHash && baselineHash !== candidateHash) {
      throw new Error(`sourceHash mismatch for case ${caseId}`);
    }
    const all = [...baselineCats, ...candidateCats];
    const uniq = new Set(all.map((v) => String(v)));
    if (uniq.size > 1) {
      disagreements.push({
        caseId,
        sourceHash: baselineHash ?? candidateHash ?? '',
        baselineCategories: baselineCats,
        candidateCategories: candidateCats,
      });
    }
  }

  const protectedRegressions = input.candidate.flatMap((r) => r.protectedRegressions);
  const reasons: string[] = [];
  if (candidateWorst.categoryErrors > baselineBest.categoryErrors) {
    reasons.push('categoryErrors worse than baseline best');
  }
  if (candidateWorst.urgentErrors > baselineBest.urgentErrors) {
    reasons.push('urgentErrors worse than baseline best');
  }
  if (!(candidateWorst.jointErrors < baselineBest.jointErrors)) {
    reasons.push('jointErrors not strictly lower than baseline best');
  }
  if (protectedRegressions.length > 0) {
    reasons.push('protected regressions present');
  }
  if (input.candidate.some((r) => !r.complete) || input.baseline.some((r) => !r.complete)) {
    reasons.push('incomplete report in pair');
  }

  return {
    eligible: reasons.length === 0,
    baselineBest,
    candidateWorst,
    protectedRegressions,
    caseIds: [...caseIds].sort(),
    sourceHashes: [...sourceHashes].sort(),
    disagreements,
    reasons,
  };
}

function compareMsgOrder(a: TriageMessageRow, b: TriageMessageRow): number {
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function serializeMessages(rows: TriageMessageRow[]): QualityInputCase['messages'] {
  return rows.map((m) => ({
    id: m.id,
    from: m.from,
    subject: m.subject,
    body: m.body,
    direction: m.direction,
    createdAt: m.createdAt,
    receivedAt: m.receivedAt,
    sentAt: m.sentAt,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
  }));
}

export function buildAllInboundExportCases(input: {
  transportId: string;
  threadId: string;
  messages: TriageMessageRow[];
  asOfByTriggerId: Record<
    string,
    { asOf: string; asOfSource: (typeof AS_OF_SOURCES)[number] }
  >;
  modelId: string;
  promptVersion: string;
}): QualityInputCase[] {
  const sorted = [...input.messages].sort(compareMsgOrder);
  const inbound = sorted.filter((m) => m.direction === 'inbound');
  return inbound.map((trigger) => {
    const asOfMeta = input.asOfByTriggerId[trigger.id];
    if (!asOfMeta) {
      throw new Error(`missing asOf for inbound trigger ${trigger.id}`);
    }
    const causal = buildCausalTriageMessages(sorted, trigger.id);
    return qualityInputCaseSchema.parse({
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: trigger.id,
      asOf: asOfMeta.asOf,
      asOfSource: asOfMeta.asOfSource,
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      messages: serializeMessages(causal),
    });
  });
}

export function buildLabelScopedExportCases(input: {
  transportId: string;
  threadId: string;
  messages: TriageMessageRow[];
  labels: QualityLabel[];
  modelId: string;
  promptVersion: string;
}): QualityInputCase[] {
  const sorted = [...input.messages].sort(compareMsgOrder);
  const out: QualityInputCase[] = [];
  for (const label of input.labels) {
    const causal = buildCausalTriageMessages(sorted, label.triggerMessageId);
    out.push(
      qualityInputCaseSchema.parse({
        transportId: input.transportId,
        threadId: input.threadId,
        triggerMessageId: label.triggerMessageId,
        asOf: label.asOf,
        asOfSource: label.asOfSource,
        modelId: input.modelId,
        promptVersion: input.promptVersion,
        messages: serializeMessages(causal),
      }),
    );
  }
  return out;
}

export function buildTargetsExportCases(input: {
  transportId: string;
  threadId: string;
  messages: TriageMessageRow[];
  triggerMessageId: string;
  generatedAt: string;
  modelId: string;
  promptVersion: string;
}): QualityInputCase[] {
  const sorted = [...input.messages].sort(compareMsgOrder);
  const causal = buildCausalTriageMessages(sorted, input.triggerMessageId);
  return [
    qualityInputCaseSchema.parse({
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
      asOf: input.generatedAt,
      asOfSource: 'frozen-manifest',
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      messages: serializeMessages(causal),
    }),
  ];
}

export type QualityExportCliArgs =
  | { mode: 'labels'; labelsPath: string; outPath: string; transportIds: readonly string[] }
  | { mode: 'all-inbound-triggers'; outPath: string; transportIds: readonly string[] }
  | { mode: 'targets'; targetsPath: string; outPath: string; transportIds: readonly string[] };

function sortedDistinctExportTransportIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
}

export function parseQualityExportArgs(argv: string[]): QualityExportCliArgs {
  let labelsPath: string | null = null;
  let targetsPath: string | null = null;
  let allInbound = false;
  let outPath: string | null = null;
  const transportIds: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--labels') {
      labelsPath = argv[++i] ?? null;
    } else if (arg.startsWith('--labels=')) {
      labelsPath = arg.slice('--labels='.length);
    } else if (arg === '--targets') {
      targetsPath = argv[++i] ?? null;
    } else if (arg.startsWith('--targets=')) {
      targetsPath = arg.slice('--targets='.length);
    } else if (arg === '--all-inbound-triggers') {
      allInbound = true;
    } else if (arg === '--transport-id') {
      const value = argv[++i];
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error('--transport-id requires a value');
      }
      transportIds.push(value.trim());
    } else if (arg.startsWith('--transport-id=')) {
      const value = arg.slice('--transport-id='.length);
      if (!value.trim()) {
        throw new Error('--transport-id requires a value');
      }
      transportIds.push(value.trim());
    } else if (arg === '--out') {
      outPath = argv[++i] ?? null;
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length);
    } else {
      throw new Error(`unknown export option: ${arg}`);
    }
  }

  const normalizedTransportIds = sortedDistinctExportTransportIds(transportIds);
  if (normalizedTransportIds.length === 0) {
    throw new Error('Quality export requires at least one --transport-id');
  }
  if (normalizedTransportIds.length !== transportIds.length) {
    throw new Error('Quality export transport scope is invalid');
  }
  for (let index = 0; index < transportIds.length; index += 1) {
    if (transportIds[index] !== normalizedTransportIds[index]) {
      throw new Error('Quality export transport scope is invalid');
    }
  }

  const scopes = [Boolean(labelsPath), allInbound, Boolean(targetsPath)].filter(Boolean).length;
  if (scopes !== 1) {
    throw new Error(
      'export scopes are mutually exclusive: pass exactly one of --labels, --all-inbound-triggers, --targets',
    );
  }
  if (!outPath) {
    throw new Error('--out is required');
  }
  if (labelsPath) {
    return { mode: 'labels', labelsPath, outPath, transportIds: normalizedTransportIds };
  }
  if (targetsPath) {
    return { mode: 'targets', targetsPath, outPath, transportIds: normalizedTransportIds };
  }
  return { mode: 'all-inbound-triggers', outPath, transportIds: normalizedTransportIds };
}
