import { describe, expect, it } from 'vitest';
import { orderCausalPreceding } from '../src/ai/quote-workflow-synced-selection.js';

describe('orderCausalPreceding', () => {
  it('keeps older same-thread mail before the selected message and drops later replies', () => {
    const selected = { id: 'mid', receivedAt: new Date('2026-10-05T12:00:00Z') };
    const preceding = orderCausalPreceding(selected, [
      { id: 'later', textBody: 'thanks, confirm', receivedAt: new Date('2026-10-05T15:00:00Z') },
      { id: 'mid', textBody: 'please quote', receivedAt: new Date('2026-10-05T12:00:00Z') },
      { id: 'older', textBody: 'original ask', receivedAt: new Date('2026-10-04T09:00:00Z') },
      { id: 'same-time', textBody: 'same-minute note', receivedAt: new Date('2026-10-05T12:00:00Z') },
      { id: 'undated', textBody: 'no clock', receivedAt: null },
    ]);
    expect(preceding.map((row) => row.bodyText)).toEqual(['original ask', 'same-minute note']);
  });

  it('does not invent causal order when the selected message has no receivedAt', () => {
    expect(
      orderCausalPreceding({ id: 'x', receivedAt: null }, [
        { id: 'older', textBody: 'ask', receivedAt: new Date('2026-10-04T09:00:00Z') },
      ]),
    ).toEqual([]);
  });
});
