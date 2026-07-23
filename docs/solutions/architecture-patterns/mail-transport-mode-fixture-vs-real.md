---
title: MAIL_TRANSPORT_MODE Fixture vs Real Transport Pattern
date: 2026-07-02
last_updated: 2026-07-23
category: architecture-patterns
module: server-pilot mail ingest
problem_type: architecture_pattern
component: email_processing
severity: medium
applies_when:
  - EC2 deploy gates need prod RDS exercise without real Exchange POP3/SMTP
  - IT handoff flips MAIL_TRANSPORT_MODE from fixture to real with one env change plus redeploy
tags:
  - mail-transport-mode
  - fixture
  - pop3
  - smtp
---

# MAIL_TRANSPORT_MODE Fixture vs Real Transport Pattern

## Context

The EC2 pilot is production-scoped — single ingest mailbox (`navaai@legacyhotels.co.za` on hotel Zimbra) plus logical hotel identities. Before real-mail cutover, the backend had to run on real RDS and S3 while mail-server TCP stayed off. `MAIL_TRANSPORT_MODE` (`fixture` | `wire` | `real`) lets fake, Mailpit, and real POP3/SMTP adapters share identical interfaces and the same downstream persistence path (S3 → Postgres transaction → message row). As of 2026-07-22 the pilot runs `real` against Zimbra; fixture/wire remain the deploy-gate and Mailpit paths.

## Guidance

### Mode matrix

| Setting | `fixture` (default) | `wire` | `real` |
|---------|---------------------|--------|--------|
| POP3 | `FakePop3Client` + fixture `.eml` dir | `RealPop3Client` → Mailpit | `RealPop3Client` |
| SMTP | `FakeSmtpTransport` ring buffer | `RealSmtpTransport` → Mailpit | `RealSmtpTransport` (nodemailer) |
| TCP to mail server | None | `127.0.0.1` Mailpit sidecar | VPN route to hotel Zimbra |
| Downstream path | Same store/ingest transaction | Identical | Identical |

### Factory pattern

`createPop3Client(env)` returns Fake when `MAIL_TRANSPORT_MODE` is `fixture` **even if** `POP3_HOST` is set — prevents accidental real connect during deploy gates.

`createPop3Client` / `createSmtpTransport` use real TCP clients when mode is `wire` or `real`.

`maybeEnqueueLoopback` is disabled for `wire` and `real` — wire path must not use `FixtureLoopbackStore`.

### Wire gate (Option B — pre-IT)

`wire-gate.sh` runs `MAIL_TRANSPORT_MODE=wire` vitest against Mailpit on prod RDS. **Not** part of every deploy — `fixture-loopback-gate.sh` stays the fast daily gate. PM2 `mailpit` binds `127.0.0.1` only.

### Autonomous deploy gate (fixture on prod RDS)

Post-deploy with `MAIL_TRANSPORT_MODE=fixture`:

1. Login → inbox 200
2. Worker runs one bounded FakePop3 cycle — idempotent UIDLs
3. PM2 logs show `transport.mode=fixture`; no TCP to mail ports

### IT handoff

Prerequisite: always-on hotel OpenVPN healthy (HARD assert / split tunnel). See [ec2-pilot-nava-openvpn-always-on-health.md](../workflow-issues/ec2-pilot-nava-openvpn-always-on-health.md) — do not restage VPN on every deploy.

`activate-real-mail.sh`: store secrets → VPN route check → POP3/SMTP smoke → set `MAIL_TRANSPORT_MODE=real` → redeploy → one real ingest cycle with `--max-messages 1`. After activate, confirm PM2 `worker` out logs show poll cycles (`online` alone can mask a silent `main()` skip under ProcessContainerFork).

## Why This Matters

Without fixture mode, deploy gates either skip ingest (untested store path) or require live hotel mail (VPN + credentials). Fake adapters mirroring real interfaces mean code exercised on every deploy is the same code activated for `real`.

## When to Apply

- **Daily gates / safe default:** `MAIL_TRANSPORT_MODE=fixture` when not proving hotel mail (unset still defaults fixture in code paths that care).
- **Pre-real TCP confidence:** run `wire-gate.sh` via SSM for Mailpit.
- **Live hotel mail:** `real` after VPN HARD assert + activate/smoke; verify one ingest cycle **and** PM2 `worker` out logs (status `online` alone is not enough — see PM2 ESM entry learning).
- **Production-parity UI proof (U9):** keep `real` — do **not** flip to fixture for Playwright real-mail gate. U9 exercises compose/reply/forceSync on live Zimbra; see [live-pilot-production-parity-real-mail.md](./live-pilot-production-parity-real-mail.md).
- **Never:** set `real` without VPN reachability to the mail host and staged credentials.

## Examples

```bash
# Pilot .env.production
MAIL_TRANSPORT_MODE=fixture
INGEST_FIXTURE_DIR=/home/ubuntu/repos/zero/apps/server-pilot/tests/fixtures
```

## Related

- [live-pilot-production-parity-real-mail.md](./live-pilot-production-parity-real-mail.md) — production-parity UX on `real` transport (auth host, poll, U9 gate, undo queue)
- [ec2-pilot-nava-openvpn-always-on-health.md](../workflow-issues/ec2-pilot-nava-openvpn-always-on-health.md) — always-on OpenVPN durability / HARD assert (prerequisite for `real`)
- [pm2-esm-is-cli-entry-and-unref-sleep.md](../runtime-errors/pm2-esm-is-cli-entry-and-unref-sleep.md) — after `real` flip, `worker` must enter `main()` under PM2 (not just show `online`)
- [2026-07-02-ec2-pilot-bug-fixes.md](../../superpowers/plans/2026-07-02-ec2-pilot-bug-fixes.md) (Task 19)
- [deferred-real-mail-readiness.md](../../../apps/server-pilot/deploy/deferred-real-mail-readiness.md)
- [wire-gate.sh](../../../apps/server-pilot/deploy/wire-gate.sh)
