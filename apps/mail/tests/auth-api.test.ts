import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoAuthAdapter } from '../lib/auth/adapters/demo-auth';
import { createHostedAuthAdapter } from '../lib/auth/adapters/hosted-auth';
import { getAuthApi, resetAuthApiCache } from '../lib/auth/factory';

describe('auth api adapters', () => {
  it('demo adapter returns demo session', async () => {
    const api = createDemoAuthAdapter();
    const res = await api.getSession();
    expect(res.data).toMatchObject({ user: { email: expect.any(String) } });
    expect(api.mode).toBe('demo');
  });

  it('demo adapter exposes login providers', async () => {
    const api = createDemoAuthAdapter();
    const r = await api.getLoginProviders({ isProd: false });
    expect(r.providers.some((p) => p.id === 'zero')).toBe(true);
  });

  it('hosted adapter marks login unavailable', async () => {
    const api = createHostedAuthAdapter();
    const r = await api.getLoginProviders({ isProd: false });
    expect(r.loadError).toBe('hosted_unavailable');
    expect(r.providers).toEqual([]);
  });
});

describe('getAuthApi with stubbed mode', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_PUBLIC_MAIL_API_MODE', 'demo');
    resetAuthApiCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAuthApiCache();
  });

  it('getAuthApi resolves demo', () => {
    expect(getAuthApi().mode).toBe('demo');
  });
});
