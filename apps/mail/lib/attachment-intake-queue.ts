export async function drainAttachmentIntakeQueue(
  getCurrentQueue: () => Promise<void>,
  getPendingWorkCount: () => number,
): Promise<void> {
  for (;;) {
    const queue = getCurrentQueue();
    await queue;
    await Promise.resolve();

    if (queue === getCurrentQueue() && getPendingWorkCount() === 0) {
      return;
    }
  }
}
