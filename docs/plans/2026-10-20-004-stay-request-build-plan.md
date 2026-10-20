---
title: Stay-request build plan (quote pane first)
status: proposed — awaiting owner GO
date: 2026-10-20
basis: ARCHITECTURE.md (arch-lanes), P1 code-grounded plan (Luna max), Grok 4.6 high code review, Opus spot-checks
---

# Stay-request build plan

Target: [ARCHITECTURE.md](../research/2026-10-20-arch-lanes/ARCHITECTURE.md). Detail: [p1-implementation-plan.md](../research/2026-10-20-arch-lanes/p1-implementation-plan.md), [grok-4.6-p1-review.md](../research/2026-10-20-arch-lanes/grok-4.6-p1-review.md). Owner decisions D9–D17 in [DECISIONS-2026-10-20.md](../context/DECISIONS-2026-10-20.md).

## Changes from P1 after Grok 4.6 high review (Opus-verified)

- Q0 dropped: "Prepare PDF + reply" already on main (`quote-workflow-panel.tsx:1583`), duplicate primary off (`:1994`).
- U1 cut to BAR-only grid (one HMS read already returns every room type, `hms-availability.ts:102–117`): 180–280 lines, 120–180 raw min. Contract/government overlay = U1b later. Reason: each extra rate strategy is another serial HMS read; measured reads 12–413 s, queue waits 80–1,025 s (`FACTS.md:145`).
- U2a (party ranking) runs in parallel with U1: its files are disjoint (party-aliases, party-picker, pane-party-lookup). Queue only if it must touch `quote-workflow-panel.tsx`.
- U3b (new-booking "Contact" label, `nava-pane.tsx:2213`) ships first, parallel.
- Prefetch of availability is off by default (`hms-jobs.ts:161–164`); grid runs on staff open, not background, unless owner later enables prefetch.

## Waves

| Wave | Slice | Lines | Raw min | Parallel | Done-check |
|---|---|---:|---:|---|---|
| 1 | U3b Contact label on new booking | 4–8 | 10–15 | A | new_booking shows "Contact", no PDF wording |
| 1 | U1 BAR price grid before room pick | 180–280 | 120–180 | A | search without room type; every room type with board, nightly price, rooms left, as-of; missing = "not checked" |
| 1 | U5 Labtest probe (read-only script, new files) | 80–140 | 75–120 | A | Labtest-only, writes blocked; table of where guarantee/deposit/A-R/agency/company and the confirmation-email control live |
| 1 | U2a Party ranking, no forced company | 100–180 | 90–150 | A (queue if panel touched) | order email-named > history > domain; domain never binds; public BAR allowed with no party |
| 2 | U3a Remove "Complete stay details" jump | 5–12 | 10–20 | after U1 | jump gone, "Add stay dates" stays |
| 2 | U1b Contract/government rate overlay | 80–150 | 60–100 | after U1 + party IDs | rows tagged BAR/contract/NGOVDB; gaps "not checked" |
| 2 | U2b Separate guest / quote contact / company / agency | 160–260 | 120–210 | after U5 | four distinct fields mapped to proven Infor fields |
| 3 | U4 Two end buttons | 80–160 | 90–150 | after U5 + U2b | Make quote default; Create provisional stays guarded until Labtest Save proof |
| later | U6 CHECK screen, TTL repro, multi-ask | — | — | — | — |
| ‖ | U7 quote truth ≥10 independent threads (evidence, no code) | 0 | 135–180 | docs lane | staff PDF/letter vs prepared price |

## Per-slice pipeline (owner D16)

Orca worktree from origin/main → Luna max implements + focused tests → Grok 4.6 high review + fix (same worktree) → remote typecheck + remote tests (EC2) ‖ `greptile review` → Grok 4.6 fixes P0/P1 → Opus reads diff, merges → Opus deploys (warn owner, last-good SHA) → staff bundle load in nginx.
