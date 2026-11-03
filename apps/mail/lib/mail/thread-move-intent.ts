// A later move of the same thread supersedes an older move still waiting to run.
let nextIntent = 0;
const latestByThread = new Map<string, number>();

export function beginThreadMove(threadId: string): number {
  const intent = ++nextIntent;
  latestByThread.set(threadId, intent);
  return intent;
}

export function isCurrentThreadMove(threadId: string, intent: number): boolean {
  return latestByThread.get(threadId) === intent;
}

export function finishThreadMove(threadId: string, intent: number): void {
  if (isCurrentThreadMove(threadId, intent)) latestByThread.delete(threadId);
}
