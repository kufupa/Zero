import { describe, expect, it } from 'vitest';
import { allocationTotal } from '../lib/quote-workflow/session';
import { loadQuoteFixture, quoteRequestKeys } from '../lib/quote-workflow/fixtures';

describe('quote workflow fixtures', () => {
  it('shares one quote request across same-date occupancy groups', () => {
    const fixture = loadQuoteFixture('mixed-same-dates');
    const keys = quoteRequestKeys(fixture);
    expect(fixture.groups.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(1);
    expect(fixture.groups.every((g) => g.arrivalDate === fixture.groups[0]?.arrivalDate)).toBe(true);
  });

  it('requires distinct quote requests for staggered dates', () => {
    const fixture = loadQuoteFixture('staggered-dates');
    const keys = quoteRequestKeys(fixture);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(1);
  });

  it('does not treat RO/BB alternatives as a combined booking total', () => {
    const fixture = loadQuoteFixture('ro-vs-bb');
    expect(fixture.offers.some((o) => o.kind === 'alternative')).toBe(true);
    expect(fixture.offers.some((o) => o.kind === 'allocation' && o.combinable === false)).toBe(false);
    const booked = allocationTotal(fixture.offers);
    const naive = fixture.offers.reduce((sum, o) => sum + o.stayTotalMinor, 0);
    expect(booked).toBeLessThan(naive);
    expect(fixture.offers.filter((o) => o.kind === 'alternative').every((o) => o.combinable === false)).toBe(
      true,
    );
  });

  it('expands varying nightly prices instead of a single average', () => {
    const fixture = loadQuoteFixture('varying-nights');
    const nights = fixture.offers[0]?.nightly ?? [];
    const amounts = new Set(nights.map((n) => n.amountMinor));
    expect(nights.length).toBeGreaterThan(1);
    expect(amounts.size).toBeGreaterThan(1);
  });

  it('marks attachment-dependent missing source without using filenames as bytes', () => {
    const fixture = loadQuoteFixture('attachment-dependent');
    expect(fixture.phase).toBe('missing_source');
    expect(fixture.missing?.length).toBeGreaterThan(0);
    expect(fixture.attachmentFilenamesOnly).toEqual(['rooming-list.pdf']);
  });

  it('keeps screenshot unavailable honest', () => {
    const fixture = loadQuoteFixture('public-single');
    const shot = fixture.offers[0]?.screenshot;
    expect(shot && 'unavailable' in shot && shot.unavailable).toBe(true);
  });
});
