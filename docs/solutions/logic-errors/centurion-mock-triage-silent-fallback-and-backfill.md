---
title: Centurion mock triage silent fallback in production and natural Bedrock backfill
date: 2026-09-07
category: logic-errors
module: server-pilot / AI triage / Bedrock adapter factory
problem_type: logic_error
component: email_processing
symptoms:
  - "Historical threads on RDS had canned mock rationales like 'Guest booking inquiry' or 'Group quote language' with latencyMs: 15."
  - "Bookings folder was artificially inflated to over 1,000 threads while other core operational folders (money-billing, manage-stay, exceptions-recovery) were starved."
  - "Retag scripts (retag-centurion-refine.mjs) re-evaluated deterministic heuristics on existing rawOutput without querying Bedrock, cementing mock triage tags."
  - "Nova Lite dialect mismatches (e.g. humanAction: 'read', automationState: 'candidate', unknown overlay tags) caused dead-letter triage workflow errors."
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - database
  - background_job
  - tooling
  - testing_framework
tags:
  - centurion
  - bedrock
  - nova-lite
  - mock-fallback
  - triage-backfill
  - fail-closed
  - rds
---

# Centurion Mock Triage Silent Fallback in Production and Natural Bedrock Backfill

## Problem

Across the RDS database (`transport-centurion` on `nava-zero-mail-pilot`), 2,219 inbound email threads (67.0% of all inbound threads) were classified not by Amazon Bedrock Nova Lite, but by `FakeModelAdapter` from `fake.ts`. These threads contained synthetic canned rationales (`Guest booking inquiry`: 1,541, `Group quote language`: 559, `Internal ops handover`: 111, `Spam offer`: 8) and a constant `latencyMs: 15`. Additionally, 262 threads had dead-lettered or had null rationales due to empty bodies or workflow timeouts.

Consequently, the inbox categorization was severely skewed: `bookings` was inflated to over 1,000 threads, while operational workflows (`money-billing`, `manage-stay`, `guest-experience`, `exceptions-recovery`, `automated-channel`) were depleted.

## Symptoms

1. `ai_workflow_run` metrics contained `latencyMs: 15` and static string rationales identical to `fake.ts`.
2. Offline backfill and retag scripts (`retag-centurion-refine.mjs`) only recalculated regex rules against existing `rawOutput`, so threads that originally ran through mock triage remained permanently miscategorized in `bookings` and `groups-events`.
3. Some threads dead-lettered with `mail triage workflow failed` when Bedrock returned dialect values such as `humanAction: 'read'` or unmapped overlay tags.

## Root Cause

1. **Silent Production Fallback:** In `apps/server-pilot/src/ai/bedrock/factory.ts`:
   ```ts
   if (!env.AI_ENABLED) {
     return createFakeModelAdapter();
   }
   ```
   When `AI_ENABLED` was missing or not explicitly `'true'`, the factory silently returned `FakeModelAdapter` without throwing or warning, even when `NODE_ENV === 'production'`.
2. **Missing Environment Variables:** On the EC2 host, `/home/ubuntu/repos/zero/apps/server-pilot/.env.production` lacked `AI_ENABLED='true'`, `BEDROCK_REGION='us-east-1'`, and `AI_MODEL_ID='amazon.nova-lite-v1:0'`. While PM2's daemon (`deploy/pm2.config.cjs`) explicitly passed `AI_ENABLED='true'` to live inbound workers, any one-off script or CLI tool sourcing `.env.production` fell back to `FakeModelAdapter`.
3. **Dialect Schema Rejections:** Bedrock Nova Lite frequently emitted variations such as `humanAction: 'read'` (not in `NOVA_HUMAN_ACTION_ALIASES`) and non-standard overlays, which caused Zod schema validation errors.

## Solution

1. **Fail-Closed Bedrock Factory:**
   Updated `apps/server-pilot/src/ai/bedrock/factory.ts` so that in production, missing or disabled `AI_ENABLED` throws immediately instead of silently returning mock data:
   ```ts
   if (!env.AI_ENABLED) {
     if (env.NODE_ENV === 'production') {
       throw new Error('AI_ENABLED is false or missing in production: refusing silent FakeModelAdapter fallback');
     }
     return createFakeModelAdapter();
   }
   ```
2. **Dialect Normalization Resilience:**
   In `apps/server-pilot/src/ai/workflows/mail-triage.ts`:
   - Added `'read': 'review_required'` to `NOVA_HUMAN_ACTION_ALIASES`.
   - Added safe fallbacks for unrecognized `humanAction` (`review_required`), `sourceScope` (`external`), and `automationState` (`unknown`).
   - Updated `normalizeNovaOverlays` to safely ignore unrecognized overlay tags instead of throwing.
3. **Configuration Hardening:**
   Appended `AI_ENABLED='true'`, `BEDROCK_REGION='us-east-1'`, and `AI_MODEL_ID='amazon.nova-lite-v1:0'` directly to `.env.production` on EC2.
4. **Natural Bedrock Backfill:**
   Created and ran `scripts/backfill-centurion-mock-threads-bedrock.mjs` on EC2:
   - Queried all mock and null rationale runs.
   - Invoked real Amazon Bedrock Nova Lite (`amazon.nova-lite-v1:0`) with concurrency 4 and jittered exponential backoff.
   - Updated both `ai_workflow_run` (storing real token counts, actual latencies ~1.5s, dynamic rationales) and `mail_thread_category` (assigning threads to their true operational folders).

## Evidence

Post-backfill RDS audit (`node scripts/audit-all-mock-runs.mjs`):
- `total_with_runs`: **3,312**
- `mock_runs_count`: **0** (was 2,219)
- `real_bedrock_count`: **3,312 (100% of all inbound threads)**
- `null_rationale_count`: **0** (was 262)
- Threads without runs: **813** (all outbound-only threads with 0 inbound messages)

Realistic operational folder distribution:
- `automated-channel`: 284
- `bookings`: 92 (normalized down from >1,000)
- `manage-stay`: 62
- `urgent`: 61
- `money-billing`: 56
- `documents-delivery`: 36
- `internal-partner`: 33
- `exceptions-recovery`: 30
- `groups-events`: 28
- `guest-experience`: 26
- `confirm-reconcile`: 19
- `spam`: 612

Contract tests:
- `tests/bedrock-adapter-contract.test.ts`: 13/13 unit tests passing.

## Prevention

1. **Never Fall Back Silently to Mocks in Production:** Always fail closed if AI credentials or feature flags are absent in production environments.
2. **Audit Raw Output vs Canned Strings:** Any triage audit must check for canned test strings and constant latency footprints (`latencyMs = 15`).
3. **Resilient Normalization for LLM Dialects:** LLM outputs must be normalized with fallback mappings for unrecognized enum variants before hitting strict Zod validation.
