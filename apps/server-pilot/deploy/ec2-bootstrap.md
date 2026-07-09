# EC2 Bootstrap — NAVA Zero (`server-pilot`)

Repeatable baseline for overnight EC2 work on branch `EC2-pilot`. SSM-only access; no public SSH/RDP.

## Day-to-day ops (use these)

| Need | Command |
|------|---------|
| Ship new code | `bash apps/server-pilot/deploy/ops-deploy.sh` |
| Ship + schema | `bash apps/server-pilot/deploy/ops-deploy.sh --migrate` |
| Bounce apps (no OS reboot) | `bash apps/server-pilot/deploy/ops-restart.sh` |
| Soft reboot box + smoke | `bash apps/server-pilot/deploy/ops-reboot.sh` |

Guts (`sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh`) remain for debugging; do not teach them as the default loop.

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

### Wire nvm into non-interactive SSM shells (idempotent)

SSM uses `sudo -u ubuntu bash -lc ...` (login, non-interactive). Ubuntu `.bashrc` returns early when non-interactive, so load nvm from `.profile` (and mirror in `.bashrc` for interactive sessions):

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh '
grep -q nava-zero-nvm ~/.profile || {
  echo "# nava-zero-nvm"
  echo "export NVM_DIR=/home/ubuntu/.nvm"
  echo "[ -s /home/ubuntu/.nvm/nvm.sh ] && . /home/ubuntu/.nvm/nvm.sh"
} >> ~/.profile
grep -q nava-zero-nvm ~/.bashrc || {
  echo "# nava-zero-nvm"
  echo "export NVM_DIR=/home/ubuntu/.nvm"
  echo "[ -s /home/ubuntu/.nvm/nvm.sh ] && . /home/ubuntu/.nvm/nvm.sh"
} >> ~/.bashrc
echo wired
'
bash apps/server-pilot/deploy/ssm-run-command.sh 'node --version && pnpm --version'
```

Expected: `node v22.x`, `pnpm 10.15.0` without manual `source`. Run verify in a **second** SSM call (profile is read at login start).

Explicit fallback in one-off commands:

```bash
source ~/.nvm/nvm.sh
```

## Step 3 — Sync repo to EC2 (git bundle, no push)

`EC2-pilot` is local-only; private GitHub HTTPS clone fails on EC2 without credentials. Use bundle sync instead of `git push` + clone.

From laptop repo root:

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
```

What it does:

1. `git bundle create` for branch `EC2-pilot`
2. Upload to private bucket `s3://nava-zero-bootstrap-845242190536/git-bundles/zero-EC2-pilot.bundle` (creates bucket if missing; SSE, block public access)
3. SSM: EC2 fetches bundle directly from S3 using its instance profile role (`aws s3 cp s3://...`) — no presigned URLs, so nothing secret is persisted in SSM command history
4. If `/home/ubuntu/repos/zero/.git` exists: in-place `git fetch` from bundle + `git reset --hard bundle/EC2-pilot` (preserves `node_modules` and other untracked work). Only fresh-clones when the repo is absent.
5. Verify `git status --short --branch`, `git log -1`, `node --version`, `pnpm --version`

### Instance-profile S3 access (one-time setup)

The EC2 instance profile role must be allowed to read the bootstrap bundle. An inline policy `NavaZeroBootstrapBundleRead` is attached to role `nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU` granting:

- `s3:GetObject` on `arn:aws:s3:::nava-zero-bootstrap-845242190536/git-bundles/*`
- `s3:ListBucket` on `arn:aws:s3:::nava-zero-bootstrap-845242190536` (prefix `git-bundles/*`)

AWS CLI v2 is installed on the EC2 box (`/usr/local/bin/aws`) so the instance role credentials are picked up automatically — no static creds on the box.

Re-attach (if role is recreated) from laptop:

```bash
aws iam put-role-policy \
  --role-name nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU \
  --policy-name NavaZeroBootstrapBundleRead \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::nava-zero-bootstrap-845242190536/git-bundles/*"]},{"Effect":"Allow","Action":["s3:ListBucket"],"Resource":["arn:aws:s3:::nava-zero-bootstrap-845242190536"],"Condition":{"StringLike":{"s3:prefix":["git-bundles/*"]}}}]}' \
  --region af-south-1
```

Env overrides: `BOOTSTRAP_BUCKET`, `BUNDLE_KEY`, `GIT_BRANCH`.

Re-run after local commits on `EC2-pilot` to refresh EC2 tree (still no push). `node_modules` and other untracked files survive re-sync.

### Legacy HTTPS clone (blocked)

Do not use until GitHub auth on EC2 and branch on origin:

```bash
git clone https://github.com/kufupa/Zero ~/repos/zero  # fails: no credentials
```

## Step 4 — SSM wrapper

From repo root on laptop:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'hostname && whoami'
```

Env overrides: `AWS_REGION`, `INSTANCE_ID`, `SSM_TIMEOUT_SECONDS`, `SSM_POLL_INTERVAL_SECONDS`.

Polls SSM until `Success`, `Failed`, `Cancelled`, or `TimedOut` (does not return while `Pending`/`InProgress`).

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

## Soft reboot checklist

1. Announce to staff (same URL, ~2–5 min gap).
2. `bash apps/server-pilot/deploy/ops-reboot.sh`
3. Staff hard refresh. Prefer `ops-restart.sh` if only apps need bounce.

## Next tasks (not this bootstrap)

- Task 2: RDS, S3, Secrets Manager, `/home/ubuntu/repos/zero/apps/server-pilot/.env.production`
- Task 3: `apps/server-pilot` package scaffold + workspace `@zero/server` resolution
