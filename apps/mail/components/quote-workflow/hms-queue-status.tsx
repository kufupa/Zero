import { Loader2 } from 'lucide-react';
import type { HmsJobView } from '@/lib/quote-workflow/amend-find';
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

/**
 * The label for a pane lookup job: Queued (position N), Running, Retrying, or Failed. A request still being queued reads
 * as Running. Null when there is no job in flight, or the job is done.
 */
export function hmsJobLabel(view: HmsJobView | null, queuing: boolean): string | null {
  if (queuing) return 'Running';
  if (!view) return null;
  switch (view.status) {
    case 'queued':
      return view.position ? `Queued (position ${view.position})` : 'Queued';
    case 'running':
      return 'Running';
    case 'retrying':
      return 'Retrying';
    case 'failed':
      return 'Failed';
    default:
      return null;
  }
}

/** HH:MM in local time for a snapshot's as-of stamp. Null when the stamp is not a date. */
export function formatAsOfTime(asOf: string): string | null {
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * The status line under a lookup button or search form. Failed shows Retry. It renders nothing once the job is done, or
 * when no job is in flight.
 */
export function HmsJobStatusLine({
  view,
  queuing,
  detail,
  onRetry,
}: {
  view: HmsJobView | null;
  queuing: boolean;
  /** Says what is running, such as "Nava is looking up the booking in HMS…". */
  detail: string;
  onRetry: () => void;
}) {
  const label = hmsJobLabel(view, queuing);
  if (!label) return null;
  if (label === 'Failed') {
    return (
      <div
        role="alert"
        data-testid="hms-job-status"
        data-state="failed"
        className="flex items-center justify-between gap-2 rounded-xs border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
      >
        <span className="font-semibold">Failed</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-sm border border-red-300 bg-white px-2.5 py-1 text-[11.5px] font-medium text-red-700"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <p
      role="status"
      data-testid="hms-job-status"
      data-state={view?.status ?? 'running'}
      className="flex items-center gap-2 rounded-xs border border-[#e2e8f0] bg-white px-3 py-2 text-xs text-[#475569]"
    >
      <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-[#0066cc]" />
      <span className="font-semibold text-[#1e293b]">{label}</span>
      <span>{detail}</span>
    </p>
  );
}

/** "As of HH:MM" under a dated HMS snapshot. Renders nothing without a stamp. */
export function HmsAsOf({ asOf }: { asOf: string | null }) {
  const time = asOf ? formatAsOfTime(asOf) : null;
  if (!time) return null;
  return (
    <p data-testid="hms-as-of" className="text-[10.5px] text-[#64748b]">
      {`As of ${time}`}
    </p>
  );
}
