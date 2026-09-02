import {
  NAVA_FROZEN_MIX_TOTAL,
  buildDashboard,
  mixTotal,
  renderDashboardMarkdown,
} from '../src/ops/nava-fte-dashboard';
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

describe('nava-fte-dashboard', () => {
  it('mix rows sum to 2957', () => {
    expect(mixTotal(buildDashboard(hours).mix)).toBe(NAVA_FROZEN_MIX_TOTAL);
    expect(buildDashboard(hours).mixTotal).toBe(2957);
  });

  it('interpolates hours.json KPIs and keeps census inbound-only line', () => {
    const dashboard = buildDashboard(hours);
    expect(dashboard.hours.nEligibleFirstResponse).toBe(77);
    expect(dashboard.hours.medianFirstResponseMinutes).toBe(42);
    expect(dashboard.inboundOnlyDisplay.inboundOnlyThreads).toBe(2102);
    expect(dashboard.inboundOnlyDrift).toBe(false);
  });

  it('flags inbound-only drift without dropping the census line', () => {
    const dashboard = buildDashboard({ ...hours, inboundOnlyThreads: 1999 });
    expect(dashboard.inboundOnlyDrift).toBe(true);
    expect(dashboard.inboundOnlyDisplay.inboundOnlyThreads).toBe(2102);
    expect(renderDashboardMarkdown(dashboard)).toContain('1999');
  });

  it('marks every ranked tool live=false shadow=false', () => {
    const dashboard = buildDashboard(hours);
    expect(dashboard.tools.every((row) => row.live === false && row.shadow === false)).toBe(
      true,
    );
    const markdown = renderDashboardMarkdown(dashboard);
    expect(markdown).toContain('live=false shadow=false');
    expect(markdown).toContain('bookable=false');
    expect(markdown).toContain(NAVA_HOURS_CAVEAT);
    expect(markdown).not.toContain('£');
  });

  it('includes harmonized source families summing to 2403', () => {
    const dashboard = buildDashboard(hours);
    expect(dashboard.sourceFamilies.reduce((sum, row) => sum + row.threads, 0)).toBe(2403);
    expect(renderDashboardMarkdown(dashboard)).toContain('security_quarantine');
  });
});