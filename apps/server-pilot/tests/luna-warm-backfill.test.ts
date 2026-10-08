import {
  PILOT_TRANSPORT_ID,
  parseBackfillArgs,
  resolveBackfillCacheDir,
  runBackfill,
  runBackfillCli,
  safeErrorCode,
  selectBackfillCandidates,
  type BackfillCandidate,
} from '../scripts/luna-warm-backfill.js';
import {
  analyseCachePath,
  canonicalInternetMessageId,
  hashSyncedQuoteSelection,
  readAnalyseCache,
} from '../src/ai/quote-workflow-analyse-selection.js';
import {
  __resetInboundTriageAnalyseWarmForTests,
  type InboundAnalyseWarmDeps,
} from '../src/ai/quote-workflow-warmer.js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { QUOTE_WORKFLOW_PROMPT_VERSION } from '../src/ai/quote-workflow-llm.js';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import { getDb, type DB } from '../src/db/client.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { basename, join } from 'node:path';
import type { SQL } from 'drizzle-orm';
import { tmpdir } from 'node:os';
import postgres from 'postgres';

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: vi.fn(),
  closeDb: vi.fn(async () => undefined),
}));

const NOW = Date.parse('2026-10-08T06:00:00.000Z');
const BODY = 'Quote 1 room 2026-11-12 to 2026-11-14, 2 adults, B&B.';
const SECRET_DSN = 'postgres://app:s3cret-pass@db.internal.example:5432/app';
const WARM_ENV = { LUNA_ANALYSE_WARMER: 'on', LUNA_ANALYSE_WARMER_MAX_PER_HOUR: '150' };
const LLM_ON = { QUOTE_WORKFLOW_LLM: 'on' };

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

function selection() {
  return { subject: 'Rooms', bodyText: BODY, preceding: [], attachments: [] };
}

function okAdapter() {
  const invoke = vi.fn(async () => ({
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
  }));
  return { adapter: { invoke } as unknown as ModelAdapter, invoke };
}

function loaderFor(delayMs = 0) {
  let inFlight = 0;
  let maxInFlight = 0;
  const load = vi.fn(async (_input: { transportId: string; internetMessageId?: string }) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    inFlight -= 1;
    return selection();
  });
  return { load, maxInFlight: () => maxInFlight };
}

type TriggerRow = { direction: string; messageIdHeader: string | null };

/**
 * Stands in for getDb() during the warmer's trigger lookup. The lookup's where()
 * clause carries the message id as its first bound parameter, so the row is picked
 * by that id, not by call order.
 */
function triggerDb(rows: Map<string, TriggerRow>) {
  const dialect = new PgDialect();
  return {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => ({
          limit: async () => {
            const row = rows.get(String(dialect.sqlToQuery(condition).params[0]));
            return row ? [row] : [];
          },
        }),
      }),
    }),
  };
}

let cacheDir = '';
let consoleWarn: MockInstance<typeof console.warn>;
let consoleInfo: MockInstance<typeof console.info>;

beforeEach(async () => {
  __resetInboundTriageAnalyseWarmForTests();
  cacheDir = await mkdtemp(join(tmpdir(), 'luna-backfill-'));
  vi.mocked(getDb).mockReset();
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(async () => {
  consoleWarn.mockRestore();
  consoleInfo.mockRestore();
  await rm(cacheDir, { recursive: true, force: true });
});

function useTriggerRows(ids: string[]): void {
  const rows = new Map<string, TriggerRow>(
    ids.map((id) => [id, { direction: 'inbound', messageIdHeader: `<${id}@mail.test>` }]),
  );
  vi.mocked(getDb).mockReturnValue(triggerDb(rows) as unknown as DB);
}

function candidate(id: string): BackfillCandidate {
  return { id, messageIdHeader: `<${id}@mail.test>` };
}

function cacheFileFor(id: string): string {
  return analyseCachePath({
    internetMessageId: canonicalInternetMessageId(`<${id}@mail.test>`) ?? '',
    sourceHash: hashSyncedQuoteSelection(selection()),
    promptVersion: QUOTE_WORKFLOW_PROMPT_VERSION,
    cacheDir,
    transportId: PILOT_TRANSPORT_ID,
  });
}

async function writeReadyCache(id: string): Promise<void> {
  await writeFile(cacheFileFor(id), JSON.stringify({ status: 'ready', source: 'luna' }));
}

function depsFor(
  load: ReturnType<typeof loaderFor>['load'],
  adapter: ModelAdapter,
): InboundAnalyseWarmDeps {
  return { cacheDir, loadSyncedSelection: load, adapter, llmEnabled: () => true };
}

function printed(): string {
  return [...consoleWarn.mock.calls, ...consoleInfo.mock.calls]
    .map((call) => JSON.stringify(call))
    .join('\n');
}

describe('selectBackfillCandidates', () => {
  it('bounds the query to pilot inbound mail in the window, newest first, limited', async () => {
    const conn = postgres('postgres://app:unused@127.0.0.1:1/none', { max: 1 });
    try {
      const db = drizzle(conn) as unknown as DB;
      const since = new Date('2026-10-06T10:00:00.000Z');
      const { sql: text, params } = selectBackfillCandidates(db, {
        transportId: PILOT_TRANSPORT_ID,
        since,
        limit: 200,
      }).toSQL();
      expect(text).toContain('"transport_id" = $1');
      expect(text).toContain('"direction" = $2');
      expect(text).toMatch(/"received_at" >= \$3/);
      expect(text).toMatch(/order by .*"received_at" desc, .*"id" desc/i);
      expect(text).toMatch(/limit \$4/i);
      // drizzle binds timestamp columns as ISO strings, the same form ingest writes.
      expect(params).toEqual(['transport-centurion', 'inbound', since.toISOString(), 200]);
    } finally {
      await conn.end({ timeout: 0 });
    }
  });
});

describe('parseBackfillArgs', () => {
  it('defaults to a 48 hour window and a max of 150', () => {
    expect(parseBackfillArgs([])).toEqual({ hours: 48, max: 150, dryRun: false, help: false });
  });

  it('accepts the bounds: hours 1-72, max 1-200', () => {
    expect(parseBackfillArgs(['--hours', '72', '--max', '200', '--dry-run'])).toMatchObject({
      hours: 72,
      max: 200,
      dryRun: true,
    });
    expect(parseBackfillArgs(['--hours', '1', '--max', '1'])).toMatchObject({ hours: 1, max: 1 });
  });

  it.each([
    [['--hours', '0']],
    [['--hours', '73']],
    [['--hours', 'soon']],
    [['--max', '0']],
    [['--max', '201']],
    [['--unknown']],
  ])('rejects %j', (argv) => {
    expect(() => parseBackfillArgs(argv)).toThrow();
  });
});

describe('runBackfill', () => {
  it('skips cached mail with no model call and no cap spend', async () => {
    useTriggerRows(['c1']);
    await writeReadyCache('c1');
    const { load } = loaderFor();
    const { adapter, invoke } = okAdapter();
    const counts = await runBackfill({
      candidates: [candidate('c1')],
      transportId: PILOT_TRANSPORT_ID,
      max: 1,
      deps: depsFor(load, adapter),
      env: WARM_ENV,
    });
    expect(counts).toMatchObject({ selected: 1, cached: 1, stored: 0, attempted: 0 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stores under the live warmer cache key', async () => {
    useTriggerRows(['s1']);
    const { load } = loaderFor();
    const { adapter, invoke } = okAdapter();
    const counts = await runBackfill({
      candidates: [candidate('s1')],
      transportId: PILOT_TRANSPORT_ID,
      max: 5,
      deps: depsFor(load, adapter),
      env: WARM_ENV,
    });
    expect(counts).toMatchObject({ stored: 1, attempted: 1 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(await readdir(cacheDir)).toEqual([basename(cacheFileFor('s1'))]);
    expect(await readAnalyseCache(cacheFileFor('s1'))).toMatchObject({
      status: 'ready',
      source: 'luna',
    });
  });

  it('counts only uncached attempts against max', async () => {
    useTriggerRows(['c1', 'c2', 'u1', 'u2', 'u3']);
    await writeReadyCache('c1');
    await writeReadyCache('c2');
    const { load } = loaderFor();
    const { adapter, invoke } = okAdapter();
    const counts = await runBackfill({
      candidates: ['c1', 'c2', 'u1', 'u2', 'u3'].map(candidate),
      transportId: PILOT_TRANSPORT_ID,
      max: 2,
      deps: depsFor(load, adapter),
      env: WARM_ENV,
    });
    expect(counts).toMatchObject({ selected: 5, cached: 2, stored: 2, attempted: 2 });
    expect(invoke).toHaveBeenCalledTimes(2);
    // u3 is never loaded: the cap was spent by u1 and u2.
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('never has more than two warms in flight', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    useTriggerRows(ids);
    const loader = loaderFor(15);
    const { adapter } = okAdapter();
    const counts = await runBackfill({
      candidates: ids.map(candidate),
      transportId: PILOT_TRANSPORT_ID,
      max: 150,
      deps: depsFor(loader.load, adapter),
      env: WARM_ENV,
    });
    expect(counts.stored).toBe(6);
    expect(loader.maxInFlight()).toBe(2);
  });

  it('counts a loader failure as failed and never prints its connection string', async () => {
    useTriggerRows(['f1']);
    const load = vi.fn(async () => {
      throw new Error(`cannot reach ${SECRET_DSN}`);
    });
    const { adapter, invoke } = okAdapter();
    const counts = await runBackfill({
      candidates: [candidate('f1')],
      transportId: PILOT_TRANSPORT_ID,
      max: 5,
      deps: depsFor(load, adapter),
      env: WARM_ENV,
    });
    expect(counts).toMatchObject({ failed: 1, stored: 0 });
    expect(invoke).not.toHaveBeenCalled();
    expect(printed()).not.toMatch(/s3cret|postgres:\/\/|db\.internal/);
  });
});

describe('runBackfillCli', () => {
  it('dry-run lists counts only, reads the requested window, and makes no model call', async () => {
    const logs: string[] = [];
    const load = vi.fn(async () => [
      { id: 'a', messageIdHeader: '<a@mail.test>' },
      { id: 'b', messageIdHeader: null },
      { id: 'c', messageIdHeader: '   ' },
    ]);
    const { adapter, invoke } = okAdapter();
    const code = await runBackfillCli(['--dry-run', '--hours', '24'], {
      log: (line) => logs.push(line),
      loadCandidates: load,
      deps: depsFor(loaderFor().load, adapter),
      env: {},
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(load).toHaveBeenCalledWith({ since: new Date(NOW - 24 * 60 * 60 * 1000), limit: 200 });
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      event: 'luna_backfill_dry_run',
      selected: 3,
      withMessageId: 1,
      wouldAttemptAtMost: 1,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses a real run when the Luna flag is off', async () => {
    const logs: string[] = [];
    const load = vi.fn(async () => [candidate('x1')]);
    const code = await runBackfillCli([], {
      log: (line) => logs.push(line),
      loadCandidates: load,
      env: { QUOTE_WORKFLOW_LLM: 'off' },
      now: () => NOW,
    });
    expect(code).toBe(2);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ code: 'llm_disabled' });
    expect(load).not.toHaveBeenCalled();
  });

  it('stops at --max and logs counts, codes and ms only', async () => {
    useTriggerRows(['e1', 'e2', 'e3']);
    const logs: string[] = [];
    const loader = loaderFor();
    const { adapter, invoke } = okAdapter();
    const code = await runBackfillCli(['--max', '2'], {
      log: (line) => logs.push(line),
      loadCandidates: async () => ['e1', 'e2', 'e3'].map(candidate),
      deps: depsFor(loader.load, adapter),
      env: LLM_ON,
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
      event: 'luna_backfill_done',
      selected: 3,
      attempted: 2,
      stored: 2,
      cached: 0,
      failed: 0,
      max: 2,
    });
    const all = logs.join('\n') + printed();
    expect(all).not.toContain(BODY);
    expect(all).not.toContain('mail.test');
  });

  it('reduces errors to a code so connection strings never reach the log', async () => {
    const logs: string[] = [];
    const code = await runBackfillCli([], {
      log: (line) => logs.push(line),
      loadCandidates: async () => {
        throw new Error(`connect refused for ${SECRET_DSN}`);
      },
      env: LLM_ON,
      now: () => NOW,
    });
    expect(code).toBe(1);
    const output = logs.join('\n');
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      event: 'luna_backfill_failed',
      code: 'error',
    });
    expect(output).not.toMatch(/s3cret|postgres:\/\/|db\.internal/);
  });

  it('keeps a Postgres error code, which is a short token and not a message', async () => {
    const logs: string[] = [];
    const code = await runBackfillCli([], {
      log: (line) => logs.push(line),
      loadCandidates: async () => {
        throw Object.assign(new Error(SECRET_DSN), { code: '28P01' });
      },
      env: LLM_ON,
      now: () => NOW,
    });
    expect(code).toBe(1);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ code: '28P01' });
    expect(logs.join('\n')).not.toMatch(/s3cret|postgres:\/\//);
  });

  it('exits 2 on bad arguments without touching the database', async () => {
    const logs: string[] = [];
    const load = vi.fn(async () => []);
    const code = await runBackfillCli(['--hours', '96'], {
      log: (line) => logs.push(line),
      loadCandidates: load,
      env: LLM_ON,
    });
    expect(code).toBe(2);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ code: 'bad_args' });
    expect(load).not.toHaveBeenCalled();
  });
});

describe('redaction helpers', () => {
  it('safeErrorCode returns only a short upper-case token', () => {
    expect(safeErrorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      'ECONNREFUSED',
    );
    expect(safeErrorCode(Object.assign(new Error('x'), { code: 'has space' }))).toBe('error');
    expect(safeErrorCode(new Error(SECRET_DSN))).toBe('error');
    expect(safeErrorCode(null)).toBe('error');
  });

  it('resolveBackfillCacheDir honours LUNA_ANALYSE_CACHE_DIR, else the server-pilot default', () => {
    expect(resolveBackfillCacheDir({ LUNA_ANALYSE_CACHE_DIR: '/srv/cache' }, '/app')).toBe(
      '/srv/cache',
    );
    expect(resolveBackfillCacheDir({}, '/app')).toBe(
      join('/app', '.private', 'luna-analyse-cache'),
    );
  });
});
