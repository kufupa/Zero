# Handoff — Hotel triage-v5 cutover (Task 9)

Date: 2026-07-30  
Status: **BLOCKED** (live retag applied then restored; audit failed 100% gate)

## User override (2026-07-30)

- Skip overnight exhaustive eligibility gate.
- Retag with production triage-v5 predictions (twice-stable Bedrock nova-lite).
- Cutover still **did not land** — audit fail → snapshot restore.

## Live retag attempt

| Field | Value |
| --- | --- |
| Box SHA | `c0fcf78e` (tip; includes `ca97bfe5`) |
| promptVersion | `triage-v5` |
| promptHash | `5b0be70c3860940be9f0d87a08995f54defa8a52c0ba7f1abd17300010ac3b8d` |
| RDS pre-retag snapshot | `nava-zero-mail-pilot-pre-v5-retag-20260730-171047` (available; DeletionProtection=true) |
| KEY_PREFIX | `inbound-triage-retag-v5-20260730-ca97bfe5` |
| Snapshot hash | `6487506d85d67bd53617adcc4ff9efd22ef6fc305a6c7d82b9fac6d81ceb26ae` |
| Inputs artifact hash / sourceHash | `186643190aba043b1a4439ad5edbdd4547bba7c8ed3016007acc5f0f850154ba` |

### Counts

- Eligible cohort: **268**
- Twice-stable approved: **265** (3 unstable excluded; 19 throttle retries succeeded)
- Unstable threadIds: `7bbc2587-8e7e-4373-878b-a13ab396ad26`, `7e0243d9-a645-4df2-bbd3-d64218b83ce2`, `9575f062-3383-4155-b69a-70ac31329d6d`
- Dry-run wouldInsert: **265**, collisions: **0**
- Apply inserted=mutated: **265**, collisions: **0**
- Key probe post-apply wouldInsert: **0**
- Drain: prefix nonterminal **0**, succeeded **265**, failed **0**

### Audit (failed)

- `ok=false`, checkedTargets=265, errors=370
- Kinds: inputHash=265, durableCategory=51, durableSpam=47, approvedOutput=6, durableUrgent=1
- Systemic: audit expects `spam_at` cleared even when approvedCategory=`spam` (durable spam join uses `spam_at`, not AI-managed slug) → spam-approved targets cannot pass as written.
- Systemic: every target failed production inputHash recompute vs worker metrics (asOf/hash path mismatch).
- Residual model drift (approvedOutput): 6 threadIds where drain classification ≠ twice-stable rehearsal.

### Rollback

- `restore-centurion-triage-snapshot.mjs --apply` from `cutover-snapshot.json`
- restored=305, `verifySnapshotAgainstLive` **ok**
- Fresh-prefix succeeded runs remain in ledger (historical); durable AI state restored to pre-retag.

## Hotel now

- PM2: http/worker/ai-worker/hms-ai-worker **online**
- Health: `{"ok":true,"service":"server-pilot"}`
- Code DEFAULT_TRIAGE_PROMPT_VERSION: **triage-v5** (new inbound uses v5)
- Durable Centurion labels: **pre-retag restored** (not cutover-applied)

## Residual risk

- Cutover incomplete; hotel durable triage still pre-v5 labels while runtime prompt is v5.
- Re-attempt needs: (1) audit spam/`spam_at` expectation fix or spam-approved handling, (2) inputHash asOf alignment between worker metrics and audit recompute, (3) optional third-pass stability or approved=drain-output binding, (4) new KEY_PREFIX (current prefix keys already exist).

## Artifacts (on box, no PII in this doc)

`.tmp/triage-quality/rollout/` — snapshot, targets, inputs, rehearsal meta, approved, dry/apply summaries, audit, restore summaries.

## Prior context

- Task7 green on `5b0be70c…`; exhaustive previously ineligible (override skipped that gate).
- Sticky model-wrong: `18829ff1` (do not open into prompt).
