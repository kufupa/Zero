# Saved-stay agent session

`saved-stay-agent-session.mjs` owns one headless HRCEN page with the shared
read-only guard. It serializes calls, including concurrent programmatic calls.
Start the JSONL runner with `node saved-stay-agent-session.mjs --jsonl`; it
emits `ready`, one result per input line, and closes on `quit` or EOF. Each
result echoes the optional `id` and `tool`. Set a restrictive shell umask and
send stdout only to a private file or trusted caller; results and Notes can
contain guest data.

| Tool | Input |
| --- | --- |
| `read` | `confirmation`; optional `guestName`, `arrivalDate` (`YYYY-MM-DD`) and `view` (`record`, the default, or `shallow`) |
| `prepareCancellation` | Optional `requestedScope` (`whole_stay`, `specific_room`, or `unspecified`); uses the current full read |
| `prepareFinance` | Uses the current full read; returns only Record View and Folio-card balance/deposit displays, with ledger and payment clearance left unknown |
| `amendNote` | `expected` with `confirmation`, `guestId`, `arrival`, `departure`, `roomType`, `ratePlan`, `note` and `newNote` |
| `amendContact` | The same saved `expected` record without `newNote`, plus either legacy `field` (`bookerName` or `bookerContact`) and synthetic `value`, or synthetic `bookerName` and/or `bookerContact` (one exact Save for the supplied fields) |
| `openCancel` | The same `expected` record fields, without `newNote` |
| `confirmCancel` | `cancellationNote` for the current reason dialog |
| `quit` | Close the JSONL session |

For composition, call `withSavedStayAgentSession(async ({ runTool }) => { ... })`.
`read` returns the existing shallow reader output and, by default, Record View.
Errors retain available candidates, searched dates and result coverage. A
shallow-only read does not authorize a write. Multiple shallow lookups are
possible; after opening Record View, start a new session to read another stay.
A retry after an unverified single-candidate hint worked on one page. Retry
after a multi-candidate ambiguity has not been verified; start a fresh session.
A native dialog interrupts an in-progress read, seals the session, and is left
untouched; reopen in a fresh session.

After a full `read`, `prepareCancellation` returns a timestamped projection
for staff review. It keeps the requested scope separate from the room facts,
and does not open the cancellation workflow or commit a cancellation. The
projection uses the session's own copy of the read, so caller edits to the
returned read do not alter it. Read again in a new session when fresh facts are
needed. See [cancellation preflight](guest-stay-cancel-preflight.md).

After a full `read`, `prepareFinance` returns a timestamped, privacy-reduced
view of the Record View and Folio-card balance/deposit displays. Those surfaces
do not establish ledger balance, payment clearance, or transaction history.
This action does not post payment, retrieve/send a document, or alter HMS.

Writes require the currently read Reserved record and delegate to the Labtest
actions. The caller must identify the exact authorized Proof Labtest stay and
respect holds; a matching name alone is not authorization. The note and Booker
contact amendments verify HRCEN, 2027+ dates, the fake guest, current fields,
NGI, CMS Send unchecked, and blank CMS recipient and guest email. They may
preserve populated primary agency/company fields only when each saved-model
value and every present form/control value agree and the exact full-record Save
leaves them unchanged. Missing, ambiguous or changed links, plus nonblank
secondary-agency, group, A/R or guarantee-card fields, are refused. Cancellation
retains the stricter rule that all linked-party fields must be blank. The Labtest
note and Booker contact amendments and the Test Reservations cancellation flow
are supported. Single-field and paired Booker changes remain subject to the
full-form guard and fresh readback described in `guest-stay-amend-contact.md`.

After `openCancel` returns `reason_ready`, only `confirmCancel` or closing the
session is available. Outcomes such as `fee_dialog_pending`, `uncertain` and
`awaiting_readback` are returned unchanged. Never accept a fee or penalty
dialog; cancellation may already have taken effect. Start a fresh guarded
session to reconcile any attempted write, and never blindly retry an uncertain
dispatch. Browser send observations cannot establish server-side delivery.
