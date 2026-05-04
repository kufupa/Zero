import { describe, expect, it } from 'vitest';
import { shouldWaitForAllReady } from '../lib/demo/entry-server';

describe('entry server allReady guard', () => {
  it('skips allReady waiting in demo mode', () => {
    expect(
      shouldWaitForAllReady({
        userAgent: 'Mozilla/5.0',
        isSpaMode: true,
        env: { VITE_PUBLIC_MAIL_API_MODE: 'demo' },
      }),
    ).toBe(false);
  });

  it('still waits for bots in non-demo mode', () => {
    expect(
      shouldWaitForAllReady({
        userAgent: 'Googlebot',
        isSpaMode: false,
        env: { VITE_PUBLIC_MAIL_API_MODE: 'legacy' },
      }),
    ).toBe(true);
  });
});
