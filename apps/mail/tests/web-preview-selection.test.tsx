/** @vitest-environment happy-dom */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWebPreview } from '@/lib/workstation/web-pane-bridge';

const mocks = vi.hoisted(() => ({
  thread: { data: undefined as unknown, isError: false, isThreadDataMismatch: false },
}));
vi.mock('@/hooks/use-threads', () => ({ useThread: () => mocks.thread }));
vi.mock('@/hooks/use-connections', () => ({
  useActiveConnection: () => ({ data: { id: 'mailbox-1', email: 'staff@example.com' } }),
}));

function stored(id: string, threadId: string) {
  return {
    id, threadId, direction: 'inbound', isDraft: false, subject: id, body: id,
    processedHtml: `<p>${id}</p>`, messageId: `<${id}@example.com>`,
    sender: { name: 'Guest', email: 'guest@example.com' }, to: [{ email: 'staff@example.com' }],
    cc: null, receivedOn: '2026-11-01T12:00:00Z',
  };
}

describe('web preview selection during thread changes', () => {
  it('never returns a previous thread or late response as the selected message', () => {
    mocks.thread = { data: { transportId: 'mailbox-1', messages: [stored('a', 'thread-a')] }, isError: false, isThreadDataMismatch: false };
    const { result, rerender } = renderHook(
      ({ threadId, sourceMessageId }) => useWebPreview({ threadId, sourceMessageId, requireSelectedMessage: true }),
      { initialProps: { threadId: 'thread-a', sourceMessageId: 'a' } },
    );
    expect(result.current.bridge.activeEmail?.entryId).toBe('a');

    mocks.thread = { ...mocks.thread, isThreadDataMismatch: true };
    rerender({ threadId: 'thread-b', sourceMessageId: 'b' });
    expect(result.current.selection.status).toBe('loading');
    expect(result.current.bridge.activeEmail).toBeNull();

    mocks.thread = { data: { transportId: 'mailbox-1', messages: [stored('b', 'thread-b')] }, isError: false, isThreadDataMismatch: false };
    rerender({ threadId: 'thread-b', sourceMessageId: 'b' });
    expect(result.current.bridge.activeEmail?.entryId).toBe('b');

    // A late A payload cannot substitute for B, even if a caller fails to mark it stale.
    mocks.thread = { data: { transportId: 'mailbox-1', messages: [stored('a', 'thread-a')] }, isError: false, isThreadDataMismatch: false };
    rerender({ threadId: 'thread-b', sourceMessageId: 'b' });
    expect(result.current.selection).toEqual({ status: 'unsynced', reason: 'source_message_unavailable' });
    expect(result.current.bridge.activeEmail).toBeNull();

    mocks.thread = { data: { transportId: 'other-mailbox', messages: [stored('b', 'thread-b')] }, isError: false, isThreadDataMismatch: false };
    rerender({ threadId: 'thread-b', sourceMessageId: 'b' });
    expect(result.current.selection).toEqual({ status: 'unsynced', reason: 'source_message_unavailable' });
    expect(result.current.bridge.activeEmail).toBeNull();
  });
});
