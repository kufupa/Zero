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
| `amendNote` | `expected` with `confirmation`, `guestId`, `arrival`, `departure`, `roomType`, `ratePlan`, `note` and `newNote` |
| `amendContact` | The same saved `expected` record without `newNote`, plus `field` (`bookerName` or `bookerContact`) and synthetic `value` |
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

Writes require the currently read Reserved record and delegate to the Labtest
actions. The caller must identify the exact authorized Proof Labtest stay and
respect holds; a matching name alone is not authorization. The underlying
actions verify HRCEN, 2027+ dates, the fake guest, current fields, NGI, CMS Send
unchecked, blank CMS recipient and guest email, and blank agency, organization,
group, A/R and guarantee-card fields. Missing or unverified linked fields are
refused. The Labtest note and Booker contact amendments and the Test
Reservations cancellation flow are supported. Booker contact changes remain
subject to the full-form guard and fresh readback described in
`guest-stay-amend-contact.md`.

After `openCancel` returns `reason_ready`, only `confirmCancel` or closing the
session is available. Outcomes such as `fee_dialog_pending`, `uncertain` and
`awaiting_readback` are returned unchanged. Never accept a fee or penalty
dialog; cancellation may already have taken effect. Start a fresh guarded
session to reconcile any attempted write, and never blindly retry an uncertain
dispatch. Browser send observations cannot establish server-side delivery.
