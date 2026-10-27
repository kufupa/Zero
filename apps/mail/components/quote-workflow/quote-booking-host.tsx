import { Fragment } from 'react';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { isMultiStay, requestedQuoteKeys } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { appliedSavedStayIds, BookingCards, SavedStayReceipt, type SavedStayCommit } from './booking-card';
import { saveConfirmationDefault, useConfirmationSources, type ConfirmationSetting } from './confirmation-recipient';
import { guestEditorKeyFor, stayingGuestName } from './quote-people-step';

export function QuoteBookingHost({
  session,
  paneSave,
  contact,
  workItemId,
  savedStays,
  screenshot,
  propertyCode,
  onSaveDefault,
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

  const shownDrafts = requestedQuoteKeys(session.groups).filter((key) => session.bookingDrafts[key]);
  const coveredStayIds = new Set(
    shownDrafts.flatMap((key) =>
      appliedSavedStayIds(session.bookingDrafts[key]!, session.groups, savedStays),
    ),
  );
  const uncoveredStays = Object.entries(savedStays ?? {}).filter(([stayId]) => !coveredStayIds.has(stayId));

  return (
    <>
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
              guestName={stayingGuestName(session, contact ?? null)}
              guestEditorKey={guestEditorKeyFor(session)}
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
    </>
  );
}
