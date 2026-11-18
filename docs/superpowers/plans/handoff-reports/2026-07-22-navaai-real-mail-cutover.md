# Handoff: navaai@ real-mail cutover (EC2 pilot)

**Date:** 2026-07-22  
**Branch:** `EC2-pilot`  
**Instance:** `i-008f737974a9ba9b3` (`af-south-1`)  
**Repo on box:** `/home/ubuntu/repos/zero`  
**Runbook:** `apps/server-pilot/deploy/navaai-real-mail-smoke.md`

## AE results

| AE | Result | Evidence |
|----|--------|----------|
| **AE1** env/gates | **PASS** | `.env.production`: `MAIL_TRANSPORT_MODE=real`, `SMTP_USER=navaai@legacyhotels.co.za`, `POP3_USER=navaai@…`, `POP3_HOST/SMTP_HOST=172.24.0.10`, `POP3_PORT=995`/`POP3_TLS=true`, `SMTP_PORT=587`, `AI_DRAFTS_ENABLED=false`, `AI_WRITE_GATE_ENABLED=true`, `MAIL_TLS_REJECT_UNAUTHORIZED=false` |
| **AE2** inbound | **PASS** | App `mail.send` self-send To:`navaai@legacyhotels.co.za` subject `AE2-real-20260722T195732Z` → POP3 one-shot `listed:1 processed:1 deled:1` → DB inbound row `1b382a17-…` + durable `ai_workflow_run` `inbound_triage` `queued` (`56fa96fc-…`) |
| **AE3** outbound | **PASS** | Same send returned `smtpMessageId=…@legacyhotels.co.za` (not `zero-fake-smtp.local`); outbound row `bd5f8dd0-…` |
| **AE4** keys-only verify | **PASS** | grep keys only on `.env.production` (no password values logged) |
| **AE5** MX | **PASS** | `nslookup -type=MX legacyhotels.co.za` → `fm-mail-in.voxtelecom.co.za` (pref 10). Self-send still used for AE2 (faster / controlled) |

## Cutover sequence (executed)

1. `ops-deploy.sh` → health OK + `VPN_HARD_OK` / `VPN_HOTEL_OK`
2. Wipe: `CONFIRM=WIPE_PILOT_DB bash pilot-db-wipe.sh` → marker `/var/lib/nava-pilot/wipe-navaai.ok`
3. `pnpm --filter @zero/server seed:prod` → `ingest mailbox: navaai@legacyhotels.co.za`, transports count 2
4. `stage-navaai-mail-env.sh` → `STAGED_OK` (`/run/nava-mail/password` mode 600)
5. `activate-real-mail.sh` → POP3 auth OK `:995`, SMTP auth OK `:587`, wrote real `.env.production`, redeploy
6. AE2/AE3 via `nava-ops@` session → `POST /api/trpc/mail.send` → one-shot worker

## Divergences / RCA (logged)

| Issue | Fix |
|-------|-----|
| Stage S3 `403 HeadObject` — IAM missing `mail-navaai/*`; also `sudo aws` drops IMDS | Patched `NavaZeroBootstrapBundleRead`; stage downloads as ubuntu then `sudo cp` |
| POP3 `CERT_HAS_EXPIRED` on 995 / SMTP `ESOCKET` on 587 | `MAIL_TLS_REJECT_UNAUTHORIZED=false` in POP3 TLS + nodemailer + activate; hotel Zimbra cert expired |
| `sudo deploy/write-ec2-env.sh` → command not found | Absolute path `sudo -E bash …/write-ec2-env.sh` |
| `pm2 startOrReload --update-env` left http on FakeSmtp after fixture→real | `deploy-ec2.sh` / `ops-restart.sh` now **delete+start** so env refreshes |
| Post-handoff PM2 `worker` → `errored` (empty logs, restart storm) | Dual root cause: (1) `abortableSleep` `.unref()` let Node exit on empty inbox; (2) **PM2 sets `argv[1]=ProcessContainerFork.js`**, so `import.meta.url === pathToFileURL(argv[1])` never matched → `main()` never ran. Fixed via `isCliEntry(..., 'worker'|'ai-worker')` + ref'd sleep. |

## Operator notes

- Password: laptop `live real data connection/navaai-mail-pass.txt` → stage script only (never SSM argv / never git)
- AI drafts stay **off**; write gate **on**
- Worker DELE after durable ingest (Zimbra not long-lived SoT)
- Centurion = local `mailbox_transport` only (no second POP3 this wave)
- Day-to-day: `ops-deploy.sh` / `ops-restart.sh` / `ops-reboot.sh` — see `it-handoff-runbook.md`

## Blockers

None for AE1–AE5. Hotel should renew Zimbra TLS cert so `MAIL_TLS_REJECT_UNAUTHORIZED` can return to default verify.
