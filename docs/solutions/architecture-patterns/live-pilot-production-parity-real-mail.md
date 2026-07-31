---
title: Live Pilot Production Parity for Real Mail on EC2
date: 2026-07-23
last_updated: 2026-07-23
category: architecture-patterns
module: server-pilot real mail
problem_type: architecture_pattern
component: email_processing
severity: high
applies_when:
  - Standing up or verifying nava.legacy.local live pilot against real Zimbra mailbox
  - Shipping auth trustedOrigins plus BETTER_AUTH_URL for SPA host parity
  - Enabling 15s poll, forceSync ingestOnce, and mailbox lock on real transport
  - Running Playwright real-mail UI gate U9 (AE1/AE7/AE9/AE8) via ops-deploy
  - Temporarily setting UNDO_SEND_SECONDS=0 for gate speed then restoring product undo
related_components:
  - authentication
  - development_workflow
  - testing_framework
  - tooling
tags:
  - ec2-pilot
  - live-pilot
  - production-parity
  - real-mail
  - playwright-u9
  - force-sync
  - better-auth
  - undo-send
---

# Live Pilot Production Parity for Real Mail on EC2

## Context

Nava Zero EC2 pilot (`EC2-pilot`, instance `i-008f737974a9ba9b3`, `af-south-1`) needed production-parity UX at `https://nava.legacy.local` for mailbox `navaai@legacyhotels.co.za` with live hotel mail (`MAIL_TRANSPORT_MODE=real`). Prior work established transport mode switching (fixture → wire → real), ops-deploy/restart entrypoints, and the Mastra/ai-worker pipeline. The overnight gap was end-to-end product parity: Better Auth cookies on the nginx SPA host, near-realtime inbox without F5, reply headers and reply-all, attachment send/download, undo/schedule outbound queue, inbox-first ingest, honesty UI (no fake Live Support / Saves), print XSS + seed/wipe safeties, hotel folder categoryIds/colors, and a Playwright real-mail UI gate (U9) proving the loop on EC2.

(session history) Audit framed the gap as demo polish missing on the live path — not wholesale FE deletion. Named friction included CSRF/`Invalid origin`, attachments, undo stubs, forever Syncing (PartyKit dead), reply headers, honesty/safeties. Send/receive on real SMTP/POP3 was already treated as working before parity overnight.

What shipped (Tasks 1–12) and verified morning 2026-07-23:

1. **Auth** — `trustedOrigins` + `BETTER_AUTH_URL=https://nava.legacy.local` so session cookies bind to the SPA host (not `http://127.0.0.1:8788`).
2. **Near-realtime** — FE poll default `VITE_MAIL_POLL_MS=15000`; real `forceSync` → `ingestOnce` with mailbox lock.
3. **U9a** — Playwright browser login (AE1) against real SPA.
4. **Reply** — selected-message reply headers + `replyToMessageId` reply-all.
5. **U9b** — reply self-loopback without full page reload (AE8).
6. **Attachments** — SMTP send + FE `getAttachment` download; later Download-All via same path.
7. **Undo/schedule** — outbound queue + migration; gate requires `UNDO_SEND_SECONDS=0`; product restore `UNDO_SEND_SECONDS=30` after gate.
8. **Inbox-first ingest** — direct-To lands Inbox; AI triage degraded containment.
9. **Honesty** — hide dead Live Support / fake Saves; Nava login copy.
10. **Safeties** — print XSS escape + seed/wipe gates.
11. **Hotel folders** — categoryIds + colors.
12. **EC2 deploy** — `ops-deploy.sh` (+ `--migrate` when schema) + U9 PASS 4/4 (~2.8m) + handoff.

Gate result (U9): AE1 login, AE7 compose self-loopback, AE9 forceSync loopback, AE8 reply loopback — all green without F5. Post-closeout: health ok; PM2 `http` / `worker` / `ai-worker` online; product `UNDO_SEND_SECONDS=30`; `BETTER_AUTH_URL` set; SPA 200.

Critical ops learning: the Playwright gate script **refuses** unless `UNDO_SEND_SECONDS=0` (deterministic immediate flush). After the gate, operators **must** restore `UNDO_SEND_SECONDS=30` and restart PM2 or undo UX is broken. `write-ec2-env.sh` / activate paths can overwrite `.env.production` — re-assert `BETTER_AUTH_URL` and `UNDO_SEND_SECONDS` before and after any gate run.

Plans/handoff: `docs/superpowers/plans/2026-07-23-live-pilot-production-parity-overnight.md`, `docs/superpowers/plans/handoff-reports/2026-07-23-live-pilot-parity-overnight.md`.

## Guidance

### Production-parity env contract (live pilot)

Keep these keys aligned on box (`.env.production` **and** running PM2 env after delete+start / `ops-restart`):

| Key | Product value | Gate-only value | Notes |
|-----|---------------|-----------------|-------|
| `MAIL_TRANSPORT_MODE` | `real` | `real` | Do **not** flip to fixture for U9 |
| `BETTER_AUTH_URL` | `https://nava.legacy.local` | same | Must match SPA / `PLAYWRIGHT_BASE_URL` host |
| `UNDO_SEND_SECONDS` | `30` | `0` | Gate refuses non-zero; restore 30 after |
| `AI_WRITE_GATE_ENABLED` | `true` | `true` | Opt-in AI product writes |
| FE bake | `VITE_MAIL_POLL_MS=15000` | baked in SPA | deploy-ec2 / ops-deploy default |

Patch live env surgically (SSM sed / targeted edit). Prefer **not** full `write-ec2-env` rewrite when POP3/SMTP secrets must stay. After any activate / write-env / deploy that rewrites the file: re-assert `BETTER_AUTH_URL` + `UNDO_SEND_SECONDS`.

(session history) Leaving `BETTER_AUTH_URL` at `http://127.0.0.1:8788` caused CSRF `Invalid origin` / cookie host mismatch. Cookie mint against `127.0.0.1` failed when auth URL is `nava.legacy.local` — AE7/8/9 bounced to login; mint path abandoned for UI form login.

### Near-realtime without F5

- Thread list polls at ~15s (`VITE_MAIL_POLL_MS=15000`).
- Open thread detail must share the same foreground poll policy (`openThreadQueryPollingOptions` on `useThread` / `mail.get`) — list bump alone leaves an open pane stale until hard refresh. See [mail-open-thread-stale-and-recipient-you-label.md](../logic-errors/mail-open-thread-stale-and-recipient-you-label.md).
- Force Sync (user debug menu) calls real `forceSync` → `ingestOnce` under mailbox lock — marker / new mail appears without hard reload.
- Compose and reply loopbacks must land via poll + sync, not `location.reload`.

(session history) Wait budgets ≤20s raced the 15s poll — gate waits should be ≥60s; AE9 must await `forceSync` mutation `{processed}` (not just poll). Near-realtime this pass = poll + forceSync; PartyKit deferred.

### Reply and attachments

- Reply uses selected-message headers; reply-all wires `replyToMessageId`.
- Accessible Reply control may read `Reply r` (`ActionButton`) — e2e selectors need `/^Reply(\s+r)?$/i`.
- Attachments: SMTP outbound + FE `getAttachment` for single and Download-All; snapshot attachments at queue time.

### Undo / schedule queue vs gate timing

Outbound send goes through undo/schedule queue. Product UX uses a 30s undo window. Playwright U9 needs immediate flush so compose/reply assertions are deterministic:

1. Set `UNDO_SEND_SECONDS=0` in `apps/server-pilot/.env.production`.
2. `bash apps/server-pilot/deploy/ops-restart.sh` (or equivalent PM2 bounce so http/worker pick up env).
3. Run U9 gate (below).
4. **Restore** `UNDO_SEND_SECONDS=30`, restart again, confirm PM2 env matches file.

Gate script hard-check: if `UNDO_SEND_SECONDS` is unset or not `0`, exit with hint to set `0` then `ops-restart.sh`.

(session history) Product undo 15–30s holds mail before SMTP → POP3 empty during short gate wait → false red on “realtime.” Same queue path with `UNDO=0` sync-flushes for the gate; product stays 30s for humans. Handoff initially left PM2 at gate `0`; continue wave restored `30`.

### Playwright real-mail UI gate (U9)

Script: `apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh` (SSM via `ssm-run-command.sh`).

Preflight:

- Refuses `ZERO_DEMO_FRONTEND_ONLY=1` / `VITE_FRONTEND_ONLY=1` (real-mail proof must not poison with demo FE).
- Default `PLAYWRIGHT_BASE_URL=https://nava.legacy.local` — must match `BETTER_AUTH_URL` host.
- Requires backend `/health` and SPA `/` reachable.
- Specs: `real-mail-browser-login` (AE1), `real-mail-compose-self-loopback` (AE7), `real-mail-force-sync-loopback` (AE9), `real-mail-reply-loopback` (AE8).

E2e divergences that stuck:

- Prefer **UI form login** over minted cookies for AE1 (KTD11: curl/session mint ≠ proving browser login).
- Compose via sidebar click — hard goto `?isComposeOpen=` remounted onboarding / blanked SPA.
- Sync-only redeploy OK for helper/RCA fixes when SPA already baked with poll=15s.
- First deploy failed on missing `.js` extension in `resolve-reply-headers` import.

Expected green: **4 passed** in ~2–3 minutes (verified ~2.8m). Full U9 not re-run after product undo restore (gate requires `UNDO=0` again).

### Deploy / ops

Primary ship path: `bash apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema changes). Bounce without rebuild: `ops-restart.sh`. After deploy: health OK, VPN HARD/HOTEL asserts as existing ops docs require. Do not restage VPN secrets every deploy.

### Honesty and safeties (parity checklist)

- Hide non-functional Live Support and fake Saves affordances.
- Escape print paths against XSS; keep seed/wipe behind gates.
- Hotel folders: durable categoryIds + colors consistent with triage/UI.

## Why This Matters

Live pilot “online” is not parity. Without host-matched auth, 15s poll + real forceSync, reply headers, attachments, and undo queue, operators still see a demo-shaped inbox on real POP3/SMTP. Without the U9 gate, regressions hide until a human clicks through VPN SPA. The UNDO=0 gate requirement is correct for timing — but forgetting restore to 30 silently breaks product undo after every green gate. Env rewrite tools (`write-ec2-env` / activate) can drop `BETTER_AUTH_URL` or `UNDO_SEND_SECONDS` and recreate morning-of stale-auth / missing-undo incidents. Encoding the assert → gate → restore loop keeps real-mail proof and product UX both true.

## When to Apply

- Shipping or verifying production-parity UX on EC2 for `nava.legacy.local` with `MAIL_TRANSPORT_MODE=real`.
- Before/after Playwright U9 (`playwright-real-mail-ui-gate.sh`): set UNDO=0 → run → restore UNDO=30 → restart → confirm PM2.
- After `write-ec2-env`, activate-real-mail, or any full env rewrite: re-assert `BETTER_AUTH_URL` + `UNDO_SEND_SECONDS`.
- Debugging “stuck on Login” or cookie failures when SPA host ≠ auth URL.
- Proving compose/reply/forceSync appear without F5 (AE7 / AE8 / AE9).
- Not for daily fixture deploy gates — those stay on fixture/wire paths documented elsewhere; U9 stays real-transport only.

## Examples

### Product steady-state (post-gate closeout)

```bash
# apps/server-pilot/.env.production (illustrative keys only — no secrets)
BETTER_AUTH_URL=https://nava.legacy.local
MAIL_TRANSPORT_MODE=real
UNDO_SEND_SECONDS=30
AI_WRITE_GATE_ENABLED=true
# FE bake includes VITE_MAIL_POLL_MS=15000
```

Confirm: health ok; `pm2` http/worker/ai-worker online; SPA `https://nava.legacy.local` → 200; PM2 env matches file for auth URL and undo seconds.

### U9 gate cycle (deterministic send, then restore product undo)

```bash
# 1) Gate mode
# set UNDO_SEND_SECONDS=0 in apps/server-pilot/.env.production
bash apps/server-pilot/deploy/ops-restart.sh

# 2) Run real-mail UI gate on EC2 (via SSM / ssm-run-command.sh)
bash apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh
# Expect: 4 passed (AE1, AE7, AE9, AE8) — refuse if UNDO != 0 or demo FE on

# 3) Product restore (mandatory)
# set UNDO_SEND_SECONDS=30 in apps/server-pilot/.env.production
bash apps/server-pilot/deploy/ops-restart.sh
# re-assert BETTER_AUTH_URL=https://nava.legacy.local if env tools rewrote the file
```

### Auth host alignment

```bash
# PLAYWRIGHT_BASE_URL and BETTER_AUTH_URL must share host
export PLAYWRIGHT_BASE_URL=https://nava.legacy.local
# BETTER_AUTH_URL=https://nava.legacy.local
# Wrong: auth on http://127.0.0.1:8788 while SPA is nava.legacy.local → login/cookie failure
```

### Operator wake-up smoke

1. Browse `https://nava.legacy.local` as `navaai@legacyhotels.co.za`.
2. Confirm ~15s poll + Force re-sync in user debug menu.
3. Confirm undo window is **30s** (product). Next U9: UNDO=0 → gate → restore 30.
4. PartyKit / multi-user / Rocketseed remain out of scope.

## Related

- [playwright-e2e-ec2-pilot-ui-gate.md](../test-failures/playwright-e2e-ec2-pilot-ui-gate.md) — Playwright/SSM runner + cookie mint (U9 reuses path; requires UI login + UNDO=0)
- [mail-transport-mode-fixture-vs-real.md](../architecture-patterns/mail-transport-mode-fixture-vs-real.md) — transport factory; U9 stays on `real`
- [ec2-pilot-ops-deploy-restart-reboot.md](../workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md) — ops-deploy / ops-restart for env bounce
- [pm2-esm-is-cli-entry-and-unref-sleep.md](../runtime-errors/pm2-esm-is-cli-entry-and-unref-sleep.md) — workers must stay online after real-mail
- [ec2-pilot-nava-openvpn-always-on-health.md](../workflow-issues/ec2-pilot-nava-openvpn-always-on-health.md) — VPN HARD behind real Zimbra
- [live-ai-mail-pipeline-mastra-worker-gates.md](../architecture-patterns/live-ai-mail-pipeline-mastra-worker-gates.md) — adjacent opt-in live gate pattern
- [nava-fixture-loopback-e2e-harness.md](../architecture-patterns/nava-fixture-loopback-e2e-harness.md) — contrasting fixture harness (not a U9 substitute)
