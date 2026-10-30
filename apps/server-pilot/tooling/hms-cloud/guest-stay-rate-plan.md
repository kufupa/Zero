# Select a rate plan on a new Guest Stay

`selectGuestStayRatePlan(page, { code })` selects an explicit current rate code
on the caller's authenticated, **unsaved HRCEN Guest Stay**. Without a
`guestProfileId`, the visible and native guest-profile IDs must be uniquely
readable and blank. The only supported nonblank profile is an explicitly selected
Proof Labtest fake profile for arrival in 2027 or later. Select it through
`selectGuestProfile` on this page, then pass its current native ID as
`guestProfileId`. The guarded picker must have verified its exact names, native
response and form readback; both form IDs, the rate-change request and response
must match that ID. Other nonblank profiles are `unsupported`. All other
observed profile, stay and reservation IDs must be present and blank. Serialize
operations on the page. Unexpected dialogs are left untouched.

```js
import { selectGuestStayRatePlan } from './guest-stay-rate-plan.mjs';

const selected = await selectGuestStayRatePlan(page, { code: chosenRateCode });
// After selecting a profile on this page:
// await selectGuestStayRatePlan(page, { code: chosenRateCode, guestProfileId: selectedProfile.nativeId });
```

The caller chooses the code. The tool opens a fresh Rate Shop catalog, requires
complete coverage and one exact code match, closes it, and verifies that the
inquiry and cancellation used the same new-draft booking session. It fences
the two observed native requests to the current code, property, draft dates and
names, the explicit guest ID if supplied, blank remaining identifiers, disabled
profile creation/link/save flags, `ONLY_DATA_REQUIRED` and that session. It checks both
responses and the visible and Ext field readback before reporting
`selected_unsaved`. A validated native **code** is returned; an independent
native rate-plan ID is not exposed. `changedFields` includes dependent form
changes, which may contain sensitive data.

A previous visible rate may be replaced. `previousCode` and
`previousRateEvidence` say whether it was blank, selected by this tool on the
same page with the same visible form, or only observed on the draft. The live
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
meal plan. Other property, name and date combinations have not been established
by these examples. The selected-profile path is limited to the fake profile;
real-guest writes remain subject to the product's owner authorization rules. The
booking-session checks bind each action to its observed inquiry and cancellation;
isolation across every concurrent server session is not proved. The expected
toolbar image GET is blocked and reported. Keep captured form values and HMS
responses in approved private storage.

The tool does not save a stay, send mail, select Source of Business or submit
Rate Shop. Rate Shop catalog and selection are not availability, eligibility, a
hold or a quote. Use Hotel Availability with verified occupancy, including
children, for quote evidence; do not infer totals or taxes from this action.
