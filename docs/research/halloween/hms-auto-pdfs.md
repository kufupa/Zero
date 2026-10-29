# HMS Auto PDFs — HRCEN Confirmation Letters

**Result:** The RDS query returned 1,865 outbound message rows with the exact `HRCEN_Confirmation_Letter_… .pdf` filename pattern; these represent 1,773 distinct email keys. It reported database name `zero`; the endpoint was not independently validated. These are stored rows, not proof of BCC delivery or capture completeness.

## Snapshot and source

- **Query snapshot:** 2026-10-29 14:58:46Z.
- **Database:** `zero`; query ran after sourcing the production `.env.production` on EC2 via SSM. The query recorded the database name but did not independently inspect the connection endpoint.
- **Scope:** all retained `attachment` rows joined to `message`, with no date filter. Only `transport-centurion` had matches; results include inbound and outbound.
- **Observed matching message-time range:** 2026-07-27 11:01:15 through 2026-10-29 13:03:16, as stored in the database. `sent_at`, `received_at`, and `created_at` are `timestamp without time zone`; the query session timezone was UTC, but these stored values are not intrinsically timezone-aware.
- **Pattern:** case-sensitive PostgreSQL regex `^HRCEN_Confirmation_Letter_.*[.]pdf$`. Underscores are literal; suffix must be lowercase `.pdf`.

## Counts

| Scope | Matching attachment rows | Message rows | Distinct email keys | Transport/thread pairs | Subject says confirmation letter | Sender matches mailbox | Messages with >1 match | Distinct filenames | Message-time range, stored value |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **Outbound** | **1,879** | **1,865** | **1,773** | 1,801 | 1,828 | 1,865 | 8 | 897 | 2026-07-27 11:01:15 → 2026-10-29 13:03:16 |
| Inbound | 187 | 130 | 126 | 106 | 44 | 0 | 34 | 139 | 2026-07-27 15:31:01 → 2026-10-29 12:01:23 |
| **All** | **2,066** | **1,995** | **1,899** | **1,862** | **1,872** | **1,865** | **42** | **909** | 2026-07-27 11:01:15 → 2026-10-29 13:03:16 |

- Attachment rows exceed message rows because 42 messages have multiple matching attachments.
- “Distinct email keys” counts `COALESCE(message_id_header, message.id::text)`. It differs from message-row count because repeated Message-ID headers are deduplicated.
- Subject and sender columns are supporting metadata only. Subject match used `confirmation[[:space:]_-]*letter`; sender match checks whether `from_address` contains the transport mailbox email, using the same rule as the prior R-CORPUS analysis.

## Method

1. Used the checked-in `apps/server-pilot/deploy/ssm-run-command.sh` for this one-off corpus query, following the existing corpus-plan precedent; remotely changed to `/home/ubuntu/repos/zero/apps/server-pilot` and sourced `.env.production` with export enabled. The general EC2 guide keeps this low-level wrapper for debugging, not as the default operations loop.
2. Piped the SQL to `psql "$DATABASE_URL"` without printing the connection value. Set `PGCONNECT_TIMEOUT=15`, SSM execution timeout to 180 seconds, and PostgreSQL `statement_timeout` to 60 seconds.
3. Wrapped the query in `BEGIN READ ONLY` / `ROLLBACK`. Read-only behavior came from the SQL transaction; the SSM wrapper accepts arbitrary commands, and DB-role grants were not audited. Returned aggregates only: no raw subject, address, filename, message-body, or guest-identifier values; no PDF bytes.
4. Query used no time predicate, so it covered every currently retained matching row. Dates above are the observed minimum and maximum message timestamps, not a filter.

## Scripts used

- [`hms-auto-pdfs.sql`](hms-auto-pdfs.sql) — exact successful aggregate SQL, now saved separately. It was inline SQL during the original run; the `.sql` file itself was not transferred or executed then.
- `apps/server-pilot/deploy/ssm-run-command.sh` — submitted and polled the one-off remote SSM command.
- `apps/server-pilot/deploy/ssm-format-invocation.cjs` — called by the SSM wrapper to collect and format command output.
- Remote execution shape: source `/home/ubuntu/repos/zero/apps/server-pilot/.env.production`, then pipe the encoded SQL to `PGCONNECT_TIMEOUT=15 psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -A -t -F '|'`. No connection value was printed.
- Host-local `ops-run.sh` shortcut — attempted first, but failed before submitting SSM because its hard-coded wrapper path was missing; it did not query the database.

The SQL file contains the read-only transaction and aggregate query, no connection string or credential. It is the query, not a standalone shell/SSM launcher.

## Limits and execution notes

- This inventories RDS rows present at query time. The query did not inspect BCC headers or delivery logs, so it cannot prove every outbound email was successfully BCC-captured.
- Filename and subject metadata do **not** establish that every matched PDF is a pro forma invoice or verify its contents. No PDF was opened in this step.
- A host-local `ops-run.sh` shortcut was unusable because its hard-coded SSM helper path was missing. The checked-in SSM wrapper was used directly instead.
- First read-only SQL attempt failed because `message.direction` is an enum and could not coalesce with text. The successful query casts it to `text`; failed attempt returned no rows and made no changes.

## Source anchors

- Prior production-corpus method, schema preflight, transport mapping, and read-only transaction pattern: `docs/research/2026-10-26-r-corpus.md:52-91`.
- Prior message, attachment, mailbox, and timestamp field usage: `docs/research/2026-10-26-r-corpus.md:93-145`.
- SSM execution wrapper: `apps/server-pilot/deploy/ssm-run-command.sh:17-55`.
- Scoped corpus plan names this wrapper for read-only SQL: `docs/plans/2026-10-26-002-overnight-run2-plan.md:154-160`. General EC2 guidance says low-level SSM tools are for debugging, not the default operations loop: `docs/superpowers/EC2-ACCESS.MD:5-14`.
- Host-local production environment sourcing convention: `/home/ubuntu/projects/zero/.worktrees/ops-run.sh:8-11`.
- Project description of Nava@ as Centurion BCC sink: `docs/superpowers/plans/2026-06-30-ec2-pilot-schema-and-backend.md:79-82`. The `message.bcc_addresses` column exists in `apps/server-pilot/drizzle/0000_omniscient_siren.sql:195-220`; this query did not read it.
- Pilot safety permits read-only SQL checks and bars raw PII in SSM/terminal logs: `.cursor/rules/pilot-rds-safety.mdc:16,21`.
