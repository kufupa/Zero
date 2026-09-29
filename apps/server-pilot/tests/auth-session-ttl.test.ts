import { describe, expect, it } from 'vitest';
import {
  resolveAuthProfilePolicy,
  resolveDatabasePoolMax,
} from '../src/lib/auth-profile';

describe('auth session TTL', () => {
  it('expires legacy staff sessions after 24 hours without renewal or cached-cookie bypass', () => {
    const policy = resolveAuthProfilePolicy({
      BETTER_AUTH_URL: 'https://nava.legacyhotels.co.za',
    });

    expect(policy.expiresIn).toBe(86_400);
    expect(policy.updateAge).toBe(0);
    expect(policy.disableSessionRefresh).toBe(true);
    expect(policy.cookieCache).toEqual({ enabled: false });
  });

  it('keeps remote sessions at 12 hours with no refresh or cookie cache', () => {
    const policy = resolveAuthProfilePolicy({ NAVA_AUTH_SESSION_PROFILE: 'remote' });
    expect(policy.expiresIn).toBe(43_200);
    expect(policy.updateAge).toBe(0);
    expect(policy.disableSessionRefresh).toBe(true);
    expect(policy.cookieCache).toEqual({ enabled: false });
  });

  it('uses fixed pool maxima per profile', () => {
    expect(resolveDatabasePoolMax('legacy')).toBe(10);
    expect(resolveDatabasePoolMax('remote')).toBe(3);
  });
});
