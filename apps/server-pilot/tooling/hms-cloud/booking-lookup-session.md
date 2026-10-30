# HMS interactive booking lookup session

`booking-lookup-session.mjs` keeps one authenticated HRCEN page and one blank, unsaved
Guest Stay for multiple independent calls. Node 22 is required. It installs the
shared read-only guard. A selection changes the unsaved form and can send a
field-change request; it does not save a booking. Callers choose candidates.

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
| `readGuestStay` | Reads the visible unsaved form, including blank fields |
| `quit` | Closes the session |

Selections also accept `selection: {nativeId, searchId}`. They return the
underlying selection result, including its form readback and changed fields.
`selection_uncertain` means the change may have occurred; use `readGuestStay`
before deciding what to do. Readback includes any automatically handled Notes.
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
