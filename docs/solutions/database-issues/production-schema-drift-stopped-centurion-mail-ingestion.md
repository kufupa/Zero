---
title: "Production Schema Drift Stopped Centurion Mail Ingestion"
date: "2026-10-02"
category: database-issues
module: "server-pilot Centurion mail ingestion"
problem_type: database_issue
component: database
symptoms:
  - "Valid inbound messages stopped persisting after September 24 while production's Drizzle migration journal remained at 0023 and deployed code required migrations 0024 through 0028."
  - "PostgreSQL returned SQLSTATE 42703 for the missing ai_workflow_run.read_request column, rolling back message persistence and AI workflow enqueue in the same transaction."
  - "When the configured retry limit was reached on cycle three, the worker mislabeled valid messages as parse_failure, archived their raw MIME to S3, and issued POP3 DELE."
  - "The September 26–28 Johannesburg corpus had only three usable threads even though the raw MIME remained available for recovery."
root_cause: missing_workflow_step
resolution_type: migration
severity: critical
related_components:
  - "email_processing"
  - "development_workflow"
  - "testing_framework"
tags:
  - "centurion"
  - "email-ingestion"
  - "schema-drift"
  - "drizzle-migrations"
  - "pop3"
  - "quarantine"
  - "postgres"
  - "mail-recovery"
  - "real-postgresql-tests"
---

# Production Schema Drift Stopped Centurion Mail Ingestion

## Problem

Centurion production stopped ingesting valid inbound mail on September 24, 2026. The deployed code depended on migrations 0024–0028, but production's migration journal was still at 0023; the resulting database error entered a generic poison-message path that quarantined valid mail and issued POP3 `DELE` on cycle three.

## Symptoms

- Inbound message creation stopped even though incoming messages were valid.
- PostgreSQL reported `42703` for `ai_workflow_run.read_request`; message persistence and the AI workflow row were in one transaction, so both rolled back.
- Quarantine records used `parse_failure` for messages that had failed on database persistence, then the worker issued POP3 `DELE` when the configured retry limit was reached on cycle three.
- A zero-message POP3 UIDL poll showed only that nothing was pending at that poll; it could not show mail already deleted after quarantine.

## What Didn't Work

- Treating every post-parse exception as proof of malformed MIME hid a systemic database error behind `parse_failure`. A read-only Centurion corpus audit on September 17 had already found that this label could cover POP3 retrieval, size checks, raw-MIME or attachment upload, parsing, and persistence errors—not just invalid MIME (session history).
- Treating an empty UIDL listing as proof that no mail had arrived confused the mailbox's current pending queue with messages already consumed and deleted.
- Adding only the first missing column would have left later committed migrations unapplied. The repair needed to run the complete migration chain.
- Mocked persistence-failure tests did not exercise PostgreSQL transaction rollback, quarantine durability, or POP3 acknowledgment. They passed without catching this real failure path and were removed in favor of a required real-PostgreSQL gate.
- Replaying every historical `parse_failure` quarantine without matching rows to the incident and verifying its raw object would have mixed this outage with unrelated quarantines.

## Solution

After confirming RDS backup/PITR protection and exercising the committed migrations on disposable PostgreSQL 16, production applied additive migrations 0024–0028; the ledger now has 29 matching migrations. The ingestion and AI repair was activated on the existing deployed lineage, avoiding an unrelated Outlook v4 release. HTTP processes remained on their previous release, and both health endpoints passed.

Deployment, restart, and PM2 boot now run a fail-closed compatibility check before activating repair code. It checks migration journal hashes and timestamps against committed migrations and compares the required ORM tables, columns, types, enum labels, and valid unique conflict arbiters and predicates with the live PostgreSQL catalog. Unknown newer migration history blocks automatic activation until an explicit route is reviewed. The gate checks the required ORM schema and uniqueness surface; it does not detect arbitrary hand-edited triggers or constraints, which still require migration review and targeted tests.

The worker now walks nested ORM and driver causes to identify known PostgreSQL schema, permission, and connection failures. These infrastructure failures do not spend the per-UIDL poison retry budget, create a `parse_failure` quarantine record, or issue `DELE`; the message stays on POP3 for retry. The bounded quarantine path remains for actual malformed MIME. Logs retain bounded error codes rather than SQL parameters or private message contents.

After fixing the schema, recovery used the parse-failure recovery utility from [PR #10](https://github.com/kufupa/Zero/pull/10), which was not present in the production checkout. It replayed the affected rows' durable S3 MIME through normal parsing and persistence, with AI enqueue disabled. The first 10 rows were restored, followed by the remaining 1,276. Two overlapping snapshot entries explain the 1,288-entry operational inventory; IDs and UIDLs both identified **1,286 distinct incident quarantine rows: 975 inbound and 311 outbound**. Every row reconciled against its archived raw MIME, with zero source date or direction mismatches, missing raw objects, missing attachment objects, or residual incident quarantines. All **5,081 attachment objects** were present. The September 26–28 Johannesburg backtest window now contains **13 usable threads**, up from three.

The required ingestion regression suite now runs against disposable PostgreSQL 16 databases using the committed migrations and actual MIME parsing, persistence, and AI enqueue. It creates missing-column/table drift, denied inserts, and interrupted PostgreSQL connections, then verifies the worker retains the message through a fake transport and persists it after repair; fake transport and object storage stand in only for external services. A malformed-header case still reaches bounded quarantine. The misleading mocked persistence-failure tests were removed; at incident close, all 33 required regression tests and 89 existing transactional tests passed with zero skips. Vitest was not run against production RDS.

The repaired workers were online and production health checks were clean after deployment. No new external inbound message was observed during the final poll window, so the recovery and schema gate were verified without claiming a fresh-arrival observation.

## Why This Works

PostgreSQL `42703` means a query referenced a column that did not exist. Here, `ai_workflow_run.read_request` was added by a migration production had not applied. Because message creation and AI enqueue shared a transaction, PostgreSQL correctly rolled back both; the unsafe behavior was classifying that rollback as evidence that the message itself was poison. Walking nested causes preserves the distinction between malformed MIME and database or connection faults without logging sensitive mail content.

Leaving an infrastructure-failed UIDL on POP3 keeps the transport's retry opportunity open until persistence works. S3 held the raw source, which made this incident recoverable, but an S3 object alone was not a stored inbox message; recovery still had to parse and persist it after repairing the schema. The compatibility gate detects migration-history drift and required ORM-schema incompatibilities before repair code activates; it does not attest to arbitrary triggers or constraints. Real-PostgreSQL tests exercise the database transaction alongside the worker's retain-versus-acknowledge decision, using a fake transport for the external POP3 boundary.

For historical analysis, use the parsed message date from the original MIME. A row recreated during recovery has a new database creation time, which describes when recovery ran rather than when the email was sent.

## Prevention

- Check RDS backup/PITR protection, apply reviewed schema changes through the explicit migration step before deploying dependent code, then require the compatibility gate before application activation or PM2 boot. Do not hand-add one observed column when the journal shows a wider gap.
- Walk nested ORM and driver causes when classifying persistence failures. Database and connection faults must not consume the malformed-message retry budget, quarantine valid mail, or acknowledge it with POP3 `DELE`; keep the malformed-MIME path bounded.
- Preserve ingest ordering: archive raw MIME, parse, commit the message transaction, and only then issue POP3 `DELE`. On terminal quarantine, make both the quarantine record and raw archive durable before deleting the transport copy.
- Require the real-PostgreSQL ingestion gate against an explicitly configured disposable `TEST_DATABASE_URL`; fail closed if that gate cannot run. Test schema drift and POP3 acknowledgment behavior with the real migrations and persistence path, and never point Vitest at production RDS.
- For recovery, scope the affected quarantine rows and source objects, verify S3 availability, begin with a small batch before processing the remainder, disable downstream AI enqueue when replay is not intended, then reconcile distinct messages, original dates and directions, attachments, and remaining quarantines.
- Read an empty UIDL poll only as “no messages currently pending.” Diagnose it alongside worker-cycle results, error codes, migration state, quarantine records, and raw-object inventory.

## Related Issues

- [EC2 pilot autonomous deploy and SSM gotchas](../workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) documents the explicit migration workflow and production deployment checks.
- [EC2 pilot ops deploy, restart, and reboot](../workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md) records migration order and rolling compatibility boundaries.
- [Pilot RDS test isolation and S3 rehydration](vitest-production-pilot-db-wipe.md) covers durable raw MIME and test safety after a separate data-loss incident.
- [Real PostgreSQL AI contract tests](../test-failures/ec2-ai-contract-tests-rds-gate-fk-setup.md) documents production-like database constraints that local mocks missed.
- [Parse-failure recovery utility, PR #10](https://github.com/kufupa/Zero/pull/10) supplied the recovery path used after schema repair.
