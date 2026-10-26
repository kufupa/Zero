---
date: 2026-10-26
ask: 226
method: GitHub PR timings for run mh1024 (gh pr view, 16 PRs), retro docs/context/ledger/2026-10-25-mh1024-retro.md, /tmp/mh1024/state.md, Exa Agent run agent_run_4f87f86334924ad39bfa209c78a541b8 (medium, $0.10) + one contradiction search
---

# Why last night's run was slow, and a faster method

**Answer: AI review and typecheck are not the problem. Greptile Apex takes about 3 min and remote typecheck about 25 s. The time went into three things: (1) a serial chain caused by 3 giant shared files, (2) repair loops on PRs that were too big, (3) an LLM orchestrator that sat idle, polled, and restarted. Fix the structure. Realistic gain is 4–5×, not 10×.**

## 1. Measured (run mh1024, 2026-10-25)

| Measure | Value | Source |
|---|---|---|
| Wall time / PRs | 18.6 h / 26 PRs | retro §2a |
| PR open→merge, 16 product PRs | median ~18 min; clean ones 1–19 min; ones with P1 rounds 100–179 min | gh pr view |
| Greptile Apex run | 2 m 43 s (#550: 18:49:34→18:52:17) | GitHub check run |
| Greptile median review (vendor) | 2:25 | greptile.com/blog/greptile-v5 |
| Remote typecheck | 25 s | state.md 04:57Z |
| Deploy, merge→live | ~94 min over 11 deploys, ~8.5 min each | retro §2c |
| P1 repair windows | ~348 min; #538 157 (1,259 changed lines), #543 94, #533 35 | retro §2c |
| Coding before PR opened | 0–20 min for most; #550 132, #529 50 | gh commits |
| Orchestrator idle with startable work | ≥30 min + 3 polls; 5 restarts = 19 min | retro §2c |
| PRs touching the same 3 files | 7 of 16 touch quote-workflow-panel.tsx (2,370 lines), nava-pane.tsx (2,596) or hms-jobs.ts (4,561) | gh pr files, wc -l |
| Oversized PRs (>500 changed lines) | #527, #529, #536, #538, #541, #545, #550 | gh pr view |

About 60% of wall time was the U5→U6b→U13 chain. It was serial because each unit edited the same panel file, and two units broke the 500-line cap.

## 2. Outside evidence (2026, Exa)

| Finding | Source |
|---|---|
| Parallel sub-agents were slower in 14/15 settings and faster in only 27.9% of jointly solved cases unless tasks were independent | arxiv.org/html/2610.10263 (2026-10-07) |
| Cross-agent merge conflicts 41.7% vs 19.8% within one agent | arxiv.org/html/2607.04697 |
| Bigger agent PRs merge less often | dl.acm.org/doi/abs/10.1145/3793302.3793600 |
| Small stacked PRs: +9% merged code, +5% time-to-merge | github.blog changelog 2026-10-06 |
| Best measured sustained gain 2.09× PR throughput; no source shows sustained 10× accepted output | arxiv.org/html/2607.01904v1 |
| OpenAI Symphony (dependency-aware dispatch): +500% landed PRs for some teams (vendor, not controlled) | openai.com/index/open-source-codex-orchestration-symphony |
| "The bottleneck relocates to review/selection" | labhub.hopto.org 2026-08-09; Ars Technica 2026-10-09 |

## 3. Speed-mode method (proposal)

| # | Change | Kills |
|---|---|---|
| 1 | First unit, one lane, ~30 min: mechanically split quote-workflow-panel.tsx into one file per card (no behaviour change) | serial chain on one file |
| 2 | Plan units ≤200 product lines, each with a file-ownership list; no two running units share a file | P1 loops on big PRs, conflicts |
| 3 | Each lane runs its own gates in the background: remote typecheck ‖ targeted remote tests ‖ Apex; a script merges when all are green (merge-gate.sh); P1 → same lane, 2 rounds, then split | wait for orchestrator |
| 4 | A dispatcher script (not an LLM) starts the next ready unit when a lane frees; the LLM orchestrator only handles red events | idle, polling, context handoffs |
| 5 | Deploy train: deploy main in the background whenever ≥1 merge since last deploy | deploy blocking |
| 6 | One background canary lane per hotel (one HMS lock each), never blocking code | proof tail |
| 7 | Cursor CLI `cursor-grok-4.6-high` (subscription) + Luna → 6–8 coder lanes, cost no longer limiting | API spend |

Estimate (not measured): per unit ~25–35 min wall (code 10–20 + gates ~5). Longest chain after the split: A→F→G→H→I→J ≈ 6 units ≈ 3–3.5 h. Tier 1+2 (14 units) ≈ 2.5–3 h, everything (22) ≈ 3.5–4 h at 6 wide, vs 16–20 h last-night style. Risk: P1 rounds (6 of 16 PRs last night) push it out.
