# Handoff: Rocketseed sole SMTP hop (2026-07-31)

## Goal

`MAIL_TRANSPORT_MODE=real` outbound SMTP connects only to Rocketseed `172.24.0.8:587` (IP-trust, never AUTH). POP3 stays Zimbra `172.24.0.10`.

## Code shipped (`EC2-pilot`)

| Commit | Summary |
|--------|---------|
| `ba66a74c` | `assertRealSmtpHop`; AUTH omit; strict STARTTLS+SNI |
| `233dfcbd` | activate + write-ec2-env Rocketseed defaults |
| `3fd4637d` | CONCEPTS / runbooks / CE sole-hop section |

## Local verification

- `tests/transport-mode.test.ts` — 20 passed (hop pin, leftover-password no AUTH, TLS split, wire/fixture)
- `tests/deploy-config.test.ts` — activate-real-mail + write-ec2-env assertions passed
- Task reviewer: **APPROVED**

## EC2 cutover evidence (redacted)

| Check | Result |
|-------|--------|
| `ops-deploy.sh` | ok; health `{"ok":true}`; VPN_HARD_OK |
| Pre-cutover `.env` | `SMTP_HOST=172.24.0.10` (stale) |
| Post-cutover `.env` | `SMTP_HOST=172.24.0.8`, `SMTP_PORT=587` |
| STARTTLS smoke (no AUTH) | `SMTP_STARTTLS_OK` |
| Nava self canary | token `ZERO-RS-HOP-2026-07-31T21-09-18`; SMTP accepted via `createSmtpTransport` host `.8` |
| Centurion→Gmail canary | token `ZERO-RS-CENT-HOP-2026-07-31T21-09-49`; SMTP accepted host `.8`; no audit BCC on this probe |

Nava unbranded remains expected (tenant). Centurion banner expected on Gmail for human spot-check (same hop as prior confirmed canary).

## Ops note

Full `activate-real-mail.sh` not re-run end-to-end (would need POP3 password stage). Cutover applied by sync/deploy + `SMTP_HOST` rewrite + STARTTLS smoke + `ops-restart`. Future activate defaults SMTP to `.8` and fails closed on `.10`.

## Done criteria

- [x] Real factory rejects non-`.8`
- [x] Never AUTH on Rocketseed with leftover password
- [x] Strict SMTP TLS+SNI
- [x] Activate/write-ec2-env contract
- [x] Docs + CE
- [x] Live send on `.8` with 250
- [x] Centurion From accepted on same hop (banner = human Gmail check / prior proof)
