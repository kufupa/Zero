import { describe, expect, it } from 'vitest';
import {
  isPoisonedStructuralArrayOverride,
  partySelectNativeRequiresMatchingName,
  resolveQuoteGroupEntityId,
} from '../src/ai/reservation-workflow-v2-draft-commands.js';

/**
 * P4/P5 polish proofs against previously-failing S4 workItemIds
 * (Pass4/Pass6 org blockers + remove_quote_group invalid_value).
 */
const FORMER_P4 = [
  '7940e9dc-36d9-407b-8f32-4164854d1085', // organization_unknown_staff_value
  '65c27686-ecde-4a7e-9dd9-6ea9d25a9472', // organization_selection_required
  'e497761d-9124-45fe-94cd-ab4a4377833d', // organization_name_unresolved
] as const;

const FORMER_P5 = [
  '5e7e2c46-c420-4a09-8b52-3b4a6a794f63', // remove_quote_group_invalid_value → still_multi_group
  '12dd7e59-a143-4425-a046-6eb1cc9d053c', // remove_quote_group_invalid_value (6 groups)
] as const;

describe('P4 quote party selectNative + focus', () => {
  it('lets Quote selectNative replace poisoned/cleared names (no typed-name gate)', () => {
    for (const id of FORMER_P4) {
      expect(partySelectNativeRequiresMatchingName('quote', false), id).toBe(false);
    }
    expect(partySelectNativeRequiresMatchingName('create', false)).toBe(true);
    expect(partySelectNativeRequiresMatchingName('quote', true)).toBe(true);
  });
});

describe('P5 remove_quote_group collapse', () => {
  it('discards poisoned whole-array group overrides that caused invalid_value', () => {
    for (const id of FORMER_P5) {
      expect(isPoisonedStructuralArrayOverride({ state: 'clear', updatedAt: 't' } as never), id).toBe(true);
      expect(isPoisonedStructuralArrayOverride({ state: 'unknown', updatedAt: 't' } as never), id).toBe(true);
      expect(isPoisonedStructuralArrayOverride({ state: 'set', value: 'not-array' }), id).toBe(true);
      expect(isPoisonedStructuralArrayOverride({ state: 'set', value: [{ id: 'g1' }] }), id).toBe(false);
      expect(isPoisonedStructuralArrayOverride(undefined), id).toBe(false);
    }
  });

  it('resolves group entity by id or index so multi-group drafts collapse', () => {
    const groups = [{ id: 'keep-a' }, { id: 'drop-b' }, { id: 'drop-c' }];
    expect(resolveQuoteGroupEntityId(groups, 'drop-b')).toBe('drop-b');
    expect(resolveQuoteGroupEntityId(groups, '1')).toBe('drop-b');
    expect(resolveQuoteGroupEntityId(groups, '2')).toBe('drop-c');
    expect(resolveQuoteGroupEntityId(groups, 'missing')).toBe(null);
    // Simulate collapsing 5e7e2c46 (2 groups) and 12dd7e59 (6 groups) to one.
    let two = [{ id: 'g0' }, { id: 'g1' }];
    while (two.length > 1) {
      const drop = resolveQuoteGroupEntityId(two, String(two.length - 1));
      expect(drop).toBeTruthy();
      two = two.filter((row) => row.id !== drop);
    }
    expect(two).toEqual([{ id: 'g0' }]);
    let six = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}` }));
    while (six.length > 1) {
      const drop = resolveQuoteGroupEntityId(six, String(six.length - 1));
      six = six.filter((row) => row.id !== drop);
    }
    expect(six).toEqual([{ id: 'g0' }]);
  });
});
