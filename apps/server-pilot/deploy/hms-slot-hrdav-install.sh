#!/usr/bin/env bash
# Coordinator-only: install hms-slot@hrdav from the live hrcen env.
# Copies /etc/nava/hms-slot-hrcen.env, switches CDP port, profile dir, and
# secret id, enables the template instance, rolls back on failure.
# Never stops hms-slot@hrcen. Never pkill. Never prints env contents.
set -euo pipefail

ACTION="${1:-install}"
NAVA_ETC="${NAVA_ETC:-/etc/nava}"
HMS_SLOT_SYSTEMD_DIR="${HMS_SLOT_SYSTEMD_DIR:-/etc/systemd/system}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
SUDO="${SUDO-sudo}"
HMS_SLOT_USER="${HMS_SLOT_USER:-ubuntu}"
HRCEN_ENV="${NAVA_ETC}/hms-slot-hrcen.env"
HRDAV_ENV="${NAVA_ETC}/hms-slot-hrdav.env"
HRDAV_PREV="${NAVA_ETC}/hms-slot-hrdav.env.pre-hrdav-install"
UNIT="hms-slot@hrdav"
DAVINCI_SECRET='nava-zero/server-pilot/infor-hms-read-davinci'
HRDAV_PORT=19225
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="${SCRIPT_DIR}/hms-slot@.service"
ROLLBACK_NEEDED=0
WORK=""
WAS_ENABLED=0
WAS_ACTIVE=0

run() {
  if [ -n "$SUDO" ]; then
    # shellcheck disable=SC2086
    $SUDO "$@"
  else
    "$@"
  fi
}

fail() {
  echo "$*" >&2
  exit 1
}

restore_env() {
  if run test -f "$HRDAV_PREV"; then
    run mv -f "$HRDAV_PREV" "$HRDAV_ENV"
  else
    run rm -f "$HRDAV_ENV"
  fi
}

restore_unit() {
  if [ "$WAS_ENABLED" -eq 1 ]; then
    run "$SYSTEMCTL" enable "$UNIT"
    if [ "$WAS_ACTIVE" -eq 1 ]; then
      run "$SYSTEMCTL" restart "$UNIT"
    fi
  else
    run "$SYSTEMCTL" disable --now "$UNIT" >/dev/null 2>&1 || true
  fi
}

rollback_failure() {
  restore_env
  restore_unit
  echo "HMS_SLOT_HRDAV_ROLLBACK_OK"
}

rollback_explicit() {
  run "$SYSTEMCTL" disable --now "$UNIT" >/dev/null 2>&1 || true
  restore_env
  echo "HMS_SLOT_HRDAV_ROLLBACK_OK"
}

on_exit() {
  local rc=$?
  if [ "$ROLLBACK_NEEDED" -eq 1 ] && [ "$rc" -ne 0 ]; then
    rollback_failure || true
  fi
  [ -n "$WORK" ] && rm -rf "$WORK"
  exit "$rc"
}

rewrite_hrdav_env() {
  local src="$1" dest="$2" line saw_secret=0
  : >"$dest"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      HMS_SLOT_CDP_PORT=*)
        printf 'HMS_SLOT_CDP_PORT=%s\n' "$HRDAV_PORT"
        ;;
      HMS_SLOT_PROFILE_DIR=* | HMS_SLOT_PHASE_PATH=*)
        printf '%s\n' "${line//\/hrcen\//\/hrdav\/}"
        ;;
      HMS_READ_SECRET_ARN=*)
        saw_secret=1
        printf 'HMS_READ_SECRET_ARN=%s\n' "$DAVINCI_SECRET"
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done <"$src" >>"$dest"
  if [ "$saw_secret" -eq 0 ]; then
    printf 'HMS_READ_SECRET_ARN=%s\n' "$DAVINCI_SECRET" >>"$dest"
  fi
}

profile_dir_from_env() {
  awk -F= '$1=="HMS_SLOT_PROFILE_DIR" {print substr($0, index($0,"=")+1); exit}' "$1"
}

install_slot() {
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/hms-slot-hrdav.XXXXXX")"
  run cp -a "$HRCEN_ENV" "$WORK/hrcen.env" || fail "missing ${HRCEN_ENV}"
  grep -q '^PLAYWRIGHT_BROWSERS_PATH=.\+' "$WORK/hrcen.env" ||
    fail "PLAYWRIGHT_BROWSERS_PATH missing from ${HRCEN_ENV}"

  if run "$SYSTEMCTL" is-enabled --quiet "$UNIT"; then WAS_ENABLED=1; fi
  if run "$SYSTEMCTL" is-active --quiet "$UNIT"; then WAS_ACTIVE=1; fi

  if run test -f "$HRDAV_ENV"; then
    run cp -a "$HRDAV_ENV" "$HRDAV_PREV"
  else
    run rm -f "$HRDAV_PREV"
  fi

  ROLLBACK_NEEDED=1
  rewrite_hrdav_env "$WORK/hrcen.env" "$WORK/hrdav.env"
  run cp -a "$WORK/hrdav.env" "$HRDAV_ENV"
  run chmod 0600 "$HRDAV_ENV"

  local profile slot_dir
  profile="$(profile_dir_from_env "$WORK/hrdav.env")"
  [ -n "$profile" ] || fail "HMS_SLOT_PROFILE_DIR missing after rewrite"
  slot_dir="$(dirname "$profile")"
  run mkdir -p "$profile"
  run chmod 0700 "$slot_dir" "$profile"
  if [ -n "$SUDO" ]; then
    run chown "${HMS_SLOT_USER}:${HMS_SLOT_USER}" "$slot_dir" "$profile"
  fi

  if [ -f "$UNIT_SRC" ] && ! run test -f "${HMS_SLOT_SYSTEMD_DIR}/hms-slot@.service"; then
    run install -m 0644 "$UNIT_SRC" "${HMS_SLOT_SYSTEMD_DIR}/hms-slot@.service"
  fi

  run "$SYSTEMCTL" daemon-reload
  run "$SYSTEMCTL" enable "$UNIT"
  run "$SYSTEMCTL" restart "$UNIT"
  run "$SYSTEMCTL" is-active --quiet "$UNIT" || fail "hms-slot@hrdav failed to start"
  ROLLBACK_NEEDED=0
  echo "HMS_SLOT_HRDAV_OK"
}

case "$ACTION" in
  install)
    trap on_exit EXIT
    install_slot
    ;;
  rollback)
    rollback_explicit
    ;;
  *)
    fail "usage: $0 [install|rollback]"
    ;;
esac
