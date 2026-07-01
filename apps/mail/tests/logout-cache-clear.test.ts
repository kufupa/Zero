import { describe, expect, it, vi } from 'vitest';
import { runLogoutCleanup } from '../lib/mail/query-cache-policy';

describe('logout cache clear', () => {
  it('clears query client and indexeddb persister', async () => {
    const queryClient = { clear: vi.fn() };
    const clearIdb = vi.fn(async () => undefined);
    const result = await runLogoutCleanup({ queryClient, clearIdb });
    expect(result).toEqual({ queryClient: true, idb: true });
    expect(queryClient.clear).toHaveBeenCalledOnce();
    expect(clearIdb).toHaveBeenCalledOnce();
  });
});
