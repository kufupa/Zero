import { Fragment, useLayoutEffect, useRef } from 'react';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { caseReviewPending, isMultiStay, requestedQuoteKeys, stayIdOf } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { appliedSavedStayIds, BookingCards, SavedStayReceipt, type SavedStayCommit } from './booking-card';
import { saveConfirmationDefault, useConfirmationSources, type ConfirmationSetting } from './confirmation-recipient';
import { stayingGuestName } from './quote-people-step';

export function QuoteBookingHost({
  session,
  paneSave,
  contact,
  guestEditorKey,
  workItemId,
  savedStays,
  screenshot,
  propertyCode,
  onSaveDefault,
}: {
  session: QuoteSession;
  paneSave?: PaneStayClient | null;
  contact?: StoredContact | null;
  guestEditorKey?: string | null;
  workItemId?: string;
  savedStays?: Record<string, SavedStayCommit>;
  /** Reads a stored screenshot when Book writes are off. */
  screenshot?: PaneStayClient['screenshot'] | null;
  propertyCode?: string | null;
  onSaveDefault?: (setting: ConfirmationSetting) => Promise<void>;
}) {
  const confirmation = useConfirmationSources();
  // Keep the same mounted card during a temporary scope hold, but discard its local state on a new owner/message.
  const lastGuestKey = useRef(guestEditorKey ?? null);
  const mountedGuestKey = guestEditorKey || lastGuestKey.current;
  useLayoutEffect(() => { if (guestEditorKey) lastGuestKey.current = guestEditorKey; }, [guestEditorKey]);
  const requestKey = JSON.stringify([
    session.binding?.transportId,
    session.binding?.storeId,
    session.binding?.folderEntryId,
    session.binding?.entryId,
    session.binding?.selectionEpoch,
    session.binding?.scopeEpoch,
    workItemId,
    mountedGuestKey,
  ]);

  const shownDrafts = requestedQuoteKeys(session.groups).filter((key) => session.bookingDrafts[key]);
  const row = session.groups.length === 1 ? session.groups[0] : undefined;
  const sourceRow = session.analysis?.groups.length === 1 ? session.analysis.groups[0] : undefined;
  const onlyDraft = shownDrafts.length === 1 ? session.bookingDrafts[shownDrafts[0]!] : undefined;
  // The People guest is keyed to a message, not to a case or room. Never apply it across rooms or a held source.
  const singleRoomGuest = Boolean(guestEditorKey && workItemId && session.binding && session.staffSource && session.analysis &&
    !caseReviewPending(session.analysis) &&
    row && sourceRow && row.id === sourceRow.id && stayIdOf(row) === stayIdOf(sourceRow) && row.quantity === 1 &&
    onlyDraft?.messageId === session.staffSource.messageId && onlyDraft.selectionEpoch === session.binding.selectionEpoch &&
    onlyDraft.draft.rooms.length === 1 && onlyDraft.draft.rooms[0]?.groupId === row.id);
  const coveredStayIds = new Set(
    shownDrafts.flatMap((key) =>
      appliedSavedStayIds(session.bookingDrafts[key]!, session.groups, savedStays),
    ),
  );
  const uncoveredStays = Object.entries(savedStays ?? {}).filter(([stayId]) => !coveredStayIds.has(stayId));

  return (
    <>
      {(shownDrafts.length > 0 || uncoveredStays.length > 0) && !guestEditorKey ? (
        <p className="text-[13px] text-[#64748b]">Select a signed-in mailbox and email to review bookings.</p>
      ) : null}
      {shownDrafts.length > 0 && guestEditorKey && !singleRoomGuest ? (
        <p className="text-[13px] text-[#64748b]">Check each room’s guest name.</p>
      ) : null}
      <div hidden={!guestEditorKey}>
      {shownDrafts.map((key) => (
          <Fragment key={`${requestKey}:${key}`}>
            {isMultiStay(session) ? (
              <p className="text-[13px] font-semibold text-[#475569]">Booking for {key.replace(':', ' → ')}</p>
            ) : null}
            <BookingCards
              draft={session.bookingDrafts[key]!}
              groups={session.groups}
              paneSave={paneSave}
              contact={contact}
              workItemId={workItemId}
              savedStays={savedStays}
              screenshot={screenshot ?? paneSave?.screenshot}
              parties={session.staffHeader.parties}
              guestName={singleRoomGuest ? stayingGuestName(session, contact ?? null, guestEditorKey ?? undefined) : ''}
              guestEditorKey={singleRoomGuest ? guestEditorKey ?? undefined : undefined}
              session={session}
              propertyCode={propertyCode}
              confirmation={confirmation}
              onSaveDefault={onSaveDefault ?? saveConfirmationDefault}
            />
          </Fragment>
        ))}
      {uncoveredStays.map(([stayId, saved]) => (
        <SavedStayReceipt key={stayId} saved={saved} screenshot={screenshot ?? paneSave?.screenshot} />
      ))}
      </div>
    </>
  );
}
