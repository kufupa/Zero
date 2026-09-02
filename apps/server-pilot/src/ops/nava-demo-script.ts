import type { NavaDashboard } from './nava-fte-dashboard.js';
import {
  ANSI_RESET,
  NAVA_BLUE_ANSI,
  NAVA_DIM_ANSI,
  NAVA_OK_ANSI,
  bar,
  navaWordmark,
} from './nava-fte-dashboard-view.js';

export type NavaDemoPhase = 'idle' | 'running' | 'dash' | 'chat';

export type NavaAgentStatus = 'queued' | 'running' | 'done';

export type NavaAgentRow = {
  id: string;
  label: string;
  detail: string;
  status: NavaAgentStatus;
};

export type NavaDemoEvent =
  | { atMs: number; kind: 'log'; text: string }
  | { atMs: number; kind: 'spawn'; agents: Array<{ id: string; label: string; detail: string }> }
  | { atMs: number; kind: 'progress'; id: string; status: NavaAgentStatus }
  | { atMs: number; kind: 'wave_done'; label: string }
  | { atMs: number; kind: 'finish' };

export type NavaDemoState = {
  phase: NavaDemoPhase;
  elapsedMs: number;
  logs: string[];
  /** Lines waiting to type into Live notes. */
  streamQueue: string[];
  /** Line currently typing (partial reveal). */
  streamLine: string | null;
  streamChars: number;
  agents: NavaAgentRow[];
  waveNote: string;
};

const WARN = '\x1b[38;2;245;197;66m';
const MAGENTA = '\x1b[38;2;180;140;255m';

function dim(text: string): string {
  return `${NAVA_DIM_ANSI}${text}${ANSI_RESET}`;
}
function ok(text: string): string {
  return `${NAVA_OK_ANSI}${text}${ANSI_RESET}`;
}
function accent(text: string): string {
  return `${NAVA_BLUE_ANSI}${text}${ANSI_RESET}`;
}
function warn(text: string): string {
  return `${WARN}${text}${ANSI_RESET}`;
}
function soft(text: string): string {
  return `${MAGENTA}${text}${ANSI_RESET}`;
}

function formatMinutes(value: number | null): string {
  return value === null ? 'n/a' : `${value}m`;
}

/** Parallel swarm — looks busy, numbers stay honest to Hermes corpus. */
export function buildDemoAgents(): NavaAgentRow[] {
  const batchWave = Array.from({ length: 18 }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return {
      id: `b${n}`,
      label: `batch-${n}`,
      detail: 'full-thread review · REP pack',
      status: 'queued' as const,
    };
  });
  const specialty: NavaAgentRow[] = [
    { id: 's01', label: 'census', detail: '3268 msgs · direction · day', status: 'queued' },
    { id: 's02', label: 'residual', detail: '111 residual inbound triggers', status: 'queued' },
    { id: 's03', label: 'source-fam', detail: 'harmonize exclusive partition', status: 'queued' },
    { id: 's04', label: 'synxis-risk', detail: 'CRS exception screening', status: 'queued' },
    { id: 's05', label: 'security', detail: 'quarantine ≠ spam adjudication', status: 'queued' },
    { id: 's06', label: 'outbound', detail: '311 msgs · 301 threads', status: 'queued' },
    { id: 's07', label: 'attach', detail: '1334 inbound markers · 45.1%', status: 'queued' },
    { id: 's08', label: 'hitl', detail: '1134 human-lock threads', status: 'queued' },
    { id: 's09', label: 'tools', detail: '1409 tool-demand rows', status: 'queued' },
    { id: 's10', label: 'dash-spec', detail: 'exception-first queue cards', status: 'queued' },
  ];
  return [...specialty.slice(0, 2), ...batchWave, ...specialty.slice(2)];
}

/**
 * ~35–42s medium replay. Crumpled from Hermes follow-up loops / finals,
 * rewritten as Nava voice (no Hermes branding in UI copy).
 */
export function buildDemoTimeline(): NavaDemoEvent[] {
  const events: NavaDemoEvent[] = [];
  const log = (atMs: number, text: string) => events.push({ atMs, kind: 'log', text });

  log(0, 'Nava · connected mailbox scope sealed (2 active transports)');
  log(300, 'Last full pass: 2026-08-25T22:24:55.657Z · today 2026-08-27 · window = 2 days');
  log(700, 'Delta since last run: +164 messages · +38 threads · +149 inbound · +15 outbound');
  log(1100, 'Loading baseline dump · asOf 2026-08-25T22:24:55.657Z');
  log(1500, 'Merging delta into working set · re-locking census before REP pack');
  log(1900, 'Census lock (merged): 3,268 messages · 2,403 threads · 2,957 inbound · 311 outbound');
  log(2300, 'Inbound-only retained gap: 2,102 / 2,403 (87.5%) — not proof of no reply elsewhere');
  log(2700, 'Planning analysis path: census → REP pack → full-thread review → risk rulebook → dashboard');

  // specialty census/residual first
  events.push({
    atMs: 3000,
    kind: 'spawn',
    agents: [
      { id: 's01', label: 'census', detail: '3268 msgs · direction · day' },
      { id: 's02', label: 'residual', detail: '111 residual inbound triggers' },
    ],
  });
  events.push({ atMs: 3200, kind: 'progress', id: 's01', status: 'running' });
  events.push({ atMs: 3400, kind: 'progress', id: 's02', status: 'running' });
  log(3600, 'Deterministic census: pattern classes, intent/fact hits, attachment markers');
  log(4200, 'Attachment marker rate: 1,334 / 2,957 inbound (45.1%) — marker ≠ MIME proof');
  events.push({ atMs: 4800, kind: 'progress', id: 's01', status: 'done' });
  events.push({ atMs: 5000, kind: 'progress', id: 's02', status: 'done' });
  log(5200, 'Residual judgment: 99 unknown abstentions kept visible · no forced route');

  // spawn all 18 batches in parallel waves of 6
  const batchSpawn = (startMs: number, from: number, to: number) => {
    const agents = [];
    for (let i = from; i <= to; i++) {
      const n = String(i).padStart(3, '0');
      agents.push({ id: `b${n}`, label: `batch-${n}`, detail: 'full-thread review · REP pack' });
    }
    events.push({ atMs: startMs, kind: 'spawn', agents });
    for (let i = from; i <= to; i++) {
      const n = String(i).padStart(3, '0');
      const offset = (i - from) * 80;
      events.push({ atMs: startMs + 200 + offset, kind: 'progress', id: `b${n}`, status: 'running' });
    }
  };
  const batchDone = (startMs: number, from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      const n = String(i).padStart(3, '0');
      const offset = (i - from) * 120;
      events.push({ atMs: startMs + offset, kind: 'progress', id: `b${n}`, status: 'done' });
    }
  };

  log(5600, 'Context calc: packing 2,403 threads into 18 size-bounded REP batches');
  log(6000, 'Coverage contract: 2,403 unique thread IDs · zero missing · zero duplicate');
  batchSpawn(6400, 1, 6);
  log(6800, 'Wave A live · batch-001…006 · 699 threads / 933 msgs');
  batchDone(9400, 1, 6);
  events.push({ atMs: 10200, kind: 'wave_done', label: 'Wave A complete (batch-001…006)' });

  batchSpawn(10400, 7, 12);
  log(10800, 'Wave B live · batch-007…012 · 835 threads / 1,192 msgs');
  batchDone(13400, 7, 12);
  events.push({ atMs: 14200, kind: 'wave_done', label: 'Wave B complete (batch-007…012)' });

  batchSpawn(14400, 13, 18);
  log(14800, 'Wave C live · batch-013…018 · 869 threads / 1,143 msgs');
  batchDone(17400, 13, 18);
  events.push({ atMs: 18200, kind: 'wave_done', label: 'Wave C complete — full-thread coverage 2403/2403' });

  log(18600, 'Full-thread review settled: human-lock 1,134 · low-confidence 68 · tool-demand 1,409');
  log(19200, 'Routes (planning only): ops 1,097 · resolved 647 · spam 397 · unknown 152 · at-risk 110');

  events.push({
    atMs: 19600,
    kind: 'spawn',
    agents: [
      { id: 's03', label: 'source-fam', detail: 'harmonize exclusive partition' },
      { id: 's04', label: 'synxis-risk', detail: 'CRS exception screening' },
      { id: 's05', label: 'security', detail: 'quarantine ≠ spam adjudication' },
      { id: 's06', label: 'outbound', detail: '311 msgs · 301 threads' },
      { id: 's07', label: 'attach', detail: '1334 inbound markers · 45.1%' },
      { id: 's08', label: 'hitl', detail: '1134 human-lock threads' },
      { id: 's09', label: 'tools', detail: '1409 tool-demand rows' },
      { id: 's10', label: 'dash-spec', detail: 'exception-first queue cards' },
    ],
  });
  for (const id of ['s03', 's04', 's05', 's06', 's07', 's08', 's09', 's10']) {
    events.push({ atMs: 20000, kind: 'progress', id, status: 'running' });
  }

  log(20400, 'Loop 01 · web-grounded risk semantics — SynXis create/modify/cancel + Defender quarantine');
  log(21400, 'Loop 02 · outbound/attachments/KPI — outbound≠closure · attachment≠file');
  log(22400, 'Loop 03 · taxonomy — urgency × external-request × potential exposure × exception overlays');
  events.push({ atMs: 23000, kind: 'progress', id: 's06', status: 'done' });
  events.push({ atMs: 23200, kind: 'progress', id: 's07', status: 'done' });

  log(23600, 'Loop 04 · rulebook — SynXis exception is screening signal until authoritative join');
  log(24600, 'Security: quarantine alone is neither incident nor safe-to-file · human-lock when verdict missing');
  events.push({ atMs: 25200, kind: 'progress', id: 's04', status: 'done' });
  events.push({ atMs: 25400, kind: 'progress', id: 's05', status: 'done' });
  events.push({ atMs: 25600, kind: 'progress', id: 's08', status: 'done' });

  log(26200, 'Source-family harmonize: security_quarantine 526 · payment_gateway_pop 506 · confirmation_document 329');
  log(27200, '… ota_channel 309 · synxis_integration 155 · night_audit_internal 154 · reservation_pms_notice 152');
  events.push({ atMs: 27800, kind: 'progress', id: 's03', status: 'done' });

  log(28400, 'Loop 05 · dashboard cards: triage · SynXis · payment · security · outbound · documents · aging');
  log(29400, 'Loop 06 · product boundary: exception-first triage assistant · shadow only · no side effects');
  log(30400, 'Tool wave 0: read-only first — hms_find_reservation · list_documents · read_folio · quote_stay');
  events.push({ atMs: 31000, kind: 'progress', id: 's09', status: 'done' });
  events.push({ atMs: 31200, kind: 'progress', id: 's10', status: 'done' });

  log(31800, 'Final synthesis: conditional pass for private planning · fail for automation until joins proven');
  log(32600, 'Staff time pressure (corpus first-response eligible sample): using live hours.json KPIs');
  log(33400, 'No realized revenue/ROI claimed — potential exposure signals only');
  log(34200, 'Delta merge closed · reassembling exception-first dashboard…');
  events.push({ atMs: 35800, kind: 'finish' });
  return events.sort((a, b) => a.atMs - b.atMs);
}

export function initialDemoState(): NavaDemoState {
  return {
    phase: 'idle',
    elapsedMs: 0,
    logs: [],
    streamQueue: [],
    streamLine: null,
    streamChars: 0,
    agents: [],
    waveNote: '',
  };
}

/** Reveal live-note characters; speeds up when queue backs up. */
export function advanceLogStream(
  state: NavaDemoState,
  dtMs: number,
  baseCharsPerSec = 110,
): NavaDemoState {
  let logs = [...state.logs];
  let queue = [...state.streamQueue];
  let line = state.streamLine;
  let chars = state.streamChars;
  const backlog = queue.length + (line ? 1 : 0);
  const cps =
    backlog > 4 ? baseCharsPerSec * 2.4 : backlog > 2 ? baseCharsPerSec * 1.6 : baseCharsPerSec;
  let budget = Math.max(0, (dtMs / 1000) * cps);

  while (budget > 0.5 || (!line && queue.length > 0)) {
    if (!line) {
      if (queue.length === 0) break;
      line = queue.shift()!;
      chars = 0;
    }
    const remaining = line.length - chars;
    if (remaining <= 0) {
      logs.push(line);
      line = null;
      chars = 0;
      continue;
    }
    const take = Math.max(1, Math.min(remaining, Math.ceil(budget)));
    chars += take;
    budget -= take;
    if (chars >= line.length) {
      logs.push(line);
      line = null;
      chars = 0;
    } else {
      break;
    }
  }

  return {
    ...state,
    logs,
    streamQueue: queue,
    streamLine: line,
    streamChars: chars,
  };
}

export function flushLogStream(state: NavaDemoState): NavaDemoState {
  const logs = [...state.logs];
  if (state.streamLine) logs.push(state.streamLine);
  logs.push(...state.streamQueue);
  return {
    ...state,
    logs,
    streamQueue: [],
    streamLine: null,
    streamChars: 0,
  };
}

export function applyDemoEvents(
  state: NavaDemoState,
  events: readonly NavaDemoEvent[],
  fromMs: number,
  toMs: number,
): NavaDemoState {
  let next: NavaDemoState = {
    ...state,
    logs: [...state.logs],
    streamQueue: [...state.streamQueue],
    agents: state.agents.map((row) => ({ ...row })),
    elapsedMs: toMs,
  };
  let finished = false;
  for (const event of events) {
    if (event.atMs < fromMs || event.atMs > toMs) continue;
    switch (event.kind) {
      case 'log':
        next.streamQueue.push(event.text);
        break;
      case 'spawn': {
        const existing = new Map(next.agents.map((row) => [row.id, row]));
        for (const agent of event.agents) {
          existing.set(agent.id, { ...agent, status: 'queued' });
        }
        next.agents = [...existing.values()];
        break;
      }
      case 'progress': {
        next.agents = next.agents.map((row) =>
          row.id === event.id ? { ...row, status: event.status } : row,
        );
        break;
      }
      case 'wave_done':
        next.waveNote = event.label;
        next.streamQueue.push(event.label);
        break;
      case 'finish':
        finished = true;
        next.phase = 'dash';
        break;
    }
  }
  const span = Math.max(0, toMs - Math.max(fromMs, 0));
  next = advanceLogStream(next, span);
  if (finished) next = flushLogStream(next);
  return next;
}

export function demoTimelineDurationMs(events: readonly NavaDemoEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.atMs), 0);
}

export function renderAgentGrid(agents: readonly NavaAgentRow[]): string {
  if (agents.length === 0) return dim(' (no sub-agents yet)');
  const cols = 3;
  const cellW = 34;
  const lines: string[] = [];
  for (let i = 0; i < agents.length; i += cols) {
    const slice = agents.slice(i, i + cols);
    const row = slice
      .map((agent) => {
        const mark =
          agent.status === 'done'
            ? ok('●')
            : agent.status === 'running'
              ? accent('●')
              : dim('○');
        const body = `${mark} ${agent.label}`.padEnd(cellW).slice(0, cellW);
        return body;
      })
      .join('');
    lines.push(` ${row}`);
  }
  const running = agents.filter((a) => a.status === 'running').length;
  const done = agents.filter((a) => a.status === 'done').length;
  lines.push(dim(` parallel ${agents.length} · running ${running} · done ${done}`));
  return lines.join('\n');
}

export function renderIdleBoard(dashboard: NavaDashboard): { board: string; footer: string } {
  const asOfDay = dashboard.loaded.asOf.slice(0, 10);
  const hours = dashboard.hours;
  return {
    board: [
      navaWordmark(),
      ` ${accent('NAVA')}  ${dim('forward-deploy engineer · connected mailbox')}`,
      ` ${ok('● Connected')}  ${dim('2 active transports · private local corpus')}`,
      dim(` asOf ${asOfDay}`),
      dim(' last pass 2026-08-25 · +164 msgs / +38 threads since (2d) · will re-merge on run'),
      '',
      accent(' What is loaded'),
      `  mailboxes     ${dashboard.loaded.mailboxes}`,
      `  messages      ${dashboard.loaded.messages}   inbound ${dashboard.analysisMeta.inboundMessages} · outbound ${dashboard.analysisMeta.outboundMessages}`,
      `  threads       ${dashboard.loaded.threads}`,
      `  inbound-only  ${dashboard.inboundOnlyDisplay.inboundOnlyThreads}/${dashboard.inboundOnlyDisplay.threadCount} (${dashboard.inboundOnlyDisplay.sharePercent})`,
      '',
      accent(' Why analyze'),
      '  Turn this reservationist inbox into an exception-first triage plan:',
      '  attention mix · source families · HITL locks · SynXis/security rulebook · read-tool wave.',
      '  Shadow only — no folder flips, no sends, no HMS writes.',
      '',
      accent(' Staff-time signal (eligible first-response sample)'),
      `  nEligible ${hours.nEligibleFirstResponse} · median ${formatMinutes(hours.medianFirstResponseMinutes)} · p90 ${formatMinutes(hours.p90FirstResponseMinutes)}`,
      dim(`  ${hours.caveat}`),
      '',
      soft(' Press Enter to run Nava analysis (~30–45s parallel sub-agents).'),
    ].join('\n'),
    footer: 'Enter start analysis · q quit',
  };
}

export function renderRunningBoard(
  dashboard: NavaDashboard,
  state: NavaDemoState,
): { board: string; footer: string } {
  const asOfDay = dashboard.loaded.asOf.slice(0, 10);
  const streaming =
    state.streamLine !== null
      ? `${state.streamLine.slice(0, state.streamChars)}${accent('▌')}`
      : null;
  const noteLines = [
    ...state.logs.map((line) => ` ${dim('›')} ${line}`),
    ...(streaming ? [` ${dim('›')} ${streaming}`] : []),
  ].slice(-12);
  const pct = Math.min(100, Math.round((state.elapsedMs / 35500) * 100));
  const meter = '█'.repeat(Math.max(1, Math.round(pct / 5))).padEnd(20, '░');
  return {
    board: [
      navaWordmark(),
      ` ${accent('NAVA')}  ${warn('analyzing')}  ${dim('connected mailbox · local')}`,
      dim(` asOf ${asOfDay} · ${dashboard.loaded.messages} msgs · ${dashboard.loaded.threads} threads`),
      '',
      ` ${accent(meter)}  ${pct}%`,
      state.waveNote ? ` ${ok(state.waveNote)}` : dim(' deploying analysis swarm…'),
      '',
      accent(' Sub-agents'),
      renderAgentGrid(state.agents),
      '',
      accent(' Live notes'),
      ...(noteLines.length > 0 ? noteLines : [dim(' › waiting…')]),
    ].join('\n'),
    footer: 'analysis running · q abort',
  };
}

export function renderDashBoard(dashboard: NavaDashboard): { board: string; footer: string } {
  const asOfDay = dashboard.loaded.asOf.slice(0, 10);
  const mixLines = dashboard.mix
    .map(
      (row) =>
        ` ${accent(bar(row.share))}  ${row.count.toString().padStart(4, ' ')}  ${row.share.padStart(5, ' ')}  ${row.className}`,
    )
    .join('\n');
  const familyLines = dashboard.sourceFamilies
    .map(
      (row) =>
        ` ${ok(bar(row.share))}  ${row.threads.toString().padStart(4, ' ')}  ${row.share.padStart(5, ' ')}  ${row.family}`,
    )
    .join('\n');
  const routeLines = dashboard.lunaRoutes
    .map(
      (row) =>
        ` ${row.threads.toString().padStart(4, ' ')}  ${row.share.padStart(5, ' ')}  ${row.route}`,
    )
    .join('\n');
  const toolLines = dashboard.tools
    .map(
      (row) =>
        ` ${row.rank}. ${row.tool}  ${dim(row.evidence)}  ${dim(`live=${String(row.live)} shadow=${String(row.shadow)}`)}`,
    )
    .join('\n');

  return {
    board: [
      navaWordmark(),
      ` ${accent('NAVA')}  ${ok('● dashboard')}  ${dim('exception-first · shadow')}`,
      dim(` asOf ${asOfDay} · ${dashboard.loaded.mailboxes} mailboxes · ${dashboard.loaded.messages} msgs · ${dashboard.loaded.threads} threads`),
      '',
      accent(' Staff-time pressure'),
      `  nEligible ${dashboard.hours.nEligibleFirstResponse}   median ${formatMinutes(dashboard.hours.medianFirstResponseMinutes)}   p90 ${formatMinutes(dashboard.hours.p90FirstResponseMinutes)}`,
      `  inbound-only ${dashboard.inboundOnlyDisplay.inboundOnlyThreads}/${dashboard.inboundOnlyDisplay.threadCount} (${dashboard.inboundOnlyDisplay.sharePercent})`,
      dim(`  ${dashboard.hours.caveat}`),
      dim('  No realized revenue/ROI claimed — potential exposure signals only.'),
      '',
      accent(' Attention mix · inbound n=2957'),
      mixLines,
      dim(`  ${dashboard.mixCaption}`),
      '',
      ok(' Source family · harmonized exclusive · n=2403'),
      familyLines,
      dim('  security quarantine ≠ spam · partitions additive only under this precedence'),
      '',
      accent(' Full-thread routes'),
      routeLines,
      `  human-lock ${dashboard.lunaHumanLock.locked}/${dashboard.lunaHumanLock.threads}   low-confidence ${dashboard.analysisMeta.lowConfidenceThreads}   tool-demand ${dashboard.analysisMeta.toolDemandRows}`,
      '',
      warn(' HITL locks'),
      `  ${dashboard.hitlLocks.join(' · ')}`,
      `  ${dashboard.hitlNote}`,
      '',
      soft(' SynXis / security rulebook'),
      '  SynXis exception = screening candidate until authoritative CRS↔PMS join.',
      '  Quarantine alone ≠ incident and ≠ spam. Missing verdict → human-lock.',
      '  Outbound history ≠ closure. Attachment marker ≠ MIME/file proof.',
      '',
      accent(' Ranked reads · build-first wave'),
      toolLines,
      '',
      dim(' Shadow only. No folder flip. No send. No HMS write.'),
      '',
      soft(' Enter continue chatting with Nava (live) · dashboard stays above.'),
    ].join('\n'),
    footer: '↑↓ scroll · Enter open live chat · q quit',
  };
}

export type NavaChatTurn = { role: 'you' | 'nava' | 'system'; text: string };

export function renderChatBoard(
  dashboard: NavaDashboard,
  opts: {
    turns: readonly NavaChatTurn[];
    draft: string;
    status: string;
  },
): { board: string; footer: string } {
  const dash = renderDashBoard(dashboard).board;
  // Trim dash chrome footer invite — chat owns the bottom.
  const dashCore = dash
    .split('\n')
    .filter((line) => !line.includes('Enter continue chatting'))
    .join('\n');
  const wrapTurn = (prefix: string, body: string, dimBody = false): string[] => {
    const lines = body.split('\n');
    return lines.map((line, idx) => {
      const text = dimBody ? dim(line) : line;
      if (idx === 0) return ` ${prefix} ${text}`;
      return `       ${text}`;
    });
  };
  const turns =
    opts.turns.length === 0
      ? [dim(' (live Nava session connecting…)')]
      : opts.turns.flatMap((turn) => {
          if (turn.role === 'you') return wrapTurn(accent('you'), turn.text);
          if (turn.role === 'system') return wrapTurn(dim('sys'), turn.text, true);
          return wrapTurn(ok('nava'), turn.text || dim('…'));
        });
  return {
    board: [
      dashCore,
      '',
      accent(' ── live chat ──'),
      ...turns,
      opts.status ? dim(` ${opts.status}`) : '',
      ` ${accent('>')} ${opts.draft}${opts.draft.length === 0 ? dim('ask about triage, tools, HITL…') : '▌'}`,
    ].join('\n'),
    footer: 'type + Enter send · Esc clear · q quit',
  };
}

export function renderDemoBoard(
  dashboard: NavaDashboard,
  state: NavaDemoState,
  chat?: {
    turns: readonly NavaChatTurn[];
    draft: string;
    status: string;
  },
): { board: string; footer: string } {
  if (state.phase === 'idle') return renderIdleBoard(dashboard);
  if (state.phase === 'running') return renderRunningBoard(dashboard, state);
  if (state.phase === 'chat' && chat) return renderChatBoard(dashboard, chat);
  return renderDashBoard(dashboard);
}
