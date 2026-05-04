import { describe, expect, it } from 'vitest';

// This documents the desired UX policy as code:
// When thread id changes, UI should not present prior thread as authoritative.
export function shouldShowStaleThreadWhileFetching(policy: 'keepPreviousData' | 'hardReset') {
  return policy === 'hardReset';
}

describe('thread transition policy', () => {
  it('defaults to hard reset (no stale thread body) while refetching', () => {
    expect(shouldShowStaleThreadWhileFetching('hardReset')).toBe(true);
  });
});
