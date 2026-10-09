---
title: EC2 ops-deploy fails at pnpm install when .husky/_/h is read-only
date: 2026-08-06
last_updated: 2026-10-09
category: workflow-issues
module: server-pilot deploy
problem_type: workflow_issue
component: development_workflow
severity: high
symptoms:
  - "husky prepare aborts pnpm install with EACCES: permission denied, copyfile ... husky -> .husky/_/h"
  - "ops-deploy.sh exits 70 at the on-box deploy step; app stays on the prior healthy build"
  - "chown -R ubuntu:ubuntu .husky does not fix; .husky/_/h is ubuntu:ubuntu mode 444"
  - "chmod u+w on .husky/_/h unblocks re-run of deploy-ec2.sh"
root_cause: config_error
resolution_type: environment_setup
related_components:
  - tooling
  - development_workflow
tags:
  - ec2-pilot
  - ops-deploy
  - husky
  - eacces
  - pnpm-install
  - prepare-lifecycle
  - readonly-hook
applies_when:
  - "EC2 pilot ops-deploy fails at on-box pnpm install during husky prepare"
  - "EACCES on copyFileSync into .husky/_/h after ownership looks correct"
  - "Root package.json prepare runs husky (husky 9.x)"
---

# EC2 ops-deploy fails at pnpm install when `.husky/_/h` is read-only

## Context

Pilot EC2 deploy can sync a new git HEAD successfully and still abort before build/PM2 reload because the on-box `pnpm install` runs the root `prepare` script (`husky`), and husky cannot overwrite the generated hook shim at `.husky/_/h` when that file is mode `0444` (owner-read-only). The failure looks like a permissions / ownership problem, but ownership can already be correct; the blocker is the missing owner write bit on the destination of a `copyfile`. Until that file is writable, every on-box deploy that reaches `pnpm install` fails the same way, and the pilot keeps serving the previous healthy build.

## Guidance

### Symptoms

- After a successful laptop→EC2 sync, on-box deploy fails at the husky prepare step with:
  `Error: EACCES: permission denied, copyfile '.../husky@9.1.7/node_modules/husky/husky' -> '.husky/_/h'`
- Session evidence: sync succeeded and EC2 HEAD advanced to the mail Calibri font commit on `EC2-pilot`, then on-box deploy still failed at prepare until the chmod fix.
- Diagnostic `ls` / `stat` on the box: `.husky` and `.husky/_` owned `ubuntu:ubuntu`, while `.husky/_/h` was mode `444` (`-r--r--r--`).
- Running app / health path can remain fine during the failed install - only the deploy pipeline is blocked until install completes and later steps run.
- When the laptop wrapper is used, `ops-deploy.sh` can surface the failed on-box step as exit `70` after bundle sync already moved HEAD.

### What didn't work

- **`sudo chown -R ubuntu:ubuntu /home/ubuntu/repos/zero/.husky`** - printed a writable confirmation in the recovery attempt, but the next deploy failed with the identical EACCES. Ownership was already `ubuntu:ubuntu`; chown did not change the `0444` mode on `.husky/_/h`.
- Treating EACCES on `.husky/**` as "wrong user / wrong tree owner" without `stat`'ing the destination **mode** wastes a deploy cycle.

### Fix

Restore the owner write bit on the generated hook file, then re-run the on-box deploy. When the bundle is already synced, a full re-sync is unnecessary.

As of 2026-10-09, `apps/server-pilot/deploy/ops-deploy.sh` runs this `chmod` over SSM right after the bundle sync, before its first on-box `pnpm install`. A missing hook is skipped. The manual step below is only needed when `deploy-ec2.sh` is run on the box directly:

```bash
# On the EC2 box (e.g. via ssm-run-command.sh)
chmod u+w /home/ubuntu/repos/zero/.husky/_/h

# Standard on-box deploy (already-synced tree)
cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh
```

Session post-verify after that path: on-box `COMMIT` matched the already-synced font commit, `/health` ok, `VPN_HARD_OK`. That is operational evidence the deploy completed after chmod - not a claim that a git commit permanently fixed husky install behavior.

## Why This Matters

Grounded tree behavior:

1. Root `package.json` declares `"prepare": "husky"`:

```8:8:package.json
    "prepare": "husky",
```

2. The repo pins husky at `9.1.7` (matches the error path `husky@9.1.7`):

```62:62:package.json
    "husky": "9.1.7",
```

3. On-box deploy always runs a frozen install early, which triggers lifecycle scripts including `prepare`:

```96:97:apps/server-pilot/deploy/deploy-ec2.sh
echo "== pnpm install =="
pnpm install --frozen-lockfile
```

4. Laptop front door `apps/server-pilot/deploy/ops-deploy.sh` syncs the bundle, then invokes that on-box script - so a failed prepare surfaces as a failed ops-deploy even when sync already moved HEAD.

Husky's prepare regenerates `.husky/_/h` by copying its bundled shim onto that path (`copyFileSync` without prior unlink). If the destination lacks owner write, prepare fails with `EACCES` (OS/Node overwrite semantics; confirm with `stat` on the box). Adding `u+w` lets the copy succeed; install proceeds; build and later deploy steps can run.

On POSIX, `chown` changes owner/group and does not restore a missing write bit. When diagnostics already show `ubuntu:ubuntu` plus mode `444`, ownership theater is a red herring - per this session's incident, only `chmod u+w` unblocked husky. A failed install leaves the previous healthy build running (no downtime), which is why mid-incident chmod + re-deploy is safe.

## When to Apply

- EC2 pilot `ops-deploy` fails at on-box `pnpm install` during husky `prepare`
- EACCES on `copyFileSync` into `.husky/_/h` after ownership looks correct
- Root `package.json` `prepare` runs husky (husky 9.x)

## Examples

**Before (fragile triage):** see EACCES → `chown -R ubuntu:ubuntu .husky` → retry ops-deploy → same failure.

**After:**

```bash
stat -c '%U:%G %a %n' /home/ubuntu/repos/zero/.husky/_/h
# expect: ubuntu:ubuntu 444 ...
chmod u+w /home/ubuntu/repos/zero/.husky/_/h
cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh
```

`ops-deploy.sh` now repairs only `.husky/_/h`. If read-only mode recurs in other hook files, the broader repair (`chmod -R u+w .husky/_` before `pnpm install`) is still not landed; treat it as recommended follow-up, not done work.

Exact historical reason `.husky/_/h` became `0444` on the box was not established (prior deploy, tool, or umask). Do not assert a single provenance story.

## Related

- [EC2 Pilot ops-deploy, ops-restart, and ops-reboot Entry Points](./ec2-pilot-ops-deploy-restart-reboot.md) - deploy front door whose on-box step this failure blocks.
- [EC2 pilot autonomous deploy and SSM gotchas](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) - adjacent deploy/SSM failure modes (different root causes: SSM charmap, migrate env, PATH/nvm).
