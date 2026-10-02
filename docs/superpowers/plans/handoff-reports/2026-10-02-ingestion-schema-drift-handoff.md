# Centurion ingestion schema drift repair — 2 October 2026

Skipped migrations were the ingestion outage. The September 24 deployment introduced AI workflow read columns while production remained at migration 0023. Message persistence and AI enqueue share a transaction; PostgreSQL 42703 rolled back valid mail. After three retries the worker treated the failure as malformed MIME, archived raw mail and deleted it from POP3. AI worker also failed against the stale schema.

## Restored production

Reviewed and applied additive migrations 0024–0028 after checking RDS backup/PITR protection and exercising committed migrations on disposable PostgreSQL 16. Production ledger now has 29 matching migrations. Built and activated the ingestion/AI repair at `cd682d39a7210fce8a77bf5bf2b6a1e9d5b8ac1c` on the existing deployed lineage, avoiding incidental Outlook v4 deployment. HTTP processes remain on their previous release; both health endpoints pass. Existing untracked EC2 work was preserved through a checked fast-forward, without reset/force checkout.

Recovered **1,286 distinct incident quarantine rows**: **975 inbound and 311 outbound**. First 10 restored, then remaining 1,276; every row reconciled against raw MIME. Two overlapping snapshot entries explain the earlier 1,288 operational snapshot total; IDs and UIDLs each identify 1,286 distinct rows. Source date/direction mismatches, missing raw objects, missing attachment objects and residual incident quarantine are all zero. Verified **5,081 attachment objects**. Recovery deliberately enqueued zero historical AI runs.

Private read-only evidence: `.private/ingestion-debug-20261002/production-migration.json`, `reconciliation-all.json`, `production-activation.json` and `production-final.json`. These stay outside Git; no mail bodies, credentials or production URLs in this handoff. Older unrelated quarantines remain visible in an opaque-ID residual report on EC2.

Refreshed private reservationist corpus for **26–28 September Johannesburg**: 265 window messages plus 123 context messages; **13 usable gold-reply threads**, up from three. No paid/live backtest executed.

## Prevention

Known nested PostgreSQL schema/permission/connection failures now retain POP3 mail without spending malformed-MIME retries; diagnostics use safe codes. Genuine malformed MIME keeps bounded quarantine. Deploy, restart and boot verify committed hashes/timestamps plus required ORM tables, columns, types, enum values and valid unique conflict arbiters/predicates before live activation. Unknown newer migration history fails closed.

Recovery returns per-row opaque IDs and bounded residual reasons. Mocked DB/persistence recovery tests and the two misleading mocked poison cases were removed. Incident regressions use actual MIME parsing, persistence and AI enqueue against committed migrations on task-owned PostgreSQL 16; fake transport/object storage only substitutes external services.

## Validation

- Real RED evidence reproduced deletion on cycle three for missing read column/table and denied INSERT; repaired behavior retains then stores once. Actual PostgreSQL session termination also retains mail.
- Required ingestion gate: **33 passed, zero skips**, repeated successfully after integration with latest main.
- Existing transactional mail/attachment/recovery gate: **89 passed, zero skips** after main integration.
- Server build, focused lint/formatting, shell syntax and independent code/integration review passed.
- Missing or unreachable disposable DB fails the required gate; CI PostgreSQL 16 job runs it explicitly.

Broader exploratory suites have baseline failures: six existing ingest-store assertions reproduced on unchanged main; unrelated deploy/AWS fixture failures also reproduce on unchanged main. These useful real tests were preserved. They do not pass merely because this repair passes. Logs and agent reports are task-private under `/tmp/ingestion-*`.

## Limits and follow-up

Compatibility check accepts timestamp with/without timezone because five existing committed SQL/ORM mappings already differ. It verifies required schema and uniqueness, not arbitrary hand-modified triggers/constraints. Current partial predicates are simple comparisons/IS NOT NULL; extend real regressions for complex future predicates. Historical AI catch-up remains intentionally separate and bounded. Future rollback with a newer ledger requires reviewed compatibility, rather than bypassing activation protection.
