import { describe, expect, it } from 'vitest';
import { resolveMailRouteFilter } from '../lib/mail/route-filter';
import { canUseNaturalLanguageSearch, PILOT_CAPABILITIES } from '../lib/pilot/capabilities';

describe('mail route filter contract', () => {
  it('maps hotel category slug to structured category filter', () => {
    const result = resolveMailRouteFilter(
      'travel-agents',
      new Map([['travel-agents', 'cat-travel']]),
    );
    expect(result).toEqual({
      folder: 'inbox',
      filters: { categoryIds: ['cat-travel'] },
    });
  });

  it('keeps system folders as folders', () => {
    const result = resolveMailRouteFilter('spam', new Map([['spam', 'cat-spam']]));
    expect(result).toEqual({ folder: 'spam', filters: {} });
  });
});

describe('pilot search capability gates', () => {
  it('disables natural language and Gmail grammar search', () => {
    expect(canUseNaturalLanguageSearch()).toBe(false);
    expect(PILOT_CAPABILITIES.gmailSearchGrammar).toBe(false);
  });
});
