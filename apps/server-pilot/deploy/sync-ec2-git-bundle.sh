#!/usr/bin/env bash
set -euo pipefail

# Sync local EC2-pilot branch to EC2 via private S3 git bundle (no git push).
# EC2 fetches the bundle directly from S3 using its instance profile role;
# no presigned URLs are generated or persisted in SSM command history.

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${GIT_BRANCH:=EC2-pilot}"
: "${EC2_REPO_PATH:=/home/ubuntu/repos/zero}"
: "${BOOTSTRAP_BUCKET:=nava-zero-bootstrap-845242190536}"
: "${BUNDLE_KEY:=git-bundles/zero-EC2-pilot.bundle}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BUNDLE_FILE="$(mktemp "${TMPDIR:-/tmp}/zero-${GIT_BRANCH}.XXXXXX.bundle")"
cleanup() { rm -f "$BUNDLE_FILE"; }
trap cleanup EXIT

cd "$REPO_ROOT"

if ! git rev-parse --verify "$GIT_BRANCH" >/dev/null 2>&1; then
  echo "error: branch $GIT_BRANCH not found in $REPO_ROOT" >&2
  exit 1
fi

echo "Creating git bundle for $GIT_BRANCH..."
git bundle create "$BUNDLE_FILE" "$GIT_BRANCH"

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

# EC2 pulls the bundle from S3 via its instance profile role (no presigned URL).
# In-place update if repo exists (preserves node_modules + untracked work);
# fresh clone only when repo absent.
# Paths are inlined (no shell vars) because ssm-run-command.sh wraps the script
# in `bash -lc "..."`, which would expand ${vars} before the inner assignment runs.
REMOTE_BUNDLE="/tmp/zero-${GIT_BRANCH}.bundle"
REMOTE_SCRIPT="set -euo pipefail; export AWS_DEFAULT_REGION=af-south-1; export NVM_DIR=/home/ubuntu/.nvm; [ -s /home/ubuntu/.nvm/nvm.sh ] && . /home/ubuntu/.nvm/nvm.sh; aws s3 cp s3://${BOOTSTRAP_BUCKET}/${BUNDLE_KEY} ${REMOTE_BUNDLE} --region ${AWS_REGION}; mkdir -p /home/ubuntu/repos; if [ -d ${EC2_REPO_PATH}/.git ]; then cd ${EC2_REPO_PATH}; git fetch ${REMOTE_BUNDLE} '+refs/heads/*:refs/remotes/bundle/*'; git checkout ${GIT_BRANCH}; git reset --hard bundle/${GIT_BRANCH}; else git clone ${REMOTE_BUNDLE} ${EC2_REPO_PATH}; cd ${EC2_REPO_PATH}; git checkout ${GIT_BRANCH}; fi; rm -f ${REMOTE_BUNDLE}; git status --short --branch; git log -1 --oneline; node --version; pnpm --version"

echo "Deploying bundle to EC2 via SSM (instance-profile S3 access)..."
bash "$SCRIPT_DIR/ssm-run-command.sh" "$REMOTE_SCRIPT"

echo "Bundle sync complete."
