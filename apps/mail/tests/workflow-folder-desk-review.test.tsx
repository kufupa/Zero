/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  folder: 'quotes',
  queryState: {
    threadId: null as string | null,
    sourceMessageId: null as string | null,
    set: 'eval' as string | null,
  },
  rows: [] as Array<Record<string, unknown>>,
  details: {} as Record<string, unknown>,
  summary: {} as Record<string, unknown>,
  listInput: null as Record<string, unknown> | null,
  threadInput: null as Record<string, unknown> | null,
  summarySet: undefined as string | undefined,
  actionOptions: null as Record<string, unknown> | null,
  actionError: null as Error | null,
  actionPending: false,
  actionMutate: vi.fn(),
  reviewMutate: vi.fn(),
  useInfiniteQuery: vi.fn(),
  invalidateQueries: vi.fn(),
  fetchNextPage: vi.fn(),
  hasNextPage: false,
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: (...args: unknown[]) => mocks.useInfiniteQuery(...args),
  useMutation: (options: Record<string, unknown> = {}) => {
    if (options.mutationKind === 'setActionLabel') {
      mocks.actionOptions = options;
      return {
        mutate: mocks.actionMutate,
        isPending: mocks.actionPending,
        error: mocks.actionError,
      };
    }
    return { mutate: mocks.reviewMutate, isPending: false, error: null };
  },
  useQuery: () => ({
    data: mocks.details[mocks.queryState.threadId ?? ''] ?? undefined,
    error: null,
    isError: false,
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock('react-router', () => ({
  useParams: () => ({ folder: mocks.folder }),
  useLocation: () => ({ pathname: '/mail/workflows/quotes', search: mocks.queryState.set ? '?set=eval' : '' }),
}));

vi.mock('nuqs', () => ({
  useQueryState: (key: keyof typeof mocks.queryState) => [
    mocks.queryState[key],
    async (value: string | null) => {
      mocks.queryState[key] = value;
    },
  ],
}));

vi.mock('@/hooks/use-threads', () => ({
  useThread: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/use-workflow-folder-summary', () => ({
  useWorkflowFolderSummary: (_enabled?: boolean, set?: string) => {
    mocks.summarySet = set;
    return { data: mocks.summary };
  },
}));

vi.mock('@/lib/demo/runtime', () => ({
  isFrontendOnlyDemo: () => false,
}));

vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({
    workflowFolders: {
      list: {
        infiniteQueryOptions: (input: Record<string, unknown>) => {
          mocks.listInput = input;
          return {};
        },
        infiniteQueryKey: () => ['workflowFolders', 'list'],
      },
      thread: {
        queryOptions: (input: Record<string, unknown>) => {
          mocks.threadInput = input;
          return {};
        },
        queryKey: () => ['workflowFolders', 'thread'],
      },
      summary: { queryKey: () => ['workflowFolders', 'summary'] },
      setActionLabel: {
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationKind: 'setActionLabel',
        }),
      },
    },
    workItems: {
      adminReview: {
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationKind: 'adminReview',
        }),
      },
    },
  }),
}));

import { WorkflowFolderDesk } from '../components/mail/workflow-folder-desk';

function row(
  sourceMessageId: string,
  predictedAction: string,
  options: { threadId?: string; ownerAction?: string | null } = {},
) {
  return {
    threadId: options.threadId ?? `thread-${sourceMessageId}`,
    sourceMessageId,
    extractionId: null,
    folder: 'quotes',
    sender: 'fixture@example.invalid',
    subject: 'Synthetic item',
    receivedAt: '2026-10-12T10:00:00.000Z',
    isRead: false,
    kind: null,
    action: null,
    payload: null,
    extractorVersion: null,
    extractionCreatedAt: null,
    prefilled: false,
    workItemStatus: null,
    review: null,
    predictedAction,
    ownerAction: options.ownerAction ?? null,
    markedAt: options.ownerAction ? '2026-10-12T10:30:00.000Z' : null,
  };
}

function setRows(rows: Array<ReturnType<typeof row>>) {
  mocks.rows = rows;
  mocks.details = Object.fromEntries(
    rows.map((item) => [
      item.threadId,
      {
        threadId: item.threadId,
        folder: 'quotes',
        defaultMessageId: item.sourceMessageId,
        messages: [
          {
            messageId: item.sourceMessageId,
            sender: item.sender,
            subject: item.subject,
            receivedAt: item.receivedAt,
            isRead: false,
            extraction: null,
            review: null,
            workItemStatus: null,
            predictedAction: item.predictedAction,
            ownerAction: item.ownerAction,
            markedAt: item.markedAt,
          },
        ],
        runs: [],
      },
    ]),
  );
  mocks.useInfiniteQuery.mockReturnValue({
    data: { pages: [{ rows, nextCursor: null }] },
    error: null,
    isError: false,
    isLoading: false,
    hasNextPage: mocks.hasNextPage,
    fetchNextPage: mocks.fetchNextPage,
  });
}

function selectRow(item: ReturnType<typeof row>) {
  mocks.queryState.threadId = item.threadId;
  mocks.queryState.sourceMessageId = item.sourceMessageId;
}

describe('workflow folder desk review set', () => {
  beforeEach(() => {
    mocks.folder = 'quotes';
    mocks.queryState.threadId = null;
    mocks.queryState.sourceMessageId = null;
    mocks.queryState.set = 'eval';
    mocks.summary = { quotes: { total: 2, marked: 0 } };
    mocks.summarySet = undefined;
    mocks.listInput = null;
    mocks.threadInput = null;
    mocks.actionOptions = null;
    mocks.actionError = null;
    mocks.actionPending = false;
    mocks.hasNextPage = false;
    mocks.actionMutate.mockReset();
    mocks.reviewMutate.mockReset();
    mocks.invalidateQueries.mockReset();
    mocks.fetchNextPage.mockReset();
    setRows([]);
  });

  afterEach(() => cleanup());

  it('preselects Nava’s action, saves Right, and advances to the next unmarked message', async () => {
    const first = row('message-one', 'quote_availability');
    const next = row('message-two', 'cancel');
    setRows([first, next]);
    selectRow(first);

    render(<WorkflowFolderDesk />);

    expect(screen.queryByText('Nava says: Quote')).toBeTruthy();
    const actionSelect = screen.queryByLabelText('Correct action') as HTMLSelectElement | null;
    expect(actionSelect).toBeTruthy();
    if (!actionSelect) return;
    expect(actionSelect.value).toBe(
      'quote_availability',
    );
    expect(mocks.listInput).toMatchObject({ folder: 'quotes', set: 'eval' });
    expect(mocks.threadInput).toMatchObject({
      folder: 'quotes',
      threadId: first.threadId,
      messageId: 'message-one',
      set: 'eval',
    });
    expect(mocks.summarySet).toBe('eval');

    const rightButton = screen.queryByRole('button', { name: 'Right' });
    expect(rightButton).toBeTruthy();
    if (!rightButton) return;
    fireEvent.click(rightButton);
    expect(mocks.actionMutate).toHaveBeenCalledWith({
      messageId: 'message-one',
      action: 'quote_availability',
    });

    const onSuccess = mocks.actionOptions?.onSuccess as
      | ((result: unknown, input: unknown) => Promise<void>)
      | undefined;
    expect(onSuccess).toBeTypeOf('function');
    await act(async () => {
      await onSuccess!(
        {},
        { messageId: 'message-one', action: 'quote_availability' },
      );
    });
    expect(mocks.queryState.threadId).toBe(next.threadId);
    expect(mocks.queryState.sourceMessageId).toBe('message-two');
  });

  it('number shortcuts save the numbered action and avoid action controls while focused', () => {
    const first = row('message-one', 'quote_availability');
    setRows([first]);
    selectRow(first);
    render(<WorkflowFolderDesk />);

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(mocks.actionMutate).toHaveBeenCalledWith({
      messageId: 'message-one',
      action: 'quote_availability',
    });

    mocks.actionMutate.mockClear();
    fireEvent.keyDown(window, { key: '4' });
    expect(mocks.actionMutate).toHaveBeenCalledWith({
      messageId: 'message-one',
      action: 'amend',
    });

    mocks.actionMutate.mockClear();
    const actionSelect = screen.queryByLabelText('Correct action');
    expect(actionSelect).toBeTruthy();
    if (!actionSelect) return;
    fireEvent.keyDown(actionSelect, { key: '4' });
    expect(mocks.actionMutate).not.toHaveBeenCalled();
  });

  it('uses j and k to move to the next and previous review-set message', async () => {
    const first = row('message-one', 'quote_availability');
    const second = row('message-two', 'cancel');
    setRows([first, second]);
    selectRow(first);
    const view = render(<WorkflowFolderDesk />);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'j' });
    });
    expect(mocks.queryState.sourceMessageId).toBe('message-two');

    view.rerender(<WorkflowFolderDesk />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k' });
    });
    expect(mocks.queryState.sourceMessageId).toBe('message-one');
  });

  it('shows a marked action chip and review progress', () => {
    const marked = row('message-marked', 'cancel', { ownerAction: 'amend' });
    setRows([marked]);
    selectRow(marked);
    mocks.summary = { quotes: { total: 4, marked: 2 } };

    render(<WorkflowFolderDesk />);

    expect(screen.queryByText('Marked: Amendment')).toBeTruthy();
    expect(screen.queryByText('Marked 2 / 4')).toBeTruthy();
  });

  it('shows mutation errors and does not advance', () => {
    const first = row('message-one', 'quote_availability');
    const next = row('message-two', 'cancel');
    setRows([first, next]);
    selectRow(first);
    mocks.actionError = new Error('Mark rejected');

    render(<WorkflowFolderDesk />);
    const rightButton = screen.queryByRole('button', { name: 'Right' });
    expect(rightButton).toBeTruthy();
    if (!rightButton) return;
    fireEvent.click(rightButton);

    expect(screen.queryByRole('alert')?.textContent).toContain('Mark rejected');
    expect(mocks.queryState.sourceMessageId).toBe('message-one');
  });

  it('toggles the eval set through the set query parameter', async () => {
    mocks.queryState.set = null;
    render(<WorkflowFolderDesk />);

    await act(async () => {
      const toggle = screen.queryByRole('button', { name: 'Review set' });
      expect(toggle).toBeTruthy();
      if (toggle) fireEvent.click(toggle);
    });

    expect(mocks.queryState.set).toBe('eval');
  });

  it('keeps the live Right / Edited / Wrong extraction review available', () => {
    mocks.queryState.set = null;
    const liveRow = { ...row('message-live', 'quote_availability'), extractionId: 'extraction-live' };
    setRows([liveRow]);
    selectRow(liveRow);
    mocks.details[liveRow.threadId] = {
      threadId: liveRow.threadId,
      folder: 'quotes',
      defaultMessageId: liveRow.sourceMessageId,
      messages: [
        {
          messageId: liveRow.sourceMessageId,
          sender: liveRow.sender,
          subject: liveRow.subject,
          receivedAt: liveRow.receivedAt,
          isRead: false,
          extraction: {
            id: 'extraction-live',
            kind: 'quote',
            action: 'quote_availability',
            folder: 'quotes',
            payload: {},
            extractorVersion: 'fixture-v1',
            createdAt: liveRow.receivedAt,
          },
          review: null,
          workItemStatus: null,
        },
      ],
      runs: [],
    };

    render(<WorkflowFolderDesk />);

    expect(screen.getByRole('heading', { name: 'Review Nava' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edited' })).toBeTruthy();
    expect(screen.queryByLabelText('Correct action')).toBeNull();
  });
});
