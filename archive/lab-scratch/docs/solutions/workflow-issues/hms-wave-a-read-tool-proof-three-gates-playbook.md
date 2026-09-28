---
title: "HMS Wave A read-tool proof: three gates playbook (payload, packaging, visual)"
date: 2026-09-14
last_updated: "2026-09-18"
category: workflow-issues
module: server-pilot-hms / centurion-dashboard-tools
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "Building or proving Centurion server-pilot HMS read tools with live overlays and compare.v1 DoD sections"
  - "Autonomous or overnight plans risk OR-clauses that treat BLOCKED or packaging-only as wave done"
  - "HITL reviewers watch Playwright webms while XHR or compare artifacts are already green"
  - "Catalogue or gold demand lists deep fields that live dumps have not proved on this property or role"
  - "Operators must classify 813 stubs, invent-forbid, and EXTERNAL_ROLE_GATE without inventing green"
tags:
  - hms
  - wave-a
  - hitl
  - visual-proof
  - payload-vs-packaging
  - soft-open
  - external-role-gate
  - centurion-dashboard
  - pms-tools
  - three-gates
related_components:
  - tooling
  - testing_framework
---

# HMS Wave A read-tool proof: three gates playbook (payload, packaging, visual)

## Context

Centurion **Wave A** delivered HMS-backed read tools on `feat/centurion-dashboard-tools` using live Infor overlays, `compare.v1.json` DoD sections, and human-review packaging (Playwright `.webm` or mailProof). The arc spanned find/reservation payload honesty (Wave 0), soft-open and function-code harvest, autonomous plans that **underworked twice**, and a second crisis when **payload GREEN diverged from HITL video truth** (Start Center, spinners, wrong surfaces).

Sibling docs already cover subsets:

- Packaging vs payload / `claimKeys` / sentinel `-1`: [hms-live-proof-packaging-vs-payload-completeness.md](./hms-live-proof-packaging-vs-payload-completeness.md)
- Soft-open, harvest, invent-forbid, escalation: [infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md](./infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md)

This playbook compounds the **full session**: twelve failure→fix patterns and the **three gates** (Payload, Packaging, Visual) so the next multi-tool wave does not relearn them. Private visual RCA: `.private/wave-a-20260912/HITL-VISUAL-RCA.md`. Payload board: `docs/superpowers/plans/handoff-reports/2026-09-12-wave-a-batch-hitl.md`. (session history)

---

## Guidance

### Three gates (all required when HITL video is in scope)

| Gate | Proves | Does not prove |
|------|--------|----------------|
| **Payload** | `compare.v1` / `result.v1.json` field contract; honest `claimKeys`; forbidden sentinels rejected | That a human saw the owner screen |
| **Packaging** | Auth, `view_only`, digests, exit code, artifact presence | Field quality or painted UI |
| **Visual** | Dense frame audit of delivered webm shows **owner surface** painted (not Start Center / spinner-only) | That every catalogue column exists |

Promote or batch-HITL only when the gates that apply are green—or an **EXTERNAL_ROLE_GATE** / invent-forbid packet is accepted after escalation.

### 1. Packaging green ≠ payload complete

**Failure:** `PROOF_EXIT=0` and video while `guestName: "-1"`, null room/rate on a grid that never exposed those keys, eight `claimKeys` regardless.

**Fix:** Split packaging from payload; write required / allowed-null / forbidden sentinels before coding; commit sanitized live GRIDRESULT fixtures; payload policy before human sign-off; compose names from `lastname`/`firstname` when `primaryguest` is `"-1"`.

### 2. Soft-open: 813 stub vs true role gate

**Failure:** Menu-first then probe → 813/400 → premature BLOCKED or credential churn.

**Fix:** `BSSTRT` warm → **early soft-open** target → harvest codes from live XHR → treat 813 as probe-order until clean retry → EXTERNAL_ROLE_GATE only after ladder (203 / menu absent / corpus unbound).

### 3. Plan OR-clause / underwork twice

**Failure:** “Compare green **OR** BLOCKED” and shallow RCA; skip packets and soft-capture without per-tool videos declared wave ready.

**Fix:** AND-chains only. Per tool at Wave 0 depth: soft-overlay attempt + live dump + `allRequiredPass` sections + dedicated webm/mailProof. BLOCKED enters HITL only after exhausted harvest/RCA.

### 4. XHR green ≠ painted UI

**Failure:** In-page `fetch()` soft-open green; Playwright camera on Start Center or Record View + **Processing request**.

**Fix:** Visual gate = owner surface painted. Re-record **UI-first** (`hms-hitl-ui-record.mjs`): menus/search/dblclick/tabs → wait paint → hold ≥20s. Soft-open may still fill payload **after** paint.

### 5. Last-frame PASS lie; dense ffmpeg audit

**Failure:** `last.png` correct while mid-clip was Start Center / spinner / overlay.

**Fix:** Sample percentiles (10/40/70/95) **and** 1s-interval dense frames on the **shipped** clip. Fail if any sample shows login bounce, Start Center KPI shell, spinner over owner tab, or Ext `0` dialog.

### 6. UI-first recorder

**Failure:** Packaging scripts never drive ExtJS chrome humans recognize.

**Fix:** Menu search / menuPath, Guest Stay quick-search (`name=search` / placeholder), dblclick row, tab clicks, `waitNoSpinner`, per-tool `verdictFor`, `view_only` abort on mutating paths.

**Build diary** (soft-XHR camera → Exa/OLH labels → click exploration → early zip fails → ffmpeg/trim): [hms-hitl-ui-first-playwright-recorder-build.md](./hms-hitl-ui-first-playwright-recorder-build.md).

### 7. Wrong click hazards

**Failure:** Wrong text field → Records 0 of 0; Folio on list chrome; lookup overlay in tail; accidental Notes Category filter.

**Fix:** Prefer quick-search Ext field; `dismissStayLookup` (Escape×2); dismiss Ext `0` OK; stay on Guest Stay child tabs for Notes/Traces.

### 8. Trim last 20s; keep `full.webm`; Traces-then-Notes

**Failure:** Long idle middles; A9 spinner while switching Traces on camera.

**Fix:** Retain `${tool}.full.webm`; ship `${tool}.webm` = last ~20s painted hold. A9: Traces off-camera → Notes → hold → trim Notes-only.

### 9. Quote: room type + QUOTE_GRID; not Availability Summary

**Failure:** AVAILABILITY SUMMARY KPI / empty form / Ext `0`.

**Historical fix (superseded 2026-09-17):** The old proof opened **Room Type and Rate Availability** and filled `roomtypes` (for example `DLXQN`). Do not reuse that recipe for current quote work. The client-approved source is Front Desk → Availability → **Hotel Availability**, with applied dates/adults/children/ages and read-only Availability Details. CRS Check Availability creates reservations—never a read path.

### 10. EXTERNAL_ROLE_GATE / invent-forbid

**Failure:** Endless chase or fake green on entitlement-hard surfaces.

**Fix:** Invent-forbid only with dump cite; amend DoD. Gate packets (accept or grant rights): A1 Rate Details nightly; A3 finalized Documents; A7 Events; A10 knowledge corpus.

### 11. Catalogue depth vs list-only proved

**Failure:** Treat list GREEN as full catalogue (e.g. A6 CON/BLK math).

**Fix:** Separate demand evidence from grabability. Promote list when list contract passes; deep columns stay invent-forbid / deferred until dump—not expand-every-tool vanity.

### 12. Gold demand vs live entitlement

**Failure:** 3949 ranks treated as proof the tenant role exposes every field.

**Fix:** Demand answers *why build*; live dump answers *what is grabable*. Amend contracts when dataspy/role disagree (e.g. ratePlan off find).

---

## Why This Matters

A false green at any gate poisons operator trust, agent prompts, and the next wave’s admission assumptions. Infor HMS is session- and order-sensitive; autonomy without written gates optimizes for the easiest artifact (exit code, skip JSON, last screenshot). Documenting three gates and underwork anti-patterns makes the next multi-tool programme cheaper: less credential churn, fewer re-record nights, honest terminals instead of silent partial tools.

---

## When to Apply

- Proving any Centurion HMS read tool with live overlays and compare.v1 sections
- Writing or reviewing autonomous plans with BLOCKED OR-clauses or “video optional”
- Preparing HITL webm batches or mailProof packs
- Interpreting 813 / 400 / 203 / POLICY_BLOCK during probes
- Splitting catalogue ambition from proved surface on one wave
- After a pause before expand work—use as reopen checklist

---

## Examples

### Payload vs packaging (find)

| Before | After |
|--------|--------|
| Done = match + video + `PROOF_EXIT=0` | Done = contract + live fixture + payload assert + packaging + HITL |
| `guestName: "-1"` with 8 claimKeys | Composed name or `partial` + shrunk claimKeys |

### Soft-open

| Before | After |
|--------|--------|
| Menus → probe → 813 → escalate | `BSSTRT` → early open → harvest → then gate |

### Underwork

| Before | After |
|--------|--------|
| One 400 → `BLOCKED_*` → wave HITL | Harvest → soft-open → compare → dedicated webm |

### Visual HITL (Folio)

| Before | After |
|--------|--------|
| XHR FOL green; camera Start Center | UI: search → dblclick → Folio tab → painted balance; ship 20s tail |

### Quote

| Before | After |
|--------|--------|
| Availability Summary KPI | Room Type and Rate Availability → Search → nightly grid |

### Honest terminal

| Before | After |
|--------|--------|
| Keep probing Rate Details after 203 | EXTERNAL_ROLE_GATE; core stay GREEN |

---

## Related

- [hms-live-proof-packaging-vs-payload-completeness.md](./hms-live-proof-packaging-vs-payload-completeness.md)
- [infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md](./infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md)
- `docs/superpowers/plans/handoff-reports/2026-09-12-wave-a-batch-hitl.md`
- `docs/superpowers/plans/2026-09-11-centurion-pms-tools-robust-catalogue.md` (anti-underwork)
- `docs/superpowers/plans/2026-09-11-centurion-pms-tools-dod-contracts.md`
- `.private/wave-a-20260912/HITL-VISUAL-RCA.md`
- [hms-hitl-ui-first-playwright-recorder-build.md](./hms-hitl-ui-first-playwright-recorder-build.md) — how the UI-first Playwright recorder was built
- [private-playwright-audit-bundles-for-live-hms-read-tools.md](../architecture-patterns/private-playwright-audit-bundles-for-live-hms-read-tools.md) — shared private evidence packaging; it does not replace the three gates
- `apps/server-pilot/scripts/hms-hitl-ui-record.mjs`
- `docs/solutions/integration-issues/live-osress-gridresult-parse-canary-row-ok.md`
- `docs/solutions/conventions/live-negative-result-verification-gate.md`
- `CONCEPTS.md` — Packaging gate, Payload gate, Visual gate, Tool promotion HITL, EXTERNAL_ROLE_GATE
