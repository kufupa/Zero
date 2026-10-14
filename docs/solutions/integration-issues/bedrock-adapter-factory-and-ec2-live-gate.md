---
title: Bedrock real adapter with fake/real factory and EC2 live gate
date: 2026-07-07
last_updated: 2026-07-08
category: integration-issues
problem_type: architecture_pattern
module: server-pilot
component: assistant
severity: medium
applies_when:
  - Wiring a real LLM provider into server-pilot ai-worker on EC2
  - Keeping daily deploy gates deterministic while proving live Bedrock IAM works
  - Cross-region Bedrock inference from af-south-1 EC2
tags:
  - bedrock
  - nova-lite
  - ai-worker
  - ec2-gate
  - model-adapter
  - converse-api
related_components:
  - background_job
  - development_workflow
  - testing_framework
---

# Bedrock real adapter with fake/real factory and EC2 live gate

> Superseded for current folder triage (2026-10-13): the default is Bedrock-backed global GPT-6 Luna at max effort. The Nova Lite policy and route below describe the historical rollout only; current provisioning is in [aws-resources.md](../../../apps/server-pilot/deploy/aws-resources.md).

## Context

The AI mail pipeline shipped with `FakeModelAdapter` only. Overnight work on branch `EC2-pilot` (commit `2533cc0e`) wired real Amazon Bedrock inference for the `ai-worker` PM2 process while preserving deterministic `ai-gate.sh` spike eval on every deploy. A separate on-demand `bedrock-live-gate.sh` proves EC2 instance credentials can invoke Nova Lite in `us-east-1` without mixing live LLM calls into daily gates.

**Region decision:** EC2 and RDS stay in `af-south-1`; Bedrock runtime targets `us-east-1` for `amazon.nova-lite-v1:0` cost and availability. Cross-region latency is acceptable for async triage/draft workflows.

## Guidance

### 1. Model adapter interface and factory

Mirror the mail transport factory pattern: one interface, env-driven selection, test env always fake.

```typescript
// apps/server-pilot/src/ai/bedrock/factory.ts
export function resolveModelAdapter(env): ModelAdapter {
  if (env.NODE_ENV === 'test') return createFakeModelAdapter();
  if (!env.AI_ENABLED) return createFakeModelAdapter();
  return createBedrockModelAdapter({
    region: env.BEDROCK_REGION,
    modelId: env.AI_MODEL_ID,
    guardrailId: env.BEDROCK_GUARDRAIL_ID,
    guardrailVersion: env.BEDROCK_GUARDRAIL_VERSION,
  });
}
```

`mail-triage.ts` and other workflows call `createModelAdapter()` — no hardcoded fake in the runtime path.

| Runtime | Adapter | Why |
|---------|---------|-----|
| `NODE_ENV=test` (vitest, gates) | `FakeModelAdapter` | deterministic, no AWS cost |
| `ai-worker` PM2 (`AI_ENABLED=true`) | `BedrockModelAdapter` | real inference |
| `ai-gate.sh` spike eval | fake only | every deploy, no flakiness |

### 2. BedrockModelAdapter (Converse API)

`apps/server-pilot/src/ai/bedrock/bedrock.ts` implements `ModelAdapter.invoke()` via `ConverseCommand`:

- **JSON output:** `parseModelJson()` strips markdown fences, parses JSON, validates through `validateStructuredJsonOutput()`
- **Structured schema:** when `responseSchema` is set, passes `additionalModelRequestFields.responseFormat.json.schema` with `temperature: 0`
- **Guardrails:** optional `guardrailConfig` when `BEDROCK_GUARDRAIL_ID` + version are set
- **Throttling:** one 500ms retry on `ThrottlingException`
- **Errors:** `AccessDeniedException` mapped to actionable message naming model + region

Inject a mock `client` in contract tests; use real `BedrockRuntimeClient` on EC2 via instance role.

### 3. Environment and PM2

`BEDROCK_REGION` defaults to `us-east-1` when `AI_ENABLED=true` (`apps/server-pilot/src/env.ts`). PM2 `ai-worker` must set:

```javascript
env: {
  NODE_ENV: 'production',
  AI_ENABLED: 'true',
  BEDROCK_REGION: 'us-east-1',
}
```

`ai-worker` has no SMTP/POP3 credentials — send-capable imports are forbidden on that process.

### 4. Two-tier gates

| Script | Adapter | When | Purpose |
|--------|---------|------|---------|
| `ai-gate.sh` | fake spike | every deploy | RDS contract tests + deterministic spike eval |
| `bedrock-live-gate.sh` | live Converse | on-demand | IAM + cross-region proof via instance role |
| `wire-gate.sh` | n/a (mail) | on-demand | Mailpit TCP path (orthogonal) |

`bedrock-live-gate.sh` sets `NODE_ENV=production`, `AI_ENABLED=true`, `BEDROCK_LIVE_TEST=1`, then runs `tests/bedrock-live-contract.test.ts`. The test is skipped locally unless `BEDROCK_LIVE_TEST=1`.

```bash
# From operator workstation via SSM
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/bedrock-live-gate.sh'
```

### 5. IAM (least privilege)

Inline policy `NavaZeroBedrockInvoke` on worker role `nava-prod-public-ipv4-WorkerRole-*`:

```
bedrock:InvokeModel on arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0
```

Provisioning command in `apps/server-pilot/deploy/aws-resources.md`. After `put-role-policy`, wait 2–5 minutes before first live gate — IAM propagation can cause transient `AccessDeniedException`.

Account-level Bedrock model access for Nova Lite must also be enabled in the AWS console (one-time).

### 6. Test layers

| Layer | File | Runs when |
|-------|------|-----------|
| Mocked SDK | `tests/bedrock-adapter-contract.test.ts` | local + CI always |
| Env defaults | `tests/env.test.ts` | local + CI always |
| Live Converse | `tests/bedrock-live-contract.test.ts` | EC2 only, `BEDROCK_LIVE_TEST=1` |

Run mocked layer before EC2 live gate:

```bash
pnpm --filter @zero/server test tests/bedrock-adapter-contract.test.ts tests/env.test.ts
pnpm --filter @zero/server build
```

## Why This Matters

Mixing live LLM into daily deploy gates causes flaky, costly, non-deterministic CI. The factory keeps production on real Nova while gates stay fake. The separate live gate gives operators a cheap, on-demand proof that IAM and cross-region Bedrock work — without blocking every deploy.

Deferring `eval-runner mode=live` (ponytail YAGNI) keeps the overnight scope bounded; spike eval on fake adapter is sufficient for deploy confidence.

## When to Apply

- Adding a new model provider: extend factory, keep `NODE_ENV=test` on fake
- Changing Bedrock region: verify model availability and update IAM resource ARN
- New EC2 region: re-run `bedrock-live-gate.sh` after IAM attach
- Guardrail rollout: set `BEDROCK_GUARDRAIL_*` env vars; extend IAM with `bedrock:ApplyGuardrail` if needed

## Examples

### Overnight gate results (EC2 SSM, 2026-07-07)

| Gate | Result |
|------|--------|
| `wire-gate.sh` | PASS — 19/19 wire tests |
| `bedrock-live-gate.sh` | PASS — live Converse ~1026ms, in=10 out=6 |
| `deploy-ec2.sh` | Success |
| `ai-gate.sh` | PASS — 78 tests + spike eval |
| `fixture-loopback-gate.sh` | PASS |

### RCA — TypeScript build fail on `additionalModelRequestFields`

**Symptom:** `Type '{ responseFormat: { json: { schema: ... } } }' is not assignable to type 'DocumentType | undefined'`

**Fix:** Cast on assign — SDK `DocumentType` is too strict for JSON schema objects:

```typescript
commandInput.additionalModelRequestFields = {
  responseFormat: { json: { schema: input.responseSchema } },
} as ConverseCommandInput['additionalModelRequestFields'];
```

### RCA — `env.test.ts` unexpected EOF

**Symptom:** vitest `ERROR: Unexpected end of file` in `tests/env.test.ts`

**Fix:** Missing `});` after new `it()` block for `BEDROCK_REGION` default test. Structural edit error from inserting test mid-file.

### RCA — `AccessDeniedException` on first live gate

**Symptom:** `bedrock-live-gate.sh` fails immediately after IAM policy attach

**Fix:** Wait 2–5 min for IAM propagation, or retry. Verify account-level Nova Lite access in Bedrock console and that policy ARN matches `us-east-1` foundation model (not `af-south-1`).

### Before / after — workflow adapter selection

```typescript
// Before (hardcoded fake)
import { createFakeModelAdapter } from '../bedrock/fake.js';
const adapter = createFakeModelAdapter();

// After (env-driven)
import { createModelAdapter } from '../bedrock/factory.js';
const adapter = createModelAdapter();
```

## Prevention

- Always run `bedrock-adapter-contract.test.ts` with mocked SDK before EC2 live gate
- Keep `ai-gate.sh` spike eval on fake adapter — comment in script points to `bedrock-live-gate.sh` for live proof
- PM2 deploy tests (`deploy-config.test.ts`) assert `ai-worker` has `AI_ENABLED`, `BEDROCK_REGION`, and no SMTP/POP3 env keys
- Document IAM inline in `aws-resources.md` only — skip separate `bedrock-iam-policy.json` reference file (ponytail delete)
- After IAM changes, retry live gate once before escalating — propagation delay is normal

## Related

- [Live AI mail pipeline with Mastra workflows, ai-worker writes, and opt-in gates](../architecture-patterns/live-ai-mail-pipeline-mastra-worker-gates.md) — full Mailpit → triage → gated writes → candidate draft → browser proof (builds on this adapter layer)
- [EC2 AI contract tests fail RDS gate on FK and mailbox setup](../test-failures/ec2-ai-contract-tests-rds-gate-fk-setup.md) — parallel ai-gate RDS failures fixed before Bedrock wiring
- Runbook: `docs/server-pilot-ai.md` (env table, adapter selection, SSM commands)
- IAM provisioning: `apps/server-pilot/deploy/aws-resources.md`
- Overnight handoff: `docs/superpowers/plans/handoff-reports/2026-07-07-wire-bedrock-adapter-report.md`
- Plan: `docs/plans/2026-07-07-004-feat-wire-gate-bedrock-real-adapter-plan.md`
- Mail transport factory precedent: `docs/solutions/architecture-patterns/mail-transport-mode-fixture-vs-real.md`
- EC2 deploy gotchas: `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`
