import { describe, expect, it } from 'vitest';
import { resolveAuthProfilePolicy } from '../src/lib/auth-profile';

const CANONICAL_ORIGIN = 'https://nava.legacyhotels.co.za';
const REMOTE_ORIGIN = 'https://admin.legacyhotels.co.za';

describe('auth profile trusted origins', () => {
  it('keeps legacy origin isolated from remote plane', () => {
    const policy = resolveAuthProfilePolicy({
      BETTER_AUTH_URL: `${CANONICAL_ORIGIN}/`,
    });

    expect(policy.trustedOrigins).toContain(CANONICAL_ORIGIN);
    expect(policy.trustedOrigins).not.toContain(REMOTE_ORIGIN);
    expect(policy.cookiePrefix).toBe('better-auth');
    expect(policy.sessionModelName).toBe('session');
  });

  it('trusts exact remote origin without shared cookie domain', () => {
    const policy = resolveAuthProfilePolicy({
      NAVA_AUTH_SESSION_PROFILE: 'remote',
      BETTER_AUTH_URL: `${REMOTE_ORIGIN}/`,
      BETTER_AUTH_TRUSTED_ORIGINS: CANONICAL_ORIGIN,
    });

    expect(policy.baseURL).toBe(`${REMOTE_ORIGIN}/`);
    expect(policy.trustedOrigins).toEqual([REMOTE_ORIGIN]);
    expect(policy.cookiePrefix).toBe('better-auth-remote');
    expect(policy.sessionModelName).toBe('remoteSession');
    expect(policy.cookieDomain).toBeUndefined();
  });
});
