import { buildDashboard } from '../src/ops/nava-fte-dashboard';
import { renderDashboardSections } from '../src/ops/nava-fte-dashboard-view';
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

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('nava-fte-dashboard-view', () => {
  it('paints Nava chrome, Hermes sections, and no fake money', () => {
    const view = renderDashboardSections(buildDashboard(hours));
    const header = stripAnsi(view.header);
    expect(header).toContain('NAVA');
    expect(header).toMatch(/[█]{12,}/);
    expect(header.split('\n')[0]!.startsWith('██   ██')).toBe(true);
    expect(view.meta).toContain('asOf 2026-08-25');
    const board = stripAnsi([view.header, view.meta, ...view.sections, view.footer].join('\n'));
    expect(board).toContain('stay-human-at-risk');
    expect(board).toContain('security_quarantine');
    expect(board).toContain(NAVA_HOURS_CAVEAT);
    expect(board).toContain('live=false');
    expect(board).not.toContain('FTE hours saved');
    expect(board).not.toContain('£');
    expect(view.footer).toContain('Enter continue');
    expect(view.footer).not.toContain('Gemini');
    expect(view.footer).toContain('q quit');
  });
});
