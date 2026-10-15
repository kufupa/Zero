# VPS migration: where everything is (2026-10-15)

The old dev VPS (4 vCPU / 15 GB, users `orca` + `ubuntu`) is being replaced. Anything not on GitHub or S3 is gone. Paste the prompt below into the first agent session on the new VPS.

No secrets are in this file or in git. Keys, tokens, `.env*` files and Postgres URLs must be set up again from their owners (AWS IAM, GitHub `gh auth login`, prod `.env.production` stays on EC2).

---

## Paste-ready prompt for the new VPS agent

> You are setting up the Nava (kufupa/zero) dev VPS after a migration. Restore state as follows, then report what worked.
>
> **1. Code (GitHub `kufupa/zero`).** Every worktree and branch was pushed on 2026-10-15. `git clone git@github.com:kufupa/zero.git /home/ubuntu/projects/zero`. Parked work lives on `wip/*park*` branches (list below). `main` is the source of truth; do not merge park branches blindly. Read `AGENTS.md`, `PRODUCT.md`, `docs/context/ACTIVE.md`, `docs/context/FACTS.md` (section 8 = 2026-10-15) and `docs/context/MISTAKES.md` first.
>
> **2. Backups (S3, af-south-1).** Prefix `s3://nava-zero-mail-845242190536-af-south-1/vps-migration/`. Run `aws s3 ls` on it first.
>
> | Object | What | Restore |
> |---|---|---|
> | `nava-research-vps-migration-20261015.tgz` (576 MB) | `/home/orca/nava-research` (corpus, reports, overnight scripts/logs/proof, Da Vinci interview) | `tar -xzf X -C /home/orca` (paths start `nava-research/`) |
> | `claude-memory-vps-migration-20261015.tgz` (6.6 MB) | `~/.claude`: memory, main transcript, hooks, skills dir, CLAUDE.md, settings.json, eta-ledger.jsonl | `tar -xzf X -C /home/orca/.claude` (paths are relative to `~/.claude`) |
> | `nava-research-backup-<UTC>.tgz` (newest 5 kept) | Same as the research tarball, refreshed every 6 h | `tar -xzf X -C /` (paths start `home/orca/...`) |
> | `claude-backup-<UTC>.tgz` (newest 5 kept) | All `~/.claude/projects` (memory + every transcript), hooks, skills (symlink followed), CLAUDE.md, settings.json, eta-ledger.jsonl, `/home/orca/bin`, and `/home/ubuntu/projects/zero/.worktrees/ops-run.sh` | `tar -xzf X -C /` |
>
> Prefer the newest `*-backup-<UTC>.tgz`; the `*-20261015.tgz` originals are the fallback and are never auto-deleted. Restore steps: `aws s3 cp s3://.../vps-migration/<obj> /tmp/<obj>`, then the `tar` line above, then `chown -R orca:orca` on the restored `/home/orca` paths. The `~/.claude/skills` path was a symlink to `/home/orca/.agents/skills` → `/home/ubuntu/.agents/skills`; the backup holds the real files, so recreate the symlink chain or leave it as a plain dir.
>
> **3. Git gotchas on the old tree.** Two stale `index.lock` files were left: `.git/index.lock` and `.git/worktrees/centurion-dashboard-tools/index.lock`. If you restore a copy of the old checkout, delete both, then `git reset` (mixed) to refresh the index. A fresh clone avoids this. The `needs-you-scope` worktree's `apps/server-pilot/data/mastra/runtime.db` (+ `-shm`, `-wal`) was NOT pushed (local Mastra SQLite, regenerable).
>
> **4. Local tooling to recreate** (all are inside the backups; none are secrets):
>
> | Path | What |
> |---|---|
> | `/home/orca/bin/remote-typecheck.sh` | Typecheck on EC2 via SSM. Never run tsc on the VPS (`AGENTS.md`) |
> | `/home/orca/bin/vitest-full.sh` | flock wrapper: one full Vitest suite machine-wide, 1 worker, nice, 25-min cap |
> | `/home/orca/bin/vps-backup.sh` | This backup job (repo copy: `scripts/ops/vps-backup.sh`) |
> | `/home/orca/nava-research/overnight/{lane.sh,watch.sh,h1.sh,pr.sh,push-fix.sh}` | Overnight lane launcher, watcher, H1 live quote proof driver, PR squash helper (rebase onto `origin/main` first, see MISTAKES 2026-10-15), Greptile fix pusher. In the research tarball |
> | `/home/ubuntu/projects/zero/.worktrees/ops-run.sh` | Runs a server-pilot script on prod EC2 under `systemd-run` (pm2-like env) via `apps/server-pilot/deploy/ssm-run-command.sh`. Not in git; in `claude-backup-*.tgz`. Edit its hard-coded worktree path `D=` after restore |
> | `~/.claude/hooks/block-local-tsc.sh`, `codegraph-prompt-hook.sh`, `overnight-state-on-compact.sh` | Claude Code hooks wired in `settings.json` |
> | `~/.orca-cleanup/worktree-cleanup.sh` | Nightly merged-worktree cleanup cron (dry run until `~/.orca-cleanup/APPLY` exists). Not in the backups; recreate if wanted |
>
> **5. Recreate the backup cron** for user `orca` (`crontab -l` first; append, never replace):
>
> ```
> 17 */6 * * * /usr/bin/flock -n /tmp/vps-backup.lock /home/orca/bin/vps-backup.sh >>/home/orca/.vps-backup/logs/cron.log 2>&1
> ```
>
> Needs `aws` (v2, `/usr/local/bin`), `pigz`, `flock`, and AWS credentials with `s3:PutObject/ListBucket/DeleteObject` on that prefix. `mkdir -p /home/orca/.vps-backup/logs` first. One run takes ~2 min and uploads ~1 GB.
>
> **6. Deploys** still go through `apps/server-pilot/deploy/ops-deploy.sh` (SSM), never GitHub Actions. Actions minutes are for the Outlook VSTO installer only.

---

## Parked branches on origin (2026-10-15)

From `git ls-remote --heads origin 'wip/park-*' 'wip/*park*'`:

- `wip/park-agent-a0461ac0e261fbe73-20261015`
- `wip/park-recover-parse-failure-20261015`
- `wip/park-stash-0-20261015` … `wip/park-stash-9-20261015` (the 10 git stashes, one branch each)
- `wip/park-w4-u18-approve-review-local-20261015`
- `wip/park-w4-u27b-eval-export-concepts-local-20261015`
- `wip/reservationist-backtest-park-2026-10-06` (also holds the `centurion-dashboard-tools` park commit of 2026-10-15)
- `wip/w4-J-park-2026-10-10`
- `wip/main-park-2026-09-27`, `wip/piranha-park-2026-09-27` (older)

All other feature branches and worktrees were pushed under their own names.

## Backup job

`scripts/ops/vps-backup.sh` (installed at `/home/orca/bin/vps-backup.sh`) tars the research dir (minus `node_modules`, `.worktrees`) and the Claude state listed above, uploads both with `--sse AES256` as `nava-research-backup-<UTC>.tgz` and `claude-backup-<UTC>.tgz`, then deletes all but the newest 5 of each. Pruning only matches `^(nava-research|claude)-backup-YYYYMMDDTHHMMSSZ\.tgz$` under `vps-migration/`, so the 20261015 originals are safe. It is a local cron job, not CI. First verified run: `20261015T102345Z` (research 577 MB, claude 486 MB).
