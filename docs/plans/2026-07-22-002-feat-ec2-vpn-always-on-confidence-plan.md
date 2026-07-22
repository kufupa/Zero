---
title: "feat: EC2 hotel VPN always-on (confidence gate → enable)"
type: feat
date: 2026-07-22
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
execution_posture: overnight-autonomous
product_contract_source: ce-plan-bootstrap
origin: smoke handoff 2026-07-22-ec2-vpn-safe-smoke + session confidence checks (no 30m soak) + overnight-autonomous-zero
---

# feat: EC2 hotel VPN always-on (confidence gate → enable)

> **For agentic workers:** REQUIRED SUB-SKILL: `overnight-autonomous-execution` + zero overlay `overnight-autonomous-zero` (mandate below binding). Prefer `superpowers:subagent-driven-development`. User unavailable — implement-fix-loop until done criteria green.

**Execution posture:** Overnight autonomous — no user checkpoint; RCA on red until green or true blocker.

**Prior art:** Ephemeral smoke **PASS** — [`docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-safe-smoke.md`](../superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-safe-smoke.md). Split tunnel proven (`HOST_ROUTE_OK`, hotel TCP). Permanent unit still off.

## Goal Capsule

Run a **short confidence gate** (not a soak) while VPN is up, then **only if PASS** install durable profile + `systemctl enable --now openvpn-client@nava` so hotel `172.24.0.0/16` stays reachable and **SSM/STS survive**.

**Stop if:** host default route changes, `resolv.conf` mutates, confidence FAIL, or enable leaves SSM dead (immediate disable + abort).

## Product Contract

### Requirements

- R1: Confidence script proves, while tunnel up: default route unchanged, `/etc/resolv.conf` unchanged, STS OK, one hotel TCP probe OK, then **one reconnect** and default route still OK.
- R2: Same client guards as smoke: `pull-filter ignore "redirect-gateway"` (+ DNS/DOMAIN), explicit `route 172.24.0.0 255.255.0.0`.
- R3: On confidence PASS only: durable secrets + `nava.conf` under `/etc/openvpn/client/`, enable `openvpn-client@nava`.
- R4: Post-enable gate: STS + default route + hotel probe still green; document disable/abort.
- R5: No secrets in git; reuse PEM stage path from [`vpn-stage-to-ec2.sh`](../../apps/server-pilot/deploy/vpn-stage-to-ec2.sh).
- R6: Skip 30-minute soak — confidence + reconnect is the bar.

### Actors / flows

```text
Laptop stage (S3) → EC2 /run (confidence) → PASS?
  ├─ NO  → wipe /run, leave systemd off, handoff FAIL
  └─ YES → install /etc/openvpn/client/nava* → enable --now
            → post-enable assert → handoff PASS
```

### Acceptance examples

- Confidence log lines: `RESOLV_OK`, `HOST_ROUTE_OK`, `STS_OK`, `PROBE_OK`, `RECONNECT_OK`, `CONFIDENCE_PASS`.
- After enable: `systemctl is-active openvpn-client@nava` = `active`; SSM still answers; default still `via 172.31.0.1 dev ens5`.
- Abort path: `systemctl disable --now openvpn-client@nava` restores SSM path without reboot.

### Product scope

**In:** confidence script, durable install/enable scripts, runbook + EC2-ACCESS update, one overnight SSM run to green or blocker.

**Out:** POP3/SMTP app wiring, Infor login automation, Secrets Manager migration (durable root files OK this wave), netns / namespaced-openvpn, VPC endpoints, 30m soak.

## Planning Contract

### Key Technical Decisions

- **KTD1 — Confidence before enable** `(session-settled: user chose option 2)` — never `enable --now` until `CONFIDENCE_PASS`.
- **KTD2 — No soak** `(session-settled)` — one-shot asserts + one reconnect replace 30m soak.
- **KTD3 — Host + pull-filter** `(carried from smoke)` — no netns; host routes so probes see `172.24`.
- **KTD4 — Durable path = `/etc/openvpn/client/`** — Ubuntu `openvpn-client@nava` reads `/etc/openvpn/client/nava.conf`; secrets in `/etc/openvpn/client/nava/` mode `600` root. Secrets Manager deferred.
- **KTD5 — Reuse smoke stage** — extend stage (or sibling `vpn-stage-durable.sh`) to also install under `/etc/openvpn/client/` after confidence; confidence itself may still use `/run/nava-vpn` then promote.
- **KTD6 — Reconnect = `systemctl restart openvpn-client@nava` or kill+start** during confidence use manual restart of the smoke process; post-enable use systemd restart.

### High-level design

```text
U0  scripts: confidence + install + enable/disable wrappers
U1  sync to EC2; stage secrets to /run; run confidence (≤180s target)
U2  on PASS: promote to /etc/openvpn/client/; enable --now; post-gate
U3  runbook + EC2-ACCESS §9; handoff report
```

**Confidence checks (exact):**

| Check | Pass line |
|-------|-----------|
| Snapshot default route before connect | (baseline) |
| Snapshot `sha256sum /etc/resolv.conf` before | (baseline) |
| Tunnel up + `172.24` route | `ROUTE_17224_OK` |
| Default route == baseline | `HOST_ROUTE_OK` |
| resolv.conf hash == baseline | `RESOLV_OK` |
| `aws sts get-caller-identity` | `STS_OK` |
| ≥1 hotel `nc` (Zimbra/Rocketseed/Infor known ports) | `PROBE_OK` |
| Kill+restart OpenVPN (or `systemctl restart` if unit already installed for dry-run) | — |
| Default route still baseline after reconnect | `RECONNECT_OK` |
| All above | `CONFIDENCE_PASS` |

**Safety on enable:**

1. Refuse enable if generated conf missing pull-filter.
2. Post-enable: if `HOST_ROUTE` fails → `disable --now` immediately, exit non-zero.
3. Document laptop abort one-liner via SSM.

### Assumptions

- Smoke profile still valid (auth, allowlist `13.247.138.62`, UDP `41.193.164.148:1203`).
- Hotel still push-only host routes (no `redirect-gateway`); pull-filter stays defense-in-depth.
- Local `live real data connection/` still has filled `nava-auth.txt` + P12 for laptop stage.
- EC2 IAM still can `s3:GetObject` on `vpn-nava/*`.

### Risks

| Risk | Mitigation |
|------|------------|
| Full tunnel after enable | pull-filter + post-enable HOST_ROUTE assert + auto-disable |
| DNS rewrite breaks SSM | ignore dhcp-option DNS; RESOLV_OK gate |
| Secrets survive reboot but leak via perms | `chmod 600` root-owned under `/etc/openvpn/client/nava/` |
| Confidence PASS, enable FAIL mid-way | leave unit disabled; wipe incomplete install |
| Reboot brings VPN up bad | enable only after PASS; disable script in runbook |

### Sequencing

Reuse [`vpn-ec2-preflight.sh`](../../apps/server-pilot/deploy/vpn-ec2-preflight.sh) / [`vpn-stage-to-ec2.sh`](../../apps/server-pilot/deploy/vpn-stage-to-ec2.sh) / smoke guards. Do not re-litigate PEM/CRLF/IAM — already fixed in smoke handoff.

## Global Constraints

- No committed secrets.
- Enable **only** after `CONFIDENCE_PASS`.
- SSM survival first — same pull-filter + route assert as smoke.
- No `--no-verify`, no force-push, no destructive git.
- Caveman ultra overnight (mandate).

## Git Commit Strategy

| Unit | Commit message | Scope |
|------|----------------|-------|
| U0 | `feat(deploy): add VPN confidence + always-on install scripts` | new sh under `apps/server-pilot/deploy/` |
| U1 | `docs(deploy): always-on VPN runbook + EC2-ACCESS` | md updates |
| RCA | `fix(deploy): <symptom>` | cite `file:line` |

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause. Goal = confidence PASS → always-on enabled → post-gate green **or** true blocker documented.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| S3 bootstrap (VPN stage) | `s3://nava-zero-bootstrap-845242190536/vpn-nava/` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Primary deploy | `apps/server-pilot/deploy/ops-deploy.sh` |
| Guts | `sync-ec2-git-bundle.sh`, `ssm-run-command.sh` |
| Prior VPN | `vpn-ec2-preflight.sh`, `vpn-stage-to-ec2.sh`, `vpn-safe-smoke.sh` |
| This plan | `vpn-confidence.sh`, `vpn-install-always-on.sh`, `vpn-disable.sh` (names flexible) |

**Allowed:** ops wrappers, bundle sync, apt, S3 stage of local VPN profile, confidence OpenVPN, **enable `openvpn-client@nava` only after CONFIDENCE_PASS**, post-enable asserts, immediate disable on HOST_ROUTE fail, handoff report.

**Forbidden:** force-push main, `--no-verify`, destructive git, commit VPN secrets, Exchange/Infor login automation, inventing IT firewall changes, enable without confidence PASS, 30m soak as a gate.

### RCA loop (mandatory on any red)

```text
FAIL → reproduce → root cause (file:line) → fix → test → commit → resume
```

### Divergence authority

Better path to done criteria → take it. Log in handoff. Prefer promote-after-confidence over dual-path install if simpler.

### Overnight deploy wave

```text
local: write confidence + install/disable scripts + runbook
  → commit + push EC2-pilot (no secrets)
  → sync-ec2-git-bundle.sh
  → laptop: vpn-stage-to-ec2.sh (or durable variant)
  → SSM: vpn-confidence.sh → must print CONFIDENCE_PASS
  → SSM: vpn-install-always-on.sh (enable --now) + post-gate
  → handoff: docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-always-on.md
```

### Done criteria

- [ ] Confidence script exists; self-check refuses missing pull-filter
- [ ] One SSM confidence run: `HOST_ROUTE_OK` + `RESOLV_OK` + `STS_OK` + `PROBE_OK` + `RECONNECT_OK` → `CONFIDENCE_PASS`
- [ ] Always-on installed: `openvpn-client@nava` **active** and **enabled**
- [ ] Post-enable: default route still ens5/172.31.0.1; STS OK; ≥1 hotel PROBE_OK
- [ ] Runbook + EC2-ACCESS §9 say permanent on + disable abort
- [ ] Handoff report written; no secrets in git status
- [ ] No open non-blocker issues

### Blocking conditions (only valid stops)

- Hotel allowlist / auth / UDP connect impossible after RCA
- HOST_ROUTE changes and cannot be fixed client-side (do not leave unit enabled)

## Implementation Units

### U0. Confidence + install/disable scripts

**Files:**

- Create: `apps/server-pilot/deploy/vpn-confidence.sh`
- Create: `apps/server-pilot/deploy/vpn-install-always-on.sh`
- Create: `apps/server-pilot/deploy/vpn-disable.sh`
- Modify (as needed): `apps/server-pilot/deploy/vpn-stage-to-ec2.sh` — generate same safety directives; optional durable target path flag

**Behavior:**

- `vpn-confidence.sh`: stage at `/run/nava-vpn` (or reuse staged); snapshot route + resolv; start OpenVPN with smoke-equivalent conf; assert table above; reconnect once; wipe `/run` on exit unless `KEEP_STAGED=1` for promote.
- `vpn-install-always-on.sh`: require prior `CONFIDENCE_PASS` file or re-run confidence; copy PEM/auth/tls + `nava.conf` to `/etc/openvpn/client/`; `systemctl enable --now openvpn-client@nava`; post-assert; on fail call disable.
- `vpn-disable.sh`: `systemctl disable --now openvpn-client@nava`; optional wipe client dir (flag).

**Test scenarios:**

- Happy: confidence prints `CONFIDENCE_PASS`.
- Safety: missing pull-filter → refuse start.
- Safety: simulated route change → kill VPN, non-zero, never enable.
- Install: conf present under `/etc/openvpn/client/nava.conf` with pull-filter.
- Disable: unit inactive after `vpn-disable.sh`.

### U1. Runbook + EC2-ACCESS

**Files:**

- Create: `apps/server-pilot/deploy/vpn-always-on.md`
- Modify: `docs/superpowers/EC2-ACCESS.MD` §9
- Modify: `apps/server-pilot/deploy/deferred-real-mail-readiness.md` (VPN permanent note)
- Modify lightly: `apps/server-pilot/deploy/vpn-smoke.md` — pointer “after smoke → confidence → always-on”

**Test scenarios:** doc lists ordered commands matching scripts; abort one-liner present.

### U2. Overnight execute + handoff

**Files:**

- Create: `docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-always-on.md`

**Behavior:** sync → stage → confidence → install → post-gate → handoff with proof lines.

**Test scenarios:** live SSM evidence in handoff; or true blocker documented.

## Verification Contract

- Laptop: `bash -n` on new scripts; grep pull-filter in generated conf path.
- EC2 via SSM: confidence + enable + `systemctl is-active openvpn-client@nava`.
- Prove SSM survival: second `ssm-run-command.sh` after enable returns stdout.
- No git-tracked secrets (`git status` clean of `live real data connection/` creds).

## Definition of Done

Global: done criteria checklist above all checked or true blocker filed.

Per unit: U0 scripts + commits; U1 docs; U2 live green handoff.

## Appendix

### Confidence vs smoke

Smoke proved connect + split tunnel once (≤300s, then wipe). Confidence adds **resolv.conf** assert + **reconnect** assert, then promotes to durable systemd — the bar user accepted instead of a 30m soak.

### Disable (operator)

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-disable.sh'
```

### Out of scope follow-ups

- Secrets Manager for VPN auth
- PM2 / mail worker binding after always-on
- Ask IT for server-side push of only `172.24.0.0/16`
## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"
