import { describe, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import { createBackgroundDrain, withDrain } from '../src/lib/background-drain.js';

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

  it('waits for a handler even after its HTTP client disconnects', async () => {
    const drain = createBackgroundDrain(), entered = deferred(), release = deferred();
    const handler = withDrain(drain, async () => {
      entered.resolve();
      await release.promise;
    });
    const server = createServer((_req, res) => {
      void handler().then(() => { if (!res.destroyed) res.end(); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not listen');
    const client = request({ hostname: '127.0.0.1', port: address.port });
    client.on('error', () => {});
    client.end();
    await entered.promise;
    client.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    let completed = false;
    const waiting = drain.drain().then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    release.resolve();
    await waiting;
    expect(completed).toBe(true);
  });
});
