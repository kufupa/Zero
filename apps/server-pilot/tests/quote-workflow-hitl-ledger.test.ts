import {
  __resetInboundTriageAnalyseWarmForTests,
  warmInboundTriageAnalyse,
  type InboundTriageWarmRun,
} from '../src/ai/quote-workflow-warmer.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';
import {
  CACHE_ORIGIN_SKEW_MS,
  type AgentRunRecord,
  type AgentRunRecorder,
  type OriginLookup,
} from '../src/ai/hitl-recorder.js';
import { quoteWorkflowLoaders } from '../src/trpc/routes/quote-workflow.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyseQuoteSelection } from '../src/ai/quote-workflow-llm.js';
import { appRouter } from '../src/trpc/router.js';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { getDb } from '../src/db/client.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: vi.fn(),
}));

const PROMPT_VERSION = 'prompt-hitl-test';
const PROVENANCE = {
  routeId: 'azure_quote',
  protocol: 'azure-openai-responses/effort-medium',
  modelId: 'gpt-6-luna',
  usageSource: 'reported' as const,
};

const quoteGroup = {
  arrival: '2026-11-12',
  departure: '2026-11-14',
  rooms: 1,
  adultsPerRoom: 2,
  childAges: [] as number[],
  board: 'bb' as const,
  roomPreference: null,
  guestNames: [] as string[],
};

function lunaOutput() {
  return {
    workflow: 'quote',
    flags: [] as string[],
    groups: [quoteGroup],
    party: { kind: null, name: null, reference: null },
    rateClaims: [] as unknown[],
    missing: [] as unknown[],
    evidence: [{ field: 'arrival', quote: '2026-11-12' }],
    tasks: [{ kind: 'quote' as const, groupIndexes: [0], note: 'quote stay' }],
  };
}

function lunaResult() {
  return {
    modelId: 'gpt-6-luna',
    output: lunaOutput(),
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      latencyMs: 5,
      estimatedCostUsd: 0.000123,
      rateTableVersion: 't',
    },
    provenance: PROVENANCE,
  };
}

function adapterReturning() {
  const invoke = vi.fn(async () => lunaResult());
  return { adapter: { invoke } as never, invoke };
}

type StoredRun = AgentRunRecord & { id: string; createdAt: Date };
type MemorySink = AgentRunRecorder & { runs: StoredRun[] };

/**
 * In-memory sink through the recorder seam. The origin lookup mirrors the DB recorder: the producing run wins
 * while it is still a model run for the input; otherwise the latest model run for the input written by the
 * cache time plus the skew. beforeOriginLookup runs first, to model another caller finishing in between.
 */
function memorySink(
  options: {
    delayMs?: number;
    fail?: boolean;
    beforeOriginLookup?: (sink: MemorySink) => Promise<void>;
  } = {},
): MemorySink {
  const runs: StoredRun[] = [];
  const isModelRunFor = (run: StoredRun, inputKey: string) =>
    run.inputKey === inputKey &&
    run.source === 'luna' &&
    (run.cacheStatus === 'miss' || run.cacheStatus === 'backfill');
  const findOriginRunId = vi.fn(async (lookup: OriginLookup) => {
    if (options.beforeOriginLookup) await options.beforeOriginLookup(sink);
    if (lookup.producingRunId) {
      const producing = runs.find(
        (run) => run.id === lookup.producingRunId && isModelRunFor(run, lookup.inputKey),
      );
      if (producing) return producing.id;
    }
    const latestBy = lookup.cacheWrittenAt
      ? lookup.cacheWrittenAt.getTime() + CACHE_ORIGIN_SKEW_MS
      : Number.POSITIVE_INFINITY;
    const origin = [...runs]
      .reverse()
      .find((run) => isModelRunFor(run, lookup.inputKey) && run.createdAt.getTime() <= latestBy);
    return origin?.id ?? null;
  });
  const record = vi.fn(async (run: AgentRunRecord) => {
    if (options.fail) throw new Error('connection refused by ledger host');
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    const id = `run-${runs.length + 1}`;
    runs.push({ ...run, id, createdAt: new Date() });
    return id;
  });
  const sink: MemorySink = { runs, findOriginRunId, record };
  return sink;
}

function synced(overrides: Partial<SyncedQuoteSelection> = {}): SyncedQuoteSelection {
  return {
    subject: 'Rooms',
    bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.',
    preceding: [],
    attachments: [],
    messageId: 'msg-1',
    threadId: 'thread-1',
    ...overrides,
  };
}

function mailboxCaller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: {
      id: 'user-ropperman',
      email: 'ropperman@legacyhotels.co.za',
      name: 'R Opperman',
    },
    activeTransportId: 'transport-1',
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole: 'owner',
  } as never);
}

function analyse(overrides: { treatAs?: 'quote' | 'create_booking'; staffNote?: string } = {}) {
  return mailboxCaller().quoteWorkflow.analyseSelection({
    internetMessageId: '<hitl-1@x>',
    storeId: 'store-1',
    entryId: 'entry-1',
    folderEntryId: 'folder-1',
    selectionEpoch: 4,
    ...overrides,
  });
}

let cacheDir = '';
let savedLedgerFlag: string | undefined;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'hitl-analyse-'));
  savedLedgerFlag = process.env.HITL_LEDGER;
  delete process.env.HITL_LEDGER;
  quoteWorkflowLoaders.analyseCacheDir = cacheDir;
  quoteWorkflowLoaders.promptVersion = PROMPT_VERSION;
  quoteWorkflowLoaders.loadSyncedSelection = async () => synced();
  quoteWorkflowLoaders.llmEnabled = () => true;
  quoteWorkflowLoaders.adapter = adapterReturning().adapter;
  quoteWorkflowLoaders.agentRunRecorder = null;
});

afterEach(async () => {
  quoteWorkflowLoaders.loadSyncedSelection = null;
  quoteWorkflowLoaders.adapter = null;
  quoteWorkflowLoaders.llmEnabled = null;
  quoteWorkflowLoaders.analyseCacheDir = null;
  quoteWorkflowLoaders.promptVersion = null;
  quoteWorkflowLoaders.agentRunRecorder = null;
  if (savedLedgerFlag === undefined) delete process.env.HITL_LEDGER;
  else process.env.HITL_LEDGER = savedLedgerFlag;
  vi.restoreAllMocks();
  await rm(cacheDir, { recursive: true, force: true });
});

describe('quoteWorkflow.analyseSelection HITL ledger', () => {
  it('writes nothing and adds no analysisRunId while HITL_LEDGER is off', async () => {
    const sink = memorySink();
    quoteWorkflowLoaders.agentRunRecorder = sink;
    const result = await analyse();
    expect(result).toMatchObject({ status: 'ready' });
    expect('analysisRunId' in result).toBe(false);
    expect(sink.record).not.toHaveBeenCalled();
    expect(sink.findOriginRunId).not.toHaveBeenCalled();
  });

  it('records a pane Luna run for the session user and returns its id', async () => {
    process.env.HITL_LEDGER = 'on';
    const sink = memorySink();
    quoteWorkflowLoaders.agentRunRecorder = sink;
    const result = await analyse();
    expect(result).toMatchObject({ status: 'ready', source: 'luna', analysisRunId: 'run-1' });
    expect(sink.runs).toHaveLength(1);
    expect(sink.runs[0]).toMatchObject({
      trigger: 'pane',
      userId: 'user-ropperman',
      transportId: 'transport-1',
      threadId: 'thread-1',
      messageId: 'msg-1',
      cacheStatus: 'miss',
      source: 'luna',
      fallbackReason: null,
      workflow: 'quote',
      treatAs: null,
      staffNotePresent: false,
      cachedFromRunId: null,
      provider: PROVENANCE.protocol,
      modelId: 'gpt-6-luna',
      modelRoute: 'azure_quote',
      promptVersion: PROMPT_VERSION,
      usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.000123, usageSource: 'reported' },
    });
    expect(sink.runs[0].inputKey).toMatch(/^[0-9a-f]{64}$/);
    expect(sink.runs[0].inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sink.runs[0].output).toMatchObject({ workflow: 'quote' });
    expect(sink.runs[0].suggestedFields).toMatchObject({ intent: 'quote' });
    expect(sink.runs[0].latencyMs).toEqual(expect.any(Number));
  });

  it('records a regex fallback run with its reason and no model output', async () => {
    process.env.HITL_LEDGER = 'on';
    const sink = memorySink();
    quoteWorkflowLoaders.agentRunRecorder = sink;
    quoteWorkflowLoaders.llmEnabled = () => false;
    const result = await analyse();
    expect(result).toMatchObject({
      status: 'ready',
      source: 'regex_fallback',
      analysisRunId: 'run-1',
    });
    expect(sink.runs[0]).toMatchObject({
      source: 'regex_fallback',
      fallbackReason: 'disabled',
      cacheStatus: 'miss',
      output: null,
      modelId: null,
      userId: 'user-ropperman',
    });
  });

  it('keeps the analyse intact when the ledger write fails, and drops only the id', async () => {
    process.env.HITL_LEDGER = 'on';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = memorySink({ fail: true });
    quoteWorkflowLoaders.agentRunRecorder = sink;
    const result = await analyse();
    expect(result).toMatchObject({ status: 'ready', source: 'luna' });
    expect('analysisRunId' in result).toBe(false);
    expect(sink.record).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('hitl_record_skipped', { code: 'error' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ledger host');
  });

  it('returns on time when the ledger is slower than the cap', async () => {
    process.env.HITL_LEDGER = 'on';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    quoteWorkflowLoaders.agentRunRecorder = memorySink({ delayMs: 1500 });
    const started = Date.now();
    const result = await analyse();
    expect(Date.now() - started).toBeLessThan(1200);
    expect(result).toMatchObject({ status: 'ready', source: 'luna' });
    expect('analysisRunId' in result).toBe(false);
  });

  it('links a cache hit to the run that produced the cached analysis', async () => {
    process.env.HITL_LEDGER = 'on';
    const sink = memorySink();
    quoteWorkflowLoaders.agentRunRecorder = sink;
    const { adapter, invoke } = adapterReturning();
    quoteWorkflowLoaders.adapter = adapter;
    const first = await analyse();
    expect(first).toMatchObject({ analysisRunId: 'run-1' });
    const second = await analyse();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ status: 'ready', analysisRunId: 'run-2' });
    expect(sink.runs[1]).toMatchObject({
      cacheStatus: 'hit',
      source: 'luna',
      cachedFromRunId: 'run-1',
      output: null,
      modelId: null,
    });
    expect(sink.runs[1].inputKey).toBe(sink.runs[0].inputKey);
  });

  it('keeps a cache hit on the run that wrote its entry when a newer run for the input lands first', async () => {
    process.env.HITL_LEDGER = 'on';
    let raced = false;
    const sink = memorySink({
      // Another pane finishes the same input between this hit's cache read and its origin lookup.
      beforeOriginLookup: async (current) => {
        if (raced) return;
        raced = true;
        await current.record({ ...current.runs[0]! });
      },
    });
    quoteWorkflowLoaders.agentRunRecorder = sink;
    const first = await analyse();
    expect(first).toMatchObject({ analysisRunId: 'run-1' });
    const second = await analyse();
    expect(raced).toBe(true);
    expect(sink.runs.map((run) => run.cacheStatus)).toEqual(['miss', 'miss', 'hit']);
    expect(sink.runs[2]).toMatchObject({ cacheStatus: 'hit', cachedFromRunId: 'run-1' });
    expect(second).toMatchObject({ analysisRunId: 'run-3' });
  });

  it('links an entry that names no run to the latest model run written by its cache time', async () => {
    process.env.HITL_LEDGER = 'on';
    const sink = memorySink();
    quoteWorkflowLoaders.agentRunRecorder = sink;
    await analyse();
    const [name] = await readdir(cacheDir);
    const path = join(cacheDir, name!);
    const entry = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete entry.analysisRunId;
    await writeFile(path, JSON.stringify(entry));
    // A model run recorded well after the entry was written must not become its origin.
    await sink.record({ ...sink.runs[0]! });
    sink.runs[1]!.createdAt = new Date(Date.now() + CACHE_ORIGIN_SKEW_MS + 60 * 60_000);
    await analyse();
    expect(sink.runs[2]).toMatchObject({ cacheStatus: 'hit', cachedFromRunId: 'run-1' });
  });

  it('puts the booking-search amendment into the first displayed snapshot as flat paths', async () => {
    process.env.HITL_LEDGER = 'on';
    const sink = memorySink();
    quoteWorkflowLoaders.agentRunRecorder = sink;
    quoteWorkflowLoaders.loadSyncedSelection = async () =>
      synced({
        bodyText: 'Please cancel booking C123 for Rambuda, arriving 2026-11-12, leaving 2026-11-14.',
      });
    const amend = {
      ...lunaResult(),
      output: {
        ...lunaOutput(),
        workflow: 'amend',
        confirmationNumber: 'C123',
        guestLastName: 'Rambuda',
        arrival: '2026-11-12',
        departure: '2026-11-14',
      },
    };
    quoteWorkflowLoaders.adapter = { invoke: vi.fn(async () => amend) } as never;
    await analyse();
    expect(sink.runs[0]!.suggestedFields).toMatchObject({
      'amendment.confirmationNumber': 'C123',
      'amendment.guestLastName': 'Rambuda',
      'amendment.arrival': '2026-11-12',
      'amendment.departure': '2026-11-14',
    });
    expect(sink.runs[0]!.suggestedFields).not.toHaveProperty('amendment');
  });

  it('records nothing when the loader gives no message or thread ids', async () => {
    process.env.HITL_LEDGER = 'on';
    const sink = memorySink();
    quoteWorkflowLoaders.agentRunRecorder = sink;
    quoteWorkflowLoaders.loadSyncedSelection = async () =>
      synced({ messageId: undefined, threadId: undefined });
    const result = await analyse();
    expect(result).toMatchObject({ status: 'ready' });
    expect('analysisRunId' in result).toBe(false);
    expect(sink.record).not.toHaveBeenCalled();
  });

  it('marks a staff-note, treat-as run and keys it apart from the plain analyse', async () => {
    process.env.HITL_LEDGER = 'on';
    const sink = memorySink();
    quoteWorkflowLoaders.agentRunRecorder = sink;
    await analyse({ treatAs: 'create_booking', staffNote: 'Arrival is 13 Nov' });
    await analyse();
    expect(sink.runs).toHaveLength(2);
    expect(sink.runs[0]).toMatchObject({
      treatAs: 'create_booking',
      staffNotePresent: true,
      workflow: 'create_booking',
    });
    expect(sink.runs[1]).toMatchObject({ treatAs: null, staffNotePresent: false });
    expect(sink.runs[1].inputKey).not.toBe(sink.runs[0].inputKey);
    expect(sink.runs[1].inputHash).not.toBe(sink.runs[0].inputHash);
  });
});

describe('inbound triage warmer HITL ledger', () => {
  function run(): InboundTriageWarmRun {
    return {
      runKind: 'inbound_triage',
      admissionSnapshotId: 'snap-1',
      executorLane: 'default',
      transportId: 'transport-1',
      triggerMessageId: 'msg-1',
    };
  }

  /** Trigger row lookup: the warmer reads direction and the canonical Message-ID once. */
  function triggerDb(row: { direction: 'inbound'; messageIdHeader: string }) {
    const limit = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    return { select: vi.fn(() => ({ from })) };
  }

  beforeEach(() => {
    __resetInboundTriageAnalyseWarmForTests();
    vi.mocked(getDb).mockReset();
    vi.mocked(getDb).mockReturnValue(
      triggerDb({ direction: 'inbound', messageIdHeader: '<warm-hitl@x>' }) as never,
    );
  });

  it('records a warmer run with no session user and no episode', async () => {
    const sink = memorySink();
    const result = await warmInboundTriageAnalyse(
      run(),
      {
        loadSyncedSelection: async () => synced(),
        adapter: adapterReturning().adapter,
        llmEnabled: () => true,
        cacheDir,
        promptVersion: PROMPT_VERSION,
        recorder: sink,
      },
      { LUNA_ANALYSE_WARMER: 'on', HITL_LEDGER: 'on' },
    );
    expect(result).toBe('stored');
    expect(sink.runs).toHaveLength(1);
    expect(sink.runs[0]).toMatchObject({
      trigger: 'warmer',
      userId: null,
      cacheStatus: 'miss',
      source: 'luna',
    });
  });

  it('records nothing while HITL_LEDGER is off, even with an injected sink', async () => {
    const sink = memorySink();
    const result = await warmInboundTriageAnalyse(
      run(),
      {
        loadSyncedSelection: async () => synced(),
        adapter: adapterReturning().adapter,
        llmEnabled: () => true,
        cacheDir,
        promptVersion: PROMPT_VERSION,
        recorder: sink,
      },
      { LUNA_ANALYSE_WARMER: 'on' },
    );
    expect(result).toBe('stored');
    expect(sink.record).not.toHaveBeenCalled();
  });
});

describe('analyseQuoteSelection telemetry', () => {
  const selection = {
    subject: 'Rooms',
    bodyText: 'Quote 1 room 2026-11-12 to 2026-11-14.',
    preceding: [],
    attachments: [],
  };

  it('reports model, route, protocol, tokens and cost on the Luna branch', async () => {
    const result = await analyseQuoteSelection({
      selection,
      adapter: adapterReturning().adapter,
      enabled: true,
    });
    expect(result.source).toBe('luna');
    expect(result.telemetry).toEqual({
      latencyMs: expect.any(Number),
      modelId: 'gpt-6-luna',
      provider: PROVENANCE.protocol,
      modelRoute: 'azure_quote',
      usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.000123, usageSource: 'reported' },
    });
  });

  it('keeps usage on an invalid-output fallback, because the model did answer', async () => {
    const invoke = vi.fn(async () => ({ ...lunaResult(), output: { workflow: 'unknown' } }));
    const result = await analyseQuoteSelection({
      selection,
      adapter: { invoke } as never,
      enabled: true,
    });
    expect(result).toMatchObject({ source: 'regex_fallback', fallbackReason: 'invalid_output' });
    expect(result.telemetry?.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
    expect(result.telemetry?.modelId).toBe('gpt-6-luna');
  });

  it('reports no model when the analyse is disabled, since no call was made', async () => {
    const invoke = vi.fn(async () => lunaResult());
    const result = await analyseQuoteSelection({
      selection,
      adapter: { invoke } as never,
      enabled: false,
    });
    expect(result).toMatchObject({ source: 'regex_fallback', fallbackReason: 'disabled' });
    expect(result.telemetry).toEqual({ latencyMs: expect.any(Number) });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports the requested model and no usage when the call fails', async () => {
    const result = await analyseQuoteSelection({
      selection,
      adapter: {
        invoke: vi.fn(async () => {
          throw new Error('upstream 503');
        }),
      } as never,
      enabled: true,
    });
    expect(result).toMatchObject({ source: 'regex_fallback', fallbackReason: 'error' });
    expect(result.telemetry).toEqual({ latencyMs: expect.any(Number), modelId: 'gpt-6-luna' });
  });

  it('leaves out optional fields that a legacy adapter does not report', async () => {
    const result = await analyseQuoteSelection({
      selection,
      adapter: {
        invoke: vi.fn(async () => ({ modelId: 'gpt-6-luna', output: lunaOutput() })),
      } as never,
      enabled: true,
    });
    expect(result.source).toBe('luna');
    expect(result.telemetry).toEqual({ latencyMs: expect.any(Number), modelId: 'gpt-6-luna' });
  });
});
