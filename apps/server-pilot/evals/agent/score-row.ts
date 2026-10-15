/**
 * One AOP scorer (Driver C aop-eval). Promptfoo, aop-eval CLI, and GEPA import this.
 * Same-move = staffMoveToOperations + decisionToOperations + opKey. No mail bodies.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { RequestContext } from '@mastra/core/request-context';
import {
  agentThreadPrompt,
  decisionToOperations,
  snapshotRowToAgentCase,
  type SnapshotRow,
} from '../../src/ai/agent-decision-to-ops.js';
import { createAzureLunaModel, lunaProviderOptions } from '../../src/ai/bedrock/luna.js';
import { staffMoveToOperations } from '../../src/ai/gold-pair-join.js';
import {
  CENTURION_HOTEL_RULES,
  QUOTE_UNAVAILABLE,
  createReservationistAgent,
  reservationistDecisionSchema,
  type ReservationistContext,
  type ReservationistDecision,
  type ReservationistRunners,
} from '../../src/ai/reservationist-agent.js';
import { assertNotTestSplit, evalTestSplitUnlocked, type SplitTaggedRow } from './split.js';

const SCORABLE = new Set(['confirmationNumber', 'arrivalDate', 'departureDate', 'rooms', 'adults']);

export type EvalGoldLabel = {
  workflow: string;
  staff_move: string;
  hms_work_implied: string[];
  required_fields: string[];
};
export type EvalGoldRow = { pair_id?: string; inbound?: { id?: string }; label: EvalGoldLabel };
export type ScoreRowResult = {
  pair: string;
  gold: string;
  goldMove: string;
  pred: string;
  workflow: string;
  ok: boolean;
  fields: number;
  req: number;
  scorable: number;
  reply: boolean;
  error: string | null;
  reason: 'match' | 'abstain-ok' | 'mismatch' | 'error';
};
export type ReplayAgent = {
  generate: (
    prompt: string,
    options: unknown,
  ) => Promise<{
    object?: ReservationistDecision | null;
    steps?: Array<{ toolResults?: Array<{ payload?: { toolName?: string } }> }>;
  }>;
};
export type AgentEvalDeps = {
  createModel?: () => unknown;
  createAgent?: (options: {
    model: unknown;
    runners: ReservationistRunners;
    aopSops?: Record<string, string>;
  }) => ReplayAgent;
  runners?: ReservationistRunners;
  sopsText?: string;
  aopSops?: Record<string, string>;
  readFile?: (filePath: string, encoding: 'utf8') => string;
};

function* iterateJsonlLines(
  filePath: string,
  readFile?: AgentEvalDeps['readFile'],
): Generator<string> {
  if (readFile) {
    const text = readFile(filePath, 'utf8');
    let start = 0;
    while (start < text.length) {
      const nl = text.indexOf('\n', start);
      const end = nl === -1 ? text.length : nl;
      const line = text.slice(start, end);
      start = nl === -1 ? text.length : nl + 1;
      if (line.trim()) yield line;
    }
    return;
  }
  const fd = openSync(filePath, 'r');
  try {
    let buf = '';
    const chunk = Buffer.alloc(64 * 1024);
    while (true) {
      const n = readSync(fd, chunk, 0, chunk.length);
      if (n === 0) break;
      buf += chunk.toString('utf8', 0, n);
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) yield line;
        nl = buf.indexOf('\n');
      }
    }
    if (buf.trim()) yield buf;
  } finally {
    closeSync(fd);
  }
}

function peekSplitAndId(line: string): SplitTaggedRow & { parsed: Record<string, unknown> } {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('jsonl row must be an object');
  }
  const rec = parsed as Record<string, unknown>;
  const inbound = rec.inbound;
  return {
    split: rec.split,
    inbound: inbound && typeof inbound === 'object' ? { id: (inbound as { id?: unknown }).id } : undefined,
    parsed: rec,
  };
}

/** Stream jsonl; drop split=test before keeping the row unless EVAL_UNLOCK_TEST=1. */
export function readUnlockedRows<T = Record<string, unknown>>(
  filePath: string,
  readFile?: AgentEvalDeps['readFile'],
): T[] {
  const unlocked = evalTestSplitUnlocked();
  const rows: T[] = [];
  for (const line of iterateJsonlLines(filePath, readFile)) {
    const peek = peekSplitAndId(line);
    if (!unlocked && peek.split === 'test') continue;
    rows.push(peek.parsed as T);
  }
  return rows;
}

export function opKey(ops: { operation: string }[]): string {
  return [...new Set(ops.map((row) => row.operation))].sort().join('+') || 'none';
}

export function stubHmsRunners(): ReservationistRunners {
  return {
    quote: async () => ({ status: QUOTE_UNAVAILABLE }),
    party: async () => ({ outcome: 'no_match', candidates: [] }),
    pdf: async () => ({ fileName: 'unavailable.pdf', path: '', bytes: 0 }),
    validateCreate: async () => ({ ok: false, errors: ['unavailable'] }),
  };
}

/** TODO(BRAIN-B): pass aopSops once createReservationistAgent accepts it. */
export function agentAcceptsAopSops(): boolean {
  return /\baopSops\b/.test(Function.prototype.toString.call(createReservationistAgent));
}

export function fieldsFound(decision: ReservationistDecision, required: string[]): number {
  const have: Record<string, boolean> = {
    confirmationNumber: Boolean(decision.confirmationNumber),
    arrivalDate: Boolean(decision.stayAsk?.arrivalDate),
    departureDate: Boolean(decision.stayAsk?.departureDate),
    rooms: Boolean(decision.stayAsk?.rooms),
    adults: Boolean(decision.stayAsk?.adults),
  };
  return required.filter((field) => have[field]).length;
}

export function scoreRow(
  row: EvalGoldRow,
  decision: ReservationistDecision | null,
  error?: string | null,
): ScoreRowResult {
  const gold = opKey(staffMoveToOperations(row.label.staff_move, row.label.hms_work_implied));
  const scorable = row.label.required_fields.filter((field) => SCORABLE.has(field)).length;
  const base = {
    pair: row.pair_id ?? row.inbound?.id ?? '',
    gold,
    goldMove: row.label.staff_move,
    req: row.label.required_fields.length,
    scorable,
  };
  if (error || !decision) {
    return { ...base, pred: 'error', workflow: 'error', ok: false, fields: 0, reply: false, error: error ?? 'no decision', reason: 'error' };
  }
  const pred = opKey(decisionToOperations(decision, []));
  const workflow =
    decision.workflow === 'hms_todo' ? `hms_todo:${decision.todoTarget ?? '?'}` : decision.workflow;
  const ok = pred === gold;
  return {
    ...base,
    pred,
    workflow,
    ok,
    fields: fieldsFound(decision, row.label.required_fields),
    reply: decision.replyDraft.trim().length > 0,
    error: null,
    reason: gold === 'unknown' && pred === 'unknown' ? 'abstain-ok' : ok ? 'match' : 'mismatch',
  };
}

function strs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Promptfoo assert: same-move + required stay fields; unknown/unknown is abstain-ok. */
export function scoreReplayOutput(
  output: unknown,
  vars?: Record<string, unknown>,
): { pass: boolean; score: number; reason: string } {
  const parsed = typeof output === 'string' ? (JSON.parse(output) as unknown) : output;
  const decision =
    parsed && typeof parsed === 'object' && 'decision' in parsed && typeof (parsed as { decision: unknown }).decision === 'object'
      ? ((parsed as { decision: ReservationistDecision }).decision)
      : null;
  const scored = scoreRow(
    {
      inbound: { id: typeof vars?.messageId === 'string' ? vars.messageId : '' },
      label: {
        workflow: typeof vars?.workflow === 'string' ? vars.workflow : '',
        staff_move: typeof vars?.staff_move === 'string' ? vars.staff_move : 'other',
        hms_work_implied: strs(vars?.hms_work_implied),
        required_fields: strs(vars?.required_fields),
      },
    },
    decision,
  );
  if (scored.reason === 'error') return { pass: false, score: 0, reason: 'error' };
  if (scored.reason === 'abstain-ok') return { pass: true, score: 1, reason: 'abstain-ok' };
  const pass = scored.ok && (scored.scorable === 0 || scored.fields === scored.scorable);
  return { pass, score: pass ? 1 : 0, reason: pass ? 'match' : 'mismatch' };
}

export async function runReservationistEvalAgent(
  row: SnapshotRow,
  deps: AgentEvalDeps = {},
): Promise<{ decision: ReservationistDecision | null; tools: string[]; error?: string }> {
  try {
    assertNotTestSplit(row);
    const model = (deps.createModel ?? createAzureLunaModel)();
    const runners = deps.runners ?? stubHmsRunners();
    const aopSops = deps.aopSops && agentAcceptsAopSops() ? deps.aopSops : undefined;
    const createAgent =
      deps.createAgent ??
      ((options) =>
        createReservationistAgent({
          model: options.model as Parameters<typeof createReservationistAgent>[0]['model'],
          runners: options.runners,
          ...(options.aopSops ? { aopSops: options.aopSops } : {}),
        } as Parameters<typeof createReservationistAgent>[0]) as unknown as ReplayAgent);
    const res = await createAgent({ model, runners, aopSops }).generate(
      agentThreadPrompt(snapshotRowToAgentCase(row)),
      {
        maxSteps: 10,
        requestContext: new RequestContext<ReservationistContext>([
          ['propertyCode', 'HRCEN'],
          ['hotelRules', deps.sopsText ? `${CENTURION_HOTEL_RULES}\n\n${deps.sopsText}` : CENTURION_HOTEL_RULES],
          ['liveQuoteOk', true],
        ]),
        providerOptions: lunaProviderOptions('medium'),
        structuredOutput: { schema: reservationistDecisionSchema },
      },
    );
    const decision = res.object ?? null;
    const tools = (res.steps ?? []).flatMap((step) =>
      (step.toolResults ?? []).map((result) => result.payload?.toolName).filter((name): name is string => Boolean(name)),
    );
    if (!decision) return { decision: null, tools, error: 'agent returned no decision' };
    return { decision, tools };
  } catch (err) {
    return { decision: null, tools: [], error: err instanceof Error ? err.message : String(err) };
  }
}
