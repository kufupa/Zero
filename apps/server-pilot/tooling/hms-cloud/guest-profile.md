# Guest profile lookup on an unsaved Guest Stay

`guest-profile.mjs` uses the **Guests** lookup on one authenticated HRCEN page.
The caller must install the shared read-only guard, open a new Guest Stay, and
serialize page actions. `withBookingLookupSession` supplies that setup. The
functions verify the property and blank confirmation before acting.

```js
import { withBookingLookupSession } from './booking-lookup-session.mjs';
import {
  searchGuestProfiles, inspectGuestProfileCandidates, selectGuestProfile, closeGuestProfilePicker,
} from './guest-profile.mjs';

async function findGuest(lastName) {
  return withBookingLookupSession(async ({ page }) => {
    const search = await searchGuestProfiles(page, { field: 'lastName', query: lastName });
    if (search.outcome !== 'matches') return search;

    // The caller examines these private details and explicitly chooses an ID.
    const view = await inspectGuestProfileCandidates(page, { searchId: search.searchId, limit: 25 });
    return { search, view };
  }, { memory: null });
}

// Selection must happen before the callback exits, on that same page:
// await selectGuestProfile(page, { searchId: search.searchId, nativeId: chosenId });
// Or await closeGuestProfilePicker(page) to leave the draft unchanged.
```

Repeat `searchGuestProfiles` to refine; the previous `searchId` then expires.
The filter is `{ field, query }`; `lastName` is the default field. The picker
exposes `profileId`, `firstName`, `lastName`, `email`, `phoneNumber`, `address`,
`city`, `country`, `externalId`, `loyaltyNumber`, `aliasFirstName`,
`aliasLastName`, `secondLastName`, `stateProvince`, `title`, `vipLevel`,
`restrictedReason`, and `vatId`. `profileId` must be numeric. Each search
checks the applied filter in the request and correlates its response with the
loaded grid. It reads one HMS page and does not paginate the HMS grid.

`matches` and verified `no_match` include the criteria, columns, server
metadata, observation time, coverage and up to 25 candidates. Coverage reports
loaded and reported counts, the server's more-records marker, and whether
truncation is known or possible. Candidate `responseData` and `gridData`
preserve the available distinguishing details. An incomplete or failed search
is `execution_failure`, never a verified empty result. The inspection function
rechecks the current picker and returns a bounded slice or the current matches
for a supplied `nativeId`; all loaded candidates remain available until the
search is invalidated. Save them privately before starting another search if
the caller needs to retain that snapshot.
`closeGuestProfilePicker` cancels the picker, invalidates its search, and checks
that the visible draft did not change. A `close_uncertain` result requires a
form readback before continuing.

Selection requires both the latest `searchId` and one unique native profile ID
from that picker. Duplicate names remain separate candidates; no name-based
identity inference occurs. The function rechecks the picker instance, criteria,
grid and draft identity before selecting. It permits one observed data-only
`guestinfo` POST only when the property, selected ID and blank stay keys match;
other non-read requests are blocked. Success requires the same ID and names in
the HMS response and visible form, with the confirmation still blank. It
returns the selected candidate, native readback, visible form and changed
fields. `selection_uncertain` means the action may have occurred: inspect the
form before deciding what to do. Unexpected dialogs are left untouched.

The response, form and screenshots can contain personal data. Keep them in
approved private storage with mode `0600`; do not log them or commit them.
Standalone examples establish the observed UI behavior, not production-wide
accuracy or a saved reservation.
