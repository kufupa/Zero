#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  printf 'Usage: local-ci.sh <worktree> [--base <ref>] [--full] [--status]\n' >&2
}

if (($# < 1)); then
  usage
  exit 2
fi

worktree_arg=$1
shift
base_ref=origin/main
full=0
post_status=0

while (($#)); do
  case $1 in
    --base)
      if (($# < 2)); then
        usage
        exit 2
      fi
      base_ref=$2
      shift 2
      ;;
    --base=*)
      base_ref=${1#--base=}
      shift
      ;;
    --full)
      full=1
      shift
      ;;
    --status)
      post_status=1
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if ! worktree=$(git -C "$worktree_arg" rev-parse --show-toplevel 2>/dev/null); then
  printf 'local-ci: not a git worktree: %s\n' "$worktree_arg" >&2
  exit 2
fi
worktree=$(cd "$worktree" && pwd -P)

if ! common_dir=$(cd "$worktree" && git rev-parse --git-common-dir 2>/dev/null); then
  printf 'local-ci: could not resolve git common directory\n' >&2
  exit 2
fi
if [[ $common_dir != /* ]]; then
  common_dir="$worktree/$common_dir"
fi
common_dir=$(cd "$common_dir" && pwd -P)

if ! head_sha=$(git -C "$worktree" rev-parse --verify HEAD 2>/dev/null); then
  printf 'local-ci: could not resolve HEAD\n' >&2
  exit 2
fi
branch=$(git -C "$worktree" branch --show-current)
if [[ -z $branch ]]; then
  branch=detached
fi
if ! git -C "$worktree" rev-parse --verify "${base_ref}^{commit}" >/dev/null 2>&1; then
  printf 'local-ci: base ref is not a commit: %s\n' "$base_ref" >&2
  exit 2
fi

worktree_is_clean() {
  local status
  status=$(git -C "$worktree" status --porcelain --untracked-files=all 2>/dev/null) || return 1
  [[ -z $status ]]
}

if ! worktree_is_clean; then
  printf 'local-ci: worktree is not clean; refusing to test uncommitted changes\n' >&2
  exit 2
fi

safe_branch=$(printf '%s' "$branch" | sed -E 's#[^A-Za-z0-9._-]+#-#g; s#^-+|-+$##g')
if [[ -z $safe_branch ]]; then
  safe_branch=detached
fi

explicit_test_db=${LOCAL_CI_TEST_DATABASE_URL:-}
unset LOCAL_CI_TEST_DATABASE_URL DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL CONFIRM_DISPOSABLE_TEST_DB

result_dir="$common_dir/local-ci"
queue_dir="$result_dir/queue"
mkdir -p "$queue_dir"
result_json="$result_dir/${safe_branch}-${head_sha}.json"
result_text="$result_dir/${safe_branch}-${head_sha}.txt"
lock_file="$result_dir/lock"
state_file="$queue_dir/$BASHPID.state"
step_file=$(mktemp "${TMPDIR:-/tmp}/local-ci-steps.XXXXXX")
run_tmp=$(mktemp -d "${TMPDIR:-/tmp}/local-ci-run.XXXXXX")
: > "$step_file"

phase=waiting-lock
current_step=lock
started_at=$(date -u +%FT%TZ)
overall_status=PASS
step_count=0
changed_file_count=0
github_status=not-requested
changed_files=()
step_log_index=0

write_state() {
  local temporary_file="${state_file}.tmp.$BASHPID"
  printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0' \
    "$BASHPID" "$phase" "$current_step" "$branch" "$head_sha" "$worktree" "$started_at" \
    > "$temporary_file"
  mv -f -- "$temporary_file" "$state_file"
}

cleanup() {
  rm -f -- "$state_file" "${state_file}.tmp.$BASHPID" "$step_file"
  rm -rf -- "$run_tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

record_step() {
  local name=$1
  local status=$2
  local exit_code=$3
  local duration=$4
  local detail=${5:-}
  printf '%s\0%s\0%s\0%s\0%s\0' \
    "$name" "$status" "$exit_code" "$duration" "$detail" >> "$step_file"
  step_count=$((step_count + 1))
  if [[ $status == FAIL ]]; then
    overall_status=FAIL
  fi
}

run_step() {
  local name=$1
  shift
  local output_file="$run_tmp/step-${step_log_index}.log"
  local start_time
  local end_time
  local duration
  local exit_code
  local status
  step_log_index=$((step_log_index + 1))
  phase=running
  current_step=$name
  write_state
  start_time=$(date +%s)
  if "$@" > "$output_file" 2>&1; then
    exit_code=0
    status=PASS
  else
    exit_code=$?
    status=FAIL
  fi
  end_time=$(date +%s)
  duration=$((end_time - start_time))
  if [[ $status == PASS ]]; then
    record_step "$name" "$status" "$exit_code" "$duration"
  else
    record_step "$name" "$status" "$exit_code" "$duration" 'command output suppressed; rerun locally for details'
  fi
}

skip_step() {
  record_step "$1" SKIP 0 0 "$2"
}

write_result_files() {
  local final_status=$overall_status
  local final_status_post=$github_status
  phase=running
  current_step='result files'
  write_state
  LOCAL_CI_RESULT_JSON=$result_json \
    LOCAL_CI_RESULT_TEXT=$result_text \
    LOCAL_CI_STEP_FILE=$step_file \
    LOCAL_CI_STATUS=$final_status \
    LOCAL_CI_STATUS_POST=$final_status_post \
    LOCAL_CI_BRANCH=$branch \
    LOCAL_CI_SHA=$head_sha \
    LOCAL_CI_BASE=$base_ref \
    LOCAL_CI_WORKTREE=$worktree \
    LOCAL_CI_FULL=$full \
    LOCAL_CI_DRY="${LOCAL_CI_DRY:-0}" \
    LOCAL_CI_CHANGED_FILE_COUNT=$changed_file_count \
    LOCAL_CI_STARTED_AT=$started_at \
    node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const fields = fs.readFileSync(process.env.LOCAL_CI_STEP_FILE).toString().split('\0');
const steps = [];
for (let index = 0; index + 4 < fields.length; index += 5) {
  const [name, status, exitCode, durationSeconds, detail] = fields.slice(index, index + 5);
  if (!name) continue;
  steps.push({
    name,
    status,
    exitCode: Number(exitCode),
    durationSeconds: Number(durationSeconds),
    ...(detail ? { detail } : {}),
  });
}

const result = {
  generatedAt: new Date().toISOString(),
  startedAt: process.env.LOCAL_CI_STARTED_AT,
  status: process.env.LOCAL_CI_STATUS,
  branch: process.env.LOCAL_CI_BRANCH,
  sha: process.env.LOCAL_CI_SHA,
  base: process.env.LOCAL_CI_BASE,
  worktree: process.env.LOCAL_CI_WORKTREE,
  full: process.env.LOCAL_CI_FULL === '1',
  dry: process.env.LOCAL_CI_DRY === '1',
  changedFileCount: Number(process.env.LOCAL_CI_CHANGED_FILE_COUNT),
  githubStatus: process.env.LOCAL_CI_STATUS_POST,
  steps,
};

function writeAtomic(target, contents) {
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

const summary = [
  `local-ci ${result.status} ${result.branch}@${result.sha.slice(0, 12)}`,
  `base: ${result.base}`,
  `worktree: ${result.worktree}`,
  `changed files: ${result.changedFileCount}`,
  `full: ${result.full ? 'yes' : 'no'}; dry: ${result.dry ? 'yes' : 'no'}`,
  `GitHub status: ${result.githubStatus}`,
  ...steps.map((step) =>
    `${step.status} ${step.name} (${step.durationSeconds}s)` + (step.detail ? ` — ${step.detail}` : ''),
  ),
].join('\n') + '\n';

writeAtomic(process.env.LOCAL_CI_RESULT_JSON, `${JSON.stringify(result, null, 2)}\n`);
writeAtomic(process.env.LOCAL_CI_RESULT_TEXT, summary);
NODE
}

run_changed_checks() {
  local shared_changed=0
  local mail_affected=0
  local server_affected=0
  local file
  local -a lint_files=()
  local -a affected_apps=()

  mapfile -d '' -t changed_files < <(
    {
      git diff --name-only -z "$base_ref"
      git ls-files --others --exclude-standard -z
    } | sort -zu
  )
  changed_file_count=${#changed_files[@]}

  for file in "${changed_files[@]}"; do
    case $file in
      apps/mail/*) mail_affected=1 ;;
      apps/server-pilot/*) server_affected=1 ;;
      packages/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|turbo.json|tsconfig.json|vitest.config.*|.npmrc)
        shared_changed=1
        ;;
    esac
    case $file in
      *.cjs|*.cts|*.js|*.jsx|*.mjs|*.mts|*.ts|*.tsx)
        if [[ $file != external/* && -f $file ]]; then
          lint_files+=("$file")
        fi
        ;;
    esac
  done

  if ((shared_changed)); then
    mail_affected=1
    server_affected=1
  fi

  run_step 'entity guard' node apps/server-pilot/scripts/check-entity-literals.mjs

  if ((${#lint_files[@]})); then
    run_step 'oxlint changed files' "$worktree/apps/mail/node_modules/.bin/oxlint" \
      --deny-warnings --ignore-pattern 'external/**' "${lint_files[@]}"
  else
    skip_step 'oxlint changed files' 'no changed JavaScript or TypeScript files'
  fi

  if ((mail_affected)); then
    affected_apps+=(mail)
  fi
  if ((server_affected)); then
    affected_apps+=(server-pilot)
  fi
  if ((${#affected_apps[@]})); then
    for file in "${affected_apps[@]}"; do
      if [[ $file == server-pilot ]]; then
        run_step "vitest apps/$file --changed=$base_ref" \
          pnpm --dir "apps/$file" exec vitest run "--changed=$base_ref" --maxWorkers=2 --configLoader runner
      else
        run_step "vitest apps/$file --changed=$base_ref" \
          pnpm --dir "apps/$file" exec vitest run "--changed=$base_ref" --maxWorkers=2
      fi
    done
  else
    skip_step 'vitest --changed' 'no affected mail or server-pilot app'
  fi
}

wait_for_memory() {
  local minimum_kb=$((8 * 1024 * 1024))
  local available_kb
  local start_time
  local end_time
  if [[ ! -r /proc/meminfo ]]; then
    record_step 'memory gate' FAIL 1 0 '/proc/meminfo unavailable'
    return 1
  fi
  start_time=$(date +%s)
  phase=waiting-memory
  while true; do
    available_kb=$(awk '$1 == "MemAvailable:" { print $2; exit }' /proc/meminfo)
    if [[ ! $available_kb =~ ^[0-9]+$ ]]; then
      record_step 'memory gate' FAIL 1 0 'MemAvailable could not be read'
      return 1
    fi
    if ((available_kb >= minimum_kb)); then
      end_time=$(date +%s)
      record_step 'memory gate' PASS 0 "$((end_time - start_time))" 'MemAvailable >= 8 GiB'
      return 0
    fi
    current_step="waiting for MemAvailable >= 8 GiB (currently ${available_kb} KiB)"
    write_state
    sleep 15
  done
}

is_explicit_local_database() {
  LOCAL_CI_CHECK_DATABASE_URL=$1 node -e '
    try {
      const database = new URL(process.env.LOCAL_CI_CHECK_DATABASE_URL);
      process.exit(
        ["postgres:", "postgresql:"].includes(database.protocol) &&
        database.hostname === "127.0.0.1" && database.port === "55601" ? 0 : 1,
      );
    } catch {
      process.exit(1);
    }
  ' >/dev/null 2>&1
}

run_database_step() {
  local name=$1
  shift
  TEST_DATABASE_URL="$explicit_test_db" \
    CONFIRM_DISPOSABLE_TEST_DB=1 \
    PORT=8799 \
    BETTER_AUTH_URL=http://127.0.0.1:8799 \
    BETTER_AUTH_SECRET=local-ci-only-dummy-secret-not-for-production \
    AWS_REGION=af-south-1 \
    S3_BUCKET=nava-test-bucket \
    run_step "$name" "$@"
}

run_full_checks() {
  local mail_node_options
  if (( ! full )); then
    skip_step 'full typechecks' '--full not requested'
    skip_step 'database suites' '--full not requested'
    return
  fi

  run_step 'server-pilot typecheck' pnpm --dir apps/server-pilot run build
  mail_node_options="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=7168"
  if node -e 'process.exit(require("./apps/mail/package.json").scripts?.typecheck ? 0 : 1)' >/dev/null 2>&1; then
    run_step 'mail typecheck' env NODE_OPTIONS="$mail_node_options" pnpm --dir apps/mail run typecheck
  else
    run_step 'mail typecheck' env NODE_OPTIONS="$mail_node_options" \
      pnpm --dir apps/mail exec tsc --noEmit -p tsconfig.json
  fi

  if [[ -z $explicit_test_db ]]; then
    skip_step 'database suites' 'set LOCAL_CI_TEST_DATABASE_URL to opt in'
    return
  fi
  if ! is_explicit_local_database "$explicit_test_db"; then
    record_step 'database configuration' FAIL 1 0 'must be PostgreSQL on 127.0.0.1:55601'
    skip_step 'database suites' 'invalid local database configuration'
    return
  fi

  run_database_step 'server-pilot ingestion DB suite' \
    pnpm --dir apps/server-pilot run test:ingestion -- --configLoader runner
  run_database_step 'server-pilot outlook-sync DB suite' \
    pnpm --dir apps/server-pilot run test:outlook-sync
}

post_github_status() {
  local current_sha
  local gh_state
  local description
  if (( ! post_status )); then
    return
  fi
  if [[ ${LOCAL_CI_DRY:-0} == 1 ]]; then
    github_status=skipped-dry
    return
  fi
  current_sha=$(git -C "$worktree" rev-parse --verify HEAD 2>/dev/null || true)
  if [[ $current_sha != "$head_sha" ]]; then
    github_status=skipped-head-changed
    return
  fi
  if ! worktree_is_clean; then
    github_status=skipped-worktree-changed
    return
  fi
  if ! command -v gh >/dev/null 2>&1; then
    github_status=failed
    record_step 'GitHub status' FAIL 127 0 'gh CLI unavailable'
    return
  fi
  gh_state=success
  if [[ $overall_status == FAIL ]]; then
    gh_state=failure
  fi
  description="local-ci $overall_status"
  phase=running
  current_step='GitHub status'
  write_state
  if gh api --method POST "repos/{owner}/{repo}/statuses/$head_sha" \
    -f "state=$gh_state" \
    -f context=local-ci/presubmit \
    -f "description=$description" > "$run_tmp/github-status.log" 2>&1; then
    github_status=posted
  else
    local exit_code=$?
    github_status=failed
    record_step 'GitHub status' FAIL "$exit_code" 0 'gh api request failed'
  fi
}

exec {lock_fd}>>"$lock_file"
write_state
while true; do
  if flock --exclusive --nonblock "$lock_fd"; then
    break
  else
    lock_result=$?
    if ((lock_result != 1)); then
      printf 'local-ci: flock failed with exit code %s\n' "$lock_result" >&2
      exit 1
    fi
  fi
  phase=waiting-lock
  current_step=lock
  write_state
  sleep 0.25
done

phase=waiting-memory
current_step='memory gate'
write_state
cd "$worktree"

if [[ ${LOCAL_CI_DRY:-0} == 1 ]]; then
  skip_step 'memory gate' 'dry mode'
  if [[ $(git rev-parse --verify HEAD) != "$head_sha" ]]; then
    record_step 'head check' FAIL 1 0 'HEAD changed while waiting for the shared lock'
  else
    record_step 'head check' PASS 0 0
  fi
  if [[ -n ${LOCAL_CI_DRY_COMMAND:-} ]]; then
    run_step 'dry command' bash -c "$LOCAL_CI_DRY_COMMAND"
  else
    run_step 'dry command' true
  fi
else
  if wait_for_memory; then
    if [[ $(git rev-parse --verify HEAD) != "$head_sha" ]]; then
      record_step 'head check' FAIL 1 0 'HEAD changed while waiting for the shared lock'
      skip_step 'changed-file checks' 'HEAD changed while waiting for the shared lock'
      if ((full)); then
        skip_step 'full checks' 'HEAD changed while waiting for the shared lock'
      fi
    else
      record_step 'head check' PASS 0 0
      run_changed_checks
      run_full_checks
    fi
  fi
fi

post_github_status
write_result_files
printf 'local-ci %s %s@%.12s (%s steps)\n' \
  "$overall_status" "$branch" "$head_sha" "$step_count"
if [[ $overall_status == FAIL ]]; then
  exit 1
fi
