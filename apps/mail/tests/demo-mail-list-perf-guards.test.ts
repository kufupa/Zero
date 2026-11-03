/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atom } from 'jotai';
import { MailList, areMailLabelsEqual } from '../components/mail/mail-list';
import { beginMailSelectionIntent } from '../lib/mail/source-message-navigation';
import { EMPTY_SEARCH_VALUE, unreadFilter, type SearchValueState } from '../lib/mail/search-list';

const mocks = vi.hoisted(() => ({
  searchValue: null as unknown as SearchValueState,
  setSearchValue: vi.fn(),
  resetSearchValue: vi.fn(),
  useThreads: vi.fn(),
  useThread: vi.fn(),
  useDraft: vi.fn(),
  folder: 'inbox',
  navigate: null as ((threadId: string | null) => void) | null,
  setMailSelection: vi.fn(),
  setComposeState: vi.fn(),
  selection: { threadId: null as string | null, sourceMessageId: 'old-message' as string | null },
  selectionListeners: new Set<() => void>(),
  flushCompose: vi.fn(),
}));

vi.mock('@/hooks/use-search-value', () => ({
  useSearchValue: () => [mocks.searchValue, mocks.setSearchValue],
  useResetSearchValue: () => mocks.resetSearchValue,
  searchResultCountAtom: atom<number | undefined>(undefined),
  mailSearchBarFocusedAtom: atom(false),
}));

vi.mock('@/hooks/use-threads', () => ({
  useThreads: () => mocks.useThreads(),
  useThread: (...args: unknown[]) => mocks.useThread(...args),
}));

vi.mock('@/hooks/use-drafts', () => ({
  useDraft: (...args: unknown[]) => mocks.useDraft(...args),
}));

vi.mock('@/components/mail/optimistic-thread-state', () => ({
  useOptimisticThreadState: () => ({
    shouldHide: false,
    isRemoving: false,
    optimisticStarred: null,
    optimisticImportant: null,
    optimisticRead: null,
    optimisticLabels: null,
  }),
}));

vi.mock('@/hooks/use-labels', () => ({
  useThreadLabels: () => ({ labels: [] }),
  useLabels: () => ({ userLabels: [], systemLabels: [] }),
}));

vi.mock('@/hooks/use-categories', () => ({
  useCategorySettings: () => [],
}));

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock('@/lib/mail/build-mail-list-virtual-rows', () => ({
  buildMailListVirtualRows: (items: Array<{ id: string }>) =>
    items.map((message, threadIndex) => ({
      type: 'thread',
      key: message.id,
      threadIndex,
      message,
    })),
}));

vi.mock('virtua', async () => {
  const { createElement, forwardRef } = await import('react');
  return {
    VList: forwardRef(
      (props: { count: number; children: (index: number) => React.ReactNode }, _ref) =>
        createElement(
          'div',
          null,
          Array.from({ length: props.count }, (_, index) => props.children(index)),
        ),
    ),
  };
});

vi.mock('@/hooks/use-mail-navigation', async () => {
  const { atom } = await import('jotai');
  return {
    focusedIndexAtom: atom<number | null>(null),
    useMailNavigation: ({ onNavigate }: { onNavigate: (id: string | null) => void }) => {
      mocks.navigate = onNavigate;
      return { focusedIndex: null, handleMouseEnter: vi.fn(), keyboardActive: false };
    },
  };
});

vi.mock('@/hooks/use-settings', () => ({
  useSettings: () => ({ data: { settings: { autoRead: true } } }),
}));

vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({ mail: { get: { queryKey: () => ['mail', 'get'] } } }),
}));

vi.mock('@tanstack/react-query', () => ({
  useIsFetching: () => 0,
}));

vi.mock('@/hooks/use-hot-key', () => ({
  useKeyState: () => () => false,
}));

vi.mock('@/components/mail/use-mail', () => ({
  useMail: () => [{ bulkSelected: [] }, vi.fn()],
}));

vi.mock('@/hooks/use-optimistic-actions', () => ({
  useOptimisticActions: () => ({ optimisticMarkAsRead: vi.fn() }),
}));

vi.mock('react-router', () => ({
  useParams: () => ({ folder: mocks.folder }),
}));

vi.mock('nuqs', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    parseAsString: {},
    useQueryState: () => [null, mocks.setComposeState],
    useQueryStates: () => [useSyncExternalStore(
      (listener) => { mocks.selectionListeners.add(listener); return () => { mocks.selectionListeners.delete(listener); }; },
      () => mocks.selection,
    ), mocks.setMailSelection],
  };
});

vi.mock('@/lib/mail/compose-flush-registry', () => ({
  flushComposeBeforeLeave: () => mocks.flushCompose(),
}));

vi.mock('@/components/icons/empty-state-svg', () => ({
  EmptyStateIcon: () => null,
}));

type MemoExoticComponent = typeof MailList & {
  compare: null | ((prev: unknown, next: unknown) => boolean);
};

beforeEach(() => {
  mocks.folder = 'inbox';
  mocks.navigate = null;
  mocks.setMailSelection.mockReset();
  mocks.setComposeState.mockReset();
  mocks.selection = { threadId: null, sourceMessageId: 'old-message' };
  mocks.flushCompose.mockReset().mockResolvedValue(undefined);
  mocks.searchValue = {
    ...EMPTY_SEARCH_VALUE,
    value: 'deposit',
    highlight: 'deposit',
    filters: [unreadFilter()],
  };
  mocks.setSearchValue.mockClear();
  mocks.resetSearchValue.mockClear();
  mocks.useThread.mockReturnValue({
    data: undefined,
    isGroupThread: false,
    latestDraft: null,
  });
  mocks.useThread.mockClear();
  mocks.useDraft.mockReturnValue({ data: undefined });
  mocks.useDraft.mockClear();
  mocks.useThreads.mockReturnValue([
    {
      refetch: vi.fn(),
      isLoading: false,
      isFetching: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      isError: false,
      error: null,
    },
    [],
    true,
    vi.fn(),
  ]);
});

afterEach(() => {
  cleanup();
});

describe('demo mail list perf guards', () => {
  it('keyboard thread navigation clears the prior message after flushing the draft', async () => {
    render(createElement(MailList));
    act(() => mocks.navigate?.('thread-b'));
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: null }));
    expect(mocks.flushCompose).toHaveBeenCalledOnce();
  });

  it('does not let a late draft flush move selection back to an earlier thread', async () => {
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    mocks.flushCompose
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishSecond = resolve; }));
    render(createElement(MailList));
    act(() => { mocks.navigate?.('thread-b'); mocks.navigate?.('thread-a'); });
    await act(async () => { finishSecond?.(); });
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-a', sourceMessageId: null }));
    await act(async () => { finishFirst?.(); });
    expect(mocks.setMailSelection).toHaveBeenCalledTimes(1);
  });
  it('does not let a pending thread navigation override a newer message choice or clear its draft', async () => {
    let finish!: () => void;
    mocks.flushCompose.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(createElement(MailList));
    act(() => mocks.navigate?.('thread-b'));
    act(() => {
      mocks.selection = { threadId: 'thread-a', sourceMessageId: 'new-message' };
      mocks.selectionListeners.forEach((listener) => listener());
    });
    await act(async () => { finish(); });
    expect(mocks.setMailSelection).not.toHaveBeenCalled();
    expect(mocks.setComposeState).not.toHaveBeenCalled();
  });
  it('cancels a pending navigation when another control makes a choice before the URL changes', async () => {
    let finish!: () => void;
    mocks.flushCompose.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(createElement(MailList));
    act(() => mocks.navigate?.('thread-b'));
    act(() => { beginMailSelectionIntent(); });
    await act(async () => { finish(); });
    expect(mocks.setMailSelection).not.toHaveBeenCalled();
    expect(mocks.setComposeState).not.toHaveBeenCalled();
  });
  it('shows effective query miss copy and preserves query state when trying all folders', () => {
    render(createElement(MailList));

    expect(screen.getByText('No emails match “deposit is:unread”')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try All folders' }));
    expect(mocks.setSearchValue).toHaveBeenCalledWith({
      ...mocks.searchValue,
      scope: 'all',
    });
  });

  it('clears a search miss through the explicit reset action', () => {
    render(createElement(MailList));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(mocks.resetSearchValue).toHaveBeenCalledOnce();
  });

  it('keeps folder-empty copy when effective query is empty', () => {
    mocks.searchValue = EMPTY_SEARCH_VALUE;

    render(createElement(MailList));

    expect(screen.getByText("It's empty here")).toBeTruthy();
    expect(screen.queryByText(/No emails match/)).toBeNull();
  });

  it('shows retryable search error before zero-result copy', () => {
    const refetch = vi.fn();
    mocks.searchValue = {
      ...EMPTY_SEARCH_VALUE,
      value: 'deposit is:unread',
      highlight: 'deposit is:unread',
    };
    mocks.useThreads.mockReturnValue([
      {
        refetch,
        isLoading: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: false,
        isError: true,
        error: new Error('request failed'),
      },
      [],
      true,
      vi.fn(),
    ]);

    render(createElement(MailList));

    expect(screen.getByRole('alert').textContent).toContain('Unable to load search results');
    expect(screen.queryByText('No emails match “deposit is:unread”')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('labels idle-folder transport failures as mail load errors, not search', () => {
    const refetch = vi.fn();
    mocks.searchValue = EMPTY_SEARCH_VALUE;
    mocks.useThreads.mockReturnValue([
      {
        refetch,
        isLoading: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: false,
        isError: true,
        error: new Error('request failed'),
      },
      [],
      true,
      vi.fn(),
    ]);

    render(createElement(MailList));

    expect(screen.getByRole('alert').textContent).toContain('Unable to load mail');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('uses normal thread rows when All folders resolves from Drafts', () => {
    mocks.folder = 'draft';
    mocks.useThreads.mockReturnValue([
      {
        refetch: vi.fn(),
        isLoading: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: false,
        isError: false,
        error: null,
      },
      [{ id: 'thread-from-all-folders' }],
      false,
      vi.fn(),
      {
        isValid: true,
        effectiveQuery: 'deposit',
        folder: 'all',
        filters: {},
        q: 'deposit',
        useDraftsList: false,
      },
    ]);

    render(createElement(MailList));

    expect(mocks.useThread).toHaveBeenCalledWith('thread-from-all-folders');
    expect(mocks.useDraft).not.toHaveBeenCalled();
  });

  it('does not force MailList memo to always skip parent updates', () => {
    expect((MailList as MemoExoticComponent).compare).toBeNull();
  });

  it('compares MailLabels arrays deterministically by id and name pairs', () => {
    const prev = [
      { id: 'a', name: 'STARRED' },
      { id: 'b', name: 'important' },
    ];
    const next = [
      { id: 'a', name: 'STARRED' },
      { id: 'b', name: 'important' },
    ];

    expect(areMailLabelsEqual(prev, next)).toBe(true);
  });

  it('detects added labels in MailLabels memo comparison', () => {
    expect(
      areMailLabelsEqual(
        [{ id: 'a', name: 'STARRED' }],
        [
          { id: 'a', name: 'STARRED' },
          { id: 'b', name: 'important' },
        ],
      ),
    ).toBe(false);
  });

  it('detects label name/id changes in MailLabels memo comparison', () => {
    expect(
      areMailLabelsEqual(
        [{ id: 'a', name: 'STARRED' }],
        [{ id: 'a', name: 'INBOX' }],
      ),
    ).toBe(false);
  });

  it('detects label order changes in MailLabels memo comparison', () => {
    expect(
      areMailLabelsEqual(
        [
          { id: 'a', name: 'STARRED' },
          { id: 'b', name: 'important' },
        ],
        [
          { id: 'b', name: 'important' },
          { id: 'a', name: 'STARRED' },
        ],
      ),
    ).toBe(false);
  });

  it('treats missing MailLabels arrays as stable empty lists', () => {
    expect(areMailLabelsEqual(undefined, undefined)).toBe(true);
    expect(areMailLabelsEqual(null, undefined)).toBe(true);
    expect(areMailLabelsEqual([], null)).toBe(true);
    expect(areMailLabelsEqual([{ id: 'a', name: 'STARRED' }], null)).toBe(false);
  });
});
