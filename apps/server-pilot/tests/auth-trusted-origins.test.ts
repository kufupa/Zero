import { describe, expect, it } from 'vitest';
import { resolvePilotTrustedOrigins } from '../src/lib/auth';

const CANONICAL_ORIGIN = 'https://nava.legacyhotels.co.za';
const LEGACY_ORIGIN = 'https://nava.legacy.local';

describe('resolvePilotTrustedOrigins', () => {
  it('derives the production origin from BETTER_AUTH_URL', () => {
    const origins = resolvePilotTrustedOrigins({
      BETTER_AUTH_URL: `${CANONICAL_ORIGIN}/`,
    });

    expect(origins).toContain(CANONICAL_ORIGIN);
    expect(origins).not.toContain(LEGACY_ORIGIN);
    expect(origins).toContain('https://127.0.0.1');
    expect(origins).toContain('http://localhost:3000');
  });

  it('merges deliberate extras and removes duplicates', () => {
    const origins = resolvePilotTrustedOrigins({
      BETTER_AUTH_URL: CANONICAL_ORIGIN,
      BETTER_AUTH_TRUSTED_ORIGINS:
        `${CANONICAL_ORIGIN}, https://extra.example, http://localhost:3000`,
    });

    expect(origins.filter((origin) => origin === CANONICAL_ORIGIN)).toHaveLength(1);
    expect(origins).toContain('https://extra.example');
    expect(origins.filter((origin) => origin === 'http://localhost:3000')).toHaveLength(1);
  });
});
