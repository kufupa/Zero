# Active context

Updated 2026-10-26 15:50Z after or2 (overnight run 2, speed mode) closeout. Dated research is evidence, not automatically current state.

## or2 closeout — 2026-10-26 (Opus coordinator)

- **Live: `f70fbae67`** (train deploy 15:42Z; health 200, 4 pm2 online). Last-good before: `60c52d376`. Migration **0054** (`work_item.revision/revision_head/revision_seq`, int default 0) applied 14:40Z with owner approval in chat; columns verified read-only. `/proc` flags unchanged since 12:45Z (save `lab`, Da Vinci reads/quote/create `on`, create `on`, cancel-unpaid `on`, amend/cancel-paid `lab`).
- All T1/T2 units merged except **R-SEED (held)**: needs a DS1-P3b follow-up owning a source-aware append-only `staff_rate_pick` store + reader (migration); never seed via synthetic work items.
- Today on prod: DS4 work-item history (J1 #597 undo/redo revisions, J2 #599, WIRE #607 pane Undo/Redo + Reset to AI + AI/Edited markers + stay/contact hold during refresh), green-main (#605 #606 #608 #609 #610), mail.send approval fix (#611: Azure-route and reservationist `resultDigest` tokens were rejected by the wire schema).
- Pane bundle `nava-pane-DACG_mgw.js` carries Reset to AI/Redo; **no nginx load yet** (staff off the pane until 2026-10-27) → pane bar not passed. Approved-draft send of an Azure draft not live-proven (needs a staff send).
- Next acceptance: owner/staff opens one quote mail, edits a field, sees Undo + AI/Edited; nginx load of `DACG_mgw` after 15:42Z.
- Follow-ups (next run): `ops-deploy --migrate` fails `SELF_SIGNED_CERT_IN_CHAIN` (drizzle-kit lacks `deploy/rds-ca-global.pem`; 1-line `NODE_EXTRA_CA_CERTS` fix); #607 P2 (switching mail mid-Undo holds B's editors until A settles); stay date/room AI markers; 6 `rate-controls`/`rate-cards` test failures on clean main (UI moved to StayRateGrid / BookingCard fixtures); R-SEED. Retro: [or2 retro](ledger/2026-10-26-or2-retro.md); handoff: [session handoff](../plans/2026-10-26-005-session-handoff.md).

## Overnight run 2 plan handoff — 2026-10-26

- Implementation-ready plan: [Run 2 plan](../plans/2026-10-26-002-overnight-run2-plan.md). It defines 45 slices (T0 4, T1 31, T2 8, T3 held 2); dispatch manifest and per-slice briefs are under `/tmp/or2/`.
- Verified state: plan and dispatch artifacts are prepared; no product code was changed, no live environment was inspected, and no deployment, flag flip, mail requeue, or HMS action was performed.
- Next acceptance: run T0 (`S0-PANE` before `S0-PANEL`; `S0-JOBS` and `R-CORPUS` independent), then start T1 only against merged S0 heads; keep `R-SEED` last in T1. Require same-head gates and specified canaries per plan.
- Holds: T2 only after all T1 gates pass; T3 M1/M2 and XLSX parsing stay out tonight. P0 runtime enable/requeue requires the plan's EC2/SSM preflight and current-session authority; no real-guest writes or email sends. Original asks 223–228 remain in `OWNER-ASKS.md`.
=======
Updated 2026-10-26 for the dev-speed scripts handoff. Product-runtime checkpoint remains the 2026-10-25 19:00Z U13-dedup `#550` deploy; dated research is evidence, not automatically current state.

## Dev-speed orchestration scripts — 2026-10-26

- Branch `ops/speed-mode-scripts` adds merge-gate, deploy-train and dispatch scripts plus a fake-`gh` Bash self-test. `bash -n` and `scripts/orch/test-orch.sh` pass; `shellcheck` is unavailable. No remote typecheck/tests, gate record, merge or deploy were run in this lane; the PR remains unmerged.
- Next acceptance: after remote typecheck and targeted remote tests pass, the lane writes `/tmp/or2/gates/<pr>-<headsha>.ok`; confirm Greptile success and zero unresolved Greptile P0/P1 threads before using `merge-gate.sh`. Run the deployment train only from a clean `recover-parse-failure` worktree when a deploy is separately needed.
- Holds: no merge or production deploy from this coding lane; the deploy-train self-test is dry-run only.
>>>>>>> origin/main

## Multi-hotel overnight — 2026-10-25 (Grok orch, plan 2026-10-24-001)

- **Live `20e5389ee`** (U13-dedup `#550` deploy ~18:59Z). Health 200/200. `REPLY_RECHECK=shadow` on http/worker/ai-worker; remote-http UNSET. last-good recorded by ops-deploy.
- Merged this run: U6a-enqueue `#547` `7dd78a67b`, WAL `#548` `e688ddf09`, U13a extras `#549` `56b9c16b7`, U13-dedup `#550` `20e5389ee`.
- Pane: Stay + contact canonical; extras in stay cards; Documents step 5. **DoD6 still FAIL** until a viewer reloads after this deploy.

| DoD | Status | Evidence |
|---|---|---|
| 1 Faith pane DV rooms + wholesale HMS prices, 1 future S4 stay all strategies vs grid | **partial** | G9 A095 8/9 match; WAL HMS-only. `/tmp/mh1024/evidence/G9-hrdav.md`, `/tmp/mh1024/evidence/G9-hrdav-rerun.md` |
| 2 DV BAR ≥10/27 S4 facts | **PARK 2/27** owner item | `/tmp/mh1024/evidence/dod2-s4.md` |
| 3 HRFAKE contract + unknown mailbox refuse | not re-run this slice | — |
| 4 CEN 8-row not lower | **PASS 5/8 = 5/8** | `/tmp/mh1024/evidence/dod4-cen.md` |
| 5 Labtest create+cancel both hotels | **PASS** HRCEN `67907179-1`, HRDAV `96077329-1` + note | `/tmp/mh1024/evidence/dod5-hrcen.md`, `dod5-hrdav.md` |
| 6 nginx pane bundle after last deploy | **FAIL** | SSM access.log 0 hits after 15:37Z |
| 7 reply-check n≥100 + 24h shadow | **eval PASS n=114**; shadow clock to ~2026-10-26 14:50Z; **do not flip on** | `/tmp/mh1024/evidence/dod7-reply-check.md` |
| 8 run closed clean | **open** | U13-dedup worktree still live |

**Owner items:** (1) DoD2 variant A same-day HMS grid vs pane, or B stays quoted ≤3 days. (2) DoD6 real pane reload after U13 deploy. (3) G9 WAL restricted `maxLeadTime=1` excluded by `includeRestricted=false` — likely correct, confirm. (4) `REPLY_RECHECK=on` stays off (labels model-adjudicated).

Compound drafts: `/tmp/mh1024/compound/`. Handoff at 240K: `HANDOFF-FINAL-7`.

## DV install run — 2026-10-22 day (Opus) — paused for retro

- **Live `e5231310a`** (deploy 3 at 14:37Z; last-good `e4d74f6fb`). Health 200/200, 4 procs. Flags on all 4 procs (`/proc` 15:47Z): every `PANE_WRITE_*=lab`, `HMS_DAVINCI_CREATE=lab`, `HMS_DAVINCI_READS=on`. Centurion real-guest create was `on` 12:07–15:47Z, then back to `lab` (owner: testing only, ask 181).
- Merged today: #476, #479 (SR3 retro closeout), #480–#487, #489. Open: #488 (dialog logging; gates incomplete), #462, #463.
- DV create: **not proven** (7 runs, 2 Saves, 0 bookings). DV requires Reservation Note; Save 2 hung on the mask. DV quote: blocked on Centurion-only rate-policy source and 6/10 truth threads.
- Next acceptance: one read-only DV create preflight reporting every blocker, then one Labtest Save with dialog logging (#488). Holds: no real-guest writes; no Faith pairing code until the multi-mailbox design (ask 179) is approved. [Retro](ledger/2026-10-22-dv-install-retro.md) · [Stagehand decision](../research/2026-10-22-stagehand-hms-decision.md).

## SR3 writes + Da Vinci quote — 2026-10-22 (Grok orchestrator)

- **Live product: `5851aa930`** (M1). last-good rollback **`b11e5ac52`**. Docs-only `#477` `7ac2e5498` is on `origin/main` and **not deployed**. Deploy only from `.worktrees/recover-parse-failure`. Health 200 after last ops-deploy; `PANE_WRITE_*=lab` on http/worker/ai-worker/remote-http (`/proc` 04:10Z). `HMS_DAVINCI_MAKE_QUOTE` **unset** (A5 not run).
- Merged: W1 #465, W2 #468, W2b #470, W2c #472, W3 #469, W4 #467, D1 #464, D2 #466, D3 #474, D4 #473, M1 #475. O1 #463 **cut** (no `selections.jsonl.gz` for frozen-431 classifier).
- Proofs: [SR3 proofs](../research/2026-10-22-sr3-proofs.md). Saves 3/3 clicks: **66865808-1 Reserved** (leave it), **82126330-1 Cancelled** (penalty dialog not accepted), 06:36 unverified (search later saw **84701420-1 already Cancelled**; SR3 did not cancel that conf — **who cancelled: unknown**). Amend **0/2**. Cancel **1/2**. D0 HRDAV n=2 `quote`.
- Next acceptance: one Labtest amend commit; `HMS_DAVINCI_MAKE_QUOTE=on` only after quote path uses davinci CDP; O1 classifier if selections exist. Holds: no switch=on, no real-guest, no penalty-dialog accept.

## SR2 stay-request v2 run — 2026-10-21 (Grok orchestrator) — closed

## SR2 stay-request v2 run — 2026-10-21 (Grok orchestrator) — closed

- **Live: `b11e5ac52`** (deploy #7 10:57Z; last-good `621058d23`). Health 200/200; `RESERVATIONIST_PANE_SAVE=lab` on http/worker/ai-worker (unset remote-http); `HMS_DAVINCI_READS=on`. Pane bundle `nava-pane-CP6dZvHL.js` (built 04:15Z, after the last pane merge) loaded 05:08Z, 07:05Z, 11:06Z.
- Merged 22 product PRs (#431–#455): pane U1/U2/U6/U7/U9, quote U3/U10, extraction U5a/U5b/U5r, Labtest create U4–U4d (**first pane Save passed, `25526053-1`**), amend U8/U8b (refuses on blank deposit, 0 commits), multi-mailbox ingest UDV-1/2/2b/3 + UH5. H5 promoted 3,363 Da Vinci rows (0 duplicates, AI skipped).
- Not done: quote replay (#451 U11b draft, 598 LOC) never ran, so the quote bar is unproven (last 5/8, n<10). Amend needs the owner's payment rule.
- Retro: [SR2 retro](ledger/2026-10-21-sr2-overnight-retro.md). Readiness: [client readiness](../research/2026-10-22-client-readiness.md).
- **HMS has planned maintenance every Wednesday ~12:00 to 15:00–15:30 SAST** (hotel IT). Failures in that window are expected.
- Next acceptance: quote score ≥10 threads (D2); one Labtest amend commit (D1); Centurion stay-lookup reliability (66 failed + 66 lock-busy in 7 days outside maintenance); live Da Vinci mail routed. Holds: no flag flips, no real-guest writes.

## Overnight quote run — 2026-10-20 (Opus orchestrator, ask 150/151)

- **Live: `3e1acb694`** (deploys 03:47Z `593d36283`, 04:24Z `3e1acb694`; last-good before `1181ca923`). ops-deploy rc=1 = 24 h dead-letter gate only; health 200/200; 4 pm2 procs; `/proc` flags unchanged (save `lab` on 3 procs, unset remote-http). Served bundle `/var/www/nava-mail/assets/nava-pane-D0woVfWG.js` carries "Prepare PDF + reply".
- Merged: #421 top Prepare PDF + reply, #423 rate plan picker in step 4, #422 Dinner B&B ask priced on Government (NGOVDB) by prepare + pane auto-runs, one strategy per mail, staff choice sticks; #425 HMS tiers STAFF 10 > PREFILL 0 > DEV -10 > REFRESH -20. DEV work is configured to defer 05–16Z when staff/prefill work is pending (`HMS_DEV_GATE=off` disables it); the live held-job behavior remains unproved.
- **Quote score (individual threads, n=8, staff PDF/reply truth): 5/8 plan class + board + room** (was 1/8 on `1181ca923`), exact price 2/8. Misses: extraction board/occupancy 2, contract party not bound 1, government B&B ask not detected 1. n < 10 → quote bar **not passed**. [Scoreboard](../research/2026-10-20-quote-backtest-pool.md).
- Run-health: staff_quote queue TTL 10 min drops tail of a ≥5-job burst; prepared quotes get 1 attempt on transient failure (~15% dead-letter class). Not fixed.
- Labtest create (plan Part 2 N-d): **blocked**. Preview passes 4/4; pane commit fails 2/2 at guarantee-type combo (`create-lab-stay.mjs` `chooseCombo`, 5 s) before Save — `clickedSave` null, nothing booked. Needs a DOM look at the commit screen state: failure screenshots on EC2 `/tmp/pane-stay-e635e858-*/failure.png` and `/tmp/pane-stay-c87e5e65-*/failure.png` (SSM 24k cap blocked fetch). Untracked eval scripts on EC2 `apps/server-pilot/scripts/_backtest-reprice-20261020.ts`, `_lab-book-20261020.ts`. Prefill backtest N-b: truth too thin (1 provisional row) — [report](../research/2026-10-20-booking-prefill-backtest.md).
- Bundle `nava-pane-D0woVfWG.js` loaded from nginx at 05:12:56Z (200), after the last deploy; requester IP not checked, so this proves a load, not who loaded it. A prefill `search_guest` ran at 05:14Z.
- Read-only prod check 10:18Z: still `3e1acb694`; priority 10 n=10 succeeded (wait p50/p90 3/82 s), priority 0 n=49 (48 succeeded, 1 staff_quote dead-letter; wait 3/50 s). No DEV runs, so the staff-hours DEV hold is not proved. Bundle returned 200 at 10:18:57Z (two source IPs across both observed loads; identities unverified). Details and limits: [overnight retro](../research/2026-10-20-overnight-quote-retro.md).
- Next acceptance: owner UI review remains unrecorded; quote truth set ≥10, prepared-quote TTL/retry fix, DEV-held-behind-PREFILL proof, Labtest DOM diagnosis, and webmail viewer + unsent draft remain open. Holds: no flag flips; 7 D2 `staff-quote-job.test.ts` failures share the `retry_wait` harness (4 baseline + 3 D2); the live NGOVDB R1 700 proof does not cover these tests.

## Quote-first planning and cleanup — 2026-10-20

- Planning only. Current planner branch starts at main9ad55993e; prod independently1181ca923. Quote queue/preparation enabled; save remains lab on3procs and unsetremote-http. No new product build/deploy/write.
- Owner147/148: reliable quote chain, click PDF acceptable. [Current plan](../plans/2026-10-20-001-fix-centurion-quote-ready-plan.md) proposes one coherent pending-safe accessible Prepare PDF + reply PR, not two micro-PRs. Grok final review + Greptile, Sol coordination; no routine extra Opus. First browser-proved release90min working estimate includes15baseline/45all-in UI/10deploy/20canary; native/staff waits and price defects excluded, full quote bar unproved. Next rate selector beside existing prices45min guideline, no duplicate display. Planning only.
- Removed5merged-clean Orca trees with archive branches; preserved3parent untrackeddocs byte-exact and tar-backed. Dirty triage/diskretention, old mainWIP and open handoffPR420 remain. Original owner asks139–146 retained.

## Party lookup + pane review — 2026-10-19 (B2 party design chat)

- Live at `1181ca923` (#418, deployed 00:28Z 2026-10-20; last-good before `78c29b5ae`, then `1c74f42b5`; env backup `.env.production.bak-20261019-party-hybrid`). `PARTY_MATCH_V3=true` and `PARTY_HISTORY_BIND=on` on http/worker/ai-worker (`/proc` checked); remote-http has no party flags, same as V2. Health 200/200.
- Hybrid shipped: v2 picker on v3 rows (#408), sender history learned from staff picks (#410, migration 0051), null-id history binds a unique same-kind row + no own-brand/country search terms (#414), email-named party beats history (#417, #418 exact-name rule restored).
- Score (same 42 mails, read-only replay p10 on #418): **20/22 right, 0 wrong**, top-3 20/22, 2 of 20 v2-misses bound, p50 29 s / p90 42 s vs v2 21/22 at 65 s. p9 on `78c29b5ae` was 12/22 (regression, fixed). [Decision](../research/2026-10-19-party-strategy-decision.md) §5d.
- Owner pane review (asks 133–137): step 1 is now "Agency & company", a preset dropdown with every same-kind HMS row (IATA · city · address, no id), ✓ confirm / ✏ edit / "Search HMS…" (#413); stay card ⓘ, Copy/Remove icons, nights dropdown, Skyscanner date clicks (#416, Check-out fix #417); rooms left on rate cards (#412); Source of business preset Email (#415).
- Next acceptance check: owner look at the pane before 05:00Z staff start; staff bundle load in nginx; party bar needs ≥ 100 non-circular truth rows (only 22 here). Open: asks 134 (real rates in Rate authority), 136 (extras/shuttle), 137 rest (no re-editable fields at Book in HMS), 132 (reusable HMS login).

## Chat A (HMS speed) — 2026-10-19

- Party wait p50 411 s (72 h) was an overnight backfill burst, not queue order; staff-hours wait 1–3 s. Fix #376 (`57b23c965`, **deployed 10:43Z**, last-good before `a00c2b783`; ops-deploy rc=1 only from the 24 h dead-letter gate, health/4 procs/VPN OK): background party/quote prep only for live-admitted, actionable mail. Handoff and next slice (session reuse; ~75% of party run time is repeat login/navigation): [Chat A handoff](../plans/2026-10-19-chatA-handoff.md).

## Lane R (ready before open) — 2026-10-19

- Read-only snapshot at 15:33Z: 3/21 quote opens had persisted-ready receipts (14.3%; `dinnerAddOnRequired=false` on all three, full pane usability unproven); party 0/36 and booking-find 0/21. All 78 recorded target-action pane events preceded the ~15:00Z #390/#391 rollout, so post-rollout effect is unmeasured. Report: [ready-before-open scoreboard](../research/2026-10-19-ready-before-open.md).
- Hold: action-at-open is unavailable for 73/78 rows and persisted skip reasons do not prove “flag off” or workflow eligibility. Next acceptance check: after pane events arrive post-rollout, remeasure readiness and waits with action-at-open coverage and persisted prefetch decision reasons; coordinator merges the docs-only PR.

## Overnight triage run — 2026-10-19

- Classifier reads prior thread mail only (#369); action rules rewritten from a frozen eval (#370, #371). Prod at `357315940`, extractor `extract-3ccdd9c9966e` (rules v4). Last-good before: `f37e07b8b` (v2), `b529984b3` (pre-run).
- Frozen Centurion test (431 rows, silver labels, leak-free prod prompts, Luna max): prod rules 81.0–83.3% acc / 78.5–81.1 macro-F1 → **v4 90.3% / 88.6**. Bar not fully met: quote P/R 88.5/88.5, new_booking P 85.9. Report: [2026-10-19 leak-free triage eval](../research/2026-10-19-leak-free-triage-eval.md).
- Flags (owner-approved in the executing chat): `INBOUND_TRIAGE_CLASSIFIER=off` and `PANE_PRECLASSIFY` unset on http/worker/ai-worker (remote-http never had either); `/proc` checked. Backup `.env.production.bak-20261019-triage-flip`. Channel mail keeps its triage run by design.
- HMS browser on 19223 now runs as `hms-slot@hrcen` (systemd, enabled; env `/etc/nava/hms-slot-hrcen.env` incl. `PLAYWRIGHT_BROWSERS_PATH=/opt/nava/ms-playwright`). First attempt without that path crash-looped; HMS reads were down ~2 min (04:15–04:17Z, 0 runs in flight).
- Final live proof at 2026-10-19 10:01Z: 55 successful post-deploy Centurion extractions on `extract-3ccdd9c9966e`, 2 quote-class `read_tool` runs succeeded (09:55Z, 09:58Z), zero dead letters. Acceptance proof complete; no HMS writes or sends. V5 candidate rejected after test macro-F1 and quote/cancel recall regressed; v4 remains live. #118 decided YES (2026-10-19 15:25Z): system_notice + new_booking routes to payments; PR #399 open. Remote workflow tests 33/33, typecheck 0 errors, oxlint clean, Greptile round 1 had 0 comments. Next check: coordinator review/merge; this lane did no deploy, live HMS probe, or DB-backed SQL proof. Other owner decisions open: 180 silver disagreements, Azure content-filter blocks.

## Chat D (triage holdout) — 2026-10-20 (D5 done)

- Live v4 rules (sha `6cf0dbde…`) scored on the untouched Aug 1–Sep 8 thread-disjoint test: 436 silver rows, vision on (28 rows / 53 images), text prompt parity 436/436, prod model/effort/deadline on EC2 `1181ca923`. **Pass 1 94.0% acc / 91.6 macro-F1, pass 2 93.8 / 90.2**; 421/436 rows (96.6%) agree across passes; 0 final failures after retry, but 36/872 first attempts (4.1%) hit the prod 180 s deadline (PRODUCT ≤1% bar ✗ at that deadline; prod's own rate not measured); 0 429s; $3.35 Luna. Report: [held-out v4 score](../research/2026-10-20-chatd-heldout-v4-score.md).
- On silver, money classes meet the leak-free triage bar on both passes (quote 11/11, new_booking P ≥96 / R ≥97). Outbound-grounded rows are only n=6 (6/6, 4/6). One booking skip on one pass (`e0e0f8dd`, internal staff booking ask); 6 of 8 actionable→no_action misses are internal hotel-staff mail (the v2 rule's "internal staff mail = no_action").
- Hold / next: no GEPA (no silver money-class gap outside noise; the skip is a policy row). Check prod's extraction timeout rate against 4.1%. Owner rules on internal-staff work mail; if yes, one rule + re-score ×2 on this same held-out set. 41 silver-disagreement test rows unscored, pending owner/adjudicated labels. D0 quote-reply linkage still unresolved; D1/D2 not run.

## Lane TRI handoff — 2026-10-15

- [PR #297](https://github.com/kufupa/Zero/pull/297) routes `gpt6_luna_max` triage through Azure GPT-6 Luna; the targeted adapter contract file passes 13/13 tests. No prod/EC2/env changes were made.
- Hold: not merged, deployed, or live-proven. After merge and owner authorization, apply `AI_TRIAGE_MODEL_PROFILE=gpt6_luna_max` via the sanctioned #273 legacy env path, run `ops-restart.sh`, inspect `/proc/<pid>/environ` for the four named processes, and prove one new succeeded `inbound_triage` plus zero dead letters since switch; details are in the PR. Azure billing-rate parity remains unverified.

## Read without rediscovering

1. `PRODUCT.md`: owner specification and hard rules.
2. This file, `docs/context/WORKSTREAMS.md` (all workstreams by ROI), then `docs/context/OWNER-ASKS.md`: current focus, decisions and unresolved asks.
3. `docs/research/README.md`: conclusions and exact evidence pointers; open only relevant reports.
4. `AGENT.md`: commands and layout. Check current branch/remote revision before any claim.

Long assessment: [2026-10-14 product and delivery assessment](../research/2026-10-14-product-assessment.md).
Evidence/methods: [2026-10-14 source index](../research/2026-10-14/README.md).
Historical entry snapshot: [SESSION-ENTRY-2026-10-14.md](SESSION-ENTRY-2026-10-14.md).

## Product and focus

Nava is the live AI reservationist for Centurion. The same pane runs in classic Outlook and webmail. Infor HMS remains the system of record. Reads can prepare in the background; consequential writes require explicit authority, staff approval and result review.

Full roadmap: quote, create, amend, cancel; then voucher/payment-proof/billing, grouped rooms and repeatable next-hotel onboarding. Email-only; OTA booking operations remain outside current scope. Sequencing is not deleting eventual features.

**Owner correction:** same familiar folders and mail experience, with different action triage behind them. Not a new inbox-reuse/redesign project. Keep reply actions and the same pane; do not add another review desk.

Recommended next slice, not yet built: make one action meaning feed existing folder/mail behavior, saved owner correction and actual routing evaluation. Expose waiting/failed-extraction mail rather than hiding it. Then close date/rate/bookability/prepared-quote parity gaps and prove the complete quote workflow.

No new product work is running from the assessment. Current source-backed gaps:

- Gold save stores owner labels, but live action-folder membership does not consult them. Quote/New booking selection can switch pane intent; folder membership is separate.
- Current action-folder query requires successful extraction. That view is not a representative all-inbound review set.
- Amendment prepares a diff; save is not wired. Cancellation preview is disabled in the pane. Create is guarded, not production-proven.
- Raw nightly stock is not full-stay bookability. Check minimum/maximum stay and other restrictions separately.
- Labeling false positives in Quotes misses false negatives elsewhere. Unreviewed predictions are not gold; action, extracted facts and quote/write outcomes need separate judgments.

## Last observed runtime, not a current permission

Read-only check 2026-10-14 18:03:56Z: EC2 checkout `15e5bb63b`; remote main at audit `00c10fd21` added handoff docs only. Admin HTTPS and both backend health endpoints responded; four processes were online. Runtime evidence: [evidence.json](../research/2026-10-14/evidence.json).

- Actual startup environment had `HMS_QUOTE_PREPARE=true` on http/worker/ai-worker, absent on remote-http. A prepared-quote HTTP route checks it; actual pane/backend routing was not proved, so this remains a potential parity gap.
- `PARTY_MATCH_V2` was observed on http/worker/ai-worker; its absence on remote-http was not verified as a defect. Older build-stamp labels do not prove stale loaded code.
- `RESERVATIONIST_PANE_SAVE` was absent on all observed startup environments. Do not infer permission to enable writes.
- Current staff adoption, representative quote-price accuracy, safe live writes and next-hotel readiness were not proved. The handoff's two outbound warnings were not re-counted.

Historical scores: 24/26 action rows, no create rows, dates unscored; classifier agreement 77% at medium effort; party picker no observed wrong binds on 95 evaluated emails, 57.9% auto-bind. These are dated, narrow metrics, not current full-product accuracy.

## Operating rules to retain

- Read the required context in one bounded pass. Inspect relevant changes since the checkpoint. Do not rescan transcripts/corpora or rerun a full retro unless new scope, a contradiction or an explicit research request needs it.
- Discuss settled product direction while independent verification runs. One coordinator owns closure; workers own named outputs/files. Keep one acceptance-tested workflow increment active.
- Parse voice-dictated requests into logged asks and acceptance criteria; retain original wording.
- Luna handles implementation and large local corpora. Fresh Haiku max handles bounded review. The previous broad Haiku reads were cheap but took over forty minutes; do not repeat that startup pattern.
- Local gateway repurposes Sonnet slot to GPT-6 Luna and Fable slot to GPT-6.1 Sol. Verify routed model; do not trust a CLI label for accounting. No new memory framework is needed for continuity.
- Never ask client staff to run scripts. Diagnostics before a remote fix; establish the causal chain before changing behavior. No HMS write authority invented; never accept cancellation-penalty dialogs. Never send email independently.
- Before Vitest: unset `DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. DB tests only on the approved disposable local DB. Never expose credentials.
- Local targeted tests/typecheck/oxlint; validate findings and fix confirmed P0/P1 before merge. Check Greptile on the exact PR head; never bypass hooks with --no-verify. No GitHub Actions beyond the authorized Outlook installer; no new GitHub checks without approval.
- Opus/lead review covers write paths, migrations and auth. Live-probe each changed HMS runner on EC2; unit tests do not see the HMS DOM. One live HMS browser owner. Deploy only through the authorized SSM path from `recover-parse-failure`, warn before live-user changes, and prove both relevant surfaces after the last fix.
- Use a current checkout, not parked worktree/index contents as production source. Nothing in a dated context file authorizes a flag flip, guest write or cleanup.

At handoff: update this short file with verified state, next acceptance check and open holds. Put detailed evidence in a dated report/source index. Keep owner requirements in `PRODUCT.md` and original asks in the ledger. Documents improve discovery; they are not a new enforcement hook.

## Other open items and navigation

- Outlook multi-mailbox (ask 179): one Outlook workstation with several mailboxes and one Nava login. [Handoff](HANDOFF-2026-10-22-outlook-multi-mailbox.md); design only, no pairing code issued.
- Host tooling audit (not Zero product work): all four CLIs currently use separate registrations for the same Exa endpoint/key; the hosted tool surface lacks Dynamic Highlights. No client settings changed. Plan: [Exa Dynamic Highlights across four agent CLIs](../plans/2026-10-19-001-exa-dynamic-highlights-plan.md). Next acceptance check: owner explicitly authorizes execution; then test the local stdio canary before any config swap. Hold: implementation and client changes are not authorized by this planning-only request.
- Webmail sync/access wording and the earlier workflow-folder load error: current live status not reverified. All core-workflow accuracy and final staff-bundle proof remain open. Historical overnight statuses are in the dated assessment, not silently claimed complete.
- Current source exemptions preserve human Profitroom enquiries and non-notice H-Pay finance mail. RateTiger had no host evidence in the handoff. If broad vendor-skip wording means something different, clarify the policy before changing revenue-mail handling.
- Code map and commands: AGENT.md. Verified solutions: docs/solutions/. Vocabulary: CONCEPTS.md. Mistakes: docs/context/MISTAKES.md. Run history: docs/context/ledger/. Record new verified mistakes at handoff.
