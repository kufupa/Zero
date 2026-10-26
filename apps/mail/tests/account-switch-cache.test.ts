import { describe, expect, it, vi } from 'vitest';
import {
  previousScopeBeforeSwitch,
  runAccountSwitchCacheCleanup,
} from '../lib/mail/account-switch-cache';
import { idbCacheKeyForScope } from '../lib/mail/mail-cache-scope';

describe('account switch cache', () => {
  it('captures previous scope before switch', () => {
    const current = { userId: 'u1', activeTransportId: 't-old' };
    const previous = previousScopeBeforeSwitch({
      current,
      nextTransportId: 't-new',
    });
    expect(previous).toEqual({ userId: 'u1', activeTransportId: 't-old' });
    expect(previous).not.toBe(current);
  });

  it('previous scope idb key differs from new scope', () => {
    const current = { userId: 'u1', activeTransportId: 't-old' };
    const previous = previousScopeBeforeSwitch({
      current,
      nextTransportId: 't-new',
    });
    const newScope = { userId: 'u1', activeTransportId: 't-new' };
    expect(idbCacheKeyForScope(previous)).not.toBe(idbCacheKeyForScope(newScope));
    expect(idbCacheKeyForScope(previous)).toBe('zero-query-cache-u1-t-old');
    expect(idbCacheKeyForScope(newScope)).toBe('zero-query-cache-u1-t-new');
  });

  it('clears previous mailbox idb cache key and react query cache on account switch cleanup', async () => {
    const current = { userId: 'u1', activeTransportId: 't-old' };
    const previous = previousScopeBeforeSwitch({
      current,
      nextTransportId: 't-new',
    });
    const newScope = { userId: 'u1', activeTransportId: 't-new' };
    const deleteIdbKey = vi.fn(async (_key: string) => undefined);
    const queryClient = { clear: vi.fn() };

    await runAccountSwitchCacheCleanup({
      previousScope: previous,
      queryClient,
      deleteIdbKey,
    });

    expect(queryClient.clear).toHaveBeenCalledOnce();
    expect(deleteIdbKey).toHaveBeenCalledOnce();
    expect(deleteIdbKey).toHaveBeenCalledWith('zero-query-cache-u1-t-old');
    expect(deleteIdbKey.mock.calls[0][0]).not.toBe(idbCacheKeyForScope(newScope));
  });
});
