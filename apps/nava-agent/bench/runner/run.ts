import {readdir, readFile, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AzureRuntime} from '../../src/agent-runtime/azure.js';
import type {RuntimeDeps, RuntimeState, ToolDefinition} from '../../src/agent-runtime/loop.js';
import {tools as baselineTools} from '../../src/schema.js';
import {schemas as triageSchemas} from '../../tools/triage/schema.js';
import {quoteSchema} from '../../tools/quote/schema.js';
import {skillReadDefinition} from '../../tools/skills/schema.js';
import {assignSplit} from '../split.js';
import {createTwin} from '../twin/index.js';
import type {CaseCard} from '../types.js';
import {buildScoreboard, scoreCase, type CaseScore, type Scoreboard} from './score.js';
const DATA_ROOT = process.env.NAVA_BENCH_DATA_ROOT ?? '/home/orca/.local/share/zero/bench/replay-bench-20261119';

const SYSTEM = `Read the selected inbound with mail_read_thread. Use the pinned triage files supplied in the system context, or load triage/SKILL.md and its references with skill_read if they were not supplied. Load the relevant workflow skill and any references not already supplied with skill_read. Handle the selected request using quote, create, amend, cancel, filing or triage as the pinned skills specify. Use only the registered tools. Publish the grounded proposal, with editable field paths for staff and native_result null (the server binds actual quote captures). For uncertain intent, scope or targets, use needs_info or staff_review. Staff runs the native action after review; never call a staging or writing tool. Never send mail, invent missing facts, or treat earlier quoted material as the current ask. End after publishing the proposal. Save is disabled.`;

/** Prod tool schemas from tool-registry baseline + triage/quote packs (same as EC2). */
function prodBenchTools(): ToolDefinition[] {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of baselineTools) {
    byName.set(tool.name, {name: tool.name, description: tool.description, input_schema: tool.input_schema as ToolDefinition['input_schema']});
  }
  byName.set(skillReadDefinition.name, {
    name: skillReadDefinition.name,
    description: skillReadDefinition.description,
    input_schema: skillReadDefinition.input_schema as ToolDefinition['input_schema'],
  });
  byName.set('hms_search_reservations', {
    name: 'hms_search_reservations',
    description: 'Search native reservation candidates without selecting a booking.',
    input_schema: triageSchemas.hms_search_reservations as ToolDefinition['input_schema'],
  });
  byName.set('hms_read_reservation', {
    name: 'hms_read_reservation',
    description: 'Read a fresh uniquely identified native saved reservation.',
    input_schema: triageSchemas.hms_read_reservation as ToolDefinition['input_schema'],
  });
  byName.set('hms_read_catalogue', {
    name: 'hms_read_catalogue',
    description: 'Read native catalogue codes and meanings with explicit coverage.',
    input_schema: triageSchemas.hms_read_catalogue as ToolDefinition['input_schema'],
  });
  byName.set('hms_search_parties', {
    name: 'hms_search_parties',
    description: 'Search native guest, organization, agency or A/R candidates without linking.',
    input_schema: triageSchemas.hms_search_parties as ToolDefinition['input_schema'],
  });
  byName.set('hms_quote', {
    name: 'hms_quote',
    description: 'Read native availability and nightly prices for one quote and its ordered date groups; does not book.',
    input_schema: quoteSchema as ToolDefinition['input_schema'],
  });
  byName.set('hms_prepare', {
    name: 'hms_prepare',
    description: 'Prepare a native change without saving.',
    input_schema: {
      type: 'object',
      properties: {
        workflow: {type: 'string', enum: ['create', 'amend', 'cancel', 'filing']},
        booking: {type: 'object'},
        action: {type: 'object'},
      },
      required: ['workflow', 'booking', 'action'],
      additionalProperties: false,
    },
  });
  // Bench twin: never expose Save.
  byName.delete('hms_save');
  return [...byName.values()];
}

const benchTools = prodBenchTools();

function pdfAttachments(raw: unknown): Array<{id: string; name: string; content_type: string; extracted_text: string}> {
  if (!Array.isArray(raw)) return [];
  return raw.map((pdf, i) => {
    const row = (pdf ?? {}) as Record<string, unknown>;
    return {
      id: String(row.id ?? `pdf-${i}`),
      name: String(row.filename ?? row.name ?? `attachment-${i}.pdf`),
      content_type: 'application/pdf',
      extracted_text: String(row.text ?? row.extracted_text ?? '').slice(0, 20_000),
    };
  });
}

async function loadSkillPin(): Promise<{version: string; files: Record<string, string>}> {
  const root = join(process.cwd(), 'skills');
  const files: Record<string, string> = {};
  async function walk(rel: string) {
    const entries = await readdir(join(root, rel), {withFileTypes: true});
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.md')) files[path] = await readFile(join(root, path), 'utf8');
    }
  }
  await walk('');
  return {version: 'bench', files};
}

function mailPayload(card: CaseCard) {
  const selected = card.selected_email as Record<string, unknown> | undefined;
  const before = (card.context_before as unknown[]) ?? [];
  const messages = [
    ...before.map((msg, index) => {
      const row = (msg ?? {}) as Record<string, unknown>;
      const nested = (row.message ?? row) as Record<string, unknown>;
      return {
        id: String(nested.message_id ?? nested.id ?? `before-${index}`),
        direction: nested.direction ?? 'inbound',
        from: nested.addresses ? (nested.addresses as {from?: string[]}).from?.[0] : nested.from,
        to: [],
        cc: [],
        subject: nested.subject ?? '',
        body_text: String(nested.body_text ?? nested.body ?? ''),
        received_at: nested.timestamp ?? nested.received_at ?? card.as_of,
        attachments: pdfAttachments(nested.pdf_attachments_text ?? nested.attachments),
      };
    }),
    {
      id: String(selected?.message_id ?? 'selected'),
      direction: 'inbound',
      from: selected?.addresses ?? selected?.from ?? null,
      to: [],
      cc: [],
      subject: selected?.subject ?? '',
      body_text: String(selected?.body_text ?? selected?.body ?? ''),
      received_at: selected?.received_at ?? card.as_of,
      attachments: pdfAttachments(selected?.pdf_attachments_text),
    },
  ];
  for (const link of (card.cross_thread_context as Array<Record<string, unknown>> | undefined) ?? []) {
    for (const msg of (link.messages as Array<Record<string, unknown>> | undefined) ?? []) {
      messages.push({
        id: `xt-${link.thread_id}-${messages.length}`,
        direction: msg.direction ?? 'inbound',
        from: null,
        to: [],
        cc: [],
        subject: `[cross-thread rank=${link.rank} ${link.reason}] ${msg.subject ?? ''}`,
        body_text: String(msg.body_text ?? msg.body ?? ''),
        received_at: msg.timestamp ?? card.as_of,
        attachments: pdfAttachments(msg.pdf_attachments_text ?? msg.attachments),
      });
    }
  }
  return {
    source: 'bench',
    source_thread_id: selected?.thread_id ?? card.case_id,
    mailbox_id: 'bench',
    selected_message_id: selected?.message_id ?? 'selected',
    property_code: 'HRCEN',
    mode: 'historical',
    messages,
    source_input: {
      input_cutoff: card.as_of,
      selected_message: selected,
      earlier_relevant_source_events: before,
    },
  };
}

export async function runCase(card: CaseCard, options: {concurrencyToken?: unknown} = {}): Promise<CaseScore> {
  void options;
  process.env.NAVA_HMS_MODE = 'twin';
  process.env.NAVA_AGENT_RUNTIME = 'azure';
  // Luna only — never Anthropic/Haiku for agent or helpers.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.NAVA_AGENT_ANTHROPIC_MODEL;
  process.env.NAVA_AGENT_AZURE_DEPLOYMENT = process.env.NAVA_AGENT_AZURE_DEPLOYMENT ?? 'gpt-6-luna';
  if ((process.env.NAVA_AGENT_AZURE_DEPLOYMENT ?? '').toLowerCase().includes('haiku')) {
    throw new Error('LUNA_ONLY: refuse Haiku deployment');
  }
  const twin = createTwin(card);
  const pin = await loadSkillPin();
  const state: RuntimeState = {
    threadId: card.case_id,
    sessionId: card.case_id,
    messages: [],
    pendingToolUseId: null,
    toolOutcomes: {},
    version: 0,
  };
  let proposal: unknown = null;
  const toolCalls: Array<{name: string; input?: unknown; result?: {ok?: boolean; error?: {code?: string} | null}}> = [];
  let tokens = {input: 0, output: 0, cached_input: 0};
  const stopReasons = new Map<number, string | null>();
  const started = Date.now();

  const deps: RuntimeDeps = {
    async load() {
      return {
        threadId: state.threadId,
        sessionId: state.sessionId,
        messages: state.messages.map(message => ({
          role: message.role,
          content: message.content.map(block => ({...block})),
        })),
        pendingToolUseId: state.pendingToolUseId,
        toolOutcomes: {...state.toolOutcomes},
        version: state.version,
      };
    },
    async append(_sessionId, message) {
      state.messages.push(message);
      state.version += 1;
    },
    async event(_sessionId, kind, payload) {
      if (kind === 'model_call' && payload && typeof payload === 'object') {
        const row = payload as Record<string, unknown>;
        tokens.input += Number(row.input_tokens ?? 0);
        tokens.output += Number(row.output_tokens ?? 0);
        tokens.cached_input += Number(row.cache_read_input_tokens ?? 0);
        if (typeof row.assistant_version === 'number') {
          stopReasons.set(row.assistant_version, typeof row.stop_reason === 'string' ? row.stop_reason : null);
        }
      }
    },
    async tools() { return benchTools; },
    async runTool(_sessionId, toolUse) {
      const {name, input} = toolUse;
      let result: {ok: boolean; data: unknown; error: {code: string; message: string; retryable: boolean; outcome: 'known' | 'uncertain'} | null};
      if (name === 'mail_read_thread') {
        result = {ok: true, data: mailPayload(card), error: null};
      } else if (name === 'skill_read') {
        const req = (input ?? {}) as {skill_name?: string; path?: string};
        const skill = req.skill_name ?? 'triage';
        const path = req.path ?? 'SKILL.md';
        const key = path.startsWith('../') ? path.replace(/^\.\.\//, '') : `${skill}/${path}`;
        const alt = `${skill}/${path}`;
        const text = pin.files[key] ?? pin.files[alt] ?? pin.files[path];
        if (!text) result = {ok: false, data: null, error: {code: 'SKILL_REFERENCE_UNAVAILABLE', message: 'Skill reference unavailable in pinned tree.', retryable: false, outcome: 'known'}};
        else result = {ok: true, data: {skill_name: skill, path, version: pin.version, text}, error: null};
      } else if (name === 'proposal_publish') {
        proposal = input;
        result = {ok: true, data: {proposal_id: `bench-${card.case_id}`, revision: 1, phase: 'ready'}, error: null};
      } else if (name.startsWith('hms_')) {
        result = await twin.dispatch(name, input) as typeof result;
      } else {
        result = {ok: false, data: null, error: {code: 'UNAVAILABLE', message: `Bench tool ${name} unavailable`, retryable: false, outcome: 'known'}};
      }
      toolCalls.push({name, input, result});
      return {kind: 'result', result};
    },
    async recordToolOutcome(_sessionId, toolUseId, result) {
      state.toolOutcomes[toolUseId] = result;
    },
    async assistantStopReason(_sessionId, version) {
      return stopReasons.has(version) ? stopReasons.get(version)! : null;
    },
    async publishStaffReview() {},
    async park(_sessionId, toolUseId) { state.pendingToolUseId = toolUseId; },
    async finish() {},
  };

  const runtime = new AzureRuntime(deps, {system: SYSTEM, maxSteps: 30});
  const nudge = `Bench case ${card.case_id} (${card.workflow}). as_of=${card.as_of}. Property HRCEN. Read mail_read_thread first, then skills/tools, then proposal_publish.`;
  await runtime.startTurn(card.case_id, {sessionId: card.case_id, content: nudge});
  return scoreCase({card, proposal, toolCalls, tokens, wall_ms: Date.now() - started});
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, () => worker()));
  return out;
}

export async function runBench(options: {casesDir?: string; concurrency?: number; limit?: number; outDir?: string} = {}) {
  const casesDir = options.casesDir ?? join(DATA_ROOT, 'cases/v1');
  const outDir = options.outDir ?? join(DATA_ROOT, 'runs', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const concurrency = options.concurrency ?? 20;
  await mkdir(outDir, {recursive: true});
  const entries = (await readdir(casesDir, {withFileTypes: true})).filter(e => e.isDirectory());
  const cards: CaseCard[] = [];
  for (const entry of entries) {
    try {
      const raw = JSON.parse(await readFile(join(casesDir, entry.name, 'case.json'), 'utf8')) as CaseCard;
      cards.push(raw);
    } catch { /* skip */ }
  }
  const selected = cards.slice(0, options.limit ?? cards.length);
  const wallStarted = Date.now();
  const scores = await mapPool(selected, concurrency, async card => {
    try {
      const score = await runCase(card);
      await writeFile(join(outDir, `${card.case_id}.json`), JSON.stringify(score));
      return score;
    } catch (error) {
      const failed: CaseScore = {
        case_id: card.case_id,
        workflow: card.workflow,
        fields: [],
        tool_quality: {calls: [], right_tool: 0, wasted_calls: 0, key_arg_hits: 0, key_arg_misses: 0},
        tokens: {input: 0, output: 0, cached_input: 0},
        cost_usd: 0,
        wall_ms: 0,
        twin_uncovered: [`RUN_ERROR:${error instanceof Error ? error.message : 'unknown'}`],
        proposal: null,
      };
      await writeFile(join(outDir, `${card.case_id}.json`), JSON.stringify(failed));
      return failed;
    }
  });
  const board = buildScoreboard(scores);
  board.totals.wall_ms = Date.now() - wallStarted;
  const {dev, holdout, labels} = assignSplit(selected);
  const devIds = new Set(dev.map(card => card.case_id));
  const holdIds = new Set(holdout.map(card => card.case_id));
  const devBoard = buildScoreboard(scores.filter(score => devIds.has(score.case_id)));
  const holdBoard = buildScoreboard(scores.filter(score => holdIds.has(score.case_id)));
  await writeFile(join(outDir, 'scoreboard.json'), JSON.stringify(board, null, 2));
  await writeFile(join(outDir, 'scoreboard-dev.json'), JSON.stringify(devBoard, null, 2));
  await writeFile(join(outDir, 'scoreboard-holdout.json'), JSON.stringify(holdBoard, null, 2));
  await writeFile(join(outDir, 'split.json'), JSON.stringify({
    seed: 'replay-bench-20261119-v1',
    n_dev: dev.length,
    n_holdout: holdout.length,
    labels,
  }, null, 2));
  return {outDir, board, devBoard, holdBoard, labels};
}

export type BenchResult = {
  outDir: string;
  board: Scoreboard;
  devBoard: Scoreboard;
  holdBoard: Scoreboard;
  labels: Record<string, 'dev' | 'holdout'>;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 20);
  const limit = process.env.BENCH_LIMIT ? Number(process.env.BENCH_LIMIT) : undefined;
  const {outDir, board} = await runBench({concurrency, limit});
  process.stdout.write(JSON.stringify({outDir, n: board.n, totals: board.totals, by_workflow: board.by_workflow}, null, 2) + '\n');
}
