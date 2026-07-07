# Server Pilot AI Mail Pipeline — Handoff Report (2026-07-07)

**Branch:** `EC2-pilot`  
**Final SHA:** `10fed90df`  
**EC2:** `i-008f737974a9ba9b3` (`af-south-1`)  
**RDS:** `nava-zero-mail-pilot` (Postgres 16)  
**S3:** `nava-zero-mail-845242190536-af-south-1`  
**Plan:** `docs/superpowers/plans/2026-07-07-server-pilot-ai-mail-pipeline-autonomous.md`

## Summary

Self-hosted AI mail pipeline landed: async `ai_workflow_run` ledger, ingest/send enqueue, triage/draft/feedback services, Bedrock adapter (fake for tests), Mastra workflow runner, `ai-worker` PM2 process, spike eval gate, runbook, and EC2 `ai-gate.sh`. No Langfuse, LangSmith, hosted Mastra, or autonomous send.

## Commits (chronological)

| SHA | Message |
|-----|---------|
| `862cb426` | feat: add AI env and package guardrails |
| `effa2165` | feat: add AI workflow run ledger |
| `d98ed5b2` | feat: enqueue AI runs from mail transactions |
| `514111c2` | feat: add AI triage draft and feedback services |
| `ee2b082e` | feat: add AI security and Bedrock adapter |
| `a7e33823` | feat: add Mastra workflow runner |
| `a40c4d00` | feat: add AI spike eval gate |
| `456357b8` | docs: add AI mail pipeline runbook and ai-gate script |
| `2d45e732` | fix: satisfy AI contract test foreign keys |
| `941c243b` | fix: repair AI contract tests for RDS gate |
| `10fed90d` | fix: resolve candidate draft author from generation row |

## Local gates

| Command | Result |
|---------|--------|
| `pnpm --filter @zero/server test tests/env.test.ts tests/package-contract.test.ts tests/schema-contract.test.ts tests/ai-workflow-run-contract.test.ts tests/ai-enqueue-contract.test.ts tests/ai-triage-contract.test.ts tests/ai-feedback-contract.test.ts tests/ai-security-contract.test.ts tests/bedrock-adapter-contract.test.ts tests/ai-worker-contract.test.ts tests/deploy-config.test.ts tests/ai-eval-runner.test.ts` | **PASS** — 57 passed, 14 skipped (no local `DATABASE_URL`) |
| `pnpm --filter @zero/server build` | **PASS** |
| `pnpm --filter @zero/server ai:test -- --mode=spike` | **PASS** — 8/8 cases, `writeGateEnabled: true` |
| `pnpm --filter @zero/mail build` | **FAIL** — pre-existing missing `@/hooks/use-templates` (and related mail SPA imports); unrelated to AI pipeline |

## EC2 gates

| Command | Result | Notes |
|---------|--------|-------|
| `bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh` | **PASS** | HEAD `10fed90df` on instance |
| `pnpm db:migrate` (SSM) | **PASS** | `0008_ai_workflow_run` applied; no pending migrations |
| `bash apps/server-pilot/deploy/ai-gate.sh` (SSM) | **PASS** | 71/71 RDS tests, spike 8/8, server build |
| `curl -fsS http://127.0.0.1:8788/health` | **PASS** | `{"ok":true,"service":"server-pilot"}` |
| `bash apps/server-pilot/deploy/fixture-loopback-gate.sh` | **PARTIAL** | Vitest 41/41 pass; mail SPA build fails (same pre-existing import gap) |
| `bash apps/server-pilot/deploy/deploy-ec2.sh` | **SKIP** | Blocked by mail build step; server-only PM2 reload used instead |
| `bash apps/server-pilot/deploy/wire-gate.sh` | **SKIP** | Not re-run; Mailpit sidecar already online from prior wire work |

### Server-only deploy (divergence)

Full `deploy-ec2.sh` blocked on mail build. Ran:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'export NVM_DIR=/home/ubuntu/.nvm; . /home/ubuntu/.nvm/nvm.sh; cd /home/ubuntu/repos/zero && pnpm --filter @zero/server build && pm2 startOrReload apps/server-pilot/deploy/pm2.config.cjs --update-env && pm2 save'
```

**PASS** — `ai-worker` started (pm_id 9, online).

## PM2 state (post server reload)

| Process | Status | Notes |
|---------|--------|-------|
| `http` | online | `dist/main.js` |
| `worker` | online | POP3 ingest worker |
| `ai-worker` | online | `dist/ai/worker.js`, `AI_ENABLED=true`, no SMTP/POP3 env keys |
| `mailpit` | online | Wire sidecar (unchanged) |

## RCA (red gates fixed during Task 8)

1. **FK violations in RDS contract tests** (`2d45e732`): Tests inserted `mail_draft` / `generationId` without parent `ai_draft_generation` or seeded thread rows. Fixed seed order in `ai-enqueue-contract.test.ts`, `ai-worker-contract.test.ts`, `ai-workflow-run-contract.test.ts`.

2. **`db` before initialization** (`941c243b`): `const db = getDb()` used after `db.insert` in worker/workflow-run tests. Moved initialization above FK inserts.

3. **SMTP failure enqueue test FORBIDDEN** (`941c243b`): Random transport without `mailboxAccess`. Switched to `seedCenturionThread` + `user-centurion-worker`.

4. **Candidate draft retry test empty drafts on RDS** (`10fed90d`): Worker used `createdByUserId: 'ai-worker'` (no `user` row) → FK failure swallowed by retry path. Fixed worker to use `aiDraftGeneration.requestedByUserId` with fallback `user-centurion-worker`.

## Skipped gates (documented)

| Gate | Reason |
|------|--------|
| Full `deploy-ec2.sh` | Pre-existing `@zero/mail` build breakage (missing hooks/components) |
| `fixture-loopback-gate.sh` (full) | Same mail build failure after vitest suite passed |
| `wire-gate.sh` | Out of AI scope; Mailpit already running |
| Real Bedrock IAM live calls | Fake adapter + spike eval only by design for pilot |

## Done criteria checklist

- [x] Local server-pilot build and targeted AI tests pass
- [x] No Langfuse/LangSmith/hosted Mastra package or env path
- [x] AI run ledger, claim/retry, idempotency tests pass (RDS: 71/71)
- [x] Ingest enqueues AI run atomically; inbox independent of AI
- [x] Send enqueues feedback after SMTP success; no feedback on SMTP failure
- [x] Candidate draft idempotent; promotion lifecycle reused
- [x] AI worker has no SMTP/POP3 env; no send-capable imports
- [x] Spike/eval gate with demo + red-team fixtures (8/8)
- [x] EC2 sync, migrate, health, AI gate pass
- [x] Handoff report (this file)
- [ ] Full EC2 deploy + fixture-loopback mail build — blocked by unrelated mail SPA

## Known risks

- **`brain.ts` / `driver/types.ts`:** `ai: false`, `brain: false` unchanged — user-visible AI off until product enables after spike gate in config.
- **Bedrock:** Real adapter stubbed; production needs IAM + guardrail wiring before live inference.
- **`executeAiRun` candidate_draft:** Pilot uses hardcoded draft body; triage workflow uses fake adapter in tests.
- **`ai-worker` db contract tests:** Use `getDb()` directly (no rollback) on EC2 — can leave orphan rows; consider `withTestDb` wrap later.
- **Mail SPA build:** Blocks full deploy and fixture-loopback completion; fix mail imports separately.

## Divergences from plan

- Used **server-only PM2 reload** instead of full `deploy-ec2.sh` when mail build failed.
- **Three post-Task-8 fix commits** for RDS gate stability (FK, test init order, worker user FK).
- **Capability flags** left false per plan (shadow-first); spike gate passes with fake adapter only.

## Key commands (replay)

```bash
# Local AI gate
pnpm --filter @zero/server test tests/env.test.ts tests/package-contract.test.ts \
  tests/schema-contract.test.ts tests/ai-workflow-run-contract.test.ts \
  tests/ai-enqueue-contract.test.ts tests/ai-triage-contract.test.ts \
  tests/ai-feedback-contract.test.ts tests/ai-security-contract.test.ts \
  tests/bedrock-adapter-contract.test.ts tests/ai-worker-contract.test.ts \
  tests/deploy-config.test.ts tests/ai-eval-runner.test.ts
pnpm --filter @zero/server build
pnpm --filter @zero/server ai:test -- --mode=spike

# EC2
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && source .env.production && set +a && pnpm db:migrate'
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'set -a; source /home/ubuntu/repos/zero/apps/server-pilot/.env.production; set +a; export NODE_ENV=test; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ai-gate.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh 'curl -fsS http://127.0.0.1:8788/health'
```

## Docs

- Runbook: `docs/server-pilot-ai.md`
- Glossary: `CONCEPTS.md` (AI workflow run, shadow triage, candidate draft, HITL feedback label, workflow runner)
