# Amend a fake saved stay's Booker contact

`guest-stay-amend-contact.mjs` is an internal Labtest-only adapter for changing
one or both Booker text fields on an already-open saved Record View:

- `bookerName` maps to the saved form's `caller` field.
- `bookerContact` maps to `udfchar06`.

Example:

```js
import { amendLabtestBookerContact, amendLabtestContact } from './guest-stay-amend-contact.mjs';

const expected = {
  confirmation, guestId, arrival, departure, roomType, ratePlan, note,
};
```

Use exactly one call per fresh guarded page; after an attempt, reconcile in a
fresh session before another mutation. The following are alternatives.

Single-field compatibility:

```js
const result = await amendLabtestContact(page, expected, {
  field: 'bookerContact', value: 'synthetic contact for an approved Labtest',
});
```

Paired Booker update:

```js
const result = await amendLabtestBookerContact(page, expected, {
  bookerName: 'Synthetic Booker',
  bookerContact: 'synthetic contact for an approved Labtest',
});
```

When the saved reservation note is blank, `expected.note` may be the exact
empty string for Booker changes; the form preimage and submitted full record
must still match it. Note amendment and cancellation retain their stricter
preconditions.

The input must be nonempty and at most 200 characters; clearing a field is not
supported. The action first verifies the current HRCEN Reserved Proof Labtest
record, 2027+ dates, NGI guarantee, disabled CMS sending, blank guest email and
verified party links. The primary agency/company fields may be nonblank only
when the saved model matches every present form value or visible control, with
at least one such form/control readback for each populated field. Secondary agency,
group, A/R and guarantee-card fields remain required blank. The complete
submitted record must match the clean preimage except for exactly the requested
Booker fields, so those links cannot be silently changed. The save request is
approved once for its exact request object; the writer falls through the
page-lifetime request fence, and only its later context route can continue that
request. Once disarmed, the page and context deny routes remain installed until
their page/context closes. They block unapproved mutations and send/email paths
on every page in the context; ordinary safe reads fall through to the shared
read-only guard.

`awaiting_readback` means only that one approved save returned HTTP 200 without
a dialog or any unexpected blocked request after dispatch. It is not proof HMS
persisted the value. Any blocked request after dispatch makes the result
`uncertain`, even when the approved response is HTTP 200. Reopen the exact
record in a fresh guarded session and independently verify the requested Booker
fields and unchanged stay fields. Reconcile every `uncertain` result before
another mutation; never retry blindly. No live persistence result is claimed
until an owner-serialized write slot and that fresh readback are complete.

The saved-stay agent session exposes this adapter as `amendContact`: preserve
the legacy `field`/`value` inputs for one field, or pass `bookerName` and/or
`bookerContact` to stage the supplied fields in one guarded Save.
