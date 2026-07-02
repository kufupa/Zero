import { describe, expect, it } from 'vitest';
import {
  SESSION_TTL_SEC,
  SESSION_UPDATE_AGE_SEC,
} from '../src/lib/auth';

describe('auth session TTL', () => {
  it('uses 400-day session and cookie cache max age', () => {
    expect(SESSION_TTL_SEC).toBe(60 * 60 * 24 * 400);
  });

  it('slides session on 7-day activity', () => {
    expect(SESSION_UPDATE_AGE_SEC).toBe(60 * 60 * 24 * 7);
  });
});
