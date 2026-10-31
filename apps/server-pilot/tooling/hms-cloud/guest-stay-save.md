# Save a fake HRCEN Labtest stay

`searchLabtestPreimage` and `saveNewLabtestStay` operate on one caller-owned,
authenticated page. Install the shared read-only guard and serialize all page
actions. Search before opening a new Guest Stay; a clear result provides a
single-use `preimageId` for that page, arrival and departure. A changed search,
write or five-minute expiry invalidates it. Existing same-name/arrival records,
incomplete results and stale proof do not authorize a save.

```js
import { searchLabtestPreimage } from './labtest-preimage.mjs';
import { saveNewLabtestStay } from './guest-stay-save.mjs';

const census = await searchLabtestPreimage(page, { arrival, departure });
if (census.outcome !== 'clear') return census;
// Open a blank HRCEN Guest Stay, select the verified Proof Labtest profile,
// dates, room, rate, source, occupancy, NGI guarantee and a synthetic note.
const saved = await saveNewLabtestStay(page, {
  preimageId: census.preimageId, arrival, departure, guestId, roomType, ratePlan, guaranteeType: 'NGI', note,
});
// Reopen in a fresh guarded session and reconcile against census.candidates.
```

The save requires the current verified fake profile, a blank new stay, dates in
2027 or later, the Non-Guaranteed Individual (`NGI`) guarantee, no selected A/R
or card, CMS Send unchecked, and blank CMS
recipient and guest email. It checks the observed request's action and key
identity fields. One exact request is dispatched from its page route; the
context read guard remains installed. The page then blocks other non-read
requests and cannot be used for another write. Unexpected dialogs remain
untouched. `saved_same_form` is only a same-form observation: independently
look up the confirmation and record. An `uncertain` outcome may have written;
reconcile before any further action and do not blindly retry.

The census and readbacks can include private guest or reservation data. Keep
them in approved private storage, not logs or Git. The browser send-request
count covers only observed browser traffic; it does not prove what HMS may have
queued server-side. The census is a point-in-time observation, not a lock
against another session creating a matching stay afterward.
