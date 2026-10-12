import {
  paneStayLookupFromTrpc,
  workItemsFromTrpc,
  type NeedsYouHms,
  type NeedsYouHmsStatus,
  type NeedsYouRow,
  type RunNeedsYouItemResult,
} from '@/lib/quote-workflow/backend-bind';
import {
  HMS_JOB_MAX_MISSES,
  HMS_JOB_POLL_MS,
  type HmsJobView,
} from '@/lib/quote-workflow/amend-find';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { HmsJobStatusLine } from '@/components/quote-workflow/hms-queue-status';
import { trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getMailCacheScope } from '@/lib/mail/mail-cache-scope';
import { Notice, SecondaryButton } from '../pane-ui';
import { Button } from '@/components/ui/button';

/** How many open items the list asks for. A full list reads "200+" on the count, since more may be behind it. */
export const NEEDS_YOU_LIMIT = 200;

/** The count as the buttons and the heading show it. */
function countLabel(rows: NeedsYouRow[]): string {
  return rows.length >= NEEDS_YOU_LIMIT ? `${NEEDS_YOU_LIMIT}+` : String(rows.length);
}

/** The text-link buttons in the screen header (Back to quotes, Close). */
const HEADER_LINK_CLASS =
  'rounded-[3px] text-[11.5px] font-semibold text-[#0066cc] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]';

const CHIP_LABEL: Record<NeedsYouRow['chip'], string> = {
  needs_you: 'Needs you',
  queued: 'Queued',
  in_hms: 'In HMS',
  review: 'Review',
};

const CHIP_CLASS: Record<NeedsYouRow['chip'], string> = {
  needs_you: 'bg-[#fef3c7] text-[#92400e]',
  queued: 'bg-[#f1f5f9] text-[#475569]',
  in_hms: 'bg-[#eff6ff] text-[#1d4ed8]',
  review: 'bg-[#eaf4ee] text-[#1a4332]',
};

const KIND_LABEL: Record<string, string> = {
  quote: 'Quote',
  booking: 'Booking',
  amendment: 'Amendment',
  cancellation: 'Cancellation',
  voucher_pop: 'Voucher or POP',
  other: 'Other',
};

export type NeedsYouStatus = 'loading' | 'ready' | 'failed' | 'unavailable';

export type NeedsYou = {
  status: NeedsYouStatus;
  /** Open items in list order (needs you first, oldest mail first). Empty until the first load settles. */
  rows: NeedsYouRow[];
  /** Shown above the list when a dismiss did not go through. The item is still on the list. */
  notice: string | null;
  reload: () => void;
  dismiss: (workItemId: string) => void;
  runHms: (workItemId: string) => Promise<RunNeedsYouItemResult>;
  getHmsJobStatus: (runId: string) => Promise<HmsJobView | null>;
};

/**
 * The Needs-you list for the pane and the webmail. Loads on mount, and again when asked (the screen opening, or after
 * a dismiss). A build without the list route reads as unavailable, so nothing throws.
 */
export function useNeedsYou(trpc: unknown): NeedsYou {
  const trpcRef = useRef(trpc);
  trpcRef.current = trpc;
  const mounted = useRef(false);
  // Ids dismissed here. A load that started before a dismiss can still answer with the row, so loads drop these.
  const dismissed = useRef(new Set<string>());
  const [view, setView] = useState<{
    status: NeedsYouStatus;
    rows: NeedsYouRow[];
    notice: string | null;
  }>({
    status: 'loading',
    rows: [],
    notice: null,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const query = workItemsFromTrpc(trpcRef.current).list?.query;
    if (!query) {
      if (mounted.current) setView((prev) => ({ ...prev, status: 'unavailable' }));
      return;
    }
    try {
      const rows = (await query({ limit: NEEDS_YOU_LIMIT })).filter(
        (row) => !dismissed.current.has(row.id),
      );
      if (mounted.current) setView((prev) => ({ ...prev, status: 'ready', rows }));
    } catch {
      if (mounted.current) setView((prev) => ({ ...prev, status: 'failed' }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The row leaves at once. If the server refuses, the row comes back on the reload and a notice says why.
  const dismiss = useCallback(
    (workItemId: string) => {
      const mutate = workItemsFromTrpc(trpcRef.current).dismiss?.mutate;
      if (!mutate) return;
      dismissed.current.add(workItemId);
      setView((prev) => ({
        ...prev,
        rows: prev.rows.filter((row) => row.id !== workItemId),
        notice: null,
      }));
      // The dismiss goes out under the active mailbox, so its event belongs to that mailbox's copy of the item.
      const owner = { workItemId, transportId: getMailCacheScope().activeTransportId };
      mutate({ workItemId })
        .then(() => {
          trackPaneAction({ type: 'item.dismissed' }, owner);
          return load();
        })
        .catch(() => {
          dismissed.current.delete(workItemId);
          if (mounted.current) {
            setView((prev) => ({
              ...prev,
              notice: "Couldn't dismiss that email. It is still on your list.",
            }));
          }
          return load();
        });
    },
    [load],
  );

  const runHms = useCallback((workItemId: string): Promise<RunNeedsYouItemResult> => {
    const mutate = paneStayLookupFromTrpc(trpcRef.current).runNeedsYouItem?.mutate;
    return mutate ? mutate({ workItemId }) : Promise.resolve(null);
  }, []);

  const getHmsJobStatus = useCallback((runId: string): Promise<HmsJobView | null> => {
    const query = paneStayLookupFromTrpc(trpcRef.current).jobStatus?.query;
    return query ? query({ runId }) : Promise.resolve(null);
  }, []);

  return {
    status: view.status,
    rows: view.rows,
    notice: view.notice,
    reload: () => void load(),
    dismiss,
    runHms,
    getHmsJobStatus,
  };
}

function whenOf(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const HMS_RUN_KINDS = new Set(['booking', 'amendment', 'cancellation', 'voucher_pop']);

function isActiveHmsStatus(
  status: NeedsYouHmsStatus | null | undefined,
): status is 'queued' | 'running' | 'retrying' {
  return status === 'queued' || status === 'running' || status === 'retrying';
}

function resultSummary(result: Record<string, unknown> | null | undefined): string | null {
  if (typeof result?.summary === 'string') return result.summary;
  // Same outcome set as the server's hmsReadSummary, so a finished check and a reopened row agree.
  if (
    result?.outcome === 'found' ||
    result?.outcome === 'ambiguous' ||
    result?.outcome === 'ambiguous_capped'
  ) {
    return 'found';
  }
  if (result?.outcome === 'not_found') return 'not found';
  if (result?.outcome === 'ok') {
    return Array.isArray(result.rows) && result.rows.length > 0 ? 'found' : 'not found';
  }
  if (typeof result?.found === 'boolean') return result.found ? 'found' : 'not found';
  return null;
}

function needsYouHmsFromResult(
  result: RunNeedsYouItemResult,
  workItemId: string,
): { hms: NeedsYouHms; disabledReason: NeedsYouRow['hmsDisabledReason'] } | null {
  const item = result?.items.find((candidate) => candidate.workItemId === workItemId);
  if (!result || !item) return null;

  const status: NeedsYouHmsStatus =
    item.status === 'skipped'
      ? item.reason === 'insufficient_data'
        ? 'insufficient_data'
        : 'failed'
      : item.status === 'cancelled'
        ? 'failed'
        : item.status === 'reused'
          ? (item.job?.status ?? 'done')
          : (item.job?.status ?? item.status);
  const summary = resultSummary(item.job?.result);
  const disabledReason =
    item.reason === 'insufficient_data' || status === 'insufficient_data'
      ? 'insufficient_data'
      : null;

  return {
    hms: {
      status,
      asOf: item.job?.asOf ?? null,
      runId: item.runId ?? item.job?.runId ?? null,
      summary,
    },
    disabledReason,
  };
}

function doneHmsLabel(summary: string | null): string {
  const normalized = (summary ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (/\b(not found|no match|no matching|no booking|no stay|no record|none)\b/.test(normalized)) {
    return 'In HMS: not found';
  }
  if (/\bfound\b/.test(normalized)) return 'In HMS: found';
  return 'In HMS: checked';
}

function NeedsYouRowView({
  row,
  onOpenThread,
  onDismiss,
  onRunHms,
  onGetHmsJobStatus,
}: {
  row: NeedsYouRow;
  onOpenThread?: (threadId: string) => void;
  onDismiss: (workItemId: string) => void;
  onRunHms: (workItemId: string) => Promise<RunNeedsYouItemResult>;
  onGetHmsJobStatus: (runId: string) => Promise<HmsJobView | null>;
}) {
  const subject = row.subject?.trim() || '(no subject)';
  const sender = row.sender?.trim() || 'Unknown sender';
  const when = whenOf(row.receivedAt);
  const threadId = row.threadId;
  const [hms, setHms] = useState(row.hms);
  const [hmsDisabledReason, setHmsDisabledReason] = useState(row.hmsDisabledReason);
  const [requestActive, setRequestActive] = useState(false);
  const [runFailed, setRunFailed] = useState(false);
  const [runUnavailable, setRunUnavailable] = useState(false);
  const localHms = useRef<NeedsYouHms | null>(null);
  const queuing = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    if (queuing.current) return;
    // Row details (why Run HMS is off) follow every list read, apart from the HMS status guard below.
    setHmsDisabledReason(row.hmsDisabledReason);
    const local = localHms.current;
    const incoming = row.hms;
    if (local) {
      if (local.runId === null && local.asOf === null) {
        // Placeholder from a local insufficient-data answer: the first server state with a run id or asOf supersedes it.
        if (!incoming?.runId && !incoming?.asOf) return;
      } else if (incoming?.runId !== local.runId) {
        // A list read may have started before our enqueue or before its latest status read.
        if (
          isActiveHmsStatus(local.status) ||
          !incoming?.asOf ||
          !local.asOf ||
          incoming.asOf <= local.asOf
        )
          return;
      } else if (
        (!isActiveHmsStatus(local.status) && isActiveHmsStatus(incoming?.status)) ||
        (local.asOf && (!incoming?.asOf || incoming.asOf < local.asOf))
      )
        return;
      localHms.current = incoming;
    }
    setHms(incoming);
  }, [row]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pollingRunId = isActiveHmsStatus(hms?.status) ? hms.runId : null;
  useEffect(() => {
    if (!pollingRunId) return;
    let active = true;
    let timeout: number | undefined;
    let misses = 0;
    const schedule = () => {
      timeout = window.setTimeout(() => void poll(), HMS_JOB_POLL_MS);
    };
    const poll = async () => {
      let job: HmsJobView | null;
      try {
        job = await onGetHmsJobStatus(pollingRunId);
      } catch {
        job = null;
      }
      if (!active || !mounted.current) return;
      if (!job || job.runId !== pollingRunId) {
        misses += 1;
        if (misses < HMS_JOB_MAX_MISSES) schedule();
        else
          setHms((previous) => {
            const failed: NeedsYouHms = {
              status: 'failed',
              asOf: previous?.asOf ?? null,
              runId: pollingRunId,
              summary: null,
            };
            localHms.current = failed;
            return failed;
          });
        return;
      }
      misses = 0;
      const snapshot: NeedsYouHms = {
        status: job.status,
        asOf: job.asOf,
        runId: job.runId,
        summary: resultSummary(job.result),
      };
      localHms.current = snapshot;
      setHms(snapshot);
      setHmsDisabledReason(null);
      if (isActiveHmsStatus(snapshot.status)) schedule();
    };
    schedule();
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [pollingRunId, onGetHmsJobStatus]);

  const activeView = isActiveHmsStatus(hms?.status) ? { status: hms.status, position: null } : null;
  const hmsBusy = requestActive || activeView !== null;
  const eligibleForHms = HMS_RUN_KINDS.has(row.kind);
  const runDisabled =
    hmsBusy ||
    runUnavailable ||
    hmsDisabledReason === 'insufficient_data';

  const runHms = async () => {
    if (runDisabled || queuing.current) return;
    queuing.current = true;
    setRequestActive(true);
    setRunFailed(false);
    try {
      const result = await onRunHms(row.id);
      if (!mounted.current) return;
      if (!result) {
        setRunUnavailable(true);
        return;
      }
      const snapshot = needsYouHmsFromResult(result, row.id);
      if (!snapshot) throw new Error('The HMS run returned no item.');
      if (mounted.current) {
        localHms.current = snapshot.hms;
        setHms(snapshot.hms);
        setHmsDisabledReason(snapshot.disabledReason);
      }
    } catch {
      if (mounted.current) setRunFailed(true);
    } finally {
      queuing.current = false;
      if (mounted.current) setRequestActive(false);
    }
  };

  return (
    <li className="flex flex-col gap-1.5 rounded-[3px] border border-[#e2e8f0] bg-white p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.4px] text-[#475569]">
          {KIND_LABEL[row.kind] ?? 'Other'}
        </span>
        <span
          data-chip={row.chip}
          className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${CHIP_CLASS[row.chip]}`}
        >
          {CHIP_LABEL[row.chip]}
        </span>
      </div>
      <p data-pii className="truncate text-[12.5px] font-semibold text-[#1e293b]" title={subject}>
        {subject}
      </p>
      <p data-pii className="truncate text-[11.5px] text-[#64748b]">
        {sender}
        {when ? (
          <>
            {' · '}
            <time dateTime={when.toISOString()}>
              {when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </time>
          </>
        ) : null}
      </p>
      {runUnavailable ? (
        <p role="status" data-hms-status="unavailable" className="text-[10.5px] text-[#64748b]">
          HMS checks are unavailable in this session.
        </p>
      ) : requestActive || activeView ? (
        <HmsJobStatusLine
          view={activeView}
          queuing={requestActive}
          detail="Checking HMS… about 2 min"
          onRetry={runHms}
          compact
        />
      ) : hmsDisabledReason === 'insufficient_data' ? (
        <p
          role="status"
          data-hms-status="insufficient_data"
          className="w-fit rounded-full bg-[#fef3c7] px-2 py-0.5 text-[10.5px] text-[#92400e]"
        >
          Not enough details to check HMS.
        </p>
      ) : hms?.status === 'done' ? (
        <p
          role="status"
          data-hms-status="done"
          className="w-fit rounded-full bg-[#eff6ff] px-2 py-0.5 text-[10.5px] text-[#1d4ed8]"
        >
          {doneHmsLabel(hms.summary)}
        </p>
      ) : hms?.status === 'stale' ? (
        <p
          role="status"
          data-hms-status="stale"
          className="w-fit rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[10.5px] text-[#475569]"
        >
          HMS result is stale.
        </p>
      ) : hms?.status === 'failed' ? (
        <p
          role="status"
          data-hms-status="failed"
          className="w-fit rounded-full bg-[#fef2f2] px-2 py-0.5 text-[10.5px] text-[#b91c1c]"
        >
          HMS check failed.
        </p>
      ) : null}
      {runFailed ? (
        <p role="alert" className="text-[10.5px] text-[#b91c1c]">
          Couldn&apos;t queue an HMS check. Try again.
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        {eligibleForHms ? (
          <button
            type="button"
            aria-label={`Run HMS ${subject}`}
            aria-busy={hmsBusy}
            disabled={runDisabled}
            onClick={() => void runHms()}
            className="rounded-[3px] border border-[#cbd5e1] bg-white px-2 py-1 text-[11.5px] font-semibold text-[#334155] hover:bg-[#f8fafc] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Run HMS
          </button>
        ) : null}
        {onOpenThread && threadId ? (
          <SecondaryButton onClick={() => onOpenThread(threadId)}>
            Open
            <span className="sr-only"> {subject}</span>
          </SecondaryButton>
        ) : null}
        <button
          type="button"
          onClick={() => onDismiss(row.id)}
          className="rounded-[3px] text-[11.5px] font-semibold text-[#64748b] hover:text-[#1e293b] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]"
        >
          Dismiss
          <span className="sr-only"> {subject}</span>
        </button>
      </div>
    </li>
  );
}

/**
 * Her Monday list (U24). The pane opens it from the "Needs you" entry and the webmail from its list header. Webmail
 * opens a row's thread; Outlook has no deep navigation, so each row carries the sender, subject and time instead.
 */
export function NeedsYouScreen({
  list,
  host,
  onBack,
  onClose,
  onOpenThread,
}: {
  list: NeedsYou;
  host: 'web' | 'outlook';
  /** Back to the quoting tool. The webmail dialog closes itself, so it leaves this out. */
  onBack?: () => void;
  /** Closes the webmail dialog. The pane passes onBack instead. */
  onClose?: () => void;
  /** Opens a row's thread in webmail. Only webmail passes it. */
  onOpenThread?: (threadId: string) => void;
}) {
  const { status, rows, notice, reload, dismiss, runHms, getHmsJobStatus } = list;
  const open = status === 'ready' ? countLabel(rows) : null;
  return (
    <section
      aria-label="Needs you"
      className="animate-in fade-in nava-pane-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5 duration-150"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-bold text-[#1e293b]">
          Needs you{open === null ? '' : ` (${open})`}
        </h2>
        {onBack ? (
          <button type="button" onClick={onBack} className={HEADER_LINK_CLASS}>
            Back to quotes
          </button>
        ) : onClose ? (
          <button type="button" onClick={onClose} className={HEADER_LINK_CLASS}>
            Close
          </button>
        ) : null}
      </div>

      {notice ? (
        <p role="status" className="text-[11.5px] text-[#b45309]">
          {notice}
        </p>
      ) : null}

      {status === 'loading' ? (
        <p role="status" className="text-[12px] text-[#64748b]">
          Loading…
        </p>
      ) : status === 'unavailable' ? (
        <Notice tone="info">The Needs-you list is not available in this version yet.</Notice>
      ) : status === 'failed' ? (
        <Notice tone="warn" role="alert">
          <p>Couldn&apos;t load the list.</p>
          <div className="mt-1.5">
            <SecondaryButton onClick={reload}>Try again</SecondaryButton>
          </div>
        </Notice>
      ) : rows.length === 0 ? (
        <div className="flex flex-col gap-0.5">
          <p role="status" className="text-[13px] font-semibold text-[#1a4332]">
            All caught up
          </p>
          <p className="text-[11.5px] text-[#64748b]">Nothing needs you right now.</p>
        </div>
      ) : (
        <>
          {host === 'outlook' ? (
            <p className="text-[11.5px] text-[#64748b]">
              Find each email in your Outlook inbox by its sender and subject.
            </p>
          ) : null}
          <ul aria-label="Open items" className="flex flex-col gap-2">
            {rows.map((row) => (
              <NeedsYouRowView
                key={row.id}
                row={row}
                onOpenThread={onOpenThread}
                onDismiss={dismiss}
                onRunHms={runHms}
                onGetHmsJobStatus={getHmsJobStatus}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The pane's "Needs you (N)" entry. It shows the same list the screen uses, so a dismiss on the screen moves this count. */
export function NeedsYouEntry({
  list,
  onOpen,
  compact = false,
}: {
  /** The pane's list, shared with the screen (see useNeedsYou). */
  list: NeedsYou;
  onOpen: () => void;
  /** Header link for the Outlook pane. */
  compact?: boolean;
}) {
  const label = list.status === 'ready' ? `Needs you (${countLabel(list.rows)})` : 'Needs you';
  if (compact) {
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onOpen}
        className="max-w-[96px] shrink-0 truncate whitespace-nowrap text-[11.5px] font-semibold text-[#0066cc] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]"
      >
        {label}
      </button>
    );
  }
  return <SecondaryButton onClick={onOpen}>{label}</SecondaryButton>;
}

/** The list on its own. It loads each time it mounts, so opening it shows the current list. */
export function NeedsYouView({
  trpc,
  host,
  onBack,
  onClose,
  onOpenThread,
}: {
  trpc: unknown;
  host: 'web' | 'outlook';
  onBack?: () => void;
  onClose?: () => void;
  onOpenThread?: (threadId: string) => void;
}) {
  const list = useNeedsYou(trpc);
  return (
    <NeedsYouScreen
      list={list}
      host={host}
      onBack={onBack}
      onClose={onClose}
      onOpenThread={onOpenThread}
    />
  );
}

/**
 * The webmail's "Needs you (N)" control in the list header. The button and the dialog keep their own lists, so a load
 * re-renders only this control and not the mail layout around it.
 */
export function NeedsYouWebControl({
  trpc,
  onOpenThread,
}: {
  trpc: unknown;
  onOpenThread: (threadId: string) => void;
}) {
  const count = useNeedsYou(trpc);
  const [open, setOpen] = useState(false);
  // Closing reloads the count, since a dismiss inside the dialog changes the number on the button.
  const close = () => {
    setOpen(false);
    count.reload();
  };
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        variant="ghost"
        size="sm"
        className="hover:bg-accent/50 h-10 shrink-0 rounded-lg border-none bg-transparent px-3 text-sm font-medium"
      >
        {count.status === 'ready' ? `Needs you (${countLabel(count.rows)})` : 'Needs you'}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setOpen(true);
          } else {
            close();
          }
        }}
      >
        {/* The dialog's own backdrop and panel. The panel stays light, as the rows use light colours. */}
        <DialogContent
          showOverlay
          className="max-h-[80dvh] max-w-xl overflow-hidden bg-white p-0 dark:bg-white"
        >
          <DialogTitle className="sr-only">Needs you</DialogTitle>
          <DialogDescription className="sr-only">
            Items that need you, with the sender, subject and time of each.
          </DialogDescription>
          <div className="flex max-h-[80dvh] min-h-0 flex-col">
            <NeedsYouView
              trpc={trpc}
              host="web"
              onClose={close}
              onOpenThread={(threadId) => {
                close();
                onOpenThread(threadId);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
