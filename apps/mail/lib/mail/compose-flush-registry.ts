export type ComposeFlushFn = () => Promise<void>;

let composeFlush: ComposeFlushFn | null = null;

export function registerComposeFlush(fn: ComposeFlushFn | null): void {
  composeFlush = fn;
}

export function getComposeFlush(): ComposeFlushFn | null {
  return composeFlush;
}

export async function flushComposeBeforeLeave(): Promise<void> {
  await composeFlush?.();
}
