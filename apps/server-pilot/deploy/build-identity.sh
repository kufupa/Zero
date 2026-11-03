#!/usr/bin/env bash
# Identity of the last completed server build, not merely the current checkout.

nava_write_build_marker() {
  local repo="$1" value="$2" dist tmp
  dist="$repo/apps/server-pilot/dist"
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
  nava_write_build_marker "$repo" "$expected"
}

nava_load_build_commit() {
  local repo="$1" dist stamp value
  dist="$repo/apps/server-pilot/dist"
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
