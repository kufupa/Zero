# EC2 Bootstrap — NAVA Zero (`server-pilot`)

Repeatable baseline for overnight EC2 work on branch `EC2-pilot`. SSM-only access; no public SSH/RDP.

## AWS identifiers

| Item | Value |
|------|--------|
| Account | `845242190536` |
| Region | `af-south-1` |
| Instance | `i-008f737974a9ba9b3` |
| Stack | `nava-prod-public-ipv4` |
| OS user | `ubuntu` |
| Repo path (target) | `/home/ubuntu/repos/zero` |

## Laptop env

```bash
export AWS_REGION=af-south-1
export INSTANCE_ID=i-008f737974a9ba9b3
export STACK_NAME=nava-prod-public-ipv4
```

## Step 1 — Verify SSM access

```bash
aws sts get-caller-identity
aws ssm describe-instance-information \
  --region "$AWS_REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text
```

**Verified 2026-07-01:** caller `arn:aws:iam::845242190536:user/ansh-cursor`, PingStatus `Online`.

Remote smoke:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'hostname && whoami && pwd'
```

**Verified 2026-07-01:** `Status=Success`, stdout `ip-172-31-12-112`, `ubuntu`.

Or raw AWS CLI:

```bash
COMMAND_ID="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "nava overnight command" \
  --timeout-seconds 900 \
  --parameters '{"commands":["sudo -u ubuntu bash -lc \"hostname && whoami && pwd\""]}' \
  --query 'Command.CommandId' \
  --output text)"

aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
```

## Step 2 — Node / pnpm on EC2

Ubuntu 24.04 ships Node 20 via apt. Pilot needs Node 22 + pnpm 10.15.0.

**RCA (2026-07-01):** system Node was `v20.20.2`, no pnpm. Installed nvm + Node 22 LTS + corepack pnpm.

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh '
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
nvm use 22
corepack enable
corepack prepare pnpm@10.15.0 --activate
node --version
pnpm --version
'
```

**Verified 2026-07-01:** `node v22.23.1`, `pnpm 10.15.0`.

Login shells must source nvm before node/pnpm:

```bash
source ~/.nvm/nvm.sh
```

Add to `~/.bashrc` if missing (idempotent):

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
```

## Step 3 — Clone or update repo on EC2

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh '
set -euo pipefail
source ~/.nvm/nvm.sh
mkdir -p ~/repos
if [ ! -d ~/repos/zero/.git ]; then
  git clone https://github.com/kufupa/Zero ~/repos/zero
fi
cd ~/repos/zero
git fetch --all --prune
git checkout EC2-pilot
git pull --ff-only || true
corepack enable
corepack prepare pnpm@10.15.0 --activate
pnpm --version
node --version
'
```

### Blockers (2026-07-01)

1. **Private GitHub repo:** HTTPS clone fails on EC2 without credentials:
   `fatal: could not read Username for 'https://github.com': No such device or address`
2. **`EC2-pilot` not on remote:** local-only branch at laptop; `git ls-remote origin EC2-pilot` empty. EC2 can only see commits after `git push -u origin EC2-pilot`.

**Unblock before deploy tasks:**

- Push `EC2-pilot` to origin, **and**
- Configure EC2 git auth (deploy key in `~/.ssh`, or read-only PAT in credential helper).

Until then, bootstrap scripts and SSM wrapper are validated from laptop; repo tree on EC2 stays empty (`~/repos/` exists, no `zero/` clone).

## Step 4 — SSM wrapper

From repo root on laptop:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'hostname && whoami'
```

Env overrides: `AWS_REGION`, `INSTANCE_ID`, `SSM_TIMEOUT_SECONDS`.

## Step 5 — Interactive shell (optional)

```bash
aws ssm start-session \
  --region af-south-1 \
  --target i-008f737974a9ba9b3 \
  --document-name AWS-StartInteractiveCommand \
  --parameters command="sudo -u ubuntu -i bash -l"
```

## Related paths on box

| Path | Purpose |
|------|---------|
| `/opt/nava/` | NAVA worker runtime (Playwright, xRDP) |
| `/home/ubuntu/nava-workflow-pilot/` | Legacy workflow pilot clone |
| `/home/ubuntu/repos/zero` | Target Zero monorepo (this pilot) |

Full EC2 access doc: `docs/superpowers/EC2-ACCESS.MD` (reference; not required on box).

## Next tasks (not this bootstrap)

- Task 2: RDS, S3, Secrets Manager, `/home/ubuntu/repos/zero/apps/server-pilot/.env.production`
- Task 3: `apps/server-pilot` package scaffold + workspace `@zero/server` resolution
