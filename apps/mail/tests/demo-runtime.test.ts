import { describe, expect, it } from 'vitest';
import { isDemoMode, isFrontendOnlyDemo, isDemoFeatureEnabled } from '../lib/demo/runtime';

describe('demo runtime', () => {
  it('treats ZERO_DEMO_MODE=1 as demo mode', () => {
    expect(isDemoMode({ ZERO_DEMO_MODE: '1' })).toBe(true);
    expect(isDemoMode({ ZERO_DEMO_MODE: '0' })).toBe(false);
  });

  it('falls back to VITE_ZERO_DEMO_MODE when ZERO_DEMO_MODE is unset', () => {
    expect(isDemoMode({ VITE_ZERO_DEMO_MODE: '1' })).toBe(true);
    expect(isDemoMode({ VITE_ZERO_DEMO_MODE: '0' })).toBe(false);
    expect(isDemoMode({})).toBe(false);
  });

  it('requires both demo + frontend-only to hard disconnect backend', () => {
    expect(
      isFrontendOnlyDemo({
        ZERO_DEMO_MODE: '1',
        VITE_FRONTEND_ONLY: '1',
      }),
    ).toBe(true);
    expect(
      isFrontendOnlyDemo({
        ZERO_DEMO_MODE: '1',
        VITE_FRONTEND_ONLY: '0',
      }),
    ).toBe(false);
  });

  it('reads typed feature toggles safely', () => {
    expect(isDemoFeatureEnabled('showAiDraftPreview')).toBe(true);
  });
});
