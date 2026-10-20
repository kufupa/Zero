# 2026-10-20 overnight run closeout

Evidence: [quote scoreboard](../../research/2026-10-20-quote-backtest-pool.md), [full retro](../../research/2026-10-20-overnight-quote-retro.md), `~/.claude/eta-ledger.jsonl`; execution window 02:29–05:27Z, read-only follow-up 10:18Z.

| Lane | Model | Planned | Shipped / live | Estimate → actual | Stuck + cause | Under/over-engineered; autonomous decision |
|---|---|---|---|---|---|---|
| Quote + pane run (`opus-overnight-quote-20261020`) | Opus coordination; Luna max implementation; Grok/Greptile review | ≥10 individual-thread matches, pane/draft proof, then Labtest | #421/#422/#423 live at `3e1acb694`; same-set match improved 1/8 → 5/8, exact price 2/8. Bar not passed. Draft/viewer proof not run; Labtest commit stopped before Save. | 200 → 162 min (0.81×); 25 rework, 20 stuck; partial | 20 min stuck recorded in close row; quote truth denominator was only n=8. Labtest combo click timed out twice before DOM diagnosis. | **Under:** no eligible-thread denominator gate before the ≥10 target; queue TTL/retry health unaddressed. **Decision:** stop Labtest before Save; no real write, send, or flag change. |
| HMS priority queue (`hms-priority-queue-20261020b`) | Luna max; Opus read-diff/merge/deploy; Grok/Greptile review | Named tiers and staff-hours gate; SQL proof | #425 live at `3e1acb694`; DEV-tier prepared read succeeded. Morning query found no DEV rows, so staff-hours hold is unproven. Queue order observed; morning priority-10 n=10, p50/p90 3/82 s; priority-0 n=49, p50/p90 3/50 s, including 1 dead-letter. | 55 → 47 min (0.85×); 15 rework, 0 stuck; partial | Review churn recorded in close row; DEV gate acceptance lacked a held-job observation. | **Under:** did not prove queued DEV held behind PREFILL during staff hours. **Decision:** ran plan 003 after explicit owner GO, even though quote bar remained partial. |
| Parallel Chat D held-out lane (`chatd-heldout-20261020`) | Opus coordination; GPT-6 Luna max | Vision-parity held-out score and owner decision sheet | ETA ledger close row: PR #424, valid held-out score; pass. | 75 → 63 min (0.84×); 4 rework, 0 stuck; pass | None recorded. | Separate workstream with its own owner-ask history; this closeout does not change ask 154. |

## Automatic closeout

At each lane close, the coordinator runs `ce-compound mode:lane-close` before spin-down and reconciles the same ETA ID rather than opening duplicate start rows. At whole-run close, the coordinator runs `nightly-retro.sh`, adds an evidence-backed dated retro, updates `ACTIVE.md`, and updates only the directly completed owner-ask rows. Link a material research report from `docs/research/README.md` and `CATALOG.md`. This is documentation-driven closeout; no hook, cron, or new automation was installed.

## Next acceptance checks

1. Choose and truth-label enough eligible individual quote threads to reach the ≥10 bar; re-score baseline and new build on the exact same rows.
2. Fix and prove prepared-quote TTL/retry health before another queued historical batch.
3. Inspect the actual Labtest commit DOM after the first timeout; repeat only after the selector/state is understood.
4. Prove staff-hours DEV deferral with a DEV job held behind queued PREFILL; run the webmail viewer and one unsent draft if still in scope.
