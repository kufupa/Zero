---
title: Cloud HMS Quote Preparation and Reusable Tools - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Cloud HMS Quote Preparation and Reusable Tools - Plan

## Goal Capsule

Build and compose the highest-value **Cloud HMS Playwright tools** for quote preparation and later booking/amendment: use an agent and small scripts to search live HMS, inspect candidates, select on an unsaved form, read prices and inventory, and return useful structured results. The coding agent is the workflow brain for this run. Tools must work individually and on the same authenticated page where appropriate; do not build a workflow framework before the interactions work.

The owner wants the 1A/1B/1C method: inspect the real Cloud UI, build quickly, demonstrate one real case, expand to representative cases and larger parallel batches when useful, then iterate. Write focused diagnostics when useful; do not invent mock tests, accuracy targets, process rituals, or an elaborate framework. Explore unknowns just enough to unlock useful code, and adjust direction when evidence changes. Elapsed time is a checkpoint for reassessment, not a reason to burn time or stop early. The owner authorizes real-guest reads and Labtest writes as specified in `PRODUCT.md`; production guest writes, sending and deployment have separate boundaries.

Product and safety authority: [PRODUCT.md](../../../PRODUCT.md), [product details](../../context/PRODUCT-DETAIL.md), current owner instructions, and the repository's `AGENTS.md`. HMS is the system of record. Real-guest reads and fake `Proof Labtest` writes for 2027+ are allowed. Avoid sending mail: the owner specifically says testing CMS email delivery is unnecessary for this run. If a truly necessary Labtest message is sent, the only owner-designated recipient is `navaai@legacyhotels.co.za`; a queued email can take roughly 20 minutes. Do not create or edit a real stay, deploy, or enable a workflow based on this plan alone.

## Product Contract

### Requirements

**Quote preparation**

- R1. Preserve request dates, room quantities, occupancy, child ages, guest names and party clues, and requested rates or meals with source and missing/conflicting information. Represent multiple date ranges or requested scenarios separately. Avoid treating quantity text such as `x2` as a guest surname. A new request-parser application is not required in this run.
- R2. Find live agency and organization candidates when relevant, informed by historical evidence; preserve distinguishing details and allow search, refinement and explicit selection.
- R3. Search the client-specified **Hotel Availability** screen for current rates and room inventory, including actual child ages, criteria applied and restrictions.
- R4. Preserve the full useful response privately and provide the agent a smaller, expandable view with its scope, observation time, relevant warnings and uncertainty.
- R5. Support multiple requested rooms and occupancy combinations without claiming that separate searches prove combined inventory.
- R6. Prepare shared quote facts that can later support the pane, copyable text, Excel/PDF and an editable unsent reply; no booking is required to obtain a quote. Actual app/pane integration and document generation are deferred by the owner for this tool-building run.
- R7. Return enough structured information to rank available options first and later show zero-inventory and HMS-closed options disabled at the bottom of a dropdown with their reason. Do not auto-recommend or prefill them as available. The actual dropdown is deferred.
- R8. Carry the same reusable reads and field-selection primitives into later booking and amendment work without making those workflows dependencies of the first quote.

**Agent and memory**

- R9. Provide a repeatable agent loop: query history, inspect live candidates, narrow the search, select a current candidate, verify the resulting screen, and ask for help or retain ambiguity when needed.
- R10. Retain native candidate IDs and other HMS details that may help distinguish entities. Keep public agent results bounded, and keep raw sensitive records private and property-scoped.
- R11. Label historical source, address role, conflicts and observation provenance. Historical bookings inform ranking; they do not prove the current live choice or the sender of the original inbound request.
- R12. Make current interfaces easy to call in different orders without requiring a rigid, invented workflow.

**Delivery**

- R13. Exercise the actual Cloud HMS screens with headless Chromium and compare returned results with what HMS shows. Use approved existing remote checks and review requirements; do not add small local tests solely to increase test count.
- R14. Use visible Orca child worktrees and well-briefed Codex agents where independent work saves time; assign one owner to shared files and integrate coherent slices without waiting for unrelated work. Start additional lanes as dependencies clear rather than launching them merely for symmetry.

### Scope and current product baseline

**Owner scope update, 30 October:** focus on practical standalone Cloud tools and a composed, real-HMS script that acts as the agent. App/pane integration, production database design, automatic staff-correction learning, product-scale accuracy evaluation, and Associated Reservations are deferred. Preserve the original product requirements above as future context; do not claim the staff-facing product is done. The owner wants useful tools reusable in quote, create and later amendment workflows; do not hard-code rate/agency mappings or build an unnecessary framework. The owner may broaden or reprioritize based on live discoveries without rewriting the plan first.

The product baseline says: agency/company is not named in the reply body; BAR is bed and breakfast, with dinner as a hotel-specific add-on; when fully booked the default reply is a one-line decline; an alternative enters the reply only when staff choose “Use this”. Quote contact is separate from the agency/company field. The pane must work in both Outlook and webmail. Nava prepares drafts and never sends. Management-approved discounts require the appropriate authorization evidence. These are current product rules, not claims about what code already does.

The owner wants the same pre-lookup to support the different outputs staff use. Quote text, a spreadsheet/PDF and a PMS confirmation may share facts, but a confirmation can involve creating a real reservation and possibly other HMS actions. Establish the actual client workflow and trigger before treating it as another output format; quote preparation itself must not create a booking.

Examples from saved email journeys: one conference requester asked for dinner and B&B; a rate negotiation needed management input; another requester asked for three single rooms and staff quoted per room per night. These show why meal terms, negotiation and multi-room requests matter, not that today's price can be reconstructed from old mail.

## Planning Contract

### Facts, decisions and unknowns

1. **Correct screen.** The client explicitly said staff use Hotel Availability because it handles children and gives the correct quote; they rejected “room type and availability”. The new Cloud reader opens Hotel Availability from the menu. A separate live probe also opened Hotel Availability as an overlay using the toolbar icon on a new Guest Stay. The draft survived closing the overlay. At planning time, selecting a rate on the draft was unproved; it has since been demonstrated separately as recorded below. An older app driver navigates to Room Type and Rate Availability; whether that path is currently active is unverified. Do not use it as the new quote source or allow it as an unnoticed fallback.
2. **What “children's ages” means.** The input is a list of actual ages, such as `[8, 12]` for two children. It is not a request for an age-range display. In one matched live comparison, a child aged eight changed BARRO from ZAR 1,930 to 2,020; another rate was unchanged. Do not turn that one observation into a pricing rule. Missing ages must stay missing, or a separately labelled hypothetical scenario must be requested.
3. **Prices are not availability.** A room returned a price when its inventory was zero on one night. Another had inventory but a priced rate marked red/Closed. One broad snapshot had 54 closed/restricted priced cells among 496 returned rows; the response could still contain `israteavailable: true`. Preserve inventory, `closed`, `restricted`, the native flag and any visible warning separately; do not derive bookability from a single flag. The owner wants unavailable options visible but disabled at the bottom of the dropdown, with their reason; they must not be auto-recommended or selected.
4. **Current criteria must be set and verified.** The Hotel Availability overlay opened from a new Guest Stay with dates and occupancy different from that draft. The party selected on a Guest Stay is not proof that it was applied to Hotel Availability. Verify property, dates, adults, child ages, room/rate filters, party selections and relevant settings against the actual applied screen/request.
5. **Broad searches require measurement.** Blank filters did not mean all. A broad one-night capture selected nine room types and 95 rate plans and returned 496 rows, about 0.66 MB of JSON. Catalog coverage and returned row coverage are distinct; an absent pair is not automatically sold out. Compare all-catalog and targeted searches for latency and completeness before picking a default. Keep the captured result available for later filtering.
6. **Memory is evidence.** The current Cloud memory supports E-Mail, Voice Call and Call Center; exact address/domain and explicit address role can be queried. Among 612 historical stays in those sources, 350 had an agency, 452 an organization and 150 an A/R account. In the 492 E-Mail-source records, seven rate plans accounted for 483 stays, and STQN plus STWN accounted for 360. These are useful prioritization signals, not guarantees for a new request. Most historical records are later PMS snapshots linked to outbound confirmation recipients, not proven inbound senders or decisions at booking time. Preserve conflicts and counts; do not hard-code a booking agency, organization, A/R account, room or rate from history. Automatic learning from staff corrections is not built.
7. **Lookup is already real but surface-specific.** The new `lookup.mjs` searches and selects primary booking agency, organization and A/R on an unsaved Guest Stay. It returns candidates and coverage; selection binds a native ID to a current `searchId`, then reads fields back. A new search invalidates the old selection token. Selection can send a field-change request, so it is an unsaved form interaction, not a pure network read. Selecting an unsaved field is different from saving a stay.
8. **Use one page safely; parallelize separate browsers.** Keep the authenticated session and property owned by the caller; serialize actions on one page. The owner has successfully run 12–30 standalone headless read browsers and wants approximately 12 concurrent across this run, with roughly three per lane as a planning guideline, not a new rigid worker limit. Those earlier reads do not prove that two *unsaved forms* using the same login have isolated server-side state. Before parallel stateful-form exploration, cheaply compare two blank sessions and read back their separate criteria; adapt if they interfere. This is not a ban on the already exercised concurrent read paths. Check host capacity and account for browsers started by other work; track and clean up only processes this run owns. The old app's per-property read lock is out of scope: do not build or wait on it for standalone Cloud tools, and do not change the other application's lock during this run.
9. **Cloud tools vs later app work.** Playwright 1.63 is merged in #749 and a standalone live Cloud search passed. The Cloud `.mjs` files and nested Stagehand package are not proven packaged in the server app, and an older app facade uses the wrong screen. App integration and packaging are deferred, so neither is on this run's critical path. Deploy Chromium/proof updates only when deployment is actually needed; there is no reason to deploy for standalone browser development.
10. **Freshness is two questions.** A snapshot becomes inapplicable when its property, dates, occupancy, party or filters change. Even if its criteria match, live prices and inventory may have changed since it was observed. Preserve the old observation for comparison, label it with time and criteria, and re-check when the workflow needs current data; do not invent an unverified freshness guarantee.

### Intended components and example contracts

These contracts describe behavior to prove and adapt against the screen; they are not a mandate to add every optional argument or a framework up front.

**Request and occupancy.** One email can contain multiple date ranges and room groups. Illustrative only; the tools can accept one stay scenario at a time rather than requiring this entire envelope:

```json
{
  "propertyCode": "HRCEN",
  "stays": [
    {"arrivalDate": "2026-11-05", "departureDate": "2026-11-07",
     "rooms": [{"quantity": 2, "adultsPerRoom": 1, "childAges": [],
                "guests": [{"firstName": "Example", "lastName": "Guest"}]}]},
    {"arrivalDate": "2026-11-12", "departureDate": "2026-11-13",
     "rooms": [{"quantity": 1, "adultsPerRoom": 2, "childAges": [8], "guests": []}]}
  ],
  "partyHints": {"agency": "XL Nexus", "organization": null},
  "requestedRatePlans": [],
  "sourceMessageRef": "scoped-message-reference"
}
```

Use local calendar dates; the current reader treats departure as exclusive when computing nights, which should be verified against actual HMS rows before computing totals. Separate date ranges may represent separate stays or alternatives; retain that distinction when the source makes it clear and don't guess otherwise. Search each distinct occupancy scenario as required by HMS, retain the requested quantity and relationship to the source email, and distinguish unknown ages from an empty child list. Explicit guest names and a room quantity are different facts: `x2` is not a surname or proof of two known names. Verify whether room inventory supports the total before claiming a joint allocation. Preserve source evidence separately from inferred hints.

**Memory.** The existing session accepts a call such as `{"tool":"queryBookingMemory","query":{"domain":"agency.example","role":"outbound-recipient"},"options":{"sourceOfBusiness":["E-Mail","Voice Call","Call Center"]}}`. It returns supporting agency/organization/A-R combinations, counts, conflicting outcomes and provenance. Query exact address and domain separately. An actual inbound sender, where independently linked, has a different role from an outbound recipient. Resolve choices in live HMS. Automatic staff-correction learning and a shared database are deferred; private JSON/JSONL is sufficient for this run. Existing note/billing-pattern research is useful context for later tools, not a dependency for these lookups.

**Entity search and selection.** Guest Stay has field-named searches for primary booking agency, organization and A/R. Hotel Availability has separate `searchHotelAvailabilityParty` and `selectHotelAvailabilityParty` calls for its own booking agency, organization and group pickers. Return `{outcome, criteria, searchId, candidates, coverage}`, including loaded versus total if known and full useful available candidate details. Outcomes distinguish success, verified zero results, incomplete/truncated data and failure. `selectOrganization({searchId, nativeId})` accepts only a current candidate on the same page and picker; it returns the chosen field plus actual changed and dependent fields after readback. A stale token or uncertain selection is not success. Preserve unsaved drafts while moving between surfaces. A short-lived, scoped server-side handle may be useful at an untrusted agent boundary; do not discard the native identifying details within the trusted tool.

**Hotel Availability.** `searchHotelAvailability({propertyCode, arrivalDate, departureDate, adults, childAges, roomTypes, ratePlans, partyContext})` is the target behavior. Here `partyContext` is shorthand for actual HMS fields: the existing reader documents Group, Organization and Booking Agency on this screen—not an extra user-visible “party” field. At planning time the reader required those fields to be blank; later live work added and verified their selection on this surface, as recorded below. Return the actual applied criteria and a private snapshot or reference, observed time, catalog/row coverage, and a bounded view of rates, inventory and restrictions. Add only inputs the UI supports. Capture raw fields even when the current agent view does not expose them.

**Room and rate catalogs.** The Hotel Availability reader loads that screen's room-type and rate-plan catalogs when passed `"all"` and retains their records with the snapshot. Separate `searchRoomTypes` and `searchRatePlans` tools inspect the Guest Stay catalogs; `selectRoomType` and `selectGuestStayRatePlan` can apply a current choice to a supported unsaved draft. The Guest Stay Rate Shop catalog and the Hotel Availability rate picker are different surfaces: one live example contained 68 and 95 rates respectively. A catalog entry or a selected draft rate is not a date-specific available quote.

**Projection.** The existing `filterHotelAvailability(snapshot, filters)` already provides a smaller view; extend it or add a small `getAvailabilityView({snapshotRef, filters})` only if the composed flow demonstrates a gap. For each relevant option, include its room/rate identifiers, requested dates, nightly counts and displayed prices, currency, restrictions/closed state, applicable source and unknowns. Retain additional HMS data such as tax, meals, cancellation/guarantee and occupancy limits when actually supplied, without guessing absent values. Return a stay/selected-rooms total when HMS provides it, or calculate an explicitly labelled total only when the price basis, taxes, occupancy and room quantities are verified. An optional exact arithmetic sum of the captured nightly values is useful even when that basis is unknown, provided it is not called an official or selected-rooms total and is not multiplied by room quantity. Preserve displayed money text; use exact decimal or integer minor units, never binary floating-point sums. If the basis, tax or combined availability is unknown, preserve the raw prices and say so rather than inventing a total, eligibility or hold.

**Agent loop.** The agent can call history and live search more than once. It can refine “Nexus” after receiving candidate names, IDs and addresses, select the intended current result, read back the applied field, then perform Hotel Availability. If selection cannot be resolved, preserve the candidates and reasoning for a later UI or human. There is no fixed mandatory call order. One page executes actions sequentially; separate standalone authenticated sessions can run in parallel subject to host capacity.

The merged JSONL session accepts one object per line and returns a result before the next action. For example, an agent can query and refine history and live candidates, select one, then quote and re-project the saved result:

```jsonl
{"id":"memory","tool":"queryBookingMemory","query":{"domain":"nexustravel.co.za","role":"outbound-recipient"}}
{"id":"agency-search","tool":"searchPrimaryBookingAgency","query":"Nexus"}
{"id":"agency-select","tool":"selectPrimaryBookingAgency","searchId":"<current-search-id>","nativeId":"<chosen-live-id>"}
{"id":"quote","tool":"readQuote","criteria":{"propertyCode":"HRCEN","arrivalDate":"2026-11-05","departureDate":"2026-11-07","adults":2,"childAges":[8],"roomTypes":["STQN","STWN"],"ratePlans":["BAR","NGOVDB"]},"roomQuantity":2,"view":{"roomTypes":["STQN"],"ratePlans":["BAR"],"limit":10,"includeNightlyValueSum":true},"snapshotPath":"<new-file-in-private-directory>"}
{"id":"more","tool":"viewQuoteSnapshot","snapshotHandle":"<quote-handle>","view":{"roomTypes":["STWN"],"ratePlans":["NGOVDB"],"limit":10}}
```

These are illustrative calls, not a real quote. Substitute IDs from the current results. Selecting an agency on Guest Stay does not apply it to Hotel Availability: use `searchHotelAvailabilityParty` and `selectHotelAvailabilityParty` on that screen, then supply the returned ID as the corresponding `criteria.partyContext` field if the quote needs it. After `closeHotelAvailability`, the draft can receive further form actions. `selectGuestStayRatePlan` is also exposed through JSONL; selecting a rate after choosing a guest profile remains unsupported until separately proved.

**Example output shape.** Field names are illustrative and should be adjusted after live inspection:

```json
{
  "snapshotRef": "private-scoped-reference",
  "observedAt": "2026-10-30T12:00:00Z",
  "appliedCriteria": {"propertyCode": "HRCEN", "arrivalDate": "2026-11-05", "departureDate": "2026-11-07", "adults": 2, "childAges": [8]},
  "coverage": {"roomCatalogLoaded": 9, "rateCatalogLoaded": 95, "returnedRows": 496, "completeForRequestedScope": "unknown"},
  "options": [{"roomType": "STQN", "ratePlan": "BAR", "nights": [{"date": "2026-11-05", "roomsAvailable": 0, "displayedPrice": "2,020.00", "currency": "ZAR", "closed": false, "restricted": false}], "warnings": ["zero_inventory"]}]
}
```

The date, rate and counts here illustrate the schema; they are not a real quote. Actual currency precision, total/basis, errors and flags must follow the HMS response. A snapshot reference must be private and scoped to the authorized property/session.

### Parallel execution and integration

Start by comparing requested and applied Hotel Availability criteria, including the actual agency, organization and group controls, and compose the existing login, Guest Stay lookup and availability reader for one useful example. Then fix the real gaps, including picker behavior if required; do not assume selecting a Guest Stay field applies it to the availability search. In parallel, an independent lane can inspect existing saved snapshots and identify projection gaps without modifying the live picker. Once the first picker behavior and shared interface are understood, launch independent guest-profile and Guest Stay field/action work in additional lanes. If actual UI behavior disproves shared assumptions, pivot and update the other lanes rather than forcing one abstraction. No app adapter lane is required for this run.

Use Orca child worktrees so the owner can see each active Codex chat. For browser work use the owner's requested `gpt-6.1-terra` at `max`; cheaper agents are fine for bounded research. Confirm the terminal is created visibly, the TUI is ready, the prompt was accepted and the turn actually started. Use bypass-approval mode only within the owner's authorized scope and existing product boundaries. One lane owns each shared file; unrelated lanes can iterate concurrently. Track the browsers each lane starts and keep total intended simultaneous Chromium runs around 12, adapting to actual shared-host load.

Give every lane this plan, the current product rules, relevant Cloud documentation, its narrow goal and file ownership, existing versus proposed behavior, the right screen, real-read/Labtest authority, headless preference, private evidence paths, and speed/live-verification philosophy. Ask for examples, evidence, remaining issues and commit. Share discoveries that change the interface immediately; never drive one page from two lanes at once. Keep concise durable checkpoints so compaction doesn't erase the design context. Use a self-review checkpoint at approximately 1.5 times a provisional task estimate and reassess/pivot around twice that estimate; these are prompts to investigate, not hard deadlines or automatic failure.

Prepare substantive code slices for review as soon as each is coherent; run relevant independent checks and Greptile Apex concurrently where safe, then integrate without serializing unrelated work. Fix genuine P0/P1s and explain dismissed non-material feedback. The owner explicitly exempts simple documentation and straightforward version changes from a ceremonial PR/Apex cycle. Do not start multiple overlapping branches that all rewrite the same helper.

Estimated product-code sizes are rough planning guides, not promises: small behavior slices may be around 100–400 changed lines; the existing `lookup.mjs` is about 523 lines and the Hotel Availability module about 341 lines. Measure the actual diff and honor the repository's approximately 500-product-line gate, including its authorized pure-move exception.

## Implementation Units

### U1. Confirm live Hotel Availability party and search behavior

- **Goal:** Establish applied Hotel Availability criteria and compose one useful quote read, then search and apply agency/organization/group controls when supported and useful.
- **Requirements:** R2, R3, R9, R12, R13.
- **Dependencies:** Existing Cloud login, lookup and Hotel Availability reader; authenticated session.
- **Files:** `apps/server-pilot/tooling/hms-cloud/lookup.mjs`, `hotel-availability.mjs`, `booking-lookup-session.mjs`, related Cloud documentation.
- **Approach:** Compare requested and actual property, dates, adults, child ages, room/rate filters and any party fields on both menu and Guest Stay overlay paths as appropriate. Compose the current search and reader once. Probe the first useful picker end to end, including candidates, refinement, selection, cancel and submitted/read-back IDs, and compare whether it changes the results. Add surface-aware search/select only where proven, keeping current Guest Stay behavior and unsaved form intact. Once the first pattern is clear, parallelize remaining independent pickers where useful. Capture the broader response and criteria.
- **Patterns to follow:** Current search ID/native ID binding, explicit uncertain outcome, verified readback and headless browser tooling.
- **Test scenarios:** ambiguous search then refine; successful selection; no match; stale token; blank versus applied party; child and adult-only searches; return to a form without losing its state.
- **Verification:** Compare live screen, request criteria and returned fields; run applicable approved remote checks for changed product code.

### U2. Retain and project useful quote data

- **Goal:** Turn a scoped private snapshot into concise, expandable quote information without dropping material HMS data.
- **Requirements:** R3–R7, R10, R13.
- **Dependencies:** Existing Cloud snapshots; agreed data shape from U1 when party context is added.
- **Files:** New small Cloud quote projection module and its usage/docs; avoid owning U1 shared files.
- **Approach:** Start with the existing snapshot and `filterHotelAvailability`; add a new projection module only if the real consumer needs more. Preserve raw snapshot and criteria; project by room, rate and occupancy. Keep inventory and all vendor restrictions independent. Retain room quantities and show unmatched or incomplete scope. Return an authoritative HMS total when present, or an exact clearly labelled computed total only when price basis, taxes, occupancy and quantity are established. Separately, a labelled arithmetic nightly sum may be returned without claiming that it is that total.
- **Patterns to follow:** `filterHotelAvailability` and observed native response fields.
- **Test scenarios:** normal available rate; zero stock with a price; closed/restricted rate with stock; missing row; multi-night and mixed-occupancy requests; unsupported price-basis or missing child age.
- **Verification:** Compare projected values with a private raw snapshot and the live UI; do not treat a few examples as a production accuracy result.

### U3. Connect the agent and app to the Cloud path

**Deferred by the owner for this run.** Retained as future context; it does not block the tool build, and its app/property-lock investigation is not an active lane.

- **Goal:** Make an authenticated, property-scoped agent session call the new reads and produce quote facts for the product.
- **Requirements:** R6, R8–R12, R14.
- **Dependencies:** Cloud package/runtime availability, session/property authority, U1 and U2 contracts.
- **Files:** New or focused server adapter and candidate-agent seam under `apps/server-pilot/src/`; runtime packaging/install configuration as required; pane integration on both surfaces when the seam works.
- **Approach:** Inspect and fence the existing OSRRAV path; bridge to the Cloud implementation, retain page/session state and private snapshot handles, and pass evidence and options to the existing editable quote experience. Where feasible, record actual staff choices separately from suggestions and PMS-confirmed saves. Measure the property lock and actual concurrency before changing either.
- **Patterns to follow:** Existing server authentication, property scoping, release controls and product UI. Treat the older HMS driver as research only.
- **Test scenarios:** complete quote read from an incoming request; no-match, ambiguous and retry; wrong property/session; snapshot criteria change; runtime/browser restart; unavailable price; current app path versus expected screen.
- **Verification:** Run the actual packaged app path and applicable remote tests/typecheck on the final head. Demonstrate that it cannot silently fall back to Room Type and Rate Availability.

### U4. Add complementary reusable lookups where evidence supports them

- **Goal:** Make useful quote/booking primitives available without inventing rigid workflows.
- **Requirements:** R2, R8, R9, R12–R14.
- **Dependencies:** U1's shared helper ownership where applicable; independent read-only exploration can start immediately.
- **Files:** Focused modules under `apps/server-pilot/tooling/hms-cloud/` and their integration where justified.
- **Approach:** Explore guest-profile search/select, groups, and room/rate catalogs and selection in the real UI, prioritizing what helps a useful quote-to-unsaved-stay sequence. Ship focused tools when their inputs, outputs and behavior are established. Organization and A/R selection on a new unsaved stay already exist; do not rebuild them merely because older party code exists elsewhere. A catalog lookup, date/occupancy-specific quote search, and selecting the resulting value on a Guest Stay are distinct actions.
- **Patterns to follow:** Search/refine/select/readback, complete candidate context and state-aware navigation.
- **Test scenarios:** ambiguous and empty candidate searches, multiple relevant fields, changing criteria, unsaved form navigation and explicit selection readback.
- **Verification:** Direct headless HMS examples and applicable approved checks. Defer Associated Reservations unless a real populated example becomes available.

### U5. Ground outcomes in real requests and prepare reviews

- **Goal:** Discover material tool failures quickly using real in-distribution examples; do not claim product accuracy or block on a full staff-facing evaluation.
- **Requirements:** R1–R14 as applicable to the delivered slices.
- **Dependencies:** One working tool or composed read path and suitable existing private corpus examples.
- **Files:** Focused change documentation and private evidence in the approved research storage, not guest data in Git.
- **Approach:** Start with one live example, then sample diverse real confirmations/requests from the existing corpus, scaling to dozens or more when it provides useful coverage. Add private data or diagnostics when needed, without treating unrelated corpus extraction as a prerequisite. Separately retained inbound-to-booking work can be reused. Formal independent accuracy evaluation and staff-facing product bars are deferred, not replaced by these exploratory checks.
- **Patterns to follow:** Existing research provenance and property privacy rules.
- **Test scenarios:** normal agency quote, individual/direct quote, child, multiple rooms, zero inventory, closed rates, conflicting party clues and unknown age.
- **Verification:** Verify live rate and room data contemporaneously. Do not compare an old email's prices against today's HMS inventory as if they were an identical truth set. Report sample size and failures; do not infer a production pass from exploratory samples.

### U6. Compose the unsaved Guest Stay and targeted Labtest actions

- **Goal:** Make the useful fields selectable/fillable in a reusable way and compose them with lookup results, without making a real booking.
- **Requirements:** R1, R2, R8–R10, R12–R14.
- **Dependencies:** Existing Cloud login and unsaved-form guard; U1/U4 where actions depend on new lookups.
- **Files:** Small focused modules and scripts under `apps/server-pilot/tooling/hms-cloud/`, with private diagnostic captures outside Git.
- **Approach:** Inspect the live form, then add useful text/date/occupancy/dropdown actions and explicit agency, organization, A/R, guest-profile, room and rate selections where actually supported. Read back dependent fields. Build the CMS message-ID, recipient and send-checkbox controls as unsaved form actions, but avoid triggering an email; the owner says waiting for mail delivery is not useful here. Only exercise saved writes using the fake `Proof Labtest` profile and a 2027+ stay; check available dates before creating a Labtest. Do not select or overwrite real-guest stays.
- **Patterns to follow:** Existing Cloud `lookup.mjs` current-search/native-ID binding and `readGuestStay` readback; actual UI evidence takes precedence over old tool assumptions.
- **Test scenarios:** Fill and read back a representative unsaved form; refine an ambiguous profile; choose a room/rate from current candidates; read CMS controls without sending; exercise a fake Labtest save only if needed to verify a module.
- **Verification:** Actual headless HMS flow and private readback; record attempted and completed operations separately. Never claim a save or email occurred from merely filling a field.

## Verification Contract

- Prefer direct headless Chromium checks against the real, correct screen for tool behavior. Record criteria, time, result scope, screenshot/response evidence privately, and whether the observation was read-only or an unsaved interaction.
- Exercise an agency case and a child case end to end, including refined and no-match searches, normal stock, zero stock with a price, and a priced closed rate. Verify exact applied criteria and distinguish partial returns from empty results. Sample more cases when findings justify it.
- For this run, prove a composed CLI/script path across relevant Cloud modules. A future application integration must separately verify its packaged runtime and agent-to-screen-to-projection path; it is not required now. No staff-facing activation until the old wrong-screen path is addressed and property authority and product gates are satisfied.
- Run typechecks through `bash /home/orca/bin/remote-typecheck.sh <clean worktree>` and applicable tests through the approved Product EC2 route; no local repo-wide lint/format or typecheck. Unset database test variables as required; never use pilot RDS.
- On 2026-10-30 the remote Vitest wrapper printed zero despite one failed test because `systemd-run` expanded shell variables before Bash ran them. The VPS helper `/home/orca/bin/remote-vitest.sh` now disables that expansion and preserves typecheck failure. Its dependent `/home/orca/bin/remote-typecheck.sh` also checks whether the requested commit already exists on the remote host, avoiding an empty-bundle failure. Verified on the actual remote route: one existing test file passed (21 tests); an intentionally nonexistent test path returned exit 1. These are host-script changes, not repository commits. Continue to inspect the actual summary as well as status.
- The owner clarified on 30 October that straightforward upgrades should use focused checks and a simple commit/merge, without automatically requiring a PR and Apex review. For substantive feature PRs, run applicable independent same-head remote tests and typecheck, obtain the required Greptile Apex result and hosted review, validate P0/P1 findings, have the coordinator read the product diff, then use `scripts/orch/merge-gate.sh`. Re-run relevant gates when the final head changes. Dismiss non-material findings only with a reason; do not create test padding.
- The Playwright update changes Chromium and HMS proof fingerprints. A future authorized rollout must install the matching browser/revision and refresh applicable proof/release bindings using the approved path. A source update or green test is not a production deployment.
- A 30 October read-only smoke on the upgrade branch resolved Playwright 1.63 from the server package and queried Hotel Availability for 5–7 November, two adults and one eight-year-old. The applied request matched, and HMS returned two room rows and four rate rows. This verifies that example, not every browser or production deployment path.

## Definition of Done

- Useful delivered Cloud tools work on the correct live screen for their supported scenarios, expose meaningful coverage and failures, and preserve useful evidence. A composed script can use them together for a representative real request and unsaved form; unsupported interactions remain explicit.
- Report the tools and real examples completed, failures, private evidence location, commits and remaining work. Integrate coherent code changes under the owner's review direction; no abandoned exploratory code or guest data in tracked diffs. Diagnostics are welcome when reusable and kept separate from production modules.
- Staff-facing pane integration, production deployment, automatic learning and product accuracy evaluation are explicitly deferred. Do not claim the entire product workflow is done. The accepted 85% quote recall target belongs to the scoped 2026-10-20 plan, not every future workflow.

## Appendix

### Review and schedule evidence

For the last 12 Cloud HMS PRs, the first opened to the last merged spanned 90.75 minutes; the last opened about 78 minutes after the first. Median open-to-merge was 18.2 minutes. Hosted Greptile checks on final heads had a 2.9-minute median and a 2.0–3.8-minute range. One availability PR took about 55 minutes and contained real fixes and merges. These figures do **not** include all prior design, live probing or code preparation and do not measure Apex CLI latency.

As further examples, PR open-to-merge was about 7 minutes for shallow read (#718), 33 for record view (#719), 17 for guest details (#730), and 49 for shared organization selection (#734). Each excludes the unrecorded work before the PR. They establish plausible review-and-fix time, not a reliable coding rate.

The earlier 5–10-hour spine and 8–15-hour wider estimate included an app adapter, pane integration and product evaluation that the owner has now deferred. Withdraw those figures for this tools-only scope. The 29 October conversation gives better but limited comparables: 1b was requested at 18:19:15 UTC and reported built with one live read at 18:24:51 (5m 36s); the corrected 1c child was reported working by 21:47:47 and finished by 21:55:01 (about 7m 14s for that reported interval). These were initial examples, not guarantees of broad reliability: a later ten-browser run exposed timeouts. A 12-browser corpus run from about 23:17 to 00:43 produced 892 successful reads including 46 already present, while investigating date-window and duplicate-confirmation issues. These are distinct workflows and times, not a general coding rate.

**Provisional target, not a promise:** aim to demonstrate the first new picker/action within 15–30 minutes and complete several useful modular tools plus a composed live example in roughly 1–3 hours, with review overlapping where safe. That extrapolates from the unusually fast 1b/1c initial examples, while allowing time for more ambiguous write/selection behavior. A full hundreds-of-stays batch or difficult HMS behavior can extend it; run large reads in parallel only when they add useful coverage. If the first picker takes about twice its provisional window, inspect the cause and adjust the approach instead of blindly waiting. Report actual timings and revise the estimate as evidence arrives.

Use actual completion of useful modules and live examples as checkpoints. When progress is slower than expected, inspect the cause, change the approach or seek a second opinion. Overlap independent implementation, existing checks and review; do not keep a lane alive to fill its allocated time.

Grok 4.7 xhigh reviewed a sanitized earlier plan. Useful critiques adopted here: separate stale criteria from live freshness; verify party on the quote screen; preserve inventory and restrictions even with a price; distinguish catalog from row coverage; and keep missing child ages explicit. Its proposed contract-only PR, hard limit of five tools, default all-catalog query without timing evidence, and blanket multi-room block were rejected. The review did not have live HMS or full repository context.

Grok 4.7 xhigh reviewed this expanded plan again on 30 October. Adopted: start with applied-criteria and composed-read evidence; avoid building a projection abstraction already supplied by the reader; don't infer price totals or joint availability; check two stateful browser sessions for interference before parallel form exploration; bind candidate IDs to the current picker and search; and overlap review only once a coherent change exists. Corrected: the existing `hotel-availability.md` already documents Group, Organization and Booking Agency controls, although selecting and pricing them is unproved. Rejected: stopping after one script, dropping the owner-requested guest-profile/group/CMS modules, a blanket three-browser cap, and forbidding authorized Labtest work. Prioritize those modules based on live evidence and progress, not Grok's narrower scope. Its suggestion to avoid actual mail agrees with the owner. The review was based on the sanitized plan and did not inspect the repository or run HMS.

### Evidence gathered during the build

- The Hotel Availability overlay did not inherit a blank Guest Stay's dates, occupancy or selected organization in a live probe. Set and verify criteria and the chosen agency, organization or group on the availability surface itself. In one comparison, agency and organization did not change the observed cells; that is not a general pricing rule.
- Two concurrently open blank sessions retained different selected organizations. This supports further parallel exploration, but does not establish isolation for every HMS server state. Actions on one page remain sequential.
- Hotel Availability has a Group picker. A separate Guest Stay Group picker has not been built: only 1 of 892 previously read Record Views had a populated Group field ([corpus analysis](memory-experiments/2026-10-30-associated-reservation-search.md)), so it is a lower-priority follow-up for this sample. That does not establish how all multi-room bookings are linked.
- A six-session exploratory run succeeded for adult-only, child and no-match-recovery cases. In one matched two-night child scenario, targeted search took 11.2 seconds for four rate rows; all catalogs took 25.8 seconds for 496 rows. The eight overlapping nightly cells matched. Full session times were 39.4 and 55.7 seconds; the full responses were about 15 KB and 1.0 MB, respectively. These are one comparison, not a production throughput or accuracy guarantee. Retain the broad private snapshot when requested and return bounded views.
- A real broad response contained nightly values and rate-basis classifications, but no explicit stay-total or tax/VAT field. A total remains unverified until its basis is demonstrated; room counts, restriction flags and unknowns must remain separate from price.
- Guest profiles, guest-form controls and room selection were exercised only on blank unsaved forms. The current blank-form guards do not support amending an existing stay; reuse for amendments requires a separately verified existing-stay mode. The Room Type catalog contained nine entries and the Rate Shop catalog 68 in one probe; a catalog does not establish dated availability. Rate selection and transfer into the draft remained unproved at that point. No real stay was saved and no email was sent.
- A later headless Proof Labtest draft for 2027 verified one current rate-plan selection: HMS returned the matching validation and rate-change data, and the displayed and Ext field values matched the selected code. The confirmation remained blank; meal plan, market segment and track also changed. The response did not expose a separate native rate-plan ID. This proves one unsaved form interaction, not a saved rate or a Hotel Availability quote. The reusable rate module merged in #765.
- The bounded quote view can optionally report an exact arithmetic sum of all observed nightly Hotel Availability values, only when the relevant dates, criteria, currency and row identities are verified. In one two-night example, ZAR 2,300 and ZAR 1,810 sum to ZAR 4,110. The result explicitly leaves tax, price and quantity basis, and the official final total unknown; it is not multiplied by the number of rooms or treated as proof of bookability.
- A same-page JSONL experiment queried memory, selected a guest and an availability organization, read a three-night child quote, and returned to the blank draft. A broad result contained 496 rate rows; a second filtered view of the private saved snapshot made no new HMS inquiry. Session-scoped handles, room-quantity preservation and rejection of arbitrary paths or changed snapshot files were exercised. This standalone interface merged in #766; it does not establish application deployment or production accuracy. The page-close handle race was corrected and the rate selector was exposed in #770; real page-close races and a live JSONL rate action were exercised.
- In the existing corpus, 85 successfully read stays had arrival on or after 30 October 2026; 39 were E-Mail, 16 Call Center and 4 Voice Call. These offer real upcoming date/occupancy/room/rate scenarios for a broader live read sample. Compare current submitted criteria and current HMS responses; do not compare old booking prices with today's prices as a correctness test. The observation is time-specific, not a prediction of current availability.
- A diverse, non-random sample of 12 of those stays (8 E-Mail, 3 Call Center, 1 Voice Call; all explicitly adult-only) was searched in 12 headless sessions with two browsers at a time. All 12 returned responses matching the submitted criteria in 2 minutes 15 seconds overall. Among 33 nightly observations, four had zero inventory and three were closed or restricted; one night had both. Current party context and requested room quantity were unknown. These are exploratory tool checks, not a production-accuracy estimate or a comparison with historical prices.
- The agency, organization, A/R and CMS pickers can be closed without choosing a candidate; one live draft verified all four unchanged-form readbacks. HMS also silently filtered a reopened Room Type picker to the room already selected. The reader now clears the verified native filter, reports other unverified filters, and in one same-page check reloaded all nine rooms and selected a different one (#771–#772).
- A Labtest draft selected two different current rate codes in sequence, with matching HMS response and form readbacks; it remained unsaved. Rate changes affected other fields including meal plan. The selector detects changed dates and unexpected profile-creation flags. A later same-page live check selected a rate, selected the verified fake Proof Labtest profile, then selected a different rate through the JSONL session and read both values back; wrong or unproved IDs were refused before network activity. The selected-profile order is supported only for that fake profile on 2027+ dates (#773); other selected profiles remain unsupported. Re-selecting an already selected guest returned an uncertain result when HMS made no guest-change request; do not blindly retry.
- On another unsaved Proof Labtest draft, selecting a rate first and then choosing an explicit fake guest retained both the rate and profile with blank confirmation. Booker name/contact, reservation note and guest email also read back correctly. The first guarantee attempt was blocked and an unexpected dialog was left untouched. A focused follow-up proved a blank-profile fake draft could change between a non-guaranteed option and Guaranteed by Agent, with matching native, submitted and visible readbacks. On final head `146977b`, one draft selected Deposit Requested before agency, organization and A/R and retained all four values; a separate draft selected a guarantee, selected a rate, selected the fake guest and read back all three with a blank confirmation. Trying to change guarantee after the profile correctly returned `unsupported` without sending a request. The guard requires all listed guest, stay and profile IDs blank, including A/R profile ID; this does not yet support arbitrary action order or real-guest changes.
- Review identified a timeout gap: removing a temporary page route can let a delayed rate, guest, party, room or child-age field-change POST pass the weaker context guard. Page-lifetime fences and stricter agency/organization target checks merged in #765, #767, #768 and #769. Live fault probes exercised delayed native requests and refused same-page retries after uncertainty. Start a new Playwright page before retrying; a reload does not clear the quarantine. A request already dispatched to HMS before the timeout may still complete, so inspect the draft or later state rather than assume cancellation.
- An unsaved draft also triggered an unrelated card-entry POST that the shared context guard originally allowed. The guard now blocks the observed cloud-vault origin and handler (#774). On the final head, a real blank-draft session confirmed the normal context guard blocked it while form updates and Rate Shop search/close still worked. This does not validate other card endpoints or older standalone guards.

### Source pointers

- Cloud modules: `apps/server-pilot/tooling/hms-cloud/README.md`, `lookup.mjs`, `hotel-availability.mjs`, `booking-lookup-session.mjs`, `hms-booking-memory.md`, `hms-readers.mjs`.
- Old app seam and concurrency: `apps/server-pilot/src/hms/quote-stay-facade.ts`, `property-read-lock.ts`, `apps/server-pilot/src/ai/candidate-draft-agent.ts`, `worker.ts`.
- Product behavior and evaluation: [PRODUCT.md](../../../PRODUCT.md), [product details](../../context/PRODUCT-DETAIL.md).
- Outbound-grounded journey examples: [quote journeys](corpus-experiments/quote-journeys.md).
- Private corpus and live captures belong in shared private research storage, not the repository.
