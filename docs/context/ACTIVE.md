# Active context

Updated 2026-10-19 after the overnight leak-free triage run. Already imported by root `CLAUDE.md`. Keep this file short; dated research is evidence, not automatically current state.

## Chat A (HMS speed) — 2026-10-19

- Party wait p50 411 s (72 h) was an overnight backfill burst, not queue order; staff-hours wait 1–3 s. Fix #376 (`57b23c965`, **deployed 10:43Z**, last-good before `a00c2b783`; ops-deploy rc=1 only from the 24 h dead-letter gate, health/4 procs/VPN OK): background party/quote prep only for live-admitted, actionable mail. Handoff and next slice (session reuse; ~75% of party run time is repeat login/navigation): [Chat A handoff](../plans/2026-10-19-chatA-handoff.md).

## Overnight triage run — 2026-10-19

- Classifier reads prior thread mail only (#369); action rules rewritten from a frozen eval (#370, #371). Prod at `357315940`, extractor `extract-3ccdd9c9966e` (rules v4). Last-good before: `f37e07b8b` (v2), `b529984b3` (pre-run).
- Frozen Centurion test (431 rows, silver labels, leak-free prod prompts, Luna max): prod rules 81.0–83.3% acc / 78.5–81.1 macro-F1 → **v4 90.3% / 88.6**. Bar not fully met: quote P/R 88.5/88.5, new_booking P 85.9. Report: [2026-10-19 leak-free triage eval](../research/2026-10-19-leak-free-triage-eval.md).
- Flags (owner-approved in the executing chat): `INBOUND_TRIAGE_CLASSIFIER=off` and `PANE_PRECLASSIFY` unset on http/worker/ai-worker (remote-http never had either); `/proc` checked. Backup `.env.production.bak-20261019-triage-flip`. Channel mail keeps its triage run by design.
- HMS browser on 19223 now runs as `hms-slot@hrcen` (systemd, enabled; env `/etc/nava/hms-slot-hrcen.env` incl. `PLAYWRIGHT_BROWSERS_PATH=/opt/nava/ms-playwright`). First attempt without that path crash-looped; HMS reads were down ~2 min (04:15–04:17Z, 0 runs in flight).
- Final live proof at 2026-10-19 10:01Z: 55 successful post-deploy Centurion extractions on `extract-3ccdd9c9966e`, 2 quote-class `read_tool` runs succeeded (09:55Z, 09:58Z), zero dead letters. Acceptance proof complete; no HMS writes or sends. V5 candidate rejected after test macro-F1 and quote/cancel recall regressed; v4 remains live. Owner decisions open: system_notice folder routing, 180 silver disagreements, Azure content-filter blocks.

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

- Webmail sync/access wording and the earlier workflow-folder load error: current live status not reverified. All core-workflow accuracy and final staff-bundle proof remain open. Historical overnight statuses are in the dated assessment, not silently claimed complete.
- Current source exemptions preserve human Profitroom enquiries and non-notice H-Pay finance mail. RateTiger had no host evidence in the handoff. If broad vendor-skip wording means something different, clarify the policy before changing revenue-mail handling.
- Code map and commands: AGENT.md. Verified solutions: docs/solutions/. Vocabulary: CONCEPTS.md. Mistakes: docs/context/MISTAKES.md. Run history: docs/context/ledger/. Record new verified mistakes at handoff.
