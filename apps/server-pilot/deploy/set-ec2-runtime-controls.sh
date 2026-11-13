#!/usr/bin/env bash
# Run as ubuntu on EC2. Update only named non-secret controls in the durable env,
# then use the existing M1 renderer and its canary guard for the remote overlay.
set -euo pipefail
[ "$(id -un)" = ubuntu ] || { echo 'must run as ubuntu' >&2; exit 2; }
[ "$#" -gt 0 ] || { echo "usage: $0 KEY=value [KEY=value ...]" >&2; exit 2; }
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd -- "$SCRIPT_DIR/../../.." && pwd)}"
SERVER_PILOT="$REPO_ROOT/apps/server-pilot"
ENV_FILE="${ENV_FILE:-$SERVER_PILOT/.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then ENV_FILE=/home/ubuntu/.env.production; fi
COMMON="$SERVER_PILOT/.env.remote-common"
for file in "$ENV_FILE" "$COMMON"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c '%a:%U:%G' "$file")" = 600:ubuntu:ubuntu ] || {
    echo 'durable or common env missing or unsafe' >&2; exit 2;
  }
done
exec 9>>/home/ubuntu/.nava-deploy.lock
flock -x 9
umask 077
candidate="$(mktemp "$(dirname -- "$ENV_FILE")/.env.scoped.XXXXXX")"
backup="$(mktemp "$SERVER_PILOT/.env.common-backup.XXXXXX")"
cp -- "$COMMON" "$backup"
source_sha="$(sha256sum "$ENV_FILE" | cut -d' ' -f1)"
common_sha="$(sha256sum "$COMMON" | cut -d' ' -f1)"
rendered_sha=""
committed=0
cleanup() {
  rc=$?
  if [ "$committed" = 0 ] && [ -n "$rendered_sha" ]; then
    if [ "$(sha256sum "$COMMON" | cut -d' ' -f1)" = "$rendered_sha" ] &&
       [ "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" = "$source_sha" ]; then
      mv -f -- "$backup" "$COMMON"
    else
      echo 'scoped update interrupted; common or source changed, inspect before retry' >&2
      rc=20
    fi
  fi
  rm -f -- "$candidate" "$backup"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 2' HUP INT TERM
node - "$ENV_FILE" "$candidate" "$@" <<'NODE'
const fs = require('fs');
const [source, dest, ...args] = process.argv.slice(2);
const flags = new Map([
  ...['PANE_WRITE_CREATE', 'PANE_WRITE_AMEND', 'PANE_WRITE_AMEND_UNPAID', 'PANE_WRITE_AMEND_PAID',
    'PANE_WRITE_CANCEL_UNPAID', 'PANE_WRITE_CANCEL_PAID', 'PANE_WRITE_ADDONS', 'PANE_WRITE_ATTACH'].map(k => [k, /^(off|lab|on)$/]),
  ...['PANE_CLOUD_CREATE_DISPATCH', 'PANE_HMS_LAB_CREATE_WORKER', 'PANE_HMS_LAB_AMEND_WORKER',
    'PANE_HMS_LAB_ATTACH_WORKER'].map(k => [k, /^(off|on)$/]),
  ...['HMS_MEMORY_PMS_PATH', 'HMS_MEMORY_OUTBOUND_PATH', 'HMS_MEMORY_DATA_DIR', 'HMS_NATIVE_CATALOG_PATH',
    'HMS_MEMORY_OBSERVATIONS_PATH', 'PARTY_INDEX_PATH', 'PARTY_INDEX_PATH_HRDAV'].map(k => [k, /^\/[A-Za-z0-9._/-]+$/]),
]);
try {
  const changes = new Map();
  for (const arg of args) {
    const index = arg.indexOf('=');
    const key = arg.slice(0, index), value = arg.slice(index + 1);
    if (index < 1 || !flags.has(key) || changes.has(key) || !flags.get(key).test(value) ||
      (value.startsWith('/') && value.split('/').some(part => part === '..' || part === '.'))) throw Error();
    changes.set(key, `${key}='${value}'`);
  }
  const text = fs.readFileSync(source, 'utf8');
  if (!text.endsWith('\n') || /[\r\0]/.test(text)) throw Error();
  const seen = new Set();
  const lines = text.slice(0, -1).split('\n').map(line => {
    if (!line) return line;
    const match = /^([A-Z][A-Z0-9_]*)=(?:'((?:[^']|'\\'')*)'|[A-Za-z0-9_./:=?@%+,-]+)$/.exec(line);
    if (!match || seen.has(match[1])) throw Error();
    seen.add(match[1]);
    if (!changes.has(match[1])) return line;
    const replacement = changes.get(match[1]); changes.delete(match[1]); return replacement;
  });
  lines.push(...changes.values());
  fs.writeFileSync(dest, lines.join('\n') + '\n', {mode: 0o600});
  const fd = fs.openSync(dest, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
} catch { console.error('invalid scoped runtime update or durable source'); process.exit(2); }
NODE
[ "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" = "$source_sha" ] &&
  [ "$(sha256sum "$COMMON" | cut -d' ' -f1)" = "$common_sha" ] || { echo 'env changed during update' >&2; exit 2; }
keys=()
for assignment in "$@"; do keys+=("${assignment%%=*}"); done
REPO_ROOT="$REPO_ROOT" ENV_FILE="$candidate" bash "$SCRIPT_DIR/write-ec2-remote-env.sh" --m1-only --keys "${keys[@]}"
rendered_sha="$(sha256sum "$COMMON" | cut -d' ' -f1)"
[ "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" = "$source_sha" ] || { echo 'durable env changed during update' >&2; exit 2; }
mv -f -- "$candidate" "$ENV_FILE"
committed=1
node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$(dirname -- "$ENV_FILE")"
echo 'Updated scoped durable controls and rendered remote common; restart required'
