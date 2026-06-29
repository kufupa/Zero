#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
plugin_dir="$repo_root/.cursor/compound-engineering"
skills_root="$repo_root/.cursor/skills"

if [ ! -f "$plugin_dir/.cursor-plugin/plugin.json" ]; then
  echo "Compound Engineering submodule missing. Run:"
  echo "  git submodule update --init .cursor/compound-engineering"
  exit 1
fi

mkdir -p "$skills_root"

for skill_dir in "$plugin_dir"/skills/*/; do
  [ -d "$skill_dir" ] || continue
  name="$(basename "$skill_dir")"
  target="$skills_root/$name"

  if [ -L "$target" ] || [ -e "$target" ]; then
    rm -rf "$target"
  fi

  ln -s "../compound-engineering/skills/$name" "$target"
  echo "linked $name"
done

echo "Compound Engineering skills synced from .cursor/compound-engineering"
