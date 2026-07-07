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
| `AI_ENABLED` | `false` | Enables AI env validation and worker runtime |
| `AI_MODEL_ID` | `amazon.nova-lite-v1:0` | Bedrock/default model id |
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
2. Scorers check category, urgent overlay, JSON validity, and security fixtures.
3. `writeGateEnabled` stays false until spike passes.
4. `applyDurableTriageResult` only mutates category/spam/urgent state when write gate is enabled.

Run locally:

```bash
pnpm --filter @zero/server ai:test -- --mode=spike
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
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/fixture-loopback-gate.sh'
```

## Future Auto-Send Prerequisites

- Spike gate green on production-like fixtures for 7+ days.
- HITL feedback dataset with stable edit-label distribution.
- Explicit hotel approval policy and rollback plan.
- Separate least-privilege send worker with human approval thresholds.
