# Active context

Updated 2026-10-14 after the product assessment. Already imported by root `CLAUDE.md`. Keep this file short; dated research is evidence, not automatically current state.

## Read without rediscovering

1. `PRODUCT.md`: owner specification and hard rules.
2. This file, then `docs/context/OWNER-ASKS.md`: current focus, decisions and unresolved asks.
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

- Actual startup environment had `HMS_QUOTE_PREPARE=true` on http/worker/ai-worker, absent on remote-http. Prepared-quote HTTP access checks it; this is a source-backed parity gap.
- `PARTY_MATCH_V2` is worker-side; its absence on remote-http is not the same defect. Older build-stamp labels do not prove stale loaded code.
- `RESERVATIONIST_PANE_SAVE` was absent on all observed startup environments. Do not infer permission to enable writes.
- Current staff adoption, representative quote-price accuracy, safe live writes and next-hotel readiness were not proved. The handoff's two outbound warnings were not re-counted.

Historical scores: 24/26 action rows, no create rows, dates unscored; classifier agreement 77% at medium effort; party picker no observed wrong binds on 95 evaluated emails, 57.9% auto-bind. These are dated, narrow metrics, not current full-product accuracy.

## Operating rules to retain

- Read the required context in one bounded pass. Inspect relevant changes since the checkpoint. Do not rescan transcripts/corpora or rerun a full retro unless new scope, a contradiction or an explicit research request needs it.
- Discuss settled product direction while independent verification runs. One coordinator owns closure; workers own named outputs/files. Keep one acceptance-tested workflow increment active.
- User voice-dictates. Parse/log asks; do not require repeated specifications. Their flat usage-counter question was a status check, not a request to rush or lower quality.
- Luna handles implementation and large local corpora. Fresh Haiku max handles bounded review. The previous broad Haiku reads were cheap but took over forty minutes; do not repeat that startup pattern.
- Local gateway repurposes Sonnet slot to GPT-6 Luna and Fable slot to GPT-6.1 Sol. Verify routed model; do not trust a CLI label for accounting. No new memory framework is needed for continuity.
- Never ask client staff to run scripts. Diagnostics before a remote fix. No HMS write authority invented; never accept cancellation-penalty dialogs. Never send email independently.
- Before Vitest: unset `DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. DB tests only on the approved disposable local DB. Never expose credentials.
- Local targeted tests/typecheck/oxlint plus adjudicated Greptile findings. No GitHub Actions beyond the authorized Outlook installer; no new GitHub checks without approval.
- One live HMS browser owner. Deploy only through the authorized SSM path from `recover-parse-failure`, warn before live-user changes, and prove both relevant surfaces after the last fix.
- Use a current checkout, not parked worktree/index contents as production source. Nothing in a dated context file authorizes a flag flip, guest write or cleanup.

At handoff: update this short file with verified state, next acceptance check and open holds. Put detailed evidence in a dated report/source index. Keep owner requirements in `PRODUCT.md` and original asks in the ledger. Documents improve discovery; they are not a new enforcement hook.
