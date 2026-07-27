---
title: Vitest Against Production RDS Wiped EC2 Pilot Mail Data
date: 2026-07-27
category: database-issues
module: server-pilot mail ingest / EC2 pilot ops / vitest
problem_type: database_issue
component: testing_framework
severity: critical
symptoms:
  - Pilot message and mail_thread rows mutated or wiped after overnight vitest run against production RDS
  - "mailbox_transport briefly replaced with *@example.com test fixtures on live pilot"
  - "pnpm --filter @zero/server test -- <files> ignored file filter and executed the full vitest suite"
  - Hotel mailbox could not re-download wiped history because POP3 already DELE'd after ingest
root_cause: test_isolation
resolution_type: tooling_addition
related_components:
  - database
  - email_processing
  - development_workflow
  - tooling
tags:
  - vitest
  - test-isolation
  - production-rds
  - ec2-pilot
  - env-production
  - server-pilot
  - mail-ingest
  - pilot-data-recovery
  - rehydrate-raw-mime
  - promote-quarantine
---

# Vitest Against Production RDS Wiped EC2 Pilot Mail Data

## Problem

During overnight unstamped Centurion routing work on the EC2 pilot, an agent sourced `apps/server-pilot/.env.production` (live RDS `DATABASE_URL`) and ran `pnpm --filter @zero/server test -- tests/env.test.ts …`. The workspace `test` script did not constrain Vitest to those files — the full server-pilot suite executed against production RDS. Tests that seed fixtures or commit outside rollback wrappers wiped real pilot mail data. Centurion and Nava transports vanished (replaced by `*@example.com` fixtures). Historical mail already POP3-DELE'd from Zimbra could not be re-fetched; S3 `raw-mime/` was the durable archive.

## Symptoms

- Vitest reported **104+ failures** on EC2; the real damage was data loss, not assertion noise.
- `mailbox_transport` contained only `*@example.com` fixtures; Centurion/Nava gone until re-seed.
- `message` count collapsed to **~3** fixture rows before recovery.
- First `promote-quarantine` after wipe: **`stored=0`, `quarantined=19`** — no Centurion transport to route into.
- After `CONFIRM_PILOT_SEED=1` seed + deactivating example.com transports: promote **`stored=17`**, **3 R5 poison** left; `inbound_triage` **`succeeded=15`**.
- S3 listed **~268–271** objects under `raw-mime/ingest-nava-legacy/`; Zimbra had no backfill for DELE'd history.
- Post-rehydrate: **`scanned=271 skipped_existing=24 skipped_quarantine=4 stored=241 quarantined=2`** → DB ~**269** messages (Centurion ~251 / Nava ~15).

## What Didn't Work

- **Promote before re-seeding Centurion transport.** Without `transport-centurion`, every promote re-quarantined (`stored=0`).
- **Expecting POP3/Zimbra to restore wiped rows.** Mail already ingested and DELE'd is gone from the mailbox; S3 raw MIME is the only historical backstop. (session history: Jul 22 cutover locked DELE-after-ingest as permanent.)
- **Assuming `pnpm --filter @zero/server test -- <file>` scopes Vitest.** Passthrough did not limit discovery; full `tests/` suite ran against live `DATABASE_URL`.
- **Trusting `withTestDb` for fleet isolation.** Transaction rollback only protects callbacks that use the helper; many tests open their own connections, seed, or commit outside it.
- **Sourcing `.env.production` then running any Vitest.** Once `DATABASE_URL` points at pilot RDS, mutating tests hit production. (session history: Jul 22–23 normalized sourcing prod env for SSM ops *and* focused EC2 vitest gates — compound risk was never connected.)
- **Relying on intentional wipe confirm alone as the only DB guard.** (session history: Jul 22 eng review rejected a `DATABASE_URL` host allowlist as YAGNI in favor of `CONFIRM=WIPE_PILOT_DB` for *intentional* wipe — left Vitest without a hard refuse of the pilot hostname.)

## Solution

Recovery was staged: restore transports, promote surviving quarantine, then bulk-rehydrate from S3.

### 1. Restore pilot ingest environment

- `INGEST_REQUIRE_OWNER_HEADER=false` (unstamped Centurion routing / promote require this).
- `CONFIRM_PILOT_SEED=1 pnpm --filter @zero/server seed:prod` — restores Centurion (`centurion@legacyhotels.co.za` + aliases) and Nava transports. Seed does **not** rebuild wiped `message` rows. (session history)
- Deactivate leftover `*@example.com` fixture transports (`is_active=false`). SQL: [`navaai-real-mail-smoke.md`](../../apps/server-pilot/deploy/navaai-real-mail-smoke.md#post-wipe--fixture-cleanup).

### 2. Promote quarantine rows

```bash
pnpm --filter @zero/server exec tsx scripts/promote-quarantine.ts --dry-run
pnpm --filter @zero/server exec tsx scripts/promote-quarantine.ts
```

Requires `INGEST_REQUIRE_OWNER_HEADER=false`. Successful second attempt: **17 stored**, 3 poison R5, **15 inbound_triage** succeeded.

### 3. Rehydrate wiped messages from S3 raw MIME

`apps/server-pilot/src/mail/ingest/rehydrate-raw-mime.ts` + `scripts/rehydrate-raw-mime.ts`:

- Lists `raw-mime/ingest-nava-legacy/*.eml` (override with `--prefix`).
- Skips keys already on `message.raw_mime_s3_key` or quarantine.
- Persists with `pop3Uidl` = sanitized filename stem.
- **Default `skipAiEnqueue`** — no Bedrock flood. Opt in with `--triage`.

```bash
pnpm --filter @zero/server exec tsx scripts/rehydrate-raw-mime.ts --dry-run
pnpm --filter @zero/server exec tsx scripts/rehydrate-raw-mime.ts
```

`PersistOptions.skipAiEnqueue` in `store.ts` gates triage enqueue for bulk restore.

### 4. Correct way to run a single test (when unavoidable)

```bash
cd apps/server-pilot
unset DATABASE_URL   # or disposable DB only — never pilot RDS
pnpm exec vitest run tests/env.test.ts
```

Do **not** run `pnpm --filter @zero/server test` on EC2 with production credentials.

## Why This Works

**Root cause:** `test_isolation` — production `DATABASE_URL` + unscoped full Vitest. `withTestDb` only protects its own callbacks; the suite includes tests that commit to the same RDS.

**Why promote failed first:** `persistInboundMessage` needs seeded `mailbox_transport`. Wiped Centurion identity → re-quarantine.

**Why S3 rehydrate works:** Ingest already PUT bodies to `raw-mime/{ingestMailboxId}/{uidl}.eml`. DB rows are rebuildable metadata; S3 survived. Idempotent skip of existing keys; `skipAiEnqueue` avoids hundreds of duplicate triage jobs.

**Why POP3 cannot help:** DELE after successful ingest removes messages from Zimbra by design.

## Prevention

### Never source `.env.production` for Vitest on EC2/pilot

Ops scripts may use prod env in a **subshell**. Vitest must not inherit pilot `DATABASE_URL`:

```bash
# BAD — poisons parent shell
set -a && source apps/server-pilot/.env.production && set +a
pnpm --filter @zero/server test

# GOOD — ops in subshell; tests never see pilot URL
(
  set -a && source apps/server-pilot/.env.production && set +a
  pnpm --filter @zero/server exec tsx scripts/promote-quarantine.ts
)
cd apps/server-pilot && unset DATABASE_URL && pnpm exec vitest run tests/env.test.ts
```

### Use explicit Vitest file scope from package root

```bash
cd apps/server-pilot
pnpm exec vitest run tests/env.test.ts
```

Avoid `pnpm --filter @zero/server test -- <file>` — may still run the full suite.

### Hard-block pilot RDS host in vitest (implemented)

- Pure helper: `apps/server-pilot/tests/helpers/pilot-rds-guard.ts`
- Vitest `setupFiles`: `apps/server-pilot/tests/setup/refuse-pilot-rds.ts`
- Also asserted in `tests/helpers/test-db.ts` before connect
- Marker: hostname contains `nava-zero-mail-pilot`
- Escape hatch (intentional gates only): `VITEST_ALLOW_PILOT_RDS=1`
- Gates that source `.env.production` then run vitest must export the opt-in:
  - `deploy/mail-search-gate.sh`
  - `deploy/fixture-loopback-gate.sh`
  - `deploy/wire-gate.sh`

Do **not** set `VITEST_ALLOW_PILOT_RDS=1` in a casual overnight agent shell.

### Prefer disposable DB for integration tests

Pilot RDS only for explicit ops scripts (`promote-quarantine`, `rehydrate-raw-mime`, `seed:prod`) — never Vitest.

### Rehydrate playbook if wipe recurs

1. Stop further tests against RDS.
2. Ensure `INGEST_REQUIRE_OWNER_HEADER=false`.
3. `CONFIRM_PILOT_SEED=1` seed; deactivate `example.com` fixtures.
4. `promote-quarantine.ts --dry-run` then apply.
5. `rehydrate-raw-mime.ts --dry-run` then apply **without** `--triage`.
6. Spot-check counts per transport.

### Agent / overnight rules

- EC2 pilot: **no `pnpm test` / vitest** unless `DATABASE_URL` is verified non-pilot.
- Ops `tsx scripts/*.ts` with `.env.production` OK; Vitest is not.
- Focused `pnpm exec vitest run <files>` on EC2 is only acceptable against a disposable DB (or after host hard-block lands).

## Related Issues

- Ops parity plan: `docs/plans/2026-07-27-003-fix-pilot-rds-test-guard-and-ops-parity-plan.md`
- Detailed impl: `docs/superpowers/plans/2026-07-27-pilot-rds-test-guard-and-ops-parity.md`
- Handoff (incident RCA): `docs/superpowers/plans/handoff-reports/2026-07-27-unstamped-centurion-overnight.md`
- Plan: `docs/plans/2026-07-27-002-feat-unstamped-centurion-routing-plan.md`
- Promote: `apps/server-pilot/src/mail/ingest/promote-quarantine.ts`, `scripts/promote-quarantine.ts`
- Rehydrate: `apps/server-pilot/src/mail/ingest/rehydrate-raw-mime.ts`, `scripts/rehydrate-raw-mime.ts`
- Persist `skipAiEnqueue`: `apps/server-pilot/src/mail/ingest/store.ts`
- Partial isolation helper: `apps/server-pilot/tests/helpers/test-db.ts`
- Adjacent (refresh needed — still recommend sourcing `.env.production` for EC2 vitest):
  - `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`
  - `docs/solutions/test-failures/inbox-listing-test-fixture-drift.md`
  - `docs/solutions/test-failures/ec2-ai-contract-tests-rds-gate-fk-setup.md`
  - `docs/solutions/logic-errors/mail-list-keyset-pagination-cursor.md`
- Safe pattern contrast: `docs/solutions/architecture-patterns/nava-fixture-loopback-e2e-harness.md`
