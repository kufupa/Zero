/**
 * Promptfoo provider: one snapshot row through the same path as replay-ops.
 * Vars: pairsPath, messageId, optional sops. Output is ops JSON — no mail bodies.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decisionToOperations, type SnapshotRow } from '../../src/ai/agent-decision-to-ops.js';
import {
  agentAcceptsAopSops,
  readUnlockedRows,
  runReservationistEvalAgent,
  type AgentEvalDeps,
} from './score-row.js';
import {
  LOCKED_TEST_SPLIT,
  assertNotTestSplit,
  evalTestSplitUnlocked,
  rowMessageId,
  warnUnlockedTestSplit,
  type SplitTaggedRow,
} from './split.js';

export type AgentReplayDeps = AgentEvalDeps;
export type AgentPromptfooTest = {
  description: string;
  vars: {
    pairsPath: string;
    messageId: string;
    staff_move: string;
    hms_work_implied: string[];
    required_fields: string[];
    workflow: string;
    sops?: string;
  };
  assert: Array<{ type: 'javascript'; value: string; metric: string }>;
};
export type AgentEvalGenerateCli = {
  labelsPath: string;
  pairsPath: string;
  split: 'train' | 'dev' | 'test';
  limit: number;
  offset: number;
  sops?: string;
  outPath?: string;
};

function readUtf8(filePath: string, readFile?: AgentReplayDeps['readFile']): string {
  return (readFile ?? readFileSync)(filePath, 'utf8');
}

function loadSops(sopsPath: string, readFile?: AgentReplayDeps['readFile']): Record<string, string> {
  const raw = JSON.parse(readUtf8(sopsPath, readFile)) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('sops JSON must be {workflow: text}');
  const out: Record<string, string> = {};
  for (const [workflow, text] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof text === 'string') out[workflow] = text;
  }
  return out;
}

function loadSnapshotRow(pairsPath: string, messageId: string, readFile?: AgentReplayDeps['readFile']): SnapshotRow {
  for (const row of readUnlockedRows<SnapshotRow & SplitTaggedRow>(pairsPath, readFile)) {
    const id = rowMessageId(row);
    if (!id || id !== messageId) continue;
    assertNotTestSplit(row);
    return row;
  }
  throw new Error(`snapshot row not found: ${messageId}`);
}

const emptyOut = JSON.stringify({ workflow: null, operations: [] });

export async function callApi(
  _prompt: string,
  context?: { vars?: Record<string, unknown> },
  deps: AgentReplayDeps = {},
): Promise<{ output: string; error?: string }> {
  const vars = context?.vars ?? {};
  const pairsPath = typeof vars.pairsPath === 'string' ? vars.pairsPath : '';
  const messageId = typeof vars.messageId === 'string' ? vars.messageId : '';
  if (!pairsPath || !messageId) return { output: emptyOut, error: 'pairsPath and messageId required' };
  try {
    const row = loadSnapshotRow(pairsPath, messageId, deps.readFile);
    let aopSops: Record<string, string> | undefined;
    if (typeof vars.sops === 'string' && vars.sops) {
      const loaded = loadSops(vars.sops, deps.readFile);
      if (agentAcceptsAopSops()) aopSops = loaded;
    }
    const { decision, tools, error } = await runReservationistEvalAgent(row, { ...deps, aopSops });
    if (error || !decision) return { output: emptyOut, error: error ?? 'agent returned no decision' };
    return {
      output: JSON.stringify({
        workflow: decision.workflow,
        operations: decisionToOperations(decision, tools.map((toolName) => ({ toolName }))),
        decision,
      }),
    };
  } catch (err) {
    return { output: emptyOut, error: err instanceof Error ? err.message : String(err) };
  }
}

function strs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function parseAgentEvalGenerateCli(argv: readonly string[]): AgentEvalGenerateCli {
  const out: Partial<AgentEvalGenerateCli> & { limit: number; offset: number } = { limit: 25, offset: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    const take = (): string => {
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      i += 1;
      return value;
    };
    if (flag === '--labels') out.labelsPath = take();
    else if (flag === '--pairs') out.pairsPath = take();
    else if (flag === '--split') {
      const split = take();
      if (split !== 'train' && split !== 'dev' && split !== 'test') {
        throw new Error('--split must be train|dev');
      }
      if (split === 'test') {
        if (!evalTestSplitUnlocked()) throw new Error(LOCKED_TEST_SPLIT);
        warnUnlockedTestSplit();
      }
      out.split = split;
    } else if (flag === '--limit') out.limit = Number(take());
    else if (flag === '--offset') out.offset = Number(take());
    else if (flag === '--sops') out.sops = take();
    else if (flag === '--out') out.outPath = take();
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!out.labelsPath || !out.pairsPath || !out.split) {
    throw new Error('usage: --labels FILE --pairs FILE --split train|dev [--limit N] [--offset N] [--sops FILE] [--out FILE]');
  }
  if (!Number.isInteger(out.limit) || out.limit < 1 || !Number.isInteger(out.offset) || out.offset < 0) {
    throw new Error('--limit must be >=1 and --offset must be >=0');
  }
  return out as AgentEvalGenerateCli;
}

export function generateAgentPromptfooTests(
  cli: Omit<AgentEvalGenerateCli, 'outPath'>,
  deps: Pick<AgentReplayDeps, 'readFile'> = {},
): { tests: AgentPromptfooTest[] } {
  if (cli.split === 'test') {
    if (!evalTestSplitUnlocked()) throw new Error(LOCKED_TEST_SPLIT);
    warnUnlockedTestSplit();
  }
  const allowed = new Set<string>();
  for (const row of readUnlockedRows<SplitTaggedRow>(cli.pairsPath, deps.readFile)) {
    const id = rowMessageId(row);
    if (!id) continue;
    if (row.split === cli.split) allowed.add(id);
  }
  const tests: AgentPromptfooTest[] = [];
  for (const line of readUtf8(cli.labelsPath, deps.readFile).split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      message_id?: string;
      messageId?: string;
      staff_move?: string;
      hms_work_implied?: unknown;
      required_fields?: unknown;
      workflow?: string;
    };
    const messageId = (row.message_id ?? row.messageId)?.trim();
    if (!messageId) continue;
    if (!allowed.has(messageId)) continue;
    const workflow = row.workflow || 'unknown';
    tests.push({
      description: messageId,
      vars: {
        pairsPath: cli.pairsPath,
        messageId,
        staff_move: row.staff_move ?? 'other',
        hms_work_implied: strs(row.hms_work_implied),
        required_fields: strs(row.required_fields),
        workflow,
        ...(cli.sops ? { sops: cli.sops } : {}),
      },
      assert: [{ type: 'javascript', value: 'file://asserts.js', metric: workflow }],
    });
  }
  return { tests: tests.slice(cli.offset, cli.offset + cli.limit) };
}

const provider = {
  id: 'reservationist-replay',
  async callApi(prompt: string, context?: { vars?: Record<string, unknown> }) {
    return callApi(prompt, context);
  },
};
export default provider;

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  const cli = parseAgentEvalGenerateCli(process.argv.slice(2));
  const { outPath, ...rest } = cli;
  const text = `${JSON.stringify(generateAgentPromptfooTests(rest), null, 2)}\n`;
  if (outPath) writeFileSync(outPath, text);
  else process.stdout.write(text);
}
