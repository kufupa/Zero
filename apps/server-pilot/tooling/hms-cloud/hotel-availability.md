# Cloud Hotel Availability

Use Hotel Availability for HRCEN quotes, as directed by the hotel. The screen
combines dated room inventory and rate information, and considers children's
ages. This is a read: it does not create or save a Guest Stay.

`searchHotelAvailability(page, criteria)` takes an authenticated Playwright
page from the Stay 360 bootstrap and leaves the page open on Hotel Availability
for subsequent searches. The caller owns the page. Required criteria are:

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

The search currently requires blank Group, Organization and Booking Agency
context. HMS has those controls, but this module does not yet select them. It
returns the other applied search settings, including restricted-sell options;
check them and the returned restriction details before using a result. A
missing room/rate combination is not automatically evidence of no availability
or eligibility. Rate cells have not been turned into a calculated stay total.

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
