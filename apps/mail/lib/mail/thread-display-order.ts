/** Assumes messages are API-asc (oldest → newest). Returns newest-first for the reading pane. */
export function orderMessagesNewestFirst<T>(messages: readonly T[]): T[] {
  return [...messages].reverse();
}
