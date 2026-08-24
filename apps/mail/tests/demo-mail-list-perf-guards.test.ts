/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailList, areMailLabelsEqual } from '../components/mail/mail-list';
import { EMPTY_SEARCH_VALUE, unreadFilter, type SearchValueState } from '../lib/mail/search-list';

const mocks = vi.hoisted(() => ({
  searchValue: null as unknown as SearchValueState,
  setSearchValue: vi.fn(),
  useThreads: vi.fn(),
}));

vi.mock('@/hooks/use-search-value', () => ({
  useSearchValue: () => [mocks.searchValue, mocks.setSearchValue],
}));

vi.mock('@/hooks/use-threads', () => ({
  useThreads: () => mocks.useThreads(),
}));

vi.mock('@/hooks/use-mail-navigation', async () => {
  const { atom } = await import('jotai');
  return {
    focusedIndexAtom: atom<number | null>(null),
    useMailNavigation: () => ({
      focusedIndex: null,
      handleMouseEnter: vi.fn(),
      keyboardActive: false,
    }),
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
  useParams: () => ({ folder: 'inbox' }),
}));

vi.mock('nuqs', () => ({
  useQueryState: () => [null, vi.fn()],
}));

vi.mock('@/components/icons/empty-state-svg', () => ({
  EmptyStateIcon: () => null,
}));

type MemoExoticComponent = typeof MailList & {
  compare: null | ((prev: unknown, next: unknown) => boolean);
};

beforeEach(() => {
  mocks.searchValue = {
    ...EMPTY_SEARCH_VALUE,
    value: 'deposit',
    highlight: 'deposit',
    filters: [unreadFilter()],
  };
  mocks.setSearchValue.mockClear();
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
  it('shows effective query miss copy and preserves query state when trying all folders', () => {
    render(createElement(MailList));

    expect(screen.getByText('No emails match “deposit is:unread”')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try All folders' }));
    expect(mocks.setSearchValue).toHaveBeenCalledWith({
      ...mocks.searchValue,
      scope: 'all',
    });
  });

  it('clears a search miss with the empty search state', () => {
    render(createElement(MailList));

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(mocks.setSearchValue).toHaveBeenCalledWith(EMPTY_SEARCH_VALUE);
  });

  it('keeps folder-empty copy when effective query is empty', () => {
    mocks.searchValue = EMPTY_SEARCH_VALUE;

    render(createElement(MailList));

    expect(screen.getByText("It's empty here")).toBeTruthy();
    expect(screen.queryByText(/No emails match/)).toBeNull();
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
