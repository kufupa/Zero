---
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
---

# HMS Add-Ons and shuttle scope

**Status:** Requirements/evidence only. No implementation, live HMS activity, flag change, provider email, deploy, or real-guest write authorized by this document.

## Decision in one line

**Test the property-specific Guest Stay Add-On path first; defer shuttle automation until each hotel's provider, note, and billing rules are evidenced.** Nava already uses deterministic Playwright tools for reservation work, but current source has no structured Add-On row write or shuttle-provider workflow.

## Original ask

Ask ID: not assigned in this checkout. Original wording is logged in `PRODUCT.md:109`.

> “Okay, so there's two features I want to scope out right now. The first one is do we have add-ons working inside of HMS? Are we using deterministic HMS tools yet? Thank you. So specifically what I mean by that is these images come straight from the client where they were showing us that they have inside of the HMS info they have like a specific guest day and that there is a add section for them to add like breakfast dinner tea etc that they can that they can do um they don't do this for the shuttle business the other thing we're going to need to do for the shuttle there's a whole workflow where they just like they email their shuttle provider or some shit it might be different for centurion and davinci i don't actually know we should probably check the previous corpus for that but they I had a meeting with the maloki can't find the transcript but they said that they don't add shuttle add-ons directly into the HMS otherwise it would double book it what they do is they note it down somewhere in the HMS like although also including a shuttle we're not charging them otherwise they get double booked because I think that's how it works but the shuttle people charge them directly. Yeah I think that's how it works but they still like organize it on their side at least for DaVinci so we can do a previous corpus analysis for that.”

## Evidence and product review

| Claim | Evidence | Counterevidence / limit |
|---|---|---|
| Nava uses deterministic HMS tools today. | Product states deterministic Playwright tools; current create path has explicit preview/commit and property-scoped write controls (`PRODUCT.md:9`; `apps/server-pilot/src/ai/pane-stay-save.ts:77-84,109,643`). | This proves only existing reservation paths, not every Infor screen or Add-On flow. Runtime flags were not checked in this scope. |
| Structured Guest Stay Add-Ons are not wired. | No typed Add-On collection in `PaneStay`/`PaneStayChoice`, create schema, property profile or writer; current pane create fills New Record fields (`apps/server-pilot/src/ai/pane-stay-save.ts:55`; `apps/mail/lib/quote-workflow/pane-stay-bind.ts:259,331`; `apps/server-pilot/tooling/playwright-quote/create-tool.schema.json:262`; `create-lab-stay.mjs:998`). Proof only checks stay identity, dates and room (`create-proof-rules.mjs:51`). | This does not mean Infor lacks the feature. Client screenshots show it exists in HMS, but the screenshots/catalog were not available to this source audit. |
| Quote extras are not HMS Add-On rows. | Quote extras include priced Shuttle, Lunch, Dinner and Other; UI captures Shuttle amount/trips and Dinner amount/unit (`apps/mail/lib/quote-workflow/types.ts:472`; `stay-extras-fields.tsx:224,249`). | They do not map HMS item IDs, charge units, dates, or folio behavior. No High Tea path found in scoped source. |
| Current reservation note is not a non-billable shuttle marker. | Note formatter can include priced extras; the create runner passes a `reservationnote` field marked `LIVE-UNVERIFIED` (`apps/mail/lib/quote-workflow/reservation-note.ts:77,186`; `apps/server-pilot/tooling/playwright-quote/create-request.mjs:215`). | Free text neither proves no charge nor books a provider. Do not reuse the priced Shuttle text as non-billable status. |
| Meal requests may be commercially material. | Meals/dinner appeared in 58/93 paired quote asks (62.4%) in one historic quote corpus. | This measures quote demand, not Add-On row use, property availability, or staff time saved. Breakfast may already be included in B&B. |
| Da Vinci has external transport coordination. | Prior interview synthesis describes passenger-to-vehicle matching, a third-party provider, transport-desk request template, and pickup instructions (`docs/research/2026-10-20-arch-lanes/l5-reservationist-workflow.md:31-34,53-60`). | No end-to-end inbound → HMS → provider trace; no exact HMS note/order or direct-provider payment rule (`:4,8,47`). Group transport may be included in an Excel quote and paid on one folio (`:31`). |
| Shuttle is never hotel-billed. | No support found. | Group-charge example is counterevidence to a universal rule; Centurion policy is unknown. Ask #136 is about dated/count-based quote extras, not provider dispatch (`docs/context/OWNER-ASKS.md:265`). Do not encode “never bill through HMS.” |
| Shuttle case mix is large. | Tight lexical screen: Centurion 23/3,599 threads (0.64%); only 2 of 5 Da Vinci mailbox snapshots screened, with 1 tight hit in one snapshot. | Regex-only candidates, not adjudicated; attachments not scanned. 0.64% is not true prevalence. Shuttle automation is not yet ROI-proven. |

**Countercase:** Add-On automation could remove repeated entry for frequent meal requests, but meal-quote evidence does not prove Add-On frequency or pricing. Do-nothing keeps staff in control and avoids wrong items/charges; its cost is manual entry and risk of losing coordination details. Shuttle provider automation is premature: no property-specific workflow, payment proof, or direct-provider trace. The user's shuttle hypothesis may be right for some cases, but available evidence cannot support a universal rule.

## Property and code map

| Area | HRCEN | HRDAV |
|---|---|---|
| Existing create profile | No extra required create fields (`property-profiles/HRCEN.json:16`). | `dinnerAddOn:false`; nonblank `reservationnote` required; `boardCodes` empty; native meal-plan codes unknown (`property-profiles/HRDAV.json:6,18,38,161`). |
| Add-On rows | No item-code or row-field mapping found. | No item-code or row-field mapping found. |
| Create gate | `PANE_WRITE_CREATE`/pane write-mode source exists; live env value unknown. | Also requires `HMS_DAVINCI_CREATE=lab|on` in the existing runtime path (`apps/server-pilot/src/env.ts:284`); deployed value unknown. |
| Live Add-On proof | None found. | None found. Existing Labtest create/cancel proof is not Add-On proof (`docs/context/ACTIVE.md:23` on current main). |

Current Add-On source gap has four pieces: typed request rows; property-specific item/field contract; deterministic UI row writer; and post-write readback/reconciliation. Existing pane lock and CLI lease are reusable (`pane-stay-save.ts:643`; `write-cli-lease.mjs:14`), but a stay-level digest/preview is not idempotency for appended rows (`pane-stay-save.ts:381`). After an ambiguous row save, read back and reconcile each row before retry; handle partial success explicitly.

Shuttle gap is separate: no provider identity/contact, itinerary/status model, request draft, response/confirmation state, or non-billable note semantics. Existing quote UI captures a *priced* shuttle extra; it is not dispatch (`apps/server-pilot/src/ai/staff-quote-workflow.ts:688`).

## G1–G10 requirements gate

| Gate | Filled answer |
|---|---|
| **G1 — Properties and defaults** | First target: HRCEN + HRDAV, each with its own profile/catalog and canary. The writer CLI fails closed for unknown/inactive/omitted property and has no hotel default (`apps/server-pilot/tooling/playwright-quote/write-cli-lease.mjs:1-14`), but this does not prove all pane callers are safe: the 2026-10-23 retro reported HRCEN rooms/rates could appear in the HRDAV pane when property context was missing (`docs/context/ledger/2026-10-23-g1023-retro.md`). Current pane behavior is not reverified. Add a regression test and prove mailbox→pane→writer property identity before canary. Next hotel excluded until separately profiled. Existing HRDAV create gate is an additional dependency; runtime state unknown. |
| **G2 — Per-workflow × property canary** | Add-Ons: after code, one Labtest stay per property, one adult, arrival 2027+, with each supported item/date/quantity written and read back; pass only on exact rows, no duplicates, correct property, and screenshot evidence. Shuttle note/draft: no live-provider send; a staff-reviewed unsent draft plus Labtest note readback only after policy and wording are confirmed. None of these Add-On/shuttle canaries has run. |
| **G3 — Flags/config/readiness** | No Add-On flag or Add-On config exists. Proposed separate `PANE_WRITE_ADDONS=off|lab` (new, not current) must default off, be explicitly forwarded only to intended processes, and must not broaden Create/Amend/Cancel gates. Readiness refuses unless property is explicit/active, its validated profile/catalog is present, its HMS slot/lease resolves, the correct Add-On mode is lab, and all required row fields are supplied. HRDAV additionally needs its existing `HMS_DAVINCI_CREATE` readiness for create. Runtime secrets, process env, slot health, and deployed SHA were not inspected; verify them through the sanctioned operator path before any canary. |
| **G4 — Retry cap** | First live DOM/UI failure triggers screenshot/DOM diagnosis before any retry; do not repeat an unchanged selector. Maximum two live loops for the same flow; if the second fails, park with written diagnosis—no third attempt. This follows `docs/context/MISTAKES.md` and the 2026-10-23 retro (`docs/context/ledger/2026-10-23-g1023-retro.md`). Ambiguous save → read back and reconcile every intended row before any retry. Partial row success must not restart the whole append blindly. |
| **G5 — ETA** | Code-sizing lane estimates: property contract 50–100 product LOC + 40–80 test LOC; typed row write/reconciliation 180–320 product + 120–220 test LOC; shuttle note 40–90 + 40–80; shuttle reviewed-draft UI 100–180 + 80–140. These assume one deterministic UI path and must be re-sized after DOM characterization. A historical planning floor for a new HMS write type is ≥120 minutes to first Save click and ≥180 minutes to first confirmed record, until three clean nights (`docs/solutions/workflow-issues/hms-live-write-preflight-and-long-jobs.md`); this is not an Add-On-specific median or total ETA. **No honest elapsed-to-production ETA:** Add-On live-HMS median, confirmed DOM path, current slot/config proof, and measured deploy/review chain are absent. Recalculate only when those measurements exist; do not multiply an unmeasured guess by ledger ratios. |
| **G6 — Proof freshness** | Record deployed SHA; run property canaries only after the last workflow-changing deploy; any subsequent writer/proof change invalidates both passes. Staff bundle proof applies to pane changes on Outlook and webmail. |
| **G7 — Staff failure copy** | Use cause-class copy on both surfaces: “Add-ons aren’t set up for this hotel”; “Infor is unavailable or busy”; “Couldn’t confirm the add-on saved—check the stay before retrying”; “That item isn’t available for this stay.” Never expose selectors, raw HMS errors, or database details. |
| **G8 — Patch or rewrite** | Do not patch quote-extras or `reservationNote` to imitate structured rows. Add a typed Add-On contract + per-property adapter + dedicated writer/readback reconciliation. Keep shuttle fulfillment, billing, and note state as separate fields. If the two HMS screens differ, add a property adapter—not a growing HRCEN/HRDAV branch in the generic writer. |
| **G9 — Done metric** | Add-On acceptance is exact row-level readback on each property's Labtest canary, zero wrong item/amount/date/quantity and zero duplicates after an ambiguous retry. This proves the write path, not staff ROI or broad workflow accuracy. Build a separate outbound-grounded Add-On truth set before claiming adoption/accuracy. Existing n=58/93 meal quotes is not that truth set. Shuttle acceptance remains blocked on human-adjudicated property policy and a real end-to-end trace. |
| **G10 — Holds/authority** | This document authorizes no code, real-guest write, flag change, provider send, deploy, deletion, or GitHub Action. Future canaries stay Labtest-only; one HMS browser owner; no subagent live HMS driving. No external provider email is sent by Nava. |

## Smallest safe slices

All estimates below are rough source-lane ranges, not elapsed ETAs. Code lane assumes one deterministic UI path; Slice 0 must happen before final implementation sizing. Only Slices 0–3 describe the future Add-On track; this requirements-only document does not authorize starting them. Slices 4–5 are parked shuttle follow-up placeholders, not part of the Add-On release; do not start them before hotel-specific policy and workflow evidence exist. One workflow remains active at a time. No parallel slices share files.

| Slice | Missing / output | Files and LOC | Depends on / pass |
|---|---|---|---|
| **0. Property DOM/catalog discovery** | Current guest-stay Add-On surface, exact native labels/IDs, units, dates/visits, pricing/folio behavior, included-board rules, save/readback boundary for each hotel. | Read-only HMS observation; **0 LOC**. One browser owner, no subagent. | HRCEN and HRDAV separately. Stop after two failed loops; capture DOM/screenshot and park. No item IDs inferred from quote labels. |
| **1. Property capability contract** | Schema validates only catalog-backed Add-On types and property-specific item mappings; fail closed when absent. | `apps/server-pilot/tooling/playwright-quote/property-profiles/{HRCEN,HRDAV}.json`, `property-profile.mjs`, `property-profile.test.mjs`; **50–100 product LOC, 40–80 test LOC**. Luna max. | Slice 0. Test unsupported property/item, missing ID/required field, included breakfast, and malformed units. |
| **2. Typed request + gate wiring** | Pane/request schema carries explicit Add-On rows; independent Add-On gate and process allowlist. No silent inheritance from generic Create. | `apps/server-pilot/src/ai/pane-stay-save.ts`, `apps/mail/lib/quote-workflow/pane-stay-bind.ts`, `apps/server-pilot/tooling/playwright-quote/create-tool.schema.json`, `create-request.mjs`, `pane-stay-spawn-env.ts`; **~80–140 product LOC, ~40–80 test LOC** (rough split from the lane's writer estimate). Luna max. | Slice 1. Verify explicit property and gate; ensure setting the new gate cannot change sibling workflow permissions. |
| **3. Deterministic row writer + proof** | Add rows with DOM-verified controls; capture screenshot; read back and reconcile exact rows; safe partial/ambiguous-save state. | Proposed `create-addon-rows.mjs`, `create-lab-stay.mjs`, `create-proof-rules.mjs` + create/pane seam tests; **~100–180 product LOC, ~80–140 test LOC** (re-split from lane's 180–320 writer estimate so slice stays ≤200 product LOC). Grok 4.6 High. | Slices 1–2. Run one Labtest canary each at HRCEN and HRDAV. Pass only on exact row readback and no duplicate after retry. |
| **4. Shuttle note semantics** | Only after hotel confirms whether note is non-billable status, where it belongs, and wording. Keep note unpriced and distinct from Add-On rows. | `reservation-note.ts`, `booking-card.tsx`, `pane-stay-bind.ts`, create request path; **40–90 product LOC, 40–80 test LOC**. Luna max for text/schema; Grok if changing HMS write semantics. | Property policy + one Labtest note readback. Current `reservationnote` mapping is `LIVE-UNVERIFIED`; strict create proof currently forbids it (`create-proof-rules.mjs:19`). |
| **5. Shuttle provider draft** | Staff-reviewed unsent itinerary/request draft, provider response and completion state; no automatic provider send or billing inference. | `types.ts`, `stay-extras-fields.tsx`, `booking-draft-bind.ts`, `staff-quote-workflow.ts`, `staff-quote-bind.ts`; **100–180 product LOC, 80–140 test LOC**. Luna max. | Separate property evidence and exact required fields/contact. Da Vinci interview is insufficient; Centurion process unknown. No implementation in first Add-On release. |

**Review and execution routing:** Add-On HMS writer coder = Grok 4.6 High; profile/schema/UI wiring = Luna max. Plan review = Gemini 4 Argon High; each code PR = Greptile Apex plus the required technical review. Remote typecheck/tests only; no local Vitest/typecheck on the shared VPS; no new GitHub workflow/check. Deploy only from `.worktrees/recover-parse-failure` through `apps/server-pilot/deploy/ops-deploy.sh` after authorization and required staff warning. Each UI slice must prove both Outlook and webmail surfaces.

## Live proof table

| Workflow | Property | Canary | Pass | Current status |
|---|---|---|---|---|
| Guest Stay Add-Ons | HRCEN | One-adult Proof Labtest stay, 2027+, supported Breakfast/Dinner/High Tea rows; screenshot and post-save readback. | Exact property/item/date/quantity/rate/folio semantics; no duplicate rows on ambiguous retry. | **Not run; catalog and DOM unknown.** |
| Guest Stay Add-Ons | HRDAV | Same isolated Labtest proof; include required reservation note only if policy confirms its content. | Same exact row checks; prove HRDAV-specific item IDs and note behavior. | **Not run; catalog and native codes unknown.** |
| Shuttle note/draft | HRCEN | No live provider message. After policy confirmation, create Labtest note and prepare unsent provider draft. | Note readback matches staff-approved wording and is not treated as a charge; draft preserves itinerary and waits for human send. | **Blocked; policy/provider details unknown.** |
| Shuttle note/draft | HRDAV | Same; no provider send. | Same plus passenger/vehicle match and provider-response state if those are confirmed as required. | Interview supports some coordination, but no end-to-end trace; **blocked**. |

## Holds and decision frontier

- **Proceed with Slice 0 only** when the single HMS browser is available. Do not code from screenshots or quote extras alone.
- For each property, obtain approval/source of truth for item code, price/unit, included-meal rule, taxes/folio treatment, and which stay dates/visits receive the row.
- For shuttle, obtain the actual provider workflow and payer policy separately for HRCEN and HRDAV; establish any group/folio exception. Do not encode “always direct-billed” or “never add to HMS.”
- Before any production claim, refresh deployed SHA, per-process flags/config, property slot health, and relevant staff-bundle proof. Historic Active/plan notes are not live authorization.
- **ETA remains open** until Add-On DOM is confirmed and a measured live-HMS Add-On write median exists. No ETA ledger row was written because no estimate was issued.

## Provenance

- Current source ref verified with `git ls-remote`: `origin/main` = `02b7d595d1fa9e3bb02f98eae535e48271d28021`.
- Read-only code-sizing lane detailed its path map at ancestor `c5db8521d7cc72d3906195519608f482506f102e`. The only delta from that commit to current `origin/main` is `#596` property-outage handling across eight availability/queue files; it does not touch Add-On/create profile paths. The local worktree `HEAD` is `a9435e6a3`, not used as current-source proof.
- Corpus/interview aggregates and limits: [2026-10-26 evidence report](../research/2026-10-26-addons-shuttle-scope-evidence.md). No mailbox body, live HMS, tests, or environment values were inspected by the code-sizing lane.
