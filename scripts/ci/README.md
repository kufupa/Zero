# Local CI and worktree bootstrap

This is local-only tooling. It does not add or invoke GitHub Actions.

```bash
scripts/ci/local-ci.sh <worktree> [--base origin/main] [--full] [--status]
scripts/ci/queue-status.sh [worktree]
scripts/ci/worktree-bootstrap.sh <worktree>
```

`local-ci.sh` serializes runs through one `flock` in the repository's Git common directory. It waits for at least 8 GiB `MemAvailable`, then runs the entity guard, Oxlint on changed JavaScript/TypeScript files, and `vitest --changed=<base> --maxWorkers=2` for affected `apps/mail` and/or `apps/server-pilot`. Shared package or root test configuration changes mark both apps affected. The queue command shows the holder, waiters, current step, branch, and worktree.

Each run writes a machine-readable result and a text summary under `<git-common-dir>/local-ci/`, named `<branch>-<sha>.json` and `<branch>-<sha>.txt`. Command output is kept out of those reports; failures record the step and exit code, so rerun the failed command locally for detailed diagnostics. The command prints one final `local-ci PASS` or `local-ci FAIL` line.

`--full` adds the server-pilot build/typecheck and mail typecheck. If a mail `typecheck` script exists, the runner uses it with a 7 GiB Node heap cap; otherwise it uses `pnpm --dir apps/mail exec tsc --noEmit -p tsconfig.json` with the same cap. Server-pilot changed tests use Vitest's `--configLoader runner` option. Database gates run only in full mode when `LOCAL_CI_TEST_DATABASE_URL` is explicitly set to the disposable PostgreSQL endpoint on `127.0.0.1:55601`. The runner clears inherited `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, `TEST_DATABASE_URL`, and disposable-DB confirmation first; it sets `TEST_DATABASE_URL`, `CONFIRM_DISPOSABLE_TEST_DB=1`, and the handoff's test-only server environment only while running the existing ingestion and Outlook-sync DB gates, one at a time. No DB URL or test secret is written to reports or printed.

The runner requires a clean worktree before checks. `--status` posts `local-ci/presubmit` with `gh api` only if the tested HEAD SHA is still current and the worktree remains clean. `LOCAL_CI_DRY=1` skips memory gating, all real checks, and GitHub calls, but still exercises the shared lock and writes result reports. Tests can supply `LOCAL_CI_DRY_COMMAND` as a shell snippet to assert queue behavior; use only synthetic commands and fixtures.

`worktree-bootstrap.sh` links the main checkout's root `node_modules` and copies each existing package (`apps/*`, `packages/*`) dependency-link tree into a worktree when absent. This keeps relative workspace links pointed into the target worktree while root/store dependencies remain shared. It replaces older direct app/package links to the main checkout, then runs `pnpm exec husky` if the worktree lacks a working `.husky/_/pre-commit` shim. It never runs `pnpm install` or postinstall; a branch that adds a dependency still needs that dependency installed in the main checkout.

Run the targeted plain-bash test with:

```bash
bash scripts/ci/tests/local-ci.test.sh
for script in scripts/ci/*.sh scripts/ci/tests/*.sh; do
  bash -n "$script" || exit 1
done
shellcheck scripts/ci/*.sh scripts/ci/tests/*.sh
```
