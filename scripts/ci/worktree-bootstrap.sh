#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  printf 'Usage: worktree-bootstrap.sh <worktree>\n' >&2
}

if (($# != 1)); then
  usage
  exit 2
fi

if ! worktree=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null); then
  printf 'worktree-bootstrap: not a git worktree: %s\n' "$1" >&2
  exit 2
fi
worktree=$(cd "$worktree" && pwd -P)
if ! common_dir=$(cd "$worktree" && git rev-parse --git-common-dir 2>/dev/null); then
  printf 'worktree-bootstrap: could not resolve git common directory\n' >&2
  exit 2
fi
if [[ $common_dir != /* ]]; then
  common_dir="$worktree/$common_dir"
fi
common_dir=$(cd "$common_dir" && pwd -P)

if [[ ! -d "$worktree/.husky" || ! -f "$worktree/.husky/pre-commit" ]]; then
  printf 'worktree-bootstrap: .husky/pre-commit is missing in %s\n' "$worktree" >&2
  exit 1
fi

main_checkout=$(dirname "$common_dir")
shared_node_modules="$main_checkout/node_modules"
worktree_node_modules="$worktree/node_modules"
node_modules_action=kept
if [[ -L $worktree_node_modules && ! -e $worktree_node_modules ]]; then
  printf 'worktree-bootstrap: node_modules is a broken symlink in %s\n' "$worktree" >&2
  exit 1
elif [[ -e $worktree_node_modules || -L $worktree_node_modules ]]; then
  if [[ ! -d $worktree_node_modules ]]; then
    printf 'worktree-bootstrap: node_modules exists but is not a directory in %s\n' "$worktree" >&2
    exit 1
  fi
elif [[ -d $shared_node_modules ]]; then
  if ln -s "$shared_node_modules" "$worktree_node_modules" 2>/dev/null; then
    node_modules_action=linked
  elif [[ -L $worktree_node_modules && $(readlink "$worktree_node_modules") == "$shared_node_modules" ]]; then
    node_modules_action=linked
  else
    printf 'worktree-bootstrap: could not link shared node_modules into %s\n' "$worktree" >&2
    exit 1
  fi
else
  printf 'worktree-bootstrap: shared node_modules missing at %s\n' "$shared_node_modules" >&2
  exit 1
fi

# pnpm keeps each workspace package's direct deps in its own node_modules; link those too.
package_links=0
for package_json in "$worktree"/apps/*/package.json "$worktree"/packages/*/package.json; do
  [[ -f $package_json ]] || continue
  package_dir=$(dirname "$package_json")
  shared_package_modules="$main_checkout/${package_dir#"$worktree"/}/node_modules"
  if [[ ! -e $package_dir/node_modules && ! -L $package_dir/node_modules && -d $shared_package_modules ]]; then
    ln -s "$shared_package_modules" "$package_dir/node_modules"
    package_links=$((package_links + 1))
  fi
done

hooks_path=$(git -C "$worktree" config --get core.hooksPath || true)
if [[ $hooks_path != .husky/_ || ! -x "$worktree/.husky/_/pre-commit" ]]; then
  if ! (cd "$worktree" && pnpm exec husky >/dev/null 2>&1); then
    printf 'worktree-bootstrap: pnpm exec husky failed in %s\n' "$worktree" >&2
    exit 1
  fi
fi

hooks_path=$(git -C "$worktree" config --get core.hooksPath || true)
if [[ $hooks_path != .husky/_ || ! -x "$worktree/.husky/_/pre-commit" ]]; then
  printf 'worktree-bootstrap: pre-commit hook shim was not created in %s\n' "$worktree" >&2
  exit 1
fi

printf 'worktree-bootstrap PASS %q (node_modules=%s package_links=%d hooks=ready)\n' "$worktree" "$node_modules_action" "$package_links"
