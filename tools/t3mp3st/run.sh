#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$ROOT/.vendor/T3MP3ST"
CMD="${1:-server}"

case "$CMD" in
  install)
    bash "$ROOT/install.sh"
    ;;
  configure)
    bash "$ROOT/configure.sh"
    ;;
  test-llm)
    node "$ROOT/scripts/test-llm.mjs"
    ;;
  swarm-test)
    node "$ROOT/scripts/lib/xai-repo-agent.selftest.mjs"
    npm --prefix "$VENDOR" run test:swarm
    ;;
  swarm)
    export T3MP3ST_WRAPPER_ROOT="$ROOT"
    shift
    node "$VENDOR/scripts/cli-swarm.mjs" --backend xai "$@"
    ;;
  swarm-overnight)
    node "$ROOT/scripts/overnight-swarm.mjs" "$@"
    ;;
  server)
    if [ ! -d "$VENDOR" ]; then
      bash "$ROOT/install.sh"
    fi
    if [ -f "$ROOT/.env" ]; then
      bash "$ROOT/configure.sh"
    else
      echo "[t3mp3st] WARN: no tools/t3mp3st/.env — set XAI_API_KEY before running missions" >&2
    fi
    # Load home env for XAI_API_KEY (T3MP3ST reads ~/.t3mp3st/.env)
    if [ -f "$HOME/.t3mp3st/.env" ]; then
      set -a
      # shellcheck disable=SC1091
      source "$HOME/.t3mp3st/.env"
      set +a
    fi
    echo "[t3mp3st] War Room → http://127.0.0.1:3333/ui/"
    echo "[t3mp3st] Scope → $ROOT/missions/ec2-pilot-scope.md"
    npm --prefix "$VENDOR" run server
    ;;
  status)
    if [ ! -d "$VENDOR" ]; then
      echo "not installed"
      exit 1
    fi
    npm --prefix "$VENDOR" exec -- node dist/cli.js status
    ;;
  *)
    echo "usage: $0 {install|configure|test-llm|swarm-test|swarm|swarm-overnight|server|status}" >&2
    exit 1
    ;;
esac
