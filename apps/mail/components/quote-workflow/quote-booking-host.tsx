import { Fragment } from 'react';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { isMultiStay, requestedQuoteKeys } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { BookingCards, type SavedStayCommit } from './booking-card';
import { guestEditorKeyFor, stayingGuestName } from './quote-people-step';

export function QuoteBookingHost({
  session,
  paneSave,
  contact,
  workItemId,
  savedStays,
  propertyCode,
}: {
  session: QuoteSession;
  paneSave?: PaneStayClient | null;
  contact?: StoredContact | null;
  workItemId?: string;
  savedStays?: Record<string, SavedStayCommit>;
  propertyCode?: string | null;
}) {
  const requestKey = JSON.stringify([
    session.binding?.transportId,
    session.binding?.storeId,
    session.binding?.folderEntryId,
    session.binding?.entryId,
    session.binding?.selectionEpoch,
    session.binding?.scopeEpoch,
    workItemId,
  ]);

  return (
    <>
      {requestedQuoteKeys(session.groups)
        .filter((key) => session.bookingDrafts[key])
        .map((key) => (
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
              parties={session.staffHeader.parties}
              guestName={stayingGuestName(session, contact ?? null)}
              guestEditorKey={guestEditorKeyFor(session)}
              session={session}
              propertyCode={propertyCode}
            />
          </Fragment>
        ))}
    </>
  );
}
