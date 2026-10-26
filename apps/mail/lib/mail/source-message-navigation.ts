import { useEffect, useRef } from 'react';

export function useExactSourceMessageSelection<T extends { id: string }>(
  sourceMessageId: string | null | undefined,
  messages: readonly T[],
) {
  const selectedMessageRef = useRef<HTMLDivElement>(null);
  const lastFocusedSourceMessageId = useRef<string | null>(null);

  useEffect(() => {
    if (!sourceMessageId) {
      lastFocusedSourceMessageId.current = null;
      return;
    }
    if (
      lastFocusedSourceMessageId.current === sourceMessageId ||
      !messages.some((message) => message.id === sourceMessageId)
    ) {
      return;
    }
    const selectedMessage = selectedMessageRef.current;
    if (!selectedMessage) return;
    lastFocusedSourceMessageId.current = sourceMessageId;
    selectedMessage.focus({ preventScroll: true });
    selectedMessage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [messages, sourceMessageId]);

  return selectedMessageRef;
}

export function shouldSuppressLatestAutoScroll(sourceMessageId: string | null | undefined): boolean {
  return Boolean(sourceMessageId);
}

export function shouldAutoScrollToLatestMessage({
  demo,
  suppressLatestAutoScroll,
  isLastEmail,
  totalEmails,
}: {
  demo?: boolean;
  suppressLatestAutoScroll?: boolean;
  isLastEmail: boolean;
  totalEmails?: number;
}): boolean {
  return (
    !demo &&
    !suppressLatestAutoScroll &&
    isLastEmail &&
    Boolean(totalEmails && totalEmails > 5)
  );
}
