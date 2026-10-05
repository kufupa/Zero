import { describe, expect, it } from 'vitest';
import { previousScopeBeforeSwitch } from '../lib/mail/account-switch-cache';
import { idbCacheKeyForScope } from '../lib/mail/mail-cache-scope';
import { runLogoutCleanup } from '../lib/mail/query-cache-policy';

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

  it('clears previous mailbox idb cache key on account switch cleanup', async () => {
    const clearedKeys: string[] = [];
    const current = { userId: 'u1', activeTransportId: 't-old' };
    const previous = previousScopeBeforeSwitch({
      current,
      nextTransportId: 't-new',
    });
    const newScope = { userId: 'u1', activeTransportId: 't-new' };

    await runLogoutCleanup({
      queryClient: { clear: () => undefined },
      clearIdb: async () => {
        clearedKeys.push(idbCacheKeyForScope(previous));
      },
    });

    expect(clearedKeys).toEqual(['zero-query-cache-u1-t-old']);
    expect(clearedKeys[0]).not.toBe(idbCacheKeyForScope(newScope));
  });
});
