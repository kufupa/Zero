import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessTerminal, Text, TUI, matchesKey } from '@earendil-works/pi-tui';
import type { NavaDashboard } from '../apps/server-pilot/src/ops/nava-fte-dashboard.ts';
import {
  applyDemoEvents,
  buildDemoTimeline,
  demoTimelineDurationMs,
  initialDemoState,
  renderDemoBoard,
  type NavaChatTurn,
  type NavaDemoState,
} from '../apps/server-pilot/src/ops/nava-demo-script.ts';
import {
  NAVA_AZURE_DEFAULT_BASE,
  NAVA_AZURE_DEFAULT_MODEL,
  buildAzureChatMessages,
  streamNavaAzure,
  type NavaAzureChatConfig,
} from '../apps/server-pilot/src/ops/nava-azure-chat.ts';
import {
  askNavaHermes,
  ensureNavaCorpusChat,
  NAVA_HERMES_ASK_TIMEOUT_MS,
} from '../apps/server-pilot/src/ops/nava-hermes-bridge.ts';
import {
  NAVA_CORPUS_SESSION_DEFAULT,
  hermesCorpusPosturePrompt,
  navaLiveGreeting,
} from '../apps/server-pilot/src/ops/nava-live-context.ts';

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function loadDashboard(): NavaDashboard {
  const jsonPath = path.join(repoRoot(), 'docs', 'infor-hms', 'nava-fte-dashboard.json');
  return JSON.parse(readFileSync(jsonPath, 'utf8')) as NavaDashboard;
}

function loadAzureConfig(): NavaAzureChatConfig | null {
  const keyPath =
    process.env.NAVA_AZURE_API_KEY_FILE ??
    path.join(repoRoot(), '.nava_azure_api_key');
  const apiKey =
    process.env.NAVA_AZURE_API_KEY?.trim() ||
    (existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '');
  if (!apiKey) return null;
  return {
    baseUrl: process.env.NAVA_AZURE_BASE_URL?.trim() || NAVA_AZURE_DEFAULT_BASE,
    apiKey,
    model: process.env.NAVA_AZURE_MODEL?.trim() || NAVA_AZURE_DEFAULT_MODEL,
    timeoutMs: 120_000,
  };
}

const dashboard = loadDashboard();
if (dashboard.mixTotal !== 2957) {
  throw new Error('dashboard mixTotal must be 2957');
}

const SPEED = Math.max(1, Number.parseFloat(process.env.NAVA_DEMO_SPEED ?? '1') || 1);
const TICK_MS = 200;
const HERMES_HOME =
  process.env.NAVA_HERMES_HOME ?? path.join('/home/ubuntu/.hermes/profiles/zero');
const CORPUS_SESSION =
  process.env.NAVA_HERMES_SESSION?.trim() || NAVA_CORPUS_SESSION_DEFAULT;
const SESSION_FILE = path.join(
  repoRoot(),
  '.private',
  'connected-mailbox-corpus',
  'nava-hermes-session.id',
);
const azureConfig = loadAzureConfig();
// Hermes corpus resume is default. Azure only when explicitly requested.
const useAzure = process.env.NAVA_CHAT_BACKEND === 'azure' && Boolean(azureConfig);

const timeline = buildDemoTimeline();
const durationMs = demoTimelineDurationMs(timeline);

let state: NavaDemoState = initialDemoState();
let timer: ReturnType<typeof setInterval> | null = null;
let lastAppliedMs = 0;
let hermesSessionId = '';
let chatReady = false;
let seeding = false;
let asking = false;
let draft = '';
let chatStatus = '';
const turns: NavaChatTurn[] = [];
const azureHistory: { role: 'user' | 'assistant'; content: string }[] = [];

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const scroll = new Text('', 0, 0);
const dock = new Text('', 0, 0);

function paint(): void {
  const view = renderDemoBoard(
    dashboard,
    state,
    state.phase === 'chat'
      ? {
          turns,
          draft: asking ? '' : draft,
          status: chatStatus,
        }
      : undefined,
  );
  scroll.setText(view.board);
  dock.setText(view.footer);
  tui.requestRender();
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function finish(): void {
  stopTimer();
  tui.stop();
  process.exit(0);
}

async function ensureHermesCorpus(): Promise<void> {
  if (chatReady || seeding) return;
  seeding = true;
  chatStatus = 'resuming corpus session…';
  paint();
  try {
    const result = await ensureNavaCorpusChat({
      hermesHome: HERMES_HOME,
      cwd: repoRoot(),
      corpusSessionId: CORPUS_SESSION,
      posturePrompt: hermesCorpusPosturePrompt(dashboard),
      sessionFile: SESSION_FILE,
      timeoutMs: NAVA_HERMES_ASK_TIMEOUT_MS,
    });
    hermesSessionId = result.sessionId || CORPUS_SESSION;
    if (!result.ok && !result.text) {
      chatStatus = `seed failed: ${result.error ?? 'no reply'}`;
      turns.push({ role: 'system', text: chatStatus });
      return;
    }
    chatReady = true;
    turns.push({
      role: 'nava',
      text: result.text || navaLiveGreeting(),
    });
    chatStatus = `hermes corpus · ${hermesSessionId}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chatStatus = `seed error: ${message}`;
    turns.push({ role: 'system', text: chatStatus });
  } finally {
    seeding = false;
    paint();
  }
}

function ensureAzureSeeded(): void {
  if (chatReady || seeding) return;
  seeding = true;
  chatStatus = 'loading Nava context…';
  paint();
  turns.push({ role: 'nava', text: navaLiveGreeting() });
  chatReady = true;
  chatStatus = `azure ${azureConfig?.model ?? NAVA_AZURE_DEFAULT_MODEL}`;
  seeding = false;
  paint();
}

async function sendAzureChat(question: string): Promise<void> {
  if (!azureConfig) {
    turns.push({ role: 'system', text: 'azure config missing' });
    return;
  }
  azureHistory.push({ role: 'user', content: question });
  turns.push({ role: 'nava', text: '' });
  const navaIdx = turns.length - 1;
  chatStatus = 'nava…';
  paint();
  const result = await streamNavaAzure({
    config: azureConfig,
    messages: buildAzureChatMessages(dashboard, azureHistory),
    onDelta: (full) => {
      turns[navaIdx] = { role: 'nava', text: full };
      chatStatus = 'nava…';
      paint();
    },
  });
  if (!result.ok) {
    turns[navaIdx] = {
      role: 'nava',
      text: `error: ${result.error ?? 'empty reply'}`,
    };
    azureHistory.pop();
    chatStatus = 'ask failed';
    return;
  }
  turns[navaIdx] = { role: 'nava', text: result.text };
  azureHistory.push({ role: 'assistant', content: result.text });
  chatStatus = `azure ${azureConfig.model}`;
}

async function sendHermesChat(question: string): Promise<void> {
  if (!hermesSessionId) {
    await ensureHermesCorpus();
    if (!hermesSessionId) return;
  }
  chatStatus = 'nava working…';
  paint();
  const result = await askNavaHermes({
    hermesHome: HERMES_HOME,
    cwd: repoRoot(),
    sessionId: hermesSessionId,
    question,
    timeoutMs: NAVA_HERMES_ASK_TIMEOUT_MS,
  });
  if (result.sessionId) hermesSessionId = result.sessionId;
  turns.push({
    role: 'nava',
    text: result.ok
      ? result.text
      : `error: ${result.error ?? 'empty reply'}${result.text ? `\n${result.text}` : ''}`,
  });
  chatStatus = result.ok ? `hermes corpus · ${hermesSessionId}` : 'ask failed';
}

async function sendChat(question: string): Promise<void> {
  const q = question.trim();
  if (!q || asking || seeding) return;
  if (!chatReady) {
    if (useAzure) ensureAzureSeeded();
    else await ensureHermesCorpus();
    if (!chatReady) return;
  }
  asking = true;
  turns.push({ role: 'you', text: q });
  draft = '';
  paint();
  try {
    if (useAzure) await sendAzureChat(q);
    else await sendHermesChat(q);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    turns.push({ role: 'system', text: `ask error: ${message}` });
    chatStatus = 'ask error';
  } finally {
    asking = false;
    paint();
  }
}

function enterChat(): void {
  state = { ...state, phase: 'chat' };
  draft = '';
  if (useAzure) {
    chatStatus = 'ready';
    paint();
    ensureAzureSeeded();
  } else {
    chatStatus = hermesSessionId
      ? `hermes corpus · ${hermesSessionId}`
      : 'resuming corpus…';
    paint();
    void ensureHermesCorpus();
  }
}

function startAnalysis(): void {
  if (state.phase !== 'idle') return;
  state = { ...initialDemoState(), phase: 'running' };
  lastAppliedMs = 0;
  paint();
  stopTimer();
  timer = setInterval(() => {
    if (state.phase !== 'running') {
      stopTimer();
      return;
    }
    const nextElapsed = Math.min(durationMs, state.elapsedMs + TICK_MS * SPEED);
    const fromMs = lastAppliedMs <= 0 ? -1 : lastAppliedMs;
    state = applyDemoEvents(state, timeline, fromMs, nextElapsed);
    lastAppliedMs = nextElapsed + 0.0001;
    if (state.phase === 'dash' || nextElapsed >= durationMs) {
      state = { ...state, phase: 'dash', elapsedMs: durationMs };
      stopTimer();
    }
    paint();
  }, TICK_MS);
}

tui.addInputListener((data) => {
  if (state.phase === 'chat') {
    if (asking || seeding) {
      if (data === '\x1b' || matchesKey(data, 'escape')) {
        draft = '';
        paint();
      }
      return { consume: true };
    }
    if (data === '\x1b' || matchesKey(data, 'escape')) {
      draft = '';
      paint();
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) {
      void sendChat(draft);
      return { consume: true };
    }
    if (data === '\x7f' || data === '\b') {
      draft = draft.slice(0, -1);
      paint();
      return { consume: true };
    }
    if ((data === 'q' || data === 'Q') && draft.length === 0) {
      finish();
      return { consume: true };
    }
    if (data.length > 0 && (data.length > 1 || data >= ' ' || data === '\t')) {
      draft += data.replace(/\r/g, '');
      paint();
      return { consume: true };
    }
    return { consume: true };
  }

  if (data === 'q' || data === 'Q') {
    finish();
    return { consume: true };
  }
  if (matchesKey(data, 'enter')) {
    if (state.phase === 'idle') {
      startAnalysis();
      return { consume: true };
    }
    if (state.phase === 'dash') {
      enterChat();
      return { consume: true };
    }
    return { consume: true };
  }
  if (data === 'j' || matchesKey(data, 'down')) {
    tui.scrollBy(1);
    return { consume: true };
  }
  if (data === 'k' || matchesKey(data, 'up')) {
    tui.scrollBy(-1);
    return { consume: true };
  }
  return undefined;
});

tui.start();
paint();
tui.enterFullscreen({ scroll: [scroll], dock, mouse: true });
