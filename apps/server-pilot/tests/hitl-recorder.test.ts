import {
  AGENT_RUN_RECORD_CAP_MS,
  analyseInputKey,
  createAgentRunRecorder,
  mergeEpisodeOnRun,
  recordAgentRunCapped,
  resolveAgentRunRecorder,
  type AgentRunDraft,
  type AgentRunRecorder,
  type EpisodeState,
  type OriginLookup,
} from '../src/ai/hitl-recorder.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db/client.js';

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: vi.fn(),
}));

/** A DB handle that fails the test if anything touches it. */
function untouchableDb() {
  const touched = vi.fn();
  const db = new Proxy(
    {},
    {
      get(_target, property) {
        touched(property);
        throw new Error(`database touched: ${String(property)}`);
      },
    },
  );
  return { db: db as never, touched };
}

function draft(overrides: Partial<AgentRunDraft> = {}): AgentRunDraft {
  return {
    trigger: 'pane',
    cacheStatus: 'miss',
    transportId: 'transport-1',
    threadId: 'thread-1',
    messageId: 'msg-1',
    userId: 'user-1',
    inputHash: 'a'.repeat(64),
    inputKey: 'b'.repeat(64),
    promptVersion: 'prompt-1',
    treatAs: null,
    staffNotePresent: false,
    source: 'luna',
    fallbackReason: null,
    workflow: 'quote',
    provider: null,
    modelId: 'gpt-6-luna',
    modelRoute: null,
    latencyMs: 12,
    usage: null,
    output: null,
    suggestedFields: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.mocked(getDb).mockReset();
  vi.restoreAllMocks();
});

describe('createAgentRunRecorder', () => {
  it('returns null when disabled and never touches the database handle', () => {
    const { db, touched } = untouchableDb();
    expect(createAgentRunRecorder(db, { enabled: false })).toBeNull();
    expect(touched).not.toHaveBeenCalled();
  });

  it('builds a recorder without querying the database', () => {
    const { db, touched } = untouchableDb();
    expect(createAgentRunRecorder(db, { enabled: true })).not.toBeNull();
    expect(touched).not.toHaveBeenCalled();
  });
});

describe('resolveAgentRunRecorder', () => {
  it.each([
    ['unset', {}],
    ['off', { HITL_LEDGER: 'off' }],
    ['true', { HITL_LEDGER: 'true' }],
    ['1', { HITL_LEDGER: '1' }],
    ['upper-case ON', { HITL_LEDGER: 'ON' }],
  ])(
    'stays closed when HITL_LEDGER is %s, with no database access and no sink use',
    (_label, env) => {
      const sink: AgentRunRecorder = {
        findOriginRunId: vi.fn(async () => null),
        record: vi.fn(async () => 'run-1'),
      };
      expect(resolveAgentRunRecorder(env, sink)).toBeNull();
      expect(getDb).not.toHaveBeenCalled();
      expect(sink.record).not.toHaveBeenCalled();
    },
  );

  it('returns the injected sink when HITL_LEDGER=on', () => {
    const sink: AgentRunRecorder = {
      findOriginRunId: vi.fn(async () => null),
      record: vi.fn(async () => 'run-1'),
    };
    expect(resolveAgentRunRecorder({ HITL_LEDGER: 'on' }, sink)).toBe(sink);
    expect(getDb).not.toHaveBeenCalled();
  });

  it('uses the database recorder when on and no sink is given', () => {
    vi.mocked(getDb).mockReturnValue({} as never);
    expect(resolveAgentRunRecorder({ HITL_LEDGER: 'on' })).not.toBeNull();
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it('closes quietly when the database cannot be reached', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('DATABASE_URL missing');
    });
    expect(resolveAgentRunRecorder({ HITL_LEDGER: 'on' })).toBeNull();
  });
});

describe('mergeEpisodeOnRun', () => {
  const t1 = new Date('2026-10-09T08:00:00Z');
  const t2 = new Date('2026-10-09T09:00:00Z');
  const r1 = new Date('2026-12-01T00:00:00Z');
  const r2 = new Date('2027-01-01T00:00:00Z');

  it('starts an episode from its first run', () => {
    expect(
      mergeEpisodeOnRun(null, {
        runId: 'run-1',
        seenAt: t1,
        displayedFields: { groups: [1] },
        retentionExpiresAt: r1,
      }),
    ).toEqual({
      firstRunId: 'run-1',
      latestRunId: 'run-1',
      firstSeenAt: t1,
      displayedFields: { groups: [1] },
      retentionExpiresAt: r1,
    });
  });

  it('keeps the first run and first display, and moves the latest run', () => {
    const first = mergeEpisodeOnRun(null, {
      runId: 'run-1',
      seenAt: t1,
      displayedFields: { groups: ['a'] },
      retentionExpiresAt: r1,
    });
    const second = mergeEpisodeOnRun(first, {
      runId: 'run-2',
      seenAt: t2,
      displayedFields: { groups: ['b'] },
      retentionExpiresAt: r2,
    });
    expect(second.firstRunId).toBe('run-1');
    expect(second.latestRunId).toBe('run-2');
    expect(second.firstSeenAt).toEqual(t1);
    expect(second.displayedFields).toEqual({ groups: ['a'] });
    expect(second.retentionExpiresAt).toEqual(r2);
  });

  it('fills a missing first display and never shortens retention', () => {
    const first = mergeEpisodeOnRun(null, {
      runId: 'run-1',
      seenAt: t1,
      displayedFields: null,
      retentionExpiresAt: r2,
    });
    const second = mergeEpisodeOnRun(first, {
      runId: 'run-2',
      seenAt: t2,
      displayedFields: { groups: ['b'] },
      retentionExpiresAt: r1,
    });
    expect(second.displayedFields).toEqual({ groups: ['b'] });
    expect(second.retentionExpiresAt).toEqual(r2);
  });

  it('adopts the incoming run as first when the stored episode has none', () => {
    const orphan: EpisodeState = {
      firstRunId: null,
      latestRunId: null,
      firstSeenAt: t1,
      displayedFields: null,
      retentionExpiresAt: r1,
    };
    const merged = mergeEpisodeOnRun(orphan, {
      runId: 'run-2',
      seenAt: t2,
      displayedFields: null,
      retentionExpiresAt: r1,
    });
    expect(merged.firstRunId).toBe('run-2');
    expect(merged.latestRunId).toBe('run-2');
  });
});

describe('analyseInputKey', () => {
  const base = {
    transportId: 'transport-1',
    messageId: 'msg-1',
    sourceHash: 'a'.repeat(64),
    promptVersion: 'prompt-1',
    treatAs: null,
  };

  it('is a stable 64-character digest for the same analyse', () => {
    const key = analyseInputKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(analyseInputKey({ ...base })).toBe(key);
  });

  it('separates transport, message, selection text, prompt and treat-as', () => {
    const key = analyseInputKey(base);
    expect(analyseInputKey({ ...base, transportId: 'transport-2' })).not.toBe(key);
    expect(analyseInputKey({ ...base, messageId: 'msg-2' })).not.toBe(key);
    expect(analyseInputKey({ ...base, sourceHash: 'c'.repeat(64) })).not.toBe(key);
    expect(analyseInputKey({ ...base, promptVersion: 'prompt-2' })).not.toBe(key);
    expect(analyseInputKey({ ...base, treatAs: 'quote' })).not.toBe(key);
  });
});

/** A DB handle that answers the origin queries in order and records the conditions it was asked with. */
function originDb(answers: Array<Array<{ id: string }>>) {
  const asked: unknown[] = [];
  const chain = {
    select: () => chain,
    from: () => chain,
    where: (condition: unknown) => {
      asked.push(condition);
      return chain;
    },
    orderBy: () => chain,
    limit: async () => answers.shift() ?? [],
  };
  return { db: chain as never, asked };
}

describe('createAgentRunRecorder origin lookup', () => {
  it('links the hit to its producing run when that run is still a model run for the input', async () => {
    const { db, asked } = originDb([[{ id: 'run-producer' }]]);
    const recorder = createAgentRunRecorder(db, { enabled: true })!;
    await expect(
      recorder.findOriginRunId({
        inputKey: 'key-1',
        producingRunId: 'run-producer',
        cacheWrittenAt: new Date('2026-10-09T09:00:00Z'),
      }),
    ).resolves.toBe('run-producer');
    expect(asked).toHaveLength(1);
  });

  it('falls back to the latest model run written by the cache time when the producing run is gone', async () => {
    const { db, asked } = originDb([[], [{ id: 'run-latest' }]]);
    const recorder = createAgentRunRecorder(db, { enabled: true })!;
    await expect(
      recorder.findOriginRunId({
        inputKey: 'key-1',
        producingRunId: 'run-purged',
        cacheWrittenAt: new Date('2026-10-09T09:00:00Z'),
      }),
    ).resolves.toBe('run-latest');
    expect(asked).toHaveLength(2);
  });

  it('looks up by input key alone when the entry names no run and gives no write time', async () => {
    const { db, asked } = originDb([[{ id: 'run-latest' }]]);
    const recorder = createAgentRunRecorder(db, { enabled: true })!;
    await expect(
      recorder.findOriginRunId({ inputKey: 'key-1', producingRunId: null, cacheWrittenAt: null }),
    ).resolves.toBe('run-latest');
    expect(asked).toHaveLength(1);
  });
});

describe('recordAgentRunCapped', () => {
  it('returns the id the recorder gives, with no origin lookup on a miss', async () => {
    const recorder: AgentRunRecorder = {
      findOriginRunId: vi.fn(async () => 'unused'),
      record: vi.fn(async () => 'run-9'),
    };
    await expect(recordAgentRunCapped(recorder, draft())).resolves.toBe('run-9');
    expect(recorder.findOriginRunId).not.toHaveBeenCalled();
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ cachedFromRunId: null }),
    );
  });

  it('looks up the origin by input key only when the cache entry names no producing run', async () => {
    const recorder: AgentRunRecorder = {
      findOriginRunId: vi.fn(async (lookup: OriginLookup) =>
        lookup.inputKey === 'key-1' ? 'run-1' : null,
      ),
      record: vi.fn(async () => 'run-2'),
    };
    await expect(
      recordAgentRunCapped(recorder, draft({ cacheStatus: 'hit', inputKey: 'key-1' })),
    ).resolves.toBe('run-2');
    expect(recorder.findOriginRunId).toHaveBeenCalledWith({
      inputKey: 'key-1',
      producingRunId: null,
      cacheWrittenAt: null,
    });
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ cachedFromRunId: 'run-1' }),
    );
  });

  it('hands the producing run and the write time to the origin lookup, so the link is never a guess', async () => {
    const writtenAt = new Date('2026-10-09T09:00:00Z');
    const recorder: AgentRunRecorder = {
      findOriginRunId: vi.fn(async () => 'run-producer'),
      record: vi.fn(async () => 'run-hit'),
    };
    await recordAgentRunCapped(
      recorder,
      draft({ cacheStatus: 'hit', producingRunId: 'run-producer', cacheWrittenAt: writtenAt }),
    );
    expect(recorder.findOriginRunId).toHaveBeenCalledWith({
      inputKey: 'b'.repeat(64),
      producingRunId: 'run-producer',
      cacheWrittenAt: writtenAt,
    });
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ cachedFromRunId: 'run-producer' }),
    );
  });

  it('resolves null, and logs only a code, when the write rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder: AgentRunRecorder = {
      findOriginRunId: vi.fn(async () => null),
      record: vi.fn(async () => {
        throw new Error('insert failed for staff@example.com');
      }),
    };
    await expect(recordAgentRunCapped(recorder, draft())).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('hitl_record_skipped', { code: 'error' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('example.com');
  });

  it('resolves null when the origin lookup rejects on a cache hit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder: AgentRunRecorder = {
      findOriginRunId: vi.fn(async () => {
        throw new Error('lookup failed');
      }),
      record: vi.fn(async () => 'run-2'),
    };
    await expect(recordAgentRunCapped(recorder, draft({ cacheStatus: 'hit' }))).resolves.toBeNull();
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it('gives up at the cap and resolves null while the slow write carries on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(AGENT_RUN_RECORD_CAP_MS).toBe(300);
    const recorder: AgentRunRecorder = {
      findOriginRunId: vi.fn(async () => null),
      record: vi.fn(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('run-late'), 1000)),
      ),
    };
    const started = Date.now();
    await expect(recordAgentRunCapped(recorder, draft())).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(AGENT_RUN_RECORD_CAP_MS + 200);
    expect(warn).toHaveBeenCalledWith('hitl_record_skipped', { code: 'timeout' });
  });
});
