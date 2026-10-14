import type { MailListThreadRow } from '@/types';

export type ConversationAwareListThread = MailListThreadRow & {
  primaryThreadId?: string | null;
  linkedThreadIds?: readonly string[];
  conversationId?: string;
  conversationResponded?: boolean;
  conversationMessageCount?: number;
  subject?: string | null;
  snippet?: string | null;
};

export type LinkedThreadStub = {
  threadId: string;
  label: string;
  latestMessageAt?: string | Date | null;
};

export type PrimaryConversationListRow = ConversationAwareListThread & {
  linkedStubs: LinkedThreadStub[];
};

function stubLabel(thread: ConversationAwareListThread | undefined): string {
  const subject = thread?.subject?.trim();
  if (subject) return subject;
  const snippet = thread?.snippet?.trim();
  if (snippet) return snippet;
  return 'Linked thread';
}

/** Show one row per conversation, falling back when its primary is outside the result set. */
export function buildConversationPrimaryListRows(
  threads: readonly ConversationAwareListThread[],
): PrimaryConversationListRow[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const firstVisibleThreadByPrimaryId = new Map<string, string>();
  const primaryRows: PrimaryConversationListRow[] = [];

  for (const thread of threads) {
    const primaryId = thread.primaryThreadId ?? thread.id;
    if (!byId.has(primaryId) && !firstVisibleThreadByPrimaryId.has(primaryId)) {
      firstVisibleThreadByPrimaryId.set(primaryId, thread.id);
    }
  }

  for (const thread of threads) {
    const primaryId = thread.primaryThreadId ?? thread.id;
    const visiblePrimaryId = byId.has(primaryId)
      ? primaryId
      : firstVisibleThreadByPrimaryId.get(primaryId);
    if (thread.id !== visiblePrimaryId) continue;

    const linkedStubs: LinkedThreadStub[] = (thread.linkedThreadIds ?? []).map((linkedId) => {
      const linked = byId.get(linkedId);
      return {
        threadId: linkedId,
        label: stubLabel(linked),
        latestMessageAt: linked?.latestMessageAt ?? linked?.receivedOn ?? null,
      };
    });

    primaryRows.push({ ...thread, linkedStubs });
  }

  return primaryRows;
}

export function conversationListRowKey(row: ConversationAwareListThread): string {
  return row.conversationId ?? row.id;
}
