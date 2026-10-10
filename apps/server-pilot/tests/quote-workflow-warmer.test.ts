import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb } from '../src/db/client.js';
import {
  analyseCachePath,
  defaultAnalyseCacheDirFor,
} from '../src/ai/quote-workflow-analyse-selection.js';
import {
  analyseWarmerMaxPerHour,
  scheduleInboundTriageAnalyseWarm,
  warmInboundTriageAnalyse,
  __resetInboundTriageAnalyseWarmForTests,
  type InboundTriageWarmRun,
  type InboundAnalyseWarmDeps,
} from '../src/ai/quote-workflow-warmer.js';
import { loadPm2Config } from '../src/deploy/load-pm2-config.js';
import { quoteWorkflowLoaders } from '../src/trpc/routes/quote-workflow.js';
import { appRouter } from '../src/trpc/router.js';

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: vi.fn(),
}));

const here = dirname(fileURLToPath(import.meta.url));
const serverPilotRoot = join(here, '..');
const FLAG_ON = { LUNA_ANALYSE_WARMER: 'on' };
const MESSAGE_ID = '<warm-h9@x>';
const PROMPT_VERSION = 'prompt-warm-test';

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

function lunaOutput(overrides: Record<string, unknown> = {}) {
  return {
    workflow: 'quote',
    flags: [] as string[],
    groups: [quoteGroup],
    party: { kind: null, name: null, reference: null },
    rateClaims: [] as unknown[],
    missing: [] as unknown[],
    evidence: [{ field: 'arrival', quote: '2026-11-12' }],
    tasks: [{ kind: 'quote' as const, groupIndexes: [0], note: 'quote stay' }],
    ...overrides,
  };
}

function okAdapter() {
  return {
    invoke: vi.fn(async () => ({
      modelId: 'gpt-6-luna',
      output: lunaOutput(),
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        latencyMs: 1,
        estimatedCostUsd: 0,
        rateTableVersion: 't',
      },
    })),
  };
}

function selection(bodyText = 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.') {
  return { subject: 'Rooms', bodyText, preceding: [], attachments: [] };
}

function run(overrides: Partial<InboundTriageWarmRun> = {}): InboundTriageWarmRun {
  return {
    runKind: 'inbound_triage',
    admissionSnapshotId: 'snap-1',
    executorLane: 'default',
    transportId: 'transport-1',
    triggerMessageId: 'msg-1',
    ...overrides,
  };
}

/** Trigger row lookup: the warmer reads direction and the canonical Message-ID once. */
function triggerDb(row: { direction: 'inbound' | 'outbound'; messageIdHeader: string | null } | null) {
  const limit = vi.fn(async () => (row ? [row] : []));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function deps(overrides: Partial<InboundAnalyseWarmDeps> = {}): InboundAnalyseWarmDeps {
  return {
    loadSyncedSelection: async () => selection(),
    adapter: okAdapter() as never,
    llmEnabled: () => true,
    cacheDir: null,
    promptVersion: PROMPT_VERSION,
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

describe('analyse cache key', () => {
  it('includes the transport, so another mailbox never reads this analysis of the same mail', () => {
    const base = {
      internetMessageId: MESSAGE_ID,
      sourceHash: 'a'.repeat(64),
      promptVersion: PROMPT_VERSION,
      cacheDir: '/tmp/luna-analyse-cache',
    };
    const one = analyseCachePath({ ...base, transportId: 'transport-1' });
    expect(analyseCachePath({ ...base, transportId: 'transport-1' })).toBe(one);
    expect(analyseCachePath({ ...base, transportId: 'transport-2' })).not.toBe(one);
  });
});

describe('inbound triage analyse warmer', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'luna-warm-'));
    __resetInboundTriageAnalyseWarmForTests();
    vi.mocked(getDb).mockReset();
    vi.mocked(getDb).mockReturnValue(
      triggerDb({ direction: 'inbound', messageIdHeader: MESSAGE_ID }) as never,
    );
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    quoteWorkflowLoaders.loadSyncedSelection = null;
    quoteWorkflowLoaders.adapter = null;
    quoteWorkflowLoaders.llmEnabled = null;
    quoteWorkflowLoaders.analyseCacheDir = null;
    quoteWorkflowLoaders.promptVersion = null;
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('is off unless LUNA_ANALYSE_WARMER is on, and then never reads the trigger, mailbox or model', async () => {
    const loader = vi.fn(async () => selection());
    const adapter = okAdapter();
    const off = deps({ loadSyncedSelection: loader, adapter: adapter as never, cacheDir });
    expect(await warmInboundTriageAnalyse(run(), off, {})).toBe('skipped');
    expect(await warmInboundTriageAnalyse(run(), off, { LUNA_ANALYSE_WARMER: 'off' })).toBe(
      'skipped',
    );
    expect(getDb).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
    expect(adapter.invoke).not.toHaveBeenCalled();
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it('skips outbound triage, runs without an admission snapshot, and non-default lanes', async () => {
    const loader = vi.fn(async () => selection());
    const adapter = okAdapter();
    const withDeps = deps({ loadSyncedSelection: loader, adapter: adapter as never, cacheDir });
    expect(await warmInboundTriageAnalyse(run({ admissionSnapshotId: null }), withDeps, FLAG_ON)).toBe(
      'skipped',
    );
    expect(await warmInboundTriageAnalyse(run({ executorLane: 'hms' }), withDeps, FLAG_ON)).toBe(
      'skipped',
    );
    expect(await warmInboundTriageAnalyse(run({ runKind: 'candidate_draft' }), withDeps, FLAG_ON)).toBe(
      'skipped',
    );
    expect(getDb).not.toHaveBeenCalled();

    vi.mocked(getDb).mockReturnValue(
      triggerDb({ direction: 'outbound', messageIdHeader: MESSAGE_ID }) as never,
    );
    expect(await warmInboundTriageAnalyse(run(), withDeps, FLAG_ON)).toBe('skipped');
    expect(loader).not.toHaveBeenCalled();
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it('warms the file the pane route reads, so the first click is a hit with zero model calls', async () => {
    const adapter = okAdapter();
    const warmed = await warmInboundTriageAnalyse(
      run(),
      deps({ adapter: adapter as never, cacheDir, promptVersion: PROMPT_VERSION }),
      FLAG_ON,
    );
    expect(warmed).toBe('stored');
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    expect(await readdir(cacheDir)).toHaveLength(1);

    quoteWorkflowLoaders.loadSyncedSelection = async () => selection();
    quoteWorkflowLoaders.adapter = adapter as never;
    quoteWorkflowLoaders.llmEnabled = () => true;
    quoteWorkflowLoaders.analyseCacheDir = cacheDir;
    quoteWorkflowLoaders.promptVersion = PROMPT_VERSION;
    const click = await mailboxCaller().quoteWorkflow.analyseSelection({
      internetMessageId: MESSAGE_ID,
      storeId: 'store-1',
      entryId: 'entry-1',
      folderEntryId: 'folder-1',
      selectionEpoch: 7,
    });
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    expect(click).toMatchObject({ status: 'ready', source: 'luna', sourceRevision: 7 });
    expect(await readdir(cacheDir)).toHaveLength(1);
  });

  it('accepts an inbound_extraction run, the live trigger after U5, as it accepted inbound_triage', async () => {
    const adapter = okAdapter();
    vi.mocked(getDb).mockReturnValue(
      triggerDb({ direction: 'inbound', messageIdHeader: MESSAGE_ID }) as never,
    );
    expect(
      await warmInboundTriageAnalyse(
        run({ runKind: 'inbound_extraction' }),
        deps({ adapter: adapter as never, cacheDir, promptVersion: PROMPT_VERSION }),
        FLAG_ON,
      ),
    ).toBe('stored');
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
  });

  it('an existing cache file skips the model call and logs luna_warm_skip_cached', async () => {
    const adapter = okAdapter();
    const withDeps = deps({ adapter: adapter as never, cacheDir });
    expect(await warmInboundTriageAnalyse(run(), withDeps, FLAG_ON)).toBe('stored');
    expect(await warmInboundTriageAnalyse(run(), withDeps, FLAG_ON)).toBe('cached');
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith(
      'luna_warm_skip_cached',
      expect.objectContaining({ code: 'cache_hit', ms: expect.any(Number) }),
    );
  });

  it('keeps at most two warms in flight across five jobs', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const loader = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return selection();
    });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        warmInboundTriageAnalyse(
          run(),
          deps({ loadSyncedSelection: loader, adapter: okAdapter() as never, cacheDir }),
          FLAG_ON,
        ),
      ),
    );
    expect(loader).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(2);
    expect(results).toHaveLength(5);
    expect(results.every((result) => result === 'stored' || result === 'cached')).toBe(true);
  });

  it('a failing model call leaves no cache file, logs luna_warm_failed and never throws', async () => {
    const adapter = {
      invoke: vi.fn(async () => {
        throw new Error('upstream failed on BODY-LEAK-MARKER');
      }),
    };
    const result = await warmInboundTriageAnalyse(
      run(),
      deps({ adapter: adapter as never, cacheDir }),
      FLAG_ON,
    );
    expect(result).toBe('failed');
    expect(await readdir(cacheDir)).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      'luna_warm_failed',
      expect.objectContaining({ code: 'error', ms: expect.any(Number) }),
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('BODY-LEAK-MARKER');
  });

  it('logs only a code and ms on success, never the mail body', async () => {
    const result = await warmInboundTriageAnalyse(
      run(),
      deps({
        loadSyncedSelection: async () => selection('Please quote BODY-LEAK-MARKER 2 adults.'),
        adapter: okAdapter() as never,
        cacheDir,
      }),
      FLAG_ON,
    );
    expect(result).toBe('stored');
    expect(console.info).toHaveBeenCalledWith('luna_warm_ok', {
      code: 'stored',
      ms: expect.any(Number),
    });
    expect(console.warn).not.toHaveBeenCalled();
    const logged = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls];
    expect(JSON.stringify(logged)).not.toContain('BODY-LEAK-MARKER');
  });

  it('stops model calls once the per-hour cap is reached and logs code cap', async () => {
    let calls = 0;
    const adapter = okAdapter();
    const warmDeps = deps({
      loadSyncedSelection: async () => {
        calls += 1;
        return selection(`Quote 1 room 2026-11-1${calls} to 2026-11-14, 2 adults.`);
      },
      adapter: adapter as never,
      cacheDir,
    });
    const env = { ...FLAG_ON, LUNA_ANALYSE_WARMER_MAX_PER_HOUR: '1' };
    expect(await warmInboundTriageAnalyse(run(), warmDeps, env)).toBe('stored');
    expect(await warmInboundTriageAnalyse(run(), warmDeps, env)).toBe('failed');
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      'luna_warm_failed',
      expect.objectContaining({ code: 'cap' }),
    );
  });

  it('a spent hourly cap stops before the mail is loaded, so no S3 or PDF work runs', async () => {
    vi.mocked(getDb).mockReturnValue(triggerDb({ direction: 'inbound', messageIdHeader: MESSAGE_ID }));
    const load = vi.fn(async () => selection());
    const adapter = okAdapter();
    const env = { ...FLAG_ON, LUNA_ANALYSE_WARMER_MAX_PER_HOUR: '0' };
    expect(
      await warmInboundTriageAnalyse(run(), deps({ loadSyncedSelection: load, adapter: adapter as never, cacheDir }), env),
    ).toBe('failed');
    expect(load).not.toHaveBeenCalled();
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it('drops a warm once 50 are already waiting, logs luna_warm_skip_queue_full and never queues it', async () => {
    vi.mocked(getDb).mockReturnValue(triggerDb({ direction: 'inbound', messageIdHeader: MESSAGE_ID }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const stuck = deps({ loadSyncedSelection: () => new Promise<never>(() => undefined), cacheDir });
    // Two jobs hold the slots and 50 wait behind them. Each call takes its place in the queue synchronously.
    for (let i = 0; i < 52; i += 1) void warmInboundTriageAnalyse(run(), stuck, FLAG_ON);
    const outcome = await Promise.race([
      warmInboundTriageAnalyse(run(), stuck, FLAG_ON),
      new Promise<string>((resolve) => setTimeout(() => resolve('queued'), 20)),
    ]);
    expect(outcome).toBe('skipped');
    expect(info).toHaveBeenCalledWith('luna_warm_skip_queue_full', { code: 'queue_full' });
    info.mockRestore();
    __resetInboundTriageAnalyseWarmForTests();
  });

  it('a disabled Luna logs code disabled and does not spend a cap slot', async () => {
    const adapter = okAdapter();
    const env = { ...FLAG_ON, LUNA_ANALYSE_WARMER_MAX_PER_HOUR: '1' };
    const off = deps({ adapter: adapter as never, cacheDir, llmEnabled: () => false });
    expect(await warmInboundTriageAnalyse(run(), off, env)).toBe('failed');
    expect(console.warn).toHaveBeenCalledWith(
      'luna_warm_failed',
      expect.objectContaining({ code: 'disabled' }),
    );
    expect(adapter.invoke).not.toHaveBeenCalled();

    const on = deps({
      loadSyncedSelection: async () => selection('Quote 2 rooms 2026-12-01 to 2026-12-03.'),
      adapter: adapter as never,
      cacheDir,
    });
    expect(await warmInboundTriageAnalyse(run(), on, env)).toBe('stored');
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
  });

  it('defaults the per-hour cap to 60 and parses an explicit value', () => {
    expect(analyseWarmerMaxPerHour({})).toBe(60);
    expect(analyseWarmerMaxPerHour({ LUNA_ANALYSE_WARMER_MAX_PER_HOUR: '5' })).toBe(5);
    expect(analyseWarmerMaxPerHour({ LUNA_ANALYSE_WARMER_MAX_PER_HOUR: 'many' })).toBe(60);
  });

  it('an unsynced mailbox is a logged failure with no model call', async () => {
    const adapter = okAdapter();
    const result = await warmInboundTriageAnalyse(
      run(),
      deps({ loadSyncedSelection: async () => null, adapter: adapter as never, cacheDir }),
      FLAG_ON,
    );
    expect(result).toBe('failed');
    expect(adapter.invoke).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      'luna_warm_failed',
      expect.objectContaining({ code: 'unsynced' }),
    );
  });

  it('a database failure is contained and never throws into triage', async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(warmInboundTriageAnalyse(run(), deps({ cacheDir }), FLAG_ON)).resolves.toBe(
      'failed',
    );
    expect(console.warn).toHaveBeenCalledWith(
      'luna_warm_failed',
      expect.objectContaining({ code: 'error' }),
    );
  });

  it('the schedule entry point is a no-op with the flag off and runs in the background when on', async () => {
    scheduleInboundTriageAnalyseWarm(run(), {});
    scheduleInboundTriageAnalyseWarm(run({ admissionSnapshotId: null }), FLAG_ON);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getDb).not.toHaveBeenCalled();

    // Under vitest with no cache dir override the background job stops before loading mail.
    scheduleInboundTriageAnalyseWarm(run(), FLAG_ON);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getDb).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      'luna_warm_failed',
      expect.objectContaining({ code: 'no_cache_dir' }),
    );
  });

  it('the cache dir is identical from src and dist layouts and matches the pm2 pin on http and ai-worker', () => {
    const expected = join(serverPilotRoot, '.private', 'luna-analyse-cache');
    const fromSrc = defaultAnalyseCacheDirFor(
      pathToFileURL(join(serverPilotRoot, 'src', 'ai', 'quote-workflow-analyse-selection.ts')).href,
    );
    const fromDist = defaultAnalyseCacheDirFor(
      pathToFileURL(join(serverPilotRoot, 'dist', 'ai', 'quote-workflow-analyse-selection.js')).href,
    );
    expect(fromSrc).toBe(expected);
    expect(fromDist).toBe(expected);

    const pm2 = loadPm2Config();
    for (const name of ['http', 'ai-worker']) {
      const app = pm2.apps.find((candidate) => candidate.name === name) as
        | { env?: Record<string, string> }
        | undefined;
      expect(app?.env?.LUNA_ANALYSE_CACHE_DIR, name).toBe(expected);
      expect(app?.env?.LUNA_ANALYSE_WARMER, name).toBe('on');
    }
  });
});
