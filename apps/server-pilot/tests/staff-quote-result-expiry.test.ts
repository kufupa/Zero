import { describe, expect, it } from 'vitest';
import { staffQuoteResultExpiry, staffQuoteResultReusable } from '../src/ai/hms-jobs.js';
import { PRICED_QUOTE_REUSE_MS } from '../src/quote-proposal/quote-revision.js';
import { assertReservationistResultFreshForAction } from '../src/ai/draft-approval.js';

const HOUR = 60 * 60_000;

describe('staffQuoteResultExpiry', () => {
  const now = new Date('2026-10-13T10:24:00.000Z');

  it('reuses a priced result for 24 h from the HMS observation', () => {
    expect(
      staffQuoteResultExpiry({ status: 'ready', asOf: '2026-10-13T10:24:00.000Z' }, now).toISOString(),
    ).toBe('2026-10-14T10:24:00.000Z');
    expect(PRICED_QUOTE_REUSE_MS).toBe(24 * HOUR);
  });

  it('keeps the 6-hour reuse for results without evidence', () => {
    expect(staffQuoteResultExpiry({ status: 'unavailable' }, now).toISOString()).toBe('2026-10-13T16:24:00.000Z');
  });
});

describe('staffQuoteResultReusable', () => {
  const now = new Date('2026-10-13T13:24:00.000Z');

  it('reuses a 3 h-old priced result and refuses a 25 h-old one', () => {
    expect(
      staffQuoteResultReusable({ status: 'ready', asOf: '2026-10-13T10:24:00.000Z' }, now),
    ).toBe(true);
    expect(
      staffQuoteResultReusable(
        { status: 'ready', asOf: '2026-10-12T12:24:00.000Z' },
        now,
      ),
    ).toBe(false);
  });

  it('never reuses a priced result stored without asOf or freshUntil', () => {
    expect(staffQuoteResultReusable({ status: 'ready' }, now)).toBe(false);
  });

  it('keeps reusing refusals and no-rate answers', () => {
    expect(staffQuoteResultReusable({ status: 'unavailable' }, now)).toBe(true);
  });
});

describe('priced quote PDF / approval', () => {
  it('accepts a 3 h-old offer whose sourceFreshness still covers 24 h', () => {
    const observedAt = '2026-10-13T10:24:00.000Z';
    const now = new Date('2026-10-13T13:24:00.000Z');
    expect(() =>
      assertReservationistResultFreshForAction(
        {
          version: 1,
          quoteRevisions: [
            {
              authorizationId: 'staff-quote:test',
              authoredDate: '2026-10-13',
              validity: { days: 3, anchor: 'authored_date', cutoff: 'unresolved' },
              groups: [{ sourceRef: 'native:quote' }],
              sourceFreshness: {
                authorizationId: 'staff-quote:test',
                sourceRefs: ['native:quote'],
                observedAt,
                expiresAt: new Date(Date.parse(observedAt) + PRICED_QUOTE_REUSE_MS).toISOString(),
                purpose: 'offer_source',
              },
            },
          ],
        },
        now,
      ),
    ).not.toThrow();
  });
});
