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
import { fetchAttachmentBlob, triggerBlobDownload, type AttachmentAccessInput } from '@/lib/attachment-access';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { useHmsJob } from '@/lib/quote-workflow/use-hms-job';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Notice, PrimaryButton, SecondaryButton, Section } from '@/components/nava-pane/pane-ui';
import { HmsLinkActions } from './hms-link-actions';
import { HmsAsOf, HmsJobStatusLine } from './hms-queue-status';

const captionClass = 'text-[11px] text-[#64748b]';
const valueClass = 'text-[12.5px] font-semibold text-[#1e293b]';
const infoNoteClass = 'text-[11.5px] text-[#334155]';

export const VOUCHER_ATTACH_COPY = {
  attach: 'Attach to HMS booking',
  prepare: 'Prepare upload for approval',
  attaching: 'Preparing attach…',
  checkInInfor: 'Check in Infor',
  documentsRow: 'Documents row in HMS',
  refused: 'Nava could not prepare the attach. Check in Infor.',
  review: 'Check document and booking',
  reviewing: 'Checking document and booking…',
  reviewFailed: 'Nava could not verify the document and booking. Check in Infor.',
  reviewReady: 'Document available. Booking found. Check they belong together.',
  listedWithHold: 'HMS lists the document by code and name. Another upload needs a safety check.',
} as const;

export type VoucherAttachBindInput = {
  workItemId: string;
  confirmation: string;
  arrival: string;
  lastName: string;
  attachmentId: string;
  sourceMessageId: string;
};

type VoucherAttachBindReply =
  | { status: 'bound'; form?: { confirmation?: string; pdfSha256?: string; attachmentId?: string } }
  | { status: 'refused'; reason: string };

type VoucherAttachWriteView = {
  form?: { action?: string };
  needsCheck?: boolean;
  filingConfigured?: boolean;
  run: { state: string; lastError: string | null; failureClass?: string | null; evidence: { name: string }[] } | null;
};

type VoucherPreviewInput = VoucherAttachBindInput & { sourceMessageId: string };
type VoucherPreviewReply =
  | { status: 'ready'; confirmation: string; arrival: string; documentName: string }
  | { status: 'refused'; reason: string };

type VoucherAttachClient = {
  bind?: (input: VoucherAttachBindInput) => Promise<VoucherAttachBindReply>;
  preview?: (input: VoucherPreviewInput) => Promise<VoucherPreviewReply>;
  writeState?: (input: { workItemId: string }) => Promise<VoucherAttachWriteView | null>;
};

type MailboxOptions = { context: { activeTransportId: string } };
type TrpcAttachRoutes = {
  mail?: {
    getAttachment?: { query: (input: { messageId: string; attachmentId: string },
      options: MailboxOptions & { signal: AbortSignal }) => Promise<{ url: string }> };
  };
  quoteWorkflow?: { bindVoucherAttach?: { mutate: (input: Omit<VoucherAttachBindInput, 'sourceMessageId'>, options: MailboxOptions) => Promise<VoucherAttachBindReply> } };
  hmsApproval?: {
    bindAttach?: { mutate: (input: VoucherAttachBindInput & { internetMessageId: string }, options: MailboxOptions) => Promise<VoucherAttachBindReply> };
    previewAttach?: { mutate: (input: VoucherPreviewInput, options: MailboxOptions) => Promise<VoucherPreviewReply> };
    writeState?: { query: (input: { workItemId: string; internetMessageId: string }, options: MailboxOptions) => Promise<VoucherAttachWriteView | null> };
  };
};

function voucherAttachClientFromTrpc(trpc: unknown, transportId: string | null, internetMessageId: string | null,
  propertyCode: string | null): VoucherAttachClient | null {
  const mailbox = inMailbox(transportId);
  if (!mailbox || !internetMessageId?.trim() || !trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = trpc as TrpcAttachRoutes;
  const bindCloud = propertyCode === 'HRCEN' ? routes.hmsApproval?.bindAttach?.mutate : undefined;
  const bindLegacy = propertyCode === 'HRCEN' ? undefined : routes.quoteWorkflow?.bindVoucherAttach?.mutate;
  const writeState = routes.hmsApproval?.writeState?.query;
  const preview = routes.hmsApproval?.previewAttach?.mutate;
  if (!bindCloud && !bindLegacy && !writeState && !preview) return null;
  return {
    ...(bindCloud ? { bind: (input: VoucherAttachBindInput) => bindCloud({ ...input, internetMessageId }, mailbox) }
      : bindLegacy ? { bind: ({ sourceMessageId: _source, ...input }: VoucherAttachBindInput) => bindLegacy(input, mailbox) } : {}),
    ...(preview ? { preview: (input: VoucherPreviewInput) => preview(input, mailbox) } : {}),
    ...(writeState ? { writeState: (input: { workItemId: string }) => writeState({ ...input, internetMessageId }, mailbox) } : {}),
  };
}

function normalizedSurname(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Find the booking for voucher or proof-of-payment mail. Renders nothing unless the server says this email is a voucher.
 * It resumes an existing guest search first, and queues one on open only when the voucher's guest and arrival are clear.
 */
type VoucherFindCardProps = {
  internetMessageId: string | null;
  trpc: unknown;
  /** The session's active transport and actor scope. Missing scope disables all voucher reads. */
  transportId?: string | null;
  mailboxScope?: string | null;
  /** Saves one attachment. The default fetches the signed URL and downloads the bytes. */
  download?: (input: AttachmentAccessInput) => Promise<void>;
  /** The mailbox sync's committed count. An email the server had not stored yet is checked again when it advances. */
  syncCommitted?: number | null;
  /** True while the mailbox sync still has mail to store. Only then does an unstored email show the waiting note. */
  syncPending?: boolean;
  /** Stored work item the attach form is written onto. */
  workItemId?: string | null;
  /** Attach is a write. Hidden when the pane has writes off. */
  writesEnabled?: boolean;
  /** Registry-backed property for the active mailbox; unknown disables filing actions. */
  propertyCode?: string | null;
};

export function VoucherFindCard(props: VoucherFindCardProps) {
  if (!props.transportId || !props.mailboxScope || !props.internetMessageId) return null;
  // Reset pending replies and previews whenever the selected mail, mailbox or actor/session changes.
  return <VoucherFindCardBody key={JSON.stringify([props.mailboxScope, props.transportId, props.internetMessageId])} {...props} />;
}

function VoucherFindCardBody({
  internetMessageId,
  trpc,
  transportId = null,
  download,
  syncCommitted = null,
  syncPending = false,
  workItemId = null,
  writesEnabled = false,
  propertyCode = null,
}: VoucherFindCardProps) {
  const findClient = useMemo(() => voucherFindClientFromTrpc(trpc, transportId), [trpc, transportId]);
  const jobClient = useMemo(() => amendFindClientFromTrpc(trpc, transportId), [trpc, transportId]);
  const attachClient = useMemo(() => voucherAttachClientFromTrpc(trpc, transportId, internetMessageId, propertyCode),
    [trpc, transportId, internetMessageId, propertyCode]);
  const [reply, setReply] = useState<VoucherFindReply | null>(null);
  const [save, setSave] = useState<SaveStatus>('idle');
  const [attach, setAttach] = useState<'idle' | 'binding' | 'bound' | 'refused'>('idle');
  const [attachStatus, setAttachStatus] = useState<{
    workItemId: string; view: VoucherAttachWriteView | null; valid: boolean;
  } | null>(null);
  const attachWrite = attachStatus?.workItemId === workItemId ? attachStatus.view : null;
  const attachStatusKnown = attachStatus?.workItemId === workItemId && attachStatus.valid && attachWrite !== null;
  const [preview, setPreview] = useState<{ key: string; status: 'loading' | 'ready' | 'refused' } | null>(null);
  const previewKeyRef = useRef('');
  const [detailsRequested, setDetailsRequested] = useState(false);
  const detailsStartedFor = useRef<string | null>(null);
  const mounted = useRef(false);
  const downloads = useRef(new Set<AbortController>());
  const [checkRound, setCheckRound] = useState(0);
  // The sync's committed count as of the last commit this card has seen.
  const committedSeen = useRef(syncCommitted);
  // True while the settled answer is unsynced. A later commit then starts one more check.
  const showingUnsynced = useRef(false);
  // The email the card last checked. A re-check of the same email keeps its answer on screen until the next one arrives.
  const checkedFor = useRef<string | null>(null);
  // The search job runs on the voucher mail's thread, which the check's reply names.
  const replyThread = reply?.status === 'voucher' ? (reply.threadId ?? null) : null;
  const replyMessageId = reply?.status === 'voucher' ? reply.messageId : null;
  const transport = useMemo(
    () => hmsJobTransport(jobClient, replyThread, replyMessageId, { exactSource: true }),
    [jobClient, replyThread, replyMessageId],
  );
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
  const searchRun: HmsSearchRun | null = searchRunFromJob(
    searchJob.view,
    searchJob.queueFailed,
    searchJob.queueFailureMessage,
  );
  const voucherGuest = reply?.status === 'voucher' ? reply.guest : null;
  const singleMatch =
    searchRun?.kind === 'rows' &&
    searchRun.rows.length === 1 &&
    voucherGuest?.lastName !== null &&
    voucherGuest?.lastName !== undefined &&
    normalizedSurname(searchRun.rows[0]!.lastName) === normalizedSurname(voucherGuest.lastName)
      ? searchRun.rows[0]!
      : null;
  const previewKey = JSON.stringify([internetMessageId, workItemId, replyMessageId,
    reply?.status === 'voucher' ? reply.file : null,
    reply?.status === 'voucher' ? reply.guest : null, singleMatch]);
  previewKeyRef.current = previewKey;
  const previewStatus = preview?.key === previewKey ? preview.status : 'idle';
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
  const detailsRun: HmsFindRun | null = findRunFromJob(
    detailsJob.view,
    detailsJob.queueFailed,
    detailsJob.queueFailureMessage,
  );
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
      for (const controller of downloads.current) controller.abort();
      downloads.current.clear();
    };
  }, []);

  useEffect(() => {
    if (checkedFor.current !== internetMessageId) {
      // A new email starts clean: the last email's voucher and save state must not show under it.
      checkedFor.current = internetMessageId;
      setReply(null);
      setSave('idle');
      setAttach('idle');
      setAttachStatus(null);
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

  useEffect(() => {
    if (!attachClient?.writeState || !workItemId) return;
    let live = true;
    const read = () => {
      attachClient.writeState!({ workItemId }).then(
        (view) => {
          if (live) setAttachStatus({ workItemId, view, valid: view !== null });
        },
        // Keep an earlier warning but never enable attach on a failed status read.
        () => { if (live) setAttachStatus((prior) => ({ workItemId,
          view: prior?.workItemId === workItemId ? prior.view : null, valid: false })); },
      );
    };
    read();
    const moving = ['queued', 'claimed', 'running', 'retry_wait'].includes(
      attachWrite?.run?.state ?? '',
    );
    const ms = moving || attach === 'bound' || attach === 'binding' ? 4000 : 30_000;
    const timer = setInterval(read, ms);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [attachClient, workItemId, attach, attachWrite?.run?.state]);

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
      const input = {
        messageId: reply.messageId,
        attachmentId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.sizeBytes,
      };
      if (download) await download(input);
      else {
        const mailbox = inMailbox(transportId);
        const route = (trpc as TrpcAttachRoutes | null)?.mail?.getAttachment;
        if (!mailbox || !route) throw new Error('attachment_unavailable');
        const controller = new AbortController();
        downloads.current.add(controller);
        try {
          const active = () => mounted.current && !controller.signal.aborted;
          const blob = await fetchAttachmentBlob(input, {
            getSignedUrl: async (messageId, attachmentId) => {
              if (!active()) throw new Error('attachment_scope_changed');
              const result = await route.query({ messageId, attachmentId }, { ...mailbox, signal: controller.signal });
              if (!active()) throw new Error('attachment_scope_changed');
              return result.url;
            },
            fetchBytes: (url) => {
              if (!active()) throw new Error('attachment_scope_changed');
              return fetch(url, { signal: controller.signal });
            },
          });
          if (active()) triggerBlobDownload(blob, input.filename);
        } finally {
          downloads.current.delete(controller);
        }
      }
      if (mounted.current) setSave('saved');
    } catch {
      if (mounted.current) setSave('failed');
    }
  };
  const listedWithHold = attachWrite?.run?.lastError === 'confirmed_hold_unsettled';
  const unconfirmedAttach = !listedWithHold && (attachWrite?.run?.lastError === 'upload_unconfirmed' ||
    (attachWrite?.form?.action === 'attach_document' &&
      (attachWrite.needsCheck === true || ['UNKNOWN', 'LEASE_LOST'].includes(attachWrite.run?.failureClass ?? ''))));
  const attachSucceeded = listedWithHold || attachWrite?.run?.state === 'succeeded';
  const attachPdf =
    file !== null && (file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.filename));
  const filingEnabled = propertyCode === 'HRCEN' ? attachWrite?.filingConfigured === true : writesEnabled;
  const canAttach = Boolean(propertyCode && singleMatch && attachPdf && workItemId && reply.messageId && attachClient?.bind &&
    filingEnabled && attachStatusKnown && !unconfirmedAttach && !attachSucceeded &&
    (propertyCode !== 'HRCEN' || previewStatus === 'ready'));
  const canPreview = Boolean(propertyCode === 'HRCEN' && singleMatch && attachPdf && workItemId && reply.messageId && attachClient?.preview &&
    !unconfirmedAttach && !attachSucceeded);
  const reviewAttach = async () => {
    if (!singleMatch || !file || !workItemId || !attachClient?.preview || previewStatus === 'loading') return;
    const key = previewKey;
    const arrival = singleMatch.arrival ?? voucherGuest?.arrival ?? '';
    setPreview({ key, status: 'loading' });
    try {
      const result = await attachClient.preview({ workItemId, sourceMessageId: reply.messageId,
        confirmation: singleMatch.confirmation, arrival, lastName: singleMatch.lastName, attachmentId: file.id });
      if (!mounted.current || previewKeyRef.current !== key) return;
      const ready = result.status === 'ready' && result.confirmation === singleMatch.confirmation &&
        result.arrival === arrival && result.documentName === file.filename;
      setPreview({ key, status: ready ? 'ready' : 'refused' });
    } catch {
      if (mounted.current && previewKeyRef.current === key) setPreview({ key, status: 'refused' });
    }
  };
  const bindAttach = async () => {
    if (!singleMatch || !file || !workItemId || !reply.messageId || !attachClient?.bind || attach === 'binding') return;
    const key = previewKey;
    setAttach('binding');
    try {
      const result = await attachClient.bind({
        workItemId,
        confirmation: singleMatch.confirmation,
        arrival: singleMatch.arrival ?? voucherGuest?.arrival ?? '',
        lastName: singleMatch.lastName,
        attachmentId: file.id,
        sourceMessageId: reply.messageId,
      });
      if (!mounted.current || previewKeyRef.current !== key) return;
      setAttach(result.status === 'bound' ? 'bound' : 'refused');
    } catch {
      if (mounted.current) setAttach('refused');
    }
  };

  // The id is the preview gate's sign that a voucher-only pane has settled (VOUCHER_CARD_SELECTOR in nava-preview-run.ts).
  return (
    <Section title={VOUCHER_COPY.heading} id="quote-voucher-find">
      <p className={captionClass}>{propertyCode === 'HRCEN'
        ? 'Find the booking and review the document before upload.' : VOUCHER_COPY.caption}</p>
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
        queueFailureMessage={searchJob.queueFailureMessage ?? AMEND_FIND_COPY.searchFailed}
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
            {save === 'saved' && !unconfirmedAttach ? (
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
            detailQueueFailureMessage={detailsJob.queueFailureMessage}
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
            canAttach={canAttach}
            cloudFiling={propertyCode === 'HRCEN'}
            canPreview={canPreview}
            previewStatus={previewStatus}
            onPreview={() => void reviewAttach()}
            attaching={attach === 'binding'}
            unconfirmedAttach={unconfirmedAttach}
            listedWithHold={listedWithHold}
            documentsSeen={attachSucceeded && (attachWrite?.run?.evidence.length ?? 0) > 0}
            attachRefused={attach === 'refused'}
            onAttach={() => void bindAttach()}
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
  detailQueueFailureMessage,
  detailStatusFailed,
  checkingDetails,
  showReadDetails,
  onReadDetails,
  onRetryDetails,
  canAttach,
  cloudFiling,
  canPreview,
  previewStatus,
  onPreview,
  attaching,
  unconfirmedAttach,
  listedWithHold,
  documentsSeen,
  attachRefused,
  onAttach,
}: {
  row: GuestSearchRow;
  detailRun: HmsFindRun | null;
  detailView: HmsJobView | null;
  detailQueuing: boolean;
  detailQueueFailed: boolean;
  detailQueueFailureMessage?: string | null;
  detailStatusFailed: boolean;
  checkingDetails: boolean;
  showReadDetails: boolean;
  onReadDetails: () => void;
  onRetryDetails: () => void;
  canAttach: boolean;
  cloudFiling: boolean;
  canPreview: boolean;
  previewStatus: 'idle' | 'loading' | 'ready' | 'refused';
  onPreview: () => void;
  attaching: boolean;
  unconfirmedAttach: boolean;
  listedWithHold: boolean;
  documentsSeen: boolean;
  attachRefused: boolean;
  onAttach: () => void;
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
      <p className={captionClass}>{cloudFiling ? 'Booking found' : VOUCHER_COPY.matchedBooking}</p>
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
        queueFailureMessage={detailQueueFailureMessage ?? AMEND_FIND_COPY.lookupFailed}
      />
      <HmsLinkActions confirmation={row.confirmation} guestSurname={row.lastName} arrival={row.arrival} />
      {unconfirmedAttach ? (
        <Notice tone="warn" role="status">
          {VOUCHER_ATTACH_COPY.checkInInfor}
        </Notice>
      ) : null}
      {listedWithHold ? <Notice tone="warn" role="status">{VOUCHER_ATTACH_COPY.listedWithHold}</Notice> : null}
      {attachRefused && !unconfirmedAttach ? (
        <Notice tone="warn" role="status">
          {VOUCHER_ATTACH_COPY.refused}
        </Notice>
      ) : null}
      {documentsSeen && !unconfirmedAttach ? (
        <p role="status" className={infoNoteClass}>
          {VOUCHER_ATTACH_COPY.documentsRow}
        </p>
      ) : null}
      {canAttach ? (
        <PrimaryButton disabled={attaching} onClick={onAttach}>
          {attaching ? VOUCHER_ATTACH_COPY.attaching : cloudFiling ? VOUCHER_ATTACH_COPY.prepare : VOUCHER_ATTACH_COPY.attach}
        </PrimaryButton>
      ) : null}
      {canPreview ? (
        <PrimaryButton disabled={previewStatus === 'loading'} onClick={onPreview}>
          {previewStatus === 'loading' ? VOUCHER_ATTACH_COPY.reviewing : VOUCHER_ATTACH_COPY.review}
        </PrimaryButton>
      ) : null}
      {canPreview && previewStatus === 'refused' ? <Notice tone="warn" role="status">{VOUCHER_ATTACH_COPY.reviewFailed}</Notice> : null}
      {canPreview && previewStatus === 'ready' ? (
        <>
          <p role="status" className={infoNoteClass}>{VOUCHER_ATTACH_COPY.reviewReady}{!canAttach ? ' Upload is not available yet.' : ''}</p>
          {!canAttach ? <PrimaryButton disabled disabledReason="Document upload is not available yet.">Go</PrimaryButton> : null}
        </>
      ) : null}
    </div>
  );
}
