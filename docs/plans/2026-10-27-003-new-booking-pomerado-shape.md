---
title: New booking 10/10 (HRDAV + HRCEN), Pomerado-led HMS operations, Infor-mirror pane
date: 2026-10-27
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: owner-ask-280
---

# New booking 10/10 shape

## Ask (280, original words in OWNER-ASKS 278-280 and `docs/context/asks/2026-10-27-pomerado-new-booking-owner-voice.md`)

"literally just copy their [Infor] stuff ... order should pretty much be just what they have in [Infor] ... collapsed because ... less space in the side pane"; "they barely check [rates] ... pretty much always do STO"; "every single room that they request you have to make a new hms booking"; "create booking button at the end of every single room"; "back test ... reading hms tool which just pulls out all the latest fields ... hundred for da vinci and a hundred for centurion"; "surely the goal of pomerado is to replace 1 2 3 and 4 ... only run pomerado"; "build for centurion and davinci"; "Jarat Tours workflow" later; how to code this agentically fast, cheap, safe.

## Evidence

| Claim | Evidence | Source |
|---|---|---|
| Staff book STO/wholesale, not BAR, for agencies | Both screenshots: Rate Plan WSF2B, Market Segment Wholesale, Track STO Rate, Meal Plan Bed & Breakfast NR | Owner screenshots HRDAV (Salute/Vinokur) + HRCEN (Kobo Safaris 8295495790-1) |
| Child bands differ per hotel | HRDAV: Child 0-02, 03-12. HRCEN: Child 0-02, 03-12, **13-17** | Same screenshots; `/tmp/dvrun/e0-newrecord-fields.tsv` (HRDAV child1/child2 only) |
| Guest email = agency email | Both: E-mail Type Primary, address at the agency domain | Screenshots |
| Reservation note carries billing instruction | HRCEN "Awaiting payment - BB to Agent, extras direct"; HRDAV note required on Save | Screenshot; Phase 1 DV install retro |
| Add-Ons live on Record View | HRCEN "Package Item Availability" button under the note; "Add-On Total" field | Screenshot |
| Group/room naming convention exists | HRCEN Last "Room", First "Mediterránea Group" | Screenshot |
| Extraction misreads "SURNAME xN" | Salute: endClient "Vinokur x2" → pane Company; rows 2×1 adult vs booked 1×2 | prod `mail_extraction` 074cc4a1; `.private/2026-10-27-ask278-*` |
| Agency not prepared before open | Background party queued 10:55, never ran; 35 party jobs stuck since 09:01; claim order puts staff_quote first | prod `ai_workflow_run`; `apps/server-pilot/src/ai/run-ledger.ts:719-723` |
| Our HMS read tools are Centurion-shaped | `read-reservation-fields.mjs` fails on HRDAV (`GUEST_STAY_NAV_NO_FRONT_DESK`); OSRESV.HDR broke HRDAV session | 3 read-only loops, `.private/2026-10-27-ask278-*` |
| Pomerado runtime prerequisite | Needs Node ≥24.21 <25; EC2 and VPS run Node 22.23.1 | `pomerado-source-fit.md`; `node --version` both hosts |
| Pomerado generates new operations; does not build on hand-written runners | Minter explores the live site and writes an operation module; standalone host rejects CDP | `.439` `mint/skills.js:184-203`, `standalone/session.js:7-10` |
| Vendor speed claim | "under an hour" / "2× faster" = vendor marketing, unmeasured on HMS | Pomerado homepage |
| Cancel hazard removed for now | `PANE_WRITE_CANCEL_UNPAID=lab` on all 4 procs, 13:5xZ | `/proc` check after ops-restart |

## Patch vs rewrite verdict

Rewrite the **HMS operation layer and the new-booking pane**, keep the spine.

| Layer | Verdict | Who builds |
|---|---|---|
| HMS operations (read Guest Stay, search party, create per room, read back, add-on rows) per hotel | **Keep hand-written create on the critical path** (per-room fan-out already exists, L1). Pomerado = side experiment minting one read op behind a typed contract; promote only after a live read passes (L4: Node 24, own browser + sign-in, provider bridge, 4–8 h unmeasured) | Grok (create fixes); Pomerado side lane |
| Pane new-booking form | **Rewrite** as Infor Record View mirror: Stay column order, dropdowns, child bands per hotel, DD-MMM-YYYY + weekday, rare fields collapsed, one Book per room | Luna UI |
| Extraction schema/prompt | Patch: "SURNAME xN" = guests, no endClient→Company, contact + agency email + board + note | Luna |
| Defaults (rate plan, segment, track, source, guarantee, note) | New: agency's last-used code per hotel from HMS history; no global STO default (L2: STO/net proxy 13% of travel-agent rows, wholesale 0%) | Luna, data from readback backtest |
| Queue, approval, receipts, both surfaces, flags | Keep; fix claim order | Grok (queue) |

Pomerado cannot replace extraction, pane, queue or approval. It replaces the hand-written Playwright runners only.

## Gates

| Gate | Answer |
|---|---|
| G1 | HRDAV + HRCEN both; property from mailbox/registry; unknown fails closed; child bands and required fields per hotel |
| G2 | Per hotel: mint/read canary on one known conf; Labtest create per room via pane Book on deployed SHA; readback equals pane fields |
| G3 | `PANE_WRITE_CREATE=on` today; new catalogue behind a per-hotel switch with readiness (Node 24 host, provider route, descriptor) |
| G4 | 2 failed HMS loops → written DOM diagnosis or park (applied today: HRDAV readback parked after 3) |
| G5 | ETA from research LOC lanes + Pomerado mint measurement; not quoted before mint proof |
| G6 | Canary after last behaviour-changing deploy, per hotel |
| G7 | Staff copy names cause: not set up / HMS down / lock busy / not found / saved-with-warning |
| G8 | Rewrite as above (3rd hotel-shaped special case avoided) |
| G9 | Backtest: extraction vs HMS readback, ≥100 bookings per hotel, staff-created, per-field accuracy; create canary passes per hotel |
| G10 | Holds: Node 24 / Pomerado install on EC2, real-guest writes, sends; Labtest writes allowed |

## Research update (L1–L4, [ask280-lanes](../research/2026-10-27-next-run/ask280-lanes.md))

- One mail → N bookings: supported today (work item `state.stays` map, pane Create per room); fix receipt-key collision (~20 LOC) and child-bearing rooms excluded from create.
- Jarat Tours: agency stay + shuttle handled by transport desk outside HMS; confirm with owner.

## Open frontier (owner)

1. Pomerado-only vs Pomerado + hand-written fallback behind one contract.
2. Approve Node 24 + Pomerado install (VPS first for minting, EC2 later for runtime).
3. Backtest scope: 100 HRDAV + 100 HRCEN staff-created bookings, read-only.
4. Hotel order: parallel minting per hotel slot vs HRDAV first.

## Parked (see 2026-10-27-002 Ask 279 list)

Cancel policy/U15, amend dates/U16, triage subtype labels, header scroll, undo/redo, E4 email proof, webmail env fix, Open HMS link, Jarat Tours workflow (owner to describe), R-SEED, multi-mailbox.

## Ask 281 override (owner, 2026-10-27): Pomerado is the main experiment

Owner overrode the side-lane recommendation. Pomerado mints the HMS operation layer for new booking; extraction, queue and the Infor-mirror pane run in parallel against one shared create-input contract.

### Operation catalogue to mint (per property; HRDAV origin and HRCEN cloud origin differ, so 2 mints each)

| # | Integration name | Authority | Input | Output |
|---|---|---|---|---|
| P1 | `hms_read_stay_<prop>` | read | confirmation (+ arrival) | every Record View field: agency, dates, adults, child bands, room type, rate plan, meal plan, segment, track, source, guarantee, booker, guest, email, note, status |
| P2 | `hms_find_agency_<prop>` | read | name or IATA | rows: id, name, IATA, city, address |
| P3 | `hms_rates_<prop>` | read | dates, adults, child bands, agency | room type × rate plan × nightly price, rooms left |
| P4 | `hms_create_stay_<prop>` | write (Labtest only while minting) | one room = full Record View input (same schema the pane form edits) | confirmation, status |
| P5 | `hms_add_addon_<prop>` | write (Labtest) | confirmation, add-on code, qty, dates | add-on rows |

Order: P1 first (read-only, safest test of the speed claim, also feeds the 100+100 backtest), then P4, P2, P3, P5. Every write mint creates one real Labtest booking; cleanup via existing Labtest cancel.

### Setup facts (verified 2026-10-27)

| Fact | Evidence |
|---|---|
| Pomerado's big-model constant ships as a non-Terra default; patch `models.js:5` to `gpt-6.1-terra` after install (owner: Terra only). Small model `gpt-6-luna` | `dist/typescript/src/models/models.js:5,7` (.439) |
| Gateway already serves `gpt-6.1-terra` and `gpt-6-luna`; point Pomerado at the gateway (`OPENAI_BASE_URL=http://127.0.0.1:4000/v1`), usage logged per call | gateway config.yaml |
| Claude Code Fable slot routes to GPT-6.1 Terra (owner was right) | gateway config line 60-63 |
| Needs Node 24.21+; hosts run 22.23.1 | README prerequisites; `node --version` |
| Own Chromium; integration signs in on every call and asks for login each time | README "Use your integration" |
| Mint asks for login via `provide_input`, so a chat-driven mint would pass the HMS password through the chat model | README "Create an integration" |

### Run protocol (owner 2026-10-27: follow the README, minimal steering)

- Fable 5.1 xhigh chat installs per README, describes each integration in plain language (name, URL, task, example input, authority), then lets Pomerado mint in its own way.
- Chat only: answers Pomerado's questions (incl. login), reports results. No custom harness, no extra review loop during minting.
- Minimum integration set: `hms_read_stay` (read), `hms_rates` (read), `hms_create_booking` (write, Labtest; agency lookup + add-ons inside the create task). Per hotel.
- Prod HMS slot for the minting hotel paused during mints (owner 282).

### Parallel lanes

| Lane | Work | Coder |
|---|---|---|
| POM | Setup + P1→P5 mints both hotels | Fable 5.1 xhigh chat (owner choice) |
| CON | ≤30-line create-input contract (Record View fields) shared by pane + P4 | Luna, first |
| PANE | Infor-mirror form, Book per room, receipt key per room, children | Luna |
| EXT | "x2" = guests, end client ≠ Company, board, contact | Luna |
| Q | Agency lookup before quote prep in claim order | Grok |
| WIRE | Swap runner spawn for `pomerado run` behind the contract; Node 24 on EC2 | Grok, after P4 passes |
