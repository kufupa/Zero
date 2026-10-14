# Server Pilot AI Mail Pipeline

Self-hosted AI mail pipeline for async triage, candidate drafts, HITL feedback, and spike evals.

## Architecture

- App Postgres owns product truth: `ai_workflow_run`, categories, drafts, revisions, feedback metrics.
- Mastra provides local workflow runtime and trace storage only (LibSQL file under `MASTRA_STORAGE_PATH`).
- `ai-worker` PM2 process claims queued runs and executes workflows.
- Ingest and send paths enqueue runs inside existing mail transactions.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `AI_ENABLED` | `false` | Enables model adapter selection |
| `AI_WRITE_GATE_ENABLED` | `false` | Shadow-only triage when false; durable category/spam writes when true |
| `AI_DRAFTS_ENABLED` | `false` | Enqueues `candidate_draft` runs after successful triage when true |
| `AI_STALE_RUN_TIMEOUT_MS` | `900000` | Reclaim stale `claimed`/`running` AI runs after this many ms |
| `AI_MODEL_ID` | `global.openai.gpt-6-luna` | Bedrock-backed Luna model id |
| `AI_TRIAGE_MODEL_PROFILE` | `gpt6_luna_max` | Folder-triage model profile; deprecated `nova_lite` requires an explicit Nova Lite model id |
| `BEDROCK_REGION` | `us-east-1` | Bedrock runtime region for the global Luna profile |
| `BEDROCK_PIPELINE_LIVE_TEST` | unset | Opt-in Playwright live pipeline proof only |
| `BEDROCK_GUARDRAIL_ID` | optional | Bedrock guardrail id |
| `BEDROCK_GUARDRAIL_VERSION` | optional | Bedrock guardrail version |
| `MASTRA_STORAGE_PATH` | `./data/mastra/runtime.db` | Local Mastra LibSQL storage |

Rejected when `AI_ENABLED=true`:

- `LANGFUSE_*`
- `LANGSMITH_*`
- `MASTRA_CLOUD_*`
- `MASTRA_PLATFORM_*`

## Policy Boundaries

- No Langfuse, LangSmith, hosted Mastra platform, or hosted observability exporters.
- No autonomous email send from `ai-worker`.
- Inbound mail is visible immediately after ingest commit; AI failure does not block inbox.
- Traces and support exports redact secrets, credentials, tokens, and system prompts.

## Run States

`ai_workflow_run.state`:

`queued` → `claimed` → `running` → `succeeded` | `retry_wait` | `dead_letter` | `superseded`

Run kinds:

- `inbound_triage`
- `candidate_draft`
- `feedback_extraction`

## Shadow-To-Write Gate

1. Spike eval runs against `tests/fixtures/ai-spike/*`.
2. Scorers check category, urgent overlay, draft skeleton schema, failure no-mutation, JSON validity, and security fixtures.
3. `AI_WRITE_GATE_ENABLED` defaults false; set true only after spike passes and ops approves durable writes.
4. `applyDurableTriageResult` only mutates AI-managed category rows and spam state when write gate is enabled.
5. `AI_DRAFTS_ENABLED` defaults false; candidate drafts enqueue only when explicitly enabled and thread is not spam.

Run locally:

```bash
pnpm --filter @zero/server ai:test -- --mode=spike
```

## Gate Order (opt-in live proof last)

1. `pnpm --dir apps/server-pilot test tests/ai-*.test.ts --reporter=dot`
2. `pnpm eval:ci`
3. `apps/server-pilot/deploy/bedrock-live-gate.sh`
4. `apps/server-pilot/deploy/wire-gate.sh`
5. `apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh`

## Triage proof profile (pilot)

For durable triage proof on EC2: `AI_ENABLED=true`, `AI_WRITE_GATE_ENABLED=true`, `AI_DRAFTS_ENABLED=false`, `MAIL_TRANSPORT_MODE=wire`.
Run `apps/server-pilot/deploy/ai-triage-live-gate.sh` after deploy. Inspect `ai_workflow_run.metrics` for `usage` (tokens, `estimatedCostUsd`, `rateTableVersion`) and `applyMode`.

## Rollback

```bash
AI_WRITE_GATE_ENABLED=false
AI_DRAFTS_ENABLED=false
pm2 restart ai-worker --update-env
```

Existing Inbox mail remains visible. Existing AI category memberships and candidate drafts are not deleted automatically.

## Failure Lookup

Latest failed AI runs:

```sql
SELECT id, run_kind, state, last_error, updated_at
FROM ai_workflow_run
WHERE state IN ('retry_wait', 'dead_letter')
ORDER BY updated_at DESC
LIMIT 20;
```

Trace by trigger message id:

```sql
SELECT id, run_kind, state, mastra_trace_id, metrics
FROM ai_workflow_run
WHERE trigger_message_id = $1
ORDER BY created_at;
```

Candidate drafts by generation id:

```sql
SELECT d.id, d.status, d.origin, d.subject, d.to_addresses
FROM mail_draft d
WHERE d.generation_id = $1;
```

Category memberships by thread id:

```sql
SELECT c.slug, c.name
FROM mail_thread_category tc
JOIN mail_category c ON c.id = tc.category_id
WHERE tc.thread_id = $1;
```

## Trace Lookup

- App ledger: `ai_workflow_run.mastra_trace_id`, `mastra_scorer_id`, `metrics`.
- Mastra local store: file at `MASTRA_STORAGE_PATH`.

## EC2 Deploy And Test

From repo root on laptop:

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && source .env.production && set +a && pnpm db:migrate'
bash apps/server-pilot/deploy/ssm-run-command.sh 'export NVM_DIR=/home/ubuntu/.nvm; . /home/ubuntu/.nvm/nvm.sh; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh 'curl -fsS http://127.0.0.1:8788/health'
bash apps/server-pilot/deploy/ssm-run-command.sh 'set -a; source /home/ubuntu/repos/zero/apps/server-pilot/.env.production; set +a; export NODE_ENV=test; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ai-gate.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/wire-gate.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/bedrock-live-gate.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/fixture-loopback-gate.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh'
```

## Adapter selection

| Runtime | Adapter |
|---------|---------|
| `NODE_ENV=test` (gates, vitest) | `FakeModelAdapter` |
| `ai-worker` PM2 (`AI_ENABLED=true`) | `LunaModelAdapter` → Bedrock `global.openai.gpt-6-luna` at max reasoning effort |
| `ai-gate.sh` spike eval | fake only (deterministic) |
| `bedrock-live-gate.sh` | one live Luna Responses call via instance role |
| `ai-mail-pipeline-live-gate.sh` | opt-in Mailpit → triage → category → draft → Playwright proof |

IAM: inline policy `NavaZeroBedrockInvoke` on worker role — see `apps/server-pilot/deploy/aws-resources.md`.

## Future Auto-Send Prerequisites

- Spike gate green on production-like fixtures for 7+ days.
- HITL feedback dataset with stable edit-label distribution.
- Explicit hotel approval policy and rollback plan.
- Separate least-privilege send worker with human approval thresholds.
