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

Agency, organization, group, A/R and guarantee-card fields must be present
and blank in the saved model; any corresponding form values and visible
controls must also be blank. Linked, missing or ambiguous fields return
`LABTEST_LINKED_PARTY_UNVERIFIED` in the identity or clean baseline checks;
later changes also block the save.

`awaiting_readback` means the request returned HTTP 200, not that HMS saved
the change. Reopen the exact record in a fresh guarded session and verify the
new note and unchanged identity and stay fields. Reconcile `uncertain`
outcomes before any further mutation. A deadline and native-dialog signal
disarm the action; dialogs are returned, never accepted.
Returned observations can contain private data and belong in private storage.
