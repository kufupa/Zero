import { describe, expect, it } from 'vitest';
import {
  assertScorableCandidate,
  filterEmailOwnCandidates,
  folioPayloadOk,
  stayIdRateAmongHits,
} from '../src/hms/leftover-score-gates.js';

describe('leftover-score-gates', () => {
  it('rejects softopen_ok_pool_rotate as scorable unique-email proof', () => {
    expect(assertScorableCandidate('softopen_ok_pool_rotate')).toBe(false);
    expect(assertScorableCandidate('email_own')).toBe(true);
    expect(assertScorableCandidate('email_own_softok')).toBe(true);
    expect(assertScorableCandidate('no_conf')).toBe(false);
  });

  it('allows explicitly labelled assisted inputs only in assisted mode', () => {
    expect(assertScorableCandidate('manual')).toBe(false);
    expect(assertScorableCandidate('manual', { allowAssisted: true })).toBe(true);
    expect(assertScorableCandidate('gold_derived', { allowAssisted: true })).toBe(true);
    expect(assertScorableCandidate('fallback', { allowAssisted: true })).toBe(true);
    expect(assertScorableCandidate('softopen_ok_pool_rotate', { allowAssisted: true })).toBe(false);
  });

  it('filters rotate rows out of email-own candidate list', () => {
    const kept = filterEmailOwnCandidates([
      { src: 'email_own_softok', id: 'a' },
      { src: 'softopen_ok_pool_rotate', id: 'b' },
      { src: 'email_own', id: 'c' },
    ]);
    expect(kept.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('computes stayIdRate among find hits only (not full corpus n)', () => {
    const rows = [
      { find: 'hit', stayId: true },
      { find: 'hit', stayId: true },
      { find: 'not_found', stayId: false },
      { find: 'not_found', stayId: false },
    ];
    // 2/2 hits have stayId — not 2/4 corpus
    expect(stayIdRateAmongHits(rows)).toBe(1);
    expect(stayIdRateAmongHits([{ find: 'hit', stayId: true }, { find: 'hit', stayId: false }])).toBe(
      0.5,
    );
    expect(stayIdRateAmongHits([{ find: 'not_found', stayId: false }])).toBe(0);
  });

  it('folioPayloadOk requires signed money + ISO-4217 currency', () => {
    expect(folioPayloadOk({ folioBalance: '12.00', currency: 'ZAR' })).toBe(true);
    expect(folioPayloadOk({ folioBalance: '-3.50', currency: 'USD' })).toBe(true);
    expect(folioPayloadOk({ folioBalance: null, currency: 'ZAR' })).toBe(false);
    expect(folioPayloadOk({ folioBalance: '12.00', currency: null })).toBe(false);
    expect(folioPayloadOk({ folioBalance: '12', currency: 'ZAR' })).toBe(false);
    expect(folioPayloadOk({ folioBalance: '12.00', currency: 'zar' })).toBe(false);
  });
});
