# Wire Gate + Real Bedrock Adapter — Overnight Autonomous Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. No user checkpoint.

**Goal:** Ship real `BedrockModelAdapter`, factory/env wiring, EC2 wire gate green, EC2 bedrock-live gate green. Nova Lite stays `us-east-1`.

**Architecture:** Mirror mail transport fake/real split. Daily `ai-gate.sh` stays fake. On-demand `wire-gate.sh` + `bedrock-live-gate.sh` prove prod RDS + instance-role Bedrock.

**Tech Stack:** TypeScript, `@aws-sdk/client-bedrock-runtime` Converse, Vitest, EC2 SSM, IAM inline policy.

## Global Constraints

- No Langfuse, LangSmith, hosted Mastra, autonomous send.
- `MAIL_TRANSPORT_MODE=fixture` in production `.env.production`.
- `amazon.nova-lite-v1:0` in `BEDROCK_REGION=us-east-1` only.
- One subagent per file cluster. Diff-aware edits. Commit after each green task.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions. No manual login.

### AWS / infra

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Sync | `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` |
| Deploy | `apps/server-pilot/deploy/deploy-ec2.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |

**Allowed:** bundle sync, deploy, IAM `put-role-policy`, SSM gates, PM2 logs.

**Forbidden:** force-push main, `--no-verify`, real Exchange mail creds.

### RCA loop

FAIL → reproduce → root cause → fix → test → commit → resume.

### Done criteria

- [ ] `BedrockModelAdapter` + `createModelAdapter` factory + `BEDROCK_REGION` env
- [ ] `bedrock-adapter-contract.test.ts` green (mocked SDK)
- [ ] `ai-gate.sh` spike still deterministic (fake)
- [ ] `NavaZeroBedrockInvoke` IAM on worker role
- [ ] `wire-gate.sh` PASS on EC2 via SSM
- [ ] `bedrock-live-gate.sh` PASS on EC2 via SSM
- [ ] `docs/server-pilot-ai.md` + `aws-resources.md` updated
- [ ] Handoff report under `docs/superpowers/plans/handoff-reports/`

## Execution Mode

Autonomous overnight — no user checkpoint.

---

## Task wave

1. **Code:** `bedrock.ts`, `factory.ts`, env, mail-triage factory, tests, gates
2. **Local:** targeted vitest + build
3. **IAM:** `aws iam put-role-policy` NavaZeroBedrockInvoke
4. **EC2:** sync → migrate → deploy → wire-gate → bedrock-live-gate → ai-gate
5. **Handoff report**
