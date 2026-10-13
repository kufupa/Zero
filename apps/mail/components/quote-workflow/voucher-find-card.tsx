'use client';

import {
  AMEND_FIND_COPY,
  amendFindClientFromTrpc,
  formatStayDate,
  findRunFromJob,
  hmsJobTransport,
  noSearchMatchCopy,
  searchRequestFor,
  searchRunFromJob,
  stayText,
  type HmsFindRun,
  type GuestSearchRow,
  type HmsSearchRun,
  type HmsJobView,
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
import { useHmsJob } from '@/lib/quote-workflow/use-hms-job';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Notice, SecondaryButton, Section } from '@/components/nava-pane/pane-ui';
import { HmsLinkActions } from './hms-link-actions';
import { HmsAsOf, HmsJobStatusLine } from './hms-queue-status';

const captionClass = 'text-[11px] text-[#64748b]';
const valueClass = 'text-[12.5px] font-semibold text-[#1e293b]';
const infoNoteClass = 'text-[11.5px] text-[#334155]';

function normalizedSurname(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Find the booking for voucher or proof-of-payment mail. Renders nothing unless the server says this email is a voucher.
 * It resumes an existing guest search first, and queues one on open only when the voucher's guest and arrival are clear.
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
  const jobClient = useMemo(() => amendFindClientFromTrpc(trpc), [trpc]);
  const [reply, setReply] = useState<VoucherFindReply | null>(null);
  const [save, setSave] = useState<SaveStatus>('idle');
  const [detailsRequested, setDetailsRequested] = useState(false);
  const detailsStartedFor = useRef<string | null>(null);
  const mounted = useRef(false);
  const [checkRound, setCheckRound] = useState(0);
  // The sync's committed count as of the last commit this card has seen.
  const committedSeen = useRef(syncCommitted);
  // True while the settled answer is unsynced. A later commit then starts one more check.
  const showingUnsynced = useRef(false);
  // The email the card last checked. A re-check of the same email keeps its answer on screen until the next one arrives.
  const checkedFor = useRef<string | null>(null);
  // The search job runs on the voucher mail's thread, which the check's reply names.
  const replyThread = reply?.status === 'voucher' ? (reply.threadId ?? null) : null;
  const transport = useMemo(() => hmsJobTransport(jobClient, replyThread), [jobClient, replyThread]);
  // Read back only a search for this voucher's guest: one thread can carry vouchers for different guests.
  const voucherSearch =
    reply?.status === 'voucher' && canSearchVoucher(reply.guest)
      ? searchRequestFor({ lastName: reply.guest.lastName, arrival: reply.guest.arrival })
      : null;
  const resumeFor = voucherSearch && 'request' in voucherSearch ? voucherSearch.request : null;
  const canSearch = resumeFor?.kind === 'search_guest' && transport !== null;
  const searchJob = useHmsJob({
    transport,
    resume:
      resumeFor?.kind === 'search_guest'
        ? { kind: 'search_guest', lastName: resumeFor.lastName, arrival: resumeFor.arrival, departure: null }
        : null,
    scope: internetMessageId,
    autoStartIfMissing: canSearch,
    targetId: 'quote-voucher-find',
  });
  const searchRun: HmsSearchRun | null = searchRunFromJob(searchJob.view, searchJob.queueFailed);
  const voucherGuest = reply?.status === 'voucher' ? reply.guest : null;
  const singleMatch =
    searchRun?.kind === 'rows' &&
    searchRun.rows.length === 1 &&
    voucherGuest?.lastName !== null &&
    voucherGuest?.lastName !== undefined &&
    normalizedSurname(searchRun.rows[0]!.lastName) === normalizedSurname(voucherGuest.lastName)
      ? searchRun.rows[0]!
      : null;
  const detailRequest = singleMatch
    ? {
        kind: 'find' as const,
        confirmation: singleMatch.confirmation,
        ...(singleMatch.arrival ? { arrival: singleMatch.arrival } : {}),
      }
    : null;
  const detailRequestKey = detailRequest
    ? [internetMessageId ?? '', detailRequest.confirmation, detailRequest.arrival ?? ''].join('\u0000')
    : null;
  const detailsJob = useHmsJob({
    transport,
    resume: detailsRequested ? detailRequest : null,
    scope: internetMessageId,
    targetId: 'quote-voucher-find',
  });
  const detailsRun: HmsFindRun | null = findRunFromJob(detailsJob.view, detailsJob.queueFailed);
  const retryableDetails =
    detailsRequested && detailsJob.view?.status === 'done' && detailsRun !== null && detailsRun.kind !== 'found';
  const showReadDetails = singleMatch !== null && (!detailsRequested || retryableDetails);

  useEffect(() => {
    if (
      !detailsRequested ||
      !detailRequest ||
      !detailRequestKey ||
      !detailsJob.readBackSettled ||
      detailsJob.view ||
      detailsJob.queuing ||
      detailsJob.queueFailed ||
      detailsJob.statusFailed ||
      detailsStartedFor.current === detailRequestKey
    ) return;
    detailsStartedFor.current = detailRequestKey;
    detailsJob.start(detailRequest);
  }, [
    detailsRequested,
    detailRequest,
    detailRequestKey,
    detailsJob.readBackSettled,
    detailsJob.view,
    detailsJob.queuing,
    detailsJob.queueFailed,
    detailsJob.statusFailed,
    detailsJob.start,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (checkedFor.current !== internetMessageId) {
      // A new email starts clean: the last email's voucher and save state must not show under it.
      checkedFor.current = internetMessageId;
      setReply(null);
      setSave('idle');
      setDetailsRequested(false);
      detailsStartedFor.current = null;
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
      <Section title={VOUCHER_COPY.heading}>
        <Notice role="status">{VOUCHER_COPY.waitingForSync}</Notice>
      </Section>
    );
  }
  if (reply.status !== 'voucher') return null;
  const { guest, file } = reply;
  const unreadPdfs = reply.unreadPdfs ?? 0;
  const line = voucherGuestLine(guest);
  const surnameConflict = (guest.conflicts?.lastNames.length ?? 0) > 1;
  const arrivalConflict = (guest.conflicts?.arrivals.length ?? 0) > 1;
  // Every warning shares one box, one short line each. Staff still see the search when the surname and arrival were read.
  // An unread voucher PDF already has its own notice in the quote panel, so the surname and arrival lines wait for a
  // readable file. Conflicts come from text that was read, so they stay.
  const conflicts = voucherConflictLines(guest);
  const warnings = [
    unreadPdfs === 0 && guest.lastName === null && !surnameConflict ? VOUCHER_COPY.missingGuest : null,
    unreadPdfs === 0 && guest.lastName !== null && guest.arrival === null && !arrivalConflict
      ? VOUCHER_COPY.missingArrival
      : null,
    ...conflicts,
  ].filter((text): text is string => text !== null);

  // Find waits for the read-back and any auto-start. A click during a slow read-back would queue a second search.
  const searchIdle =
    searchJob.readBackSettled &&
    searchJob.view === null &&
    !searchJob.queuing &&
    !searchJob.queueFailed &&
    !searchJob.statusFailed;
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

  // The id is the preview gate's sign that a voucher-only pane has settled (VOUCHER_CARD_SELECTOR in nava-preview-run.ts).
  return (
    <Section title={VOUCHER_COPY.heading} id="quote-voucher-find">
      <p className={captionClass}>{VOUCHER_COPY.caption}</p>
      {line ? (
        <p data-pii className={valueClass}>
          {line}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <Notice tone="warn">
          <ul className="flex list-disc flex-col gap-0.5 pl-4">
            {warnings.map((text) => (
              <li key={text} data-pii={conflicts.includes(text) || undefined}>
                {text}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {/* Staff search by hand when nothing ran for this email: the queue is off, so no auto-start ran. */}
      {canSearch && searchIdle && resumeFor ? (
        <SecondaryButton onClick={() => searchJob.start(resumeFor)}>{VOUCHER_COPY.search}</SecondaryButton>
      ) : null}
      <HmsJobStatusLine
        view={searchJob.view}
        queuing={searchJob.queuing}
        detail={VOUCHER_COPY.searching}
        onRetry={searchJob.retry}
        statusFailed={searchJob.statusFailed}
        queueFailed={searchJob.queueFailed}
        queueFailureMessage={AMEND_FIND_COPY.searchFailed}
      />
      {searchRun && !singleMatch && !searchJob.queueFailed ? <SearchResult run={searchRun} /> : null}
      {searchJob.view?.status === 'done' ? <HmsAsOf asOf={searchJob.view.asOf} /> : null}
      <div data-testid="voucher-save-and-match" className="flex flex-col gap-2 sm:flex-row sm:items-start">
        {file ? (
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton disabled={save === 'saving'} onClick={() => void saveFile()}>
              {save === 'saving' ? VOUCHER_COPY.saving : VOUCHER_COPY.save}
            </SecondaryButton>
            <span data-pii className={captionClass}>
              {file.filename}
            </span>
            {save === 'saved' ? (
              <span role="status" className={infoNoteClass}>
                {VOUCHER_COPY.saved}
              </span>
            ) : null}
            {save === 'failed' ? (
              <Notice tone="warn" role="alert">
                {VOUCHER_COPY.saveFailed}
              </Notice>
            ) : null}
          </div>
        ) : (
          <p className={captionClass}>{VOUCHER_COPY.noFile}</p>
        )}
        {singleMatch ? (
          <MatchedBooking
            key={singleMatch.confirmation}
            row={singleMatch}
            detailRun={detailsRun}
            detailView={detailsJob.view}
            detailQueuing={detailsJob.queuing}
            detailQueueFailed={detailsJob.queueFailed}
            detailStatusFailed={detailsJob.statusFailed}
            checkingDetails={detailsRequested && !detailsJob.readBackSettled && !detailsJob.statusFailed}
            showReadDetails={showReadDetails}
            onReadDetails={() => {
              if (!detailsRequested) {
                setDetailsRequested(true);
                return;
              }
              if (detailRequest && detailRequestKey) {
                detailsStartedFor.current = detailRequestKey;
                detailsJob.start(detailRequest);
              }
            }}
            onRetryDetails={detailsJob.retry}
          />
        ) : null}
      </div>
    </Section>
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
    return (
      <p data-pii className={infoNoteClass}>
        {noSearchMatchCopy(run.lastName, run.arrival)}
      </p>
    );
  if (run.kind === 'capped') return <Notice tone="warn">{AMEND_FIND_COPY.searchCapped}</Notice>;
  return <Notice tone="warn">{run.message}</Notice>;
}

function SearchRow({ row }: { row: GuestSearchRow }) {
  const guest = [row.firstName, row.lastName].filter(Boolean).join(' ') || 'Name not shown';
  const dates = row.arrival
    ? `${formatStayDate(row.arrival)}${row.departure ? ` – ${formatStayDate(row.departure)}` : ''}`
    : 'Dates not shown';
  return (
    <div className="rounded-xs flex flex-col gap-1 border border-[#e2e8f0] p-2">
      <p data-pii className={valueClass}>{`${guest} · ${row.confirmation}`}</p>
      <p className={captionClass}>{`${dates} · ${row.status || 'status not shown'}`}</p>
      <HmsLinkActions confirmation={row.confirmation} guestSurname={row.lastName} arrival={row.arrival} />
    </div>
  );
}

function MatchedBooking({
  row,
  detailRun,
  detailView,
  detailQueuing,
  detailQueueFailed,
  detailStatusFailed,
  checkingDetails,
  showReadDetails,
  onReadDetails,
  onRetryDetails,
}: {
  row: GuestSearchRow;
  detailRun: HmsFindRun | null;
  detailView: HmsJobView | null;
  detailQueuing: boolean;
  detailQueueFailed: boolean;
  detailStatusFailed: boolean;
  checkingDetails: boolean;
  showReadDetails: boolean;
  onReadDetails: () => void;
  onRetryDetails: () => void;
}) {
  const guest = [row.firstName, row.lastName].filter(Boolean).join(' ') || 'Name not shown';
  const dates = row.arrival
    ? `${formatStayDate(row.arrival)}${row.departure ? ` – ${formatStayDate(row.departure)}` : ''}`
    : 'Dates not shown';
  const commercial = detailRun?.kind === 'found' ? detailRun.commercial : undefined;
  const company = stayText(commercial?.company?.name) ?? stayText(commercial?.company?.nativeId);
  const agency = stayText(commercial?.agency?.name) ?? stayText(commercial?.agency?.nativeId);
  return (
    <div
      data-testid="voucher-matched-booking"
      className="rounded-xs flex flex-col gap-1 border border-[#b7d5ef] bg-[#f5faff] p-2"
    >
      <p className={captionClass}>{VOUCHER_COPY.matchedBooking}</p>
      <p data-pii className={valueClass}>{`${guest} · ${row.confirmation}`}</p>
      <p className={captionClass}>{`${dates} · ${row.status || 'status not shown'}`}</p>
      {company ? <p className={captionClass}>{`Company: ${company}`}</p> : null}
      {agency ? <p className={captionClass}>{`Booking agency: ${agency}`}</p> : null}
      {checkingDetails ? <p role="status" className={captionClass}>Checking for saved HMS booking details…</p> : null}
      {showReadDetails ? (
        <SecondaryButton onClick={onReadDetails}>{VOUCHER_COPY.readDetails}</SecondaryButton>
      ) : null}
      <HmsJobStatusLine
        view={detailView}
        queuing={detailQueuing}
        detail={VOUCHER_COPY.readingDetails}
        onRetry={onRetryDetails}
        statusFailed={detailStatusFailed}
        queueFailed={detailQueueFailed}
        queueFailureMessage={AMEND_FIND_COPY.lookupFailed}
      />
      <HmsLinkActions confirmation={row.confirmation} guestSurname={row.lastName} arrival={row.arrival} />
    </div>
  );
}
