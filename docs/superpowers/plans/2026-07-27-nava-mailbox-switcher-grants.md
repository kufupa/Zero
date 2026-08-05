# Nava Multi-Mailbox Switcher + Auto-Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nava AI can switch across every active hotel mailbox in the SPA; Centurion login stays Centurion-only; switcher chrome appears only when the user has 2+ grants.

**Architecture:** Reuse RDS `mailbox_access` + existing `connections.list` / `setDefault`. Change seed so Nava gets an owner row on every **active** `mailbox_transport` (auto-picks up future hotels on re-seed). Centurion user keeps a single Centurion row. FE replaces the hard `allowConnectionManagement = false` with `connections.length > 1`.

**Tech Stack:** Drizzle + Postgres (`apps/server-pilot`), Better Auth pilot users, tRPC `connections` router, React SPA (`apps/mail` / `nav-user.tsx`), Vitest.

**Spec source:** [docs/plans/2026-07-27-004-feat-nava-mailbox-switcher-grants-plan.md](../../plans/2026-07-27-004-feat-nava-mailbox-switcher-grants-plan.md)

## Global Constraints

- No schema migration — only `mailbox_access` / `is_default` behavior change.
- No admin grant UI; no OAuth add-connection.
- Do not rotate pilot passwords on EC2 apply (`seed:prod` without `--rotate`).
- Keep `user-centurion` + `centurion@legacyhotels.co.za` login.
- Nava must be auto-granted on **future** active transports created inside `seedAll` without editing a static Nava transport id list.
- Centurion transport will have **two** access rows after this change (Nava + Centurion) — update tests that currently expect exactly one row on that transport.

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

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [ ] Task 1: `applyPilotMailboxAccess` + seed/auth contract tests green (Nava all active; Centurion-only; third-transport auto-grant)
- [ ] Task 2: `canManageConnections` + `nav-user` gate; unit tests green
- [ ] Task 3: CONCEPTS OK; EC2 `CONFIRM_PILOT_SEED=1 pnpm seed:prod` **without** `--rotate`
- [ ] Live smoke: Nava login shows switcher incl. Centurion; Centurion login has no multi-switcher chrome
- [ ] Handoff report: `docs/superpowers/plans/handoff-reports/2026-07-27-nava-mailbox-switcher-grants.md`

### Typical overnight wave

```text
local: tests green → commit → push/sync EC2-pilot
→ ops-deploy.sh
→ SSM: CONFIRM_PILOT_SEED=1 pnpm seed:prod (no --rotate)
→ SSM: vitest seed-contract + auth-context (+ mail can-manage-connections)
→ handoff report under docs/superpowers/plans/handoff-reports/
```

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/db/seed.ts` | Export `applyPilotMailboxAccess(db)`; call from `seedAll`; remove static Nava-only `ACCESS_ROWS` exclusivity |
| `apps/server-pilot/tests/seed-contract.test.ts` | Assert Nava multi-grant + Centurion-only + third-transport auto-grant |
| `apps/server-pilot/tests/auth-context.test.ts` | Nava may resolve Centurion transport again |
| `apps/mail/lib/mail/can-manage-connections.ts` | Pure gate `canManageConnections(connectionCount)` |
| `apps/mail/tests/can-manage-connections.test.ts` | Unit tests for the gate |
| `apps/mail/components/ui/nav-user.tsx` | Wire gate to `data.connections.length` |
| `CONCEPTS.md` | Already has Mailbox access / Mailbox switcher — verify wording matches ship |

---

### Task 1: Extract seed grant helper + failing auto-grant tests

**Files:**
- Modify: `apps/server-pilot/src/db/seed.ts`
- Modify: `apps/server-pilot/tests/seed-contract.test.ts`
- Modify: `apps/server-pilot/tests/auth-context.test.ts`

**Interfaces:**
- Consumes: existing `seedAll`, `NAVA_USER_ID`, `CENTURION_USER_ID`, `NAVA_TRANSPORT_ID`, `TRANSPORT_ID`, `pilotUserIds()`, Drizzle `db`
- Produces: `export async function applyPilotMailboxAccess(db: DB): Promise<void>` — deletes pilot users' `mailbox_access`, inserts Nava owner on every `mailbox_transport` where `isActive === true` (`isDefault` true only for `NAVA_TRANSPORT_ID`), inserts Centurion owner only on `TRANSPORT_ID` (`isDefault` true)

- [ ] **Step 1: Write the failing seed-contract expectations**

Replace / update tests in `apps/server-pilot/tests/seed-contract.test.ts`:

1. Rename/replace `'seeds transport-nava; navaai owns nava only, centurion owns centurion only'` with:

```ts
it(
  'seeds Nava owner on every active transport; Centurion owns Centurion only',
  async () => {
    const result = await withSeededTestDb(async (db) => {
      const active = await db
        .select({ id: mailboxTransport.id })
        .from(mailboxTransport)
        .where(eq(mailboxTransport.isActive, true));
      const access = await db
        .select({
          userId: mailboxAccess.userId,
          transportId: mailboxAccess.transportId,
          role: mailboxAccess.role,
          isDefault: mailboxAccess.isDefault,
        })
        .from(mailboxAccess);
      return { activeIds: active.map((r) => r.id).sort(), access };
    });

    const navaRows = result.access.filter((r) => r.userId === NAVA_USER_ID);
    expect(navaRows).toHaveLength(result.activeIds.length);
    expect(navaRows.map((r) => r.transportId).sort()).toEqual(result.activeIds);
    expect(navaRows.every((r) => r.role === 'owner')).toBe(true);
    expect(navaRows.find((r) => r.transportId === 'transport-nava')?.isDefault).toBe(true);
    expect(navaRows.filter((r) => r.isDefault)).toHaveLength(1);

    const cenRows = result.access.filter((r) => r.userId === CENTURION_USER_ID);
    expect(cenRows).toEqual([
      {
        userId: CENTURION_USER_ID,
        transportId: 'transport-centurion',
        role: 'owner',
        isDefault: true,
      },
    ]);
  },
  30000,
);
```

2. Replace `'seeds exactly one mailbox_access row on transport-centurion for centurion owner'` with:

```ts
it(
  'transport-centurion has Nava + Centurion owner rows',
  async () => {
    const access = await withSeededTestDb(async (db) => {
      return db
        .select({
          userId: mailboxAccess.userId,
          role: mailboxAccess.role,
        })
        .from(mailboxAccess)
        .where(eq(mailboxAccess.transportId, 'transport-centurion'));
    });
    expect(access).toHaveLength(2);
    expect(access).toEqual(
      expect.arrayContaining([
        { userId: NAVA_USER_ID, role: 'owner' },
        { userId: CENTURION_USER_ID, role: 'owner' },
      ]),
    );
  },
  30000,
);
```

3. Add auto-grant future-transport test (uses exported helper):

```ts
it(
  'applyPilotMailboxAccess grants Nava a new active transport without static ACCESS_ROWS edit',
  async () => {
    const { applyPilotMailboxAccess } = await import('../src/db/seed.js');
    const outcome = await withSeededTestDb(async (db) => {
      await db.insert(mailboxTransport).values({
        id: 'transport-davinci',
        email: 'davinci@legacyhotels.co.za',
        ownerHeaderValue: 'davinci@legacyhotels.co.za',
        mailboxType: 'personal',
        displayName: 'Da Vinci Transport',
        isActive: true,
      });
      await applyPilotMailboxAccess(db);
      const nava = await db
        .select({ transportId: mailboxAccess.transportId })
        .from(mailboxAccess)
        .where(eq(mailboxAccess.userId, NAVA_USER_ID));
      const cen = await db
        .select({ transportId: mailboxAccess.transportId })
        .from(mailboxAccess)
        .where(eq(mailboxAccess.userId, CENTURION_USER_ID));
      return { navaIds: nava.map((r) => r.transportId).sort(), cenIds: cen.map((r) => r.transportId) };
    });
    expect(outcome.navaIds).toContain('transport-davinci');
    expect(outcome.navaIds).toContain('transport-nava');
    expect(outcome.navaIds).toContain('transport-centurion');
    expect(outcome.cenIds).toEqual(['transport-centurion']);
  },
  30000,
);
```

4. In `apps/server-pilot/tests/auth-context.test.ts`, replace the FORBIDDEN navaai-on-centurion test with:

```ts
it(
  'returns owner access for navaai on Centurion transport',
  async () => {
    const ctx = await withSeededTestDb((db) =>
      resolveMailboxContext('user-navaai', 'transport-centurion', db),
    );
    expect(ctx.userId).toBe('user-navaai');
    expect(ctx.activeTransportId).toBe('transport-centurion');
    expect(ctx.transportEmail).toBe('centurion@legacyhotels.co.za');
    expect(ctx.accessRole).toBe('owner');
  },
  30000,
);
```

Keep the Centurion-user-on-Centurion test and the default-to-nava test unchanged.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --dir apps/server-pilot exec vitest run tests/seed-contract.test.ts tests/auth-context.test.ts --reporter=dot
```

Expected: FAIL — Nava missing Centurion grant; `applyPilotMailboxAccess` not exported; auth FORBIDDEN test expectations inverted / new test fails.

- [ ] **Step 3: Implement `applyPilotMailboxAccess` and call it from `seedAll`**

In `apps/server-pilot/src/db/seed.ts`:

1. Remove or stop using static `ACCESS_ROWS` for the insert loop (keep type if useful; comment that Centurion exclusivity is enforced in `applyPilotMailboxAccess`).

2. Add:

```ts
/** Nava owns every active transport; Centurion owns Centurion only. */
export async function applyPilotMailboxAccess(db: DB): Promise<void> {
  const keepIds = pilotUserIds();
  await db.delete(mailboxAccess).where(inArray(mailboxAccess.userId, keepIds));

  const active = await db
    .select({ id: mailboxTransport.id })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));

  for (const transport of active) {
    await db.insert(mailboxAccess).values({
      id: `access-${NAVA_USER_ID}-${transport.id}`,
      userId: NAVA_USER_ID,
      transportId: transport.id,
      role: 'owner',
      isDefault: transport.id === NAVA_TRANSPORT_ID,
    });
  }

  await db.insert(mailboxAccess).values({
    id: `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`,
    userId: CENTURION_USER_ID,
    transportId: TRANSPORT_ID,
    role: 'owner',
    isDefault: true,
  });
}
```

3. In `seedAll`, replace the ACCESS_ROWS insert block with:

```ts
  const keepIds = pilotUserIds();
  await db.delete(userTable).where(notInArray(userTable.id, keepIds));
  await applyPilotMailboxAccess(db);
```

(Do **not** double-delete access: `applyPilotMailboxAccess` already deletes pilot access. Remove the old `delete(mailboxAccess)` + `ACCESS_ROWS` loop.)

4. Update the comment above former `ACCESS_ROWS` to:

```ts
/** @deprecated Prefer applyPilotMailboxAccess — kept only if tests still import AccessRowSpec. */
```

If nothing imports `ACCESS_ROWS`, delete the constant entirely to avoid drift.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --dir apps/server-pilot exec vitest run tests/seed-contract.test.ts tests/auth-context.test.ts tests/connections-default.test.ts --reporter=dot
```

Expected: PASS (skip DB-gated suites if `TEST_DB_AVAILABLE` false locally — run on EC2/RDS if needed).

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/db/seed.ts apps/server-pilot/tests/seed-contract.test.ts apps/server-pilot/tests/auth-context.test.ts
git commit -m "$(cat <<'EOF'
feat(pilot): auto-grant Nava access on all active mailbox transports

EOF
)"
```

---

### Task 2: FE connection-management gate (TDD)

**Files:**
- Create: `apps/mail/lib/mail/can-manage-connections.ts`
- Create: `apps/mail/tests/can-manage-connections.test.ts`
- Modify: `apps/mail/components/ui/nav-user.tsx`

**Interfaces:**
- Consumes: `connections` array length from `useConnections()`
- Produces: `export function canManageConnections(connectionCount: number): boolean` — `return connectionCount > 1`

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

### Task 3: CONCEPTS verify + EC2 apply note (no password rotate)

**Files:**
- Modify: `CONCEPTS.md` only if wording drifts from ship
- No new runbook file required — leave ops steps in this task

**Interfaces:** none

- [ ] **Step 1: Verify CONCEPTS entries**

Open `CONCEPTS.md` and confirm sections **Mailbox access** and **Mailbox switcher** exist and say:

- access rows drive `connections.list`
- switcher shown when 2+ connections

If missing or wrong, fix in place (same headings).

- [ ] **Step 2: Apply on EC2 after code sync (manual ops — do after Tasks 1–2 land on box)**

```bash
# from laptop: sync branch / hotfix as you normally deploy EC2-pilot
bash apps/server-pilot/deploy/ssm-run-command.sh 'set -euo pipefail
export NVM_DIR=/home/ubuntu/.nvm; . "$NVM_DIR/nvm.sh"
cd /home/ubuntu/repos/zero/apps/server-pilot
set -a; source .env.production; set +a
export CONFIRM_PILOT_SEED=1
pnpm seed:prod
'
```

Expected stdout includes both pilot emails and does **not** require `--rotate`.

Then verify SQL (via SSM node/postgres as before):

- `user-navaai` access rows ≥ 2 including `transport-centurion`
- `user-centurion` access rows = 1 on `transport-centurion`

Browser:

- Login `navaai@legacyhotels.co.za` → switcher shows Centurion → switch → Centurion threads
- Login `centurion@legacyhotels.co.za` → no multi-avatar switcher

- [ ] **Step 3: Commit CONCEPTS only if changed**

```bash
git add CONCEPTS.md
git commit -m "$(cat <<'EOF'
docs(concepts): align mailbox access and switcher glossary

EOF
)"
```

Skip commit if CONCEPTS unchanged.

---

## Self-review

| Spec item | Task |
|-----------|------|
| R1 switcher when 2+ | Task 2 |
| R2 existing setDefault | Task 2 (no API change) |
| R3–R7 Nava auto-grant + Centurion-only | Task 1 |
| R8 keep Centurion login / no rotate | Task 3 |
| AE1–AE5 | Task 1–2 tests + Task 3 smoke |
| No admin UI / OAuth | Global constraints — not tasked |

Placeholder scan: none intentional.

Type consistency: `applyPilotMailboxAccess(db: DB): Promise<void>`; `canManageConnections(connectionCount: number): boolean`.
