import { describe, expect, it } from 'vitest';
import { oldestMailOr, onboardingBounds } from '../src/outlook-sync/service.js';

function fakeDb(oldest: Date | null) {
  const chain = { from: () => chain, where: async () => [{ oldest }] };
  return { select: () => chain } as never;
}

describe('outlook history anchors on the oldest mail already held', () => {
  const now = new Date('2026-10-22T10:00:00Z');

  it('starts one month before the oldest server-synced mail', async () => {
    const anchor = await oldestMailOr(fakeDb(new Date('2026-10-08T06:00:00Z')), 't1', now);
    expect(anchor.toISOString()).toBe('2026-10-08T06:00:00.000Z');
    expect(onboardingBounds(anchor).historyFrom.toISOString()).toBe('2026-09-08T06:00:00.000Z');
  });

  it('falls back to now for an empty mailbox', async () => {
    expect((await oldestMailOr(fakeDb(null), 't1', now)).toISOString()).toBe(now.toISOString());
  });

  it('never anchors in the future', async () => {
    const later = new Date('2026-11-01T00:00:00Z');
    expect((await oldestMailOr(fakeDb(later), 't1', now)).toISOString()).toBe(now.toISOString());
  });
});
