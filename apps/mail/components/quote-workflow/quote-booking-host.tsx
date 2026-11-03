import { Fragment, useCallback, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { isMultiStay, requestedQuoteKeys } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { appliedSavedStayIds, BookingCards, SavedStayReceipt, type BatchDraftAggregation, type BatchDraftSnapshot, type SavedStayCommit } from './booking-card';
import { BatchBookingReview } from './batch-booking-review';
import { saveConfirmationDefault, useConfirmationSources, type ConfirmationSetting } from './confirmation-recipient';
import { guestEditorKeyFor, stayingGuestName } from './quote-people-step';

export type BookingBatchReview = Omit<NonNullable<ComponentProps<typeof BookingCards>['batchReview']>, 'aggregate'>;

/** Joins proposals only. Source, manifest, approval and execution are still server authority. */
function CoordinatedDrafts({ keys, review, enabled, allowSingleFallback, priorWriteUncertain, renderCard, onStart }: {
  keys: string[];
  review?: BookingBatchReview;
  enabled: boolean;
  allowSingleFallback: boolean;
  priorWriteUncertain: boolean;
  renderCard: (key: string, aggregate?: BatchDraftAggregation) => ReactNode;
  onStart: () => void;
}) {
  // The stable parent preserves card edits. Only a never-submitted group with
  // one remaining room and no prior single attempt may return to single mode.
  const wasCoordinated = useRef(false);
  const approvalStarted = useRef(false);
  if (enabled) wasCoordinated.current = true;
  const [snapshots, setSnapshots] = useState<Record<string, BatchDraftSnapshot>>({});
  const [locked, setLocked] = useState(false);
  const coordinated = enabled || (wasCoordinated.current &&
    (approvalStarted.current || locked || !allowSingleFallback));
  const update = useCallback((key: string, snapshot: BatchDraftSnapshot | null) => {
    setSnapshots((previous) => {
      if (snapshot === null) {
        if (!(key in previous)) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      }
      if (JSON.stringify(previous[key]) === JSON.stringify(snapshot)) return previous;
      return { ...previous, [key]: snapshot };
    });
  }, []);
  const parts = keys.map((key) => snapshots[key]);
  const inputs = parts.map((part) => part?.input);
  const first = inputs[0];
  const compatible = Boolean(first && inputs.every((input) => input && input.propertyCode === first.propertyCode &&
    JSON.stringify(input.source) === JSON.stringify(first.source)));
  const input = compatible && first ? { ...first, rooms: inputs.flatMap((item) => item?.rooms ?? []) } : null;
  const missing = [...new Set([
    ...parts.flatMap((part) => part?.missing ?? ['booking details']),
    ...(priorWriteUncertain ? ['a booking is still being checked'] : []),
    ...(parts.every(Boolean) && inputs.every(Boolean) && !compatible ? ['email source'] : []),
  ])];
  const revisionKey = JSON.stringify(keys.map((key) => [key, snapshots[key]?.revisionKey ?? null]));
  return <>
    {keys.map((key) => renderCard(key, wasCoordinated.current ? { key, locked, update, singleMode: !coordinated } : undefined))}
    {coordinated ? <BatchBookingReview client={review?.client} input={input} missing={missing} onLock={(value) => {
      if (value) { approvalStarted.current = true; onStart(); }
      setLocked(value);
    }} hideInclusion revisionKey={revisionKey} /> : null}
  </>;
}

export function QuoteBookingHost({
  session,
  paneSave,
  contact,
  workItemId,
  savedStays,
  screenshot,
  propertyCode,
  onSaveDefault,
  batchReview,
}: {
  session: QuoteSession;
  paneSave?: PaneStayClient | null;
  contact?: StoredContact | null;
  workItemId?: string;
  savedStays?: Record<string, SavedStayCommit>;
  /** Reads a stored screenshot when Book writes are off. */
  screenshot?: PaneStayClient['screenshot'] | null;
  propertyCode?: string | null;
  onSaveDefault?: (setting: ConfirmationSetting) => Promise<void>;
  /** Disconnected opt-in only; callers must separately authorize the client. */
  batchReview?: BookingBatchReview;
}) {
  const confirmation = useConfirmationSources();
  const requestKey = JSON.stringify([
    session.binding?.transportId,
    session.binding?.storeId,
    session.binding?.folderEntryId,
    session.binding?.entryId,
    session.binding?.selectionEpoch,
    session.binding?.scopeEpoch,
    workItemId,
  ]);

  // Outlook folders and selection epochs can change for the same work item; neither releases a Go hold.
  const batchWasEnabled = useRef(false);
  const sourceKey = session.binding?.transportId && session.staffSource?.messageId
    ? JSON.stringify([session.binding.transportId, session.staffSource.messageId]) : null;
  const [started, setStarted] = useState<Record<string, { arrival: string; keys: string[]; sourceKey: string | null }>>({});
  const active = workItemId ? started[workItemId] ?? null : null;
  // A different work item can still refer to the same message after a reread.
  // Missing identities are ambiguous, not evidence that the write is unrelated.
  const sourceStarted = Object.values(started).some((attempt) => !sourceKey || !attempt.sourceKey || attempt.sourceKey === sourceKey);
  const writeHeld = Boolean(active) || sourceStarted || (!workItemId && Object.keys(started).length > 0);
  if (batchReview) batchWasEnabled.current = true;
  // Losing the opt-in client must not expose the old single-room write controls.
  const effectiveBatchReview = batchReview ?? (batchWasEnabled.current ? { refs: {} } : undefined);
  const requestedKeys = requestedQuoteKeys(session.groups);
  const shownDrafts = requestedKeys.filter((key) => session.bookingDrafts[key]);
  const arrivals = new Map<string, string[]>();
  for (const key of requestedKeys) {
    const arrival = key.split(':', 1)[0] ?? 'unknown';
    arrivals.set(arrival, [...(arrivals.get(arrival) ?? []), key]);
  }
  // Keep the submitted group and result panel mounted when draft membership changes after Go.
  // Another source still needs the host's selection guard and durable server fence.
  if (active) arrivals.set(active.arrival, active.keys);
  const coveredStayIds = new Set(
    shownDrafts.flatMap((key) =>
      appliedSavedStayIds(session.bookingDrafts[key]!, session.groups, savedStays),
    ),
  );
  const uncoveredStays = Object.entries(savedStays ?? {}).filter(([stayId]) => !coveredStayIds.has(stayId));
  // A prior unknown result can belong to a hidden or no-longer-matching draft.
  // Keep it held if a refresh omits it; only server recovery may release the hold.
  // The server must still fence all source writes, including ones not yet loaded here.
  const unknownSeen = useRef<Record<string, true>>({});
  const singleAttempts = useRef<Record<string, true>>({});
  const [, updateSingleAttempt] = useState(0);
  const hasUnknownSavedStay = Object.values(savedStays ?? {}).some((saved) => saved.status === 'unknown' || !saved.confirmationNumber);
  if (hasUnknownSavedStay) {
    const keys = workItemId && sourceKey ? [`item:${workItemId}`, `source:${sourceKey}`] : ['*'];
    for (const key of keys) unknownSeen.current[key] = true;
  }
  // No client response alone proves settlement and independent readback. Keep
  // every observed single attempt held for this host lifetime, even after its
  // card unmounts. Only durable server recovery can safely release it.
  const singleAttemptHeld = Boolean(singleAttempts.current['*'] ||
    (workItemId && singleAttempts.current[`item:${workItemId}`]) ||
    (sourceKey && singleAttempts.current[`source:${sourceKey}`]) ||
    ((!workItemId || !sourceKey) && Object.keys(singleAttempts.current).length));
  const unknownHeld = Boolean(unknownSeen.current['*'] ||
    (workItemId && unknownSeen.current[`item:${workItemId}`]) ||
    (sourceKey && unknownSeen.current[`source:${sourceKey}`]) ||
    ((!workItemId || !sourceKey) && Object.keys(unknownSeen.current).length));
  const priorWriteUncertain = hasUnknownSavedStay || singleAttemptHeld || unknownHeld;

  const renderCard = (key: string, aggregate?: BatchDraftAggregation) => {
    const draft = session.bookingDrafts[key];
    if (!draft) return null;
    return <Fragment key={`${requestKey}:${key}`}>
      {isMultiStay(session) ? <p className="text-[13px] font-semibold text-[#475569]">Booking for {key.replace(':', ' → ')}</p> : null}
      <BookingCards draft={draft} groups={session.groups} paneSave={writeHeld || (effectiveBatchReview && priorWriteUncertain) ? null : paneSave} contact={contact} workItemId={workItemId}
        savedStays={savedStays} screenshot={screenshot ?? paneSave?.screenshot} parties={session.staffHeader.parties}
        guestName={stayingGuestName(session, contact ?? null)} guestEditorKey={guestEditorKeyFor(session)} session={session}
        propertyCode={propertyCode} confirmation={confirmation} onSaveDefault={onSaveDefault ?? saveConfirmationDefault}
        onSingleAttemptStart={() => {
          // Work-item IDs can change on reclassification. Retain both bindings;
          // missing identity holds the whole host rather than guessing an alias.
          const keys = workItemId && sourceKey ? [`item:${workItemId}`, `source:${sourceKey}`] : ['*'];
          if (keys.some((key) => !singleAttempts.current[key])) {
            for (const key of keys) singleAttempts.current[key] = true;
            updateSingleAttempt((value) => value + 1);
          }
        }}
        batchReview={effectiveBatchReview ? { ...effectiveBatchReview, ...(writeHeld ? { client: undefined } : {}), aggregate } : undefined} />
    </Fragment>;
  };

  return (
    <>
      {[...arrivals.entries()].map(([arrival, keys]) => <CoordinatedDrafts key={`${requestKey}:${arrival}`} keys={keys}
        enabled={Boolean(effectiveBatchReview && (keys.length > 1 || active?.arrival === arrival ||
          keys.some((key) => (session.bookingDrafts[key]?.draft.rooms.length ?? 0) > 1)))}
        allowSingleFallback={Boolean(workItemId && !writeHeld && !priorWriteUncertain && keys.length === 1 &&
          session.bookingDrafts[keys[0]!]?.draft.rooms.length === 1 && batchReview?.client &&
          ['lab', 'on'].includes(batchReview.client.mode() ?? ''))}
        priorWriteUncertain={priorWriteUncertain}
        review={effectiveBatchReview && writeHeld ? { ...effectiveBatchReview, client: undefined } : effectiveBatchReview}
        onStart={() => { if (workItemId) setStarted((previous) => ({ ...previous, [workItemId]: { arrival, keys: [...keys], sourceKey } })); }} renderCard={renderCard} />)}
      {uncoveredStays.map(([stayId, saved]) => (
        <SavedStayReceipt key={stayId} saved={saved} screenshot={screenshot ?? paneSave?.screenshot} />
      ))}
    </>
  );
}
