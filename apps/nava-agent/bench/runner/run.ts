import {readdir, readFile, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AzureRuntime} from '../../src/agent-runtime/azure.js';
import type {RuntimeDeps, RuntimeMessage, RuntimeState, ToolDefinition} from '../../src/agent-runtime/loop.js';
import {createTwin} from '../twin/index.js';
import type {CaseCard} from '../types.js';
import {buildScoreboard, scoreCase, type CaseScore} from './score.js';
const DATA_ROOT = process.env.NAVA_BENCH_DATA_ROOT ?? '/home/orca/.local/share/zero/bench/replay-bench-20261119';

const SYSTEM = `Read the selected inbound with mail_read_thread. Use the pinned triage files supplied in the system context, or load triage/SKILL.md and its references with skill_read if they were not supplied. Load the relevant workflow skill and any references not already supplied with skill_read. Handle the selected request using quote, create, amend, cancel, filing or triage as the pinned skills specify. Use only the registered tools. Publish the grounded proposal, with editable field paths for staff and native_result null (the server binds actual quote captures). For uncertain intent, scope or targets, use needs_info or staff_review. Staff runs the native action after review; never call a staging or writing tool. Never send mail, invent missing facts, or treat earlier quoted material as the current ask. End after publishing the proposal. Save is disabled.`;

function tool(name: string, description: string, properties: Record<string, unknown>): ToolDefinition {
  // Azure strict mode requires every property key to appear in required.
  return {
    name,
    description,
    input_schema: {type: 'object', properties, required: Object.keys(properties), additionalProperties: false},
  };
}

/** Azure Foundry strict-compatible schemas (no minLength/format/oneOf; every prop required). */
const strOrNull = {type: ['string', 'null'] as unknown as string};
const objOpen = {type: 'object', additionalProperties: false, properties: {} as Record<string, unknown>, required: [] as string[]};
const benchTools: ToolDefinition[] = [
  tool('mail_read_thread', 'Read the selected mail thread for this bench case.', {}),
  tool('skill_read', 'Read a pinned skill or its relative Markdown reference.', {
    skill_name: {type: 'string', enum: ['triage', 'quote', 'create', 'amend', 'cancel', 'filing']},
    path: strOrNull,
  }),
  tool('hms_search_reservations', 'Search twin reservations.', {
    property_code: {type: 'string'},
    criteria: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reservation_id: strOrNull,
        guest_name: strOrNull,
        guest_first_name: strOrNull,
        guest_name_is_surname: {type: ['boolean', 'null']},
        arrival_date: strOrNull,
        departure_date: strOrNull,
      },
      required: ['reservation_id', 'guest_name', 'guest_first_name', 'guest_name_is_surname', 'arrival_date', 'departure_date'],
    },
  }),
  tool('hms_read_reservation', 'Read a twin reservation.', {
    property_code: {type: 'string'},
    reservation_id: {type: 'string'},
    arrival_date: strOrNull,
    departure_date: strOrNull,
    last_name: strOrNull,
  }),
  tool('hms_read_catalogue', 'Read twin catalogue sections.', {
    property_code: {type: 'string'},
    arrival_date: strOrNull,
    departure_date: strOrNull,
    kinds: {
      type: 'array',
      items: {type: 'string', enum: ['room_type', 'rate_plan', 'meal_plan', 'source_of_business', 'track', 'guarantee_type', 'organization', 'agency']},
    },
  }),
  tool('hms_search_parties', 'Search twin parties/profiles.', {
    property_code: {type: 'string'},
    kind: {type: 'string', enum: ['guest', 'organization', 'agency', 'ar_account']},
    field: {type: 'string', enum: ['last_name', 'first_name', 'email', 'phone', 'profile_id', 'name']},
    query: {type: 'string'},
  }),
  tool('hms_quote', 'Quote from recorded twin prices only.', {
    quote_id: {type: 'string'},
    party_name: strOrNull,
    property_code: {type: 'string'},
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group_id: {type: 'string'},
          arrival_date: {type: 'string'},
          departure_date: {type: 'string'},
          rooms: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: {type: 'string'},
                quantity: {type: 'number'},
                adults: {type: 'number'},
                children: {type: 'number'},
                child_ages: {type: 'array', items: {type: 'number'}},
              },
              required: ['id', 'quantity', 'adults', 'children', 'child_ages'],
            },
          },
        },
        required: ['group_id', 'arrival_date', 'departure_date', 'rooms'],
      },
    },
    details: {type: ['string', 'null'], enum: ['summary', 'full', null]},
    max_options_per_group: {type: ['number', 'null']},
  }),
  // proposal_publish must allow free-form booking fields; keep non-strict for Azure.
  {
    name: 'proposal_publish',
    description: 'Publish the grounded proposal for scoring.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['workflow', 'disposition', 'reason', 'bookings', 'actions', 'field_specs', 'missing', 'warnings', 'reply_draft', 'native_result'],
      properties: {
        workflow: {type: 'string', enum: ['triage', 'quote', 'create', 'amend', 'cancel', 'filing']},
        disposition: {type: 'string', enum: ['propose', 'needs_info', 'decline', 'skip', 'staff_review']},
        reason: strOrNull,
        bookings: {type: 'array', items: {type: 'object', additionalProperties: true, properties: {
          id: {type: 'string'},
          property_code: {type: 'string'},
          reservation_id: strOrNull,
          current_state: {type: 'object', additionalProperties: true, properties: {}},
          fields: {type: 'object', additionalProperties: true, properties: {}},
        }}},
        actions: {type: 'array', items: {type: 'object', additionalProperties: true, properties: {
          id: {type: 'string'},
          type: {type: 'string'},
          booking_ids: {type: 'array', items: {type: 'string'}},
          details: {type: 'object', additionalProperties: true, properties: {}},
        }}},
        field_specs: {type: 'array', items: {type: 'object', additionalProperties: true, properties: {
          path: {type: 'string'},
          editable: {type: 'boolean'},
        }}},
        missing: {type: 'array', items: {type: 'string'}},
        warnings: {type: 'array', items: {type: 'string'}},
        reply_draft: strOrNull,
        native_result: {type: ['object', 'null'], additionalProperties: true, properties: {}},
      },
    },
  },
];

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
        body_text: nested.body ?? nested.body_text ?? '',
        received_at: nested.timestamp ?? nested.received_at ?? card.as_of,
        attachments: [],
      };
    }),
    {
      id: String(selected?.message_id ?? 'selected'),
      direction: 'inbound',
      from: selected?.addresses ?? selected?.from ?? null,
      to: [],
      cc: [],
      subject: selected?.subject ?? '',
      body_text: selected?.body_text ?? '',
      received_at: selected?.received_at ?? card.as_of,
      attachments: (selected?.pdf_attachments_text as unknown[] ?? []).map((pdf, i) => {
        const row = pdf as Record<string, unknown>;
        return {
          id: `pdf-${i}`,
          name: row.filename ?? `attachment-${i}.pdf`,
          content_type: 'application/pdf',
          extracted_text: String(row.text ?? '').slice(0, 20_000),
        };
      }),
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
        body_text: String(msg.body ?? ''),
        received_at: msg.timestamp ?? card.as_of,
        attachments: [],
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
  const twin = createTwin(card, {mode: 'twin'});
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
  await writeFile(join(outDir, 'scoreboard.json'), JSON.stringify(board, null, 2));
  return {outDir, board};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 20);
  const limit = process.env.BENCH_LIMIT ? Number(process.env.BENCH_LIMIT) : undefined;
  const {outDir, board} = await runBench({concurrency, limit});
  process.stdout.write(JSON.stringify({outDir, n: board.n, totals: board.totals, by_workflow: board.by_workflow}, null, 2) + '\n');
}
