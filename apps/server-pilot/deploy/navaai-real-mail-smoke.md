# navaai@ Real-Mail Smoke (pilot cutover)

Ordered checklist for flipping EC2 pilot from `MAIL_TRANSPORT_MODE=fixture` → `real` against Zimbra `172.24.0.10` using internet-reachable **`navaai@legacyhotels.co.za`** (sole POP3 ingest + Nava SMTP identity).

**Not this task / not here:** live EC2 cutover ops (Task 9). This file is the operator runbook only.

**Pilot model (KD5):** `navaai@` is internet-reachable. Old BCC-only / internal-aggregate + external-quarantine negative test is **deferred** to hotel-prod later — see supersession notes in [`deferred-real-mail-readiness.md`](./deferred-real-mail-readiness.md), [`exchange-smoke.md`](./exchange-smoke.md), [`it-handoff-runbook.md`](./it-handoff-runbook.md).

**Expected POP3 behavior:** after S3 + PG commit, worker **DELE**s the message on Zimbra (drain). Source of truth = Nava app inbox/spam, not a long-lived Zimbra mailbox.

**AI gates (must persist after activate):** `AI_DRAFTS_ENABLED=false`, `AI_WRITE_GATE_ENABLED=true`.

**Scripts (by path):**

| Step | Path |
|------|------|
| VPN assert | `apps/server-pilot/deploy/vpn-health-assert.sh` |
| Wipe + marker | `apps/server-pilot/deploy/pilot-db-wipe.sh` → marker `/var/lib/nava-pilot/wipe-navaai.ok` |
| Stage password | `apps/server-pilot/deploy/stage-navaai-mail-env.sh` → `/run/nava-mail/password` |
| Activate | `apps/server-pilot/scripts/activate-real-mail.sh` |
| Promote quarantine | `apps/server-pilot/scripts/promote-quarantine.ts` |
| Env writer | `apps/server-pilot/deploy/write-ec2-env.sh` (called by activate) |
| Deploy | `apps/server-pilot/deploy/deploy-ec2.sh` (called by activate) |
| Handoff ops | [`it-handoff-runbook.md`](./it-handoff-runbook.md) |
| Post-live evidence | `docs/superpowers/plans/handoff-reports/2026-07-22-navaai-real-mail-cutover.md` (create after AE1–AE5) |

Instance: `i-008f737974a9ba9b3` · Region: `af-south-1` · Repo on box: `/home/ubuntu/repos/zero`

---

## Checklist

### 0) Sync code (optional)

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
```

### 1) VPN assert

On EC2 (or via SSM):

```bash
cd /home/ubuntu/repos/zero
bash apps/server-pilot/deploy/vpn-health-assert.sh
# expect: VPN_HARD_OK (unit active, host default not tun, 172.24/16, STS OK)
```

Abort on `VPN_HARD_FAIL_*`. Do not continue without always-on green. See [`vpn-always-on.md`](./vpn-always-on.md).

### 2) Wipe + marker (mandatory before first navaai@ seed on legacy DB)

**Destructive RDS mail tables only** (auth users left). Requires confirm.

```bash
cd /home/ubuntu/repos/zero
CONFIRM=WIPE_PILOT_DB bash apps/server-pilot/deploy/pilot-db-wipe.sh
# expect: wipe marker written: /var/lib/nava-pilot/wipe-navaai.ok
test -f /var/lib/nava-pilot/wipe-navaai.ok
```

Refuse cutover if marker missing.

### 3) Migrate

```bash
cd /home/ubuntu/repos/zero
set -a && source apps/server-pilot/.env.production && set +a
pnpm --filter @zero/server db:migrate
```

### 4) seed:prod

No `--rotate` by default (preserves known pilot passwords unless intentional rotate).

```bash
pnpm --filter @zero/server seed:prod
# expect ingest mailbox: navaai@legacyhotels.co.za + Centurion transport still present
```

### 5) MX dig (AE5 preflight)

From laptop or any DNS-capable host:

```bash
dig +short MX legacyhotels.co.za
# and/or:
nslookup -type=MX legacyhotels.co.za
```

| Result | Action |
|--------|--------|
| MX resolves toward hotel path | External AE2 allowed |
| MX FAIL / unknown | Document blocker; use **app self-send** for AE2 ingest proof |

### 6) Stage password (before activate smoke)

Local (gitignored file `live real data connection/navaai-mail-pass.txt`):

```bash
bash apps/server-pilot/deploy/stage-navaai-mail-env.sh
# expect: STAGED_OK  (password → S3 → /run/nava-mail/password mode 600; never in SSM argv)
```

On EC2, **export into shell before activate** (staged file wins over stale `.env.production`; never `echo` / `set -x`):

```bash
export POP3_PASSWORD="$(sudo tr -d '\r\n' </run/nava-mail/password)"
export SMTP_PASSWORD="$POP3_PASSWORD"
# same password for POP3+SMTP this wave; SMTP_USER defaults to navaai@ inside activate
```

Order is **stage → export → activate smoke → write-ec2-env**. Do not run activate with empty passwords hoping Secrets Manager fills them (pilot = env-on-disk).

### 7) Activate

```bash
cd /home/ubuntu/repos/zero/apps/server-pilot
./scripts/activate-real-mail.sh
```

Activate does: VPN/route check → POP3 port probe `995` then `110` → SMTP `587` then `25` → POP3 auth smoke → SMTP **auth** smoke → writes `.env.production` with `MAIL_TRANSPORT_MODE=real`, `SMTP_USER=navaai@legacyhotels.co.za`, `AI_DRAFTS_ENABLED=false`, `AI_WRITE_GATE_ENABLED=true` → `deploy-ec2.sh` → one-shot ingest `WORKER_ONE_SHOT=1 WORKER_MAX_MESSAGES=1`.

Verify:

```bash
grep -E 'MAIL_TRANSPORT_MODE|AI_DRAFTS_ENABLED|AI_WRITE_GATE_ENABLED|SMTP_USER|POP3_USER' .env.production
pm2 list   # worker online
pm2 logs worker --lines 30
```

### 8) Backlog throttle (post-wipe note)

After RDS wipe, Zimbra `navaai@` may still hold mail. First POP3 cycles will **DELE-ingest** that backlog into app.

Throttle options:

- Prefer activate’s one-shot / keep `WORKER_MAX_MESSAGES=1` for first proofs
- Or lower `POP3_MAX_MESSAGES_PER_CYCLE` in env before full worker poll
- Optional: empty Zimbra first if operator wants zero backlog (not required)

Busy first cycle = OK if intentional.

### 9) AE2 — inbound proof (external or self-send)

**Preferred (MX PASS):** send external test mail To:`navaai@legacyhotels.co.za` with unique subject.

**Substitute (MX FAIL):** app compose/self-send To:`navaai@legacyhotels.co.za` (also exercises SMTP).

Then:

```bash
# if needed, another one-shot:
cd /home/ubuntu/repos/zero/apps/server-pilot
set -a && source .env.production && set +a
WORKER_ONE_SHOT=1 WORKER_MAX_MESSAGES=1 node dist/mail/ingest/worker.js
```

Pass when:

- Subject visible in app (inbox **or spam** OK without Centurion `X-Zero-Mailbox` rules)
- Durable triage write exists (`AI_WRITE_GATE_ENABLED=true`)
- Zimbra copy gone after DELE (expected)

Centurion inbox may stay empty until hotel IT BCC + stamp wave (deferred).

### 10) AE3 — app outbound proof

From app UI (or API): send as `navaai@legacyhotels.co.za` via real Zimbra SMTP.

Pass when send succeeds and transport is not fixture `FakeSmtp` (`MAIL_TRANSPORT_MODE=real` in logs).

### 11) Handoff path

1. Record AE1–AE5 (or MX/auth/port blockers) in  
   `docs/superpowers/plans/handoff-reports/2026-07-22-navaai-real-mail-cutover.md`
2. Day-to-day ops: [`it-handoff-runbook.md`](./it-handoff-runbook.md) (`ops-deploy.sh` / `ops-restart.sh` / `ops-reboot.sh`)
3. Stay on `real` + worker on; drafts remain off (`AI_DRAFTS_ENABLED=false`)

### 12) Promote `missing_owner_header` quarantine (after U1/U2 env flip)

After `INGEST_REQUIRE_OWNER_HEADER=false` is on EC2 and `seed:prod` has run:

```bash
cd /home/ubuntu/repos/zero
set -a && source apps/server-pilot/.env.production && set +a
grep INGEST_REQUIRE_OWNER_HEADER apps/server-pilot/.env.production
# must show false before promote

# dry-run first
pnpm --filter @zero/server tsx apps/server-pilot/scripts/promote-quarantine.ts --dry-run

# promote all (or --limit N for partial)
pnpm --filter @zero/server tsx apps/server-pilot/scripts/promote-quarantine.ts
```

Pass when summary shows `stored` + `duplicate` counts, `errors=0`, and SQL  
`select count(*) from mail_ingest_quarantine where reason='missing_owner_header'` → 0 (or only new poison).

## Rollback

```bash
cd /home/ubuntu/repos/zero/apps/server-pilot
MAIL_TRANSPORT_MODE=fixture \
INGEST_FIXTURE_DIR=/home/ubuntu/repos/zero/apps/server-pilot/tests/fixtures \
sudo -E deploy/write-ec2-env.sh
bash deploy/deploy-ec2.sh
pm2 stop worker   # fixture prod keeps worker deleted by deploy; stop if still up
```

## Safety

- Never commit `navaai-mail-pass.txt` or echo passwords
- Single POP3 account only (`navaai@`); Centurion = local `mailbox_transport` row, not a second POP3
- No live wipe/activate in docs-only tasks — run on EC2 when cutover is intentional
