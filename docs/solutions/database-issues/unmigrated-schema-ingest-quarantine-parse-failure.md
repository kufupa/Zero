---
title: Unapplied RDS Migrations Diverted Inbound Mail to Ingest Quarantine as Parse Failure
date: 2026-09-17
category: database-issues
module: apps/server-pilot mail ingest / database migration / EC2 pilot ops
problem_type: database_issue
component: database
severity: critical
symptoms:
  - "401 inbound emails missing from pilot inbox over ~36 hours since Sep 15 20:04 UTC"
  - "Incoming emails silently diverted to mail_ingest_quarantine under reason 'parse_failure' and deleted from POP3"
  - "Postgres 42703 error column read_request does not exist thrown during persistInboundMessage transaction"
  - "PM2 worker reported online with 0 restarts while PM2 ai-worker entered errored state after 9 restart crashes"
  - "Drizzle schema model drifted ahead of RDS Postgres table columns due to feature branch deploy without migrations"
root_cause: incomplete_setup
resolution_type: migration
related_components:
  - email_processing
  - development_workflow
  - tooling
tags:
  - database-migration
  - rds
  - server-pilot
  - mail-ingest
  - mail-quarantine
  - schema-drift
  - ai-workflow-run
  - ec2-pilot
---

# Unapplied RDS Migrations Diverted Inbound Mail to Ingest Quarantine as Parse Failure

## Problem

Between September 15, 2026 20:04 UTC and September 17, 2026 14:00 UTC (~36 hours), 401 incoming emails to the Centurion mail pilot (`navaai@legacyhotels.co.za`) vanished from operator inboxes without triggering deployment health check failures. The emails were successfully fetched from the POP3 sink and saved to S3, but database persistence failed when an unapplied Drizzle schema addition (`read_request` on `ai_workflow_run` introduced in feature branch `feat/centurion-dashboard-tools`) triggered Postgres error `42703: column "read_request" of relation "ai_workflow_run" does not exist` during triage enqueue, rolling back the message transaction and causing the worker to misclassify the failure as poison MIME, quarantine the record, and issue `DELE` to the upstream POP3 server.

**Invariant at risk:** Inbound mail ingest must fail closed and maintain transactional persistence guarantees: an email must never be deleted from the upstream transport sink (`POP3 DELE`) unless its message headers, body, and thread associations are durably committed in Postgres, or the payload is genuinely corrupted RFC MIME poison. Downstream AI triage workflow enqueue failures must never abort primary email receipt, and deployment automation must verify database schema parity before activating worker processes.

## Symptoms

- **401 Missing Inbound Emails:** Over a ~36-hour period starting at 2026-09-15T20:04:12Z, 401 legitimate customer and reservation emails sent to `navaai@legacyhotels.co.za` were never inserted into the `message` or `mail_thread` tables and failed to appear in the mail SPA inbox.
- **Silent Quarantine Divergence:** All 401 emails were inserted into `mail_ingest_quarantine` with `reason = 'parse_failure'`, where `parsed_headers.error` captured:
  ```
  error: column "read_request" of relation "ai_workflow_run" does not exist (code: 42703)
  ```
- **Deceptively Healthy PM2 Status:** In PM2, `worker` displayed status `online` with 0 restarts. The ingest loop caught the database error, incremented the per-UIDL failure count until reaching `POISON_MAX_RETRIES`, quarantined the email, and issued `await pop3.dele(uidl)`, reporting `{ status: 'ok' }` in its batch summary.
- **Crash Looping `ai-worker`:** The PM2 `ai-worker` process failed immediately on startup because Drizzle's default `select()` across `ai_workflow_run` included `read_request`. It crashed on boot, cycled through 9 restart attempts, and entered `errored` status.
- **Intact S3 MIME Archive:** In S3, all 401 raw RFC 822 payloads were preserved under `raw-mime/ingest-nava-legacy/*.eml` because `worker.ts` uploaded the raw MIME to object storage prior to executing the database transaction.

## What Didn't Work

- **Suspecting Upstream POP3 / Zimbra Forwarding Failures:** Because operator inboxes were completely quiet, initial suspicion centered on Zimbra mail routing, SPF/DKIM filtering, or a stalled POP3 service. However, Zimbra access logs confirmed continuous active POP3 authentication sessions from the EC2 instance, and POP3 `STAT` returned 0 messages because the worker had successfully polled and deleted every message.
- **Relying on PM2 `online` Status and HTTP Health Checks:** The deployment script (`apps/server-pilot/deploy/deploy-ec2.sh`) ran health checks against `http://127.0.0.1:8788/health` and `:8789/health`. These HTTP probes only evaluated the Express API server (`http`), which had no database queries on startup. The `worker` process also stayed `online` because it caught the error internally rather than throwing an uncaught exception.
- **Interpreting `parse_failure` as Corrupt Email Encodings:** In normal operations, `parse_failure` in `mail_ingest_quarantine` signifies unparseable multipart boundaries, non-RFC 822 byte streams, or malformed email headers in `parseRawMessage()`. Inspecting the quarantined records showed standard RFC-compliant reservation emails with valid senders, subjects, and MIME structures; the parse had succeeded, and the failure occurred exclusively during relational persistence.
- **Assuming Drizzle ORM Compile-Time Safety Guarantees DB Schema Parity:** TypeScript compilation (`pnpm --filter @zero/server build`) succeeded without error during deploy. TypeScript validated only that application code matched the TypeScript schema in `apps/server-pilot/src/db/schema/mail.ts`. It had no runtime validation of whether the RDS database actually had the corresponding columns.
- **Re-running Quarantine Promotion Without Fixing Schema/Branch:** Attempting to execute `pnpm --filter @zero/server exec tsx scripts/promote-quarantine.ts` while running the feature branch code would have simply re-executed `persistInboundMessage` with the mismatched schema, failing with the exact same 42703 error and re-quarantining the messages.

## Solution

Resolution required a three-part fix: aligning the deployed EC2 code to the authoritative `main` branch, restarting the crashed background workers, and safely rehydrating the 401 quarantined emails from S3 into production PostgreSQL.

### 1. Root Cause: Feature Branch Deployment & Migration Collision

The EC2 instance was deployed from the experimental feature branch `feat/centurion-dashboard-tools` (commit `d9565ab23da`) rather than `main`.

In `feat/centurion-dashboard-tools` (commit `4c39c2c0619`), new columns were introduced to `aiWorkflowRun` in `apps/server-pilot/src/db/schema/mail.ts`:
```typescript
// apps/server-pilot/src/db/schema/mail.ts
export const aiWorkflowRun = pgTable('ai_workflow_run', {
  id: text('id').primaryKey(),
  transportId: text('transport_id').notNull().references(() => mailboxTransport.id),
  threadId: text('thread_id').notNull().references(() => mailThread.id, { onDelete: 'cascade' }),
  triggerMessageId: text('trigger_message_id').notNull().references(() => message.id, { onDelete: 'cascade' }),
  runKind: aiWorkflowRunKindEnum('run_kind').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  modelId: text('model_id').notNull(),
  promptVersion: text('prompt_version').notNull(),
  promptHash: text('prompt_hash'),
  /** Closed typed read request; private server-side input, never model text. */
  readRequest: jsonb('read_request').$type<Record<string, unknown>>(),
  /** Durable typed receipt reference for read_tool runs. */
  readResultRef: text('read_result_ref'),
  readResult: jsonb('read_result').$type<Record<string, unknown>>(),
  readResultExpiresAt: timestamp('read_result_expires_at'),
  state: aiWorkflowRunStateEnum('state').notNull().default('queued'),
  // ...
});
```

The feature branch generated migration file `0023_read_tool_runs.sql`. However:
1. `deploy-ec2.sh` did not execute migrations as part of its automated deployment sequence.
2. In production RDS, migration `0023` had already been claimed by `main` as `0023_message_reaction.sql`.
3. The production PostgreSQL table `ai_workflow_run` lacked the `read_request`, `read_result_ref`, `read_result`, and `read_result_expires_at` columns.

### 2. Failure Mechanism in Ingest Pipeline

In `apps/server-pilot/src/mail/ingest/store.ts`, incoming messages are persisted inside a single atomic database transaction:

```typescript
// apps/server-pilot/src/mail/ingest/store.ts
await db.transaction(async (tx) => {
  // 1. Insert message row
  await tx.insert(message).values(...);
  // 2. Insert or update mail_thread row
  await tx.insert(mailThread).values(...);
  // 3. Attach participants, categories, search vectors
  // ...
  // 4. Enqueue AI triage workflow run
  if (!isHotelSent && !opts.skipAiEnqueue) {
    await enqueueAiRun(
      {
        transportId: transport.id,
        threadId,
        triggerMessageId: messageId,
        runKind: 'inbound_triage',
        idempotencyKey: `inbound-triage:${messageId}`,
        modelId: DEFAULT_AI_MODEL_ID,
        promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
      },
      tx as unknown as DB,
    );
  }
});
```

Because `aiWorkflowRun` included `readRequest` in its Drizzle schema, Drizzle included `read_request` in its generated SQL query / `RETURNING` projection. PostgreSQL immediately rejected the statement:
```
PostgresError: column "read_request" of relation "ai_workflow_run" does not exist
  code: '42703'
```
PostgreSQL aborted the transaction and rolled back all preceding operations: the message, thread, and participant inserts were undone.

The error was rethrown to `apps/server-pilot/src/mail/ingest/worker.ts`:
```typescript
// apps/server-pilot/src/mail/ingest/worker.ts
} catch (err) {
  // ...
  const prev = failureCounts.get(uidl) ?? 0;
  const next = prev + 1;
  failureCounts.set(uidl, next);

  if (next >= POISON_MAX_RETRIES && rawKey) {
    const error = err instanceof Error ? err.message : String(err);
    const result = await quarantineParseFailure(
      { ingestMailboxId, pop3Uidl: uidl },
      rawKey,
      { db },
      error,
    );
    // ...
    await archiveQuarantineRawMime(storage, rawKey, { ingestMailboxId, pop3Uidl: uidl });
    failureCounts.delete(uidl);
    await renewClaim();
    await pop3.dele(uidl); // <--- DELETED FROM UPSTREAM SINK
    retainClaimForQuit();
    scheduledDeletions += 1;
    items.push({ uidl, result, status: 'ok' });
    processed += 1;
    continue;
  }
}
```
The worker classified the relational error as a parse failure, wrote a record to `mail_ingest_quarantine`, copied the S3 MIME object to quarantine prefix, deleted the email from POP3 with `pop3.dele(uidl)`, and continued running without error.

### 3. Remediation Procedure

#### Step A: Align EC2 Deployment to Main
Deploy the authoritative `main` branch to EC2, which matches the production RDS schema:
```bash
# On EC2 instance /home/ubuntu/repos/zero
git fetch origin
git checkout main
git reset --hard origin/main

# Rebuild server and client packages
pnpm install --frozen-lockfile
pnpm --filter @zero/server build
pnpm --filter @zero/mail build

# Restart PM2 processes with updated environment
pm2 restart http worker ai-worker --update-env
pm2 status
```
Verify that `ai-worker` stays `online` with 0 restarts:
```bash
pm2 logs ai-worker --lines 50 --nostream
```

#### Step B: Promote and Reprocess 401 Quarantined Messages
The raw MIME for all 401 quarantined messages remains intact in S3. Use a targeted quarantine promotion script or ops runner to re-parse and store the emails:
```bash
# Execute promotion for parse_failure rows against production RDS
pnpm --filter @zero/server exec tsx scripts/promote-quarantine.ts
```

#### Step C: Database Verification
Confirm in PostgreSQL that messages have populated the mail tables and AI workflow runs are queued:
```sql
-- Confirm quarantine count has cleared or returned to baseline
SELECT count(*) FROM mail_ingest_quarantine WHERE reason = 'parse_failure';

-- Confirm messages inserted for the incident window
SELECT count(*) FROM message WHERE received_at >= '2026-09-15 20:00:00+00';

-- Confirm AI workflow runs are queued or running
SELECT state, count(*) FROM ai_workflow_run GROUP BY state;
```

## Why This Works

1. **Schema Alignment:** Reverting the EC2 code to `main` aligns Drizzle's in-memory schema definitions with the actual PostgreSQL schema on RDS. When `enqueueAiRun` executes, it only generates column references that exist on the physical table (`0008_ai_workflow_run.sql`), eliminating error `42703`.
2. **Transaction Integrity:** With valid column mappings, `db.transaction()` successfully commits the message, thread, and AI workflow run rows together.
3. **S3 Durability Backstop:** Because the ingest pipeline writes raw RFC 822 bytes to S3 (`storage.putObject({ key: currentRawKey, body: msg.raw })`) *before* opening the database transaction, database aborts do not destroy email content. The raw payloads in S3 can be idempotently reprocessed through `promote-quarantine.ts` or `rehydrate-raw-mime.ts`.
4. **Worker Recovery:** Once the database transaction succeeds, `worker.ts` receives `{ kind: 'stored' }` or `{ kind: 'duplicate' }`, issues `pop3.dele(uidl)` legitimately, and increments normal message counters.

## Prevention

To prevent recurrence of silent email drops and schema mismatch outages, the following safeguards must be enforced:

### 1. Pre-Deployment Schema Parity Gate in `deploy-ec2.sh`
Add an automated pre-flight gate in `apps/server-pilot/deploy/deploy-ec2.sh` that checks database schema parity and forbids non-main branch deployments on production:
```bash
# apps/server-pilot/deploy/deploy-ec2.sh

# 1. Enforce main branch unless explicitly overridden
CURRENT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ] && [ "${ALLOW_FEATURE_BRANCH_DEPLOY:-0}" != "1" ]; then
  echo "ERROR: Attempted to deploy non-main branch '$CURRENT_BRANCH' to production EC2." >&2
  echo "Switch to 'main' or set ALLOW_FEATURE_BRANCH_DEPLOY=1 with verified migrations." >&2
  exit 1
fi

# 2. Check pending Drizzle migrations against RDS
echo "== verify database migration parity =="
pnpm --filter @zero/server exec tsx scripts/check-migration-parity.ts || {
  echo "ERROR: RDS schema drift detected! Code contains migrations not applied to RDS." >&2
  exit 1
}
```

### 2. Transactional Decoupling of Ingest vs Workflow Enqueue
In `apps/server-pilot/src/mail/ingest/store.ts`, decouple primary email receipt from secondary AI workflow triggering. A failure in the AI scheduling pipeline must never roll back message persistence:
```typescript
// Recommended refactor in apps/server-pilot/src/mail/ingest/store.ts
// 1. Transaction 1: Persist core message data
await db.transaction(async (tx) => {
  await tx.insert(message).values(...);
  await tx.insert(mailThread).values(...);
  await applyThreadLabels(tx, threadId, labels);
  await refreshThreadSearchVector(tx, threadId);
});

// 2. Step 2: Enqueue AI workflow OUTSIDE the critical message persistence transaction
if (!isHotelSent && !opts.skipAiEnqueue) {
  try {
    await enqueueAiRun({
      transportId: transport.id,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `inbound-triage:${messageId}`,
      modelId: DEFAULT_AI_MODEL_ID,
      promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
    }, db);
  } catch (aiEnqueueError) {
    console.error(`Failed to enqueue AI triage for message ${messageId}:`, aiEnqueueError);
    // Message remains stored; AI triage can be caught up via background sweep
  }
}
```

### 3. Fail-Closed POP3 Error Classification
In `apps/server-pilot/src/mail/ingest/worker.ts`, explicitly distinguish between unrecoverable MIME parse poison and operational infrastructure failures:
- **Parse Poison:** Thrown directly by `parseRawMessage()` (e.g. malformed RFC headers, invalid MIME boundary structures). Only these should be eligible for `quarantineParseFailure` and `pop3.dele`.
- **Infrastructure / Database Errors:** `PostgresError`, database connection timeouts, S3 write failures, or constraint violations. Under no circumstances should an infrastructure error trigger `quarantineParseFailure` or `pop3.dele`.
- When an infrastructure error occurs, the worker must leave the message on POP3, retain the claim, back off exponentially, and report an error status to prevent message loss.

### 4. Comprehensive PM2 Health Check
Update the deployment and monitoring health checks to verify the operational state of all critical background processes:
- In `deploy-ec2.sh`, query `pm2 jlist` and assert that `worker`, `http`, and `ai-worker` are all in `online` state with restart count equal to 0.
- Add an alert on CloudWatch or monitoring scripts when `mail_ingest_quarantine` row count increases by more than 5 in any 15-minute window.

## Related Documentation

- [Vitest Against Production RDS Wiped EC2 Pilot Mail Data](file:///home/ubuntu/projects/zero/docs/solutions/database-issues/vitest-production-pilot-db-wipe.md): Documents production RDS safeguards and S3 raw MIME rehydration tooling.
- [EC2 Pilot ops-deploy, ops-restart, and ops-reboot Entry Points](file:///home/ubuntu/projects/zero/docs/solutions/workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md): Establishes standard operations tooling for EC2 pilot deployments.
- [EC2 Pilot Autonomous Deploy and SSM Gotchas](file:///home/ubuntu/projects/zero/docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md): Documents SSM deployment pitfalls and environment variable persistence.
- [Live Pilot Production Parity for Real Mail on EC2](file:///home/ubuntu/projects/zero/docs/solutions/architecture-patterns/live-pilot-production-parity-real-mail.md): Details live POP3 transport architecture and S3 raw MIME ingest paths.
- [Live AI mail pipeline with Mastra workflows, ai-worker writes, and opt-in gates](file:///home/ubuntu/projects/zero/docs/solutions/architecture-patterns/live-ai-mail-pipeline-mastra-worker-gates.md): Architecture separating POP3 ingest from Mastra AI workflows.
