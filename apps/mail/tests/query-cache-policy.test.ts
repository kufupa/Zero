import { describe, expect, it, vi } from 'vitest';
import { makeLiveQueryHashPrefix, runLogoutCleanup } from '../lib/mail/query-cache-policy';

describe('query cache policy', () => {
  it('hashes live query keys with active mailbox context', () => {
    expect(makeLiveQueryHashPrefix({ userId: 'u1', activeTransportId: 't1' })).toEqual({
      userId: 'u1',
      activeTransportId: 't1',
    });
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
