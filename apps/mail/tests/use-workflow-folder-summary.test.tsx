/** @vitest-environment happy-dom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ summary: undefined as unknown }));

vi.mock('@/hooks/use-connections', () => ({
  useActiveConnection: () => ({ data: { providerId: 'mailbox' } }),
}));

vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));

vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({
    workflowFolders: {
      summary: {
        queryOptions: (_input: unknown, options: object) => ({
          queryKey: ['workflowFolders', 'summary'],
          queryFn: async () => state.summary,
          ...options,
        }),
      },
    },
  }),
}));

import { useWorkflowFolderSummary } from '../hooks/use-workflow-folder-summary';

const queryClients: QueryClient[] = [];

function renderSummary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  queryClients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  return renderHook(() => useWorkflowFolderSummary(), { wrapper });
}

afterEach(() => {
  cleanup();
  for (const client of queryClients.splice(0)) client.clear();
  state.summary = undefined;
});

describe('useWorkflowFolderSummary', () => {
  it('preserves the live folder counts', async () => {
    const quoteStats = {
      threads: 4,
      read: 3,
      prefilled: 2,
      reviewedRight: 1,
      reviewedEdited: 0,
      reviewedWrong: 1,
    };
    state.summary = { quotes: quoteStats };

    const { result } = renderSummary();
    await waitFor(() => {
      if (!result.current.isSuccess) throw new Error('Expected the summary query to succeed.');
    });

    expect(result.current.data?.quotes).toEqual(quoteStats);
  });

  it('filters the eval summary shape', async () => {
    state.summary = { quotes: { total: 11, marked: 3 } };

    const { result } = renderSummary();
    await waitFor(() => {
      if (!result.current.isSuccess) throw new Error('Expected the summary query to succeed.');
    });

    expect(result.current.data).toBeUndefined();
  });
});
