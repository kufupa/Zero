import { describe, expect, it } from 'vitest';
import {
  buildConversationPrimaryListRows,
  conversationListRowKey,
  type ConversationAwareListThread,
} from '../lib/mail/conversation-list';

function row(
  id: string,
  overrides: Partial<ConversationAwareListThread> = {},
): ConversationAwareListThread {
  return {
    id,
    receivedOn: '2026-04-13T10:00:00.000Z',
    latestMessageAt: '2026-04-13T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildConversationPrimaryListRows', () => {
  it('keeps standalone threads and drops non-primary linked duplicates', () => {
    const threads = [
      row('primary', {
        conversationId: 'conv-1',
        primaryThreadId: 'primary',
        linkedThreadIds: ['linked'],
        subject: 'Primary subject',
      }),
      row('linked', {
        conversationId: 'conv-1',
        primaryThreadId: 'primary',
        linkedThreadIds: ['primary'],
        subject: 'Linked subject',
        latestMessageAt: '2026-04-12T10:00:00.000Z',
      }),
      row('solo', { conversationId: 'conv-2', primaryThreadId: 'solo' }),
    ];

    const primaryRows = buildConversationPrimaryListRows(threads);
    expect(primaryRows.map((entry) => entry.id)).toEqual(['primary', 'solo']);
  });

  it('keeps a workflow-matching linked thread when its primary is outside results', () => {
    const threads = [
      row('workflow-thread-b', {
        conversationId: 'conv-1',
        primaryThreadId: 'newer-thread-a',
        linkedThreadIds: ['newer-thread-a'],
        subject: 'Workflow thread B',
      }),
    ];

    expect(buildConversationPrimaryListRows(threads).map((entry) => entry.id)).toEqual([
      'workflow-thread-b',
    ]);
  });

  it('builds linked stubs from hidden sibling rows', () => {
    const threads = [
      row('primary', {
        conversationId: 'conv-1',
        primaryThreadId: 'primary',
        linkedThreadIds: ['linked'],
        conversationResponded: true,
        conversationMessageCount: 4,
      }),
      row('linked', {
        conversationId: 'conv-1',
        primaryThreadId: 'primary',
        linkedThreadIds: ['primary'],
        subject: 'Earlier thread subject',
        latestMessageAt: '2026-04-11T08:00:00.000Z',
      }),
    ];

    const [primary] = buildConversationPrimaryListRows(threads);
    expect(primary?.linkedStubs).toEqual([
      {
        threadId: 'linked',
        label: 'Earlier thread subject',
        latestMessageAt: '2026-04-11T08:00:00.000Z',
      },
    ]);
    expect(primary?.conversationResponded).toBe(true);
    expect(primary?.conversationMessageCount).toBe(4);
  });
});

describe('conversationListRowKey', () => {
  it('prefers conversationId over thread id', () => {
    expect(conversationListRowKey(row('thread-a', { conversationId: 'conv-1' }))).toBe('conv-1');
    expect(conversationListRowKey(row('thread-a'))).toBe('thread-a');
  });
});
