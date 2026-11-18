#!/usr/bin/env bash
# Private rewrite config is loaded only by the HTTP children.
# Values use the unquoted KEY=value subset of dotenv; no shell is evaluated.

nava_gateway_load() {
  set +x
  local file="$1" line key value
  local -A values=()
  [ -f "$file" ] && [ ! -L "$file" ] &&
    [ "$(stat -c '%a:%u:%g' "$file")" = "600:$(id -u):$(id -g)" ] || return 1

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" == *=* ]] || return 1
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      NAVA_AGENT_BASE_URL|NAVA_STAFF_JWT_SECRET|NAVA_REWRITE_COHORT_USER_ID|NAVA_REWRITE_COHORT_MAILBOX_ID) ;;
      *) return 1 ;;
    esac
    [ -z "${values[$key]+present}" ] || return 1
    [[ "$value" =~ ^[a-zA-Z0-9_./:@+-]+$ ]] && [ "${#value}" -le 512 ] || return 1
    values[$key]="$value"
  done < "$file"

  [ "${values[NAVA_AGENT_BASE_URL]:-}" = 'http://127.0.0.1:3107' ] &&
    [ -n "${values[NAVA_STAFF_JWT_SECRET]:-}" ] &&
    [ -n "${values[NAVA_REWRITE_COHORT_USER_ID]:-}" ] &&
    [ -n "${values[NAVA_REWRITE_COHORT_MAILBOX_ID]:-}" ] &&
    [ "${#values[NAVA_STAFF_JWT_SECRET]}" -ge 32 ] || return 1

  for key in NAVA_AGENT_BASE_URL NAVA_STAFF_JWT_SECRET NAVA_REWRITE_COHORT_USER_ID NAVA_REWRITE_COHORT_MAILBOX_ID; do
    printf -v "$key" '%s' "${values[$key]}"
    export "$key"
  done
}

# Explicit promotion is separate from deployment. The staged file is inert.
nava_gateway_activate() (
  set +x
  local dir="${HOME:?HOME required}/.config/nava-agent"
  local staged="$dir/gateway.staged.env" active="$dir/gateway.env" runtime="$dir/runtime.env" candidate
  exec 9>>"$HOME/.nava-deploy.lock"
  flock -x 9
  nava_gateway_load "$staged" || { echo 'staged gateway config invalid' >&2; exit 2; }
  [ -f "$runtime" ] && [ ! -L "$runtime" ] &&
    [ "$(stat -c '%a:%u:%g' "$runtime")" = "600:$(id -u):$(id -g)" ] || {
      echo 'Nava runtime config invalid' >&2; exit 2;
    }
  candidate="$(mktemp "$dir/.gateway.env.XXXXXX")"
  trap 'rm -f -- "$candidate"' EXIT
  cp -- "$staged" "$candidate"
  nava_gateway_load "$candidate" || { echo 'gateway copy invalid' >&2; exit 2; }
  python3 - "$runtime" <<'PY' || { echo 'Nava runtime secret mismatch' >&2; exit 2; }
import hmac, os, re, sys
with open(sys.argv[1], encoding='utf8') as file:
    matches = [m.group(1) for line in file if (m := re.fullmatch(r'NAVA_STAFF_JWT_SECRET=([A-Za-z0-9_-]+)\s*', line))]
if len(matches) != 1 or not hmac.compare_digest(matches[0], os.environ['NAVA_STAFF_JWT_SECRET']):
    sys.exit(1)
PY
  if [ -e "$active" ] || [ -L "$active" ]; then
    [ ! -L "$active" ] && nava_gateway_load "$active" && cmp -s -- "$candidate" "$active" || {
      echo 'active gateway config differs; refusing to replace' >&2; exit 2;
    }
  else
    ln -- "$candidate" "$active" || { echo 'gateway activation failed' >&2; exit 2; }
  fi
  echo 'Gateway config activated; restart is still required'
)
