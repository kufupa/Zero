import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE_CACHE_MAX_AGE_SEC,
  SESSION_TTL_SEC,
  SESSION_UPDATE_AGE_SEC,
} from '../src/lib/auth';

describe('auth session TTL', () => {
  it('uses 400-day DB session lifetime', () => {
    expect(SESSION_TTL_SEC).toBe(60 * 60 * 24 * 400);
  });

  it('uses 1-hour signed cookie cache for DB revalidation', () => {
    expect(SESSION_COOKIE_CACHE_MAX_AGE_SEC).toBe(60 * 60);
  });

  it('slides session on 7-day activity', () => {
    expect(SESSION_UPDATE_AGE_SEC).toBe(60 * 60 * 24 * 7);
  });
});
