# HMS interactive booking lookup session

`booking-lookup-session.mjs` keeps one authenticated HRCEN page and one blank, unsaved
Guest Stay for multiple independent calls. Node 22 is required. It installs the
shared read-only guard. A selection changes the unsaved form and can send a
field-change request. The normal session does not save a booking. Callers choose
candidates. An explicit Labtest-only mode is described below.

Start the JSONL entry point with `node booking-lookup-session.mjs --jsonl`. The old
`../playwright-quote/hms-party-session.mjs --jsonl` path also works. Send one
JSON object per line. Responses are private: redirect stdout to a private file
or pipe it directly to a trusted caller, never to a shared terminal or log.
`quit` returns an acknowledgement and closes the browser; EOF also closes it.
The `ready` event reports whether memory loaded. Invalid JSON and unknown tools
return `input_gap`; each response echoes the optional `id` and requested `tool`.
Memory query output is under `result`; lookup and readback fields are returned
at the top level.

| Tool | Input |
| --- | --- |
| `queryBookingMemory` | `query`: string or `{email}`, `{domain}`, `{name}`; optional `options` |
| `searchPrimaryBookingAgency` | `query`: agency name; optional lookup `options` |
| `selectPrimaryBookingAgency` | `nativeId` and `searchId` from the current agency search |
| `searchOrganization` | `query`: organization name; optional lookup `options` |
| `selectOrganization` | `nativeId` and `searchId` from the current organization search |
| `searchArAccount` | `query`: A/R account name; optional lookup `options` |
| `selectArAccount` | `nativeId` and `searchId` from the current A/R account search |
| `closeGuestStayPartyPicker` | `propertyCode`; close the current agency, organization or A/R picker |
| `readGuestStay` | Reads the visible unsaved form, including blank fields |
| `quit` | Closes the session |

Additional tools accept their inputs as top-level request properties. Each
response keeps the underlying module's outcome and fields alongside `id` and
`tool`. The JSONL runner executes actions sequentially on the same page.

| Tool | Input |
| --- | --- |
| `searchGuestProfiles` | `field` and `query`; optional lookup `options` |
| `inspectGuestProfileCandidates` | Current `searchId`; optional `nativeId`, `offset`, `limit` |
| `selectGuestProfile` | Current `searchId` and explicit `nativeId`; optional lookup `options` |
| `closeGuestProfilePicker` | Cancels the current picker without choosing a guest |
| `readGuestStayForm` | `propertyCode` |
| `setGuestStayText` | `propertyCode`, `field`, `value` |
| `setGuestStayDate` | `propertyCode`, `field`, `date` |
| `listGuestStayDropdown` | `propertyCode`, `field` |
| `selectGuestStayDropdown` | `propertyCode`, `field`, explicit current `value` |
| `setGuestStayChildAges` | `propertyCode`, explicit `childAges` array |
| `listCmsMessageIds` | `propertyCode`; opens the picker |
| `selectCmsMessageId` | `propertyCode`, current `searchId`, explicit `code` |
| `closeCmsMessageIdPicker` | `propertyCode`; close the CMS picker without selecting a code |
| `setCmsSendCheckbox` | `propertyCode`, explicit boolean `checked` |
| `searchHotelAvailabilityParty` | `propertyCode`, `kind`, `query`; optional lookup `options` |
| `selectHotelAvailabilityParty` | `kind`, current `searchId`, explicit `nativeId` |
| `cancelHotelAvailabilityParty` | Cancels the current availability party picker |
| `searchRoomTypes`, `searchRatePlans` | Optional `query`, `offset`, `limit` |
| `inspectRoomRateCandidate` | Current `searchId` and `nativeId` and/or `code` |
| `selectRoomType` | Current `searchId` and explicit `nativeId` and/or `code`; optional lookup `options` |
| `closeRoomRatePicker` | Closes the current room or rate catalog picker |
| `selectGuestStayRatePlan` | Explicit current rate `code`; optional verified Proof Labtest `guestProfileId` |
| `searchGuestStaySourceBusiness` | Optional description `query`, `field: "description"` and lookup `options` |
| `inspectGuestStaySourceBusiness` | Current `searchId`; optional `nativeCode`, `offset`, `limit` |
| `selectGuestStaySourceBusiness` | Current `searchId` and explicit `nativeCode`; optional lookup `options` |
| `closeGuestStaySourceBusinessPicker` | Closes the current Source of Business picker |
| `readQuote` | `criteria`, optional positive integer `roomQuantity`, `view`, private `snapshotPath` |
| `viewQuoteSnapshot` | Current `snapshotHandle` and bounded `view` filters |
| `closeHotelAvailability` | Closes the availability iframe and verifies the blank-confirmation draft |
| `saveNewLabtestStay` | Labtest-only: `preimageId`, `arrival`, `departure`, `guestId`, `roomType`, `ratePlan`, `guaranteeType`, `note`; optional `createFieldProof` with any `adultSelection`, `childAgeSelection`, `sourceSelection` results, and independent top-level `agencySelection` / `organizationSelection` results |

Guest searches invalidate earlier guest search IDs; inspection, selection and
closing use the current picker. The availability party kinds are `organization`,
`bookingAgency` and `group`. Select a current candidate there before supplying
its ID in the quote criteria's `partyContext`. The session never chooses a
guest, party, dropdown value or CMS code. See [guest-profile.md](./guest-profile.md),
[guest-stay-form.md](./guest-stay-form.md) and
[hotel-availability.md](./hotel-availability.md) for supported inputs and
uncertain outcomes.

### Opt-in Labtest save session

For a new fake HRCEN Proof Labtest stay in 2027 or later, start the session with
`--jsonl --labtest-arrival YYYY-MM-DD --labtest-departure YYYY-MM-DD`. Before
opening the blank form, it searches the same page for matching fake stays. The
private `ready` event contains `labtestPreimage`, including the current
single-use `preimageId`, expiry and candidate context. A non-clear search ends
startup with its result in the private error output; no blank form is opened.
Both stdout and stderr must therefore stay private.

Prepare the verified fake guest, dates, room, rate, source, occupancy, NGI
guarantee and synthetic note using the normal session tools. Then pass the
preimage ID and the matching explicit values to `saveNewLabtestStay`. The normal
session rejects that action; it never enables general booking writes. The proof
is bound to its page and dates and can expire or be invalidated. Independently
reopen and verify the confirmation, and reconcile any uncertain outcome before
trying another write. See [guest-stay-save.md](./guest-stay-save.md) for all
guards and the limits of browser-side email observations.

Each strict create option is independent. Pass the corresponding helper result
directly: `adultSelection` from `selectGuestStayDropdown`, including its current
profile token; `childAgeSelection` from `setGuestStayChildAges` (empty, one, or
multiple ages); `sourceSelection` from Source of Business selection; and/or the
top-level `agencySelection` and `organizationSelection` from their current
search-bound selectors. Agency must carry the picker's reference value or
explicit `null`, with both reference properties present and correlated between
the current response and grid row. Its `agencyReferenceEvidence` reports
`response_grid_correlated` for each field; a missing or mismatched property
blocks selection. A blank is accepted only when the draft and outgoing request
also prove blank. None of the other selections implies an agency, source or
child selection.

The programmatic equivalent passes `{labtestDates: {arrival, departure}}` to
`withBookingLookupSession`. The callback receives `labtestPreimage` and the
same sequential `runTool` function. If the search is not clear, the rejected
error has `phase: 'labtest_preimage'` and its private result in
`error.labtestPreimage`.

Room and Source of Business actions use the current picker and require an
explicit selection. Source selection verifies the description; independent
native-code form readback is unsupported. Rate Plan search reads the Rate Shop
catalog, not a quote or a draft rate selection. Closing Rate Shop can leave its
server-side session cancel unverified. See
[guest-stay-room-rate.md](./guest-stay-room-rate.md) and
[guest-stay-source-business.md](./guest-stay-source-business.md) for details.
`selectGuestStayRatePlan` sets an unsaved draft rate with response and form
readback. After selecting the verified Proof Labtest profile, pass its current native ID as
`guestProfileId`; see [guest-stay-rate-plan.md](./guest-stay-rate-plan.md) for
its guards and evidence limits.

`readQuote` uses [quote-read.mjs](./quote-read.mjs) unchanged: the caller
supplies explicit criteria, a view object and a new snapshot path
in a private caller-owned directory outside any Git worktree. The path's parent
is resolved before the boundary check; the snapshot is written once with mode
`0600`. The response contains a bounded quote view and snapshot path, never the
full availability snapshot. It also returns an opaque `snapshotHandle` for this
session, including when the snapshot was saved but the first projection failed.
View defaults and limits are described in
[availability-view.md](./availability-view.md). Supply `roomQuantity` either at
the top level or in criteria; if omitted, the view reports
`ROOM_QUANTITY_UNKNOWN`. Quantity means a count check, not a hold or combined
availability. Separate searches need separate paths.

`viewQuoteSnapshot` re-projects a snapshot created by `readQuote` on the same
page without contacting HMS. Its `view` accepts `roomTypes`, `ratePlans`,
`offset`, `limit`, `nightOffset`, `nightLimit` and `includeNightlyValueSum`; it
retains the original room quantity or unknown and rejects any other view key or
snapshot path. The optional sum is not a final stay total; see
[quote-view.md](./quote-view.md) for its basis and limits. Handles expire when
the page closes and cannot address snapshots from another session. The private
file must remain present, mode `0600` and unchanged: a content hash detects
replacement, and symlinks are rejected. A successful projection has top-level
`outcome: "ok"`; both top-level `snapshotOutcome` and `view.outcome` report
whether the saved search was `criteria_unavailable`.

`closeHotelAvailability` only acts on the current Guest Stay iframe's unique
native Close button. An unexpected dialog or a nonblank confirmation prevents
the click. After a click, `closed_unsaved` requires the iframe to disappear and
the HRCEN blank-confirmation form to read back. `close_uncertain` means the
click may have happened; inspect the form before continuing. It does not
resolve unexpected dialogs or save the form. If a native dialog appears, page
actions fail with `UNEXPECTED_DIALOG`; memory and saved-snapshot projections
remain available, and `quit` closes the session.

The form module's observed coverage is narrower than its complete list of
supported fields; consult its live-coverage note before relying on an untested
text field or guarantee type.

Guest Stay agency, organization and A/R selections also accept
`selection: {nativeId, searchId}`. They return the
underlying selection result, including its form readback and changed fields.
After a failed selection interaction, the change may have occurred and the page
is quarantined for further fenced actions. Use `readGuestStay` if useful, then
start a fresh session before selecting again. Readback includes any automatically
handled Notes.
A blocked form read returns `FORM_READ_TIMEOUT`;
unexpected dialogs are left untouched. Results retain all candidates, search IDs, raw
response and grid details, coverage and truncation flags. Search again to
refine; selection requires the latest matching live search.

The old names `memory`, `agency`, `organization`, `arAccount`, and
`selectAgency` remain available. `selectAgency` accepts the legacy top-level
`nativeId` without a search ID and checks it against the latest live grid. If
provided, a top-level `searchId` is checked too.

Memory is optional and independent of live searches. By default the CLI tries
the established private corpus under `HMS_MEMORY_DATA_DIR`, or its historical
local default: `stay360-1a-1b-1c-20261029-run01.json` and
`centurion-outbound-pdf-records-2026-10-29.jsonl`. Set `HMS_MEMORY_PMS_PATH` to
an explicit snapshot and optionally `HMS_MEMORY_OUTBOUND_PATH` to message/PDF
JSONL; a snapshot without a message file has no address evidence. Inputs must
already be partitioned to HRCEN; missing property metadata cannot be verified.
Missing or invalid files return `unavailable`, not an empty match. An address
query returns `unavailable` with the raw result and linkage when no linked
address evidence exists for its requested role. Other roles cannot establish
availability; when role evidence exists, a zero-match result is returned as
such. Query options pass directly to the memory API: defaults are 25
candidates and conflicts, 20 evidence records, all supported business sources,
and the `outbound-recipient` address role when none is specified.
Results preserve role, source, conflict and truncation signals. See
[hms-booking-memory.md](./hms-booking-memory.md) for input and query details.

For composition, import `withBookingLookupSession` and call the provided `runTool`
sequentially inside its callback. Pass `{memory}` for an already-loaded HRCEN
memory, `{memory: null}` to disable it, or `{memorySources}` with the paths
accepted by `loadHmsBookingMemory`. The callback receives the page and can use
the exported `runBookingLookupTool({page, memory}, request)` directly;
`runPartyTool` remains an alias. Memory queries also work without a page. The
callback must finish before the page is closed. Callers supplying their own
page must install `installReadOnlyGuard(page.context())` and open a blank Guest
Stay before live calls; they own the page lifecycle. Page-backed queries reject
memory for a different property.
