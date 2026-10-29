import { TRPCError } from '@trpc/server';

export const QUOTE_SOURCE_BUSY_MESSAGE = 'The email is being updated. Wait a moment, then try again.';

/** Drizzle may wrap the PostgreSQL error in one or more causes. */
export function isQuoteSourceLockBusy(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === '55P03' || value.code === '40P01' || value.code === 'QUOTE_SOURCE_BUSY') return true;
    current = value.cause;
  }
  return false;
}

export function quoteSourceBusyError(): TRPCError {
  return new TRPCError({ code: 'PRECONDITION_FAILED', message: QUOTE_SOURCE_BUSY_MESSAGE,
    cause: { reason: 'refused_lock_busy', code: 'QUOTE_SOURCE_BUSY' } });
}

/** Convert contention only after the transaction rolls back; never return an unchecked price. */
export async function withQuoteSourceBusyHold<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (isQuoteSourceLockBusy(error)) throw quoteSourceBusyError();
    throw error;
  }
}
