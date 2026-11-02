#!/usr/bin/env bash
# PM2 entrypoint for remote-http, including saved-state resurrection and restarts.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$SERVER_PILOT/../.." && pwd)"

# The PM2 CLI and saved process metadata need no remote auth or model secrets.
# Validate and load them only in this child, after clearing the inherited env.
exec env -i \
  HOME="${HOME:?HOME required}" \
  PATH="${PATH:?PATH required}" \
  REPO_ROOT="$REPO_ROOT" \
  SERVER_PILOT="$SERVER_PILOT" \
  NAVA_BUILD_COMMIT="${NAVA_BUILD_COMMIT:-}" \
  ENV_FILE="${ENV_FILE:-}" \
  NODE_ENV=production \
  PORT=8789 \
  NAVA_AUTH_SESSION_PROFILE=remote \
  bash -ceu '
    writer="$SERVER_PILOT/deploy/write-ec2-remote-env.sh"
    launch_build_commit="${NAVA_BUILD_COMMIT:-}"
    if [[ ! "$launch_build_commit" =~ ^[a-fA-F0-9]{40}$ ]]; then
      echo "remote build identity missing or invalid" >&2
      exit 2
    fi
    snapshot="$(bash "$writer" --prepare-model)"
    cleanup_snapshot() {
      env -i PATH="$PATH" rm -f -- "$snapshot/model" "$snapshot/brain" "$snapshot/common" "$snapshot/admin"
      env -i PATH="$PATH" rmdir -- "$snapshot"
    }
    trap cleanup_snapshot EXIT
    trap "exit 2" HUP INT TERM

    set -a
    source "$snapshot/common"
    source "$snapshot/admin"
    common_pane_brain_set="${PANE_BRAIN+x}"
    common_pane_brain="${PANE_BRAIN:-}"
    common_quote_llm_set="${QUOTE_WORKFLOW_LLM+x}"
    common_quote_llm="${QUOTE_WORKFLOW_LLM:-}"
    unset PANE_BRAIN QUOTE_WORKFLOW_LLM
    source "$snapshot/model"
    source "$snapshot/brain"
    if [ "$common_pane_brain_set" = x ]; then
      if [ "$common_pane_brain" != "${PANE_BRAIN:-classifier}" ]; then
        echo "remote pane routing conflicts with source" >&2
        exit 2
      fi
      PANE_BRAIN="$common_pane_brain"
    fi
    if [ "$common_quote_llm_set" = x ] &&
      { [ "${QUOTE_WORKFLOW_LLM+x}" != x ] || [ "$common_quote_llm" != "$QUOTE_WORKFLOW_LLM" ]; }; then
      echo "remote quote model flag conflicts with source" >&2
      exit 2
    fi
    NAVA_BUILD_COMMIT="$launch_build_commit"
    set +a
    # Re-render and compare source and auth/flags after loading; never pass secrets to the checker.
    env -i HOME="$HOME" PATH="$PATH" REPO_ROOT="$REPO_ROOT" ENV_FILE="${ENV_FILE:-}" bash "$writer" --check-model "$snapshot"
    cleanup_snapshot
    trap - EXIT HUP INT TERM
    unset common_pane_brain_set common_pane_brain common_quote_llm_set common_quote_llm launch_build_commit writer snapshot REPO_ROOT ENV_FILE
    exec node "$SERVER_PILOT/dist/main.js"
  '
