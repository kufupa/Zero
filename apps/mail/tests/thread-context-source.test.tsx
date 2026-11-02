/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selection: vi.fn(), compose: vi.fn(), composeState: vi.fn(), error: vi.fn(),
  flush: vi.fn(), unsaved: vi.fn(),
  messages: [{ id: 'source-b', threadId: 'thread-b', isDraft: false }] as Array<{ id: string; threadId: string; isDraft: boolean }>,
}));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));
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
  useThread: () => ({ data: { latest: { id: 'newest-message' }, messages: mocks.messages, hasUnread: false } }),
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
  useQueryStates: (keys: Record<string, unknown>) => [null, 'threadId' in keys ? mocks.selection : mocks.composeState],
}));
vi.mock('@/paraglide/messages', () => ({ m: new Proxy({}, { get: (_target, key) => () => String(key) }) }));
vi.mock('@/lib/mail/reply-compose-context', () => ({ openReplyComposeContext: (...args: unknown[]) => mocks.compose(...args) }));
vi.mock('@/lib/mail/compose-flush-registry', () => ({
  flushComposeBeforeLeave: () => mocks.flush(), composeHasUnsavedChanges: () => mocks.unsaved(),
}));

import { ThreadContextMenu } from '../components/context/thread-context';

beforeEach(() => {
  mocks.selection.mockClear(); mocks.compose.mockReset(); mocks.compose.mockResolvedValue(undefined);
  mocks.error.mockClear(); mocks.composeState.mockClear(); mocks.flush.mockReset().mockResolvedValue(undefined);
  mocks.unsaved.mockReset().mockReturnValue(false); mocks.messages = [{ id: 'source-b', threadId: 'thread-b', isDraft: false }];
});
afterEach(cleanup);

describe('context menu source selection', () => {
  it.each([
    ['common.mail.reply', 'reply'],
    ['common.mail.replyAll', 'replyAll'],
    ['common.mail.forward', 'forward'],
  ])('binds %s to the selected row source', async (label, mode) => {
    render(<ThreadContextMenu threadId="thread-b" sourceMessageId="source-b"><span>Row</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(mocks.selection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: 'source-b' }));
    expect(mocks.compose).toHaveBeenCalledWith(expect.objectContaining({ mode, messageId: 'source-b' }));
  });

  it('clears stale source for ordinary thread reply', async () => {
    render(<ThreadContextMenu threadId="thread-b"><span>Row</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: 'common.mail.reply' }));
    await waitFor(() => expect(mocks.selection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: null }));
    expect(mocks.compose).toHaveBeenCalledWith(expect.objectContaining({ mode: 'reply', messageId: 'newest-message' }));
  });

  it.each<[string, Array<{ id: string; threadId: string; isDraft: boolean }>, string]>([
    ['missing', [], 'source-b'],
    ['blank', [], ''],
    ['wrong thread', [{ id: 'source-b', threadId: 'other', isDraft: false }], 'source-b'],
    ['draft', [{ id: 'source-b', threadId: 'thread-b', isDraft: true }], 'source-b'],
    ['duplicate', [{ id: 'source-b', threadId: 'thread-b', isDraft: false },
      { id: 'source-b', threadId: 'thread-b', isDraft: false }], 'source-b'],
  ])('does not open a reply to the latest message when the source is %s', async (_label, messages, source) => {
    mocks.messages = messages;
    render(<ThreadContextMenu threadId="thread-b" sourceMessageId={source}><span>Row</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: 'common.mail.reply' }));
    await waitFor(() => expect(mocks.selection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: source }));
    expect(mocks.compose).not.toHaveBeenCalled();
    expect(mocks.composeState).toHaveBeenCalledWith({ mode: null, activeReplyId: null, draftId: null });
    expect(mocks.error).toHaveBeenCalled();
  });

  it('saves the open composer before changing message or reply target', async () => {
    let finish!: () => void;
    mocks.flush.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<ThreadContextMenu threadId="thread-b" sourceMessageId="source-b"><span>Row</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: 'common.mail.reply' }));
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.selection).not.toHaveBeenCalled();
    expect(mocks.compose).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(mocks.selection).toHaveBeenCalledWith({ threadId: 'thread-b', sourceMessageId: 'source-b' });
    expect(mocks.compose).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'source-b' }));
  });

  it.each(['rejected', 'still dirty'])('keeps the current composer if saving is %s', async (failure) => {
    if (failure === 'rejected') mocks.flush.mockRejectedValue(new Error('save failed'));
    else mocks.unsaved.mockReturnValue(true);
    render(<ThreadContextMenu threadId="thread-b" sourceMessageId=""><span>Row</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: 'common.mail.reply' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.selection).not.toHaveBeenCalled();
    expect(mocks.composeState).not.toHaveBeenCalled();
    expect(mocks.compose).not.toHaveBeenCalled();
  });

  it('preserves exact source in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<ThreadContextMenu threadId="thread-b" sourceMessageId="source-b"><span>Row</span></ThreadContextMenu>);
    fireEvent.click(screen.getByRole('button', { name: 'common.mail.openInNewTab' }));
    expect(open).toHaveBeenCalledWith('/mail/quotes?threadId=thread-b&sourceMessageId=source-b', '_blank');
    open.mockRestore();
  });
});
