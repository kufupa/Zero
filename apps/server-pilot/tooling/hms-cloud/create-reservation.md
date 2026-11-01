# Cloud create reservation

`create-reservation.mjs` prepares an HRCEN Guest Stay from private JSON and
can commit only a guarded Proof Labtest fake stay. The owner authorizes
Labtest writes, not real-guest writes. This standalone interface does not
authenticate a staff approval; caller-supplied approval fields are untrusted
metadata and do not grant authority. No live HMS run is implied by this change.

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
  "parties": { "organizationId": "41", "agencyName": "Example Agency", "agencyId": "99",
    "arAccountName": "Example Account", "arAccountId": "75" },
  "cms": { "send": false }
}
```

Codes are examples, not defaults, quotes or availability claims. Provide
`guest.profileId` or `guest.search` with `lastName` and optional `firstName`
and `email`. The current picker must verify an explicit profile ID; ambiguous
or incomplete name searches return candidates and coverage. `stay.childCount`,
when supplied, must agree with `childAges`. Absent or null ages mean unknown,
not zero; `[]` means known zero. Missing prepare inputs do not prevent other
supported fields from being staged.

Room and rate are native codes. Prepare accepts room codes up to 200 characters
and rate codes up to 100. Commit accepts only uppercase letters and digits, up
to 12 characters for either code. Source of Business may be a native code or an
exact current description. Selection does not establish inventory, rate
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

For the existing organization-only commit path, a native ID or a unique,
complete exact-name search is accepted. Its current behavior is unchanged.

Before opening a session, the wrapper checks recognized request keys and object
shapes. Explicit unsupported fields and unrecognized nested fields appear in
`unsupportedFields`. Prepare can still stage other supported fields; commit
refuses the unsupported request before opening a session. Malformed types may take precedence
as `needs_input`; requested fields are never silently dropped. This
includes explicit null for an unsupported field or an optional field whose
clear is not supported. An omitted optional field is different. Booker, CMS
message or recipient, billing reference, price, track, market
segment, guest opt-in and confirmation recipient are not staged here.
`cms.send: true` is unsupported. Explicit `cms.send: false` is checked against
the unsaved form as a no-send invariant. The suggested CMS message ID `03` is
not a requested or staged value.

A fully staged unsaved draft returns `prepared` with `approvalReady: false`.
This does not claim approval, a save, or persistence. NGI is staged only when
an eligible verified Proof Labtest profile and valid 2027+ dates are present.
Other drafts retain their staged fields but report `guaranteeType.staging` as
missing. Non-NGI guarantees remain unsupported. Exact child ages are checked
at selection, but fresh saved-record readback exposes age bands rather than
exact ages. Party IDs are checked at selection only on the unsaved draft. The
existing organization-only commit has separate saved verification. Neither a
visible label nor a selection proves persistence.

`mode: "commit"` requires complete supported inputs and selects the current
Proof Labtest profile. Agency and A/R requests, including their names or IDs,
remain unsupported in commit and are rejected before opening a session. The
existing save/readback guards cannot prove an agency-plus-organization create
or a nonblank A/R account. No guard is relaxed here. Caller-provided
`approval.by` and `approval.at` are
optional legacy metadata, not authentication. Commit obtains a same-date
single-use preimage, checks the form and no-send state, takes private before
and after screenshots, dispatches at most one guarded save, then independently
reopens the record. An organization-only create also uses same-session-bound
organization readback. If no note is supplied, a unique synthetic marker helps
reconciliation. Screenshots use a private directory and private file modes.

Outcomes are `prepared`, `saved`, `refused`, `needs_input`, `unsupported`, or
`uncertain`. `applied` records observed draft values and `appliedVerification`
separates visible readback from selection-only child ages and party IDs.
A saved outcome requires matching fresh readback and organization proof when
applicable. A possible dispatch without confirmation remains uncertain and
returns fresh census and candidate readbacks. Never retry a possibly dispatched
save without reconciliation. Browser-side no-send observations cannot prove
what HMS may have queued server-side.

The new prepare-mode party combinations have not yet been verified in live HMS.
The current strict full-body create path has not yet been proven by a
dispatched create under that guard. See [guest-stay-save.md](./guest-stay-save.md)
for the existing fake-only request, preimage, no-send and proof limitations.
No part of this interface enables real-guest writes or replaces a future
authenticated staff approval boundary.
