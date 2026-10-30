# Select a rate plan on a new Guest Stay

`selectGuestStayRatePlan(page, { code })` selects an explicit current rate code
on the caller's authenticated, **unsaved HRCEN Guest Stay**. The visible and
native guest-profile IDs must be uniquely readable and blank. The native change
request must also have the observed guest, profile, stay and reservation IDs
present and blank; a nonblank or unverified ID is `unsupported`. Serialize
operations on the page. Unexpected dialogs are left untouched.

```js
import { selectGuestStayRatePlan } from './guest-stay-rate-plan.mjs';

const selected = await selectGuestStayRatePlan(page, { code: chosenRateCode });
```

The caller chooses the code. The tool opens a fresh Rate Shop catalog, requires
complete coverage and one exact code match, closes it, and verifies that the
inquiry and cancellation used the same blank-draft booking session. It fences
the two observed native requests to the current code, property, draft dates and
names, blank identifiers, disabled profile creation/link/save flags,
`ONLY_DATA_REQUIRED` and that session. It checks both
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

One live Proof Labtest observation on 2027 dates changed meal plan, market
segment and track; a later rate replacement changed meal plan. Other property,
name and date combinations have not been established by that example. The
booking-session checks bind each action to its observed inquiry and cancellation;
isolation across every concurrent server session is not proved. The expected
toolbar image GET is blocked and reported. Keep captured form values and HMS
responses in approved private storage.

The tool does not save a stay, send mail, select Source of Business or submit
Rate Shop. Rate Shop catalog and selection are not availability, eligibility, a
hold or a quote. Use Hotel Availability with verified occupancy, including
children, for quote evidence; do not infer totals or taxes from this action.
