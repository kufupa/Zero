# IT Handoff Runbook — Real Mail Transport

Flip `MAIL_TRANSPORT_MODE` from `fixture` (default) to `real` after Zimbra POP3/SMTP access for **`navaai@legacyhotels.co.za`**.

**Pilot cutover checklist:** `navaai-real-mail-smoke.md`  
**VPN assert / wipe / stage / activate paths documented there.**

**Pilot model:** internet-reachable `navaai@` (sole POP3). Old BCC-only internal-aggregate + external-quarantine model **deferred** to hotel-prod — see [`deferred-real-mail-readiness.md`](./deferred-real-mail-readiness.md) + `exchange-smoke.md`.

**Persist on activate:** `AI_DRAFTS_ENABLED=false`, `AI_WRITE_GATE_ENABLED=true`.  
**POP3:** DELE-after-ingest expected.  
**Post-wipe:** throttle backlog (`WORKER_ONE_SHOT` / `POP3_MAX_MESSAGES_PER_CYCLE`).

## Day-to-day ops (before / after handoff)

| Need | Command |
|------|---------|
| Ship new code | `bash apps/server-pilot/deploy/ops-deploy.sh` |
| Bounce apps | `bash apps/server-pilot/deploy/ops-restart.sh` |
| Soft reboot + smoke | `bash apps/server-pilot/deploy/ops-reboot.sh` |

After real mail is active, `ops-deploy` keeps `worker` in the PM2 dump (non-fixture mode).

**VPN:** always-on live on pilot; `ops-deploy` / `ops-reboot` HARD-assert via `vpn-health-assert.sh`. Durability + abort: [`vpn-always-on.md`](./vpn-always-on.md).

## Prerequisites

- Security Wave 1 gate passed (ec2-pilot-security-hardening plan)
- All fixture/fake tests green on EC2
- VPN always-on installed with split tunnel for AWS (RDS, S3, SSM must stay reachable) — see [`vpn-always-on.md`](./vpn-always-on.md)
- Wipe marker `/var/lib/nava-pilot/wipe-navaai.ok` then migrate + `seed:prod` (mandatory on legacy DB before navaai@ seed)
- Local password file filled: `live real data connection/navaai-mail-pass.txt` (gitignored)

## IT / operator must provide

| Item | Example (this pilot) |
|------|----------------------|
| POP3 host / port | `172.24.0.10` / probe `995` then `110` |
| POP3 user | `navaai@legacyhotels.co.za` |
| POP3 password | staged via `stage-navaai-mail-env.sh` → `/run/nava-mail/password` → export to shell → `.env.production` (chmod 600) |
| SMTP host / port | **Rocketseed** `172.24.0.8` / `587` only (STARTTLS; IP-trust — **no SMTP AUTH**) |
| SMTP From identity | Active mailbox transport (`navaai@` or `centurion@`) — not free-form client From |
| SMTP password | **Not required** for Rocketseed; leftover Zimbra SMTP password must not be used for AUTH |
| VPN | always-on already; assert with `vpn-health-assert.sh` |
| Transport rules | **Deferred** for pilot smoke — Centurion BCC + `X-Zero-Mailbox` later |

Secrets Manager for mail is **not** required for this single-box pilot (env-on-disk). Optional SM path still works in `activate-real-mail.sh` for **POP3** if `POP3_SECRET_ARN` set instead of env password. Defaults inside activate when unset: `POP3_HOST=172.24.0.10`, `SMTP_HOST=172.24.0.8`, `POP3_USER`/`SMTP_USER=navaai@legacyhotels.co.za`.

## Agent steps

### 1. Stage password (never log / never SSM argv)

```bash
# Laptop — after filling navaai-mail-pass.txt
bash apps/server-pilot/deploy/stage-navaai-mail-env.sh
# expect STAGED_OK
```

### 2. On EC2 — export then activate

```bash
cd /home/ubuntu/repos/zero/apps/server-pilot

# staged wins over stale .env.production
export POP3_PASSWORD="$(sudo tr -d '\r\n' </run/nava-mail/password)"
export SMTP_PASSWORD="$POP3_PASSWORD"

./scripts/activate-real-mail.sh
```

Defaults inside activate when unset: `POP3_HOST=172.24.0.10`, `SMTP_HOST=172.24.0.8`, `POP3_USER`/`SMTP_USER=navaai@legacyhotels.co.za`. SMTP password is optional (Rocketseed IP-trust).

The script:

1. Validates VPN + AWS + RDS + S3 (`deploy/vpn-route-check.sh`)
2. Port probe POP3 `995`→`110`; SMTP **587 only** on Rocketseed
3. POP3 USER/PASS smoke
4. SMTP **STARTTLS** smoke (no AUTH; `requireTLS` + SNI `branding.legacyhotels.co.za`)
5. Writes `.env.production` with `MAIL_TRANSPORT_MODE=real`, `SMTP_HOST=172.24.0.8`, AI gates (`deploy/write-ec2-env.sh`)
6. Redeploys via `deploy/deploy-ec2.sh`
7. One ingest cycle: `WORKER_ONE_SHOT=1 WORKER_MAX_MESSAGES=1`

### 3. Verify

```bash
pm2 logs worker --lines 30   # expect transport.mode=real
pm2 logs http --lines 20
grep -E 'MAIL_TRANSPORT_MODE|AI_DRAFTS_ENABLED|AI_WRITE_GATE_ENABLED|SMTP_USER' .env.production
# UI: login → inbox/spam → send as navaai@
```

### 4. Exchange / AE smoke

Follow `navaai-real-mail-smoke.md` + `exchange-smoke.md`: MX dig → AE2 inbound (or self-send) → AE3 outbound. Record evidence in `docs/superpowers/plans/handoff-reports/2026-07-22-navaai-real-mail-cutover.md` after live run.

## Rollback

```bash
MAIL_TRANSPORT_MODE=fixture \
INGEST_FIXTURE_DIR=/home/ubuntu/repos/zero/apps/server-pilot/tests/fixtures \
sudo -E deploy/write-ec2-env.sh
./deploy/deploy-ec2.sh
pm2 stop worker   # optional — fixture poll is safe on prod RDS (UIDL dedup)
```

Set `MAIL_TRANSPORT_MODE=fixture` to stop all TCP to mail servers. Fixture ingest remains idempotent on prod RDS.

## User handoff phrase

*"Here is the navaai@ mailbox password"* (paste into gitignored `navaai-mail-pass.txt`) → agent runs stage → export → `activate-real-mail.sh` per `navaai-real-mail-smoke.md`, reports green/red for AE1–AE5.
