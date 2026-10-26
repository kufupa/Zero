import { Fragment } from 'react';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { isMultiStay, requestedQuoteKeys } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { BookingCards } from './booking-card';
import { reservationNoteForGroup } from './rate-controls';
import { guestEditorKeyFor, stayingGuestName } from './quote-people-step';

export function QuoteBookingHost({
  session,
  paneSave,
  contact,
  propertyCode,
}: {
  session: QuoteSession;
  paneSave?: PaneStayClient | null;
  contact?: StoredContact | null;
  propertyCode?: string | null;
}) {
  return (
    <>
      {requestedQuoteKeys(session.groups)
        .filter((key) => session.bookingDrafts[key])
        .map((key) => {
          const draft = session.bookingDrafts[key]!;
          const reservationNotePreviews: Record<string, string | null> = {};
          for (const room of draft.draft.rooms) {
            reservationNotePreviews[room.groupId] = reservationNoteForGroup(session, propertyCode, room.groupId);
          }
          return (
            <Fragment key={key}>
              {isMultiStay(session) ? (
                <p className="text-[13px] font-semibold text-[#475569]">Booking for {key.replace(':', ' → ')}</p>
              ) : null}
              <BookingCards
                draft={draft}
                groups={session.groups}
                paneSave={paneSave}
                contact={contact}
                parties={session.staffHeader.parties}
                guestName={stayingGuestName(session, contact ?? null)}
                guestEditorKey={guestEditorKeyFor(session)}
                reservationNotePreviews={reservationNotePreviews}
              />
            </Fragment>
          );
        })}
    </>
  );
}
