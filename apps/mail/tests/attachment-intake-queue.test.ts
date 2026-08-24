import { describe, expect, it } from 'vitest';
import { drainAttachmentIntakeQueue } from '../lib/attachment-intake-queue';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

describe('attachment intake queue drain', () => {
  it('waits for work appended by a settlement callback registered after drain starts', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    let currentQueue = first.promise;
    let pendingWork = 1;
    let drained = false;

    const drainPromise = drainAttachmentIntakeQueue(
      () => currentQueue,
      () => pendingWork,
    ).then(() => {
      drained = true;
    });

    first.promise.then(() => {
      currentQueue = second.promise;
      pendingWork += 1;
    });
    first.resolve();
    pendingWork -= 1;

    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    second.resolve();
    pendingWork -= 1;
    await drainPromise;

    expect(drained).toBe(true);
  });
});
