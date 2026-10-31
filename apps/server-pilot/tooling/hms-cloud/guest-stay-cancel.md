# Cancel an authorized fake HRCEN stay

On a fresh page with the shared read-only guard installed, use `readShallow`
and `readRecord` to open the exact authorized Proof Labtest confirmation in
Record View. The caller must verify that this is the newly authorized stay and
respect any holds on other records.

```js
import { openLabtestCancellation, confirmLabtestCancellation } from './guest-stay-cancel.mjs';

const expected = { confirmation, guestId, arrival, departure, roomType, ratePlan, note };
const opened = await openLabtestCancellation(page, expected);
if (opened.outcome !== 'reason_ready') return opened;
const result = await confirmLabtestCancellation(page, expected, {
  cancellationNote: syntheticCancellationNote,
});
```

The action verifies HRCEN, the fake guest and saved Reserved record, dates,
room, rate, NGI guarantee, note, and disabled CMS sending. It refuses a dirty
form or quarantined page. It opens the reason dialog and permits one matching
Test Reservations save only after comparing the full request to the clean
record and the expected cancellation changes. The context read guard remains
installed; other mutations are blocked. A native dialog or action deadline
disarms the action and quarantines the page.

Never accept a fee or penalty dialog. `fee_dialog_pending` can occur after the
cancellation save: reopen the confirmation in a fresh guarded session and
verify its status and cancellation details. `awaiting_readback` also requires
independent verification; reconcile uncertain outcomes before any further
mutation, and never blindly retry. Browser send observations do not prove what
HMS may have queued server-side. Keep returned dialogs and readbacks in private
storage.
