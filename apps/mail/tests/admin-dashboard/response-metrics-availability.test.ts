import type { AdminDashboardMetrics } from '@/lib/admin-dashboard/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import * as React from 'react';

const { useQueryMock, useSessionMock, useTRPCMock, queryOptionsMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  useSessionMock: vi.fn(),
  useTRPCMock: vi.fn(),
  queryOptionsMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: useQueryMock,
}));
vi.mock('@/lib/auth-client', () => ({ useSession: useSessionMock }));
vi.mock('@/providers/query-provider', () => ({ useTRPC: useTRPCMock }));
vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));

const { useAdminDashboardDataMock, useAdminDashboardExportMock } = vi.hoisted(() => ({
  useAdminDashboardDataMock: vi.fn(),
  useAdminDashboardExportMock: vi.fn(),
}));

vi.mock('@/hooks/use-admin-dashboard', () => ({
  useAdminDashboardData: useAdminDashboardDataMock,
  useAdminDashboardExport: useAdminDashboardExportMock,
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
  transports: [
    { id: 'centurion', email: 'centurion@legacyhotels.co.za', displayName: 'Centurion Transport' },
  ],
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
    useAdminDashboardExportMock.mockReturnValue({
      isDownloading: false,
      isError: false,
      download: vi.fn(),
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

  it('adds a report version to the hosted dashboard cache key', async () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: 'viewer-1', email: 'navaai@legacyhotels.co.za' } },
      isLoading: false,
      isError: false,
    });
    queryOptionsMock.mockImplementation((input: unknown, options: Record<string, unknown>) => ({
      queryKey: ['adminDashboard', 'getMetrics', input],
      queryFn: vi.fn(),
      ...options,
    }));
    useTRPCMock.mockReturnValue({
      adminDashboard: { getMetrics: { queryOptions: queryOptionsMock } },
    });
    useQueryMock.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
    });

    const { useAdminDashboardData } = await vi.importActual<
      typeof import('../../hooks/use-admin-dashboard')
    >('../../hooks/use-admin-dashboard');
    function HookProbe() {
      useAdminDashboardData({ cohortId: 'centurion', window: '7d' });
      return null;
    }
    renderToStaticMarkup(createElement(HookProbe));

    const queryOptions = useQueryMock.mock.calls.at(-1)?.[0] as { queryKey?: unknown[] };
    expect(queryOptions.queryKey).toContain('executive-dashboard-v2');
  });
});
