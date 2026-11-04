import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AMEND_CANCEL_COPY,
  AMEND_FIELD_LABEL,
  AMEND_FORM_FIELDS,
  AMEND_SAVE_COPY,
  amendCancelClientFromTrpc,
  cancelChargeClientFromTrpc,
  amendCapabilitiesFromTrpc,
  amendStayClientFromTrpc,
  canPreviewAmendFromCapabilities,
  canPreviewCancelFromCapabilities,
  cancelConfirmLine,
  cancelFeeSentence,
  cancelSwitchedOffNote,
  changedAmendRows,
  classifyAmendPayment,
  isoDayOf,
  paymentStayFromRecord,
  viewAfterAmendCommit,
  viewAfterAmendPreview,
  viewAfterCommit,
  viewAfterPreview,
  type AmendCancelClient,
  type AmendFormField,
  type AmendFormValues,
  type AmendStayClient,
  type AmendView,
  type CancelRun,
  type CancelView,
} from '@/lib/quote-workflow/amend-cancel';
import {
  AMEND_FIND_COPY,
  arrivalMismatchNote,
  amendDiffs,
  amendFindClientFromTrpc,
  findRequestFor,
  findRunFromJob,
  formatStayDate,
  hmsJobTransport,
  hmsNumberFor,
  isSettled,
  noSearchMatchCopy,
  notFoundConfirmationCopy,
  notHmsNumberNote,
  pickStayFromFindRows,
  prefetchedNotFoundConfirmationCopy,
  searchRequestFor,
  searchRunFromJob,
  sendableArrival,
  stayGuest,
  stayPickCaption,
  stayText,
  suspectStayLink,
  type AmendDiff,
  type GuestSearchRow,
  type HmsJobView,
  type HmsSearchRun,
  type ScreenshotInput,
  type ScreenshotReply,
  type StayContactObservations,
  type StayPick,
  type StayRecordWire,
} from '@/lib/quote-workflow/amend-find';
import { amendmentOf } from '@/lib/quote-workflow/session';
import { cancelWriteStateClientFromTrpc, type CancelWriteSelection } from '@/lib/quote-workflow/cancel-write-state';
import { getMailCacheScope, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';
import { cloudAmendClientFromTrpc, type CloudAmendClient, type CloudAmendRequest, type CloudAmendSelection } from '@/lib/quote-workflow/cloud-amend-client';
import { HMS_WRITE_IDLE_POLL_MS, HMS_WRITE_POLL_MS } from '@/lib/quote-workflow/hms-write';
import { knownRoomCode, ROOM_TYPE_NAMES } from '@/lib/quote-workflow/room-types';
import { savedStayAmendReviewBasis, type SavedStayAmendDraftUpdate, type SavedStayAmendEditorIdentity } from '@/lib/quote-workflow/saved-stay-amendment';
import type { QuoteAmendment, QuoteSession, RatePlanCatalogueEntry } from '@/lib/quote-workflow/types';
import type { useAmendWorkItem } from '@/lib/quote-workflow/use-amend-work-item';
import { rateMoney, rateReason, useAmendRateCandidates } from '@/lib/quote-workflow/use-amend-rate-candidates';
import { useHmsJob } from '@/lib/quote-workflow/use-hms-job';
import { HmsLinkActions } from './hms-link-actions';
import { HmsAsOf, HmsJobStatusLine } from './hms-queue-status';
import { createSavedStayAmendDraftStore, SavedStayAmendEditor } from './saved-stay-amend-editor';
import { ApproveCard, CancelChargePrompt } from './approve-card';
import { resolveConfirmationRecipient, useConfirmationSources, type ConfirmationMode } from './confirmation-recipient';

export type AmendReadOnlyContext = {
  propertyCode: 'HRCEN';
  ratePlans: RatePlanCatalogueEntry[];
  selectionCurrent: boolean;
  sourceContentChanged?: boolean;
  sourceSelectionUnavailable?: boolean;
  draft?: ReturnType<typeof useAmendWorkItem>;
  historyEpoch?: number;
  historyBusy?: boolean;
  refreshPending?: boolean;
  refreshMessage?: string | null;
  retryRefresh?: () => void;
  requireDurableDraft?: boolean;
  retryDraft?: () => void;
  draftLoading?: boolean;
};

type SearchForm = { lastName: string; arrival: string; departure: string };

const panelClass =
  'flex flex-col gap-3 rounded-sm border border-[#e2e8f0] bg-white px-3 py-3 text-[#1e293b]';
const headingClass = 'text-[10px] font-semibold uppercase tracking-wide text-[#64748b]';
const captionClass = 'text-[10px] text-[#94a3b8]';
const valueClass = 'text-[12.5px] text-[#1e293b]';
const buttonClass =
  'rounded-sm border border-[#0066cc] bg-white px-2.5 py-1.5 text-[11.5px] font-medium text-[#0066cc] disabled:cursor-not-allowed disabled:border-[#cbd5e1] disabled:text-[#94a3b8]';
const infoNoteClass =
  'rounded-xs border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-2 text-[11.5px] text-[#334155]';
const warnNoteClass = 'rounded-xs border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11.5px] text-amber-900';
const penaltyClass =
  'rounded-xs border border-amber-400 bg-amber-50 px-2.5 py-2 text-[12.5px] font-semibold text-amber-900';
const selectClass =
  'h-8 min-w-0 w-full rounded-sm border border-[#cbd5e1] bg-white px-2 py-1.5 text-[12px] text-[#1e293b] disabled:text-[#94a3b8]';

export type AmendSavedStay = {
  confirmationNumber: string | null;
  status: 'booked' | 'unknown';
  screenshotRef?: { runId: string; name: string } | null;
};

const SAVED_STAY_COPY = {
  heading: 'Bookings on this request',
};

const CANCEL_PREVIEW_MISMATCH = 'Nava could not confirm the cancellation details. Check the booking in HMS.';

function nativeCancelPreview(run: CancelRun, target: { confirmation: string; arrival: string }): NonNullable<CancelRun['previewStay']> | null {
  const stay = run.previewStay;
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 &&
    value.length <= max && !/[\p{Cc}]/u.test(value);
  const day = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  };
  if (!stay || typeof stay !== 'object' || Array.isArray(stay) || stay.confirmation !== target.confirmation ||
      stay.arrival !== target.arrival || !day(stay.arrival) || !day(stay.departure) ||
      !text(stay.firstName, 200) || !text(stay.lastName, 200) || !text(stay.roomType, 12)) return null;
  return stay;
}

function savedStayPicksFrom(
  savedStays: Record<string, AmendSavedStay> | undefined,
): Array<{ stayId: string; confirmationNumber: string }> {
  if (!savedStays) return [];
  const picks: Array<{ stayId: string; confirmationNumber: string }> = [];
  for (const [stayId, record] of Object.entries(savedStays)) {
    const confirmation = record.confirmationNumber?.trim();
    if (confirmation) picks.push({ stayId, confirmationNumber: confirmation });
  }
  return picks;
}

function resolvedSavedStayId(
  picks: Array<{ stayId: string; confirmationNumber: string }>,
  stayId: string | null,
  emailConfirmation: string | null,
): string | null {
  if (stayId && picks.some((pick) => pick.stayId === stayId)) return stayId;
  if (picks.length === 1) return picks[0]!.stayId;
  if (emailConfirmation) {
    const match = picks.find((pick) => pick.confirmationNumber === emailConfirmation);
    if (match) return match.stayId;
  }
  return null;
}

/**
 * Amend and cancel mail: shows what the guest asked beside the booking HMS returns for the email's booking number.
 * With no usable number, staff find the booking by surname and arrival instead. Renders nothing unless the analysis
 * carries an amendment. Lookups are persisted HMS jobs: the panel shows the job's state and its dated snapshot.
 */
export function AmendLookupPanel({
  session,
  trpc,
  savedStays,
  onStayActionResult,
  readOnlyAmend,
  workItemId = null,
}: {
  session: QuoteSession;
  trpc: unknown;
  savedStays?: Record<string, AmendSavedStay>;
  readOnlyAmend?: AmendReadOnlyContext | null;
  workItemId?: string | null;
  onStayActionResult?: (input: {
    stayId: string;
    confirmationNumber: string;
    kind: 'amend' | 'cancel';
  }) => void;
}) {
  const amendment = amendmentOf(session);
  const exactSource = Boolean(readOnlyAmend);
  const selectedTransportId = exactSource && readOnlyAmend?.selectionCurrent
    ? session.binding?.transportId?.trim() || null : null;
  const client = useMemo(() => amendFindClientFromTrpc(trpc, selectedTransportId), [trpc, selectedTransportId]);
  const cancelTransportId = selectedTransportId ?? session.binding?.transportId?.trim() ?? null;
  const cancelClient = useMemo(() => amendCancelClientFromTrpc(trpc,
    readOnlyAmend?.propertyCode === 'HRCEN' ? cancelTransportId : undefined), [trpc, cancelTransportId, readOnlyAmend?.propertyCode]);
  const amendClient = useMemo(() => amendStayClientFromTrpc(trpc), [trpc]);
  const loadCapabilities = useMemo(() => amendCapabilitiesFromTrpc(trpc), [trpc]);
  const [canPreviewCancel, setCanPreviewCancel] = useState(false);
  const [canPreviewAmend, setCanPreviewAmend] = useState(false);
  const [activeAmendApproval, setActiveAmendApproval] = useState(false);
  useEffect(() => {
    if (!loadCapabilities) {
      setCanPreviewCancel(false);
      setCanPreviewAmend(false);
      return;
    }
    let live = true;
    loadCapabilities()
      .then((capabilities) => {
        if (!live) return;
        setCanPreviewCancel(canPreviewCancelFromCapabilities(capabilities));
        setCanPreviewAmend(canPreviewAmendFromCapabilities(capabilities)); // paneWrite amend/cancel, not create
      })
      .catch(() => {
        if (!live) return;
        setCanPreviewCancel(false);
        setCanPreviewAmend(false);
      });
    return () => {
      live = false;
    };
  }, [loadCapabilities]);
  const threadId = session.staffSource?.threadId.trim() || null;
  const messageId = session.staffSource?.messageId.trim() || null;
  const sourceHash = session.staffSource?.sourceHash.trim() || null;
  const transport = useMemo(
    () => exactSource && (!selectedTransportId || !sourceHash) ? null
      : hmsJobTransport(client, threadId, messageId, exactSource ? { exactSource: true, sourceHash: sourceHash! } : undefined),
    [client, threadId, messageId, sourceHash, exactSource, selectedTransportId],
  );
  const epoch = session.binding?.selectionEpoch ?? null;
  const key = threadId && epoch !== null ? `${threadId}:${epoch}` : null;
  const savedPicks = useMemo(() => savedStayPicksFrom(savedStays), [savedStays]);
  const [pickedStayId, setPickedStayId] = useState<string | null>(null);
  const draftSource = readOnlyAmend?.draft?.source;
  const sourceDraftMatches = Boolean(readOnlyAmend?.selectionCurrent && draftSource && session.staffSource &&
    draftSource.threadId === session.staffSource.threadId && draftSource.messageId === session.staffSource.messageId &&
    draftSource.sourceHash === session.staffSource.sourceHash);
  const durableDraft = sourceDraftMatches && readOnlyAmend?.draft?.available ? readOnlyAmend.draft : null;
  const projected = durableDraft?.request?.fields.value;
  const targetCleared = projected?.target === null &&
    durableDraft?.fieldMeta[`requests[${durableDraft?.request?.requestId}].target`]?.origin === 'staff';
  const emailConfirmation = targetCleared ? null : projected?.target?.confirmation ?? (amendment?.confirmationNumber?.trim() || null);
  const resolvedStayId = resolvedSavedStayId(savedPicks, pickedStayId, emailConfirmation);
  const pickedConfirmation =
    savedPicks.find((pick) => pick.stayId === resolvedStayId)?.confirmationNumber ?? null;
  const confirmationNumber = targetCleared ? null : pickedConfirmation ?? (savedPicks.length > 0 ? null : emailConfirmation);
  // Only a dash confirmation (57291630-1) is an HMS number. A bare number may be a billing or voucher reference, so it is not one.
  const hmsNumber = hmsNumberFor(confirmationNumber);
  const lookupable = hmsNumber !== null;
  // The booked arrival rides with the find so HMS quick search covers that day. Without booked dates in the mail the
  // find goes by confirmation number alone: the requested arrival never stands in (AE2). findRequestFor drops a non-date.
  const findArrival = targetCleared ? null : projected?.target?.arrival ?? amendment?.arrival ?? null;
  const bookedMissing = !findArrival;
  const searchIdentity =
    amendment?.guestLastName?.trim() && amendment.arrival
      ? searchRequestFor({ lastName: amendment.guestLastName, arrival: amendment.arrival })
      : null;
  const searchResume =
    searchIdentity && 'request' in searchIdentity && searchIdentity.request.kind === 'search_guest'
      ? {
          kind: 'search_guest' as const,
          lastName: searchIdentity.request.lastName,
          arrival: searchIdentity.request.arrival,
          departure: null,
        }
      : null;

  // The find reads back the email's own number after a remount. A booking picked from a search is queued in this session.
  const find = useHmsJob({
    transport,
    resume: hmsNumber ? { kind: 'find', confirmation: hmsNumber,
      ...(exactSource ? { arrival: sendableArrival(findArrival) } : {}) } : null,
    scope: key,
    autoStartIfMissing: Boolean(key && transport && hmsNumber),
    targetId: 'quote-booking',
  });
  const search = useHmsJob({ transport, resume: searchResume, scope: key, targetId: 'quote-booking' });
  // A search the form refused before queueing. It shows in place of a run, for the scope it was made in.
  const [refusedSearch, setRefusedSearch] = useState<{ scope: string; message: string } | null>(null);
  // Cancel views are kept per booking on an email (see cancelScope), so a reply for one booking never shows on another.
  const [cancelViews, setCancelViews] = useState<Record<string, CancelView>>({});
  const [cancelNotes, setCancelNotes] = useState<Record<string, string>>({});
  const cancelSelection = JSON.stringify([workItemId, threadId, messageId, sourceHash, cancelTransportId,
    session.binding?.internetMessageId, epoch, readOnlyAmend?.selectionCurrent,
    readOnlyAmend?.sourceContentChanged, readOnlyAmend?.sourceSelectionUnavailable]);
  const cancelSelectionRef = useRef(cancelSelection);
  cancelSelectionRef.current = cancelSelection;
  const cancelScopeRef = useRef<string | null>(null);
  const cancelScopeGeneration = useRef(0);
  const cancelMountedRef = useRef(true);
  const cancelMailboxGeneration = useRef(0);
  useEffect(() => {
    cancelMountedRef.current = true;
    const unsubscribe = subscribeMailCacheScope(() => { cancelMailboxGeneration.current += 1; });
    return () => { cancelMountedRef.current = false; unsubscribe(); };
  }, []);
  const [amendViews, setAmendViews] = useState<Record<string, AmendView>>({});
  const [requestedByScope, setRequestedByScope] = useState<Record<string, AmendFormValues>>({});
  const [selectedAfterClear, setSelectedAfterClear] = useState<{ scope: string; confirmation: string; arrival: string | null } | null>(null);
  // Keep the mounted editor during a refresh, but never allow its stale booking to prepare a write.
  const refreshingAmend = useRef<{ scope: string; confirmation: string; stay: StayRecordWire;
    contactObservations?: StayContactObservations } | null>(null);

  if (!amendment) {
    if (cancelScopeRef.current !== null) cancelScopeGeneration.current += 1;
    cancelScopeRef.current = null;
    return null;
  }

  const findView: HmsJobView | null = find.view;
  const shownFindRequest = findView?.request?.kind === 'find' ? findView.request : null;
  const findRun = findRunFromJob(findView, find.queueFailed, find.queueFailureMessage);
  const running = find.queuing || (findView !== null && !isSettled(findView));
  const found = findRun?.kind === 'found' ? findRun : null;
  const stay: StayRecordWire | null = found?.stay ?? null;
  const hmsStatus = stay ? displayedStatus(stay.status) : null;
  const roomType = stay ? displayedRoomType(stay.roomType) : null;
  // The number the stay on screen was found under: the email's own, or a row picked from a search.
  const foundNumber = found
    ? stayText(stay?.confirmation) ?? (findView?.request?.kind === 'find' ? findView.request.confirmation : null)
    : null;
  // The one HMS handoff row copies the number HMS holds the booking under, else the number in the email.
  const handoffNumber = foundNumber ?? confirmationNumber;
  const diff: AmendDiff = stay ? amendDiffs(amendment, stay) : {};
  const canLookUp = Boolean(key && transport && lookupable);
  const searchView: HmsJobView | null = search.view;
  const refusedNow = refusedSearch && key && refusedSearch.scope === key ? refusedSearch.message : null;
  const searchRun: HmsSearchRun | null = refusedNow
    ? { kind: 'error', message: refusedNow }
    : searchRunFromJob(searchView, search.queueFailed, search.queueFailureMessage);
  const searching = search.queuing || (searchView !== null && !isSettled(searchView));
  // A background prefetch shows its status but never blocks a staff Find: the staff run queues ahead of it.
  const findBusy = find.queuing || (findView !== null && !isSettled(findView) && !findView.prefetch);
  const busy = findBusy || searching;
  const findNotFound = findRun?.kind === 'not_found';
  const findAmbiguous = findRun?.kind === 'ambiguous';
  const searchedConfirmation = findView?.request?.kind === 'find' ? findView.request.confirmation : null;
  const prefetchedNotFound = Boolean(findView?.prefetch && findNotFound);
  const stayPick: StayPick =
    searchRun?.kind === 'rows'
      ? pickStayFromFindRows({
          ask: {
            lastName: amendment.guestLastName ?? '',
            arrival: amendment.arrival ?? '',
            ...(amendment.departure ? { departure: amendment.departure } : {}),
            confirmationNumber,
          },
          rows: searchRun.rows,
        })
      : { status: 'none', confirmationNumber: null, why: [] };
  const suspectLink = Boolean(stay && suspectStayLink(amendment, stay, Boolean(found?.arrivalMismatch)));
  const waitingForSavedPick = savedPicks.length > 0 && !lookupable;
  // CHECK: missing / not found / ambiguous / suspect, or staff already has a candidate list to reopen.
  const awaitingClearedTarget = Boolean(targetCleared && (!key || selectedAfterClear?.scope !== key ||
    selectedAfterClear.confirmation !== foundNumber || (selectedAfterClear.arrival && selectedAfterClear.arrival !== stay?.arrival)));
  const checkReason = awaitingClearedTarget ? 'missing' : waitingForSavedPick
    ? null
    : !stay
      ? !lookupable
        ? 'missing'
        : findNotFound
          ? 'not_found'
          : findAmbiguous || stayPick.status === 'check_conf'
            ? 'ambiguous'
            : null
      : suspectLink || stayPick.status === 'check_conf'
        ? 'suspect'
        : null;
  const searchOpen = checkReason !== null || searchView !== null || search.queuing;

  // pii: the note quotes the guest's booking number.
  let note: { tone: 'info' | 'warn'; text: string; pii?: boolean } | null = null;
  if (findRun?.kind === 'error') note = { tone: 'warn', text: findRun.message };
  else if (findRun?.kind === 'not_found') {
    note = {
      tone: 'warn',
      text:
        prefetchedNotFound && searchedConfirmation !== null
          ? prefetchedNotFoundConfirmationCopy(searchedConfirmation)
          : notFoundConfirmationCopy(searchedConfirmation ?? hmsNumber ?? confirmationNumber ?? ''),
      pii: true,
    };
  }
  else if (findRun?.kind === 'ambiguous') note = { tone: 'warn', text: AMEND_FIND_COPY.ambiguous };
  else if (!confirmationNumber && !waitingForSavedPick) note = { tone: 'info', text: AMEND_FIND_COPY.noNumber };
  else if (!lookupable && confirmationNumber) note = { tone: 'warn', text: notHmsNumberNote(confirmationNumber), pii: true };
  else if (!threadId) note = { tone: 'info', text: AMEND_FIND_COPY.waitingThread };

  const searchHint = !client ? AMEND_FIND_COPY.unavailable : !key ? AMEND_FIND_COPY.waitingThread : null;

  const selectedBookingMatches = !pickedConfirmation || foundNumber === pickedConfirmation;
  const cancelTarget = selectedBookingMatches && foundNumber ? foundNumber : hmsNumber;
  const cancelStay = stay && selectedBookingMatches && foundNumber === cancelTarget ? stay : null;
  // Use the booked email target to restore history while Find is still running.
  const cancelArrival = isoDayOf(stayText(cancelStay?.arrival)) ?? isoDayOf(amendment.arrival);
  const requireNativeCancelPreview = readOnlyAmend?.propertyCode === 'HRCEN';
  // Cloud views bind the source and target; legacy cancellation keeps its existing scope.
  const cancelScope = requireNativeCancelPreview
    ? key && cancelTarget ? JSON.stringify([key, cancelTarget, cancelArrival, resolvedStayId, confirmationNumber, cancelSelection]) : null
    : key && foundNumber ? `${key}|${foundNumber}` : null;
  if (cancelScopeRef.current !== cancelScope) {
    cancelScopeGeneration.current += 1;
    cancelScopeRef.current = cancelScope;
  }
  const cancelView = cancelScope ? (cancelViews[cancelScope] ?? null) : null;
  const cancelRestoreInput = cancelTarget && cancelArrival && workItemId && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(workItemId) &&
    threadId && messageId && /^[a-f0-9]{64}$/.test(sourceHash ?? '') &&
    (!readOnlyAmend || (readOnlyAmend.selectionCurrent && !readOnlyAmend.sourceContentChanged && !readOnlyAmend.sourceSelectionUnavailable))
    ? { confirmation: cancelTarget, arrival: cancelArrival, workItemId,
        source: { threadId, messageId, sourceHash: sourceHash! } } : null;
  const legacyCancelInput = foundNumber && cancelArrival ? { confirmation: foundNumber, arrival: cancelArrival } : null;
  const cancelInput = requireNativeCancelPreview ? (cancelStay && !checkReason ? cancelRestoreInput : null) : legacyCancelInput;
  const amendScope = cancelScope;
  const amendView = amendScope ? (amendViews[amendScope] ?? null) : null;
  const requested = (amendScope && requestedByScope[amendScope]) || {};
  const stayCurrent = {
    arrival: isoDayOf(stayText(stay?.arrival)), departure: isoDayOf(stayText(stay?.departure)),
    roomType: stayText(stay?.roomType), adults: stay?.adults ?? null, children: stay?.children ?? null,
  };
  const requestedValues: AmendFormValues = {
    arrival: requested.arrival ?? isoDayOf(amendment.requestedArrival) ?? stayCurrent.arrival ?? undefined,
    departure: requested.departure ?? isoDayOf(amendment.requestedDeparture) ?? stayCurrent.departure ?? undefined,
    roomType: requested.roomType ?? knownRoomCode(stayCurrent.roomType ?? '') ?? stayCurrent.roomType ?? undefined,
    adults: requested.adults ?? stayCurrent.adults ?? undefined,
    children: requested.children ?? stayCurrent.children ?? undefined,
  };
  const amendRows = stay && amendment.kind === 'amend' ? changedAmendRows(stayCurrent, requestedValues) : [];
  const amendFields = Object.fromEntries(amendRows.map((row) => [row.field, requestedValues[row.field]])) as AmendFormValues;
  const amendLastName = stayText(stay?.lastName) ?? amendment.guestLastName ?? '';
  const unpaidStay = amendment.kind === 'cancel' && requireNativeCancelPreview
    ? null : classifyAmendPayment(paymentStayFromRecord(stay)) === 'unpaid';
  const canAmendWrite = Boolean(canPreviewAmend && unpaidStay && !checkReason && foundNumber);
  const amendInput =
    foundNumber && cancelArrival && amendLastName && Object.keys(amendFields).length
      ? { confirmation: foundNumber, arrival: cancelArrival, lastName: amendLastName, fields: amendFields }
      : null;

  const chooseSavedStay = (stayId: string, confirmation: string) => {
    setPickedStayId(stayId);
    if (!key) return;
    const next = findRequestFor(confirmation, findArrival);
    if ('request' in next && next.request.kind === 'find') {
      setSelectedAfterClear({ scope: key, confirmation, arrival: next.request.arrival ?? null });
      find.start(next.request);
    }
  };

  const reportStayAction = (kind: 'amend' | 'cancel', confirmation: string) => {
    if (!resolvedStayId) return;
    onStayActionResult?.({ stayId: resolvedStayId, confirmationNumber: confirmation, kind });
  };

  const legacyPreviewCancel = async () => {
    if (checkReason || !canPreviewCancel || !cancelScope || !cancelClient || !cancelInput) return;
    const scope = cancelScope;
    setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'previewing' } }));
    try {
      const run = await cancelClient.previewCancel(cancelInput);
      setCancelViews((prev) => ({ ...prev, [scope]: viewAfterPreview(run, cancelInput.confirmation) }));
    } catch {
      setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'idle', note: AMEND_CANCEL_COPY.failed } }));
    }
  };

  // The commit must carry the digest of the preview it follows. Without one there is nothing to commit.
  const legacyCommitCancel = async (ready: Extract<CancelView, { kind: 'ready' }>) => {
    const previewDigest = ready.run.previewDigest;
    if (checkReason || !canPreviewCancel || !cancelScope || !cancelClient || !cancelInput || !ready.reason || !previewDigest) return;
    const scope = cancelScope;
    setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'committing', run: ready.run, reason: ready.reason } }));
    try {
      const run = await cancelClient.commitCancel({ ...cancelInput, reason: ready.reason, previewDigest });
      const view = viewAfterCommit(run, ready.run, cancelInput.confirmation);
      setCancelViews((prev) => ({ ...prev, [scope]: view }));
      if (view.kind === 'done') reportStayAction('cancel', cancelInput.confirmation);
    } catch {
      setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'idle', note: AMEND_CANCEL_COPY.failed } }));
    }
  };

  const cancelResponseCurrent = (scope: string, selection: string, generation: number, scopeGeneration: number, userId: string) => {
    const active = getMailCacheScope();
    return cancelMountedRef.current && cancelScopeRef.current === scope && cancelSelectionRef.current === selection &&
      cancelMailboxGeneration.current === generation && cancelScopeGeneration.current === scopeGeneration &&
      active.userId === userId && active.activeTransportId === cancelTransportId;
  };

  const previewCancel = async () => {
    if (!requireNativeCancelPreview) return legacyPreviewCancel();
    if (checkReason || !canPreviewCancel || !cancelScope || !cancelClient || !cancelInput) return;
    const mailbox = getMailCacheScope();
    const userId = mailbox.userId;
    if (!userId || mailbox.activeTransportId !== cancelTransportId) return;
    const scope = cancelScope;
    const selection = cancelSelection;
    const generation = cancelMailboxGeneration.current;
    const scopeGeneration = cancelScopeGeneration.current;
    setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'previewing' } }));
    try {
      const run = await cancelClient.previewCancel(cancelInput);
      if (!cancelResponseCurrent(scope, selection, generation, scopeGeneration, userId)) return;
      const preview = viewAfterPreview(run, cancelInput.confirmation);
      setCancelViews((prev) => ({ ...prev, [scope]: preview.kind === 'ready' && requireNativeCancelPreview &&
        !nativeCancelPreview(run, cancelInput) ? { kind: 'idle', note: CANCEL_PREVIEW_MISMATCH } : preview }));
    } catch {
      if (!cancelResponseCurrent(scope, selection, generation, scopeGeneration, userId)) return;
      setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'idle', note: AMEND_CANCEL_COPY.failed } }));
    }
  };

  // The commit must carry the digest of the preview it follows. Without one there is nothing to commit.
  const commitCancel = async (ready: Extract<CancelView, { kind: 'ready' }>) => {
    if (!requireNativeCancelPreview) return legacyCommitCancel(ready);
    const previewDigest = ready.run.previewDigest;
    if (checkReason || !canPreviewCancel || !cancelScope || !cancelClient || !cancelInput || !ready.reason || !previewDigest ||
        (requireNativeCancelPreview && !nativeCancelPreview(ready.run, cancelInput))) return;
    const mailbox = getMailCacheScope();
    const userId = mailbox.userId;
    if (!userId || mailbox.activeTransportId !== cancelTransportId) return;
    const scope = cancelScope;
    const selection = cancelSelection;
    const generation = cancelMailboxGeneration.current;
    const scopeGeneration = cancelScopeGeneration.current;
    setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'committing', run: ready.run, reason: ready.reason } }));
    try {
      const run = await cancelClient.commitCancel({ ...cancelInput, reason: ready.reason, previewDigest,
        cancellationNote: (cancelNotes[scope] ?? '').slice(0, 200) });
      if (!cancelResponseCurrent(scope, selection, generation, scopeGeneration, userId)) return;
      const view = viewAfterCommit(run, ready.run, cancelInput.confirmation);
      setCancelViews((prev) => ({ ...prev, [scope]: view }));
      if (view.kind === 'done' && ['cancelled', 'already_cancelled'].includes(run.outcome)) reportStayAction('cancel', cancelInput.confirmation);
    } catch {
      if (!cancelResponseCurrent(scope, selection, generation, scopeGeneration, userId)) return;
      setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'done', run: ready.run, text: AMEND_CANCEL_COPY.unconfirmed } }));
    }
  };

  const previewAmendStay = async () => {
    if (!canAmendWrite || !amendScope || !amendClient || !amendInput) return;
    const scope = amendScope;
    setAmendViews((prev) => ({ ...prev, [scope]: { kind: 'previewing' } }));
    try {
      const run = await amendClient.previewAmend(amendInput);
      setAmendViews((prev) => ({ ...prev, [scope]: viewAfterAmendPreview(run, amendInput.confirmation) }));
    } catch {
      setAmendViews((prev) => ({ ...prev, [scope]: { kind: 'idle', note: AMEND_SAVE_COPY.failed } }));
    }
  };

  const commitAmendStay = async (ready: Extract<AmendView, { kind: 'ready' }>) => {
    const previewDigest = ready.run.previewDigest;
    if (!canAmendWrite || !amendScope || !amendClient || !amendInput || !previewDigest) return;
    const scope = amendScope;
    setAmendViews((prev) => ({ ...prev, [scope]: { kind: 'committing', run: ready.run } }));
    try {
      const run = await amendClient.commitAmend({ ...amendInput, previewDigest });
      const view = viewAfterAmendCommit(run, amendInput.confirmation);
      setAmendViews((prev) => ({ ...prev, [scope]: view }));
      if (view.kind === 'done') reportStayAction('amend', amendInput.confirmation);
    } catch {
      setAmendViews((prev) => ({ ...prev, [scope]: { kind: 'idle', note: AMEND_SAVE_COPY.failed } }));
    }
  };

  // Cancel mail the pane can preview says so; otherwise the look-up footer stays.
  const footer =
    amendment.kind === 'cancel' && stay && foundNumber && canPreviewCancel && cancelInput && !checkReason
      ? AMEND_CANCEL_COPY.footerPreview
      : AMEND_FIND_COPY.footer;

  const chooseReason = (reason: string) => {
    if (!cancelScope) return;
    const scope = cancelScope;
    setCancelViews((prev) => {
      const view = prev[scope];
      if (!view || view.kind !== 'ready') return prev;
      return { ...prev, [scope]: { ...view, reason } };
    });
  };

  const requestedRows = stay && amendment.kind === 'amend' ? requestedChangeRows(amendment, stay, diff) : [];
  const requestLine = requestSummary(amendment, requestedRows.length === 0);
  const ratePlan = stayText(stay?.ratePlan);
  const source = session.staffSource;
  const binding = session.binding;
  const readOnlyIdentity: SavedStayAmendEditorIdentity | null =
    readOnlyAmend?.selectionCurrent && source?.threadId.trim() && source.messageId.trim() &&
    /^[a-f0-9]{64}$/.test(source.sourceHash) && binding?.mailboxEmail.trim() &&
    binding.internetMessageId?.trim()
      ? { propertyCode: readOnlyAmend.propertyCode, threadId: source.threadId, messageId: source.messageId,
          mailboxEmail: binding.mailboxEmail, sourceHash: source.sourceHash }
      : null;
  const reviewScope = readOnlyIdentity ? JSON.stringify([readOnlyIdentity, binding?.transportId, binding?.selectionEpoch]) : null;
  const currentAmendReview = amendment.kind === 'amend' && stay && foundNumber && !checkReason && readOnlyIdentity &&
    stayText(stay.confirmation) === foundNumber && findView?.request?.kind === 'find' &&
    findView.request.confirmation === foundNumber
      ? { confirmation: foundNumber, stay, contactObservations: found?.reservationObservations } : null;
  const heldAmendReview = reviewScope && refreshingAmend.current?.scope === reviewScope ? refreshingAmend.current : null;
  const amendReview = currentAmendReview ?? heldAmendReview;
  // This is a local display revision, not an extraction id or authority to write.
  const localReadRevision = JSON.stringify([session.inputRevision, amendment]);
  const matchWarningParts =
    stay && amendment.kind === 'amend'
      ? [
          diff.guest ? `Email surname ${amendment.guestLastName}; HMS guest ${stayGuest(stay) ?? 'not shown'}` : null,
          found?.arrivalMismatch
            ? arrivalMismatchNote(found.arrivalMismatch)
            : amendment.requestedArrival === undefined && diff.arrival
              ? `Email arrival ${shownDate(amendment.arrival)}; HMS arrival ${shownDate(stay.arrival)}`
              : null,
          amendment.requestedDeparture === undefined && diff.departure
            ? `Email departure ${shownDate(amendment.departure)}; HMS departure ${shownDate(stay.departure)}`
            : null,
        ].filter((part): part is string => Boolean(part))
      : [];

  return (
    <section id="quote-booking" aria-labelledby="amend-lookup-title" data-testid="amend-lookup-panel" className={panelClass}>
      <h3 id="amend-lookup-title" className="text-[13px] font-semibold text-[#1e293b]">
        {amendment.kind === 'cancel' ? 'Cancellation request' : 'Change to an existing booking'}
      </h3>
      {amendment.kind === 'amend' && readOnlyAmend?.refreshPending ? <p role="status" className={infoNoteClass}>
        Checking this email for the latest request…
      </p> : null}
      {amendment.kind === 'amend' && readOnlyAmend?.refreshMessage ? <p role="status" className={warnNoteClass}>
        {readOnlyAmend.refreshMessage}{' '}
        {readOnlyAmend.retryRefresh ? <button type="button" className="font-semibold underline" onClick={readOnlyAmend.retryRefresh}>Try again</button> : null}
      </p> : null}
      {amendment.kind === 'amend' && (readOnlyAmend?.draft?.requestCount ?? 0) > 1 ?
        <p role="status" className={warnNoteClass}>This email has multiple changes. Open each booking in HMS.</p> : null}
      <p data-testid="amend-request-summary" data-pii title="Request from this email" className={valueClass}>
        {requestLine}
      </p>
      {amendment.kind === 'amend' && readOnlyIdentity && selectedTransportId && workItemId ? (
        <CloudAmendHistory key={JSON.stringify([readOnlyIdentity, selectedTransportId, binding?.selectionEpoch, workItemId])}
          trpc={trpc} transportId={selectedTransportId} suspended={activeAmendApproval} selection={{ workItemId, source: {
            threadId: readOnlyIdentity.threadId, messageId: readOnlyIdentity.messageId, sourceHash: readOnlyIdentity.sourceHash,
          } }} />
      ) : null}
      {savedPicks.length ? (
        <div data-testid="amend-saved-stays" className="flex flex-col gap-2">
          <p className={headingClass}>{SAVED_STAY_COPY.heading}</p>
          <ul className="flex flex-col gap-1.5">
            {savedPicks.map((pick) => (
              <li key={pick.stayId}>
                <button
                  type="button"
                  data-testid="amend-saved-stay"
                  aria-pressed={pick.stayId === resolvedStayId}
                  data-pii
                  className={buttonClass}
                  onClick={() => chooseSavedStay(pick.stayId, pick.confirmationNumber)}
                >
                  {pick.confirmationNumber}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {checkReason ? (
        <div data-testid="amend-check-banner" className={warnNoteClass}>
          <p className="font-semibold">{AMEND_FIND_COPY.checkBanner}</p>
          <p>{AMEND_FIND_COPY.checkHint}</p>
        </div>
      ) : null}
      {stay && unpaidStay === false && (!readOnlyAmend || amendment.kind === 'cancel') &&
        (amendment.kind === 'amend' || amendment.kind === 'cancel') ? (
        <div
          data-testid={amendment.kind === 'cancel' ? 'cancel-payment-banner' : 'amend-payment-banner'}
          className={warnNoteClass}
        >
          {AMEND_SAVE_COPY.handleInHms}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3">
        <div
          data-testid={stay ? 'amend-hms-result-card' : undefined}
          className="flex min-w-0 flex-col gap-2"
        >
          <p className={headingClass}>{readOnlyAmend ? 'Booking at last HMS lookup' : 'Booking in HMS now'}</p>
          {stay ? (
            <>
              <dl data-testid="amend-hms-facts" className="grid grid-cols-2 gap-x-2.5 gap-y-1.5">
                <HmsFact field="confirmation" label="Confirmation" value={foundNumber ?? 'Not shown'} pii />
                <HmsFact field="guest" label="Guest" value={stayGuest(stay) ?? 'Not shown'} pii />
                <HmsFact field="dates" label="Dates" value={stayDateRange(stay)} />
                <HmsFact field="room" label="Room" value={roomType ?? 'Not shown'} />
                <HmsFact field="status" label="Status" value={hmsStatus ?? 'Not shown'} />
                <HmsFact field="rate-plan" label="Rate plan" value={ratePlan ?? 'Not shown'} />
              </dl>
              {matchWarningParts.length ? (
                <p data-testid="amend-match-warning" data-pii className="text-[10.5px] text-[#64748b]">
                  <span className="font-semibold">Doesn't match HMS: </span>
                  {matchWarningParts.join(' · ')}
                </p>
              ) : null}
              {handoffNumber ? (
                <HmsLinkActions
                  confirmation={handoffNumber}
                  guestSurname={amendment.guestLastName}
                  arrival={amendment.arrival}
                />
              ) : null}
              {found ? (
                <RunScreenshot
                  load={client?.screenshot ?? null}
                  runId={found.runId}
                  name={found.screenshots.includes('record.png') ? 'record.png' : null}
                  label={AMEND_FIND_COPY.seeBooking}
                  alt="What Nava saw on the HMS booking record"
                />
              ) : null}
              {findView?.status === 'done' ? <HmsAsOf asOf={findView.asOf} /> : null}
              {readOnlyAmend && shownFindRequest && shownFindRequest.confirmation === foundNumber ? (
                <button type="button" className={buttonClass} disabled={!key || !transport || busy}
                  onClick={() => {
                    if (reviewScope && foundNumber && stay && amendment.kind === 'amend')
                      refreshingAmend.current = { scope: reviewScope, confirmation: foundNumber, stay,
                        contactObservations: found?.reservationObservations };
                    find.start(shownFindRequest);
                  }}>
                  Refresh HMS lookup
                </button>
              ) : null}
            </>
          ) : (
            <>
              {handoffNumber ? (
                <>
                  <dl className="grid grid-cols-2 gap-x-2.5 gap-y-1.5">
                    <HmsFact
                      field="confirmation"
                      label="Confirmation"
                      value={handoffNumber}
                      title="From the email"
                      pii
                    />
                  </dl>
                  <HmsLinkActions
                    confirmation={handoffNumber}
                    guestSurname={amendment.guestLastName}
                    arrival={amendment.arrival}
                    handoff
                  />
                </>
              ) : null}
              <p className="text-[11.5px] text-[#64748b]">{running ? 'Looking up…' : 'Nothing shown yet.'}</p>
            </>
          )}
        </div>
        {requestedRows.length ? (
          <div data-testid="amend-changes" className="flex min-w-0 flex-col gap-2">
            <p className={headingClass}>Requested changes</p>
            {requestedRows.map((row) => (
              <RequestedChangeRow key={row.label} {...row} />
            ))}
          </div>
        ) : null}
      </div>
      {bookedMissing ? (
        <p data-testid="booked-dates-missing" className={warnNoteClass}>
          {AMEND_FIND_COPY.bookedMissing}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {found || (findNotFound && !prefetchedNotFound) || findAmbiguous || waitingForSavedPick ? null : (
          <>
            <button
              type="button"
              className={buttonClass}
              disabled={!canLookUp || busy || !find.readBackSettled}
              onClick={() => {
                if (!key || !hmsNumber) return;
                const next = findRequestFor(hmsNumber, findArrival);
                if ('request' in next) find.start(next.request);
              }}
            >
              {findRun?.kind === 'error' ? 'Try the lookup again' : 'Find this booking in HMS'}
            </button>
            {lookupable ? null : (
              <p className="text-[10.5px] font-semibold text-amber-900">
                {AMEND_FIND_COPY.noHmsNumber}
              </p>
            )}
            <p className="text-[10.5px] text-[#64748b]">{AMEND_FIND_COPY.lookupWait}</p>
          </>
        )}
        <HmsJobStatusLine
          view={findView}
          queuing={find.queuing}
          detail={AMEND_FIND_COPY.looking}
          onRetry={find.retry}
          statusFailed={find.statusFailed}
        />
        <div aria-live="polite">
          {note ? (
            <p data-pii={note.pii || undefined} className={note.tone === 'warn' ? warnNoteClass : infoNoteClass}>
              {note.text}
            </p>
          ) : null}
        </div>
      </div>
      {searchOpen ? (
        <GuestSearchSection
          key={`${key ?? 'none'}|${amendment.guestLastName ?? ''}|${amendment.arrival ?? ''}|${amendment.departure ?? ''}`}
          initial={{
            lastName: amendment.guestLastName?.trim() ?? '',
            arrival: amendment.arrival ?? '',
            departure: amendment.departure ?? '',
          }}
          canSearch={Boolean(key && transport)}
          readBackSettled={searchResume === null || search.readBackSettled}
          hint={searchHint}
          busy={busy}
          searching={searching}
          queuing={search.queuing}
          view={searchView}
          statusFailed={search.statusFailed}
          run={searchRun}
          stayPick={stayPick}
          onRetry={search.retry}
          onSearch={(form) => {
            if (!key) return;
            const next = searchRequestFor(form);
            if ('request' in next) {
              setRefusedSearch(null);
              search.start(next.request);
            } else {
              setRefusedSearch({ scope: key, message: next.error });
            }
          }}
          onPick={(row) => {
            if (!key) return;
            const next = findRequestFor(row.confirmation, row.arrival);
            if ('request' in next) {
              setSelectedAfterClear({ scope: key, confirmation: row.confirmation, arrival: row.arrival });
              find.start(next.request);
            }
          }}
        />
      ) : null}
      {requireNativeCancelPreview ? (
        <>
      {amendment.kind === 'cancel' && cancelTarget && cancelScope &&
        (cancelRestoreInput || (cancelStay && !checkReason)) ? (
        <CloudCancelSection
          key={cancelScope}
          view={cancelView}
          canPreview={canPreviewCancel && Boolean(cancelInput)}
          chargeEnabled={canPreviewCancel && Boolean(cancelRestoreInput)}
          offNote={checkReason ? 'Check the booking in HMS before previewing cancellation.'
            : canPreviewCancel && !cancelInput ? 'Select the current email before previewing cancellation.' : cancelSwitchedOffNote(cancelTarget)}
          confirmation={cancelTarget}
          arrival={cancelArrival}
          requireNativePreview={requireNativeCancelPreview}
          guestName={(cancelStay ? stayGuest(cancelStay) : null) ?? amendment.guestLastName ?? 'this guest'}
          client={cancelClient}
          trpc={trpc}
          transportId={cancelTransportId}
          selection={cancelRestoreInput && session.binding?.internetMessageId?.trim()
            ? { ...cancelRestoreInput, internetMessageId: session.binding.internetMessageId.trim() } : null}
          waitingForFind={!cancelStay || Boolean(checkReason)}
          isCurrent={() => cancelMountedRef.current && cancelScopeRef.current === cancelScope}
          onRestored={(view) => {
            if (!cancelMountedRef.current || !cancelScope || cancelScopeRef.current !== cancelScope) return;
            setCancelViews((prev) => {
              if (view) return { ...prev, [cancelScope]: view };
              if (!(cancelScope in prev)) return prev;
              const next = { ...prev }; delete next[cancelScope]; return next;
            });
            if (view?.kind === 'done' && view.run.outcome === 'cancelled') reportStayAction('cancel', cancelTarget);
          }}
          onPreview={() => void previewCancel()}
          onReason={chooseReason}
          cancellationNote={cancelScope ? cancelNotes[cancelScope] ?? '' : ''}
          onNote={(note) => { if (cancelScope) setCancelNotes((prev) => ({ ...prev, [cancelScope]: note.slice(0, 200) })); }}
          onCommit={() => {
            if (cancelView?.kind === 'ready') void commitCancel(cancelView);
          }}
        />
      ) : null}
        </>
      ) : (
        <>
      {amendment.kind === 'cancel' && stay && foundNumber && !checkReason ? (
        <CancelSection
          view={cancelView}
          canPreview={canPreviewCancel}
          offNote={cancelSwitchedOffNote(foundNumber)}
          confirmation={foundNumber}
          guestName={stayGuest(stay) ?? amendment.guestLastName ?? 'this guest'}
          client={cancelClient}
          onPreview={() => void previewCancel()}
          onReason={chooseReason}
          onCommit={() => {
            if (cancelView?.kind === 'ready') void commitCancel(cancelView);
          }}
        />
      ) : null}
        </>
      )}
      {amendment.kind === 'amend' && readOnlyAmend && amendReview && readOnlyIdentity &&
          (!readOnlyAmend.requireDurableDraft || durableDraft) ? (
          <fieldset className="min-w-0" hidden={!currentAmendReview} disabled={readOnlyAmend.historyBusy}>
          <LocalAmendReview
            key={JSON.stringify([readOnlyIdentity, binding?.transportId, binding?.selectionEpoch, amendReview.confirmation,
              readOnlyAmend.historyEpoch])}
            identity={readOnlyIdentity}
            revision={localReadRevision}
            confirmation={amendReview.confirmation}
            stay={amendReview.stay}
            contactObservations={amendReview.contactObservations}
            requestedArrival={projected ? projected.arrival : amendment.requestedArrival}
            requestedDeparture={projected ? projected.departure : amendment.requestedDeparture}
            requestedAdults={projected?.adults}
            requestedChildren={projected?.children}
            requestedChildAges={projected?.childAges}
            durableDraft={durableDraft}
            refreshPending={readOnlyAmend.refreshPending}
            ratePlans={readOnlyAmend.ratePlans}
            defaultRecipient={session.staffHeader.clientEmail}
            onApprovalVisibilityChange={setActiveAmendApproval}
            writeContext={currentAmendReview && selectedTransportId && workItemId ? { trpc, transportId: selectedTransportId, workItemId } : null}
          />
          </fieldset>
      ) : amendment.kind === 'amend' && stay && foundNumber && !checkReason && readOnlyAmend &&
          (readOnlyAmend.draft?.requestCount ?? 0) <= 1 ? (
        <p className={infoNoteClass}>{readOnlyAmend.requireDurableDraft && !durableDraft
          ? <>{readOnlyAmend.draftLoading ? 'Loading the saved request…' : 'The saved request is not ready.'}{' '}
            {!readOnlyAmend.draftLoading && readOnlyAmend.retryDraft ? <button type="button" className="font-semibold underline"
              onClick={readOnlyAmend.retryDraft}>Try again</button> : null}</>
          : 'Select the email and confirm the booking before reviewing this change.'}</p>
      ) : amendment.kind === 'amend' && stay && foundNumber && !checkReason && !readOnlyAmend ? (
        <AmendSection
          view={amendView}
          canPreview={canAmendWrite}
          offNote={
            unpaidStay
              ? `${AMEND_SAVE_COPY.switchedOff} Open ${foundNumber} in HMS and save the change there.`
              : ''
          }
          rows={amendRows}
          values={requestedValues}
          current={stayCurrent}
          client={amendClient}
          onChange={(field, value) => {
            if (!amendScope) return;
            setRequestedByScope((prev) => ({ ...prev, [amendScope]: { ...prev[amendScope], [field]: value } }));
            setAmendViews((prev) => {
              const view = prev[amendScope];
              if (view?.kind !== 'ready' && view?.kind !== 'committing') return prev;
              return { ...prev, [amendScope]: { kind: 'idle', note: null } };
            });
          }}
          onPreview={() => void previewAmendStay()}
          onCommit={() => {
            if (amendView?.kind === 'ready') void commitAmendStay(amendView);
          }}
        />
      ) : amendment.kind === 'amend' && !(stay && foundNumber) && readOnlyAmend ? (
        <p className={captionClass}>Find the booking to review the requested changes.</p>
      ) : amendment.kind === 'amend' && !(stay && foundNumber) ? (
        <div data-testid="amend-run-placeholder" className="flex justify-end border-t border-[#e2e8f0] pt-2">
          <button type="button" className={buttonClass} disabled title="Find the booking first">
            {AMEND_SAVE_COPY.preview}
          </button>
        </div>
      ) : (
        <p className={captionClass}>{footer}</p>
      )}
    </section>
  );
}

/** Find by surname and arrival, for an email with no usable booking number. Prefilled from the email, editable. */
function GuestSearchSection({
  initial,
  canSearch,
  readBackSettled,
  hint,
  busy,
  searching,
  queuing,
  view,
  statusFailed,
  run,
  stayPick,
  onRetry,
  onSearch,
  onPick,
}: {
  initial: SearchForm;
  canSearch: boolean;
  readBackSettled: boolean;
  hint: string | null;
  busy: boolean;
  searching: boolean;
  queuing: boolean;
  view: HmsJobView | null;
  statusFailed: boolean;
  run: HmsSearchRun | null;
  stayPick: StayPick;
  onRetry: () => void;
  onSearch: (form: SearchForm) => void;
  onPick: (row: GuestSearchRow) => void;
}) {
  const [form, setForm] = useState<SearchForm>(initial);
  const surnameId = useId();
  const arrivalId = useId();
  const departureId = useId();

  return (
    <div data-testid="amend-guest-search" className="flex flex-col gap-2">
      <p className={headingClass}>Find by guest name</p>
      <p className={captionClass}>{AMEND_FIND_COPY.searchIntro}</p>
      <div className="grid grid-cols-3 gap-2">
        <label htmlFor={surnameId} className="flex flex-col gap-1">
          <span className={headingClass}>Guest surname</span>
          <input
            id={surnameId}
            type="text"
            data-pii
            className={selectClass}
            value={form.lastName}
            disabled={searching}
            onChange={(event) => setForm((prev) => ({ ...prev, lastName: event.target.value }))}
          />
        </label>
        <label htmlFor={arrivalId} className="flex flex-col gap-1">
          <span className={headingClass}>Arrival</span>
          <input
            id={arrivalId}
            type="date"
            className={selectClass}
            value={form.arrival}
            disabled={searching}
            onChange={(event) => setForm((prev) => ({ ...prev, arrival: event.target.value }))}
          />
        </label>
        <label htmlFor={departureId} className="flex flex-col gap-1">
          <span className={headingClass}>Departure (optional)</span>
          <input
            id={departureId}
            type="date"
            className={selectClass}
            value={form.departure}
            disabled={searching}
            onChange={(event) => setForm((prev) => ({ ...prev, departure: event.target.value }))}
          />
        </label>
      </div>
      <button
        type="button"
        className={buttonClass}
        disabled={!canSearch || busy || !readBackSettled}
        onClick={() => onSearch(form)}
      >
        {AMEND_FIND_COPY.searchButton}
      </button>
      {hint ? <p className={captionClass}>{hint}</p> : null}
      <div aria-live="polite" className="flex flex-col gap-2">
        <HmsJobStatusLine
          view={view}
          queuing={queuing}
          detail={AMEND_FIND_COPY.searching}
          onRetry={onRetry}
          statusFailed={statusFailed}
        />
        {run ? <SearchResult run={run} busy={busy} onPick={onPick} stayPick={stayPick} /> : null}
        {view?.status === 'done' ? <HmsAsOf asOf={view.asOf} /> : null}
      </div>
    </div>
  );
}

function StayPickNote({ pick, shownConfirmation }: { pick: StayPick; shownConfirmation?: string | null }) {
  const text = stayPickCaption(pick, shownConfirmation);
  if (!text) return null;
  return (
    <p data-testid="stay-pick-line" data-pii className={infoNoteClass}>
      {text}
    </p>
  );
}

function SearchResult({
  run,
  busy,
  onPick,
  stayPick,
}: {
  run: HmsSearchRun;
  busy: boolean;
  onPick: (row: GuestSearchRow) => void;
  stayPick: StayPick;
}) {
  if (run.kind === 'rows') {
    const rows = run.rows.slice(0, 5);
    const shown = rows.length === 1 ? rows[0]!.confirmation : null;
    return (
      <div className="flex flex-col gap-2">
        <StayPickNote pick={stayPick} shownConfirmation={shown} />
        <ul aria-label="Bookings found in HMS" className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.confirmation}>
              <div className="flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white px-2.5 py-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px] text-[#1e293b]">
                  <span data-pii className="font-semibold text-[#0066cc]">
                    {row.confirmation}
                  </span>
                  <span data-pii>{rowGuest(row)}</span>
                  <span className="text-[#64748b]">{displayedStatus(row.status) ?? 'Status not shown'}</span>
                  <span className="text-[#64748b]">{rowDates(row)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" disabled={busy} onClick={() => onPick(row)} className={buttonClass}>
                    Show booking in HMS
                  </button>
                  <HmsLinkActions confirmation={row.confirmation} confirmationOnly />
                </div>
              </div>
            </li>
          ))}
        </ul>
        <p className={captionClass}>
          {run.rows.length > 5
            ? 'Showing the first 5 matches. Add the departure date to narrow the search.'
            : AMEND_FIND_COPY.searchPick}
        </p>
      </div>
    );
  }
  const text =
    run.kind === 'none'
      ? noSearchMatchCopy(run.lastName, run.arrival)
      : run.kind === 'capped'
        ? AMEND_FIND_COPY.searchCapped
        : run.message;
  return (
    <p data-pii={run.kind === 'none' || undefined} className={warnNoteClass}>
      {text}
    </p>
  );
}

function rowGuest(row: GuestSearchRow): string {
  return [stayText(row.firstName), stayText(row.lastName)].filter(Boolean).join(' ') || 'Name not shown';
}

function rowDates(row: GuestSearchRow): string {
  const arrival = row.arrival ? formatStayDate(row.arrival) : 'Not shown';
  const departure = row.departure ? formatStayDate(row.departure) : 'Not shown';
  return `${arrival} to ${departure}`;
}

function shownDate(value: string | null): string {
  const text = stayText(value);
  return text ? formatStayDate(text) : 'Not shown';
}

function stayDateRange(stay: StayRecordWire): string {
  const arrival = stayText(stay.arrival);
  const departure = stayText(stay.departure);
  if (arrival && departure) return `${formatStayDate(arrival)}–${formatStayDate(departure)}`;
  const onlyDate = arrival ?? departure;
  if (onlyDate) return formatStayDate(onlyDate);
  return 'Dates not shown';
}

function displayedRoomType(value: string | null): string | null {
  const roomType = stayText(value);
  if (!roomType) return null;
  const code = knownRoomCode(roomType);
  return code ? ROOM_TYPE_NAMES[code] : roomType;
}

function displayedStatus(value: string | null): string | null {
  const status = stayText(value);
  if (!status) return null;
  if (/cancel/i.test(status)) return 'Cancelled';
  if (/\b(reserv|confirm|booked)\w*\b/i.test(status)) return 'Confirmed';
  return status;
}

function requestSummary(amendment: QuoteAmendment, includeStructuredDates = true): string {
  const request = stayText(amendment.requestedChange);
  if (amendment.kind === 'cancel') return request ?? 'Cancel this booking';

  const changes: string[] = [];
  const dateChanges = [
    { label: 'arrival', current: amendment.arrival, requested: amendment.requestedArrival },
    { label: 'departure', current: amendment.departure, requested: amendment.requestedDeparture },
  ];
  for (const { label, current, requested } of dateChanges) {
    if (!requested || (current && isoDayOf(current) === isoDayOf(requested))) continue;
    const to = formatStayDate(requested);
    changes.push(current ? `Change ${label} ${formatStayDate(current)} → ${to}` : `Change ${label} to ${to}`);
  }
  if (request) return includeStructuredDates && changes.length ? `${request} · ${changes.join('; ')}` : request;
  if (changes.length) return includeStructuredDates ? changes.join('; ') : 'Change requested in this email.';
  return 'No change requested in this email.';
}

function requestedChangeRows(
  amendment: QuoteAmendment,
  stay: StayRecordWire,
  diff: AmendDiff,
): Array<{ label: string; from: string; to: string }> {
  const rows: Array<{ label: string; from: string; to: string }> = [];
  if (amendment.requestedArrival && (diff.arrival || !stayText(stay.arrival))) {
    rows.push({
      label: 'Arrival',
      from: stayText(stay.arrival) ? shownDate(stay.arrival) : 'HMS: —',
      to: formatStayDate(amendment.requestedArrival),
    });
  }
  if (amendment.requestedDeparture && (diff.departure || !stayText(stay.departure))) {
    rows.push({
      label: 'Departure',
      from: stayText(stay.departure) ? shownDate(stay.departure) : 'HMS: —',
      to: formatStayDate(amendment.requestedDeparture),
    });
  }
  return rows;
}

/** `pii`: values naming the guest or reservation are masked in preview snapshots. */
function HmsFact({
  field,
  label,
  value,
  title,
  pii = false,
}: {
  field: string;
  label: string;
  value: string;
  title?: string;
  pii?: boolean;
}) {
  return (
    <div data-field={field} className="flex min-w-0 flex-col gap-0.5">
      <dt className={headingClass}>{label}</dt>
      <dd data-pii={pii || undefined} title={title} className="break-words text-[12.5px] text-[#1e293b]">
        {value}
      </dd>
    </div>
  );
}

function RequestedChangeRow({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <p data-testid="amend-diff-row" data-pii={label === 'Guest' || undefined} className={valueClass}>
      {`${label}: ${from} → ${to}`}
    </p>
  );
}

/** Bind the editable request to the current selected email and booking. */
function LocalAmendReview({ identity, revision, confirmation, stay, contactObservations, requestedArrival, requestedDeparture,
  requestedAdults, requestedChildren, requestedChildAges, durableDraft, refreshPending, ratePlans, defaultRecipient, writeContext, onApprovalVisibilityChange }: {
  identity: SavedStayAmendEditorIdentity;
  revision: string;
  confirmation: string;
  stay: StayRecordWire;
  contactObservations?: StayContactObservations;
  requestedArrival?: string | null;
  requestedDeparture?: string | null;
  requestedAdults?: number | null;
  requestedChildren?: number | null;
  requestedChildAges?: number[] | null;
  durableDraft: NonNullable<AmendReadOnlyContext['draft']> | null;
  refreshPending?: boolean;
  ratePlans: RatePlanCatalogueEntry[];
  defaultRecipient: string;
  onApprovalVisibilityChange: (visible: boolean) => void;
  writeContext: { trpc: unknown; transportId: string; workItemId: string } | null;
}) {
  const [draftStore] = useState(createSavedStayAmendDraftStore);
  const [draft, setDraft] = useState<SavedStayAmendDraftUpdate | null>(null);
  const lastTarget = useRef('');
  useEffect(() => {
    const arrival = sendableArrival(stay.arrival ?? '');
    if (refreshPending || !durableDraft || !arrival) return;
    const target = { confirmation, arrival };
    const key = JSON.stringify(target);
    if (key !== lastTarget.current && JSON.stringify(durableDraft.request?.fields.value.target) !== key) {
      lastTarget.current = key;
      durableDraft.record('target', target);
    }
  }, [refreshPending, durableDraft?.record, durableDraft?.request?.fields.value.target, confirmation, stay.arrival]);
  const stayId = durableDraft?.request?.stayId;
  const cleared = stayId ? {
    arrival: requestedArrival == null && durableDraft?.fieldMeta[`stays[${stayId}].requested.arrival`]?.origin === 'staff',
    departure: requestedDeparture == null && durableDraft?.fieldMeta[`stays[${stayId}].requested.departure`]?.origin === 'staff',
    adults: requestedAdults == null && durableDraft?.fieldMeta[`stays[${stayId}].totalAdults`]?.origin === 'staff',
    children: requestedChildren == null && durableDraft?.fieldMeta[`stays[${stayId}].totalChildren`]?.origin === 'staff',
  } : undefined;
  const requested = { arrival: requestedArrival, departure: requestedDeparture, adults: requestedAdults,
    children: requestedChildren, childAges: requestedChildAges, cleared };
  const basis = savedStayAmendReviewBasis(stay, requested, revision);
  const currentDraft = draft?.basis === basis && draft.extractionRevision === revision &&
    draft.confirmation === confirmation &&
    (['propertyCode', 'threadId', 'messageId', 'mailboxEmail', 'sourceHash'] as const)
      .every((field) => draft.identity[field] === identity[field]) ? draft : null;
  return <>
    <SavedStayAmendEditor draftStore={draftStore} identity={identity} extractionRevision={revision}
      confirmation={confirmation} stay={stay} requestedArrival={requestedArrival}
      requestedDeparture={requestedDeparture} requestedAdults={requestedAdults} requestedChildren={requestedChildren}
      requestedChildAges={requestedChildAges} cleared={cleared} onFieldEdit={(field, value, next) => {
        if (!durableDraft) return;
        if (field === 'arrival' || field === 'departure' || field === 'nights') {
          const dateField = field === 'nights' ? 'departure' : field;
          const date = next[dateField];
          durableDraft.record(dateField, date || null, !date || Boolean(sendableArrival(date)));
        } else if (field === 'adults' || field === 'children') {
          const valid = !value || /^(0|[1-9]\d{0,2})$/.test(value);
          durableDraft.record(field, value && valid ? Number(value) : null, valid);
        } else if (field === 'childAges') {
          const parts = value.trim() ? value.split(',').map((age) => age.trim()) : [];
          const valid = parts.every((age) => /^(0|[1-9]\d?)$/.test(age) && Number(age) <= 17) && parts.length <= 9;
          durableDraft.record('childAges', value.trim() && valid ? parts.map(Number) : value.trim() ? null : [], valid);
        }
      }} onDraftChange={setDraft} />
    <LocalAmendChoices stay={stay} ratePlans={ratePlans} draft={currentDraft}
      identity={identity} confirmation={confirmation} contactObservations={contactObservations}
      defaultRecipient={defaultRecipient} writeContext={writeContext} durableDraft={durableDraft}
      onApprovalVisibilityChange={onApprovalVisibilityChange} />
  </>;
}

function LocalAmendChoices({ stay, ratePlans, draft, identity, confirmation, contactObservations, defaultRecipient, writeContext,
  durableDraft, onApprovalVisibilityChange }: {
  stay: StayRecordWire;
  ratePlans: RatePlanCatalogueEntry[];
  draft: SavedStayAmendDraftUpdate | null;
  identity: SavedStayAmendEditorIdentity;
  confirmation: string;
  contactObservations?: StayContactObservations;
  defaultRecipient: string;
  onApprovalVisibilityChange: (visible: boolean) => void;
  writeContext: { trpc: unknown; transportId: string; workItemId: string } | null;
  durableDraft: NonNullable<AmendReadOnlyContext['draft']> | null;
}) {
  const labtest = stay.firstName?.trim() === 'Proof' && stay.lastName?.trim() === 'Labtest';
  const saved = durableDraft?.request?.fields.value;
  const staffCleared = (field: string) => durableDraft?.fieldMeta[`requests[${durableDraft?.request?.requestId}].${field}`]?.origin === 'staff';
  const savedText = (field: string, value: string | null | undefined, fallback: string) =>
    value ?? (staffCleared(field) ? '' : fallback);
  const initialRoom = saved?.roomType ?? (staffCleared('roomType') ? '' : knownRoomCode(stay.roomType ?? '') ?? stay.roomType ?? '');
  const initialRate = saved?.ratePlan ?? (staffCleared('ratePlan') ? '' : stay.ratePlan ?? '');
  const initialFirstName = savedText('firstName', saved?.firstName, stay.firstName ?? '');
  const initialLastName = savedText('lastName', saved?.lastName, stay.lastName ?? '');
  const initialGuestEmail = savedText('guestEmail', saved?.guestEmail, contactObservations?.guestEmail?.value ?? '');
  const initialBookerName = savedText('bookerName', saved?.bookerName, contactObservations?.bookerName?.value ?? '');
  const initialBookerContact = savedText('bookerContact', saved?.bookerContact, contactObservations?.bookerContact?.value ?? '');
  const initialCmsMessageId = savedText('cms.messageId', saved?.cms.messageId,
    labtest ? '' : stay.bookingAgency || stay.organization ? '03' : '01');
  const recipientCleared = saved?.cms.recipient === null && staffCleared('cms.recipient');
  const sendCleared = saved?.cms.send === null && staffCleared('cms.send');
  const [roomType, setRoomType] = useState(initialRoom);
  const [ratePlan, setRatePlan] = useState(initialRate);
  const [rateSearch, setRateSearch] = useState(initialRate);
  const [showRateMatches, setShowRateMatches] = useState(false);
  const [retainRates, setRetainRates] = useState<'yes' | 'no'>(saved?.retainRates ?? 'no');
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [guestEmail, setGuestEmail] = useState(initialGuestEmail);
  const [bookerName, setBookerName] = useState(initialBookerName);
  const [bookerContact, setBookerContact] = useState(initialBookerContact);
  const [editedDetails, setEditedDetails] = useState<string[]>([]);
  const sources = useConfirmationSources();
  const [recipientMode, setRecipientMode] = useState<ConfirmationMode>(recipientCleared ? 'custom' : saved?.cms.recipient?.mode ?? sources?.setting?.mode ?? 'self');
  const [customRecipient, setCustomRecipient] = useState(recipientCleared ? '' : saved?.cms.recipient?.address ?? sources?.setting?.address ?? '');
  const [recipientTouched, setRecipientTouched] = useState(Boolean(saved?.cms.recipient || recipientCleared));
  const [cmsSend, setCmsSend] = useState(labtest ? false : saved?.cms.send ?? true);
  const [cmsNeedsChoice, setCmsNeedsChoice] = useState(Boolean(!labtest && sendCleared));
  const [cmsMessageId, setCmsMessageId] = useState(initialCmsMessageId);
  const [cmsTouched, setCmsTouched] = useState(Boolean(saved && (saved.cms.send !== null || saved.cms.messageId !== null || saved.cms.recipient)));
  const [cmsEdited, setCmsEdited] = useState(false);
  const [boundKey, setBoundKey] = useState<string | null>(null);
  const [availableKey, setAvailableKey] = useState<string | null>(null);
  const rates = useAmendRateCandidates({ trpc: writeContext?.trpc ?? null,
    transportId: writeContext?.transportId ?? null, workItemId: writeContext?.workItemId ?? null,
    source: { threadId: identity.threadId, messageId: identity.messageId, sourceHash: identity.sourceHash },
    confirmation, draft: durableDraft });
  useEffect(() => {
    if (recipientTouched || !sources?.setting) return;
    setRecipientMode(sources.setting.mode);
    setCustomRecipient(sources.setting.address ?? '');
  }, [recipientTouched, sources?.setting]);
  useEffect(() => {
    if (!editedDetails.includes('roomType')) setRoomType(initialRoom);
    if (!editedDetails.includes('ratePlan')) {
      setRatePlan(initialRate);
      setRateSearch(initialRate);
    }
    if (!editedDetails.includes('firstName')) setFirstName(initialFirstName);
    if (!editedDetails.includes('lastName')) setLastName(initialLastName);
    if (!editedDetails.includes('guestEmail')) setGuestEmail(initialGuestEmail);
    if (!editedDetails.includes('bookerName')) setBookerName(initialBookerName);
    if (!editedDetails.includes('bookerContact')) setBookerContact(initialBookerContact);
    if (!editedDetails.includes('retainRates')) setRetainRates(saved?.retainRates ?? 'no');
    if (!cmsEdited && saved) {
      setCmsSend(labtest ? false : saved.cms.send ?? true);
      setCmsNeedsChoice(Boolean(!labtest && sendCleared));
      setCmsMessageId(initialCmsMessageId);
      setCmsTouched(Boolean(saved.cms.send !== null || saved.cms.messageId !== null || saved.cms.recipient));
      if (saved.cms.recipient) {
        setRecipientMode(saved.cms.recipient.mode);
        setCustomRecipient(saved.cms.recipient.address);
        setRecipientTouched(true);
      } else if (recipientCleared) {
        setRecipientMode('custom'); setCustomRecipient(''); setRecipientTouched(true);
      }
    }
  }, [stay, contactObservations, saved, editedDetails, cmsEdited, labtest, initialRoom, initialRate, initialFirstName,
    initialLastName, initialGuestEmail, initialBookerName, initialBookerContact, initialCmsMessageId, recipientCleared, sendCleared]);
  const recipient = resolveConfirmationRecipient({
    mode: recipientMode, customAddress: customRecipient, userEmail: sources?.userEmail ?? '', clientEmail: defaultRecipient,
    invalidSetting: sources?.invalidSetting || sources?.load === 'failed', staffChose: recipientTouched,
  });
  const recipientLoading = sources?.load === 'pending' && !recipientTouched;
  const cmsRecipient = recipient.ok ? recipient.recipient.address : '';
  const choicesValid = Boolean(draft && draft.errors.every((error) => error === 'Choose a change to the booking.'));
  const rateMatches = ratePlans.filter((plan) =>
    `${plan.code} ${plan.name}`.toLocaleLowerCase().includes(rateSearch.trim().toLocaleLowerCase())).slice(0, 8);
  const pendingRateMatch = showRateMatches && rateMatches.length > 0 &&
    !ratePlans.some((plan) => plan.code.toUpperCase() === ratePlan);
  const changes = { ...draft?.proposal?.changes,
    ...(roomType && roomType !== (knownRoomCode(stay.roomType ?? '') ?? stay.roomType) ? { roomType } : {}),
    ...(ratePlan && ratePlan !== stay.ratePlan ? { ratePlan } : {}),
    ...(firstName.trim() !== (stay.firstName ?? '') ? { firstName: firstName.trim() } : {}),
    ...(lastName.trim() !== (stay.lastName ?? '') ? { lastName: lastName.trim() } : {}),
    ...(guestEmail.trim() !== (contactObservations?.guestEmail?.value ?? '') ? { guestEmail: guestEmail.trim() } : {}),
    ...(bookerName.trim() !== (contactObservations?.bookerName?.value ?? '') ? { bookerName: bookerName.trim() } : {}),
    ...(bookerContact.trim() !== (contactObservations?.bookerContact?.value ?? '') ? { bookerContact: bookerContact.trim() } : {}),
  };
  const retainedPriceChange = retainRates === 'yes' &&
    ['arrival', 'departure', 'adults', 'children', 'childAges', 'roomType', 'ratePlan'].some((key) => Object.hasOwn(changes, key));
  const validRecipient = !cmsNeedsChoice && (!cmsSend || (!recipientLoading && recipient.ok && Boolean(cmsMessageId.trim())));
  const validChanges = Boolean(writeContext && choicesValid && stay.arrival && stay.departure &&
    firstName.trim() && lastName.trim() && /^[A-Z0-9]{1,12}$/.test(ratePlan) && !pendingRateMatch &&
    /^[A-Z0-9]{1,12}$/.test(roomType) && validRecipient && !retainedPriceChange &&
    (Object.keys(changes).length > 0 || cmsTouched));
  const request: CloudAmendRequest | null = validChanges && writeContext && stay.arrival ? {
    workItemId: writeContext.workItemId,
    source: { threadId: identity.threadId, messageId: identity.messageId, sourceHash: identity.sourceHash },
    confirmation, arrival: stay.arrival,
    changes: { ...changes, ratePlan, retainRates, cmsSend: labtest ? false : cmsSend,
      cmsMessageId: cmsMessageId.trim(), cmsRecipient: cmsRecipient.trim() },
  } : null;
  const requestKey = request ? JSON.stringify([request, durableDraft?.editVersion ?? 0]) : null;
  const markDetail = (name: string) => setEditedDetails((current) => current.includes(name) ? current : [...current, name]);
  const recordRecipient = (mode: ConfirmationMode, custom: string) => durableDraft?.record('cms.recipient', {
    mode, address: mode === 'self' ? sources?.userEmail ?? '' : mode === 'client' ? defaultRecipient : custom,
  });
  return <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
    <div className="grid grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-[11.5px] text-[#334155]">
        <span className="font-semibold">Room type</span>
        <span className={captionClass}>HMS: {stay.roomType || 'Not shown'}</span>
        <select className={selectClass} value={roomType} onChange={(event) => {
          setRoomType(event.target.value); markDetail('roomType'); durableDraft?.record('roomType', event.target.value || null);
        }}>
          {!roomType ? <option value="">Choose room type</option> : null}
          {roomType && !Object.hasOwn(ROOM_TYPE_NAMES, roomType) ? <option value={roomType}>{roomType}</option> : null}
          {Object.entries(ROOM_TYPE_NAMES).map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
        </select>
      </label>
      <div className="flex flex-col gap-1 text-[11.5px] text-[#334155]">
        <span className="font-semibold">Rate plan</span>
        <span className={captionClass}>HMS: {stay.ratePlan || 'Not shown'}</span>
        <input aria-label="Rate plan" className={selectClass} value={rateSearch} placeholder="Search code or name"
          onFocus={() => setShowRateMatches(true)} onChange={(event) => {
            const input = event.target.value;
            const code = input.trim().toUpperCase();
            const matches = ratePlans.some((plan) => `${plan.code} ${plan.name}`.toLocaleLowerCase().includes(input.trim().toLocaleLowerCase()));
            const exact = ratePlans.some((plan) => plan.code.toUpperCase() === code);
            setRateSearch(input);
            setRatePlan(code);
            setShowRateMatches(true);
            markDetail('ratePlan');
            durableDraft?.record('ratePlan', code || null, !code || (/^[A-Z0-9]{1,12}$/.test(code) && (!matches || exact)));
          }} />
        {showRateMatches && rateMatches.length ? <ul aria-label="Matching rates" className="max-h-32 overflow-y-auto rounded-sm border border-[#cbd5e1] bg-white">
          {rateMatches.map((plan) => <li key={plan.code}><button type="button" className="w-full px-2 py-1 text-left hover:bg-[#f1f5f9]"
            onClick={() => { setRatePlan(plan.code); setRateSearch(plan.code); setShowRateMatches(false); markDetail('ratePlan');
              durableDraft?.record('ratePlan', plan.code); }}>
            {plan.code} · {plan.name}
          </button></li>)}
          {pendingRateMatch && /^[A-Z0-9]{1,12}$/.test(ratePlan) ? <li><button type="button"
            className="w-full px-2 py-1 text-left hover:bg-[#f1f5f9]" onClick={() => { setRateSearch(ratePlan); setShowRateMatches(false);
              durableDraft?.record('ratePlan', ratePlan); }}>
            Use {ratePlan} as a code
          </button></li> : null}
        </ul> : null}
        <span className={captionClass}>{pendingRateMatch ? 'Choose a match or confirm the typed code.'
          : ratePlans.find((plan) => plan.code === ratePlan)?.name ?? 'Availability checked by HMS when prepared'}</span>
      </div>
      <label className="flex flex-col gap-1 text-[11.5px] text-[#334155]">
        <span className="font-semibold">Retain the current rate?</span>
        <select aria-label="Retain the current rate?" className={selectClass} value={retainRates} onChange={(event) => {
          const value = event.target.value as 'yes' | 'no'; setRetainRates(value); markDetail('retainRates'); durableDraft?.record('retainRates', value);
        }}>
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
        <span className={captionClass}>No: HMS reprices the stay.</span>
      </label>
    </div>
    {retainedPriceChange ? <p className={warnNoteClass}>The new total cannot be verified while retaining rates. Choose No to reprice, or make this change in HMS.</p> : null}
    {rates.available ? <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} disabled={rates.view?.status === 'checking'}
          onClick={() => void rates.check()}>{rates.view?.status === 'checking' ? 'Checking rates…' : 'Check rates in HMS'}</button>
        {/^[A-Z0-9]{1,12}$/.test(ratePlan) ? <button type="button" className={buttonClass}
          disabled={rates.view?.status === 'checking' || pendingRateMatch}
          onClick={() => void rates.check(ratePlan)}>Check {ratePlan}</button> : null}
      </div>
      {rates.view?.status === 'blocked' ? <p role="status" className={warnNoteClass}>{rates.view.message}</p> : null}
      {rates.view?.status === 'ready' && rates.view.reply ? <>
        <HmsAsOf asOf={rates.view.reply.observedAt} />
        <p className={captionClass}>{rates.view.reply.coverage.candidateList === 'complete' ? 'Rate list complete.'
          : rates.view.reply.coverage.candidateList === 'partial' ? 'Rate list is incomplete.' : 'Rate list coverage is unknown.'}
          {rates.view.reply.coverage.reason ? ` ${rates.view.reply.coverage.reason}` : ''}</p>
        {rates.view.reply.recommendation ? <p className={captionClass}>
          {rates.view.reply.recommendation.rateCode ? `${rates.view.reply.recommendation.rateCode}: ` : ''}
          {rates.view.reply.recommendation.explanation}
          {rates.view.reply.recommendation.validation === 'needs_native_check' ? ' HMS check required.' : ''}
        </p> : null}
        {rates.view.reply.options.length ? <ul aria-label="Rates from HMS" className="max-h-48 overflow-y-auto rounded-sm border border-[#cbd5e1] bg-white">
          {rates.view.reply.options.map((option) => {
            const nightly = option.price ? rateMoney(option.price.currency, option.price.averagePerNightMinor) : null;
            const total = option.price?.totalBasis === 'native' ? rateMoney(option.price.currency, option.price.totalMinor) : null;
            return <li key={option.id} className="border-b border-[#e2e8f0] last:border-0">
              <button type="button" className="w-full px-2 py-1.5 text-left disabled:text-[#94a3b8]"
                disabled={['unavailable', 'restricted', 'failed'].includes(option.state)} onClick={() => {
                  setRatePlan(option.rateCode); setRateSearch(option.rateCode); setShowRateMatches(false); markDetail('ratePlan');
                  durableDraft?.record('ratePlan', option.rateCode);
                }}>
                <span className="block text-[12px] font-semibold">{option.rateCode}{option.rateLabel ? ` · ${option.rateLabel}` : ''}</span>
                <span className={captionClass}>{[option.roomLabel ?? option.roomCode, option.boardLabel,
                  option.state === 'unchecked' ? 'Not fully checked' : option.state,
                  nightly ? `${nightly} estimated per night` : null, total ? `${total} total` : null,
                  option.minRoomsAvailable !== null ? `${option.minRoomsAvailable} rooms listed` : null].filter(Boolean).join(' · ')}</span>
                <span className={`block ${captionClass}`}>{option.coverage.nightsObserved}/{option.coverage.nightsExpected} nights checked
                  {!option.coverage.eligibilityVerified ? ' · eligibility not verified' : ''}
                  {!option.coverage.nativePartyIdsMatched ? ' · company/agency not verified' : ''}
                  {option.reasons.length ? ` · ${option.reasons.map(rateReason).join('; ')}` : ''}</span>
              </button>
            </li>;
          })}
        </ul> : <p className={captionClass}>HMS returned no rate options for this check.</p>}
        {rates.view.reply.issues.map((issue, index) => <p key={`${issue.message}:${index}`} className={captionClass}>{issue.message}</p>)}
      </> : null}
    </div> : null}
    {stay.averageRate || stay.grandTotal ? <p className={captionClass}>HMS at lookup: {stay.averageRate ? `Average ${stay.averageRate}` : ''}{stay.averageRate && stay.grandTotal ? ' · ' : ''}{stay.grandTotal ? `Total ${stay.grandTotal}` : ''}</p> : null}
    <details className="rounded-sm border border-[#e2e8f0] p-2">
      <summary className="cursor-pointer text-[12px] font-semibold text-[#334155]">More · guest and booker</summary>
      <div className="mt-2 grid grid-cols-2 gap-2">
      {([['Guest first name', firstName, setFirstName, stay.firstName], ['Guest surname', lastName, setLastName, stay.lastName],
        ['Guest email', guestEmail, setGuestEmail, contactObservations?.guestEmail?.value],
        ['Booker name', bookerName, setBookerName, contactObservations?.bookerName?.value],
        ['Booker contact', bookerContact, setBookerContact, contactObservations?.bookerContact?.value]] as const).map(([label, value, update, current]) =>
        <label key={label} className="flex min-w-0 flex-col gap-1 text-[11.5px] text-[#334155]">
          <span className="font-semibold">{label}</span>
          <span data-pii className={captionClass}>HMS: {current || 'Not shown'}</span>
          <input data-pii className={selectClass} value={value} onChange={(event) => {
            update(event.target.value);
            const detailNames: Record<string, string> = { 'Guest first name': 'firstName', 'Guest surname': 'lastName', 'Guest email': 'guestEmail', 'Booker name': 'bookerName', 'Booker contact': 'bookerContact' };
            const name = detailNames[label];
            if (name) {
              markDetail(name);
              durableDraft?.record(name as 'firstName' | 'lastName' | 'guestEmail' | 'bookerName' | 'bookerContact', event.target.value,
                event.target.value.length <= 1000 && !/[\p{Cc}]/u.test(event.target.value));
            }
          }} />
        </label>)}
      </div>
    </details>
    {!firstName.trim() || !lastName.trim() ? <p className={warnNoteClass}>Enter guest first name and surname under More.</p> : null}
    {!/^[A-Z0-9]{1,12}$/.test(ratePlan) || !/^[A-Z0-9]{1,12}$/.test(roomType) ? <p className={warnNoteClass}>Choose a room type and enter a rate code (letters and numbers).</p> : null}
    {cmsNeedsChoice ? <label className="flex flex-col gap-1 text-[11.5px] text-[#334155]">
      <span>Send HMS confirmation?</span>
      <select className={selectClass} value="" onChange={(event) => {
        if (!event.target.value) return;
        const send = event.target.value === 'yes'; setCmsSend(send); setCmsNeedsChoice(false);
        setCmsTouched(true); setCmsEdited(true); durableDraft?.record('cms.send', send);
      }}><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select>
    </label> : <label className="flex items-center gap-2 text-[11.5px] text-[#334155]">
      <input type="checkbox" checked={cmsSend} disabled={labtest} onChange={(event) => {
        setCmsSend(event.target.checked); setCmsTouched(true); setCmsEdited(true); durableDraft?.record('cms.send', event.target.checked);
      }} />
      Send HMS confirmation
    </label>}
    {cmsSend && !cmsNeedsChoice ? <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-[11.5px] text-[#334155]">
        <span className="font-semibold">CMS message ID</span>
        <input className={selectClass} maxLength={8} value={cmsMessageId} disabled={labtest} onChange={(event) => {
          setCmsMessageId(event.target.value); setCmsTouched(true); setCmsEdited(true); durableDraft?.record('cms.messageId', event.target.value);
        }} />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-[#334155]">
        <span className="font-semibold">Send confirmation to</span>
        <select className={selectClass} value={(sources?.invalidSetting || sources?.load === 'failed') && !recipientTouched ? '' : recipientMode}
          onChange={(event) => { const mode = event.target.value as ConfirmationMode;
            setRecipientMode(mode); setRecipientTouched(true); setCmsTouched(true); setCmsEdited(true); recordRecipient(mode, customRecipient); }}>
          {(sources?.invalidSetting || sources?.load === 'failed') && !recipientTouched ? <option value="">Choose recipient</option> : null}
          <option value="self">Me</option><option value="client">Client</option><option value="custom">Other</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-[#334155]">
        <span className="font-semibold">Confirmation recipient</span>
        <input data-pii type="email" maxLength={255} className={selectClass} value={recipientMode === 'custom' ? customRecipient : cmsRecipient}
          onChange={(event) => { setRecipientMode('custom'); setCustomRecipient(event.target.value); setRecipientTouched(true);
            setCmsTouched(true); setCmsEdited(true); recordRecipient('custom', event.target.value); }} />
      </label>
      <p className={captionClass}>HMS sends this confirmation.</p>
    </div> : null}
    {!validRecipient ? <p className={warnNoteClass}>{cmsNeedsChoice ? 'Choose whether to send an HMS confirmation.'
      : recipientLoading ? 'Loading confirmation preference…' : !recipient.ok ? recipient.message : 'Enter a confirmation message ID.'}</p> : null}
    {labtest ? <p className={infoNoteClass}>HMS confirmation is off for Labtest.</p> : null}
    {durableDraft?.error ? <p role="status" className={warnNoteClass}>{durableDraft.error}{' '}
      {durableDraft.retryable ? <button type="button" className="font-semibold underline" onClick={durableDraft.retry}>Retry save</button> : null}
    </p> : null}
    <p className={infoNoteClass}>{requestKey && boundKey === requestKey
      ? 'Review the HMS price and change below before Go.'
      : requestKey && availableKey === requestKey
        ? 'Prepare the change to see the HMS price.'
        : 'Enter the requested change and confirmation details.'}</p>
    {request && requestKey && writeContext ? <CloudAmendAction key={requestKey} request={request}
      guestSurname={stay.lastName || ''} transportId={writeContext.transportId} trpc={writeContext.trpc}
      flushDraft={durableDraft?.flush} draftBinding={durableDraft?.binding}
      onApprovalVisibilityChange={onApprovalVisibilityChange}
      onAvailable={() => setAvailableKey(requestKey)} onBound={() => setBoundKey(requestKey)} /> : null}
  </div>;
}

/** Hidden unless the server advertises the complete, explicitly enabled writer. */
function CloudAmendAction({ request, transportId, trpc, onAvailable, onBound, guestSurname, flushDraft, draftBinding, onApprovalVisibilityChange }: {
  request: CloudAmendRequest; transportId: string; trpc: unknown; onAvailable: () => void; onBound: () => void; guestSurname: string;
  flushDraft?: () => Promise<boolean>;
  draftBinding?: () => CloudAmendRequest['draft'] | null;
  onApprovalVisibilityChange: (visible: boolean) => void;
}) {
  const [client, setClient] = useState<CloudAmendClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [bound, setBound] = useState(false);
  const [failed, setFailed] = useState(false);
  const liveRef = useRef(false);
  useEffect(() => {
    onApprovalVisibilityChange(bound && client !== null);
    return () => onApprovalVisibilityChange(false);
  }, [bound, client, onApprovalVisibilityChange]);
  // The component is keyed by the exact source, booking and choices.
  const [selected] = useState(request);
  useEffect(() => {
    const controller = new AbortController();
    liveRef.current = true;
    let live = true, owned: CloudAmendClient | null = null;
    void cloudAmendClientFromTrpc(trpc, selected, { transportId, signal: controller.signal, isCurrent: () => live })
      .then((result) => {
        if (!live) { result?.dispose(); return; }
        owned = result;
        setClient(result);
        if (result) onAvailable();
      });
    return () => { live = false; liveRef.current = false; controller.abort(); owned?.dispose(); };
  }, [trpc, selected, transportId]);
  if (!client) return null;
  return <>
    {!bound ? <button type="button" className={buttonClass} disabled={busy} onClick={() => {
      setBusy(true); setFailed(false);
      void (async () => {
        if (flushDraft && !(await flushDraft())) return;
        if (!liveRef.current) return;
        const draft = draftBinding?.();
        if (draftBinding && !draft) return;
        const ok = await client.prepare(draft ?? undefined);
        if (liveRef.current) { if (ok) { setBound(true); onBound(); } else setFailed(true); }
      })()
        .finally(() => { if (liveRef.current) setBusy(false); });
    }}>{busy ? 'Checking the booking…' : 'Review change for approval'}</button> : null}
    {failed ? <p role="alert" className={warnNoteClass}>Nava could not prepare this change. Check it in HMS.</p> : null}
    {bound ? <ApproveCard client={client.approval} workItemId={selected.workItemId} confirmation={selected.confirmation}
      arrival={selected.arrival} guestSurname={guestSurname} writesEnabled manualResolve={false} /> : null}
  </>;
}

/** Restore a previous run without creating another HMS preview or approval. */
function CloudAmendHistory({ trpc, transportId, selection, suspended }: {
  trpc: unknown; transportId: string; selection: CloudAmendSelection; suspended: boolean;
}) {
  const [client, setClient] = useState<CloudAmendClient | null>(null);
  const [selected] = useState(selection);
  useEffect(() => {
    const controller = new AbortController();
    let live = true, owned: CloudAmendClient | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined, attempts = 0;
    setClient(null);
    const poll = async () => {
      const result = await cloudAmendClientFromTrpc(trpc, selected, {
        transportId, signal: controller.signal, isCurrent: () => live, resume: true,
      });
      if (!live) { result?.dispose(); return; }
      if (result) {
        if (!owned || owned.resumeKey !== result.resumeKey) {
          owned?.dispose();
          owned = result;
          setClient(result);
        } else result.dispose();
      }
      attempts += 1;
      // A delayed retry may replace an older stopped run after the draft changes.
      timer = setTimeout(poll, attempts <= 3 ? HMS_WRITE_POLL_MS : HMS_WRITE_IDLE_POLL_MS);
    };
    if (!suspended) void poll();
    return () => { live = false; clearTimeout(timer); controller.abort(); owned?.dispose(); };
  }, [trpc, selected, transportId, suspended]);
  return !suspended && client ? <ApproveCard key={client.resumeKey} client={client.approval} workItemId={selected.workItemId} confirmation={null}
    writesEnabled manualResolve={false} allowApprove={false} /> : null;
}


function AmendSection({
  view,
  canPreview,
  offNote,
  rows,
  values,
  current,
  client,
  onChange,
  onPreview,
  onCommit,
}: {
  view: AmendView | null;
  canPreview: boolean;
  offNote: string;
  rows: ReturnType<typeof changedAmendRows>;
  values: AmendFormValues;
  current: Record<string, string | number | null>;
  client: AmendStayClient | null;
  onChange: (field: AmendFormField, value: string | number) => void;
  onPreview: () => void;
  onCommit: () => void;
}) {
  const currentView: AmendView = view ?? { kind: 'idle', note: null };
  const changed = new Set(rows.map((row) => row.field));
  const busy = currentView.kind === 'previewing' || currentView.kind === 'committing';
  const shot = (run: { runId: string | null; screenshots: string[] }) => (
    <RunScreenshot
      load={client?.paneStayScreenshot ?? null}
      runId={run.runId}
      name={run.screenshots.at(-1) ?? null}
      label={AMEND_SAVE_COPY.seeScreenshot}
      alt="What Nava saw on the HMS amend screen"
    />
  );
  if (currentView.kind === 'done') {
    return (
      <div aria-live="polite" className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
        <p className={headingClass}>Change in HMS</p>
        <p className={infoNoteClass}>{currentView.text}</p>
        {shot(currentView.run)}
      </div>
    );
  }
  return (
    <div data-testid="amend-form" aria-live="polite" className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
      <p className={headingClass}>Change in HMS</p>
      <div className="grid grid-cols-[1fr_1fr] gap-x-2 gap-y-1.5">
        <p className={captionClass}>HMS now</p>
        <p className={captionClass}>Requested</p>
        {AMEND_FORM_FIELDS.map((field) => {
          const isChanged = changed.has(field);
          const from = current[field];
          const countField = field === 'adults' || field === 'children';
          return (
            <div
              key={field}
              data-testid={isChanged ? 'amend-diff-row' : undefined}
              data-field={field}
              className={`col-span-2 grid grid-cols-2 gap-2 rounded-xs px-1 py-1 ${isChanged ? 'bg-amber-50' : ''}`}
            >
              <p className={valueClass}>{`${AMEND_FIELD_LABEL[field]}: ${from == null || from === '' ? '—' : String(from)}`}</p>
              {field === 'roomType' ? (
                <select className={selectClass} disabled={busy} value={String(values[field] ?? '')} onChange={(event) => onChange(field, event.target.value)}>
                  {Object.entries(ROOM_TYPE_NAMES).map(([code, name]) => (
                    <option key={code} value={code}>{name}</option>
                  ))}
                </select>
              ) : (
                <input
                  className={selectClass}
                  disabled={busy}
                  type={countField ? 'number' : field === 'arrival' || field === 'departure' ? 'date' : 'text'}
                  min={field === 'adults' ? 1 : field === 'children' ? 0 : undefined}
                  max={countField ? 16 : undefined}
                  value={String(values[field] ?? '')}
                  onChange={(event) => onChange(field, countField ? Number(event.target.value) : event.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
      {currentView.kind === 'ready' || currentView.kind === 'committing' ? shot(currentView.run) : null}
      {canPreview ? (
        <button
          type="button"
          className={buttonClass}
          disabled={
            currentView.kind === 'ready' || currentView.kind === 'committing'
              ? currentView.kind === 'committing'
              : busy || rows.length === 0
          }
          onClick={currentView.kind === 'ready' || currentView.kind === 'committing' ? onCommit : onPreview}
        >
          {currentView.kind === 'ready' || currentView.kind === 'committing' ? AMEND_SAVE_COPY.commit : AMEND_SAVE_COPY.preview}
        </button>
      ) : offNote ? (
        <p data-pii className={infoNoteClass}>{offNote}</p>
      ) : null}
      {currentView.kind === 'previewing' ? <p className={infoNoteClass}>{AMEND_SAVE_COPY.previewing}</p> : null}
      {currentView.kind === 'committing' ? <p className={infoNoteClass}>{AMEND_SAVE_COPY.committing}</p> : null}
      {currentView.kind === 'idle' && currentView.note ? <p className={warnNoteClass}>{currentView.note}</p> : null}
    </div>
  );
}

function CloudCancelSection({
  view,
  canPreview,
  chargeEnabled,
  offNote,
  confirmation,
  arrival,
  requireNativePreview,
  guestName,
  client,
  trpc,
  transportId,
  selection,
  waitingForFind,
  isCurrent,
  onRestored,
  onPreview,
  onReason,
  cancellationNote,
  onNote,
  onCommit,
}: {
  view: CancelView | null;
  canPreview: boolean;
  chargeEnabled: boolean;
  offNote: string;
  confirmation: string;
  arrival: string | null;
  requireNativePreview: boolean;
  guestName: string;
  client: AmendCancelClient | null;
  trpc: unknown;
  transportId: string | null;
  selection: CancelWriteSelection | null;
  waitingForFind: boolean;
  isCurrent: () => boolean;
  onRestored: (view: CancelView | null) => void;
  onPreview: () => void;
  onReason: (reason: string) => void;
  cancellationNote: string;
  onNote: (note: string) => void;
  onCommit: () => void;
}) {
  const reasonId = useId();
  const noteId = useId();
  const selected = useRef(selection).current;
  const chargeClient = useMemo(() => cancelChargeClientFromTrpc(trpc, transportId, selected?.source,
    selected?.internetMessageId), [trpc, transportId, selected]);
  const currentSelection = useRef(isCurrent);
  const restored = useRef(onRestored);
  const currentView = useRef(view);
  const carriedView = useRef(view);
  const settledRun = useRef<string | null>(null);
  const revoked = useRef(false);
  currentSelection.current = isCurrent;
  restored.current = onRestored;
  currentView.current = view;
  const [readState, setReadState] = useState<'checking' | 'ready' | 'failed'>('checking');
  const queuedRunId = view?.kind === 'committing' && view.run.outcome === 'cancel_queued' ? view.run.runId : null;

  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    setReadState('checking');
    if (!selected || !transportId || revoked.current) {
      setReadState('failed');
      return;
    }
    const controller = new AbortController();
    const stateClient = cancelWriteStateClientFromTrpc(trpc, selected, {
      transportId, signal: controller.signal, isCurrent: () => live && currentSelection.current(),
      onInvalidated: () => {
        if (live) { revoked.current = true; setReadState('failed'); }
      },
    });
    if (!stateClient) {
      setReadState('failed');
      return () => { live = false; controller.abort(); };
    }
    let expectedRunId = queuedRunId ?? undefined;
    const poll = async () => {
      try {
        const state = await stateClient.read(expectedRunId);
        if (!live || !currentSelection.current()) return;
        if (state.kind === 'empty') {
          const current = currentView.current;
          if (carriedView.current?.kind === 'committing' && current?.kind === 'committing') {
            const unknown = { ...current.run, outcome: 'cancel_unconfirmed' as const };
            restored.current(viewAfterCommit(unknown, current.run, confirmation));
          } else if ((carriedView.current?.kind === 'ready' || carriedView.current?.kind === 'previewing') &&
              (current?.kind === 'ready' || current?.kind === 'previewing')) {
            restored.current(null);
          }
          carriedView.current = null;
          setReadState('ready');
          return;
        }
        carriedView.current = null;
        expectedRunId = state.runId;
        const current = currentView.current;
        const run: CancelRun = current?.kind === 'committing' && current.run.runId === state.runId
          ? current.run : { outcome: 'cancel_queued', statusBefore: null, statusAfter: null, reasons: [],
              penaltyText: null, screenshots: [], runId: state.runId, previewDigest: null };
        if (state.kind === 'running') {
          if (current?.kind !== 'committing' || current.run.outcome !== 'cancel_queued' || current.run.runId !== state.runId) {
            restored.current({ kind: 'committing', run, reason: '' });
          }
          setReadState('ready');
          timer = setTimeout(() => void poll(), 2_000);
          return;
        }
        setReadState('ready');
        if (settledRun.current === state.runId) return;
        settledRun.current = state.runId;
        const result = { ...run, outcome: state.outcome, ...(state.outcome === 'cancelled' ? { statusAfter: 'Cancelled' } : {}) };
        const done = viewAfterCommit(result, run, confirmation);
        if (done.kind === 'done') restored.current(done);
      } catch {
        if (live) setReadState('failed');
      }
    };
    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); stateClient.dispose(); controller.abort(); };
  }, [trpc, transportId, selected, queuedRunId, confirmation, waitingForFind]);

  const current: CancelView = view ?? { kind: 'idle', note: null };
  const runId = 'run' in current ? current.run?.runId : null;
  const chargePrompt = selected && chargeClient && runId ? <CancelChargePrompt client={chargeClient}
    target={{ workItemId: selected.workItemId, runId, confirmation: selected.confirmation, arrival: selected.arrival }}
    writesEnabled={chargeEnabled} /> : null;

  if (readState !== 'ready') {
    const note = readState === 'checking' ? 'Nava is checking the previous cancellation…'
      : !selection && canPreview ? 'Select the current email before previewing cancellation.'
        : !selection ? offNote : 'Nava could not check the previous cancellation. Check HMS before trying again.';
    return <div aria-live="polite" className="flex flex-col gap-2">
      <p className={headingClass}>Cancel in HMS</p>
      <p data-pii className={readState === 'failed' ? warnNoteClass : infoNoteClass}>{note}</p>
      {chargePrompt}
    </div>;
  }

  if (current.kind === 'done') {
    return (
      <div aria-live="polite" className="flex flex-col gap-2">
        <p className={headingClass}>Cancel in HMS</p>
        <p data-pii className={infoNoteClass}>{current.text}</p>
        <CancelScreenshot client={client} run={current.run} />
        {chargePrompt}
      </div>
    );
  }

  if (current.kind === 'committing' && current.run.outcome === 'cancel_queued') {
    return <div aria-live="polite" className="flex flex-col gap-2">
      <p className={headingClass}>Cancel in HMS</p>
      <p className={infoNoteClass}>{AMEND_CANCEL_COPY.committing}</p>
      {chargePrompt}
    </div>;
  }

  if (waitingForFind) return chargePrompt;

  if (current.kind === 'ready' || current.kind === 'committing') {
    const { run, reason } = current;
    const committing = current.kind === 'committing';
    const native = arrival ? nativeCancelPreview(run, { confirmation, arrival }) : null;
    if (requireNativePreview && !native) return <div aria-live="polite" className="flex flex-col gap-2">
      <p className={headingClass}>Cancel in HMS</p>
      <p className={warnNoteClass}>{CANCEL_PREVIEW_MISMATCH}</p>
    </div>;
    const reviewedGuest = native ? `${native.firstName} ${native.lastName}` : guestName;
    return (
      <div aria-live="polite" className="flex flex-col gap-2">
        <p className={headingClass}>Cancel in HMS</p>
        <p className={valueClass}>{`Status in HMS: ${run.statusBefore ?? 'not shown'}`}</p>
        {native ? <div data-testid="cancel-native-preview" data-pii className={valueClass}>
          <p>{`Confirmation: ${native.confirmation}`}</p>
          <p>{`Guest: ${native.firstName} ${native.lastName}`}</p>
          <p>{`Arrival: ${native.arrival}`}</p>
          <p>{`Departure: ${native.departure}`}</p>
          <p>{`Room: ${native.roomType}`}</p>
        </div> : null}
        {native?.guarantee ? <p className={valueClass}>Guarantee: {native.guarantee}</p> : null}
        {native?.depositReceived ? <p className={valueClass}>Deposit received: {native.depositReceived}</p> : null}
        {(run.policyFacts ?? []).map((fact) => <p key={fact} className={valueClass}>{fact}</p>)}
        <p className={run.penaltyText ? penaltyClass : captionClass}>{cancelFeeSentence(run.penaltyText)}</p>
        <CancelScreenshot client={client} run={run} />
        {chargePrompt}
        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className={headingClass}>
            {AMEND_CANCEL_COPY.reasonLabel}
          </label>
          <select
            id={reasonId}
            className={selectClass}
            value={reason}
            disabled={committing}
            onChange={(event) => onReason(event.target.value)}
          >
            <option value="">{AMEND_CANCEL_COPY.reasonPlaceholder}</option>
            {run.reasons.map((text) => (
              <option key={text} value={text}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={noteId} className={headingClass}>Cancellation note (optional)</label>
          <textarea id={noteId} data-pii className={selectClass} value={cancellationNote} maxLength={200}
            disabled={committing} onChange={(event) => onNote(event.target.value)} />
        </div>
        <p data-pii className={warnNoteClass}>
          {cancelConfirmLine({ confirmation, guest: reviewedGuest, penaltyText: run.penaltyText })}
        </p>
        {canPreview ? (
          <button
            type="button"
            className={buttonClass}
            disabled={!reason || committing}
            onClick={onCommit}
          >
            {AMEND_CANCEL_COPY.commit}
          </button>
        ) : (
          <p className={infoNoteClass}>{offNote}</p>
        )}
        {committing ? <p className={infoNoteClass}>{AMEND_CANCEL_COPY.committing}</p> : null}
        {current.kind === 'ready' && current.note ? <p className={warnNoteClass}>{current.note}</p> : null}
      </div>
    );
  }

  const previewing = current.kind === 'previewing';
  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      <p className={headingClass}>Cancel in HMS</p>
      {canPreview ? (
        <button
          type="button"
          className={buttonClass}
          disabled={previewing}
          onClick={onPreview}
        >
          {AMEND_CANCEL_COPY.preview}
        </button>
      ) : null}
      {canPreview ? (
        <>
          <p className={captionClass}>{AMEND_CANCEL_COPY.previewHint}</p>
        </>
      ) : (
        <p data-pii className={infoNoteClass}>
          {offNote}
        </p>
      )}
      {previewing ? <p className={infoNoteClass}>{AMEND_CANCEL_COPY.previewing}</p> : null}
      {current.kind === 'idle' && current.note ? <p data-pii className={warnNoteClass}>{current.note}</p> : null}
      {current.kind === 'idle' && current.run ? <CancelScreenshot client={client} run={current.run} /> : null}
      {chargePrompt}
    </div>
  );
}

function CancelSection({
  view,
  canPreview,
  offNote,
  confirmation,
  guestName,
  client,
  onPreview,
  onReason,
  onCommit,
}: {
  view: CancelView | null;
  canPreview: boolean;
  offNote: string;
  confirmation: string;
  guestName: string;
  client: AmendCancelClient | null;
  onPreview: () => void;
  onReason: (reason: string) => void;
  onCommit: () => void;
}) {
  const reasonId = useId();
  const current: CancelView = view ?? { kind: 'idle', note: null };

  if (current.kind === 'done') {
    return (
      <div aria-live="polite" className="flex flex-col gap-2">
        <p className={headingClass}>Cancel in HMS</p>
        <p className={infoNoteClass}>{current.text}</p>
        <CancelScreenshot client={client} run={current.run} />
      </div>
    );
  }

  if (current.kind === 'ready' || current.kind === 'committing') {
    const { run, reason } = current;
    const committing = current.kind === 'committing';
    return (
      <div aria-live="polite" className="flex flex-col gap-2">
        <p className={headingClass}>Cancel in HMS</p>
        <p className={valueClass}>{`Status in HMS: ${run.statusBefore ?? 'not shown'}`}</p>
        <p className={run.penaltyText ? penaltyClass : captionClass}>{cancelFeeSentence(run.penaltyText)}</p>
        <CancelScreenshot client={client} run={run} />
        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className={headingClass}>
            {AMEND_CANCEL_COPY.reasonLabel}
          </label>
          <select
            id={reasonId}
            className={selectClass}
            value={reason}
            disabled={committing}
            onChange={(event) => onReason(event.target.value)}
          >
            <option value="">{AMEND_CANCEL_COPY.reasonPlaceholder}</option>
            {run.reasons.map((text) => (
              <option key={text} value={text}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <p data-pii className={warnNoteClass}>
          {cancelConfirmLine({ confirmation, guest: guestName, penaltyText: run.penaltyText })}
        </p>
        {canPreview ? (
          <button
            type="button"
            className={buttonClass}
            disabled={!reason || committing}
            onClick={onCommit}
          >
            {AMEND_CANCEL_COPY.commit}
          </button>
        ) : (
          <p className={infoNoteClass}>{offNote}</p>
        )}
        {committing ? <p className={infoNoteClass}>{AMEND_CANCEL_COPY.committing}</p> : null}
        {current.kind === 'ready' && current.note ? <p className={warnNoteClass}>{current.note}</p> : null}
      </div>
    );
  }

  const previewing = current.kind === 'previewing';
  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      <p className={headingClass}>Cancel in HMS</p>
      {canPreview ? (
        <button
          type="button"
          className={buttonClass}
          disabled={previewing}
          onClick={onPreview}
        >
          {AMEND_CANCEL_COPY.preview}
        </button>
      ) : null}
      {canPreview ? (
        <>
          <p className={captionClass}>{AMEND_CANCEL_COPY.previewHint}</p>
        </>
      ) : (
        <p data-pii className={infoNoteClass}>
          {offNote}
        </p>
      )}
      {previewing ? <p className={infoNoteClass}>{AMEND_CANCEL_COPY.previewing}</p> : null}
      {current.kind === 'idle' && current.note ? <p className={warnNoteClass}>{current.note}</p> : null}
      {current.kind === 'idle' && current.run ? <CancelScreenshot client={client} run={current.run} /> : null}
    </div>
  );
}

function CancelScreenshot({ client, run }: { client: AmendCancelClient | null; run: CancelRun }) {
  return (
    <RunScreenshot
      load={client?.paneStayScreenshot ?? null}
      runId={run.runId}
      name={run.screenshots.at(-1) ?? null}
      label={AMEND_CANCEL_COPY.seeScreenshot}
      alt="What Nava saw on the HMS cancel screen"
    />
  );
}

/** One screenshot of a run as a thumbnail, with a full-size overlay. Renders nothing until the bytes load. */
function RunScreenshot({
  load,
  runId,
  name,
  label,
  alt,
}: {
  load: ((input: ScreenshotInput) => Promise<ScreenshotReply>) | null;
  runId: string | null;
  name: string | null;
  label: string;
  alt: string;
}) {
  const [image, setImage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setImage(null);
    if (!load || !runId || !name) return;
    let live = true;
    load({ runId, name })
      .then((reply) => {
        if (live && reply.status === 'ok') setImage(reply.dataUrl);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [load, name, runId]);

  if (!image) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 self-start text-left">
        <img src={image} alt="" className="h-16 w-auto rounded-xs border border-[#e2e8f0]" />
        <span className="text-[11.5px] font-medium text-[#0066cc]">{label}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
        >
          <img src={image} alt={alt} className="max-h-[85vh] max-w-full rounded-sm bg-white" />
          <button type="button" className={buttonClass} onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      ) : null}
    </>
  );
}
