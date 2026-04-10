import { describe, expect, it } from 'vitest';
import {
  resolveDemoQueryPolicy,
  shouldHydratePersistedQueries,
  shouldInvalidateHydratedThreadQueries,
} from '../lib/demo/query-policy';

describe('demo query policy', () => {
  it('disables persisted query hydration in frontend-only demo mode', () => {
    expect(shouldHydratePersistedQueries(true)).toBe(false);
    expect(shouldHydratePersistedQueries(false)).toBe(true);
  });

  it('disables hydrated thread invalidation in frontend-only demo mode', () => {
    expect(shouldInvalidateHydratedThreadQueries(true)).toBe(false);
    expect(shouldInvalidateHydratedThreadQueries(false)).toBe(true);
  });

  it('resolves both decisions consistently from one input', () => {
    expect(resolveDemoQueryPolicy({ frontendOnlyDemo: true })).toEqual({
      shouldHydratePersistedQueries: false,
      shouldInvalidateHydratedThreadQueries: false,
    });

    expect(resolveDemoQueryPolicy({ frontendOnlyDemo: false })).toEqual({
      shouldHydratePersistedQueries: true,
      shouldInvalidateHydratedThreadQueries: true,
    });
  });
});
