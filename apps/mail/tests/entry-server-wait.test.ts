import { describe, expect, it } from 'vitest';
import { shouldWaitForAllReady } from '../lib/demo/entry-server';

describe('entry server allReady guard', () => {
  it('skips allReady waiting in frontend-only demo mode', () => {
    expect(
      shouldWaitForAllReady({
        userAgent: 'Mozilla/5.0',
        isSpaMode: true,
        env: { ZERO_DEMO_MODE: '1', VITE_FRONTEND_ONLY: '1' },
      }),
    ).toBe(false);
  });

  it('still waits for bots in non-demo mode', () => {
    expect(
      shouldWaitForAllReady({
        userAgent: 'Googlebot',
        isSpaMode: false,
        env: { ZERO_DEMO_MODE: '0', VITE_FRONTEND_ONLY: '0' },
      }),
    ).toBe(true);
  });
});
