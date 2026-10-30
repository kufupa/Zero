# Quantity-aware quote view

`getQuoteView(snapshot, { roomQuantity, ...filters })` adds a room-count check
to the bounded `getAvailabilityView` result. Supply a positive safe integer
`roomQuantity` for the number of rooms of this room type in the scenario. A
`roomQuantity` already in the snapshot's requested criteria is also accepted.
If both the option and recorded quantity are absent or null, the result reports
`ROOM_QUANTITY_UNKNOWN` and does not assume one room.

The possible aliases `roomCount` and `quantity` in requested criteria are
checked, but never used to infer `roomQuantity`; an alias alone leaves the
quantity unknown. Supplied aliases must be positive safe integers and all
supplied representations must agree. A null alias is invalid; an undefined
alias is treated as absent. Invalid values throw `ROOM_QUANTITY_INVALID`, and
conflicts, including those in older snapshots, throw `ROOM_QUANTITY_MISMATCH`.
The view filters must not contain `roomCount` or `quantity`; those throw
`ROOM_QUANTITY_IN_VIEW`. Pass `roomQuantity` directly as the documented option.

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

For an optional arithmetic sum, pass `includeNightlyValueSum: true` in the view
options. `nightlyValueSum` adds the native Hotel Availability values for one
option only when all nights and checked search criteria match, no criteria
fields are unprojected, rate rows are unique and within the submitted scope,
and every value has at most two decimal places in one known currency. It uses
exact decimal arithmetic; incomplete, unsupported or unverified inputs return
`unavailable`.
The room quantity is not multiplied. Price basis, quantity basis, taxes and the
official stay total remain unknown; restrictions and stock still need review.

## Live read on a shared page

`readQuote` composes the existing Hotel Availability reader with this view. It
saves the full snapshot to a new file in a private, caller-owned directory
outside Git worktrees and returns a bounded view. It accepts
`criteria_unavailable` as a separate result.
Supply `roomQuantity` at the top level or in `criteria`, and keep any
`roomCount` or `quantity` values at either level consistent with it. Invalid or
conflicting representations return `input_gap` with `ROOM_QUANTITY_INVALID` or
`ROOM_QUANTITY_MISMATCH` before the search. Supplying `roomQuantity`,
`roomCount` or `quantity` inside `view` returns `ROOM_QUANTITY_IN_VIEW`.
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
