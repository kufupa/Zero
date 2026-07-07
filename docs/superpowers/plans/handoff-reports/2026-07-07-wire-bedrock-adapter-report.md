# Handoff: Wire Gate + Real Bedrock Adapter

**Date:** 2026-07-07  
**Branch:** EC2-pilot  
**Commit:** `d91b2a8d` (HEAD at handoff refresh; Bedrock landed `2533cc0e`)

## Done

- `BedrockModelAdapter` — Converse API, JSON parse, throttle retry, AccessDenied messaging
- `createModelAdapter` / `resolveModelAdapter` — fake in `NODE_ENV=test`, Bedrock when `AI_ENABLED`
- `BEDROCK_REGION` default `us-east-1` in env + PM2 ai-worker
- `bedrock-live-gate.sh` + opt-in `bedrock-live-contract.test.ts`
- IAM `NavaZeroBedrockInvoke` on worker role
- Docs: `server-pilot-ai.md`, `aws-resources.md`

## Gates (EC2 SSM)

| Gate | Result |
|------|--------|
| `wire-gate.sh` | PASS — 19/19 wire tests |
| `bedrock-live-gate.sh` | PASS — live Converse ~1026ms, in=10 out=6 |
| `deploy-ec2.sh` | Success |
| `ai-gate.sh` | PASS — 78 tests + spike eval |

## Local

```bash
pnpm --filter @zero/server test tests/bedrock-adapter-contract.test.ts tests/env.test.ts
pnpm --filter @zero/server build
```

## Human-only (if blocked)

- Bedrock model access in AWS console (account-level) — verified working
- IAM `put-role-policy` if CLI lacks permission — applied successfully

## Divergences

- Skipped separate `bedrock-iam-policy.json` file (ponytail: inline in aws-resources only)
- Skipped `eval-runner mode=live` (deferred manual benchmark)

## Plans

- CE: `docs/plans/2026-07-07-004-feat-wire-gate-bedrock-real-adapter-plan.md`
- Overnight: `docs/superpowers/plans/2026-07-07-wire-bedrock-real-adapter-autonomous.md`
- SDD: `docs/superpowers/plans/2026-07-07-wire-bedrock-real-adapter-sdd.md`
