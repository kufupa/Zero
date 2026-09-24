/**
 * @vitest-environment happy-dom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enhancedKeyboardShortcuts } from '../config/shortcuts';
import { ThreadDisplayHotkeys } from '../lib/hotkeys/thread-display-hotkeys';

const mocks = vi.hoisted(() => ({
  capturedHandlers: {} as Record<string, () => void>,
  setMail: vi.fn(),
  mailState: { bulkSelected: [] as string[] },
  threads: [{ id: 'thread-1' }, { id: 'thread-2' }],
}));

vi.mock('../lib/hotkeys/use-hotkey-utils', () => ({
  useShortcuts: (
    _shortcuts: unknown,
    handlers: Record<string, () => void>,
  ) => {
    mocks.capturedHandlers = handlers;
  },
}));

vi.mock('@/components/mail/use-mail', () => ({
  useMail: () => [mocks.mailState, mocks.setMail],
}));

vi.mock('@/hooks/use-threads', () => ({
  useThreads: () => [{}, mocks.threads],
  useThread: () => ({ data: null }),
}));

vi.mock('@/hooks/driver/use-delete', () => ({
  default: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/driver/use-move-to', () => ({
  default: () => ({ mutate: vi.fn() }),
}));

vi.mock('react-router', () => ({
  useParams: () => ({ folder: 'inbox' }),
}));

vi.mock('nuqs', () => ({
  useQueryState: () => [null, vi.fn()],
  useQueryStates: () => [{}, vi.fn()],
  parseAsString: {},
}));

vi.mock('jotai', () => ({
  useSetAtom: () => vi.fn(),
  atom: () => ({}),
}));

beforeEach(() => {
  mocks.capturedHandlers = {};
  mocks.setMail.mockClear();
  mocks.mailState = { bulkSelected: [] };
  mocks.threads = [{ id: 'thread-1' }, { id: 'thread-2' }];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Ctrl + A Shortcut Configuration', () => {
  it('registers selectAll in both mail-list and thread-display scopes', () => {
    const threadDisplaySelectAll = enhancedKeyboardShortcuts.find(
      (s) => s.scope === 'thread-display' && s.action === 'selectAll',
    );
    const mailListSelectAll = enhancedKeyboardShortcuts.find(
      (s) => s.scope === 'mail-list' && s.action === 'selectAll',
    );

    expect(mailListSelectAll).toBeDefined();
    expect(mailListSelectAll?.keys).toEqual(['mod', 'a']);

    expect(threadDisplaySelectAll).toBeDefined();
    expect(threadDisplaySelectAll?.keys).toEqual(['mod', 'a']);
    expect(threadDisplaySelectAll?.preventDefault).toBe(true);
  });

  it('ThreadDisplayHotkeys provides selectAll handler that selects all loaded threads', () => {
    render(<ThreadDisplayHotkeys />);

    expect(mocks.capturedHandlers.selectAll).toBeDefined();

    // Trigger selectAll when no threads are bulkSelected
    mocks.capturedHandlers.selectAll();

    expect(mocks.setMail).toHaveBeenCalled();
    const updateFn = mocks.setMail.mock.calls[0][0];
    const nextState = updateFn({ bulkSelected: [] });
    expect(nextState.bulkSelected).toEqual(['thread-1', 'thread-2']);
  });

  it('ThreadDisplayHotkeys selectAll deselects all when threads are already selected', () => {
    mocks.mailState = { bulkSelected: ['thread-1', 'thread-2'] };
    render(<ThreadDisplayHotkeys />);

    expect(mocks.capturedHandlers.selectAll).toBeDefined();

    // Trigger selectAll when threads are already bulkSelected
    mocks.capturedHandlers.selectAll();

    expect(mocks.setMail).toHaveBeenCalled();
    const updateFn = mocks.setMail.mock.calls[0][0];
    const nextState = updateFn({ bulkSelected: ['thread-1', 'thread-2'] });
    expect(nextState.bulkSelected).toEqual([]);
  });

  describe('resolveActiveMailScope', () => {
    it('returns mail-list when no email is open', async () => {
      const { resolveActiveMailScope } = await import('../lib/mail/mail-panel-visibility');
      expect(
        resolveActiveMailScope({
          hasBulkSelection: false,
          threadId: null,
          isWideSplit: true,
          listCollapsed: false,
        }),
      ).toBe('mail-list');
    });

    it('returns thread-display when an email is open with no bulk selection', async () => {
      const { resolveActiveMailScope } = await import('../lib/mail/mail-panel-visibility');
      expect(
        resolveActiveMailScope({
          hasBulkSelection: false,
          threadId: 'thread-123',
          isWideSplit: true,
          listCollapsed: false,
        }),
      ).toBe('thread-display');
    });

    it('prioritizes mail-list scope when bulk selection is active even with open thread', async () => {
      const { resolveActiveMailScope } = await import('../lib/mail/mail-panel-visibility');
      expect(
        resolveActiveMailScope({
          hasBulkSelection: true,
          threadId: 'thread-123',
          isWideSplit: true,
          listCollapsed: false,
        }),
      ).toBe('mail-list');
    });
  });
});
