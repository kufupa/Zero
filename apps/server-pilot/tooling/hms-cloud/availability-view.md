# Hotel Availability projection

`getAvailabilityView(snapshot, filters)` returns a bounded view of a caller-owned,
private snapshot from `searchHotelAvailability`. It does not open a browser,
read or write files, or change the snapshot. Keep both the snapshot and its
scoped view private; the view can contain property and price information.

```js
import { getAvailabilityView } from './availability-view.mjs';

const view = getAvailabilityView(snapshot, {
  roomTypes: [roomCode], // omit to include all room rows returned by HMS
  ratePlans: [rateCode], // omit to include all rate rows returned by HMS
  offset: 0,
  limit: 10,
  nightOffset: 0,
  nightLimit: 14,
});
```

`limit` is 1–50 rows; `nightLimit` is 1–31 dates. Follow the respective
`coverage.page.nextOffset` and `coverage.nights.nextOffset` to expand the view.
Categories and counts cover every matching row and returned date, even when
the current page shows fewer. Filters narrow returned rows, not the hotel
catalog. `unreturnedRequestedPairs` counts selected combinations absent from
the response; their availability is **unknown**. Catalog coverage and returned
row coverage are separate. `criteria_unavailable` remains a distinct outcome;
malformed snapshots throw instead of becoming an empty availability result.
`filtersOutsideSubmittedScope` identifies requested filter codes that were not
included in the saved search; null means that comparison is unavailable.

The view includes the observation time, requested and applied criteria,
submitted and catalog coverage, native property/room/rate identifiers and
metadata, and each night's inventory, price and complete native property,
room and rate cells. The criteria check compares property, dates, occupancy,
submitted room/rate codes, and requested party IDs against the applied request.
`partyContext` supports the observed `group`, `organization` and `bookingAgency`
native IDs. Unrequested party fields are individually unknown; their applied
IDs must be blank for the requested context to match. Omitted or empty context
means blank parties only when all three applied IDs are present and blank;
missing IDs remain unknown, and a mismatch is false. Otherwise unverified
party context makes positive stock **unknown**. Other
settings remain in the applied criteria. A mismatch, missing required evidence,
missing nightly cell, row outside submitted codes, or unconfirmed date alignment
also makes positive stock **unknown**. Duplicate property/room/rate identities
are reported in coverage and cannot be classified as positive stock. The saved
nightly grid does not establish checkout-day restrictions; coverage marks them
unknown.

The criteria view contains supported search settings, room-quantity fields and
the three party IDs. Other fields stay in the private snapshot; coverage reports
their count and positive stock remains unknown. Session IDs are omitted.

The `category` and `reasons` fields separate `zero_stock`, `negative_stock`,
`closed_or_restricted`, `conditional`, `unknown` and `positive_stock` signals.
They preserve multiple reasons: a zero-stock row may also be restricted.
`positive_stock` means the observed nightly counts are positive with no
detected blocking flags; it is not a guarantee of eligibility or bookability.
Conditional flags are retained without interpreting whether they apply.
Individual nightly categories are also provided.

`price.responseValue` retains the raw value. When the reader captured an
unambiguous, fully visible HMS grid cell for the same row, date, value and
currency, `displayedTextStatus` is `captured` and `displayedTextSource` is
`visible_hms_grid`. Offscreen, clipped, unmatched or duplicate cells remain
`unknown`. `coverage.displayedPrices` reports capture coverage, which is not
exhaustive. A native response string, if present, is kept as `responseText`
without claiming it appeared on screen. Currency and every native cell flag
remain available. No total, tax, eligibility, hold or combined-room availability
is calculated.
