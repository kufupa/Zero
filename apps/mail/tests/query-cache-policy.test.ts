import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  BOOTSTRAP_QUERY_HASH_PREFIX,
  makeLiveQueryHashPrefix,
  resolveQueryHashPrefix,
  runLogoutCleanup,
} from '../lib/mail/query-cache-policy';
import { getMailCacheScope, setMailCacheScope, subscribeMailCacheScope } from '../lib/mail/mail-cache-scope';

describe('query cache policy', () => {
  afterEach(() => {
    setMailCacheScope({ userId: null, activeTransportId: null });
  });
  it('hashes live query keys with active mailbox context', () => {
    expect(makeLiveQueryHashPrefix({ userId: 'u1', activeTransportId: 't1' })).toEqual({
      userId: 'u1',
      activeTransportId: 't1',
    });
  });

  it('uses one bootstrap prefix until mailbox scope is fully resolved', () => {
    expect(resolveQueryHashPrefix({ userId: null, activeTransportId: null })).toEqual(
      BOOTSTRAP_QUERY_HASH_PREFIX,
    );
    expect(resolveQueryHashPrefix({ userId: 'u1', activeTransportId: null })).toEqual(
      BOOTSTRAP_QUERY_HASH_PREFIX,
    );
    expect(resolveQueryHashPrefix({ userId: 'u1', activeTransportId: 't1' })).toEqual({
      userId: 'u1',
      activeTransportId: 't1',
    });
  });

  it('notifies scope subscribers when mailbox scope changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMailCacheScope(listener);
    setMailCacheScope({ userId: 'u1', activeTransportId: 't1' });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('keeps the same snapshot for an unchanged mailbox scope', () => {
    setMailCacheScope({ userId: 'u1', activeTransportId: 't1' });
    const scope = getMailCacheScope();
    setMailCacheScope({ userId: 'u1', activeTransportId: 't1' });
    expect(getMailCacheScope()).toBe(scope);
  });

  it('clears query cache and idb on logout', async () => {
    const fakeQueryClient = { clear: vi.fn() };
    const fakeClearIdb = vi.fn(async () => undefined);
    const cleared = await runLogoutCleanup({
      queryClient: fakeQueryClient,
      clearIdb: fakeClearIdb,
    });
    expect(cleared.queryClient).toBe(true);
    expect(cleared.idb).toBe(true);
    expect(fakeQueryClient.clear).toHaveBeenCalledOnce();
    expect(fakeClearIdb).toHaveBeenCalledOnce();
  });
});
