---
title: "feat: EC2 hotel VPN boot/deploy durability (assert + Restart + race guards)"
type: feat
date: 2026-07-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
origin: session — always-on already enabled; user asked wire into boot/deploy + what else missed
---

# feat: EC2 hotel VPN boot/deploy durability (assert + Restart + race guards)

> **Prior state (live):** `openvpn-client@nava` is already **enabled** + **active** on `i-008f737974a9ba9b3`. Default still `via 172.31.0.1 dev ens5`. Hotel `172.24.0.0/16` via `tun0`. Durable files under `/etc/openvpn/client/`. Reboot already starts the unit via systemd `WantedBy=multi-user.target` — **do not re-install VPN from PM2 or re-run confidence every deploy.**

> **Implement from:** [`docs/superpowers/plans/2026-07-22-ec2-vpn-boot-deploy-durability.md`](../superpowers/plans/2026-07-22-ec2-vpn-boot-deploy-durability.md) (scope **B** = recover + notice; HARD/SOFT assert contract locked there).

## Goal Capsule

Make always-on VPN **survive process death, reboot, and day-to-day ops** by wiring asserts into existing boot/deploy paths, fixing systemd `Restart=no`, and documenting the gaps that are not "add VPN to ops-deploy."

**Stop if:** any change risks full-tunnel / HOST_ROUTE change, or deploy HARD-fails on hotel TCP alone (hotel must stay SOFT unless `REQUIRE_HOTEL_PROBE=1`).

**Product Contract preservation:** new plan (not enriching 002). 002 delivered enable; this plan delivers **ops durability**.

## Product Contract

### Requirements

- R1: After EC2 reboot, VPN comes back without laptop action; post-boot smoke reports VPN green (unit + split-tunnel + optional hotel probe).
- R2: If OpenVPN process exits, systemd restarts it (`Restart=` override) so tunnel is not silently dead until next reboot.
- R3: Day-to-day `ops-deploy` / `ops-reboot` run **HARD** VPN checks (unit + HOST_ROUTE + `172.24` route + STS); hotel TCP is **SOFT** warn unless `REQUIRE_HOTEL_PROBE=1`. They do **not** re-stage secrets or re-enable the unit every ship.
- R4: `vpn-route-check.sh` (used by `activate-real-mail.sh`) fails closed when unit down / no `172.24` / HOST_ROUTE wrong.
- R5: Confidence/smoke scripts must not `pkill` the always-on unit when durable install is present (or must refuse / use unit-aware stop).
- R6: Docs name: bootstrap of **new** instance still needs stage→confidence→install once; AMI replace loses `/etc/openvpn/client/nava*`.
- R7: Keep pull-filter + HOST_ROUTE / RESOLV guards; never weaken split tunnel for "convenience."

### Actors / flows

```text
Boot:
  network-online → openvpn-client@nava (enabled) → tun0 + 172.24 routes
    → pm2-ubuntu → nava-post-boot-smoke (now waits/asserts VPN)

Deploy:
  ops-deploy → sync → deploy-ec2 (apps only) → vpn-health-assert (HARD unit/route/STS; SOFT hotel)
  ops-reboot → wait SSM → post-boot-smoke (incl. HARD VPN) → green

Crash:
  openvpn dies → systemd Restart=always → reconnect → HOST_ROUTE still ens5
```

### Acceptance examples

- `systemctl show openvpn-client@nava -p Restart` → `always` (or `on-failure`) via drop-in.
- Soft reboot via `ops-reboot.sh` → smoke prints `VPN_OK` (or equivalent) + existing nginx/pm2 PASS.
- `vpn-route-check.sh` with unit stopped → non-zero exit before POP3.
- Fixture `ops-deploy` still succeeds if hotel TCP briefly down but HARD checks pass (`VPN_HARD_OK` + `VPN_SOFT_WARN_HOTEL`). `REQUIRE_HOTEL_PROBE=1` flips hotel to HARD.

### Product scope

**In:** systemd drop-in for Restart; post-boot smoke VPN asserts; ops-reboot/ops-deploy hooks; harden `vpn-route-check.sh`; guard smoke/confidence against pkill of always-on; docs (vpn-always-on, EC2-ACCESS, it-handoff, deferred readiness); optional keepalive in `nava.conf` via install script.

**Out:** Secrets Manager migration; CloudWatch alarm (document as follow-up); re-running confidence on every deploy; putting OpenVPN under PM2; netns; changing hotel VPN server config.

## Planning Contract

### Key Technical Decisions

- KTD1 — **Systemd is source of truth for auto-connect** `(session-settled: already enabled)` — boot path = `enable`; do not add VPN start to `deploy-ec2.sh` / PM2.
- KTD2 — **Assert, don't reinstall** — deploy/reboot scripts check health; only `vpn-install-always-on.sh` / `vpn-disable.sh` mutate unit enablement.
- KTD3 — **Drop-in for Restart** — stock `openvpn-client@.service` has `Restart=no` (live verified). Add `/etc/systemd/system/openvpn-client@nava.service.d/restart.conf` from repo, install via `vpn-install-always-on.sh` (and one-shot apply now). Prefer `Restart=on-failure` + `RestartSec=5` (or `always` if hotel flaps exit 0 — verify during implement).
- KTD4 — **Post-boot ordering** — `nava-post-boot-smoke.service` gains `After=openvpn-client@nava.service` + `Wants=`; smoke script waits briefly for tun/`172.24` then asserts HOST_ROUTE + unit active.
- KTD5 — **HARD vs SOFT (locked)** — HARD = unit active + default via `172.31.0.1` not tun + `172.24.0.0/16` route + STS (fail exit 1). SOFT = hotel `nc` matrix (print `VPN_SOFT_WARN_HOTEL`, exit 0). `REQUIRE_HOTEL_PROBE=1` → hotel HARD. POP3/SMTP in `vpn-route-check` when env set stay HARD via `set -e`.
- KTD6 — **Dangerous pkill** — `vpn-confidence.sh` / `vpn-safe-smoke.sh` currently `pkill -x openvpn`. With always-on live, that kills production tunnel. Gate: if `/etc/openvpn/client/nava.conf` exists and unit enabled, refuse ephemeral smoke unless `ALLOW_KILL_ALWAYS_ON=1`, or stop/start via `systemctl` for the named unit only during controlled tests.

### What already works (do not redo)

| Piece | Status |
|-------|--------|
| `openvpn-client@nava` enabled + active | Live PASS |
| Durable `/etc/openvpn/client/nava.conf` + secrets dir | Live PASS |
| Split tunnel + pull-filter | Live PASS |
| Reboot starts unit (systemd WantedBy) | Expected; prove in U2 with `ops-reboot` |

### What you likely have not considered

| Gap | Why it matters | Plan action |
|-----|----------------|-------------|
| **`Restart=no`** | Process crash / UDP flap → VPN stays down forever until manual restart | KTD3 drop-in |
| **No `keepalive`/`ping` in conf** | Client may not detect dead peer quickly | Add `keepalive 10 60` (or similar) in install generator |
| **Post-boot smoke ignores VPN** | Reboot "green" while hotel unreachable | Extend `post-boot-smoke.sh` |
| **Smoke unit race** | Smoke can run before tun up | `After=` + wait loop |
| **`ops-deploy` silent** | Ship code while VPN dead; discover at mail flip | Soft assert after health |
| **`vpn-route-check` weak** | Only dumps routes; no unit/HOST_ROUTE fail | Harden script |
| **Smoke/confidence `pkill`** | Operator re-runs smoke → kills always-on | Guard R5 |
| **New instance / replace root volume** | Secrets not in git or AMI; deploy alone insufficient | Document re-bootstrap in runbook |
| **Real-mail race** | PM2 `worker` may start before tun | Rely on worker retry + post-boot order; document; optional delay in activate path |
| **Credential rotation** | Hotel changes user/pass → unit fails auth loop | Document re-stage → install path |
| **Monitoring** | No alarm if unit inactive overnight | Out of scope; appendix follow-up (CW metric / SSM cron) |
| **apt openvpn upgrade** | Rarely replaces unit file; drop-in usually survives | Prefer drop-in over editing vendor unit |
| **Do not put VPN in PM2** | Wrong privilege / wrong lifecycle | Explicit non-goal |

### High-level design

```text
U0  systemd Restart drop-in + install script writes it; optional keepalive in nava.conf
U1  post-boot-smoke + nava-post-boot-smoke.service ordering; ops-reboot already calls smoke
U2  harden vpn-route-check; HARD VPN assert in ops-deploy; guard pkill in smoke/confidence
U3  docs + prove soft reboot (ops-reboot) VPN_OK; handoff
```

### Assumptions

- Always-on install from plan 002 remains valid; secrets still on disk.
- Hotel still pushes host routes only; pull-filter stays defense-in-depth.
- Fixture prod remains default until real-mail activate.

### Risks

| Risk | Mitigation |
|------|------------|
| Restart loop on bad auth burns hotel allowlist | Use `Restart=on-failure` + `StartLimitBurst`; journal on fail |
| Hotel outage fails whole deploy | Hotel is SOFT; only HARD checks abort deploy |
| Ordering `Requires=` VPN breaks smoke if VPN intentionally disabled | Use `Wants=` not `Requires=`; smoke treats missing unit as FAIL only when expected always-on flag file exists — or always expect always-on now that install done |
| pkill guard blocks legitimate re-test | `ALLOW_KILL_ALWAYS_ON=1` escape |

### Sequencing

U0 → U1 → U2 → U3 (live reboot proof last).

## Implementation Units

### U0. Systemd Restart drop-in + conf keepalive

**Files:**

- Create: `apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf`
- Modify: `apps/server-pilot/deploy/vpn-install-always-on.sh` — install drop-in, `daemon-reload`, ensure keepalive in generated `nava.conf`
- Modify: `apps/server-pilot/deploy/vpn-disable.sh` — optional note; leave drop-in in place (harmless when unit disabled)

**Behavior:**

- Drop-in sets `Restart=on-failure` (or settled value), `RestartSec=5`, reasonable `StartLimitIntervalSec` / `StartLimitBurst`.
- Install script copies drop-in under `/etc/systemd/system/openvpn-client@nava.service.d/` and reloads.
- One-shot apply on live box during execute (even without full reinstall): copy drop-in + reload + `systemctl restart openvpn-client@nava` + HOST_ROUTE assert.

**Test scenarios:**

- Happy: `systemctl show -p Restart` reflects drop-in.
- Safety: after artificial `systemctl kill` of openvpn process (or `kill` main PID), unit returns active within ~30s; HOST_ROUTE unchanged.
- Conf: `keepalive` present in `/etc/openvpn/client/nava.conf`.

### U1. Post-boot smoke asserts VPN

**Files:**

- Modify: `apps/server-pilot/deploy/post-boot-smoke.sh`
- Modify: `apps/server-pilot/deploy/nava-post-boot-smoke.service`
- Modify: `apps/server-pilot/deploy/pm2-startup.sh` — only if needed to reinstall unit file (already copies service)

**Behavior:**

- Service: `After=network-online.target pm2-ubuntu.service openvpn-client@nava.service`; `Wants=openvpn-client@nava.service`.
- Smoke: wait up to N seconds for unit active + `172.24` route; assert default route still `via 172.31.0.1` (or snapshot-compare); print `VPN_OK` / `HOST_ROUTE_OK`.
- Hotel `nc` optional soft unless `REQUIRE_HOTEL_PROBE=1`.

**Test scenarios:**

- Happy: post-boot-smoke PASS includes VPN lines.
- Fail: with unit stopped, smoke fails (proves assert wired).
- `ops-reboot` end-to-end still returns `ops-reboot ok` with VPN up.

### U2. Ops deploy HARD assert + route-check harden + pkill guard

**Files:**

- Create: `apps/server-pilot/deploy/vpn-health-assert.sh` — shared HARD/SOFT contract (required, not optional)
- Modify: `apps/server-pilot/deploy/vpn-route-check.sh`
- Modify: `apps/server-pilot/deploy/ops-deploy.sh` — after health, SSM `vpn-health-assert.sh`
- Modify: `apps/server-pilot/deploy/vpn-confidence.sh`, `vpn-safe-smoke.sh` — refuse pkill when always-on present unless escape hatch

**Behavior:**

- `vpn-health-assert.sh`: HARD = unit + HOST_ROUTE + `172.24` + STS; SOFT = hotel `nc` (warn only).
- `vpn-route-check.sh`: call health assert first; keep RDS/S3; POP3/SMTP `nc` HARD when env set.
- `ops-deploy`: after curl health, HARD assert; do not stage secrets. Hotel SOFT warn does not abort.
- Ephemeral scripts: detect durable always-on → exit 20 unless `ALLOW_KILL_ALWAYS_ON=1`.

**Test scenarios:**

- `vpn-route-check` fails when unit inactive.
- `ops-deploy` green with unit up + hotel briefly down (`VPN_SOFT_WARN_HOTEL` OK).
- Confidence refuse when always-on without escape.

### U3. Docs + live reboot proof + handoff

**Files:**

- Modify: `apps/server-pilot/deploy/vpn-always-on.md` — boot durability, Restart drop-in, new-instance bootstrap, "deploy does not reinstall VPN"
- Modify: `docs/superpowers/EC2-ACCESS.MD` §9
- Modify: `apps/server-pilot/deploy/deferred-real-mail-readiness.md`, `it-handoff-runbook.md`, `ec2-bootstrap.md` (brief)
- Create: `docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-boot-durability.md`

**Behavior:**

- Document operator expectation: reboot → VPN auto; abort still `vpn-disable.sh`.
- Live: apply drop-in; run `ops-reboot.sh` or equivalent soft reboot + capture `VPN_OK` + STS.

**Test scenarios:**

- Soft reboot evidence in handoff.
- Docs list non-goals (PM2, Secrets Manager).

## Verification Contract

- Live: `systemctl is-enabled` / `is-active` = enabled/active; `Restart` ≠ no.
- Live: `post-boot-smoke.sh` prints VPN success lines; HOST_ROUTE still ens5.
- Live: kill OpenVPN main PID → unit recovers; STS still OK.
- Laptop: `bash -n` on touched scripts.
- Soft reboot via `ops-reboot.sh` → `ops-reboot ok` + SSM still answers.
- No secrets added to git.

## Definition of Done

- [ ] Restart drop-in installed and proven recover-after-kill
- [ ] Post-boot smoke asserts VPN; unit `After=` ordered
- [ ] `vpn-route-check` fails closed without tunnel
- [ ] `ops-deploy` HARD-asserts VPN without restaging (hotel SOFT)
- [ ] Smoke/confidence cannot silently pkill always-on
- [ ] Docs updated; handoff with reboot proof
- [ ] HOST_ROUTE never via tun after any change

## Appendix

### Follow-ups (explicitly out)

- CloudWatch / EventBridge alarm when `openvpn-client@nava` inactive > N minutes
- Secrets Manager for VPN auth + cert material
- Worker-level "wait for 172.24" before first POP3 connect (app retry already helps)

### Disable abort (unchanged)

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-disable.sh'
```

### Why not "add VPN to ops-deploy start"

Deploy ships app code. VPN secrets live outside the git bundle. Re-running install on every deploy couples ship velocity to hotel auth and risks wiping a working tunnel. Assert health; reinstall only on credential rotation or new instance.
