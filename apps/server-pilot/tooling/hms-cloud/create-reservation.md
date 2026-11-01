# Cloud create reservation

`create-reservation.mjs` prepares one HRCEN Guest Stay from JSON. A commit is
limited to a verified **Proof Labtest** profile with arrival in 2027 or later.
It uses the existing Cloud session, request fences, Labtest preimage and save
guard. It never sends mail or accepts a penalty dialog. Node 22 is required.

```sh
umask 077
node apps/server-pilot/tooling/hms-cloud/create-reservation.mjs < request.json > result.json
```

Keep input and output private: guest candidates, form values and readback can
contain personal data. The CLI reads one JSON object from stdin and writes one
JSON object to stdout. Programmatic callers can import `createReservation`.

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

The example codes are examples, not defaults or availability claims. Specify
either `guest.profileId` or `guest.search` (`lastName`, optional `firstName` and
`email`). Search choices must match exactly; ambiguous or incomplete name
searches return `guestCandidates` and coverage instead of choosing. Explicit
profile IDs are checked against the current picker. A caller may provide
`stay.childCount`, but it must agree with `childAges`. Use `childAges: []` only
when zero children is known; `null` or omitted ages produce `needs_input`.
Missing prepare inputs do not prevent other supported fields from being staged.

Room and rate are exact native codes. Source of Business may be a native code or
exact current description. `parties.organizationId` is supported alongside
`parties.organizationName`: the existing picker searches by name and verifies
the selected ID. A unique, complete exact-name search also accepts the name
alone. Returned source and organization candidates help resolve a failed match.
No draft selection establishes inventory, a quote, rate eligibility or a hold.

Box 1 sets guest, dates, adults, child ages, room, rate, source, reservation
`note`, and organization. It accepts `parties.agencyId`, `parties.arAccountId`,
`booker: { name, contact }`, `cms: { send, messageId, recipient }`,
`billingReference`, `price`, `track`, `marketSegment`, `guestoptin4` and
`confirmationRecipient`, but reports them as `not_settable_yet` warnings.
Unrecognized fields also produce warnings. Warnings do not prevent a Labtest
save. The tool suggests CMS message ID `03`; a caller may supply another value
or null, but box 1 does not set it. Prepare mode warns about a requested
guarantee; commit sets `NGI` and refuses other guarantees. Commit with
`cms.send: true` is `unsupported`.

The pane's first/last name map to `guest.search`, its date, occupancy, room and
rate fields to `stay` and `room`, its organization to `parties`, its note to
`note`, its Booker fields to `booker`, and CMS/recipient fields to `cms` or
`confirmationRecipient`. Other pane fields listed above remain warnings.

For `mode: "commit"`, supply `approval: { "by": "...", "at": "ISO timestamp" }`.
If `note` is omitted, a unique synthetic Proof Labtest marker is used to make
reconciliation possible. A commit first obtains the existing same-date Labtest
preimage, verifies the fake profile and form, captures a screenshot, dispatches
at most one guarded save, captures the result, and independently opens Record
View. An organization save also uses the same-session-bound organization
readback. Screenshots are mode `0600` in a new private mode `0700` directory
under `/tmp/hms-cloud-create-*`.

Outcomes are `prepared`, `saved`, `refused`, `needs_input`, `unsupported`, or
`uncertain`. `applied` records values observed on the form; `missing` and
`warnings` identify work left for the caller. A saved result includes the
confirmation, fresh Record View fields, and `readback.mismatches`. Exact saved
child ages and the source's native code are not exposed by Record View; the
readback compares child counts/bands and the source description instead.
`save.blockedRequest` can report safe full-body mismatch field names. A refused
or uncertain save must not be retried blindly: independently reconcile a
possible dispatch first. Browser-side send observations cannot prove what HMS
may have queued server-side.
