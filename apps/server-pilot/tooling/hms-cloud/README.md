# HMS cloud field lookups

These functions use one authenticated, property-scoped Playwright page. The caller
owns the page and must install the existing read-only guard before opening an
unsaved Guest Stay. Search leaves the picker open for refinement. The caller
chooses a candidate; the tools do not infer an identity.

```js
import {
  openNewGuestStay, searchOrganization, selectOrganization,
  searchPrimaryBookingAgency, selectPrimaryBookingAgency, searchArAccount, selectArAccount,
} from './lookup.mjs';

await openNewGuestStay(page);
const result = await searchOrganization(page, query);
// The caller reviews result.candidates and chooses an ID from this result.
const selected = await selectOrganization(page, {
  nativeId: chosenId,
  searchId: result.searchId,
});

const accounts = await searchArAccount(page, accountQuery);
const selectedAccount = await selectArAccount(page, {
  nativeId: chosenAccountId,
  searchId: accounts.searchId,
});
```

Searches return the applied UI and request filters, column labels, server
metadata, and both response and loaded-grid data for each candidate. Coverage
includes loaded and reported totals, the server's more-records flag, and an
unknown truncation state when completeness cannot be established. Searches do
not paginate. Correlation identifies fields that could not be compared between
the response and grid, including dates converted by the UI. `no_match` requires
a verified empty response and grid;
`execution_failure` is not an empty result.

Field-named selection requires the `searchId` and a unique native ID from that
search. It checks the current picker, criteria and grid again before acting.
On success it returns the selected field and visible form fields with their
changes. A/R selection also returns `nativeReadback` with the account ID, name
and status fields present in the HMS response. Organization, agency and A/R
selections send a field-change request before Save; the selection guard allows
that request only for a blank confirmation, empty reservation keys and the
chosen ID. A/R selection also checks the property and record IDs and blocks
unexpected POSTs during selection. The reply must confirm the ID and contain no
HMS message. A `selection_uncertain` outcome means
the action may have occurred: inspect the form before trying again. Unexpected
dialogs are left untouched.

The compatibility path `../playwright-quote/hms-party-search.mjs` retains
`searchBookingAgencies`, `searchOrganizations`, `searchArAccounts`, and
`selectBookingAgency`. The legacy agency selection also accepts an ID alone and
checks it against the latest live grid.

Results can contain personal, business and financial details. Keep them private.
