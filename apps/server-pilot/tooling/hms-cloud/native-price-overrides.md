# Native rate and charge-room tools

These are HRCEN Playwright tools, not a production write authorization. Saved
writes below are limited to a verified Proof Labtest stay with 2027+ arrival,
and require CMS send off. An uncertain write must be reconciled in a fresh
session before any retry.

## Saved-stay nightly rate

Use `withSavedStayAgentSession` and its `runTool` callback. First `read` the
saved stay; the session keeps its verified native identity privately. The
following requests use the same `{ id, tool, ... }` envelope:

| Tool | Required fields | Result |
| --- | --- | --- |
| `readSavedStayRates` | none; optional `includeReasons: true` | native nightly amounts, currency, totals and digest; optionally saved reason descriptions |
| `listRateOverrideReasons` | none | current native codes and descriptions; coverage may be unknown |
| `prepareRateOverride` | `date`, `amountCents`, `currency`, `reasonCode`; optional `endDate` | one-use `preparedId`, reviewed baseline and staged change |
| `commitRateOverride` | `preparedId` | dispatch evidence and independent readback |

`date` is the first night in the selected stay. `endDate` defaults to `date`;
when supplied, it is the inclusive last night and must be before departure.
`amountCents` is a positive integer string different from at least one selected
night's saved amount. A new preparation replaces
the prior handle; handles expire when the session closes. Prepare is unsaved
and works for verified real guests. Commit
requires a backend-supplied `dispatchRateOverride` callback and is restricted
to verified Labtest stays. The JSONL CLI supplies no dispatch authority.
The callback receives the paused native request, `continueOnce`, and the
review binding; it must explicitly await `continueOnce` to dispatch. Neither a
handle nor a digest grants authority. After an attempt the session requires a
fresh read, and missing readback evidence is reported as unknown.

With `includeReasons: true`, `readSavedStayRates` adds `reasons` with its
`source`, `observedAt`, per-night `{ date, description, code }`, and date
coverage. A missing native description is `null`. HMS currently exposes the
saved description here, not its code, so `code` is `null`. The option does
not change the nightly-rate digest. Without it, the existing result is unchanged.
An unverified or unavailable native reason response adds an `issue` and unknown
coverage; it does not erase an independently read nightly price. Identity,
guard and browser cleanup failures remain read failures.

Prepare returns `change.reasonCode` and the selected native
`change.reasonDescription`; both are bound to the review. Commit reopens the
stay and reports `readback.reason` with expected and observed code/description
and separate `descriptionStatus` and `codeStatus`. A matching description does
not prove the saved code: `verification.reasonReadback` remains `UNKNOWN`
unless the code itself can be observed. A changed description makes the write
`uncertain`; missing evidence remains `UNKNOWN` and requires reconciliation.
HMS can change `recordId` on Save: readback reports it separately as
`verification.nativeRecordId`, while the stable stay, guest and business fields
are checked for preservation. The pre-submit drift check still includes it.

The lower-level helpers remain available:

`pane-rate-override-session.mjs` owns the verified saved-stay session.
`saved-stay-rate-override.mjs` stages and reviews the Stay Wizard change.

1. Call `withRateOverrideSavedStay({ target, selected, cloudTargetKey }, callback)`
   with the exact current native preimage as `selected`. In the callback call
   `prepareSavedStayRateOverride(page, state, target, change)`.
2. The change is `{ startDate, endDate, amountCents, currency, reason }`. Both
   dates are inclusive nights within the stay, amounts are positive integer
   cent strings, and currency must match the saved nightly rates. `reason` is
   the explicit native code; it is not inferred.
3. The result is `STAGED_UNSAVED`, with `review`, a digest of saved nightly
   rates, `nativePreview`, and `commitBoundary`. Proposed totals are `null`:
   the visible wizard totals are not a reliable preview of the change.
4. `submitRateOverrideOnce(session, stage, onPaused)` permits one matching
   native Submit. The callback inspects the paused request with
   `stage.pausedGate.inspect(request)` and must explicitly call and await the
   provided `continueOnce()` to dispatch. An HTTP 200 is not proof of saved
   prices. `readBackSavedStayRateOverride(review, { target, cloudTargetKey })`
   reopens the reviewed identity in a new guarded session and compares fresh
   nightly rates. Its `MATCHED`
   result covers nightly values; dispatch, reason and other stay fields have
   separate proof requirements.

The rate `target` is `{ propertyCode, confirmation, guestId, nativeStayId,
firstName, lastName, arrival, departure }`. The session input's `target` is the
browser target `{ propertyCode, browserSlot, origin }`; its `selected` is the
full fresh record preimage, not the smaller rate target. Multi-night staging has
been observed without Submit; persistence across a range still needs a Labtest
Save and fresh readback.

## New stay with a numeric rate

`withNewStayRateOverrideSession` in `create-reservation-rate-override.mjs`
composes an existing Create with one subsequent Stay Wizard override. Calls use
the `{ id, tool, ... }` envelope and run in order within the owning session.

| Tool | Required fields | Result |
| --- | --- | --- |
| `prepareNewStayRateOverride` | `reservation` (the Create input without `mode`); `rate: { amountCents, currency, reasonCode, reasonDescription }` | create preview, whole-stay change, opaque `preparedId`, review digest and explicit write sequence |
| `commitNewStayRateOverride` | `preparedId` | create outcome, confirmation and rate write/readback, including partial or uncertain results |

The rate applies to every night from arrival through the night before departure.
The reservation must include `sourceOfBusiness`; HMS required it on the tested draft.
The native override cannot be staged on the unsaved stay: preparation shows
the requested price and the existing native price, not an HMS-approved override
or proposed total. The code and description must be chosen from current HMS
reasons; they are checked against the actual stay after Create. HMS confirmation
sending must be off. A requested `cms.send: true` is refused.

In one priced HRCEN new-stay draft, Average Rate and Total Rate were read-only;
the tested Rate Shop price details had no editable amount either. This does not
establish behavior for every property, rate plan or account permission.

Commit is Labtest-only, requires the `NGI` guarantee, and currently excludes
stays with children or an A/R account. It requires trusted host `authorizeCandidate`,
`dispatchCandidate` and `dispatchRateOverride` callbacks. The host must bind
staff authority to the review, keep durable attempt/recovery records for both
writes and serialize writes to the same stay. An opaque ID is not authority.
The tool verifies the original Create request and its native price again before
Create, checks price fields in the paused Save and the saved price against that preview, then opens the newly
created stay, checks its identity and reviewed business fields, stages the rate,
checks the saved rate baseline, and independently reads back the result.
A failure after Create returns
`created_rate_unverified` with the confirmation; an uncertain Create must be
reconciled before any retry. Neither outcome is a successful rate override.
This combined flow has not yet been proven with a Labtest Save and readback.

## Room type for charge on a new stay

In `booking-lookup-session.mjs`, call `searchRoomTypes` with optional `query`,
`offset`, `limit` and `forField: 'roomTypeForCharge'` (the default field is
`'roomType'`). Then call `selectRoomTypeForCharge` with the returned `searchId`
and at least one of the candidate's `nativeId` or `code`. Selection returns `selected_unsaved`, the field and
changed form values, effects, and `pricing.availability: 'requires_recheck'`.
It does not save the stay. Selecting a charge room after a checked rate cleared
average and total; choose the charge room before the rate and check the rate
again. Do not reuse an earlier quote.

For a Labtest-only new-stay Save, `saveNewLabtestStay` accepts the optional
`roomTypeForCharge` code, checks the draft and outgoing request, and requires
fresh readback. `readLabtestCreate` can compare it when supplied in `expected`.
The higher-level Create request/binding does not expose this field. Real-guest
saves with an explicit charge-room override remain unsupported.
