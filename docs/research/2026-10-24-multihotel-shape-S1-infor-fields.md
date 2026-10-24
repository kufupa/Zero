---
date: 2026-10-24
lane: S1 (multi-hotel shape)
model: GPT-6 Luna max (Sonnet slot)
method: read-only code + docs; no prod, HMS or mail
base: origin/main 1656bca50
---

## S1 — multi-hotel field map

**Pane is not yet property-driven end to end.** The HMS quote reader accepts a property code and reads live room/rate rows, and create has property profiles. But the pane still uses Centurion room and rate lists in shared UI code. This inventory covers fields the inspected deterministic contracts and readers map; it does **not** claim every field visible anywhere in HMS. Some readers deliberately ignore unmapped labels.

**Evidence footing:** Read `PRODUCT.md`, `docs/context/ACTIVE.md`, `docs/context/OWNER-ASKS.md`, `docs/research/README.md`, `docs/context/FACTS.md`, `docs/research/CATALOG.md`, and `AGENT.md`. Target worktree was at `1656bca50`, matching `origin/main`.

### 1. Workflow fields

| Workflow | Fields deterministic tools use or return | Pane: shown, prefilled, editable |
|---|---|---|
| **Quote / availability** | Request: property, arrival/departure, room groups (`quantity`, adults, children, child ages), required/preferred room codes, rate codes, bed types, boards and supported features; organization/agency/group context; currency; sales strategy; restricted/alternative switches. Supported feature mappings: refundability, payment method, accessibility, parking, room description. HMS read: property/currency; date columns; room code/label/building/category; rate code/label/currency/symbol; negotiated/restricted/policies/meal-plan/package flags; min/max stay, lead-time, rate-limit and night-inventory fields; nightly price, inventory and availability; bundles; supported closure and min/max-stay restrictions. | Email/staff-note analysis prefills dates, room count/type, adults, children/ages and board, with evidence snippets. Staff can edit stay dates and room/occupancy rows. Rate results show HMS room, rate, board, price and rooms left; staff picks a rate. The meal-plan highlight/filter is **UI-only**; it does not itself change the room row or HMS search. |
| **Create reservation** | Required: arrival, departure, adults, source of business, room type, rate plan, track, first name, last name, guarantee type. Optional: child ages, agency/booking agency, organization, reservation note, booker name/email, A/R account, billing reference, profile ID. Result: confirmation number, status, meal plan, market segment, totals; deposit due/amount remain explicitly unknown. | Quote and mail facts prefill the card. Dates, occupancy, price and meal/rate facts are shown as reference/copy rows; staff can edit room type, guest and party names, source, track, guarantee, note and booker contact. HMS applies its own rate at create; a quoted override is not silently written as the HMS rate. |
| **Amend** | Search uses surname and arrival, optional departure; a confirmation number can identify the booking. Writable allowlist: arrival, departure, adults, children, room type. Current status/guarantee/deposit facts are read for guards, not amended by this allowlist. | Pane shows current versus requested values and has controls for those five supported changes. Requested changes come from the mail and remain staff-reviewable. |
| **Cancel** | Stay lookup can read status, confirmation, first/last name, arrival/departure, nights, adults/children, room type, rate/meal plan, average rate, total, balance, source, guarantee, booking agency, organization and reservation note. Cancellation is a separate write; penalty dialogs are refused. | Pane can show the matched stay facts and cancellation reason/copy, but cancellation preview is disabled in the inspected pane. No real cancellation is implied or authorized. |
| **Attach document** | Requires confirmation number, arrival, PDF file and document name; runner checks stay identity, uploads, then reads the document list back. | Voucher pane extracts guest/file details, searches for a matching booking and offers attach only when match, PDF, work item and write capability are present. Otherwise staff can download the file. No automatic attach. |

### 2. Property-specific requiredness and lists

| Area | HRCEN | HRDAV | Evidence and caveat |
|---|---|---|---|
| Create requiredness | Common schema-required fields above; profile adds none. | Same common fields; profile additionally requires `reservationnote`. | `create-tool.schema.json` plus property profiles. Profiles do not establish validity for other hotels. |
| Room types | Profile has nine codes with capacities; shared pane matcher maps `STWN`, `STQN`, `SKNG`, `EXKNG`, `DLXTWN`, `DLXQN`, `DLXKNG`, `LUXKNG`, `SUITE` to Centurion names. | Profile has nine different room codes/names, including `JNRSUI`, `EXKNGB`, `EXKNGR`, `EXKNGS`, `DLXPAT`, `DLXKNG`, `ACCES`, `STKNG`, `STWN`. | HRCEN capacities derive from 95 captures plus cited room-count sources; HRDAV names/options derive from two D0 BAR reads. Shared quote room matcher still imports the HRCEN list. |
| Rate / board / strategy | Shared static Centurion rate catalogue has 13 rate codes; only BAR, BARRO and DBB have confirmed board labels there. Pane override choices: `NCOR1B`, `NCOR2B`, `BAR`, `GNC3B`, `GNC4B`, plus free-typed “Other”. | Profile records BAR, BARRO, BLRB, BARDIS, DEF; board labels observed as “Bed &amp; Breakfast R/NR”; nine sales strategies, including BAR, GOV, WS and PRESET. | Static catalogue explicitly is **not** availability or entitlement data. Live HMS labels/rates should remain authoritative. HRDAV fallback room names exist in the rate grid, but not in the shared room selector. |
| Source / track / guarantee | Create contract has fixed source labels, track codes and guarantee labels. | Same contract lists; no property-profile-specific lists recorded. | These are schema-observed lists, not evidence that every value is valid at every property. Draft option route uses active transport property, but inspected profiles do not define these lists. |

The create schema’s source labels are: Booking.com, Call Center, Channel Manager, Consumer, CORPORATE WEB PORTAL, DOTW-XML, E-Mail, Event Specific Booking, Expedia, GDS, Hotelbeds, HyperGuest, Internal, Legacy Hotels, Mobile Message, Parsec-XML, TBOHolidays, TOUR, Tour Operator, Travel Agent, Trip.com, Voice Call, Walk in, Web B2B, Web B2C. Track and guarantee enums are also fixed in that schema; they are not currently maintained in each property profile.

**Centurion-only pane values to unhardcode or explicitly verify:** the nine-code room matcher/list; `CENTURION_RATE_CATALOGUE`; rate override codes and cricket-event hints; and the `room_only` / `bb` / `dinner_bb` board labels. HRDAV’s profile already has different room/rate/board data, but does not drive all these shared controls.

### 3. Gaps ranked by evidence

| Rank | Gap | Evidence and limit |
|---|---|---|
| **1** | Room type is the clearest extraction/prefill risk. | Oct 20 sample: 14/31 room rows had no type. The sole provisional HMS-linked prefill chose `SKNG` instead of `STQN`; it is not a reliability score. |
| **2** | Create defaults are often absent from the mail. | Oct 6 create cohort, `n=91`: source of business absent 31%, adults 25%, guarantee 13%, room type 10%, rate plan 7%, track 3%. These are field-presence figures, not current pane accuracy. |
| **3** | Board/rate context can drift. | Oct 20 sample: 6/31 rows lacked board; two revision-backed DBB requests had B&amp;B revisions. Only one provisional HMS-linked row existed. |
| **4** | Party context is frequent and can be lost between bind and draft. | Oct 6 cohort: party lookup needed in 45–63%. Oct 20: all six saved revisions lacked party context; two also had an agency bind. |
| **Unranked** | Attach/cancel field frequency and hotel-by-hotel requiredness. | Available evidence does not measure these reliably. Do not infer prevalence from tool presence. |

These sources are different cohorts and should not be combined into one accuracy rate: `../../docs/plans/2026-10-06-003-case-coverage-gap-audit.md` and `../../docs/research/2026-10-20-booking-prefill-backtest.md`.

### 4. Per-property registry size — **INFERENCE**

For all five pane workflows to render fields/options from a per-property registry, estimate **450–750 product LOC**, plus **150–300 test/fixture LOC**. Range assumes reusing current forms and deterministic runners, adding typed property metadata for labels/options/requiredness/provenance, wiring it to active-property data, then replacing hard-coded quote/create controls. A narrower quote-and-create-only change is likely smaller. Registry-backed UI would not itself prove HMS write behavior or hotel-specific validity.

**No files changed; no tests, typechecks, prod, SSM, HMS or mail operations run.**

**Running lanes:** S2, DV rate answer key; S3, hotel users/mail mix.  
**Open by ROI:** 1) use S2/S3 evidence to confirm property lists and requirements; 2) define the registry boundary for quote/create fields; 3) separately prove each hotel’s live workflow before calling it ready.
