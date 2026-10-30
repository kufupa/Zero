---
name: building-hms-playwright-tools
description: Use when building or extending PMS Playwright read or write flows, especially Centurion Stay 360.
---

# Building PMS flows

Build quickly with Codex and Playwright driving the actual PMS. Use the owner’s requested behavior and context; clarify when needed. Give each useful read or action a module with explicit inputs and structured results; compose longer flows on the same page/session where useful. Return options for unresolved identities instead of guessing. Prefer headless Chromium; screenshots still work. Use headed when useful or requested.

New cloud tools are being organized under `apps/server-pilot/tooling/hms-cloud/`; preserve compatible existing imports in `playwright-quote/`. Check which modules are present in the current checkout:

- `centurion-stay360.mjs`: browser, login and Stay 360 lifecycle.
- `stay360-notes.mjs`: automatically closes and privately captures Notes popups; other dialogs stay untouched. The shared browser installs it; install it on any other page setup. Use `takeHandledNotes(page)` to include automatic captures in a reader's output.
- `stay360-confirmation.mjs`, `stay360-record-view.mjs`, `stay360-guest-details.mjs`: composable shallow, record and guest readers. `hms-readers.mjs` exposes them as `readShallow`, `readRecord`, `readGuest` (when present); prior filenames and result keys remain compatible. Shallow accepts optional name/date and returns options for ambiguous matches.
- `stay360-guest-form.mjs`: after `readGuest`, select each loaded guest row and read its detailed form; `readGuestForm` exposes it. `stay360-record-tabs.mjs` verifies the open stay and navigates a record tab; Guest Details, `stay360-documents.mjs` and `stay360-associated-reservations.mjs` use it (when present). Documents and associated reservations are separate readers. `read-*-ui.mjs` runners compose these on one page.
- `stay360-lookup-cli.mjs`: shared JSON input and structured lookup-error output.
- `hms-cloud/lookup.mjs` (when present): live agency, organization and A/R searches on an unsaved Guest Stay, with explicit agency and organization selection. `hms-party-search.mjs` preserves older imports; `hms-party-session.mjs` is a same-session JSONL runner when present.
- `hms-booking-memory.mjs` (when present): query prior observed party combinations by email, domain or name, with optional evidence.
- `hms-cloud/hotel-availability.mjs` (when present): read dated inventory and prices for specified room types and rates, or load their picker catalogs; retain the full private snapshot and optionally filter the agent view.
- `create-lab-stay.mjs`, `amend-stay.mjs`, and `write-cli-lease.mjs`: existing write-workflow references; check their actual coverage before reuse.

Inspect the real UI, build in small stages, and validate the requested behavior in the PMS as directly as practical. For identity lookups, check ambiguous results, blank fields and conflicting hints against real records where available. Skip low-value local test loops; follow the repository's required release checks. Report what was observed and what remains unverified. An observed read field is not proof it is writable.

On Guest Details, the detailed form may remain blank until a guest row is selected. Verify the selected row and matching identity before reading; flag duplicate names when no native ID is available. Loaded rows are not proof that unloaded pages were captured, and detailed forms can contain sensitive identity data. Treat arrival and departure dates as calendar days: converting a local-time date to ISO can shift it by one day.

For dynamic Infor grids, a stale refresh or empty grid is not proof of no matches. Verify the displayed rows belong to the current Run; correlating its response and grid can help. Report errors separately from true zero results and flag capped results so the caller can refine the search. Return native IDs and available distinguishing fields.

On a new HRCEN Guest Stay, the Room Type lookup shows a room catalog; the Rate Plan lookup opens Rate Shop, whose grid can return dated room counts and prices together. It also exposes stay-summary, party, promotion and other controls. Hotel Availability is a separate screen; inspect the actual workflow before assuming the two are interchangeable.

Preserve and report useful loaded fields, labels, search criteria and result coverage; note newly discovered controls and fields even when not yet used. Store raw evidence privately, never credentials in the skill. For broad capped searches, report loaded versus total when known and let the agent refine; paginate when the task needs it rather than dumping the whole catalog by default.

For HRCEN quotes, the hotel directs us to use Hotel Availability because it considers children and produces the correct rate. Its Guests control exposes separate adult and child counts and child-age inputs; a matched live probe showed an age-8 child changed one rate. New Guest Stay has a Hotel Availability toolbar icon; in one probe the overlay used different dates/occupancy from the draft, so set and verify criteria explicitly. Treat other availability screens as separate workflows, not interchangeable quote sources.

On cloud Hotel Availability, room-type and rate-plan filters use checkbox multi-select; the highlighted row is not the checked selection. Blank room and rate filters did not mean all options in a tested Preset search. Verify applied values after Submit. A picker can load only part of its catalog (HRCEN showed 50 of 95 rates); report or retrieve the rest. The results grid can include daily room counts and rates; inspect availability, restrictions and useful response fields without assuming they are all visible in the grid.

For one HRCEN Hotel Availability search, loading all picker entries produced 9 room types and 95 rate plans; HMS returned 496 room/rate rows, not the full Cartesian product. Do not infer that an absent combination is unavailable. The visible picker footer gave the loaded and total counts even when the Ext store's total was zero. Verify the submitted property, dates, adults, child ages, room and rate codes, and party context. Preserve the full private response before filtering a smaller view; the current reader does not choose rates, calculate a stay total or apply agency/organization context.

The cloud app menu can be technically visible while positioned outside the viewport, and some menu clicks can be dropped during navigation. Verify that the menu and destination actually opened and use bounded retries. When inspecting an unsaved lookup selection, a 200 response alone does not prove success: inspect HMS messages and confirm the native ID and form readback. A failed or incomplete picker read must not be reported as an empty result.

On Associated Reservations, a row can represent the current stay; compare confirmation numbers before treating it as another linked stay. The reported total can be lower than the loaded row count, so do not infer completeness from that total alone.

When an unsaved selection is authorized, choose an explicit ID from current results and read back the selection and dependent fields; the UI may send a server request before Save. Historical PMS choices are evidence, not guaranteed current matches. Keep observed blanks distinct from missing values, and label address roles: an outbound recipient does not establish the inbound sender. Preserve link provenance and conflicts: an attachment match can carry forward an earlier filename or subject inference.

Follow `PRODUCT.md` and current workspace instructions: an agent may read real guests, but writes only to Labtest. Keep credentials and guest values out of logs, comments and this skill.

After a building session, discuss what worked, what failed, and what to change. Update relevant skill copies when a reusable lesson or module materially changes; preserve concurrent work and avoid overgeneralizing from one run.

For historical UI pitfalls, see [references/traps.md](references/traps.md); verify old observations against the current cloud UI and ignore dated model-routing mandates.
