# Nava Mailbox Switcher Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Nava multi-mailbox switcher: verify shipped seed grants safely, enable FE gate for 2+ connections, apply seed on EC2 without password rotate, smoke + handoff.

**Architecture:** Task 1 seed (`applyPilotMailboxAccess` in `50bc65f1`) already grants Nava owner on every active transport and Centurion-only for Centurion. Remaining work is FE `canManageConnections(n) => n > 1` wired into `nav-user`, then intentional `seed:prod` (no `--rotate`) + SQL/UI smoke. **Never** run vitest against pilot RDS.

**Tech Stack:** Drizzle/Postgres (`apps/server-pilot`), tRPC `connections`, React SPA (`apps/mail`), Vitest (unit / rollback-only, never pilot host).

**Supersedes for remaining work:** [2026-07-27-nava-mailbox-switcher-grants.md](./2026-07-27-nava-mailbox-switcher-grants.md)  
**Spec:** [docs/plans/2026-07-27-004-feat-nava-mailbox-switcher-grants-plan.md](../../plans/2026-07-27-004-feat-nava-mailbox-switcher-grants-plan.md)  
**Wipe policy:** [docs/solutions/database-issues/vitest-production-pilot-db-wipe.md](../../solutions/database-issues/vitest-production-pilot-db-wipe.md)  
**Eng+ponytail review (auto):** `~/.gstack/projects/kufupa-Zero/gamin-EC2-pilot-eng-review-20260729-124053.md`

## Global Constraints

- No schema migration — only `mailbox_access` / `is_default` behavior + FE gate.
- No admin grant UI; no OAuth add-connection.
- Do not rotate pilot passwords on EC2 (`seed:prod` without `--rotate`).
- Keep `user-centurion` + `centurion@legacyhotels.co.za` login.
- `transport-centurion` has **two** access rows (Nava + Centurion).
- **Never** vitest against hostname containing `nava-zero-mail-pilot`. No `VITEST_ALLOW_PILOT_RDS=1` for this feature. Unset `DATABASE_URL` for local vitest (or disposable non-pilot DB only).
- Live grant proof = `CONFIRM_PILOT_SEED=1 pnpm seed:prod` + SQL smoke — **not** DB-gated vitest suites.
- Touch **only** files listed per task. Do not commit unrelated WIP (revenue queues, 1pager, logs, VPN).
- **Models:** standard (non-fast) only for every subagent/orchestrator dispatch. Never `composer-2.5-fast` or any `*-fast` slug. Prefer `composer-2.5` (or session-equivalent standard).

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

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

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (**no `--rotate`**), SSM SQL/health curl, PM2 logs, **unit** vitest with `DATABASE_URL` unset.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, **any vitest with pilot `DATABASE_URL`**, `VITEST_ALLOW_PILOT_RDS=1` for this feature, `pnpm --filter @zero/server test` on EC2 with prod env.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [ ] Task 1: safe local vitest (guard + identity; DB suites skip) + `seedAll` JSDoc fix; ledger marks seed Task complete
- [ ] Task 2: `canManageConnections` + `nav-user` gate; unit tests green
- [ ] Task 3: CONCEPTS OK (already aligned — verify only); EC2 deploy + `CONFIRM_PILOT_SEED=1 pnpm seed:prod` **without** `--rotate`; SQL + UI smoke
- [ ] Handoff: `docs/superpowers/plans/handoff-reports/2026-07-29-nava-mailbox-switcher-finish.md`
- [ ] No pilot vitest ran during this plan

### Typical overnight wave

```text
local: unset DATABASE_URL → safe vitest → FE unit tests → commits
→ ops-deploy.sh (ship FE + server tip)
→ SSM: CONFIRM_PILOT_SEED=1 pnpm seed:prod   # NO --rotate, NOT vitest
→ SSM: SQL smoke (Nava ≥2 grants incl centurion; Centurion =1)
→ handoff report
```

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"  
**Subagent models: standard only (no fast variants).**

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/db/seed.ts` | Already has `applyPilotMailboxAccess`; Task 1 only fixes stale `seedAll` JSDoc |
| `apps/server-pilot/tests/pilot-rds-guard.test.ts` | Safe unit verify of refuse |
| `apps/server-pilot/tests/seed-contract.test.ts` | Identity constants pass; DB blocks skip without disposable DB |
| `apps/mail/lib/mail/can-manage-connections.ts` | `canManageConnections(count): boolean` |
| `apps/mail/tests/can-manage-connections.test.ts` | Unit tests |
| `apps/mail/components/ui/nav-user.tsx` | Wire gate to `data.connections.length` |
| `CONCEPTS.md` | Verify Mailbox access / switcher (expect no edit) |
| `.superpowers/sdd/progress.md` | Ledger for this plan |
| `docs/superpowers/plans/handoff-reports/2026-07-29-nava-mailbox-switcher-finish.md` | Handoff |

---

### Task 1: Safe verify shipped seed + JSDoc

**Files:**
- Modify: `apps/server-pilot/src/db/seed.ts` (JSDoc only)
- Test: `apps/server-pilot/tests/pilot-rds-guard.test.ts`, `tests/seed-contract.test.ts`, `tests/auth-context.test.ts`, `tests/connections-default.test.ts`
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes: shipped `applyPilotMailboxAccess(db: DB): Promise<void>` (commit `50bc65f1`)
- Produces: accurate `seedAll` JSDoc; ledger line for seed complete

- [ ] **Step 1: Fix stale seedAll JSDoc**

In `apps/server-pilot/src/db/seed.ts`, replace the `seedAll` docblock sentence that claims it prunes `mailbox_access` not in `PILOT_USERS` with wording that matches reality:

```ts
/**
 * Seed all pilot rows against the given DB handle.
 *
 * Idempotent: re-running upserts rows. The DB handle may be a normal
 * connection (production) or a transaction-scoped handle (tests with
 * rollback). Prunes auth users not in PILOT_USERS; mailbox_access for
 * pilot users is rebuilt by applyPilotMailboxAccess.
 */
```

- [ ] **Step 2: Safe vitest (DATABASE_URL unset)**

```bash
cd apps/server-pilot
unset DATABASE_URL
pnpm exec vitest run \
  tests/pilot-rds-guard.test.ts \
  tests/seed-contract.test.ts \
  tests/auth-context.test.ts \
  tests/connections-default.test.ts \
  --reporter=dot
```

Expected: guard + identity constants **pass**; DB `describe.skipIf` suites **skip** (not fail). If any test **fails** (not skip) because pilot URL leaked into env → STOP, unset, do not set opt-in.

- [ ] **Step 3: Ledger**

Append to `.superpowers/sdd/progress.md`:

```markdown
## nava-mailbox-switcher-finish
Plan: docs/superpowers/plans/2026-07-29-nava-mailbox-switcher-finish.md
Started: 2026-07-29
Branch: EC2-pilot
Seed already shipped: 50bc65f1
Task 1: complete (safe vitest + JSDoc; Important RDS-green waived — wipe policy; live proof Task 3)
```

- [ ] **Step 4: Commit**

```bash
git add apps/server-pilot/src/db/seed.ts
git commit -m "$(cat <<'EOF'
docs(seed): clarify seedAll vs applyPilotMailboxAccess JSDoc

EOF
)"
```

Do not stage `.superpowers/sdd/progress.md` unless repo tracks it (usually gitignored scratch — leave untracked).

---

### Task 2: FE connection-management gate (TDD)

**Files:**
- Create: `apps/mail/lib/mail/can-manage-connections.ts`
- Create: `apps/mail/tests/can-manage-connections.test.ts`
- Modify: `apps/mail/components/ui/nav-user.tsx`

**Interfaces:**
- Consumes: `connections` array length from `useConnections()` (`data`)
- Produces: `export function canManageConnections(connectionCount: number): boolean`

- [ ] **Step 1: Write the failing unit test**

Create `apps/mail/tests/can-manage-connections.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canManageConnections } from '@/lib/mail/can-manage-connections';

describe('canManageConnections', () => {
  it('is false for 0 or 1 connection', () => {
    expect(canManageConnections(0)).toBe(false);
    expect(canManageConnections(1)).toBe(false);
  });

  it('is true for 2+ connections', () => {
    expect(canManageConnections(2)).toBe(true);
    expect(canManageConnections(5)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --dir apps/mail exec vitest run tests/can-manage-connections.test.ts --reporter=dot
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mail/lib/mail/can-manage-connections.ts`:

```ts
/** Show mailbox switcher chrome only when the user can actually switch. */
export function canManageConnections(connectionCount: number): boolean {
  return connectionCount > 1;
}
```

In `apps/mail/components/ui/nav-user.tsx`:

1. Add import:

```ts
import { canManageConnections } from '@/lib/mail/can-manage-connections';
```

2. Replace:

```ts
  const allowConnectionManagement = false;
```

with:

```ts
  const allowConnectionManagement = canManageConnections(data?.connections?.length ?? 0);
```

(`data` already comes from `useConnections()` earlier in the component.)

Do not change `handleAccountSwitch` or demo-mode early returns.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --dir apps/mail exec vitest run tests/can-manage-connections.test.ts --reporter=dot
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/can-manage-connections.ts apps/mail/tests/can-manage-connections.test.ts apps/mail/components/ui/nav-user.tsx
git commit -m "$(cat <<'EOF'
feat(mail): show mailbox switcher when user has 2+ connections

EOF
)"
```

---

### Task 3: CONCEPTS verify + EC2 seed/smoke + handoff

**Files:**
- Verify: `CONCEPTS.md` (expect no edit — already says 2+ connections)
- Create: `docs/superpowers/plans/handoff-reports/2026-07-29-nava-mailbox-switcher-finish.md`

**Interfaces:** none

- [ ] **Step 1: Verify CONCEPTS**

Confirm **Mailbox access** and **Mailbox switcher** say access rows drive `connections.list` and switcher shown when 2+ connections. If wrong, fix; if OK, no commit.

- [ ] **Step 2: Deploy tip to EC2**

Ship commits from Tasks 1–2 via normal `ops-deploy.sh` (or bundle sync + deploy). Confirm mail SPA + server tip include FE gate + seed helper.

- [ ] **Step 3: Seed without rotate**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'set -euo pipefail
export NVM_DIR=/home/ubuntu/.nvm; . "$NVM_DIR/nvm.sh"
cd /home/ubuntu/repos/zero/apps/server-pilot
set -a; source .env.production; set +a
export CONFIRM_PILOT_SEED=1
pnpm seed:prod
'
```

Expected: both pilot emails in stdout; **no** `--rotate`.

**Do not** run vitest in this SSM session.

- [ ] **Step 4: SQL smoke (read)**

Via SSM + node/psql against RDS (ops pattern already used on box), assert:

- `user-navaai` `mailbox_access` count ≥ 2 and includes `transport-centurion`
- `user-centurion` `mailbox_access` count = 1 on `transport-centurion`
- `transport-centurion` has exactly 2 owner rows (Nava + Centurion)

- [ ] **Step 5: UI smoke**

- Login `navaai@legacyhotels.co.za` → switcher shows Centurion → switch → Centurion threads
- Login `centurion@legacyhotels.co.za` → no multi-avatar switcher

- [ ] **Step 6: Handoff report**

Write `docs/superpowers/plans/handoff-reports/2026-07-29-nava-mailbox-switcher-finish.md` with: commits, seed command used, SQL counts, UI smoke results, note that pilot vitest was not run (wipe policy), any divergences.

```bash
git add docs/superpowers/plans/handoff-reports/2026-07-29-nava-mailbox-switcher-finish.md
git commit -m "$(cat <<'EOF'
docs: handoff nava mailbox switcher finish

EOF
)"
```

If CONCEPTS changed, include it in the same or prior commit.

---

## Self-review

| Spec item | Task |
|-----------|------|
| R1 switcher when 2+ | Task 2 |
| R2 existing setDefault | Task 2 (no API change) |
| R3–R7 Nava auto-grant + Centurion-only | Shipped `50bc65f1`; proven Task 3 SQL |
| R8 keep Centurion login / no rotate | Task 3 |
| Wipe-safe verification | Task 1 + Global Constraints |
| No admin UI / OAuth | Global constraints |
| Standard models only | Global Constraints + Execution Mode |

Placeholder scan: none.  
Type consistency: `applyPilotMailboxAccess(db: DB): Promise<void>`; `canManageConnections(connectionCount: number): boolean`.
