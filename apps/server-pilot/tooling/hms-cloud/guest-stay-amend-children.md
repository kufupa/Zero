# Saved-stay child occupancy staging

`guest-stay-amend-children.mjs` is an experimental programmatic adapter for a
caller-owned, **exclusive**, guarded HRCEN Proof Labtest Record View. It can
stage an editor and, when explicitly requested, dispatch one tightly bound
native validation to apply it to an **unsaved** parent draft. No saved-stay
session wrapper or staff surface is connected. It never authorizes Save,
checks availability, reprices, or sends a message.

## Interface and safety

`planSavedChildOccupancy({ childCount, childAges })` preserves explicit zero,
empty ages and unknown values. Exact ages are integers 0–17; a supplied count
must equal the list length. The HRCEN count bound of 0–9 is not a universal
hotel rule. A count alone does not supply ages.

`stageLabtestChildAmendment(page, expected, options)` requires:

- `expected`: exact `confirmation`, `guestId`, `arrival`, `departure`,
  `roomType`, `ratePlan`, `note`, `adults`, `childCount` and `childAges` from
  the current stay. The shared guard checks HRCEN, Proof Labtest, Reserved,
  2027+ dates, a non-guaranteed individual, disabled sending, permitted party
  links, the clean full record, identity and the full occupancy preimage.
  Unknown prior ages are refused. The caller must own the exclusive stay.
- A dedicated browser context created with `serviceWorkers: 'block'`, with no
  active workers. The adapter checks the pinned Playwright client's private
  context options and refuses if it cannot verify this prerequisite.
- `options`: explicit `childCount` and `childAges`; optional `timeoutMs` and
  `applyToDraft`. The latter defaults to false. Extra keys or contradictory
  values fail. An explicit empty list is not equivalent to unknown.

The exact saved-stay `getChildAges` request is bound to the authenticated page,
record frame, origin, property, stay ID and previous ages. The editor must be
the unique visible window. Before edits, the adapter checks the two observed
model metadata changes against the native response and the complete snapshot.
It verifies the category toggle, child count, each age, and the parent state.

With `applyToDraft: true`, exactly one `validateChildAgeDetails` request can
pass the page-lifetime fence. Its frame, origin, method, encoding, exact keys,
property, saved stay ID, adults, requested count and ages, category toggle,
active categories and original band counts must match. The full target, native
session identity, party links and draft snapshot are rechecked immediately
before the click. Save, unrelated unsafe requests and dangerous paths remain
blocked. Existing caller context routes remain in the chain; the adapter uses
`route.fallback()`, not `route.continue()`.

After any attempt, the adapter closes its approval scope and quarantines the
page. Close the entire page to discard the draft. Do not manually press Apply
or Save on that page. Calls must be serialized on the page and context.

## Outcomes and evidence

- `staged_in_editor` means the visible and native popup values matched while
  the parent retained its verified pre-Apply state. It does not mean applied.
- `applied_to_unsaved_draft` requires the native response, parent form,
  identity and known side effects to match the adapter's checks. It does not
  mean saved, approved, repriced or available. This post-fix result has **not**
  been verified by a live run.
- `apply_uncertain` means an Apply may have been dispatched and was not fully
  verified. Do not retry automatically. Close the page and independently
  reconcile the saved record before any future action. `stage_uncertain` also
  requires a fresh page and investigation. All outcomes have `saveEligible:
  false`; pricing, tax and inventory remain `unknown`.
- A response with the same ages in a different order remains uncertain. The
  multiset is useful diagnostic evidence, not proof that child ordering or
  identity can be ignored. Form and model fields are reported separately.

On 2026-11-01, one guarded HRCEN Proof Labtest probe staged three children in
the popup. The saved preimage was two children aged 8 and 12; the requested
popup ages were 8, 12 and 5. Visible and native popup controls agreed. A
separate abort-only click captured the validation payload without dispatch.

A later single guarded Apply returned HTTP 200 but the adapter reported
`apply_uncertain` / `AGE_VALIDATION_RESPONSE_UNVERIFIED`: HMS returned ages in
order 5, 8 and 12. The parent visibly showed three children in the 3–12 band;
the model retained `8,12,5`, while the parent's saved-model count still showed
two and the form count showed three. This proves neither ordering semantics
nor a saved amendment. Opening the editor also changed native
`successmessages` and `activechildcategories` metadata and made the in-memory
record dirty. Apply cleared visible rate and tax totals and enabled the
availability control; no availability check or reprice was run.

A fresh separate session read the same identity and clean record. Its full
form values, child occupancy and business fields matched the baseline; only
native session identifiers differed in the full model. No Save was dispatched.
Screenshots, request and response, and snapshots remain private under
`/tmp/hms-child-live-evidence/`. The first probe's full JSON was accidentally
overwritten by the second inspection; its summary and screenshots remain.

The later service-worker prerequisite was not separately live-tested.

The code was then adjusted to classify only observed side effects and report a
reordered response as `AGE_VALIDATION_ORDER_UNVERIFIED`. The dispatched Apply
was **not retried**, so the final adjustment remains unverified by live Apply.
The targeted regression file passed 18 tests on isolated Product EC2 using the
uncommitted files, with database variables unset. No local tests or typechecks
ran. The remote result is private at
`/tmp/hms-child-live-evidence/remote-test.vvndXM/`.

Zero-child saved-popup behavior, other ages, properties and versions are
unproved. A separate exact-save guard, verified repricing and inventory, and
human approval would be required before any persistence; real-guest writes
remain out of scope.
