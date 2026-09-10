import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';

const { useSessionMock, useTRPCMock, queryOptionsMock, queryFnMock, downloadMock, cacheScope } =
  vi.hoisted(() => ({
    useSessionMock: vi.fn(),
    useTRPCMock: vi.fn(),
    queryOptionsMock: vi.fn(),
    queryFnMock: vi.fn(),
    downloadMock: vi.fn(),
    cacheScope: { userId: 'viewer-1', activeTransportId: 'transport-centurion' },
  }));

vi.mock('@/lib/auth-client', () => ({ useSession: useSessionMock }));
vi.mock('@/providers/query-provider', () => ({ useTRPC: useTRPCMock }));
vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));
vi.mock('@/lib/admin-dashboard/export', () => ({
  downloadAdminDashboardExport: downloadMock,
}));
vi.mock('@/lib/mail/mail-cache-scope', () => ({
  getMailCacheScope: () => cacheScope,
  subscribeMailCacheScope: () => () => undefined,
}));

import { useAdminDashboardExport } from '@/hooks/use-admin-dashboard';

const successfulPayload = {
  schemaVersion: 'admin-dashboard-export-v1',
  query: {
    cohortId: 'centurion',
    window: '7d',
    windowStart: '2026-09-01T00:00:00.000Z',
    windowEnd: '2026-09-08T00:00:00.000Z',
    observationCutoff: '2026-09-08T00:00:00.000Z',
    sourceVintage: '2026-09-08T00:00:00.000Z',
  },
} as const;

type ExportHook = ReturnType<typeof useAdminDashboardExport>;

function HookProbe({ onReady }: { onReady: (hook: ExportHook) => void }): ReactNode {
  onReady(useAdminDashboardExport({ cohortId: 'centurion', window: '7d' }));
  return null;
}

describe('useAdminDashboardExport', () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({
      data: { user: { id: 'viewer-1', email: 'ropperman@legacyhotels.co.za' } },
      isLoading: false,
      isError: false,
    });
    queryFnMock.mockReset();
    queryOptionsMock.mockReset();
    downloadMock.mockReset();
    queryOptionsMock.mockImplementation((input: unknown, options: Record<string, unknown>) => ({
      queryKey: ['adminDashboard', 'getMetrics', input],
      queryFn: queryFnMock,
      ...options,
    }));
    useTRPCMock.mockReturnValue({
      adminDashboard: { getMetrics: { queryOptions: queryOptionsMock } },
    });
  });

  it('does not download a cached export after a later refresh fails', async () => {
    let refreshCount = 0;
    queryFnMock.mockImplementation(async () => {
      refreshCount += 1;
      if (refreshCount === 1) return successfulPayload;
      throw new Error('transient export refresh failure');
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let hook: ExportHook | null = null;
    try {
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(HookProbe, { onReady: (value) => (hook = value) }),
        ),
      );

      expect(hook).not.toBeNull();
      expect(await hook!.download()).toBe(true);
      expect(downloadMock).toHaveBeenCalledTimes(1);

      expect(await hook!.download()).toBe(false);
      expect(downloadMock).toHaveBeenCalledTimes(1);
    } finally {
      queryClient.clear();
    }
  });
});
