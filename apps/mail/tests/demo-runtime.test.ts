import { describe, expect, it } from 'vitest';
import {
  FORCE_FRONTEND_ONLY_DEMO,
  isDemoMode,
  isFrontendOnlyDemo,
  isDemoFeatureEnabled,
  resolveMailMode,
} from '../lib/demo/runtime';

describe('demo runtime', () => {
  it('does not force frontend-only demo via constant', () => {
    expect(FORCE_FRONTEND_ONLY_DEMO).toBe(false);
  });

  it('treats canonical demo mode as demo', () => {
    expect(isDemoMode({ VITE_PUBLIC_MAIL_API_MODE: 'demo' })).toBe(true);
    expect(isDemoMode({ VITE_PUBLIC_MAIL_API_MODE: 'legacy' })).toBe(false);
  });

  it('treats VITE compatibility flags as demo via resolver', () => {
    expect(resolveMailMode({ VITE_ZERO_DEMO_MODE: '1' })).toBe('demo');
    expect(resolveMailMode({ VITE_FRONTEND_ONLY: '1' })).toBe('demo');
  });

  it('treats frontend-only demo when mode is demo', () => {
    expect(isFrontendOnlyDemo({ VITE_PUBLIC_MAIL_API_MODE: 'demo' })).toBe(true);
    expect(
      isFrontendOnlyDemo({
        VITE_PUBLIC_MAIL_API_MODE: 'legacy',
      }),
    ).toBe(false);
  });

  it('reads typed feature toggles safely', () => {
    expect(isDemoFeatureEnabled('showAiDraftPreview')).toBe(true);
  });
});
