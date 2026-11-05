# Guest profile creation (HRCEN)

Use the existing `guest-profile.mjs` lookup separately to find and review
profiles. Creation never searches or selects an existing person. A name match
is not proof of identity.

The supplied runner is a **Proof Labtest-only** caller. It does not authorize a
real-guest Save or implement staff approval. It exposes three operations:

```js
import { randomUUID } from 'node:crypto';
import { createGuestProfileRunner } from './guest-profile-runner.mjs';

const runner = createGuestProfileRunner();
const input = {
  propertyCode: 'HRCEN', // optional
  guest: { firstName: 'Proof', lastName: 'Labtest', mobile: '+27000000000' },
  confirmDuplicateName: true, // explicit reviewed choice; defaults to false
};
const prepared = await runner.prepareGuestProfile(input); // stages only
if (prepared.outcome === 'ready') {
  const result = await runner.createGuestProfile({
    ...input, expectedPreviewDigest: prepared.previewDigest,
    attemptId: randomUUID(), // keep and reuse this ID for this approved attempt
  });
}
const profile = await runner.readGuestProfile({ nativeId: '12345' });
```

## Inputs

| Operation | Required | Optional |
| --- | --- | --- |
| `prepareGuestProfile` | `guest.firstName`, `guest.lastName`, `guest.mobile`: nonblank strings | `guest.email`, `propertyCode: 'HRCEN'`, `confirmDuplicateName` boolean (default `false`), `expectedPreviewDigest` to compare against a prior preview |
| `createGuestProfile` | Same guest fields, `expectedPreviewDigest` from Prepare, stable `attemptId` | Same optional fields; `retryOfAttemptId` only for the reviewed recovery described below |
| `readGuestProfile` | `nativeId`: numeric string | `propertyCode: 'HRCEN'`; `attemptId` to reconcile that attempt using its recorded ID |

Guest values are trimmed, limited to 200 characters and must not contain
control characters. Omitted or null email means **blank**; null property and
duplicate decision use their defaults. An attempt ID has 1–128 letters,
digits, `.`, `_`, `:` or `-`, and starts with a letter or digit. Creation stages ACTIVE with
all four supported consent controls off. The runner refuses other guest names;
the low-level module's callback interface is trusted infrastructure, not a
staff authorization system.

## Results

- `ready`: normalized `businessFields`, `previewDigest`, native required-field
  names and an available Save control. No Save was sent. The digest binds the
  values and duplicate decision; it does not itself prove approval or that a
  previous Prepare ran.
- `created`: `attemptId`, native ID, dispatched phase and a fresh exact-ID
  `readback`. All supported values match, including blank email, ACTIVE and
  four false consent values. The readback includes `consent` and
  `consentCoverage`; an unreadable consent value is `null`, never assumed off.
- `confirmation_required`: HMS asked the recognized duplicate-name question
  but the reviewed input did not permit Yes. No automatic confirmation occurs.
- `not_dispatched`, `needs_input`, `input_gap`, `review_required` or
  `unavailable`: validation, preparation, authorization or journal failed.
  Inspect `issue` before deciding what to do.
- `uncertain` or `reconciliation_required`: inspect `attemptId`, `phase`,
  `dispatched` and `nativeId`; a `null` dispatch state means it is unknown.
  Do not repeat Save. An exact-ID read is evidence of the profile's current
  contents, not by itself evidence attributing its creation to an attempt.

## Replay and recovery

The runner writes private, synchronized attempt, phase and response records
under `~/.nava-hms-runtime/guest-profile` by default. A configured `runtimeDir`
must be an absolute, owner-controlled `0700` directory outside Git. Files are
`0600`; filenames are opaque hashes. Records contain the approved guest data,
so retain them as private operational data.

A repeated completed attempt returns its recorded result. A claimed or
uncertain attempt stays held after process restart. Equivalent normalized
property and guest values share an intent hold even if the attempt ID or the
duplicate decision changes. That grouping prevents retries; it does not claim
those values identify a person. This is local shared-directory protection, not
a distributed exactly-once guarantee or a replacement for the existing
browser/property ownership and write serialization mechanisms.

If HMS returned an ID, call `readGuestProfile({ nativeId, attemptId })`. The
runner compares the fresh master read with the recorded approved fields and,
only when a successful response with that same ID was durably recorded, stores
and returns a `reconciliation` result. No recovery read sends Save. Without a
recorded ID, use the separate lookup and manual evidence; matching names alone
cannot establish which attempt created a profile. Incomplete or corrupt
records remain held.

A later reviewed attempt can reuse the same intent only after a **trusted
runtime** independently establishes that the earlier attempt did not create a
profile. Configure `verifyNoCreate` on the runner to perform that review and
return `{ outcome: 'no_create', evidenceDigest }`, where `evidenceDigest` is
a SHA-256 hex digest of the retained private evidence. Then supply the prior
`retryOfAttemptId` with a new `attemptId` and newly reviewed preview. The
callback is infrastructure, not a tool-input field: JSON flags and caller
assertions cannot release a hold. A successful response or returned ID cannot
be declared no-create by this path. Without a trusted verifier, the hold stays
in place.

## Full master-profile reads

The low-level `readGuestProfile({ nativeId, propertyCode? }, options?)` returns the
existing summary plus `propertyCode`, `observedAt`, `fields` and `coverage`.
A legitimate null mobile is readable. Summary email retains its compatibility
blank string for an observed native null; a missing email remains null/unknown.
`fields` preserves the native representation separately. Missing summary fields
are reported in coverage; strict creation readback still refuses them.

Each discovered Header form field has `{ name, label, kind, visibleWhenDiscovered,
state, value, displayValue, rawValue }`. A dropdown retains its native object in `rawValue`
and selected code in `value`. `displayValue` is resolved only from one native
option whose value matches that code; ambiguous or absent display text stays null. States are `present`, `blank`, `true`, `false`,
`unknown`, `unread`, `masked` or `redacted`. Password, credential and token
controls are returned as redacted metadata without their values. Dates remain
native calendar/display strings; timezone and field authorship are not inferred.

Coverage describes the discovered form-field scope and reports unread/unknown
fields and additional native value names. It does not claim hidden sections or
other profile tabs were read. Additional native response keys are not dumped;
they can include unrelated operational data. No fixed field count is required.
Metadata is discovered from the instantiated Header components, which can be
hidden while the native List tab is active. `visibleWhenDiscovered` does not
describe visibility or editability on a selected record or the New form.

`readGuestProfiles([{ nativeId, propertyCode? }, ...], { onResult?, signal?,
openSession? })` reads unique exact IDs sequentially on one guarded session.
`onResult` receives an independent checkpoint observation. These observations
remain provisional until `{ outcome: 'read', sessionVerified: true, profiles }`
is returned after cleanup. Failure returns `outcome: 'unavailable'`, an `issue`,
partial `profiles` and `sessionVerified: false`. There is no lookup or Save.

Private CLI: `diagnostics/batch-read-guest-profiles.mjs INPUT.json OUTPUT.json`.
Input is `{ candidates: [{ nativeId, propertyCode? }] }`; output must be in an
owner-controlled `0700` directory outside Git and is created with `0600` mode.

Private paired reader: `diagnostics/batch-read-reservation-guests.mjs INPUT.json
OUTPUT.json`. Input requires `{ propertyCode: 'HRCEN', candidates: [{ confirmation,
nativeId?, lookupOptions? }] }`. Confirmations must be trimmed and unique;
`nativeId` is historical comparison metadata, not selection authority.
`lookupOptions` forwards the existing lookup's optional guest name and ISO
calendar arrival date. Only use corroborated identity hints; preserve conflicts.
The output includes per-stay Record View, selected guest forms, native identity,
observation timestamps and session guard verification. Failed reads remain
explicit, retaining the existing lookup's native candidates, searched date
range and result coverage when available. A setup/cleanup failure is not no-match. Grid coverage remains the
reader's loaded/rendered scope, not a claim that every hidden guest was read.
Both CLIs reject symlink-aliased output directories and paths inside Git.
