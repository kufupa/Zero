/**
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { createStore, Provider, useAtomValue } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailSearchBar } from '../components/mail/mail-search-bar';
import { mailSearchBarFocusedAtom, useSearchValue } from '../hooks/use-search-value';
import {
  EMPTY_SEARCH_VALUE,
  saveRecentSearch,
  type SearchValueState,
  unreadFilter,
} from '../lib/mail/search-list';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  folder: 'inbox',
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

vi.mock('react-router', () => ({
  useParams: () => ({ folder: mocks.folder }),
}));

function SearchValueProbe() {
  const [state] = useSearchValue();
  return <output data-testid="committed">{state.value}</output>;
}

function SearchFocusProbe() {
  const focused = useAtomValue(mailSearchBarFocusedAtom);
  return <output data-testid="search-focused">{String(focused)}</output>;
}

function SearchValueInitializer({ state }: { state: SearchValueState }) {
  const [, setSearchValue] = useSearchValue();

  useEffect(() => {
    setSearchValue(state);
  }, [setSearchValue, state]);

  return null;
}

function ExternalSearchValueControls() {
  const [state, setSearchValue] = useSearchValue();

  return (
    <>
      <button type="button" onClick={() => setSearchValue({ ...state })}>
        Re-emit committed search
      </button>
      <button
        type="button"
        onClick={() =>
          setSearchValue({
            ...state,
            value: 'label:vip',
            highlight: 'label:vip',
          })
        }
      >
        Set external search
      </button>
      <button
        type="button"
        onClick={() =>
          setSearchValue({
            ...EMPTY_SEARCH_VALUE,
            resetVersion: state.resetVersion + 1,
          })
        }
      >
        Clear external search
      </button>
    </>
  );
}

function renderMailSearchBar({
  initialSearchValue,
  includeExternalControls = false,
  store = createStore(),
  folderTitle = 'Inbox',
}: {
  initialSearchValue?: SearchValueState;
  includeExternalControls?: boolean;
  store?: ReturnType<typeof createStore>;
  folderTitle?: string;
} = {}) {
  return {
    ...render(
      <Provider store={store}>
        {initialSearchValue && <SearchValueInitializer state={initialSearchValue} />}
        {includeExternalControls && <ExternalSearchValueControls />}
        <MailSearchBar folderTitle={folderTitle} />
        <SearchValueProbe />
        <SearchFocusProbe />
      </Provider>,
    ),
    store,
  };
}

function renderMailSearchBarWithoutControls(folderTitle = 'Inbox') {
  return render(
    <Provider>
      <MailSearchBar folderTitle={folderTitle} />
      <SearchValueProbe />
      <SearchFocusProbe />
    </Provider>,
  );
}

function openMenu(name: string) {
  const trigger = screen.getByRole('button', { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

function setMailScope(userId = 'user-one', activeTransportId = 'transport-one') {
  act(() => {
    setMailCacheScope({ userId, activeTransportId });
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  setMailCacheScope({ userId: null, activeTransportId: null });
  vi.clearAllMocks();
  mocks.folder = 'inbox';
});

describe('MailSearchBar', () => {
  it('renders a search input and does not show command items', () => {
    renderMailSearchBarWithoutControls();

    expect(screen.getByRole('searchbox', { name: /search mail/i })).toBeTruthy();
    expect(screen.queryByText('Compose Email')).toBeNull();
    expect(screen.queryByText(/Search\s+Emails/)).toBeNull();
    expect(screen.queryByText(/Try\s+Natural\s+Language/)).toBeNull();
  });

  it('toggles unread without committing free text', () => {
    renderMailSearchBarWithoutControls();

    openMenu('Filters');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unread' }));

    expect(screen.getByRole('button', { name: 'Remove Unread' })).toBeTruthy();
    expect(screen.getByTestId('committed').textContent).toBe('');

    openMenu('Filters');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unread' }));

    expect(screen.queryByRole('button', { name: 'Remove Unread' })).toBeNull();
    expect(screen.getByTestId('committed').textContent).toBe('');
  });

  it('switches scope to all folders', () => {
    renderMailSearchBarWithoutControls();

    openMenu('Inbox');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'All folders' }));

    expect(screen.getByRole('button', { name: 'All folders' })).toBeTruthy();
  });

  it('does not expose unsupported header filters in this-folder Drafts', () => {
    mocks.folder = 'draft';
    renderMailSearchBar({
      folderTitle: 'Drafts',
      initialSearchValue: {
        ...EMPTY_SEARCH_VALUE,
        filters: [unreadFilter()],
      },
    });

    expect((screen.getByRole('button', { name: 'Filters' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Remove Unread' })).toBeNull();
  });

  it('clears header filters when switching All folders back to Drafts', () => {
    mocks.folder = 'draft';
    renderMailSearchBar({
      folderTitle: 'Drafts',
      initialSearchValue: {
        ...EMPTY_SEARCH_VALUE,
        scope: 'all',
        filters: [unreadFilter()],
      },
    });

    expect(screen.getByRole('button', { name: 'Remove Unread' })).toBeTruthy();

    openMenu('All folders');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'This folder' }));

    expect(screen.queryByRole('button', { name: 'Remove Unread' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Filters' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps header filters available for All folders from Drafts', () => {
    mocks.folder = 'draft';
    renderMailSearchBar({
      folderTitle: 'Drafts',
      initialSearchValue: {
        ...EMPTY_SEARCH_VALUE,
        scope: 'all',
      },
    });

    openMenu('Filters');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unread' }));

    expect(screen.getByRole('button', { name: 'Remove Unread' })).toBeTruthy();
  });

  it('keeps typed text local until Enter', () => {
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.change(input, { target: { value: 'deposit' } });

    expect(screen.getByTestId('committed').textContent).toBe('');

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(screen.getByTestId('committed').textContent).toBe('deposit');
  });

  it('opens recents with ArrowDown and applies highlighted recent on Enter', () => {
    setMailScope();
    saveRecentSearch('invoice');
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });

    expect(screen.getByRole('option', { name: 'invoice' })).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(screen.getByTestId('committed').textContent).toBe('invoice');
  });

  it('tracks input focus and supports Command or Control K', () => {
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.focus(input);
    expect(screen.getByTestId('search-focused').textContent).toBe('true');

    fireEvent.blur(input);
    expect(screen.getByTestId('search-focused').textContent).toBe('false');

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    expect(document.activeElement).not.toBe(input);
  });

  it('keeps mailbox navigation guard active for search controls and open menus', () => {
    const { store } = renderMailSearchBar();

    openMenu('Inbox');
    expect(store.get(mailSearchBarFocusedAtom)).toBe(true);

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'This folder' }));
    openMenu('Filters');
    expect(store.get(mailSearchBarFocusedAtom)).toBe(true);
  });

  it('rejects an over-limit committed query without truncating it', () => {
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    const tooLong = 'x'.repeat(513);

    fireEvent.change(input, { target: { value: tooLong } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(screen.getByTestId('committed').textContent).toBe('');
    expect((input as HTMLInputElement).value).toBe(tooLong);
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Search query must be 512 characters or fewer.',
    );
  });

  it('rejects an over-limit filter chip without changing filters', () => {
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.change(input, { target: { value: 'x'.repeat(512) } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(screen.getByTestId('committed').textContent).toHaveLength(512);

    openMenu('Filters');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Unread' }));

    expect(screen.queryByRole('button', { name: 'Remove Unread' })).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Search query must be 512 characters or fewer.',
    );
  });

  it('clears uncommitted text after an explicit external reset', () => {
    renderMailSearchBar({ includeExternalControls: true });
    const input = screen.getByRole('searchbox', { name: /search mail/i }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'draft text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear external search' }));

    expect(input.value).toBe('');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(screen.getByTestId('committed').textContent).toBe('');
  });

  it('syncs local text only when an external committed value changes', () => {
    renderMailSearchBar({ includeExternalControls: true });
    const input = screen.getByRole('searchbox', { name: /search mail/i }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'draft text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Re-emit committed search' }));
    expect(input.value).toBe('draft text');

    fireEvent.click(screen.getByRole('button', { name: 'Set external search' }));
    expect(input.value).toBe('label:vip');

    fireEvent.click(screen.getByRole('button', { name: 'Clear external search' }));
    expect(input.value).toBe('');
  });

  it('resets focused atom when unmounted', () => {
    const store = createStore();
    const { unmount } = renderMailSearchBar({ store });
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.focus(input);
    expect(store.get(mailSearchBarFocusedAtom)).toBe(true);

    unmount();
    expect(store.get(mailSearchBarFocusedAtom)).toBe(false);
  });

  it('closes recents for controls and only exposes popup attributes while rendered', () => {
    setMailScope();
    saveRecentSearch('invoice');
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });
    const scopeButton = screen.getByRole('button', { name: 'Inbox' });

    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');

    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(input.getAttribute('aria-controls')).toBe('mail-search-suggestions');
    expect(input.getAttribute('aria-expanded')).toBe('true');

    fireEvent.blur(input, { relatedTarget: scopeButton });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a focused suggestion available until it applies', () => {
    setMailScope();
    saveRecentSearch('invoice');
    const { store } = renderMailSearchBar();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.focus(input);
    const suggestion = screen.getByRole('option', { name: 'invoice' });
    fireEvent.blur(input, { relatedTarget: suggestion });
    expect(store.get(mailSearchBarFocusedAtom)).toBe(true);
    fireEvent.click(suggestion);

    expect(screen.getByTestId('committed').textContent).toBe('invoice');
  });

  it('isolates recent suggestions across users and active transports', () => {
    setMailScope('user-one', 'transport-one');
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.change(input, { target: { value: 'first recent' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.focus(input);
    expect(screen.getByRole('option', { name: 'first recent' })).toBeTruthy();

    setMailScope('user-two', 'transport-one');
    expect(screen.queryByRole('option', { name: 'first recent' })).toBeNull();

    fireEvent.change(input, { target: { value: 'second recent' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.change(input, { target: { value: '' } });

    setMailScope('user-one', 'transport-one');
    fireEvent.focus(input);
    expect(screen.getByRole('option', { name: 'first recent' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'second recent' })).toBeNull();

    setMailScope('user-one', 'transport-two');
    expect(screen.queryByRole('option', { name: 'first recent' })).toBeNull();
  });

  it('does not render prior-mailbox recents during a synchronous scope transition', () => {
    setMailScope('user-one', 'transport-one');
    saveRecentSearch('private booking reference');
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.focus(input);
    expect(screen.getByRole('option', { name: 'private booking reference' })).toBeTruthy();

    flushSync(() => {
      setMailCacheScope({ userId: 'user-two', activeTransportId: 'transport-one' });
    });

    expect(screen.queryByRole('option', { name: 'private booking reference' })).toBeNull();
  });

  it('does not render prior-mailbox recents when user scope becomes incomplete', () => {
    setMailScope('user-one', 'transport-one');
    saveRecentSearch('private booking reference');
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.focus(input);
    expect(screen.getByRole('option', { name: 'private booking reference' })).toBeTruthy();

    flushSync(() => {
      setMailCacheScope({ userId: null, activeTransportId: 'transport-one' });
    });

    expect(screen.queryByRole('option', { name: 'private booking reference' })).toBeNull();
  });

  it('does not render prior-mailbox recents when transport scope becomes incomplete', () => {
    setMailScope('user-one', 'transport-one');
    saveRecentSearch('private booking reference');
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.focus(input);
    expect(screen.getByRole('option', { name: 'private booking reference' })).toBeTruthy();

    flushSync(() => {
      setMailCacheScope({ userId: 'user-one', activeTransportId: null });
    });

    expect(screen.queryByRole('option', { name: 'private booking reference' })).toBeNull();
  });

  it('removes legacy global recents without showing their terms', () => {
    localStorage.setItem('mail-recent-searches', JSON.stringify(['legacy recent']));
    renderMailSearchBarWithoutControls();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.focus(input);

    expect(screen.queryByRole('option', { name: 'legacy recent' })).toBeNull();
    expect(localStorage.getItem('mail-recent-searches')).toBeNull();
  });

  it('removes an existing date chip instead of replacing its old UTC token', () => {
    renderMailSearchBar({
      initialSearchValue: {
        ...EMPTY_SEARCH_VALUE,
        filters: [
          {
            type: 'date',
            value: 'after:2000/01/01',
            display: 'Last 7 days',
          },
        ],
      },
    });

    expect(screen.getByRole('button', { name: 'Remove Last 7 days' })).toBeTruthy();

    openMenu('Filters');
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Last 7 days' }));

    expect(screen.queryByRole('button', { name: 'Remove Last 7 days' })).toBeNull();
  });
});
