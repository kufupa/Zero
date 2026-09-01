/**
 * @vitest-environment happy-dom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enhancedKeyboardShortcuts } from '../config/shortcuts';
import { useShortcuts } from '../lib/hotkeys/use-hotkey-utils';

const mocks = vi.hoisted(() => ({
  useHotkeys: vi.fn(),
  handler: vi.fn(),
  callback: undefined as
    | undefined
    | ((
        event: KeyboardEvent,
        hotkeysEvent: { keys?: string[]; meta?: boolean; ctrl?: boolean },
      ) => void),
}));

vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: (...args: unknown[]) => mocks.useHotkeys(...args),
}));

function FocusSearchShortcutHarness() {
  const focusSearchShortcut = enhancedKeyboardShortcuts.filter(
    (shortcut) => shortcut.action === 'commandPalette',
  );
  useShortcuts(focusSearchShortcut, { commandPalette: mocks.handler }, { scope: 'global' });
  return null;
}

beforeEach(() => {
  mocks.handler.mockClear();
  mocks.callback = undefined;
  mocks.useHotkeys.mockImplementation(
    (
      _keys: string,
      callback: (
        event: KeyboardEvent,
        hotkeysEvent: { keys?: string[]; meta?: boolean; ctrl?: boolean },
      ) => void,
    ) => {
      mocks.callback = callback;
    },
  );
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('focus-search shortcut', () => {
  it('prevents browser Cmd/Ctrl+K without a mounted search input', () => {
    render(<FocusSearchShortcutHarness />);
    const event = new KeyboardEvent('keydown', { cancelable: true });

    mocks.callback?.(event, { keys: ['k'], ctrl: true });

    expect(mocks.handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
