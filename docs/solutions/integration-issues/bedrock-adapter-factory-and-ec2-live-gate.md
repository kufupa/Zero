---
title: Bedrock real adapter with fake/real factory and EC2 live gate
date: 2026-07-07
last_updated: 2026-07-07
category: integration-issues
problem_type: architecture_pattern
module: server-pilot
component: ai/bedrock
tags:
  - bedrock
  - nova-lite
  - ai-worker
  - ec2-gate
severity: medium
---

## Context

AI mail pipeline shipped with `FakeModelAdapter` only. Needed real Bedrock on `ai-worker` while keeping deterministic `ai-gate.sh` spike eval and adding on-demand proof that EC2 instance role can invoke Nova Lite in `us-east-1`.

## Guidance

### Adapter factory (mirror mail transport)

```typescript
// NODE_ENV=test → always fake (vitest, ai-gate)
// AI_ENABLED + production → BedrockModelAdapter
export function createModelAdapter(): ModelAdapter {
  return resolveModelAdapter({ ...process.env });
}
```

Workflow (`mail-triage.ts`) calls `createModelAdapter()` — no hardcoded fake in runtime path.

### Two-tier gates

| Script | Adapter | Purpose |
|--------|---------|---------|
| `ai-gate.sh` | fake spike | every deploy, deterministic |
| `bedrock-live-gate.sh` | live Converse | on-demand IAM + cross-region proof |

Set `BEDROCK_LIVE_TEST=1` for opt-in vitest live contract.

### IAM

Inline policy `NavaZeroBedrockInvoke` on worker role:

```
bedrock:InvokeModel on arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0
```

EC2/RDS stay `af-south-1`; only Bedrock crosses to US.

### Env

- `BEDROCK_REGION` defaults to `us-east-1` when `AI_ENABLED=true`
- PM2 `ai-worker` must include `BEDROCK_REGION` — no SMTP/POP3 keys

## Why This Matters

Mixing live LLM into daily gates causes flaky deploys. Factory + separate live gate keeps CI stable while production worker uses real Nova.

## When to Apply

- Adding new model providers: extend factory, keep test env on fake
- New EC2 regions: verify Bedrock model availability before changing `BEDROCK_REGION`

## Examples

**RCA — build fail on `additionalModelRequestFields`:** SDK `DocumentType` too strict for JSON schema; cast field type on assign.

**RCA — `env.test.ts` EOF:** missing `});` after new `it()` block when inserting `BEDROCK_REGION` test.

## Prevention

- Run `bedrock-adapter-contract.test.ts` with mocked SDK before EC2 live gate
- After IAM attach, wait 2–5 min or retry `bedrock-live-gate.sh` on `AccessDeniedException`
