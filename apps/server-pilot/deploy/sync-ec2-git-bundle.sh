#!/usr/bin/env bash
set -euo pipefail

# Sync chosen local branch to EC2 via private S3 git bundle (no git push).
# EC2 fetches the bundle directly from S3 using its instance profile role;
# no presigned URLs are generated or persisted in SSM command history.
#
# Also: --plan-snapshot <name> stages an allowlisted no-commit release under
# /opt/nava/releases/<sourceRevision> without resetting the canonical EC2 repo.
#
# Phase B (Task 13): staged worktree may materialize registry-candidate + seed
# release-v2 under /opt/nava/shared/hms-releases/ without replacing the active
# app. Atomic source+registry CAS + rollback (exit 20 on incomplete restore) is
# owned by ops-deploy / deploy-ec2 → source-registry-cas.sh →
# runSourceRegistryTransaction crash points:
# before_source_switch | after_source_switch | before_registry_rename |
# after_registry_rename | before_pm2_restart | after_pm2_restart |
# before_health_verdict | after_health_verdict.

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${GIT_BRANCH:=main}"
: "${EC2_REPO_PATH:=/home/ubuntu/repos/zero}"
: "${BOOTSTRAP_BUCKET:=nava-zero-bootstrap-845242190536}"
: "${BUNDLE_KEY:=git-bundles/zero-${GIT_BRANCH}.bundle}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if ! [[ "$AWS_REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]] ||
  ! [[ "$BOOTSTRAP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
  ! [[ "$BUNDLE_KEY" =~ ^[A-Za-z0-9._/-]+$ ]] ||
  ! [[ "$EC2_REPO_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "error: unsafe deployment configuration" >&2
  exit 10
fi

if [ "$#" -eq 0 ]; then
  MODE="bundle-sync"
elif [ "$#" -eq 2 ] && [ "$1" = "--plan-snapshot" ]; then
  MODE="plan-snapshot"
else
  echo "usage: $0 [--plan-snapshot mail-artifact-reservation-chain]" >&2
  exit 2
fi

if [ "$MODE" = "plan-snapshot" ]; then
  PLAN_NAME="$2"
  if [ "$PLAN_NAME" != "mail-artifact-reservation-chain" ]; then
    echo "usage: $0 --plan-snapshot mail-artifact-reservation-chain" >&2
    exit 2
  fi
  ALLOWLIST="${SCRIPT_DIR}/mail-artifact-reservation-chain-files.txt"
  GATE_REPORT="${REPO_ROOT}/.superpowers/sdd/hms-read-foundation/gates/hms-read-gate-report.json"
  if [ ! -f "$ALLOWLIST" ]; then
    echo "error: missing allowlist $ALLOWLIST" >&2
    exit 10
  fi
  COMMIT_REVISION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  BASE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  for build_input in \
    apps/server-pilot/package.json \
    apps/server-pilot/tsconfig.json \
    apps/server-pilot/src/mail/artifacts/read-artifact.ts \
    apps/server-pilot/src/storage/s3.ts \
    apps/server-pilot/tests/hms-artifact.test.ts \
    apps/server-pilot/evals/hms \
    package.json \
    packages/tsconfig/base.json \
    packages/tsconfig/package.json \
    pnpm-lock.yaml \
    pnpm-workspace.yaml; do
    if ! git -C "$REPO_ROOT" diff --quiet "$BASE_COMMIT" -- "$build_input"; then
      echo "error: base build input differs from tested commit: $build_input" >&2
      exit 10
    fi
  done
  node - "$REPO_ROOT" "$ALLOWLIST" <<'NODE' || {
const fs=require("fs");
const {execFileSync}=require("child_process");
const root=process.argv[2];
const allowlist=new Set(fs.readFileSync(process.argv[3],"utf8")
  .split(/\r?\n/).map(line=>line.trim()).filter(Boolean));
const phaseB=new Set([
  "apps/server-pilot/src/mail/artifacts/read-artifact.ts",
  "apps/server-pilot/src/ops/mail-artifact-backtest.ts",
  "apps/server-pilot/src/storage/s3.ts",
  "apps/server-pilot/tests/hms-artifact.test.ts",
  "apps/server-pilot/tests/mail-artifact-backtest.test.ts",
  "apps/server-pilot/tests/s3-stream.test.ts",
]);
const scope=[
  "apps/server-pilot/src",
  "apps/server-pilot/deploy",
  "apps/server-pilot/tests",
  "apps/server-pilot/vitest.config.ts",
  "apps/server-pilot/evals/hms",
  "packages/testing",
];
const readNames=(args)=>execFileSync("git",["-C",root,...args,"--",...scope])
  .toString("utf8").split("\0").filter(Boolean);
const changed=new Set([
  ...readNames(["diff","--name-only","-z","HEAD"]),
  ...readNames(["ls-files","--others","--exclude-standard","-z"]),
]);
for(const file of changed){
  if(allowlist.has(file)||phaseB.has(file)||file.endsWith(".bak"))continue;
  process.stderr.write(`unbound release input drift: ${file}\n`);
  process.exit(1);
}
NODE
    echo "error: modified HMS release/test input is outside the Phase A allowlist" >&2
    exit 10
  }
  TRANSFER_UUID="$(node -e 'console.log(require("crypto").randomUUID())')"
  STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nava-plan-snap.XXXXXX")"
  TAR=""
  KEY=""
  SNAPSHOT_URI=""
  LIFECYCLE_ERR="$(mktemp "${TMPDIR:-/tmp}/nava-lifecycle.XXXXXX.err")"
  cleanup_snap() {
    local original_rc=$?
    local cleanup_failed=0
    trap - EXIT
    rm -rf "$STAGE_DIR" || cleanup_failed=1
    [ -z "$TAR" ] || rm -f "$TAR" || cleanup_failed=1
    rm -f "$LIFECYCLE_ERR" || cleanup_failed=1
    if [ -n "$KEY" ]; then
      aws s3api delete-object \
        --bucket "$BOOTSTRAP_BUCKET" \
        --key "$KEY" \
        --region "$AWS_REGION" >/dev/null 2>&1 || cleanup_failed=1
    fi
    if [ "$cleanup_failed" -ne 0 ]; then
      echo "HMS_FAIL code=ROLLBACK_INCOMPLETE" >&2
      exit 20
    fi
    exit "$original_rc"
  }
  trap cleanup_snap EXIT

  if LIFECYCLE_JSON="$(aws s3api get-bucket-lifecycle-configuration \
    --bucket "$BOOTSTRAP_BUCKET" --region "$AWS_REGION" --output json 2>"$LIFECYCLE_ERR")"; then
    :
  elif [[ "$(<"$LIFECYCLE_ERR")" == *NoSuchLifecycleConfiguration* ]]; then
    LIFECYCLE_JSON='{"Rules":[]}'
  else
    echo "error: source transfer lifecycle unavailable" >&2
    exit 10
  fi
  LIFECYCLE_MERGE="$(
    LIFECYCLE_JSON_VALUE="$LIFECYCLE_JSON" node -e '
const current=JSON.parse(process.env.LIFECYCLE_JSON_VALUE||"{}");
const rules=Array.isArray(current.Rules)?current.Rules:[];
const target="git-bundles/proof-source/v1/";
const desired={
  ID:"HmsProofSourceExpire1Day",
  Status:"Enabled",
  Filter:{Prefix:target},
  Expiration:{Days:1},
};
const prior=rules.find(rule=>rule.ID===desired.ID);
const valid=prior&&prior.Status==="Enabled"&&
  Object.keys(prior.Filter||{}).length===1&&prior.Filter.Prefix===target&&
  Number(prior.Expiration?.Days)===1;
const merged=valid?rules:[...rules.filter(rule=>rule.ID!==desired.ID),desired];
process.stdout.write(JSON.stringify({changed:!valid,configuration:{Rules:merged}}));
'
  )" || {
    echo "error: source transfer lifecycle invalid" >&2
    exit 10
  }
  if [ "$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).changed))' "$LIFECYCLE_MERGE")" = "true" ]; then
    LIFECYCLE_CONFIG="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).configuration))' "$LIFECYCLE_MERGE")"
    aws s3api put-bucket-lifecycle-configuration \
      --bucket "$BOOTSTRAP_BUCKET" \
      --region "$AWS_REGION" \
      --lifecycle-configuration "$LIFECYCLE_CONFIG" >/dev/null || {
      echo "error: source transfer lifecycle unavailable" >&2
      exit 10
    }
  fi
  LIFECYCLE_JSON="$(aws s3api get-bucket-lifecycle-configuration \
    --bucket "$BOOTSTRAP_BUCKET" --region "$AWS_REGION" --output json)" ||
    {
      echo "error: source transfer lifecycle unavailable" >&2
      exit 10
    }
  LIFECYCLE_JSON_VALUE="$LIFECYCLE_JSON" node -e '
const rules=JSON.parse(process.env.LIFECYCLE_JSON_VALUE||"{}").Rules||[];
const target="git-bundles/proof-source/v1/";
const valid=rules.some(r=>{
  const filter=r.Filter;
  const exactLegacy=r.Prefix===target&&filter==null;
  const exactFilter=filter!=null&&typeof filter==="object"&&
    Object.keys(filter).length===1&&filter.Prefix===target;
  return r.ID==="HmsProofSourceExpire1Day"&&
    r.Status==="Enabled"&&(exactLegacy||exactFilter)&&
    Number(r.Expiration?.Days)===1;
});
if(!valid)process.exit(1);
' || {
    echo "error: source transfer lifecycle invalid" >&2
    exit 10
  }

  echo "Staging allowlisted snapshot from $COMMIT_REVISION ..."
  # Start from committed server build closure; overlay only the fixed allowlist.
  # This excludes unrelated repo assets and all stale EC2 checkout content.
  (
    cd "$REPO_ROOT"
    git archive HEAD -- \
      apps/server-pilot/src \
      apps/server-pilot/deploy \
      apps/server-pilot/package.json \
      apps/server-pilot/tsconfig.json \
      packages/tsconfig \
      patches \
      package.json \
      pnpm-lock.yaml \
      pnpm-workspace.yaml
  ) | tar -x -C "$STAGE_DIR"
  is_phase_b_overlay() {
    case "$1" in
      apps/server-pilot/src/mail/artifacts/read-artifact.ts | \
      apps/server-pilot/src/ops/mail-artifact-backtest.ts | \
      apps/server-pilot/src/storage/s3.ts | \
      apps/server-pilot/tests/hms-artifact.test.ts | \
      apps/server-pilot/tests/mail-artifact-backtest.test.ts | \
      apps/server-pilot/tests/s3-stream.test.ts)
        return 0
        ;;
      *) return 1 ;;
    esac
  }
  node - "$REPO_ROOT" "$ALLOWLIST" <<'NODE' || {
const fs=require("fs");
const path=require("path");
const root=fs.realpathSync(process.argv[2]);
const files=fs.readFileSync(process.argv[3],"utf8")
  .split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
for(const relative of files){
  const parts=relative.split("/");
  if(path.isAbsolute(relative)||parts.some(part=>!part||part==="."||part==="..")){
    process.exit(1);
  }
  let current=root;
  for(const part of parts){
    current=path.join(current,part);
    const info=fs.lstatSync(current);
    if(info.isSymbolicLink())process.exit(1);
  }
  const real=fs.realpathSync(current);
  if(!real.startsWith(root+path.sep)||!fs.statSync(real).isFile())process.exit(1);
}
NODE
    echo "error: allowlist contains unsafe source path" >&2
    exit 10
  }
  while IFS= read -r rel || [ -n "$rel" ]; do
    rel="${rel%$'\r'}"
    [ -z "$rel" ] && continue
    case "$rel" in
      *..*|~*|/*) echo "error: unsafe path $rel" >&2; exit 10 ;;
    esac
    src="${REPO_ROOT}/${rel}"
    if [ -L "$src" ]; then
      echo "error: symlink forbidden $rel" >&2
      exit 10
    fi
    if [ ! -f "$src" ]; then
      echo "error: missing allowlisted file $rel" >&2
      exit 10
    fi
    case "$rel" in
      *.env*|*/credentials*|*/.env*) echo "error: secret-like path $rel" >&2; exit 10 ;;
    esac
    # Reservation proof is Phase A. Keep local/untracked Phase-B deltas out of
    # its immutable release; a post-G1 Phase-B front door must opt in later.
    if is_phase_b_overlay "$rel"; then
      continue
    fi
    dest="${STAGE_DIR}/${rel}"
    mkdir -p "$(dirname "$dest")"
    cp -p "$src" "$dest"
  done < "$ALLOWLIST"

  node - "$GATE_REPORT" "$REPO_ROOT" "$ALLOWLIST" "$BASE_COMMIT" <<'NODE' || {
const crypto=require("crypto");
const fs=require("fs");
const path=require("path");
const reportPath=process.argv[2];
const root=path.resolve(process.argv[3]);
const allowlist=process.argv[4];
const currentBaseCommit=process.argv[5];
const value=JSON.parse(fs.readFileSync(reportPath,"utf8"));
const timestamp=Date.parse(value.timestamp);
if(value.passed!==true||value.mode!=="--fixture-only"||
  value.testedBaseCommit!==currentBaseCommit||
  !Number.isFinite(timestamp)||Date.now()-timestamp>2*60*60*1000||
  timestamp>Date.now()+60000)process.exit(1);
const phaseB=new Set([
  "apps/server-pilot/src/mail/artifacts/read-artifact.ts",
  "apps/server-pilot/src/ops/mail-artifact-backtest.ts",
  "apps/server-pilot/src/storage/s3.ts",
  "apps/server-pilot/tests/hms-artifact.test.ts",
  "apps/server-pilot/tests/mail-artifact-backtest.test.ts",
  "apps/server-pilot/tests/s3-stream.test.ts",
]);
const files=fs.readFileSync(allowlist,"utf8").split(/\r?\n/).filter(Boolean)
  .filter((file)=>!phaseB.has(file)).sort();
const digest=crypto.createHash("sha256");
for(const relative of files){
  let file=root;
  for(const part of relative.split("/")){
    if(!part||part==="."||part==="..")process.exit(1);
    file=path.join(file,part);
    if(fs.lstatSync(file).isSymbolicLink())process.exit(1);
  }
  file=fs.realpathSync(file);
  if(!file.startsWith(root+path.sep)||!fs.statSync(file).isFile())process.exit(1);
  digest.update(relative);digest.update("\0");
  digest.update(crypto.createHash("sha256").update(fs.readFileSync(file)).digest());
}
const currentSourceSha256=digest.digest("hex");
if(currentSourceSha256!==value.testedSourceSha256)process.exit(1);
NODE
    echo "error: fresh fixture-only HMS gate report required" >&2
    exit 10
  }
  mkdir -p "${STAGE_DIR}/gate"
  cp -p "$GATE_REPORT" "${STAGE_DIR}/gate/hms-read-gate-report.json"
  (
    cd "$STAGE_DIR"
    find . -type f \
      ! -path './apps/server-pilot/dist/*' \
      ! -name MANIFEST.sha256 \
      ! -name tsconfig.tsbuildinfo \
      -print0 | sort -z | xargs -0 sha256sum
  ) > "${STAGE_DIR}/MANIFEST.sha256"
  SNAPSHOT_CONTENT_SHA256="$(sha256sum "${STAGE_DIR}/MANIFEST.sha256" | awk '{print $1}')"
  SOURCE_REVISION="phase-a-${COMMIT_REVISION}-${SNAPSHOT_CONTENT_SHA256:0:16}"
  echo "Staged content-addressed snapshot $SOURCE_REVISION"
  TAR="$(mktemp "${TMPDIR:-/tmp}/nava-snap.XXXXXX.tar.gz")"
  tar -C "$STAGE_DIR" -czf "$TAR" .
  TAR_SHA256="$(sha256sum "$TAR" | awk '{print $1}')"
  KEY="git-bundles/proof-source/v1/${TRANSFER_UUID}/snapshot.tar.gz"
  SNAPSHOT_URI="s3://${BOOTSTRAP_BUCKET}/${KEY}"
  echo "Uploading ${SNAPSHOT_URI} ..."
  aws s3 cp "$TAR" "$SNAPSHOT_URI" --region "$AWS_REGION" \
    --sse AES256
  rm -f "$TAR"
  TAR=""

  RELEASE_DIR="/opt/nava/releases/${SOURCE_REVISION}"
  REMOTE_SCRIPT="set -euo pipefail
export AWS_DEFAULT_REGION=${AWS_REGION}
export NVM_DIR=/home/ubuntu/.nvm
[ -s /home/ubuntu/.nvm/nvm.sh ] && . /home/ubuntu/.nvm/nvm.sh
for p in /opt/nava /opt/nava/releases /opt/nava/shared \
  /opt/nava/shared/hms-browser-artifacts /opt/nava/shared/hms-runtime; do
  [ ! -L \"\$p\" ] || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
done
sudo install -d -o root -g root -m 0755 /opt/nava
sudo install -d -o root -g root -m 0755 /opt/nava/releases /opt/nava/shared
sudo install -d -o ubuntu -g ubuntu -m 0700 /opt/nava/shared/hms-browser-artifacts
sudo install -d -o ubuntu -g ubuntu -m 0700 /opt/nava/shared/hms-runtime
TMP=/tmp/nava-proof-src-${TRANSFER_UUID}
STAGING=/opt/nava/releases/.staging-${TRANSFER_UUID}
FINAL=${RELEASE_DIR}
OPERATION_LOCK=/opt/nava/shared/hms-runtime/.hms-live-operation.v2.lock
OPERATION_LOCK_HELD=0
acquire_operation_lock() {
  [ ! -L \"\$OPERATION_LOCK\" ] ||
    { echo HMS_FAIL code=RUN_ISOLATION_BLOCKED; exit 10; }
  exec 8>\"\$OPERATION_LOCK\"
  flock -n 8 ||
    { echo HMS_FAIL code=RUN_ISOLATION_BLOCKED; exit 10; }
  OPERATION_LOCK_HELD=1
}
release_operation_lock() {
  [ \"\$OPERATION_LOCK_HELD\" = 1 ] || return 0
  flock -u 8
  exec 8>&-
  OPERATION_LOCK_HELD=0
}
cleanup_remote() {
  RC=\$?
  rm -rf \"\$TMP\"
  sudo rm -rf \"\$STAGING\"
  if ! release_operation_lock; then
    echo HMS_FAIL code=ROLLBACK_INCOMPLETE
    exit 20
  fi
  return \"\$RC\"
}
trap cleanup_remote EXIT
acquire_operation_lock
rm -rf \"\$TMP\"
mkdir -p \"\$TMP\"
aws s3 cp s3://${BOOTSTRAP_BUCKET}/${KEY} \"\$TMP/snapshot.tar.gz\" --region ${AWS_REGION}
printf '%s  %s\n' '${TAR_SHA256}' \"\$TMP/snapshot.tar.gz\" | sha256sum -c - >/dev/null
[ ! -L /opt/nava/releases/.publish.lock ] ||
  { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
sudo touch /opt/nava/releases/.publish.lock
sudo chown root:ubuntu /opt/nava/releases/.publish.lock
sudo chmod 0660 /opt/nava/releases/.publish.lock
exec 9<>/opt/nava/releases/.publish.lock
flock -x 9
if [ -e \"\$FINAL\" ]; then
  [ -d \"\$FINAL/worktree\" ] &&
    [ \"\$(stat -c '%U:%G' \"\$FINAL\")\" = root:root ] &&
    [ -z \"\$(find \"\$FINAL\" \\( -type f -o -type d \\) -perm /022 -print -quit)\" ] &&
    [ \"\$(cat \"\$FINAL/SOURCE_REVISION\")\" = '${SOURCE_REVISION}' ] ||
    { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
  cd \"\$FINAL/worktree\"
  sha256sum -c MANIFEST.sha256 >/dev/null
  sha256sum -c BUILD_MANIFEST.sha256 >/dev/null
  node -e 'const fs=require(\"fs\");const links=JSON.parse(fs.readFileSync(\"BUILD_SYMLINKS.json\",\"utf8\"));for(const item of links){const s=fs.lstatSync(item.path);if(!s.isSymbolicLink()||fs.readlinkSync(item.path)!==item.target)process.exit(1)}'
  [ \"\$(sha256sum MANIFEST.sha256 | awk '{print \$1}')\" = '${SNAPSHOT_CONTENT_SHA256}' ] ||
    { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
  REV_TMP=/opt/nava/shared/.nava-proof-source-revision-${TRANSFER_UUID}
  printf '%s' '${SOURCE_REVISION}' | sudo tee \"\$REV_TMP\" >/dev/null
  sudo chown root:root \"\$REV_TMP\"
  sudo chmod 0444 \"\$REV_TMP\"
  sudo mv -f \"\$REV_TMP\" /opt/nava/shared/nava-proof-source-revision
  echo NAVA_PROOF_SOURCE_REVISION=${SOURCE_REVISION}
  echo PLAN_SNAPSHOT_READY
  exit 0
fi
sudo install -d -o ubuntu -g ubuntu -m 0700 \"\$STAGING\"
WORK=\"\$STAGING/worktree\"
mkdir -p \"\$WORK\"
tar -C \"\$WORK\" -xzf \"\$TMP/snapshot.tar.gz\"
cd \"\$WORK\"
sha256sum -c MANIFEST.sha256 >/dev/null
pnpm install --frozen-lockfile --ignore-scripts --package-import-method=copy --filter @zero/server...
pnpm --filter @zero/server build
sha256sum -c MANIFEST.sha256 >/dev/null
node -e 'const fs=require(\"fs\"),path=require(\"path\");const root=fs.realpathSync(\".\");const links=[];for(const start of [\"apps/server-pilot/dist\",\"node_modules\",\"apps/server-pilot/node_modules\"]){if(!fs.existsSync(start))continue;const q=[start];while(q.length){const p=q.pop();const s=fs.lstatSync(p);if(s.isSymbolicLink()){const real=fs.realpathSync(p);if(real!==root&&!real.startsWith(root+path.sep))process.exit(1);links.push({path:p.split(path.sep).join(\"/\"),target:fs.readlinkSync(p)});continue}if(s.isDirectory())for(const n of fs.readdirSync(p))q.push(path.join(p,n));}}links.sort((a,b)=>a.path.localeCompare(b.path));fs.writeFileSync(\"BUILD_SYMLINKS.json\",JSON.stringify(links)+\"\\n\",{mode:0o600})'
find apps/server-pilot/dist node_modules apps/server-pilot/node_modules \
  -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > BUILD_MANIFEST.sha256
sha256sum BUILD_SYMLINKS.json >> BUILD_MANIFEST.sha256
[ -s BUILD_MANIFEST.sha256 ]
sha256sum -c BUILD_MANIFEST.sha256 >/dev/null
node -e 'const fs=require(\"fs\");const links=JSON.parse(fs.readFileSync(\"BUILD_SYMLINKS.json\",\"utf8\"));for(const item of links){const s=fs.lstatSync(item.path);if(!s.isSymbolicLink()||fs.readlinkSync(item.path)!==item.target)process.exit(1)}'
printf '%s' '${SOURCE_REVISION}' > \"\$STAGING/SOURCE_REVISION\"
sudo chown -R root:root \"\$STAGING\"
sudo chmod -R a+rX,a-w \"\$STAGING\"
[ -z \"\$(find \"\$STAGING\" \\( -type f -o -type d \\) -perm /022 -print -quit)\" ] ||
  { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
sudo mv -T \"\$STAGING\" \"\$FINAL\"
REV_TMP=/opt/nava/shared/.nava-proof-source-revision-${TRANSFER_UUID}
printf '%s' '${SOURCE_REVISION}' | sudo tee \"\$REV_TMP\" >/dev/null
sudo chown root:root \"\$REV_TMP\"
sudo chmod 0444 \"\$REV_TMP\"
sudo mv -f \"\$REV_TMP\" /opt/nava/shared/nava-proof-source-revision
rm -rf \"\$TMP\"
echo NAVA_PROOF_SOURCE_REVISION=${SOURCE_REVISION}
echo PLAN_SNAPSHOT_READY
"

  export SSM_DELIVERY_TIMEOUT_SECONDS=60
  export SSM_EXECUTION_TIMEOUT_SECONDS=900
  export SSM_MAX_POLL_SECONDS=1200
  bash "$SCRIPT_DIR/ssm-run-command.sh" "$REMOTE_SCRIPT"
  echo "Plan snapshot staged: $SOURCE_REVISION"
  exit 0
fi

BUNDLE_FILE="$(mktemp "${TMPDIR:-/tmp}/zero-git-bundle.XXXXXX.bundle")"
cleanup() { rm -f "$BUNDLE_FILE"; }
trap cleanup EXIT

cd "$REPO_ROOT"

if ! git check-ref-format --branch "$GIT_BRANCH" >/dev/null 2>&1; then
  echo "error: branch $GIT_BRANCH not found in $REPO_ROOT" >&2
  exit 1
fi

# The bundle ships local refs/heads/$GIT_BRANCH, not origin. A stale or unpushed
# local branch would deploy the wrong commit, so it must match origin first.
if [ "${ALLOW_UNPUSHED_DEPLOY:-0}" != "1" ]; then
  if ! GIT_TERMINAL_PROMPT=0 git fetch -q origin "+refs/heads/$GIT_BRANCH:refs/remotes/origin/$GIT_BRANCH"; then
    echo "error: cannot fetch origin/$GIT_BRANCH to check the deploy branch (ALLOW_UNPUSHED_DEPLOY=1 skips this check)" >&2
    exit 1
  fi
  LOCAL_COMMIT="$(git rev-parse --verify --quiet "refs/heads/$GIT_BRANCH^{commit}" || true)"
  ORIGIN_COMMIT="$(git rev-parse --verify --quiet "refs/remotes/origin/$GIT_BRANCH^{commit}" || true)"
  if [ -z "$LOCAL_COMMIT" ] || [ "$LOCAL_COMMIT" != "$ORIGIN_COMMIT" ]; then
    echo "error: local $GIT_BRANCH (${LOCAL_COMMIT:0:9}) does not match origin/$GIT_BRANCH (${ORIGIN_COMMIT:0:9})" >&2
    echo "  update it first: git fetch origin $GIT_BRANCH:$GIT_BRANCH (ALLOW_UNPUSHED_DEPLOY=1 skips this check)" >&2
    exit 1
  fi
fi

echo "Creating git bundle for $GIT_BRANCH..."
git bundle create "$BUNDLE_FILE" "refs/heads/$GIT_BRANCH"

BUNDLE_LINE="$(git bundle list-heads "$BUNDLE_FILE" "refs/heads/$GIT_BRANCH")"
BUNDLE_COMMIT="${BUNDLE_LINE%% *}"
BUNDLE_HEAD="${BUNDLE_LINE#* }"
if [ "$BUNDLE_HEAD" != "refs/heads/$GIT_BRANCH" ] ||
  ! git rev-parse --verify --quiet "$BUNDLE_COMMIT^{commit}" >/dev/null; then
  echo "error: branch $GIT_BRANCH not found in $REPO_ROOT" >&2
  exit 1
fi
# The bundle re-reads the branch by name; refuse if it moved after the origin check.
if [ "${ALLOW_UNPUSHED_DEPLOY:-0}" != "1" ] && [ "$BUNDLE_COMMIT" != "$LOCAL_COMMIT" ]; then
  echo "error: $GIT_BRANCH moved during bundle creation; rerun the deploy" >&2
  exit 1
fi

if ! aws s3api head-bucket --bucket "$BOOTSTRAP_BUCKET" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "Creating private bootstrap bucket s3://$BOOTSTRAP_BUCKET ..."
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BOOTSTRAP_BUCKET" --region "$AWS_REGION"
  else
    aws s3api create-bucket \
      --bucket "$BOOTSTRAP_BUCKET" \
      --region "$AWS_REGION" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION"
  fi
  aws s3api put-public-access-block \
    --bucket "$BOOTSTRAP_BUCKET" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption \
    --bucket "$BOOTSTRAP_BUCKET" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
fi

echo "Uploading bundle to s3://$BOOTSTRAP_BUCKET/$BUNDLE_KEY ..."
aws s3 cp "$BUNDLE_FILE" "s3://$BOOTSTRAP_BUCKET/$BUNDLE_KEY" --region "$AWS_REGION"

REMOTE_BUNDLE="/tmp/zero-git-bundle-$$.bundle"
printf -v Q_REMOTE_BUNDLE '%q' "$REMOTE_BUNDLE"
printf -v Q_REPO_PATH '%q' "$EC2_REPO_PATH"
printf -v Q_GIT_BRANCH '%q' "$GIT_BRANCH"
printf -v Q_BUNDLE_REF '%q' "refs/remotes/bundle/${GIT_BRANCH}"
printf -v Q_BUNDLE_REFSPEC '%q' "+refs/heads/${GIT_BRANCH}:refs/remotes/bundle/${GIT_BRANCH}"
printf -v Q_BUNDLE_COMMIT '%q' "$BUNDLE_COMMIT"
printf -v Q_BUNDLE_URI '%q' "s3://${BOOTSTRAP_BUCKET}/${BUNDLE_KEY}"
printf -v Q_AWS_REGION '%q' "$AWS_REGION"
REMOTE_SCRIPT="set -euo pipefail; export AWS_DEFAULT_REGION=${Q_AWS_REGION}; export NVM_DIR=/home/ubuntu/.nvm; [ -s /home/ubuntu/.nvm/nvm.sh ] && . /home/ubuntu/.nvm/nvm.sh; aws s3 cp ${Q_BUNDLE_URI} ${Q_REMOTE_BUNDLE} --region ${Q_AWS_REGION}; mkdir -p /home/ubuntu/repos; if [ -d ${Q_REPO_PATH}/.git ]; then cd ${Q_REPO_PATH}; git fetch ${Q_REMOTE_BUNDLE} ${Q_BUNDLE_REFSPEC}; [ \"\$(git rev-parse --verify --quiet ${Q_BUNDLE_REF}^{commit})\" = ${Q_BUNDLE_COMMIT} ] || { echo \"error: bundle commit mismatch\" >&2; exit 1; }; git checkout -f -B ${Q_GIT_BRANCH} ${Q_BUNDLE_COMMIT}; git reset --hard ${Q_BUNDLE_COMMIT}; else git init ${Q_REPO_PATH}; cd ${Q_REPO_PATH}; git fetch ${Q_REMOTE_BUNDLE} ${Q_BUNDLE_REFSPEC}; [ \"\$(git rev-parse --verify --quiet ${Q_BUNDLE_REF}^{commit})\" = ${Q_BUNDLE_COMMIT} ] || { echo \"error: bundle commit mismatch\" >&2; exit 1; }; git checkout -f -B ${Q_GIT_BRANCH} ${Q_BUNDLE_COMMIT}; git reset --hard ${Q_BUNDLE_COMMIT}; fi; rm -f ${Q_REMOTE_BUNDLE}; git status --short --branch; git log -1 --oneline; node --version; pnpm --version"

echo "Deploying bundle to EC2 via SSM (instance-profile S3 access)..."
bash "$SCRIPT_DIR/ssm-run-command.sh" "$REMOTE_SCRIPT"

echo "Bundle sync complete."
