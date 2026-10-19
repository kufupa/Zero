# 2026-10-19 daytime: four parallel chats

Owner reachable. Each chat = own worktree from `origin/main`, own branch, disjoint files. **Chat A is the only deploy owner**; B–D hand merged PRs to A for the next deploy. Read this file, `PRODUCT.md`, `AGENTS.md` and `docs/context/MISTAKES.md` once; nothing else at startup. Approvals are given in each chat, never relayed.

## Shared facts (read-only checks, 2026-10-19 ~09:30Z)

- Prod `357315940` (triage rules v4, extractor `extract-3ccdd9c9966e`). Since 05:08Z: 40 Centurion extractions, 0 failures; 2 system-prepared quotes, 2 succeeded.
- HMS `read_tool`, last 72 h. `TRANSIENT_NETWORK` = **156 `cancelled_cdp_owner_down`** (the 19223 browser was down; 99 of them 18 Oct 21:00–23:59Z, before the borrowed-Chromium fix and `hms-slot@hrcen`), plus **7 `staff quote execution failed`** (all 7 dead letters) and 4 `party lookup execution failed`. Since 03:00Z today: 2 failures.
- Wait vs run, succeeded reads, p50/p90 seconds: party wait **411/1420**, run 70/84 (n=123); staff_quote wait 44/164, run 122/230 (n=53); find wait 20/101, run 17/45. **Party time is queue, not HMS.** 201 party jobs vs 94 staff_quote at priority 0 share one HRCEN browser.
- HMS tools are deterministic Playwright; rate calls use in-page `fetch` POST (`runtime.ts` `postForm`).
- `feat/oct18-hms-slots` (worktree `oct18-c2-hms`) has 6 unmerged commits: native slot owner, slot ready/recover/reset, property-keyed locks.
- remote-http env is an allowlist (`deploy/write-ec2-remote-env.sh:21`, test `deploy-config.test.ts:5646`): only `HMS_JOB_QUEUE` among `HMS_*`, so webmail never sees prepared quotes (`workstation.ts:575`, `hms-jobs.ts:3101`).
- `mapWorkflowFolder` sends every `origin=system_notice` to not-for-nava before reading the action (`workflow-folders.ts:269`): 31/431 test rows (agent/TMC vouchers, extensions, VCC) are hidden.
- Corpora: RDS Centurion messages Jul 554 / Aug 4,456 / Sep 5,202 / Oct 3,326. Private corpus `/home/orca/nava-research/corpus/2026-10-13/messages.jsonl.gz` (Jul 30–Oct 13) has direction: Aug 3,153 in / 1,305 out, Sep 3,638 / 1,636. **August has outbound.** Overnight silver window was 2026-09-09 10:00Z → 2026-10-16 14:00Z (the #364 gold window). Silver data: `/home/orca/nava-research/triage-20261019/` (PII, never git).
- Label meaning = what happens next: quote → rates prefetch; new_booking → party + create prep; amend/cancel/payment_proof → find by confirmation number; group_event, billing, other_actionable → human, no tool; no_action → hidden. billing and other_actionable both mean "human, no tool".

## Chat A: HMS speed + deploy owner (Opus 5.5, worktree `oct19-hms-speed`)

Outcome: staff never wait on a party or quote read that Nava could have run first.
1. Diagnose the 7 `staff quote execution failed` dead letters (`last_error`, run logs, artifacts). One fix PR if the cause is code.
2. Party wait: order the queue so a quote prep and staff-kicked reads run before party prefetch, and skip party prefetch on `no_action`. Measure p50 wait after deploy.
3. Party run 70 s: one read-only probe of where the time goes; cut only if one obvious step dominates.
4. Decide on `feat/oct18-hms-slots`: merge only what HRDAV parallel reads need. A second HRCEN browser needs a second HMS login (one-browser-per-login rule): **owner question**, do not build.
5. Deploy B/C/D PRs as they land via `ops-deploy.sh`; `/proc` check all four procs after env changes.
Bar: party p50 wait < 60 s, 0 new `staff_quote` dead letters for a staff day. Live HMS = Opus only.

## Chat B: party lookup quality (Haiku 5.5 max drives, Luna workers, worktree `oct19-party-eval`, read-only first)

Outcome: the right company/agency is bound without staff searching. PRODUCT bar: 0 wrong auto-binds, auto-bind ≥ 70%, right party in top 3 ≥ 95%.
1. Score the 123 succeeded party reads in the last 72 h against what staff did (confirmation PDF / quote PDF company field in the outbound). Prior: `r7-party-v2-live.md` (55/95 bound, 0 wrong).
2. Read 20 misses and name the cause (name variant, no profile, wrong field extracted).
3. If variants dominate: propose an agentic loop: LLM proposes ≤3 name variants → deterministic HMS contains-search → LLM picks or says none. Plan + ETA to the owner before code; it touches chat A's files, so it queues behind A.

## Chat C: ship small (Haiku 5.5 max drives, Luna codes, worktree `oct19-ship-small`)

1. W: add `HMS_QUOTE_PREPARE` and `HMS_QUOTE_PREPARE_PER_HOUR` to `REMOTE_COMMON_ALLOWLIST`, the validator's `common` set, and the `HMS_*` assertion in `deploy-config.test.ts`. One PR.
2. S (owner approved 2026-10-19): `system_notice` with an action other than `no_action` → its action folder; `automatedChannel` (OTA/channel) stays not-for-nava; TMC cancellation notifications are already `no_action`. Update `workflow-folders.test.ts:180`. One PR.
Gates: remote typecheck, targeted EC2 tests (`remote-vitest.sh`), Greptile ≤ 2 rounds. Hand both to chat A for deploy.

## Chat D: labels + GEPA, side quest (Haiku 5.5 max drives, Luna workers, worktree `oct19-triage-gepa`; no prod)

1. Quote recall: v4 on every inbound answered by a staff quote file (40 threads 09-09→10-16, plus Aug–Oct from the private corpus). Report recall; that is the PRODUCT "real quote ask skipped" error.
2. Adjudicate the 180 silver disagreements with Luna max + the owner's rules (PRODUCT Asks logged + plan 2026-10-19 quote-feedback rules). Output: label, confidence, one-line reason. Owner spot-checks the 20 lowest-confidence rows only.
3. Grow silver to Aug–Oct with outbound anchors (quote file, `HRCEN_confirmation*`, POP). Fresh holdout = 2026-10-16 14:00Z → now, never used for tuning.
4. GEPA seeded from `rules-v4.txt`, metric = money-class F1 with billing+other_actionable merged and a heavy penalty for actionable → `no_action`. Ship a PR only if it beats v4 outside the noise band on the fresh holdout; else report.
Timebox 3 h. LLM spend cap $40 at Luna price.

## All chats

- Plan → owner → code. Timebox each step at 1.5× raw; cut scope when over. When a stop rule hits early, take the next item in your list, then report.
- Heavy reads go to subagents so the driver context stays small. Hand off to a fresh session at ~150k context.
- No HMS writes, no sends, no Vitest/tsc on the VPS, kill by PID.
