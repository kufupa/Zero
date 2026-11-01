# Save a fake HRCEN Labtest stay

Owner authorization applies to fake Labtest writes only. This standalone
interface does not authenticate staff approval and does not authorize writes
for real guests.

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
not claim explicit occupancy or Source of Business coverage and cannot save a
linked agency or organization. For stricter create-field proof, pass any
combination of these selector results; each option is independent:

- `createFieldProof.adultSelection`: the result of selecting `adults` with
  `selectGuestStayDropdown`.
- `createFieldProof.childAgeSelection`: the result of
  `setGuestStayChildAges`, including an explicit empty array, one age, or
  multiple ages and native age-band counts.
- `createFieldProof.sourceSelection`: the result of selecting a current Source
  of Business candidate.
- Top-level `agencySelection` and `organizationSelection`: results from the
  matching current party selectors. Either may be supplied alone or with any
  occupancy/source combination.

All supplied selections must carry the same current Proof Labtest draft token.
The current agency picker may expose `iatanumber` and
`referencenumbertype`. Each value is usable only when the selected response and
grid row both contain that property and the values correlate; an absent or
uncorrelated property stays unproven and blocks selection. A correlated blank
is returned as explicit `null`, with `agencyReferenceEvidence` marking both
fields `response_grid_correlated`. The writer accepts that blank only when the
current draft and exact outgoing request also prove a blank;
nonblank values must match exactly. This does not assert a server-side IATA
requirement, and agencies whose picker omits either reference property are not
currently selectable through strict create proof. No agency save has yet
proved either case. Organization selection binds its returned native ID and
displayed name. The writer checks the current `companyid` and `company` values,
and permits `companyname` only when blank or equal to that same organization.
It does not infer that selecting an agency requires a child or source. Do not
reuse selector results across pages or profile selections.

```js
import { searchLabtestPreimage } from './labtest-preimage.mjs';
import { setGuestStayChildAges, selectGuestStayDropdown } from './guest-stay-form.mjs';
import { searchGuestStaySourceBusiness, selectGuestStaySourceBusiness } from './guest-stay-source-business.mjs';
import { saveNewLabtestStay } from './guest-stay-save.mjs';

const census = await searchLabtestPreimage(page, { arrival, departure });
if (census.outcome !== 'clear') return census;
// Open a blank HRCEN stay, select the verified Proof Labtest profile, dates,
// room, rate, adults, child age, source, NGI guarantee and a synthetic note.
const adultSelection = await selectGuestStayDropdown(page, { propertyCode: 'HRCEN', field: 'adults', value: 2 });
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
  createFieldProof: { adultSelection, childAgeSelection, sourceSelection },
});
// Reopen in a fresh guarded session and reconcile against census.candidates.
```

The draft and save request must match every supplied selection: adult count;
exact child age array, count and bands; and/or source code and description.
Strict proof snapshots the full native `record.getData()` key set and requires
the one outgoing form payload to match every expected value, alongside the
three fixed OSRESV/HDR controls. A read-only comparison found 985 unique
`record.getData()` keys, matching the 985 non-control keys in the captured
988-key save request; proof mode pins that observed field-key set and fails
closed if it changes. This is a schema allowlist: complete model/body equality
alone would also accept a newly added field without establishing whether it
carries a create-side effect. Any field-set change therefore needs re-review
before proof mode is enabled. Raw `record.data` had 1,109 keys, including 123
extra metadata fields and `extId`.

The live Ext `form.getForm().getValues()` can reflect explicitly selected adult
and child counts/bands while `record.data` and `record.getData()` remain stale.
Strict proof starts with `record.getData()` and substitutes only selected
occupancy values plus the current reservation note, revenue and lifetime nights
values. The note must match the synthetic input and the visible control, Ext
value and submit data. Revenue must be read-only zero; its current native form
value must agree with the visible control, Ext value and submit data. The
read-only `Lifetime Nights` value must be nonnegative, match the model, and
agree across those same native surfaces. It describes the selected guest's
history, not this stay's duration. Exact arrival and departure values in both
the visible form and outgoing request define stay length (for example,
2027-12-11 through 2027-12-13 is two nights). Every request must still match
the full 985-key expected snapshot; all other values stay pinned to the model.

The current path has not yet been proven by a dispatched create request. In a
fresh 2027+ Proof Labtest draft, the intercepted 988-key POST matched the
selected two-night dates and every reported field check except the
`revenuevalue` comparison; the route refused it before network dispatch. The
diagnostic retained only a mismatch flag, not the request value, so it does
not establish whether that value was absent, duplicated, nonzero or simply a
different zero format. Strict proof accepts only a single decimal numeric
zero in the outgoing field when the read-only model and native form values
also prove zero; every other key and value remains exact. A historical
successful one-child POST carried selected adults, child count/band, age CSV
and source; its captured 988-key body had one `revenuevalue` serialized as `0`
and an exact two-night date pair. It predates this strict full-body guard and
does not explain the blocked request or prove the current path or
zero/multiple-child payloads.
The selected source's native code is checked in its current model and outgoing
request, but persisted native-code readback is unsupported; the independent
saved-record reader currently exposes only the description and child
count/bands, not exact child ages.

In strict proof mode, `agencySelection` may be the direct result of a current,
search-ID-bound `selectPrimaryBookingAgency` call from the same Proof Labtest
draft. Its token must match the other selections and current native profile
proof. It carries the selector's response/grid-correlated reference values
(possibly explicit `null`); the draft and request must match its native ID,
display name and auto-populated reference value. The picker reference type is
preserved as evidence but is not claimed to be a separate save field. A blank
is not inferred when the picker omits either property.
`organizationSelection` may likewise be the current, search-bound
`selectOrganization` result; the draft and request must match its native ID and
displayed name. Unselected party fields (group, secondary agency, contract,
A/R and card) remain blank.

The save also requires the current verified Proof Labtest profile, a new HRCEN
stay, dates in 2027 or later, the Non-Guaranteed Individual (`NGI`) guarantee,
no A/R or guarantee card, CMS Send unchecked, and blank CMS recipient and guest
email. The save action and core identity/party fields are exact-matched on the
legacy path; strict proof mode also exact-matches whichever occupancy, source
and party selections were supplied, plus the full serialized model. One exact request from the current main frame may
pass through the page fence and writer-local context guard. Every other
non-read request, plus send/email/mail paths, is blocked on every page in that
browser context. The deny routes remain until the context closes; the page
cannot be reused for another write. An existing page quarantine blocks
saving. The whole action has a deadline; unexpected native dialogs remain
untouched and disarm the action. A blocked request observed after dispatch
makes the outcome `uncertain`, even if the save response is 200 and the form
shows a confirmation. `saved_same_form` is only a same-form observation when
no post-dispatch request was blocked: independently look up the confirmation
and record. An `uncertain` outcome may have written; reconcile before any
further action and do not blindly retry.

The stricter proof remains opt-in; the original core-only input contract
remains valid under the writer-local context guard. Each supplied selector
result must be passed directly from the same page and current draft.

The census and readbacks can include private guest or reservation data. Keep
them in approved private storage, not logs or Git. The browser send-request
count covers only observed browser traffic; it does not prove what HMS may
have queued server-side. The census is a point-in-time observation, not a lock
against another session creating a matching stay afterward.
