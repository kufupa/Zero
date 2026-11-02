# Saved Labtest stay staging

These programmatic tools inspect or stage **one field** on an already saved HRCEN
Proof Labtest reservation with arrival and departure in 2027 or later. They do not
save, reprice, check inventory, send mail, or produce a quote. This is an internal
experimental adapter, not approval or a production amendment workflow.

Open the exact Record View in a fresh, dedicated browser context created with
`serviceWorkers: 'block'`, after installing `installReadOnlyGuard(context)`.
The stage verifies the Playwright client's internal context options and refuses
if the setting is missing, not blocked, or workers are active. This is fail-closed
but relies on a private Playwright property. The pinned 1.63.0 client source
sets it from context initializer options; runtime behavior still needs proof. The current Centurion bootstrap does not set this option and
therefore cannot run this stage without a separate integration change. The caller owns the Labtest authorization and
must coordinate exclusive use of the target. Use a new page for each staging
attempt. `currentLabtestRecord` checks the guest, confirmation, property, dates,
status, room, rate, note, guarantee, send settings and supported party links.
The entire form must start clean, and both saved dates, room and rate must
match their expected values in the form and bound record. Staging rechecks the
identity and full baseline immediately before editing. Native dialogs are not accepted.

```js
import {
  inspectLabtestSavedRoomRateOptions,
  stageLabtestStayAmendment,
} from './guest-stay-amend-date-room-rate.mjs';

const expected = { confirmation, guestId, arrival, departure, roomType, ratePlan, note };
const result = await stageLabtestStayAmendment(page, expected, {
  field: 'departure', value: '2027-01-21',
});
// Or inspect options already loaded by THIS saved form, without opening a picker.
const options = await inspectLabtestSavedRoomRateOptions(otherFreshPage, expected, {
  field: 'roomType', offset: 0, limit: 50,
});
// On a separate fresh page, and only if the saved control exposes a unique
// loaded option with both native ID and code:
const room = await stageLabtestStayAmendment(thirdFreshPage, expected, {
  field: 'roomType', value: 'DLX', nativeId: '123',
});
```

Supported field names are `arrival`, `departure`, `roomType`, and `ratePlan`.
Dates are ISO calendar dates, must remain in 2027+ and preserve arrival before
departure. Room/rate inputs require a code and explicit native ID. The component
must have a loaded, non-loading store containing exactly one record with both.
If the saved form exposes no such store, ID, or code, the adapter refuses rather
than guessing or falling back to selectors from the new-stay form. Inspection
reads only already-loaded candidates, reports coverage, and does not search or
establish current availability. An ID/code can become stale: stage rechecks the
actual store on the same form immediately before selecting. There is no
saved-form picker discovery or rate-shop search in this slice.

The date action fills the visible saved-form field and tabs out. It checks the
Ext component's local calendar date and the form's native model-data contribution
independently. A date stage also checks that the opposite date and room/rate
values and available IDs did not change. Missing IDs are not proven. It reports
the bound record value separately: that record can
remain at its preimage while the form contains the staged date. No form-wide
record synchronization is invoked. The option adapter uses the saved field's
own Ext component and its loaded record. The context deny route blocks routable network traffic during and after staging,
including delayed requests and popup requests. Service workers must be blocked
because Playwright routing does not intercept their requests. The shared saved-stay fence also
remains disarmed, and the Save matcher and validation cannot authorize a Save.
Discard the entire context after the call. A blocked change request means the
operation may be incomplete; never retry on that context.

`updated_unsaved` means the requested date or option is verified in the local
form and native field, with no blocked requests or unexpected dialog during
the observation window. The deny routes remain active for the context lifetime. It still
returns `REPRICE_AND_INVENTORY_UNVERIFIED`, and cannot be saved by this tool.
Incomplete attempts report `not_dispatched`; input gaps, refusals, and unchanged
requests have separate outcomes. Stage details report actual form and model values separately,
their match to the request, changed field names, dirty state, related date/room/
rate fields, and before/after pricing and tax fields. Missing, null, blank,
ambiguous and valued fields stay distinct. `networkRequestsBlocked` counts the
extra context-wide deny route; `blockedRequests` reports the lifecycle's own
blocked requests. If no usable option store exists, `SAVED_OPTIONS_UNAVAILABLE`
or `SAVED_OPTION_UNAVAILABLE` is expected. No result authorizes Save, establishes
an eligible rate, or confirms availability. Other changed fields are observations,
not approved Save deltas. Results can contain private data; handle accordingly.

## Evidence and holds

Private `/tmp/hms-box2-scout-ILas7h/departure_user-evidence.json` records one
unsaved departure extension on one HRCEN fake stay. Its displayed departure,
nights and weekday changed while the native departure model remained old; price
and tax fields cleared. The original record was independently reread unchanged.
A separate actual-adapter run on one additional verified HRCEN Labtest stay is
recorded privately in `/tmp/hms-saved-date-rate-proof-MmTtllz3/evidence.json`,
with before, staged and fresh-readback screenshots beside it. The displayed
departure moved one day, its model stayed unchanged, and prices and taxes cleared.
No Save or blocked request was observed, and a fresh independent read verified
the original saved record stayed clean. All form values matched the preimage;
the only changed model fields were the two session identifiers. This run preceded a subsequent change
that only tightened saved-option form ownership checks; its date code was unchanged.

A follow-up investigation on the same exclusive fake stay is recorded privately
in `/tmp/hms-saved-date-native-5jxTCQ/native-evidence.json`. The native Ext date
control's `getValue` and `getModelData` represented the changed local calendar
day, and the form's `getFieldValues` agreed, while its bound record still held
the original date. Ext's form `updateRecord` reads field values and writes them
to the record; this observation does not prove how HMS Save invokes it. The
independent readback matched all form values and all record data except the two
session identifiers, and was clean. A JavaScript Date serializes to UTC in the
private JSON; compare its local calendar components, not its ISO UTC day.

The updated adapter was run on the same fake stay. It reported
`updated_unsaved`, with the requested local date confirmed by both the field and
its model-data contribution, no blocked requests, and no Save. A separate
`updateRecord` call on an isolated copy of the Ext record converted the date to
`10/14/2027`, while the live bound record retained `10/13/2027`; this did not
establish the native Save path. A fresh independent readback was clean and
matched all form values and record data except the two session identifiers. Private evidence:
`/tmp/hms-saved-date-native-5jxTCQ/clone-sync-evidence.json`. After tightening
the unchanged-stay-input and dialog checks, the final adapter again reported
`updated_unsaved` with no Save and an independent clean readback:
`/tmp/hms-saved-date-native-5jxTCQ/final-date-evidence.json`.

The actual saved-form room and rate components on that stay were editable
`lovfield` inputs with search-list triggers, but exposed no component option store
(`/tmp/hms-saved-date-rate-proof-MmTtllz3/control-evidence.json`). Inspection returned `SAVED_OPTIONS_UNAVAILABLE` for both,
so this adapter cannot stage either there. Arrival editing and room/rate
selection remain inferred, not native proof. A fenced native-picker scout
(`/tmp/hms-saved-date-rate-proof-MmTtllz3/picker-evidence.json`) found that the
room trigger requests `POST /web/base/LOVPOP` and the rate trigger requests
`POST /web/base/OSRASD`; both were blocked in that scout. A separate scout
allowed only the exact current-room catalog request under a page-lifetime Save
fence. It returned HTTP 200 and the current room in a filtered grid; five other
requests were blocked (`/tmp/hms-saved-date-rate-proof-MmTtllz3/room-picker-read-evidence.json`).
In a subsequent scout, the native filter-reset request was captured while
blocked, then allowed only after an exact match to that observed read request.
The saved picker returned nine room options with response/grid agreement and
complete reported coverage. Selecting the representative room in the picker
attempted a saved-record room-change POST, which the fence blocked; the scout
returned `ROOM_SELECTION_SCOUT_FAILED` and did not capture a reliable staged
form state. The native body carried the full saved model, `ONLY_DATA_REQUIRED`,
and a changed confirmation-prompt flag; its `autosave` field was already set in
the preimage, and the server-side meaning remains unverified. Do not infer this
endpoint is safe for a saved record from its name or from blank-stay behavior.
A fresh session independently read the original full form unchanged, with only
session identifiers different in model data. Private evidence:
`/tmp/hms-saved-date-native-5jxTCQ/room-reset-evidence.json` and
`/tmp/hms-saved-date-native-5jxTCQ/room-selection-scout.json`.

A saved-rate scout allowed only the exact previously observed `OSRASD` entry
request after checking the complete fake-stay preimage and current booking
session. It returned HTTP 200 and opened Rate Shop. Its automatic rate inquiry
was blocked, and no rate was selected. The exact inquiry body was captured, but
the blocked-request trace did not retain its query string; do not guess it. The
browser context closed without a verified Rate Shop session cancellation, so
server-side session cleanup remains unknown. A fresh session independently read
the original full form unchanged, with only session identifiers different in
model data. Private evidence: `/tmp/hms-saved-date-native-5jxTCQ/rate-entry-scout.json`.

A guarded saved-picker selection path is still needed; these observations are
not inventory or price evidence. Repricing, inventory and Save remain unverified.
Synthetic tests are written but have not run; the approved remote runner uses
committed HEAD, and this dispatch cannot commit.

Do not run live probes until the coordinator schedules an exclusive fake stay.
The coordinator must integrate these exports into a saved-stay session separately;
this module intentionally does not edit the shared session or save lifecycle.

## Availability read bound to a saved Labtest form

`readLabtestStayAmendmentAvailability(recordPage, availabilityPage, expected,
options)` connects a proposed date, room or rate change to a separate Hotel
Availability read. It verifies the clean saved fake-stay form before and after
the read, including its date/room/rate preimage, adult count, native child ages
and linked party IDs. Supply explicit `change`, `occupancy`, `partyContext`,
`roomQuantity` and private `snapshotPath` in `options` as documented in
[amendment availability](guest-stay-amend-availability.md). Select the native
party on the separate availability page first when required by `readQuote`.
The full form must remain identical across the read, or the result is refused.
A saved stay with missing or ambiguous child ages remains unsupported. A verified
zero child count and matching zero age bands permit an empty age list only when
the native age field is genuinely blank and no displayed age field conflicts. Linked-party limitations of the existing
Labtest guard still apply. A page used for the saved Record View cannot also be
the availability page.

This combines the current saved-record adapter and existing Hotel Availability
reader. It does not reprice the saved form, establish amendment inventory,
authorize Save, or integrate the shared saved-stay agent session. Count and rate
observations remain separate from native amendment availability, especially when
the existing booking already occupies inventory. Real-guest writes remain out
of scope.

On 2026-11-02 the existing date adapter staged a one-day departure extension
on a separately reserved HRCEN Proof Labtest stay. The visible date and native
field date matched the requested day; the bound record still held the prior
value. The adapter returned `updated_unsaved` with no blocked request and no
Save. A fresh independent session reread the original clean record unchanged.
This is staging evidence, not saved persistence, native repricing or inventory.
Private screenshots and evidence: `/tmp/hms-date-alt-stage-OCvA0p/`.
