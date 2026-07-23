import { describe, expect, it } from 'vitest';
import {
  openThreadQueryPollingOptions,
  resolveThreadPollingMs,
} from '../lib/mail/thread-polling-policy';

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

  it('open thread detail polls at the same default interval as the list', () => {
    // Open thread used to only list-poll; replies stayed invisible until hard refresh.
    expect(openThreadQueryPollingOptions(undefined).refetchInterval).toBe(15_000);
    expect(openThreadQueryPollingOptions(undefined).refetchOnWindowFocus).toBe(true);
  });

  it('disables open-thread polling when interval is invalid', () => {
    expect(openThreadQueryPollingOptions('1000').refetchInterval).toBe(false);
  });
});
