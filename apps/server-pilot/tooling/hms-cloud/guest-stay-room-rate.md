# Guest Stay room and rate catalogs

These tools operate on the caller's authenticated, **unsaved HRCEN Guest Stay**.
Install the existing read-only guard and open a new stay first. Serialize all
operations on the page, including calls to other HMS modules. The tools verify
the HMS origin, HRCEN toolbar and blank confirmation before acting; they do not
save a stay. Unexpected dialogs are left untouched.

```js
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { openNewGuestStay } from './lookup.mjs';
import {
  searchRoomTypes, searchRatePlans, inspectRoomRateCandidate,
  selectRoomType, closeRoomRatePicker,
} from './guest-stay-room-rate.mjs';

await installReadOnlyGuard(page.context());
await openNewGuestStay(page);
const rooms = await searchRoomTypes(page, { query, limit: 20 });
// The caller inspects the candidates and explicitly supplies the chosen ID or code.
const details = await inspectRoomRateCandidate(page, { searchId: rooms.searchId, nativeId: chosenId });
const selection = await selectRoomType(page, { searchId: rooms.searchId, nativeId: chosenId });

const rates = await searchRatePlans(page, { query, limit: 20 });
const rateDetails = await inspectRoomRateCandidate(page, { searchId: rates.searchId, code: chosenCode });
await closeRoomRatePicker(page);
```

`query` is an optional case-insensitive substring of a loaded candidate's ID,
code or name. `offset` defaults to 0 and `limit` to 20 (maximum 100). Results
include an observation time, scope, server metadata, columns, loaded/total
coverage, and full available response and grid data for each returned candidate.
The response and grid are correlated by native ID, code and name where available;
other candidate fields are preserved without independent correlation.
Use `offset` or inspection for more detail. Rate Shop controls are included in
its catalog result. A `no_match` means no match in a verified complete catalog;
otherwise an empty partial catalog is `incomplete`.

Search leaves the picker open. A further search of that picker refines the same
observation and issues a new `searchId`; it does not refresh HMS data. Close the
picker and search again for a new observation. Inspection and selection require
the latest ID on the same page and check the property, form, picker controls and
loaded rows again. They reject changed or closed visible state; hidden identity changes and later
server changes are not detected. Even matching criteria and an unchanged picker
do not guarantee current inventory, prices or eligibility.

If loading fails after this module opens a picker, call `closeRoomRatePicker`
before retrying. Cleanup checks the recorded window and blank draft and refuses
unexpected dialogs; it never makes the incomplete catalog selectable.

Room selection requires a unique current candidate with both a native ID and a
code. A non-unique supplied identifier returns `ambiguous` on inspection and selection
refuses; a distinguishing ID/code pair can resolve it. The tool checks the selected row, fences both observed
field-change requests to the empty HRCEN reservation keys and chosen ID/code,
checks their responses, and reads back the form. `changedFields` includes visible
fields added, removed or changed. If it returns `selection_uncertain`, an action
may have occurred: inspect the draft before retrying. Closing a Rate Shop picker
explicitly discards its pending shopping selection and can send a session-cancel
request; it does not cancel a stay.
In one live blank draft, that request's session ID matched the two room-change
responses and the Rate Shop inquiry. The cancel guard does not independently
bind the ID, and isolation from other shopping sessions remains unverified.

The Rate Plans picker filters **Rate Shop**; selecting a catalog entry does not
itself set a rate on the stay. Rate-plan selection and transfer of a Hotel
Availability quote to the draft are not implemented by this module. Use Hotel
Availability for quotes, and treat picker entries as catalog facts only: they do
not prove availability, eligibility, a hold, a price or a total. Quote and draft
criteria can differ and must be checked independently. In one probe, Update Stay
sent shopping-session requests without changing the visible draft. Complete then
attempted an unverified `SUBMIT` request, which was blocked; its effect is unknown.

One live HRCEN observation loaded 9/9 room candidates and, after a room was
selected, 68/68 Rate Shop rate candidates. The latter initially loaded 50 and
required scrolling. One explicit room selection returned the native ID and code
in both HMS responses and changed one visible draft field. These are examples,
not guarantees for other dates or property configurations.

Candidate records, form fields, request/response captures and screenshots may be
sensitive. Keep them in approved private storage with mode 0600; do not print
them or put them in Git. Returned objects are intended for a trusted caller.
