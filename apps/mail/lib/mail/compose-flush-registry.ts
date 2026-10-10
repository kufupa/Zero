export type ComposeFlushFn = () => Promise<void>;

let composeFlush: ComposeFlushFn | null = null;
let composeUnsavedCheck: (() => boolean) | null = null;

export function registerComposeFlush(fn: ComposeFlushFn | null): void {
  composeFlush = fn;
}

export function getComposeFlush(): ComposeFlushFn | null {
  return composeFlush;
}

export async function flushComposeBeforeLeave(): Promise<void> {
  await composeFlush?.();
}

/** The open composer's check: true when a leave would have edits to save. */
export function registerComposeUnsavedCheck(fn: (() => boolean) | null): void {
  composeUnsavedCheck = fn;
}

/** True when an open composer holds edits not yet saved. False with no composer open. */
export function composeHasUnsavedChanges(): boolean {
  return composeUnsavedCheck?.() ?? false;
}
