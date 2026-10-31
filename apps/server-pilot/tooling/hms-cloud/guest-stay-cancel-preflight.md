# Prepare cancellation facts from an existing stay read

`projectCancellationPreflight` is a pure projection. It accepts the direct
`readShallow` (1A) and `readRecord` (1B) results; it does not use a page, make an
HMS request, open the cancellation form, or commit anything.

```js
import { readShallow, readRecord } from './hms-readers.mjs';
import { projectCancellationPreflight } from './guest-stay-cancel-preflight.mjs';

const shallow = await readShallow(page, confirmation, { guestName, arrivalDate });
const record = await readRecord(page, shallow.confirmation);
const preflight = projectCancellationPreflight({
  confirmation,
  requestedScope: 'whole_stay', // 'specific_room' or 'unspecified' are also supported
  shallow,
  record,
});
```

The projection verifies 1A success, complete search results, matching requested
confirmation and 1A header, then matching 1B confirmation and active Record View.
Any target or view failure returns `target_unverified` without stay facts. It
uses the 1A `details.cards` Stay and Associations cards (with
`visibleFormFields` as a duplicate check) and the 1B `details.fields`; it does
not copy `selectedRow`, notes, visible page text,
grids, or unrelated guest fields. The displayed facts include stay
status/dates/nights, guarantee type, rate plan, adult/child counts, and booking
agency/organization/group where rendered. Party values are displayed
associations only: they do not prove an association record, linked-stay
relationship, or complete party/room scope. Duplicate fields become
`ambiguous`; differing 1A/1B values become `conflict`. It never selects the
first value to resolve either case.

The result projects status, arrival/departure, nights, guarantee type, rate
plan, adult/child counts, displayed party associations, room/scheduled-room,
room type and displayed money. Money fields retain `observed`, `observed_zero`,
`blank`, `unavailable`, `ambiguous`, or `conflict` states; currency is a
separate field. A displayed amount is not a ledger, refund, or penalty proof.

`requestedScope` records caller intent only (`whole_stay`, `specific_room`, or
`unspecified`). Room assignments are separate evidence. This 1A/1B reader does
not prove a complete room or linked-stay list, so `roomScope.state` remains
`unresolved` and `complete` remains `false`, even when a displayed room exists.
Do not treat the projection as proof that the request covers exactly one room
or the whole stay.

1A/1B do not provide prospective policy or fee terms. The result therefore
keeps `policy.state: 'unknown'` and `fee.state: 'unknown_precommit'`; a zero
balance is not a zero cancellation fee. Historical cancellation fields are not
used as future terms. Do not open Cancel Reservation or call
`openLabtestCancellation` to obtain policy flags: that enters the cancellation
workflow. This tool only prepares information for human review; it exposes no
cancellation action or commit capability. Keep its result and all reader data
in the existing private guest-data handling path.
