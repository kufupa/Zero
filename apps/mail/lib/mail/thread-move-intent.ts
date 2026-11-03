// A newer pending move supersedes older moves until it is undone or sent.
let nextIntent = 0;
const pendingByThread = new Map<string, number[]>();

export function beginThreadMove(threadId: string): number {
  const intent = ++nextIntent;
  pendingByThread.set(threadId, [...(pendingByThread.get(threadId) ?? []), intent]);
  return intent;
}

export function hasThreadMove(threadId: string, intent?: number): boolean {
  const pending = pendingByThread.get(threadId) ?? [];
  return intent === undefined ? pending.length > 0 : pending.includes(intent);
}

export function isCurrentThreadMove(threadId: string, intent: number): boolean {
  return pendingByThread.get(threadId)?.at(-1) === intent;
}

/** Undo or discard one intent, exposing the preceding pending move if any. */
export function cancelThreadMove(threadId: string, intent: number): void {
  const remaining = (pendingByThread.get(threadId) ?? []).filter((value) => value !== intent);
  if (remaining.length) pendingByThread.set(threadId, remaining);
  else pendingByThread.delete(threadId);
}

/** Once sent, an intent and all earlier moves it superseded cannot be restored. */
export function finishThreadMove(threadId: string, intent: number): void {
  const pending = pendingByThread.get(threadId) ?? [];
  const index = pending.indexOf(intent);
  if (index < 0) return;
  const remaining = pending.slice(index + 1);
  if (remaining.length) pendingByThread.set(threadId, remaining);
  else pendingByThread.delete(threadId);
}
