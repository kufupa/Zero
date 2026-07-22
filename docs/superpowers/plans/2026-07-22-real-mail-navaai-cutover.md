# Real Mail navaai@ Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip EC2 pilot from `MAIL_TRANSPORT_MODE=fixture` → `real` against Zimbra `172.24.0.10` as `navaai@legacyhotels.co.za` — one inbound proof + one outbound proof + durable AI triage (drafts off).

**Architecture:** Reuse `activate-real-mail.sh` + `write-ec2-env.sh` + real POP3/SMTP clients. Sole POP3 sink = `navaai@`; Centurion stays a logical `mailbox_transport` only. Mandatory RDS wipe before `seed:prod` with new identity. Password staged like VPN (`vpn-stage-to-ec2.sh` pattern) — never in SSM argv. Worker DELE-after-ingest unchanged.

**Tech Stack:** TypeScript, Drizzle/Postgres, Vitest, nodemailer, bash/SSM, PM2, AWS EC2/RDS/S3.

**Spec / Product Contract:** [docs/plans/2026-07-22-003-feat-real-mail-navaai-cutover-plan.md](../../plans/2026-07-22-003-feat-real-mail-navaai-cutover-plan.md)

**Branch:** `EC2-pilot`

## Global Constraints

- Identity: `INGEST_EMAIL` = `NAVA_TRANSPORT_EMAIL` = `navaai@legacyhotels.co.za` (replace `nava@legacyhotel.com`).
- Centurion `TRANSPORT_EMAIL` / ops `nava-ops@legacyhotel.com` unchanged.
- `MAIL_TRANSPORT_MODE=real`; `AI_DRAFTS_ENABLED=false`; `AI_WRITE_GATE_ENABLED=true`.
- Mail secrets: EC2 `.env.production` only (KD4). No Secrets Manager for POP3/SMTP this wave.
- Hosts: `POP3_HOST=SMTP_HOST=172.24.0.10`. Ports probed: POP3 995→110, SMTP 587→25.
- Keep POP3 DELE after S3+PG success. No Rocketseed/banner. No second POP3.
- VPN assumed `ALWAYS_ON_OK` (`openvpn-client@nava`). Do not re-install VPN.
- Testing posture: full automated package — never skip tests for speed.
- Grep gate: zero `nava@legacyhotel.com` under `apps/server-pilot/{src,tests,deploy,scripts}` (runbook “old model” notes only in `*.md` runbooks).
- Subagent model: `cursor-grok-4.5-high` only (never fast variants).
- Commits: conventional, one per task, no `--no-verify`, no force-push, never commit secrets.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** RDS wipe OK (nobody using EC2/RDS). No blocking questions overnight. No “which approach?” pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Bootstrap bucket | `nava-zero-bootstrap-845242190536` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| Guts | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, migrate, `seed:prod` (no `--rotate` unless required), SSM, PM2 logs, health, **pilot DB wipe with `CONFIRM=WIPE_PILOT_DB`**, real-mail stage/activate/smoke per this plan.

**Forbidden:** force-push main, `--no-verify`, destructive git, password in SSM command argv, commit of `navaai-mail-pass.txt` / filled secrets, Rocketseed work, Secrets Manager mail migration.

**Password precondition:** Operator pastes mailbox password into `live real data connection/navaai-mail-pass.txt` before Task 9 (done). If missing/placeholder at Task 9 → handoff `BLOCKED_PASSWORD` and stop.

**AE2 overnight default:** App SMTP self-send to `navaai@` → POP3 ingest → durable triage. Human external optional.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [ ] Tasks 1–8 green + committed
- [ ] Grep gate + deploy-config asserts green
- [ ] Fixture loopback E2E green after identity rename
- [ ] EC2: wipe+seed, activate real, AE1–AE5 (or AE2 via self-send) documented in handoff
- [ ] `.env.production` has `SMTP_PASSWORD`, `SMTP_USER=navaai@…`, `AI_DRAFTS_ENABLED=false`, `AI_WRITE_GATE_ENABLED=true`, `MAIL_TRANSPORT_MODE=real`
- [ ] No secrets in git

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

## Git Commit Strategy

| Task | Commit message |
|------|----------------|
| 1 | `chore(mail): add navaai mailbox password skeleton` |
| 2 | `fix(deploy): persist SMTP password and AI gates in write-ec2-env` |
| 3 | `feat(deploy): add pilot DB wipe with confirm gate` |
| 4 | `feat(seed): use navaai@legacyhotels.co.za as ingest identity` |
| 5 | `test(mail): rename nava ingest identity + grep gate` |
| 6 | `feat(deploy): stage navaai mail password via S3` |
| 7 | `feat(deploy): harden activate-real-mail for navaai Zimbra` |
| 8 | `docs(mail): navaai real-mail smoke runbook` |
| 9 | `docs(mail): navaai real-mail cutover handoff` |

Push `EC2-pilot` after each task OR after Task 5 batch before live Task 9.

---

## File Map

| File | Responsibility |
|------|----------------|
| `live real data connection/navaai-mail-pass.txt` | One-line password (gitignored; never commit filled value) |
| `live real data connection/.gitignore` | Ignore `*mail-pass*` |
| `apps/server-pilot/deploy/write-ec2-env.sh` | Persist `SMTP_PASSWORD`, `AI_DRAFTS_ENABLED`, `AI_WRITE_GATE_ENABLED`, `SMTP_USER` |
| `apps/server-pilot/deploy/pilot-db-wipe.sh` | `CONFIRM=WIPE_PILOT_DB` truncate mail tables + wipe marker |
| `apps/server-pilot/deploy/stage-navaai-mail-env.sh` | Laptop→S3→EC2 `/run/nava-mail/` |
| `apps/server-pilot/scripts/activate-real-mail.sh` | Port probe, preserve staged secrets, SMTP auth smoke |
| `apps/server-pilot/src/db/seed.ts` | Identity constants |
| `apps/server-pilot/tests/deploy-config.test.ts` | Writer + wipe + activate + stage asserts |
| `apps/server-pilot/tests/identity-grep-gate.test.ts` | Fail if old ingest email in src/tests/deploy/scripts |
| `apps/server-pilot/deploy/navaai-real-mail-smoke.md` | Cutover runbook |
| `docs/superpowers/plans/handoff-reports/2026-07-22-navaai-real-mail-cutover.md` | Live evidence |

---

### Task 1: Password skeleton + gitignore

**Files:**
- Create: `live real data connection/navaai-mail-pass.txt` (local only; gitignored)
- Modify: `live real data connection/.gitignore`
- Modify: `live real data connection/FILL-ME.txt`

**Note:** Password may already be filled locally. **Never commit the filled password.** Commit only `.gitignore` + `FILL-ME.txt` (and optionally a tracked example is NOT required — file stays gitignored). Verify `git check-ignore` on pass file. If folder has other secrets (`nava-auth.txt`, keys), do not `git add` them — add only safe docs/gitignore paths.

- [ ] **Step 1:** Ensure `.gitignore` has `navaai-mail-pass.txt` and `*mail-pass*`
- [ ] **Step 2:** Ensure `FILL-ME.txt` documents `navaai-mail-pass.txt` (line 1 = password only)
- [ ] **Step 3:** Ensure local pass file exists (placeholder OR filled — do not log value)
- [ ] **Step 4:** `git check-ignore -v "live real data connection/navaai-mail-pass.txt"` → ignored
- [ ] **Step 5:** Commit only safe paths:

```bash
git add "live real data connection/.gitignore" "live real data connection/FILL-ME.txt"
git commit -m "$(cat <<'EOF'
chore(mail): add navaai mailbox password skeleton

EOF
)"
```

---

### Task 2: Env writer persists SMTP + AI gates (TDD)

**Files:**
- Modify: `apps/server-pilot/deploy/write-ec2-env.sh`
- Modify: `apps/server-pilot/tests/deploy-config.test.ts`

**Gap:** script appends `POP3_PASSWORD` / `SMTP_SECRET_ARN` but not `SMTP_PASSWORD`, `AI_DRAFTS_ENABLED`, `AI_WRITE_GATE_ENABLED`.

- [ ] **Step 1: Write failing test** in `deploy-config.test.ts` asserting `write-ec2-env.sh` contains:
  - `append_env SMTP_PASSWORD`
  - `append_env AI_DRAFTS_ENABLED`
  - `append_env AI_WRITE_GATE_ENABLED`
  - `append_env SMTP_USER`
- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter @zero/server-pilot exec vitest run tests/deploy-config.test.ts
```

- [ ] **Step 3: Implement** after `append_env SMTP_USER`:

```bash
append_env SMTP_PASSWORD "${SMTP_PASSWORD:-}"
append_env AI_DRAFTS_ENABLED "${AI_DRAFTS_ENABLED:-}"
append_env AI_WRITE_GATE_ENABLED "${AI_WRITE_GATE_ENABLED:-}"
```

- [ ] **Step 4: Run test — expect PASS**
- [ ] **Step 5: Commit** `fix(deploy): persist SMTP password and AI gates in write-ec2-env`

---

### Task 3: Pilot DB wipe script + CONFIRM gate

**Files:**
- Create: `apps/server-pilot/deploy/pilot-db-wipe.sh`
- Modify: `apps/server-pilot/tests/deploy-config.test.ts`

**Wipe SQL (Postgres only; leave auth users):**

```sql
TRUNCATE TABLE
  mail_draft_revision,
  mail_draft,
  ai_workflow_run,
  ai_draft_generation,
  attachment,
  message,
  mail_thread_category,
  mail_thread,
  mail_label,
  mail_category,
  mailbox_access,
  mail_ingest_quarantine,
  mailbox_transport,
  mail_ingest_mailbox
RESTART IDENTITY CASCADE;
```

- Require `CONFIRM=WIPE_PILOT_DB` else exit 2
- Source `DATABASE_URL` from `.env.production` on EC2
- Write marker `/var/lib/nava-pilot/wipe-navaai.ok` with timestamp
- Tests: `bash -n`; script contains `CONFIRM=WIPE_PILOT_DB`; assert refuse without confirm
- Commit: `feat(deploy): add pilot DB wipe with confirm gate`

---

### Task 4: Seed identity rename (TDD)

**Files:**
- Modify: `apps/server-pilot/src/db/seed.ts`
- Modify: `apps/server-pilot/tests/seed-contract.test.ts`
- Modify: `apps/server-pilot/scripts/seed-prod.ts` (log line)

```ts
export const NAVA_TRANSPORT_EMAIL = 'navaai@legacyhotels.co.za';
export const INGEST_EMAIL = 'navaai@legacyhotels.co.za';
// description: 'NAVA aggregate ingest (legacyhotels.co.za)'
```

- Centurion still `centurion@legacyhotel.com`
- TDD: update seed-contract first (fail) → change constants → pass
- Commit: `feat(seed): use navaai@legacyhotels.co.za as ingest identity`

---

### Task 5: Grep gate + rewrite hardcoded tests/gates

**Files:** All `nava@legacyhotel.com` under `apps/server-pilot/{src,tests,deploy,scripts}`; Create `tests/identity-grep-gate.test.ts`.

- Replace ingest/Nava transport with `navaai@legacyhotels.co.za`
- Leave Centurion addresses alone
- Gate fails if `nava@legacyhotel.com` remains in those dirs
- Run fixture-loopback-e2e + seed-contract green
- Commit: `test(mail): rename nava ingest identity + grep gate`

---

### Task 6: Stage mail password (VPN pattern)

**Files:**
- Create: `apps/server-pilot/deploy/stage-navaai-mail-env.sh` (mirror `vpn-stage-to-ec2.sh`)
- Modify: `apps/server-pilot/tests/deploy-config.test.ts`

- Read `navaai-mail-pass.txt`; refuse `REPLACE_` placeholder
- S3: `s3://nava-zero-bootstrap-845242190536/mail-navaai/<stamp>/password`
- SSM: `/run/nava-mail/password` mode 600 root
- Echo `STAGED_OK` only (never cat password)
- Commit: `feat(deploy): stage navaai mail password via S3`

---

### Task 7: Activate — preserve secrets, port probe, SMTP auth

**Files:**
- Modify: `apps/server-pilot/scripts/activate-real-mail.sh`
- Modify: `apps/server-pilot/tests/deploy-config.test.ts`

**Fix:** Save staged `POP3_PASSWORD`/`SMTP_PASSWORD` before sourcing `.env.production`; restore staged wins after.

**Defaults:**

```bash
: "${POP3_HOST:=172.24.0.10}"
: "${SMTP_HOST:=172.24.0.10}"
: "${POP3_USER:=navaai@legacyhotels.co.za}"
: "${SMTP_USER:=navaai@legacyhotels.co.za}"
```

**Port probe:** POP3 995→110; SMTP 587→25; set TLS flags; fail closed.

**SMTP smoke:** nodemailer `auth: { user, pass }` + `verify()` (not EHLO-only).

```bash
export AI_DRAFTS_ENABLED=false
export AI_WRITE_GATE_ENABLED=true
```

- Commit: `feat(deploy): harden activate-real-mail for navaai Zimbra`

---

### Task 8: Smoke runbook + runbook supersession

**Files:**
- Create: `apps/server-pilot/deploy/navaai-real-mail-smoke.md`
- Modify: `deferred-real-mail-readiness.md`, `exchange-smoke.md`, `it-handoff-runbook.md`

Checklist: VPN assert → wipe+marker → migrate → seed:prod → MX dig → stage → activate → self-send AE2 → AE3 → handoff.

- Commit: `docs(mail): navaai real-mail smoke runbook`

---

### Task 9: Live EC2 cutover + handoff

**Precondition:** password file filled (verified).

1. `vpn-health-assert.sh`
2. `CONFIRM=WIPE_PILOT_DB bash pilot-db-wipe.sh`
3. Push + `ops-deploy.sh` + `pnpm seed:prod`
4. `stage-navaai-mail-env.sh` (laptop)
5. Export from `/run/nava-mail/password` → `activate-real-mail.sh`
6. AE1–AE5 (AE2 via self-send)
7. Write `docs/superpowers/plans/handoff-reports/2026-07-22-navaai-real-mail-cutover.md`
8. Commit: `docs(mail): navaai real-mail cutover handoff`

---

## Verification (DoD)

1. Local: deploy-config + identity-grep + seed-contract + fixture-loopback-e2e green
2. EC2 wipe marker; ingest = `navaai@`; Centurion transport present
3. Activate: probe + POP3 auth + SMTP auth OK
4. `.env.production` keys (AE4)
5. AE2 self-send in app ≤2 cycles (spam OK)
6. AE3 real SMTP send OK
7. No secrets in git

## Out of scope

Rocketseed/banner · Secrets Manager mail · Centurion BCC IT rules · second POP3 · VPN reinstall · Infor · ops-login rename · leave-on-server DELE change
