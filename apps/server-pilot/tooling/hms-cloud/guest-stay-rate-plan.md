# Select a rate plan on a new Guest Stay

`selectGuestStayRatePlan(page, { code })` selects an explicit current rate code
on the caller's authenticated, **unsaved HRCEN Guest Stay**. Without a
`guestProfileId`, the visible and native guest-profile IDs must be uniquely
readable and blank. A nonblank guest must be the Proof Labtest fake profile,
selected through `selectGuestProfile` on this page; pass its current native ID
as `guestProfileId`.

An A/R account may already be selected through `selectArAccount` on this same
page. Its current account and profile IDs are taken from the verified draft,
not supplied by the caller. With A/R or a guest profile selected, the draft
must have the exact fake name and an arrival in 2027 or later. Selected identities
must have current proofs for the same native form and booking session. A new
search through the guest or A/R tool invalidates that selection's proof, even
if its old value remains visible; select it again before choosing the rate. Unverified
identities are `unsupported`. Other guarded profile, stay and reservation IDs
must be present and blank. Serialize page operations. Unexpected dialogs are
left untouched.

```js
import { selectGuestStayRatePlan } from './guest-stay-rate-plan.mjs';

const selected = await selectGuestStayRatePlan(page, { code: chosenRateCode });
// After selecting the fake guest on this page, including when A/R is selected:
// await selectGuestStayRatePlan(page, { code: chosenRateCode, guestProfileId: selectedProfile.nativeId });
```

The caller chooses the code. The tool opens a fresh Rate Shop catalog, requires
complete coverage and one exact code match, closes it, and verifies that the
inquiry and cancellation used the same new-draft booking session. It fences
the two observed native requests to the current code, property, draft dates and
names, the selected guest and A/R IDs, blank remaining identifiers, disabled
profile creation/link/save flags, `ONLY_DATA_REQUIRED` and that session. It checks both
responses and the visible and Ext field readback before reporting
`selected_unsaved`. A validated native **code** is returned; an independent
native rate-plan ID is not exposed. `identityReadback` includes the retained
guest ID and A/R account ID, profile ID and name when present. `changedFields`
includes dependent form changes. HMS can send case-variant non-identity fields;
the guard still requires each identity and safety key to be unique. These
results may contain sensitive data.

A previous visible rate may be replaced. `previousCode` and
`previousRateEvidence` say whether it was blank, selected by this tool on the
same page with the same form and native identity, or only observed on the draft. The live
replacement used a previous tool-selected rate; replacement of a rate set by
staff has not been independently demonstrated. A `selection_uncertain` result
means an action may have occurred; inspect the draft before retrying. If an
unsupported identifier is discovered in the native request after typing, the
request is blocked and `draftMayHaveChanged` is true.

After any uncertain attempted selection, the page refuses further rate
selections and other actions using the shared fence; use a fresh page after
inspecting the draft. A page-lifetime fence blocks later unapproved rate-change
requests while allowing unrelated operations.

Live observations use Proof Labtest and 2027 dates. One blank-profile selection
changed meal plan, market segment and track; a later rate replacement changed
meal plan. A/R-only and guest-plus-A/R selections retained their identities and
rates in the change responses and on the drafts. Other property, name and date
combinations have not been established by these examples. A/R and selected-guest
paths support only fake Labtest drafts; real-guest writes remain subject to
`PRODUCT.md`. The booking-session checks bind each action to its observed inquiry and cancellation;
isolation across every concurrent server session is not proved. The expected
toolbar image GET is blocked and reported. Keep captured form values and HMS
responses in approved private storage.

The tool does not save a stay, send mail, select Source of Business or submit
Rate Shop. Rate Shop catalog and selection are not availability, eligibility, a
hold or a quote. Use Hotel Availability with verified occupancy, including
children, for quote evidence; do not infer totals or taxes from this action.
