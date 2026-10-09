/**
 * Reservationist backtest on the operator's golden set (R20, U27).
 *
 *   check                          validate the set: 80 dev + 40 holdout, no sender domain over 15% of a split
 *   run [--subset 30] [--run-id]   run the agent: medium reasoning, 8 in flight, HMS quote/party reads replayed
 *   score --run-id ID              field-level accuracy per split and the overfit alarm (dev - holdout > 10 points)
 *
 * Input: apps/server-pilot/.private/reservationist-backtest/golden-set.jsonl (gitignored). It is not exported from
 * prod by this script; a missing file fails with the expected path. Traces and scores land in <run-id>/ beside it.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RequestContext } from '@mastra/core/request-context';
import { createAzureLunaModel, lunaProviderOptions } from '../src/ai/bedrock/luna.js';
import {
  CENTURION_HOTEL_RULES,
  createDefaultRunners,
  createReservationistAgent,
  reservationistDecisionSchema,
  type ReservationistContext,
  type ReservationistDecision,
} from '../src/ai/reservationist-agent.js';
import {
  GOLDEN_TARGETS,
  cellOf,
  pickSubset,
  readGoldenSet,
  replayRunners,
  scoreGoldenCase,
  senderDomainOf,
  summarizeGolden,
  tally,
  validateGoldenSet,
  type CaseMessage,
  type GoldenRow,
  type ToolCall,
} from '../src/ai/reservationist-backtest.js';
import { validateRunId } from '../src/ai/reservationist-replay.js';

const ROOT = fileURLToPath(new URL('../.private/reservationist-backtest/', import.meta.url));
const GOLDEN_SET = join(ROOT, 'golden-set.jsonl');
const REASONING = 'medium' as const;
const CONCURRENCY = 8;
const MAX_STEPS = 10;
const MAX_MESSAGE_CHARS = 20_000;
const USAGE = 'usage: run-reservationist-backtest.ts check | run [--subset 30] [--run-id ID] | score --run-id ID';

type Trace = {
  id: string;
  split: GoldenRow['split'];
  type: GoldenRow['type'];
  decision: ReservationistDecision | null;
  toolCalls: ToolCall[];
  replayMisses: number;
  usage: unknown;
  ms: number;
  error?: string;
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

function emailBlock(m: CaseMessage) {
  return `<email direction="${m.direction}" at="${m.eventAt}" from="${m.from}" subject="${m.subject}">
${m.text.slice(0, MAX_MESSAGE_CHARS)}
</email>`;
}

function threadPrompt(row: GoldenRow) {
  return `Thread messages oldest first. Handle the LAST message (asOf ${row.trigger.eventAt}); earlier ones are context.

${[...row.context, row.trigger].map(emailBlock).join('\n\n')}`;
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

async function run(runId: string, subset?: number): Promise<number> {
  const rows = loadValidGolden();
  const picked = subset ? pickSubset(rows, subset) : rows;
  const dir = join(ROOT, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tracesPath = join(dir, 'traces.jsonl');
  const done = new Set(latestTraces(tracesPath).filter((trace) => !trace.error).map((trace) => trace.id));
  writePrivate(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        runId,
        reasoning: REASONING,
        subset: subset ?? null,
        cases: picked.map((row) => ({ id: row.id, split: row.split, type: row.type, senderDomain: senderDomainOf(row.trigger.from) })),
      },
      null,
      2,
    ),
  );
  const todo = picked.filter((row) => !done.has(row.id));
  console.log(JSON.stringify({ runId, cases: picked.length, todo: todo.length }));

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
        workflow: trace.decision?.workflow ?? null,
        replayMisses: trace.replayMisses,
        ms: trace.ms,
        error: trace.error ? 'yes' : undefined,
      }),
    );
  });
  return 0;
}

function score(runId: string): number {
  const dir = join(ROOT, runId);
  const golden = new Map(readGoldenSet(GOLDEN_SET).map((row) => [row.id, row]));
  const traces = latestTraces(join(dir, 'traces.jsonl'));
  const rows = traces.flatMap((trace) => {
    const row = golden.get(trace.id);
    return row ? [scoreGoldenCase(row, trace)] : [];
  });
  const summary = { ...summarizeGolden(rows), scored: rows.length, traced: traces.length };
  writePrivate(join(dir, 'fields.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  writePrivate(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.overfitAlarm) {
    console.error(`overfit alarm: dev minus holdout is ${summary.gapPoints} points (limit ${GOLDEN_TARGETS.overfitGapPoints})`);
  }
  return summary.overfitAlarm ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { subset: { type: 'string' }, 'run-id': { type: 'string' } },
  });
  const [command, ...extra] = positionals;
  if (extra.length) {
    console.error(USAGE);
    return 2;
  }
  if (command === 'check') return check();
  if (command === 'run') {
    const subset = values.subset === undefined ? undefined : Number(values.subset);
    if (subset !== undefined && (!Number.isInteger(subset) || subset < 1)) {
      console.error(USAGE);
      return 2;
    }
    const runId = values['run-id'] ?? `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    return run(validateRunId(runId), subset);
  }
  if (command === 'score' && values['run-id']) return score(validateRunId(values['run-id']));
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
