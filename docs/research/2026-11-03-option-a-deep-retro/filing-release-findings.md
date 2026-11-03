# U2 Filing/Cancel + U4 release retro (cutoff 2026-11-03 19:14 UTC)

## Verdict

No pilot was deployed by cutoff. `origin/main` had U0/U1/U4-prep, but U2/U3 remained unmerged; prod was still `0da451e` per the 19:05 handoff. No final-main remote typecheck, `ops-deploy.sh`, flag cutover, or final-SHA canary is evidenced. Code merge readiness was mistaken for release readiness.

The unexercised gate is a real source constraint: HRCEN `on` flips require a matching exact 40-hex final-SHA `CANARY PASS`; the supported Cloud Create commit also refuses while `PANE_CLOUD_CREATE_DISPATCH` is off. No in-repo PASS producer was found. If PASS means the same flag-gated pane Save, this is circular; do not fabricate PASS or bypass the writer. See source below.

## Timed work (spans include waits; overlapping sessions must not be summed)

| Task | UTC wall interval / observed time | Evidence + necessity |
|---|---|---|
| U4 release recon | 14:44:44–14:54:57; 10.21m, 32 ops | Necessary: dirty deploy tree/clean-main route and flag/deploy constraints. It found a safe clean checkout route; no deploy. `sessions.csv:3`; `worker-evidence.md:107–122`. |
| U2 first implementation | 15:18:10–15:47:44; 29.57m, 227 ops, 10 waits | 112 focused tests; no live/DB tests. Native stay/document binding, cancel approval/recovery, uncertainty/penalty guards; necessary connected workflow work. Frozen at 15:47:44. `sessions.csv:8`; `worker-evidence.md:284–294,354–358,411–458,485–503`. |
| U2 review/fixes | Review at 16:05 found 5 P1 blockers; fixes ran 16:07:26–16:32:05, 16:39:14–16:48:22, 16:56:17–17:04:55, 17:09:58–17:15:13. Fix session span 67.79m, 361 ops, 29 waits; two review sessions 18.16m + 21.21m (overlap/gaps). | Real safety issues: missing source-bound generic Cancel handoff, timeout before fresh read, incomplete linked-stay list proof, slow-read race; final fix wired generic card to same guarded preview/Go. Necessary; not “review ceremony.” `sessions.csv:11,14,18`; `turns.csv:31–72`; `worker-evidence.md:635–671,703–707`. |
| U4 pane/launcher recon | 16:50:55–16:56:35; 5.67m, 31 ops | Useful read-only source check: existing `playwright-real-mail-ui-gate.sh --read-only` proves login/list/thread launch, not pane workflow/native readback. No E2E driver found. `sessions.csv:15`; `worker-evidence.md:1121–1125`. |
| Mailbox selector recon | 17:18:17–17:22:09; 3.88m, 18 ops | Low value once using an already-selected Labtest item/direct pane output; not a release gate. `sessions.csv:19`; `worker-evidence.md:1370–1422`. |
| Admin browser “canary” search | 17:40:48–18:56:53; 76.09m, 223 ops, 31 waits (28 browser/canary-classified); active turns 17:40:48–18:09:25, 18:28:59–18:42:51, 18:47:27–18:56:53. | Not a canary: selected real travel-agent email was “Not for Nava”; first open marked it read; exact live SHA/source binding absent; no Go/write. Search did not establish actionable input. `sessions.csv:22`; `turns.csv:79,82,95,101,103–104`; `worker-evidence.md:1733–1771,2094–2103`. |
| Cancel payment/folio widening (mixed U5 session) | 18:45:22 investigation start to cutoff 19:14; parent’s whole mixed session was 17:34:56–19:13:57 (99.01m, 559 ops, 46 waits; not all Cancel). | Need payment coverage before widening; not needed to ship a *narrow* gate, but no evidence justified broadening. 18 numbered probe/receipt pairs existed by cutoff (probe18 19:11:29, receipt18 19:11:51); probe19/20 are post-cutoff (19:17+). 19:05 handoff’s “12” is stale. `sessions.csv:21`; `turns.csv:102`; `worker-evidence.md:2032–2048,2088–2092`; `/tmp/zero-option-a-u2-finance.uUUJ1I/`. |
| U4 env/cutover draft | Writer inspection 18:02:15; staged-wrapper claim by 18:08:36; 413-line draft existed by cutoff; not executed. | Env preservation/process checks are necessary; the bespoke wrapper is not evidence of deployment. Cutover notes explicitly say review draft/not run and retain canary gate. `worker-evidence.md:1725–1762`; `/tmp/zero-option-a-u4-cutover-notes.md:1–3,14,27,38–40`. |

## Cancel: separate unpaid classification from guarantee label

`classifyAmendPayment` returns `unpaid` only for provisional status + confirmed zero/blank deposit + non-paying guarantee; missing/unknown evidence stays `unknown` (`/home/orca/.codex/worktrees/810e/zero/apps/server-pilot/src/ai/pane-stay-lookup.ts:227–247`). Commit re-reads/classifies and refuses non-unpaid (`pane-stay-cancel.ts:353–372`). Preserve this meaningful guard.

Cloud Cancel additionally binds NGI/“Non-Guaranteed Individual” and zero deposit (`pane-cloud-cancel.ts:33–39`; `tooling/hms-cloud/pane-cancel-session.mjs:36–53`). NGI alone is not unpaid proof; deposit zero alone does not establish no folio/advance-deposit transactions. At 18:49:53 the reader could not certify complete transaction coverage; at 18:56:45 All Folios was empty and separate advance-deposit coverage was still being checked (`worker-evidence.md:2044–2048,2088–2092`). Thus broadening was a legitimate safety question, but an unbounded 18-probe chase was optional for a first narrow launch. Do not enable Cancel solely because it is NGI; hold until an independent payment/folio proof exists. Do not discard the unpaid classifier.

## U4 release gate and wrapper critique

| Gate | Evidence / finding |
|---|---|
| Main/Create claim | Read-only GitHub history: #989 opened 15:41:58, merged 18:20:31; #990 opened 15:49:57, merged 18:21:56; origin/main `dc26b3863`. Create’s last code commit was ~16:51:54: 88m37 to merge, but “idle” is unproven and merge is not deployment. At cutoff U2/U3 unmerged (`HANDOFF-2026-11-03-option-a-ship-now-steer.md:11–22`; `WORKING.md:17–18`). |
| Canary | `origin/main:apps/server-pilot/deploy/write-ec2-remote-env.sh:341–347,360–370,412–467` requires workflow/property/final SHA before `on`; for HRCEN `exactSha` requires 40-hex exact match. `pane-cloud-preview.ts:58–60,582–595` requires `PANE_CLOUD_CREATE_DISPATCH=on` to commit. Read-only `git grep` found PASS text in the writer and tests only, no producer. Test fixtures are not production proof. This is the unresolved circularity/operational hold—not a reason to bypass flags. |
| Env safety | Keeping unrelated env values is required: `write-ec2-env.sh:74–99` rebuilds `.env.production`; remote-http has a separate env. Verifying effective `http`, `worker`, `ai-worker`, `remote-http` controls is required (`PRODUCT.md:47`; cutover notes:38). The 413-line wrapper stages copies, exact-compares settings, backs up/rolls back files, and traverses PM2 process trees; these are unexecuted/unreviewed extra mechanics. Preserve invariants, but do not confuse wrapper length with readiness. |

## Browser task: required outcome, wrong method

Original `/goal` asks final-head checks, screenshots, fresh readback, and deployed connected workflow (`/home/orca/.codex/attachments/7560d57f-7ce9-4d29-ae01-3a151fc122fc/pasted-text-1.txt:13–18,55–67`). PRODUCT says end-to-end on deployed pane plus final fake booking (`PRODUCT.md:57`), not “click around.” Owner reaffirmed a prior no-click instruction after cutoff (historical original locator not recovered; `WORKING.md`), and governs this audit: take pane output directly. The 17:40 real-email browser session was not required launch verification and produced no canary; its first open had a real read-state side effect.

No-click evidence ladder: (1) read the pane’s direct Prepare output for a known fake Labtest item—proves source binding, classification, fields and displayed status, not a save; (2) capture actual deployed route response plus final SHA—proves runtime routing, while component/unit output alone proves only code; (3) a real guarded fake Save with before/after evidence and fresh native readback proves persistence. But Create commit requires the dispatch flag already on, and its writer needs pre-flip PASS; no approved PASS producer/path was found. Keep that as a hold, never bypass it. Process-env inspection is separate proof for all four PM2 processes.

## Retro corrections

“U2 226m+” is elapsed lane age, not 226m hands-on; the later 99m finance session mixes U5 and Cancel and overlaps other work (`WORKING.md:7`, `sessions.csv:21`). 112 U2 tests were useful; this scoped evidence cannot support “tests negligible,” and no aggregate test-runtime estimate is made here. The 16:51→18:20 Create merge gap is real, but calling it pure idle or “deployable” omits final-main remote checks, flag/canary gate, deploy and live acceptance. Main could have been code-deployed inert; a pilot could not honestly be declared ready by 19:14.

## Scope / method

Read-only inspection only; no tests, browser, DB, live calls, or repo edits. Cutoff is exactly 19:14 UTC; later probe19/20 and owner correction are excluded from task-time totals. Evidence includes PRODUCT, original `/goal`, handoff/retro, indexed worker rollouts, worktree code, origin/main source, and read-only GitHub PR history. Unresolved: actual remote `/tmp/mh1024/CANARY.txt` contents and live process state were not read.
