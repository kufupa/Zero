# Handoff — Nava mailbox switcher finish

**Date:** 2026-07-29  
**Branch:** `EC2-pilot` @ `3f93c873` (laptop + EC2 bundle after ops-deploy)  
**Plan:** `docs/superpowers/plans/2026-07-29-nava-mailbox-switcher-finish.md`  
**Spec:** `docs/plans/2026-07-27-004-feat-nava-mailbox-switcher-grants-plan.md`  
**Verdict:** Tasks 1–3 **done**. CONCEPTS verified (no edit). EC2 deploy + seed (no rotate) + SQL smoke green. API-level connections proof green. SPA browser login **skipped** (no VPN / no browser automation this session).

## Commits (plan-relevant)

| SHA | Summary |
|-----|---------|
| `50bc65f1` | `applyPilotMailboxAccess` — Nava owner on all active transports; Centurion-only on Centurion |
| `8854a770` | `seedAll` JSDoc aligned with mailbox_access rebuild |
| `64c89044` | FE `canManageConnections(n) => n > 1` wired in `nav-user` |

**EC2 sync SHA (Task 3):** `3f93c873` — includes FE gate + seed helper; mail SPA + server-pilot rebuilt via `ops-deploy.sh`.

## CONCEPTS verify

`CONCEPTS.md` **Mailbox access** and **Mailbox switcher** already state:

- `connections.list` returns granted transports only.
- Switcher shown when user has 2+ connections; hidden for single-inbox personas.

No edit required.

## Deploy

```bash
bash apps/server-pilot/deploy/ops-deploy.sh
```

- Health: `{"ok":true,"service":"server-pilot"}` on `:8788`
- VPN assert: `VPN_HARD_OK`, `HOTEL_PROBE_OK`
- Mail SPA build includes minified `canManageConnections` gate in `app-sidebar` bundle (`Da(connectionCount)`)

## Seed (no rotate)

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'set -euo pipefail
export NVM_DIR=/home/ubuntu/.nvm; . "$NVM_DIR/nvm.sh"
cd /home/ubuntu/repos/zero/apps/server-pilot
set -a; source .env.production; set +a
export CONFIRM_PILOT_SEED=1
pnpm seed:prod
'
```

**Stdout (2026-07-29):**

```text
seed complete
ingest mailbox: navaai@legacyhotels.co.za
transports (count): 5
mailbox_access rows (total): 3
pilot users: navaai@legacyhotels.co.za, centurion@legacyhotels.co.za
pilot credentials unchanged (use --rotate to rotate); secret pruned to pilot emails
```

No `--rotate`. Pilot passwords unchanged.

## SQL smoke (pilot RDS via EC2 psql)

### Active transports

| id | email | is_active |
|----|-------|-----------|
| `transport-centurion` | `centurion@legacyhotels.co.za` | true |
| `transport-nava` | `navaai@legacyhotels.co.za` | true |

### mailbox_access rows

| user_id | transport_id | role | is_default |
|---------|--------------|------|------------|
| `user-centurion` | `transport-centurion` | owner | true |
| `user-navaai` | `transport-centurion` | owner | false |
| `user-navaai` | `transport-nava` | owner | true |

### Assertions

| Check | Expected | Actual |
|-------|----------|--------|
| `user-navaai` access count | ≥ 2 | **2** |
| `user-navaai` includes `transport-centurion` | yes | **1** |
| `user-centurion` on `transport-centurion` | = 1 | **1** |
| `transport-centurion` owner rows | = 2 | **2** |

All pass.

## UI / API smoke

### Browser (skipped)

No VPN / browser automation available overnight. Manual spot-check deferred:

- Login `navaai@legacyhotels.co.za` → switcher shows Centurion → switch → Centurion threads
- Login `centurion@legacyhotels.co.za` → no multi-avatar switcher

### API substitute (connections.list semantics via server DB join)

Node one-shot on EC2 (not vitest; read-only query mirroring `connections.list`):

```json
{"userId":"user-navaai","connectionCount":2,"canManageConnections":true,"connections":[{"id":"transport-centurion","email":"centurion@legacyhotels.co.za","isDefault":false},{"id":"transport-nava","email":"navaai@legacyhotels.co.za","isDefault":true}]}
{"userId":"user-centurion","connectionCount":1,"canManageConnections":false,"connections":[{"id":"transport-centurion","email":"centurion@legacyhotels.co.za","isDefault":true}]}
```

**Assessment:** Nava would see switcher (2 connections); Centurion would not (1 connection). Matches R1 + R8.

## Pilot vitest policy

**No vitest ran** against pilot RDS during this plan. Live grant proof = `seed:prod` + SQL above.

See: `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md`

## Divergences / notes

- UI browser smoke skipped; SQL + API-semantic proof used instead (per overnight mandate + plan divergence authority).
- EC2 HEAD `3f93c873` includes unrelated `test(ai): remap invent-WHO fixtures` — harmless to mailbox switcher; FE gate commit `64c89044` is ancestor.
- Task 2 review noted demo chrome may show switcher at 2+ connections — out of scope for pilot personas.

## Done criteria checklist

- [x] Task 1: safe local vitest + JSDoc
- [x] Task 2: `canManageConnections` + `nav-user` gate
- [x] Task 3: CONCEPTS OK; EC2 deploy + seed (no rotate); SQL smoke
- [x] Handoff report (this file)
- [x] No pilot vitest during this plan
