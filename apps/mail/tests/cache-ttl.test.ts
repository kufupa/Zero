import { describe, expect, it } from 'vitest';
import { PERSIST_MAX_AGE, QUERY_GC_TIME } from '../lib/mail/cache-ttl';

describe('cache-ttl constants', () => {
  it('disables persist max-age eviction', () => {
    expect(PERSIST_MAX_AGE).toBe(Infinity);
  });

  it('disables query gc-time eviction', () => {
    expect(QUERY_GC_TIME).toBe(Infinity);
  });
});
