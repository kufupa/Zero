import { describe, expect, it } from 'vitest';
import {
  publicBackendPath,
  publicBackendTrpcUrl,
  resolvePublicBackendUrl,
} from '../lib/public-backend-url';

describe('resolvePublicBackendUrl', () => {
  it('treats explicit missing values as same-origin without reading Vite env', () => {
    expect(resolvePublicBackendUrl(undefined)).toBe('');
    expect(resolvePublicBackendUrl(null)).toBe('');
  });

  it('never stringifies undefined/null into a path segment', () => {
    expect(resolvePublicBackendUrl('undefined')).toBe('');
    expect(resolvePublicBackendUrl('null')).toBe('');
    expect(publicBackendTrpcUrl(undefined)).toBe('/api/trpc');
    expect(publicBackendTrpcUrl('undefined')).toBe('/api/trpc');
  });

  it('keeps explicit origins and strips trailing slashes', () => {
    expect(resolvePublicBackendUrl('https://nava.legacyhotels.co.za/')).toBe(
      'https://nava.legacyhotels.co.za',
    );
    expect(publicBackendTrpcUrl('https://nava.legacyhotels.co.za')).toBe(
      'https://nava.legacyhotels.co.za/api/trpc',
    );
    expect(publicBackendPath('/api/public/providers', '')).toBe(
      '/api/public/providers',
    );
  });
});

describe('deployed SPA must not bake undefined/api/trpc', () => {
  it('documents the concatenation footgun the helper prevents', () => {
    // Mirrors Vite's missing-env behavior: bare undefined coerces in +.
    const broken = (undefined as unknown as string) + '/api/trpc';
    expect(broken).toBe('undefined/api/trpc');
    expect(publicBackendTrpcUrl(undefined)).not.toBe(broken);
  });
});
