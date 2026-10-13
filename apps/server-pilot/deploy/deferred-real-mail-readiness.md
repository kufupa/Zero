# Deferred Real-Mail Readiness

## Pilot cutover status (2026-07-22)

**Primary path:** internet-reachable **`navaai@legacyhotels.co.za`** — POP3 on Zimbra `172.24.0.10`, SMTP on Rocketseed `172.24.0.8:587` via always-on VPN.

**Operator checklist:** [`navaai-real-mail-smoke.md`](./navaai-real-mail-smoke.md)  
(VPN assert → wipe+marker → migrate → `seed:prod` → MX dig → stage → activate → AE2 → AE3 → handoff)

**Expected:** POP3 **DELE-after-ingest**; app is source of truth.  
**AI:** `AI_DRAFTS_ENABLED=false`, `AI_WRITE_GATE_ENABLED=true`.  
**Post-wipe:** throttle first POP3 cycles (`WORKER_ONE_SHOT` / `POP3_MAX_MESSAGES_PER_CYCLE`) — leftover Zimbra mail will DELE-ingest.

### Superseded / deferred (hotel-prod later)

Old BCC-only internal-aggregate model + “mailbox must not be internet-reachable” + external-quarantine negative test are **out of this pilot**. Revisit when IT ships Centurion BCC + `X-Zero-Mailbox` stamp/strip for multi-user routing. Until then, direct mail to `navaai@` and in-app routing (spam OK without stamp) are the smoke path.

---

## Still true (fixture / preflight)

Current fixture scope:

- Backend runs on EC2.
- Frontend connects to backend.
- RDS/S3-backed schema works.
- Fixture ingest works.
- Fake SMTP send works.
- Isolation/load/build tests pass.

Still out of this wave (not blocking navaai@ smoke):

- Secrets Manager for mail POP3/SMTP (pilot = env-on-disk via [`stage-navaai-mail-env.sh`](./stage-navaai-mail-env.sh) + `write-ec2-env.sh`)
- IT Centurion BCC + header stamp/strip multi-user routing
- AI chatbot assistant work
- workflow-use Chromium/API integration

**In scope now:** Rocketseed sole real SMTP hop (`172.24.0.8:587` IP-trust) — see [`2026-07-31-rocketseed-sole-smtp-hop.md`](../../../docs/superpowers/plans/2026-07-31-rocketseed-sole-smtp-hop.md).

Always-on hotel VPN is **live + durable** on pilot (`Restart=on-failure`, boot/deploy HARD assert) — see [`vpn-always-on.md`](./vpn-always-on.md) + [`2026-07-22-ec2-vpn-boot-deploy-durability.md`](../../../docs/superpowers/plans/2026-07-22-ec2-vpn-boot-deploy-durability.md). New instance still needs stage → confidence → install once.

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

Production `.env.production` stays `MAIL_TRANSPORT_MODE=fixture` until cutover. Wire env is forced only inside `wire-gate.sh`.

**Fixture prod PM2:** `deploy-ec2.sh` / `ops-deploy.sh` keep `http` + `ai-worker` only — `worker` is deleted so reboot does not show an errored POP3 process. Start `worker` only via `activate-real-mail.sh` / `wire-gate.sh` after real/wire flip.

## Bedrock live gate (on-demand, not daily deploy)

Proves the EC2 instance role can invoke Bedrock-backed `global.openai.gpt-6-luna` in `us-east-1`. Daily `ai-gate.sh` spike stays on the fake adapter.

**IAM:** inline `NavaZeroBedrockInvoke` on worker role — see `aws-resources.md`.

**Pre-IT SSM:**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/bedrock-live-gate.sh'
```

`ai-worker` PM2 uses `AI_ENABLED=true`, `BEDROCK_REGION=us-east-1`. EC2/RDS stay `af-south-1`.

## Real-mail cutover gates (pilot)

Follow [`navaai-real-mail-smoke.md`](./navaai-real-mail-smoke.md) in order:

1. `vpn-health-assert.sh` → `VPN_HARD_OK`
2. `pilot-db-wipe.sh` + marker `/var/lib/nava-pilot/wipe-navaai.ok`
3. migrate + `pnpm --filter @zero/server seed:prod`
4. MX dig for `legacyhotels.co.za` (AE5); on FAIL use self-send for AE2
5. `stage-navaai-mail-env.sh` → export password → `scripts/activate-real-mail.sh`
6. AE2 inbound (external or self-send) + durable triage; spam OK
7. AE3 app outbound as `navaai@`
8. Handoff evidence + [`it-handoff-runbook.md`](./it-handoff-runbook.md)

**Hotel-prod later (deferred):** Centurion-bound BCC into `navaai@` + `X-Zero-Mailbox: centurion@legacyhotel.com` last; strip forged external stamps; multi-user visibility proofs — see [`exchange-smoke.md`](./exchange-smoke.md) deferred section.

## Current fixture expectation (pre-activate)

```text
AWS STS OK
RDS OK
S3 OK
POP3/SMTP skipped or may fail until activate-real-mail
```

## After activate expectation

```text
AWS STS still OK
SSM still Online from laptop
RDS still OK
S3 OK
VPN_HARD_OK
POP3 auth OK to 172.24.0.10; SMTP STARTTLS OK to Rocketseed 172.24.0.8 (no AUTH)
MAIL_TRANSPORT_MODE=real
AI_DRAFTS_ENABLED=false
AI_WRITE_GATE_ENABLED=true
worker online
```

## If VPN breaks AWS/SSM/RDS

- Check `ip route` default route before/after.
- Prefer split tunnel from IT.
- If no split tunnel, add VPC endpoints for `ssm`, `ssmmessages`, `ec2messages`, S3 gateway endpoint, CloudWatch Logs, Secrets Manager where needed.
- Keep RDS in local VPC path; never make RDS public to solve VPN routing.
