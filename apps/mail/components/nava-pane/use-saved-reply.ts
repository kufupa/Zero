import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewedReply } from './use-insert-ai-draft';

/** How often Outlook checks whether the thread's saved reply was saved, replaced or removed in webmail. */
export const SAVED_REPLY_REFRESH_MS = 30_000;

type SavedReplyRead = (input: { threadId: string }) => Promise<ReviewedReply | null>;

/**
 * The thread's saved reply (Save reply on the webmail panel), offered for Insert in Outlook. `available` drives the
 * button and is read again while the thread stays open, since webmail can save or replace it meanwhile. `readCurrent`
 * reads it at the moment of the click, so Insert never puts in an older copy.
 */
export function useSavedReply(read: SavedReplyRead, threadId: string | null) {
  const [available, setAvailable] = useState(false);
  const readRef = useRef(read);
  readRef.current = read;

  const readCurrent = useCallback(async (): Promise<ReviewedReply | null> => {
    if (!threadId) return null;
    const saved = await readRef.current({ threadId });
    return saved ? { html: saved.html, attachments: saved.attachments,
      ...(saved.quoteBound === undefined ? {} : { quoteBound: saved.quoteBound }) } : null;
  }, [threadId]);

  useEffect(() => {
    setAvailable(false);
    if (!threadId) return;
    let alive = true;
    const refresh = () =>
      readCurrent().then(
        (saved) => {
          if (alive) setAvailable(saved !== null);
        },
        // ponytail: a failed read hides Insert saved reply rather than showing an error. Insert draft still works.
        () => {
          if (alive) setAvailable(false);
        },
      );
    void refresh();
    const timer = setInterval(() => void refresh(), SAVED_REPLY_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [threadId, readCurrent]);

  return { available, readCurrent };
}
