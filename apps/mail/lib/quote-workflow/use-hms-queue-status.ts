import { useEffect, useRef, useState } from 'react';
import type { QueueStatus } from './types';

/** Poll cadence while a staff quote run is pending. */
export const HMS_QUEUE_POLL_MS = 3_000;

/**
 * Polls the staff quote run status every 3 s while `pending` is true. The first
 * read starts at once. Polling stops when `pending` turns false (the run settled)
 * or the host unmounts, and a read that lands after that is dropped.
 */
export function useHmsQueueStatus(input: {
  pending: boolean;
  fetchStatus: () => Promise<QueueStatus | null>;
}): QueueStatus | null {
  const { pending } = input;
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const fetchRef = useRef(input.fetchStatus);
  useEffect(() => {
    fetchRef.current = input.fetchStatus;
  });

  useEffect(() => {
    setStatus(null);
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let next: QueueStatus | null = null;
      try {
        next = await fetchRef.current();
      } catch {
        next = null;
      }
      if (stopped) return;
      if (next) setStatus(next);
      timer = setTimeout(poll, HMS_QUEUE_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending]);

  return status;
}
