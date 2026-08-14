import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminDashboardMetrics } from '@/lib/admin-dashboard/types';

const { useAdminDashboardDataMock } = vi.hoisted(() => ({
  useAdminDashboardDataMock: vi.fn(),
}));

vi.mock('@/hooks/use-admin-dashboard', () => ({
  useAdminDashboardData: useAdminDashboardDataMock,
}));

import AdminDashboardPage from '@/app/(routes)/settings/admin-dashboard/page';

const metrics: AdminDashboardMetrics = {
  inboundVolume: { availability: 'live', value: 509 },
  medianFirstResponseMinutes: { availability: 'live', value: 6 },
  p90FirstResponseMinutes: { availability: 'live', value: 6 },
  answeredWithin3hPercent: { availability: 'live', value: 0.3 },
  draftCreationMinutes: { availability: 'unavailable', value: null },
  aiAssistedSendRate: { availability: 'unavailable', value: null },
  medianEditDistance: { availability: 'unavailable', value: null },
  totalRevenue: { availability: 'coming_soon', value: null },
  eligibleThreadCount: 380,
  unansweredEligible: 379,
  inboundPerDay: [{ period: '2026-08-12', byTransport: { centurion: 509 } }],
  comparison: [
    {
      transportId: 'centurion',
      label: 'Centurion Transport',
      inbound: 509,
      answeredWithin3hPercent: 0.3,
      drafted: null,
    },
  ],
  perTransport: [
    {
      transportId: 'centurion',
      label: 'Centurion Transport',
      inbound: 509,
      latenciesMinutes: [6],
      unanswered: 379,
    },
  ],
  transports: [{ id: 'centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion Transport' }],
  assumptions: [],
  footnote: 'Baseline from Centurion ingest.',
  windowStart: '2026-08-05T00:00:00.000Z',
  windowEnd: '2026-08-12T00:00:00.000Z',
};

describe('AdminDashboardPage response metric availability', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React);
    useAdminDashboardDataMock.mockReturnValue({
      canAccess: true,
      isLoading: false,
      isError: false,
      source: 'hosted',
      data: null,
      metrics,
    });
  });

  it('withholds unvalidated response metrics and comparison data', () => {
    const markup = renderToStaticMarkup(createElement(AdminDashboardPage));

    expect(markup).toContain('Response metrics temporarily unavailable');
    expect(markup).toContain('Response comparison temporarily unavailable');
    expect(markup).not.toContain('p90 6m');
    expect(markup).not.toContain('0.3%');
    expect(markup).not.toContain('379 unanswered');
  });
});
