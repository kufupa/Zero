---
title: Nava Mailbox Switcher Finish — Wipe-Safe EC2 Pilot Verify Path
date: 2026-07-29
category: workflow-issues
module: "server-pilot mailbox access / mail SPA / EC2 pilot ops"
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Finishing multi-mailbox switcher or mailbox_access seed changes on EC2-pilot
  - Task review or CI pressure asks for green via Vitest against pilot RDS
  - Verifying Nava owner-on-all-transports and Centurion Centurion-only grants after seed:prod
  - Wiring FE canManageConnections and proving connections.list without browser VPN
symptoms:
  - Reviewer expects EC2 Vitest against pilot RDS as proof the mailbox-switcher finish is green
  - VITEST_ALLOW_PILOT_RDS=1 or sourced .env.production DATABASE_URL during unit/guard runs risks wiping live mail
  - Single-inbox personas must hide switcher; Nava with 2+ grants must show it
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - testing_framework
  - database
  - authentication
  - email_processing
  - tooling
tags:
  - mailbox-switcher
  - mailbox-access
  - ec2-pilot
  - wipe-safe-verify
  - seed-prod
  - vitest
  - nava
  - can-manage-connections
---

# Nava Mailbox Switcher Finish — Wipe-Safe EC2 Pilot Verify Path

## Context

Hotel mail pilot needed **Nava** (`navaai@legacyhotels.co.za`) to switch across granted hotel mailboxes in the SPA, while **Centurion** stayed a single-inbox persona. Backend already had `mailbox_access` + `connections.list` / `setDefault`. After Centurion got its own login, seed briefly became 1:1 (Nava→Nava only), so even flipping the FE hard-off would not give Nava a useful multi-row switcher.

Finishing the feature meant: (1) seed auto-grant Nava on every **active** transport, (2) FE gate `canManageConnections(n) => n > 1`, (3) live proof on EC2. The dangerous trap: task review / overnight plans asked for “green” via **Vitest against pilot RDS** — the same path that wiped live mail on 2026-07-27.

## Guidance

### Seed grants

`applyPilotMailboxAccess` in `apps/server-pilot/src/db/seed.ts` rebuilds pilot `mailbox_access`:

- Nava = owner on every `mailbox_transport` where `isActive === true` (default only on Nava transport).
- Centurion = owner only on Centurion transport.
- After apply, Centurion transport has **two** owner rows (Nava + Centurion).

Do not grow a static Nava `ACCESS_ROWS` id list for future hotels — re-seed picks up new active transports.

### FE switcher chrome

```typescript
export function canManageConnections(connectionCount: number): boolean {
  return connectionCount > 1;
}

// nav-user.tsx
const allowConnectionManagement = canManageConnections(data?.connections?.length ?? 0);
```

Single-connection users (Centurion) never see multi-avatar switcher chrome.

### Wipe-safe verify (mandatory)

**Never** prove this change with Vitest pointed at pilot `DATABASE_URL`.

| Step | Do | Do not |
|------|----|--------|
| Local unit/guard | `unset DATABASE_URL` then `pnpm exec vitest run <files>` | Source `.env.production` into vitest |
| Live grants | `ops-deploy.sh` then `CONFIRM_PILOT_SEED=1 pnpm seed:prod` **without** `--rotate` | `VITEST_ALLOW_PILOT_RDS=1` for this feature |
| Assert | SQL on `mailbox_access` + API/`connections.list` semantics | Full `pnpm test` / unscoped vitest on EC2 |

SQL matrix (observed green 2026-07-29):

- `user-navaai` access ≥ 2 including `transport-centurion`
- `user-centurion` access = 1 on Centurion
- Centurion transport owner rows = 2

When VPN/browser unavailable, read-only query mirroring `connections.list` is an accepted overnight substitute for SPA login smoke (document divergence in handoff).

## Why This Matters

Wrong verify path can wipe production pilot mail again (POP3 already DELE’d; only S3 `raw-mime/` recovers history). Right path still proves the product: seed mutates access intentionally behind `CONFIRM_PILOT_SEED`; Vitest does not. Rejecting “run EC2 vitest” for grant proof is process correctness, not under-testing.

## When to Apply

- Any overnight / SDD task that changes `mailbox_access` seed or mailbox switcher FE on EC2-pilot
- Whenever a reviewer Important finding says “run vitest on EC2 with DATABASE_URL” for seed/access proof
- When proving Nava multi-grant after adding a new active hotel transport

## Examples

**Before (unsafe):** source `.env.production` → `pnpm --filter @zero/server test` on EC2 → wipe.

**After (safe):**

```bash
# laptop / CI unit
cd apps/server-pilot && unset DATABASE_URL
pnpm exec vitest run tests/pilot-rds-guard.test.ts tests/seed-contract.test.ts

# EC2 live proof
bash apps/server-pilot/deploy/ops-deploy.sh
# SSM:
export CONFIRM_PILOT_SEED=1
pnpm seed:prod   # no --rotate
# then SQL / connections.list semantic check
```

Commits that shipped this finish: `50bc65f1` (grants), `8854a770` (JSDoc), `64c89044` (FE gate). Handoff: `docs/superpowers/plans/handoff-reports/2026-07-29-nava-mailbox-switcher-finish.md`.

## Related

- [Vitest Against Production RDS Wiped EC2 Pilot Mail Data](../database-issues/vitest-production-pilot-db-wipe.md) — wipe incident, guard, recovery (session history: overnight “RDS vitest allowed” text was part of the failure mode)
- [EC2 Pilot Autonomous Deploy and SSM Gotchas](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — refresh candidate if it still recommends sourcing prod env for vitest
- CONCEPTS.md — Mailbox access / Mailbox switcher
- Plans: `docs/superpowers/plans/2026-07-29-nava-mailbox-switcher-finish.md`
