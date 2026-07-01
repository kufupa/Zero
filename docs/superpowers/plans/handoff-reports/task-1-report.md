# Task 1 Report — EC2 Bootstrap Reviewer Findings Fix

Date: 2026-07-01
Branch: EC2-pilot
Commit: 64695dbf

## Findings addressed

1. Presigned URL exposed in SSM command parameters/history.
2. `rm -rf` of EC2 repo on every sync destroyed build artifacts (node_modules).

## RCA

**Finding 1 (presigned URL in SSM history):** `sync-ec2-git-bundle.sh` generated a short-lived S3 presigned GET URL and embedded it verbatim in the SSM `send-command` parameters. SSM retains command parameters (including `--parameters commands=[...]`) in command invocation history for the account for ~90 days (cloud-side, accessible to anyone with `ssm:GetCommandInvocation`/`List*`). Anyone reading that history later could reuse the URL within its validity window, and the URL pattern itself leaks the bucket + key. Root cause: choice of presign-as-transport instead of direct instance-role S3 access.

**Finding 2 (rm -rf destroys artifacts):** The remote script ran `rm -rf '${EC2_REPO_PATH}'; git clone ...` unconditionally on every sync. This nuked `node_modules`, build outputs, and any untracked local work on every re-sync, forcing a full reinstall and losing state. Root cause: no existence check on `.git` — clone-only path used for both first boot and subsequent syncs.

## What changed

### `apps/server-pilot/deploy/sync-ec2-git-bundle.sh`
- Removed `PRESIGN_EXPIRES_SECONDS`, `aws s3 presign`, and the presigned URL variable.
- Remote script now uses `aws s3 cp s3://<bucket>/<key> /tmp/zero-EC2-pilot.bundle --region af-south-1` so EC2 fetches the bundle via its instance profile role. No URL is ever placed in SSM parameters.
- Added in-place update branch: if `/home/ubuntu/repos/zero/.git` exists, run `git fetch <bundle> '+refs/heads/*:refs/remotes/bundle/*'`, then `git checkout EC2-pilot && git reset --hard bundle/EC2-pilot`. Fresh `git clone` runs only when the repo is absent. Untracked files (`node_modules`, etc.) are not touched by fetch/reset.
- Inlined literal paths in the remote script (no shell vars) because `ssm-run-command.sh` wraps the script in `bash -lc "..."`; `${var}` would be expanded by the outer bash before the inner assignment executes, producing empty paths.

### `apps/server-pilot/deploy/ec2-bootstrap.md`
- Replaced presign step with instance-profile S3 access step.
- Documented inline policy `NavaZeroBootstrapBundleRead` attached to role `nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU` granting `s3:GetObject` on `arn:aws:s3:::nava-zero-bootstrap-845242190536/git-bundles/*` and `s3:ListBucket` on `arn:aws:s3:::nava-zero-bootstrap-845242190536` (prefix `git-bundles/*`).
- Documented that AWS CLI v2 is installed on the EC2 box so instance role credentials are picked up automatically (no static creds on box).
- Documented in-place update behavior and that `node_modules`/untracked work survives re-sync.
- Dropped `PRESIGN_EXPIRES_SECONDS` from env overrides list.

### AWS-side changes (not committed; applied via AWS CLI from laptop)
- Attached inline policy `NavaZeroBootstrapBundleRead` to IAM role `nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU` (the EC2 instance profile role).
- Installed AWS CLI v2 (`aws-cli/2.35.13`) on EC2 instance `i-008f737974a9ba9b3` at `/usr/local/bin/aws` so the instance role is used for S3 access without static credentials.

## Verification (non-secret)

1. **Instance role S3 access from EC2:**
   - `aws sts get-caller-identity` on EC2 → `arn:aws:sts::845242190536:assumed-role/nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU/i-008f737974a9ba9b3`. Confirms instance role in use, no static creds.
   - `aws s3 ls s3://nava-zero-bootstrap-845242190536/git-bundles/` → listed `zero-EC2-pilot.bundle`. Confirms policy grants read.

2. **No presigned URL in SSM parameters:**
   - Grep of `apps/server-pilot/deploy/` for `presign|PRESIGN|presigned` → only explanatory "no presigned URL" comments remain; no presign code path, no URL literals.

3. **Re-sync preserves node_modules (sentinel test):**
   - Pre-sync: created `/home/ubuntu/repos/zero/node_modules/.nava-sync-sentinel` with content `sentinel-1782870395-preserved`.
   - Ran `bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh` from laptop. SSM status `Success`. Remote stdout: `git fetch` created `[new branch] EC2-pilot -> bundle/EC2-pilot`, `Already on 'EC2-pilot'`, `HEAD is now at e042f530`, `node v22.23.1`, `pnpm 10.15.0`.
   - Post-sync: `ls -la /home/ubuntu/repos/zero/node_modules/.nava-sync-sentinel` → file present, content `sentinel-1782870395-preserved`. **Sentinel survived re-sync.** Untracked `node_modules` preserved.
   - `git status --short --branch` → `## EC2-pilot...origin/EC2-pilot`, clean tree at `e042f530`.

4. **In-place vs fresh-clone branch selection:**
   - Repo existed (`.git` present) → took in-place `git fetch` + `git reset --hard bundle/EC2-pilot` branch. No `rm -rf` and no `git clone` executed.

## Commit

- SHA: `64695dbf`
- Subject: `fix(deploy): use instance-profile S3 access and preserve node_modules on sync`
- Files: `apps/server-pilot/deploy/sync-ec2-git-bundle.sh`, `apps/server-pilot/deploy/ec2-bootstrap.md`
- Not pushed to remote (per constraints).

## Concerns

- AWS CLI v2 install on EC2 and the inline IAM policy are AWS-side state not captured in git. If the EC2 instance or role is recreated, both must be re-applied (instructions in `ec2-bootstrap.md`).
- Inline policy is attached to the production worker role; it is scoped to a single bucket prefix, but future tightening could move it to a managed policy.
