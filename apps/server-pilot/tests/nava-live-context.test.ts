import { buildDashboard } from '../src/ops/nava-fte-dashboard';
import { extractHermesSessionId } from '../src/ops/nava-hermes-bridge';
import { hermesSeedPrompt, buildNavaLiveContext } from '../src/ops/nava-live-context';
import { NAVA_HOURS_CAVEAT, type NavaHoursStats } from '../src/ops/nava-fte-hours';
import { describe, expect, it } from 'vitest';

const hours: NavaHoursStats = {
  asOf: '2026-08-25T22:24:55.657Z',
  threadCount: 2403,
  threadsWithOutbound: 301,
  inboundOnlyThreads: 2102,
  nEligibleFirstResponse: 77,
  medianFirstResponseMinutes: 42,
  p90FirstResponseMinutes: 180,
  droppedNegativeOrMissing: 3,
  caveat: NAVA_HOURS_CAVEAT,
};

describe('nava-live-context', () => {
  it('packs dashboard facts as Nava briefing without Hermes brand', () => {
    const ctx = buildNavaLiveContext(buildDashboard(hours));
    expect(ctx).toContain('You are Nava');
    expect(ctx).toContain('security_quarantine');
    expect(ctx).toContain('1134');
    expect(ctx).toContain('Never say you are Hermes');
    expect(ctx).toContain('1015');
    expect(ctx).toContain('tool-relevance');
    expect(ctx).toContain('.private/connected-mailbox-corpus');
    const seed = hermesSeedPrompt(buildDashboard(hours));
    expect(seed).toContain('NAVA_LIVE_OK');
    expect(seed).not.toMatch(/investor/i);
    expect(ctx).not.toMatch(/investor/i);
  });

  it('parses hermes session id from stderr', () => {
    expect(extractHermesSessionId('session_id: abc123\n', '')).toBe('abc123');
  });
});
