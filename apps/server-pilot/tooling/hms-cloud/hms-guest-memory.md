# Historical HMS guest candidates

`hms-guest-memory.mjs` provides a private, read-only candidate aid. It wraps
`buildHmsBookingMemory` and extracts guest fields from the same supplied PMS
snapshots. No message/PDF address is treated as a guest address. Inputs and
outputs contain personal information: keep them private and do not commit them.
Node 22 is required.

```js
import { buildHmsGuestMemory, queryHmsGuestMemory } from './hms-guest-memory.mjs';

const memory = buildHmsGuestMemory({ propertyCode, pmsSnapshots, pmsSourceFiles });
const result = queryHmsGuestMemory(memory, {
  propertyCode, firstName, lastName,
  // email and profileId are optional additional exact criteria
}, { limit: 25, evidenceLimit: 10 });
```

`pmsSnapshot` is also accepted for a single snapshot. `pmsSourceFiles` is an
optional array corresponding to `pmsSnapshots` followed by `pmsSnapshot`.
The builder applies the existing booking memory's source and duplicate-stay
rules. Input without a property declaration **must be partitioned by the caller**
before building. A conflicting declared property is rejected; every query also
requires the matching explicit property. The current source filter is E-Mail,
Voice Call and Call Center, not all HMS bookings.

Query by exact profile ID, exact guest email, or both first and last name.
Supplied criteria are combined on the **same historical observation**. An
incomplete query returns `input_gap` and missing names with email/profile ID as
alternatives. A malformed email or nonnumeric profile ID also returns an input
gap. Case and Unicode compatibility are normalized; there is no fuzzy search.
`no_match` means no match in the eligible captured observations, not no HMS
profile. A query may return multiple candidates even for an exact email. A match against
a conflicting or partially unavailable field is included but explicitly marked
uncertain in its support and evidence.

Only observations with both native reservation confirmation views matched, a
single recorded numeric profile ID, and the booking builder's eligible source
are used as candidates. The candidate contains all eligible observations for
that property-scoped profile ID, including conflicting names/contact values,
matched and total observation/confirmation counts, and bounded evidence.
No candidate is selected or ranked as correct. Coverage counts observations,
not guests or all hotel bookings. They include builder exclusions, identity and
profile field states, and per-field states on eligible observations. Evidence
records the confirmation, source of business, snapshot metadata, native
confirmation status, field values and field path, caller-supplied provenance,
and a content fingerprint. Snapshot/observation IDs are positional; the
fingerprint remains the same when snapshots are reordered but changes when the
serialized source record or snapshot metadata changes. Field states distinguish
blank, missing, unavailable, conflicting and unknown; historical contact data
may be stale or shared. Caller-supplied `verifiedStayId` is not independently
verified by this module.

## Safe integration seam

Treat a candidate as a suggestion to investigate, never as identity proof or
permission to select. Search the current guarded Guests picker using
`searchGuestProfiles(page, { field: 'profileId', query: candidate.profileId })`.
Inspect its latest `searchId`, correlation, coverage and current candidate
fields. Compare against independent request evidence, handle ambiguity or
missing information, and follow the existing human-in-the-loop approval and
selection rules. A remembered ID alone must never select a profile. The current
picker implementation is HRCEN-specific; this memory adapter does not expand
its property support or perform live HMS actions.
