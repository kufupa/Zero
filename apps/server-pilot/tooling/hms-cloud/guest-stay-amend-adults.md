# Stage a fake saved stay's adult occupancy

`guest-stay-amend-adults.mjs` exposes `stageLabtestAdultAmendment` directly.
Use a fresh, guarded HMS page with the exact HRCEN Proof Labtest Reserved
record already open in Record View. The caller must identify the authorized
fake stay using fresh reads; the fake name alone does not identify the target.

```js
import { stageLabtestAdultAmendment } from './guest-stay-amend-adults.mjs';

const result = await stageLabtestAdultAmendment(page, {
  confirmation, guestId, arrival, departure, roomType, ratePlan,
  note: previousNote, adults: previousAdults,
}, { adults: requestedAdults, timeoutMs: 20_000 });
```

Dates are `YYYY-MM-DD`, with arrival in 2027 or later and departure after
arrival. Counts must be integers from 1 through 16. The previous note may be
empty, but must match exactly. Additional expected fields or options are
rejected. The requested count must also be available as one unique loaded HMS
option; equal counts return `unchanged` without staging.

The adapter verifies the current origin, property, identity, Reserved status,
dates, room, rate, note, NGI guarantee, disabled CMS sending and blank guest
email. It binds the full clean record and adult form/model preimage to the
staged draft. Primary agency/company links can be nonblank only when verified
and unchanged; secondary agency, group, A/R and guarantee-card fields must be
blank. Missing, dirty, ambiguous or unexpected fields are refused. Snapshot
digests bind diagnostic comparisons to the target and stable preimage, excluding
session identifiers; they are not human approval or authorization to save.

This adapter changes the adult selection on the open form **without saving**.
The page request fence blocks unexpected mutations and send requests, and the
shared save lifecycle is unconditionally prepare-only. The usual staged result
is `not_dispatched` with `OCCUPANCY_REPRICE_REQUIRED` and a diagnostic preview;
other issues report refusal, invalid input or an unverified draft. A preview
contains changed fields, native side effects, adult counts and the target. It
also preserves absent versus blank child fields instead of assuming zero.
The page is consumed after staging; use a fresh guarded session for further
work, and reconcile unexpected or uncertain actions before any retry.

**No pricing, tax or inventory result is verified by staging.** The observed
HMS side effects can clear pricing fields. The preview marks repricing,
inventory and human approval as unverified and `saveEligible` as false.
There is no adult amendment Save path here. Guarded availability recalculation,
approval and persistence are not implemented here. Any future save requires
independent readback in a fresh session; staging does not establish persistence.

The result and preview can contain private guest, stay, rate, note and party
information. Keep them in private storage and never put them in logs or Git.
