import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { workItemsFromTrpc, type NeedsYouRow } from '@/lib/quote-workflow/backend-bind';
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

  return {
    status: view.status,
    rows: view.rows,
    notice: view.notice,
    reload: () => void load(),
    dismiss,
  };
}

function whenOf(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function NeedsYouRowView({
  row,
  onOpenThread,
  onDismiss,
}: {
  row: NeedsYouRow;
  onOpenThread?: (threadId: string) => void;
  onDismiss: (workItemId: string) => void;
}) {
  const subject = row.subject?.trim() || '(no subject)';
  const sender = row.sender?.trim() || 'Unknown sender';
  const when = whenOf(row.receivedAt);
  const threadId = row.threadId;
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
      <div className="flex items-center gap-3">
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
  const { status, rows, notice, reload, dismiss } = list;
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
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The pane's "Needs you (N)" entry. It holds its own list, so a load re-renders this button and not the pane around it. */
export function NeedsYouEntry({ trpc, onOpen }: { trpc: unknown; onOpen: () => void }) {
  const list = useNeedsYou(trpc);
  return (
    <SecondaryButton onClick={onOpen}>
      {list.status === 'ready' ? `Needs you (${countLabel(list.rows)})` : 'Needs you'}
    </SecondaryButton>
  );
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
