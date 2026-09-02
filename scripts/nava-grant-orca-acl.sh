#!/usr/bin/env bash
# Re-apply named POSIX ACLs after private-output chmod 0700/0600 zeros the mask.
# No dump stdout. Requires passwordless sudo setfacl.
set -euo pipefail

REPO="${NAVA_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PRIVATE="$REPO/.private"
CORPUS="$PRIVATE/connected-mailbox-corpus"
DUMP="$CORPUS/connected-mailbox-inbox.md"
HOURS="$CORPUS/hours.json"
INFOR="$REPO/docs/infor-hms"

sudo -n true

grant_dir() {
  local path="$1"
  sudo setfacl -m u:orca:rwx -m u:ubuntu:rwx -m m::rwx "$path"
  sudo setfacl -d -m u:orca:rwx -m u:ubuntu:rwx -m m::rwx "$path"
}

grant_file_rw() {
  local path="$1"
  sudo setfacl -m u:orca:rw -m u:ubuntu:rw -m m::rw "$path"
}

grant_file_r() {
  local path="$1"
  sudo setfacl -m u:orca:r -m u:ubuntu:rw -m m::rw "$path"
}

if [[ ! -d "$PRIVATE" ]]; then
  echo "missing $PRIVATE" >&2
  exit 1
fi
grant_dir "$PRIVATE"

if [[ ! -d "$CORPUS" ]]; then
  echo "missing $CORPUS" >&2
  exit 1
fi
grant_dir "$CORPUS"

if [[ -e "$DUMP" ]]; then
  grant_file_r "$DUMP"
fi
if [[ -e "$HOURS" ]]; then
  grant_file_rw "$HOURS"
fi

if [[ ! -d "$INFOR" ]]; then
  echo "missing $INFOR" >&2
  exit 1
fi
grant_dir "$INFOR"

if [[ -e "$DUMP" ]]; then
  if test -r "$DUMP"; then
    echo DUMP_READ_OK
  else
    echo DUMP_READ_FAIL >&2
    exit 1
  fi
  stat -c '%s %a %U:%G' "$DUMP"
else
  echo DUMP_ABSENT >&2
  exit 1
fi

probe="$INFOR/.orca-write-probe"
touch "$probe"
rm -f "$probe"
echo INFOR_WRITE_OK
echo ACL_GRANT_OK
