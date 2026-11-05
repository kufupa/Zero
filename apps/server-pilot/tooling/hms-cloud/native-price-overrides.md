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
| `readSavedStayRates` | none | native nightly amounts, currency, totals and digest |
| `listRateOverrideReasons` | none | current native codes and descriptions; coverage may be unknown |
| `prepareRateOverride` | `date`, `amountCents`, `currency`, `reasonCode` | one-use `preparedId`, reviewed baseline and staged change |
| `commitRateOverride` | `preparedId` | dispatch evidence and independent readback |

`date` is one night in the selected stay; `amountCents` is a positive integer
string different from that night's saved amount. A new preparation replaces
the prior handle; handles expire when the session closes. Prepare is unsaved
and works for verified real guests. Commit
requires a backend-supplied `dispatchRateOverride` callback and is restricted
to verified Labtest stays. The JSONL CLI supplies no dispatch authority.
The callback receives the paused native request, `continueOnce`, and the
review binding; it must explicitly await `continueOnce` to dispatch. Neither a
handle nor a digest grants authority. After an attempt the session requires a
fresh read, and missing readback evidence is reported as unknown.
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
   dates must be the same night within the stay, amounts are positive integer
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
full fresh record preimage, not the smaller rate target. No new-stay numeric
editor or multi-night operation is established by these tools.

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
