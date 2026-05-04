import { describe, expect, it } from 'vitest';
import { computeThreadListEnabled } from '../lib/mail/thread-list-query-enabled';

describe('computeThreadListEnabled', () => {
  it('returns false when route folder is missing', () => {
    expect(
      computeThreadListEnabled({
        demoMode: true,
        sessionUserId: undefined,
        routeFolder: undefined,
      }),
    ).toBe(false);
    expect(
      computeThreadListEnabled({
        demoMode: false,
        sessionUserId: 'user-1',
        routeFolder: undefined,
      }),
    ).toBe(false);
  });

  it('returns true in demo mode when folder is present', () => {
    expect(
      computeThreadListEnabled({
        demoMode: true,
        sessionUserId: undefined,
        routeFolder: 'inbox',
      }),
    ).toBe(true);
  });

  it('returns false in live mode without session', () => {
    expect(
      computeThreadListEnabled({
        demoMode: false,
        sessionUserId: undefined,
        routeFolder: 'inbox',
      }),
    ).toBe(false);
  });

  it('returns true in live mode with session and folder', () => {
    expect(
      computeThreadListEnabled({
        demoMode: false,
        sessionUserId: 'user-1',
        routeFolder: 'inbox',
      }),
    ).toBe(true);
  });
});
