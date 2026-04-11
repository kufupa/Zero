import { describe, expect, it } from 'vitest';
import { shouldShowSupportLinks } from '../lib/demo/support-links';
import { FORCE_FRONTEND_ONLY_DEMO } from '../lib/demo/runtime';

describe('support links visibility', () => {
  it('hides support links in frontend-only demo mode', () => {
    expect(
      shouldShowSupportLinks({
        ZERO_DEMO_MODE: '1',
        VITE_FRONTEND_ONLY: '1',
      }),
    ).toBe(false);
  });

  it('shows support links when not in frontend-only demo mode', () => {
    if (FORCE_FRONTEND_ONLY_DEMO) {
      expect(
        shouldShowSupportLinks({
          ZERO_DEMO_MODE: '1',
          VITE_FRONTEND_ONLY: '0',
        }),
      ).toBe(false);
      return;
    }
    expect(
      shouldShowSupportLinks({
        ZERO_DEMO_MODE: '1',
        VITE_FRONTEND_ONLY: '0',
      }),
    ).toBe(true);
  });

  it('shows support links outside demo mode', () => {
    if (FORCE_FRONTEND_ONLY_DEMO) {
      expect(
        shouldShowSupportLinks({
          ZERO_DEMO_MODE: '0',
          VITE_FRONTEND_ONLY: '1',
        }),
      ).toBe(false);
      return;
    }
    expect(
      shouldShowSupportLinks({
        ZERO_DEMO_MODE: '0',
        VITE_FRONTEND_ONLY: '1',
      }),
    ).toBe(true);
  });
});
