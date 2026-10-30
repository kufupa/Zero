# Cloud Hotel Availability

Use Hotel Availability for HRCEN quotes, as directed by the hotel. The screen
combines dated room inventory and rate information, and considers children's
ages. This is a read: it does not create or save a Guest Stay.

`searchHotelAvailability(page, criteria)` takes an authenticated Playwright
page and leaves Hotel Availability open for subsequent searches. It opens the
standalone screen from Stay 360, or the Hotel Availability iframe from a new,
unsaved Guest Stay. The caller owns the page and serializes actions. Required
criteria are:

- `propertyCode`: expected property, currently verified with `HRCEN`.
- `arrivalDate`, `departureDate`: calendar dates in `YYYY-MM-DD`.
- `adults`: explicit count; `childAges`: explicit array, empty for no children.
- `roomTypes`, `ratePlans`: arrays of exact HMS codes, or `"all"` to load the
  complete corresponding picker catalog.

An `"all"` search scrolls the picker to load more records and requires the
visible loaded and total counts to agree before submitting the codes. The
snapshot retains the full loaded catalogs and HMS response. It also records the
search time and applied criteria; the browser request is checked against the
requested property, dates, occupancy and codes. An incomplete catalog or failed
search is not a sold-out result.

When HMS explicitly says the selected criteria are unavailable for those dates,
the reader returns `criteria_unavailable`, records the response, and closes that
specific message so the same page can be searched again. This does not mean the
whole hotel is sold out. A malformed response without that message remains an
execution failure.

The Guest Stay's dates, occupancy and parties are not assumed to carry over to
the availability iframe. Set the quote criteria explicitly. Party context
defaults to blank; a nonblank field is rejected unless the caller selected it
in the current Hotel Availability picker and supplied its native ID in
`partyContext`. The request's Group, Organization and Booking Agency IDs are
checked along with property, dates, occupancy and room/rate codes.

```js
import {
  searchHotelAvailabilityParty, selectHotelAvailabilityParty,
  cancelHotelAvailabilityParty, searchHotelAvailability,
} from './hotel-availability.mjs';

const found = await searchHotelAvailabilityParty(page, {
  propertyCode: 'HRCEN', kind: 'organization', query: organizationName,
});
// Inspect candidates and choose one native ID from this current search.
const choice = await selectHotelAvailabilityParty(page, {
  kind: 'organization', nativeId: chosenId, searchId: found.searchId,
});
if (choice.outcome === 'selected') {
  const quote = await searchHotelAvailability(page, {
    ...criteria, partyContext: { organization: chosenId },
  });
}
```

Picker kinds are `organization`, `bookingAgency` and `group`; the matching
`partyContext` keys carry their native IDs. A group candidate must identify the
current property before it can be selected. Search returns full candidate
details, loaded/total coverage, and a `searchId`; another search invalidates
that token. Selection checks the current grid, reads back the field and returns
the other visible criteria and changes. `requestVerified: false` on selection
means the ID has not yet been verified in a search request; a successful
availability snapshot supplies that verification. `cancelHotelAvailabilityParty`
closes a current picker and invalidates its search without clearing a prior
selection. A stale token, ambiguous ID, unexpected dialog or unverified field is
not success.

HMS can change other settings when a party is selected. Check selection
`criteria.changedFields` and the snapshot's `appliedCriteria`, including
restricted-sell options, before using a result. In one live group example, the
sales strategy and restricted-sell setting changed along with the group; no
rate rows came back. That does not establish which change caused the result.
A missing room/rate combination is unknown, not automatically sold out or
ineligible. Priced cells can have zero inventory or be closed/restricted.
Preserve those separate facts; a rate cell is not a calculated stay total.

The full snapshot can be retained privately for later use.
`filterHotelAvailability(snapshot, { roomTypes, ratePlans })` creates a smaller
view without changing the snapshot; omit a filter to retain all its rows. The
view keeps the original details on returned rows, including inventory, prices
and restrictions. Neither function chooses a room or rate for the agent.

For a standalone run, pass a private output path and JSON on standard input:

```sh
printf '%s' '{"criteria":{"propertyCode":"HRCEN","arrivalDate":"2026-11-05","departureDate":"2026-11-07","adults":2,"childAges":[8],"roomTypes":"all","ratePlans":"all"},"view":{"roomTypes":["STQN"],"ratePlans":["BAR"]}}' |
  node apps/server-pilot/tooling/hms-cloud/read-hotel-availability-ui.mjs /private/directory/availability.json --json-stdin
```

The output directory must be private; the snapshot is created with mode 0600
and is never overwritten. With no `view`, stdout contains only a summary and
the snapshot path. With a `view`, stdout also contains the requested filtered
data, so it must be handled privately too.

In a live one-night read on 30 October 2026, `"all"` loaded 9 room types and
95 rate plans, and HMS returned 496 room/rate rows. This is one observation,
not a guarantee about other dates, occupancy, rates, or hotel configurations.
