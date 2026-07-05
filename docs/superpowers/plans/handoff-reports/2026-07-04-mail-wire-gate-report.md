# Mail Wire Gate Report — 2026-07-04

**Gate:** `wire-gate.sh` (Option B — pre-IT only)  
**Deployed SHA:** `d1f8c3bec11` (`fix(test): WIRE-3 drain mailpit POP3 before ingest`)  
**EC2:** `i-008f737974a9ba9b3` (`af-south-1`)  
**Mailpit:** v1.27.3 (`/usr/local/bin/mailpit`)

## Results

| Check | Status |
|-------|--------|
| Mailpit sidecar | PM2 `mailpit` on 127.0.0.1:11025/11110/18025 |
| Vitest wire suite | **19/19 pass** (2.45s) |
| WIRE-1 centurion inbox | PASS |
| WIRE-2 Nava spam | PASS |
| WIRE-3 sent only | PASS |
| WIRE-4 isolation | PASS |
| **wire-gate.sh** | **PASS** (SSM Success, ~10m) |

Production transport unchanged: `MAIL_TRANSPORT_MODE=fixture` in `.env.production`.

## Wave commits (Tasks 1–6)

| Task | Commit | Message |
|------|--------|---------|
| 1 | `668b73a4` | feat(mail): add wire transport mode to env and factories |
| 2 | `521561a5` | test(mail): add mailpit lifecycle helper |
| 3 | `5d335279` | test(mail): add wire E2E suite over Mailpit TCP |
| 4 | `da306bf5` | feat(deploy): add mailpit sidecar and wire gate script |
| 5 | `5616d1a9` | docs(mail): document wire transport and option B gate |
| 6 fixes | `607fa804` | fix(deploy): start mailpit sidecar with pm2 startOrReload |
| 6 fixes | `4dcb3c8d` | fix(deploy): pm2 start mailpit binary directly in wire gate |
| 6 fixes | `d1f8c3be` | fix(test): WIRE-3 drain mailpit POP3 before ingest |

## RCA notes

1. **PM2 ecosystem parse crash** (`607fa804` attempt): `pm2 startOrReload mailpit.ecosystem.cjs` ran the file as Node and threw `Cannot read properties of undefined (reading 'deploy')`. **Fix:** `pm2 start /usr/local/bin/mailpit --interpreter none` with CLI flags + `MP_POP3_AUTH` env (`4dcb3c8d`). Separate `pm2 delete` for ghost `mailpit.ecosystem` process.

2. **WIRE-3 false fail** (first green mailpit run): Mailpit captures app SMTP and re-exposes via POP3; `ingestOnce` re-imported `wire-outbound` into inbox. Fixture E2E-3 uses empty `FakePop3Client` — no re-ingest. **Fix:** `await ctx.clearAll()` after external send, before ingest (`d1f8c3be`). Documents harness semantics: external-only sends are not in ingest mailbox.

## Cadence

- **Every deploy:** `fixture-loopback-gate.sh` (unchanged)
- **Pre-IT:** `wire-gate.sh` (this report)

## Next

- IT handoff: `activate-real-mail.sh` after wire green
- Flip `MAIL_TRANSPORT_MODE=real` only when Exchange creds + VPN ready
