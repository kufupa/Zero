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
HRCEN_ENV="${NAVA_ETC}/hms-slot-hrcen.env"
HRDAV_ENV="${NAVA_ETC}/hms-slot-hrdav.env"
HRDAV_PREV="${NAVA_ETC}/hms-slot-hrdav.env.pre-hrdav-install"
UNIT="hms-slot@hrdav"
DAVINCI_SECRET='nava-zero/server-pilot/infor-hms-read-davinci'
HRDAV_PORT=19225
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="${SCRIPT_DIR}/hms-slot@.service"
ROLLBACK_NEEDED=0

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

rollback() {
  "$SYSTEMCTL" disable --now "$UNIT" >/dev/null 2>&1 || true
  if [ -f "$HRDAV_PREV" ]; then
    run mv -f "$HRDAV_PREV" "$HRDAV_ENV"
  else
    run rm -f "$HRDAV_ENV"
  fi
  echo "HMS_SLOT_HRDAV_ROLLBACK_OK"
}

on_exit() {
  local rc=$?
  if [ "$ROLLBACK_NEEDED" -eq 1 ] && [ "$rc" -ne 0 ]; then
    rollback || true
  fi
  exit "$rc"
}

rewrite_hrdav_env() {
  local src="$1" dest="$2" tmp line
  tmp="$(mktemp "${NAVA_ETC}/.hms-slot-hrdav.env.XXXXXX")"
  local saw_secret=0
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
  done <"$src" >"$tmp"
  if [ "$saw_secret" -eq 0 ]; then
    printf 'HMS_READ_SECRET_ARN=%s\n' "$DAVINCI_SECRET" >>"$tmp"
  fi
  run mv -f "$tmp" "$dest"
  run chmod 0600 "$dest"
}

profile_dir_from_env() {
  awk -F= '$1=="HMS_SLOT_PROFILE_DIR" {print substr($0, index($0,"=")+1); exit}' "$1"
}

install_slot() {
  [ -f "$HRCEN_ENV" ] || fail "missing ${HRCEN_ENV}"
  grep -q '^PLAYWRIGHT_BROWSERS_PATH=.\+' "$HRCEN_ENV" ||
    fail "PLAYWRIGHT_BROWSERS_PATH missing from ${HRCEN_ENV}"

  if [ -f "$HRDAV_ENV" ]; then
    run cp -a "$HRDAV_ENV" "$HRDAV_PREV"
  else
    run rm -f "$HRDAV_PREV"
  fi

  ROLLBACK_NEEDED=1
  rewrite_hrdav_env "$HRCEN_ENV" "$HRDAV_ENV"

  local profile
  profile="$(profile_dir_from_env "$HRDAV_ENV")"
  [ -n "$profile" ] || fail "HMS_SLOT_PROFILE_DIR missing after rewrite"
  if [ -n "$SUDO" ]; then
    run install -d -o ubuntu -g ubuntu -m 0700 "$profile"
  else
    install -d -m 0700 "$profile"
  fi

  if [ -f "$UNIT_SRC" ] && [ ! -f "${HMS_SLOT_SYSTEMD_DIR}/hms-slot@.service" ]; then
    run install -m 0644 "$UNIT_SRC" "${HMS_SLOT_SYSTEMD_DIR}/hms-slot@.service"
  fi

  "$SYSTEMCTL" daemon-reload
  "$SYSTEMCTL" enable --now "$UNIT"
  "$SYSTEMCTL" is-active --quiet "$UNIT" || fail "hms-slot@hrdav failed to start"
  ROLLBACK_NEEDED=0
  echo "HMS_SLOT_HRDAV_OK"
}

case "$ACTION" in
  install)
    trap on_exit EXIT
    install_slot
    ;;
  rollback)
    rollback
    ;;
  *)
    fail "usage: $0 [install|rollback]"
    ;;
esac
