import { describe, expect, it } from 'vitest';
import { orderMessagesNewestFirst } from '../lib/mail/thread-display-order';

describe('orderMessagesNewestFirst', () => {
  it('reverses API-asc messages to newest-first', () => {
    const ordered = orderMessagesNewestFirst([
      { id: 'old' },
      { id: 'mid' },
      { id: 'new' },
    ]);
    expect(ordered.map((m) => m.id)).toEqual(['new', 'mid', 'old']);
  });

  it('returns a new array and does not mutate input', () => {
    const input = [{ id: 'a' }, { id: 'b' }];
    const out = orderMessagesNewestFirst(input);
    expect(out).not.toBe(input);
    expect(input.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('handles empty and single', () => {
    expect(orderMessagesNewestFirst([])).toEqual([]);
    expect(orderMessagesNewestFirst([{ id: 'only' }])).toEqual([{ id: 'only' }]);
  });
});
