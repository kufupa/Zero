import { describe, expect, it } from 'vitest';

/** Pure helper — extract from auth.ts for unit test without booting betterAuth DB */
import { resolvePilotTrustedOrigins } from '../src/lib/auth';

describe('resolvePilotTrustedOrigins', () => {
  it('includes nava.legacy.local and 127.0.0.1 by default', () => {
    const origins = resolvePilotTrustedOrigins({});
    expect(origins).toContain('https://nava.legacy.local');
    expect(origins).toContain('https://127.0.0.1');
  });

  it('merges BETTER_AUTH_TRUSTED_ORIGINS CSV', () => {
    const origins = resolvePilotTrustedOrigins({
      BETTER_AUTH_TRUSTED_ORIGINS: 'https://extra.example, http://localhost:3000',
    });
    expect(origins).toContain('https://extra.example');
    expect(origins).toContain('http://localhost:3000');
  });
});
