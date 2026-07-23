# Handoff: Live Pilot Production Parity Overnight

**Date:** 2026-07-23  
**Branch:** `EC2-pilot` @ `91270fac`  
**Instance:** `i-008f737974a9ba9b3` (`af-south-1`)  
**Repo on box:** `/home/ubuntu/repos/zero`  
**Plan:** `docs/superpowers/plans/2026-07-23-live-pilot-production-parity-overnight.md`  
**Gate:** `apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh` via `ssm-run-command.sh`

## Gate result (U9)

**PASS — 4 passed (2.8m)** — AE1 / AE7 / AE9 / AE8

```text
SPA index.html age 2478s (ok)
using SPA at https://nava.legacy.local
Running 4 tests using 1 worker
[1/4] real-mail-browser-login (AE1) … UI form login lands in inbox
[2/4] real-mail-compose-self-loopback (AE7) … compose To self appears in inbox without reload
[3/4] real-mail-force-sync-loopback (AE9) … Force Sync mutation processed then marker appears (no F5)
[4/4] real-mail-reply-loopback (AE8) … reply self appears without full page reload
  4 passed (2.8m)
Status: Success
```

Deploy path: `ops-deploy.sh --migrate` (HEAD `c5d8caec` then RCA commits synced) → health OK → `VPN_HARD_OK` / `VPN_HOTEL_OK` → gate green after e2e RCA loop.

## PM2 / `.env.production` snapshot (gate wave)

| Key | Value |
|-----|-------|
| `BETTER_AUTH_URL` | `https://nava.legacy.local` |
| `UNDO_SEND_SECONDS` | `0` (gate only) |
| `AI_WRITE_GATE_ENABLED` | `true` |
| `MAIL_TRANSPORT_MODE` | `real` |
| FE bake | `VITE_MAIL_POLL_MS=15000` (deploy-ec2 default) |

## PM2 / `.env.production` snapshot (post closeout — current)

| Key | Value |
|-----|-------|
| `BETTER_AUTH_URL` | `https://nava.legacy.local` |
| `UNDO_SEND_SECONDS` | `30` |
| `AI_WRITE_GATE_ENABLED` | `true` |
| `MAIL_TRANSPORT_MODE` | `real` |
| FE bake | `VITE_MAIL_POLL_MS=15000` |
| tip | `4a0ca36b` Download-All deployed; docs `ab9145ce` |

Patched on box before deploy (file was stale: auth URL still `http://127.0.0.1:8788`, `UNDO_SEND_SECONDS` missing). PM2 http process env matches file after deploy delete+start.

## Commits shipped (Tasks 1–12 + Task 12 RCA)

| Area | Commit | Message |
|------|--------|---------|
| T1 Auth | `8feb2e2a` | `fix(auth): trustedOrigins + BETTER_AUTH_URL for nava.legacy.local` |
| T2 Poll+forceSync | `2fbd0aaa` (+ lock RCAs) | `feat(mail): default 15s thread poll + real forceSync ingestOnce` |
| T3 Gate specs | `e12d59c4` | `feat(deploy): playwright real-mail UI gate + browser login/compose/forceSync specs` |
| T4 Reply headers | `189940d5` / `91a20e7c` | reply selected-message headers + unit-test without DB |
| T5 Reply e2e | `94642659` | `test(e2e): real-mail reply loopback after header fix` |
| T6 Attachments | `d8c3993e` | `feat(mail): SMTP attachments + FE getAttachment download` |
| T7 Undo queue | `55a02e2e` / `264a83c1` | undo/schedule queue + atomic unsend |
| T8 Inbox-first | `541c1ce2` | `fix(ingest): inbox-first direct-To; AI degraded containment` |
| T9 Honesty | `fcd9a7ef` | `fix(mail-ui): hide dead support/fake saves; Nava login copy` |
| T10 Safeties | `3be17fed` | `fix(security): print XSS escape + seed/wipe gates` |
| T11 Folders | `aa9030e3` / `77524a9a` | hotel folder colors + categoryIds; duplicate describe fix |
| T12 build | `c5d8caec` | `fix(mail): add .js extension to resolve-reply-headers import` |
| T12 e2e RCA | `d696d301`…`91270fac` | base URL / UI login / onboarding / compose click / Reply `r` suffix |

## Divergence log

| Divergence | Why |
|------------|-----|
| Patch `.env.production` via SSM sed (not full `write-ec2-env` rewrite) | Preserve live POP3/SMTP secrets; only fix gate keys |
| Gate default `PLAYWRIGHT_BASE_URL=https://nava.legacy.local` | Must match `BETTER_AUTH_URL` host |
| AE7/8/9 use UI login (mint cookies abandoned) | Minted session still landed on Login to Nava even on matching host |
| Compose via sidebar click, not `?isComposeOpen=` hard goto | Hard goto remounted onboarding / blanked SPA |
| Reply selector `/^Reply(\s+r)?$/i` | `ActionButton` accessible name is `Reply r` |
| Sync-only redeploy for e2e helper fixes (no full rebuild each RCA) | Helpers run from repo; SPA already baked with poll=15s |

## Residuals (closed / non-blocking)

- ~~`UNDO_SEND_SECONDS=0`~~ → restored **`30`** in continue-working closeout (PM2 + `.env.production`).
- `write-ec2-env.sh` / activate may still overwrite env — re-assert `BETTER_AUTH_URL` + `UNDO_SEND_SECONDS` before next U9 (set gate `0` only for that run).
- Cookie mint path in gate script still runs (assist) but specs use UI login — YAGNI cleanup later.
- EC2 git “ahead of origin by N” noise — HEAD matches pushed tip via bundle.

## Operator wake-up

1. Browse `https://nava.legacy.local` as `navaai@legacyhotels.co.za`.
2. Confirm poll ~15s + Force re-sync in user debug menu.
3. Undo window is **30s** (product). For next Playwright U9: set `UNDO_SEND_SECONDS=0`, restart, run gate, restore `30`.
4. PartyKit / multi-user / Rocketseed still out of scope.

## PLAN STATUS

**COMPLETE** — Tasks 1–12 + continue closeout. Health green. No open plan blockers.

## Continue-working closeout (2026-07-23 ~03:30 UTC+1)

| Action | Result |
|--------|--------|
| Deploy `4a0ca36b` (Download-All via getAttachment) | `ops-deploy` ok; health `{"ok":true}`; VPN_HARD_OK / VPN_HOTEL_OK |
| Restore product undo | `.env.production` + PM2 `UNDO_SEND_SECONDS=30` (was gate `0`) |
| PM2 | http/worker/ai-worker online; `BETTER_AUTH_URL=https://nava.legacy.local`; `MAIL_TRANSPORT_MODE=real`; `AI_WRITE_GATE_ENABLED=true` |

**Plan done criteria:** met. U9 gate previously green (4/4). Post-gate FE fix deployed. Product undo window restored.

**Not re-run:** full Playwright U9 (gate requires `UNDO=0`); product now on `30`.
