import type { SyncStatusV1 } from '@zero/server/outlook-sync-contracts';
import { useId, useState } from 'react';
export type SyncControlOperation = 'start' | 'pause' | 'resume' | 'syncNow' | 'retryMissing';
export function outlookSyncLabel(status: SyncStatusV1 | null, error: string | null) {
  if (error === 'offline') return 'Offline — will retry';
  if (error === 'access-removed') return 'Access removed — contact Ansh';
  if (!status) return 'Checking sync access';
  if (status.userPaused) return 'Sync paused';
  if (status.state === 'sign-in-required') return 'Sign in to resume';
  if (status.resourcePauseReason === 'disk') return 'Low disk space — free space and recheck';
  if (status.resourcePauseReason === 'quota') return 'Copy limit reached — contact Ansh';
  const pending = Math.max(
    0,
    (status.live?.discovered ?? status.discovered) - (status.live?.committed ?? status.committed),
  );
  if (pending) return `${pending} copies pending`;
  if (status.committedThrough)
    return `Up to date — checked ${new Date(status.committedThrough).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return 'Checking for new mail';
}
export function OutlookSyncProgress({
  status,
  mailbox,
  onControl,
  error = null,
  busy = false,
}: {
  status: SyncStatusV1 | null;
  mailbox: string;
  onControl: (operation: SyncControlOperation) => void;
  error?: string | null;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false),
    id = useId(),
    label = outlookSyncLabel(status, error),
    paused = Boolean(status?.userPaused),
    disabled = busy || !status || status.state === 'sign-in-required' || error === 'access-removed';
  return (
    <div className="relative min-w-0 max-w-[180px] text-[11px]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="block min-w-0 max-w-full truncate rounded border border-slate-200 px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-emerald-700"
      >
        <span aria-live="polite">{label}</span>
      </button>
      {open && (
        <section
          id={id}
          aria-label="Outlook sync details"
          className="absolute right-0 top-full z-30 mt-2 w-[320px] max-w-[calc(100vw-24px)] rounded border border-slate-200 bg-white p-3 text-xs shadow-md"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          <p className="break-words font-semibold">{mailbox}</p>
          <p className="mt-1">
            Outlook copies email originals to Nava while Outlook is open. Closing this pane keeps
            sync running.
          </p>
          {status && (
            <>
              <p className="mt-2">
                {status.history?.discoveryComplete
                  ? status.history.gaps
                    ? `Copied with ${status.history.gaps} gaps`
                    : status.history.retained === status.history.discovered
                      ? 'History copied'
                      : `Copying ${status.history.retained} of ${status.history.discovered}`
                  : 'Finding emails'}
              </p>
              <p>
                {status.retained} originals retained · {status.committed} searchable
              </p>
              {status.historyFrom && (
                <p>
                  History: {new Date(status.historyFrom).toLocaleDateString()}–
                  {new Date(status.historyTo!).toLocaleDateString()}
                </p>
              )}
              {status.gaps > 0 && (
                <p className="text-amber-800">{status.gaps} unavailable copies need attention.</p>
              )}
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onControl(paused ? 'resume' : 'pause')}
              className="rounded border px-2 py-1 disabled:opacity-50"
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              disabled={disabled || paused}
              onClick={() => onControl('syncNow')}
              className="rounded border px-2 py-1 disabled:opacity-50"
            >
              Sync now
            </button>
            <button
              type="button"
              disabled={disabled || paused || !status?.gaps}
              onClick={() => onControl('retryMissing')}
              className="rounded border px-2 py-1 disabled:opacity-50"
            >
              Retry missing
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
