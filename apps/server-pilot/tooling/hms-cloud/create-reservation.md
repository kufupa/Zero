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

Room and rate are native codes. Source of Business may be a native code or an
exact current description. Organization selection accepts a native ID or a
unique, complete exact-name search. When both ID and name are supplied, they
must match. Selection does not establish inventory, rate eligibility or a hold.

Before opening a session, the wrapper checks recognized request keys and object
shapes. Explicit unsupported fields and unrecognized nested fields appear in
`unsupportedFields`. Prepare can still stage other supported fields; commit
refuses the unsupported request before opening a session. Malformed types may take precedence
as `needs_input`; requested fields are never silently dropped. This
includes explicit null for an unsupported field or an optional field whose
clear is not supported. An omitted optional field is different. Agency, A/R,
Booker, CMS message or recipient, billing reference, price, track, market
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
exact ages. Organization ID is checked at selection and has separate saved
verification. Neither a visible label nor a selection proves persistence.

`mode: "commit"` requires complete supported inputs and selects the current
Proof Labtest profile. Caller-provided `approval.by` and `approval.at` are
optional legacy metadata, not authentication. Commit obtains a same-date
single-use preimage, checks the form and no-send state, takes private before
and after screenshots, dispatches at most one guarded save, then independently
reopens the record. An organization-only create also uses same-session-bound
organization readback. If no note is supplied, a unique synthetic marker helps
reconciliation. Screenshots use a private directory and private file modes.

Outcomes are `prepared`, `saved`, `refused`, `needs_input`, `unsupported`, or
`uncertain`. `applied` records observed draft values and `appliedVerification`
separates visible readback from selection-only child ages and organization ID.
A saved outcome requires matching fresh readback and organization proof when
applicable. A possible dispatch without confirmation remains uncertain and
returns fresh census and candidate readbacks. Never retry a possibly dispatched
save without reconciliation. Browser-side no-send observations cannot prove
what HMS may have queued server-side.

The current strict full-body create path has not yet been proven by a
dispatched create under that guard. See [guest-stay-save.md](./guest-stay-save.md)
for the existing fake-only request, preimage, no-send and proof limitations.
No part of this interface enables real-guest writes or replaces a future
authenticated staff approval boundary.
