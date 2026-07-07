# Wire Gate + Real Bedrock Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real Bedrock adapter on EC2 ai-worker; wire gate + bedrock-live gate green on prod RDS.

**Architecture:** `createModelAdapter()` returns fake in test, Bedrock in production ai-worker. Separate on-demand gates; daily ai-gate stays fake spike.

**Tech Stack:** TypeScript, `@aws-sdk/client-bedrock-runtime`, Vitest, EC2 SSM, IAM inline policy.

## Global Constraints

- `amazon.nova-lite-v1:0` in `BEDROCK_REGION=us-east-1`
- No Langfuse, LangSmith, hosted Mastra, autonomous send
- `ai-gate.sh` spike eval stays on fake adapter
- Commit after each green task

---

### Task 1: BedrockModelAdapter

**Files:**
- Create: `apps/server-pilot/src/ai/bedrock/bedrock.ts`
- Modify: `apps/server-pilot/tests/bedrock-adapter-contract.test.ts`

**Interfaces:**
- Produces: `BedrockModelAdapter`, `createBedrockModelAdapter(config)`
- Consumes: `ModelAdapter`, `validateStructuredJsonOutput`

- [ ] **Step 1: Write failing mocked SDK tests** (parse JSON, AccessDenied, fence strip)
- [ ] **Step 2: Implement `bedrock.ts`** with Converse, throttle retry once
- [ ] **Step 3: Run** `pnpm --filter @zero/server test tests/bedrock-adapter-contract.test.ts`
- [ ] **Step 4: Commit** `feat: add BedrockModelAdapter with Converse`

---

### Task 2: Factory + BEDROCK_REGION env

**Files:**
- Create: `apps/server-pilot/src/ai/bedrock/factory.ts`
- Modify: `apps/server-pilot/src/env.ts`
- Modify: `apps/server-pilot/tests/env.test.ts`
- Modify: `apps/server-pilot/deploy/pm2.config.cjs`
- Modify: `apps/server-pilot/tests/deploy-config.test.ts`

- [ ] **Step 1: Write failing factory/env tests**
- [ ] **Step 2: Implement `resolveModelAdapter` + `createModelAdapter`**
- [ ] **Step 3: Add `BEDROCK_REGION` default `us-east-1` when AI enabled**
- [ ] **Step 4: PM2 ai-worker env `BEDROCK_REGION=us-east-1`**
- [ ] **Step 5: Run** env + deploy-config + bedrock contract tests
- [ ] **Step 6: Commit** `feat: model adapter factory and BEDROCK_REGION`

---

### Task 3: Wire factory into triage workflow

**Files:**
- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`

- [ ] **Step 1: Replace `createFakeModelAdapter()` with `createModelAdapter()`**
- [ ] **Step 2: Run** `pnpm --filter @zero/server test tests/ai-worker-contract.test.ts tests/ai-triage-contract.test.ts`
- [ ] **Step 3: Commit** `feat: triage workflow uses model adapter factory`

---

### Task 4: Bedrock live gate

**Files:**
- Create: `apps/server-pilot/deploy/bedrock-live-gate.sh`
- Create: `apps/server-pilot/tests/bedrock-live-contract.test.ts`
- Modify: `apps/server-pilot/deploy/ai-gate.sh` (comment cross-ref)

- [ ] **Step 1: Opt-in live test** (`BEDROCK_LIVE_TEST=1`)
- [ ] **Step 2: Gate script** mirroring wire-gate.sh
- [ ] **Step 3: Commit** `feat: bedrock-live-gate for EC2 instance role`

---

### Task 5: IAM + docs

**Files:**
- Modify: `apps/server-pilot/deploy/aws-resources.md`
- Modify: `docs/server-pilot-ai.md`

- [ ] **Step 1: Document + apply `NavaZeroBedrockInvoke`**
- [ ] **Step 2: Run** `aws iam put-role-policy` for worker role
- [ ] **Step 3: Commit** `docs: Bedrock IAM and gate runbook`

---

### Task 6: EC2 gates

- [ ] **Step 1:** `sync-ec2-git-bundle.sh`
- [ ] **Step 2:** SSM migrate + `deploy-ec2.sh`
- [ ] **Step 3:** SSM `wire-gate.sh` → fix RCA if red
- [ ] **Step 4:** SSM `bedrock-live-gate.sh` → fix RCA if red
- [ ] **Step 5:** SSM `ai-gate.sh`
- [ ] **Step 6: Handoff report** `docs/superpowers/plans/handoff-reports/2026-07-07-wire-bedrock-adapter-report.md`

## Execution Handoff

Plan complete. Use **Subagent-Driven** — one subagent per task, review between tasks.
