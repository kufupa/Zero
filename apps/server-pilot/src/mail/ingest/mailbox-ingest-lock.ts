/**
 * Mailbox-scoped in-memory ingest lock for forceSync (and same-process callers).
 * Wait up to `waitMs` for an existing holder; on timeout return cycleError.
 *
 * Acquire is atomic via a per-key promise chain (enqueue before await) so two
 * waiters cannot both pass a check-then-set race after the holder releases.
 */
const tails = new Map<string, Promise<void>>();

export const MAILBOX_INGEST_LOCK_WAIT_MS = 30_000;

export type MailboxLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; cycleError: string };

export async function withMailboxIngestLock<T>(
  mailboxKey: string,
  fn: () => Promise<T>,
  waitMs: number = MAILBOX_INGEST_LOCK_WAIT_MS,
): Promise<MailboxLockResult<T>> {
  const previous = tails.get(mailboxKey) ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Enqueue atomically (sync Map set before any await).
  const tail = previous.catch(() => undefined).then(() => gate);
  tails.set(mailboxKey, tail);

  try {
    const acquired = await Promise.race([
      previous.then(() => true as const).catch(() => true as const),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), waitMs);
      }),
    ]);

    if (!acquired) {
      return { ok: false, cycleError: 'mailbox ingest lock timeout' };
    }

    return { ok: true, value: await fn() };
  } finally {
    release();
    if (tails.get(mailboxKey) === tail) {
      tails.delete(mailboxKey);
    }
  }
}

/** Test-only: drop all held locks (does not resolve waiters mid-flight). */
export function __resetMailboxIngestLocksForTests(): void {
  tails.clear();
}
