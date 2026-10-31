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
`visibleFormFields` as a duplicate check), the 1A Folio card for separate
observations, and the 1B `details.fields`; it does not copy `selectedRow`, notes,
visible page text, grids, or unrelated guest fields. The displayed facts include stay
status/dates/nights, guarantee type, rate plan, adult/child counts, and booking
agency/organization/group where rendered. Party values are displayed
associations only: they do not prove an association record, linked-stay
relationship, or complete party/room scope. Duplicate fields become
`ambiguous`; differing 1A/1B values become `conflict`. It never selects the
first value to resolve either case.

Only observed date/count formats are normalized: ISO dates or `DD-MMM-YYYY`
with an optional matching weekday and `HH:MM` compare by calendar date;
`N Nights` compares with numeric `N`; and the exact `N AdultsM Child(ren)`
summary compares adult and child counts separately. A well-formed but
different value remains a conflict; an unrecognized differing format remains
ambiguous. The shallow combined adult/child summary supplies a child count only
when no direct child field is rendered and that summary matches the strict
format.

One exact cancellation display is handled narrowly: a 1A Stay-card status of
`Cancelled` followed by a newline and seven digits is split only when the 1B
Record View separately reports status `Cancelled` and `cancelnumber` equals
those digits. The result exposes the 1B `cancelnumber` field directly as
`stay.cancellationNumber`; a matching pair lets `stay.status` be shown as
`Cancelled`. Either disagreement keeps status in conflict; a missing or
duplicate comparison field keeps status ambiguous. Other status decorations
are not normalized.

The result projects status and cancellation number, arrival/departure, nights,
guarantee type, rate plan, adult/child counts, displayed party associations,
room/scheduled-room, room type and displayed money. Money fields retain `observed`, `observed_zero`,
`blank`, `unavailable`, `ambiguous`, or `conflict` states; currency is a
separate field. A displayed amount is not a ledger, refund, or penalty proof.
The `R` amount prefix is compared with a bare numeric amount only when the
Record View exposes `ZAR`; otherwise that comparison remains ambiguous. Amounts
whose numeric display cannot be parsed in the supported format are not used to
manufacture a match or conflict.

The separately labeled `folio` observations come only from the 1A Folio card:
`foliobalance`, `depositreceived`, `depositamount`, and `depositduedate`. They
are not substituted for similarly named Stay-card or 1B Record View fields.
The displayed folio balance does not establish a ledger balance, a displayed
deposit received (including zero) does not establish cleared payment, and the
displayed deposit due date is not independently verified.

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
