# Quantity-aware quote view

`getQuoteView(snapshot, { roomQuantity, ...filters })` adds a room-count check
to the bounded `getAvailabilityView` result. Supply a positive integer for the
number of rooms of this room type in the scenario. A `roomQuantity` already in
the snapshot's requested criteria is also accepted; conflicting values fail.
If the quantity is unknown, the result reports `ROOM_QUANTITY_UNKNOWN` and does
not assume one room.

Each returned night includes the requested quantity, the difference between it
and the observed room count (`observedShortfall`, never below zero), and a
status. A verified shortfall is `shortfall`; `shortfall_unverified` still shows
the observed difference when other evidence is incomplete. Missing inventory
remains unknown. `count_sufficient` means only that the observed count is
large enough for that night. It does not establish rate eligibility, a hold,
combined availability across room types or a reservation. When later nights
have not been returned, the option-level status is `partial` only if all shown
nights are `count_sufficient`; an observed shortfall or unknown can take
precedence. Check `allNightsShown` and follow the night-page cursor before
using the whole stay.

Adult and child counts are per search scenario; guest names and room quantity
are separate inputs. Run separate searches for different dates or occupancies.
The underlying snapshot and quote view remain private. No total is inferred.

## Live read on a shared page

`readQuote` composes the existing Hotel Availability reader with this view. It
saves the full snapshot to a new file in a private, caller-owned directory
outside Git worktrees and returns a bounded view. It accepts
`criteria_unavailable` as a separate result.
The room quantity is recorded with the request; it is not sent as an HMS
inventory reservation or proof of joint availability.

```js
import { withBookingLookupSession } from './booking-lookup-session.mjs';
import { searchHotelAvailabilityParty, selectHotelAvailabilityParty } from './hotel-availability.mjs';
import { readQuote } from './quote-read.mjs';

await withBookingLookupSession(async ({ page }) => {
  const found = await searchHotelAvailabilityParty(page, {
    propertyCode: 'HRCEN', kind: 'organization', query: organizationName,
  });
  // Inspect the current candidates, then use the chosen native ID.
  const selected = await selectHotelAvailabilityParty(page, {
    kind: 'organization', searchId: found.searchId, nativeId: chosenId,
  });
  if (selected.outcome !== 'selected') return;
  const quote = await readQuote(page, {
    criteria: { ...criteria, partyContext: { organization: chosenId } },
    roomQuantity: 2,
    snapshotPath: '/private/directory/quote.json',
    view: { limit: 10 },
  });
  // Handle quote.view and quote.snapshotPath privately.
});
```

Run different date or occupancy scenarios as separate reads with separate file
paths. To expand a saved result, read the private snapshot and call
`getQuoteView` with the next page or night offset. If the quantity is absent,
the view reports the gap even when HMS shows positive stock.
