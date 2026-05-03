import { describe, expect, it } from 'vitest';
import { shouldShowSupportLinks } from '../lib/demo/support-links';

describe('support links visibility', () => {
  it('hides support links in demo mode', () => {
    expect(
      shouldShowSupportLinks({
        VITE_PUBLIC_MAIL_API_MODE: 'demo',
      }),
    ).toBe(false);
  });

  it('shows support links in legacy mode', () => {
    expect(
      shouldShowSupportLinks({
        VITE_PUBLIC_MAIL_API_MODE: 'legacy',
      }),
    ).toBe(true);
  });

  it('shows support links in hosted mode', () => {
    expect(
      shouldShowSupportLinks({
        VITE_PUBLIC_MAIL_API_MODE: 'hosted',
      }),
    ).toBe(true);
  });
});
