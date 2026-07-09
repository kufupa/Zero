# Deferred Real-Mail Readiness

Current scope:

- Backend runs on EC2.
- Frontend connects to backend.
- RDS/S3-backed schema works.
- Fixture ingest works.
- Fake SMTP send works.
- Isolation/load/build tests pass.

Explicitly out of scope for this implementation pass:

- Connecting VPN.
- Connecting to Exchange/on-prem POP3/SMTP.
- Sending real email.
- Receiving/deleting real email from `nava@`.
- AI chatbot assistant work.
- workflow-use Chromium/API integration.

## Automated fixture loopback gate (pre–real-mail)

Before VPN/real POP3/SMTP, fixture Nava send→ingest→inbox/spam/sent is verified automatically — no manual login, no Mailpit.

**Script:** `apps/server-pilot/deploy/fixture-loopback-gate.sh`

**On EC2 (ubuntu):**

```bash
cd /home/ubuntu/repos/zero
bash apps/server-pilot/deploy/fixture-loopback-gate.sh
```

**From laptop via SSM** (`i-008f737974a9ba9b3`, `af-south-1`):

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/fixture-loopback-gate.sh'
```

**Typical deploy wave (overnight autonomous):**

```text
sync-ec2-git-bundle.sh
→ source .env.production
→ pnpm --filter @zero/server db:migrate
→ deploy-ec2.sh
→ fixture-loopback-gate.sh
```

Gate behavior:

- Sources `apps/server-pilot/.env.production` (RDS `DATABASE_URL`, S3, etc.).
- Forces `NODE_ENV=test` and `MAIL_TRANSPORT_MODE=fixture` for vitest only.
- `pm2 stop worker` before tests (avoids POP3 race); `pm2 start worker` after.
- Runs: `fixture-loopback-e2e`, `fixture-loopback`, `seed-contract`, `mail-send`, `ingest-store`, `pop3-worker`.
- Builds `@zero/mail` SPA; prints `fixture-loopback-gate: PASS` on success.

Manual browser playbook (login as `nava-ops@`, DevTools header toggle, etc.) is **superseded** for fixture verification — keep only for post-VPN real-mail activation below.

## Wire gate (pre–IT only, Option B)

Runs `RealPop3Client` / `RealSmtpTransport` against localhost Mailpit — not every deploy.

**One-time on EC2:** `bash apps/server-pilot/deploy/install-mailpit.sh`

**Pre-IT SSM:**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/wire-gate.sh'
```

Production `.env.production` stays `MAIL_TRANSPORT_MODE=fixture`. Wire env is forced only inside `wire-gate.sh`.

**Fixture prod PM2:** `deploy-ec2.sh` / `ops-deploy.sh` keep `http` + `ai-worker` only — `worker` is deleted so reboot does not show an errored POP3 process. Start `worker` only via `activate-real-mail.sh` / `wire-gate.sh` after real/wire flip.

## Bedrock live gate (on-demand, not daily deploy)

Proves EC2 instance role can invoke `amazon.nova-lite-v1:0` in `us-east-1`. Daily `ai-gate.sh` spike stays on fake adapter.

**IAM:** inline `NavaZeroBedrockInvoke` on worker role — see `aws-resources.md`.

**Pre-IT SSM:**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/bedrock-live-gate.sh'
```

`ai-worker` PM2 uses `AI_ENABLED=true`, `BEDROCK_REGION=us-east-1`. EC2/RDS stay `af-south-1`.

## Later real-ingest phase gates

- Start VPN profile provided by IT.
- Verify SSM, RDS, S3 still work after VPN.
- Verify POP3/SMTP reachability.
- **IT transport rule (required):** BCC `nava@legacyhotel.com` and set `X-Zero-Mailbox: centurion@legacyhotel.com` on Centurion-bound copies.
- **Strip rule (required before prod multi-user):** Exchange must remove any inbound external `X-Zero-Mailbox` before applying the internal relay stamp.
- **`nava@` must not be internet-reachable** — only internal BCC copies land there; direct external mail to `nava@` must quarantine (negative test).
- Send test email to Centurion.
- Confirm copied raw mail includes `X-Zero-Mailbox: centurion@legacyhotel.com` as the **last** occurrence (forged earlier values stripped or overridden by relay).
- Run worker against real `nava@` only after fixture/fake tests are green.

## Current no-VPN expectation

```text
AWS STS OK
RDS OK
S3 OK
POP3/SMTP skipped or may fail because real mail connection is deferred
```

## Future after-VPN expectation

```text
AWS STS still OK
SSM still Online from laptop
RDS still OK
S3 OK
POP3/SMTP OK
```

## If VPN breaks AWS/SSM/RDS

- Check `ip route` default route before/after.
- Prefer split tunnel from IT.
- If no split tunnel, add VPC endpoints for `ssm`, `ssmmessages`, `ec2messages`, S3 gateway endpoint, CloudWatch Logs, Secrets Manager where needed.
- Keep RDS in local VPC path; never make RDS public to solve VPN routing.
