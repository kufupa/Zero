# NAVA EC2 — complete access & runtime handoff

Copy this file alone into any repo or chat. It contains everything needed to reach the worker, run Chromium/Playwright, and operate the workflow pilot **without** other NAVA docs.

## Day-to-day ops (use these)

| Need | Command |
|------|---------|
| Ship new code | `bash apps/server-pilot/deploy/ops-deploy.sh` |
| Ship + schema | `bash apps/server-pilot/deploy/ops-deploy.sh --migrate` |
| Bounce apps (no OS reboot) | `bash apps/server-pilot/deploy/ops-restart.sh` |
| Soft reboot box + smoke | `bash apps/server-pilot/deploy/ops-reboot.sh` |

Guts (`sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh`) remain for debugging; do not teach them as the default loop.

---

## 1. What this machine is

- **Purpose:** NAVA Stage 1 **production worker** in AWS (browser automation, workflow teach/replay, future HMS web workflows via VPN).
- **Access model:** **No public SSH/RDP.** Admin only via **AWS SSM** (IAM). Desktop via **SSM port-forward + RDP**.
- **Browser runtime:** **Playwright bundled Chromium** at `/opt/nava/playwright-browsers` — **not** Google Chrome.

---

## 2. AWS identifiers (memorize these)

| Item | Value |
|------|--------|
| **AWS account** | `845242190536` |
| **Region** | `af-south-1` (Africa / Cape Town) |
| **CloudFormation stack** | `nava-prod-public-ipv4` |
| **Instance ID** | `i-008f737974a9ba9b3` |
| **Elastic IP (public)** | `13.247.138.62` |
| **Instance type** | `m6i.xlarge` (4 vCPU, 16 GiB RAM) |
| **OS** | Ubuntu 24.04 |
| **Linux user** | `ubuntu` |
| **VPC** | `vpc-0f078e17a5f0f8599` |
| **Subnet** | `subnet-0e6446aaaeaa8762e` |
| **Security group** | `sg-00190151691bd66fa` |
| **Root EBS volume** | `vol-06b5dc5ed39b8aa5f` (100 GB gp3, encrypted, persists on stop) |

### What is the Elastic IP?

Static public IPv4 attached to the instance. **Outbound** traffic uses `13.247.138.62` consistently. It does **not** mean RDP/SSH are open to the internet — security group has **zero inbound** rules.

---

## 3. Bare minimum on your laptop (prerequisites)

1. **AWS CLI v2** configured with credentials for account `845242190536`
2. **Region** set to `af-south-1` (profile or env)
3. **Session Manager plugin** for AWS CLI  
   https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
4. **IAM permission** to use SSM on the instance (`ssm:StartSession`, `ssm:SendCommand`, etc.)
5. **(Optional, for recording)** Microsoft Remote Desktop — connect to `localhost:3390` through SSM tunnel

### Quick env (bash)

```bash
export AWS_REGION=af-south-1
export INSTANCE_ID=i-008f737974a9ba9b3
export STACK_NAME=nava-prod-public-ipv4
```

### Verify access

```bash
aws sts get-caller-identity
aws ssm describe-instance-information \
  --region af-south-1 \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text
```

**Expected:** `Online`

Resolve IDs from stack (if instance ever replaced):

```bash
aws cloudformation describe-stacks \
  --region af-south-1 \
  --stack-name nava-prod-public-ipv4 \
  --query 'Stacks[0].Outputs' \
  --output table
```

---

## 4. How to get a shell on EC2

### Interactive shell (SSM)

```bash
aws ssm start-session \
  --region af-south-1 \
  --target i-008f737974a9ba9b3
```

Runs as root in SSM document context; for app work prefer:

```bash
aws ssm start-session \
  --region af-south-1 \
  --target i-008f737974a9ba9b3 \
  --document-name AWS-StartInteractiveCommand \
  --parameters command="sudo -u ubuntu -i bash -l"
```

### Run one command remotely (SSM RunShellScript)

```bash
aws ssm send-command \
  --region af-south-1 \
  --instance-ids i-008f737974a9ba9b3 \
  --document-name AWS-RunShellScript \
  --comment "your comment" \
  --timeout-seconds 300 \
  --parameters '{"commands":["sudo -u ubuntu bash -lc \"hostname && whoami\""]}' \
  --query 'Command.CommandId' \
  --output text
```

Then fetch output (replace `COMMAND_ID`):

```bash
aws ssm get-command-invocation \
  --region af-south-1 \
  --command-id COMMAND_ID \
  --instance-id i-008f737974a9ba9b3 \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
```

### SSH-over-SSM (optional)

Add to `~/.ssh/config`:

```sshconfig
Host i-* mi-*
    ProxyCommand aws ssm start-session --region af-south-1 --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p
    User ubuntu
    IdentityFile ~/.ssh/nava_prod_ed25519
```

Connect: `ssh i-008f737974a9ba9b3` (after placing your public key in `ubuntu`’s `authorized_keys` via SSM once).

---

## 5. Desktop access (xRDP) — required for **headed** workflow recording

SSM shell alone has **no DISPLAY**. To record workflows in Chrome, use xRDP.

**Terminal 1 — leave open:**

```bash
aws ssm start-session \
  --region af-south-1 \
  --target i-008f737974a9ba9b3 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3389"],"localPortNumber":["3390"]}'
```

**Terminal 2 — Remote Desktop client:**

```text
localhost:3390
```

User: `ubuntu` (set password via SSM if needed: `sudo passwd ubuntu`).

**Latency note:** Laptop → Cape Town is ~150–250 ms RTT; usable for teach, not instant.

---

## 6. What is installed on the box (paths)

| Path | Purpose |
|------|---------|
| `/opt/nava/` | NAVA runtime root |
| `/opt/nava/ec2-playwright-chromium/` | Playwright venv + scripts |
| `/opt/nava/ec2-playwright-chromium/.venv/` | Python venv (Playwright 1.52.0) |
| `/opt/nava/ec2-playwright-chromium/env.sh` | **Source this** before browser commands |
| `/opt/nava/playwright-browsers/` | Chromium binaries (chromium-1169) |
| `/opt/nava/bootstrap-worker.sh` | Host bootstrap (xRDP, UFW, openvpn client pkg, etc.) |
| `/opt/nava/ec2-xrdp-session-cleanup/` | Kills stale xRDP sessions |
| `/home/ubuntu/nava-workflow-pilot/` | Workflow pilot git clone |
| `/home/ubuntu/nava-logs/` | Preflight / replay logs |
| `/var/log/nava/` | System logs (may need sudo) |

**Chromium binary (typical):**

```text
/opt/nava/playwright-browsers/chromium-1169/chrome-linux/chrome
```

---

## 7. Chromium / Playwright — how to run anything

**Always on EC2:**

```bash
source /opt/nava/ec2-playwright-chromium/env.sh
```

That sets:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/nava/playwright-browsers
export NAVA_BROWSER_AUTOMATION_VENV=/opt/nava/ec2-playwright-chromium/.venv
```

### Smoke test (headless, works from SSM)

```bash
source /opt/nava/ec2-playwright-chromium/env.sh
/opt/nava/ec2-playwright-chromium/.venv/bin/python \
  /opt/nava/ec2-playwright-chromium/validate.py
```

**Expected:** `ALL CHECKS PASSED`

### Reinstall Chromium stack (idempotent, rare)

From a machine with this repo, or paste bootstrap onto box:

```bash
sudo bash /opt/nava/ec2-playwright-chromium/bootstrap.sh
```

### Do **not** on EC2

- Bare `playwright install` (not on PATH; wrong version)
- `uv run python` in workflow pilot (reinstalls Playwright 1.60, breaks browser match)
- Install Google Chrome as substitute

**Pilot rule:** use `.venv/bin/python` + `PLAYWRIGHT_BROWSERS_PATH` + pin **playwright==1.52.0**.

---

## 8. Workflow pilot (teach / replay)

### Clone (if missing on box)

```bash
sudo -u ubuntu bash -lc '
  git clone --depth 1 https://github.com/kufupa/nava-workflow-pilot.git ~/nava-workflow-pilot
  cd ~/nava-workflow-pilot && bash scripts/setup-ec2.sh
'
```

### Record (xRDP terminal only — needs DISPLAY)

```bash
cd ~/nava-workflow-pilot
git pull
bash scripts/record.sh
```

Extension: puzzle icon → **browser-use-workflow-recorder** → Start recording → do workflow → Stop.

### Replay

```bash
cd ~/nava-workflow-pilot
bash scripts/replay.sh workflow-use/workflows/tmp/YOUR.semantic.workflow.yaml
```

Example workflow already on box: `3y_srn4b.semantic.workflow.yaml` (DuckDuckGo smoke).

### Deploy + verify from laptop (needs this repo’s scripts)

If you have `browser-automation-pilot` locally:

```bash
export AWS_REGION=af-south-1
export INSTANCE_ID=i-008f737974a9ba9b3
cd browser-automation-pilot
bash scripts/ec2-deploy-preflight-via-ssm.sh
```

---

## 9. VPN (always-on after confidence)

- **Why:** Reach Zimbra / Rocketseed / Infor on `172.24.0.0/16` without public APIs.
- **Status:** Always-on **live** on pilot (`openvpn-client@nava` active+enabled). Durable: systemd `Restart=on-failure` drop-in + `keepalive 10 60`. Boot/deploy notice via `vpn-health-assert.sh` (HARD unit/route/STS; SOFT hotel).
- **Runbooks:** [`vpn-smoke.md`](../../apps/server-pilot/deploy/vpn-smoke.md) (ephemeral) → [`vpn-always-on.md`](../../apps/server-pilot/deploy/vpn-always-on.md) (confidence → enable + durability). Plan: [`2026-07-22-ec2-vpn-boot-deploy-durability.md`](./plans/2026-07-22-ec2-vpn-boot-deploy-durability.md).
- **Scripts:** `vpn-stage-to-ec2.sh` → `vpn-confidence.sh` → `vpn-install-always-on.sh`; abort `vpn-disable.sh`. Deploy never restages VPN.
- **Guards:** `pull-filter ignore redirect-gateway` + DNS/DOMAIN; host default-route + resolv assert; auto-disable on HOST_ROUTE fail; ephemeral smoke refuses always-on unless `ALLOW_KILL_ALWAYS_ON=1`.
- **Egress:** Security group allows all outbound (`0.0.0.0/0`) for SSM, apt, VPN, and web.
- **Allowlist:** hotel firewall may need `13.247.138.62`.

---

## 10. Security summary

| Topic | Policy |
|-------|--------|
| Inbound from internet | **None** (SG empty ingress) |
| Admin access | **IAM + SSM only** |
| Public IP | EIP for **stable outbound** only |
| UFW on instance | Default deny incoming |
| RDP/SSH to `13.247.138.62` | **Blocked** — use SSM tunnel |

---

## 11. Useful ops commands

```bash
# Soft reboot + post-boot smoke (preferred)
bash apps/server-pilot/deploy/ops-reboot.sh

# App bounce only
bash apps/server-pilot/deploy/ops-restart.sh

# Ship code
bash apps/server-pilot/deploy/ops-deploy.sh

# Raw reboot (advanced — prefer ops-reboot.sh)
aws ec2 reboot-instances --region af-south-1 --instance-ids i-008f737974a9ba9b3

# Re-run host bootstrap
aws ssm send-command --region af-south-1 --instance-ids i-008f737974a9ba9b3 \
  --document-name AWS-RunShellScript \
  --parameters commands='["sudo bash /opt/nava/bootstrap-worker.sh"]'

# Tail pilot preflight log on box
sudo tail -100 /home/ubuntu/nava-logs/pilot-preflight.log

# Check xRDP
sudo systemctl status xrdp
```

---

## 12. Git repos (if you need source)

| Repo | URL |
|------|-----|
| Workflow pilot (deploy target on EC2) | https://github.com/kufupa/nava-workflow-pilot |
| workflow-use fork (recorder fixes) | https://github.com/kufupa/workflow-use/tree/nava/recorder-fixes |

---

## 13. One-page cheat sheet

```bash
# --- LAPTOP ---
export AWS_REGION=af-south-1
export INSTANCE_ID=i-008f737974a9ba9b3

# Shell
aws ssm start-session --region af-south-1 --target $INSTANCE_ID

# Desktop tunnel (then RDP localhost:3390)
aws ssm start-session --region af-south-1 --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3389"],"localPortNumber":["3390"]}'

# --- ON EC2 (SSM or xRDP) ---
source /opt/nava/ec2-playwright-chromium/env.sh
/opt/nava/ec2-playwright-chromium/.venv/bin/python /opt/nava/ec2-playwright-chromium/validate.py

cd ~/nava-workflow-pilot && git pull
bash scripts/record.sh    # xRDP only
bash scripts/replay.sh workflow-use/workflows/tmp/foo.semantic.workflow.yaml
```

---

## 14. If something is missing

| Symptom | Fix |
|---------|-----|
| SSM not Online | Wait after reboot; check IAM; instance running |
| `validate.py` fails | `sudo bash /opt/nava/ec2-playwright-chromium/bootstrap.sh` |
| Chrome won't open on record | Use **xRDP** terminal; `echo $DISPLAY` must be set |
| `chromium-1223` / browser not found | Don't use `uv run`; use pilot `record.sh` / `replay.sh` |
| No pilot tree | `git clone` URL above + `bash scripts/setup-ec2.sh` |

---

*Last aligned with deployed stack `nava-prod-public-ipv4`, instance `i-008f737974a9ba9b3`, EIP `13.247.138.62`, pilot commit on `kufupa/nava-workflow-pilot` main.*
