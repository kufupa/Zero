#!/usr/bin/env bash
set -Eeuo pipefail

ci_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
local_ci="$ci_dir/local-ci.sh"
queue_status="$ci_dir/queue-status.sh"
bootstrap="$ci_dir/worktree-bootstrap.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

for script in "$local_ci" "$queue_status" "$bootstrap"; do
  [[ -x "$script" ]] || fail "expected executable script: $script"
done

test_root=$(mktemp -d)
background_pids=()

cleanup() {
  local exit_code=$?
  trap - EXIT
  for pid in "${background_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${background_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$test_root"
  exit "$exit_code"
}
trap cleanup EXIT

repo="$test_root/repo"
worktrees="$test_root/worktrees"
markers="$test_root/markers"
fake_bin="$test_root/fake-bin"
mkdir -p "$repo/.husky" "$repo/node_modules" "$repo/apps/mail" \
  "$repo/apps/server-pilot/scripts" "$repo/packages/shared" "$worktrees" "$markers" "$fake_bin"
printf 'node_modules\n/.husky/_/\n' > "$repo/.gitignore"
printf '#!/usr/bin/env sh\nexit 0\n' > "$repo/.husky/pre-commit"
printf 'synthetic dependency marker\n' > "$repo/node_modules/fixture.txt"
printf '{"name":"@fixture/mail"}\n' > "$repo/apps/mail/package.json"
printf '{"name":"@fixture/shared"}\n' > "$repo/packages/shared/package.json"
printf 'process.exit(0);\n' > "$repo/apps/server-pilot/scripts/check-entity-literals.mjs"

git init -q -b main "$repo"
git -C "$repo" config user.name 'Local CI test'
git -C "$repo" config user.email 'local-ci@example.invalid'
git -C "$repo" add .gitignore .husky/pre-commit apps/mail/package.json \
  apps/server-pilot/scripts/check-entity-literals.mjs packages/shared/package.json
git -C "$repo" commit -qm 'test fixture'
git -C "$repo" worktree add -q -b lane-a "$worktrees/lane-a" main
git -C "$repo" worktree add -q -b lane-b "$worktrees/lane-b" main

mkdir -p "$repo/apps/mail/node_modules/.bin" "$repo/apps/mail/node_modules/@fixture" \
  "$repo/packages/shared/node_modules/@fixture"
printf 'synthetic mail dependency marker\n' > "$repo/apps/mail/node_modules/fixture.txt"
printf 'synthetic shared dependency marker\n' > "$repo/packages/shared/node_modules/fixture.txt"
ln -s ../../../../packages/shared "$repo/apps/mail/node_modules/@fixture/shared"
ln -s ../../../../apps/mail "$repo/packages/shared/node_modules/@fixture/mail"
cat > "$repo/apps/mail/node_modules/.bin/oxlint" <<'OXLINT_STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$PWD" > "${LOCAL_CI_TEST_OXLINT_PWD:?}"
printf '%s\n' "$@" > "${LOCAL_CI_TEST_OXLINT_ARGS:?}"
OXLINT_STUB
chmod +x "$repo/apps/mail/node_modules/.bin/oxlint"
ln -s "$repo/apps/mail/node_modules" "$worktrees/lane-b/apps/mail/node_modules"
ln -s "$repo/packages/shared/node_modules" "$worktrees/lane-b/packages/shared/node_modules"

cat > "$fake_bin/awk" <<'AWK_STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $* == *MemAvailable:* ]]; then
  printf '9000000\n'
  exit 0
fi
exec /usr/bin/awk "$@"
AWK_STUB
chmod +x "$fake_bin/awk"

cat > "$fake_bin/gh" <<'GH_STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
touch "${LOCAL_CI_DRY_GH_CALLED:?}"
GH_STUB
chmod +x "$fake_bin/gh"

export PATH="$fake_bin:$PATH"
export LOCAL_CI_DRY=1
export LOCAL_CI_DRY_MARKERS="$markers"
export LOCAL_CI_DRY_ACTIVE="$markers/active"
export LOCAL_CI_DRY_EVENTS="$markers/events"
export LOCAL_CI_DRY_OVERLAP="$markers/overlap"
export LOCAL_CI_DRY_GH_CALLED="$markers/gh-called"
export LOCAL_CI_DRY_COMMAND='set -eu
if [[ -n "${DATABASE_URL:-}" || -n "${VITEST_ALLOW_PILOT_RDS:-}" || -n "${TEST_DATABASE_URL:-}" ]]; then
  touch "$LOCAL_CI_DRY_MARKERS/unsafe-db-env"
  exit 97
fi
if ! mkdir "$LOCAL_CI_DRY_ACTIVE"; then
  touch "$LOCAL_CI_DRY_OVERLAP"
  exit 98
fi
printf "%s:start\n" "$LOCAL_CI_DRY_ID" >> "$LOCAL_CI_DRY_EVENTS"
touch "$LOCAL_CI_DRY_MARKERS/$LOCAL_CI_DRY_ID.started"
sleep "$LOCAL_CI_DRY_SLEEP_SECONDS"
printf "%s:end\n" "$LOCAL_CI_DRY_ID" >> "$LOCAL_CI_DRY_EVENTS"
touch "$LOCAL_CI_DRY_MARKERS/$LOCAL_CI_DRY_ID.finished"
rmdir "$LOCAL_CI_DRY_ACTIVE"'

DATABASE_URL=synthetic \
VITEST_ALLOW_PILOT_RDS=1 \
TEST_DATABASE_URL=synthetic \
LOCAL_CI_DRY_ID=first \
LOCAL_CI_DRY_SLEEP_SECONDS=3 \
"$local_ci" "$worktrees/lane-a" --base main --status > "$markers/first.out" 2>&1 &
first_pid=$!
background_pids+=("$first_pid")

attempt=0
while ((attempt < 120)); do
  [[ -e "$markers/first.started" ]] && break
  attempt=$((attempt + 1))
  sleep 0.05
done
[[ -e "$markers/first.started" ]] || fail 'first dry command did not start'

LOCAL_CI_DRY_ID=second \
LOCAL_CI_DRY_SLEEP_SECONDS=0.1 \
"$local_ci" "$worktrees/lane-b" --base main --status > "$markers/second.out" 2>&1 &
second_pid=$!
background_pids+=("$second_pid")

queue_output=''
attempt=0
while ((attempt < 120)); do
  queue_output=$("$queue_status" "$worktrees/lane-a")
  [[ "$queue_output" == *"WAITING pid=$second_pid"* ]] && break
  attempt=$((attempt + 1))
  sleep 0.05
done
[[ "$queue_output" == *"WAITING pid=$second_pid"* ]] || fail 'queue status did not report the second run waiting'
[[ ! -e "$markers/second.started" ]] || fail 'second dummy command ran before lock became available'

wait "$first_pid" || fail 'first local-ci dry run failed'
wait "$second_pid" || fail 'second local-ci dry run failed'
background_pids=()

[[ ! -e "$markers/overlap" ]] || fail 'dummy commands overlapped despite shared lock'
[[ ! -e "$markers/unsafe-db-env" ]] || fail 'pilot/test database environment reached dry command'
[[ ! -e "$markers/gh-called" ]] || fail 'dry run posted a GitHub status'

expected_events=$(printf 'first:start\nfirst:end\nsecond:start\nsecond:end')
actual_events=$(<"$markers/events")
[[ "$actual_events" == "$expected_events" ]] || fail 'dummy commands did not execute serially'

[[ "$(wc -l < "$markers/first.out")" -eq 1 ]] || fail 'first run did not print exactly one summary line'
[[ "$(wc -l < "$markers/second.out")" -eq 1 ]] || fail 'second run did not print exactly one summary line'
grep -q '^local-ci PASS ' "$markers/first.out" || fail 'first run summary was not PASS'
grep -q '^local-ci PASS ' "$markers/second.out" || fail 'second run summary was not PASS'

json_results=("$repo/.git/local-ci"/*.json)
[[ "${#json_results[@]}" -eq 2 ]] || fail 'expected one common-dir result per branch'
for result in "${json_results[@]}"; do
  node -e 'const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (result.status !== "PASS") process.exit(1);' "$result" || fail "invalid or failing JSON result: $result"
  text_result=${result%.json}.txt
  [[ -s "$text_result" ]] || fail "missing text result: $text_result"
done

cat > "$fake_bin/pnpm" <<'PNPM_STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\t%s\n' "$PWD" "$*" >> "${LOCAL_CI_TEST_PNPM_LOG:?}"
[[ "$#" -eq 2 && "$1" == exec && "$2" == husky ]] || exit 91
git config core.hooksPath .husky/_
mkdir -p .husky/_
printf '#!/usr/bin/env sh\nexit 0\n' > .husky/_/pre-commit
chmod +x .husky/_/pre-commit
PNPM_STUB
chmod +x "$fake_bin/pnpm"
export LOCAL_CI_TEST_PNPM_LOG="$test_root/pnpm.log"

"$bootstrap" "$worktrees/lane-b" > "$markers/bootstrap.out" 2>&1 || fail 'worktree bootstrap failed'
[[ -L "$worktrees/lane-b/node_modules" ]] || fail 'bootstrap did not link node_modules'
[[ "$(readlink "$worktrees/lane-b/node_modules")" == "$repo/node_modules" ]] || fail 'node_modules link points to wrong checkout'
app_workspace_target=$(readlink -f "$worktrees/lane-b/apps/mail/node_modules/@fixture/shared")
[[ $app_workspace_target == "$worktrees/lane-b/packages/shared" ]] || \
  fail 'app workspace dependency resolves to the main checkout'
package_workspace_target=$(readlink -f "$worktrees/lane-b/packages/shared/node_modules/@fixture/mail")
[[ $package_workspace_target == "$worktrees/lane-b/apps/mail" ]] || \
  fail 'package workspace dependency resolves to the main checkout'
app_node_modules="$worktrees/lane-b/apps/mail/node_modules"
package_node_modules="$worktrees/lane-b/packages/shared/node_modules"
[[ -d $app_node_modules && ! -L $app_node_modules ]] || \
  fail 'bootstrap did not create worktree-local app node_modules'
[[ -d $package_node_modules && ! -L $package_node_modules ]] || \
  fail 'bootstrap did not create worktree-local package node_modules'
[[ -x "$worktrees/lane-b/.husky/_/pre-commit" ]] || fail 'bootstrap did not install the pre-commit shim'
[[ "$(git -C "$worktrees/lane-b" config --get core.hooksPath)" == '.husky/_' ]] || fail 'bootstrap did not configure Husky hooksPath'

"$bootstrap" "$worktrees/lane-b" > "$markers/bootstrap-second.out" 2>&1 || fail 'second bootstrap failed'
[[ "$(wc -l < "$LOCAL_CI_TEST_PNPM_LOG")" -eq 1 ]] || fail 'bootstrap was not idempotent'
if grep -qi 'install' "$LOCAL_CI_TEST_PNPM_LOG"; then
  fail 'bootstrap invoked pnpm install/postinstall'
fi

printf 'export {};\n' > "$worktrees/lane-b/apps/mail/local-ci-test.ts"
git -C "$worktrees/lane-b" add apps/mail/local-ci-test.ts
git -C "$worktrees/lane-b" commit -qm 'fixture mail change'

cat > "$fake_bin/pnpm" <<'PNPM_CHECK_STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\t%s\n' "$PWD" "$*" >> "${LOCAL_CI_TEST_PNPM_LOG:?}"
if [[ ${1:-} == exec && ${2:-} == oxlint ]]; then
  if [[ -x $PWD/node_modules/.bin/oxlint ]]; then
    "$PWD/node_modules/.bin/oxlint" "${@:3}"
  else
    printf 'oxlint executable missing from root node_modules\n' >&2
    exit 127
  fi
fi
if [[ ${1:-} == --dir && ${2:-} == apps/mail && ${3:-} == exec && ${4:-} == vitest ]]; then
  if [[ -n ${LOCAL_CI_TEST_VITEST_READY:-} ]]; then
    touch "$LOCAL_CI_TEST_VITEST_READY"
    while [[ ! -e ${LOCAL_CI_TEST_VITEST_RELEASE:?} ]]; do sleep 0.05; done
  fi
  exit 0
fi
printf 'unexpected pnpm invocation: %s\n' "$*" >&2
exit 91
PNPM_CHECK_STUB
chmod +x "$fake_bin/pnpm"

export LOCAL_CI_DRY=0
export LOCAL_CI_TEST_PNPM_LOG="$markers/pnpm-check.log"
export LOCAL_CI_TEST_OXLINT_PWD="$markers/oxlint-pwd"
export LOCAL_CI_TEST_OXLINT_ARGS="$markers/oxlint-args"
lint_run_exit=0
"$local_ci" "$worktrees/lane-b" --base main > "$markers/lint-run.out" 2>&1 || lint_run_exit=$?
lint_result="$repo/.git/local-ci/lane-b-$(git -C "$worktrees/lane-b" rev-parse --verify HEAD).json"
node -e '
  const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const step = result.steps.find(({ name }) => name === "oxlint changed files");
  if (!step || step.status !== "PASS") {
    console.error(`Oxlint step was ${step?.status ?? "missing"} (exit ${step?.exitCode ?? "n/a"})`);
    process.exit(1);
  }
' "$lint_result" || fail 'local CI could not run Oxlint from the mail app install'
if [[ $lint_run_exit -ne 0 ]]; then
  node -e '
    const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const step of result.steps.filter(({ status }) => status === "FAIL")) {
      console.error(`Failed step: ${step.name} (exit ${step.exitCode})`);
    }
  ' "$lint_result"
  fail 'local CI failed after Oxlint passed'
fi
[[ -e "$markers/oxlint-pwd" ]] || fail 'local CI did not run the app-local Oxlint executable'
oxlint_cwd=$(<"$markers/oxlint-pwd")
[[ $oxlint_cwd == "$worktrees/lane-b" ]] || fail 'Oxlint ran outside the worktree root'
grep -Fxq 'apps/mail/local-ci-test.ts' "$markers/oxlint-args" || fail 'Oxlint did not receive the changed file path'
grep -q '^local-ci PASS ' "$markers/lint-run.out" || \
  fail 'local CI did not report PASS with the app-local Oxlint executable'

rm -f "$LOCAL_CI_DRY_GH_CALLED"
status_ready="$markers/status-vitest-ready"
status_release="$markers/status-vitest-release"
LOCAL_CI_TEST_VITEST_READY="$status_ready" \
LOCAL_CI_TEST_VITEST_RELEASE="$status_release" \
  "$local_ci" "$worktrees/lane-b" --base main --status > "$markers/status-run.out" 2>&1 &
status_pid=$!
background_pids+=("$status_pid")

attempt=0
while ((attempt < 120)); do
  [[ -e "$status_ready" ]] && break
  attempt=$((attempt + 1))
  sleep 0.05
done
[[ -e "$status_ready" ]] || fail 'status run did not reach its Vitest step'
printf '// changed while local CI was running\n' >> "$worktrees/lane-b/apps/mail/local-ci-test.ts"
touch "$status_release"

status_run_exit=0
wait "$status_pid" || status_run_exit=$?
background_pids=()
[[ $status_run_exit -eq 0 ]] || fail 'status run failed before posting its result'
grep -q '^local-ci PASS ' "$markers/status-run.out" || fail 'status run did not report PASS'
status_sha=$(git -C "$worktrees/lane-b" rev-parse --verify HEAD)
status_result="$repo/.git/local-ci/lane-b-$status_sha.json"
node -e '
  const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (result.githubStatus !== "skipped-worktree-changed") {
    console.error(`GitHub status was ${result.githubStatus}, expected skipped-worktree-changed`);
    process.exit(1);
  }
' "$status_result" || fail 'local CI posted a status for a changed worktree'
[[ ! -e "$LOCAL_CI_DRY_GH_CALLED" ]] || fail 'local CI called gh after its worktree changed'

dirty_run_exit=0
"$local_ci" "$worktrees/lane-b" --base main --status \
  > "$markers/dirty-run.out" 2>&1 || dirty_run_exit=$?
[[ $dirty_run_exit -eq 2 ]] || fail 'local CI did not reject a dirty worktree before testing'
grep -q 'worktree is not clean' "$markers/dirty-run.out" || fail 'dirty-worktree rejection was not explained'
[[ ! -e "$LOCAL_CI_DRY_GH_CALLED" ]] || fail 'local CI posted a status for a dirty worktree'

queue_dir="$repo/.git/local-ci/queue"
mkdir -p "$queue_dir"
vanished_state="$queue_dir/a-vanishing.state"
remaining_state="$queue_dir/b-remaining.state"
printf '%s\0' \
  '123' 'running' 'first-step' 'first-branch' 'deadbeef' '/tmp/first' 'started' \
  > "$vanished_state"
printf '%s\0' \
  '123' 'running' 'remaining-step' 'remaining-branch' 'deadbeef' '/tmp/remaining' 'started' \
  > "$remaining_state"
cat > "$markers/remove-state-before-mapfile.sh" <<'RACE_HOOK'
remove_queue_state_before_read() {
  if [[ ${BASH_COMMAND:-} == mapfile* && -n ${QUEUE_STATUS_RACE_FILE:-} ]]; then
    rm -f -- "$QUEUE_STATUS_RACE_FILE"
    unset QUEUE_STATUS_RACE_FILE
    trap - DEBUG
  fi
}
trap remove_queue_state_before_read DEBUG
RACE_HOOK
if queue_output=$(
  QUEUE_STATUS_RACE_FILE="$vanished_state" \
    BASH_ENV="$markers/remove-state-before-mapfile.sh" \
    "$queue_status" "$worktrees/lane-b" 2> "$markers/queue-status.err"
); then
  :
else
  sed -n '1,20p' "$markers/queue-status.err" >&2
  fail 'queue status failed when a state file vanished before read'
fi
[[ ! -e "$vanished_state" ]] || fail 'queue race test did not remove the listed state file'
if [[ $queue_output != *'branch=remaining-branch'* ]]; then
  fail 'queue status omitted the remaining run after a state file vanished'
fi
if [[ $queue_output != *'step=remaining-step'* ]]; then
  fail 'queue status omitted the remaining run step'
fi

printf 'PASS: local CI queue, worktree links, app lint, and status attribution\n'
