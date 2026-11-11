import type { TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '@zero/server/trpc';

let inFlight = 0;
export const NAVA_FAILURE_REPORT_CONTEXT_KEY = 'navaFailureReport';

/** tRPC mutations started and not yet settled. The pane will not reload while this is above zero. */
export function mutationsInFlight(): number {
  return inFlight;
}

/** Counts a write made outside tRPC (the native reply draft) in the same counter. Pair with endMutation. */
export function beginMutation(): void {
  inFlight += 1;
}

export function endMutation(): void {
  inFlight = Math.max(0, inFlight - 1);
}

/**
 * Counts each business tRPC mutation from start until it settles, errors or is cancelled. Every
 * pane write (quote prep, booking, stay lookup, cancel, PDF) goes through the shared client,
 * so one link covers them all. Best-effort failure reports are excluded; queries are read-only.
 */
export const countMutationsLink: TRPCLink<AppRouter> = () => {
  return ({ op, next }) =>
    observable((observer) => {
      if (op.type !== 'mutation' || op.context[NAVA_FAILURE_REPORT_CONTEXT_KEY] === true) return next(op).subscribe(observer);
      inFlight += 1;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        inFlight -= 1;
      };
      const subscription = next(op).subscribe({
        next: (value) => observer.next(value),
        error: (error) => {
          settle();
          observer.error(error);
        },
        complete: () => {
          settle();
          observer.complete();
        },
      });
      return () => {
        settle();
        subscription.unsubscribe();
      };
    });
};
