import { Fragment } from 'react';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { isMultiStay, requestedQuoteKeys } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { BookingCards } from './booking-card';

export function QuoteBookingHost({
  session,
  paneSave,
  contact,
}: {
  session: QuoteSession;
  paneSave?: PaneStayClient | null;
  contact?: StoredContact | null;
}) {
  return (
    <>
      {requestedQuoteKeys(session.groups)
        .filter((key) => session.bookingDrafts[key])
        .map((key) => (
          <Fragment key={key}>
            {isMultiStay(session) ? (
              <p className="text-[13px] font-semibold text-[#475569]">Booking for {key.replace(':', ' → ')}</p>
            ) : null}
            <BookingCards
              draft={session.bookingDrafts[key]!}
              groups={session.groups}
              paneSave={paneSave}
              contact={contact}
              parties={session.staffHeader.parties}
            />
          </Fragment>
        ))}
    </>
  );
}
