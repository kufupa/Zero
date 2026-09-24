import { describe, expect, it } from 'vitest';
import { resolveThreadListErrorView } from '../lib/mail/thread-list-error';

describe('resolveThreadListErrorView', () => {
  it('does not call session failures a search outage', () => {
    const view = resolveThreadListErrorView({ message: 'no session' }, true);
    expect(view.isSessionError).toBe(true);
    expect(view.message).toMatch(/session expired/i);
    expect(view.message.toLowerCase()).not.toContain('search');
  });

  it('keeps search copy only for non-auth list failures with an active query', () => {
    const withSearch = resolveThreadListErrorView(new Error('request failed'), true);
    expect(withSearch.message).toContain('Unable to load search results');
    expect(withSearch.retryLabel).toBe('Retry search');

    const idle = resolveThreadListErrorView(new Error('request failed'), false);
    expect(idle.message).toContain('Unable to load mail');
    expect(idle.retryLabel).toBe('Retry');
  });
});
