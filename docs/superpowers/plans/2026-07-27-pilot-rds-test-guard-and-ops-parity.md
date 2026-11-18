# Pilot RDS Vitest Guard + Rehydrate Ops Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Overnight: also follow `.cursor/skills/overnight-autonomous-zero/SKILL.md`. Steps use checkbox (`- [ ]`) syntax for tracking. No user checkpoint — see **Execution Mode**.

**Goal:** Stop another vitest wipe of the live pilot RDS, land rehydrate tooling on the `EC2-pilot` tip, deactivate leftover `*@example.com` fixture transports, and smoke-check Centurion/Nava health via SQL + a short human checklist.

**Architecture:** Fail-closed host-marker guard (`nava-zero-mail-pilot`) runs at vitest `setupFiles` load and inside `test-db.ts` before any postgres connect. Opt-in escape hatch `VITEST_ALLOW_PILOT_RDS=1` for intentional gate scripts only. Rehydrate + `skipAiEnqueue` commit and bundle-sync to EC2 (no more S3 tarball overlays). Fixture transports deactivated with SQL; verification is checklist-only (no new Playwright).

**Tech Stack:** Vitest, drizzle/postgres-js, bash gate scripts, S3 git-bundle sync (`sync-ec2-git-bundle.sh`), pilot RDS hostname marker shared with `ingest-benchmark.ts`.

**Spec source:** `docs/plans/2026-07-27-003-fix-pilot-rds-test-guard-and-ops-parity-plan.md`

## Global Constraints

- Pilot host marker substring: exact `nava-zero-mail-pilot` (same as `ingest-benchmark.ts`).
- Opt-in env name: exact `VITEST_ALLOW_PILOT_RDS=1` — do not invent a second allow flag.
- Rehydrate default stays triage-off (`skipAiEnqueue`); no bulk `--triage` in this plan.
- Fixture cleanup: `is_active=false` only — no CASCADE DELETE of transports/messages.
- UI verification: SQL + human checklist only — no new Playwright suite.
- Vitest scoped runs: always `cd apps/server-pilot && pnpm exec vitest run <files>` — never `pnpm --filter @zero/server test -- …` as a scoped run.
- Never source `.env.production` into a vitest process without `VITEST_ALLOW_PILOT_RDS=1` **and** knowing the suite is rollback-safe.
- IT Zimbra stamp/strip still deferred; do not reopen unstamped Centurion product work.
- Overnight: after Task 2 lands, **do not** run casual/full vitest against pilot `DATABASE_URL`. Intentional gates only via scripts that export `VITEST_ALLOW_PILOT_RDS=1`. Never `pnpm --filter @zero/server test` on EC2 with sourced `.env.production`.
- Overnight SPA login/VPN UI spot-check is best-effort — if login blocked, tick SQL + health + PM2 only and note in handoff.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause. Goal = ship pilot-RDS vitest refuse + rehydrate git/EC2 parity + fixture deactivate + smoke evidence.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2 **only** through gate scripts that export `VITEST_ALLOW_PILOT_RDS=1` (after Task 2/3 land). Fixture deactivate SQL via SSM/psql. Rehydrate `--dry-run` only unless message counts regress.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, full unscoped vitest with sourced `.env.production`, bulk rehydrate `--triage`, CASCADE DELETE of fixture transports/messages, inventing S3 tarball overlays instead of commit+bundle sync.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [ ] Tasks 1–3: pilot RDS refuse in vitest setup + `test-db`; unit tests green; gates export `VITEST_ALLOW_PILOT_RDS=1` and use `pnpm exec vitest run`; wipe solution doc updated
- [ ] Task 4: rehydrate module/script/tests + `skipAiEnqueue` + CONCEPTS committed on `EC2-pilot`
- [ ] Task 5: EC2 HEAD matches laptop tip; `scripts/rehydrate-raw-mime.ts` + guard files present; optional rehydrate `--dry-run` exits 0
- [ ] Task 6: `active_example = 0` for `*@example.com`; Centurion + Nava still `is_active=true`; smoke doc has SQL
- [ ] Task 7: SQL smoke (Centurion volume ≫ 0; quarantine residuals poison-only); health + PM2 green; handoff written at `docs/superpowers/plans/handoff-reports/2026-07-27-pilot-rds-guard-ops-parity.md`
- [ ] No open blockers for “vitest cannot wipe pilot RDS again” goal

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

Typical wave: local Tasks 1–4 green + commit → `sync-ec2-git-bundle.sh` (Task 5) → SSM fixture SQL (Task 6) → SQL/health smoke + handoff (Task 7). Prefer `ops-deploy.sh` only if PM2/env bounce needed; this plan is mostly guard + docs + sync (no schema migrate).

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `apps/server-pilot/tests/helpers/pilot-rds-guard.ts` | Pure `isPilotProdDatabase` + `assertNotPilotProdDatabase` (no sockets). |
| `apps/server-pilot/tests/setup/refuse-pilot-rds.ts` | Vitest `setupFiles` entry: refuse pilot `DATABASE_URL` unless opt-in. |
| `apps/server-pilot/tests/helpers/test-db.ts` | Call assert before probe / `withTestDb` connect; keep rollback helper. |
| `apps/server-pilot/vitest.config.ts` | Register `setupFiles`. |
| `apps/server-pilot/tests/pilot-rds-guard.test.ts` | Unit tests for pure guard (fake URLs only). |
| `apps/server-pilot/deploy/mail-search-gate.sh` | Export opt-in before intentional RDS vitest. |
| `apps/server-pilot/deploy/fixture-loopback-gate.sh` | Export opt-in; switch to `pnpm exec vitest run`. |
| `apps/server-pilot/deploy/wire-gate.sh` | Export opt-in; switch to `pnpm exec vitest run`. |
| `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md` | Document live guard + opt-in + correct vitest invocation. |
| `apps/server-pilot/src/mail/ingest/rehydrate-raw-mime.ts` | Already written — commit. |
| `apps/server-pilot/scripts/rehydrate-raw-mime.ts` | Already written — commit. |
| `apps/server-pilot/tests/rehydrate-raw-mime.test.ts` | Already written — commit. |
| `apps/server-pilot/src/mail/ingest/store.ts` | `skipAiEnqueue` already present — commit. |
| `CONCEPTS.md` | Raw MIME rehydrate entry already present — commit if dirty. |
| `apps/server-pilot/deploy/navaai-real-mail-smoke.md` | Fixture deactivate SQL + post-guard smoke section. |
| `docs/superpowers/plans/handoff-reports/2026-07-27-pilot-rds-guard-ops-parity.md` | Create at end of execution. |

**Do not extract a shared prod module for benchmark yet** — copy the marker constant into the guard file with a `keep in sync with ingest-benchmark.ts` comment. Avoid dragging scripts into test imports.

---

### Task 1: Pure pilot-RDS guard + unit tests (TDD)

**Files:**
- Create: `apps/server-pilot/tests/helpers/pilot-rds-guard.ts`
- Create: `apps/server-pilot/tests/pilot-rds-guard.test.ts`
- Test: `apps/server-pilot/tests/pilot-rds-guard.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export const PILOT_PROD_DB_HOST = 'nava-zero-mail-pilot'`
  - `export function isPilotProdDatabase(databaseUrl: string): boolean`
  - `export function assertNotPilotProdDatabase(databaseUrl: string | undefined, env?: NodeJS.ProcessEnv): void`
  - Opt-in read: `env?.VITEST_ALLOW_PILOT_RDS === '1'` (default `process.env`)
  - On refuse: throw `Error` whose message includes `nava-zero-mail-pilot` and `VITEST_ALLOW_PILOT_RDS=1`

- [ ] **Step 1: Write the failing test**

Create `apps/server-pilot/tests/pilot-rds-guard.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  assertNotPilotProdDatabase,
  isPilotProdDatabase,
  PILOT_PROD_DB_HOST,
} from './helpers/pilot-rds-guard';

describe('pilot-rds-guard', () => {
  const pilotUrl =
    'postgresql://u:p@nava-zero-mail-pilot.abc123.af-south-1.rds.amazonaws.com:5432/zero';

  it('exports the same host marker as ingest-benchmark', () => {
    expect(PILOT_PROD_DB_HOST).toBe('nava-zero-mail-pilot');
  });

  it('detects pilot host via URL hostname', () => {
    expect(isPilotProdDatabase(pilotUrl)).toBe(true);
  });

  it('falls back to substring when URL parse fails', () => {
    expect(
      isPilotProdDatabase('not-a-url-but-has-nava-zero-mail-pilot-inside'),
    ).toBe(true);
  });

  it('allows non-pilot hosts', () => {
    expect(isPilotProdDatabase('postgresql://u:p@localhost:5432/zero')).toBe(
      false,
    );
    expect(
      isPilotProdDatabase(
        'postgresql://u:p@other-rds.abc.af-south-1.rds.amazonaws.com:5432/zero',
      ),
    ).toBe(false);
  });

  it('refuses pilot URL without opt-in', () => {
    expect(() =>
      assertNotPilotProdDatabase(pilotUrl, { VITEST_ALLOW_PILOT_RDS: '' }),
    ).toThrow(/VITEST_ALLOW_PILOT_RDS=1/);
  });

  it('allows pilot URL with opt-in', () => {
    expect(() =>
      assertNotPilotProdDatabase(pilotUrl, { VITEST_ALLOW_PILOT_RDS: '1' }),
    ).not.toThrow();
  });

  it('no-ops when DATABASE_URL unset / empty', () => {
    expect(() => assertNotPilotProdDatabase(undefined, {})).not.toThrow();
    expect(() => assertNotPilotProdDatabase('', {})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd apps/server-pilot
pnpm exec vitest run tests/pilot-rds-guard.test.ts
```

Expected: FAIL — `Cannot find module './helpers/pilot-rds-guard'` (or equivalent).

- [ ] **Step 3: Write minimal implementation**

Create `apps/server-pilot/tests/helpers/pilot-rds-guard.ts`:

```typescript
/**
 * Fail-closed guard so vitest cannot open/mutate the live pilot RDS.
 * Host marker kept in sync with scripts/ingest-benchmark.ts PILOT_PROD_DB_HOST.
 */
export const PILOT_PROD_DB_HOST = 'nava-zero-mail-pilot';

export function isPilotProdDatabase(databaseUrl: string): boolean {
  try {
    const host = new URL(databaseUrl).hostname;
    return host.includes(PILOT_PROD_DB_HOST);
  } catch {
    return databaseUrl.includes(PILOT_PROD_DB_HOST);
  }
}

/**
 * Throws if `databaseUrl` points at the pilot RDS and
 * `VITEST_ALLOW_PILOT_RDS=1` is not set. No-ops for unset/empty URL.
 */
export function assertNotPilotProdDatabase(
  databaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!databaseUrl) return;
  if (!isPilotProdDatabase(databaseUrl)) return;
  if (env.VITEST_ALLOW_PILOT_RDS === '1') return;

  let host = '(unparseable)';
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    /* keep fallback label */
  }

  throw new Error(
    `Refusing vitest against pilot RDS (${host}). ` +
      `Unset DATABASE_URL or use a disposable DB. ` +
      `Intentional gates only: set VITEST_ALLOW_PILOT_RDS=1 ` +
      `(marker: ${PILOT_PROD_DB_HOST}).`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd apps/server-pilot
pnpm exec vitest run tests/pilot-rds-guard.test.ts
```

Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/tests/helpers/pilot-rds-guard.ts \
  apps/server-pilot/tests/pilot-rds-guard.test.ts
git commit -m "$(cat <<'EOF'
test: add pure pilot RDS host refuse helper for vitest

EOF
)"
```

---

### Task 2: Wire guard into test-db + vitest setupFiles

**Files:**
- Create: `apps/server-pilot/tests/setup/refuse-pilot-rds.ts`
- Modify: `apps/server-pilot/tests/helpers/test-db.ts`
- Modify: `apps/server-pilot/vitest.config.ts`
- Test: `apps/server-pilot/tests/pilot-rds-guard.test.ts` (already green; re-run after wire)

**Interfaces:**
- Consumes: `assertNotPilotProdDatabase` from Task 1
- Produces: every vitest worker loads refuse before tests; `probeDb` / `withTestDb` also assert before `postgres()`

- [ ] **Step 1: Add setup file**

Create `apps/server-pilot/tests/setup/refuse-pilot-rds.ts`:

```typescript
/**
 * Vitest setupFiles entry: refuse pilot DATABASE_URL even when a suite
 * never imports withTestDb / test-db.ts (those suites wiped prod Jul 27).
 */
import { assertNotPilotProdDatabase } from '../helpers/pilot-rds-guard.js';

assertNotPilotProdDatabase(process.env.DATABASE_URL);
```

- [ ] **Step 2: Register setupFiles in vitest.config.ts**

Replace the `test` block in `apps/server-pilot/vitest.config.ts` so it includes `setupFiles`:

```typescript
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup/refuse-pilot-rds.ts'],
  },
  resolve: {
    alias,
  },
});
```

- [ ] **Step 3: Call assert inside test-db.ts**

At top of `apps/server-pilot/tests/helpers/test-db.ts`, after existing imports, add:

```typescript
import { assertNotPilotProdDatabase } from './pilot-rds-guard.js';
```

Immediately after `loadTestEnvFromDotenv();` (before `export const TEST_DB_AVAILABLE`):

```typescript
loadTestEnvFromDotenv();
assertNotPilotProdDatabase(process.env.DATABASE_URL);
```

Inside `probeDb`, as the first lines after the unset check:

```typescript
async function probeDb(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  assertNotPilotProdDatabase(process.env.DATABASE_URL);
  // ... existing postgres() ...
}
```

Inside `withTestDb`, immediately after the `DATABASE_URL required` throw:

```typescript
  assertNotPilotProdDatabase(process.env.DATABASE_URL);
```

Update the file header comment (top JSDoc) to mention the refuse:

```typescript
/**
 * Test DB helper: opens a drizzle postgres-js DB ...
 *
 * HARD REFUSE: if DATABASE_URL hostname contains `nava-zero-mail-pilot`
 * and `VITEST_ALLOW_PILOT_RDS` is not `1`, this module throws at load /
 * before connect. See tests/helpers/pilot-rds-guard.ts.
 * ...
 */
```

- [ ] **Step 4: Verify guard tests still pass (no pilot URL in env)**

Run:

```bash
cd apps/server-pilot
# Ensure local shell is not poisoned:
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/pilot-rds-guard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Smoke the refuse path with a one-liner (optional local, safe)**

Run:

```bash
cd apps/server-pilot
DATABASE_URL='postgresql://u:p@nava-zero-mail-pilot.example.rds.amazonaws.com:5432/zero' \
  pnpm exec vitest run tests/pilot-rds-guard.test.ts 2>&1 | head -40
```

Expected: FAIL at setup with message containing `VITEST_ALLOW_PILOT_RDS=1` (suite never reaches tests). Then confirm opt-in bypass:

```bash
DATABASE_URL='postgresql://u:p@nava-zero-mail-pilot.example.rds.amazonaws.com:5432/zero' \
  VITEST_ALLOW_PILOT_RDS=1 \
  pnpm exec vitest run tests/pilot-rds-guard.test.ts
```

Expected: PASS (fake host is unreachable for DB tests, but this file has no DB open — setup allows).

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/tests/setup/refuse-pilot-rds.ts \
  apps/server-pilot/tests/helpers/test-db.ts \
  apps/server-pilot/vitest.config.ts
git commit -m "$(cat <<'EOF'
fix: refuse pilot RDS host in vitest setup and test-db

EOF
)"
```

---

### Task 3: Gate scripts opt-in + wipe solution doc

**Files:**
- Modify: `apps/server-pilot/deploy/mail-search-gate.sh`
- Modify: `apps/server-pilot/deploy/fixture-loopback-gate.sh`
- Modify: `apps/server-pilot/deploy/wire-gate.sh`
- Modify: `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md`
- Optional modify: `apps/server-pilot/tests/deploy-config.test.ts` (assert gates export opt-in)

**Interfaces:**
- Consumes: Task 2 refuse (gates that source `.env.production` then run vitest must set opt-in or they hard-fail)
- Produces: documented intentional path for RDS-backed gates

- [ ] **Step 1: Patch mail-search-gate.sh**

After sourcing env / before vitest, add:

```bash
# Intentional RDS-backed gate — required after pilot-RDS vitest refuse.
export VITEST_ALLOW_PILOT_RDS=1
```

Place it immediately before `echo "== mail-search-gate: vitest =="`.

- [ ] **Step 2: Patch fixture-loopback-gate.sh**

1. After `export MAIL_TRANSPORT_MODE=fixture` (or immediately before vitest), add:

```bash
export VITEST_ALLOW_PILOT_RDS=1
```

2. Replace the dangerous `pnpm test …` block with scoped vitest:

```bash
echo "== vitest: fixture loopback suite =="
cd "$SERVER_PILOT"
pnpm exec vitest run \
  tests/fixture-loopback-e2e.test.ts \
  tests/fixture-loopback.test.ts \
  tests/seed-contract.test.ts \
  tests/mail-send.test.ts \
  tests/ingest-store.test.ts \
  tests/pop3-worker.test.ts \
  --reporter=dot
```

- [ ] **Step 3: Patch wire-gate.sh**

Same two changes: `export VITEST_ALLOW_PILOT_RDS=1` before vitest, and replace `pnpm test` with:

```bash
pnpm exec vitest run \
  tests/mailpit-lifecycle.test.ts \
  tests/mail-wire-e2e.test.ts \
  tests/transport-mode.test.ts \
  --reporter=dot
```

- [ ] **Step 4: Update wipe solution Prevention section**

In `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md`, replace the stub “Hard-block … (required — implement if absent)” code sample with the live contract:

```markdown
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
```

Also add under Related Issues / plans:

```markdown
- Ops parity plan: `docs/plans/2026-07-27-003-fix-pilot-rds-test-guard-and-ops-parity-plan.md`
- Detailed impl: `docs/superpowers/plans/2026-07-27-pilot-rds-test-guard-and-ops-parity.md`
```

- [ ] **Step 5: Optional — assert gates mention opt-in in deploy-config.test.ts**

If touching `deploy-config.test.ts`, add a focused test:

```typescript
  it('RDS vitest gates export VITEST_ALLOW_PILOT_RDS=1', () => {
    for (const name of [
      'mail-search-gate.sh',
      'fixture-loopback-gate.sh',
      'wire-gate.sh',
    ]) {
      const script = readFileSync(
        path.join(deployDir, name),
        'utf8',
      );
      expect(script).toContain('VITEST_ALLOW_PILOT_RDS=1');
      expect(script).toContain('pnpm exec vitest run');
    }
  });
```

(`deployDir` / `readFileSync` / `path` — reuse whatever that file already imports.)

- [ ] **Step 6: Run focused tests**

```bash
cd apps/server-pilot
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/pilot-rds-guard.test.ts tests/deploy-config.test.ts
```

Expected: PASS (or only the new gate assertion if Step 5 added).

- [ ] **Step 7: Commit**

```bash
git add apps/server-pilot/deploy/mail-search-gate.sh \
  apps/server-pilot/deploy/fixture-loopback-gate.sh \
  apps/server-pilot/deploy/wire-gate.sh \
  docs/solutions/database-issues/vitest-production-pilot-db-wipe.md
# plus deploy-config.test.ts if modified
git commit -m "$(cat <<'EOF'
fix: opt-in pilot RDS for intentional vitest gates

EOF
)"
```

---

### Task 4: Commit rehydrate + skipAiEnqueue + CONCEPTS

**Files:**
- Add (currently untracked): `apps/server-pilot/src/mail/ingest/rehydrate-raw-mime.ts`
- Add: `apps/server-pilot/scripts/rehydrate-raw-mime.ts`
- Add: `apps/server-pilot/tests/rehydrate-raw-mime.test.ts`
- Modify (already dirty): `apps/server-pilot/src/mail/ingest/store.ts` (`PersistOptions.skipAiEnqueue`)
- Modify (already dirty): `CONCEPTS.md` (Raw MIME rehydrate glossary)

**Interfaces:**
- Consumes: existing `persistInboundMessage` + `skipAiEnqueue?: boolean`
- Produces: committed tip that EC2 bundle sync can ship (AE3)

- [ ] **Step 1: Confirm skipAiEnqueue is present in store.ts**

Grep locally:

```bash
rg -n "skipAiEnqueue" apps/server-pilot/src/mail/ingest/store.ts
```

Expected: interface field + `if (!isHotelSent && !opts.skipAiEnqueue)` gate around `enqueueAiRun`.

- [ ] **Step 2: Run rehydrate unit tests**

```bash
cd apps/server-pilot
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/rehydrate-raw-mime.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit only these paths (atomic)**

```bash
git add \
  apps/server-pilot/src/mail/ingest/rehydrate-raw-mime.ts \
  apps/server-pilot/scripts/rehydrate-raw-mime.ts \
  apps/server-pilot/tests/rehydrate-raw-mime.test.ts \
  apps/server-pilot/src/mail/ingest/store.ts \
  CONCEPTS.md
git commit -m "$(cat <<'EOF'
feat: add S3 raw-MIME rehydrate with skipAiEnqueue persist flag

EOF
)"
```

Do **not** stage unrelated dirty files (deploy scripts, debug logs, other plans).

---

### Task 5: EC2 bundle sync + file presence check

**Files:**
- Run: `apps/server-pilot/deploy/sync-ec2-git-bundle.sh`
- Verify on EC2: `scripts/rehydrate-raw-mime.ts`, guard files, HEAD SHA

**Interfaces:**
- Consumes: committed tip from Tasks 1–4 on branch `EC2-pilot`
- Produces: AE3 — EC2 files match laptop tip

- [ ] **Step 1: Record laptop HEAD**

```bash
git rev-parse HEAD
git log -3 --oneline
```

- [ ] **Step 2: Sync bundle to EC2**

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
```

Expected: script exits 0; EC2 hard-resets to bundle tip.

- [ ] **Step 3: Confirm files + SHA on EC2 (SSM or SSH)**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && git rev-parse HEAD && test -f apps/server-pilot/scripts/rehydrate-raw-mime.ts && test -f apps/server-pilot/tests/helpers/pilot-rds-guard.ts && test -f apps/server-pilot/tests/setup/refuse-pilot-rds.ts && echo OK'
```

Expected: printed SHA matches laptop Step 1; ends with `OK`.

- [ ] **Step 4: Optional dry-run rehydrate (prove CLI; do not full re-run)**

On EC2 (prod env in **subshell only**):

```bash
(
  set -a && source /home/ubuntu/repos/zero/apps/server-pilot/.env.production && set +a
  cd /home/ubuntu/repos/zero/apps/server-pilot
  export INGEST_REQUIRE_OWNER_HEADER=false
  pnpm exec tsx scripts/rehydrate-raw-mime.ts --dry-run --limit 3
)
```

Expected: exits 0; summary line with `scanned=` / mostly `skipped_existing` if prior restore intact. **Do not** pass `--triage`.

- [ ] **Step 5: No commit** (ops verify only). If sync failed, fix and re-run Step 2 — do not invent a tarball overlay.

---

### Task 6: Deactivate `*@example.com` fixture transports

**Files:**
- Modify: `apps/server-pilot/deploy/navaai-real-mail-smoke.md` (paste SQL + verify)
- Modify: `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md` (ensure deactivate step still listed)

**Interfaces:**
- Consumes: live pilot DB (ops, not vitest)
- Produces: AE4 — zero active `*@example.com` transports; Centurion + Nava still active

- [ ] **Step 1: Add runbook section to navaai-real-mail-smoke.md**

Append (or insert near post-cutover checks):

```markdown
## Post-wipe / fixture cleanup

Deactivate leftover vitest fixture transports (do **not** DELETE):

```sql
UPDATE mailbox_transport SET is_active = false WHERE email LIKE '%@example.com';

SELECT id, email, is_active FROM mailbox_transport ORDER BY email;

SELECT count(*) AS active_example
FROM mailbox_transport
WHERE email LIKE '%@example.com' AND is_active;

SELECT count(*) AS orphan_fixture_messages
FROM message m
JOIN mailbox_transport t ON m.transport_id = t.id
WHERE t.email LIKE '%@example.com';
```

Expect `active_example = 0`. Centurion + Nava rows `is_active = true`. Orphan fixture message count may be >0 — leave them; CASCADE delete is out of scope.
```

- [ ] **Step 2: Run the UPDATE on pilot RDS (ops)**

Use whatever the team already uses for SQL (psql via SSM, etc.). Exact statements from Step 1.

- [ ] **Step 3: Verify AE4**

```sql
SELECT count(*) FROM mailbox_transport
WHERE email LIKE '%@example.com' AND is_active;
```

Expected: `0`.

```sql
SELECT email, is_active FROM mailbox_transport
WHERE email NOT LIKE '%@example.com'
ORDER BY email;
```

Expected: Centurion + Nava (and any other real pilots) with `is_active=true`.

- [ ] **Step 4: Commit doc only**

```bash
git add apps/server-pilot/deploy/navaai-real-mail-smoke.md \
  docs/solutions/database-issues/vitest-production-pilot-db-wipe.md
git commit -m "$(cat <<'EOF'
docs: fixture transport deactivate SQL for post-wipe ops

EOF
)"
```

Then re-run Task 5 sync if EC2 needs the doc (optional; SQL already applied).

---

### Task 7: SQL + human smoke checklist + handoff

**Files:**
- Create: `docs/superpowers/plans/handoff-reports/2026-07-27-pilot-rds-guard-ops-parity.md`
- Modify: `docs/superpowers/plans/handoff-reports/2026-07-27-unstamped-centurion-overnight.md` (residuals → done/partial)

**Interfaces:**
- Consumes: Tasks 1–6 complete on box
- Produces: AE5 checklist ticks; Definition of Done evidence

- [ ] **Step 1: Run SQL smoke**

```sql
-- Active transports
SELECT email, is_active FROM mailbox_transport ORDER BY email;

-- Message volume by transport
SELECT t.email, m.direction, count(*)
FROM message m
JOIN mailbox_transport t ON m.transport_id = t.id
GROUP BY t.email, m.direction
ORDER BY t.email, m.direction;

-- Quarantine residuals
SELECT reason, count(*) FROM mail_ingest_quarantine GROUP BY reason;

-- Newest Centurion subjects (non-empty)
SELECT left(coalesce(subject, ''), 60), created_at
FROM message m
JOIN mailbox_transport t ON m.transport_id = t.id
WHERE t.email ILIKE '%centurion%'
ORDER BY created_at DESC
LIMIT 10;
```

Expected: Centurion message count ≫ 0; `missing_owner_header` only poison/non-equated residuals (not bulk equated BCC).

- [ ] **Step 2: Human / ops checklist**

On EC2:

```bash
curl -sS http://127.0.0.1:8788/health
pm2 status
# Confirm in .env.production (read-only):
#   INGEST_REQUIRE_OWNER_HEADER=false
#   MAIL_TRANSPORT_MODE=real
#   AI_WRITE_GATE_ENABLED=true
```

SPA (VPN): Centurion folder shows restored subjects; Nava shows direct-To tests.

Optional live: send one equated Centurion BCC → lands Centurion, **not** `missing_owner_header` quarantine.

- [ ] **Step 3: Write handoff report**

Create `docs/superpowers/plans/handoff-reports/2026-07-27-pilot-rds-guard-ops-parity.md` with:

- What landed (guard, gates, rehydrate commit, sync SHA, fixture deactivate)
- SQL counts snapshot
- Checklist ticks
- Residuals / deferred (Testcontainers, CASCADE delete, Zimbra stamp/strip)
- Pointer to wipe solution + this plan

- [ ] **Step 4: Update overnight handoff residuals**

In `docs/superpowers/plans/handoff-reports/2026-07-27-unstamped-centurion-overnight.md`, mark the “hard-refuse pilot RDS / commit rehydrate / fixture cleanup” residuals as done (or link to the new handoff).

- [ ] **Step 5: Commit handoff docs**

```bash
git add docs/superpowers/plans/handoff-reports/2026-07-27-pilot-rds-guard-ops-parity.md \
  docs/superpowers/plans/handoff-reports/2026-07-27-unstamped-centurion-overnight.md
git commit -m "$(cat <<'EOF'
docs: handoff for pilot RDS vitest guard and ops parity

EOF
)"
```

- [ ] **Step 6: Final local guard regression**

```bash
cd apps/server-pilot
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/pilot-rds-guard.test.ts tests/rehydrate-raw-mime.test.ts
```

Expected: PASS.

---

## Self-Review

1. **Spec coverage:** R1–R8 / AE1–AE5 / U1–U4 from `2026-07-27-003` map to Tasks 1–7. Deferred items (Testcontainers, CASCADE delete, `--triage`, Zimbra stamp) explicitly out of steps.
2. **Placeholder scan:** No TBD / “add validation” / “similar to Task N” without code.
3. **Type consistency:** `assertNotPilotProdDatabase(url, env?)`, `VITEST_ALLOW_PILOT_RDS`, marker `nava-zero-mail-pilot` used consistently; `skipAiEnqueue` / rehydrate CLI unchanged.

---

## Execution Mode (reminder)

Autonomous overnight — no user checkpoint. Subagent-driven per task. See mandate above for infra, RCA, and done criteria.
