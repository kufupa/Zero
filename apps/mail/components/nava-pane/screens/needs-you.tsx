import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { workItemsFromTrpc, type NeedsYouRow } from '@/lib/quote-workflow/backend-bind';
import { trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import {
  NAVA_READ_AS_LABEL,
  NAVA_WORK_STATE_LABEL,
  readAsForKind,
  type NavaWorkState,
} from '@/lib/quote-workflow/workflow-vocabulary';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getMailCacheScope, inMailbox } from '@/lib/mail/mail-cache-scope';
import { toast } from 'sonner';
import { Notice, SecondaryButton } from '../pane-ui';
import { Button } from '@/components/ui/button';

/** How many open items the list asks for. A full list reads "200+" on the count, since more may be behind it. */
export const NEEDS_YOU_LIMIT = 200;
/** Time to cancel a dismissal before the existing server mutation is sent. */
export const NEEDS_YOU_UNDO_MS = 5000;
/** Temporary rollout gate for the Needs-you entry controls. */
const NEEDS_YOU_CONTROLS_ENABLED = false;

export type NeedsYouFilter = 'open' | 'finished';
export type NeedsYouStatus = 'loading' | 'ready' | 'failed' | 'unavailable';

const FILTER_STATUSES: Record<NeedsYouFilter, NeedsYouRow['status'][]> = {
  open: ['needs_you', 'review'],
  finished: ['done', 'dismissed'],
};

/** The count as the buttons and the heading show it. */
function countLabel(count: number): string {
  return count >= NEEDS_YOU_LIMIT ? `${NEEDS_YOU_LIMIT}+` : String(count);
}

/** The text-link buttons in the screen header (Back to quotes, Close). */
const HEADER_LINK_CLASS =
  'rounded-[3px] text-[11.5px] font-semibold text-[#0066cc] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]';

const CHIP_CLASS: Record<NavaWorkState, string> = {
  needs_you: 'bg-[#fef3c7] text-[#92400e]',
  queued: 'bg-[#f1f5f9] text-[#475569]',
  in_hms: 'bg-[#eff6ff] text-[#1d4ed8]',
  review: 'bg-[#eaf4ee] text-[#1a4332]',
};

type NeedsYouViewState = {
  status: NeedsYouStatus;
  openRows: NeedsYouRow[];
  finishedRows: NeedsYouRow[];
  openLoaded: boolean;
  finishedLoaded: boolean;
  notice: string | null;
};

export type NeedsYou = {
  status: NeedsYouStatus;
  filter: NeedsYouFilter;
  rows: NeedsYouRow[];
  openCount: number;
  openLoaded: boolean;
  notice: string | null;
  canDismiss: boolean;
  setFilter: (filter: NeedsYouFilter) => void;
  reload: () => void;
  dismiss: (workItemId: string) => void;
};

type PendingDismissal = {
  row: NeedsYouRow;
  index: number;
  timer: ReturnType<typeof setTimeout>;
  flush: () => void;
  toastId: ReturnType<typeof toast>;
};

function restoreAt(rows: NeedsYouRow[], row: NeedsYouRow, index: number): NeedsYouRow[] {
  if (rows.some((item) => item.id === row.id)) return rows;
  const next = [...rows];
  next.splice(Math.min(index, next.length), 0, row);
  return next;
}

/**
 * One shared list for the pane entry/screen and webmail button/dialog. Finished is a real server filter; Dismiss uses
 * the existing mutation only after a short client-side Undo window.
 */
export function useNeedsYou(trpc: unknown): NeedsYou {
  const trpcRef = useRef(trpc);
  trpcRef.current = trpc;
  const mounted = useRef(false);
  const filterRef = useRef<NeedsYouFilter>('open');
  const loadSequence = useRef<Record<NeedsYouFilter, number>>({ open: 0, finished: 0 });
  // Keep a dismissed row out of stale open-list replies, but still let the server return it in Finished.
  const dismissed = useRef(new Set<string>());
  const pendingDismissals = useRef(new Map<string, PendingDismissal>());
  const [filter, setFilterState] = useState<NeedsYouFilter>('open');
  filterRef.current = filter;
  const [view, setView] = useState<NeedsYouViewState>({
    status: 'loading',
    openRows: [],
    finishedRows: [],
    openLoaded: false,
    finishedLoaded: false,
    notice: null,
  });

  const load = useCallback(async (
    requestedFilter: NeedsYouFilter = filterRef.current,
    preserveNotice = false,
  ) => {
    const query = workItemsFromTrpc(trpcRef.current).list?.query;
    if (!query) {
      if (mounted.current && filterRef.current === requestedFilter) {
        setView((prev) => ({ ...prev, status: 'unavailable' }));
      }
      return;
    }

    const sequence = ++loadSequence.current[requestedFilter];
    if (mounted.current && filterRef.current === requestedFilter) {
      setView((prev) => {
        const hasLoaded = requestedFilter === 'open' ? prev.openLoaded : prev.finishedLoaded;
        return {
          ...prev,
          status: hasLoaded ? prev.status : 'loading',
          ...(preserveNotice ? {} : { notice: null }),
        };
      });
    }
    try {
      const result = await query({
        limit: NEEDS_YOU_LIMIT,
        statuses: FILTER_STATUSES[requestedFilter],
      });
      const rows = requestedFilter === 'open'
        ? result.filter((row) => !dismissed.current.has(row.id))
        : result;
      if (!mounted.current || sequence !== loadSequence.current[requestedFilter]) return;
      setView((prev) => ({
        ...prev,
        ...(requestedFilter === 'open'
          ? { openRows: rows, openLoaded: true }
          : { finishedRows: rows, finishedLoaded: true }),
        ...(filterRef.current === requestedFilter
          ? { status: 'ready' as const, ...(preserveNotice ? {} : { notice: null }) }
          : {}),
      }));
    } catch {
      if (mounted.current && sequence === loadSequence.current[requestedFilter] && filterRef.current === requestedFilter) {
        setView((prev) => ({ ...prev, status: 'failed' }));
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const pendingDismissalsOnUnmount = pendingDismissals.current;
    return () => {
      mounted.current = false;
      for (const pending of pendingDismissalsOnUnmount.values()) {
        clearTimeout(pending.timer);
        toast.dismiss(pending.toastId);
        pending.flush();
      }
    };
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const setFilter = useCallback((next: NeedsYouFilter) => {
    if (filterRef.current === next) return;
    filterRef.current = next;
    setFilterState(next);
    setView((prev) => ({ ...prev, status: 'loading', notice: null }));
  }, []);

  const dismiss = useCallback(
    (workItemId: string) => {
      const client = workItemsFromTrpc(trpcRef.current);
      const mutate = client.dismiss?.mutate;
      if (!mutate || pendingDismissals.current.has(workItemId)) return;

      const row = view.openRows.find((item) => item.id === workItemId);
      if (!row) return;
      const index = view.openRows.indexOf(row);
      dismissed.current.add(workItemId);
      setView((prev) => ({
        ...prev,
        openRows: prev.openRows.filter((item) => item.id !== workItemId),
        notice: null,
      }));

      const transportId = getMailCacheScope().activeTransportId;
      const owner = { workItemId, transportId };
      // After a mailbox switch the list shows another mailbox: re-read it instead of putting this row into it.
      const mailboxChanged = () => getMailCacheScope().activeTransportId !== transportId;
      const undo = () => {
        const pending = pendingDismissals.current.get(workItemId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingDismissals.current.delete(workItemId);
        dismissed.current.delete(workItemId);
        if (mailboxChanged()) {
          void load('open', true);
          return;
        }
        setView((prev) => ({
          ...prev,
          openRows: restoreAt(prev.openRows, pending.row, pending.index),
          notice: null,
        }));
      };
      const flush = () => {
        pendingDismissals.current.delete(workItemId);
        const mailbox = inMailbox(transportId);
        (mailbox ? mutate({ workItemId }, mailbox) : mutate({ workItemId }))
          .then(() => {
            trackPaneAction({ type: 'item.dismissed' }, owner);
            return Promise.all([load('open'), load('finished')]);
          })
          .catch(() => {
            dismissed.current.delete(workItemId);
            if (mounted.current && !mailboxChanged()) {
              setView((prev) => ({
                ...prev,
                openRows: restoreAt(prev.openRows, row, index),
                notice: "Couldn't dismiss that email. It is back on your list.",
              }));
            }
            void load('open', true);
          });
      };
      const timer = setTimeout(flush, NEEDS_YOU_UNDO_MS);
      const toastId = toast('Email dismissed', {
        duration: NEEDS_YOU_UNDO_MS,
        action: { label: 'Undo', onClick: undo },
      });
      pendingDismissals.current.set(workItemId, { row, index, timer, flush, toastId });
    },
    [load, view.openRows],
  );

  const rows = filter === 'open' ? view.openRows : view.finishedRows;
  return {
    status: view.status,
    filter,
    rows,
    openCount: view.openRows.length,
    openLoaded: view.openLoaded,
    notice: view.notice,
    canDismiss: Boolean(workItemsFromTrpc(trpcRef.current).dismiss?.mutate),
    setFilter,
    reload: () => void load(filterRef.current),
    dismiss,
  };
}

function whenOf(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function reopenReasonOf(row: NeedsYouRow): string | null {
  const value = (row as NeedsYouRow & { reopenReason?: unknown }).reopenReason;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function hasExactId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function officeDisplayMessageForm(): ((entryId: string) => void) | undefined {
  const mailbox = (globalThis as {
    Office?: { context?: { mailbox?: { displayMessageForm?: (entryId: string) => void } } };
  }).Office?.context?.mailbox;
  return typeof mailbox?.displayMessageForm === 'function'
    ? (entryId) => mailbox.displayMessageForm!(entryId)
    : undefined;
}

function NeedsYouRowView({
  row,
  finished,
  onOpen,
  onDismiss,
}: {
  row: NeedsYouRow;
  finished: boolean;
  onOpen?: () => void;
  onDismiss?: (workItemId: string) => void;
}) {
  const subject = row.subject?.trim() || '(no subject)';
  const sender = row.sender?.trim() || 'Unknown sender';
  const when = whenOf(row.receivedAt);
  const reopenReason = reopenReasonOf(row);
  const stateLabel = finished ? 'Finished' : NAVA_WORK_STATE_LABEL[row.chip];
  const stateClass = finished ? 'bg-[#f1f5f9] text-[#475569]' : CHIP_CLASS[row.chip];
  return (
    <li className="flex flex-col gap-1.5 rounded-[3px] border border-[#e2e8f0] bg-white p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.4px] text-[#475569]">
          {NAVA_READ_AS_LABEL[readAsForKind(row.kind)]}
        </span>
        <span
          data-chip={finished ? 'finished' : row.chip}
          className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${stateClass}`}
        >
          {stateLabel}
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
      {reopenReason ? <p className="text-[11.5px] text-[#92400e]">{reopenReason}</p> : null}
      <div className="flex items-center gap-3">
        {onOpen ? (
          <SecondaryButton onClick={onOpen}>
            Open
            <span className="sr-only"> {subject}</span>
          </SecondaryButton>
        ) : null}
        {!finished && onDismiss ? (
          <button
            type="button"
            onClick={() => onDismiss(row.id)}
            className="rounded-[3px] text-[11.5px] font-semibold text-[#64748b] hover:text-[#1e293b] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]"
          >
            Dismiss
            <span className="sr-only"> {subject}</span>
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** The open/Finished list for both pane and webmail. Exact host IDs open the source; missing IDs fall back to search. */
export function NeedsYouScreen({
  list,
  host,
  onBack,
  onClose,
  onOpenThread,
}: {
  list: NeedsYou;
  host: 'web' | 'outlook';
  onBack?: () => void;
  onClose?: () => void;
  onOpenThread?: (threadId: string, sourceMessageId: string) => void;
}) {
  const { status, filter, rows, openCount, openLoaded, notice, reload, dismiss, canDismiss, setFilter } = list;
  const displayMessageForm = host === 'outlook' ? officeDisplayMessageForm() : undefined;
  const rowsWithActions = rows.map((row) => {
    if (host === 'outlook') {
      const entryId = row.outlookEntryId;
      return {
        row,
        onOpen:
          displayMessageForm && hasExactId(entryId) ? () => displayMessageForm(entryId) : undefined,
      };
    }
    const threadId = row.threadId;
    const sourceMessageId = row.sourceMessageId;
    const openThread = onOpenThread;
    return {
      row,
      onOpen:
        openThread && hasExactId(threadId) && hasExactId(sourceMessageId)
          ? () => openThread(threadId, sourceMessageId)
          : undefined,
    };
  });
  const needsManualSearch = rowsWithActions.some(({ onOpen }) => !onOpen);
  return (
    <section
      aria-label="Needs you"
      className="animate-in fade-in nava-pane-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5 duration-150"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-bold text-[#1e293b]">
          Needs you{openLoaded ? ` (${countLabel(openCount)})` : ''}
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

      {status !== 'unavailable' ? (
        <div role="group" aria-label="Needs-you filter" className="flex w-fit rounded-[3px] border border-[#cbd5e1] bg-white p-0.5">
          {(['open', 'finished'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded-[2px] px-2.5 py-1 text-[11.5px] font-semibold ${
                filter === value ? 'bg-[#1a4332] text-white' : 'text-[#475569] hover:bg-[#f1f5f9]'
              }`}
            >
              {value === 'open' ? 'Open' : 'Finished'}
            </button>
          ))}
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="text-[11.5px] text-[#b45309]">
          {notice}
        </p>
      ) : null}

      {status === 'loading' ? (
        <p role="status" className="text-[12px] text-[#64748b]">Loading…</p>
      ) : status === 'unavailable' ? (
        <Notice tone="info">Needs-you isn&apos;t available for this mailbox. You can still work from the selected email.</Notice>
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
            {filter === 'finished' ? 'Nothing finished yet' : 'All caught up'}
          </p>
          <p className="text-[11.5px] text-[#64748b]">
            {filter === 'finished' ? 'Finished emails will appear here.' : 'Nothing needs you right now.'}
          </p>
        </div>
      ) : (
        <>
          {needsManualSearch ? (
            <p className="text-[11.5px] text-[#64748b]">
              {host === 'outlook'
                ? 'Find each email in your Outlook inbox by its sender and subject.'
                : 'Find this email in webmail by its sender and subject.'}
            </p>
          ) : null}
          <ul aria-label={filter === 'open' ? 'Open items' : 'Finished items'} className="flex flex-col gap-2">
            {rowsWithActions.map(({ row, onOpen }) => (
              <NeedsYouRowView
                key={row.id}
                row={row}
                finished={filter === 'finished' || row.status === 'done' || row.status === 'dismissed'}
                onOpen={onOpen}
                onDismiss={canDismiss ? dismiss : undefined}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The Outlook pane's Needs-you entry, temporarily gated by the default-off rollout flag. */
export function NeedsYouEntry({
  list,
  onOpen,
  compact = false,
}: {
  list: NeedsYou;
  onOpen: () => void;
  compact?: boolean;
}) {
  if (!NEEDS_YOU_CONTROLS_ENABLED || list.status === 'unavailable') return null;
  const label = list.openLoaded ? `Needs you (${countLabel(list.openCount)})` : 'Needs you';
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

/** The list on its own, retained for callers that do not already own a shared list hook. */
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
  onOpenThread?: (threadId: string, sourceMessageId: string) => void;
}) {
  const list = useNeedsYou(trpc);
  return <NeedsYouScreen list={list} host={host} onBack={onBack} onClose={onClose} onOpenThread={onOpenThread} />;
}

/** The webmail Needs-you control and dialog share one list, so the Undo timer survives closing the dialog. */
export function NeedsYouWebControl({
  trpc,
  onOpenThread,
}: {
  trpc: unknown;
  onOpenThread: (threadId: string, sourceMessageId: string) => void;
}) {
  if (!NEEDS_YOU_CONTROLS_ENABLED) return null;
  return <NeedsYouWebControlContent trpc={trpc} onOpenThread={onOpenThread} />;
}

function NeedsYouWebControlContent({
  trpc,
  onOpenThread,
}: {
  trpc: unknown;
  onOpenThread: (threadId: string, sourceMessageId: string) => void;
}) {
  const list = useNeedsYou(trpc);
  const [open, setOpen] = useState(false);
  // Mail can arrive while the dialog is closed, so opening it re-reads the list as well as closing it.
  const show = () => {
    setOpen(true);
    list.reload();
  };
  const close = () => {
    setOpen(false);
    list.reload();
  };
  if (list.status === 'unavailable') return null;
  return (
    <>
      <Button
        onClick={show}
        variant="ghost"
        size="sm"
        className="hover:bg-accent/50 h-10 shrink-0 rounded-lg border-none bg-transparent px-3 text-sm font-medium"
      >
        {list.openLoaded ? `Needs you (${countLabel(list.openCount)})` : 'Needs you'}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) show();
          else close();
        }}
      >
        <DialogContent showOverlay className="max-h-[80dvh] max-w-xl overflow-hidden bg-white p-0 dark:bg-white">
          <DialogTitle className="sr-only">Needs you</DialogTitle>
          <DialogDescription className="sr-only">
            Open and finished emails, with the sender, subject and time of each.
          </DialogDescription>
          <div className="flex max-h-[80dvh] min-h-0 flex-col">
            <NeedsYouScreen
              list={list}
              host="web"
              onClose={close}
              onOpenThread={(threadId, sourceMessageId) => {
                close();
                onOpenThread(threadId, sourceMessageId);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
