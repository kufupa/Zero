#!/usr/bin/env bash
# Staged triage-v5 quality eval on EC2 side checkout. Private artifacts under .tmp/triage-quality.
set -euo pipefail
export NVM_DIR=/home/ubuntu/.nvm
# shellcheck disable=SC1091
. /home/ubuntu/.nvm/nvm.sh
export AWS_DEFAULT_REGION=af-south-1

REPO=/home/ubuntu/repos/zero-triage-v5
PROD=/home/ubuntu/repos/zero
TQ=$REPO/.tmp/triage-quality
STAGE=${1:?stage id required: a|b|c|selected-1|selected-2}
BASE_SHA=${2:-1ebe904ae065c4394e44fd7c9358657045b535ec}

mkdir -p "$TQ/reports" "$TQ/stage-src"

if [ ! -e "$REPO/node_modules/.pnpm" ] && [ ! -L "$REPO/node_modules" ]; then
  if [ -d "$PROD/node_modules" ]; then
    ln -sfn "$PROD/node_modules" "$REPO/node_modules"
  fi
fi
if [ ! -e "$REPO/apps/server-pilot/node_modules" ] && [ -d "$PROD/apps/server-pilot/node_modules" ]; then
  ln -sfn "$PROD/apps/server-pilot/node_modules" "$REPO/apps/server-pilot/node_modules"
fi

set -a
# shellcheck disable=SC1091
source "$PROD/apps/server-pilot/.env.production"
set +a
unset VITEST_ALLOW_PILOT_RDS

cd "$REPO"
export NODE_ENV=production
export AI_ENABLED=true

node apps/server-pilot/scripts/triage-v5-build-stages.cjs "$BASE_SHA" "$TQ/stage-src"

MAIL=apps/server-pilot/src/ai/workflows/mail-triage.ts
TRIAGE=apps/server-pilot/src/ai/triage.ts

case "$STAGE" in
  a)
    cp "$TQ/stage-src/mail-triage-stage-a.ts" "$MAIL"
    cp "$TQ/stage-src/triage-stage-a.ts" "$TRIAGE"
    ;;
  b)
    cp "$TQ/stage-src/mail-triage-stage-b.ts" "$MAIL"
    cp "$TQ/stage-src/triage-stage-b.ts" "$TRIAGE"
    ;;
  c|selected-1|selected-2)
    cp "$TQ/stage-src/mail-triage-stage-c.ts" "$MAIL"
    cp "$TQ/stage-src/triage-stage-c.ts" "$TRIAGE"
    ;;
  *)
    echo "unknown stage $STAGE" >&2
    exit 2
    ;;
esac

if [ ! -f "$TQ/inputs.jsonl" ] || [ ! -f "$TQ/labels.jsonl" ]; then
  echo "missing inputs/labels under $TQ" >&2
  exit 3
fi

echo "STAGE_START $(date -u +%Y-%m-%dT%H:%M:%SZ) stage=$STAGE sha=$(git rev-parse HEAD)"

NODE_ENV=production AI_ENABLED=true pnpm --dir apps/server-pilot exec tsx src/ai/eval-runner.ts \
  --mode=quality \
  --inputs ../../.tmp/triage-quality/inputs.jsonl \
  --labels ../../.tmp/triage-quality/labels.jsonl \
  --out "../../.tmp/triage-quality/reports/stage-${STAGE}.json" \
  --repeat-id "stage-${STAGE}"

node -e '
const fs=require("fs");
const stage=process.argv[1];
const r=JSON.parse(fs.readFileSync(".tmp/triage-quality/reports/stage-"+stage+".json","utf8"));
const out={
  stage,
  sha: require("child_process").execSync("git rev-parse HEAD",{encoding:"utf8"}).trim(),
  complete:r.complete,
  promptHash:r.promptHash,
  modelId:r.modelId,
  promptVersion:r.promptVersion,
  metrics:{
    totalCases:r.metrics.totalCases,
    completeCases:r.metrics.completeCases,
    categoryErrors:r.metrics.categoryErrors,
    urgentErrors:r.metrics.urgentErrors,
    jointErrors:r.metrics.jointErrors,
  },
  protectedRegressions:(r.protectedRegressions||[]).length,
  protectedReasons:[...new Set((r.protectedRegressions||[]).map(x=>x.reason))],
};
fs.writeFileSync(".tmp/triage-quality/reports/stage-"+stage+"-summary.json", JSON.stringify(out,null,2));
console.log(JSON.stringify(out));
if(!r.complete) process.exit(4);
' "$STAGE"

echo "STAGE_OK $(date -u +%Y-%m-%dT%H:%M:%SZ) stage=$STAGE"
