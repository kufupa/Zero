import { describe, expect, it } from 'vitest';
import { resolveThreadPollingMs } from '../lib/mail/thread-polling-policy';

describe('thread polling policy', () => {
  it('uses configured foreground interval', () => {
    expect(resolveThreadPollingMs('30000')).toBe(30000);
  });

  it('disables invalid or too-low intervals', () => {
    expect(resolveThreadPollingMs('1000')).toBe(null);
    expect(resolveThreadPollingMs(undefined)).toBe(null);
  });
});
