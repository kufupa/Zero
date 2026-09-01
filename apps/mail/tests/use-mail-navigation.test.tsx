/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusedIndexAtom, useMailNavigation } from '../hooks/use-mail-navigation';

const mocks = vi.hoisted(() => ({
  hotkeys: new Map<string, (...args: unknown[]) => void>(),
  onNavigate: vi.fn(),
  handleMouseEnter: null as null | ((threadId: string) => void),
}));

vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: (keys: string, callback: (...args: unknown[]) => void) => {
    mocks.hotkeys.set(keys, callback);
  },
}));

vi.mock('nuqs', () => ({
  useQueryState: () => [null, vi.fn()],
}));

vi.mock('../hooks/use-optimistic-actions', () => ({
  useOptimisticActions: () => ({ optimisticMarkAsRead: vi.fn() }),
}));

vi.mock('../components/mail/use-mail', () => ({
  useMail: () => [{ bulkSelected: [] }, vi.fn()],
}));

type Item = { id: string };

function NavigationHarness({ items, showSecond = true }: { items: Item[]; showSecond?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const navigation = useMailNavigation({
    items,
    containerRef,
    onNavigate: mocks.onNavigate,
  });
  mocks.handleMouseEnter = navigation.handleMouseEnter;

  return (
    <div ref={containerRef}>
      <div data-thread-id={items[0]?.id} tabIndex={0} data-testid="row-0" />
      {showSecond && items[1] ? (
        <div data-thread-id={items[1].id} tabIndex={0} data-testid="row-1" />
      ) : null}
      <output data-testid="keyboard-active">{String(navigation.keyboardActive)}</output>
      <output data-testid="focused-index">{String(navigation.focusedIndex)}</output>
    </div>
  );
}

function renderNavigation(
  items: Item[] = [{ id: 'thread-a' }, { id: 'thread-b' }],
  showSecond = true,
  initialFocusedIndex: number | null = 0,
) {
  const store = createStore();
  store.set(focusedIndexAtom, initialFocusedIndex);
  const result = render(
    <Provider store={store}>
      <NavigationHarness items={items} showSecond={showSecond} />
    </Provider>,
  );
  return { ...result, store };
}

function invokeHotkey(key: string) {
  const callback = mocks.hotkeys.get(key);
  if (!callback) throw new Error(`No hotkey callback registered for ${key}`);
  act(() => callback(new KeyboardEvent('keydown', { key })));
}

beforeEach(() => {
  mocks.hotkeys.clear();
  mocks.onNavigate.mockReset();
  mocks.handleMouseEnter = null;
  if (!HTMLElement.prototype.scrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    });
  }
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useMailNavigation focus handoff', () => {
  it('moves DOM focus from the clicked row to the keyboard-selected row', async () => {
    renderNavigation();
    const firstRow = screen.getByTestId('row-0');
    const secondRow = screen.getByTestId('row-1');
    const focus = vi.spyOn(secondRow, 'focus');
    firstRow.focus();

    invokeHotkey('ArrowDown');

    await waitFor(() => expect(document.activeElement).toBe(secondRow));
    expect(document.activeElement).not.toBe(firstRow);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(screen.getByTestId('keyboard-active').textContent).toBe('true');
  });

  it('retries focus when the virtualized target mounts after the index changes', async () => {
    const rendered = renderNavigation([{ id: 'thread-a' }, { id: 'thread-b' }], false);
    screen.getByTestId('row-0').focus();

    invokeHotkey('ArrowDown');
    expect(screen.getByTestId('focused-index').textContent).toBe('1');

    rendered.rerender(
      <Provider store={rendered.store}>
        <NavigationHarness items={[{ id: 'thread-a' }, { id: 'thread-b' }]} showSecond />
      </Provider>,
    );

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('row-1')));
  });

  it('re-focuses a replacement row when the focused index keeps the same number', async () => {
    const rendered = renderNavigation();
    screen.getByTestId('row-0').focus();
    invokeHotkey('ArrowDown');

    rendered.rerender(
      <Provider store={rendered.store}>
        <NavigationHarness items={[{ id: 'thread-a' }, { id: 'thread-c' }]} />
      </Provider>,
    );

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('row-1')));
    expect(screen.getByTestId('row-1').getAttribute('data-thread-id')).toBe('thread-c');
  });

  it('clears keyboard mode on Escape and pointer navigation', () => {
    renderNavigation();
    invokeHotkey('ArrowDown');
    expect(screen.getByTestId('keyboard-active').textContent).toBe('true');

    invokeHotkey('Escape');
    expect(screen.getByTestId('keyboard-active').textContent).toBe('false');

    invokeHotkey('ArrowDown');
    expect(screen.getByTestId('keyboard-active').textContent).toBe('true');

    act(() => mocks.handleMouseEnter?.('thread-b'));
    expect(screen.getByTestId('keyboard-active').textContent).toBe('false');
  });
});
