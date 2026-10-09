import { describe, expect, it } from 'vitest';
import { observable } from '@trpc/server/observable';
import { countMutationsLink, mutationsInFlight } from '../lib/workstation/mutations-in-flight';

type Settle = { succeed: () => void; fail: (error: Error) => void };

/** Runs one op through the link. The downstream request settles only when the test says so. */
function runOp(type: 'query' | 'mutation') {
  const settle: Partial<Settle> = {};
  const next = () =>
    observable<unknown, Error>((observer) => {
      settle.succeed = () => {
        observer.next({ result: { type: 'data', data: 'ok' } } as never);
        observer.complete();
      };
      settle.fail = (error) => observer.error(error);
    });
  const link = countMutationsLink({} as never);
  const op = { id: 1, type, path: 'workstation.x', input: undefined, context: {} };
  const subscription = link({ op, next } as never).subscribe({});
  return { settle, subscription };
}

describe('countMutationsLink', () => {
  it('counts a mutation from start until it completes', () => {
    expect(mutationsInFlight()).toBe(0);
    const { settle, subscription } = runOp('mutation');
    expect(mutationsInFlight()).toBe(1);
    settle.succeed?.();
    expect(mutationsInFlight()).toBe(0);
    subscription.unsubscribe();
    expect(mutationsInFlight()).toBe(0);
  });

  it('releases the count when a mutation errors', () => {
    const { settle } = runOp('mutation');
    expect(mutationsInFlight()).toBe(1);
    settle.fail?.(new Error('network'));
    expect(mutationsInFlight()).toBe(0);
  });

  it('releases the count when a mutation is cancelled before it settles', () => {
    const { subscription } = runOp('mutation');
    expect(mutationsInFlight()).toBe(1);
    subscription.unsubscribe();
    expect(mutationsInFlight()).toBe(0);
  });

  it('does not count queries, which are read-only', () => {
    runOp('query');
    expect(mutationsInFlight()).toBe(0);
  });
});
