import { describe, expect, it } from 'vitest';
import {
  resolveAuthProfilePolicy,
  resolveDatabasePoolMax,
} from '../src/lib/auth-profile';

describe('auth session TTL', () => {
  it('preserves legacy 400-day sessions with weekly renewal and cookie cache', () => {
    const policy = resolveAuthProfilePolicy({
      BETTER_AUTH_URL: 'https://nava.legacyhotels.co.za',
    });

    expect(policy.expiresIn).toBe(60 * 60 * 24 * 400);
    expect(policy.updateAge).toBe(60 * 60 * 24 * 7);
    expect(policy.disableSessionRefresh).toBe(false);
    expect(policy.cookieCache).toEqual({ enabled: true, maxAge: 60 * 60 });
  });

  it('uses fixed pool maxima per profile', () => {
    expect(resolveDatabasePoolMax('legacy')).toBe(10);
    expect(resolveDatabasePoolMax('remote')).toBe(3);
  });
});
