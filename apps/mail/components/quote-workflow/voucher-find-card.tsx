'use client';

import {
  AMEND_FIND_COPY,
  amendSearchClientFromTrpc,
  formatStayDate,
  noSearchMatchCopy,
  runHmsSearch,
  type GuestSearchRow,
  type HmsSearchRun,
} from '@/lib/quote-workflow/amend-find';
import {
  canSearchVoucher,
  VOUCHER_COPY,
  voucherConflictLines,
  voucherFindClientFromTrpc,
  voucherGuestLine,
  type VoucherFindReply,
} from '@/lib/quote-workflow/voucher-find';
import { downloadAttachmentViaBlob, type AttachmentAccessInput } from '@/lib/attachment-access';
import { useEffect, useMemo, useRef, useState } from 'react';
import { HmsLinkActions } from './hms-link-actions';

const panelClass = 'flex flex-col gap-2 rounded-sm border border-[#e2e8f0] bg-white p-3';
const headingClass = 'text-[10px] font-semibold uppercase tracking-wide text-[#64748b]';
const captionClass = 'text-[10px] text-[#94a3b8]';
const valueClass = 'text-[12.5px] text-[#1e293b]';
const warnNoteClass =
  'rounded-xs border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11.5px] text-amber-900';
const infoNoteClass = 'text-[11.5px] text-[#334155]';
const buttonClass =
  'rounded-sm border border-[#0066cc] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#0066cc] disabled:border-[#cbd5e1] disabled:text-[#94a3b8]';

type SearchStatus = { phase: 'running' } | { phase: 'done'; run: HmsSearchRun };
type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Find the booking for voucher or proof-of-payment mail. Renders nothing unless the server says this email is a voucher.
 * The HMS search runs only when staff press the button, because a search takes about a minute of the shared HMS session.
 */
export function VoucherFindCard({
  internetMessageId,
  trpc,
  download = downloadAttachmentViaBlob,
  syncCommitted = null,
  syncPending = false,
}: {
  internetMessageId: string | null;
  trpc: unknown;
  /** Saves one attachment. The default fetches the signed URL and downloads the bytes. */
  download?: (input: AttachmentAccessInput) => Promise<void>;
  /** The mailbox sync's committed count. An email the server had not stored yet is checked again when it advances. */
  syncCommitted?: number | null;
  /** True while the mailbox sync still has mail to store. Only then does an unstored email show the waiting note. */
  syncPending?: boolean;
}) {
  const findClient = useMemo(() => voucherFindClientFromTrpc(trpc), [trpc]);
  const searchClient = useMemo(() => amendSearchClientFromTrpc(trpc), [trpc]);
  const [reply, setReply] = useState<VoucherFindReply | null>(null);
  const [search, setSearch] = useState<SearchStatus | null>(null);
  const [save, setSave] = useState<SaveStatus>('idle');
  const mounted = useRef(false);
  const [checkRound, setCheckRound] = useState(0);
  // The sync's committed count as of the last commit this card has seen.
  const committedSeen = useRef(syncCommitted);
  // True while the settled answer is unsynced. A later commit then starts one more check.
  const showingUnsynced = useRef(false);
  // The email the card last checked. A re-check of the same email keeps its answer on screen until the next one arrives.
  const checkedFor = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (checkedFor.current !== internetMessageId) {
      // A new email starts clean: the last email's voucher, search and save state must not show under it.
      checkedFor.current = internetMessageId;
      setReply(null);
      setSearch(null);
      setSave('idle');
    }
    showingUnsynced.current = false;
    if (!findClient || !internetMessageId) return;
    let live = true;
    // The commit count when this check starts. A commit that lands while the check runs is compared when it answers.
    const startedAt = committedSeen.current;
    findClient.check({ internetMessageId }).then(
      (next) => {
        if (!live) return;
        // A commit during this check means an unsynced answer may predate it, so check once more. The running check
        // is never restarted, so a slow read keeps its answer.
        if (next.status === 'unsynced' && committedSeen.current !== startedAt) {
          setCheckRound((round) => round + 1);
          return;
        }
        showingUnsynced.current = next.status === 'unsynced';
        setReply(next);
      },
      () => {
        if (!live) return;
        showingUnsynced.current = false;
        setReply({ status: 'not_voucher' });
      },
    );
    return () => {
      live = false;
    };
  }, [findClient, internetMessageId, checkRound]);

  // A commit while an unsynced answer shows starts one more check. A commit during a running check is compared when
  // that check answers, so the running check is left alone.
  useEffect(() => {
    if (committedSeen.current === syncCommitted) return;
    committedSeen.current = syncCommitted;
    if (showingUnsynced.current) setCheckRound((round) => round + 1);
  }, [syncCommitted]);

  if (!reply) return null;
  if (reply.status === 'unsynced') {
    if (!syncPending) return null;
    return (
      <section aria-label={VOUCHER_COPY.heading} className={panelClass}>
        <p className={headingClass}>{VOUCHER_COPY.heading}</p>
        <p role="status" className={infoNoteClass}>
          {VOUCHER_COPY.waitingForSync}
        </p>
      </section>
    );
  }
  if (reply.status !== 'voucher') return null;
  const { guest, file } = reply;
  const line = voucherGuestLine(guest);
  const canSearch = canSearchVoucher(guest) && searchClient !== null;
  const surnameConflict = (guest.conflicts?.lastNames.length ?? 0) > 1;
  const arrivalConflict = (guest.conflicts?.arrivals.length ?? 0) > 1;

  const runSearch = async () => {
    if (!canSearchVoucher(guest)) return;
    setSearch({ phase: 'running' });
    const run = await runHmsSearch({
      client: searchClient,
      lastName: guest.lastName,
      arrival: guest.arrival,
    });
    if (mounted.current) setSearch({ phase: 'done', run });
  };

  const saveFile = async () => {
    if (!file) return;
    setSave('saving');
    try {
      await download({
        messageId: reply.messageId,
        attachmentId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.sizeBytes,
      });
      if (mounted.current) setSave('saved');
    } catch {
      if (mounted.current) setSave('failed');
    }
  };

  return (
    <section aria-label={VOUCHER_COPY.heading} className={panelClass}>
      <p className={headingClass}>{VOUCHER_COPY.heading}</p>
      <p className={captionClass}>{VOUCHER_COPY.caption}</p>
      {line ? <p className={valueClass}>{line}</p> : null}
      {guest.lastName === null && !surnameConflict ? (
        <p className={warnNoteClass}>{VOUCHER_COPY.missingGuest}</p>
      ) : null}
      {guest.lastName !== null && guest.arrival === null && !arrivalConflict ? (
        <p className={warnNoteClass}>{VOUCHER_COPY.missingArrival}</p>
      ) : null}
      {voucherConflictLines(guest).map((text) => (
        <p key={text} className={warnNoteClass}>
          {text}
        </p>
      ))}
      {canSearch ? (
        <button
          type="button"
          className={buttonClass}
          disabled={search?.phase === 'running'}
          onClick={() => void runSearch()}
        >
          {VOUCHER_COPY.search}
        </button>
      ) : null}
      {search?.phase === 'running' ? (
        <p role="status" className={infoNoteClass}>
          {VOUCHER_COPY.searching}
        </p>
      ) : null}
      {search?.phase === 'done' ? <SearchResult run={search.run} /> : null}
      {file ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={save === 'saving'}
            onClick={() => void saveFile()}
          >
            {save === 'saving' ? VOUCHER_COPY.saving : VOUCHER_COPY.save}
          </button>
          <span className={captionClass}>{file.filename}</span>
          {save === 'saved' ? (
            <span role="status" className={infoNoteClass}>
              {VOUCHER_COPY.saved}
            </span>
          ) : null}
          {save === 'failed' ? (
            <span role="alert" className={warnNoteClass}>
              {VOUCHER_COPY.saveFailed}
            </span>
          ) : null}
        </div>
      ) : (
        <p className={captionClass}>{VOUCHER_COPY.noFile}</p>
      )}
    </section>
  );
}

// The rows HMS returned, each with the copy and open actions for its own confirmation number from HMS.
function SearchResult({ run }: { run: HmsSearchRun }) {
  if (run.kind === 'rows') {
    return (
      <div className="flex flex-col gap-2">
        <p className={captionClass}>{VOUCHER_COPY.pickRow}</p>
        {run.rows.map((row) => (
          <SearchRow key={row.confirmation} row={row} />
        ))}
      </div>
    );
  }
  if (run.kind === 'none')
    return <p className={infoNoteClass}>{noSearchMatchCopy(run.lastName, run.arrival)}</p>;
  if (run.kind === 'capped') return <p className={warnNoteClass}>{AMEND_FIND_COPY.searchCapped}</p>;
  return <p className={warnNoteClass}>{run.message}</p>;
}

function SearchRow({ row }: { row: GuestSearchRow }) {
  const guest = [row.firstName, row.lastName].filter(Boolean).join(' ') || 'Name not shown';
  const dates = row.arrival
    ? `${formatStayDate(row.arrival)}${row.departure ? ` – ${formatStayDate(row.departure)}` : ''}`
    : 'Dates not shown';
  return (
    <div className="rounded-xs flex flex-col gap-1 border border-[#e2e8f0] p-2">
      <p className={valueClass}>{`${guest} · ${row.confirmation}`}</p>
      <p className={captionClass}>{`${dates} · ${row.status || 'status not shown'}`}</p>
      <HmsLinkActions confirmation={row.confirmation} />
    </div>
  );
}
