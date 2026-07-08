# Server Pilot AI Mail Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the self-hosted server-pilot AI mail pipeline: async triage, candidate drafts, HITL edit feedback, Mastra evals, Bedrock adapter, and EC2 autonomous gates with no Langfuse and no AI send.

**Architecture:** App Postgres owns product truth through an `ai_workflow_run` ledger, existing mail category/spam/draft tables, and feedback/eval records. Mastra wraps deterministic app services for workflow orchestration, datasets, scorers, and local traces. `ai-worker` is a thin PM2 runner that claims queued rows and never receives SMTP/POP3 credentials.

**Tech Stack:** TypeScript, Hono, tRPC, Drizzle, Postgres/RDS, S3, PM2, Mastra, Amazon Bedrock (`amazon.nova-lite-v1:0` default), Vitest, EC2 SSM gates.

## Global Constraints

- No Langfuse, LangSmith, hosted Mastra platform, or hosted observability exporter.
- No autonomous email send in this plan; AI may create candidate drafts only.
- Inbound mail must be visible immediately after ingest commit; AI failure must not block inbox.
- Triage uses `internal`, `individual`, `group`, `travel-agents`, `spam`, and `urgent` overlay.
- Triage runs shadow/eval first, then durable writes after spike gate passes.
- Full guest email content may remain in product DB for pilot verification; traces/support exports redact secrets, credentials, tokens, and system prompts.
- Bedrock provider access goes through a small adapter; keep model id configurable for Azure/provider swap later.
- One task subagent owns one file cluster. Never run two editing subagents against the same file.
- Existing files must be edited with diff-aware tools only. Never full-file overwrite an existing large file.
- After each task: run targeted tests, build/type gate where relevant, shrink sweep, inspect diff, then commit.
- Hard-stop on first unexpected red gate. Diagnose root cause before further edits.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Sync | `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` |
| Deploy | `apps/server-pilot/deploy/deploy-ec2.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |

**Allowed:** bundle sync, deploy, migrate, seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

FAIL -> reproduce -> root cause (file:line) -> fix -> test -> commit -> resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria -> take it. Log in handoff report.

### Done criteria

- [ ] Local server-pilot build and targeted AI/mail tests pass on disk.
- [ ] No Langfuse/LangSmith/hosted Mastra package or env path exists.
- [ ] AI run ledger, claim/retry state, and idempotency tests pass.
- [ ] Ingest enqueues AI run atomically and inbox remains visible without AI.
- [ ] Send enqueues feedback run after SMTP success and never blocks on AI.
- [ ] Candidate draft creation is idempotent and reuses existing promotion lifecycle.
- [ ] AI worker has no SMTP/POP3 env keys and cannot import send-capable modules.
- [ ] Spike/eval gate runs with demo corpus and red-team fixtures.
- [ ] EC2 sync, migrate, deploy, health, and AI/fixture gates pass or are skipped with documented non-credential reason.
- [ ] Handoff report records exact gates run and any divergence.

## Execution Mode

Autonomous overnight - no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

---

## File Map

- `apps/server-pilot/package.json`: add AI scripts/dependencies and package guard coverage.
- `apps/server-pilot/src/env.ts`: parse AI env, default model, reject hosted observability env.
- `apps/server-pilot/src/db/schema/mail.ts`: add AI run, feedback, prompt/eval tables while preserving existing mail/draft schema.
- `apps/server-pilot/drizzle/*.sql`: generated migration for AI tables and indexes.
- `apps/server-pilot/src/mail/ingest/store.ts`: enqueue inbound AI run inside message transaction.
- `apps/server-pilot/src/trpc/routes/mail.ts`: enqueue feedback run inside final sent revision transaction.
- `apps/server-pilot/src/ai/*`: new AI domain services, Bedrock adapter, Mastra runtime, workflows, security, eval runner, worker.
- `apps/server-pilot/deploy/pm2.config.cjs`: add `ai-worker` process.
- `apps/server-pilot/tests/*ai*.test.ts`: AI contract, security, worker, eval, feedback, and idempotency tests.
- `docs/server-pilot-ai.md`: runbook and no-cloud/no-send policy.
- `CONCEPTS.md`: glossary entries only if new durable domain terms are missing.

---

### Task 1: Env, Dependency, And Capability Guardrails

**Files:**
- Modify: `apps/server-pilot/package.json`
- Modify: `apps/server-pilot/src/env.ts`
- Modify: `apps/server-pilot/tests/env.test.ts`
- Modify: `apps/server-pilot/tests/package-contract.test.ts`
- Modify: `apps/server-pilot/src/lib/driver/types.ts`
- Modify: `apps/server-pilot/src/trpc/routes/brain.ts`

**Interfaces:**
- Produces: `MailEnv` fields for `AI_ENABLED`, `AI_MODEL_ID`, `BEDROCK_GUARDRAIL_ID`, `BEDROCK_GUARDRAIL_VERSION`, and local Mastra storage config.
- Produces: package contract asserting no `langfuse`, `langsmith`, or Mastra platform exporter dependency.
- Consumes: existing env parser and package contract patterns.

- [ ] **Step 1: Write failing env/package tests**

Add tests that prove:
- AI disabled by default if `AI_ENABLED` is absent.
- AI enabled accepts `AI_MODEL_ID=amazon.nova-lite-v1:0`.
- Any `LANGFUSE_*`, `LANGSMITH_*`, `MASTRA_CLOUD_*`, or `MASTRA_PLATFORM_*` env key throws when AI is enabled.
- Package deps/devDeps do not contain Langfuse, LangSmith, or hosted Mastra exporter package names.

Run:

```bash
pnpm --filter @zero/server test tests/env.test.ts tests/package-contract.test.ts
```

Expected: FAIL on missing AI env parsing and package assertions.

- [ ] **Step 2: Implement minimal env and package guardrails**

Add only required AI packages. Prefer narrow install when implementing:

```bash
pnpm --filter @zero/server add @mastra/core @mastra/libsql @aws-sdk/client-bedrock-runtime
```

If Mastra package names differ in 2026 docs, use current official Mastra packages for core workflow, storage, eval datasets, experiments, and scorers only. Do not add Langfuse/LangSmith/platform exporter packages.

- [ ] **Step 3: Keep capability flags controlled**

Keep `ai: false` and `brain: false` until spike gate is done. If backend needs a hidden internal flag, expose it separately from user-visible legacy AI features.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @zero/server test tests/env.test.ts tests/package-contract.test.ts
pnpm --filter @zero/server build
```

Expected: PASS.

- [ ] **Step 5: Shrink sweep and commit**

Run shrink sweep from repo root:

```bash
for f in $(git diff --name-only HEAD); do old=$(git show "HEAD:$f" 2>/dev/null | wc -l); new=$(wc -l < "$f" 2>/dev/null || echo 0); if [ "$old" -gt 200 ] && [ "$new" -lt $((old / 2)) ]; then echo "SHRANK $f: $old -> $new"; fi; done
```

Expected: no `SHRANK` lines.

Commit:

```bash
git add apps/server-pilot/package.json apps/server-pilot/src/env.ts apps/server-pilot/tests/env.test.ts apps/server-pilot/tests/package-contract.test.ts apps/server-pilot/src/lib/driver/types.ts apps/server-pilot/src/trpc/routes/brain.ts pnpm-lock.yaml
git commit -m "feat: add AI env and package guardrails"
```

---

### Task 2: AI Run Ledger Schema And Claim Contract

**Files:**
- Modify: `apps/server-pilot/src/db/schema/mail.ts`
- Modify: `apps/server-pilot/src/db/schema/index.ts`
- Create/Generate: `apps/server-pilot/drizzle/0008_ai_workflow_run.sql`
- Create: `apps/server-pilot/tests/ai-workflow-run-contract.test.ts`
- Modify: `apps/server-pilot/tests/schema-contract.test.ts`

**Interfaces:**
- Produces: `aiWorkflowRun` table and types.
- Produces: run states `queued | claimed | running | succeeded | retry_wait | dead_letter | superseded`.
- Produces: idempotency key uniqueness for inbound triage, candidate draft, and feedback extraction runs.

- [ ] **Step 1: Write failing schema/claim tests**

Test cases:
- Duplicate idempotency key returns or conflicts with existing row, not two runs.
- Concurrent claim simulation updates exactly one queued row.
- Retry state stores attempts, next-run time, and last error.
- Transport/thread/message ids are required for mail-triggered runs.
- Schema exports `aiWorkflowRun`.

Run:

```bash
pnpm --filter @zero/server test tests/schema-contract.test.ts tests/ai-workflow-run-contract.test.ts
```

Expected: FAIL because table does not exist.

- [ ] **Step 2: Add schema and migration**

Add Drizzle table with columns for identity, tenant scope, subject links, run kind, idempotency key, prompt/model metadata, state, claim owner, attempts, retry/dead-letter fields, Mastra trace/scorer ids, generation id, metrics, error, and timestamps.

Generate migration:

```bash
pnpm --filter @zero/server db:generate
```

Rename generated migration if needed to keep sequence clear.

- [ ] **Step 3: Implement claim helpers**

Create helper module only if tests need reusable logic:

```text
apps/server-pilot/src/ai/run-ledger.ts
```

Expose:
- `enqueueAiRun(input)`
- `claimNextAiRun(input)`
- `markAiRunSucceeded(input)`
- `markAiRunRetry(input)`
- `markAiRunDeadLetter(input)`

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @zero/server test tests/schema-contract.test.ts tests/ai-workflow-run-contract.test.ts
pnpm --filter @zero/server build
```

Expected: PASS.

- [ ] **Step 5: Shrink sweep and commit**

Run shrink sweep. Commit:

```bash
git add apps/server-pilot/src/db/schema/mail.ts apps/server-pilot/src/db/schema/index.ts apps/server-pilot/drizzle apps/server-pilot/tests/schema-contract.test.ts apps/server-pilot/tests/ai-workflow-run-contract.test.ts apps/server-pilot/src/ai/run-ledger.ts
git commit -m "feat: add AI workflow run ledger"
```

---

### Task 3: Atomic Ingest And Send Enqueue

**Files:**
- Modify: `apps/server-pilot/src/mail/ingest/store.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Create: `apps/server-pilot/tests/ai-enqueue-contract.test.ts`
- Modify: `apps/server-pilot/tests/ingest-store.test.ts`
- Modify: `apps/server-pilot/tests/mail-send.test.ts`

**Interfaces:**
- Consumes: `enqueueAiRun(input)` from Task 2.
- Produces: inbound triage/draft run after message commit.
- Produces: feedback extraction run after sent revision commit.

- [ ] **Step 1: Write failing enqueue tests**

Test cases:
- Stored inbound message creates one queued AI run.
- Duplicate inbound UIDL creates no duplicate run.
- Inbox list behavior remains unaffected by missing/running AI.
- `mail.send` creates sent revision and feedback run together after SMTP success.
- SMTP failure does not create feedback run.

Run:

```bash
pnpm --filter @zero/server test tests/ai-enqueue-contract.test.ts tests/ingest-store.test.ts tests/mail-send.test.ts
```

Expected: FAIL on missing AI enqueue.

- [ ] **Step 2: Add inbound enqueue inside transaction**

Insert AI run row in the same transaction as inbound `message`. Keep LLM calls out of ingest.

- [ ] **Step 3: Add feedback enqueue inside send transaction**

After SMTP succeeds, inside the transaction that writes outbound `message`, updates `mailDraft`, and inserts `mailDraftRevision(kind='sent')`, enqueue feedback extraction for drafts linked to an AI generation.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @zero/server test tests/ai-enqueue-contract.test.ts tests/ingest-store.test.ts tests/mail-send.test.ts
pnpm --filter @zero/server build
```

Expected: PASS.

- [ ] **Step 5: Shrink sweep and commit**

Run shrink sweep. Commit:

```bash
git add apps/server-pilot/src/mail/ingest/store.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/tests/ai-enqueue-contract.test.ts apps/server-pilot/tests/ingest-store.test.ts apps/server-pilot/tests/mail-send.test.ts
git commit -m "feat: enqueue AI runs from mail transactions"
```

---

### Task 4: Triage, Candidate Draft, And Feedback Services

**Files:**
- Create: `apps/server-pilot/src/ai/triage.ts`
- Create: `apps/server-pilot/src/ai/drafts.ts`
- Create: `apps/server-pilot/src/ai/feedback.ts`
- Create: `apps/server-pilot/tests/ai-triage-contract.test.ts`
- Create: `apps/server-pilot/tests/ai-feedback-contract.test.ts`
- Modify: `apps/server-pilot/tests/draft-ai-promotion-contract.test.ts`
- Modify: `apps/server-pilot/tests/draft-eval-schema-contract.test.ts`

**Interfaces:**
- Produces: `validateTriageOutput`, `applyShadowTriageResult`, `applyDurableTriageResult`.
- Produces: `persistAiCandidateDraft`.
- Produces: `extractDraftFeedbackLabels`.
- Consumes: existing `aiDraftGeneration`, `mailDraft`, `mailDraftRevision`, `mailCategory`, and `mailThreadCategory`.

- [ ] **Step 1: Write failing service tests**

Test cases:
- Valid triage categories match hotel vocabulary.
- Invalid category or malformed model JSON rejects.
- Shadow triage records metrics and does not mutate categories/spam/urgent.
- Durable triage writes category membership and spam/urgent state only when write gate is enabled.
- Candidate draft persistence creates generation, candidate draft, and `ai_generated` revision in one transaction.
- Replayed generation does not create duplicate candidate drafts.
- Feedback extraction compares `ai_generated` to `sent` revision and labels edit classes.

Run:

```bash
pnpm --filter @zero/server test tests/ai-triage-contract.test.ts tests/ai-feedback-contract.test.ts tests/draft-ai-promotion-contract.test.ts tests/draft-eval-schema-contract.test.ts
```

Expected: FAIL on missing services.

- [ ] **Step 2: Implement deterministic service functions**

Keep services pure or DB-transaction scoped. Do not import Mastra or Bedrock here. Do not import SMTP or POP3 modules.

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @zero/server test tests/ai-triage-contract.test.ts tests/ai-feedback-contract.test.ts tests/draft-ai-promotion-contract.test.ts tests/draft-eval-schema-contract.test.ts
pnpm --filter @zero/server build
```

Expected: PASS.

- [ ] **Step 4: Shrink sweep and commit**

Run shrink sweep. Commit:

```bash
git add apps/server-pilot/src/ai/triage.ts apps/server-pilot/src/ai/drafts.ts apps/server-pilot/src/ai/feedback.ts apps/server-pilot/tests/ai-triage-contract.test.ts apps/server-pilot/tests/ai-feedback-contract.test.ts apps/server-pilot/tests/draft-ai-promotion-contract.test.ts apps/server-pilot/tests/draft-eval-schema-contract.test.ts
git commit -m "feat: add AI triage draft and feedback services"
```

---

### Task 5: Security Boundary And Bedrock Adapter

**Files:**
- Create: `apps/server-pilot/src/ai/security/redact.ts`
- Create: `apps/server-pilot/src/ai/security/policy.ts`
- Create: `apps/server-pilot/src/ai/bedrock/adapter.ts`
- Create: `apps/server-pilot/src/ai/bedrock/fake.ts`
- Create: `apps/server-pilot/tests/ai-security-contract.test.ts`
- Create: `apps/server-pilot/tests/bedrock-adapter-contract.test.ts`

**Interfaces:**
- Produces: model adapter interface with fake and Bedrock implementations.
- Produces: redaction and policy guard functions.
- Consumes: env model/guardrail config from Task 1.

- [ ] **Step 1: Write failing security tests**

Test cases:
- Prompt injection fixture cannot override system policy.
- Forbidden send/tool request rejects before workflow side effects.
- Output must validate as structured JSON.
- SMTP/POP3 secrets, auth tokens, API keys, and system prompt text are redacted.
- Fake adapter returns deterministic fixture output.

Run:

```bash
pnpm --filter @zero/server test tests/ai-security-contract.test.ts tests/bedrock-adapter-contract.test.ts
```

Expected: FAIL on missing modules.

- [ ] **Step 2: Implement adapter and policy**

Use fake adapter for tests. Bedrock implementation should be small and isolated. App policy rejects unsafe input/output even when Guardrails are unavailable.

- [ ] **Step 3: Verify**

Run:

```bash
pnpm --filter @zero/server test tests/ai-security-contract.test.ts tests/bedrock-adapter-contract.test.ts
pnpm --filter @zero/server build
```

Expected: PASS.

- [ ] **Step 4: Shrink sweep and commit**

Run shrink sweep. Commit:

```bash
git add apps/server-pilot/src/ai/security apps/server-pilot/src/ai/bedrock apps/server-pilot/tests/ai-security-contract.test.ts apps/server-pilot/tests/bedrock-adapter-contract.test.ts
git commit -m "feat: add AI security and Bedrock adapter"
```

---

### Task 6: Mastra Runtime And AI Worker

**Files:**
- Create: `apps/server-pilot/src/ai/mastra.ts`
- Create: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Create: `apps/server-pilot/src/ai/worker.ts`
- Modify: `apps/server-pilot/deploy/pm2.config.cjs`
- Create: `apps/server-pilot/tests/ai-worker-contract.test.ts`
- Modify: `apps/server-pilot/tests/deploy-config.test.ts`

**Interfaces:**
- Consumes: run ledger, domain services, security policy, model adapter.
- Produces: `ai-worker` runner and Mastra workflow.
- Produces: PM2 `ai-worker` process with no SMTP/POP3 env keys.

- [ ] **Step 1: Write failing worker/deploy tests**

Test cases:
- PM2 config contains `ai-worker`.
- `ai-worker` env excludes POP3/SMTP secret keys.
- Worker claims queued run and marks it succeeded.
- Worker retry does not duplicate candidate draft.
- Worker module does not import send-capable SMTP modules.

Run:

```bash
pnpm --filter @zero/server test tests/ai-worker-contract.test.ts tests/deploy-config.test.ts
```

Expected: FAIL on missing worker/PM2 process.

- [ ] **Step 2: Implement Mastra runtime and workflow**

Configure local storage/export only. Do not enable hosted platform exporter. Workflow should call app services, not perform raw DB side effects inline.

- [ ] **Step 3: Implement `ai-worker`**

Runner loop:
- Claim due run.
- Mark running.
- Execute matching workflow.
- Store trace/scorer ids and metrics.
- Mark success, retry, dead-letter, or superseded.

- [ ] **Step 4: Verify**

Run:

```bash
pnpm --filter @zero/server test tests/ai-worker-contract.test.ts tests/deploy-config.test.ts
pnpm --filter @zero/server build
```

Expected: PASS.

- [ ] **Step 5: Shrink sweep and commit**

Run shrink sweep. Commit:

```bash
git add apps/server-pilot/src/ai/mastra.ts apps/server-pilot/src/ai/workflows apps/server-pilot/src/ai/worker.ts apps/server-pilot/deploy/pm2.config.cjs apps/server-pilot/tests/ai-worker-contract.test.ts apps/server-pilot/tests/deploy-config.test.ts
git commit -m "feat: add Mastra workflow runner"
```

---

### Task 7: Spike Fixtures, Evals, And Shadow-To-Write Gate

**Files:**
- Create: `apps/server-pilot/tests/fixtures/ai-spike/centurion-demo.json`
- Create: `apps/server-pilot/tests/fixtures/ai-spike/redteam.json`
- Create: `apps/server-pilot/src/ai/scorers/category.ts`
- Create: `apps/server-pilot/src/ai/scorers/security.ts`
- Create: `apps/server-pilot/src/ai/eval-runner.ts`
- Modify: `apps/server-pilot/package.json`
- Create: `apps/server-pilot/tests/ai-eval-runner.test.ts`

**Interfaces:**
- Produces: `pnpm --filter @zero/server ai:test -- --mode spike`.
- Produces: pass/fail report with trace ids, scorer ids, latency, token/cost metrics.
- Consumes: `apps/mail/lib/demo-data/centurion-threads.json` as fixture source.

- [ ] **Step 1: Write failing eval tests**

Test cases:
- Fixture loader maps demo threads into expected labels.
- Red-team fixtures fail safe.
- Spike gate blocks durable triage writes when threshold fails.
- Spike gate enables write gate when threshold passes.

Run:

```bash
pnpm --filter @zero/server test tests/ai-eval-runner.test.ts
```

Expected: FAIL on missing eval runner.

- [ ] **Step 2: Implement fixtures and scorers**

Cover at least:
- spam sales email.
- individual booking.
- group quote.
- internal/banqueting message.
- travel-agent message.
- urgent overlay.
- prompt injection asking model to reveal prompt or send mail.

- [ ] **Step 3: Add script and verify**

Run:

```bash
pnpm --filter @zero/server ai:test -- --mode spike
pnpm --filter @zero/server test tests/ai-eval-runner.test.ts
pnpm --filter @zero/server build
```

Expected: PASS and report generated.

- [ ] **Step 4: Shrink sweep and commit**

Run shrink sweep. Commit:

```bash
git add apps/server-pilot/tests/fixtures/ai-spike apps/server-pilot/src/ai/scorers apps/server-pilot/src/ai/eval-runner.ts apps/server-pilot/package.json apps/server-pilot/tests/ai-eval-runner.test.ts
git commit -m "feat: add AI spike eval gate"
```

---

### Task 8: Docs, EC2 Gates, And Handoff Report

**Files:**
- Create: `docs/server-pilot-ai.md`
- Modify: `CONCEPTS.md`
- Create or Modify: `apps/server-pilot/deploy/ai-gate.sh`
- Create: `docs/superpowers/plans/handoff-reports/2026-07-07-ai-mail-pipeline-report.md`

**Interfaces:**
- Produces: AI runbook and EC2 AI gate.
- Consumes: existing SSM, bundle sync, migrate, deploy, fixture loopback, and health patterns.

- [ ] **Step 1: Write runbook**

Include:
- architecture.
- env.
- no Langfuse/no hosted Mastra.
- no-send boundary.
- run states.
- shadow-to-write gate.
- eval reports.
- trace lookup.
- EC2 deploy/test steps.
- future auto-send prerequisites.

- [ ] **Step 2: Add concept glossary entries**

Only add missing durable terms:
- AI workflow run.
- Shadow triage.
- AI candidate draft.
- HITL feedback label.
- AI workflow runner.

- [ ] **Step 3: Add EC2 AI gate if missing**

Gate should run targeted AI tests and build with `NODE_ENV=test`, using ASCII-safe output when run through SSM.

- [ ] **Step 4: Run full local gate**

Run from repo root:

```bash
pnpm --filter @zero/server test tests/env.test.ts tests/package-contract.test.ts tests/schema-contract.test.ts tests/ai-workflow-run-contract.test.ts tests/ai-enqueue-contract.test.ts tests/ai-triage-contract.test.ts tests/ai-feedback-contract.test.ts tests/ai-security-contract.test.ts tests/bedrock-adapter-contract.test.ts tests/ai-worker-contract.test.ts tests/deploy-config.test.ts tests/ai-eval-runner.test.ts
pnpm --filter @zero/server build
pnpm --filter @zero/mail build
```

Expected: PASS.

- [ ] **Step 5: Run EC2 gate**

Sync:

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
```

Migrate explicitly:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && source .env.production && set +a && pnpm db:migrate'
```

Deploy:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'export NVM_DIR=/home/ubuntu/.nvm; . /home/ubuntu/.nvm/nvm.sh; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh'
```

Health:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'curl -fsS http://127.0.0.1:8788/health'
```

AI/fixture gates:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'set -a; source /home/ubuntu/repos/zero/apps/server-pilot/.env.production; set +a; export NODE_ENV=test; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ai-gate.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/fixture-loopback-gate.sh'
```

Optional wire gate when Mailpit is installed and relevant:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/wire-gate.sh'
```

- [ ] **Step 6: Write handoff report**

Report exact:
- commits.
- local gates.
- EC2 gates.
- skipped gates and reason.
- migrations applied.
- PM2 process state.
- known risks.
- divergence from plan.

- [ ] **Step 7: Final shrink sweep and commit**

Run shrink sweep. Commit:

```bash
git add docs/server-pilot-ai.md CONCEPTS.md apps/server-pilot/deploy/ai-gate.sh docs/superpowers/plans/handoff-reports/2026-07-07-ai-mail-pipeline-report.md
git commit -m "docs: add AI mail pipeline runbook and gates"
```

---

## Final Verification Matrix

- Local targeted AI/mail tests: must pass.
- `pnpm --filter @zero/server build`: must pass.
- `pnpm --filter @zero/mail build`: must pass if frontend wire/capability files changed.
- Shrink sweep: no `SHRANK` output before every commit.
- `git diff --check`: no whitespace errors.
- EC2 explicit RDS migrate: must pass after schema changes.
- EC2 deploy and health: must pass.
- EC2 AI gate: must pass or document AWS Bedrock IAM gap while fake adapter tests still pass.
- Fixture loopback gate: must pass after mail route/send/ingest changes.
- No hosted observability package/env: package and env contract tests prove it.
- No-send invariant: worker tests prove no SMTP/POP3 env and no send-capable import.

## Subagent Dispatch Rules

- Dispatch one fresh subagent per task.
- Never dispatch two tasks that touch `apps/server-pilot/src/db/schema/mail.ts`, `apps/server-pilot/src/trpc/routes/mail.ts`, `apps/server-pilot/src/mail/ingest/store.ts`, or `apps/server-pilot/package.json` in parallel.
- Parent orchestrator reviews each subagent diff before launching next task.
- Reviewer checks: no truncation, tests real, package graph clean, no AI send path, no hosted observability, no unscoped transport access.
- Commit after each task only when tests and shrink sweep pass.

## Execution Handoff

Autonomous overnight execution required. Start with Task 1 and continue through Task 8. Use subagent-driven development unless subagent output becomes unsafe; then continue inline with the same task gates.
