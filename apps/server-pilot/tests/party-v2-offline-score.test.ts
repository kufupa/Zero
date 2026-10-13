import {
  selectPartyV2FailureExamples,
  simulateHmsContains,
} from '../scripts/party-v2-offline-score.js';
import { describe, expect, it } from 'vitest';

describe('offline HMS contains simulator', () => {
  it('matches case-insensitive substrings in order and flags results beyond the cap', () => {
    const universe = [
      { kind: 'agency' as const, nativeId: 'a-1', name: 'Northwind Travel' },
      { kind: 'company' as const, nativeId: 'c-1', name: 'Windward Group' },
      { kind: 'company' as const, nativeId: 'c-2', name: 'Acme' },
    ];

    expect(simulateHmsContains(universe, 'WIND')).toEqual({
      rows: universe.slice(0, 2),
      truncated: false,
    });

    const crowded = Array.from({ length: 51 }, (_, index) => ({
      kind: 'company' as const,
      nativeId: `c-${index}`,
      name: `Acme ${index}`,
    }));
    const capped = simulateHmsContains(crowded, 'acme');
    expect(capped.rows).toHaveLength(50);
    expect(capped.truncated).toBe(true);
  });
});

describe('offline party-v2 failure examples', () => {
  it('reports unique abstentions and wrong binds, but omits correct binds', () => {
    const expected = { kind: 'agency' as const, name: 'Truth Travel' };
    const candidates = [
      {
        kind: 'agency' as const,
        name: 'Extracted Agency',
        source: 'extraction_agency' as const,
        strength: 'strong' as const,
      },
    ];
    const base = {
      testEmail: { domain: 'example.org', expected },
      candidates,
    };

    expect(
      selectPartyV2FailureExamples([
        { ...base, fallbackDecision: { boundParty: { ...expected, nativeId: 'truth-1' } } },
        { ...base, fallbackDecision: { boundParty: null } },
        { ...base, fallbackDecision: { boundParty: null } },
      ]),
    ).toEqual([
      {
        domain: 'example.org',
        extractedOrgName: 'Extracted Agency',
        truthName: 'Truth Travel',
      },
    ]);
  });
});
