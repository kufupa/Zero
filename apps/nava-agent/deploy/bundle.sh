#!/usr/bin/env bash
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root"
[[ $# == 1 ]] || { echo 'usage: bash apps/nava-agent/deploy/bundle.sh /absolute/new-bundle.tar.gz' >&2; exit 2; }
out=$1
[[ $out == /* && ! -e $out ]] || { echo 'output must be an absolute path that does not exist' >&2; exit 2; }
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || { echo 'build requires Node 22' >&2; exit 1; }
git diff --quiet HEAD -- apps/nava-agent apps/server-pilot/tooling/hms-cloud apps/server-pilot/src/hms apps/server-pilot/src/ops/playwright-quote-purge.ts tooling/playwright-quote || { echo 'commit changes to bundle inputs first' >&2; exit 1; }
sha=$(git rev-parse HEAD)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
paths=(apps/nava-agent apps/server-pilot/tooling/hms-cloud apps/server-pilot/src/hms/request-policy.ts apps/server-pilot/src/hms/private-digests.ts apps/server-pilot/src/hms/trace-privacy.ts apps/server-pilot/src/hms/trace-privacy-worker.ts apps/server-pilot/src/ops/playwright-quote-purge.ts)
contents=(apps COMMIT_SHA)
if git cat-file -e "$sha:tooling/playwright-quote" 2>/dev/null; then paths+=(tooling/playwright-quote); contents+=(tooling); fi
git archive "$sha" "${paths[@]}" | tar -x -C "$tmp"
cp "$tmp/apps/nava-agent/deploy/native/package.json" "$tmp/apps/server-pilot/package.json"
cp "$tmp/apps/nava-agent/deploy/native/package-lock.json" "$tmp/apps/server-pilot/package-lock.json"
CI=1 npm ci --prefix "$tmp/apps/nava-agent" --omit=dev --ignore-scripts --no-audit --no-fund
CI=1 npm ci --prefix "$tmp/apps/server-pilot" --omit=dev --ignore-scripts --no-audit --no-fund
printf '%s\n' "$sha" > "$tmp/COMMIT_SHA"
(cd "$tmp" && node --import ./apps/server-pilot/node_modules/tsx/dist/loader.mjs --input-type=module -e "await import('./apps/server-pilot/tooling/hms-cloud/fetch-quote.mjs'); console.log('native quote module imports OK')")
tar -czf "$tmp/bundle.tar.gz" -C "$tmp" "${contents[@]}"
set -o noclobber
cat "$tmp/bundle.tar.gz" > "$out"
sha256sum "$out"
