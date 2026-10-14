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
mkdir -p "$repo/.husky" "$repo/node_modules" "$worktrees" "$markers" "$fake_bin"
printf '/node_modules/\n/.husky/_/\n' > "$repo/.gitignore"
printf '#!/usr/bin/env sh\nexit 0\n' > "$repo/.husky/pre-commit"
printf 'synthetic dependency marker\n' > "$repo/node_modules/fixture.txt"

git init -q -b main "$repo"
git -C "$repo" config user.name 'Local CI test'
git -C "$repo" config user.email 'local-ci@example.invalid'
git -C "$repo" add .gitignore .husky/pre-commit
git -C "$repo" commit -qm 'test fixture'
git -C "$repo" worktree add -q -b lane-a "$worktrees/lane-a" main
git -C "$repo" worktree add -q -b lane-b "$worktrees/lane-b" main

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
[[ -x "$worktrees/lane-b/.husky/_/pre-commit" ]] || fail 'bootstrap did not install the pre-commit shim'
[[ "$(git -C "$worktrees/lane-b" config --get core.hooksPath)" == '.husky/_' ]] || fail 'bootstrap did not configure Husky hooksPath'

"$bootstrap" "$worktrees/lane-b" > "$markers/bootstrap-second.out" 2>&1 || fail 'second bootstrap failed'
[[ "$(wc -l < "$LOCAL_CI_TEST_PNPM_LOG")" -eq 1 ]] || fail 'bootstrap was not idempotent'
if grep -qi 'install' "$LOCAL_CI_TEST_PNPM_LOG"; then
  fail 'bootstrap invoked pnpm install/postinstall'
fi

printf 'PASS: local CI serializes shared-worktree runs and bootstrap is idempotent\n'
