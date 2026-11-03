import { describe, expect, it } from 'vitest';
import { createBackgroundDrain } from '../src/lib/background-drain.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('background shutdown drain', () => {
  it('waits for all started work, including a task started while draining', async () => {
    const drain = createBackgroundDrain();
    const first = deferred(), late = deferred();
    drain.track(first.promise);
    let complete = false;
    const waiting = drain.drain().then(() => { complete = true; });
    drain.track(late.promise);
    first.resolve();
    await Promise.resolve();
    expect(complete).toBe(false);
    late.resolve();
    await waiting;
    expect(complete).toBe(true);
  });

  it('waits for a failed task without blocking shutdown forever', async () => {
    const drain = createBackgroundDrain(), task = deferred();
    const tracked = drain.track(task.promise);
    const waiting = drain.drain();
    task.reject(new Error('fixture failure'));
    await expect(tracked).rejects.toThrow('fixture failure');
    await expect(waiting).resolves.toBeUndefined();
  });
});
