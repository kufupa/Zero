/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atom } from 'jotai';
import { MailList, areMailLabelsEqual, listThreadSelection } from '../components/mail/mail-list';
import { EMPTY_SEARCH_VALUE, unreadFilter, type SearchValueState } from '../lib/mail/search-list';
import { retainSameScopePlaceholder, selectionRequiresExactSource } from '../config/workflow-folders';
import { registerComposeFlush, registerComposeUnsavedCheck } from '../lib/mail/compose-flush-registry';

const mocks = vi.hoisted(() => ({
  searchValue: null as unknown as SearchValueState,
  setSearchValue: vi.fn(),
  resetSearchValue: vi.fn(),
  useThreads: vi.fn(),
  useThread: vi.fn(),
  useDraft: vi.fn(),
  folder: 'inbox',
  setMailSelection: vi.fn(),
  onNavigate: null as null | ((threadId: string | null) => void),
  linkedTarget: null as string | null,
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
  buildMailListVirtualRows: (items: Array<{ id: string }>) => [
    ...items.map((message, threadIndex) => ({ type: 'thread', key: message.id, threadIndex, message })),
    ...(mocks.linkedTarget ? [{ type: 'linked-stub', key: 'linked', parentThreadIndex: 0,
      stub: { threadId: mocks.linkedTarget } }] : []),
  ],
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
    useMailNavigation: (args: { onNavigate: (threadId: string | null) => void }) => {
      mocks.onNavigate = args.onNavigate;
      return {
        focusedIndex: null,
        handleMouseEnter: vi.fn(),
        keyboardActive: false,
      };
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

vi.mock('nuqs', () => ({
  parseAsString: {},
  useQueryState: () => [null, vi.fn()],
  useQueryStates: () => [{ threadId: null, sourceMessageId: 'old-source' }, mocks.setMailSelection],
}));

vi.mock('@/components/icons/empty-state-svg', () => ({
  EmptyStateIcon: () => null,
}));

vi.mock('@/components/mail/linked-thread-stub-row', () => ({
  LinkedThreadStubRow: ({ stub, onNavigate }: { stub: { threadId: string }; onNavigate: (id: string) => void }) =>
    createElement('button', { onClick: () => onNavigate(stub.threadId) }, 'Linked thread'),
}));

vi.mock('@/components/context/thread-context', () => ({
  ThreadContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/ui/bimi-avatar', () => ({ BimiAvatar: () => null }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}));
vi.mock('@/paraglide/messages', () => ({ m: new Proxy({}, { get: () => () => '' }) }));


type MemoExoticComponent = typeof MailList & {
  compare: null | ((prev: unknown, next: unknown) => boolean);
};

beforeEach(() => {
  mocks.folder = 'inbox';
  mocks.linkedTarget = null;
  registerComposeFlush(null);
  registerComposeUnsavedCheck(null);
  mocks.setMailSelection.mockReset();
  mocks.onNavigate = null;
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
  registerComposeFlush(null);
  registerComposeUnsavedCheck(null);
});

describe('demo mail list perf guards', () => {
  it('retains placeholders only when their actual row scope matches the next list', () => {
    const ordinary = { pages: [{ threads: [{ id: 'ordinary', workflowSourceRequired: false }] }] };
    const workflow = { pages: [{ threads: [{ id: 'workflow', workflowSourceRequired: true, workflowSourceMessageId: null }] }] };
    const unknown = { pages: [{ threads: [{ id: 'old-cache' }] }] };
    expect(retainSameScopePlaceholder(ordinary, false)).toBe(ordinary);
    expect(retainSameScopePlaceholder(workflow, true)).toBe(workflow);
    expect(retainSameScopePlaceholder(ordinary, true)).toBeUndefined();
    expect(retainSameScopePlaceholder(workflow, false)).toBeUndefined();
    expect(retainSameScopePlaceholder(unknown, false)).toBeUndefined();
    expect(retainSameScopePlaceholder({ pages: [{ threads: [] }] }, false)).toBeUndefined();
    expect(selectionRequiresExactSource('inbox', { isValid: true, folder: 'all' }, true, ordinary.pages[0]!.threads)).toBe(false);
    expect(selectionRequiresExactSource('inbox', { isValid: true, folder: 'all' }, true, workflow.pages[0]!.threads)).toBe(true);
    expect(selectionRequiresExactSource('inbox', { isValid: true, folder: 'all' }, true, unknown.pages[0]!.threads)).toBe(true);
  });

  it('clears source for an ordinary retained row during search', async () => {
    mocks.useThreads.mockReturnValue([
      { refetch: vi.fn(), isLoading: false, isFetching: true, isFetchingNextPage: false,
        hasNextPage: false, isError: false, error: null, isPlaceholderData: true },
      [{ id: 'thread-a', workflowSourceRequired: false, workflowSourceMessageId: null }], false, vi.fn(),
      { isValid: true, folder: 'all', useDraftsList: false },
    ]);
    render(createElement(MailList));
    act(() => mocks.onNavigate?.('thread-a'));
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-a', sourceMessageId: null }));
  });

  it('keeps exact workflow IDs and refuses absent row sources', () => {
    const rows = [
      { id: 'thread-a', workflowSourceMessageId: 'source-a' },
      { id: 'thread-b', workflowSourceMessageId: 'source-b' },
      { id: 'missing-source' },
    ];
    expect(listThreadSelection('thread-a', true, rows)).toEqual({ threadId: 'thread-a', sourceMessageId: 'source-a' });
    expect(listThreadSelection('thread-b', true, rows)).toEqual({ threadId: 'thread-b', sourceMessageId: 'source-b' });
    expect(listThreadSelection('missing-source', true, rows)).toEqual({ threadId: 'missing-source', sourceMessageId: '' });
    expect(listThreadSelection('missing-row', true, rows)).toEqual({ threadId: 'missing-row', sourceMessageId: '' });
    expect(listThreadSelection('thread-a', false, rows)).toEqual({ threadId: 'thread-a', sourceMessageId: null });
  });

  it('opens the workflow source for keyboard and pointer selection, not the latest message', async () => {
    mocks.folder = 'quotes';
    const latest = { id: 'newer-message', threadId: 'thread-a', sender: { name: 'Guest', email: 'guest@example.com' },
      subject: 'Request', body: '', tags: [], to: [], unread: false };
    mocks.useThread.mockReturnValue({ data: { latest, messages: [latest], labels: [], totalReplies: 0 }, isGroupThread: false, latestDraft: null });
    mocks.useThreads.mockReturnValue([
      { refetch: vi.fn(), isLoading: false, isFetching: false, isFetchingNextPage: false, hasNextPage: false, isError: false, error: null },
      [{ id: 'thread-a', workflowSourceMessageId: 'classified-source' }], false, vi.fn(),
      { isValid: true, folder: 'quotes', useDraftsList: false },
    ]);
    render(createElement(MailList));
    act(() => mocks.onNavigate?.('thread-a'));
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-a', sourceMessageId: 'classified-source' }));
    mocks.setMailSelection.mockClear();
    fireEvent.click(screen.getByText('Guest'));
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-a', sourceMessageId: 'classified-source' }));
  });

  it.each<[string, string, boolean, boolean]>([
    ['an invalid workflow search', 'quotes', false, false],
    ['an all-mail search with retained workflow rows', 'quotes', true, true],
    ['a route change with retained workflow rows', 'inbox', true, true],
  ])('keeps the classified source during %s', async (_label, folder, valid, placeholder) => {
    mocks.folder = folder;
    mocks.useThreads.mockReturnValue([
      { refetch: vi.fn(), isLoading: false, isFetching: false, isFetchingNextPage: false,
        hasNextPage: false, isError: false, error: null, isPlaceholderData: placeholder },
      [{ id: 'thread-a', workflowSourceMessageId: 'classified-source' }], false, vi.fn(),
      valid ? { isValid: true, folder: 'all', useDraftsList: false } : { isValid: false },
    ]);
    render(createElement(MailList));
    act(() => mocks.onNavigate?.('thread-a'));
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({
      threadId: 'thread-a', sourceMessageId: 'classified-source',
    }));
  });

  it.each(['keyboard', 'linked'])('captures the selected source before a pending %s draft save', async (kind) => {
    mocks.folder = 'quotes';
    mocks.linkedTarget = kind === 'linked' ? 'thread-a' : null;
    let finish!: () => void;
    registerComposeFlush(() => new Promise<void>((resolve) => { finish = resolve; }));
    const query = { refetch: vi.fn(), isLoading: false, isFetching: false, isFetchingNextPage: false,
      hasNextPage: false, isError: false, error: null };
    const search = { isValid: true, folder: 'quotes', useDraftsList: false };
    mocks.useThreads.mockReturnValue([query, [{ id: 'thread-a', workflowSourceMessageId: 'original' }], false, vi.fn(), search]);
    const view = render(createElement(MailList));
    if (kind === 'linked') fireEvent.click(screen.getByRole('button', { name: 'Linked thread' }));
    else act(() => mocks.onNavigate?.('thread-a'));
    expect(mocks.setMailSelection).not.toHaveBeenCalled();
    mocks.useThreads.mockReturnValue([query, [{ id: 'thread-a', workflowSourceMessageId: 'replacement' }], false, vi.fn(), search]);
    view.rerender(createElement(MailList));
    await act(async () => { finish(); });
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-a', sourceMessageId: 'original' }));
  });

  it.each(['keyboard', 'linked', 'pointer'])('keeps the composer open after a failed %s navigation save', async (kind) => {
    mocks.folder = 'quotes';
    mocks.linkedTarget = kind === 'linked' ? 'thread-a' : null;
    const checkDirty = vi.fn(() => true);
    registerComposeFlush(async () => {}); // The real failed save returns without clearing its dirty revision.
    registerComposeUnsavedCheck(checkDirty);
    const latest = { id: 'newer-message', threadId: 'thread-a', sender: { name: 'Guest', email: 'guest@example.com' },
      subject: 'Request', body: '', tags: [], to: [], unread: false };
    mocks.useThread.mockReturnValue({ data: { latest, messages: [latest], labels: [], totalReplies: 0 }, isGroupThread: false, latestDraft: null });
    mocks.useThreads.mockReturnValue([
      { refetch: vi.fn(), isLoading: false, isFetching: false, isFetchingNextPage: false, hasNextPage: false, isError: false, error: null },
      [{ id: 'thread-a', workflowSourceMessageId: 'classified-source' }], false, vi.fn(),
      { isValid: true, folder: 'quotes', useDraftsList: false },
    ]);
    render(createElement(MailList));
    if (kind === 'linked') fireEvent.click(screen.getByRole('button', { name: 'Linked thread' }));
    else if (kind === 'pointer') fireEvent.click(screen.getByText('Guest'));
    else act(() => mocks.onNavigate?.('thread-a'));
    await waitFor(() => expect(checkDirty).toHaveBeenCalled());
    expect(mocks.setMailSelection).not.toHaveBeenCalled();
  });

  it('opens the exact source carried by a linked workflow stub', async () => {
    mocks.folder = 'quotes';
    mocks.linkedTarget = 'thread-b';
    mocks.useThreads.mockReturnValue([
      { refetch: vi.fn(), isLoading: false, isFetching: false, isFetchingNextPage: false, hasNextPage: false, isError: false, error: null },
      [{ id: 'thread-a', workflowSourceMessageId: 'source-a', linkedStubs: [{ threadId: 'thread-b', workflowSourceMessageId: 'source-b' }] }],
      false, vi.fn(), { isValid: true, folder: 'quotes', useDraftsList: false },
    ]);
    render(createElement(MailList));
    fireEvent.click(screen.getByRole('button', { name: 'Linked thread' }));
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: 'source-b' }));
  });

  it('does not infer a missing workflow source for keyboard navigation', async () => {
    mocks.folder = 'quotes';
    mocks.useThreads.mockReturnValue([
      { refetch: vi.fn(), isLoading: false, isFetching: false, isFetchingNextPage: false, hasNextPage: false, isError: false, error: null },
      [], true, vi.fn(), { isValid: true, folder: 'quotes', useDraftsList: false },
    ]);
    render(createElement(MailList));
    act(() => mocks.onNavigate?.('thread-without-row'));
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({ threadId: 'thread-without-row', sourceMessageId: '' }));
  });

  it('clears the old source message when keyboard navigation opens another thread', async () => {
    render(createElement(MailList));
    expect(mocks.onNavigate).not.toBeNull();
    act(() => mocks.onNavigate?.('new-thread'));
    await waitFor(() => expect(mocks.setMailSelection).toHaveBeenCalledWith({
      threadId: 'new-thread', sourceMessageId: null,
    }));
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
