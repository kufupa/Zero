# Exchange / Real Mail Smoke

**Pilot (current):** internet-reachable **`navaai@legacyhotels.co.za`** — sole POP3 sink + Nava SMTP identity on Zimbra `172.24.0.10`.

Full ordered cutover: [`navaai-real-mail-smoke.md`](./navaai-real-mail-smoke.md).

## Pilot smoke (navaai@)

When real mail is in scope for this pilot:

```text
external or app self-send lands in navaai@ (Zimbra)
worker RETR → S3 + PG → DELE (expected drain)
thread visible in Nava app (inbox or spam OK without X-Zero-Mailbox)
durable inbound_triage write exists (AI_WRITE_GATE_ENABLED=true)
AI_DRAFTS_ENABLED=false
app send as navaai@legacyhotels.co.za via real SMTP (not fixture FakeSmtp)
```

Centurion inbox may stay empty until hotel IT BCC + stamp (deferred below).

## Preconditions

1. VPN always-on green — `bash apps/server-pilot/deploy/vpn-health-assert.sh` → `VPN_HARD_OK` (see [`vpn-always-on.md`](./vpn-always-on.md)).
2. Wipe marker present: `/var/lib/nava-pilot/wipe-navaai.ok` (from `pilot-db-wipe.sh`) then migrate + `seed:prod`.
3. Password staged: `stage-navaai-mail-env.sh` → `/run/nava-mail/password`; export into shell **before** activate smoke.
4. `POP3_HOST`/`SMTP_HOST=172.24.0.10`, `POP3_USER`/`SMTP_USER=navaai@legacyhotels.co.za` (activate defaults).
5. MX dig for `legacyhotels.co.za` (AE5) — on FAIL use self-send for inbound proof.
6. Fixture/fake gates green before flip.

## Smoke steps (pilot)

1. Activate via `apps/server-pilot/scripts/activate-real-mail.sh` (port probe + POP3/SMTP auth + env write + one-shot).
2. Confirm `.env.production`: `MAIL_TRANSPORT_MODE=real`, `AI_DRAFTS_ENABLED=false`, `AI_WRITE_GATE_ENABLED=true`.
3. Send test To:`navaai@legacyhotels.co.za` (external if MX PASS, else app self-send).
4. Throttle backlog after wipe: `WORKER_ONE_SHOT=1` / low `POP3_MAX_MESSAGES_PER_CYCLE` on first cycles.
5. `pm2 logs worker --lines 50` — ingest + DELE; subject in app.
6. App outbound as `navaai@legacyhotels.co.za`; confirm real SMTP path.

## Deferred — hotel-prod multi-user (not pilot)

Old BCC-only / internal-aggregate + “not internet-reachable” + external-quarantine negative test are **superseded for this pilot**. Revisit later:

1. **Transport rule:** Centurion-bound mail → BCC `navaai@legacyhotels.co.za` + set `X-Zero-Mailbox: centurion@legacyhotel.com` (last).
2. **Strip rule:** Remove forged external `X-Zero-Mailbox` before relay stamp.
3. Role visibility: manager/member see Centurion thread; frontdesk cannot.
4. Reply Send-As Centurion (Infor / separate wave).

## Rollback

If real ingest causes issues, stop worker (`pm2 stop worker`), set `MAIL_TRANSPORT_MODE=fixture` via `write-ec2-env.sh` + `deploy-ec2.sh`, and quarantine unmapped messages via `mailIngestQuarantine`. See [`it-handoff-runbook.md`](./it-handoff-runbook.md).
