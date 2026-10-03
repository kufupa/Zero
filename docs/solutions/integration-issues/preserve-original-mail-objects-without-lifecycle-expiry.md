---
title: Prevent S3 lifecycle from deleting original mail objects
date: 2026-10-03
category: integration-issues
module: server-pilot S3 mail retention
problem_type: integration_issue
component: email_processing
symptoms:
  - "S3 lifecycle rules scheduled raw MIME for deletion after 30 days and extracted attachments after 90 days."
  - "The proof guard did not reject every overlapping expiry or restore-required archive configuration."
root_cause: config_error
resolution_type: config_change
severity: medium
tags:
  - s3-retention
  - raw-mime
  - attachments
  - intelligent-tiering
---

# Prevent S3 lifecycle from deleting original mail objects

## Problem

The mail bucket's lifecycle rules scheduled `raw-mime/` objects for deletion after 30 days and `attachments/` objects after 90 days. If allowed to run, this could leave RDS message and attachment records pointing to missing S3 objects. This change does not establish that any objects had already been deleted; changing a lifecycle policy cannot restore objects that were previously removed.

## Symptoms

- Raw MIME and extracted attachment objects had automatic expiration rules despite being needed for faithful EML and attachment downloads.
- A valid named Intelligent-Tiering rule could coexist with another enabled overlapping rule or tiering configuration that deleted mail or required a restore before download.

## What Didn't Work

- Treating raw MIME and extracted attachment bytes as redundant copies was unsafe. RDS stores parsed message content and attachment metadata, not the complete original MIME file or attachment bytes.
- Checking only the expected named lifecycle rules was insufficient: another broad or overlapping rule could still expire or cold-archive the same objects. Intelligent-Tiering's optional Archive Access settings are also configured separately from bucket lifecycle rules.
- Applying a partial `put-bucket-lifecycle-configuration` to an existing bucket can replace the full lifecycle configuration and remove unrelated cleanup rules.

## Solution

Keep `raw-mime/` and `attachments/` without lifecycle expiration. Transition eligible objects into S3 Intelligent-Tiering after 30 days of **object age** (upload age), not the email's sent/received date:

```json
{
  "ID": "archive-raw-mime-30d",
  "Status": "Enabled",
  "Filter": { "Prefix": "raw-mime/" },
  "Transitions": [{ "Days": 30, "StorageClass": "INTELLIGENT_TIERING" }]
}
```

Use the same rule with `attachments/`. Neither mail rule may contain `Expiration` or `NoncurrentVersionExpiration`. The bootstrap command in `apps/server-pilot/deploy/aws-resources.md` sets `TransitionDefaultMinimumObjectSize` to `all_storage_classes_128K`; objects smaller than 128 KiB remain in Standard but are still retained. When modifying an existing bucket, preserve its exact returned minimum-size setting rather than assuming a default.

The reservation and artifact-fetch paths in `apps/server-pilot/deploy/ops-hms-proof.sh` validate the live policy before proceeding. They fail closed when:

- Either named mail rule is missing or changed, or any enabled overlapping lifecycle rule expires current/noncurrent mail objects or transitions them to `GLACIER` / `DEEP_ARCHIVE`.
- Intelligent-Tiering configuration results are incomplete, or an enabled configuration overlapping either mail prefix enables optional `ARCHIVE_ACCESS` / `DEEP_ARCHIVE_ACCESS` tiers. Those tiers require an asynchronous restore; normal EML and attachment downloads do not implement that flow.
- The lifecycle transition minimum-size setting is absent or unrecognized.

When the proof script adds its one-day `hms-browser-proof-transfer/v1/` cleanup rule, it preserves existing rules and the returned minimum-size setting. One-day cleanup for temporary proof transfers and incomplete multipart uploads remains; neither is retained email data.

The live AWS lifecycle policy was changed separately before PR #27 merged. The PR aligned the bootstrap instructions, added these deployment guards, and added regression tests in `apps/server-pilot/tests/mail-retention-lifecycle.test.ts`; merging the code did not itself mutate AWS. S3 applies a lifecycle-policy update without an app restart or add-in rebuild; the updated proof guards ship with the next server deployment. The policy change does not recover objects already deleted under the old rules.

## Why This Works

RDS remains the searchable parsed representation; S3 keeps the original message and attachment bytes used by EML and attachment downloads. Intelligent-Tiering can reduce storage cost for eligible inactive objects while keeping its Frequent Access, Infrequent Access, and Archive Instant Access tiers immediately accessible. The optional Archive Access and Deep Archive Access tiers are excluded because they require restore operations.

During a recent schema-drift recovery, retained S3 originals enabled reconstruction of 1,286 messages after RDS writes had failed; S3 did not replace the need to repair database schema and relational state (session history). This is why S3 originals are a recovery source, not a substitute for RDS integrity and migration safeguards.

This is lifecycle retention, not immutable/WORM storage: explicitly deleting an object or losing the bucket/account remains outside this change.

## Prevention

- Treat every mail-data prefix, including future mailbox-sync prefixes, as retained: no automatic expiration and no storage tier that requires restore for ordinary reads.
- When changing a live bucket, fetch and back up the complete lifecycle and Intelligent-Tiering configurations; modify only the intended rules; preserve unrelated rules and the exact transition-size setting; then read back and verify the full result.
- Validate all enabled rules/configurations whose prefixes overlap retained mail, not only the expected rule IDs. Fail closed on incomplete API results or unknown settings.
- Keep regression coverage for both the bootstrap policy and production guards: old expiration rules, broad/overlapping prefixes, current and noncurrent Glacier transitions, optional archive tiers, truncated configuration results, missing size defaults, and preservation of unrelated cleanup rules.
- Test that normal EML and attachment reads work without restore. A lifecycle policy change prevents future expiration; it does not recover earlier deletions.

## Related Issues

- [PR #27 — retain original mail without expiry](https://github.com/kufupa/Zero/pull/27)
- [RDS wipe recovery](../database-issues/vitest-production-pilot-db-wipe.md) — related recovery path; it remains a distinct database failure mode.
- [One-click EML download](../architecture-patterns/one-click-eml-download-infor-pms-drag-bridge.md) — depends on the original MIME remaining readable from S3.
- [Raw MIME rehydrate](../../CONCEPTS.md#raw-mime-rehydrate) — existing operational recovery term.
