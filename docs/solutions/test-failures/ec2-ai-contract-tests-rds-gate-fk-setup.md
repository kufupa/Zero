---
title: EC2 AI contract tests fail RDS gate on FK and mailbox setup
date: 2026-07-07
last_updated: 2026-07-08
category: test-failures
module: server-pilot
problem_type: test_failure
component: testing_framework
severity: high
symptoms:
  - EC2 ai-gate.sh RDS contract tests fail with FK violations inserting mail_draft and ai_draft_generation without parent rows
  - "ReferenceError: db used before getDb() initialization in AI contract tests"
  - MailboxForbiddenError when SMTP failure enqueue test used random transport without mailboxAccess
  - Worker persisted candidate drafts with createdByUserId ai-worker causing silent FK failure on RDS
root_cause: incomplete_setup
resolution_type: test_fix
tags:
  - ec2-pilot
  - rds-gate
  - ai-contract-tests
  - foreign-key
  - server-pilot
  - mailbox-access
  - ai-worker
related_components:
  - background_job
  - database
  - email_processing
---

# EC2 AI contract tests fail RDS gate on FK and mailbox setup

## Problem

After landing the server-pilot AI mail pipeline, EC2 `ai-gate.sh` failed on RDS-backed contract tests while local vitest reported green. The failures spanned incomplete test seed data, JavaScript init-order bugs, missing mailbox authorization in one send-path test, and a production worker bug that hardcoded a nonexistent user id — causing FK violations that the retry path swallowed instead of surfacing.

## Symptoms

| Test file | Failure mode on RDS |
|-----------|---------------------|
| `ai-enqueue-contract.test.ts` | Postgres FK violation inserting `mail_draft` (missing `ai_draft_generation` parent); SMTP failure case threw `MailboxForbidden` |
| `ai-worker-contract.test.ts` | `ReferenceError` or FK error — `db` used before `getDb()`; retry test: `expect(drafts).toHaveLength(1)` failed with `[]` |
| `ai-workflow-run-contract.test.ts` | FK violation on `ai_draft_generation` insert; `db` used before initialization |

Locally, tests without `DATABASE_URL` are skipped (`describe.skipIf(!TEST_DB_AVAILABLE || !reachable)`), so these bugs only appeared on EC2 `ai-gate.sh`. After the Bedrock adapter landed (`2533cc0e`), the gate runs 78 targeted tests (including mocked `bedrock-adapter-contract.test.ts` — still `FakeModelAdapter` because `NODE_ENV=test`) plus spike eval. Live Bedrock is a separate on-demand `bedrock-live-gate.sh`, not part of `ai-gate.sh`.

## What Didn't Work

**Round 1 only (commit `2d45e732`, session history):** Seeding `ai_draft_generation` before `mail_draft` fixed some FK errors but left three failures:

1. **Init order bug** — `ai-worker-contract.test.ts` and `ai-workflow-run-contract.test.ts` called `db.insert(...)` before `const db = getDb()`.
2. **Authorization mismatch** — SMTP failure test created a random transport + `user-1` caller without `mailboxAccess`; tRPC returned `MailboxForbidden` instead of exercising the SMTP failure path.
3. **Production user FK** — `executeAiRun` passed `createdByUserId: 'ai-worker'` to `persistAiCandidateDraft`. No such user exists in RDS seed data. Insert failed, the catch block called `markAiRunRetry`, and the test observed zero drafts with no obvious FK message.

## Solution

### 1. Seed FK parents before child inserts (commit `2d45e732`)

Added `seedCenturionThread` and `aiDraftGeneration` inserts before `mail_draft` in all three contract tests.

**Before (`ai-enqueue-contract.test.ts`):**

```typescript
await db.insert(mailDraft).values({
  id: draftId,
  transportId,
  threadId,
  createdByUserId: 'user-centurion-worker',
  generationId,
  replyToMessageId: inboundId,
  // ...
});
```

**After:**

```typescript
await seedCenturionThread(db);
await db.insert(aiDraftGeneration).values({
  id: generationId,
  transportId,
  threadId,
  requestedByUserId: 'user-centurion-worker',
  contextMessageIds: [inboundId],
  model: 'amazon.nova-lite-v1:0',
  promptVersion: 'draft-v1',
});
await db.insert(mailDraft).values({
  id: draftId,
  transportId,
  threadId,
  createdByUserId: 'user-centurion-worker',
  generationId,
  replyToMessageId: inboundId,
  // ...
});
```

Same pattern in `ai-worker-contract.test.ts` and `ai-workflow-run-contract.test.ts` (real `generationId` UUID instead of hardcoded `'gen-789'`).

### 2. Move `getDb()` before any `db.insert` (commit `941c243b`)

**Before (`ai-worker-contract.test.ts`):**

```typescript
const run = await enqueueAiRun({ /* ... */ });
await db.insert(aiDraftGeneration).values({ /* ... */ });  // db not defined yet
await markAiRunRetry({ /* ... */ });
const db = getDb();
```

**After:**

```typescript
const db = getDb();
const run = await enqueueAiRun({ /* ... */ });
await db.insert(aiDraftGeneration).values({ /* ... */ });
await markAiRunRetry({ /* ... */ });
```

### 3. Centurion mailbox for SMTP failure test (commit `941c243b`)

**Before:** Random `transportId` / `threadId` from `randomUUID()`, inline transport/user/thread/message seeding, `callerFor('user-1', { requestedTransportId: transportId })`.

**After:**

```typescript
const transportId = 'transport-centurion';
const threadId = 'thread-centurion-1';
const inboundId = 'msg-centurion-inbound-1';

await seedCenturionThread(db);
await db.insert(aiDraftGeneration).values({
  id: generationId,
  transportId,
  threadId,
  requestedByUserId: 'user-centurion-worker',
  contextMessageIds: [inboundId],
  model: 'amazon.nova-lite-v1:0',
  promptVersion: 'draft-v1',
});
// mail_draft with createdByUserId: 'user-centurion-worker'

const caller = await callerFor('user-centurion-worker', { db });
```

`user-centurion-worker` has `mailboxAccess` for `transport-centurion` in pilot seed data.

### 4. Resolve draft author from generation row (commit `10fed90d`)

**Before (`apps/server-pilot/src/ai/worker.ts`):**

```typescript
const draft = await persistAiCandidateDraft({
  db,
  createdByUserId: 'ai-worker',
  generationId,
  // ...
});
```

**After:**

```typescript
const [existingGeneration] = await db
  .select({ requestedByUserId: aiDraftGeneration.requestedByUserId })
  .from(aiDraftGeneration)
  .where(eq(aiDraftGeneration.id, generationId))
  .limit(1);
const createdByUserId = existingGeneration?.requestedByUserId ?? 'user-centurion-worker';

const draft = await persistAiCandidateDraft({
  db,
  createdByUserId,
  generationId,
  // ...
});
```

## Why This Works

Postgres enforces FK chains in the mail schema:

- `mail_draft.generation_id` → `ai_draft_generation.id`
- `mail_draft.created_by_user_id` → `user.id`
- `ai_draft_generation.thread_id` → `mail_thread.id`
- `ai_draft_generation.transport_id` → `mailbox_transport.id`

Tests must seed the full ancestor chain in dependency order. Moving `getDb()` first ensures the Drizzle client exists before any direct SQL.

Send-path tRPC checks `mailboxAccess` per transport. Random transports bypass the pilot seed graph and fail authorization before SMTP is invoked.

The generation row already records `requested_by_user_id` (the human who triggered AI). Reading it satisfies the user FK and preserves audit semantics.

The silent-failure mechanism: `executeAiRun` wraps the body in `try/catch`. Any insert error (including FK violation) becomes `markAiRunRetry` with `state: 'retry_wait'`. The retry idempotency test calls `executeAiRun` twice and asserts exactly one draft — with the bad user id, both runs failed into retry and left `drafts` empty, masking the root cause.

## Prevention

1. **Run RDS gate before declaring AI pipeline done.** Local vitest without `DATABASE_URL` skips RDS-only cases; only EC2 `ai-gate.sh` exercises the full FK surface against prod Postgres. After Bedrock wiring, gate count is 78 targeted tests + spike eval — live Converse is `bedrock-live-gate.sh` only.

2. **Centralize AI draft fixture seeding.** Use `seedCenturionThread` + `aiDraftGeneration` (+ optional `mail_draft`) in a shared helper so new contract tests cannot omit parents.

3. **Declare `getDb()` first.** In contract tests using `getDb()` directly (no `withTestDb` rollback), put `const db = getDb()` as the first line inside each `it` block that touches the database.

4. **Never hardcode synthetic user ids in production paths.** `createdByUserId` must come from authenticated context or the `ai_draft_generation` row.

5. **Log FK errors in worker catch during test runs.** Consider failing fast when `NODE_ENV=test` so contract tests do not misread retry-as-success.

6. **FK dependency order for AI fixtures:** `mailbox_transport` → `mail_thread` → `message` → `ai_draft_generation` → `mail_draft` / `mail_draft_revision`, with `user` required on draft `created_by_user_id`.

## Related Issues

- [Bedrock real adapter with fake/real factory and EC2 live gate](../integration-issues/bedrock-adapter-factory-and-ec2-live-gate.md) — adapter factory + two-tier gates (ai-gate fake vs bedrock-live-gate)
- [EC2 Pilot Autonomous Deploy and SSM Gotchas](../workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — SSM + `NODE_ENV=test` pattern for RDS gates
- [EC2 inbox listThreads tests fail after thread-only fixtures](inbox-listing-test-fixture-drift.md) — parallel pattern: incomplete RDS seed data
- [EC2 pilot post-audit Tier 5 execution](../workflow-issues/ec2-pilot-post-audit-tier5-execution.md) — mailbox_access test drift in same gate family
- [Server Pilot AI Mail Pipeline handoff report](../../superpowers/plans/handoff-reports/2026-07-07-ai-mail-pipeline-report.md) — full session RCA and gate results
- Runbook: `docs/server-pilot-ai.md`
