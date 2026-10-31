# Save a fake HRCEN Labtest stay

`searchLabtestPreimage` and `saveNewLabtestStay` operate on one caller-owned,
authenticated page. Install the shared read-only guard and serialize page
actions. Search before opening a new Guest Stay; a clear result provides a
single-use `preimageId` for that page, arrival and departure. A changed search,
write or five-minute expiry invalidates it. Existing same-name/arrival records,
incomplete results and stale proof do not authorize a save.
The search checks that the request's date offsets match the displayed range.
If the property's calendar date and UTC differ, it refuses the preimage rather
than guessing the offset anchor; retry when the dates agree.

The legacy core-only save call remains available for existing callers. It does
not claim occupancy or Source of Business parity and cannot save a linked
agency. To opt into the stricter create-field proof, provide an explicitly
selected adult count, exactly one child age, the age-band counts returned by
`setGuestStayChildAges`, and a current Source of Business selection. The
current serialized save shape has only been proved for one child (`childages`
is a scalar); zero or multiple children are rejected in this proof mode until
their native payloads are separately observed. Source selection verifies the
current picker row and displayed description; the save binds both its native
code and description to the form model and request.

```js
import { searchLabtestPreimage } from './labtest-preimage.mjs';
import { setGuestStayChildAges, selectGuestStayDropdown } from './guest-stay-form.mjs';
import { searchGuestStaySourceBusiness, selectGuestStaySourceBusiness } from './guest-stay-source-business.mjs';
import { saveNewLabtestStay } from './guest-stay-save.mjs';

const census = await searchLabtestPreimage(page, { arrival, departure });
if (census.outcome !== 'clear') return census;
// Open a blank HRCEN stay, select the verified Proof Labtest profile, dates,
// room, rate, adults, child age, source, NGI guarantee and a synthetic note.
await selectGuestStayDropdown(page, { propertyCode: 'HRCEN', field: 'adults', value: 2 });
const childAgeSelection = await setGuestStayChildAges(page, { propertyCode: 'HRCEN', childAges: [8] });
const sourceSearch = await searchGuestStaySourceBusiness(page, { query: 'E-Mail' });
const sources = sourceSearch.candidates.filter((candidate) => candidate.description === 'E-Mail');
if (sources.length !== 1 || sourceSearch.coverage?.truncated !== false) throw new Error('SOURCE_NOT_UNIQUE');
const source = sources[0];
const sourceSelection = await selectGuestStaySourceBusiness(page, {
  searchId: sourceSearch.searchId, nativeCode: source.nativeCode,
});
const saved = await saveNewLabtestStay(page, {
  preimageId: census.preimageId, arrival, departure, guestId, roomType, ratePlan,
  guaranteeType: 'NGI', note,
  createFieldProof: { adults: 2, childAgeSelection, sourceSelection },
});
// Reopen in a fresh guarded session and reconcile against census.candidates.
```

The required selection results must come from the same page. The draft model
and save request must match the explicit adult count, single exact child age,
child count/bands, source code and description. In proof mode, the save route
snapshots the full native `record.getData()` projection and compares it to the
outgoing form payload: key set, uniqueness and every serialized value must
match, alongside the three fixed OSRESV/HDR request controls. A read-only
comparison found 985 unique `record.getData()` keys, matching the 985
non-control keys in the captured 988-key save request; proof mode pins that
observed field-key set and fails closed if it changes. Raw `record.data` had
1,109 keys, including 123 extra metadata fields and `extId`. Missing, extra,
duplicate or unrepresentable fields fail closed. This compares all submitted
party/card/profile fields and catches collateral changes beyond the explicit
proof fields. The key-shape comparison was read-only; the strict full-value
route matcher has not yet been exercised with an outgoing save request. The
selected source's native code is checked in its current model and outgoing
request, but its persisted native-code readback is
not supported; the independent saved-record reader currently exposes only the
description and child count/bands, not exact child ages.

In proof mode, an optional `agencySelection` may be the direct result of a
current, search-ID-bound `selectPrimaryBookingAgency` call. It must include
the selector's response evidence and nonblank `agencyIataNumber`; the draft
and request must match its native ID, display name and auto-populated IATA
number. All organization/company, group, secondary-agency, contract, A/R and
card fields remain blank. Organization selection is not enabled for this save
path until an explicit synthetic identity is unambiguous.

The save also requires the current verified Proof Labtest profile, a new HRCEN
stay, dates in 2027 or later, the Non-Guaranteed Individual (`NGI`) guarantee,
no A/R or guarantee card, CMS Send unchecked, and blank CMS recipient and guest
email. The save action and core identity/party fields are exact-matched on the
legacy path; create-field proof mode also exact-matches occupancy, source and
the full serialized model. One request may pass its page route; the context
read guard remains installed. The page then blocks other non-read requests and
cannot be used for another write. An existing page quarantine blocks saving.
The whole action has a deadline; unexpected native dialogs remain untouched
and disarm the action. `saved_same_form` is only a same-form observation:
independently look up the confirmation and record. An `uncertain` outcome may
have written; reconcile before any further action and do not blindly retry.

The new create-field proof is explicitly opt-in under `createFieldProof`; the
former core-only input shape is preserved and continues to use its existing
guard. `agencySelection` without `createFieldProof` fails closed. The session
wrapper may adopt the stricter proof only when it can pass the current helper
results from that same page.

The census and readbacks can include private guest or reservation data. Keep
them in approved private storage, not logs or Git. The browser send-request
count covers only observed browser traffic; it does not prove what HMS may
have queued server-side. The census is a point-in-time observation, not a lock
against another session creating a matching stay afterward.
