---
title: "Hotel Triage Quality Improvement - Plan"
date: 2026-07-29
type: perf
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin:
  - "docs/plans/2026-07-29-001-feat-hotel-revenue-inbox-ia-plan.md"
  - "docs/superpowers/plans/handoff-reports/2026-07-29-hotel-revenue-queues.md"
deepened: 2026-07-29
---

# Hotel Triage Quality Improvement - Plan

## Goal Capsule

Raise Centurion text-visible triage quality from the manually adjudicated `triage-v4` baseline before changing production labels again.
Build a real read-only Bedrock quality evaluator, improve thread serialization and queue boundaries as `triage-v5`, prove the candidate against frozen and temporal gold sets, then deploy and retag through the existing guarded path.

**Baseline:** after resolving the four manual-review cases, 163 of 193 categories are correct (84.5%).
Thread #179 is attachment-informed; the text-only score is 163 of 192 (84.9%) when that case is reported outside the primary gate.
Urgency is 183/193 correct but only 58.3% precision/recall/F1 because there are 7 true positives, 5 false positives, and 5 false negatives.
Joint category+urgency exact match is 159/193 (82.4%); 34 threads are wrong on at least one dimension.

**Authority:** final human calls in this session > manual audit rubric > shipped revenue-queue plan > historical durable labels.

**Execution profile:** sequential, test-first, read-only evaluation before any prompt or production mutation.

**Stop when:** `triage-v5` passes the regression and temporal-holdout gates, production retag drains with drafts disabled, and a fresh human audit confirms the expected error reduction.
If the candidate misses a quality gate, do not deploy it and do not compensate with unmeasured rules or a blind model switch.

---

## Product Contract

### Summary

The next quality gain is not “write a longer prompt.”
First make quality measurable using the real prompt, real Bedrock adapter, and real thread shape.
Then fix the two largest confusion families, add the time and direction facts urgent classification currently lacks, and ship only if the same evaluator shows a material win without regressions.

### Problem Frame

The production pipeline works, but its deploy-time spike eval is not a classifier-quality eval.
`apps/server-pilot/src/ai/eval-runner.ts:63-117` uses `FakeModelAdapter` and overwrites each output with the fixture’s expected category.
It therefore proves plumbing and schema behavior while making category success self-fulfilling.
The deterministic gate is also currently red: its generic `new-bookings` override forces urgent=true on ordinary cases, while the Bedrock contract still expects Nova `outputConfig` that the runtime intentionally omits.

The current user prompt also discards facts already loaded by the worker.
`apps/server-pilot/src/ai/worker.ts:101-120` loads `direction`, but `apps/server-pilot/src/ai/workflows/mail-triage.ts:139-150` does not render it.
Neither layer supplies an explicit classification `asOf`, so the model cannot reliably distinguish actionable urgency from historical dates during retag.
The worker also loads the eventual full thread, which leaks messages received after an older trigger into historical evaluation.

The manual audit found 27 definite category errors and four unresolved cases.
Human review resolved those four as:

- #65 `groups-events`
- #97 `groups-events`
- #171 `new-bookings`
- #179 `groups-events`

That produces 30 category errors.
The largest families are 14 group/event under-detections, seven voucher/invoice lifecycle mistakes, five at-risk boundary mistakes, three spam/work mistakes, one residual internal-forward sender bias, and false urgency on historical cancellations or invoices.
Expected `groups-events` recall is only 44% while precision is 100%, so recall is the primary category defect.

The current voucher prompt was deployed after the original full retag, then rerun only for four Rennies threads.
The five non-Rennies voucher errors have not been evaluated uniformly against the current prompt.
A fresh baseline run must precede more voucher rules.

Model-authored `confidence` is not a calibrated probability.
It remains diagnostic metadata only.
No write, escalation, or release decision may depend on it in this plan.

### Actors

- A1. Centurion front-office staff, who need revenue mail in the correct queue without silent urgency noise.
- A2. Triage evaluator/operator, who runs private, read-only model comparisons against human labels.
- A3. `ai-worker`, which executes the selected prompt and applies labels behind existing write gates.
- A4. Human adjudicator, who owns ambiguous queue policy and temporal-holdout labels.

### Requirements

#### Evaluation truth

- R1. Add a `quality` eval mode that invokes the same prompt builder, serializer, model adapter, schema validation, and `refineTriageOutput` path as production.
- R2. Keep the existing fake spike mode as a deterministic plumbing gate; do not present it as an accuracy gate.
- R3. Export production-shaped thread inputs read-only from the database and join them by trigger message ID to a separate private label JSONL containing expected category, expected urgent flag, fixed `asOf`, evidence span, policy reason, template family, adjudication state, slice tags, and evidence scope.
- R4. Tag cases as `text-visible` or `attachment-informed`; score both, but use only `text-visible` cases for the primary release gate.
- R5. Treat the existing 193-thread corpus as diagnostic/development data, not pristine held-out evidence.
For locked temporal labels, require two independent model-blind human judgments and a third tie-break on disagreement.
- R6. Treat invalid JSON, schema failure, adapter failure, or missing trigger messages as explicit failures.
Every repeat must complete with 100% schema-valid outputs before promotion; unresolved failures cannot be diluted into the accuracy denominator.
- R7. Report category accuracy, macro-F1, per-queue precision/recall/F1, confusion matrix, urgent precision/recall/F1, spam precision/recall/F1, joint exact match, template-family scores, slice scores, schema-valid rate, tokens, latency, and estimated cost.
- R8. Compare baseline and candidate on identical ordered cases and emit per-case changes so every gain and regression is auditable.
- R9. Keep raw bodies, addresses, and attachment facts out of Git, logs committed to Git, and chat output.

#### Input representation

- R10. Serialize messages in chronological order with stable boundaries, message index, direction, sender, subject, canonical event timestamp, and a unique `TRIGGER` marker.
The event timestamp is `coalesce(receivedAt, sentAt, createdAt)` so outbound replies remain interleaved correctly.
- R11. Apply a causal cutoff: include only messages at or before the trigger’s deterministic `(event timestamp, message ID)` tuple.
Never expose later replies or outcomes to an earlier trigger.
- R12. Pass an explicit trusted classification `asOf`.
Live runs use the server-created AI run time; regression eval uses the fixed human-audit time; temporal eval uses each original run creation time.
Treat sender-authored email `Date` as message context, not the urgency clock.
- R13. Preserve the existing per-message body limit for the first measured candidate; do not add quote stripping or attachment extraction in the same change.
- R14. Hash the exact system prompt and serialized user input into run/eval metrics without persisting either raw prompt body in metrics.

#### Queue and urgency policy

- R15. Teach `groups-events` with contrastive text-visible signals: two or more rooms, rooming lists, teams/squads/families, delegates/officials, allocations/series, site inspections, conferences, banquets, catering, functions, and multi-person event meals.
- R16. Teach one-stay travel vouchers, booking vouchers, billback instructions, and agency travel documents as `new-bookings` unless the request is group-shaped or explicitly at risk.
- R17. Teach internal forwards to follow the underlying guest/agency commercial request; use `ops` only when the forwarded content is internal operations rather than revenue work.
- R18. Teach calendar meeting cancellations and channel/PMS integration failures as `ops` unless the text contains a real booking cancellation, revenue threat, or hard reply SLA.
- R19. Set `urgent=true` only when explicit text is actionable at `asOf` or carries an unexpired hard SLA.
Words such as “urgent,” “cancel,” “arrival,” or a future date alone are insufficient.
- R20. Narrow the deterministic invoice/commission urgency suppression to stale `ops` finance noise.
It must not suppress a real same-day tax-invoice request or explicit hard SLA.
- R21. Preserve the current spam inclusion/exclusion policy, never-spam enforcement, user spam locks, and blocked-sender preferences.
- R22. Keep `confidence` in the output contract for compatibility, label it as self-reported diagnostic metadata, and never branch production or release logic on it.
- R23. Keep the first `triage-v5` candidate prompt-first.
Do not add a broad regex routing engine; add a narrow deterministic override later only if the quality report proves a stable, high-precision residual.

#### Rollout and provenance

- R24. Assign `triage-v5` to the changed prompt and serializer.
Do not reuse `triage-v4` for changed behavior.
- R25. Execute each run with the queued `modelId`, record `promptVersion`, prompt hash, input hash, raw model category/urgent/confidence, refined category/urgent, rationale, and policy flags in metrics, and reject unsupported prompt-version drift rather than mislabeling results.
- R26. Capture three private baseline reports before changing prompt behavior.
- R27. Require regression, per-queue noninferiority, stability, and temporal-holdout gates before enabling a full Centurion retag.
- R28. Fix the retag script so a duplicate idempotency key is a true no-op: insert with `RETURNING` first, mutate labels only when insertion succeeds, and report collisions versus actual inserts.
- R29. Preserve user spam locks and blocked-sender preferences during retag.
- R30. Quiesce HTTP/force-sync, ingest, and AI workers around cutover and retag; terminalize or supersede every nonterminal old triage and candidate-draft run, including `retry_wait`.
- R31. Export pre-retag labels privately and retain the prior deploy SHA so rollback is a code rollback plus a fresh idempotency-key retag, not an in-place guess.
- R32. Harden post-retag audit to filter succeeded v5 runs by prompt version and key prefix, then reconcile trigger/input hashes against durable categories and the candidate report.

### Key Flows

- F1. **Baseline:** production-shaped private export + separate private labels → current production classifier path → three immutable `v4-current` reports keyed by dataset, prompt, and input hashes.
- F2. **Candidate:** same cases → `triage-v5` path → paired report showing fixes, regressions, quality metrics, latency, tokens, and cost.
- F3. **Temporal proof:** new production threads remain on current labels → private candidate replay → human labels → paired holdout report.
- F4. **Promotion:** passing reports → quiesce/drain → deploy `triage-v5` → quiesce again → drafts off → dry-run retag → private pre-retag snapshot → one controlled v5 generation → strict audit → resume ingest.
- F5. **Failure:** any quality or safety gate fails → candidate remains undeployed → report residual errors → open a smaller follow-up for model comparison or measured deterministic policy.

### Acceptance Examples

- AE1. A thread asking for 20 rooms, a cricket team, a rooming list, six officials, or a 20-person breakfast function resolves to `groups-events`.
- AE2. A one-guest FCM/FlyNow/Nexus/Thompsons accommodation voucher resolves to `new-bookings`; a multi-room voucher resolves to `groups-events`.
- AE3. An internal `FW:` containing a family stay RFQ resolves from the quoted commercial intent, not the internal sender domain.
- AE4. `Canceled: Front Office Update` resolves to `ops`, while an explicit booking cancellation resolves to `at-risk`.
- AE5. `RESERVATION FAILED TO INTEGRATE (MODIFICATION)` resolves to `ops` unless a hard guest/revenue deadline is present.
- AE6. A cancellation received on July 29 for an October stay is `at-risk` and `urgent=false`.
- AE7. An arrival due within 48 hours under an explicit SynXis action clock is `at-risk` and `urgent=true`.
- AE8. #179 remains expected `groups-events`, carries `attachment-informed`, appears in the all-case report, and does not lower the text-only release score.
- AE9. A wrong output with `confidence=0.99` still counts as wrong and cannot bypass a quality gate.
- AE10. A malformed model response counts as a failed eval case and causes no mailbox mutation.
- AE11. Retagging an old message on July 29 evaluates urgency at the explicit July 29 `asOf`, not at the sender-controlled email `Date`.
- AE12. Re-evaluating an older trigger cannot read a later hotel reply, cancellation outcome, or booking confirmation.

### Success Criteria

| Gate | Required result |
|---|---|
| Current audit regression set | At least 92% category accuracy on `text-visible` cases, with all changed cases listed |
| Known group/MICE slice | `groups-events` recall at least 80%, precision at least 95%, and at least 90% correct on the text-visible development slice |
| Known voucher slice | At least 90% correct under the current prompt candidate |
| Urgent | Precision, recall, and F1 each at least 80%; at most 3 known urgent errors; no loss on explicit same-day/hard-SLA cases |
| Spam safety | Precision at least 95% and zero regressions on the audited FortiMail, GuestRevu, OTP, bounce, bank-POP, and never-spam cases |
| Joint exact match | At least 90% of text-visible threads have both category and urgent correct |
| Per-queue noninferiority | No primary queue F1 drops more than 2 percentage points on regression; zero newly wrong `at-risk`, spam, or explicit urgent=true cases; at most one newly wrong text-visible case overall |
| Schema | Every baseline and candidate repeat completes with 100% schema-valid outputs and no unresolved adapter failures |
| Stability | Three baseline and three candidate repeats; modal prediction used for paired quality, every candidate repeat passes absolute gates, at least 98% candidate category unanimity, and no flip on spam or explicit urgent=true cases |
| Temporal holdout | Next 200 consecutive inbound threads after prompt freeze, extended without cherry-picking until at least 10 examples exist for each primary queue, spam, urgent=true, group-shaped, and voucher slices; candidate improves category accuracy by at least 5 percentage points and paired bootstrap 95% CI lower bound is above 0 |
| Runtime | Candidate p95 latency no more than 25% above baseline and estimated cost per thread no more than 30% above baseline; report p50/p95/p99/max message counts, input tokens, latency, and cost |
| Production | All unlocked retag runs terminal; zero dead letters; drafts remain disabled; fresh audit meets the same policy |

### Scope Boundaries

#### In scope

- Real read-only quality eval mode and private gold-data contract.
- Production-shaped read-only corpus exporter with labels stored separately.
- Canonical text thread serialization with direction and timestamps.
- `triage-v5` contrastive prompt for queue boundaries and urgency evidence.
- Prompt/input provenance metrics.
- Retag idempotency/sender-policy hardening and strict post-deploy audit.

#### Deferred

- Nova Pro/Nova 2/model-cascade benchmark.
Run only if measured `triage-v5` residuals miss the release gate.
- Calibrated selective review or abstention queue.
Self-reported confidence is not enough; this needs a separate labeled calibration set and product workflow.
- Recurring active-learning automation.
Start with versioned manual error mining; automate only after the evaluator is trusted.
- Quoted-reply stripping or deduplication.
Measure token/quality impact first because lossy stripping can remove the decisive request.
- Global thread-message or token truncation.
Report message-count and input-token distributions first; add a deterministic cap only if model limits or the runtime gate require it.
- Broad deterministic routing rules.
Any future rule must prove high precision and coverage on held-out cases.
- One-way AI primary escalation from `new-bookings|groups-events` to `at-risk`.
Prior design explicitly froze settled primaries; revisit only in a separate lifecycle-policy plan with multi-trigger evidence and user-action protections.
- Bounded multi-worker concurrency and queue-throughput tuning.
Current request targets classification quality; existing ledger already supports a later measured runtime-only optimization without retag.

#### NOT in scope

- OCR, image understanding, PDF extraction, or attachment-derived classification.
- Frontend queue or sidebar changes.
- Candidate-draft content/tone changes.
- New queues, schema migrations, autonomous send, or model-provider migration.
- Trusting or displaying model `confidence` as a probability of correctness.
- External package/CLI distribution; evaluator and exporter remain repository-internal tools deployed with `server-pilot`.

### Sources

- Current runtime prompt and serializer: `apps/server-pilot/src/ai/workflows/mail-triage.ts:56-199`
- Current thread loading: `apps/server-pilot/src/ai/worker.ts:94-199`
- Current fake spike eval: `apps/server-pilot/src/ai/eval-runner.ts:63-249`
- Nova adapter and stale contract: `apps/server-pilot/src/ai/bedrock/bedrock.ts:113-177`, `apps/server-pilot/tests/bedrock-adapter-contract.test.ts:97-124`
- Existing AI gate: `apps/server-pilot/deploy/ai-gate.sh:29-50`
- Current prompt version: `apps/server-pilot/src/ai/run-ledger.ts:11-13`
- Existing retag path: `apps/server-pilot/scripts/retag-centurion-triage.mjs`
- Shipped v4/v4b operations: `docs/superpowers/plans/handoff-reports/2026-07-29-hotel-revenue-queues.md`
- AWS Nova prompting: https://docs.aws.amazon.com/nova/latest/userguide/prompting.html
- AWS Nova long context: https://docs.aws.amazon.com/nova/latest/userguide/prompting-long-context.html
- AWS Bedrock prompt datasets: https://docs.aws.amazon.com/bedrock/latest/userguide/model-evaluation-prompt-datasets.html
- AWS Bedrock model evaluation: https://docs.aws.amazon.com/bedrock/latest/userguide/evaluation.html
- Selective prediction and self-evaluation: https://aclanthology.org/2023.findings-emnlp.345.pdf

---

## Planning Contract

### Assumptions

- Current Centurion raw text and human verdict artifacts remain available privately on the operator machine or private S3.
- The first quality runner executes sequentially to avoid Bedrock throttling and simplify paired latency measurements.
- `amazon.nova-lite-v1:0` remains the production baseline and first candidate model.
“Lite” here names the application model, not a fast agent/subagent variant.
- The existing body limit is not the main cause of the known text-visible errors.
- Attachment-informed cases remain useful operational examples but cannot fairly gate a text-only classifier.
- No production write is required to evaluate either baseline or candidate.

### Key Technical Decisions

- KTD1. **Evaluator before prompt:** build and run the real baseline before editing behavior.
The current fake spike remains a plumbing gate.
- KTD2. **Reuse the production classifier path:** export one adapter-injectable classification function from `mail-triage.ts`; both Mastra and quality eval call it.
No second prompt implementation.
- KTD3. **Production-shaped private corpus:** commit schema validation, exporter code, and synthetic tests, not real hotel bodies or addresses.
Export exact production inputs read-only, store labels separately, and hash both in each report.
- KTD4. **Canonical causal text context:** add direction and event time, then slice the ordered thread through the trigger.
Do not add a parser or dependency in this pass.
- KTD5. **Prompt-first candidate:** strengthen explicit boundaries and contrastive examples before adding deterministic category rules.
This preserves the prior decision against a force-ham rule engine.
- KTD6. **Evidence-based urgency:** an explicit server/eval `asOf` is the reference clock; sender `Date` remains untrusted context and prompt rationale names the decisive deadline/date signal.
- KTD7. **Confidence stays inert:** preserve contract compatibility but use human outcomes, not self-report, for release decisions.
- KTD8. **Version and hash both:** `triage-v5` names intended behavior; prompt/input hashes catch accidental edits or metadata drift.
- KTD9. **No blind model escalation:** if v5 misses gates, stop and use the evaluator to justify a separate model/rule follow-up.
- KTD10. **Full retag only after proof:** once gates pass, keep one coherent production label generation rather than hand-patching selected rows.
- KTD11. **Frozen baseline worktree:** tag the U1 baseline commit and run it from a separate worktree for every later paired dataset.
This preserves the exact v4-current prompt and serializer without retaining duplicate production prompt code.
- KTD12. **Symmetric repeats:** run both v4-current and v5 three times, use modal outputs for paired quality, require every candidate repeat to pass, and gate category unanimity.
- KTD13. **True retag idempotency:** duplicate keys cannot clear labels.
Insert first with `RETURNING`, mutate only after a successful insert, and report collisions.
- KTD14. **Quiesced cutover:** HTTP/force-sync, ingest, and AI workers do not run concurrently with retag snapshot/enqueue/apply.
- KTD15. **Strict audit:** production proof comes from succeeded v5 runs reconciled by trigger/input hash to durable categories, not the latest run regardless of state.
- KTD16. **Development versus locked evidence:** use the current 193 threads for diagnosis/regression; promotion evidence comes from the next 200 consecutive, independently adjudicated inbound threads.
- KTD17. **Measured refiner repair:** prompt-first forbids a new routing engine, but does not preserve a verified deterministic bug.
Narrow stale-finance urgency suppression so it cannot erase valid same-day tax-invoice or hard-SLA urgency.

### What Already Exists

| Existing capability | Reuse decision |
|---|---|
| `buildSystemPrompt` / `buildUserPrompt` | Reuse directly; no duplicate evaluator prompt |
| Full thread query in `worker.ts` | Reuse its DB shape, add causal trigger cutoff and explicit `asOf` |
| `refineTriageOutput` and never-spam enforcement | Reuse; narrowly repair verified stale-finance urgency overreach |
| Fake spike eval and scorers | Keep for deterministic deploy plumbing; add separate quality semantics |
| Bedrock adapter with temperature 0 and retry | Reuse; quality CLI requires Bedrock explicitly and reports adapter kind |
| `ai_workflow_run` metrics JSON | Reuse for hashes/rationale/policy flags; no migration |
| Write gate and drafts gate | Reuse for rollout safety |
| Retag script with dry-run, locks, key prefix, domain subset | Harden insert-before-mutate idempotency and blocked-sender preservation |
| Full audit dump | Harden state/version/key filtering and durable/report reconciliation |

### High-Level Technical Design

```text
READ-ONLY DB EXPORT              PRIVATE LABEL JSONL
production mapper + causal cut   expected labels + fixed asOf + slices
                  \             /
                   +-----------+
                         |
                         v
        quality eval runner (read-only)
                  |
          +-------+-------+
          |               |
          v               v
 baseline worktree    candidate worktree
 current v4-current   triage-v5
 same Bedrock adapter / classify function / refine path
          |               |
          +-------+-------+
                  |
                  v
 paired report
 accuracy + macro-F1 + queue/urgent/spam slices
 schema + latency + tokens + cost + changed-case list
                  |
          +-------+-------+
          |               |
        FAIL             PASS
          |               |
    no production       temporal holdout
    mutation              |
                          v
                   deploy + retag-v5
                          |
                          v
                    fresh audit
```

Runtime after promotion:

```text
ai_workflow_run
  modelId + promptVersion
          |
          v
worker loads thread messages
  canonical event order + causal cutoff through trigger
  id + direction + message date + sender + subject + body
  explicit run.createdAt asOf
          |
          v
classifyMailTriage()
  system prompt v5
  canonical user prompt
  Bedrock structured JSON
  validate + refine
          |
          v
metrics
  raw model category/urgent/confidence
  refined category/urgent
  rationale + policyFlags
  promptHash + inputHash + tokens + latency + cost
          |
          v
existing durable apply + draft gate
```

### Sequencing

Sequential implementation, no parallelization opportunity.
The evaluator, serializer, prompt, and versioning all touch the same AI module and must share one classification path.

1. Freeze private labels, implement production-shaped export, and implement quality mode.
2. Commit/tag the evaluator-only U1 state, run three baseline repeats, and retain that SHA for a baseline worktree.
3. Add canonical serialization and candidate prompt.
4. Run both baseline and candidate worktrees three times on regression and temporal-holdout corpora.
5. Stop HTTP/ingest, terminalize old running work, supersede old queued/retry/draft work, then stop AI before deploying code that rejects v4 runs.
6. Deploy, re-quiesce, run one controlled v5 retag generation, audit, then resume services.

### Alternatives Considered

| Alternative | Decision |
|---|---|
| Edit prompt immediately and spot-check production | Rejected: repeats the unmeasured v4/v4b loop |
| Treat fake spike pass rate as model accuracy | Rejected: expected-label overrides make it self-fulfilling |
| Add OCR now | Rejected by user; classifier remains text-only |
| Route low `confidence` to humans | Deferred: value is uncalibrated and no review product exists |
| Switch directly to a stronger model | Deferred: task-specific gain, cost, IAM, and latency are unmeasured |
| Add broad MICE/voucher regex routing | Rejected for first candidate: prompt has not been uniformly reevaluated |
| Store real audit corpus in Git | Rejected: hotel mail contains PII and commercial data |
| Build a second standalone classifier for eval | Rejected: prompt/runtime drift would invalidate results |
| Use sender email `Date` as urgency authority | Rejected: sender-controlled and wrong for historical retag; use explicit `asOf` |
| Leave workers live during retag | Rejected: concurrent runs make first completion permanently settle the category |

### Failure Modes

| Failure | Test or control | Error handling | User impact |
|---|---|---|---|
| Quality runner accidentally mutates mailbox | Adapter-injected unit test; quality mode never imports durable apply | Fail closed before run | No production mutation |
| Eval path drifts from worker path | Both call exported `classifyMailTriage` | Shared function, one schema | Prevents false-green comparison |
| Gold set leaks PII into Git | Export/label path and content-hash contract; Git status inspection before commit | Abort if a private artifact is tracked | Prevents data exposure |
| Manually cleaned corpus diverges from production | Shared mapper and read-only exporter | Join labels by immutable trigger ID | Prevents optimistic eval |
| Later replies leak into old trigger | Causal cutoff fixture | Slice through deterministic trigger tuple | Prevents answer leakage |
| Trusted urgency clock missing | Dataset/schema and worker tests | Case fails, not silently scored | Avoids false urgent decisions |
| Outbound reply sorts after later inbound mail | Interleaved inbound/outbound fixture | Order by canonical event timestamp | Prevents false thread interpretation |
| Wrong prompt version runs current prompt | Version assertion + hash in metrics | Dead-letter/abort candidate run | Prevents mislabeled audit history |
| Quality CLI silently selects fake adapter | Explicit Bedrock construction and adapter-kind assertion | Abort before first case | Prevents fake quality evidence |
| Bedrock throttles or returns invalid JSON | Sequential runner; invalid/schema errors counted | Mark report incomplete and block promotion | Candidate cannot pass silently |
| One favorable stochastic run hides instability | Three baseline and three candidate repeats | Modal + every-run + unanimity gates | Prevents favorable-run selection |
| Attachment-only evidence is unavailable | `evidenceScope` required | Separate score, no OCR guess | Honest text-only quality |
| Candidate fixes slices but regresses ordinary mail | Per-queue noninferiority and zero-critical-regression gates | Gate blocks promotion | Avoids silent broad regression |
| Duplicate retag key clears successful labels | Insert-first integration test | Duplicate is a reported no-op | Prevents destructive reruns |
| Blocked sender loses spam state | Sender-preference integration case | Skip/reapply blocked policy | Preserves human policy |
| Live worker settles category during retag | Quiesced service sequence | One controlled v5 generation | Prevents first-writer race |
| Retag produces bad labels | Private pre-retag snapshot + prior SHA + fresh key prefix | Roll back code and rerun prior version | Staff may see temporary misroutes, not data loss |
| Old queued v4 runs survive v5 deploy | Drain preflight and prompt-version assertion | Do not execute under wrong prompt | Avoids mixed-generation labels |
| Audit reports an old/failed run as current | Strict state/version/key/hash join | Audit fails reconciliation | Prevents false rollout proof |

---

## Implementation Units

### U1. Real read-only quality evaluator and private gold contract

**Goal:** measure the actual classifier instead of fake expected-label overrides.

**Requirements:** R1-R9, R26

**Dependencies:** none

**Files:**

- Modify: `apps/server-pilot/src/ai/eval-runner.ts`
- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Create: `apps/server-pilot/scripts/export-centurion-triage-quality.ts`
- Modify: `apps/server-pilot/tests/ai-eval-runner.test.ts`
- Modify: `apps/server-pilot/tests/ai-triage-contract.test.ts`
- Modify: `apps/server-pilot/tests/bedrock-adapter-contract.test.ts`
- Modify: `apps/server-pilot/tests/centurion-live-corpus-contract.test.ts`
- Modify/add: `apps/server-pilot/tests/fixtures/centurion-live/*`
- Private runtime artifacts: gitignored production-input JSONL, separate label JSONL, and generated reports

**Approach:**

- Preserve `--mode=spike`.
- Restore the existing deterministic gate honestly: ordinary `new-bookings` fake cases default `urgent=false`, only explicitly urgent fixtures override true, and `pnpm eval:ci` returns green without claiming model accuracy.
- Align Bedrock contract with runtime: Nova must omit unsupported `outputConfig`; retain/add a non-Nova schema-output assertion for the supported path.
- Add an `at-risk` live-corpus fixture so the “all primaries” contract covers all primaries.
- Add `--mode=quality --inputs <path> --labels <path> --out <path>`.
- Add a read-only exporter that uses the same production row mapper and causal cutoff as the worker.
The exporter reads trigger IDs from the private label file, but never reads expected labels while constructing model input.
- Validate and hash input and label JSONL independently, then join exactly by trigger message ID.
- Export an adapter-injectable `classifyMailTriage(input, adapter)` used by the Mastra step and evaluator.
- In tests, inject a deterministic adapter whose outputs are not derived from expected labels.
- In live quality mode, require `NODE_ENV=production`, `AI_ENABLED=true`, and explicit Bedrock configuration; construct the Bedrock adapter directly, report `adapterKind=bedrock`, and abort rather than falling back to fake.
- Never import or call durable apply from quality mode or exporter.
- Score all required metrics and write one JSON report containing dataset hash, prompt hash, input hashes, model, prompt version, case outcomes, confusion matrix, slice metrics, tokens, latency, and cost.
- Build private development labels for the 193 adjudicated threads.
Use current assigned labels for the 162 original correct cases, the 27 audit corrections, and the four final human calls; set regression `asOf` to the audit timestamp; record evidence span, policy reason, template family, and `clear|ambiguous|attachment-required|insufficient-content`.
Tag #179 `attachment-informed`.
- Keep correlated duplicate/template families together in every development split and report family-level scores.
- Commit/tag the U1 evaluator-only state before any serializer or prompt behavior changes.
Record this SHA in the baseline report and use its worktree for future v4-current runs.
- Run and retain three complete baseline repeats.

**Test Scenarios:**

- Spike mode behavior and existing pass/fail semantics remain unchanged.
- `pnpm eval:ci` passes ordinary and explicitly urgent booking fixtures without expected-label leakage.
- Nova adapter test asserts no `outputConfig`; supported non-Nova adapter test still asserts schema output.
- Live corpus contract includes `at-risk`.
- Quality mode does not call `CATEGORY_OVERRIDES`.
- Wrong high-confidence output scores wrong.
- Invalid JSON, schema-invalid output, and thrown adapter call mark the report incomplete and promotion-ineligible.
- CLI parsing rejects missing input/label/output, unsupported mode, unknown arguments, fake adapter resolution, and non-production live config.
- Input/label loading rejects malformed JSONL, duplicate IDs, unmatched IDs, missing triggers, invalid labels, invalid `asOf`, future-message leakage, and an empty corpus.
- Scoring covers zero-support classes, zero denominators, matrix totals, macro-F1, urgent/spam binary metrics, paired case-ID mismatch, and deterministic bootstrap seeding.
- Attachment-informed case appears in all-case metrics and not text-only primary metrics.
- Dataset hash and paired per-case output are stable for identical input.
- Quality mode uses no DB connection; exporter issues only read queries and writes only the requested private file.

**Verification:**

```bash
pnpm --dir apps/server-pilot exec vitest run tests/ai-eval-runner.test.ts tests/ai-triage-contract.test.ts tests/bedrock-adapter-contract.test.ts tests/centurion-live-corpus-contract.test.ts
pnpm eval:ci
```

Export and run all three baseline repeats before U2:

```bash
pnpm --dir apps/server-pilot exec tsx scripts/export-centurion-triage-quality.ts --labels <private-labels.jsonl> --out <private-inputs.jsonl>
NODE_ENV=production AI_ENABLED=true pnpm --dir apps/server-pilot exec tsx src/ai/eval-runner.ts --mode=quality --inputs <private-inputs.jsonl> --labels <private-labels.jsonl> --out <private-v4-current-repeat-1.json>
# Repeat as repeat-2 and repeat-3.
```

### U2. Canonical thread serialization with time and direction

**Goal:** give the model enough text-visible structure to classify forwards and urgency consistently.

**Requirements:** R10-R14

**Dependencies:** U1 baseline captured

**Files:**

- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Modify: `apps/server-pilot/src/ai/worker.ts`
- Modify: `apps/server-pilot/tests/ai-triage-contract.test.ts`
- Modify: `apps/server-pilot/tests/ai-worker-contract.test.ts`

**Approach:**

- Select and order each triage message by canonical ISO `occurredAt = coalesce(receivedAt, sentAt, createdAt)` plus message ID.
- Find the trigger in that deterministic order and discard every later message before serialization.
- Carry sender email `Date`/message event time as context, not authority.
- Add explicit `asOf` and `asOfSource`; live worker uses `run.createdAt`, regression labels use fixed audit time, and temporal labels use original run creation time.
- Pass the queued `modelId` and `promptVersion` into the classifier input.
- Render `asOf`, message index, direction, canonical event timestamp, sender, subject, body fence, and `TRIGGER`.
- Append a short final instruction after thread data to classify the trigger using prior messages as context.
- Keep the 2,000-character per-message body cap for the measured candidate.
- Compute SHA-256 prompt and serialized-input hashes.
- Do not add quote stripping, HTML parsing, or dependencies.

**Test Scenarios:**

- Oldest-to-newest order is stable.
- Trigger is marked exactly once.
- Later replies and outcomes are absent when an older trigger is classified.
- Direction and ISO timestamps render for every message.
- Interleaved inbound/outbound mail remains in true event order when outbound `receivedAt` is null.
- `asOf` is named as urgency reference and comes from run/label metadata, never wall-clock “now” or sender `Date`.
- Missing/invalid `asOf` fails before model invocation.
- Email fence sanitization and body truncation remain intact.
- Worker passes the run’s model/version/creation time and stored message timestamps.

**Verification:**

```bash
pnpm --dir apps/server-pilot exec vitest run tests/ai-triage-contract.test.ts tests/ai-worker-contract.test.ts
```

### U3. Contrastive `triage-v5` prompt

**Goal:** fix measured queue boundaries and urgent overfire without a new rule engine.

**Requirements:** R15-R23

**Dependencies:** U2

**Files:**

- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Modify: `apps/server-pilot/tests/ai-triage-contract.test.ts`

**Approach:**

- Keep concise category definitions.
- Add a decision sequence: identify underlying commercial intent, detect group shape, detect real revenue risk, then decide urgency from explicit time evidence.
- Add contrastive examples covering:
  - one-room voucher versus multi-room voucher;
  - team/rooming-list/delegates/site-inspection/banquet versus one normal stay;
  - internal forward of guest RFQ versus internal handover;
  - booking cancellation versus calendar cancellation;
  - channel integration failure versus time-boxed OTA action;
  - same-day/hard-SLA urgency versus future cancellation/invoice noise.
- Require rationale to name the decisive text-visible signal.
- Describe `confidence` as a self-report for diagnostics only.
- Preserve spam criteria and never-spam policy.
- Narrow `refine:subject-urgent-not-sla` to `ops` plus stale commission/invoice evidence.
Preserve urgent for same-day tax-invoice requests and explicit hard SLAs.

**Test Scenarios:**

- Prompt contains every queue boundary and paired contrast.
- Prompt states that sender domain does not override embedded commercial intent.
- Prompt prohibits urgency without same-day/unexpired hard-SLA evidence relative to explicit `asOf`.
- Prompt distinguishes calendar cancellation and PMS integration failures from booking risk.
- Prompt keeps voucher and spam exclusions.
- Contract contains no new primary slug and no attachment/OCR instruction.
- Refiner suppresses stale ops commission noise but preserves urgent tax-invoice-today and hard-SLA cases.

**Verification:**

```bash
pnpm --dir apps/server-pilot exec vitest run tests/ai-triage-contract.test.ts
```

### U4. Provenance, release gate, and retag version

**Goal:** make candidate reports and production runs attributable and rollback-safe.

**Requirements:** R24-R32

**Dependencies:** U1-U3

**Files:**

- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Modify: `apps/server-pilot/src/ai/worker.ts`
- Modify: `apps/server-pilot/src/ai/run-ledger.ts`
- Modify: `apps/server-pilot/scripts/retag-centurion-triage.mjs`
- Modify: `apps/server-pilot/scripts/dump-centurion-full-triage-audit.mjs`
- Modify: `apps/server-pilot/tests/ai-worker-contract.test.ts`
- Create: `apps/server-pilot/tests/retag-centurion-triage.test.ts`
- Create: `apps/server-pilot/tests/centurion-triage-audit.test.ts`

**Approach:**

- Set `DEFAULT_TRIAGE_PROMPT_VERSION = 'triage-v5'`.
- Use `inputData.modelId`, not mutable process env, for the actual call.
- Record prompt version, prompt hash, input hash, raw model category/urgent/confidence, refined category/urgent, rationale, policy flags, usage, and model ID in workflow metrics.
- Refuse to process a queued triage version unsupported by the deployed classifier.
- Bump retag defaults and documentation to `inbound-triage-retag-v5` / `triage-v5`.
- In retag transaction, attempt run insertion first with `ON CONFLICT DO NOTHING RETURNING id`; only a returned row may clear AI-managed labels/spam and increment `unsettled/enqueued`.
- Make dry-run query idempotency collisions and report `eligible`, `collisions`, and `wouldInsert`.
- Preserve dry-run default, spam user locks, blocked-sender preferences, drafts-off requirement, and existing subset option.
- Harden audit selection to `state='succeeded'`, `prompt_version='triage-v5'`, and v5 key prefix.
Join pre-retag snapshot, candidate report, run trigger/input hash, and durable category; fail on any mismatch.
- Capture private pre-retag labels and deployed SHA before `--apply`.

**Test Scenarios:**

- Queued model ID is the invoked model ID.
- Metrics distinguish raw model output from refined output and contain version/hashes/rationale/policy flags but not raw message bodies.
- Unsupported queued prompt version fails rather than running under v5.
- Running identical v5 retag twice leaves labels unchanged on pass two, reports collisions, and inserts zero new runs.
- A new key inserts one run before clearing labels; transaction rollback preserves prior labels on insertion/mutation failure.
- Locked spam threads remain untouched.
- Threads whose latest inbound sender has a `block` preference remain spam and receive no retag mutation.
- Audit ignores failed/old runs and fails when durable category, trigger ID, prompt/input hash, or candidate report disagrees.
- Existing draft gating remains unchanged.

**Verification:**

```bash
pnpm --dir apps/server-pilot exec vitest run tests/ai-worker-contract.test.ts tests/ai-eval-runner.test.ts tests/ai-triage-contract.test.ts tests/retag-centurion-triage.test.ts tests/centurion-triage-audit.test.ts
pnpm --dir apps/server-pilot build
```

### U5. Paired evaluation, temporal holdout, deploy, retag, and audit

**Goal:** promote only measured improvement and leave production in one coherent generation.

**Requirements:** R26-R32

**Dependencies:** U1-U4

**Files:**

- Private reports, exported inputs, labels, and pre-retag snapshot
- Update after completion: `docs/superpowers/plans/handoff-reports/2026-07-29-hotel-triage-v5.md`

**Approach:**

1. Run the frozen U1 baseline worktree three times and v5 candidate worktree three times against identical private regression inputs/labels.
2. Compute modal paired quality, worst-repeat metrics, candidate unanimity, and per-queue noninferiority; inspect every changed decision.
3. Run a serializer census across every intended retag target and report p50/p95/p99/max message count, serialized characters, and input tokens; report p50/p95/p99/max live latency and cost.
4. If any regression, schema, noninferiority, stability, tail, or runtime gate fails, stop.
5. Freeze v5 before the first holdout message, then take the next 200 consecutive inbound threads; continue consecutively until every required temporal queue/slice has at least 10 examples.
6. Obtain two independent model-blind labels with evidence spans/policy reasons and a third tie-break for disagreements, export production-shaped inputs, then run both worktrees three times.
7. If the temporal gate fails or remains statistically inconclusive, keep production on v4-current and collect more cases.
8. If all gates pass, stop PM2 `http` and ingest `worker` to block force-sync and new enqueue.
9. Let claimed/running v4 triage finish; supersede queued/retry-wait v4 triage and every nonterminal candidate draft; verify no nonterminal old work, then stop `ai-worker`.
10. Deploy through `ops-deploy.sh`.
Because deploy restarts services, immediately stop `http`, ingest `worker`, and `ai-worker` again; supersede any brief-window nonterminal normal v5 run.
11. Confirm `AI_WRITE_GATE_ENABLED=true` and `AI_DRAFTS_ENABLED=false`.
12. With all three services stopped, run v5 retag dry-run and capture private pre-retag labels/SHA.
13. Apply v5 retag while `ai-worker` remains stopped; verify actual insert count and zero collision mutation.
14. Start only `ai-worker`, drain the single retag generation, then stop it.
15. Run strict audit reconciliation and manually review every changed case plus a deterministic 20% unchanged sample, minimum 30.
16. If rollback thresholds pass, restart `http`, ingest `worker`, and `ai-worker`; otherwise keep ingest paused and execute rollback from the saved SHA/snapshot.
17. Record scores, repeat agreement, distributions, costs, hashes, baseline/candidate SHAs, counts, service-stop evidence, rollback data, and residual errors in the handoff.

**Test Scenarios:**

- Regression report meets every Success Criteria row.
- All six reports contain identical case IDs; all candidate repeats pass; modal and worst-run reports meet gates.
- Temporal labels are consecutive, thread-grouped, independently adjudicated, template-family tagged, and contain no v4/v5 output leakage.
- Temporal labels meet every minimum queue/slice support threshold; insufficient support is inconclusive, not a pass.
- Every input case ends at its trigger and has an explicit trusted `asOf`.
- Dry-run reports eligible/collisions/would-insert; apply inserts exactly would-insert.
- No queued/claimed/running/retry-wait old triage or candidate draft remains before deploy.
- HTTP, ingest, and AI services are stopped during retag snapshot and enqueue.
- Retag produces zero dead letters and no candidate drafts.
- Blocked-sender and user-locked threads retain policy.
- Strict audit matches succeeded v5 trigger/input hashes and durable categories to the candidate report.
- Rollback drill can name prior SHA, prior prompt hash, and fresh rollback key prefix.

**Verification:**

```bash
pnpm --dir apps/server-pilot exec vitest run tests/ai-eval-runner.test.ts tests/ai-triage-contract.test.ts tests/ai-worker-contract.test.ts tests/retag-centurion-triage.test.ts tests/centurion-triage-audit.test.ts
pnpm --dir apps/server-pilot build
bash apps/server-pilot/deploy/ops-deploy.sh
```

Production eval and retag run on EC2 through the existing SSM wrapper with production env exported.
No Vitest command may target pilot RDS without the repository’s explicit production-RDS opt-in gate.

---

## Verification Contract

| Layer | Command or artifact | Done signal |
|---|---|---|
| Unit/contract | `pnpm --dir apps/server-pilot exec vitest run tests/ai-eval-runner.test.ts tests/ai-triage-contract.test.ts tests/ai-worker-contract.test.ts tests/bedrock-adapter-contract.test.ts tests/centurion-live-corpus-contract.test.ts tests/retag-centurion-triage.test.ts tests/centurion-triage-audit.test.ts` | All branches and error cases green |
| Existing AI suite | `pnpm --dir apps/server-pilot exec vitest run tests/ai-*.test.ts` | No pipeline regression |
| Build | `pnpm --dir apps/server-pilot build` | TypeScript build green |
| Deterministic deploy gate | `pnpm eval:ci` | Existing fake plumbing spike is honestly green without claiming quality |
| Full AI gate | `bash apps/server-pilot/deploy/ai-gate.sh` | Nova adapter contract, eval, and AI suite green |
| Baseline quality | three private v4-current reports from frozen worktree | Input/label/prompt hashes captured; complete schema-valid runs |
| Candidate quality | three private paired v5 reports | Modal, worst-run, noninferiority, and stability gates pass |
| Temporal quality | six private paired holdout reports | Holdout and support metrics pass |
| Live adapter | `apps/server-pilot/deploy/bedrock-live-gate.sh` | IAM/model invocation green |
| Retag | quiesce evidence + v5 dry-run/apply/drain report | Actual inserts match dry-run; collisions no-op; zero dead letters/drafts |
| Human audit | strict reconciliation + private changed-case/deterministic-sample review | Succeeded-v5 hashes match durable labels; attachment cases separated |

### Test Coverage Map

```text
CODE PATHS                                      OPERATOR FLOWS
[+] read-only export + label join               [+] freeze baseline
  +-- production mapper + causal cutoff           +-- 3 immutable hashed reports
  +-- valid joined case -> classify -> score       +-- no mailbox write
  +-- unmatched/invalid -> hard block
  +-- attachment-informed -> secondary score
  +-- fake/schema/adapter failure -> hard block  [+] compare candidate
                                                   +-- modal + worst-run metrics
                                                   +-- changed/regressed cases visible
[+] classifyMailTriage()                           +-- regressions block promote
  +-- fake adapter in unit tests
  +-- explicit Bedrock in quality/live          [+] quiesced retag promotion
  +-- validate -> refine -> metrics                +-- stop HTTP/ingest
                                                   +-- terminalize/supersede old work
                                                   +-- stop AI, snapshot, enqueue
                                                   +-- AI-only drain, strict audit
                                                   +-- resume services
[+] canonical serialization
  +-- ordered messages
  +-- causal cutoff through trigger
  +-- direction/event time/explicit asOf
  +-- inbound/outbound event-time fallback
  +-- body truncate/fence sanitize

[+] worker
  +-- supported version -> invoke queued model
  +-- unsupported version -> fail closed
  +-- durable write gate unchanged
  +-- draft gate unchanged

[+] retag
  +-- insert returned -> mutate + count
  +-- key collision -> no-op
  +-- user lock/blocked sender -> preserve

[+] audit
  +-- succeeded v5 key/version only
  +-- trigger/input hash -> report -> durable category
  +-- any mismatch -> fail

LLM eval: [EVAL] queue/category/spam/urgent slices, latency, tokens, cost
Integration: [E2E] quality runner uses explicit Bedrock but no durable apply
Stability: [EVAL] three baseline + three candidate repeats; modal/worst/unanimity gates
```

### Failure-Path Coverage

Every failure mode in the Planning Contract requires either a unit test, an eval assertion, or an operational preflight.
No silent failure may be excluded from the denominator.
The user-facing effect of a classifier failure is a silent misroute, so changed-case inspection and rollback evidence are release-blocking controls.

---

## Definition of Done

- [ ] Production-shaped private export and separate development labels cover all 193 adjudicated triggers, final labels, fixed `asOf`, evidence spans, policy reasons, template families, adjudication state, slices, and evidence scope; raw content remains outside Git.
- [ ] U1 evaluator-only commit SHA is frozen and its exact v4-current worktree produces three complete immutable baseline reports before behavioral edits.
- [ ] Quality mode calls the shared production classification path and never durable apply.
- [ ] Tests prove expected-label overrides cannot enter quality mode.
- [ ] Existing fake eval and Nova adapter contracts are honestly green; live corpus includes `at-risk`.
- [ ] Live quality mode refuses fake adapter selection and records `adapterKind=bedrock`.
- [ ] Thread serialization uses canonical event-time ordering, excludes every message after the trigger, includes direction/timestamp, uses explicit `asOf`, and marks one trigger.
- [ ] `triage-v5` contains the measured contrastive queue and urgency policy.
- [ ] Deterministic stale-finance refinement preserves same-day tax-invoice and hard-SLA urgency.
- [ ] No new OCR, attachment parser, broad rule engine, or confidence gate appears in the diff.
- [ ] Prompt version, model ID, prompt hash, input hash, raw model output, refined output, rationale, and policy flags are attributable in reports and run metrics.
- [ ] Regression, per-queue noninferiority, schema, stability, tail/runtime, and temporal holdout gates pass.
- [ ] Locked holdout contains the next 200 consecutive inbound threads, two independent model-blind labels, tie-breaks, and required slice support.
- [ ] Existing AI contracts, full AI suite, build, fake spike, and live Bedrock gate pass.
- [ ] Production deploy uses existing wrappers; HTTP/ingest stop, all old nonterminal work is finished or superseded, and AI stops before cutover.
- [ ] Retag duplicate keys are true no-ops; dry-run counts actual prospective inserts.
- [ ] Retag runs with HTTP/ingest/AI stopped, preserves spam user locks and blocked-sender policy, and creates no drafts.
- [ ] All v5 runs terminate with zero dead letters.
- [ ] Strict succeeded-v5 trigger/input-hash reconciliation matches durable labels and candidate report.
- [ ] Fresh manual audit covers every changed case plus deterministic 20% unchanged sample, minimum 30, and confirms queue/spam/urgent policy.
- [ ] Handoff records reports, hashes, costs, SHAs, counts, rollback path, and residual errors.
- [ ] Experimental/dead-end code and private temporary data are absent from Git.

---

## Implementation Tasks

Synthesized from engineering review findings.

- [ ] **T1 (P1, human: ~2 days / CC: ~60 min)** — evaluator — Restore honest existing gates and build production-shaped, causal, Bedrock-only quality evaluation.
  - Surfaced by: architecture review — fake deploy eval, hand-shaped corpus drift, future-message leakage, and fake-adapter fallback.
  - Files: `apps/server-pilot/src/ai/eval-runner.ts`, `apps/server-pilot/src/ai/workflows/mail-triage.ts`, `apps/server-pilot/scripts/export-centurion-triage-quality.ts`, evaluator/triage/Bedrock/live-corpus tests.
  - Verify: fake gate and Nova contract pass honestly; quality mode cannot mutate DB, select fake adapter, or include post-trigger messages; reports are complete and hashed.
- [ ] **T2 (P1, human: ~1 day / CC: ~40 min)** — retag — Make duplicate retag keys non-destructive and preserve sender policy.
  - Surfaced by: architecture review — clear-before-conflict reruns remove labels and blocked senders lose spam state.
  - Files: `apps/server-pilot/scripts/retag-centurion-triage.mjs`, `apps/server-pilot/tests/retag-centurion-triage.test.ts`.
  - Verify: second identical apply inserts zero, mutates zero, reports collision, and preserves locks/blocked senders.
- [ ] **T3 (P1, human: ~1 day / CC: ~30 min)** — cutover — Execute quiesced v4→v5 deployment and one controlled retag generation.
  - Surfaced by: architecture review — `retry_wait`, force-sync, normal enqueue, and first-writer settlement can race retag.
  - Files: operational commands/handoff only unless existing wrappers need a safe stop/start option.
  - Verify: no nonterminal old runs/drafts; HTTP/ingest/AI stopped during snapshot/enqueue; AI-only drain precedes service resume.
- [ ] **T4 (P1, human: ~1 day / CC: ~40 min)** — audit — Reconcile succeeded v5 runs to candidate inputs and durable labels.
  - Surfaced by: architecture review — latest-run audit can select failed/old runs and mask durable disagreement.
  - Files: `apps/server-pilot/scripts/dump-centurion-full-triage-audit.mjs`, `apps/server-pilot/tests/centurion-triage-audit.test.ts`.
  - Verify: wrong state/version/key/trigger/hash/category causes audit failure.
- [ ] **T5 (P2, human: ~1 day / CC: ~30 min)** — classifier — Add explicit `asOf`, canonical causal serialization, and contrastive v5 policy.
  - Surfaced by: code/test review — sender `Date` is not a trusted urgency clock; direction/time/group boundaries are under-specified.
  - Files: `apps/server-pilot/src/ai/workflows/mail-triage.ts`, `apps/server-pilot/src/ai/worker.ts`, `apps/server-pilot/src/ai/triage.ts`, triage/worker tests.
  - Verify: queue contrasts, stale-finance refiner boundaries, urgent tax invoice, event ordering, as-of boundaries, hashes, model/version provenance.
- [ ] **T6 (P2, human: ~1 day / CC: ~35 min)** — release gates — Require symmetric repeats, noninferiority, schema completeness, and tail metrics.
  - Surfaced by: test/performance review — one baseline run, favorable-run selection, vacuous schema wording, and p95-only limits.
  - Files: `apps/server-pilot/src/ai/eval-runner.ts`, `apps/server-pilot/tests/ai-eval-runner.test.ts`.
  - Verify: modal/worst/unanimity math, every-repeat absolute gates, per-queue and joint regression guards, urgent/spam precision-recall-F1, deterministic bootstrap, p99/max census.

## TODO Decisions

- Calibrated abstention/human-review queue: skip separate `TODOS.md` entry for now; already deferred here and blocked by trusted v5 labels.
- Nova Pro/Nova 2 benchmark: skip until v5 misses a measured gate.
- OCR/attachment extraction: skip per explicit user direction.
- Recurring active-learning automation: skip until evaluator and one temporal cycle prove stable.
- One-way settled-primary escalation to `at-risk`: defer to a separate lifecycle-policy decision because prior design explicitly rejected category flips.
- Bounded worker concurrency: defer; classify-quality evidence first, then optimize existing ledger throughput without retag.

## GSTACK REVIEW REPORT

### Scope Challenge

- Scope accepted with safety corrections.
- More than eight files are touched, but work is one coupled quality/rollout loop with no new infrastructure or class hierarchy.
- Existing prompt, worker, adapter, ledger, gates, retag script, and audit path are reused.

### Review Findings

- Architecture: 8 issues found and folded.
- Code quality: 3 issues found and folded.
- Tests: coverage diagram produced; 13 parser, scorer, causality, retag, cutover, and audit gaps made explicit.
- Performance: 2 issues found and folded: symmetric repeat policy and p99/max tail census.
- Late pipeline/audit analyses: 4 additional gaps folded: urgent-F1 measurement, locked double-adjudication, red existing AI gates, and stale-finance refiner overreach.
- Failure modes: 6 initial critical gaps; 0 unresolved in plan.
- Outside voice: Codex authentication failed before inference; independent standard-model reviewer ran and returned 13 findings.
- Cross-model tension: none on settled strategy.
Typed usage recovery for malformed Bedrock JSON remains deferred because any schema failure now hard-blocks promotion.
- Parallelization: 1 sequential implementation lane; frozen baseline/candidate worktrees run serially to avoid Bedrock contention.
- TODO proposals: 6 considered, 0 added to root `TODOS.md`.
- Lake Score: 15/16 coverage recommendations chose the complete option.

### Final Engineering Verdict

Proceed with evaluator/exporter and baseline freeze first.
Do not edit the prompt, deploy v5, or touch durable labels until U1 produces three real, complete baseline reports.

Status: **DONE**
