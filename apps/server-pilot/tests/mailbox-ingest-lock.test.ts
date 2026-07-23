import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetMailboxIngestLocksForTests,
  withMailboxIngestLock,
} from '../src/mail/ingest/mailbox-ingest-lock.js';

afterEach(() => {
  __resetMailboxIngestLocksForTests();
});

describe('withMailboxIngestLock', () => {
  it('serializes work for the same mailbox key', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withMailboxIngestLock('transport-a', async () => {
      order.push('first-enter');
      await firstGate;
      order.push('first-exit');
      return 1;
    });

    // Let first acquire the lock.
    await Promise.resolve();
    await Promise.resolve();

    const second = withMailboxIngestLock('transport-a', async () => {
      order.push('second');
      return 2;
    });

    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ ok: true, value: 1 });
    expect(b).toEqual({ ok: true, value: 2 });
    expect(order).toEqual(['first-enter', 'first-exit', 'second']);
  });

  it('returns cycleError when lock wait times out', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withMailboxIngestLock('transport-b', async () => {
      await gate;
      return 'held';
    });

    await Promise.resolve();
    await Promise.resolve();

    const timedOut = await withMailboxIngestLock(
      'transport-b',
      async () => 'never',
      20,
    );
    expect(timedOut).toEqual({
      ok: false,
      cycleError: 'mailbox ingest lock timeout',
    });

    release();
    await holder;
  });
});
