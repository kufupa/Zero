# Mail Wire Mock & Cross-Mailbox Testing — Requirements

**Date:** 2026-07-04  
**Status:** Draft — awaiting confirmation  
**Builds on:** Nava fixture loopback gate (green at `4f38697d`), `MAIL_TRANSPORT_MODE` fixture|real pattern

## Problem

Fixture **loopback** is a custom in-process RAM queue (`fixture-loopback.ts`): `mail.send` enqueues RFC822, `FakePop3Client.connect()` drains it. It proves **app logic** (routing, folders, isolation) but **not** mail-server integration — no TCP, no POP3 UIDL/RETR/DELE wire, no SMTP relay semantics, no multi-recipient delivery timing.

We need a path to test **the same `RealPop3Client` / `RealSmtpTransport` code** that IT handoff will use, without Exchange/VPN — and extend to **cross-mailbox** ingest routing.

## What we're building

A **wire-fidelity mail mock layer** that sits between fixture (fast, in-memory) and real (Exchange). Worker and send paths use real TCP clients against a controllable local server. Vitest + optional EC2 gate prove multi-mailbox routing via SMTP inject → POP3 poll → folder assertions.

## Success criteria

- New transport mode (proposed: `wire`) uses `RealPop3Client` + `RealSmtpTransport` against localhost mock — **not** `FakePop3` / loopback queue.
- At least one automated test: SMTP send (or inject) with `X-Zero-Mailbox` for mailbox A → worker ingest → correct transport inbox; repeat for mailbox B; negative isolation case.
- EC2 gate can run wire suite without VPN (mock as PM2 sidecar or vitest lifecycle).
- Fixture mode + loopback E2E **unchanged** — fast path stays fast.

## Non-goals

- Replacing fixture loopback for daily deploy gate (keep both).
- Playwright/browser E2E (separate track).
- Real Exchange deliverability (SPF/DKIM).
- Tier5 bug backlog.

## Recommended approach (brainstorm consensus)

**Primary:** `MAIL_TRANSPORT_MODE=wire` + **Mailpit sidecar** on EC2/vitest.

| Why Mailpit over pure Node libs |
|--------------------------------|
| SMTP + POP3 + REST API in one binary |
| Matches production pull model (worker polls POP3) |
| `RealPop3Client` already implemented and socket-tested |
| Node `smtp-server` / `email-fake` = SMTP only — still need POP3 |
| GreenMail = JVM — heavy for TS monorepo |

**Vitest pattern:** start Mailpit (or assume EC2 sidecar), set `POP3_HOST`/`SMTP_HOST` to localhost, `MAIL_TRANSPORT_MODE=wire`, run ingest worker + assertions via `mailpit-api` or REST.

**Fallback (code-only):** embed `smtp-server` for send assertions only — does **not** satisfy full ingest wire test without also building POP3.

## Priority stack

| P | What | Why | How |
|---|------|-----|-----|
| **1** | `wire` transport mode | Loopback ≠ mail server; can't catch protocol/framing bugs before IT | Extend `env.ts` + factories; point real clients at Mailpit ports |
| **2** | Cross-mailbox wire suite | User goal: all mailboxes ingest + route correctly | SMTP inject per transport email + `X-Zero-Mailbox`; assert inbox/spam per user |
| **3** | EC2 wire gate (optional tier) | Prove wire path on prod RDS, not just laptop | PM2 `mailpit` on instance; SSM gate script variant or flag |
| **4** | IT handoff hardening | Production path | `activate-real-mail.sh` after wire green |
| **5** | Browser E2E | Lower leverage — API E2E exists | Playwright + Mailpit wait later |

## Glaring app gaps (current)

| Gap | Severity | Notes |
|-----|----------|-------|
| No wire-fidelity mail test | **Medium** | Loopback covers logic only |
| Real Exchange not connected | **Expected** | Blocked on IT/VPN |
| Cross-mailbox wire E2E | **Medium** | Isolation tested in fixture only |
| `nava-ops@` login creds | **Low** | Secrets Manager; `seed:prod --rotate` if needed |
| Playwright UI E2E | **Low** | Out of Nava wave scope |

Nothing **blocking** fixture pilot; wire mock is the highest-leverage next increment.

## Outstanding questions

1. **Gate cadence:** wire tests every deploy vs weekly/pre-IT only?
2. **Mock hosting:** Mailpit binary on EC2 vs vitest-spawned subprocess?
3. **IT timeline:** if handoff < 2 weeks, swap P3/P4 priority?

## Handoff

→ `/ce-plan` for: `wire` mode schema, Mailpit lifecycle in vitest, cross-mailbox test matrix, EC2 pm2 unit file.
