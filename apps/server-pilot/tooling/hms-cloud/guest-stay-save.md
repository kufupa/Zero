# Save a fake HRCEN Labtest stay

The writer refuses to dispatch unless its browser context blocks service workers
and has no active service workers. This protects request interception; it does
not by itself prove what HMS does server-side.

Real-guest writes go through the pane's staff Go (PRODUCT.md). The writer is
being generalized from its Labtest origin; check business fields, not whole
request bodies or key sets (AGENTS.md).

`searchLabtestPreimage` and `saveNewLabtestStay` operate on one caller-owned,
authenticated page. Install the shared read-only guard and serialize page
actions. Search before opening a new Guest Stay; a clear result provides a
single-use `preimageId` for that page, arrival and departure. A changed search,
write or five-minute expiry invalidates it. Existing same-name/arrival records,
incomplete results and stale proof do not authorize a save.
The search checks that the request's date offsets match the displayed range.
If the property's calendar date and UTC differ, it refuses the preimage rather
than guessing the offset anchor; retry when the dates agree.

The fake writer supports `NGI` and `GTDAGT` only. An agent-guarantee save
requires the current page's `selectGuestStayDropdown` result as
`guaranteeSelection`, including matching code, submitted value and display.
The current form and outgoing native body are checked again with full schema
proof. The agent-guarantee save itself has not yet been proved in HMS.

The legacy core-only save call remains available for existing callers. It does
not claim explicit occupancy or Source of Business coverage and cannot save a
linked agency or organization. For stricter create-field proof, pass any
combination of these selector results:

- `createFieldProof.adultSelection`: the result of selecting `adults` with
  `selectGuestStayDropdown`.
- `createFieldProof.childAgeSelection`: the result of
  `setGuestStayChildAges`, including an explicit empty array, one age, or
  multiple ages and native age-band counts.
- `createFieldProof.sourceSelection`: the result of selecting a current Source
  of Business candidate.
- `createFieldProof.cmsMessageSelection`: the optional current CMS picker result.
- `createFieldProof.reasonSelection`: the optional current reason-for-stay dropdown result.
- Top-level `agencySelection` and `organizationSelection`: results from the
  matching current party selectors. `arSelection` accepts the current A/R selector result.
  Parties can be supplied independently or together with occupancy/source selections.
  CMS and reason proofs require an adult, child or source proof on the same draft.

Adult, child, source, agency and organization proofs must carry the current Proof Labtest draft token. The A/R proof is independently bound to the current page and native account/profile identity. CMS is matched against its native control and the same verified draft.
The current agency picker may expose `iatanumber` and
`referencenumbertype`. Each value is usable only when the selected response and
grid row both contain that property and the values correlate; an absent or
uncorrelated property stays unproven and blocks selection. A correlated blank
is returned as explicit `null`, with `agencyReferenceEvidence` marking both
fields `response_grid_correlated`. The writer accepts that blank only when the
current draft and exact outgoing request also prove a blank;
nonblank values must match exactly. This does not assert a server-side IATA
requirement, and agencies whose picker omits either reference property are not
currently selectable through strict create proof. One guarded agency create
verified correlated blank reference values; a nonblank-reference agency save
remains unverified. Organization selection binds its returned native ID and
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
exact child age array, count and bands; source code and description; and optional CMS and reason values.
Strict proof snapshots the full native `record.getData()` key set and requires
the one outgoing form payload to match every expected value, alongside the
three fixed OSRESV/HDR controls. A read-only comparison found 985 unique
`record.getData()` keys, matching the 985 non-control keys in the captured
988-key save request; proof mode pins that observed field-key set. A later
unsaved HRCEN draft and blocked native request had the same fields plus
`confirmcheckinautoaddons` and `confirmratenotallowedforrestemplate`, both
blank. The native client sets them only after their respective confirmation
dialogs. Proof mode accepts the pair only when both are blank, and fails closed
for any other field-set change. This is a schema allowlist: complete model/body equality
alone would also accept a newly added field without establishing whether it
carries a create-side effect. Any field-set change therefore needs re-review
before proof mode is enabled. Raw `record.data` had 1,109 keys, including 123
extra metadata fields and `extId`.

The live Ext `form.getForm().getValues()` can reflect explicitly selected adult
and child counts/bands while `record.data` and `record.getData()` remain stale.
Strict proof starts with `record.getData()` and substitutes only selected
occupancy values plus the current reservation note, revenue and lifetime nights
values. With a verified agency selection, it also binds the two native agency
commission controls after their unique form, control and submit values agree.
It does not infer an agency commission value or substitute unrelated fields. The note must match the synthetic input and the visible control, Ext
value and submit data. Revenue must be read-only zero; its current native form
value must agree with the visible control, Ext value and submit data. The
read-only `Lifetime Nights` value must be nonnegative, match the model, and
agree across those same native surfaces. It describes the selected guest's
history, not this stay's duration. Exact arrival and departure values in both
the visible form and outgoing request define stay length (for example,
2027-12-11 through 2027-12-13 is two nights). Every request must still match
the full expected snapshot, including any blank confirmation flags; all other
values stay pinned to the model.

One strict full-body Proof Labtest create dispatched successfully with an agency,
organization, no A/R account, zero children and CMS message `03`; fresh saved
record and party readback matched. This does not prove other combinations.
Earlier, in a fresh 2027+ Proof Labtest draft, the intercepted 988-key POST matched the
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
does not explain the blocked request or by itself prove the strict current path
or zero/multiple-child payloads.
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
displayed name. Unselected party fields (group, secondary agency, contract, A/R and card) remain blank.
A selected A/R account must carry the matching current page-bound account/profile proof.
The draft and full outgoing payload must match that identity and account name.

The optional `billingReference` accepts explicit nonblank text only with a
verified A/R selection. It preserves whitespace and rejects control characters.
The writer installs its retained deny-unless-exact-save route chain unarmed
before filling the control. Only the billing control may change in the full
model, form snapshot and visible fields. The component, visible text and native
submit value must agree exactly; all other required fields remain mandatory.
The current fake-profile and A/R record proofs are checked again after staging
and before Save. A blocked request, stale proof, timeout, dialog or uncertain
staging quarantines the page; it must be discarded. The full outgoing model
still must match, including the exact billing value. A fresh saved-record
native-model and visible-field check is required before reporting `saved`.
This is separate from the draft-only Booker/billing adapter, whose permanent
page-lifetime no-POST fence remains unchanged. No billing-reference save has
been proven in live HMS.

The save also requires the current verified Proof Labtest profile, a new HRCEN
stay, dates in 2027 or later, an `NGI` or `GTDAGT` guarantee, no guarantee
card, CMS Send unchecked, and blank CMS recipient and guest email. A `GTDAGT`
save also requires the current verified `guaranteeSelection` described above.
The save action and core identity/party fields are exact-matched on the
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

Optional CMS codes and reason-for-stay selections are checked against the current native control and the exact outgoing request. The tool does not send; a browser fence cannot prove absence of server-side queued messages. A/R and CMS persistence require independent fresh readback.
