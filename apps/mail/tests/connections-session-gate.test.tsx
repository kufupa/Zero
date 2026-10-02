/** @vitest-environment happy-dom */
import { useActiveConnection, useConnections } from '../hooks/use-connections';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';

const state = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  list: vi.fn(async () => []),
  getDefault: vi.fn(async () => ({ id: 'approved-mailbox' })),
}));

vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: state.session }) }));
vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));
vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({
    connections: {
      list: {
        queryOptions: (_input: unknown, options: object) => ({
          queryKey: ['connections', 'list'],
          queryFn: state.list,
          ...options,
        }),
      },
      getDefault: {
        queryOptions: (_input: unknown, options: object) => ({
          queryKey: ['connections', 'default'],
          queryFn: state.getDefault,
          ...options,
        }),
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  state.session = null;
  vi.clearAllMocks();
});

describe('mailbox queries require a staff session', () => {
  it('does not request either mailbox endpoint before sign-in, then loads after sign-in', async () => {
    window.history.replaceState({}, '', '/outlook-pane');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(() => ({ active: useActiveConnection(), list: useConnections() }), {
      wrapper,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.getDefault).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
    state.session = { user: { id: 'named-staff' } };
    hook.rerender();
    await waitFor(() => expect(state.getDefault).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.list).toHaveBeenCalledOnce());
    client.clear();
  });

  it('preserves normal web-mail loading even while its cached session is stale', async () => {
    window.history.replaceState({}, '', '/mail/inbox');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => ({ active: useActiveConnection(), list: useConnections() }), { wrapper });
    await waitFor(() => expect(state.getDefault).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.list).toHaveBeenCalledOnce());
    client.clear();
  });
});
