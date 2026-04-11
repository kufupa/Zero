import { describe, expect, it } from 'vitest';
import {
  FORCE_FRONTEND_ONLY_DEMO,
  isDemoMode,
  isFrontendOnlyDemo,
  isDemoFeatureEnabled,
} from '../lib/demo/runtime';

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
    if (FORCE_FRONTEND_ONLY_DEMO) {
      expect(isFrontendOnlyDemo({})).toBe(true);
      expect(
        isFrontendOnlyDemo({
          ZERO_DEMO_MODE: '1',
          VITE_FRONTEND_ONLY: '0',
        }),
      ).toBe(true);
      return;
    }
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
    expect(
      isFrontendOnlyDemo({
        ZERO_DEMO_MODE: '1',
        ZERO_DEMO_FRONTEND_ONLY: '1',
      }),
    ).toBe(true);
  });

  it('reads typed feature toggles safely', () => {
    expect(isDemoFeatureEnabled('showAiDraftPreview')).toBe(true);
  });
});
