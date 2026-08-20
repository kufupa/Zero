import {
  resolveComposeCloseAction,
  type PersistDecisionInput,
} from '@/lib/mail/draft-persistence';

export type OpenThreadIdentity = {
  id?: string | null;
  latest?: { id?: string | null; threadId?: string | null } | null;
  messages?: Array<{ threadId?: string | null }> | null;
};

/**
 * Resolve the thread id for an open mail.get payload.
 * Never fall back to a message id — that falsely marks mismatch and blanks
 * the open thread (compose unmount / typing kick-out).
 */
export function resolveOpenThreadId(threadData: OpenThreadIdentity | undefined): string | undefined {
  if (!threadData) return undefined;
  if (threadData.id) return threadData.id;
  if (threadData.latest?.threadId) return threadData.latest.threadId;
  const fromMessages = threadData.messages?.find((message) => message.threadId)?.threadId;
  return fromMessages ?? undefined;
}

/** Blank open-thread UI only when we positively know data belongs to another thread. */
export function shouldBlankOpenThreadData(input: {
  requestedThreadId: string | null | undefined;
  resolvedThreadId: string | undefined;
}): boolean {
  if (!input.requestedThreadId || !input.resolvedThreadId) return false;
  return input.resolvedThreadId !== input.requestedThreadId;
}

/** Skeleton must not unmount a loaded composer during same-thread refetch. */
export function shouldShowOpenThreadSkeleton(input: {
  hasEmailData: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isThreadDataMismatch: boolean;
}): boolean {
  if (input.hasEmailData && !input.isThreadDataMismatch) return false;
  if (!input.hasEmailData && input.isLoading) return true;
  if (input.isFetching && input.isThreadDataMismatch && !input.hasEmailData) return true;
  return !input.hasEmailData;
}

export type ComposeEscapeAction = 'ignore' | 'closeSilent' | 'prompt';

/**
 * Escape while typing must not silent-kick after autosave cleared dirty.
 * IME composing Escape is ignored entirely.
 */
export function resolveComposeEscapeAction(
  input: PersistDecisionInput & { isComposing: boolean },
): ComposeEscapeAction {
  if (input.isComposing) return 'ignore';

  const closeAction = resolveComposeCloseAction({ ...input, intent: 'userClose' });
  if (closeAction === 'prompt') return 'prompt';

  // Autosave may have cleared dirty while the body still has real text.
  if (input.text.trim().length > 0 || input.subject.trim().length > 0 || input.to.length > 0) {
    return 'prompt';
  }

  return 'closeSilent';
}
