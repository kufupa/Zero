Review-only pass: read skills + plan + architecture, then check cited code against the real tree.Using ce-doc-review headless + code check. User format wins: no edits, no spawn-and-fix. Next: plan, architecture, Hindsight, cited code.Using 95 local + ce-doc-review. Next: architecture, Hindsight, then cited code.No CodeGraph, empty Hindsight. Checking cited path:line against source.**Most cites hold. U1 overscoped vs existing all-room helper. Q0 already on main. Fastest path: U3b + U5 parallel with BAR-only U1, then party.**

## 1. Wrong path:line
- `hms-availability.ts:171–198` used as lock occupancy (`p1-implementation-plan.md:12`) — that range is `AvailabilitySnapshot`. Lock is `494–517`.
- `fetch-quote.mjs:191–195` as “accepts organizationID/travelAgencyID” — `projectCriteria` POST readback keys. Request accept is `quote-contract.mjs:260–278`.
- `hms-jobs.ts:191–196` as 24h priced reuse — that is 6h `STAFF_QUOTE_RESULT_TTL_MS`. 24h is `PRICED_QUOTE_REUSE_MS` import at `hms-jobs.ts:123`.
- `nava-pane-render.test.tsx:2880–2919` as U3b new-booking contact — existing-stay + voucher. File has zero `new_booking`.
- `l4-infor-order-dropped.md:99` points at stale worktree `ACTIVE.md:11`; live `ACTIVE.md:11` is party pane review.
- Spot-checked ranges that **hold**: `hms-availability.ts:36–56,102–117,398–427,494–517`; `quote-workflow-panel.tsx:920–924,960,1517–1527,1583,1994`; `nava-pane.tsx:2213`; `party-aliases.ts:144–151`; `pane-stay-save.ts:134–177,333–335`; `FACTS.md:145–146`; `ACTIVE.md:8–11,60–61`.

## 2. Slice sizes / U1 minutes
- **240–360 raw / 320–450 lines is high for Luna-max** if U1 is BAR-only reuse of `quoteRequestFor` (`hms-availability.ts:102–117`).
- Real new work: pane `queueAvailability` (copy `queueFind` at `pane-stay-lookup.ts:230–248`), keep `board` (`fetch-quote.mjs:531` dropped at `hms-availability.ts:418–427`), ungate `roomRequirementReady` (`quote-workflow-panel.tsx:884–886,960`).
- **BAR-only U1: 180–280 lines, 120–180 raw min.** Multi-strategy add-on: +80–150 lines, +60–100 min.
- U3a/b, U5, U2a sizes look right. Q0 80–150 is leftover: top CTA + `primaryAction={false}` already ship.
- ARCHITECTURE `~90 min` (`ARCHITECTURE.md:53`) is gates+deploy fantasy for this U1.

## 3. Slice order / Q0 / U3 warm-up
- Owner order holds: **price grid, then party** (`ARCHITECTURE.md:8–9,53–55`).
- **U3b first/parallel** — 4–8 lines, disjoint (`nava-pane.tsx:2213`). Visible staff win today.
- **U3a after U1** — same `quote-workflow-panel.tsx`. Warm-up PR that blocks the pane file slows the quote bar.
- **Q0 drop from critical path.** `Prepare PDF + reply` at `quote-workflow-panel.tsx:1583`; duplicate primary already off at `1994`; unsent copy at `reply-body.tsx:217–225`. Leftover label “Make quote” belongs on U4.

## 4. Parallelism
- **Same-time, disjoint:** U1 ‖ U3b ‖ U5 (new probe files) ‖ U7 truth docs.
- **U2a listed files disjoint** (`party-aliases.ts`, `party-picker.tsx`, …). Plan queues it after U1 from ARCHITECTURE “same pane file” (`ARCHITECTURE.md:53–55`) while U2a file list omits the panel — **wrongly serialized**.
- **U3b wrongly queued** behind U2/nava-pane owner.
- **Keep serial:** U3a+U1 (`quote-workflow-panel.tsx`); U7 TTL+U1 (`hms-jobs.ts`); U2b+U4 (`booking-card.tsx`, `pane-stay-save.ts`); U6 if it touches `amend-find.ts` (U1 adds availability kind at `amend-find.ts:162–168`).
- Live HMS always one property lock (`hms-availability.ts:507`).

## 5. U1 design risk / smallest viable
- One lock × BAR + contract + NGOVDB = 2–3 serial Hotel Availability reads. Dated duration **12–413s each**, queue **80–1025s** (`FACTS.md:145`). Staff wait explodes.
- Prefetch default off (`hms-jobs.ts:161–164`).
- **Smallest U1:** one BAR `quoteRequestFor` (already all room types), pane queue/read, grid **before** room pick, exact `board`, nightly `availableCount` + as-of, missing → “not checked”.
- Contract/gov tagged overlay = **U1b** after confirmed party IDs. NGOVDB from `FACTS.md:146`; dinner allowance stays config (`FACTS.md:149`).

## 6. DoD (sufficient)
- **U1:** one fixture snapshot + panel test: dates+occupancy search; room type optional; every room×rate shows board/nightly/as-of. Staff artefact optional. No ≥100.
- **U2 rank:** fixture order body > history > domain; domain never binds; BAR with neither party. **No accuracy rate** — owner labels nothing; `ACTIVE.md:8–11` 20/22 is circular n=22.
- **U3:** one assertion each (jump gone; new_booking `Contact`).
- **U5:** Labtest-only, write-blocked, DOM/API field table. `send_on_save=unknown` (`ARCHITECTURE.md:68` overclaims; plan U5 is right).
- **U4:** two end buttons; create stays copy-only until Labtest Save proof. No send claim.
- **U7 quote proof:** ≥10 independent staff outbound/PDF+HMS nights (`AGENTS.md:68`). ≥100 only if a later accuracy rate is claimed (`AGENTS.md:74`).

| Slice | lines | raw min | parallel group | done-check |
|---|---:|---:|---|---|
| P1.0 / U3b Contact label | 4–8 | 10–15 | **A** now | `new_booking` region = Contact |
| P1.1 / U1 BAR grid | 180–280 | 120–180 | **A** ‖ U3b/U5 | search w/o room type; all rooms+board+nightly+as-of |
| P1.4 / U5 Labtest probe | 80–140 | 75–120 | **A** new files | Labtest DOM/API table; zero writes |
| P1.2a / U2 rank | 100–180 | 90–150 | **B** (files disjoint; queue if panel touched) | rank fixtures; domain no bind; BAR w/ no party |
| P1.3a / U3a jump | 5–12 | 10–20 | after U1 (shared panel) | no “Complete stay details” jump; Add stay dates stays |
| P1.1b strategies | 80–150 | 60–100 | after U1+party IDs | tagged BAR/contract/NGOVDB; gaps = not checked |
| P1.2b role fields | 160–260 | 120–210 | after U5 | guest/PDF/org/agency distinct; A/R only if U5 proves |
| P1.5 / U4 two ends | 80–160 | 90–150 | after U5 | Make quote default; Create provisional copy-only |
| Q0 | 0 | 0 | drop | already on main (`1583`,`1994`) |
| P1.6 TTL | 0 until repro | 30–60 evid. | after U1 | name the dropping object first |
| P1.7 CHECK | 80–160 | 60–105 | later | candidates + re-read; no write |
| U7 ≥10 quote truth | 0 | 135–180 evid. | ‖ docs | staff artefacts; no accuracy claim |
