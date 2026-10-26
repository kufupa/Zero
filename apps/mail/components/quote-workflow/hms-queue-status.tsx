import { useEffect, useState } from 'react';
import type { HmsJobView } from '@/lib/quote-workflow/amend-find';
import type { QueueStatus } from '@/lib/quote-workflow/types';

/** "45 s" under a minute, then "1 min 20 s". */
export function formatQueueElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

function usePendingElapsed(pending: boolean, startedAt?: string | null): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!pending) {
      setElapsedMs(0);
      return;
    }
    const parsedStart = startedAt ? new Date(startedAt).getTime() : Date.now();
    const started = Number.isNaN(parsedStart) ? Date.now() : parsedStart;
    const update = () => setElapsedMs(Math.max(0, Date.now() - started));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [pending, startedAt]);
  return elapsedMs;
}

/** A non-blocking HMS read notice for a pending lookup outside the quote queue line. */
export function HmsLookupProgress({ pending, detail }: { pending: boolean; detail?: string }) {
  const elapsedMs = usePendingElapsed(pending);
  if (!pending) return null;
  return (
    <p role="status" className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12.5px] text-[#475569]">
      <span className="font-semibold text-[#1e293b]">Looking up in HMS — you can keep working</span>
      <span>{`· ${formatQueueElapsed(elapsedMs)} elapsed`}</span>
      {elapsedMs >= 30_000 ? <span>Still working — you can keep going</span> : null}
      {detail ? <span>{`· ${detail}`}</span> : null}
    </p>
  );
}

/** Status line under the quote steps while a staff quote run is pending. */
export function HmsQueueStatusLine({
  pending,
  status,
  staffQuote = false,
}: {
  pending: boolean;
  status: QueueStatus | null;
  staffQuote?: boolean;
}) {
  const elapsedMs = usePendingElapsed(pending);
  if (!pending) return null;
  if (status?.state === 'unavailable') {
    return (
      <p
        role="alert"
        className="rounded-xs border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
      >
        Could not check HMS status. You can keep working and retry shortly.
      </p>
    );
  }
  // The first read can say idle before the run registers. Ignore it while pending.
  const elapsed =
    status?.state === 'running' && status.runningForMs !== undefined
      ? Math.max(elapsedMs, status.runningForMs)
      : elapsedMs;
  const queueLabel =
    status?.state === 'running'
      ? 'Running in HMS'
      : status?.state === 'waiting'
        ? `Queued · ${
            status.aheadCount && status.aheadCount > 0
              ? `${status.aheadCount} ${status.aheadCount === 1 ? 'quote' : 'quotes'} ahead`
              : 'waiting for HMS to become free'
          }${
            status.etaMinutes && status.etaMinutes > 0
              ? ` · about ${status.etaMinutes === 1 ? '1 minute' : `${status.etaMinutes} minutes`}`
              : ''
          }`
        : status?.state === 'idle'
          ? 'Queued'
          : 'Queued';
  return (
    <p role="status" className="rounded-xs border border-[#e2e8f0] bg-white px-3 py-2 text-xs text-[#475569]">
      <span className="font-semibold text-[#1e293b]">
        {staffQuote ? 'Nava is getting rates from HMS — you can keep working' : 'Looking up in HMS — you can keep working'}
      </span>
      <span>{` · ${formatQueueElapsed(elapsed)} elapsed`}</span>
      <span>{` · ${queueLabel}`}</span>
      {elapsed >= 30_000 ? <span> · Still working — you can keep going</span> : null}
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

/** A dated snapshot age that never appears to come from the future. */
export function formatAsOfAgo(asOf: string, now: Date = new Date()): string | null {
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) return null;
  const seconds = Math.floor(Math.max(0, now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
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
  visible = true,
  statusFailed = false,
  queueFailed = false,
  failureMessage = 'Could not check for an existing HMS lookup.',
  failedMessage = 'Failed',
  queueFailureMessage = 'Could not queue the HMS lookup.',
}: {
  view: HmsJobView | null;
  queuing: boolean;
  /** Says what is running, such as "Nava is looking up the booking in HMS…". */
  detail: string;
  onRetry: () => void;
  /** Hides a duplicate line when another field announces the same shared job. */
  visible?: boolean;
  statusFailed?: boolean;
  queueFailed?: boolean;
  failureMessage?: string;
  failedMessage?: string;
  queueFailureMessage?: string;
}) {
  const label = hmsJobLabel(view, queuing);
  const elapsedMs = usePendingElapsed(
    visible && Boolean(label && label !== 'Failed'),
    view?.createdAt,
  );
  if (!visible) return null;
  if (statusFailed || queueFailed) {
    return (
      <div
        role="alert"
        data-testid="hms-job-status"
        data-state="failed"
        className="rounded-xs flex items-center justify-between gap-2 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
      >
        <span>{queueFailed ? queueFailureMessage : failureMessage}</span>
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
  if (!label) return null;
  if (label === 'Failed') {
    return (
      <div
        role="alert"
        data-testid="hms-job-status"
        data-state="failed"
        className="rounded-xs flex items-center justify-between gap-2 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
      >
        <span>{failedMessage}</span>
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
  const elapsed = formatQueueElapsed(elapsedMs);
  return (
    <p
      role="status"
      data-testid="hms-job-status"
      data-state={view?.status ?? 'running'}
      className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 rounded-xs border border-[#e2e8f0] bg-white px-3 py-2 text-xs text-[#475569]"
    >
      <span className="font-semibold text-[#1e293b]">Looking up in HMS — you can keep working</span>
      <span className="font-semibold text-[#475569]">{label}</span>
      {view?.createdAt ? (
        <span>{`${detail} ${elapsed} elapsed.`}</span>
      ) : (
        <>
          <span>{detail}</span>
          <span>{`${elapsed} elapsed`}</span>
        </>
      )}
      {elapsedMs >= 30_000 ? <span>Still working — you can keep going</span> : null}
    </p>
  );
}

/**
 * "Looked up in HMS <time ago>" under a dated result. Renders nothing without a valid stamp. A once-a-minute tick
 * re-renders the age, since an idle card gets no other update after its job settles.
 */
export function HmsAsOf({ asOf }: { asOf: string | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!asOf) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, [asOf]);
  const ago = asOf ? formatAsOfAgo(asOf) : null;
  if (!ago) return null;
  return (
    <p data-testid="hms-as-of" className="text-[10.5px] text-[#64748b]">
      {`Looked up in HMS ${ago}`}
    </p>
  );
}
