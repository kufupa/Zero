/**
 * Reservationist backtest on the operator's golden set (R20, U27).
 *
 *   check                          validate the set: 80 dev + 40 holdout, no sender domain over 15% of a split
 *   run [--target pane|extract|agent] [--subset 30] [--run-id]
 *                                  run one target, 8 in flight. pane: the Nava pane analysis (lunaAnalysisSchema).
 *                                  extract: the inbound mail extraction. Both use the production prompt, adapter and
 *                                  deadline and read no HMS. agent: the reservationist agent at medium reasoning,
 *                                  HMS quote/party reads replayed. Default pane.
 *   run --target extract --dataset FILE [--run-id ID]
 *                                  the label dataset from export-work-events-dataset.ts: each labelled case through the
 *                                  production extraction on its masked mail, with the mail's own message id. No golden
 *                                  set and no HMS.
 *   score --run-id ID              field-level accuracy per split and the overfit alarm (dev - holdout > 10 points).
 *                                  For a dataset run: the label gates (label-scorers.ts). Exit 1 when a gate fails.
 *   replay-ops --snapshot FILE --out FILE [--limit N] [--concurrency 4]
 *                                  offline replay of the production agent on a snapshot JSONL. Stub HMS runners
 *                                  (quote/party unavailable). Writes predicted GoldOperation JSONL. Ignores outbound.
 *
 * Input: apps/server-pilot/.private/reservationist-backtest/golden-set.jsonl (gitignored). It is not exported from
 * prod by this script; a missing file fails with the expected path. Traces and scores land in <run-id>/ beside it.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RequestContext } from '@mastra/core/request-context';
import { eq } from 'drizzle-orm';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import { extractInboundMail } from '../src/ai/extraction/extract.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../src/ai/quote-workflow-synced-selection.js';
import { getDb } from '../src/db/client.js';
import { mailboxTransport } from '../src/db/schema/mail.js';
import { createAzureLunaModel, lunaProviderOptions } from '../src/ai/bedrock/luna.js';
import {
  CENTURION_HOTEL_RULES,
  QUOTE_UNAVAILABLE,
  createDefaultRunners,
  createReservationistAgent,
  reservationistDecisionSchema,
  type ReservationistContext,
  type ReservationistDecision,
  type ReservationistRunners,
} from '../src/ai/reservationist-agent.js';
import {
  agentThreadPrompt,
  decisionToOperations,
  snapshotRowToAgentCase,
  type SnapshotRow,
} from '../src/ai/agent-decision-to-ops.js';
import { resolveAdapter } from '../src/ai/quote-workflow-analyse-selection.js';
import {
  BACKTEST_TARGETS,
  GOLDEN_TARGETS,
  cellOf,
  goldenMailbox,
  incompleteRunProblems,
  pickSubset,
  readGoldenSet,
  replayRunners,
  runCasesDigest,
  runProductionTarget,
  scoreGoldenCase,
  senderDomainOf,
  summarizeGolden,
  tally,
  validateGoldenSet,
  type BacktestTarget,
  type GoldenRow,
  type GoldenTrace,
  type ToolCall,
} from '../src/ai/reservationist-backtest.js';
import { fingerprint, validateRunId } from '../src/ai/reservationist-replay.js';
import {
  evaluateLabelGates,
  parseLabelCases,
  scoreLabelCases,
  type CandidateTrace,
  type LabelCase,
} from '../src/ai/label-scorers.js';

const ROOT = fileURLToPath(new URL('../.private/reservationist-backtest/', import.meta.url));
const GOLDEN_SET = join(ROOT, 'golden-set.jsonl');
const REASONING = 'medium' as const;
const CONCURRENCY = 8;
const MAX_STEPS = 10;
const USAGE =
  'usage: run-reservationist-backtest.ts check | run [--target pane|extract|agent] [--subset 30] [--run-id ID] | run --target extract --dataset FILE [--run-id ID] | score --run-id ID | replay-ops --snapshot FILE --out FILE [--limit N] [--concurrency 4]';

type Trace = GoldenTrace & {
  id: string;
  split: GoldenRow['split'];
  type: GoldenRow['type'];
  toolCalls?: ToolCall[];
  usage: unknown;
  ms: number;
};

const writePrivate = (path: string, text: string) => writeFileSync(path, text, { mode: 0o600 });
const appendPrivate = (path: string, row: unknown) =>
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });

/** Resumed runs append retries; the last trace per case wins. */
function latestTraces(path: string): Trace[] {
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Trace);
  return [...new Map(rows.map((trace) => [trace.id, trace])).values()];
}

function threadPrompt(row: GoldenRow) {
  return agentThreadPrompt(row);
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

function loadValidGolden(): GoldenRow[] {
  const rows = readGoldenSet(GOLDEN_SET);
  const problems = validateGoldenSet(rows);
  if (problems.length) throw new Error(`golden set is invalid: ${problems.join('; ')}`);
  return rows;
}

function check(): number {
  const rows = readGoldenSet(GOLDEN_SET);
  const problems = validateGoldenSet(rows);
  const splitSummary = (split: GoldenRow['split']) => {
    const part = rows.filter((row) => row.split === split);
    return {
      n: part.length,
      types: tally(part, (row) => row.type),
      domains: tally(part, (row) => senderDomainOf(row.trigger.from)),
      cells: new Set(part.map(cellOf)).size,
    };
  };
  console.log(JSON.stringify({ targets: GOLDEN_TARGETS, dev: splitSummary('dev'), holdout: splitSummary('holdout'), problems }, null, 2));
  for (const problem of problems) console.error(`check failed: ${problem}`);
  return problems.length ? 1 : 0;
}

type Manifest = { runId: string; target?: BacktestTarget; casesDigest?: string; cases: Array<{ id: string }>; dataset?: string };
const readManifest = (dir: string): Manifest | null =>
  existsSync(join(dir, 'manifest.json')) ? (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest) : null;

async function run(runId: string, target: BacktestTarget, subset?: number): Promise<number> {
  const rows = loadValidGolden();
  const picked = subset ? pickSubset(rows, subset) : rows;
  const dir = join(ROOT, runId);
  const casesDigest = runCasesDigest(picked);
  const prior = readManifest(dir);
  if (prior) {
    const previous = prior.target ?? 'agent';
    if (previous !== target) throw new Error(`run ${runId} is a ${previous} run; resume it with --target ${previous}`);
    if (prior.casesDigest !== casesDigest) {
      throw new Error(`run ${runId} was started with different cases or case inputs; start a new --run-id`);
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tracesPath = join(dir, 'traces.jsonl');
  const done = new Set(latestTraces(tracesPath).filter((trace) => !trace.error).map((trace) => trace.id));
  writePrivate(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        runId,
        target,
        // pane and extract run at the production adapter's own reasoning effort.
        reasoning: target === 'agent' ? REASONING : 'production',
        subset: subset ?? null,
        casesDigest,
        cases: picked.map((row) => ({ id: row.id, split: row.split, type: row.type, senderDomain: senderDomainOf(row.trigger.from) })),
      },
      null,
      2,
    ),
  );
  const todo = picked.filter((row) => !done.has(row.id));
  console.log(JSON.stringify({ runId, target, cases: picked.length, todo: todo.length }));
  if (target !== 'agent') return runProduction(target, todo, tracesPath, goldenMailbox(rows));

  const model = createAzureLunaModel();
  const defaults = createDefaultRunners({
    gotenbergUrl: process.env.GOTENBERG_URL,
    signer: { name: 'Centurion Reservations', email: '' },
    pdfDir: join(dir, 'pdfs'),
  });
  let finished = 0;
  await mapLimit(todo, CONCURRENCY, async (row) => {
    const replay = replayRunners(row);
    const agent = createReservationistAgent({
      model,
      runners: { ...defaults, quote: replay.quote, party: replay.party },
    });
    // Replayed reads stand in for live HMS, so quotes are available to every case. The gold type is never given to the agent.
    const requestContext = new RequestContext<ReservationistContext>([
      ['propertyCode', 'HRCEN'],
      ['hotelRules', CENTURION_HOTEL_RULES],
      ['liveQuoteOk', true],
    ]);
    const started = Date.now();
    let trace: Trace;
    try {
      const res = await agent.generate(threadPrompt(row), {
        maxSteps: MAX_STEPS,
        requestContext,
        providerOptions: lunaProviderOptions(REASONING),
        structuredOutput: { schema: reservationistDecisionSchema },
      });
      trace = {
        id: row.id,
        split: row.split,
        type: row.type,
        target,
        decision: (res.object as ReservationistDecision | undefined) ?? null,
        toolCalls: res.steps.flatMap((step) =>
          step.toolResults.map(({ payload }) => ({
            toolName: payload.toolName,
            args: payload.args,
            result: payload.result,
          })),
        ),
        replayMisses: replay.misses(),
        usage: res.usage,
        ms: Date.now() - started,
      };
    } catch (err) {
      trace = {
        id: row.id,
        split: row.split,
        type: row.type,
        target,
        decision: null,
        toolCalls: [],
        replayMisses: replay.misses(),
        usage: null,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    appendPrivate(tracesPath, trace);
    finished += 1;
    console.log(
      JSON.stringify({
        n: finished,
        of: todo.length,
        id: row.id,
        type: row.type,
        workflow: 'decision' in trace ? (trace.decision?.workflow ?? null) : null,
        replayMisses: trace.replayMisses,
        ms: trace.ms,
        error: trace.error ? 'yes' : undefined,
      }),
    );
  });
  return 0;
}

/** pane and extract: the production adapter, prompt and deadline for every row. */
async function runProduction(
  target: 'pane' | 'extract',
  todo: GoldenRow[],
  tracesPath: string,
  mailbox: string | null,
): Promise<number> {
  const { adapter } = resolveAdapter(true, null);
  if (!adapter) throw new Error('AZURE_OPENAI_BASE_URL and AZURE_FOUNDRY_API_KEY required');
  let finished = 0;
  await mapLimit(todo, CONCURRENCY, async (row) => {
    const started = Date.now();
    let trace: Trace;
    try {
      trace = { id: row.id, split: row.split, type: row.type, ...(await runProductionTarget(target, row, adapter, mailbox)), ms: Date.now() - started };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const empty = target === 'pane' ? { target, analysis: null } : { target, extraction: null };
      trace = { id: row.id, split: row.split, type: row.type, ...empty, replayMisses: 0, usage: null, ms: Date.now() - started, error };
    }
    appendPrivate(tracesPath, trace);
    finished += 1;
    const workflow = 'analysis' in trace ? trace.analysis?.workflow : 'extraction' in trace ? trace.extraction?.kind : null;
    console.log(JSON.stringify({ n: finished, of: todo.length, id: row.id, type: row.type, workflow: workflow ?? null, ms: trace.ms, error: trace.error }));
  });
  return 0;
}

function score(runId: string): number {
  const dir = join(ROOT, runId);
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`run ${runId} has no manifest.json`);
  const golden = new Map(readGoldenSet(GOLDEN_SET).map((row) => [row.id, row]));
  const caseIds = manifest.cases.map((c) => c.id);
  const declared = caseIds.flatMap((id) => golden.get(id) ?? []);
  if (declared.length !== caseIds.length || runCasesDigest(declared) !== manifest.casesDigest) {
    throw new Error(`run ${runId} cases changed in the golden set since the run; start a new --run-id`);
  }
  const traces = latestTraces(join(dir, 'traces.jsonl')).filter((trace) => golden.has(trace.id) && caseIds.includes(trace.id));
  const rows = traces.map((trace) => scoreGoldenCase(golden.get(trace.id)!, trace));
  const target = traces[0]?.target ?? 'agent';
  const summary = { target, ...summarizeGolden(rows), scored: rows.length, traced: traces.length };
  const incomplete = incompleteRunProblems(caseIds, new Set(traces.map((trace) => trace.id)), summary);
  writePrivate(join(dir, 'fields.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  writePrivate(join(dir, 'summary.json'), JSON.stringify({ ...summary, incomplete }, null, 2));
  console.log(JSON.stringify({ ...summary, incomplete }, null, 2));
  for (const problem of incomplete) console.error(`score incomplete: ${problem}`);
  if (summary.overfitAlarm) {
    console.error(`overfit alarm: dev minus holdout is ${summary.gapPoints} points (limit ${GOLDEN_TARGETS.overfitGapPoints})`);
  }
  return summary.overfitAlarm || incomplete.length ? 1 : 0;
}

type DatasetTrace = CandidateTrace & { id: string; split: string; usage: unknown; ms: number };

/** The newest row per id: a resumed run appends its retries. */
function latestById<T extends { id: string }>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

/**
 * --dataset: each labelled case through the production extraction. The case's masked mail is the trigger, under its
 * own message id, so the extraction's stable stay and row ids match the labels' field ids.
 */
/**
 * One dataset case through inbound extraction, as the inbound worker runs it. The stored message, its thread and its
 * attachments come from the database through the worker's loader, and the sender and mailbox are the stored ones. The
 * masked case text is not replayed: it would lose the facts the worker reads.
 */
export async function replayExtraction(
  row: Pick<LabelCase, 'message_id' | 'transport_id'>,
  adapter: ModelAdapter,
): Promise<Pick<DatasetTrace, 'extraction' | 'usage' | 'error'>> {
  const messageId = row.message_id;
  const transportId = row.transport_id;
  const missing = {
    extraction: null,
    usage: null,
    error: `message ${messageId ?? '(none)'} is not in the database`,
  };
  if (!messageId || !transportId) return missing;
  const selection = await loadSyncedQuoteSelectionFromMailbox({ transportId, messageId });
  if (!selection) return missing;
  const [transport] = await getDb()
    .select({ email: mailboxTransport.email })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.id, transportId))
    .limit(1);
  const res = await extractInboundMail({
    adapter,
    selection,
    messageId,
    from: selection.fromAddress ?? null,
    mailbox: transport?.email ?? null,
  });
  const usage = {
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    costUsd: res.usage.costUsd,
  };
  return res.ok
    ? { extraction: { kind: res.kind, payload: res.payload }, usage }
    : { extraction: null, usage, error: res.reason };
}

async function runDataset(runId: string, datasetPath: string): Promise<number> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('dataset replay loads each stored message: set DATABASE_URL to the database the dataset was exported from');
  }
  const cases = parseLabelCases(readFileSync(datasetPath, 'utf8'));
  if (!cases.length) throw new Error(`dataset ${datasetPath} has no cases`);
  const dir = join(ROOT, runId);
  const casesDigest = fingerprint(cases);
  const prior = readManifest(dir);
  if (prior && (prior.target !== 'extract' || prior.casesDigest !== casesDigest)) {
    throw new Error(`run ${runId} was started with another dataset or other cases; start a new --run-id`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tracesPath = join(dir, 'traces.jsonl');
  const done = new Set(latestById<DatasetTrace>(tracesPath).filter((trace) => !trace.error).map((trace) => trace.id));
  writePrivate(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        runId,
        target: 'extract',
        dataset: resolve(datasetPath),
        casesDigest,
        cases: cases.map((row) => ({ id: row.work_item_id, split: row.split })),
      },
      null,
      2,
    ),
  );
  const { adapter } = resolveAdapter(true, null);
  if (!adapter) throw new Error('AZURE_OPENAI_BASE_URL and AZURE_FOUNDRY_API_KEY required');
  const todo = cases.filter((row) => !done.has(row.work_item_id));
  console.log(JSON.stringify({ runId, target: 'extract', cases: cases.length, todo: todo.length }));
  let finished = 0;
  await mapLimit(todo, CONCURRENCY, async (row: LabelCase) => {
    const started = Date.now();
    let trace: DatasetTrace;
    try {
      const res = await replayExtraction(row, adapter);
      trace = { id: row.work_item_id, split: row.split, ...res, ms: Date.now() - started };
    } catch (err) {
      trace = {
        id: row.work_item_id,
        split: row.split,
        extraction: null,
        usage: null,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    appendPrivate(tracesPath, trace);
    finished += 1;
    console.log(
      JSON.stringify({ n: finished, of: todo.length, id: row.work_item_id, kind: trace.extraction?.kind ?? null, ms: trace.ms, error: trace.error }),
    );
  });
  return 0;
}

/** Label gates for a dataset run. Every case must have an answer; the gates come from label-scorers.ts. */
async function scoreDataset(runId: string, manifest: Manifest): Promise<number> {
  const dir = join(ROOT, runId);
  const cases = parseLabelCases(readFileSync(manifest.dataset!, 'utf8'));
  if (fingerprint(cases) !== manifest.casesDigest) {
    throw new Error(`run ${runId} cases changed in the dataset since the run; start a new --run-id`);
  }
  const traces = new Map(latestById<DatasetTrace>(join(dir, 'traces.jsonl')).map((trace) => [trace.id, trace]));
  const summary = await scoreLabelCases(cases, traces);
  const gates = evaluateLabelGates(summary);
  const report = { runId, dataset: manifest.dataset, traced: traces.size, ...summary, gates };
  writePrivate(join(dir, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const check of gates.checks) if (check.status === 'fail') console.error(`gate failed: ${check.name} (${check.detail})`);
  return gates.pass ? 0 : 1;
}

type PredictedOpsRow = {
  kind: 'predicted';
  message_id: string;
  operations: ReturnType<typeof decisionToOperations>;
  workflow: ReservationistDecision['workflow'] | null;
  tools: string[];
  error: string | null;
};

function unavailableRunners(): ReservationistRunners {
  return {
    quote: async () => ({ status: QUOTE_UNAVAILABLE }),
    party: async () => ({ outcome: 'no_match', candidates: [] }),
    pdf: async () => ({ fileName: 'unavailable.pdf', path: '', bytes: 0 }),
    validateCreate: async () => ({ ok: false, errors: ['unavailable'] }),
  };
}

function predictedError(messageId: string, error: string): PredictedOpsRow {
  return {
    kind: 'predicted',
    message_id: messageId,
    operations: [],
    workflow: null,
    tools: [],
    error,
  };
}

function loadSnapshotJobs(path: string, limit?: number): Array<{ messageId: string; row?: SnapshotRow; error?: string }> {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  const picked = limit === undefined ? lines : lines.slice(0, limit);
  return picked.map((line) => {
    try {
      const row = JSON.parse(line) as SnapshotRow;
      const messageId = row.inbound?.id;
      if (!messageId) return { messageId: 'unknown', error: 'snapshot row missing inbound.id' };
      return { messageId, row };
    } catch (err) {
      return { messageId: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function loadPredictedOps(path: string): PredictedOpsRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PredictedOpsRow);
}

async function replayOps(args: {
  snapshot: string;
  out: string;
  limit?: number;
  concurrency: number;
}): Promise<number> {
  const jobs = loadSnapshotJobs(args.snapshot, args.limit);
  const latestPrior = new Map(loadPredictedOps(args.out).map((row) => [row.message_id, row]));
  const model = createAzureLunaModel();
  const runners = unavailableRunners();
  const requestContext = new RequestContext<ReservationistContext>([
    ['propertyCode', 'HRCEN'],
    ['hotelRules', CENTURION_HOTEL_RULES],
    ['liveQuoteOk', true],
  ]);
  mkdirSync(dirname(args.out), { recursive: true });
  const outputs: PredictedOpsRow[] = new Array(jobs.length);
  for (const [index, job] of jobs.entries()) {
    const existing = latestPrior.get(job.messageId);
    if (existing && existing.error === null) outputs[index] = existing;
  }
  const indexed = jobs
    .map((job, index) => ({ job, index }))
    .filter(({ index }) => outputs[index] === undefined);
  await mapLimit(indexed, args.concurrency, async ({ job, index }) => {
    let row: PredictedOpsRow;
    if (job.error || !job.row) {
      row = predictedError(job.messageId, job.error ?? 'snapshot row invalid');
    } else {
      try {
        const agent = createReservationistAgent({ model, runners });
        const res = await agent.generate(agentThreadPrompt(snapshotRowToAgentCase(job.row)), {
          maxSteps: MAX_STEPS,
          requestContext,
          providerOptions: lunaProviderOptions(REASONING),
          structuredOutput: { schema: reservationistDecisionSchema },
        });
        const decision = (res.object as ReservationistDecision | undefined) ?? null;
        if (!decision) {
          row = predictedError(job.messageId, 'agent returned no decision');
        } else {
          const tools = res.steps.flatMap((step) =>
            step.toolResults.map(({ payload }) => payload.toolName as string),
          );
          row = {
            kind: 'predicted',
            message_id: job.messageId,
            operations: decisionToOperations(
              decision,
              tools.map((toolName) => ({ toolName })),
            ),
            workflow: decision.workflow,
            tools,
            error: null,
          };
        }
      } catch (err) {
        row = predictedError(job.messageId, err instanceof Error ? err.message : String(err));
      }
    }
    outputs[index] = row;
    appendPrivate(args.out, row);
  });
  const ok = outputs.filter((row) => row.error === null).length;
  const errors = outputs.length - ok;
  const workflows = tally(
    outputs.filter((row): row is PredictedOpsRow & { workflow: string } => Boolean(row.workflow)),
    (row) => row.workflow,
  );
  console.log(`replay-ops n=${outputs.length} ok=${ok} errors=${errors} workflows=${JSON.stringify(workflows)}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      subset: { type: 'string' },
      'run-id': { type: 'string' },
      target: { type: 'string' },
      dataset: { type: 'string' },
      snapshot: { type: 'string' },
      out: { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string' },
    },
  });
  const [command, ...extra] = positionals;
  if (extra.length) {
    console.error(USAGE);
    return 2;
  }
  if (command === 'check') return check();
  if (command === 'run' && values.dataset !== undefined) {
    if (values.subset !== undefined || (values.target !== undefined && values.target !== 'extract')) {
      console.error(USAGE);
      return 2;
    }
    return runDataset(validateRunId(values['run-id'] ?? `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`), values.dataset);
  }
  if (command === 'run') {
    const subset = values.subset === undefined ? undefined : Number(values.subset);
    const target = (values.target ?? 'pane') as BacktestTarget;
    if ((subset !== undefined && (!Number.isInteger(subset) || subset < 1)) || !BACKTEST_TARGETS.includes(target)) {
      console.error(USAGE);
      return 2;
    }
    const runId = values['run-id'] ?? `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    return run(validateRunId(runId), target, subset);
  }
  if (command === 'score' && values['run-id']) {
    const runId = validateRunId(values['run-id']);
    const manifest = readManifest(join(ROOT, runId));
    return manifest?.dataset ? scoreDataset(runId, manifest) : score(runId);
  }
  if (command === 'replay-ops') {
    const snapshot = values.snapshot;
    const out = values.out;
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    const concurrency = values.concurrency === undefined ? 4 : Number(values.concurrency);
    if (
      !snapshot ||
      !out ||
      (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) ||
      !Number.isInteger(concurrency) ||
      concurrency < 1
    ) {
      console.error(USAGE);
      return 2;
    }
    return replayOps({ snapshot, out, limit, concurrency });
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`backtest failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
