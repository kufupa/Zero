# Amend a fake HRCEN stay's reservation note

Use `readShallow` and `readRecord` on a fresh, guarded page to open the exact
authorized Proof Labtest confirmation in Record View. Then call:

```js
import { amendLabtestNote } from './guest-stay-amend.mjs';

const result = await amendLabtestNote(page, {
  confirmation, guestId, arrival, departure, roomType, ratePlan,
  note: previousNote, newNote: syntheticNote,
});
```

The action verifies the current fake guest, HRCEN, Reserved status, dates,
room, rate, NGI guarantee, current note and disabled CMS sending. It changes
only the note and permits one matching save request from the verified record
frame. The saved form must start clean; the full submitted record must match
its baseline except for that note. An existing page quarantine prevents the
action. The page is sealed against other non-read requests. The caller must
verify that the confirmation belongs to the newly created stay and respect any
holds; an existing matching fake name alone does not authorize a write.

Primary agency/company links may be nonblank only when the saved model matches
every present form value or visible control, with at least one such form/control
readback for each populated field. Secondary agency, group, A/R and
guarantee-card fields must remain blank. Every link is part of the full
preimage and exact submitted record; missing, ambiguous or changed fields return
`LABTEST_LINKED_PARTY_UNVERIFIED` or block the save.

The shared save route falls through the page-lifetime fence before its one exact
context exception. Popup writes and send/email requests remain blocked across
the context, including after the writer is disarmed.

This adapter remains note-only. Date, occupancy, room/rate and party setters
need their own saved-frame observations. `labtestRecordDelta` reports rendered,
form and record-model effects separately; callers must surface and approve every
native side effect before including it in a save request.

`awaiting_readback` means the request returned HTTP 200, not that HMS saved
the change. Reopen the exact record in a fresh guarded session and verify the
new note and unchanged identity and stay fields. Reconcile `uncertain`
outcomes before any further mutation. A deadline and native-dialog signal
disarm the action; dialogs are returned, never accepted.
Returned observations can contain private data and belong in private storage.
