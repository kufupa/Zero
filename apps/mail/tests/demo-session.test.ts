import { describe, expect, it } from 'vitest';
import { getDemoSession } from '../lib/demo/session';

describe('demo session', () => {
  it('returns a stable mock user payload', () => {
    const session = getDemoSession();

    expect(session.user.id).toBe('demo-user');
    expect(session.user.email).toBe('demo@centurion.local');
    expect(session.user.name).toBeTruthy();
  });

  it('marks the demo user as verified for stable settings flows', () => {
    const session = getDemoSession();

    expect(session.user.phoneNumberVerified).toBe(true);
  });
});
