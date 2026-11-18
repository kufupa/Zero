# EC2 Hotel VPN Boot/Deploy Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development under Overnight Autonomous Execution Mandate below. Steps use checkbox (`- [ ]`) syntax for tracking. Do not ask "which approach?"

**Goal:** Keep always-on hotel OpenVPN alive across crashes and reboots, and make boot/deploy scripts **notice** when it is unhealthy — without restaging secrets every ship.

**Architecture:** Systemd owns reconnect (`Restart=` drop-in + `keepalive`). Shared `vpn-health-assert.sh` owns checks with a locked **HARD vs SOFT** contract. Boot/deploy call that script; they never re-enable the unit. Ephemeral smoke/confidence refuse to `pkill` the always-on process.

**Tech Stack:** Ubuntu 24.04 systemd, OpenVPN 2.6 client (`openvpn-client@nava`), bash deploy scripts under `apps/server-pilot/deploy/`, AWS SSM via `ssm-run-command.sh`.

**Scope (locked B):** recover (Restart + keepalive) **+** notice (post-boot + ops-deploy asserts + route-check harden + pkill guard + docs + live reboot proof).

**Supersedes execution detail in:** [`docs/plans/2026-07-22-003-feat-ec2-vpn-boot-deploy-durability-plan.md`](../../plans/2026-07-22-003-feat-ec2-vpn-boot-deploy-durability-plan.md) (product intent unchanged; this file is the implementable plan).

## Global Constraints

- Never weaken split tunnel: keep `pull-filter ignore "redirect-gateway"`; never push default via `tun`.
- Never restage VPN secrets or re-run `vpn-install-always-on.sh` from `ops-deploy` / `deploy-ec2.sh` / PM2.
- Never put OpenVPN under PM2.
- No secrets in git (`nava-auth.txt`, `*.p12`, `*-tls.key`, PEM keys).
- Live instance: `i-008f737974a9ba9b3`, region `af-south-1`, unit `openvpn-client@nava` already enabled.
- Hard fail = non-zero exit that aborts the calling script. Soft warn = print line, exit code of assert script stays 0 for that check.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, SSM remote tests (VPN health assert, kill-recover, refuse pkill, post-boot smoke), soft reboot via `ops-reboot.sh`, apply systemd drop-in + `keepalive` on live unit, PM2 logs, health curl.

**Forbidden:** force-push main, `--no-verify`, destructive git, soliciting new IT Exchange/VPN/real-mail credentials, restaging VPN secrets from laptop unless install path broken and RCA requires it, weakening split-tunnel / removing pull-filter.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [ ] Tasks 1–5 implemented + committed on `EC2-pilot`
- [ ] Live: `systemctl show openvpn-client@nava -p Restart` → `on-failure`; kill MainPID recovers; HOST_ROUTE still `via 172.31.0.1`
- [ ] Live: `vpn-health-assert.sh` prints `VPN_HARD_OK`; HARD fail proven when unit stopped
- [ ] Live: `post-boot-smoke.sh` PASS includes VPN; `ops-deploy` HARD-asserts without restaging
- [ ] Live: ephemeral smoke/confidence exit 20 (`*_REFUSE_ALWAYS_ON`) without `ALLOW_KILL_ALWAYS_ON=1`
- [ ] Live: `ops-reboot.sh` → `ops-reboot ok` + `VPN_HARD_OK` after boot
- [ ] Handoff: `docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-boot-durability.md`
- [ ] No secrets committed; split tunnel intact

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

---

## Soft / Hard Assert Contract (locked — no fuzzy wording)

Shared script: `apps/server-pilot/deploy/vpn-health-assert.sh`

| Check | Class | Pass criterion | Fail behavior |
|-------|-------|----------------|---------------|
| Unit active | **HARD** | `systemctl is-active --quiet openvpn-client@nava` | print `VPN_HARD_FAIL_UNIT`; exit **1** |
| Host default route | **HARD** | `ip -4 route show default` contains `via 172.31.0.1` and does **not** match `tun` | print `VPN_HARD_FAIL_HOST_ROUTE`; exit **1** |
| Hotel prefix route | **HARD** | `ip -4 route` matches `172\.24\.0\.0/16` | print `VPN_HARD_FAIL_ROUTE_17224`; exit **1** |
| AWS STS | **HARD** | `aws sts get-caller-identity --region af-south-1` succeeds | print `VPN_HARD_FAIL_STS`; exit **1** |
| Hotel TCP (`nc`) | **SOFT** | At least one of hosts `172.24.0.10` `172.24.0.8` `172.24.240.41` answers on any of ports `25 587 993 443 8080 80` | print `VPN_SOFT_WARN_HOTEL`; **do not** change exit code |
| Hotel TCP when `REQUIRE_HOTEL_PROBE=1` | **HARD** | Same probe must succeed | print `VPN_HARD_FAIL_HOTEL`; exit **1** |

**Caller rules (exact):**

| Caller | What it runs | Deploy/boot outcome |
|--------|--------------|---------------------|
| `post-boot-smoke.sh` | `vpn-health-assert.sh` (default SOFT hotel) | HARD fail → smoke exit 1 → boot smoke red |
| `ops-deploy.sh` | same after `:8788/health` | HARD fail → `ops-deploy` aborts (`set -e`); SOFT hotel warn still prints `ops-deploy ok` if HARD pass |
| `vpn-route-check.sh` | HARD checks always; if `POP3_HOST`+`POP3_PORT` set, run those `nc` as **HARD** (existing activate-real-mail path); else hotel matrix follows `REQUIRE_HOTEL_PROBE` (default 0 = SOFT) | Real-mail activate fails closed without tunnel / without POP3 when configured |
| `activate-real-mail.sh` | unchanged call to `vpn-route-check.sh` | Inherits hardened fail-closed |

**Banned phrases in code/comments going forward:** "soft assert (warn or fail flag)", "optional fail", "maybe warn". Use **HARD** / **SOFT** only as defined above.

**Success tokens (print exactly):**

- All HARD pass: `VPN_HARD_OK`
- Hotel SOFT fail: `VPN_SOFT_WARN_HOTEL`
- Hotel SOFT or HARD pass: `VPN_HOTEL_OK`
- Full script success: exit 0 after `VPN_HARD_OK` (and `VPN_HOTEL_OK` or `VPN_SOFT_WARN_HOTEL`)

---

## File Map

| File | Responsibility |
|------|----------------|
| Create `apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf` | Repo copy of Restart drop-in |
| Create `apps/server-pilot/deploy/vpn-health-assert.sh` | Shared HARD/SOFT checks |
| Modify `apps/server-pilot/deploy/vpn-install-always-on.sh` | Install drop-in; add `keepalive 10 60` to generated conf |
| Modify `apps/server-pilot/deploy/post-boot-smoke.sh` | Call health assert after app checks |
| Modify `apps/server-pilot/deploy/nava-post-boot-smoke.service` | `After=`/`Wants=` openvpn unit |
| Modify `apps/server-pilot/deploy/ops-deploy.sh` | HARD assert after health |
| Modify `apps/server-pilot/deploy/vpn-route-check.sh` | Fail closed on unit/route/HOST/STS |
| Modify `apps/server-pilot/deploy/vpn-confidence.sh` | Refuse `pkill` when always-on present |
| Modify `apps/server-pilot/deploy/vpn-safe-smoke.sh` | Same refuse |
| Modify `apps/server-pilot/deploy/vpn-always-on.md` + EC2-ACCESS + readiness/handoff docs | Operator durability |
| Create handoff `docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-boot-durability.md` | Live proof |

`pm2-startup.sh` already copies `nava-post-boot-smoke.service` — no logic change unless copy path broken (verify only).

---

### Task 1: Systemd Restart drop-in + keepalive

**Files:**
- Create: `apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf`
- Modify: `apps/server-pilot/deploy/vpn-install-always-on.sh`
- Live one-shot apply on EC2 (execute phase)

**Interfaces:**
- Consumes: existing `UNIT=openvpn-client@nava`, conf generator block in install script
- Produces: drop-in on disk; `systemctl show -p Restart` → `on-failure`; conf contains `keepalive 10 60`

- [ ] **Step 1: Add drop-in file in repo**

Create `apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf`:

```ini
[Unit]
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Restart=on-failure
RestartSec=5
```

- [ ] **Step 2: Teach install script to copy drop-in + keepalive**

In `vpn-install-always-on.sh`, after writing `$CONF` and before `systemctl enable`:

1. Insert into the conf heredoc (after `auth-nocache`):

```bash
  echo "keepalive 10 60"
```

2. After `chmod`/`chown` of conf, install drop-in:

```bash
DROPIN_DIR="/etc/systemd/system/openvpn-client@nava.service.d"
DROPIN_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/systemd/openvpn-client@nava.service.d/restart.conf"
mkdir -p "$DROPIN_DIR"
cp -f "$DROPIN_SRC" "$DROPIN_DIR/restart.conf"
chmod 644 "$DROPIN_DIR/restart.conf"
systemctl daemon-reload
```

If install script already ran on this box, execute phase still copies drop-in once via SSM (same paths) and runs:

```bash
systemctl daemon-reload
systemctl restart openvpn-client@nava
```

Then assert HOST_ROUTE still `via 172.31.0.1`.

- [ ] **Step 3: Syntax-check install script**

Run (laptop):

```bash
bash -n apps/server-pilot/deploy/vpn-install-always-on.sh
```

Expected: no output, exit 0.

- [ ] **Step 4: Live apply drop-in + prove recover-after-kill**

Via SSM (execute phase):

```bash
# after syncing repo / copying drop-in
systemctl show openvpn-client@nava -p Restart -p RestartSec
# expect Restart=on-failure

MAINPID=$(systemctl show openvpn-client@nava -p MainPID --value)
kill "$MAINPID"
sleep 15
systemctl is-active openvpn-client@nava
# expect active
ip -4 route show default
# expect via 172.31.0.1 (not tun)
```

Expected: unit returns `active` within ~30s; default route unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf \
  apps/server-pilot/deploy/vpn-install-always-on.sh
git commit -m "$(cat <<'EOF'
fix(vpn): add Restart=on-failure drop-in and keepalive

Survive OpenVPN process death without waiting for reboot; detect dead peers faster.
EOF
)"
```

---

### Task 2: Shared `vpn-health-assert.sh`

**Files:**
- Create: `apps/server-pilot/deploy/vpn-health-assert.sh`

**Interfaces:**
- Consumes: systemd unit `openvpn-client@nava`; env `AWS_REGION` (default `af-south-1`); env `REQUIRE_HOTEL_PROBE` (default `0`)
- Produces: exit 0 + `VPN_HARD_OK` on HARD pass; exit 1 + `VPN_HARD_FAIL_*` on HARD fail; may print `VPN_SOFT_WARN_HOTEL` or `VPN_HOTEL_OK`

- [ ] **Step 1: Write the assert script (full content)**

```bash
#!/usr/bin/env bash
# Shared VPN health checks. HARD fails exit 1; hotel TCP is SOFT unless REQUIRE_HOTEL_PROBE=1.
set -euo pipefail

UNIT="${UNIT:-openvpn-client@nava}"
AWS_REGION="${AWS_REGION:-af-south-1}"
REQUIRE_HOTEL_PROBE="${REQUIRE_HOTEL_PROBE:-0}"

HOSTS=(172.24.0.10 172.24.0.8 172.24.240.41)
PORTS=(25 587 993 443 8080 80)

hard_fail() {
  echo "$1"
  exit 1
}

echo "== vpn-health-assert =="

if ! systemctl is-active --quiet "$UNIT"; then
  hard_fail "VPN_HARD_FAIL_UNIT"
fi

DEFAULT="$(ip -4 route show default | head -n1 || true)"
echo "DEFAULT_ROUTE=$DEFAULT"
if [ -z "$DEFAULT" ] || ! echo "$DEFAULT" | grep -q 'via 172\.31\.0\.1'; then
  hard_fail "VPN_HARD_FAIL_HOST_ROUTE"
fi
if echo "$DEFAULT" | grep -qE 'tun[0-9]+'; then
  hard_fail "VPN_HARD_FAIL_HOST_ROUTE"
fi

if ! ip -4 route | grep -qE '172\.24\.0\.0/16'; then
  hard_fail "VPN_HARD_FAIL_ROUTE_17224"
fi

if ! aws sts get-caller-identity --region "$AWS_REGION" >/tmp/nava-vpn-health-sts.json; then
  hard_fail "VPN_HARD_FAIL_STS"
fi

echo "VPN_HARD_OK"

hotel_ok=0
for h in "${HOSTS[@]}"; do
  for p in "${PORTS[@]}"; do
    if nc -z -w 2 "$h" "$p" 2>/dev/null; then
      hotel_ok=1
      echo "HOTEL_PROBE_OK $h:$p"
      break 2
    fi
  done
done

if [ "$hotel_ok" -eq 1 ]; then
  echo "VPN_HOTEL_OK"
else
  if [ "$REQUIRE_HOTEL_PROBE" = "1" ]; then
    hard_fail "VPN_HARD_FAIL_HOTEL"
  fi
  echo "VPN_SOFT_WARN_HOTEL"
fi

exit 0
```

- [ ] **Step 2: chmod + bash -n**

```bash
chmod +x apps/server-pilot/deploy/vpn-health-assert.sh
bash -n apps/server-pilot/deploy/vpn-health-assert.sh
```

Expected: exit 0.

- [ ] **Step 3: Live happy path**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'
```

Expected stdout contains `VPN_HARD_OK` (and `VPN_HOTEL_OK` or `VPN_SOFT_WARN_HOTEL`); SSM exit 0.

- [ ] **Step 4: Live HARD fail proof (unit stop)**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'sudo systemctl stop openvpn-client@nava; bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh; ec=$?; sudo systemctl start openvpn-client@nava; exit $ec'
```

Expected: prints `VPN_HARD_FAIL_UNIT`, non-zero; unit restarted after.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/deploy/vpn-health-assert.sh
git commit -m "$(cat <<'EOF'
feat(vpn): add shared HARD/SOFT vpn-health-assert

Centralize unit/route/STS hard fails and soft hotel TCP warns for boot and deploy.
EOF
)"
```

---

### Task 3: Post-boot smoke + unit ordering

**Files:**
- Modify: `apps/server-pilot/deploy/post-boot-smoke.sh`
- Modify: `apps/server-pilot/deploy/nava-post-boot-smoke.service`

**Interfaces:**
- Consumes: `vpn-health-assert.sh` from Task 2
- Produces: smoke PASS only if apps + HARD VPN checks pass; service waits for openvpn via `Wants=`/`After=`

- [ ] **Step 1: Update systemd unit ordering**

Replace `[Unit]` block in `nava-post-boot-smoke.service` with:

```ini
[Unit]
Description=NAVA Zero post-boot smoke (nginx + :8788 + :443 + VPN)
After=network-online.target pm2-ubuntu.service openvpn-client@nava.service
Wants=network-online.target openvpn-client@nava.service
Requires=pm2-ubuntu.service
```

Do **not** use `Requires=openvpn-client@nava.service` (intentional VPN disable must not block unit install forever).

- [ ] **Step 2: Call assert from post-boot-smoke**

In `post-boot-smoke.sh`, after the existing app checks succeed (before final `PASS` log / `exit 0`), add a short wait then assert:

```bash
  # VPN HARD checks (hotel SOFT). Wait briefly for tun after boot race.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  VPN_WAIT_SECS="${VPN_WAIT_SECS:-30}"
  vpn_ready=0
  for _i in $(seq 1 "$VPN_WAIT_SECS"); do
    if systemctl is-active --quiet openvpn-client@nava \
      && ip -4 route | grep -qE '172\.24\.0\.0/16'; then
      vpn_ready=1
      break
    fi
    sleep 1
  done
  if [ "$vpn_ready" -ne 1 ]; then
    log "attempt ${attempt}: VPN not ready after ${VPN_WAIT_SECS}s"
    ok=0
  elif ! bash "${SCRIPT_DIR}/vpn-health-assert.sh"; then
    log "attempt ${attempt}: vpn-health-assert HARD fail"
    ok=0
  fi
```

Update the PASS log line to include VPN:

```bash
    log "PASS: nginx + :8788 + :443 + pm2 http online + VPN_HARD_OK"
```

Place the VPN block inside the attempt loop so retries apply (same as nginx).

- [ ] **Step 3: bash -n**

```bash
bash -n apps/server-pilot/deploy/post-boot-smoke.sh
```

Expected: exit 0.

- [ ] **Step 4: Reinstall unit on EC2 + run smoke**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'sudo cp /home/ubuntu/repos/zero/apps/server-pilot/deploy/nava-post-boot-smoke.service /etc/systemd/system/nava-post-boot-smoke.service && sudo systemctl daemon-reload && bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/post-boot-smoke.sh'
```

Expected: PASS line includes VPN; stdout shows `VPN_HARD_OK`.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/deploy/post-boot-smoke.sh \
  apps/server-pilot/deploy/nava-post-boot-smoke.service
git commit -m "$(cat <<'EOF'
feat(vpn): assert HARD VPN health in post-boot smoke

Order smoke after openvpn-client@nava so reboot green means tunnel up.
EOF
)"
```

---

### Task 4: ops-deploy HARD assert + route-check harden + pkill guard

**Files:**
- Modify: `apps/server-pilot/deploy/ops-deploy.sh`
- Modify: `apps/server-pilot/deploy/vpn-route-check.sh`
- Modify: `apps/server-pilot/deploy/vpn-confidence.sh`
- Modify: `apps/server-pilot/deploy/vpn-safe-smoke.sh`

**Interfaces:**
- Consumes: `vpn-health-assert.sh`
- Produces: deploy aborts on HARD fail; route-check fails if unit/route bad; ephemeral scripts exit 20 if always-on present unless `ALLOW_KILL_ALWAYS_ON=1`

- [ ] **Step 1: Wire ops-deploy**

After the `:8788/health` curl block in `ops-deploy.sh`, before `echo "ops-deploy ok"`:

```bash
echo "== ops-deploy: VPN HARD assert =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'
```

Because `set -euo pipefail`, HARD fail from SSM non-zero aborts deploy. SOFT hotel warn does not abort.

- [ ] **Step 2: Harden vpn-route-check.sh**

Replace the top of `vpn-route-check.sh` so HARD VPN checks run first (keep existing identity/RDS/S3/POP3 sections after):

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== vpn HARD (unit/route/STS) =="
bash "${SCRIPT_DIR}/vpn-health-assert.sh"

echo "== identity =="
hostname
whoami

echo "== routes =="
ip route

echo "== aws sts =="
aws sts get-caller-identity --region "${AWS_REGION:-af-south-1}" >/tmp/aws-sts.json
cat /tmp/aws-sts.json

echo "== rds =="
psql "$DATABASE_URL" -c "select 1;"

echo "== s3 =="
aws s3 ls "s3://$S3_BUCKET" --region "${AWS_REGION:-af-south-1}" >/dev/null

echo "== pop3/smtp =="
if [ -n "${POP3_HOST:-}" ] && [ -n "${POP3_PORT:-}" ]; then
  nc -vz "$POP3_HOST" "$POP3_PORT"
else
  echo "POP3_HOST/POP3_PORT unset; skipped because real mail connection is deferred"
fi

if [ -n "${SMTP_HOST:-}" ] && [ -n "${SMTP_PORT:-}" ]; then
  nc -vz "$SMTP_HOST" "$SMTP_PORT"
else
  echo "SMTP_HOST/SMTP_PORT unset; skipped because real mail connection is deferred"
fi
```

Note: when POP3/SMTP env are set, those `nc` lines are **HARD** via `set -e` (activate-real-mail). Matrix hotel SOFT already ran inside `vpn-health-assert.sh`.

- [ ] **Step 3: Guard pkill in confidence + safe-smoke**

At the top of both `vpn-confidence.sh` and `vpn-safe-smoke.sh`, immediately after root re-exec / before any `pkill`, add:

```bash
ALWAYS_ON_CONF="/etc/openvpn/client/nava.conf"
if [ -f "$ALWAYS_ON_CONF" ] && systemctl is-enabled --quiet openvpn-client@nava 2>/dev/null; then
  if [ "${ALLOW_KILL_ALWAYS_ON:-0}" != "1" ]; then
    echo "REFUSE: always-on openvpn-client@nava present. Re-run with ALLOW_KILL_ALWAYS_ON=1 only for controlled tests."
    echo "SMOKE_REFUSE_ALWAYS_ON"  # or CONFIDENCE_REFUSE_ALWAYS_ON in confidence script
    exit 20
  fi
  echo "ALLOW_KILL_ALWAYS_ON=1 — stopping unit before ephemeral test"
  systemctl stop openvpn-client@nava
fi
```

Use tag `CONFIDENCE_REFUSE_ALWAYS_ON` in confidence and `SMOKE_REFUSE_ALWAYS_ON` in safe-smoke.

In cleanup of those scripts: if `ALLOW_KILL_ALWAYS_ON=1` was used, end with `systemctl start openvpn-client@nava` (best-effort) so production tunnel returns.

Do **not** change `vpn-disable.sh` pkill (intentional kill path).

- [ ] **Step 4: bash -n all touched scripts**

```bash
bash -n apps/server-pilot/deploy/ops-deploy.sh
bash -n apps/server-pilot/deploy/vpn-route-check.sh
bash -n apps/server-pilot/deploy/vpn-confidence.sh
bash -n apps/server-pilot/deploy/vpn-safe-smoke.sh
```

Expected: all exit 0.

- [ ] **Step 5: Refuse proof**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-safe-smoke.sh'
```

Expected: exit 20, `SMOKE_REFUSE_ALWAYS_ON`, unit still active.

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/deploy/ops-deploy.sh \
  apps/server-pilot/deploy/vpn-route-check.sh \
  apps/server-pilot/deploy/vpn-confidence.sh \
  apps/server-pilot/deploy/vpn-safe-smoke.sh
git commit -m "$(cat <<'EOF'
feat(vpn): HARD assert on deploy; harden route-check; guard pkill

Notice dead tunnels at ship time; refuse ephemeral smoke against always-on.
EOF
)"
```

---

### Task 5: Docs + live soft reboot proof + handoff

**Files:**
- Modify: `apps/server-pilot/deploy/vpn-always-on.md`
- Modify: `docs/superpowers/EC2-ACCESS.MD` (§9 VPN)
- Modify: `apps/server-pilot/deploy/deferred-real-mail-readiness.md`
- Modify: `apps/server-pilot/deploy/it-handoff-runbook.md` (brief)
- Modify: `apps/server-pilot/deploy/ec2-bootstrap.md` (brief: new instance still needs stage→confidence→install once)
- Create: `docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-boot-durability.md`

**Interfaces:**
- Consumes: live proofs from Tasks 1–4 + `ops-reboot.sh`
- Produces: operator runbook that states HARD vs SOFT; reboot evidence

- [ ] **Step 1: Update vpn-always-on.md**

Add section **Durability (boot / deploy / crash)** covering:

- systemd `Restart=on-failure` drop-in path
- `keepalive 10 60`
- post-boot + ops-deploy call `vpn-health-assert.sh` (HARD unit/route/STS; SOFT hotel)
- deploy never restages VPN
- new AMI / new instance: still run stage → confidence → install once
- abort: `vpn-disable.sh`
- ephemeral smoke refuse unless `ALLOW_KILL_ALWAYS_ON=1`

- [ ] **Step 2: Update EC2-ACCESS §9 + deferred readiness + bootstrap note**

State always-on is live + durable Restart; point to `vpn-always-on.md` and this plan.

- [ ] **Step 3: Live soft reboot proof**

```bash
bash apps/server-pilot/deploy/ops-reboot.sh
```

Expected: `ops-reboot ok`; post-boot smoke PASS includes VPN; afterward:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'systemctl is-active openvpn-client@nava; ip -4 route show default; bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'
```

Expected: `active`, default `via 172.31.0.1`, `VPN_HARD_OK`.

- [ ] **Step 4: Write handoff report**

Include: Restart show output, kill-recover evidence, refuse exit 20, ops-reboot evidence, HOST_ROUTE still ens5, link to this plan.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/deploy/vpn-always-on.md \
  docs/superpowers/EC2-ACCESS.MD \
  apps/server-pilot/deploy/deferred-real-mail-readiness.md \
  apps/server-pilot/deploy/it-handoff-runbook.md \
  apps/server-pilot/deploy/ec2-bootstrap.md \
  docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-boot-durability.md
git commit -m "$(cat <<'EOF'
docs(vpn): boot/deploy durability runbook and reboot proof

Document HARD/SOFT asserts and capture soft-reboot evidence for always-on VPN.
EOF
)"
```

---

## Self-Review

1. **Spec coverage (scope B):** Restart+keepalive (T1); notice via post-boot (T3) + ops-deploy (T4); route-check harden (T4); pkill guard (T4); docs+reboot proof (T5); shared assert with locked HARD/SOFT (T2). Gaps: none for locked scope.
2. **Placeholder scan:** no TBD / "warn or fail flag" / optional fuzzy assert.
3. **Type consistency:** tokens `VPN_HARD_OK`, `VPN_HARD_FAIL_*`, `VPN_SOFT_WARN_HOTEL`, `VPN_HOTEL_OK`, exit 20 refuse tags consistent across tasks.

## Out of scope (explicit)

- CloudWatch alarm on inactive unit
- Secrets Manager migration
- Worker-level wait-for-172.24 before first POP3 (app retry already helps)
