# Amend a fake saved stay's Booker contact

`guest-stay-amend-contact.mjs` is an internal Labtest-only adapter for changing
one text field on an already-open saved Record View:

- `bookerName` maps to the saved form's `caller` field.
- `bookerContact` maps to `udfchar06`.

Example:

```js
import { amendLabtestContact } from './guest-stay-amend-contact.mjs';

const result = await amendLabtestContact(page, {
  confirmation, guestId, arrival, departure, roomType, ratePlan, note,
}, { field: 'bookerContact', value: 'synthetic contact for an approved Labtest' });
```

The input must be nonempty and at most 200 characters; clearing a field is not
supported. The action first verifies the current HRCEN Reserved Proof Labtest
record, 2027+ dates, NGI guarantee, disabled CMS sending, blank guest email and
blank linked-party fields. It requires a clean full-form snapshot, one writable
Ext field in that same form, and a preimage matching the saved model. The
complete submitted record must match that snapshot except for the selected
contact field. The save request is approved once for its exact request object;
the writer falls through the page-lifetime request fence, and only its later
context route can continue that request. The temporary context exception is
removed when the action ends, but the used page retains its disarmed deny route
for the rest of its lifetime so delayed send/email requests remain blocked.
Other pages continue to use only the shared read-only guard.

`awaiting_readback` means only that one approved save returned HTTP 200 without
a dialog or any unexpected blocked request after dispatch. It is not proof HMS
persisted the value. Any blocked request after dispatch makes the result
`uncertain`, even when the approved response is HTTP 200. Reopen the exact
record in a fresh guarded session and independently verify the selected Booker
field and unchanged stay fields. Reconcile every `uncertain` result before
another mutation; never retry blindly. No live persistence result is claimed
until an owner-serialized write slot and that fresh readback are complete.

This adapter is not yet exposed through `saved-stay-agent-session.mjs`; that
shared session registry is coordinator-owned. The module and its route-chain
test are deliberately separate from the registry change.
