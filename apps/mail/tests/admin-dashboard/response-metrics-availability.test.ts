import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

const { useQueryMock, useSessionMock, useTRPCMock, queryOptionsMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(), useSessionMock: vi.fn(), useTRPCMock: vi.fn(), queryOptionsMock: vi.fn(),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()), useQuery: useQueryMock,
}));
vi.mock('@/lib/auth-client', () => ({ useSession: useSessionMock }));
vi.mock('@/providers/query-provider', () => ({ useTRPC: useTRPCMock }));
vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));

describe('admin dashboard report cache', () => {
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
    expect(queryOptions.queryKey).toContain('executive-dashboard-v3-shadow-scorecard');
  });
});
