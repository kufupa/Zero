import { describe, expect, it } from 'vitest';
import { shouldShowSupportLinks } from '../lib/demo/support-links';

describe('support links visibility', () => {
  it('hides support links in frontend-only demo mode', () => {
    expect(
      shouldShowSupportLinks({
        ZERO_DEMO_MODE: '1',
        VITE_FRONTEND_ONLY: '1',
      }),
    ).toBe(false);
  });

  it('hides support links when not in frontend-only demo mode', () => {
    expect(
      shouldShowSupportLinks({
        ZERO_DEMO_MODE: '1',
        VITE_FRONTEND_ONLY: '0',
      }),
    ).toBe(false);
  });

  it('hides support links outside demo mode', () => {
    expect(
      shouldShowSupportLinks({
        ZERO_DEMO_MODE: '0',
        VITE_FRONTEND_ONLY: '1',
      }),
    ).toBe(false);
  });

  it('hides support links on live pilot without support provider', () => {
    expect(
      shouldShowSupportLinks({
        ZERO_DEMO_MODE: '0',
        VITE_FRONTEND_ONLY: '0',
      }),
    ).toBe(false);
  });
});
