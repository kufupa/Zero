---
title: "HMS Wave A HITL: building the UI-first Playwright recorder when soft-XHR video failed review"
date: 2026-09-14
last_updated: "2026-09-18"
category: workflow-issues
module: server-pilot-hms / centurion-dashboard-tools
problem_type: workflow_issue
component: tooling
severity: high
applies_when:
  - "Human reviewers reject Wave A HMS Playwright webms that show Start Center, spinners, or soft-XHR-only surfaces instead of owner tabs"
  - "Building or extending HITL visual packaging for Centurion server-pilot HMS read tools (A2, A3, A5, A6, A8, A9)"
  - "Iterating ExtJS menu paths, quick-search fields, dblclick row open, and child tabs on live Infor HMS"
  - "Auditing shipped clips with dense ffmpeg frame samples before zip handoff"
  - "Trimming long recordings to a 20s painted tail while retaining full.webm for RCA"
  - "Using Infor OLH or Exa to disambiguate menu labels before Playwright navigation"
symptoms:
  - "Soft-XHR or overlay-only capture passes compare while HITL video shows wrong chrome"
  - "last.png correct but mid-clip frames show Start Center or Processing request"
  - "Early video packs fail human review before UI-first recorder existed"
  - "Wrong Ext quick-search or Folio-on-list clicks yield Records 0 of 0 or mutating paths"
root_cause: missing_tooling
resolution_type: tooling_addition
related_components:
  - development_workflow
  - testing_framework
tags:
  - hms
  - wave-a
  - hitl
  - playwright
  - visual-proof
  - ui-first-recorder
  - ffmpeg
  - centurion-dashboard
  - pms-tools
  - extjs
  - exa
---

# HMS Wave A HITL: building the UI-first Playwright recorder when soft-XHR video failed review

## Context

Wave A read tools proved **payload** through soft overlays, live dumps, and `compare.v1.json`. Packaging runners also captured Playwright video and sometimes ran in-page `fetch()` against harvested function codes (`PSSNEL.HDR`, `OSRRAV.HDR`, `GSGRPB.LST`, `OSRESV.FOL`, etc.). Those two proofs **diverged**: network bytes and compare sections could go green while the browser camera stayed on **Start Center**, **login bounce**, **Record View + Processing request**, or the wrong menu target (Start Center KPI **Availability Summary** instead of the quote screen).

Human HITL on 2026-09-13 night failed visually on A2 Folio, A3 Sent Email, A5 Quote, A6 Group, A8 Company, and A9 Notes/Traces—even when operators believed payload was done. The crisis triggered a dedicated **UI-first recorder**, **Infor OLH / Exa research** for exact menu labels, a **live click exploration loop** (snap → fix selector → re-record), and a **video packaging pipeline** (full record → painted hold → `trimHitlTail` → zip). A second crisis appeared when **`last.png` and last-frame checks lied**: percentile ffmpeg sampling showed Start Center, spinners, and lookup overlays through most of the clip. (session history)

**Relationship to sibling docs:** Gate definitions and twelve failure→fix patterns live in [hms-wave-a-read-tool-proof-three-gates-playbook.md](./hms-wave-a-read-tool-proof-three-gates-playbook.md). Soft-open session order and payload completion live in [infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md](./infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md). **Do not re-derive gates here**—use those files when asking “are we allowed to sign off?” This document is the **build and method diary**.

---

## Guidance

### A. Two recorder generations (soft-XHR camera vs UI-first)

| Generation | What the camera sees | What still goes green | Visual result |
|------------|----------------------|------------------------|---------------|
| **Soft-XHR packaging** | Idle Start Center, Guest Stay list chrome, or Record View under **Processing request** while in-page `fetch()` hits `.HDR`/`.FOL`/`.LST` | Payload compare from response bytes | **FAIL** for human HITL |
| **UI-first (`hms-hitl-ui-record.mjs`)** | Real ExtJS navigation: `menuSearch` / `menuPath`, Guest Stay open, tab clicks, quote Search, group/org **Run** | Soft-open may still run **after** paint for payload; video gate is painted frames + dense audit | **PASS** when `verdictFor` + trim + ffmpeg agree |

Soft-open **proves fields**; UI-first **proves the screen a human recognizes**. Neither substitutes for the other.

Entrypoint: `HMS_HITL_TOOL=A2|A3|A5|A6|A8|A9`, `HMS_DISCOVERY_ALLOW_LIVE=1`, credentials via `HMS_READ_SECRET_ARN`, proof stay via `HMS_PROOF_EXACT_CANDIDATE_PATH`. RCA run order: A2 → A9 → A3 → A5 → A6 → A8, each `pass=true` before the next.

### B. Web research role (Infor OLH / Exa → menu labels)

Official Infor HMS Online Help (`docs.infor.com`) and Exa (`web_search_exa` / `web_fetch_exa`) named the right surface **before** Playwright drove clicks—not as a substitute for live snaps:

- **Folio vs Record View:** Folio = guest bill tab. Record View = stay header. Tab label visible ≠ Folio painted.
- **Quote vs Availability Summary:** Start Center KPI **AVAILABILITY SUMMARY** is not quote. Quote = **Room Type and Rate Availability** (menu search; `Alt+Z` fallback). KPI path produced Ext **0 + exclamation** dialogs.
- **Sent Email / Group Booking / Organization Profiles:** Prefer documented menu strings; fall back to `appmenusearch` when `clickText` misses.

Research is product documentation only. **Never send mail bodies or guest identifiers to Exa.**

### C. Live click exploration loop (fail snap → fix selector → re-record)

The recorder is also a **probe harness**. Each failed run writes `last.png`, `hitl-visual.v1.json`, and scrubbed stdout. Loop:

1. Run one tool on live HMS.
2. Read `snap()`: `activeTab`, `processing`, `startCenter`, `lookupOpen`, `hasQuoteGrid`, …
3. Map to `verdictFor` code (`NOT_FOLIO`, `WRONG_AVAIL_SUMMARY`, `LOOKUP_OVERLAY`, …).
4. Adjust navigation or field targeting; re-run until `pass=true`.

**A2 search-field iterations (visual RCA):**

| Run | Mistake | Snap signal | Fix |
|-----|---------|-------------|-----|
| run1 | First/wrong input | Records **0 of 0**; Folio on **list** chrome | Guest Stay **quick-search**, not first textfield |
| run2 | Ext fill matching `/confirm/` | Still 0 of 0 | **`confidential`** matched before confirmation |
| run3 | Hidden detail `confirmationnumber` | Wrong layer | Quick-search `name=search`, placeholder **Search by Name, Confirmation, Room or Lo** |
| PASS | placeholder + Enter + Run + dblclick | `activeTab=Folio`, Folio Balance, no spinner | `clickVisibleTab("Folio")`, `waitNoSpinner`, `dismissStayLookup`, `holdPainted` |

Helpers: `openGuestStay`, `fillHeaderSearch`, `clickVisibleTab`, `setActiveTab`, `dismissStayLookup`, `fillQuoteSearch`.

**A3:** Front Desk → Sent Email missed; PASS after `menuSearch("Sent Email")`.  
**A5:** Menu search Room Type and Rate Availability; later `fillQuoteSearch` (`roomtypes=DLXQN` + Search → `QUOTE_GRID`).  
**A9:** Dense audit failed spinner on Notes↔Traces switch → visit **Traces first** (off trimmed tail), then **Notes**, hold → Notes-only 20s clip.

### D. Video packaging pipeline

1. `ensureFfmpeg` (Playwright-bundled or system).
2. Headless Chromium `recordVideo`; **`view_only` route abort** on mutating URL paths.
3. `login` → `runTool` → `snap` + `last.png` (hint only—see E).
4. Copy artifact to **`${tool}.full.webm`**.
5. `trimHitlTail` — last **`HITL_TAIL_SEC` (20)** into `${tool}.webm`.
6. `holdPainted`: `waitNoSpinner` then **`HOLD_PAINTED_MS` (20_000)** on owner surface.
7. Ship into `.private/Human Review Videos Read Only/` and rebuild **`Human-Review-Videos-Read-Only.zip`** (trimmed tails for humans; keep `full.webm` for RCA).

This pipeline assumes the recorder creates the browser context, so it can set
context-level `recordVideo` at startup. A borrowed remote browser cannot have
that option added retroactively; the native quote tool uses a post-login
`page.screencast` instead. Both capture modes feed the same private evidence
and gate contract.

### E. Visual QA: last.png untrusted; dense ffmpeg

**Failure:** `verdictFor` + `last.png` green while p70 showed Start Center / spinner / overlay.

**Audit ladder:**

1. Percentile frames at 10 / 40 / 70 / 95% of **shipped** `.webm`.
2. Dense every-2s on 20s tails (caught A9 spinner at t=6).
3. 1s-interval pass across all clips after A9 order fix.

**VP8 caveat:** Frame **file size drops** at keyframes can be codec smear—eyeball content; do not auto-fail on size alone.

### F. Safety

| Control | Implementation |
|---------|------------------|
| **view_only** | Route abort on mutating paths; `HMS_DISCOVERY_ALLOW_LIVE=1` |
| **Secrets** | `loadSecret()` from `HMS_READ_SECRET_ARN`—never log secret fields |
| **Proof stay** | `loadConfirm()` from `HMS_PROOF_EXACT_CANDIDATE_PATH`; stdout only `confirmLen` |
| **PII scrub** | `scrub()`; mask emails / long digit runs in snap samples |
| **No invent green** | Exit 2 when `verdictFor.pass` false; dense ffmpeg + human HITL beat compare green |

---

## Why This Matters

Payload compare answers “did we get the bytes?” HITL video answers “would a reservationist believe we opened the same screen they use?” Wave A nearly signed off on **XHR-only green** while reviewers saw Start Center and spinners—a false completion class distinct from EXTERNAL_ROLE_GATE. Building UI-first tooling plus dense ffmpeg audit closes the **Visual gate** without discarding soft-open payload work. The A2 search-field saga shows ExtJS has many similarly named fields; documentation and live snap loops are cheaper than shipping another wrong zip.

---

## When to Apply

- Packaging or compare green but human reports wrong screen / spinner / login bounce in `.webm`
- Autonomous plans claim wave done while video came from soft-XHR-only navigation
- Adding a new HMS read tool that needs a named human-review clip (`verdictFor` case + HMS_HITL_TOOL)
- Before refreshing Human-Review zip—run percentile and 1s dense checks on **shipped** files
- Disambiguating Infor menu labels (quote vs summary, Folio vs Record View)—research OLH/Exa, then confirm on live snap

---

## Examples

### Human night vs UI-first PASS

| Clip | Before (human FAIL) | After (UI-first + trim) |
|------|---------------------|-------------------------|
| A2 Folio | Record View + spinner; Folio not painted | Folio tab + txn rows; overlay dismissed |
| A3 Sent Email | Stuck Start Center | Sent Email grid |
| A5 Quote | Availability Summary / 0-exclaim; login bounce | Room Type and Rate Availability + DLXQN rate grid |
| A6 Group | Start Center | Active Groups list |
| A8 Company | Same stuck clip as A6 | Organization Profile list; **separate** video |
| A9 Notes/Traces | Record View + spinner | Notes rows in 20s tail (Traces off-camera) |

### last frame vs dense audit

| File | last/p95 looked OK? | Dense/p70 failure | Fix |
|------|---------------------|-------------------|-----|
| A2 | p95 Folio + overlay | p70 Record View + overlay | `dismissStayLookup`; Folio-only tail |
| A5 | empty form | Start Center / No KPIs | Menu search + `fillQuoteSearch` + `QUOTE_GRID` |
| A6 | list | Processing request at p70 | `waitNoSpinner` through Run; trim |
| A9 | Traces empty | t=6 spinner on Notes switch | Traces first → Notes; Notes-only trim |

---

## Related

- [hms-wave-a-read-tool-proof-three-gates-playbook.md](./hms-wave-a-read-tool-proof-three-gates-playbook.md) — acceptance gates
- [infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md](./infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md) — soft-XHR payload path vs UI-first camera
- [hms-live-proof-packaging-vs-payload-completeness.md](./hms-live-proof-packaging-vs-payload-completeness.md) — packaging green ≠ field honesty
- [private-playwright-audit-bundles-for-live-hms-read-tools.md](../architecture-patterns/private-playwright-audit-bundles-for-live-hms-read-tools.md) — shared private evidence contract and borrowed-browser capture distinction
- `apps/server-pilot/scripts/hms-hitl-ui-record.mjs`
- `.private/wave-a-20260912/HITL-VISUAL-RCA.md`
- `.private/Human Review Videos Read Only/`
- `CONCEPTS.md` — Visual gate, Owner surface, UI-first recorder
