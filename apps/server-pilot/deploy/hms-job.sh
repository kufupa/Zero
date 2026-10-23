#!/usr/bin/env bash
# EC2 HMS job runner: start U0 under systemd-run (no --wait), poll a result file.
# Lock lives inside U0 (createPostgresPropertyReadLock). No shell flock.
# usage:
#   hms-job.sh start --property HRCEN|HRDAV --tool <path> --args-file <file>
#   hms-job.sh poll <id>
#   hms-job.sh result <id>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="${HMS_JOB_SERVER_PILOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
LOG_ROOT="${HMS_JOB_LOG_ROOT:-/var/log/nava/hms-jobs}"
SYSTEMCTL="${HMS_JOB_SYSTEMCTL:-systemctl}"
PROOF_REL="src/ops/hms-proof-run.ts"
WAIT_SECS="${HMS_JOB_WAIT_SECS:-1}"

usage() {
  echo "usage: $0 start --property HRCEN|HRDAV --tool <path> --args-file <file>" >&2
  echo "       $0 poll <id>" >&2
  echo "       $0 result <id>" >&2
  exit 2
}

# systemd-run under SSM needs sudo -n. No --wait: SSM stdout cap + long HMS jobs.
run_systemd() {
  if [ -n "${HMS_JOB_SYSTEMD_RUN:-}" ]; then
    "$HMS_JOB_SYSTEMD_RUN" "$@"
    return
  fi
  sudo -n systemd-run "$@"
}

safe_id() {
  [[ "$1" =~ ^[A-Za-z0-9:_-]+$ ]]
}

resolve_tool() {
  local tool="$1" abs proof allowed
  case "$tool" in
    *.mjs)
      echo "hms-job: refuse: raw .mjs (only ${PROOF_REL})" >&2
      exit 2
      ;;
    /*) abs="$tool" ;;
    *) abs="${SERVER_PILOT}/${tool#./}" ;;
  esac
  abs="$(realpath -m "$abs")"
  proof="$(realpath -m "${SERVER_PILOT}/${PROOF_REL}")"
  allowed="$(realpath -m "${SERVER_PILOT}/src/ops")"
  case "$abs" in
    "${allowed}"/*) ;;
    *)
      echo "hms-job: refuse: tool outside allowed dir (${allowed})" >&2
      exit 2
      ;;
  esac
  if [ "$abs" != "$proof" ]; then
    echo "hms-job: refuse: tool must be ${PROOF_REL}" >&2
    exit 2
  fi
  printf '%s\n' "$abs"
}

job_dir() {
  printf '%s\n' "${LOG_ROOT}/$1"
}

wait_for_earlier_jobs() {
  local id="$1" property="$2" my_seq other other_seq other_prop
  my_seq="$(cat "$(job_dir "$id")/seq")"
  while :; do
    local blocked=0
    shopt -s nullglob
    for other_seq_file in "${LOG_ROOT}"/*/seq; do
      other="$(basename "$(dirname "$other_seq_file")")"
      [ "$other" = "$id" ] && continue
      other_seq="$(cat "$other_seq_file")"
      if [ "$other_seq" -ge "$my_seq" ]; then
        continue
      fi
      other_prop="$(cat "$(job_dir "$other")/property")"
      if [ "${HMS_LOCK_SCOPE:-}" = property ] && [ "$other_prop" != "$property" ]; then
        continue
      fi
      if [ ! -f "$(job_dir "$other")/result.json" ]; then
        blocked=1
        break
      fi
    done
    shopt -u nullglob
    [ "$blocked" = 0 ] && return 0
    sleep "$WAIT_SECS"
  done
}

run_u0() {
  local property="$1" args_file="$2" out_dir="$3"
  if [ -n "${HMS_JOB_PROOF_CMD:-}" ]; then
    "$HMS_JOB_PROOF_CMD" --property "$property" --args-file "$args_file" --out "$out_dir"
    return
  fi
  # U0 fills this binary. Do not invent a second runner; never exec a raw .mjs.
  node --import tsx "${SERVER_PILOT}/${PROOF_REL}" \
    --property "$property" --args-file "$args_file" --out "$out_dir"
}

cmd_start() {
  local property="" tool="" args_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --property)
        property="${2:-}"
        shift 2
        ;;
      --tool)
        tool="${2:-}"
        shift 2
        ;;
      --args-file)
        args_file="${2:-}"
        shift 2
        ;;
      *)
        echo "hms-job: unknown start arg: $1" >&2
        usage
        ;;
    esac
  done
  [ -n "$property" ] && [ -n "$tool" ] && [ -n "$args_file" ] || usage
  case "$property" in
    HRCEN | HRDAV) ;;
    *)
      echo "hms-job: refuse: --property must be HRCEN or HRDAV" >&2
      exit 2
      ;;
  esac
  [ -f "$args_file" ] || {
    echo "hms-job: refuse: --args-file not a file: ${args_file}" >&2
    exit 2
  }
  resolve_tool "$tool" >/dev/null

  local id
  id="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || true)"
  id="${id:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
  safe_id "$id" || {
    echo "hms-job: refuse: bad job id" >&2
    exit 2
  }

  local dir log
  dir="$(job_dir "$id")"
  log="${LOG_ROOT}/${id}.log"
  mkdir -p "$dir"
  printf '%s\n' "$property" >"${dir}/property"
  printf '%s\n' "$args_file" >"${dir}/args-file"
  # GNU date %N: earlier start() wins the slot even if _run races.
  date +%s%N >"${dir}/seq"
  : >"$log"

  run_systemd \
    --uid ubuntu \
    --gid ubuntu \
    --unit "hms-job-${id}" \
    --quiet \
    -p TimeoutStopSec=30 \
    -E HOME=/home/ubuntu \
    -E "HMS_LOCK_SCOPE=${HMS_LOCK_SCOPE:-}" \
    --working-directory "$SERVER_PILOT" \
    bash "${SCRIPT_DIR}/hms-job.sh" _run "$id"

  printf '%s\n' "$id"
}

cmd_poll() {
  local id="${1:-}"
  [ -n "$id" ] && safe_id "$id" || usage
  local unit="hms-job-${id}"
  local load
  load="$("$SYSTEMCTL" show -p LoadState --value "$unit" 2>/dev/null || echo not-found)"
  if [ "$load" = "not-found" ] || [ -z "$load" ]; then
    echo "state=unknown"
    return 0
  fi
  local active result
  active="$("$SYSTEMCTL" show -p ActiveState --value "$unit" 2>/dev/null || echo inactive)"
  result="$(job_dir "$id")/result.json"
  case "$active" in
    active | activating) echo "state=running" ;;
    failed) echo "state=failed" ;;
    *)
      if [ -f "$result" ]; then
        echo "state=done"
      else
        echo "state=unknown"
        return 0
      fi
      ;;
  esac
  echo "result=${result}"
}

cmd_result() {
  local id="${1:-}"
  [ -n "$id" ] && safe_id "$id" || usage
  printf '%s\n' "$(job_dir "$id")/result.json"
}

cmd_run() {
  local id="${1:-}"
  safe_id "$id" || exit 2
  local dir log property args_file
  dir="$(job_dir "$id")"
  log="${LOG_ROOT}/${id}.log"
  property="$(cat "${dir}/property")"
  args_file="$(cat "${dir}/args-file")"
  mkdir -p "$dir"
  exec >>"$log" 2>&1
  if [ -s "${NVM_DIR:-/home/ubuntu/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1090,SC1091
    . "${NVM_DIR:-/home/ubuntu/.nvm}/nvm.sh"
    export PATH="${HOME:-/home/ubuntu}/.local/share/pnpm:${PATH}"
  fi
  cd "$SERVER_PILOT"
  if [ -f .env.production ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env.production
    set +a
  fi
  wait_for_earlier_jobs "$id" "$property"
  run_u0 "$property" "$args_file" "$dir" || true
  if [ ! -f "${dir}/result.json" ]; then
    printf '%s\n' '{"ok":false,"error":"u0_no_result"}' >"${dir}/result.json"
  fi
}

[ $# -ge 1 ] || usage
cmd="$1"
shift
case "$cmd" in
  start) cmd_start "$@" ;;
  poll) cmd_poll "$@" ;;
  result) cmd_result "$@" ;;
  _run) cmd_run "$@" ;;
  *) usage ;;
esac
