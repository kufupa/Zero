import { describe, expect, it } from 'vitest';
import { resolveMailMode, isDemoMode, isFrontendOnlyDemo } from '../lib/runtime/mail-mode';

describe('mail mode resolver', () => {
  it('defaults to legacy', () => expect(resolveMailMode({})).toBe('legacy'));

  it('accepts canonical modes', () => {
    expect(resolveMailMode({ VITE_PUBLIC_MAIL_API_MODE: 'legacy' })).toBe('legacy');
    expect(resolveMailMode({ VITE_PUBLIC_MAIL_API_MODE: 'hosted' })).toBe('hosted');
    expect(resolveMailMode({ VITE_PUBLIC_MAIL_API_MODE: 'demo' })).toBe('demo');
  });

  it('ignores invalid explicit values', () => {
    expect(resolveMailMode({ VITE_PUBLIC_MAIL_API_MODE: 'ses' })).toBe('legacy');
  });

  it('does not accept removed hotel token (use hosted)', () => {
    expect(resolveMailMode({ VITE_PUBLIC_MAIL_API_MODE: 'hotel' })).toBe('legacy');
  });

  it('keeps compatibility only for VITE-prefixed old client flags', () => {
    expect(resolveMailMode({ VITE_ZERO_DEMO_MODE: '1' })).toBe('demo');
    expect(resolveMailMode({ VITE_FRONTEND_ONLY: '1' })).toBe('demo');
  });

  it('maps demo helpers to canonical demo mode', () => {
    expect(isDemoMode({ VITE_PUBLIC_MAIL_API_MODE: 'demo' })).toBe(true);
    expect(isFrontendOnlyDemo({ VITE_PUBLIC_MAIL_API_MODE: 'demo' })).toBe(true);
  });
});
