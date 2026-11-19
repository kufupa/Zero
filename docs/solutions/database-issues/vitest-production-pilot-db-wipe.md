---
title: Vitest Against Production RDS Wiped EC2 Pilot Mail Data
date: 2026-07-27
last_updated: 2026-07-30
category: database-issues
module: server-pilot mail ingest / EC2 pilot ops / vitest
problem_type: database_issue
component: testing_framework
severity: critical
symptoms:
  - Pilot message and mail_thread rows mutated or wiped after overnight vitest/fixture run against production RDS
  - "mailbox_transport briefly replaced with *@example.com test fixtures on live pilot"
  - "pnpm --filter @zero/server test -- <files> ignored file filter and executed the full vitest suite"
  - "Recurrence 2026-07-30 Task 9 ~02:50Z — ~2 fixture messages, transport-centurion absent; DeletionProtection did not stop SQL wipe"
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
  - vitest-allow-pilot-rds
  - pilot-rds-guard
  - pitr-recovery
  - deletion-protection
  - hotel-triage-quality
---

# Vitest Against Production RDS Wiped EC2 Pilot Mail Data

## Problem

During overnight unstamped Centurion routing work on the EC2 pilot, an agent sourced the gitignored live env file under apps/server-pilot (not committed; holds production DATABASE_URL for host nava-zero-mail-pilot) and ran `pnpm --filter @zero/server test -- apps/server-pilot/tests/env.test.ts …`. The workspace `test` script did not constrain Vitest to those files — the full server-pilot suite under `apps/server-pilot/tests/` executed against production RDS. Tests that seed fixtures or commit outside rollback wrappers wiped real pilot mail data. Centurion and Nava transports vanished (replaced by `*@example.com` fixtures). Historical mail already POP3-DELE'd from Zimbra could not be re-fetched; the durable archive was the S3 bucket object prefix for ingest MIME (commonly named raw-mime), not a path in this repository.

The incident exposed a compound failure: (1) no hard refuse when Vitest inherits a pilot `DATABASE_URL`, (2) `pnpm --filter … test -- <file>` does not scope discovery, (3) `withTestDb` transaction rollback only protects callbacks that use the helper, and (4) no recovery tooling to rebuild wiped rows from S3.

**Invariant at risk:** live pilot mail plane (`mailbox_transport` identity, `message` / `mail_thread` / triage state) must not be mutated by Vitest fixtures against production `DATABASE_URL`. POP3 DELE-after-ingest makes Zimbra non-authoritative for wiped history — S3 ingest MIME objects are the durable backstop.

**Recurrence (2026-07-30 Task 9):** Overnight hotel-triage-quality work hit the **same logical wipe fingerprint** again (~02:50Z): fixture `mailbox_transport` (~`created_at=2026-07-30T02:50:31Z`), ~2 fixture messages, `transport-centurion` absent. Vitest refuse + gate opt-in were already on tree — escape hatch, sourced prod env, or non-Vitest SQL/tsx with pilot `DATABASE_URL` can still wipe. Culprit process for this recurrence was **not** definitively pinned; treat as fingerprint match. Recovery used **PITR → rename** (section 3b) rather than S3 rehydrate. RDS **DeletionProtection does not stop SQL wipe** — only instance delete. (session history)

## Symptoms

- Vitest reported **104+ failures** on EC2; the real damage was data loss, not assertion noise.
- `mailbox_transport` contained only `*@example.com` fixtures; Centurion/Nava gone until re-seed.
- `message` count collapsed to **~3** fixture rows before recovery (Jul 27) / **~2** (Jul 30 recurrence).
- First `promote-quarantine` after wipe: **`stored=0`, `quarantined=19`** — no Centurion transport to route into.
- After `CONFIRM_PILOT_SEED=1` seed + deactivating example.com transports: promote **`stored=17`**, **3 R5 poison** left; `inbound_triage` **`succeeded=15`**.
- S3 listed **~268–271** objects under the ingest-nava-legacy MIME prefix (Jul 27); ~**314** raw-mime + attachments survived Jul 30; Zimbra had no backfill for DELE'd history.
- Post-rehydrate (Jul 27): **`scanned=271 skipped_existing=24 skipped_quarantine=4 stored=241 quarantined=2`** → DB ~**269** messages (Centurion ~251 / Nava ~15).
- Jul 30 PITR to `2026-07-30T02:00:00Z` verified Centurion inbound **~234** before rename cutover.

## What Didn't Work

- **Promote before re-seeding Centurion transport.** Without `transport-centurion`, every promote re-quarantined (`stored=0`).
- **Expecting POP3/Zimbra to restore wiped rows.** Mail already ingested and DELE'd is gone from the mailbox; S3 raw MIME is the only historical backstop. (session history: Jul 22 cutover locked DELE-after-ingest as permanent.)
- **Assuming `pnpm --filter @zero/server test -- <file>` scopes Vitest.** Passthrough did not limit discovery; full `apps/server-pilot/tests/` suite ran against live `DATABASE_URL`.
- **Trusting `withTestDb` for fleet isolation.** Transaction rollback only protects callbacks that use the helper; many tests open their own connections, seed, or commit outside it.
- **Sourcing `.env.production` then running any Vitest.** Once `DATABASE_URL` points at pilot RDS, mutating tests hit production. (session history: Jul 22–23 normalized sourcing prod env for SSM ops *and* focused EC2 vitest gates — compound risk was never connected.)
- **Relying on intentional wipe confirm alone as the only DB guard.** (session history: Jul 22 eng review rejected a `DATABASE_URL` host allowlist as YAGNI in favor of `CONFIRM=WIPE_PILOT_DB` for *intentional* wipe — left Vitest without a hard refuse of the pilot hostname. Jul 27 reversed that for the Vitest path after the wipe.)
- **Treating DeletionProtection as data insurance.** (session history: Jul 30) Instance stayed “available”; tables still emptied by fixtures/SQL.
- **Restoring from the latest same-day automated snapshot after wipe.** (session history: Jul 30) Snapshot `rds:nava-zero-mail-pilot-2026-07-30-04-26` was post-wipe / empty — would have restored fixture state. Prefer PITR to a **known pre-wipe** timestamp.
- **Assuming Jul 27 Vitest refuse made recurrence impossible.** The former guard allowed `VITEST_ALLOW_PILOT_RDS=1`; the current guard has no override. Non-Vitest mutators and agent shells that source prod env still require separate safety controls.

## Solution

Recovery was staged: restore transports, promote surviving quarantine, bulk-rehydrate from S3, then harden Vitest against pilot RDS. Prevention shipped and verified on `EC2-pilot` (tip includes `ai-gate` / `bedrock-live-gate` opt-in + dynamic gate scan). **Jul 30 recurrence** preferred PITR+rename when a clean pre-wipe restore window existed (see §3b).

### 1. Restore pilot ingest environment

- `INGEST_REQUIRE_OWNER_HEADER=false` (unstamped Centurion routing / promote require this).
- `CONFIRM_PILOT_SEED=1 pnpm --filter @zero/server seed:prod` — restores Centurion (+ aliases) and Nava transports. Seed does **not** rebuild wiped `message` rows. (session history)
- Deactivate leftover `*@example.com` fixture transports (`is_active=false`). SQL runbook: `navaai-real-mail-smoke.md`.

### 2. Promote quarantine rows

```bash
pnpm --filter @zero/server exec tsx scripts/promote-quarantine.ts --dry-run
pnpm --filter @zero/server exec tsx scripts/promote-quarantine.ts
```

Requires `INGEST_REQUIRE_OWNER_HEADER=false`. Successful second attempt: **17 stored**, 3 poison R5, **15 inbound_triage** succeeded.

### 3. Rehydrate wiped messages from S3 raw MIME

`apps/server-pilot/src/mail/ingest/rehydrate-raw-mime.ts` + `apps/server-pilot/scripts/rehydrate-raw-mime.ts`:

- Lists S3 ingest MIME objects under the ingest-nava-legacy prefix (override with `--prefix`; not a repo path).
- Skips keys already on `message.raw_mime_s3_key` or quarantine.
- Persists with `pop3Uidl` = sanitized filename stem.
- **Default `skipAiEnqueue`** — no Bedrock flood. Opt in with `--triage`.

```bash
pnpm --filter @zero/server exec tsx scripts/rehydrate-raw-mime.ts --dry-run
pnpm --filter @zero/server exec tsx scripts/rehydrate-raw-mime.ts
```

`PersistOptions.skipAiEnqueue` in `store.ts` gates triage enqueue for bulk restore. Rehydrate passes `skipAiEnqueue: !opts.triage`.

**Recovery limits:** rehydrate rebuilds message rows via normal persist — new message/thread IDs; pre-wipe labels and triage history are not restored unless you pass `--triage` (and that only enqueues new triage). Poison / non-equated quarantine residuals and any S3-missing keys are irreversible without manual ops. Intentional wipe scripts use `CONFIRM_PILOT_WIPE=1` (not the older `CONFIRM=WIPE_PILOT_DB` wording in some runbooks).

### 3b. Recurrence recovery — PITR + rename (2026-07-30 Task 9)

When wipe time is known and automated backups cover a **pre-wipe** window, PITR preserves message/thread IDs and triage state better than S3 rehydrate. (session history)

**Caveats (integrity):**
- Confirm `EarliestRestorableTime` / retention **before** committing to rename; list snapshots vs wipe clock and skip any taken after wipe.
- Restore time → wipe clock is an **RPO hole** — mail ingested in that gap is absent from the PITR DB; optionally rehydrate only those newer S3 keys after cutover.
- If choosing §3b, do **not** seed/promote/rehydrate onto the wiped live instance first (work discarded on rename; confusing cutover).
- Rename cutover is hard to reverse; verify counts on the PITR endpoint first. Keep forensic wiped instance offline/unused until the proof window closes.
- Between rename steps the prod identifier may briefly be unavailable — quiesce producers and only resume PM2 after DNS/endpoint + inventory checks.

1. **Confirm fingerprint** — fixture transports / tiny message count / Centurion absent; pin wipe clock (here ~02:50Z via fixture `created_at`).
2. **Skip post-wipe snapshots** — do not restore from same-day automations taken after wipe (Jul 30: `rds:nava-zero-mail-pilot-2026-07-30-04-26` was empty).
3. **Quiesce producers** (PM2 http/worker/ai-worker/… stop + save) before instance rename.
4. **PITR** to a verified pre-wipe time into a temp identifier (Jul 30: restore to `2026-07-30T02:00:00Z` → `nava-zero-mail-pilot-task9-pitr`).
5. **Verify** on the PITR endpoint (Centurion inbound count, transports) before cutover.
6. **Rename dance** (keep the app DNS/hostname apps already use):
   - Wiped live → forensic retain name (Jul 30: `nava-zero-mail-pilot-wiped-20260730`)
   - PITR temp → `nava-zero-mail-pilot`
7. Re-enable **DeletionProtection**; **rotate** master password if SSM/tool stdout leaked it; refresh gitignored live env / secrets consumers.
8. Resume PM2 on restored endpoint; decide product cutovers separately (Jul 30 left hotel on triage-v4).

**Choose rehydrate (§3) vs PITR (§3b):** Prefer PITR when a clean pre-wipe restore time exists and label/thread continuity matters. Prefer S3 rehydrate when PITR window is wrong/expired or only object store survived with new IDs acceptable.

### 4. Hard-block pilot RDS in Vitest (shipped)

Pure helper — no DB I/O:

```typescript
// apps/server-pilot/tests/helpers/pilot-rds-guard.ts
export const PILOT_PROD_DB_HOST = 'nava-zero-mail-pilot';

export function assertNotPilotProdDatabase(
  databaseUrl: string | undefined,
): void {
  if (!databaseUrl) return;
  if (!isPilotProdDatabase(databaseUrl)) return;
  throw new Error(/* names host + states that no override exists */);
}
```

Vitest `setupFiles` refuses even when a suite never imports `test-db.ts`:

```typescript
// apps/server-pilot/tests/setup/refuse-pilot-rds.ts
assertNotPilotProdDatabase(process.env.DATABASE_URL);
```

Registered in `apps/server-pilot/vitest.config.ts` as `setupFiles: ['./tests/setup/refuse-pilot-rds.ts']`. `apps/server-pilot/tests/helpers/test-db.ts` also asserts at module load and before `postgres()` connect.

### 5. Disposable database requirement for gate Vitest

Deploy gates that source `.env.production` **and** run Vitest must require `TEST_DATABASE_URL`, replace inherited `DATABASE_URL`, clear the legacy escape hatch, and use scoped `pnpm exec vitest run`:

- `apps/server-pilot/deploy/mail-search-gate.sh`
- `apps/server-pilot/deploy/fixture-loopback-gate.sh`
- `apps/server-pilot/deploy/wire-gate.sh`
- `apps/server-pilot/deploy/hms-read-gate.sh` (`--full` only; fixture-only remains DB-free)

`apps/server-pilot/tests/deploy-config.test.ts` dynamically scans `apps/server-pilot/deploy/*.sh` for scripts that source `.env.production` **and** invoke Vitest, then asserts each requires `TEST_DATABASE_URL`, assigns it to `DATABASE_URL`, clears `VITEST_ALLOW_PILOT_RDS`, and uses `pnpm exec vitest run`.

### 6. Correct way to run a single test (when unavoidable)

```bash
cd apps/server-pilot
unset DATABASE_URL   # or disposable DB only — never pilot RDS
pnpm exec vitest run tests/env.test.ts
```

Do **not** run `pnpm --filter @zero/server test` on EC2 with production credentials.

## Why This Works

**Root cause:** `test_isolation` — production `DATABASE_URL` + unscoped full Vitest. `withTestDb` only protects its own callbacks; the suite includes tests that commit to the same RDS.

**Why promote failed first:** `persistInboundMessage` needs seeded `mailbox_transport`. Wiped Centurion identity → re-quarantine.

**Why S3 rehydrate works:** Ingest already PUT bodies to durable S3 MIME keys. DB rows are rebuildable metadata; S3 survived. Idempotent skip of existing keys; `skipAiEnqueue` avoids hundreds of duplicate triage jobs.

**Why POP3 cannot help:** DELE after successful ingest removes messages from Zimbra by design.

**Why the guard works:** `setupFiles` runs before any test file loads — even suites that never import `test-db.ts` are blocked. Hostname marker `nava-zero-mail-pilot` is checked via `URL.hostname` with string fallback. No override exists; `deploy-config.test.ts` requires disposable DB configuration for every production-env gate that invokes Vitest.

**Why DeletionProtection is insufficient:** It blocks accidental *instance* delete, not data-plane SQL/fixture commits. Jul 30 wipe left the instance available with fixture rows. (session history)

**Why PITR+rename works:** Continuous backup to a pre-wipe timestamp restores relational continuity; renaming into the original identifier keeps the existing endpoint hostname so EC2 env churn stays minimal. Skipping post-wipe snapshots avoids restoring empty/fixture state. (session history)

## Prevention

### Never treat DeletionProtection as wipe insurance

Logical wipe ≠ instance delete. Assume fixtures/SQL can empty tables while RDS status stays `available`.

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
- Also asserted in `apps/server-pilot/tests/helpers/test-db.ts` before connect
- Marker: hostname contains `nava-zero-mail-pilot`
- No escape hatch: `VITEST_ALLOW_PILOT_RDS=1` is ignored and prohibited
- Gates that source `.env.production` then run Vitest must replace `DATABASE_URL` with required `TEST_DATABASE_URL` (enforced by `apps/server-pilot/tests/deploy-config.test.ts`)

Do **not** set `VITEST_ALLOW_PILOT_RDS=1`; it is retained only as a legacy variable that scripts explicitly clear.

### Prefer disposable DB for integration tests

Pilot RDS only for explicit ops scripts (`promote-quarantine`, `rehydrate-raw-mime`, `seed:prod`) — never Vitest.

### If wipe recurs — recovery choice

1. Stop further tests/mutators against RDS; quiesce producers.
2. If wipe clock known and PITR window clean → **§3b PITR+rename** (skip post-wipe snapshots; verify counts; rotate secrets if leaked).
3. Else → **§1–3** seed transports, promote quarantine, `rehydrate-raw-mime` **without** `--triage`.
4. Spot-check Centurion (+ hotel) transports active; message counts ≫ fixture noise; DeletionProtection on.

### Agent / overnight rules

- EC2 pilot: **no casual / full `pnpm test` / vitest** with sourced `.env.production`.
- Ops `tsx scripts/*.ts` with `.env.production` may be valid when explicitly reviewed; Vitest never inherits production `DATABASE_URL`.
- Focused `pnpm exec vitest run <files>` on EC2 is acceptable only with `DATABASE_URL` unset or pointed at a disposable database.
- Never echo `DATABASE_URL` / passwords in SSM stdout; rotate on exposure. (session history)

### Verification checklist

- `active_example = 0` for `*@example.com` transports; Centurion + Nava still active.
- Message counts by transport ≫ 0 after rehydrate or PITR; quarantine residuals poison/non-equated only.
- With or without legacy opt-in: `DATABASE_URL=…nava-zero-mail-pilot… pnpm exec vitest run tests/pilot-rds-guard.test.ts` fails at setup with `No override exists`.
- `pnpm exec vitest run tests/deploy-config.test.ts` — disposable-DB gate invariant green.
- Gate scripts that source `.env.production` and run Vitest require `TEST_DATABASE_URL`, replace inherited `DATABASE_URL`, and clear `VITEST_ALLOW_PILOT_RDS`.
- After PITR rename: endpoint hostname still `nava-zero-mail-pilot…`; DeletionProtection `true`; wiped instance retained for forensics until proof window closes.
## Related Issues

- Ops parity handoff: `docs/superpowers/plans/handoff-reports/2026-07-27-pilot-rds-guard-ops-parity.md`
- Ops parity plan: `docs/plans/2026-07-27-003-fix-pilot-rds-test-guard-and-ops-parity-plan.md`
- Detailed impl: `docs/superpowers/plans/2026-07-27-pilot-rds-test-guard-and-ops-parity.md`
- Handoff (incident RCA): `docs/superpowers/plans/handoff-reports/2026-07-27-unstamped-centurion-overnight.md`
- Plan: `docs/plans/2026-07-27-002-feat-unstamped-centurion-routing-plan.md`
- Promote: `apps/server-pilot/src/mail/ingest/promote-quarantine.ts`, `apps/server-pilot/scripts/promote-quarantine.ts`
- Rehydrate: `apps/server-pilot/src/mail/ingest/rehydrate-raw-mime.ts`, `apps/server-pilot/scripts/rehydrate-raw-mime.ts`
- Persist `skipAiEnqueue`: `apps/server-pilot/src/mail/ingest/store.ts`
- Guard: `apps/server-pilot/tests/helpers/pilot-rds-guard.ts`, `apps/server-pilot/tests/setup/refuse-pilot-rds.ts`
- Adjacent (refresh needed — still recommend sourcing `.env.production` for EC2 vitest):
  - `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`
  - `docs/solutions/test-failures/inbox-listing-test-fixture-drift.md`
  - `docs/solutions/test-failures/ec2-ai-contract-tests-rds-gate-fk-setup.md`
  - `docs/solutions/logic-errors/mail-list-keyset-pagination-cursor.md`
- Safe pattern contrast: `docs/solutions/architecture-patterns/nava-fixture-loopback-e2e-harness.md`
