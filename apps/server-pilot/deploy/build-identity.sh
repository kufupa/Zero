#!/usr/bin/env bash
# Identity of the last completed server build, not merely the current checkout.

nava_write_build_marker() {
  local repo="$1" value="$2" server dist tmp
  server="$repo/apps/server-pilot"
  mkdir -p "$server" || return 1
  if [ -L "$server" ] || [ ! -d "$server" ]; then
    echo "build identity: unsafe server directory" >&2
    return 1
  fi
  # A clean build may remove dist before it fails. Keep this separate flag
  # outside dist so a later restart cannot mistake that failure for a legacy build.
  if [ "$value" = BUILD_IN_PROGRESS ]; then
    [ ! -L "$server/.nava-build-in-progress" ] || return 1
    tmp="$(mktemp "$server/.nava-build-in-progress.XXXXXX")" || return 1
    if ! printf '%s\n' "$value" >"$tmp" || ! mv -f "$tmp" "$server/.nava-build-in-progress"; then
      rm -f "$tmp"
      return 1
    fi
  fi
  dist="$server/dist"
  mkdir -p "$dist" || return 1
  if [ -L "$dist" ] || [ ! -d "$dist" ]; then
    echo "build identity: unsafe dist directory" >&2
    return 1
  fi
  tmp="$(mktemp "$dist/.nava-build-commit.XXXXXX")" || return 1
  if ! printf '%s\n' "$value" >"$tmp" || ! mv -f "$tmp" "$dist/.nava-build-commit"; then
    rm -f "$tmp"
    return 1
  fi
}

nava_finish_server_build() {
  local repo="$1" expected="$2" actual
  [[ "$expected" =~ ^[0-9a-f]{40}$ ]] || return 1
  actual="$(git -C "$repo" rev-parse --verify 'HEAD^{commit}')" || return 1
  if [ "$actual" != "$expected" ]; then
    echo "build identity: checkout changed during server build" >&2
    return 1
  fi
  nava_write_build_marker "$repo" "$expected" || return 1
  rm -f -- "$repo/apps/server-pilot/.nava-build-in-progress"
}

nava_load_build_commit() {
  local repo="$1" dist stamp value
  dist="$repo/apps/server-pilot/dist"
  if [ -e "$repo/apps/server-pilot/.nava-build-in-progress" ] || [ -L "$repo/apps/server-pilot/.nava-build-in-progress" ]; then
    echo "build identity: server build in progress or incomplete" >&2
    return 1
  fi
  if [ -L "$dist" ]; then
    echo "build identity: unsafe dist directory" >&2
    return 1
  fi
  stamp="$dist/.nava-build-commit"
  if [ -e "$stamp" ] || [ -L "$stamp" ]; then
    if [ -L "$stamp" ] || [ ! -f "$stamp" ]; then
      echo "build identity: invalid marker" >&2
      return 1
    fi
    value="$(cat "$stamp")" || return 1
  else
    # A checkout or inherited env is not evidence of the running artifact.
    NAVA_BUILD_COMMIT=unknown
    export NAVA_BUILD_COMMIT
    echo "build identity: legacy build has no marker; identity is unverified" >&2
    return 0
  fi
  if ! [[ "$value" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "build identity: missing or invalid server build identity" >&2
    return 1
  fi
  NAVA_BUILD_COMMIT="${value,,}"
  export NAVA_BUILD_COMMIT
}
