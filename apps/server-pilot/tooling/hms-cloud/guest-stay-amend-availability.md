# Saved-stay amendment availability

This read-only adapter prepares a Hotel Availability search for a proposed
single-stay date, room-type or rate-plan change. It never edits the saved form,
holds inventory, dispatches Save, or produces an official amendment price.
The existing saved-stay adapter remains the only local unsaved staging path;
its own Labtest guards and limitations still apply.

```js
import { readStayAmendmentAvailability } from './guest-stay-amend-availability.mjs';

const result = await readStayAmendmentAvailability(separateAvailabilityPage, {
  existing: { propertyCode: 'HRCEN', arrival: '2027-03-15', departure: '2027-03-17',
    roomType: 'STQN', ratePlan: 'BAR' },
  change: { departure: '2027-03-18', roomType: 'DLX' },
  occupancy: { adults: 2, childAges: [8] },
  partyContext: { group: null, organization: '42', bookingAgency: null },
  roomQuantity: 1,
}, { snapshotPath: '/private/caller-owned-directory/amendment.json' });
```

`existing` is caller-supplied, not independently checked by this adapter. Read
and verify the current stay separately, including complete occupancy and party
identities. Every party key must be present: use `null` only when independently
verified blank, not for unknown. Select any requested party by native ID on the
Hotel Availability surface before searching, as required by `readQuote`.
Dates are calendar days, and room/rate codes identify the exact requested pair.
The room quantity and each child age must be explicit. The proposal can change
one or several supported fields but cannot change property.

The adapter delegates the search, private snapshot handling, paging and evidence
projection to `readQuote`. Search on a separate read-only page rather than the
saved Record View. Inspect `availability.coverage`, the night cursor, restriction
reasons and every night rather than treating an absent pair as unavailable.
The caller-owned private snapshot can be reopened through `getQuoteView` for
additional nights. A current booking may already occupy inventory, so a displayed
count does not prove whether its requested change can be applied. Counts also do
not establish rate eligibility, a hold, combined inventory, tax or the official
stay total. A catalog rate or a successful availability read does not authorize
Save or prove native repricing.

`prepareStayAmendmentAvailability` performs the same validation without opening
HMS. It reports `savedPreimage: caller_supplied_unverified`, `saveEligible: false`
and unknown pricing and inventory. `criteria_unavailable`, failed reads and
empty observations remain distinct. No retry of a possibly dispatched HMS action
is authorized by this read-only result. The caller is responsible for private
data handling and independent verification of the saved record.

For a guarded saved Labtest record, prefer the connected
`readLabtestStayAmendmentAvailability` entry point in
[the saved-stay adapter](guest-stay-amend-date-room-rate.md#availability-read-bound-to-a-saved-labtest-form).
It binds the scenario to the current saved form before and after the read.
