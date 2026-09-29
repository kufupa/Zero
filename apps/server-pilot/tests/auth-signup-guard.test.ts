import { describe, expect, it } from 'vitest';
import { APIError } from 'better-auth/api';
import {
  assertPilotSignupAllowed,
  isPilotSignupEmailAllowed,
  parsePilotSignupAllowlist,
} from '../src/lib/auth.js';

describe('parsePilotSignupAllowlist', () => {
  it('returns empty array when unset', () => {
    expect(parsePilotSignupAllowlist(undefined)).toEqual([]);
    expect(parsePilotSignupAllowlist('')).toEqual([]);
    expect(parsePilotSignupAllowlist('   ')).toEqual([]);
  });

  it('normalizes comma-separated emails', () => {
    expect(
      parsePilotSignupAllowlist(' Admin@Hotel.com , guest@hotel.com , '),
    ).toEqual(['admin@hotel.com', 'guest@hotel.com']);
  });
});

describe('isPilotSignupEmailAllowed', () => {
  it('allows any email when PILOT_OPEN_SIGNUP=1', () => {
    expect(
      isPilotSignupEmailAllowed('anyone@example.com', {
        PILOT_OPEN_SIGNUP: '1',
      }),
    ).toBe(true);
  });

  it('blocks unknown emails when signup closed', () => {
    expect(
      isPilotSignupEmailAllowed('stranger@example.com', {
        PILOT_OPEN_SIGNUP: '0',
      }),
    ).toBe(false);
  });

  it('blocks leftover allowlisted emails when PILOT_OPEN_SIGNUP=0', () => {
    const env = {
      PILOT_OPEN_SIGNUP: '0',
      PILOT_SIGNUP_ALLOWLIST: 'Manager@Hotel.com, guest@hotel.com',
    };
    expect(isPilotSignupEmailAllowed('manager@hotel.com', env)).toBe(false);
    expect(isPilotSignupEmailAllowed('guest@hotel.com', env)).toBe(false);
    expect(isPilotSignupEmailAllowed('other@hotel.com', env)).toBe(false);
    expect(() => assertPilotSignupAllowed('manager@hotel.com', env)).toThrow(APIError);
  });

  it('retains deliberate allowlist opt-in when open-signup flag is unset', () => {
    expect(isPilotSignupEmailAllowed('MANAGER@hotel.com', {
      PILOT_SIGNUP_ALLOWLIST: 'manager@hotel.com',
    })).toBe(true);
    expect(isPilotSignupEmailAllowed('other@hotel.com', {
      PILOT_SIGNUP_ALLOWLIST: 'manager@hotel.com',
    })).toBe(false);
  });

  it('rejects missing email when signup closed', () => {
    expect(isPilotSignupEmailAllowed(undefined, { PILOT_OPEN_SIGNUP: '0' })).toBe(
      false,
    );
  });
});

describe('assertPilotSignupAllowed', () => {
  it('throws FORBIDDEN when signup is blocked', () => {
    expect(() =>
      assertPilotSignupAllowed('stranger@example.com', {
        PILOT_OPEN_SIGNUP: '0',
      }),
    ).toThrow(APIError);

    try {
      assertPilotSignupAllowed('stranger@example.com', {
        PILOT_OPEN_SIGNUP: '0',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect((error as APIError).message).toBe('signup disabled for pilot');
    }
  });
});
