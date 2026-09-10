/* @vitest-environment happy-dom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, useLayoutEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createRoot } from 'react-dom/client';

const {
  useSessionMock,
  useTRPCMock,
  queryOptionsMock,
  queryFnMock,
  downloadMock,
  sessionState,
  cacheScope,
  renderScope,
  scopeListeners,
} = vi.hoisted(() => ({
  useSessionMock: vi.fn(),
  useTRPCMock: vi.fn(),
  queryOptionsMock: vi.fn(),
  queryFnMock: vi.fn(),
  downloadMock: vi.fn(),
  sessionState: {
    data: { user: { id: 'viewer-1', email: 'ropperman@legacyhotels.co.za' } },
    isLoading: false,
    isError: false,
  },
  cacheScope: { userId: 'viewer-1', activeTransportId: 'transport-centurion' },
  renderScope: {
    value: null as { userId: string; activeTransportId: string } | null,
  },
  scopeListeners: new Set<() => void>(),
}));

vi.mock('@/lib/auth-client', () => ({ useSession: useSessionMock }));
vi.mock('@/providers/query-provider', () => ({ useTRPC: useTRPCMock }));
vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));
vi.mock('@/lib/admin-dashboard/export', () => ({
  downloadAdminDashboardExport: downloadMock,
}));
vi.mock('@/lib/mail/mail-cache-scope', () => ({
  getMailCacheScope: () => renderScope.value ?? cacheScope,
  subscribeMailCacheScope: (listener: () => void) => {
    scopeListeners.add(listener);
    return () => scopeListeners.delete(listener);
  },
}));

import {
  useAdminDashboardExport,
  type AdminDashboardQueryInput,
} from '@/hooks/use-admin-dashboard';

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

function HookProbe({
  queryInput,
  onReady,
  onLayout,
}: {
  queryInput: AdminDashboardQueryInput;
  onReady: (hook: ExportHook) => void;
  onLayout?: () => void;
}): ReactNode {
  onReady(useAdminDashboardExport(queryInput));
  useLayoutEffect(() => onLayout?.(), [onLayout]);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('useAdminDashboardExport', () => {
  beforeEach(() => {
    sessionState.data = {
      user: { id: 'viewer-1', email: 'ropperman@legacyhotels.co.za' },
    };
    sessionState.isLoading = false;
    sessionState.isError = false;
    useSessionMock.mockImplementation(() => sessionState);
    queryFnMock.mockReset();
    queryOptionsMock.mockReset();
    downloadMock.mockReset();
    cacheScope.userId = 'viewer-1';
    cacheScope.activeTransportId = 'transport-centurion';
    renderScope.value = null;
    scopeListeners.clear();
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
    const view = render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(HookProbe, {
          queryInput: { cohortId: 'centurion', window: '7d' },
          onReady: (value) => (hook = value),
        }),
      ),
    );
    try {
      expect(hook).not.toBeNull();
      expect(await hook!.download()).toBe(true);
      expect(downloadMock).toHaveBeenCalledTimes(1);

      expect(await hook!.download()).toBe(false);
      expect(downloadMock).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it('rejects a deferred export after a newer viewer render before scope publication', async () => {
    const firstRefresh = deferred<typeof successfulPayload>();
    queryFnMock.mockImplementationOnce(() => firstRefresh.promise);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const initialCommit = deferred<void>();
    const transitionCommit = deferred<void>();
    let hook: ExportHook | null = null;
    const initialQuery = { cohortId: 'centurion' as const, window: '7d' as const };
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(HookProbe, {
          queryInput: initialQuery,
          onReady: (value) => (hook = value),
          onLayout: () => initialCommit.resolve(),
        }),
      ),
    );

    try {
      await initialCommit.promise;
      expect(hook).not.toBeNull();
      const oldDownload = hook!.download();

      // A session/transport transition publishes its new cache scope in a
      // passive effect. Resolve the old request from the newer render's
      // layout phase, before that publication or React Query's new options.
      sessionState.data = {
        user: { id: 'viewer-2', email: 'new-viewer@example.com' },
      };
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(HookProbe, {
            queryInput: initialQuery,
            onReady: (value) => (hook = value),
            onLayout: () => {
              firstRefresh.resolve(successfulPayload);
              transitionCommit.resolve();
            },
          }),
        ),
      );
      await transitionCommit.promise;

      expect(await oldDownload).toBe(false);
      expect(downloadMock).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      queryClient.clear();
      container.remove();
    }
  });

  it('ignores a deferred export after a newer selection render', async () => {
    const firstRefresh = deferred<typeof successfulPayload>();
    queryFnMock.mockImplementationOnce(() => firstRefresh.promise);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let hook: ExportHook | null = null;
    const initialQuery = { cohortId: 'centurion' as const, window: '7d' as const };
    const nextQuery = {
      cohortId: 'research' as const,
      window: '28d' as const,
      observationCutoff: '2026-09-08T00:00:00.000Z',
    };
    const view = render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(HookProbe, {
          queryInput: initialQuery,
          onReady: (value) => (hook = value),
        }),
      ),
    );

    try {
      expect(hook).not.toBeNull();
      const oldDownload = hook!.download();

      view.rerender(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(HookProbe, {
            queryInput: nextQuery,
            onReady: (value) => (hook = value),
          }),
        ),
      );

      let result: boolean | undefined;
      await act(async () => {
        firstRefresh.resolve(successfulPayload);
        result = await oldDownload;
      });
      expect(result).toBe(false);
      expect(downloadMock).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });
});
