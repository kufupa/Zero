import { describe, expect, it } from 'vitest';
import { resolveThreadPollingMs } from '../lib/mail/thread-polling-policy';

describe('thread polling policy', () => {
  it('uses configured foreground interval', () => {
    expect(resolveThreadPollingMs('30000')).toBe(30000);
  });

  it('defaults to 15000 when unset', () => {
    expect(resolveThreadPollingMs(undefined)).toBe(15000);
  });

  it('rejects below 15s', () => {
    expect(resolveThreadPollingMs('1000')).toBe(null);
  });
});
