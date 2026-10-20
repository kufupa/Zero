# 2026-10-20 overnight quote and HMS queue retro

**Outcome: partial.** Three quote/pane PRs and the authorized HMS priority-queue PR merged and deployed. The individual-thread score improved on the same eight rows, but the ≥10-thread quote bar was not met. Labtest create, webmail viewer/draft proof, and the staff-hours DEV-hold proof remain open.

## Scope and sources

This retro covers the 2026-10-20 overnight run authorized under owner asks 150–151, plus the read-only production check at 10:18Z. It uses the overnight handoff and plan, the final backtest scoreboard, the 2026-10-20 ETA-ledger close rows, `ACTIVE.md`, and the 24-hour aggregate report at `~/retros/2026-10-20.md`. No raw mail, guest data, credentials, or source IPs are included.

- [Overnight quote/backtest scoreboard](2026-10-20-quote-backtest-pool.md)
- [Run contract](../context/RUN-CONTRACT.md)
- [Active context](../context/ACTIVE.md)
- [ETA closeout rows](../context/ledger/2026-10-20-overnight-retro.md)

## 1. What went well

- **Real accuracy moved, without claiming a pass.** On the same eight individual, plannable threads, rate-plan class + board + room matches rose from **1/8** on `1181ca923` to **5/8** on `593d36283`; exact-price matches were **2/8**. The remaining score is explicitly partial because `n=8 < 10`.
- **The Dinner B&B path was corrected and proven live.** A DBB request produced NGOVDB at R1 700, matching the staff rate; Government strategy now follows the request unless staff explicitly edits it.
- **The owner-authorized queue slice shipped.** PR #425 deployed with STAFF > PREFILL > DEV > REFRESH tiers. A DEV-tier read succeeded and remained Nava-prepared; no flag was flipped.
- **Safety held.** No guest email was sent, no real-guest HMS write occurred, no penalty dialog was accepted, no production flag was changed, and no GitHub Actions or local tsc/Vitest were run. Labtest attempts stopped before Save; no booking was created.
- **The owner received a bounded status, not a false green.** The bundle was observed in nginx after deploy; the response distinguished load evidence from proof of staff identity. Run health was checked read-only after the staff window.

## 2. What did not finish

| Acceptance item | Result | Why it remains open |
|---|---|---|
| Quote match on ≥10 individual threads | **5/8** | The initial pool count was message rows, not eligible unique individual threads after deduplication and group exclusion. Final set was below the product bar. |
| Exact price | **2/8** | Rate/occupancy extraction and party/contract binding still miss; class match does not prove price correctness. |
| Labtest create then cancel | **Blocked before Save** | Commit-screen guarantee combo click timed out twice at 5 s. Preview passed 4/4; `clickedSave` stayed null, so nothing was booked. A DOM look was not completed. |
| Webmail viewer run + unsent test draft | **Not done** | The run window went to quote scoring, queue work, and the Labtest diagnosis; no draft was saved. |
| DEV staff-hours hold | **Unproven** | The read-only morning query found no DEV runs. Absence of a run does not prove the gate held a DEV run behind queued PREFILL work. |
| Prepared-quote queue health | **Not fixed** | Eight queued reads produced three TTL expiries; two other jobs dead-lettered after one attempt and succeeded on manual retry. |

## 3. Evidence after the run

Read-only production check at 10:18Z showed prod still at `3e1acb694`. From 05:00–10:05Z, priority 10 had 10 succeeded jobs (wait p50 3 s, p90 82 s); priority 0 had 48 succeeded and one `staff_quote` dead-letter (wait p50 3 s, p90 50 s). These are small-window operational counts, not a reliability guarantee. No DEV-tier runs appeared in that window.

Nginx recorded the pane bundle at 05:12:56Z and again at 10:18:57Z (200 responses, two distinct source IPs). The identity of either requester was not verified; this establishes bundle requests after deploy, not staff adoption or a successful viewer workflow.

Six of eight historical asks had a later history-aware extraction marking them `no_action` after staff had replied. The backtest intentionally priced from each ask's pre-reply extraction. This is a useful historical pricing counterfactual, but it is not evidence that the current live admission path would automatically prepare those already-answered threads.

## 4. ETA and review calibration

| Work item | Estimate | Actual | Ratio | Close outcome | Recorded rework / stuck |
|---|---:|---:|---:|---|---:|
| Overnight quote run (`opus-overnight-quote-20261020`) | 200 min | 162 min | 0.81× | partial | 25 / 20 min |
| HMS priority-queue PR (`hms-priority-queue-20261020b`) | 55 min | 47 min | 0.85× | partial | 15 / 0 min |
| Parallel Chat D held-out lane (`chatd-heldout-20261020`) | 75 min | 63 min | 0.84× | pass | 4 / 0 min |

The estimates landed below planned time, but the first two outcomes are partial: elapsed-time accuracy is not acceptance success. The run close rows record `scope_growth` for the overnight work and `review_churn` for the queue PR. The queue close row records three P1 and three P2 review items; those were handled before merge. The Chat D row records two P0, two P1, and three P2 findings and PR #424 as its pass verdict.

The generated report scans local Claude transcripts for the prior 24 hours (2026-10-19 10:31Z–2026-10-20 10:31Z): 23 sessions across five Zero worktree directories. It estimates $150.56 priced transcript usage: Opus 5.5 $138.98 (2,004 assistant usage events) and Haiku 5.5 $11.59. Raw Opus IDs in this window were all `claude-opus-5-5`. A separate GPT-6 Luna report-synthesis call cost $0.0053.

| Opus timestamp slice | Estimated spend |
|---|---:|
| Full report window | $138.98 |
| Overnight execution, quote/queue worktree (02:29–05:27Z) | $32.35 |
| Concurrent Chat D lane in that window | $3.26 |
| Report-window spend outside execution window | $103.37 |

These are local transcript-usage estimates at model rates, not an invoice; timestamp slices are not complete task-level attribution. The estimated $1.93 cache-gap premium is already included in the $138.98 Opus total. Direct Codex/Cursor/Grok usage and unpriced transcript models are not included.

## 5. Causes and learning

1. **The goal's denominator was not made feasible before execution.** A 24-row price pool included repeated messages and groups. The plan carried a ≥10-thread target before establishing how many unique, plannable individual truth threads remained. The final eight-row score was useful progress, but could never pass the owner’s minimum bar.
2. **The backtest load exceeded queue health limits.** Eight serial jobs were put behind a 10-minute queued-job TTL while a typical read takes minutes. The first transient failure path had only one attempt for prepared quotes. The resulting expiry/dead-letter pattern was predictable from the service time and retry policy.
3. **The commit selector was retried without new evidence.** After the first guarantee-combo timeout, the commit DOM was not inspected before the same interaction was retried. The safe stop before Save was correct; the second unchanged attempt added no diagnostic value.
4. **The plan had more checks than its clock could prove.** Quote quality, pane UI, queue priority, Labtest write/cancel, webmail draft, and owner review competed for one serial HMS lane and one hard stop. The queue item was later explicitly authorized, but the remaining proof items should have been visibly cut at the checkpoint rather than left implicit.
5. **Runtime events were stronger than the adoption proof.** A 200 bundle request is not proof that staff saw or used the pane. Likewise, zero DEV runs do not establish that the staff-hours gate held one.

## 6. Next-run changes

- Before owner GO, publish the **eligible denominator**: raw candidates → unique threads → exclude groups/past/unplannable → truth-backed individual `n`; compare that `n` to the pass bar. If it is short, make the run goal a measured improvement and state the minimum additional rows/owner decision required to claim a pass.
- Before any historical reprice batch, calculate serial service time against the queue TTL and retry count. Enqueue one-at-a-time (or fix and prove the queue policy first); track every row to a terminal state and separate manual retry from first-attempt reliability.
- After the first live DOM timeout, capture the relevant screen/visible options and inspect the actual interaction target before retrying. Keep all write-path probes within the approved Labtest guard and stop before Save if uncertain.
- At the mid-run checkpoint, explicitly cut lower-priority deliverables and report each acceptance check as PASS, BLOCKED, or NOT RUN. Do not leave a draft or staff-hours gate as implied work.
- Prove the queue hold by placing a DEV item behind a queued PREFILL during the configured window and inspecting claim/state timestamps; do not infer it from no DEV rows.
- Record what a bundle 200 proves (asset fetch) separately from viewer completion, staff identity, and unsent-draft proof.
- Close ETA rows once. Reuse the same ID; do not create a second start row for the same execution. Keep daily aggregate cost separate from run-specific spend.

## 7. Model, measurement, and scope notes

The overnight coordinator used Opus; implementation work was delegated to Luna max; Grok/Greptile reviewed code; Sol was not used for code/review. The queue plan followed owner GO after the quote slice deployed. The Labtest attempt remained within the authorized lab-only path. Nothing here promotes the unpassed quote score, incomplete viewer test, or unverified staff-hours gate to a done claim.
