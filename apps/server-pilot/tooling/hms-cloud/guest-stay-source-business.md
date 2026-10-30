# Source of Business on an unsaved Guest Stay

`guest-stay-source-business.mjs` operates on one authenticated, guarded HRCEN
page. Open a new Guest Stay first and serialize actions on the page.
`withBookingLookupSession` supplies the shared read-only guard and blank form.

```js
import { withBookingLookupSession } from './booking-lookup-session.mjs';
import {
  searchGuestStaySourceBusiness, inspectGuestStaySourceBusiness,
  selectGuestStaySourceBusiness, closeGuestStaySourceBusinessPicker,
} from './guest-stay-source-business.mjs';

await withBookingLookupSession(async ({ page }) => {
  const search = await searchGuestStaySourceBusiness(page, { query: 'requested description' });
  if (search.outcome !== 'matches') return search;
  const candidates = await inspectGuestStaySourceBusiness(page, { searchId: search.searchId });
  // The caller examines the private candidates and explicitly chooses a nativeCode.
  // await selectGuestStaySourceBusiness(page, { searchId: search.searchId, nativeCode: chosenCode });
  await closeGuestStaySourceBusinessPicker(page);
  return candidates;
}, { memory: null });
```

Omit `query` to list the current picker; a query uses its **Description
contains** filter. Other filters return `unsupported`. Search returns at most 25
of the loaded candidates; inspection supports `offset`, `limit` (up to 100) and
an optional `nativeCode`. Candidates retain the response and grid fields.
Coverage distinguishes loaded and reported totals, the server's more-records
marker and possible truncation. The tool does not paginate the HMS grid.
An unverified empty response is a failure, not `no_match`.

A new search invalidates the previous `searchId`. Selection requires the latest
search and one unique current native code, a complete result set and a unique
description in that set. It rechecks the picker, grid, controls and form, then
verifies the selected row and the visible description on the still-unsaved form.
HMS did not expose a separate native-code form readback in the observed UI: the
result says `nativeCodeReadback: { outcome: 'unsupported', ... }`. Therefore
`selected_unsaved` verifies the row and displayed description, not a saved stay
or an independently read-back native code. `selection_uncertain` means an action
may have occurred; inspect the form and end the session before retrying.

While the picker is open, a page-level guard blocks all requests except the
observed data-only picker header and matching grid Run. These requests pass
through the existing context guard. Unexpected dialogs are left untouched.
Close with `closeGuestStaySourceBusinessPicker`; it verifies that the draft did
not change and removes the page guard. If a failure or uncertain action leaves a
dialog or picker open, the guard remains until a verified close or page closure.
Results and form changes can contain private data; keep them in private storage.

The picker is a Guest Stay field, separate from Hotel Availability, rates and
guarantee type. This tool does not save a reservation or infer a choice.
