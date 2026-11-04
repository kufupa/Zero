# Cloud create reservation

`create-reservation.mjs` prepares an HRCEN Guest Stay from private JSON and
can commit only a guarded Proof Labtest fake stay. This standalone interface
does not implement the owner's staff-approved real-guest booking authorization.
Caller-supplied approval fields are rejected and do not grant authority. See the
live proof and limitations below.

```sh
umask 077
node apps/server-pilot/tooling/hms-cloud/create-reservation.mjs < request.json > result.json
```

Node 22 is required. Keep inputs and outputs private: guest candidates, form
values and readback can contain personal data. The CLI reads one JSON object
from stdin and returns one JSON object. Programmatic callers can import
`createReservation`.

```json
{
  "mode": "prepare",
  "propertyCode": "HRCEN",
  "guest": { "search": { "lastName": "Example", "firstName": "Guest" } },
  "stay": { "arrival": "2027-03-15", "departure": "2027-03-17", "adults": 2, "childAges": [] },
  "room": { "roomType": "DLXKNG", "ratePlan": "BAR" },
  "guaranteeType": "NGI",
  "sourceOfBusiness": "E-Mail",
  "reasonForStay": "BUS",
  "parties": { "organizationId": "41", "agencyName": "Example Agency", "agencyId": "99",
    "arAccountName": "Example Account", "arAccountId": "75" },
  "cms": { "send": false }
}
```

Codes are examples, not defaults, quotes or availability claims. Provide
`guest.profileId` or `guest.search` with `lastName` and optional `firstName`
and `email`. The current picker must verify an explicit profile ID; ambiguous
or incomplete name searches return candidates and coverage. After a verified
empty name search and successful picker close, prepare may stage explicit first
and last name text only if the visible guest ID and both editable name fields
are uniquely present and blank. It rechecks those fields after each edit and
again on the final draft. A missing or hidden guest ID is not a verified blank.
`guestNameDraft` records text staging only: the guest remains unresolved,
`approvalReady` remains false, and the wrapper does not create or select a
profile. Profile persistence remains unverified. This path has only synthetic
wrapper coverage and requires live proof before native claims.
`stay.childCount`, when supplied, must agree with `childAges`. Absent or null ages mean unknown,
not zero; `[]` means known zero. Missing prepare inputs do not prevent other
supported fields from being staged.

Room and rate are native codes. Prepare accepts room codes up to 200 characters
and rate codes up to 100. Commit accepts only uppercase letters and digits, up
to 12 characters for either code. Source of Business may be a native code or an
exact current description. Optional `reasonForStay` is an explicit native dropdown code. Selection does not establish inventory, rate
eligibility or a hold.

In prepare mode, party selection always requires the caller's explicit native
ID. `agencyName` and `arAccountName` are search queries and are required even
when the corresponding ID is known, because those pickers only search names.
They can be partial queries; the ID must identify exactly one loaded current
candidate. Organization may search by `organizationId` alone; if both its ID
and `organizationName` are supplied, the name must match. Name-only searches
return candidates but never select one, even if there is only one result.

`partySearches` returns each search's candidates, criteria, coverage, columns,
metadata and correlation where provided. Candidate response or grid details
outside the correlation's verified fields are not independently verified.
Truncated or unknown coverage does not prove an absent ID is missing. An
explicit ID can be selected from a truncated result only when it occurs once in
the loaded grid. Selected IDs are bound to the same-session current search and
form-change response, and visible labels are checked again on the draft. Where
returned by the selector, selection evidence retains the A/R response's native
account fields and agency reference values with their correlation evidence.
These are selection-time observations, not saved-record readback. A missing or
ambiguous choice closes its picker without selecting and does not
prevent other parties from staging, provided cleanup is verified. A failed
search, uncertain selection or unverified cleanup stops further actions.
Search IDs expire when the wrapper closes its session. Return the chosen ID and
query in a new prepare request, which searches again before selecting. The
wrapper closes the browser after every call, so the draft does not persist
across requests. Selection is not a saved record.

For the organization commit path, a native ID or a unique, complete exact-name search is accepted. Agency and A/R require an explicit ID and a name query in both modes.

Before opening a session, the wrapper checks recognized request keys and object
shapes. Explicit unsupported fields and unrecognized nested fields appear in
`unsupportedFields`. Prepare can still stage other supported fields; commit
refuses the unsupported request before opening a session. Malformed types may take precedence
as `needs_input`; requested fields are never silently dropped. This
includes explicit null for an unsupported field or an optional field whose
clear is not supported. An omitted optional field is different. Booker, CMS recipient, price, track, market
segment, guest opt-in and confirmation recipient are not staged here.

`billingReference` is optional only for commit with an explicit A/R ID and name
query. It must be caller-supplied, nonblank text without control characters.
Whitespace is preserved and checked exactly; null, clear and prepare staging are
unsupported. No value is inferred. On one HRCEN draft, selecting an A/R account
made Billing Reference and Source of Business required. This observation does
not establish requirements for every account or property.
`cms.send: true` is unsupported. Explicit `cms.send: false` is checked against
the unsaved form as a no-send invariant. `cms.messageId` is optional and selected
from the current picker; `03` remains a suggestion, not a default or requirement.

A fully staged unsaved draft returns `prepared` with `approvalReady: false`.
When eligible, `requestBinding` contains a versioned canonical request and digest.
The digest helper accepts either its raw input or returned canonical request; it
is not authorization and does not prove equality to the native save body.
This does not claim approval, a save, or persistence. NGI and Guaranteed By
Agent (`GTDAGT`) are staged only with an eligible verified Proof Labtest profile
and valid 2027+ dates. Other drafts retain their staged fields but report
`guaranteeType.staging` as missing. Other guarantees remain unsupported; an
agent-guarantee save has not yet been proved in HMS. Exact child ages are checked
at selection, but fresh saved-record readback exposes age bands rather than
exact ages. Party IDs are checked at selection only on the unsaved draft. Selected party IDs require separate saved verification. Neither a
visible label nor a selection proves persistence.

`mode: "commit"` requires complete supported inputs and selects the current
Proof Labtest profile. Agency, organization and A/R selections are independent.
A/R additionally requires the current page-bound account/profile proof. The save
matches selected IDs, party names, the full native body, optional CMS code and reason for stay;
all card fields remain blank. Caller-provided `approval.by` and `approval.at`
are rejected rather than treated as authentication. Commit obtains a same-date
single-use preimage, takes private before and after screenshots, dispatches at
most one guarded save, then independently reopens the record. Party combinations
with agency or A/R require a fresh native ID and visible-name readback; a
missing or mismatched proof makes the outcome uncertain. With an explicit billing
reference, the writer stages it with the save route unarmed, then captures the
before screenshot after staging. Fresh readback requires exact native-model and
visible text. An uncertain create without confirmation cannot yet verify billing
or party identity through its census candidates. No implicit retry occurs.
For a verified Proof Labtest draft, prepare generates a unique synthetic note only when the note is omitted. Review the returned `applied.note` and pass that exact value to commit; a note-less Labtest commit is refused. An explicit null note is unsupported and is not replaced.

Outcomes are `prepared`, `saved`, `refused`, `needs_input`, `unsupported`, or
`uncertain`. `applied` records observed draft values and `appliedVerification`
separates visible readback from selection-only child ages and party IDs.
A saved outcome requires matching fresh readback and organization proof when
applicable. A possible dispatch without confirmation remains uncertain and
returns fresh census and candidate readbacks. Never retry a possibly dispatched
save without reconciliation. Browser-side no-send observations cannot prove
what HMS may have queued server-side.

One HRCEN Proof Labtest create dispatched through the strict full-body guard and
was independently read back with its selected agency and organization, blank
A/R account, and CMS message `03`. The CMS send box was unchecked, and no
browser send requests were observed; this does not establish server-side email
queue behavior. Saved A/R, billing reference, reason for stay, and other combinations remain
unverified. The new billing path has not been proven with a live save. See [guest-stay-save.md](./guest-stay-save.md) for the existing
request, preimage and readback contract. Real-guest writes happen only through
the pane's staff Go (PRODUCT.md).
