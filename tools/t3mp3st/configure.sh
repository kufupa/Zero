#!/usr/bin/env bash
# Sync local tools/t3mp3st/.env → ~/.t3mp3st/.env and set xai / grok-4.3 defaults.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOCAL_ENV="$ROOT/.env"
REPO_ENV="$(cd "$ROOT/../.." && pwd)/.env"
HOME_ENV="$HOME/.t3mp3st/.env"

if [ -f "$LOCAL_ENV" ]; then
  ENV_SOURCE="$LOCAL_ENV"
elif [ -f "$REPO_ENV" ]; then
  ENV_SOURCE="$REPO_ENV"
else
  echo "Missing env — copy tools/t3mp3st/.env.example or set XAI_API_KEY in repo .env" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_SOURCE"
set +a

if [ -z "${XAI_API_KEY:-}" ]; then
  echo "XAI_API_KEY empty in $LOCAL_ENV" >&2
  exit 1
fi

PROVIDER="${LLM_PROVIDER:-xai}"
MODEL="${LLM_MODEL:-grok-4.3}"
REASONING="${XAI_REASONING_EFFORT:-high}"

mkdir -p "$(dirname "$HOME_ENV")"
{
  printf 'XAI_API_KEY=%s\n' "$XAI_API_KEY"
  printf 'LLM_PROVIDER=%s\n' "$PROVIDER"
  printf 'LLM_MODEL=%s\n' "$MODEL"
  printf 'XAI_REASONING_EFFORT=%s\n' "$REASONING"
} > "$HOME_ENV"
chmod 600 "$HOME_ENV"

VENDOR="$ROOT/.vendor/T3MP3ST"
if [ ! -d "$VENDOR" ]; then
  echo "Vendor missing — run install.sh first" >&2
  exit 1
fi

echo "[t3mp3st] setting default provider=$PROVIDER model=$MODEL reasoning=$REASONING ..."
node "$ROOT/scripts/configure-provider.mjs" "$PROVIDER" "$MODEL"

echo "[t3mp3st] configured → $HOME_ENV"
