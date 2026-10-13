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

export type PrimaryConversationListRow<
  T extends ConversationAwareListThread = ConversationAwareListThread,
> = T & {
  linkedStubs: LinkedThreadStub[];
};

function stubLabel(thread: ConversationAwareListThread | undefined): string {
  const subject = thread?.subject?.trim();
  if (subject) return subject;
  const snippet = thread?.snippet?.trim();
  if (snippet) return snippet;
  return 'Linked thread';
}

/** Hide non-primary linked threads; attach stub metadata from the full page set. */
export function buildConversationPrimaryListRows<T extends ConversationAwareListThread>(
  threads: readonly T[],
): PrimaryConversationListRow<T>[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const primaryRows: PrimaryConversationListRow<T>[] = [];

  for (const thread of threads) {
    const primaryId = thread.primaryThreadId ?? thread.id;
    if (thread.id !== primaryId) continue;

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
