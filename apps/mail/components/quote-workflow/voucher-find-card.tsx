'use client';

import {
  AMEND_FIND_COPY,
  amendFindClientFromTrpc,
  formatStayDate,
  findRequestFor,
  findRunFromJob,
  hmsJobTransport,
  noSearchMatchCopy,
  searchRequestFor,
  searchRunFromJob,
  sendableArrival,
  stayText,
  type HmsFindRun,
  type GuestSearchRow,
  type HmsSearchRun,
  type HmsJobView,
  type HmsJobRequest,
} from '@/lib/quote-workflow/amend-find';
import {
  canSearchVoucher,
  VOUCHER_COPY,
  voucherConflictLines,
  voucherFindClientFromTrpc,
  voucherReviewClientFromTrpc,
  voucherGuestLine,
  type VoucherFindReply,
  type VoucherReview,
} from '@/lib/quote-workflow/voucher-find';
import { fetchAttachmentBlob, triggerBlobDownload, type AttachmentAccessInput } from '@/lib/attachment-access';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import type { MailSourceSelection } from '@/lib/quote-workflow/backend-bind';
import type { HmsPreparedReceipt } from '@/lib/quote-workflow/hms-write';
import type { PropertySwitch } from '@/lib/reservation-workflow/types';
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

type SelectedSource = { threadId: string; messageId: string; sourceHash: string };
type DocumentSource = { sha256: string; snapshotDigest: string };

export type VoucherAttachBindInput = {
  workItemId: string;
  confirmation: string;
  arrival: string;
  lastName: string;
  attachmentId: string;
  sourceMessageId: string;
  selectedSource?: SelectedSource;
  documentSource?: DocumentSource;
  revisionSeq?: number;
  expectedStay?: { firstName: string; status: string; departure: string };
};

type VoucherAttachBindReply =
  | { status: 'bound'; formDigest?: string; form?: {
      confirmation?: string; arrival?: string; lastName?: string; attachmentId?: string; documentName?: string;
      sourceDocumentName?: string;
      pdfSha256?: string; sourceSnapshotDigest?: string; sourceMessageId?: string; sourceThreadId?: string; sourceHash?: string;
    } }
  | { status: 'refused'; reason: string; retryable?: boolean };

type VoucherAttachWriteView = {
  form?: { action?: string };
  grant?: { fingerprintMatches: boolean } | null;
  needsCheck?: boolean;
  filingConfigured?: boolean;
  run: { state: string; lastError: string | null; failureClass?: string | null;
    reviewed?: 'ok' | 'flag' | null; evidence: { name: string }[] } | null;
};

type VoucherPreviewInput = VoucherAttachBindInput & { sourceMessageId: string };
type VoucherPreviewReply =
  | { status: 'ready'; confirmation: string; arrival: string; documentName: string;
      documentSource: DocumentSource; revisionSeq: number }
  | { status: 'refused'; reason: string };

type VoucherAttachClient = {
  bind?: (input: VoucherAttachBindInput) => Promise<VoucherAttachBindReply>;
  preview?: (input: VoucherPreviewInput) => Promise<VoucherPreviewReply>;
  writeState?: (input: { workItemId: string }) => Promise<VoucherAttachWriteView | null>;
  prepare?: (input: { workItemId: string; confirmation: string; arrival: string; formDigest: string;
    selectedSource: SelectedSource }) => Promise<HmsPreparedReceipt | null>;
};

type MailboxOptions = { context: { activeTransportId: string } };
type TrpcAttachRoutes = {
  mail?: {
    getAttachment?: { query: (input: { messageId: string; attachmentId: string },
      options: MailboxOptions & { signal: AbortSignal }) => Promise<{ url: string }> };
  };
  quoteWorkflow?: { bindVoucherAttach?: { mutate: (input: Omit<VoucherAttachBindInput, 'sourceMessageId' | 'selectedSource'>, options: MailboxOptions) => Promise<VoucherAttachBindReply> } };
  hmsApproval?: {
    bindAttach?: { mutate: (input: VoucherAttachBindInput & { internetMessageId: string; propertySwitch?: PropertySwitch }, options: MailboxOptions) => Promise<VoucherAttachBindReply> };
    previewAttach?: { mutate: (input: VoucherPreviewInput & { propertySwitch?: PropertySwitch }, options: MailboxOptions) => Promise<VoucherPreviewReply> };
    writeState?: { query: (input: { workItemId: string; internetMessageId: string; selectedSource?: SelectedSource; propertySwitch?: PropertySwitch }, options: MailboxOptions) => Promise<VoucherAttachWriteView | null> };
    prepare?: { mutate: (input: { workItemId: string; internetMessageId: string; confirmation: string; arrival: string;
      formDigest: string; selectedSource: SelectedSource; propertySwitch?: PropertySwitch }, options: MailboxOptions) => Promise<
        | { status: 'prepared'; preparedRef: string; propertyCode: string; businessDigest: string; revision: number;
            generationId: string; expiresAtIso: string; warnings: string[] }
        | { status: 'refused'; reason: string }> };
  };
};

function voucherAttachClientFromTrpc(trpc: unknown, transportId: string | null, internetMessageId: string | null,
  propertyCode: string | null, selectedSource?: SelectedSource | null,
  filingCapability?: import('@/lib/reservation-workflow/types').PropertyConfiguration['capabilities']['attach'] | null): VoucherAttachClient | null {
  const mailbox = inMailbox(transportId);
  if (!mailbox || !internetMessageId?.trim() || !trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = trpc as TrpcAttachRoutes;
  const cloud = propertyCode === 'HRCEN' || propertyCode === 'HRDAV' || propertyCode === 'HRDAVS';
  const propertySwitch = propertyCode === 'HRDAV' || propertyCode === 'HRDAVS' ? propertyCode : undefined;
  const selectedProperty: { propertySwitch?: 'HRDAV' | 'HRDAVS' } = propertySwitch ? { propertySwitch } : {};
  const canPrepare = propertyCode === 'HRCEN' && filingCapability === undefined ||
    Boolean(filingCapability && ['prepare-only', 'lab', 'staff-enabled'].includes(filingCapability.status));
  const bindCloud = cloud && canPrepare ? routes.hmsApproval?.bindAttach?.mutate : undefined;
  const bindLegacy = cloud ? undefined : routes.quoteWorkflow?.bindVoucherAttach?.mutate;
  const writeState = routes.hmsApproval?.writeState?.query;
  const preview = canPrepare ? routes.hmsApproval?.previewAttach?.mutate : undefined;
  const prepare = cloud && canPrepare ? routes.hmsApproval?.prepare?.mutate : undefined;
  if (!bindCloud && !bindLegacy && !writeState && !preview) return null;
  return {
    ...(bindCloud ? { bind: (input: VoucherAttachBindInput) => bindCloud({ ...input, internetMessageId, ...selectedProperty }, mailbox) }
      : bindLegacy ? { bind: ({ sourceMessageId: _source, selectedSource: _selection,
        documentSource: _document, revisionSeq: _revision, expectedStay: _stay, ...input }: VoucherAttachBindInput) => bindLegacy(input, mailbox) } : {}),
    ...(preview ? { preview: (input: VoucherPreviewInput) => preview({ ...input, ...selectedProperty }, mailbox) } : {}),
    ...(prepare ? { prepare: async (input: { workItemId: string; confirmation: string; arrival: string;
      formDigest: string; selectedSource: SelectedSource }) => {
      const result = await prepare({ ...input, internetMessageId, ...selectedProperty }, mailbox);
      if (result.status !== 'prepared' || result.propertyCode !== propertyCode || result.businessDigest !== input.formDigest ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.preparedRef) ||
          !Number.isSafeInteger(result.revision) || result.revision < 0 || !result.generationId ||
          !Number.isFinite(Date.parse(result.expiresAtIso)) || Date.parse(result.expiresAtIso) <= Date.now() ||
          !Array.isArray(result.warnings) || !result.warnings.every(warning => typeof warning === 'string')) return null;
      return { preparedRef: result.preparedRef, expectedRevision: result.revision, generationId: result.generationId,
        expiresAtIso: result.expiresAtIso, warnings: result.warnings };
    } } : {}),
    ...(writeState ? { writeState: (input: { workItemId: string }) => writeState({ ...input, internetMessageId,
      ...(selectedSource ? { selectedSource } : {}), ...selectedProperty }, mailbox) } : {}),
  };
}

function normalizedSurname(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
type VoucherSearchRequest = Extract<HmsJobRequest, { kind: 'search_guest' }>;
type VoucherSearchForm = { confirmation: string; lastName: string; arrival: string; departure: string };
type VoucherFindRequest = Extract<HmsJobRequest, { kind: 'find' }> & { arrival: string };

function searchKey(request: VoucherSearchRequest): string {
  return JSON.stringify([normalizedSurname(request.lastName), request.arrival, request.departure ?? '']);
}

/**
 * Find the booking for voucher or proof-of-payment mail. Renders nothing unless the server says this email is a voucher.
 * It resumes an existing guest search first, and queues one on open only when the voucher's guest and arrival are clear.
 */
type VoucherFindCardProps = {
  internetMessageId: string | null;
  lookupSelection?: MailSourceSelection;
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
  /** An approval card for this same selected work item is mounted. */
  approvalAvailable?: boolean;
  /** Refresh the sibling approval card only after the reviewed form and snapshot are stored. */
  onPrepared?: (formDigest?: string, receipt?: HmsPreparedReceipt) => void;
  /** Registry-backed property for the active mailbox; unknown disables filing actions. */
  propertyCode?: string | null;
  filingCapability?: import('@/lib/reservation-workflow/types').PropertyConfiguration['capabilities']['attach'] | null;
  /** Selection generation and current source keep every search and approval on this email revision. */
  selectionEpoch?: number | null;
  selectedSource?: SelectedSource | null;
  reviewSource?: SelectedSource | null;
  selectionCurrent?: boolean;
  /** The stored approval no longer describes the search or selected target. */
  onTargetChanged?: () => void;
};

export function VoucherFindCard(props: VoucherFindCardProps) {
  if (!props.transportId || !props.mailboxScope || !props.internetMessageId) return null;
  // Reset pending replies and previews whenever the selected mail, mailbox or actor/session changes.
  return <VoucherFindCardBody key={JSON.stringify([props.mailboxScope, props.transportId, props.internetMessageId,
    props.lookupSelection, props.propertyCode, props.selectionEpoch, props.selectedSource?.threadId, props.selectedSource?.messageId,
    props.selectedSource?.sourceHash, props.reviewSource?.threadId, props.reviewSource?.messageId,
    props.reviewSource?.sourceHash, props.selectionCurrent])} {...props} />;
}

function VoucherFindCardBody({
  internetMessageId,
  lookupSelection,
  trpc,
  transportId = null,
  download,
  syncCommitted = null,
  syncPending = false,
  workItemId = null,
  writesEnabled = false,
  approvalAvailable = false,
  onPrepared,
  propertyCode = null,
  filingCapability,
  selectionEpoch = null,
  selectedSource,
  reviewSource,
  selectionCurrent = true,
  onTargetChanged,
}: VoucherFindCardProps) {
  const cloudFiling = propertyCode === 'HRCEN' || propertyCode === 'HRDAV' || propertyCode === 'HRDAVS';
  const findClient = useMemo(() => voucherFindClientFromTrpc(trpc, transportId), [trpc, transportId]);
  const reviewClient = useMemo(() => voucherReviewClientFromTrpc(trpc, transportId), [trpc, transportId]);
  const jobClient = useMemo(() => amendFindClientFromTrpc(trpc, transportId), [trpc, transportId]);
  const attachClient = useMemo(() => voucherAttachClientFromTrpc(trpc, transportId, internetMessageId, propertyCode, selectedSource, filingCapability),
    [trpc, transportId, internetMessageId, propertyCode, selectedSource?.threadId, selectedSource?.messageId, selectedSource?.sourceHash, filingCapability]);
  const [reply, setReply] = useState<VoucherFindReply | null>(null);
  const [inventory, setInventory] = useState<Extract<VoucherFindReply, { status: 'voucher' }> | null>(null);
  const [selectedFileId, setSelectedFileId] = useState('');
  const selectedFileRef = useRef('');
  const [verifiedFileId, setVerifiedFileId] = useState('');
  const [fileError, setFileError] = useState(false);
  const [save, setSave] = useState<SaveStatus>('idle');
  const [attachState, setAttach] = useState<{
    key: string; workItemId: string; status: 'binding' | 'bound' | 'refused' | 'unknown';
  } | null>(null);
  const bindingRequest = useRef(false);
  const [attachStatus, setAttachStatus] = useState<{
    workItemId: string; view: VoucherAttachWriteView | null; valid: boolean;
  } | null>(null);
  const attachWrite = attachStatus?.workItemId === workItemId ? attachStatus.view : null;
  const [voucherReview, setVoucherReview] = useState<VoucherReview | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState(false);
  const reviewGeneration = useRef(0);
  const reviewSelection = reviewSource ?? selectedSource;
  const reviewScope = JSON.stringify([transportId, workItemId, reviewSelection?.threadId, reviewSelection?.messageId,
    reviewSelection?.sourceHash, selectionCurrent]);
  const reviewScopeRef = useRef(reviewScope);
  reviewScopeRef.current = reviewScope;
  const attachStatusKnown = attachStatus?.workItemId === workItemId && attachStatus.valid && attachWrite !== null;
  const [preview, setPreview] = useState<{ key: string; status: 'loading' | 'ready' | 'refused';
    documentSource?: DocumentSource; revisionSeq?: number } | null>(null);
  const previewKeyRef = useRef('');
  const [detailsRequested, setDetailsRequested] = useState(false);
  const detailsStartedFor = useRef<string | null>(null);
  const [searchForm, setSearchForm] = useState<VoucherSearchForm>({ confirmation: '', lastName: '', arrival: '', departure: '' });
  const [submittedSearch, setSubmittedSearch] = useState<VoucherSearchRequest | null>(null);
  const [submittedDirect, setSubmittedDirect] = useState<VoucherFindRequest | null>(null);

  useEffect(() => {
    const generation = ++reviewGeneration.current;
    if (!reviewClient || !workItemId || !reviewSelection || !selectionCurrent) {
      setVoucherReview(null);
      return;
    }
    let current = true;
    reviewClient.read({ workItemId, source: reviewSelection }).then(
      (result) => { if (current && reviewGeneration.current === generation) { setVoucherReview(result); setReviewError(false); } },
      () => { if (current && reviewGeneration.current === generation) { setVoucherReview(null); setReviewError(true); } },
    );
    return () => { current = false; };
  }, [reviewClient, workItemId, reviewSelection?.threadId, reviewSelection?.messageId, reviewSelection?.sourceHash,
    selectionCurrent, attachWrite?.run?.state]);
  const [directPicked, setDirectPicked] = useState<{ key: string; row: GuestSearchRow } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRevision, setSearchRevision] = useState(0);
  const [picked, setPicked] = useState<{ searchKey: string; row: GuestSearchRow } | null>(null);
  const seededReply = useRef<string | null>(null);
  const editedSearch = useRef(false);
  const targetChanged = useRef(onTargetChanged);
  targetChanged.current = onTargetChanged;
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
  const fileReady = Boolean(selectedFileId && verifiedFileId === selectedFileId &&
    reply?.status === 'voucher' && reply.file?.id === selectedFileId);
  const noEligiblePdf = inventory?.files?.length === 0 && reply?.status === 'voucher' &&
    inventory.messageId === reply.messageId && inventory.threadId === reply.threadId;
  const failedFile = fileError && !fileReady && reply?.status === 'voucher' && inventory !== null &&
    inventory.messageId === reply.messageId && inventory.threadId === reply.threadId
    ? inventory.files?.find((file) => file.id === selectedFileId) ?? null : null;
  const lookupReady = fileReady || noEligiblePdf || Boolean(failedFile);
  selectedFileRef.current = fileReady ? selectedFileId : noEligiblePdf && reply?.status === 'voucher'
    ? reply.file?.id ?? '' : selectedFileId;
  const documentSource = reply?.status === 'voucher' ? reply.documentSource : undefined;
  const validDocumentSource = Boolean(documentSource && /^[a-f0-9]{64}$/.test(documentSource.sha256) &&
    /^[a-f0-9]{64}$/.test(documentSource.snapshotDigest));
  const emailMatches = selectionCurrent &&
    (selectedSource === undefined ? !cloudFiling : Boolean(selectedSource &&
    selectedSource.threadId === replyThread && selectedSource.messageId === replyMessageId &&
    /^[a-f0-9]{64}$/.test(selectedSource.sourceHash)));
  const sourceMatches = fileReady && emailMatches && (!cloudFiling || validDocumentSource);
  // Payment-only views have no filing source; their reads still use the exact checked message.
  const lookupSourceMatches = lookupReady && (emailMatches || (selectedSource === undefined && selectionCurrent));
  const propertySwitch = propertyCode === 'HRDAV' || propertyCode === 'HRDAVS' ? propertyCode : undefined;
  const transport = useMemo(
    () => lookupSourceMatches && propertyCode ? hmsJobTransport(jobClient, replyThread, replyMessageId,
      { exactSource: true, ...(selectedSource?.sourceHash ? { sourceHash: selectedSource.sourceHash } : {}),
        ...(propertySwitch ? { propertySwitch } : {}) }) : null,
    [jobClient, replyThread, replyMessageId, lookupSourceMatches, selectedSource?.sourceHash, propertyCode, propertySwitch],
  );
  // Read back only a search for this voucher's guest: one thread can carry vouchers for different guests.
  const voucherSearch =
    lookupReady && !failedFile && reply?.status === 'voucher' && canSearchVoucher(reply.guest)
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
    scope: JSON.stringify([internetMessageId, selectedFileId]),
    autoStartIfMissing: canSearch,
    targetId: 'quote-voucher-find',
  });
  const directJob = useHmsJob({ transport, resume: null, scope: JSON.stringify([internetMessageId, selectedFileId]),
    targetId: 'quote-voucher-find' });
  const directKey = submittedDirect && searchForm.confirmation.trim() === submittedDirect.confirmation &&
    searchForm.arrival === submittedDirect.arrival
    ? JSON.stringify([submittedDirect.confirmation, submittedDirect.arrival]) : null;
  const directRequestMatches = Boolean(directKey && directJob.view?.request?.kind === 'find' &&
    directJob.view.request.confirmation === submittedDirect?.confirmation &&
    directJob.view.request.arrival === submittedDirect?.arrival);
  const directRun = directRequestMatches ? findRunFromJob(directJob.view, directJob.queueFailed, directJob.queueFailureMessage) : null;
  const directStay = directRun?.kind === 'found' && !directRun.arrivalMismatch &&
    directRun.stay.confirmation === submittedDirect?.confirmation && directRun.stay.arrival === submittedDirect?.arrival &&
    directRun.stay.lastName ? directRun.stay : null;
  const directRow: GuestSearchRow | null = directStay ? { confirmation: directStay.confirmation!,
    lastName: directStay.lastName!, firstName: directStay.firstName ?? '', status: directStay.status ?? '',
    arrival: directStay.arrival, departure: directStay.departure } : null;
  const directMatch = directPicked && directPicked.key === directKey && directRow &&
    JSON.stringify(directPicked.row) === JSON.stringify(directRow) ? directPicked.row : null;
  const currentSearch = searchRequestFor(searchForm);
  const currentSearchKey = 'request' in currentSearch && currentSearch.request.kind === 'search_guest'
    ? searchKey(currentSearch.request) : null;
  const submittedKey = submittedSearch ? searchKey(submittedSearch) : null;
  const resultRequest = searchJob.view?.request;
  const currentResult = Boolean(submittedKey && currentSearchKey === submittedKey &&
    (!resultRequest || (resultRequest.kind === 'search_guest' && searchKey(resultRequest) === submittedKey)));
  const searchRun: HmsSearchRun | null = currentResult
    ? searchRunFromJob(searchJob.view, searchJob.queueFailed, searchJob.queueFailureMessage) : null;
  const singleMatch =
    searchRun?.kind === 'rows' &&
    searchRun.rows.length === 1 &&
    submittedSearch !== null &&
    sendableArrival(searchRun.rows[0]!.arrival) === submittedSearch.arrival &&
    normalizedSurname(searchRun.rows[0]!.lastName) === normalizedSurname(submittedSearch.lastName)
      ? searchRun.rows[0]!
      : null;
  const pickedMatch = picked && picked.searchKey === submittedKey && searchRun?.kind === 'rows' &&
    searchRun.rows.some((row) => JSON.stringify(row) === JSON.stringify(picked.row)) ? picked.row : null;
  // For Cloud filing, even one surname match needs an explicit choice and an exact fresh HMS read.
  const explicitPick = pickedMatch ?? directMatch;
  const selectedMatch = explicitPick ?? (cloudFiling || submittedDirect ? null : singleMatch);
  const previewKey = JSON.stringify([internetMessageId, selectionEpoch, selectedSource?.sourceHash, workItemId,
    replyMessageId, approvalAvailable, searchRevision, currentSearchKey,
    reply?.status === 'voucher' ? reply.file : null, documentSource,
    reply?.status === 'voucher' ? reply.guest : null, selectedMatch]);
  previewKeyRef.current = previewKey;
  const previewStatus = preview?.key === previewKey ? preview.status : 'idle';
  const attach = attachState?.key === previewKey ? attachState.status : 'idle';
  const detailCandidate = selectedMatch
    ? findRequestFor(selectedMatch.confirmation, selectedMatch.arrival ?? submittedSearch?.arrival) : null;
  const detailRequest = detailCandidate && 'request' in detailCandidate && detailCandidate.request.kind === 'find'
    ? detailCandidate.request : null;
  const detailRequestKey = detailRequest
    ? [internetMessageId ?? '', detailRequest.confirmation, detailRequest.arrival ?? ''].join('\u0000')
    : null;
  const detailsJob = useHmsJob({
    transport,
    // Explicit picks always get a new exact read; a previous result is not proof of the current row.
    resume: detailsRequested && !explicitPick ? detailRequest : null,
    scope: JSON.stringify([internetMessageId, selectedFileId]),
    targetId: 'quote-voucher-find',
  });
  const detailsRequestMatches = Boolean(detailRequest && detailsJob.view?.request?.kind === 'find' &&
    detailsJob.view.request.confirmation === detailRequest.confirmation &&
    (detailsJob.view.request.arrival ?? null) === (detailRequest.arrival ?? null));
  const detailsRun: HmsFindRun | null = detailsRequestMatches || (!detailsJob.view && detailsJob.queueFailed)
    ? findRunFromJob(detailsJob.view, detailsJob.queueFailed, detailsJob.queueFailureMessage) : null;
  const pickedVerified = Boolean(explicitPick && detailRequest && detailRequestKey &&
    detailsStartedFor.current === detailRequestKey && !detailsJob.queuing && detailsRequestMatches && detailsRun?.kind === 'found' &&
    !detailsRun.arrivalMismatch && detailsRun.stay.confirmation === explicitPick.confirmation &&
    detailsRun.stay.arrival === detailRequest.arrival && detailsRun.stay.lastName &&
    normalizedSurname(detailsRun.stay.lastName) === normalizedSurname(explicitPick.lastName) &&
    (!explicitPick.firstName || (detailsRun.stay.firstName &&
      normalizedSurname(detailsRun.stay.firstName) === normalizedSurname(explicitPick.firstName))) &&
    (!cloudFiling || ((!explicitPick.departure || detailsRun.stay.departure === explicitPick.departure) &&
      (!explicitPick.status || normalizedSurname(detailsRun.stay.status ?? '') === normalizedSurname(explicitPick.status)))));
  const retryableDetails =
    detailsRequested && detailsJob.view?.status === 'done' && detailsRun !== null && detailsRun.kind !== 'found';
  const showReadDetails = selectedMatch !== null && (!detailsRequested || retryableDetails);

  const replySeed = lookupReady && reply?.status === 'voucher'
    ? JSON.stringify([reply.messageId, reply.threadId, failedFile ? null : reply.guest, failedFile ?? reply.file]) : null;
  useEffect(() => {
    if (!replySeed || reply?.status !== 'voucher' || seededReply.current === replySeed) return;
    seededReply.current = replySeed;
    if (editedSearch.current) {
      targetChanged.current?.();
      return;
    }
    const form = failedFile ? { confirmation: '', lastName: '', arrival: '', departure: '' }
      : { confirmation: reply.guest.confirmationNumber ?? '', lastName: reply.guest.lastName ?? '',
        arrival: reply.guest.arrival ?? '', departure: '' };
    const request = !failedFile && canSearchVoucher(reply.guest) ? searchRequestFor(form) : null;
    setSearchForm(form);
    setSubmittedSearch(request && 'request' in request && request.request.kind === 'search_guest' ? request.request : null);
    setSearchError(null);
    setPicked(null);
    setDirectPicked(null);
    setSubmittedDirect(null);
    setDetailsRequested(false);
    detailsStartedFor.current = null;
    setSearchRevision((revision) => revision + 1);
    targetChanged.current?.();
  }, [reply, replySeed]);

  useEffect(() => {
    if (
      !detailsRequested ||
      !detailRequest ||
      !detailRequestKey ||
      (!explicitPick && (!detailsJob.readBackSettled || detailsJob.view || detailsJob.queuing ||
        detailsJob.queueFailed || detailsJob.statusFailed)) ||
      detailsStartedFor.current === detailRequestKey
    ) return;
    detailsStartedFor.current = detailRequestKey;
    detailsJob.start(detailRequest);
  }, [
    detailsRequested,
    explicitPick,
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
      setAttach(null);
      setAttachStatus(null);
      setDetailsRequested(false);
      detailsStartedFor.current = null;
    }
    showingUnsynced.current = false;
    if (!findClient || !internetMessageId) return;
    let live = true;
    // The commit count when this check starts. A commit that lands while the check runs is compared when it answers.
    const startedAt = committedSeen.current;
    findClient.check({ internetMessageId, ...(lookupSelection ? { selection: lookupSelection } : {}) }).then(
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
        if (next.status === 'voucher') {
          setInventory(next);
          if (next.files?.length === 1) setSelectedFileId(next.files[0]!.id);
        }
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
  }, [findClient, internetMessageId, lookupSelection, checkRound]);

  useEffect(() => {
    if (!findClient || !internetMessageId || !selectedFileId || !inventory?.files?.some((file) => file.id === selectedFileId)) return;
    let live = true;
    setVerifiedFileId('');
    setFileError(false);
    findClient.check({ internetMessageId, ...(lookupSelection ? { selection: lookupSelection } : {}), attachmentId: selectedFileId }).then(
      (next) => {
        if (!live) return;
        if (next.status !== 'voucher' || next.messageId !== inventory.messageId || next.threadId !== inventory.threadId ||
            next.file?.id !== selectedFileId || !next.files?.some((file) => file.id === selectedFileId) ||
            (cloudFiling && (!/^[a-f0-9]{64}$/.test(next.documentSource?.sha256 ?? '') ||
              !/^[a-f0-9]{64}$/.test(next.documentSource?.snapshotDigest ?? '')))) {
          setFileError(true);
          return;
        }
        setReply(next);
        setVerifiedFileId(selectedFileId);
      },
      () => { if (live) setFileError(true); },
    );
    return () => { live = false; };
  }, [findClient, internetMessageId, lookupSelection, selectedFileId, inventory, propertyCode]);

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
  const guest = failedFile ? { ...reply.guest, lastName: null, arrival: null, confirmationNumber: null, conflicts: undefined }
    : reply.guest;
  const file = failedFile ?? (lookupReady ? reply.file : null);
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
      if (mounted.current && selectedFileRef.current === file.id) setSave('saved');
    } catch {
      if (mounted.current && selectedFileRef.current === file.id) setSave('failed');
    }
  };
  const listedWithHold = attachWrite?.run?.lastError === 'confirmed_hold_unsettled';
  const unconfirmedAttach = !listedWithHold && (attachWrite?.run?.lastError === 'upload_unconfirmed' ||
    (attachWrite?.form?.action === 'attach_document' &&
      (attachWrite.needsCheck === true || ['UNKNOWN', 'LEASE_LOST'].includes(attachWrite.run?.failureClass ?? ''))));
  const attachSucceeded = listedWithHold || (attachWrite?.form?.action === 'attach_document' &&
    (cloudFiling ? attachWrite.grant?.fingerprintMatches === true :
      attachWrite.grant?.fingerprintMatches !== false) && attachWrite.run?.state === 'succeeded');
  const attachMoving = ['queued', 'claimed', 'running', 'retry_wait'].includes(attachWrite?.run?.state ?? '');
  const bindingFrozen = attachState?.workItemId === workItemId &&
    (attachState.status === 'binding' || attachState.status === 'unknown' ||
      (attachState.status === 'bound' && !attachStatusKnown));
  const searchFrozen = bindingFrozen || unconfirmedAttach || attachMoving || listedWithHold ||
    (attachSucceeded && attachWrite?.run?.reviewed !== 'flag');
  const invalidateTarget = () => {
    previewKeyRef.current = '';
    setPicked(null);
    setDirectPicked(null);
    setDetailsRequested(false);
    detailsStartedFor.current = null;
    setSearchRevision((revision) => revision + 1);
    targetChanged.current?.();
  };
  const selectFile = (id: string) => {
    if (searchFrozen || bindingRequest.current || id === selectedFileId) return;
    invalidateTarget();
    setVerifiedFileId('');
    setFileError(false);
    selectedFileRef.current = id;
    setSelectedFileId(id);
    setSearchForm({ confirmation: '', lastName: '', arrival: '', departure: '' });
    setSubmittedSearch(null);
    setSubmittedDirect(null);
    setSearchError(null);
    setPreview(null);
    setSave('idle');
    seededReply.current = null;
    editedSearch.current = false;
  };
  const editSearch = (field: keyof VoucherSearchForm, value: string) => {
    if (searchFrozen || bindingRequest.current) return;
    editedSearch.current = true;
    setSearchForm((current) => ({ ...current, [field]: value }));
    setSubmittedSearch(null);
    setSubmittedDirect(null);
    setSearchError(null);
    invalidateTarget();
  };
  const searchByFields = () => {
    if (searchFrozen || bindingRequest.current || !transport) return;
    const request = searchRequestFor(searchForm);
    invalidateTarget();
    setSubmittedDirect(null);
    if ('error' in request || request.request.kind !== 'search_guest') {
      setSubmittedSearch(null);
      setSearchError('error' in request ? request.error : AMEND_FIND_COPY.searchInvalid);
      return;
    }
    setSearchError(null);
    setSubmittedSearch(request.request);
    searchJob.start(request.request);
  };
  const findByConfirmation = () => {
    if (searchFrozen || bindingRequest.current || !transport) return;
    const request = findRequestFor(searchForm.confirmation.trim(), searchForm.arrival);
    invalidateTarget();
    setSubmittedSearch(null);
    if ('error' in request || request.request.kind !== 'find' || !request.request.arrival) {
      setSubmittedDirect(null);
      setSearchError('Check the confirmation number and arrival date, then search again.');
      return;
    }
    const direct = { ...request.request, arrival: request.request.arrival };
    setSearchError(null);
    setSubmittedDirect(direct);
    directJob.start(direct);
  };
  const pickBooking = (row: GuestSearchRow) => {
    if (searchFrozen || bindingRequest.current || !submittedKey || !submittedSearch) return;
    const request = findRequestFor(row.confirmation, row.arrival ?? submittedSearch.arrival);
    if ('error' in request || request.request.kind !== 'find' || !request.request.arrival) return;
    invalidateTarget();
    setPicked({ searchKey: submittedKey, row });
    setDetailsRequested(true);
  };
  const pickDirectBooking = () => {
    if (searchFrozen || bindingRequest.current || !directKey || !directRow) return;
    invalidateTarget();
    setDirectPicked({ key: directKey, row: directRow });
    setDetailsRequested(true);
  };
  const attachPdf =
    file !== null && (file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.filename));
  const legacyFiling = propertyCode === 'HRCEN' && filingCapability === undefined &&
    (attachWrite?.filingConfigured === true || writesEnabled);
  const propertyCanPrepare = legacyFiling || Boolean(filingCapability &&
    ['prepare-only', 'lab', 'staff-enabled'].includes(filingCapability.status));
  const filingEnabled = cloudFiling ? approvalAvailable && attachWrite?.filingConfigured === true && propertyCanPrepare : writesEnabled;
  const arrivalForMatch = selectedMatch?.arrival ?? submittedSearch?.arrival ?? '';
  const verifiedStay = pickedVerified && detailsRun?.kind === 'found' ? detailsRun.stay : null;
  const firstName = verifiedStay?.firstName?.trim() ?? '';
  const status = verifiedStay?.status?.trim() ?? '';
  const departure = verifiedStay?.departure ?? '';
  const expectedStay = firstName && status && departure ? { firstName, status, departure } : null;
  const targetVerified = Boolean(selectedMatch && detailRequest?.arrival &&
    (cloudFiling ? pickedVerified : !explicitPick || pickedVerified) &&
    sendableArrival(arrivalForMatch));
  const canAttach = Boolean(propertyCode && sourceMatches && targetVerified && attachPdf && workItemId && reply.messageId && attachClient?.bind &&
    filingEnabled && attachStatusKnown && !searchFrozen && attach !== 'bound' &&
    (!cloudFiling || (previewStatus === 'ready' && expectedStay && attachClient.prepare)));
  const canPreview = Boolean(cloudFiling && propertyCanPrepare && sourceMatches && targetVerified && attachPdf && workItemId && reply.messageId &&
    attachClient?.preview && !searchFrozen && attach !== 'bound');
  const reviewAttach = async () => {
    if (!canPreview || !selectedMatch || !file || !workItemId || !attachClient?.preview || !documentSource || previewStatus === 'loading') return;
    const key = previewKey;
    const arrival = arrivalForMatch;
    setPreview({ key, status: 'loading' });
    try {
      const result = await attachClient.preview({ workItemId, sourceMessageId: reply.messageId,
        confirmation: selectedMatch.confirmation, arrival, lastName: selectedMatch.lastName, attachmentId: file.id, documentSource,
        ...(selectedSource ? { selectedSource } : {}) });
      if (!mounted.current || previewKeyRef.current !== key) return;
      const ready = result.status === 'ready' && result.confirmation === selectedMatch.confirmation &&
        result.arrival === arrival && result.documentName === file.filename &&
        result.documentSource?.sha256 === documentSource.sha256 &&
        result.documentSource?.snapshotDigest === documentSource.snapshotDigest &&
        Number.isSafeInteger(result.revisionSeq) && result.revisionSeq >= 0;
      setPreview(ready && result.status === 'ready'
        ? { key, status: 'ready', documentSource: result.documentSource, revisionSeq: result.revisionSeq }
        : { key, status: 'refused' });
    } catch {
      if (mounted.current && previewKeyRef.current === key) setPreview({ key, status: 'refused' });
    }
  };
  const bindAttach = async () => {
    if (!canAttach || !selectedMatch || !file || !workItemId || !reply.messageId || !attachClient?.bind || bindingRequest.current ||
        (cloudFiling && (!preview?.documentSource || preview.revisionSeq === undefined))) return;
    const key = previewKey;
    const item = workItemId;
    bindingRequest.current = true;
    targetChanged.current?.();
    setAttach({ key, workItemId: item, status: 'binding' });
    try {
      const result = await attachClient.bind({
        workItemId: item,
        confirmation: selectedMatch.confirmation,
        arrival: arrivalForMatch,
        lastName: selectedMatch.lastName,
        attachmentId: file.id,
        sourceMessageId: reply.messageId,
        ...(cloudFiling ? { documentSource: preview!.documentSource, revisionSeq: preview!.revisionSeq,
          expectedStay: expectedStay! } : {}),
        ...(selectedSource ? { selectedSource } : {}),
      });
      if (!mounted.current) return;
      const current = previewKeyRef.current === key;
      const form = result.status === 'bound' ? result.form : null;
      const matchesSelection = !selectedSource || Boolean(form && result.status === 'bound' &&
        /^[a-f0-9]{64}$/.test(result.formDigest ?? '') && form.pdfSha256 === preview?.documentSource?.sha256 &&
        form.sourceSnapshotDigest === preview?.documentSource?.snapshotDigest &&
        form.confirmation === selectedMatch.confirmation && form.arrival === arrivalForMatch &&
        normalizedSurname(form.lastName ?? '') === normalizedSurname(selectedMatch.lastName) &&
        form.attachmentId === file.id && (form.sourceDocumentName ?? form.documentName) === file.filename &&
        form.sourceMessageId === reply.messageId && form.sourceThreadId === selectedSource.threadId &&
        form.sourceHash === selectedSource.sourceHash);
      if (current && result.status === 'bound' && matchesSelection) {
        const receipt = cloudFiling && selectedSource && result.formDigest && attachClient.prepare
          ? await attachClient.prepare({ workItemId: item, confirmation: selectedMatch.confirmation,
              arrival: arrivalForMatch, formDigest: result.formDigest, selectedSource }) : null;
        if (!mounted.current || previewKeyRef.current !== key) return;
        if (cloudFiling && !receipt) { setAttach({ key, workItemId: item, status: 'unknown' }); return; }
        setAttach({ key, workItemId: item, status: 'bound' });
        onPrepared?.(result.formDigest, receipt ?? undefined);
      } else {
        // A refused snapshot may already have stored the form; do not pretend it was unbound.
        setAttach({ key, workItemId: item, status: current && result.status === 'refused' && result.retryable ? 'refused' : 'unknown' });
      }
    } catch {
      if (mounted.current) setAttach({ key, workItemId: item, status: 'unknown' });
    } finally {
      bindingRequest.current = false;
    }
  };

  const reviewFile = voucherReview?.files.find((entry) => entry.attachmentId === selectedFileId);
  const pendingFiles = inventory?.files?.filter((file) => voucherReview?.files.some(
    (entry) => entry.attachmentId === file.id && !entry.handled,
  )) ?? [];
  const otherPendingFiles = pendingFiles.filter((file) => file.id !== reviewFile?.attachmentId);
  const acknowledgeFile = async () => {
    if (!reviewClient || !workItemId || !reviewSelection || !reviewFile || reviewFile.handled || reviewBusy || !selectionCurrent) return;
    const file = reviewFile;
    const scope = reviewScope;
    ++reviewGeneration.current;
    setReviewBusy(true);
    setReviewError(false);
    try {
      await reviewClient.acknowledge({ workItemId, source: reviewSelection, attachmentId: file.attachmentId, key: file.key });
      if (mounted.current && reviewScopeRef.current === scope) {
        ++reviewGeneration.current;
        setVoucherReview((current) => current ? { ...current,
          files: current.files.map((entry) => entry.key === file.key ? { ...entry, handled: true } : entry) } : null);
      }
    } catch { if (mounted.current && reviewScopeRef.current === scope) setReviewError(true); }
    finally { if (mounted.current) setReviewBusy(false); }
  };

  // The id is the preview gate's sign that a voucher-only pane has settled (VOUCHER_CARD_SELECTOR in nava-preview-run.ts).
  return (
    <Section title={VOUCHER_COPY.heading} id="quote-voucher-find">
      <p className={captionClass}>{cloudFiling
        ? 'Find the booking and review the document before upload.' : VOUCHER_COPY.caption}</p>
      {(propertyCode === 'HRDAV' || propertyCode === 'HRDAVS') && (!filingCapability || filingCapability.status === 'unavailable') &&
        <Notice tone="warn">{filingCapability?.reason || 'Filing is not available for this hotel yet.'}</Notice>}
      {otherPendingFiles.length > 0 ? <Notice tone="warn">
        <p data-pii>Attached PDF needs review: {otherPendingFiles.map((file) => file.filename).join(', ')}. Select a file below.</p>
      </Notice> : null}
      {inventory?.files && inventory.files.length > 0 ? (
        <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#475569]">
          Document
          <select value={selectedFileId} disabled={searchFrozen} onChange={(event) => selectFile(event.target.value)}
            className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12px]">
            <option value="">Select a PDF</option>
            {inventory.files.map((candidate) => <option data-pii key={candidate.id} value={candidate.id}>{candidate.filename}</option>)}
          </select>
        </label>
      ) : !inventory?.files ? <Notice tone="warn">Document list unavailable. Reopen this email.</Notice>
        : file ? <Notice tone="warn">No eligible PDF available for filing.</Notice> : null}
      {selectedFileId && !fileReady ? <Notice tone={fileError ? 'warn' : undefined} role="status">
        {fileError ? 'Could not read this document. Reopen the email and try again.' : 'Reading selected document…'}
      </Notice> : null}
      {reviewFile && !reviewFile.handled ? <Notice tone="warn">
        <p>Review this PDF and file it if needed.</p>
        <SecondaryButton type="button" disabled={reviewBusy || !selectionCurrent} onClick={() => void acknowledgeFile()}>
          {reviewBusy ? 'Saving…' : 'Mark review handled'}
        </SecondaryButton>
      </Notice> : null}
      {reviewFile?.handled ? <p role="status" className={infoNoteClass}>Document review handled.</p> : null}
      {reviewError ? <Notice tone="warn">Could not update the document review. Reopen this email and try again.</Notice> : null}
      {(!fileReady || !selectedMatch) && (unconfirmedAttach || listedWithHold) ? <Notice tone="warn" role="status">
        {listedWithHold ? VOUCHER_ATTACH_COPY.listedWithHold : VOUCHER_ATTACH_COPY.checkInInfor}
      </Notice> : null}
      {fileReady && !selectedMatch && attachSucceeded && !unconfirmedAttach && (attachWrite?.run?.evidence.length ?? 0) > 0
        ? <p role="status" className={infoNoteClass}>{VOUCHER_ATTACH_COPY.documentsRow}</p> : null}
      {lookupReady && line ? (
        <p data-pii className={valueClass}>
          {line}
        </p>
      ) : null}
      {lookupReady && warnings.length > 0 ? (
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
      {lookupReady && !lookupSourceMatches ? <Notice tone="warn">Nava cannot verify this email and document. Reopen the email.</Notice> : null}
      {lookupReady && !propertyCode ? <Notice tone="warn">The hotel is not available for this lookup yet. Try again.</Notice> : null}
      {bindingFrozen && attachState?.status === 'unknown' ? (
        <Notice tone="warn">Nava could not confirm preparation. Reopen this email and check the filing status.</Notice>
      ) : null}
      {lookupReady ? <><form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); searchByFields(); }}>
        <p className={captionClass}>Find by confirmation and arrival, or search by surname and arrival.</p>
        <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#475569]">
          Confirmation number
          <input type="text" data-pii value={searchForm.confirmation} disabled={searchFrozen}
            onChange={(event) => editSearch('confirmation', event.target.value)}
            className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12px]" />
        </label>
        <div className="grid grid-cols-1 gap-2">
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#475569]">
            Guest surname
            <input type="text" data-pii value={searchForm.lastName} disabled={searchFrozen}
              onChange={(event) => editSearch('lastName', event.target.value)}
              className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12px]" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#475569]">
            Arrival
            <input type="date" value={searchForm.arrival} disabled={searchFrozen}
              onChange={(event) => editSearch('arrival', event.target.value)}
              className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12px]" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#475569]">
            Departure (optional)
            <input type="date" value={searchForm.departure} disabled={searchFrozen}
              onChange={(event) => editSearch('departure', event.target.value)}
              className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12px]" />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton type="button" disabled={!transport || searchFrozen || directJob.queuing} onClick={findByConfirmation}>
            Find by confirmation
          </SecondaryButton>
          <SecondaryButton type="submit" disabled={!transport || searchFrozen || searchJob.queuing}>
            {canSearch && searchIdle && resumeFor && currentSearchKey === submittedKey ? VOUCHER_COPY.search : AMEND_FIND_COPY.searchButton}
          </SecondaryButton>
        </div>
        {searchError ? <Notice tone="warn">{searchError}</Notice> : null}
      </form>
      <HmsJobStatusLine view={directRequestMatches ? directJob.view : null}
        queuing={Boolean(directKey && directJob.queuing)} detail={VOUCHER_COPY.readingDetails}
        onRetry={directJob.retry} statusFailed={Boolean(directKey && directJob.statusFailed)}
        queueFailed={Boolean(directKey && directJob.queueFailed)}
        queueFailureMessage={directJob.queueFailureMessage ?? AMEND_FIND_COPY.lookupFailed} />
      {directKey && directRow ? <SearchRow row={directRow} arrival={submittedDirect?.arrival ?? ''}
        disabled={searchFrozen} selected={Boolean(directMatch)} onPick={pickDirectBooking} /> : null}
      {directKey && directRun && !directRow ? <Notice tone="warn">
        {directRun.kind === 'not_found' ? 'No booking found for that confirmation and arrival.'
          : directRun.kind === 'error' ? directRun.message : 'Booking could not be verified. Check the confirmation and arrival.'}
      </Notice> : null}
      <HmsJobStatusLine
        view={currentResult ? searchJob.view : null}
        queuing={currentResult && searchJob.queuing}
        detail={VOUCHER_COPY.searching}
        onRetry={searchJob.retry}
        statusFailed={currentResult && searchJob.statusFailed}
        queueFailed={currentResult && searchJob.queueFailed}
        queueFailureMessage={searchJob.queueFailureMessage ?? AMEND_FIND_COPY.searchFailed}
      />
      {searchRun && (cloudFiling || !singleMatch) && !searchJob.queueFailed ? <SearchResult run={searchRun} onPick={pickBooking}
        selected={pickedMatch} arrival={submittedSearch?.arrival ?? ''} disabled={searchFrozen} /> : null}
      {currentResult && searchJob.view?.status === 'done' ? <HmsAsOf asOf={searchJob.view.asOf} /> : null}
      <div data-testid="voucher-save-and-match" className="flex flex-col gap-2 sm:flex-row sm:items-start">
        {file ? (
          <div className="flex flex-wrap items-center gap-2">
            {!fileReady ? <span data-pii className={captionClass}>{file.filename}</span> : null}
            <SecondaryButton disabled={save === 'saving'} onClick={() => void saveFile()}>
              {save === 'saving' ? VOUCHER_COPY.saving : VOUCHER_COPY.save}
            </SecondaryButton>
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
        {selectedMatch ? (
          <MatchedBooking
            key={`${selectedMatch.confirmation}:${searchRevision}`}
            row={selectedMatch}
            detailRun={detailsRun}
            detailView={detailsRequestMatches ? detailsJob.view : null}
            detailQueuing={detailsJob.queuing}
            detailQueueFailed={detailsJob.queueFailed}
            detailQueueFailureMessage={detailsJob.queueFailureMessage}
            detailStatusFailed={detailsJob.statusFailed}
            checkingDetails={detailsRequested && !explicitPick && !detailsJob.readBackSettled && !detailsJob.statusFailed}
            verifyingSelection={Boolean(explicitPick && !pickedVerified)}
            selectionMismatch={Boolean(explicitPick && detailsRun?.kind === 'found' && !pickedVerified)}
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
            cloudFiling={cloudFiling}
            canPreview={canPreview}
            previewStatus={previewStatus}
            onPreview={() => void reviewAttach()}
            attaching={attach === 'binding'}
            prepared={attach === 'bound'}
            unconfirmedAttach={unconfirmedAttach}
            listedWithHold={listedWithHold}
            documentsSeen={attachSucceeded && (attachWrite?.run?.evidence.length ?? 0) > 0}
            attachRefused={attach === 'refused'}
            onAttach={() => void bindAttach()}
          />
        ) : null}
      </div></> : null}
    </Section>
  );
}

// The rows HMS returned, each with the copy and open actions for its own confirmation number from HMS.
function SearchResult({ run, onPick, selected, arrival, disabled }: {
  run: HmsSearchRun; onPick: (row: GuestSearchRow) => void; selected: GuestSearchRow | null;
  arrival: string; disabled: boolean;
}) {
  if (run.kind === 'rows') {
    return (
      <div className="flex flex-col gap-2">
        <p className={captionClass}>{VOUCHER_COPY.pickRow}</p>
        <p className={captionClass}>Select the correct booking. Nava will check it in HMS.</p>
        {run.rows.map((row, index) => (
          <SearchRow key={`${row.confirmation}:${index}`} row={row} arrival={arrival} disabled={disabled}
            selected={selected === row} onPick={() => onPick(row)} />
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

function SearchRow({ row, arrival, disabled, selected, onPick }: {
  row: GuestSearchRow; arrival: string; disabled: boolean; selected: boolean; onPick: () => void;
}) {
  const guest = [row.firstName, row.lastName].filter(Boolean).join(' ') || 'Name not shown';
  const dates = row.arrival
    ? `${formatStayDate(row.arrival)}${row.departure ? ` – ${formatStayDate(row.departure)}` : ''}`
    : 'Dates not shown';
  const request = findRequestFor(row.confirmation, row.arrival ?? arrival);
  const selectable = 'request' in request && request.request.kind === 'find' && Boolean(request.request.arrival);
  return (
    <div className="rounded-xs flex flex-col gap-1 border border-[#e2e8f0] p-2">
      <p data-pii className={valueClass}>{`${guest} · ${row.confirmation}`}</p>
      <p className={captionClass}>{`${dates} · ${row.status || 'status not shown'}`}</p>
      <SecondaryButton disabled={disabled || !selectable || selected} onClick={onPick}>
        {selected ? 'Selected' : 'Select booking'}
      </SecondaryButton>
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
  verifyingSelection,
  selectionMismatch,
  showReadDetails,
  onReadDetails,
  onRetryDetails,
  canAttach,
  cloudFiling,
  canPreview,
  previewStatus,
  onPreview,
  attaching,
  prepared,
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
  verifyingSelection: boolean;
  selectionMismatch: boolean;
  showReadDetails: boolean;
  onReadDetails: () => void;
  onRetryDetails: () => void;
  canAttach: boolean;
  cloudFiling: boolean;
  canPreview: boolean;
  previewStatus: 'idle' | 'loading' | 'ready' | 'refused';
  onPreview: () => void;
  attaching: boolean;
  prepared: boolean;
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
  const company = stayText(commercial?.organization?.name) ?? stayText(commercial?.organization?.nativeId);
  const agency = stayText(commercial?.bookingAgency?.name) ?? stayText(commercial?.bookingAgency?.nativeId);
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
      {verifyingSelection && !selectionMismatch ? <p role="status" className={captionClass}>Checking the selected booking in HMS…</p> : null}
      {selectionMismatch ? <Notice tone="warn">The booking details changed. Search and select it again.</Notice> : null}
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
      {prepared && !unconfirmedAttach ? <p role="status" className={infoNoteClass}>HMS document form prepared. Check the booking above to approve.</p> : null}
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
      {canPreview && previewStatus !== 'ready' ? (
        <PrimaryButton disabled={previewStatus === 'loading'} onClick={onPreview}>
          {previewStatus === 'loading' ? VOUCHER_ATTACH_COPY.reviewing : VOUCHER_ATTACH_COPY.review}
        </PrimaryButton>
      ) : null}
      {canPreview && previewStatus === 'refused' ? <Notice tone="warn" role="status">{VOUCHER_ATTACH_COPY.reviewFailed}</Notice> : null}
      {canPreview && previewStatus === 'ready' ? (
        <p role="status" className={infoNoteClass}>{VOUCHER_ATTACH_COPY.reviewReady}{!canAttach ? ' Upload is not available yet.' : ''}</p>
      ) : null}
    </div>
  );
}
