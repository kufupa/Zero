import type { TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '@zero/server/trpc';

let inFlight = 0;

/** tRPC mutations started and not yet settled. The pane will not reload while this is above zero. */
export function mutationsInFlight(): number {
  return inFlight;
}

/**
 * Counts each tRPC mutation from start until it settles, errors or is cancelled. Every
 * pane write (quote prep, booking, stay lookup, cancel, PDF) goes through the shared client,
 * so one link covers them all. Queries are read-only and are not counted.
 */
export const countMutationsLink: TRPCLink<AppRouter> = () => {
  return ({ op, next }) =>
    observable((observer) => {
      if (op.type !== 'mutation') return next(op).subscribe(observer);
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
