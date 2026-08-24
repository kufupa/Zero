/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { Provider, useAtomValue } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailSearchBar } from '../components/mail/mail-search-bar';
import { mailSearchBarFocusedAtom, useSearchValue } from '../hooks/use-search-value';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

function SearchValueProbe() {
  const [state] = useSearchValue();
  return <output data-testid="committed">{state.value}</output>;
}

function SearchFocusProbe() {
  const focused = useAtomValue(mailSearchBarFocusedAtom);
  return <output data-testid="search-focused">{String(focused)}</output>;
}

function renderMailSearchBar() {
  return render(
    <Provider>
      <MailSearchBar folderTitle="Inbox" />
      <SearchValueProbe />
      <SearchFocusProbe />
    </Provider>,
  );
}

function openMenu(name: string) {
  const trigger = screen.getByRole('button', { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('MailSearchBar', () => {
  it('renders a search input and does not show command items', () => {
    renderMailSearchBar();

    expect(screen.getByRole('searchbox', { name: /search mail/i })).toBeTruthy();
    expect(screen.queryByText('Compose Email')).toBeNull();
    expect(screen.queryByText('Search Emails')).toBeNull();
    expect(screen.queryByText('Try Natural Language')).toBeNull();
  });

  it('toggles unread without committing free text', () => {
    renderMailSearchBar();

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
    renderMailSearchBar();

    openMenu('Inbox');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'All folders' }));

    expect(screen.getByRole('button', { name: 'All folders' })).toBeTruthy();
  });

  it('keeps typed text local until Enter', () => {
    renderMailSearchBar();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.change(input, { target: { value: 'deposit' } });

    expect(screen.getByTestId('committed').textContent).toBe('');

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(screen.getByTestId('committed').textContent).toBe('deposit');
  });

  it('opens recents with ArrowDown and applies highlighted recent on Enter', () => {
    localStorage.setItem('mail-recent-searches', JSON.stringify(['invoice']));
    renderMailSearchBar();
    const input = screen.getByRole('searchbox', { name: /search mail/i });

    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });

    expect(screen.getByRole('option', { name: 'invoice' })).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(screen.getByTestId('committed').textContent).toBe('invoice');
  });

  it('tracks input focus and supports Command or Control K', () => {
    renderMailSearchBar();
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

  it('rejects an over-limit committed query without truncating it', () => {
    renderMailSearchBar();
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
    renderMailSearchBar();
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
});
