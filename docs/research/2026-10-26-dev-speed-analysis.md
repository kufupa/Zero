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

## 4. Root causes in the method (owner: "what are we fundamentally doing wrong")

| # | Finding | Number | Source |
|---|---|---|---|
| F1 | Lanes were mostly not running | 30 lane sessions = 44.5 lane-hours over 18.6 h → **2.4 busy lanes on average** | R1.md lane wall times |
| F2 | Coding waits on review, merge and deploy: the next unit started only after the previous one merged (plan start table) | U6b/U7/U11b "gated on #538" 3 h; U6b chain serial 5 h 54 | state.md tick 8, retro §2b |
| F3 | Each lane is a full PR lifecycle: cold start (read rules + plan + codegraph), code, gates, local review, wait for Apex, fix, repeat | **89 min per lane session** for ~150 product lines | R1.md: 2,670 min / 30 sessions |
| F4 | Tests and docs outweigh product code | 10-25 diff: product +4,576, tests +5,563, docs +1,529 | git diff origin/main |
| F5 | Coordination is done by LLMs reading state files: orchestrator + Opus watchdog + 6 handoffs | orch $9.6, watchdog $14.8, docs lane Sol $24.5 = 40% of $123 | retro §3 |
| F6 | ~~Planning took 12 h~~ **corrected:** shape 10-24 00:19–~02:00 UTC, owner away until 13:37, plan 21:49→00:27 = **~2.6 h active**; run start 00:42 (15 min after go) | transcript timestamps |
| F7 | Live HMS proof sits on the critical path | proofs 14:29–15:56 + G9 reruns | retro §2b |
| F8 | Every lane loads ~7.7k words of rules + a 400-line plan | wc -w | — |

Daily output is steady regardless of method: 10-19 52 PRs, 10-22 30, 10-23 35, 10-25 26 (gh). That is a process ceiling, not a model ceiling.

## 5. Proposed method change

1. **Never block coding on review.** One long-lived lane per area keeps coding the next slice on top of its open PR (stacked PRs, GA on GitHub 2026-10-06). Review fixes go in as their own commits later.
2. **Lanes per area, not per unit** (pane-cards, server-prefetch, HMS-session, booking). No cold start per unit; ≤4 areas with disjoint files → 4 always-busy lanes instead of 2.4.
3. **Split the 3 monolith files first** (30 min) so areas don't collide.
4. **Script, not LLM, for coordination:** dispatcher + merge-gate + deploy-on-merge. No watchdog LLM; Opus checks hourly.
5. **Tests: one test per behaviour, at the seam.** No snapshot-of-UI tests; the target ratio is ≤0.7× product.
6. **Planning ≤1 h:** a slice list + file ownership + acceptance per slice. No 400-line plan.
7. **Proof off the critical path:** background canary lane per hotel after each deploy.

Expected (inference, not measured): 4 busy lanes × ~3× less lane overhead ≈ 4–6× throughput, if P1 rounds stay low. No 2026 source shows a sustained 10×.

## 6. P1 findings, last night (27 Greptile P1 comments on 14 PRs)

| Kind | Count | Examples | Worth fixing? |
|---|---:|---|---|
| Real product bug, prod path | ~21 | DV batches stay blocked (#532); different hotels share one job (#533); GOV requests always fail (#545); bookings use the wrong room (#550); missing restrictions become open (#548) | Yes |
| Test/ops-only | ~4 | existing quote tests fail (#536); overlapping proof runs bypass cap (#527); walk-in breakfast test (#548) | Fix cheaply, not worth a round |
| Out of diff / follow-up | ~2 | "most strategies have no jobs" (#546, became #547) | Follow-up PR was right |

The P1s were mostly real. Cost came from **waves**: big PRs got 3–4 P1s per round, 3 rounds each. #538 (share HMS reads across mailbox copies) was worth it: 1,887 of 8,636 distinct Message-IDs in 14 days (21.8%) arrive in 2+ mailboxes (prod read-only SQL 2026-10-26).

## 7. Deploys

11 deploys, ~8.5 min each, run by the orchestrator after most merges while it waited. Should be one background deploy train (deploy main when ≥1 new merge, never blocking a lane).

## 8. Backtest (inference, rough)

Last night's longest dependency chain: U1→U3a→U3b→U6a→U5→U6b(3 PRs)→U13 ≈ 9 units. At ~30 min/unit with no waiting on merge/deploy: ~4.5 h + ~1 h proof tail ≈ **5.5 h vs 18.6 h actual (≈3.4×)**. Not more because the chain was real (registry → targets → jobs → pane), and U13 was declared "after everything".

## 9. Gemini 4 Argon on Google AI Pro (Exa run agent_run_1abcee683c4c42c4aa8f287f85b6042b, $0.10)

- Paid Pro gets Argon in Antigravity CLI (antigravity.google/docs/models).
- Quota is compute-based, refreshes every 5 h until a weekly cap; **no published numbers** (antigravity.google/docs/plans). Ultra = 5×/20× Pro.
- `agy -p` likely draws the same pool; 2026 GitHub issues report Pro lockouts after 2 prompts and 168 h weekly lockouts (antigravity-cli #56, #234).
- At the limit: wait for refresh, or AI-credit overage if enabled. No automatic fallback.
- Use: adversarial review + at most 1 lane for the hardest slice; check `/usage` interactively after the first reviews.
