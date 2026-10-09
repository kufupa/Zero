import {
  advisoryLockCoordinates,
  beginQuoteRun,
  countOtherInFlightQuoteRuns,
  describeHmsQueueStatus,
  latestQuoteRunFor,
  QUOTE_RUNNING_STALL_MS,
  QUOTE_WAITING_STALL_MS,
  readPropertyLockHolder,
  type QuoteRunHandle,
} from '../src/hms/property-queue-state.js';
import { propertyReadLockKey } from '../src/hms/property-read-lock.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DB } from '../src/db/client.js';

const NOW = 1_000_000_000_000;
const MIN = 60_000;

const handles: QuoteRunHandle[] = [];
function begin(input: Parameters<typeof beginQuoteRun>[0]) {
  const handle = beginQuoteRun(input);
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.end();
});

describe('advisory lock key mapping (pg_locks coordinates)', () => {
  it('maps a bigint key onto pg_locks classid/objid with sign extension', () => {
    expect(advisoryLockCoordinates('-1')).toEqual({ classid: 4294967295, objid: 4294967295 });
    expect(advisoryLockCoordinates('1')).toEqual({ classid: 0, objid: 1 });
    expect(advisoryLockCoordinates('-2147483648')).toEqual({
      classid: 4294967295,
      objid: 2147483648,
    });
    expect(advisoryLockCoordinates('2147483647')).toEqual({ classid: 0, objid: 2147483647 });
  });

  it('round-trips the production property key back to the int32 it was derived from', () => {
    for (const [tenant, property] of [
      ['tenant-centurion', 'HRCEN'],
      ['synthetic-hotel', 'HRCEN'],
      ['tenant-other', 'XXPRP'],
    ] as const) {
      const key = propertyReadLockKey(tenant, property);
      const { classid, objid } = advisoryLockCoordinates(key);
      const rebuilt = BigInt.asIntN(64, (BigInt(classid) << 32n) | BigInt(objid));
      expect(rebuilt.toString()).toBe(key);
      expect(classid).toBeGreaterThanOrEqual(0);
      expect(objid).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects anything that is not a signed int32 decimal key', () => {
    expect(() => advisoryLockCoordinates('2147483648')).toThrow();
    expect(() => advisoryLockCoordinates('1.5')).toThrow();
    expect(() => advisoryLockCoordinates('1; DROP TABLE x')).toThrow();
  });
});

describe('describeHmsQueueStatus', () => {
  it('is idle with an empty message when this caller has no run in flight', () => {
    expect(describeHmsQueueStatus({ nowMs: NOW })).toEqual({ state: 'idle', message: '' });
  });

  it('reports the running step in plain English once the lock is held', () => {
    const status = describeHmsQueueStatus({
      run: { phaseIndex: 1, startedAtMs: NOW - 2 * MIN, runningSinceMs: NOW - 30_000 },
      nowMs: NOW,
    });
    expect(status).toMatchObject({
      state: 'running',
      phase: 'Searching rates',
      phaseIndex: 1,
      phaseCount: 3,
      runningForMs: 30_000,
      message: 'Nava is working in HMS – step 1 of 3: Searching rates.',
    });
    expect(status.aheadCount).toBeUndefined();
    expect(status.etaMinutes).toBeUndefined();
  });

  it('advances the step label without changing the count', () => {
    const status = describeHmsQueueStatus({
      run: { phaseIndex: 2, startedAtMs: NOW - MIN, runningSinceMs: NOW - MIN },
      nowMs: NOW,
    });
    expect(status).toMatchObject({
      state: 'running',
      phase: 'Checking the quote rules',
      phaseIndex: 2,
      phaseCount: 3,
      message: 'Nava is working in HMS – step 2 of 3: Checking the quote rules.',
    });
  });

  it('says "ahead" for one other quote, counting the current holder into the estimate', () => {
    // Holder started 4.0 min ago: 0.7 min of its 4.7 min typical remain.
    // ETA = 1 waiting quote (4.7 min) + 0.7 min = 5.4 min -> rounded up to 6.
    const status = describeHmsQueueStatus({
      run: { phaseIndex: 0, startedAtMs: NOW - MIN },
      nowMs: NOW,
      holder: { present: true, elapsedMs: 4 * MIN },
      otherQuoteRuns: 2,
    });
    expect(status).toMatchObject({
      state: 'waiting',
      aheadCount: 1,
      etaMinutes: 6,
      message: '1 quote ahead of yours – about 6 minutes.',
    });
  });

  it('counts plural quotes ahead and rounds the ETA up', () => {
    const status = describeHmsQueueStatus({
      run: { phaseIndex: 0, startedAtMs: NOW - MIN },
      nowMs: NOW,
      otherQuoteRuns: 2,
    });
    expect(status).toMatchObject({
      state: 'waiting',
      aheadCount: 2,
      etaMinutes: 10,
      message: '2 quotes ahead of yours – about 10 minutes.',
    });
  });

  it('reports a busy HMS with no quote ahead when only the current holder remains', () => {
    const status = describeHmsQueueStatus({
      run: { phaseIndex: 0, startedAtMs: NOW - MIN },
      nowMs: NOW,
      holder: { present: true, elapsedMs: 4 * MIN },
      otherQuoteRuns: 1,
    });
    expect(status).toMatchObject({
      state: 'waiting',
      aheadCount: 0,
      etaMinutes: 1,
      message: 'HMS is busy with another run – about a minute.',
    });
  });

  it('treats an unknown holder start as a full typical run', () => {
    const status = describeHmsQueueStatus({
      run: { phaseIndex: 0, startedAtMs: NOW - MIN },
      nowMs: NOW,
      holder: { present: true },
      otherQuoteRuns: 2,
    });
    expect(status).toMatchObject({ aheadCount: 1, etaMinutes: 10 });
  });

  it('says it is waiting for HMS when nothing else holds or queues the lock', () => {
    const status = describeHmsQueueStatus({
      run: { phaseIndex: 0, startedAtMs: NOW - 5_000 },
      nowMs: NOW,
      holder: { present: false },
      otherQuoteRuns: 0,
    });
    expect(status).toEqual({
      state: 'waiting',
      aheadCount: 0,
      message: 'Waiting for HMS to become free.',
    });
  });

  it('declares HMS not responding once a waiting run exceeds the waiting stall limit', () => {
    const status = describeHmsQueueStatus({
      run: { phaseIndex: 0, startedAtMs: NOW - QUOTE_WAITING_STALL_MS - 1 },
      nowMs: NOW,
      holder: { present: true, elapsedMs: 20 * MIN },
      otherQuoteRuns: 3,
    });
    expect(status).toMatchObject({
      state: 'unavailable',
      message: 'HMS is not responding. Try again in a few minutes.',
    });
  });

  it('measures the running stall from lock acquisition, not from the queue wait', () => {
    const status = describeHmsQueueStatus({
      run: {
        phaseIndex: 1,
        startedAtMs: NOW - 14 * MIN,
        runningSinceMs: NOW - MIN,
      },
      nowMs: NOW,
    });
    expect(status.state).toBe('running');
  });

  it('keeps a running quote "running" up to 2x typical and then reports HMS not responding', () => {
    const atLimit = describeHmsQueueStatus({
      run: {
        phaseIndex: 3,
        startedAtMs: NOW - QUOTE_RUNNING_STALL_MS,
        runningSinceMs: NOW - QUOTE_RUNNING_STALL_MS,
      },
      nowMs: NOW,
    });
    expect(atLimit.state).toBe('running');
    const pastLimit = describeHmsQueueStatus({
      run: {
        phaseIndex: 1,
        startedAtMs: NOW - QUOTE_RUNNING_STALL_MS - 1,
        runningSinceMs: NOW - QUOTE_RUNNING_STALL_MS - 1,
      },
      nowMs: NOW,
    });
    expect(pastLimit).toMatchObject({
      state: 'unavailable',
      message: 'HMS is not responding. Try again in a few minutes.',
    });
  });

  it('never uses queue-position wording that implies FIFO order', () => {
    const messages = [
      describeHmsQueueStatus({
        run: { phaseIndex: 0, startedAtMs: NOW - MIN },
        nowMs: NOW,
        otherQuoteRuns: 2,
      }).message,
      describeHmsQueueStatus({
        run: { phaseIndex: 0, startedAtMs: NOW - MIN },
        nowMs: NOW,
        holder: { present: true, elapsedMs: MIN },
        otherQuoteRuns: 2,
      }).message,
    ];
    for (const message of messages) expect(message).not.toMatch(/2nd|in line|first|position/i);
  });
});

describe('quote run registry (this process)', () => {
  it('reports the latest run for the same mailbox and user only', () => {
    begin({
      generationId: 'gen-older',
      transportId: 'transport-a',
      userId: 'user-1',
      lockKey: '-1',
      nowMs: NOW - 2 * MIN,
    });
    expect(latestQuoteRunFor({ transportId: 'transport-a', userId: 'user-1' })).toMatchObject({
      generationId: 'gen-older',
      phaseIndex: 0,
      startedAtMs: NOW - 2 * MIN,
    });
    begin({
      generationId: 'gen-newer',
      transportId: 'transport-a',
      userId: 'user-1',
      lockKey: '-1',
      nowMs: NOW - MIN,
    });
    expect(latestQuoteRunFor({ transportId: 'transport-a', userId: 'user-1' })?.generationId).toBe(
      'gen-newer',
    );
    expect(latestQuoteRunFor({ transportId: 'transport-b', userId: 'user-1' })).toBeUndefined();
    expect(latestQuoteRunFor({ transportId: 'transport-a', userId: 'user-2' })).toBeUndefined();
  });

  it('marks the start of running on the first lock-held phase and keeps it on later phases', () => {
    const handle = begin({
      generationId: 'gen-phase',
      transportId: 'transport-a',
      userId: 'user-1',
      lockKey: '-1',
      nowMs: NOW - 3 * MIN,
    });
    handle.setPhase(1, NOW - MIN);
    handle.setPhase(2, NOW);
    expect(latestQuoteRunFor({ transportId: 'transport-a', userId: 'user-1' })).toMatchObject({
      phaseIndex: 2,
      runningSinceMs: NOW - MIN,
    });
  });

  it('forgets a run when it ends, so a finished run never reports as running', () => {
    const handle = begin({
      generationId: 'gen-end',
      transportId: 'transport-a',
      userId: 'user-1',
      lockKey: '-1',
      nowMs: NOW,
    });
    handle.end();
    handle.end();
    expect(latestQuoteRunFor({ transportId: 'transport-a', userId: 'user-1' })).toBeUndefined();
  });
});

function fakeDb(options: { execute?: unknown[]; selectRows?: unknown[] }) {
  const executed: unknown[] = [];
  const chain: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then')
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(options.selectRows ?? []).then(resolve, reject);
        return () => chain;
      },
    },
  ) as Record<string | symbol, unknown>;
  const db = {
    execute: vi.fn(async (query: unknown) => {
      executed.push(query);
      return options.execute ?? [];
    }),
    select: vi.fn(() => chain),
  };
  return { db: db as unknown as DB, db_raw: db, executed };
}

describe('pg_locks holder and in-flight counts (mocked database)', () => {
  it('reports no holder when no granted advisory lock matches the property key', async () => {
    const { db } = fakeDb({ execute: [] });
    await expect(readPropertyLockHolder(db, '-1')).resolves.toEqual({ present: false });
  });

  it('reports the holder start from pg_stat_activity and binds the key coordinates as parameters', async () => {
    const { db, executed } = fakeDb({ execute: [{ elapsed_ms: '4000.5' }] });
    await expect(readPropertyLockHolder(db, '-1')).resolves.toEqual({
      present: true,
      elapsedMs: 4000.5,
    });
    const compiled = new PgDialect().sqlToQuery(
      executed[0] as Parameters<PgDialect['sqlToQuery']>[0],
    );
    expect(compiled.params).toEqual(expect.arrayContaining([4294967295, 4294967295]));
    expect(compiled.sql).toContain("l.locktype = 'advisory'");
    expect(compiled.sql).toContain('l.granted');
  });

  it('counts other in-flight staff quote runs', async () => {
    const { db } = fakeDb({ selectRows: [{ count: 3 }] });
    await expect(countOtherInFlightQuoteRuns(db, 'gen-self')).resolves.toBe(3);
  });

  it('treats an empty count result as zero', async () => {
    const { db } = fakeDb({ selectRows: [] });
    await expect(countOtherInFlightQuoteRuns(db, 'gen-self')).resolves.toBe(0);
  });
});
