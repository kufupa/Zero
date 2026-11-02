/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ selection: vi.fn(), compose: vi.fn() }));
vi.mock('../components/ui/context-menu', () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    ContextMenu: Wrap, ContextMenuContent: Wrap, ContextMenuSeparator: Wrap,
    ContextMenuShortcut: Wrap, ContextMenuSub: Wrap, ContextMenuSubContent: Wrap,
    ContextMenuSubTrigger: Wrap, ContextMenuTrigger: Wrap,
    ContextMenuItem: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) =>
      <button onClick={onClick} disabled={disabled}>{children}</button>,
  };
});
vi.mock('@/components/labels/label-dialog', () => ({ LabelDialog: () => null }));
vi.mock('@/components/mail/snooze-dialog', () => ({ SnoozeDialog: () => null }));
vi.mock('@/components/mail/optimistic-thread-state', () => ({ useOptimisticThreadState: () => ({ optimisticStarred: null, optimisticImportant: null }) }));
vi.mock('@/hooks/use-threads', () => ({
  useThreads: () => [{ isLoading: false, isFetching: false, refetch: vi.fn() }],
  useThread: () => ({ data: { latest: { id: 'newest-message' }, messages: [], hasUnread: false } }),
}));
vi.mock('@/hooks/use-labels', () => ({ useLabels: () => ({ userLabels: [], refetch: vi.fn() }) }));
vi.mock('@/hooks/use-optimistic-actions', () => ({ useOptimisticActions: () => ({}) }));
vi.mock('@/components/mail/use-mail', () => ({ useMail: () => [{ bulkSelected: [] }, vi.fn()] }));
vi.mock('@/providers/query-provider', () => ({ useTRPC: () => ({
  mail: { delete: { mutationOptions: () => ({}) } }, labels: { create: { mutationOptions: () => ({}) } },
}) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('react-router', () => ({ useParams: () => ({ folder: 'quotes' }) }));
vi.mock('nuqs', () => ({
  parseAsString: {}, useQueryState: () => [null, vi.fn()],
  useQueryStates: (keys: Record<string, unknown>) => [null, 'threadId' in keys ? mocks.selection : vi.fn()],
}));
vi.mock('@/paraglide/messages', () => ({ m: new Proxy({}, { get: (_target, key) => () => String(key) }) }));
vi.mock('@/lib/mail/reply-compose-context', () => ({ openReplyComposeContext: (...args: unknown[]) => mocks.compose(...args) }));

import { ThreadContextMenu } from '../components/context/thread-context';

beforeEach(() => { mocks.selection.mockClear(); mocks.compose.mockReset(); mocks.compose.mockResolvedValue(undefined); });
afterEach(cleanup);

describe('context menu source selection', () => {
  it.each([
    ['common.mail.reply', 'reply'],
    ['common.mail.replyAll', 'replyAll'],
    ['common.mail.forward', 'forward'],
  ])('binds %s to the selected row source', (label, mode) => {
    render(<ThreadContextMenu threadId="thread-b" sourceMessageId="source-b"><span>Row</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(mocks.selection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: 'source-b' });
    expect(mocks.compose).toHaveBeenCalledWith(expect.objectContaining({ mode, messageId: 'newest-message' }));
  });

  it('clears stale source for ordinary thread reply', () => {
    render(<ThreadContextMenu threadId="thread-b"><span>Row</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: 'common.mail.reply' }));
    expect(mocks.selection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: null });
  });

  it('preserves exact source in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<ThreadContextMenu threadId="thread-b" sourceMessageId="source-b"><span>Row</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: 'common.mail.openInNewTab' }));
    expect(open).toHaveBeenCalledWith('/mail/quotes?threadId=thread-b&sourceMessageId=source-b', '_blank');
    open.mockRestore();
  });
});
