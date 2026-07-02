# IT Handoff Runbook — Real Mail Transport

Flip `MAIL_TRANSPORT_MODE` from `fixture` (default) to `real` after IT provides Exchange POP3/SMTP access.

## Prerequisites

- Security Wave 1 gate passed ([ec2-pilot-security-hardening plan](../../docs/superpowers/plans/2026-07-01-ec2-pilot-security-hardening.md))
- All fixture/fake tests green on EC2
- VPN profile installed with split tunnel for AWS (RDS, S3, SSM must stay reachable)

## IT must provide

| Item | Example |
|------|---------|
| POP3 host / port | `mail.legacyhotel.local` / `995` |
| POP3 user | aggregate mailbox `nava@legacyhotel.com` |
| POP3 password | stored in Secrets Manager (never in chat logs) |
| SMTP relay host / port | `mail.legacyhotel.local` / `587` |
| SMTP auth user | relay account |
| SMTP password | Secrets Manager |
| VPN profile | split tunnel preferred |
| Transport rules | BCC `nava@`, stamp `X-Zero-Mailbox` **last** on Centurion copies |
| Strip rule | Remove forged external `X-Zero-Mailbox` before relay stamp |

See [deferred-real-mail-readiness.md](./deferred-real-mail-readiness.md) and [exchange-smoke.md](./exchange-smoke.md).

## Agent steps

### 1. Store secrets (never log passwords)

```bash
# POP3 — JSON or plain string accepted
aws secretsmanager create-secret \
  --name nava-zero-mail-pilot/pop3 \
  --secret-string '{"POP3_PASSWORD":"..."}' \
  --region af-south-1

# SMTP
aws secretsmanager create-secret \
  --name nava-zero-mail-pilot/smtp \
  --secret-string '{"SMTP_PASSWORD":"..."}' \
  --region af-south-1
```

Or update existing secrets with `put-secret-value`.

### 2. Run handoff script

Paste IT details as env vars (passwords via Secrets Manager ARNs, not inline):

```bash
cd /home/ubuntu/repos/zero/apps/server-pilot

POP3_HOST=mail.legacyhotel.local \
POP3_PORT=995 \
POP3_TLS=true \
POP3_USER=nava@legacyhotel.com \
POP3_SECRET_ARN=arn:aws:secretsmanager:af-south-1:...:secret:nava-zero-mail-pilot/pop3 \
SMTP_HOST=mail.legacyhotel.local \
SMTP_PORT=587 \
SMTP_USER=relay@legacyhotel.com \
SMTP_SECRET_ARN=arn:aws:secretsmanager:af-south-1:...:secret:nava-zero-mail-pilot/smtp \
./scripts/activate-real-mail.sh
```

The script:

1. Validates VPN + AWS + RDS + S3 (`deploy/vpn-route-check.sh`)
2. TCP smoke to POP3/SMTP ports
3. POP3 USER/PASS smoke (openssl s_client or node one-liner)
4. SMTP EHLO smoke
5. Writes `.env.production` with `MAIL_TRANSPORT_MODE=real` (quoted values)
6. Redeploys via `deploy/deploy-ec2.sh`
7. Runs one ingest cycle: `WORKER_ONE_SHOT=1 WORKER_MAX_MESSAGES=1`

### 3. Verify

```bash
pm2 logs worker --lines 30   # expect transport.mode=real
pm2 logs http --lines 20
# UI: login → inbox → send reply
```

Confirm PM2 logs show `transport.mode=real` and no fixture fake path.

### 4. Exchange smoke

Follow [exchange-smoke.md](./exchange-smoke.md): external mail to Centurion → copy in `nava@` → worker ingests → role visibility → reply sends as `centurion@legacyhotel.com`.

## Rollback

```bash
MAIL_TRANSPORT_MODE=fixture \
INGEST_FIXTURE_DIR=/home/ubuntu/repos/zero/apps/server-pilot/tests/fixtures \
sudo -E deploy/write-ec2-env.sh
./deploy/deploy-ec2.sh
pm2 stop worker   # optional — fixture poll is safe on prod RDS (UIDL dedup)
pm2 start worker
```

Set `MAIL_TRANSPORT_MODE=fixture` to stop all TCP to mail servers. Fixture ingest remains idempotent on prod RDS.

## User handoff phrase

*"Here are the POP3/SMTP/mail server details"* + paste → agent reads this runbook, runs `activate-real-mail.sh`, reports green/red.
