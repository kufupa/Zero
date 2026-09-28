---
title: Centurion nine-day corpus and human-response tool analysis
date: 2026-09-17
type: research
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: autonomous-analysis
execution_posture: one-pass
---

# Centurion nine-day corpus and human-response tool analysis

**Objective:** export the newest Centurion email evidence from production RDS and the quarantine store, classify every message, then perform a blinded inbound-to-human-response analysis that identifies the operations and PMS tools needed to replace the human reservationist.

**Scope window:** `2026-09-09 00:00` through `2026-09-18 16:50` in `Africa/Johannesburg` (staff logoff; end exclusive). Mail after 16:50 the same calendar day is quarantine spillover only, not core totals. Unanswered in-window inbound stays in (replies may arrive after cutoff).

## Goal Capsule

- Produce a private, reproducible RDS/quarantine snapshot with complete available email evidence.
- Produce daily inbound/outbound classifications and quarantine reconciliation.
- Read every eligible message with Luna Max workers; do not sample or reuse the old pending-work denominator.
- For every in-window human outbound, predict required operations from information available before that reply, then compare against the actual human response.
- Produce an evidence-backed PMS tool demand report and a sanitized handoff for the running “Analyze Stagehand tool costs” work.
- No email sending, PMS mutation, quarantine promotion, production repair, or app deployment.

## Product Contract

### Requirements

- R1. Scope normal mail to the Centurion transport and the fixed Johannesburg window; retain older linked messages only as context.
- R2. Include `mail_ingest_quarantine` records and recover relevant raw MIME read-only, especially `parse_failure` records from the reported ingestion incident.
- R3. Preserve complete text, HTML, headers, participants, timestamps, thread/reply identifiers, attachment descriptors, raw hashes and explicit parse/attachment failures.
- R4. Classify every recovered in-window message by business direction, human/automated provenance, primary workflow and secondary intents.
- R5. Produce daily totals, inbound and outbound category tables, quarantine reconciliation, spillover reporting and coverage audits.
- R6. Evaluate every in-window human outbound as a held-out target. Predictor input must end before the target reply and must not contain target or later information.
- R7. Compare predicted semantic operations and required fields with the human response; distinguish claimed human actions from independently verified PMS actions.
- R8. Rank candidate PMS tools from distinct task demand, including unanswered and ambiguous strata; do not infer endpoint or PMS execution facts from email alone.
- R9. Keep raw PII and attachments private; publish only aggregate tables and sanitized handoff material outside the private corpus.

### Scope boundaries

Included: production RDS reads, approved S3 raw-MIME reads, local parsing, Luna classification, causal thread matching, blinded prediction, semantic gold comparison, aggregate reports and Stagehand handoff.

Excluded: mail ingestion repair, quarantine promotion/rehydration, writes to RDS/S3/PMS, email generation or sending, PMS tool implementation, schema migrations, app routes, OCR or bulk image extraction, and the unrelated dirty read-tool changes already in the worktree.

## Global Constraints

- Preserve all existing worktree changes. Add only non-overlapping extraction, analysis, tests and private artifacts.
- Use the existing approved EC2/IMDS/read-only RDS path and repeatable-read snapshot. Do not bypass host or credential guards.
- Never call `promote-quarantine`, `rehydrate-raw-mime` or production `parseRawMessage`; the latter can write attachment objects. Parse raw MIME locally with a side-effect-free parser.
- Never run a test runner against pilot/production RDS. Never set `VITEST_ALLOW_PILOT_RDS=1` or source production environment files into tests.
- No raw PII in Git, Exa/web search, external MCP/API, CI, SSM output, collaboration messages or logs. Local authorized workers may read private file paths directly; never paste bodies into prompts.
- Root `.private` must be Git-ignored, mode `0700`; private files must be mode `0600`. Never use the existing unignored `apps/server-pilot/.private` directory.
- Do not claim hotel-mail completeness. Report RDS-and-quarantine-observed coverage and every unresolved source gap.
- Do not treat current thread labels, unread state, regex hits or “pending work” as historical message truth.
- Do not interrupt or modify the running Codex chat titled “Analyze Stagehand tool costs”. Read only its existing local handoff/transcript when needed.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** Continue through extraction, classification, prediction, comparison and handoff until the goal and done criteria are evidenced or a genuine blocker remains. Do not pause for routine choices.

### Communication

- Orchestrator and every subagent: **Respond `/caveman ultra`. Technical terms exact.**
- Use up to five GPT-5.6-Luna-Max workers total. Batch them when the runtime concurrency limit is lower; never reduce coverage to fit concurrency.

### AWS / infra

| Resource | ID / path |
|---|---|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Existing wrappers | `ssm-run-command.sh`, `ops-deploy.sh`, `ops-restart.sh` |

Read-only SSM checks and approved private artifact transfer are allowed. Deployment, migration, restart, seed and reboot are forbidden for this analysis.

### Pilot RDS safety

Never run Vitest or another test runner against pilot/production RDS. Before every test command run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Use a disposable non-production database for database-required tests; otherwise use offline fixtures or read-only checks. Missing disposable test DB is a blocker, not permission to weaken the guard.

### RCA loop

FAIL → reproduce minimally → identify mechanism and file/line → research unfamiliar behavior → choose the smallest safe fix → test → resume. Do not stop at the first red result or hide a failed gate.

### Decision authority

- Choose safe, reversible implementation details without asking.
- Preserve every requirement and log material divergences in the private handoff.
- If one source path is unavailable, continue independent work and mark the affected records blocked; never silently substitute incomplete data.
- Stop only for missing access that cannot be obtained safely, human-only interaction, destructive ambiguity, safety conflict or an outage preventing required evidence.

### Done criteria

- [ ] A sealed manifest records the exact snapshot, time bounds, timezone, transport scope, source counts, schema/model/prompt versions and ordered message/body hashes.
- [ ] Normal and quarantine records are reconciled; the reported quarantine incident count is independently measured; every source row has a disposition.
- [ ] Every eligible in-window message has a direction/provenance/workflow classification or an explicit uncertainty/error reason, with no silent truncation.
- [ ] Daily inbound/outbound/category tables, quarantine audit, September 17 spillover and coverage audit are written under the private corpus directory.
- [ ] Every in-window human outbound has exactly one target status and one frozen pre-target prediction or explicit error.
- [ ] Predictor inputs contain no target/post-target payload, later timestamp/ID, human outcome or future attachment.
- [ ] Gold comparison records semantic predicted operations, human claims, verification status and mismatch reasons.
- [ ] Distinct-task tool-demand rankings and a sanitized Stagehand handoff are produced.
- [ ] Focused offline tests and applicable broader checks pass with pilot-RDS safety verified.
- [ ] No unresolved blocker affects the evidence-backed report.

## Implementation Units

### U1. Guarded Centurion snapshot

**Goal:** Extend the existing guarded exporter with explicit Centurion transport and date bounds without changing its broad default behavior.

**Files:** `apps/server-pilot/scripts/export-centurion-nine-day-corpus-live.ts`, `apps/server-pilot/src/ops/centurion-thread-corpus-postgres-reader.ts`, `apps/server-pilot/tests/centurion-corpus-export.test.ts`.

**Approach:** Use `event_at = sent_at` for confirmed outbound sends, then `received_at`, then `sent_at` fallback, then `created_at`; record the source and fallback. Use UTC-naive database bounds equivalent to the Johannesburg window and convert only for grouping. Preserve `message.direction` separately from inferred business direction. Keep older linked messages as context-only.

**Tests:** timezone boundary inclusion/exclusion; transport isolation; sent/received fallback provenance; duplicate physical rows; missing timestamps; read-only/private-output preflight.

### U2. Quarantine recovery and source reconciliation

**Goal:** Recover parse-failure and other relevant quarantine evidence without invoking mutating ingest paths.

**Files:** `apps/server-pilot/scripts/export-centurion-quarantine-live.ts`, `apps/server-pilot/src/mail/ingest/parse-message.ts` (read-only reuse only), `apps/server-pilot/tests/centurion-quarantine-export.test.ts`.

**Approach:** Read quarantine metadata and raw-MIME/archive keys; parse locally; derive message date from RFC `Date` and preserve quarantine-created time separately. Resolve Centurion routing and direction using effective sender, owner headers, recipients, self/BCC evidence and queue correlation. Keep `inbound`, `outbound`, `ambiguous`, `unattributed`, missing-object and parse-error statuses. Skip bulk inline image extraction; preserve attachment metadata and hashes.

**Tests:** parse-failure with valid MIME; genuinely malformed MIME; missing primary/archive object; owner mismatch; BCC mirror; self-loopback; duplicate UIDL/raw hash; missing RFC date; oversized/unsupported attachment.

### U3. Exhaustive message classification and daily reports

**Goal:** Read every recovered message and create the first aggregate tables.

**Files:** `apps/server-pilot/scripts/classify-centurion-nine-day-corpus.ts`, `apps/server-pilot/tests/centurion-corpus-classification.test.ts`, private `daily-classification.jsonl`, `daily-tables.md`, `coverage-audit.json`.

**Approach:** Shard private inputs across up to five fresh Luna Max workers. Workers read local paths and return opaque IDs, multi-label workflow classifications, evidence spans/locations, primary class, provenance and uncertainty. Do not use the old 20,000-character truncating analyser, future-leaking thread aggregation, outbound-only heuristic or regex counts. Reconcile daily sums to the sealed manifest and report September 17 spillover separately.

**Tests:** no sampling; full-body preservation; multi-intent labels; unknown reason required; daily partition reconciliation; model/schema hash persistence; worker failure and retry accounting.

### U4. Blinded inbound-to-human-response analysis

**Goal:** Predict required operations for every in-window human outbound using only information available before that reply.

**Files:** `apps/server-pilot/scripts/analyse-centurion-human-responses.ts`, `apps/server-pilot/tests/centurion-human-response-analysis.test.ts`, private `target-manifest.jsonl`, `prediction-freeze.jsonl`.

**Approach:** Match targets using RFC reply headers/references, strong thread identity and bounded causal time; never silently choose the first inbound. Predictor receives triggering inbound plus strictly earlier context and attachment evidence, but not target/post-target content or Stage 1 outputs that could leak outcomes. Persist immutable input hashes before gold reveal. Track paired, ambiguous, no-eligible-inbound and outbound-only strata, plus pending-at-cutoff and late-response status.

**Tests:** target leakage rejection; quoted-body leakage; multiple replies per task; multiple intents; pre-window trigger; unanswered inbound; ambiguous match; target at cutoff; unavailable attachment.

### U5. Gold comparison, tool ranking and Stagehand handoff

**Goal:** Compare frozen predictions to actual human responses and produce evidence-backed candidate tool demand.

**Files:** `apps/server-pilot/scripts/compare-centurion-human-gold.ts`, `apps/server-pilot/tests/centurion-human-gold-comparison.test.ts`, private `gold-comparison.jsonl`, `tool-demand-report.md`, `stagehand-handoff.md`.

**Approach:** A separate fresh comparator sees the actual human outbound only after prediction freeze. Grade semantic operations and required fields, not prose similarity. Separate `claimed_action` from `verified_pms_action`; absent an authoritative PMS receipt/read, verification is `not_observed`. Rank by distinct task IDs with answered, unanswered, automated, ambiguous and unavailable strata. Handoff sanitized task frequencies, exemplar IDs, required PMS inputs/outputs, candidate tools and live-proof gaps to “Analyze Stagehand tool costs” without modifying or interrupting it.

**Tests:** claimed-vs-verified distinction; multi-operation prediction; mismatch classification; no human reply; late reply; duplicate task replies; report aggregation and sanitized handoff.

## Verification Contract

- Offline unit tests run with production database variables unset.
- Read-only runtime evidence verifies EC2 guard, repeatable-read snapshot, Centurion scope and private artifact permissions.
- Manifest, source ledger, message hashes, daily partitions and target partitions are independently checked before report generation.
- A leakage audit proves target and post-target material is absent from every predictor input.
- A final private handoff records commands/evidence, worker/model versions, failures, unresolved records, decisions and coverage limitations.

## Definition of Done

The private corpus, daily classification tables, quarantine reconciliation, exhaustive blinded human-response comparison, PMS tool-demand report and Stagehand handoff exist; all partition/leakage/privacy/safety checks pass; no production mutation occurred; and any remaining gaps are explicitly evidenced rather than described as complete.

## Sources and prior-art constraints

- Existing guarded export: `apps/server-pilot/scripts/export-centurion-thread-corpus-live.ts`.
- Existing RDS reader: `apps/server-pilot/src/ops/centurion-thread-corpus-postgres-reader.ts`.
- Quarantine schema and parser semantics: `apps/server-pilot/src/db/schema/mail.ts` and `apps/server-pilot/src/mail/ingest/parse-message.ts`.
- Historical 3949 analysis: `docs/superpowers/plans/2026-09-10-human-gold-pms-tool-reanalysis.md`.
- Stagehand context: local chat “Analyze Stagehand tool costs” and its private trial handoff.
