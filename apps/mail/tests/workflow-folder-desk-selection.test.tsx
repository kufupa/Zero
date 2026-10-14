/**
 * @vitest-environment happy-dom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter, type UrlUpdateEvent } from 'nuqs/adapters/testing';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  queryRows: [
    {
      threadId: 'thread-one',
      sourceMessageId: 'message-one-latest',
      sender: 'First sender',
      subject: 'First thread subject',
      receivedAt: '2026-10-13T10:00:00.000Z',
      review: null,
      prefilled: false,
      action: 'quote_availability',
      kind: 'quote',
    },
    {
      threadId: 'thread-two',
      sourceMessageId: 'message-two-latest',
      sender: 'Second sender',
      subject: 'Second thread subject',
      receivedAt: '2026-10-13T11:00:00.000Z',
      review: null,
      prefilled: false,
      action: 'quote_availability',
      kind: 'quote',
    },
  ],
  threadDetails: {
    'thread-one': {
      defaultMessageId: 'message-one-latest',
      messages: [
        {
          messageId: 'message-one-latest',
          sender: 'First sender',
          subject: 'First thread subject',
          receivedAt: '2026-10-13T10:00:00.000Z',
          extraction: null,
          review: null,
          workItemStatus: null,
        },
        {
          messageId: 'message-one-older',
          sender: 'First sender',
          subject: 'Earlier message in first thread',
          receivedAt: '2026-10-13T09:00:00.000Z',
          extraction: null,
          review: null,
          workItemStatus: null,
        },
      ],
      runs: [],
    },
    'thread-two': {
      defaultMessageId: 'message-two-latest',
      messages: [
        {
          messageId: 'message-two-latest',
          sender: 'Second sender',
          subject: 'Second thread subject',
          receivedAt: '2026-10-13T11:00:00.000Z',
          extraction: null,
          review: null,
          workItemStatus: null,
        },
      ],
      runs: [],
    },
  },
}));

vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({
    workflowFolders: {
      list: {
        infiniteQueryOptions: (
          _input: unknown,
          options: {
            initialCursor: string;
            getNextPageParam: (page: { nextCursor: string | null }) => string | undefined;
          },
        ) => ({
          queryKey: ['workflowFolders', 'list'],
          queryFn: async () => ({ rows: fixtures.queryRows, nextCursor: null }),
          initialPageParam: options.initialCursor,
          getNextPageParam: options.getNextPageParam,
        }),
      },
      thread: {
        queryOptions: (
          { threadId }: { threadId: string },
          options?: { enabled?: boolean },
        ) => ({
          queryKey: ['workflowFolders', 'thread', threadId],
          queryFn: async () => fixtures.threadDetails[threadId as keyof typeof fixtures.threadDetails],
          enabled: options?.enabled,
        }),
      },
      summary: { queryKey: () => ['workflowFolders', 'summary'] },
    },
    workItems: {
      adminReview: {
        mutationOptions: () => ({ mutationFn: async () => undefined }),
      },
    },
  }),
}));

vi.mock('@/hooks/use-threads', () => ({
  useThread: (threadId: string | null) => {
    return {
      data:
        threadId === 'thread-one'
          ? {
              messages: [
                { id: 'message-one-latest', decodedBody: 'Latest message body in first thread' },
                { id: 'message-one-older', decodedBody: 'Earlier message body in first thread' },
              ],
            }
          : threadId === 'thread-two'
            ? { messages: [{ id: 'message-two-latest', decodedBody: 'Message body in second thread' }] }
            : undefined,
      isLoading: false,
    };
  },
}));

vi.mock('@/hooks/use-workflow-folder-summary', () => ({
  useWorkflowFolderSummary: () => ({ data: undefined }),
}));

vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));

import { WorkflowFolderDesk } from '../components/mail/workflow-folder-desk';

const queryClients: QueryClient[] = [];

function StatefulNuqsTestingAdapter({
  children,
  onUrlUpdate,
}: {
  children: ReactNode;
  onUrlUpdate: (event: UrlUpdateEvent) => void;
}) {
  const searchParams = useRef(new URLSearchParams());
  const [, forceRerender] = useState(0);

  return (
    <NuqsTestingAdapter
      resetUrlUpdateQueueOnMount={false}
      searchParams={searchParams.current}
      onUrlUpdate={(event) => {
        for (const key of Array.from(searchParams.current.keys())) searchParams.current.delete(key);
        event.searchParams.forEach((value, key) => searchParams.current.set(key, value));
        forceRerender((revision) => revision + 1);
        onUrlUpdate(event);
      }}
    >
      {children}
    </NuqsTestingAdapter>
  );
}

function renderDesk(onUrlUpdate: (event: UrlUpdateEvent) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  queryClients.push(queryClient);

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/mail/quotes']}>
        <StatefulNuqsTestingAdapter onUrlUpdate={onUrlUpdate}>
          <Routes>
            <Route path="/mail/:folder" element={<WorkflowFolderDesk />} />
          </Routes>
        </StatefulNuqsTestingAdapter>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe('workflow folder desk selection', () => {
  it('switches rows after selecting another email in the first thread', async () => {
    const updates: URLSearchParams[] = [];
    const emailBody = () => screen.getByRole('region', { name: 'Email body' });

    renderDesk(({ searchParams }) => updates.push(new URLSearchParams(searchParams)));

    expect(
      (await within(emailBody()).findByText('Latest message body in first thread')).textContent,
    ).toBe('Latest message body in first thread');

    fireEvent.change(screen.getByRole('combobox', { name: 'Inbound email in thread' }), {
      target: { value: 'message-one-older' },
    });

    expect(
      within(emailBody()).getByText('Earlier message body in first thread').textContent,
    ).toBe('Earlier message body in first thread');
    const updatesBeforeRowSwitch = updates.length;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Second thread subject/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      const secondRowSelected =
        screen
          .getByRole('button', { name: /Second thread subject/ })
          .getAttribute('aria-current') === 'true';
      const secondThreadWritten = updates.some((params) => params.get('threadId') === 'thread-two');
      if (!secondRowSelected || !secondThreadWritten) {
        throw new Error('Expected the second row and thread query state to be selected.');
      }
    });
    expect(
      screen
        .getByRole('button', { name: /Second thread subject/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    const rowSelectionUpdates = updates
      .slice(updatesBeforeRowSwitch)
      .filter((params) => params.get('threadId') === 'thread-two');
    expect(rowSelectionUpdates).toHaveLength(1);
    expect(rowSelectionUpdates[0].has('sourceMessageId')).toBe(false);
    expect(
      (await within(emailBody()).findByText('Message body in second thread')).textContent,
    ).toBe('Message body in second thread');
  });
});
