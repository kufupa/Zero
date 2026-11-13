#!/usr/bin/env bash
# Transfer only approved HRCEN artifacts through the private bootstrap bucket.
set -euo pipefail
: "${AWS_REGION:=af-south-1}"
: "${BOOTSTRAP_BUCKET:=nava-zero-bootstrap-845242190536}"
: "${EC2_REPO_PATH:=/home/ubuntu/repos/zero}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
expected_commit="$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}')"
[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ] || { echo 'local checkout has tracked changes' >&2; exit 2; }
if [ "$#" -eq 0 ]; then
  echo "usage: $0 --catalog FILE --observations FILE --pms FILE [--outbound FILE] [--party FILE]" >&2
  exit 2
fi
[[ "$AWS_REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]] &&
  [[ "$BOOTSTRAP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] &&
  [[ "$EC2_REPO_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] &&
  [[ "/$EC2_REPO_PATH/" != *'/../'* ]] && [[ "/$EC2_REPO_PATH/" != *'/./'* ]] || {
    echo 'unsafe deployment configuration' >&2; exit 2;
  }
umask 077
stage="$(mktemp -d "${TMPDIR:-/tmp}/centurion-artifacts.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
manifest_sha="$(node "$SCRIPT_DIR/centurion-artifact-manifest.mjs" prepare "$stage" "$@")"
[[ "$manifest_sha" =~ ^[a-f0-9]{64}$ ]] || exit 2
block="$(aws s3api get-public-access-block --bucket "$BOOTSTRAP_BUCKET" --region "$AWS_REGION" --output json)"
node -e 'const b=JSON.parse(process.argv[1]).PublicAccessBlockConfiguration;if(!b||!["BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets"].every(k=>b[k]===true))process.exit(1)' "$block" || {
  echo 'bootstrap bucket public access block incomplete' >&2; exit 2;
}
prefix="git-bundles/centurion-runtime-artifacts/v1/$manifest_sha"
files=(catalogs.json observations.jsonl pms.json)
[ ! -f "$stage/outbound.jsonl" ] || files+=(outbound.jsonl)
[ ! -f "$stage/party-index.json" ] || files+=(party-index.json)
for file in "${files[@]}" manifest.json; do
  aws s3 cp "$stage/$file" "s3://$BOOTSTRAP_BUCKET/$prefix/$file" --region "$AWS_REGION" --sse AES256 --only-show-errors
done
printf -v repo_q '%q' "$EC2_REPO_PATH"
printf -v bucket_q '%q' "$BOOTSTRAP_BUCKET"
printf -v region_q '%q' "$AWS_REGION"
printf -v prefix_q '%q' "$prefix"
printf -v sha_q '%q' "$manifest_sha"
printf -v commit_q '%q' "$expected_commit"
printf -v files_q '%q ' "${files[@]}"
REMOTE_COMMAND="set -euo pipefail
repo=$repo_q
bucket=$bucket_q
region=$region_q
prefix=$prefix_q
expected=$sha_q
commit=$commit_q
[ -d \"\$repo/.git\" ] && [ \"\$(git -C \"\$repo\" rev-parse --show-toplevel)\" = \"\$repo\" ] || { echo 'configured EC2 checkout missing' >&2; exit 2; }
exec 9>>/home/ubuntu/.nava-deploy.lock
flock -x 9
[ \"\$(git -C \"\$repo\" rev-parse --verify 'HEAD^{commit}')\" = \"\$commit\" ] || { echo 'remote checkout SHA differs' >&2; exit 2; }
private=\"\$repo/apps/server-pilot/.private\"
owned=\"\$private/centurion-runtime-artifacts\"
for dir in \"\$repo/apps/server-pilot\" \"\$private\" \"\$owned\" \"\$owned/releases\"; do
  [ ! -L \"\$dir\" ] || { echo 'artifact parent symlink forbidden' >&2; exit 2; }
  [ -e \"\$dir\" ] || mkdir -m 700 -- \"\$dir\"
  [ -d \"\$dir\" ] && [ \"\$(stat -c '%U' \"\$dir\")\" = ubuntu ] || { echo 'unsafe artifact directory' >&2; exit 2; }
done
umask 077
stage=\"\$(mktemp -d \"\$owned/releases/.stage.XXXXXX\")\"
link=\"\$owned/.current.\$(basename \"\$stage\")\"
cleanup() { rm -rf -- \"\$stage\"; rm -f -- \"\$link\"; }
trap cleanup EXIT
aws s3 cp \"s3://\$bucket/\$prefix/manifest.json\" \"\$stage/manifest.json\" --region \"\$region\" --only-show-errors
[ \"\$(sha256sum \"\$stage/manifest.json\" | cut -d' ' -f1)\" = \"\$expected\" ] || { echo 'manifest checksum mismatch' >&2; exit 2; }
for file in $files_q; do
  aws s3 cp \"s3://\$bucket/\$prefix/\$file\" \"\$stage/\$file\" --region \"\$region\" --only-show-errors
done
node \"\$repo/apps/server-pilot/deploy/centurion-artifact-manifest.mjs\" verify \"\$stage\"
current=\"\$owned/current\"
if [ -e \"\$current\" ] || [ -L \"\$current\" ]; then
  [ -L \"\$current\" ] || { echo 'current path is not owned symlink' >&2; exit 2; }
  old=\"\$(readlink \"\$current\")\"
  [[ \"\$old\" =~ ^releases/[a-f0-9]{64}$ ]] || { echo 'current target is not an owned release' >&2; exit 2; }
  for optional in outbound.jsonl party-index.json; do
    [ ! -f \"\$owned/\$old/\$optional\" ] || [ -f \"\$stage/\$optional\" ] || { echo 'existing optional artifact omitted' >&2; exit 2; }
  done
fi
final=\"\$owned/releases/\$expected\"
if [ -e \"\$final\" ] || [ -L \"\$final\" ]; then
  [ -d \"\$final\" ] && [ ! -L \"\$final\" ] && [ \"\$(sha256sum \"\$final/manifest.json\" | cut -d' ' -f1)\" = \"\$expected\" ] || { echo 'existing release conflict' >&2; exit 2; }
  node \"\$repo/apps/server-pilot/deploy/centurion-artifact-manifest.mjs\" verify \"\$final\"
else
  mv -T -- \"\$stage\" \"\$final\"
fi
ln -s -- \"releases/\$expected\" \"\$link\"
mv -Tf -- \"\$link\" \"\$current\"
printf 'activated=%s manifest_sha256=%s\\n' \"\$current\" \"\$expected\"
"
SSM_EXECUTION_TIMEOUT_SECONDS=900 SSM_MAX_POLL_SECONDS=1000 bash "$SCRIPT_DIR/ssm-run-command.sh" "$REMOTE_COMMAND"
echo "private release s3://$BOOTSTRAP_BUCKET/$prefix/"
echo "runtime paths: $EC2_REPO_PATH/apps/server-pilot/.private/centurion-runtime-artifacts/current/{catalogs.json,observations.jsonl,pms.json,outbound.jsonl,party-index.json}"
echo 'Run set-ec2-runtime-controls.sh on EC2 with the relevant paths, then ops-restart.sh.'
