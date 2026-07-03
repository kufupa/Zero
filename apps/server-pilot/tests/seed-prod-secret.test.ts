import { describe, expect, it } from 'vitest';
import { mergePilotSecretPayload } from '../src/lib/pilot-secrets.js';

describe('seed-prod secret merge', () => {
  it('preserves unrelated users when seeding one new pilot', () => {
    const existing = {
      'legacy@hotel.com': { password: 'keep-me' },
      'other@hotel.com': { password: 'also-keep' },
    };
    const updates = {
      'new@hotel.com': { password: 'new-pass' },
    };
    expect(mergePilotSecretPayload(existing, updates)).toEqual({
      'legacy@hotel.com': { password: 'keep-me' },
      'other@hotel.com': { password: 'also-keep' },
      'new@hotel.com': { password: 'new-pass' },
    });
  });

  it('overwrites rotated credentials for same email', () => {
    const existing = { 'a@x.com': { password: 'old' } };
    const updates = { 'a@x.com': { password: 'new' } };
    expect(mergePilotSecretPayload(existing, updates)).toEqual({
      'a@x.com': { password: 'new' },
    });
  });
});
