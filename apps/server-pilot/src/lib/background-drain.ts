/** Track work started by timers so shutdown can wait for it before closing the DB. */
export function createBackgroundDrain() {
  const active = new Set<Promise<unknown>>();
  return {
    track<T>(task: Promise<T>): Promise<T> {
      active.add(task);
      void task.then(() => active.delete(task), () => active.delete(task));
      return task;
    },
    async drain(): Promise<void> {
      while (active.size) await Promise.allSettled(active);
    },
  };
}

/** A disconnected HTTP client must not hide a handler that is still running. */
export function withDrain<T extends unknown[], R>(
  drain: ReturnType<typeof createBackgroundDrain>,
  handler: (...args: T) => R,
): (...args: T) => Promise<Awaited<R>> {
  return (...args) => drain.track(Promise.resolve().then(() => handler(...args)));
}
