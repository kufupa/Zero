#!/usr/bin/env bash
# Thin ops wrapper: HMS reservation shadow canary / start / status / stop.
# Sole starter of hms-ai-worker (via dist/ops/hms-live-proof.js). Never Vitest.
# Never accepts lookup argv (confirmation/thread/message).
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
ACTION="${1:-}"

usage() {
  echo "usage: $0 {canary|start|status|stop|rearm}"
  exit 2
}

case "$ACTION" in
  canary|start|status|stop|rearm) ;;
  -h|--help) usage ;;
  *) usage ;;
esac

# Refuse unexpected extra args (no confirmation/thread/message passthrough).
if [ "$#" -ne 1 ]; then
  echo "HMS_FAIL code=POLICY_BLOCK" >&2
  exit 10
fi

case "$ACTION" in
  canary|start|rearm)
    exec 9>>/home/ubuntu/.nava-deploy.lock
    flock -x 9
    ;;
esac

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then
  ENV_FILE=/home/ubuntu/.env.production
fi
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Canary/start may not use stale inherited identity or an unbuilt checkout.
# Status and stop remain available when build identity is unknown.
# shellcheck source=build-identity.sh
source "${SERVER_PILOT}/deploy/build-identity.sh"
case "$ACTION" in
  canary|start|rearm)
    if ! nava_load_build_commit "$REPO_ROOT" ||
      ! [[ "$NAVA_BUILD_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
      [ "$NAVA_BUILD_COMMIT" = 0000000000000000000000000000000000000000 ]; then
      echo "HMS_FAIL code=BUILD_MISMATCH" >&2
      exit 10
    fi
    checkout="$(env -i PATH="$PATH" HOME="$HOME" git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
    if [ "$checkout" != "$NAVA_BUILD_COMMIT" ]; then
      echo "HMS_FAIL code=BUILD_MISMATCH" >&2
      exit 10
    fi
    ;;
  status)
    if ! nava_load_build_commit "$REPO_ROOT"; then
      export NAVA_BUILD_COMMIT=unknown
    fi
    ;;
esac
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/nava/ms-playwright}"

cd "$REPO_ROOT"

PROOF_JS="${SERVER_PILOT}/dist/ops/hms-live-proof.js"
if [ ! -f "$PROOF_JS" ]; then
  echo "HMS_FAIL code=BUILD_MISMATCH" >&2
  echo "missing ${PROOF_JS}; run deploy/build first" >&2
  exit 10
fi

exec node "$PROOF_JS" "$ACTION"
