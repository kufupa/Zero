---
title: Live AI mail pipeline with Mastra workflows, ai-worker writes, and opt-in gates
date: 2026-07-08
category: architecture-patterns
problem_type: architecture_pattern
module: server-pilot
component: email_processing
severity: medium
applies_when:
  - Proving production-shaped AI mail loop on EC2 (Mailpit ingest through browser-visible category and draft proof)
  - Separating Mastra model workflows from ai-worker product writes
  - Enabling durable triage categories and candidate drafts behind opt-in write gates
  - Running live Bedrock gates without making them daily deploy blockers
tags:
  - ai-mail-pipeline
  - mastra
  - ai-worker
  - ai-workflow-run
  - bedrock
  - mailpit
  - triage
  - candidate-draft
related_components:
  - background_job
  - assistant
  - testing_framework
  - database
---

# Live AI mail pipeline with Mastra workflows, ai-worker writes, and opt-in gates

## Context

The EC2-pilot hotel mailbox needed a production-shaped proof that real ingest, real LLM calls, durable triage, candidate draft generation, and browser visibility all connect — without autonomous send, without blocking inbox on AI failure, and without making live Bedrock proof a daily deploy gate.

Prior work wired `FakeModelAdapter` and the Bedrock adapter factory (`docs/solutions/integration-issues/bedrock-adapter-factory-and-ec2-live-gate.md`). The gap was the full loop: Mailpit SMTP → POP3 ingest → Postgres → `ai_workflow_run` triage → optional category writes → optional candidate draft → Playwright browser proof.

Branch `EC2-pilot`, commits `e188fe4f`–`b3f3e5ae`, implemented the eight-task plan in `docs/superpowers/plans/2026-07-08-live-ai-mail-pipeline.md`.

## Guidance

### Separation of concerns

| Layer | Owns | Must not |
|-------|------|----------|
| Mastra workflows (`mail-triage`, `candidate-draft`) | Model invocation, JSON validation, trace/metrics | Product DB writes, SMTP/POP3 |
| `ai-worker` | Claim runs, apply triage, enqueue drafts, persist drafts, mark terminal state | Import send-capable mail modules or receive mail secrets |
| `ai_workflow_run` | Durable queue, idempotency, retry/dead-letter | — |

`NODE_ENV=test` always uses `FakeModelAdapter`. Live Bedrock gates are opt-in (`BEDROCK_PIPELINE_LIVE_TEST=1`).

### Opt-in write gates (default shadow)

```typescript
// apps/server-pilot/src/env.ts — defaults false
AI_WRITE_GATE_ENABLED  // durable category/spam writes
AI_DRAFTS_ENABLED      // enqueue candidate_draft after triage
```

PM2 passes gates to `ai-worker` without mail secrets (`apps/server-pilot/deploy/pm2.config.cjs`). Rollback: set both false and `pm2 restart ai-worker --update-env`.

### AI-managed categories

Single source of truth in `apps/server-pilot/src/ai/categories.ts`:

- Primary (exactly one): `internal`, `individual`, `group`, `travel-agents`, or `spam`
- Overlay (optional): `urgent`
- Seeded idempotently via `AI_MANAGED_CATEGORY_SEED_ROWS`

`applyDurableTriageResult` replaces only AI-managed category memberships; non-AI category rows are preserved. Non-spam triage leaves existing `spamAt` untouched (V1 does not track spam provenance).

### Triage workflow contract

`mail-triage` Mastra workflow returns validated `output`, `metrics`, and `traceId`. Worker calls `validateTriageOutput` before any durable write. Local validation is mandatory even when Bedrock structured output is enabled.

### Durable commit + draft enqueue in one transaction

Triage success, optional draft enqueue, and `markAiRunSucceeded` share one DB transaction so a stale worker cannot mark success after reclaim:

```typescript
// apps/server-pilot/src/ai/worker.ts (inbound_triage path)
await db.transaction(async (tx) => {
  await applyDurableTriageFromWorker({ ..., writeGateEnabled: env.AI_WRITE_GATE_ENABLED });
  if (env.AI_DRAFTS_ENABLED && output.category !== 'spam' && !threadBeforeDraft?.spamAt) {
    await enqueueAiRun({ runKind: 'candidate_draft', idempotencyKey: `candidate-draft:${triggerMessageId}` }, tx);
  }
  const marked = await markAiRunSucceeded({ runId, claimOwner: owner, expectedStates: ['running'], ... }, tx);
  if (!marked) throw new Error(`failed to mark AI run succeeded with claim fencing: ${runId}`);
});
```

### Claim fencing on terminal updates

`markAiRunSucceeded`, `markAiRunRetry`, and `markAiRunDeadLetter` require matching `claimOwner` and `expectedStates`. A reclaimed worker's terminal update returns `null` instead of overwriting a newer owner's result:

```typescript
// apps/server-pilot/src/ai/run-ledger.ts
.where(
  and(
    eq(aiWorkflowRun.id, input.runId),
    eq(aiWorkflowRun.claimOwner, input.claimOwner),
    inArray(aiWorkflowRun.state, input.expectedStates),
  ),
)
```

`claimNextAiRun` reclaims stale `claimed`/`running` rows after `AI_STALE_RUN_TIMEOUT_MS` (default 15 min).

### Candidate draft: code-derived recipients and subject

The LLM returns skeleton body only. `deriveReplyToAddress` and `deriveReplySubject` run in worker code before `persistAiCandidateDraft`:

```typescript
// apps/server-pilot/src/ai/workflows/candidate-draft.ts
export function deriveReplySubject(subject: string | null | undefined): string {
  const trimmed = subject?.trim() || 'Your inquiry';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
```

Draft persists as `mail_draft` with `status='candidate'`, `origin='ai'`.

### Frontend and browser proof

- `apps/mail/app/(routes)/mail/[folder]/page.tsx` — folder routes validate against live categories, not just static labels
- `apps/mail/components/mail/thread-display.tsx` — stable `data-testid` on AI draft card
- `packages/testing/e2e/ai-mail-pipeline.spec.ts` — Playwright proof behind `BEDROCK_PIPELINE_LIVE_TEST`

### Gate order (opt-in live last)

1. `pnpm --dir apps/server-pilot test tests/ai-*.test.ts`
2. `pnpm eval:ci` (fake adapter spike)
3. `bedrock-live-gate.sh` (IAM proof)
4. `wire-gate.sh`
5. `ai-mail-pipeline-live-gate.sh` (full Mailpit → Bedrock → browser proof)

See `docs/server-pilot-ai.md` for rollback SQL and failure lookup.

## Why This Matters

Without this split, LLM output could mutate mailbox state directly, race on concurrent workers, or block inbox visibility. Opt-in gates let ops shadow-triage in production before enabling writes. Claim fencing prevents double-application when workers reclaim stale runs. Code-derived draft metadata prevents model hallucination of recipients or subjects.

## When to Apply

- Adding a new AI workflow kind — register in Mastra, enqueue via `run-ledger`, execute in `ai-worker`, fence terminal marks
- Enabling durable AI writes in production — spike eval pass, then `AI_WRITE_GATE_ENABLED=true`, then optionally `AI_DRAFTS_ENABLED=true`
- Adding a new triage category — extend `categories.ts`, seed, update triage schema and eval fixtures
- Proving live Bedrock on EC2 — run `ai-mail-pipeline-live-gate.sh`, not daily `ai-gate.sh`

## Examples

### Shadow triage (production default)

```bash
AI_ENABLED=true
AI_WRITE_GATE_ENABLED=false
AI_DRAFTS_ENABLED=false
```

Runs classify and record metrics; inbox categories unchanged.

### Full live proof on EC2

```bash
BEDROCK_PIPELINE_LIVE_TEST=1 \
AI_WRITE_GATE_ENABLED=true \
AI_DRAFTS_ENABLED=true \
apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh
```

### Eval cases added for regression

`eval-runner` includes draft skeleton schema checks and failure no-mutation cases (`tests/fixtures/ai-spike/centurion-demo.json`).

## Related

- [Bedrock adapter factory and EC2 live gate](../integration-issues/bedrock-adapter-factory-and-ec2-live-gate.md) — adapter selection and IAM proof (complements this doc; does not cover full pipeline)
- [EC2 AI contract tests RDS gate FK setup](../test-failures/ec2-ai-contract-tests-rds-gate-fk-setup.md) — DB-backed contract test setup
- [PM2 ESM is-CLI-entry + unref sleep](../runtime-errors/pm2-esm-is-cli-entry-and-unref-sleep.md) — `worker` / `ai-worker` stay online under PM2 (argv + timer refs)
- `docs/server-pilot-ai.md` — operator runbook (flags, gate order, rollback, SQL diagnostics)
- `docs/superpowers/plans/2026-07-08-live-ai-mail-pipeline.md` — implementation plan source
