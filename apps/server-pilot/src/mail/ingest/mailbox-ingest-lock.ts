/**
 * Mailbox-scoped in-memory ingest lock for forceSync (and same-process callers).
 * Wait up to `waitMs` for an existing holder; on timeout return cycleError.
 */
const locks = new Map<string, Promise<void>>();

export const MAILBOX_INGEST_LOCK_WAIT_MS = 30_000;

export type MailboxLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; cycleError: string };

export async function withMailboxIngestLock<T>(
  mailboxKey: string,
  fn: () => Promise<T>,
  waitMs: number = MAILBOX_INGEST_LOCK_WAIT_MS,
): Promise<MailboxLockResult<T>> {
  const deadline = Date.now() + waitMs;
  while (locks.has(mailboxKey)) {
    const pending = locks.get(mailboxKey)!;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, cycleError: 'mailbox ingest lock timeout' };
    }
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, remaining)),
    ]);
  }

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(mailboxKey, held);
  try {
    return { ok: true, value: await fn() };
  } finally {
    locks.delete(mailboxKey);
    release();
  }
}

/** Test-only: drop all held locks (does not resolve waiters mid-flight). */
export function __resetMailboxIngestLocksForTests(): void {
  locks.clear();
}
