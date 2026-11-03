export type ComposeFlushFn = () => Promise<void>;

let composeFlush: ComposeFlushFn | null = null;
let composeUnsavedCheck: (() => boolean) | null = null;
let composePendingRecipientCheck: (() => boolean) | null = null;
let composeSwitchLock: ((locked: boolean) => void) | null = null;
let composeSwitchInFlight = false;

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

/** Uncommitted recipient text must remain in the editor until the user completes it. */
export function registerComposePendingRecipientCheck(fn: (() => boolean) | null): void {
  composePendingRecipientCheck = fn;
}

/** Keep the current editor non-interactive until the selection has committed. */
export function registerComposeSwitchLock(fn: ((locked: boolean) => void) | null): void {
  composeSwitchLock = fn;
  if (fn && composeSwitchInFlight) fn(true);
}

/** A row switch must not discard a reply when its save failed or it remains dirty. */
export async function flushComposeBeforeSwitch(): Promise<boolean> {
  try {
    await flushComposeBeforeLeave();
    return !composeHasUnsavedChanges();
  } catch {
    return false;
  }
}

/** Only the first pending switch may save and commit a new selection. */
export async function runComposeSwitch(commit: () => void | Promise<void>): Promise<'switched' | 'busy' | 'unfinished_recipient' | 'save_failed' | 'switch_failed'> {
  if (composeSwitchInFlight) return 'busy';
  composeSwitchInFlight = true;
  const lock = composeSwitchLock;
  try {
    lock?.(true);
    if (composePendingRecipientCheck?.()) return 'unfinished_recipient';
    if (!(await flushComposeBeforeSwitch())) return 'save_failed';
    try {
      await commit();
      return 'switched';
    } catch {
      return 'switch_failed';
    }
  } finally {
    try {
      lock?.(false);
      if (composeSwitchLock !== lock) composeSwitchLock?.(false);
    } finally { composeSwitchInFlight = false; }
  }
}
