---
date: 2026-10-26
asks: [223, 224, 225, 226, 227]
evidence: docs/research/2026-10-26-dev-speed-analysis.md, docs/research/2026-10-25-pane-prefetch-and-ui-evidence.md, docs/plans/2026-10-26-001-overnight-run2-shape.md
---

# Run 2 decisions (evidence-backed)

| # | Decision | Evidence | Owner |
|---|---|---|---|
| 1 | Speed mode is the default for every run | 2.4 of 6 lanes busy, 89 min per lane session, Apex 2m43, typecheck 25 s (speed analysis §1, §4) | yes, "always" |
| 2 | Reviews still run every PR (Greptile Apex + P1 fix on the same PR); coding does not idle while a PR is in review — the lane starts its next slice on a stacked branch and returns to fix P1s first when they land | 6 of 16 PRs had P1s; P1s ~78% real (§6) | yes |
| 3 | Split the 3 monolith files first when ≥2 slices touch them | 7 of 16 PRs touched them | yes |
| 4 | Slice size: aim ~200 product lines; judge by feature difficulty, not a hard cap; >500 still refused by merge-gate | >500-line PRs 100–179 min vs clean 1–19 min | yes (soft) |
| 5 | One test per behaviour at the seam, no UI snapshot tests | tests 1.2× product on 10-25 | yes |
| 6 | People card: Contact / Agency / Guest; verify against past HMS confirmations vs inbound mail | Infor create needs guest last/first name (HRDAV DOM read) | yes, check corpus |
| 7 | Argon 4 High = adversarial review only (repeatable); no Argon coding lane until owner tests quota | AI Pro quota unpublished; lockout reports (§9) | yes |
| 8 | Coders: Grok 4.6 high via Cursor CLI (subscription) for HMS/writes; Luna max (codex) for the rest | 10-25 cost Grok $4.7/PR vs Luna $0.9/PR | yes |
| 9 | LLM watchdog replaced by scripts (merge-gate, dispatch --idle-check, deploy-train) + Opus hourly check | 5 of 6 watchdog catches were mechanical (§10) | yes |
| 10 | Rates: shop all 9 strategies, likely-first; log staff picks for a tally | 11–16 HMS-min/day for all 9 (§1.4 shape) | yes |
| 11 | No hard deadline; run until the slice list is empty (9–10 UK fine) | — | yes |
| 12 | Architecture changes allowed when best/fastest; log them here | — | yes |
| 13 | Orchestrator: extensive kickoff prompt + rule re-injection on every compaction/handoff (state file + rules digest re-read via hook/resume prompt) + script gates so rules do not depend on memory | 10-25: orch merged before Apex 2×, idle 3×, after 6 handoffs (retro) | yes (ask 228) |
| 14 | Rate suggestion seeded from the corpus now, not after 100 new picks: backfill the per mailbox × sender/agency × rate tally from past outbound (rate code on staff PDFs / HMS letters joined to inbound), eval on held-out threads (does the likely-first order put the staff-sent rate in top 1 / top 3). Slice R-SEED (luna), last in T1 | S5: 1,288 labelled outbound, 344 joined; ordering-only change, all 9 still shopped | yes (owner 01:20 UK) |
| 15 | Cursor model = `cursor-grok-4.6-high` (normal speed), never `-fast` variants (cost) | owner | yes |
| 16 | Timebox: if any step runs >2x its ETA, stop and analyse the whole strategy (not just that lane) before continuing; log the review here | owner 01:25 UK | yes |
