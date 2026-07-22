---
title: "feat: EC2 hotel VPN safe smoke (SSM-proof)"
type: feat
status: active
date: 2026-07-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
execution_posture: overnight-autonomous
product_contract_source: ce-plan-bootstrap
origin: live real data connection/ + eng-review of ec2_vpn_failsafe_test plan + overnight-autonomous-zero
---

# feat: EC2 hotel VPN safe smoke (SSM-proof)

> **For agentic workers:** REQUIRED SUB-SKILL: `overnight-autonomous-execution` + zero overlay `overnight-autonomous-zero` (mandate below binding). Prefer `superpowers:subagent-driven-development`. User unavailable — implement-fix-loop until done criteria green.

**Execution posture:** Overnight autonomous — no user checkpoint; RCA on red until green or true blocker.

## Summary

Stage hotel OpenVPN onto EC2 and run a **≤5 minute** connectivity smoke to Zimbra / Rocketseed / Infor **without** risking SSM lockout. We have SSM on `i-008f737974a9ba9b3` — **do not guess** package capabilities: first unit inventories the box and `apt install`s whatever is missing. Primary safety stays **client-enforced split tunnel** (`pull-filter ignore redirect-gateway` + explicit `172.24.0.0/16` routes) plus host default-route assert and hard `timeout 300`. If live OpenVPN supports `--netns`, enable it; if not, install a supported helper (`namespaced-openvpn` or equivalent) **or** stay on pull-filter-only — decision from live probe output, not docs folklore.

## Problem Frame

Hotel IT delivered `Nava.ovpn` + PKCS#12 + tls-auth + user/pass. Targets:

| Host | IP | Role |
|------|-----|------|
| Zimbra | `172.24.0.10` | Mail |
| Rocketseed | `172.24.0.8` | Banner SMTP |
| Infor | `172.24.240.41` | App server |

VPN server: `41.193.164.148:1203` UDP. Our egress: `13.247.138.62`.

EC2 is **SSM-only** (no inbound SSH). If OpenVPN accepts a server-pushed `redirect-gateway`, host default route dies → SSM agent cannot reach AWS → lockout until stop/reboot. We mitigate with pull-filter + route assert + timeout; netns isolation is used **when the live binary supports it or we install a helper**.

## Requirements

- R0: Via SSM, inventory OpenVPN/`ip`/`nc`/`timeout` on the instance; install missing packages before smoke.
- R1: Stage profile to EC2 without committing secrets to git.
- R2: Connect as OpenVPN client; prove reach (or clear failure) to the three hotel IPs.
- R3: Host default route and SSM/STS must remain healthy **during** the test.
- R4: Auto-teardown within **300 seconds**; no `systemctl enable` of OpenVPN.
- R5: Document operator steps using existing SSM wrappers.

## Readiness

| Artifact | Status |
|----------|--------|
| `live real data connection/Nava.ovpn` | Ready |
| `Nava.p12`, `Nava-tls.key` | Ready |
| `nava-auth.txt` | Ready (local only — never commit) |
| `nava-p12-pass.txt` | Still placeholder → **strip `askpass`** for attempt 1 |
| OpenVPN package on EC2 | Docs say installed — **confirm + upgrade/install via SSM in U0** |
| IT allowlist of `13.247.138.62` | Assume needed; connect fail ⇒ **true overnight blocker** (document + stop; IT-only) |

## High-Level Technical Design

```text
LAPTOP                         EC2 HOST (SSM safe)              HOTEL
──────                         ──────────────────              ─────
stage → S3 ──SSM sync──► /run/nava-vpn/*.ovpn(+creds)
                                │
                         openvpn (timeout 300)
                           ├─ pull-filter IGNORE redirect-gateway
                           ├─ route 172.24.0.0/16 via tun
                           └─ assert: host default still eth0
                                │
                         probes: nc 172.24.0.10 / .8 / .240.41
                         host: aws sts + ip route
                                │
                         always: kill openvpn, wipe /run/nava-vpn
```

**Safety layers (all required):**

1. **`pull-filter ignore "redirect-gateway"`** (+ ignore `redirect-gateway def1` variants) so full-tunnel push cannot steal host default.
2. **Explicit routes** for `172.24.0.0/16` (covers 0-net mail + 240-net Infor).
3. **Host default-route snapshot/assert** — if gateway changes → kill OpenVPN immediately.
4. **`timeout 300`** hard deadline.
5. **No host DNS rewrite** — ignore `dhcp-option DNS` / disable `update-resolv-conf` on host.
6. **Netns if available:** U0 SSM probe decides. If native `--netns` exists → use it. If not → `apt`/`pip`/`curl` install a small helper (prefer [namespaced-openvpn](https://github.com/slingamn/namespaced-openvpn) into `/usr/local/bin`) **or** proceed pull-filter-only. Never assume either way from docs alone.

## Key Technical Decisions

- **KTD1 — Client pull-filter split tunnel as primary SSM shield** `(session-settled: eng-review)` — always on, even with netns.
- **KTD2 — Live EC2 inventory + install (U0)** `(session-settled: user-directed — we have SSM; check and install instead of guessing)` — probe `openvpn --version`, `--help | grep netns`, `ip`, `nc`/`nmap`, `timeout`; `apt-get install -y` anything missing (`openvpn`, `iproute2`, `netcat-openbsd`, `coreutils`).
- **KTD3 — Ephemeral only** — no systemd enable until split tunnel proven + IT allowlist confirmed.
- **KTD4 — Secrets via private S3 → `/run/nava-vpn` (tmpfs)** — not git bundle; delete after smoke; Secrets Manager later.
- **KTD5 — Strip askpass attempt 1** — placeholder P12 pass would fail; if decrypt fails, stop for IT passphrase.
- **KTD6 — Success if host STS OK + (hotel TCP respond OR tun up with 172.24 route)** — ICMP may be filtered.

## Scope Boundaries

**In:** U0 live EC2 inventory/install via SSM; stage scripts; smoke script; short runbook; EC2-ACCESS / deferred-readiness pointers; one SSM-driven smoke run.

**Out / NOT in scope:**

- Permanent `openvpn-client@` systemd
- POP3/SMTP app wiring / Send As Centurion
- Infor login automation
- VPC endpoints for SSM (document as follow-up if host routing ever drifts)
- Shipping `namespaced-openvpn` binary unless pull-filter fails
- Committing any real credentials

### Deferred to Follow-Up Work

- Store VPN auth in Secrets Manager after first green connect
- Always-on VPN unit **inside** proven split-tunnel config
- PM2 worker wrapping `ip netns exec` only if we later adopt netns for process isolation
- Ask IT for server-side split tunnel (push only `172.24.0.0/16`) as belt-and-suspenders

## Assumptions

- Outbound UDP to `41.193.164.148:1203` allowed (SG egress open per docs).
- Hotel pushes routes for `172.24.x` **or** our explicit `route` lines suffice.
- P12 has empty passphrase (validate; otherwise restore askpass).
- Bootstrap bucket `s3://nava-zero-bootstrap-845242190536/` usable with instance role (same as git-bundle path).
- **Not assumed:** whether `--netns` exists — U0 measures and installs helper if needed.

## Risks

| Risk | Mitigation |
|------|------------|
| Full tunnel push | pull-filter ignore + route assert + kill |
| `--netns` missing | Do not depend on it; pull-filter path |
| Allowlist miss | Diagnose connect fail; write blocker note (IT must add `13.247.138.62`) — valid overnight stop |
| Host DNS poisoned | Ignore dhcp-option DNS; no update-resolv-conf |
| Secrets in SSM argv | S3 pull on instance only |
| Port unknown | Probe TCP 25/587/993/443/8080 best-effort; route presence counts |
| Reboot auto-VPN | Never enable systemd unit this PR |

## Global Constraints

- **No committed secrets** — `nava-auth.txt`, `nava-p12-pass.txt`, `*.p12`, `*-tls.key` stay gitignored; stage via S3 → `/run/nava-vpn` only.
- **Ephemeral VPN only** — never `systemctl enable` OpenVPN this plan.
- **SSM survival first** — pull-filter ignore redirect-gateway + host default-route assert + `timeout 300` always on.
- **Live inventory before tunnel** — U0 SSM probe/install; no folklore about `--netns`.
- **Strip askpass attempt 1** — placeholder P12 pass not used; decrypt fail → try empty / restore askpass only if local file filled; else blocker.
- Scripts land under `apps/server-pilot/deploy/`; docs pointers only in EC2-ACCESS §9 + deferred-real-mail-readiness.

## Git Commit Strategy

Atomic conventional commits per unit (tests/scripts green). Linear history for overnight RCA.

| Unit | Commit message (after green) | Files scope |
|------|------------------------------|-------------|
| U0 | `feat(deploy): add EC2 OpenVPN preflight inventory` | `vpn-ec2-preflight.sh` |
| U1 | `feat(deploy): add hotel VPN stage + SSM-safe smoke` | `vpn-stage-to-ec2.sh`, `vpn-safe-smoke.sh`, related |
| U2 | `docs(deploy): VPN safe-smoke runbook + EC2-ACCESS pointer` | `vpn-smoke.md`, EC2-ACCESS, deferred-readiness |
| RCA | `fix(deploy): <symptom>` | cite root cause `file:line` in body |

**Rules:** No amend, no force-push, no `--no-verify`. Never commit VPN secrets or `/run/nava-vpn` dumps.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No "which approach?" pause. Goal = ship U0–U2 + one real SSM smoke with PASS or diagnosed true blocker.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 mail | `nava-zero-mail-845242190536-af-south-1` |
| S3 bootstrap (VPN stage) | `s3://nava-zero-bootstrap-845242190536/vpn-nava/` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |
| VPN smoke (this plan) | `vpn-ec2-preflight.sh`, `vpn-stage-to-ec2.sh`, `vpn-safe-smoke.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, SSM remote cmds, apt install on EC2 via SSM, ephemeral OpenVPN client smoke using **already-local** `live real data connection/` profile (S3 stage → `/run/nava-vpn`, wipe after), host route assert, hotel TCP probes, STS checks.

**Forbidden:** force-push main, `--no-verify`, destructive git, **commit** VPN/mail secrets, permanent `openvpn-client@` enable, Exchange/Infor login automation, inventing IT firewall changes.

### RCA loop (mandatory on any red)

```text
FAIL → reproduce minimally → root cause (file:line + mechanism)
  → Exa MCP if unfamiliar → enumerate fixes → smallest correct fix
  → test + commit → resume plan
```

Bar: 95% confident can explain what broke and why. Symptom patches without RCA = loop again.

### Divergence authority

Better path to done criteria → take it. Log in handoff / plan addendum (what, why). Prefer pull-filter-only if netns helper install is flaky — do not block overnight on netns.

### Overnight deploy wave

```text
local: write scripts + laptop self-check (ovpn contains pull-filter)
  → commit + push EC2-pilot (no secrets)
  → SSM: vpn-ec2-preflight.sh (U0)
  → laptop: vpn-stage-to-ec2.sh (S3)
  → SSM: vpn-safe-smoke.sh (≤300s)
  → handoff under docs/superpowers/plans/handoff-reports/ if smoke run
```

### Done criteria

- [ ] U0 preflight script exists; SSM run shows OpenVPN version + `HAS_NETNS`/`HAS_NS_HELPER`
- [ ] U1 stage + smoke scripts exist; generated ovpn has pull-filter + `172.24.0.0/16` route
- [ ] U2 runbook + EC2-ACCESS §9 / deferred-readiness pointers updated
- [ ] One real SSM smoke: `HOST_ROUTE_OK` + STS OK + (`PROBE_OK` or `ROUTE_17224_OK`) **or** documented true blocker
- [ ] Within 300s: no OpenVPN process; `/run/nava-vpn` wiped; no secrets in git status
- [ ] No open non-blocker issues

### Blocking conditions (only valid stops)

- Hotel firewall has not allowlisted `13.247.138.62` (connect never establishes after auth/TLS OK ruled out) — IT-only
- PKCS#12 passphrase required and not available in local `nava-p12-pass.txt` — human/IT-only
- Missing local `nava-auth.txt` real creds (placeholders only) — human-only

**Not** valid stops: `--netns` absent, apt noise, empty SSM stdout (RCA format), scary first connect, prefer netns vs pull-filter debate.

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` + `overnight-autonomous-execution`. Do not ask "which approach?"

## Implementation Units

### U0. Live EC2 inventory + install

**Goal:** Know exactly what the box has; install gaps before any tunnel attempt.

**Dependencies:** none

**Files:**

- Create `apps/server-pilot/deploy/vpn-ec2-preflight.sh` (SSM-runnable)

**Approach:** Via `ssm-run-command.sh`, as root:

- Print: `openvpn --version`, `openvpn --help 2>&1 | grep -i netns || echo NO_NATIVE_NETNS`, `ip -V`, `which nc timeout`, host `ip -4 route show default`, SSM agent ping already implied by send-command success.
- `apt-get update -qq && apt-get install -y openvpn iproute2 netcat-openbsd dnsutils`
- If `NO_NATIVE_NETNS`: install `namespaced-openvpn` to `/usr/local/bin` (curl raw from GitHub release/main script; `chmod +x`) **or** record `NETNS_HELPER=none` and rely on pull-filter only.
- Write machine-readable summary to `/tmp/nava-vpn-preflight.env` (`HAS_NETNS=0|1`, `HAS_NS_HELPER=0|1`) for smoke script to source.

**Test scenarios:**

- Happy: preflight exits 0; `openvpn` on PATH; summary file present.
- Install: if openvpn missing, apt installs it and re-checks.
- Idempotent: second run no harmful side effects.

**Verification:** SSM stdout shows version + `HAS_NETNS`/`HAS_NS_HELPER`; send-command still works after apt.

### U1. Stage + smoke scripts

**Goal:** Laptop→S3→EC2 staging and one SSM-safe OpenVPN smoke with 300s teardown.

**Dependencies:** U0

**Files:**

- Create `apps/server-pilot/deploy/vpn-stage-to-ec2.sh`
- Create `apps/server-pilot/deploy/vpn-safe-smoke.sh` (runs on EC2 as root via SSM)
- Create `apps/server-pilot/deploy/vpn-smoke.md`
- Modify `apps/server-pilot/deploy/deferred-real-mail-readiness.md` (link smoke)
- Modify `docs/superpowers/EC2-ACCESS.MD` §9

**Approach:**

- **Stage:** From laptop, upload `Nava.p12`, `Nava-tls.key`, `nava-auth.txt`, and a **generated** `Nava.smoke.ovpn` (base profile + safety directives; askpass removed) to `s3://nava-zero-bootstrap-845242190536/vpn-nava/<timestamp>/`. SSM on EC2: `aws s3 sync` into `/run/nava-vpn/` (`700`/`600`), never echo secrets.
- **Generated ovpn safety lines (directional):**
  - `pull-filter ignore "redirect-gateway"`
  - `pull-filter ignore "dhcp-option DNS"`
  - `route 172.24.0.0 255.255.0.0`
  - `script-security 1` (or avoid up/down scripts)
  - keep `auth-user-pass`, `pkcs12`, `tls-auth`, `remote`
- **Smoke:** source `/tmp/nava-vpn-preflight.env` → snapshot host default → start OpenVPN with `timeout 300` (use `--netns` or `namespaced-openvpn` when preflight says available; else host + pull-filter) → assert host default unchanged → STS → hotel TCP probes → always kill + wipe `/run/nava-vpn`.

**Execution note:** Prefer install/runtime smoke via SSM over unit tests; add a small bash self-check for “generated ovpn contains pull-filter” that can run on laptop without network.

**Test scenarios:**

- Happy: stage uploads; EC2 lists files mode 600; smoke exits 0 with `HOST_ROUTE_OK` + STS OK + at least one `PROBE_OK` or `ROUTE_17224_OK`.
- Error: missing local `nava-auth.txt` → stage exits non-zero before S3.
- Safety: if host default changes mid-test → script kills OpenVPN and exits non-zero with `HOST_ROUTE_CHANGED`.
- Failsafe: after 300s OpenVPN gone; `/run/nava-vpn` empty or removed.
- Auth: P12 decrypt fail → clear log line; no hang beyond timeout.

**Verification:** One SSM invocation returns structured PASS/FAIL lines; laptop still gets SSM Online.

### U2. Operator runbook + doc pointers

**Goal:** You can run stage→smoke without improvising.

**Dependencies:** U1

**Files:** `apps/server-pilot/deploy/vpn-smoke.md`; updates in EC2-ACCESS §9 and deferred-real-mail-readiness.

**Approach:** Ordered commands using `apps/server-pilot/deploy/ssm-run-command.sh`; abort recipe (`killall openvpn`; wipe `/run/nava-vpn`); interpret table for PROBE vs ROUTE results.

**Test expectation:** none — docs only.

## Verification Contract

1. Laptop: SSM `PingStatus=Online` before and during smoke.
2. Smoke log contains `HOST_ROUTE_OK` and STS JSON.
3. At least one of: hotel TCP probe OK, or `ip route` shows `172.24.0.0/16` via tun while host default unchanged.
4. Within 300s: no OpenVPN process; secrets dir cleaned.
5. No secrets in git status.

## Definition of Done

- Scripts + runbook merged (or ready to run) with **no** committed credentials.
- One real SSM smoke attempted with clear PASS or diagnosed **true blocker** (allowlist / P12 / auth) — no "wait for morning" pause.
- EC2-ACCESS §9 notes safe-smoke procedure; permanent VPN still off.
- Overnight mandate done-criteria checkboxes all checked or blocker documented under `docs/superpowers/plans/handoff-reports/`.

## What already exists (reuse)

| Existing | Reuse |
|----------|--------|
| `apps/server-pilot/deploy/ssm-run-command.sh` | Invoke smoke |
| S3 bootstrap bucket + instance role | Stage secrets |
| `vpn-route-check.sh` | Pattern for STS/RDS/S3 post-VPN later |
| `deferred-real-mail-readiness.md` | Gate list after smoke green |
| OpenVPN client package on box | No apt install unless missing |

## Sources & Research

- Eng-review of prior netns-first plan: `--netns` likely absent on Ubuntu OpenVPN 2.6.19; up/down scripts and DNS can still poison host.
- OpenVPN client `pull-filter` can ignore `redirect-gateway` (client-enforced split tunnel).
- Fallback patterns: [namespaced-openvpn](https://github.com/slingamn/namespaced-openvpn); AWS SSM VPC endpoints docs for later hardening.
- Hotel targets from IT email; profile in `live real data connection/`.

## GSTACK REVIEW REPORT

**Step 0:** Scope accepted with **reduction**: drop netns-as-primary; keep 5-min ephemeral smoke + SSM survival.

**Architecture:** Primary issue — unproven `--netns`. Folded into KTD1/KTD2.

**NOT in scope:** listed above.

**Outside voice:** Claude research subagent ([OpenVPN netns risk research](6204c974-531d-4c7e-8855-bd2ea46762df)) — agree: pull-filter + timeout + route assert; treat `--netns` as unverified.

**Lake score:** Chose complete safety stack (pull-filter + assert + timeout + DNS ignore) over shortcut host-VPN-with-timeout-only.
