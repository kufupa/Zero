---
name: pilot-user-credentials
description: Create or edit Zero pilot app logins (email/password), mailbox_access grants, and Secrets Manager credentials, then seed on EC2. Use when adding a hotel staff login, rotating a pilot password, changing mailbox grants, or when the user asks for a new username/password for Nava mail pilot.
---

# Pilot user credentials

Provision or change Better Auth pilot logins for `apps/server-pilot`. Seed is source of truth; Secrets Manager holds plaintext passwords.

## Hard rules

- Login email must pass `z.string().email()` (SPA login). No TLD-less forms like `name@hotel`.
- Every durable login must be in `PILOT_USERS` in `apps/server-pilot/src/db/seed.ts`. Users not in that list get **pruned** on `seed:prod`.
- Never run Vitest against pilot RDS. Never `--rotate` unless user wants **all** pilot passwords rotated.
- Never print other users' passwords into chat, SSM, or logs. Only surface the target account.
- Windows + AWS CLI: `file://` needs a real Windows path (`cygpath -w`), not Git Bash `/c/...`.

## Collect before writing

1. **Email** (login id) — confirm valid email.
2. **Display name**
3. **Mailbox grants** — which `mailbox_transport` id(s), role (`owner`), default?
   - Centurion-only (audit staff): `transport-centurion` only, like Centurion/Martha.
   - Nava-style: owner on every **active** transport (usually only Nava).
4. **Password** — user-supplied, or invent memorable (≥6 chars). Prefer pre-set in SM before seed.
5. **Mode** — `create` | `password-only` | `grants-only` | `rename-email` (rare; treat as create + prune old).

## Create workflow

```
Progress:
- [ ] 1. Code: PILOT_USERS + applyPilotMailboxAccess
- [ ] 2. Tests: seed-contract expectations
- [ ] 3. Local identity tests (unset DATABASE_URL)
- [ ] 4. Commit seed files only (stash other WIP if pre-commit lint blocks)
- [ ] 5. Put target password in SM
- [ ] 6. sync-ec2-git-bundle.sh
- [ ] 7. EC2 seed:prod (CONFIRM_PILOT_SEED=1, no --rotate)
- [ ] 8. Verify SQL + return credentials
```

### 1–2 Code + tests

**File:** `apps/server-pilot/src/db/seed.ts`

- Add `USER_ID` / `USER_EMAIL` constants + row in `PILOT_USERS`.
- Update `applyPilotMailboxAccess` so grants match the persona. Pattern today:
  - Nava → every active transport
  - Centurion-scoped staff → `TRANSPORT_ID` (`transport-centurion`) owner + `isDefault: true`

**File:** `apps/server-pilot/tests/seed-contract.test.ts`

- Extend `PILOT_USERS` equality, user count, prune keep-list, Centurion transport owner-row count, and any Centurion-only grant assertions.

### 3 Local check

```bash
cd apps/server-pilot
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/seed-contract.test.ts tests/seed-prod-secret.test.ts
```

DB-backed cases may skip without disposable DB — identity/unit assertions must still pass.

### 4 Commit for bundle sync

`sync-ec2-git-bundle.sh` only ships **commits**. Uncommitted seed changes never reach EC2.

- Stage only seed + seed-contract (and related secret helper tests if touched).
- If husky fails on unrelated WIP lint: stash other dirt → commit → stash pop.
- Commit message focuses on why (audit login, ops persona, etc.).

### 5 Secrets Manager (password)

Secret: `nava-zero/server-pilot/pilot-users` (region `af-south-1`). JSON keyed by email → `{ "password": "..." }`.

**Create / set known password:** merge target email into existing secret **before** `seed:prod`. Seed prefers SM plaintext for new accounts.

```bash
export SECRET_FILE="$HOME/pilot-users-secret-tmp.json"
aws secretsmanager get-secret-value --region af-south-1 \
  --secret-id nava-zero/server-pilot/pilot-users \
  --query SecretString --output text > "$SECRET_FILE"
# node: parse, set existing[email] = { password }, write back
WIN_PATH=$(cygpath -w "$SECRET_FILE")
aws secretsmanager put-secret-value --region af-south-1 \
  --secret-id nava-zero/server-pilot/pilot-users \
  --secret-string "file://$WIN_PATH"
rm -f "$SECRET_FILE"
```

### 6–7 Sync + seed

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'export NVM_DIR=/home/ubuntu/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; export PATH="$HOME/.local/share/pnpm:$PATH"; cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && source .env.production && set +a && export CONFIRM_PILOT_SEED=1 && unset VITEST_ALLOW_PILOT_RDS && pnpm seed:prod'
```

Expect stdout to list the new email under `pilot users:`. Full `ops-deploy` only if app code besides seed must reload (seed itself is `tsx` on source).

### 8 Verify + hand credentials

SSM read-only check (no password columns):

- `user` row: id, email, name
- `mailbox_access` for that user_id → expected transport(s), role, is_default
- `account` row `cred-<userId>`, `provider_id = credential`, `password is not null`

Confirm SM password for **target email only** matches intended value.

Tell user clearly:

| | |
|---|---|
| **Username** | email |
| **Password** | plaintext |
| **Access** | which mailbox(es) |

## Password-only rotate (one user)

1. Put new password for that email in SM (merge; do not drop other keys).
2. On EC2, force re-hash for that account only — **preferred:** temporary one-off is OK if seed lacks single-user rotate.
3. Until single-user rotate exists: options are (a) delete that user's `account` row then `seed:prod` no `--rotate` (recreates from SM), or (b) `seed:prod --rotate` (**rotates everyone** — ask first).

Do **not** use `--rotate` for a single-user password change unless user accepts rotating all pilot logins.

## Grants-only change

1. Edit `applyPilotMailboxAccess` (+ tests).
2. Commit → sync → `seed:prod` **without** `--rotate` (rebuilds pilot `mailbox_access`; keeps passwords).

## Rename email

Treat as new `PILOT_USERS` email + SM key. Old email drops from allowed list on next seed (secret pruned). Confirm with user before prune.

## Reference

- Seed: `apps/server-pilot/src/db/seed.ts`
- Prod runner: `apps/server-pilot/scripts/seed-prod.ts`
- Secret merge helper: `apps/server-pilot/src/lib/pilot-secrets.ts`
- Pilot RDS safety: `.cursor/rules/pilot-rds-safety.mdc`
