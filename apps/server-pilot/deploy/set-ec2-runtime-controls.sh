#!/usr/bin/env bash
# Run as ubuntu on EC2. Update only named non-secret controls in the durable env,
# then use the existing M1 renderer and its canary guard for the remote overlay.
set -euo pipefail
[ "$(id -un)" = ubuntu ] || { echo 'must run as ubuntu' >&2; exit 2; }
[ "$#" -gt 0 ] || { echo "usage: $0 KEY=value [KEY=value ...]" >&2; exit 2; }
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
POLICY_MODULE="$SCRIPT_DIR/../tooling/hms-cloud/hms-workflow-policy.mjs"
[ ! -e "${NAVA_RUN_HOLD_FILE:-/tmp/mh1024/HOLD.txt}" ] || { echo "scoped update refused: HOLD file present" >&2; exit 2; }
REPO_ROOT="${REPO_ROOT:-$(cd -- "$SCRIPT_DIR/../../.." && pwd)}"
SERVER_PILOT="$REPO_ROOT/apps/server-pilot"
ENV_FILE="${ENV_FILE:-$SERVER_PILOT/.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then ENV_FILE=/home/ubuntu/.env.production; fi
COMMON="$SERVER_PILOT/.env.remote-common"
ADMIN="$SERVER_PILOT/.env.remote-admin"
for file in "$ENV_FILE" "$COMMON" "$ADMIN"; do
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
admin_sha="$(sha256sum "$ADMIN" | cut -d' ' -f1)"
rendered_sha=""
candidate_sha=""
render_root=""
armed=0
committed=0
cleanup() {
  rc=$?
  preserve=0
  if [ "$committed" = 0 ] && [ "$armed" = 1 ]; then
    current_common="$(sha256sum "$COMMON" 2>/dev/null | cut -d' ' -f1 || true)"
    current_source="$(sha256sum "$ENV_FILE" 2>/dev/null | cut -d' ' -f1 || true)"
    if [ "$current_source" = "$candidate_sha" ] && [ "$current_common" = "$rendered_sha" ]; then
      echo 'scoped update committed before interruption' >&2
    elif [ "$current_source" = "$source_sha" ] && [ "$current_common" = "$common_sha" ]; then
      :
    elif [ "$current_source" = "$source_sha" ] && [ "$current_common" = "$rendered_sha" ]; then
      if ! mv -f -- "$backup" "$COMMON"; then preserve=1; rc=20; fi
    else
      preserve=1
      rc=20
    fi
  fi
  if [ "$preserve" = 1 ]; then
    echo "scoped update interrupted; preserve $backup and $candidate for inspection" >&2
  else
    rm -f -- "$candidate" "$backup"
  fi
  if [ -n "$render_root" ]; then
    rm -f -- "$render_root/apps/server-pilot/.env.remote-common" "$render_root/apps/server-pilot/.env.remote-admin"
    rmdir -- "$render_root/apps/server-pilot" "$render_root/apps" "$render_root" 2>/dev/null || true
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 2' HUP INT TERM
[ "$(sha256sum "$backup" | cut -d' ' -f1)" = "$common_sha" ] || { echo 'common env changed during backup' >&2; exit 2; }
node --input-type=module - "$POLICY_MODULE" "$ENV_FILE" "$candidate" "$@" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [policyPath, source, dest, ...args] = process.argv.slice(2);
const { SCOPED_RUNTIME_CONTROL_KEYS, validateRuntimeControl } = await import(pathToFileURL(policyPath).href);
const flags = new Set(SCOPED_RUNTIME_CONTROL_KEYS);
try {
  const changes = new Map();
  for (const arg of args) {
    const index = arg.indexOf('=');
    const key = arg.slice(0, index), value = arg.slice(index + 1);
    if (index < 1 || !flags.has(key) || changes.has(key) || (value === '' && key !== 'HMS_DAVINCI_ENABLED_PROPERTIES')) throw Error();
    validateRuntimeControl(key, value);
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
    const raw = line.slice(match[1].length + 1);
    const value = raw.startsWith("'") ? raw.slice(1, -1).replace(/'\\''/g, "'") : raw;
    validateRuntimeControl(match[1], value);
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
candidate_sha="$(sha256sum "$candidate" | cut -d' ' -f1)"
render_root="$(mktemp -d "$SERVER_PILOT/.env.scoped-render.XXXXXX")"
mkdir -p -- "$render_root/apps/server-pilot"
staged_common="$render_root/apps/server-pilot/.env.remote-common"
cp -- "$COMMON" "$staged_common"
cp -- "$ADMIN" "$render_root/apps/server-pilot/.env.remote-admin"
live_sha="${NAVA_LIVE_SHA:-}"
if [ -z "$live_sha" ] && [ -d "$REPO_ROOT/.git" ]; then
  live_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
REPO_ROOT="$render_root" ENV_FILE="$candidate" NAVA_LIVE_SHA="$live_sha" \
  bash "$SCRIPT_DIR/write-ec2-remote-env.sh" --m1-only --keys "${keys[@]}"
rendered_sha="$(sha256sum "$staged_common" | cut -d' ' -f1)"
[ "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" = "$source_sha" ] &&
  [ "$(sha256sum "$COMMON" | cut -d' ' -f1)" = "$common_sha" ] &&
  [ "$(sha256sum "$ADMIN" | cut -d' ' -f1)" = "$admin_sha" ] || { echo 'env changed during update' >&2; exit 2; }
[ ! -e "${NAVA_RUN_HOLD_FILE:-/tmp/mh1024/HOLD.txt}" ] || { echo "scoped update refused: HOLD file present" >&2; exit 2; }
armed=1
mv -f -- "$staged_common" "$COMMON"
mv -f -- "$candidate" "$ENV_FILE"
committed=1
node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$(dirname -- "$ENV_FILE")"
echo 'Updated scoped durable controls and rendered remote common; restart required'
