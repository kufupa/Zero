import { Loader2 } from 'lucide-react';
import type { QueueStatus } from '@/lib/quote-workflow/types';

/** "45 s" under a minute, then "1 min 20 s". */
export function formatQueueElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/** Status line under the quote steps while a staff quote run is pending. */
export function HmsQueueStatusLine({
  pending,
  status,
}: {
  pending: boolean;
  status: QueueStatus | null;
}) {
  if (!pending) return null;
  if (status?.state === 'unavailable') {
    return (
      <p role="alert" className="rounded-xs border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        {status.message}
      </p>
    );
  }
  // The first read can say idle before the run registers. Ignore it while pending.
  const text =
    !status || status.state === 'idle'
      ? 'Starting the HMS run…'
      : status.state === 'running' && status.runningForMs !== undefined
        ? `${status.message} ${formatQueueElapsed(status.runningForMs)} so far.`
        : status.message;
  return (
    <p role="status" className="flex items-center gap-2 rounded-xs border border-[#e2e8f0] bg-white px-3 py-2 text-xs text-[#475569]">
      <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-[#0066cc]" />
      <span>{text}</span>
    </p>
  );
}
