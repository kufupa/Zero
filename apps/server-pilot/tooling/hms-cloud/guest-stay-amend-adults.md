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
email. Before staging, it checks the native target and rechecks the full clean
model and form preimages in the same browser turn as the adult edit. Primary
agency/company links can be nonblank only when verified and unchanged; secondary
agency, group, A/R and guarantee-card fields must be blank. Missing, dirty, ambiguous or unexpected fields are refused. Snapshot
digests bind diagnostic comparisons to the target and stable preimage, excluding
session identifiers; they are not human approval or authorization to save.

This adapter changes the adult selection on the open form **without saving**.
The page request fence blocks unexpected mutations and send requests, and the
shared save lifecycle is unconditionally prepare-only. The usual staged result
is `not_dispatched` with `OCCUPANCY_REPRICE_REQUIRED` and a diagnostic preview;
other issues report refusal, invalid input or an unverified draft. A preview
contains changed fields, native side effects, adult counts and the target. It
also preserves absent versus blank child fields instead of assuming zero.
A full-form update can copy unexpected values into the unsaved draft. If that
happens, the adapter refuses the draft without rolling it back or saving it.
The page is consumed after staging; use a fresh guarded session for further
work, and reconcile unexpected or uncertain actions before any retry. A
bounded staging attempt rechecks its deadline before changing the control;
a delayed control lookup cannot edit the draft after the operation returns.
A queued browser evaluation also checks the deadline before mutation. An
already-started browser action is not cancelled by the timeout.

**No pricing, tax or inventory result is verified by staging.** The observed
HMS side effects can clear pricing fields. The preview marks repricing,
inventory and human approval as unverified and `saveEligible` as false.
There is no adult amendment Save path here. Guarded availability recalculation,
approval and persistence are not implemented here. Any future save requires
independent readback in a fresh session; staging does not establish persistence.

## Isolated save observation

On 2026-11-02, a one-off experimental copy of this adapter used the shared
one-save lifecycle on an exclusive fake HRCEN stay. It staged adults from two
to three and sent one exactly matched Save request without an availability
recalculation. HMS returned HTTP 200, but the outcome was `uncertain`. A later
screenshot showed the native prompt “Retain the current rates?” with Yes, No
and Cancel. No option was selected. The runner did not capture the response
body or the dialog count, so it did not establish the server response or the
meaning of either option.

A separate fresh session found the clean saved form and model unchanged apart
from session identifiers, including the original adult count. This is a
point-in-time readback, not proof that the earlier request cannot complete
later. No retry was made. Pricing, tax and inventory correctness remain
unknown. This experiment does not add a Save path to the adapter.

The result and preview can contain private guest, stay, rate, note and party
information. Keep them in private storage and never put them in logs or Git.
