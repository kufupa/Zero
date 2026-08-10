import { describe, expect, it } from 'vitest';
import {
  resolveAuthProfilePolicy,
  resolveAuthSessionProfile,
  resolveDatabasePoolMax,
} from '../src/lib/auth-profile';
import { getPublicAuthProviders, getSocialProviders } from '../src/lib/auth-providers';

const LEGACY_ENV = {
  BETTER_AUTH_URL: 'https://nava.legacyhotels.co.za',
  GOOGLE_CLIENT_ID: 'legacy-google-client',
  GOOGLE_CLIENT_SECRET: 'legacy-google-secret',
};

describe('auth session profile', () => {
  it('fails closed for an unknown profile', () => {
    expect(() =>
      resolveAuthSessionProfile({ NAVA_AUTH_SESSION_PROFILE: 'other' }),
    ).toThrow(/NAVA_AUTH_SESSION_PROFILE/);
  });

  it('makes remote sessions fixed 12-hour database-checked sessions', () => {
    const policy = resolveAuthProfilePolicy({
      ...LEGACY_ENV,
      NAVA_AUTH_SESSION_PROFILE: 'remote',
      BETTER_AUTH_URL: 'https://admin.legacyhotels.co.za',
    });

    expect(policy.expiresIn).toBe(43_200);
    expect(policy.updateAge).toBe(0);
    expect(policy.disableSessionRefresh).toBe(true);
    expect(policy.cookieCache).toEqual({ enabled: false });
    expect(resolveDatabasePoolMax('remote')).toBe(3);
  });

  it('omits Google from remote auth and public provider views', () => {
    const providers = getPublicAuthProviders(
      { ...LEGACY_ENV, NAVA_AUTH_SESSION_PROFILE: 'remote' },
      'remote',
    );

    expect(getSocialProviders(LEGACY_ENV, 'remote')).toEqual({});
    expect(providers.map((provider) => provider.id)).toEqual(['zero']);
  });

  it('retains legacy Google behavior when credentials exist', () => {
    const providers = getPublicAuthProviders(LEGACY_ENV, 'legacy');

    expect(getSocialProviders(LEGACY_ENV, 'legacy')).toHaveProperty('google');
    expect(providers.map((provider) => provider.id)).toEqual(['zero', 'google']);
  });
});
