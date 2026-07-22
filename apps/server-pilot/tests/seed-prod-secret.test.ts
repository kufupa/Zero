import { describe, expect, it } from 'vitest';
import {
  mergePilotSecretPayload,
  replacePilotSecretPayload,
} from '../src/lib/pilot-secrets.js';

describe('seed-prod secret replace', () => {
  it('keeps only allowed emails and drops orphan personas', () => {
    const existing = {
      'manager@legacyhotel.com': { password: 'drop-me' },
      'nava-ops@legacyhotel.com': { password: 'drop-me-too' },
      'navaai@legacyhotels.co.za': { password: 'keep-me' },
    };
    const updates = {};
    expect(
      replacePilotSecretPayload(existing, ['navaai@legacyhotels.co.za'], updates),
    ).toEqual({
      'navaai@legacyhotels.co.za': { password: 'keep-me' },
    });
  });

  it('applies updates for new or rotated pilot emails', () => {
    const existing = {
      'manager@legacyhotel.com': { password: 'old-manager' },
    };
    const updates = {
      'navaai@legacyhotels.co.za': { password: 'new-pass' },
    };
    expect(
      replacePilotSecretPayload(existing, ['navaai@legacyhotels.co.za'], updates),
    ).toEqual({
      'navaai@legacyhotels.co.za': { password: 'new-pass' },
    });
  });
});

describe('seed-prod secret merge (legacy)', () => {
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
