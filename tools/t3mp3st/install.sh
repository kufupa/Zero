#!/usr/bin/env bash
# Clone T3MP3ST into tools/t3mp3st/.vendor and install deps (isolated from monorepo pnpm).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$ROOT/.vendor/T3MP3ST"
PATCH="$ROOT/patches/reasoning-effort.patch"
PATCH_SWARM="$ROOT/patches/cli-swarm-xai-backend.patch"
REF="${T3MP3ST_REF:-main}"

if ! command -v git >/dev/null 2>&1; then
  echo "git required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm required (T3MP3ST uses npm, not pnpm workspace)" >&2
  exit 1
fi

if [ ! -d "$VENDOR/.git" ]; then
  echo "[t3mp3st] cloning elder-plinius/T3MP3ST @ $REF ..."
  mkdir -p "$ROOT/.vendor"
  git clone --depth 1 --branch "$REF" https://github.com/elder-plinius/T3MP3ST.git "$VENDOR"
else
  echo "[t3mp3st] vendor exists; fetch $REF ..."
  git -C "$VENDOR" fetch --depth 1 origin "$REF"
  git -C "$VENDOR" checkout "$REF"
  git -C "$VENDOR" pull --ff-only origin "$REF" || true
fi

echo "[t3mp3st] npm install ..."
npm --prefix "$VENDOR" install

if [ -f "$PATCH" ]; then
  echo "[t3mp3st] applying reasoning_effort patch ..."
  if git -C "$VENDOR" apply --check "$PATCH" 2>/dev/null; then
    git -C "$VENDOR" apply "$PATCH"
  elif git -C "$VENDOR" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "[t3mp3st] patch already applied"
  else
    echo "[t3mp3st] WARN: patch did not apply cleanly; grok-4.3 may run without reasoning_effort=high" >&2
  fi
fi

if [ -f "$PATCH_SWARM" ]; then
  echo "[t3mp3st] applying cli-swarm xai backend patch ..."
  if git -C "$VENDOR" apply --check "$PATCH_SWARM" 2>/dev/null; then
    git -C "$VENDOR" apply "$PATCH_SWARM"
  elif git -C "$VENDOR" apply --reverse --check "$PATCH_SWARM" 2>/dev/null; then
    echo "[t3mp3st] cli-swarm xai patch already applied"
  else
    echo "[t3mp3st] WARN: cli-swarm xai patch did not apply cleanly" >&2
  fi
fi

echo "[t3mp3st] build ..."
npm --prefix "$VENDOR" run build --silent

echo "[t3mp3st] install OK → $VENDOR"
