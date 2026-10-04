# AWS Resources — NAVA Zero server-pilot

Provisioned AWS resources for the mail pilot. All created via AWS CLI from laptop on branch `EC2-pilot`.

## Identifiers

| Resource | Value |
|----------|-------|
| Account | `845242190536` |
| Region | `af-south-1` |
| VPC | `vpc-0f078e17a5f0f8599` (default VPC) |
| EC2 instance | `i-008f737974a9ba9b3` |
| EC2 instance profile role | `nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU` |
| EC2 SG (source for RDS ingress) | `sg-00190151691bd66fa` (`nava-prod-public-ipv4-WorkerSecurityGroup-tYMRcvjFke7X`) |
| RDS instance identifier | `nava-zero-mail-pilot` |
| RDS endpoint | `nava-zero-mail-pilot.cpuaauo4kfyd.af-south-1.rds.amazonaws.com` |
| RDS port | `5432` |
| RDS class | `db.t4g.medium` |
| RDS engine | `postgres 16` |
| RDS storage | `gp3 100GB`, storage-encrypted |
| RDS backup retention | `7` days |
| RDS publicly accessible | `false` |
| RDS DB name | `zero` |
| RDS admin user | `zero_admin` |
| RDS SG | `sg-0fbe865a67165678c` (`nava-zero-rds`) |
| RDS subnet group | `nava-zero-mail` (subnets `subnet-0e6446aaaeaa8762e` af-south-1a + `subnet-094bf8643d98c22f6` af-south-1b) |
| Secrets Manager secret name | `nava-zero/server-pilot/database-url` |
| Secret ARN | `arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/database-url-RsBcd2` |
| Secret contents | JSON `{"DATABASE_URL":"postgres://zero_admin:<redacted>@nava-zero-mail-pilot.cpuaauo4kfyd.af-south-1.rds.amazonaws.com:5432/zero"}` |
| S3 mail bucket | `nava-zero-mail-845242190536-af-south-1` |
| S3 SSE | AES256 |
| S3 public access block | all 4 blocks enabled (private) |
| S3 lifecycle | Retain `raw-mime/*`, `attachments/*` and `outlook-sync-originals/v1/*` indefinitely; transition eligible objects to Intelligent-Tiering after 30d. Incomplete multipart abort 1d; temporary `hms-browser-proof-transfer/v1/*` expire 1d; uncommitted `outlook-sync-staging/v1/*` expire 7d. |
| S3 CORS | Cutover overlap: canonical + legacy + localhost GET/HEAD. Final after 24h: canonical + localhost GET/HEAD; legacy removed. No wildcard origins. |
| Bootstrap bucket (Task 1) | `nava-zero-bootstrap-845242190536` |

## EC2 instance profile inline policies

| Policy name | Grants |
|-------------|-------|
| `NavaZeroBootstrapBundleRead` (Task 1) | `s3:GetObject` on `nava-zero-bootstrap-845242190536/git-bundles/*`, `vpn-nava/*`, and `mail-navaai/*`; `s3:ListBucket` on bootstrap bucket (prefixes `git-bundles/*`, `vpn-nava/*`, `mail-navaai/*`) |
| `NavaZeroMailBucketAccess` | `s3:ListBucket` / `s3:GetBucketLocation` / `s3:ListBucketMultipartUploads` on mail bucket; `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` / `s3:AbortMultipartUpload` / `s3:ListMultipartUploadParts` on mail bucket `/*` |
| `NavaZeroSecretsRead` | `secretsmanager:GetSecretValue` / `secretsmanager:DescribeSecret` on `nava-zero/server-pilot/database-url-*`, `nava-zero/server-pilot/infor-hms-read-*`, and `nava-zero/server-pilot/hms-evidence-hmac-*` |
| `NavaZeroRDSConnect` | `rds-db:connect` on `dbuser:nava-zero-mail-pilot/zero_admin` (for future IAM DB auth; password auth used today via SG routing) |
| `NavaZeroBedrockInvoke` | `bedrock:InvokeModel` on `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0`; optional `bedrock:ApplyGuardrail` when guardrail env vars set |

## asm-exec digests (Phase B evidence bootstrap)

Vendored `apps/server-pilot/deploy/vendor/asm-exec` is CRLF on purpose (`.gitattributes -text`). Install strips CR before `/usr/local/bin/asm-exec`.

| Pin | Bytes | SHA-256 |
|-----|-------|---------|
| Vendor SRC (`ASM_EXEC_PIN` / `DEFAULT_PIN`) | CRLF vendor file | `5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f` |
| Installed (`ASM_EXEC_INSTALLED_SHA256`) | LF after `tr -d '\r'` | `81fd29e1f039209282bc8cbe482cda033d331f07284533a46f990368228a7e65` |

Derive installed pin: `tr -d '\r' < apps/server-pilot/deploy/vendor/asm-exec | sha256sum`. Provision remote, `install-hms-browser.sh`, and scoped doctor verify both digests.

Run from repo root on laptop. The password is generated locally and never printed; it is written to a 600-mode temp file then to Secrets Manager.

```bash
export AWS_REGION=af-south-1
export DB_ID=nava-zero-mail-pilot
export DB_NAME=zero
export DB_ADMIN_USER=zero_admin
export DB_SECRET_NAME=nava-zero/server-pilot/database-url

# 1. RDS SG + ingress from EC2 SG (skip if SG already exists)
RDS_SG_ID="$(aws ec2 describe-security-groups --region "$AWS_REGION" --filters "Name=group-name,Values=nava-zero-rds" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)"
if [ -z "$RDS_SG_ID" ] || [ "$RDS_SG_ID" = "None" ]; then
  RDS_SG_ID="$(aws ec2 create-security-group --region "$AWS_REGION" --group-name nava-zero-rds --description "RDS Postgres for NAVA Zero" --vpc-id vpc-0f078e17a5f0f8599 --query 'GroupId' --output text)"
fi
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$RDS_SG_ID" --protocol tcp --port 5432 --source-group sg-00190151691bd66fa || true

# 2. Subnet group (needs >=2 subnets in different AZs)
RDS_SUBNET_IDS="$(aws ec2 describe-subnets --region "$AWS_REGION" --filters "Name=vpc-id,Values=vpc-0f078e17a5f0f8599" --query 'Subnets | sort_by(@, &AvailabilityZone)[].SubnetId | [0:2]' --output text | tr '\t' ' ' | tr -s ' ')"
test "$(wc -w <<< "$RDS_SUBNET_IDS")" -ge 2
aws rds create-db-subnet-group --region "$AWS_REGION" --db-subnet-group-name nava-zero-mail --db-subnet-group-description "NAVA Zero mail pilot" --subnet-ids $RDS_SUBNET_IDS || true

# 3. RDS instance (skip if exists); password saved to 600 temp file
if ! aws rds describe-db-instances --region "$AWS_REGION" --db-instance-identifier "$DB_ID" >/dev/null 2>&1; then
  DB_ADMIN_PASSWORD="$(openssl rand -base64 36 | tr -d '\n+/=' | head -c 32)"
  aws rds create-db-instance \
    --region "$AWS_REGION" \
    --db-instance-identifier "$DB_ID" \
    --db-instance-class db.t4g.medium \
    --engine postgres --engine-version 16 \
    --allocated-storage 100 --storage-type gp3 --storage-encrypted \
    --db-name "$DB_NAME" \
    --master-username "$DB_ADMIN_USER" \
    --master-user-password "$DB_ADMIN_PASSWORD" \
    --vpc-security-group-ids "$RDS_SG_ID" \
    --db-subnet-group-name nava-zero-mail \
    --backup-retention-period 7 \
    --no-publicly-accessible
  umask 077
  printf '%s' "$DB_ADMIN_PASSWORD" > /tmp/nava-zero-db-pw.tmp
  chmod 600 /tmp/nava-zero-db-pw.tmp
fi
aws rds wait db-instance-available --region "$AWS_REGION" --db-instance-identifier "$DB_ID"

# 4. Secrets Manager (create or rotate)
DB_ENDPOINT="$(aws rds describe-db-instances --region "$AWS_REGION" --db-instance-identifier "$DB_ID" --query 'DBInstances[0].Endpoint.Address' --output text)"
DB_ADMIN_PASSWORD="$(cat /tmp/nava-zero-db-pw.tmp)"
DATABASE_URL="postgres://${DB_ADMIN_USER}:${DB_ADMIN_PASSWORD}@${DB_ENDPOINT}:5432/${DB_NAME}"
aws secretsmanager create-secret --region "$AWS_REGION" --name "$DB_SECRET_NAME" --description "NAVA Zero server-pilot DATABASE_URL" --secret-string "{\"DATABASE_URL\":\"${DATABASE_URL}\"}" \
  || aws secretsmanager put-secret-value --region "$AWS_REGION" --secret-id "$DB_SECRET_NAME" --secret-string "{\"DATABASE_URL\":\"${DATABASE_URL}\"}"

# 5. S3 mail bucket (SSE, private, lifecycle for raw-mime/attachments)
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
NAVA_MAIL_BUCKET="nava-zero-mail-${AWS_ACCOUNT_ID}-af-south-1"
aws s3api create-bucket --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --create-bucket-configuration LocationConstraint=af-south-1 || true
aws s3api put-public-access-block --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-lifecycle-configuration --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --transition-default-minimum-object-size all_storage_classes_128K --lifecycle-configuration '{"Rules":[{"ID":"archive-raw-mime-30d","Status":"Enabled","Filter":{"Prefix":"raw-mime/"},"Transitions":[{"Days":30,"StorageClass":"INTELLIGENT_TIERING"}]},{"ID":"archive-attachments-30d","Status":"Enabled","Filter":{"Prefix":"attachments/"},"Transitions":[{"Days":30,"StorageClass":"INTELLIGENT_TIERING"}]},{"ID":"archive-outlook-sync-originals-30d","Status":"Enabled","Filter":{"Prefix":"outlook-sync-originals/v1/"},"Transitions":[{"Days":30,"StorageClass":"INTELLIGENT_TIERING"}]},{"ID":"outlook-sync-staging-expire-7d","Status":"Enabled","Filter":{"Prefix":"outlook-sync-staging/v1/"},"Expiration":{"Days":7},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}},{"ID":"abort-incomplete-multipart-1d","Status":"Enabled","Filter":{"Prefix":""},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}},{"ID":"HmsBrowserProofTransferExpire1Day","Status":"Enabled","Filter":{"Prefix":"hms-browser-proof-transfer/v1/"},"Expiration":{"Days":1}}]}'
# Proof wrappers semantically merge/read back this named rule; never replace
# unrelated lifecycle rules during ordinary proof operation.
# Browser attachment fetch and catch-up upload. Origin allowlist only — never *.
aws s3api put-bucket-cors --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://nava.legacyhotels.co.za","https://nava.legacy.local","http://localhost:3000","https://localhost:3000"],"AllowedMethods":["GET","HEAD","PUT"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Disposition","Content-Type","Content-Length","ETag"],"MaxAgeSeconds":300},{"AllowedOrigins":["https://nava-admin.trynava.io"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Disposition","Content-Type","Content-Length"],"MaxAgeSeconds":300},{"AllowedOrigins":["https://nava-admin.trynava.io"],"AllowedMethods":["PUT"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Disposition","Content-Type","Content-Length","ETag"],"MaxAgeSeconds":300}]}'

# 6. EC2 instance role inline policies
ROLE=nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroMailBucketAccess --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation","s3:ListBucketMultipartUploads"],"Resource":"arn:aws:s3:::'"$NAVA_MAIL_BUCKET"'"},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":"arn:aws:s3:::'"$NAVA_MAIL_BUCKET"'/*"}]}'
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroSecretsRead --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"],"Resource":["arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/database-url-*","arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/infor-hms-read-*","arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/hms-evidence-hmac-*"]}]}'
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroRDSConnect --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["rds-db:connect"],"Resource":"arn:aws:rds:af-south-1:845242190536:dbuser:nava-zero-mail-pilot/zero_admin"}]}'
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroBedrockInvoke --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel"],"Resource":"arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0"}]}'
```

## Mail retention and storage tiering

Since 2026-10-03, original MIME files and attachments have **no lifecycle expiration**.
These original prefixes transition eligible objects to S3 Intelligent-Tiering at 30 days of object age,
not the email sent/received date. RDS message bodies, metadata and S3 keys remain in place;
this policy does not move Outlook mail to an Archive folder or purge database rows.

Intelligent-Tiering starts in Frequent Access, then automatically moves unaccessed objects
to Infrequent Access after 30 days in that tier and Archive Instant Access after 90 days.
Do not enable optional Archive Access / Deep Archive Access: they require asynchronous
restores, which normal attachment and EML downloads do not support. Objects below 128 KiB
remain in Standard under the lifecycle minimum-size default; they are still retained.
Tier transitions are asynchronous and do not restore files already deleted by legacy rules.

The bootstrap command above is for initial provisioning. On an existing bucket, read and
back up the complete lifecycle configuration, replace only the named mail rules, preserve
unrelated rules and `TransitionDefaultMinimumObjectSize`, then read back and verify.
Temporary proof transfers and incomplete multipart uploads are not retained email data;
their one-day cleanup remains enabled. Any future committed mailbox-sync object prefix
must use the same no-expiration retention policy; abandoned staging uploads are separate.

Outlook sync uploads use `outlook-sync-staging/v1/<scope-hash>/<attempt-uuid>` and are
checksum/length bound. Expire unaccepted staging after seven days and abort incomplete
multipart after one day. Sealing streams the verified staging version into
`outlook-sync-originals/v1/<scope-hash>/<sha256>` with conditional completion; those
keys are never presigned for writes and have no expiration or restore-required tier.
A late staging overwrite or staging cleanup cannot change a sealed accepted original.
Server IAM retains GetObject, PutObject, ListMultipartUploadParts and
AbortMultipartUpload within these prefixes. Grant URLs expire within the staff/read
lease, at most five minutes. No additional public bucket or CORS origin is required.

Apply the additive sync lifecycle rules only in the separately authorized release:
read the current bucket policy, preserve existing rules and the transition minimum,
append the exact original/staging rules above, verify no enabled expiration or Glacier
rule overlaps any retained original prefix, and verify readback. A global deletion
rule also overlaps originals and must fail the retention guard. Do not replace the
existing policy with this bootstrap example on a live bucket.

## S3 CORS cutover states

Browser attachment fetches use one CORS rule so each allowed origin receives both required methods.

1. **Cutover overlap:** allow `https://nava.legacyhotels.co.za`, `https://nava.legacy.local`, `http://localhost:3000`, and `https://localhost:3000` with `GET` and `HEAD`.
2. **Final state after 24 hours:** allow `https://nava.legacyhotels.co.za`, `http://localhost:3000`, and `https://localhost:3000` with `GET` and `HEAD`. Remove `https://nava.legacy.local`.

Never use `*` in `AllowedOrigins`. Do not split the canonical origin and its `GET`/`HEAD` methods across different rules.

For either transition:

1. **Read before write:** save `aws s3api get-bucket-cors --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --output json` to a mode-600 temporary file.
2. Apply the intended complete CORS document.
3. **Immediate readback:** run the same `get-bucket-cors` command, then semantically compare the returned rule with the intended origins and methods. `launch-readiness.sh` must report `s3CorsCanonical=true`.
4. Preserve that successful readback as the applied-state snapshot.
5. **Compare before rollback:** read current CORS again and compare it with the applied-state snapshot. If they differ, stop because another operator changed the bucket. Only when they match may the saved pre-write document be restored, followed by another immediate readback.

These snapshots contain bucket configuration only. Do not include S3 object keys, environment values, credentials, or mail data in readiness output.

## Remote admin ALB: gated operator procedure

This procedure is deliberately split by human gates. It is not a bootstrap shortcut. Legacy `nava.legacyhotels.co.za:443 -> 127.0.0.1:8788` remains internal-DNS plus `tun0:443`; do not add legacy security-group ingress, public DNS, or remote process traffic to legacy `:443`.

All commands accept only account-scoped resource IDs or ARNs discovered during read-only preflight. They never print secret values.

### Fixed names and preflight facts

```bash
set -euo pipefail
set +x

is_windows_shell() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

aws_file_uri() {
  local path="$1"
  local converted_path
  if is_windows_shell; then
    command -v cygpath >/dev/null 2>&1 || return 1
    converted_path="$(cygpath -w -- "$path")" || return 1
    converted_path="${converted_path//\\//}"
    [[ "$converted_path" =~ ^[A-Za-z]:/ ]] || return 1
    printf 'file://%s\n' "$converted_path"
    return 0
  fi
  [[ "$path" == /* ]] || return 1
  printf 'file://%s\n' "$path"
}

export AWS_REGION=af-south-1
export AWS_ACCOUNT_ID=845242190536
export VPC_ID=vpc-0f078e17a5f0f8599
export INSTANCE_ID=i-008f737974a9ba9b3
export REMOTE_TARGET_PRIVATE_IP=172.31.12.112
export REMOTE_ALB_SUBNET_A=subnet-0e6446aaaeaa8762e
export REMOTE_ALB_SUBNET_B=subnet-094bf8643d98c22f6
export REMOTE_ADMIN_HOST=nava-admin.trynava.io
export REMOTE_ALB_NAME=nava-remote-admin-alb
export REMOTE_TARGET_GROUP_NAME=nava-remote-admin
export REMOTE_TARGET_SECURITY_GROUP_NAME=nava-remote-admin-target
export REMOTE_WAF_NAME=nava-remote-admin-waf
export REMOTE_LOG_BUCKET=nava-zero-remote-alb-logs-845242190536-af-south-1
export REMOTE_AUTH_SECRET_NAME=nava-zero/server-pilot/remote-auth
export REMOTE_ROLE_NAME=nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU

umask 077
: "${EVIDENCE_ROOT:=${HOME}/.nava-evidence/remote-admin}"
EVIDENCE_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p -- "$EVIDENCE_ROOT"
chmod 700 -- "$EVIDENCE_ROOT"
EVIDENCE_DIR="$(mktemp -d "${EVIDENCE_ROOT%/}/${EVIDENCE_TIMESTAMP}-preflight.XXXXXX")"
chmod 700 -- "$EVIDENCE_DIR"

PREFLIGHT_SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nava-remote-admin-preflight.XXXXXX")"
chmod 700 -- "$PREFLIGHT_SCRATCH_DIR"
cleanup_preflight_scratch() {
  rm -rf -- "$PREFLIGHT_SCRATCH_DIR"
}
trap cleanup_preflight_scratch EXIT
```

Use `$(aws_file_uri "$PATH")` for every AWS CLI file argument below. It converts Git-Bash paths to an AWS CLI-compatible Windows file URI; do not substitute a raw `file://` path.

Before any mutation, run only these read calls. `EVIDENCE_DIR` is persistent, timestamped mode-0700 evidence containing sanitized mode-0600 metadata only. Every raw AWS response stays in mode-0700 `PREFLIGHT_SCRATCH_DIR`, which is deleted on failure by its EXIT trap and after successful preflight. Never write addresses, raw AWS responses, credentials, environment values, mail data, or secrets into `EVIDENCE_DIR`.

```bash
aws sts get-caller-identity --output json >"$PREFLIGHT_SCRATCH_DIR/identity.json"
aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --output json >"$PREFLIGHT_SCRATCH_DIR/instance.json"
aws ec2 describe-network-interfaces --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --output json >"$PREFLIGHT_SCRATCH_DIR/network-interfaces.json"
aws ec2 describe-subnets --region "$AWS_REGION" \
  --subnet-ids "$REMOTE_ALB_SUBNET_A" "$REMOTE_ALB_SUBNET_B" \
  --output json >"$PREFLIGHT_SCRATCH_DIR/subnets.json"
aws ec2 describe-route-tables --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --output json >"$PREFLIGHT_SCRATCH_DIR/routes.json"

node - \
  "$PREFLIGHT_SCRATCH_DIR/identity.json" \
  "$PREFLIGHT_SCRATCH_DIR/instance.json" \
  "$PREFLIGHT_SCRATCH_DIR/network-interfaces.json" \
  "$PREFLIGHT_SCRATCH_DIR/subnets.json" \
  "$PREFLIGHT_SCRATCH_DIR/routes.json" \
  "$EVIDENCE_DIR/remote-admin-preflight-evidence.json" <<'NODE'
const fs = require("fs");
const [identityPath, instancePath, networkInterfacesPath, subnetsPath, routesPath, outputPath] =
  process.argv.slice(2);
const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
const instance = JSON.parse(fs.readFileSync(instancePath, "utf8"))
  .Reservations?.[0]?.Instances?.[0];
const globalNetworkInterfaces = JSON.parse(
  fs.readFileSync(networkInterfacesPath, "utf8"),
).NetworkInterfaces;
const subnets = JSON.parse(fs.readFileSync(subnetsPath, "utf8")).Subnets ?? [];
const tables = JSON.parse(fs.readFileSync(routesPath, "utf8")).RouteTables ?? [];
const expectedSubnets = new Set([
  "subnet-0e6446aaaeaa8762e",
  "subnet-094bf8643d98c22f6",
]);
const groupIdPattern = /^sg-[0-9a-f]{8,17}$/;
const groupIds = (groups) => {
  if (
    !Array.isArray(groups) ||
    groups.length === 0 ||
    !groups.every((group) =>
      group &&
      typeof group === "object" &&
      typeof group.GroupId === "string" &&
      groupIdPattern.test(group.GroupId),
    )
  ) {
    return null;
  }
  const ids = groups.map((group) => group.GroupId);
  return new Set(ids).size === ids.length ? ids.sort() : null;
};
const sameStrings = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);
const embeddedNetworkInterfaces = Array.isArray(instance?.NetworkInterfaces)
  ? instance.NetworkInterfaces
  : [];
const embedded = embeddedNetworkInterfaces.map((eni) => {
  const id = eni?.NetworkInterfaceId;
  const deviceIndex = eni?.Attachment?.DeviceIndex;
  const groups = groupIds(eni?.Groups);
  if (
    typeof id !== "string" ||
    !id.startsWith("eni-") ||
    !Number.isInteger(deviceIndex) ||
    deviceIndex < 0 ||
    groups === null
  ) {
    return null;
  }
  return {
    id,
    deviceIndex,
    groupIds: groups,
    privateIp: eni?.PrivateIpAddress,
  };
});
const globalForInstance = Array.isArray(globalNetworkInterfaces)
  ? globalNetworkInterfaces
      .filter((eni) => eni?.Attachment?.InstanceId === instance?.InstanceId)
      .map((eni) => {
        const id = eni?.NetworkInterfaceId;
        const deviceIndex = eni?.Attachment?.DeviceIndex;
        const groups = groupIds(eni?.Groups);
        if (
          typeof id !== "string" ||
          !id.startsWith("eni-") ||
          !Number.isInteger(deviceIndex) ||
          deviceIndex < 0 ||
          groups === null
        ) {
          return null;
        }
        return { id, deviceIndex, groupIds: groups };
      })
  : [];
const primary = embedded.filter((eni) => eni?.deviceIndex === 0);
const embeddedIds = embedded.map((eni) => eni?.id);
const globalIds = globalForInstance.map((eni) => eni?.id);
const globalById = new Map(
  globalForInstance
    .filter((eni) => eni !== null)
    .map((eni) => [eni.id, eni]),
);
const globalEniCorrespondence =
  embedded.length > 0 &&
  !embedded.some((eni) => eni === null) &&
  globalForInstance.length === embedded.length &&
  !globalForInstance.some((eni) => eni === null) &&
  new Set(embeddedIds).size === embedded.length &&
  new Set(globalIds).size === globalForInstance.length &&
  sameStrings(embeddedIds, globalIds) &&
  embedded.every((eni) => {
    const global = globalById.get(eni.id);
    return (
      global &&
      global.deviceIndex === eni.deviceIndex &&
      sameStrings(global.groupIds, eni.groupIds)
    );
  });
const attachedGroups = [
  ...new Set(
    embedded.flatMap((eni) => eni?.groupIds ?? []),
  ),
].sort();
const main = tables.find((table) =>
  table.Associations?.some((association) => association.Main === true),
);
const hasInternetGatewayRoute = Array.from(expectedSubnets).every((subnetId) => {
  const explicit = tables.find((table) =>
    table.Associations?.some((association) => association.SubnetId === subnetId),
  );
  const table = explicit ?? main;
  return table?.Routes?.some((route) =>
    route.DestinationCidrBlock === "0.0.0.0/0" &&
    typeof route.GatewayId === "string" &&
    route.GatewayId.startsWith("igw-"),
  );
});
if (
  identity?.Account !== "845242190536" ||
  instance?.InstanceId !== "i-008f737974a9ba9b3" ||
  instance?.VpcId !== "vpc-0f078e17a5f0f8599" ||
  primary.length !== 1 ||
  primary[0]?.privateIp !== "172.31.12.112" ||
  !globalEniCorrespondence ||
  attachedGroups.length === 0 ||
  subnets.length !== 2 ||
  new Set(subnets.map((subnet) => subnet.SubnetId)).size !== 2 ||
  !subnets.every((subnet) => expectedSubnets.has(subnet.SubnetId) &&
    subnet.VpcId === "vpc-0f078e17a5f0f8599") ||
  !hasInternetGatewayRoute
) {
  process.exit(2);
}
fs.writeFileSync(outputPath, JSON.stringify({
  schema: "remote-admin-preflight/v1",
  account: identity.Account,
  region: "af-south-1",
  vpcId: instance.VpcId,
  instanceId: instance.InstanceId,
  targetPrivateIpMatchesConfigured: true,
  instanceNetworkInterfaceIds: embeddedIds.sort(),
  instanceNetworkInterfaceCount: embedded.length,
  attachedSecurityGroupIds: attachedGroups,
  attachedSecurityGroupCount: attachedGroups.length,
  globalEniIdentityAndGroupCorrespondenceConfirmed: true,
  albSubnetIds: subnets.map((subnet) => subnet.SubnetId).sort(),
  publicAlbSubnetRoutesConfirmed: true,
}, null, 2), { mode: 0o600 });
NODE
chmod 600 "$EVIDENCE_DIR/remote-admin-preflight-evidence.json"
```

Derive attached groups only from each embedded ENI `Groups` list and require exact identity/device-index/group correspondence with global `describe-network-interfaces` readback; `instance.SecurityGroups` is not authority. Read every derived EC2 security group before creating the target SG. Stop if any current SG exposes TCP `8443` through an IPv4/IPv6 CIDR, prefix list, or non-ALB SG source. This blocks an accidental direct target path before it exists.

```bash
ATTACHED_SG_IDS="$(node - "$EVIDENCE_DIR/remote-admin-preflight-evidence.json" <<'NODE'
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(value.attachedSecurityGroupIds.join(" "));
NODE
)"
read -r -a ATTACHED_SG_ID_ARRAY <<<"$ATTACHED_SG_IDS"
test "${#ATTACHED_SG_ID_ARRAY[@]}" -gt 0
aws ec2 describe-security-groups --region "$AWS_REGION" \
  --group-ids "${ATTACHED_SG_ID_ARRAY[@]}" \
  --output json >"$PREFLIGHT_SCRATCH_DIR/attached-security-groups.json"
node \
  "$PREFLIGHT_SCRATCH_DIR/attached-security-groups.json" \
  "$EVIDENCE_DIR/remote-admin-preflight-evidence.json" <<'NODE'
const fs = require("fs");
const [groupsPath, evidencePath] = process.argv.slice(2);
const groups = JSON.parse(fs.readFileSync(groupsPath, "utf8")).SecurityGroups ?? [];
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const expectedIds = Array.isArray(evidence.attachedSecurityGroupIds)
  ? evidence.attachedSecurityGroupIds
  : [];
const actualIds = groups.map((group) => group?.GroupId);
const sameStrings = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);
const opens8443 = (permission) =>
  permission.IpProtocol === "-1" ||
  (
    permission.IpProtocol === "tcp" &&
    Number(permission.FromPort) <= 8443 &&
    Number(permission.ToPort) >= 8443
  );
if (
  !sameStrings(expectedIds, actualIds) ||
  groups.some((group) => (group.IpPermissions ?? []).some(opens8443))
) {
  process.exit(2);
}
fs.writeFileSync(evidencePath, JSON.stringify({
  ...evidence,
  attachedSecurityGroupReadbackConfirmed: true,
  attachedSecurityGroupReadbackCount: actualIds.length,
}, null, 2), { mode: 0o600 });
NODE
chmod 600 "$EVIDENCE_DIR/remote-admin-preflight-evidence.json"
```

Lovable is already confirmed as authoritative DNS provider with edit access. No pre-ACM DNS attestation variable exists. Gate A begins only after ACM returns its exact validation CNAME for the operator to save.

Confirm permissions read-only with IAM simulation. When STS returns an assumed-role ARN, the IAM owner must supply the corresponding role ARN as `IAM_POLICY_SOURCE_ARN`; do not infer or substitute one.

```bash
: "${IAM_POLICY_SOURCE_ARN:?IAM role/user ARN required for read-only permission simulation}"
cat >"$PREFLIGHT_SCRATCH_DIR/required-actions.json" <<'JSON'
[
  "acm:ListCertificates",
  "acm:RequestCertificate",
  "acm:DescribeCertificate",
  "elasticloadbalancing:CreateLoadBalancer",
  "elasticloadbalancing:CreateTargetGroup",
  "elasticloadbalancing:CreateListener",
  "elasticloadbalancing:CreateRule",
  "elasticloadbalancing:DescribeLoadBalancers",
  "elasticloadbalancing:DescribeTargetGroups",
  "elasticloadbalancing:DescribeTargetGroupAttributes",
  "elasticloadbalancing:DescribeListeners",
  "elasticloadbalancing:DescribeRules",
  "elasticloadbalancing:DescribeTargetHealth",
  "elasticloadbalancing:DescribeLoadBalancerAttributes",
  "elasticloadbalancing:ModifyLoadBalancerAttributes",
  "elasticloadbalancing:ModifyTargetGroupAttributes",
  "elasticloadbalancing:RegisterTargets",
  "ec2:CreateSecurityGroup",
  "ec2:AuthorizeSecurityGroupIngress",
  "ec2:AuthorizeSecurityGroupEgress",
  "ec2:RevokeSecurityGroupEgress",
  "ec2:ModifyInstanceAttribute",
  "ec2:DescribeInstances",
  "ec2:DescribeSecurityGroups",
  "ec2:DescribeSubnets",
  "ec2:DescribeRouteTables",
  "wafv2:CreateWebACL",
  "wafv2:AssociateWebACL",
  "wafv2:ListWebACLs",
  "wafv2:GetWebACL",
  "wafv2:GetWebACLForResource",
  "s3:CreateBucket",
  "s3:ListAllMyBuckets",
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetBucketEncryption",
  "s3:GetBucketOwnershipControls",
  "s3:GetBucketPolicy",
  "s3:GetBucketLifecycleConfiguration",
  "s3:GetBucketCors",
  "s3:PutBucketEncryption",
  "s3:PutBucketOwnershipControls",
  "s3:PutPublicAccessBlock",
  "s3:PutBucketLifecycleConfiguration",
  "s3:PutBucketPolicy",
  "s3:PutBucketCors",
  "secretsmanager:CreateSecret",
  "secretsmanager:DescribeSecret",
  "secretsmanager:PutSecretValue",
  "secretsmanager:GetSecretValue",
  "iam:GetRolePolicy",
  "iam:PutRolePolicy",
  "iam:SimulatePrincipalPolicy",
  "ssm:SendCommand",
  "ssm:GetCommandInvocation"
]
JSON
mapfile -t REQUIRED_ACTIONS < <(node -e 'for (const action of require(process.argv[1])) console.log(action)' "$PREFLIGHT_SCRATCH_DIR/required-actions.json")
aws iam simulate-principal-policy --policy-source-arn "$IAM_POLICY_SOURCE_ARN" \
  --action-names "${REQUIRED_ACTIONS[@]}" --output json \
  >"$PREFLIGHT_SCRATCH_DIR/permission-simulation.json"
node \
  "$PREFLIGHT_SCRATCH_DIR/required-actions.json" \
  "$PREFLIGHT_SCRATCH_DIR/permission-simulation.json" \
  "$EVIDENCE_DIR/remote-admin-preflight-evidence.json" <<'NODE'
const fs = require("fs");
const [actionsPath, permissionPath, evidencePath] = process.argv.slice(2);
const actions = JSON.parse(fs.readFileSync(actionsPath, "utf8"));
const evaluations = JSON.parse(
  fs.readFileSync(permissionPath, "utf8"),
).EvaluationResults ?? [];
if (
  !Array.isArray(actions) ||
  evaluations.length !== actions.length ||
  evaluations.some((result) => result.EvalDecision !== "allowed")
) {
  process.exit(2);
}
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
fs.writeFileSync(evidencePath, JSON.stringify({
  ...evidence,
  requiredIamActionsAllowed: true,
  requiredIamActionCount: actions.length,
}, null, 2), { mode: 0o600 });
NODE
chmod 600 "$EVIDENCE_DIR/remote-admin-preflight-evidence.json"
rm -rf -- "$PREFLIGHT_SCRATCH_DIR"
trap - EXIT
```

Stop and report **BLOCKED** when any preflight assertion or required action fails. Do not compensate with broad policies, alternate subnets, or guessed IDs.

### ALB access-log policy compatibility

Final ALB logging uses the exact bucket, `access_logs.s3.prefix=""`, modern service principal `logdelivery.elasticloadbalancing.amazonaws.com` with only exact `ArnLike aws:SourceArn`, Cape Town legacy root `arn:aws:iam::098369216593:root`, and TLS-only deny. The modern Allow must not include `aws:SourceAccount`: AWS ALB guidance and the live bounded delivery proof use this shape, while the prior live `SourceAccount` attempt returned `AccessDenied`. Keep former `SourceAccount` handling only as a bounded stale-policy repair path; do not restore it to the final writer or readiness contract.

### Gate A — ACM request only

After complete preflight, request no resource except certificate. Reuse a matching pending/issued certificate if one exists; otherwise request once with the deterministic idempotency token.

```bash
CERTIFICATE_ARN="$(
  aws acm list-certificates --region "$AWS_REGION" \
    --certificate-statuses PENDING_VALIDATION ISSUED \
    --query "CertificateSummaryList[?DomainName=='$REMOTE_ADMIN_HOST'].CertificateArn | [0]" \
    --output text
)"
if [ -z "$CERTIFICATE_ARN" ] || [ "$CERTIFICATE_ARN" = None ]; then
  CERTIFICATE_ARN="$(
    aws acm request-certificate --region "$AWS_REGION" \
      --domain-name "$REMOTE_ADMIN_HOST" \
      --validation-method DNS \
      --idempotency-token navaadminalb20260812 \
      --query CertificateArn --output text
  )"
fi
aws acm describe-certificate --region "$AWS_REGION" \
  --certificate-arn "$CERTIFICATE_ARN" \
  --query 'Certificate.DomainValidationOptions[?DomainName==`nava-admin.trynava.io`].[ResourceRecord.Name,ResourceRecord.Value]' \
  --output text
```

Record exact validation CNAME name/value and certificate ARN, then stop at Gate A. Do not create a secret, ALB, target group, listener, SG, WAF, bucket, CORS change, target registration, host-forward rule, DNS record, or EC2/UFW change.

After operator replies **“ACM CNAME saved”**, poll at most 45 minutes:

```bash
deadline=$(( $(date +%s) + 2700 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  status="$(aws acm describe-certificate --region "$AWS_REGION" \
    --certificate-arn "$CERTIFICATE_ARN" \
    --query 'Certificate.Status' --output text)"
  [ "$status" = ISSUED ] && break
  sleep 30
done
test "${status:-}" = ISSUED
```

### Secret and narrowly scoped instance permission

Run only after Gate A issuance and before creating the remote process environment. Generate local JSON in a mode-0600 temporary file; never echo it, pass it as a shell argument, or retrieve it into operator output.

```bash
SECRET_FILE="$(mktemp)"
chmod 600 "$SECRET_FILE"
trap 'rm -f "$SECRET_FILE"' EXIT
node - <<'NODE' >"$SECRET_FILE"
const { randomBytes } = require("crypto");
process.stdout.write(JSON.stringify({
  BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
}));
NODE

if REMOTE_SECRET_ARN="$(aws secretsmanager describe-secret --region "$AWS_REGION" \
  --secret-id "$REMOTE_AUTH_SECRET_NAME" --query ARN --output text 2>/dev/null)"; then
  test "${REMOTE_AUTH_ROTATE:-0}" = 1
  aws secretsmanager put-secret-value --region "$AWS_REGION" \
    --secret-id "$REMOTE_SECRET_ARN" --secret-string "$(aws_file_uri "$SECRET_FILE")" >/dev/null
else
  REMOTE_SECRET_ARN="$(aws secretsmanager create-secret --region "$AWS_REGION" \
    --name "$REMOTE_AUTH_SECRET_NAME" \
    --description "NAVA Zero remote-admin Better Auth signing secret" \
    --secret-string "$(aws_file_uri "$SECRET_FILE")" \
    --query ARN --output text)"
fi
rm -f "$SECRET_FILE"
trap - EXIT
```

Extend only inline policy `NavaZeroSecretsRead`; preserve existing statements and add this exact ARN to its existing `GetSecretValue`/`DescribeSecret` resource list. The guarded transform rejects unexpected policy shape instead of widening access.

```bash
CURRENT_POLICY="$(mktemp)"
UPDATED_POLICY="$(mktemp)"
chmod 600 "$CURRENT_POLICY" "$UPDATED_POLICY"
trap 'rm -f "$CURRENT_POLICY" "$UPDATED_POLICY"' EXIT
aws iam get-role-policy --role-name "$REMOTE_ROLE_NAME" \
  --policy-name NavaZeroSecretsRead --query PolicyDocument --output json >"$CURRENT_POLICY"
node - "$CURRENT_POLICY" "$UPDATED_POLICY" "$REMOTE_SECRET_ARN" <<'NODE'
const fs = require("fs");
const [input, output, secretArn] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(input, "utf8"));
const policy = typeof raw === "string" ? JSON.parse(decodeURIComponent(raw)) : raw;
const statements = Array.isArray(policy?.Statement) ? policy.Statement : [];
const match = statements.filter((statement) => {
  const actions = Array.isArray(statement?.Action) ? statement.Action : [statement?.Action];
  return statement?.Effect === "Allow" &&
    actions.length === 2 &&
    actions.includes("secretsmanager:GetSecretValue") &&
    actions.includes("secretsmanager:DescribeSecret") &&
    Array.isArray(statement?.Resource);
});
if (match.length !== 1 || !/^arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero\/server-pilot\/remote-auth-/.test(secretArn)) {
  process.exit(2);
}
if (!match[0].Resource.includes(secretArn)) match[0].Resource.push(secretArn);
fs.writeFileSync(output, JSON.stringify(policy), { mode: 0o600 });
NODE
aws iam put-role-policy --role-name "$REMOTE_ROLE_NAME" \
  --policy-name NavaZeroSecretsRead --policy-document "$(aws_file_uri "$UPDATED_POLICY")"
rm -f "$CURRENT_POLICY" "$UPDATED_POLICY"
trap - EXIT
```

On EC2, use a dynamic reference and print only JSON key name plus length:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && BETTER_AUTH_SECRET="{{resolve:secretsmanager:nava-zero/server-pilot/remote-auth:SecretString:BETTER_AUTH_SECRET}}" asm-exec -- node -e '"'"'const value=process.env.BETTER_AUTH_SECRET ?? ""; if (!/^[A-Za-z0-9_-]{64}$/.test(value)) process.exit(2); console.log(JSON.stringify({jsonKey:"BETTER_AUTH_SECRET",length:value.length}));'"'"''
```

Rotation sequence: generate new file-backed value → guarded `REMOTE_AUTH_ROTATE=1` write → run `write-ec2-remote-env.sh` as `ubuntu` → restart only `remote-http` with `pm2 restart remote-http --update-env` → prove remote loopback health and human remote login → retire prior secret version only after proof. Never restart legacy `http`, workers, or mutate the database for remote secret rotation.

### Idempotent edge resources after Gate A

`remote-edge-provisioner.sh` is sole Task 4 edge mutator. It collects fresh fixed AWS/EC2/host projections, validates them with `remote-edge-state.mjs`, derives one closed prefix, makes one mapped mutation, then repeats fresh collection and requires its exact successor. Reports, checkpoints, pasted facts, and stage labels never authorize a mutation.

Use only:

```bash
bash apps/server-pilot/deploy/remote-edge-provisioner.sh inspect --evidence-root /secure/operator/evidence
bash apps/server-pilot/deploy/remote-edge-provisioner.sh apply-one --action ACTION --evidence-root /secure/operator/evidence
```

`inspect` prints sanitized `stage` and next `action`. `apply-one` accepts only that exact action, writes only atomic sanitized stage/action evidence (`0700` directory, `0600` files), and fails closed on read errors, malformed or extra facts, duplicate names, unsafe SG/UFW/ALB/listener/WAF/bucket-policy state, unexpected attachment, or a wrong successor. Every SSM invocation is pinned to `af-south-1` and polled only to a bounded terminal state before the provisioner classifies or mutates again. It never exposes IDs, ARNs, secrets, SSM output, object keys, response bodies, or PII.

`SG_FINAL_UNATTACHED` is recognized only when both named groups have their exact final rules, neither is attached to EC2, and no later deterministic named resource exists. Its sole action is `ATTACH_TARGET_SECURITY_GROUP`.

The executable never registers a target, creates a host-forward rule, creates a public HTTP listener, mutates DNS or CORS, or performs Task 5 work.

Resource definitions, transition mapping, and successor checks live only in the executable provisioner and state module. `launch-readiness.sh` remains a separate read-only final gate:

```bash
REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0 \
  bash apps/server-pilot/deploy/launch-readiness.sh
```

`UFW_READY` is not Task 4 pre-Gate-B readiness. Its sole action is `PROVE_ALB_LOG_DELIVERY`. The provisioner performs one harmless body-discarding HTTPS request through `--connect-to` using the remote Host against the ALB DNS name, while the listener remains fixed `404` and no target, host-forward rule, public DNS, or CORS change exists. It then polls `s3api list-objects-v2` for at most `REMOTE_EDGE_LOG_PROOF_MAX_ATTEMPTS` × `REMOTE_EDGE_LOG_PROOF_INTERVAL_SECONDS` (default 15 minutes), accepts only a log object newer than proof start, and passes only boolean evidence (`accessLogDelivered=true`) into fresh successor classification.

Every terminal `inspect` independently reads `s3api list-objects-v2` from the exact current log bucket. It accepts only an exact current-ALB access-log key whose S3 `LastModified` is within `REMOTE_EDGE_LOG_PROOF_MAX_AGE_SECONDS` (default 900 seconds, bounded to 86400), then passes only `accessLogDelivered=true` into state classification. Absent, stale, malformed, or wrong-ALB S3 evidence returns `UFW_READY` / `PROVE_ALB_LOG_DELIVERY`; no local file can authorize terminal readiness.

For `apply-one PROVE_ALB_LOG_DELIVERY`, the proof scope is captured before the request and must exactly match a fresh post-proof scope before terminal classification or audit recording. Only then does the provisioner atomically record a sanitized `0600` audit receipt containing version, bounded issued-at epoch, and opaque SHA-256 scope. This receipt is never read by classification and has no authorization effect. Raw request output, S3 object keys, and list responses remain private scratch data; reports and durable evidence contain only stage/action or audit metadata.

### Gate B and Task 5 handoff

After ALB DNS is known, stop at Gate B. Operator saves `nava-admin.trynava.io CNAME → ALB DNS name`, replies **“nava-admin CNAME saved”**, then operator polls DNS for at most 45 minutes. Never use a wildcard origin.

Only after DNS settles, use this additive mail-bucket CORS protocol. It preserves all existing valid rules, adds remote origin only to one GET/HEAD rule, validates immediate readback, and refuses rollback when another operator changed state.

```bash
export MAIL_BUCKET=nava-zero-mail-845242190536-af-south-1
: "${EVIDENCE_ROOT:=${HOME}/.nava-evidence/remote-admin}"
CORS_EVIDENCE_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p -- "$EVIDENCE_ROOT"
chmod 700 -- "$EVIDENCE_ROOT"
CORS_EVIDENCE_DIR="$(mktemp -d "${EVIDENCE_ROOT%/}/${CORS_EVIDENCE_TIMESTAMP}-cors.XXXXXX")"
chmod 700 -- "$CORS_EVIDENCE_DIR"
CORS_SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nava-remote-admin-cors.XXXXXX")"
chmod 700 -- "$CORS_SCRATCH_DIR"
cleanup_cors_scratch() {
  rm -rf -- "$CORS_SCRATCH_DIR"
}
trap cleanup_cors_scratch EXIT
CORS_BEFORE="$CORS_SCRATCH_DIR/mail-cors-before.json"
CORS_INTENDED="$CORS_SCRATCH_DIR/mail-cors-intended.json"
CORS_APPLIED="$CORS_SCRATCH_DIR/mail-cors-applied.json"

aws s3api get-bucket-cors --region "$AWS_REGION" --bucket "$MAIL_BUCKET" \
  --output json >"$CORS_BEFORE"
node - "$CORS_BEFORE" "$CORS_INTENDED" <<'NODE'
const fs = require("fs");
const [beforePath, intendedPath] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const rules = Array.isArray(value?.CORSRules) ? value.CORSRules : [];
const remoteOrigin = "https://nava-admin.trynava.io";
const hasExactGetHeadMethods = (rule) =>
  Array.isArray(rule?.AllowedMethods) &&
  rule.AllowedMethods.length === 2 &&
  rule.AllowedMethods.includes("GET") &&
  rule.AllowedMethods.includes("HEAD");
if (rules.length === 0 || rules.some((rule) =>
  !Array.isArray(rule?.AllowedOrigins) ||
  rule.AllowedOrigins.some((origin) => typeof origin !== "string" || origin.includes("*")) ||
  !Array.isArray(rule?.AllowedMethods),
)) {
  process.exit(2);
}
if (rules.some((rule) =>
  rule.AllowedOrigins.includes(remoteOrigin) && !hasExactGetHeadMethods(rule),
)) {
  process.exit(2);
}
const target = rules.find((rule) =>
  hasExactGetHeadMethods(rule),
);
if (!target) process.exit(2);
if (!target.AllowedOrigins.includes(remoteOrigin)) target.AllowedOrigins.push(remoteOrigin);
fs.writeFileSync(intendedPath, JSON.stringify({ CORSRules: rules }), { mode: 0o600 });
NODE
aws s3api put-bucket-cors --region "$AWS_REGION" --bucket "$MAIL_BUCKET" \
  --cors-configuration "$(aws_file_uri "$CORS_INTENDED")"
aws s3api get-bucket-cors --region "$AWS_REGION" --bucket "$MAIL_BUCKET" \
  --output json >"$CORS_APPLIED"
node - "$CORS_INTENDED" "$CORS_APPLIED" <<'NODE'
const fs = require("fs");
const [intendedPath, appliedPath] = process.argv.slice(2);
const intended = JSON.parse(fs.readFileSync(intendedPath, "utf8"));
const applied = JSON.parse(fs.readFileSync(appliedPath, "utf8"));
const remoteOrigin = "https://nava-admin.trynava.io";
const hasExactGetHeadMethods = (rule) =>
  Array.isArray(rule?.AllowedMethods) &&
  rule.AllowedMethods.length === 2 &&
  rule.AllowedMethods.includes("GET") &&
  rule.AllowedMethods.includes("HEAD");
const canonicalizeCorsRules = (value) => {
  if (!Array.isArray(value?.CORSRules)) process.exit(2);
  return value.CORSRules
    .map((rule) => {
      if (rule === null || typeof rule !== "object" || Array.isArray(rule)) process.exit(2);
      return Object.fromEntries(
        Object.entries(rule)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, field]) => [
            key,
            Array.isArray(field)
              ? [...field].sort()
              : field,
          ]),
      );
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
};
const valid = [intended, applied].every((value) =>
  Array.isArray(value?.CORSRules) &&
  value.CORSRules.some((rule) =>
    Array.isArray(rule?.AllowedOrigins) &&
    Array.isArray(rule?.AllowedMethods) &&
    !rule.AllowedOrigins.some((origin) => origin.includes("*")) &&
    rule.AllowedOrigins.includes(remoteOrigin) &&
    hasExactGetHeadMethods(rule),
  ),
);
if (
  !valid ||
  JSON.stringify(canonicalizeCorsRules(intended)) !==
    JSON.stringify(canonicalizeCorsRules(applied))
) {
  process.exit(2);
}
NODE
node - "$CORS_EVIDENCE_DIR/remote-admin-cors-evidence.json" <<'NODE'
const fs = require("fs");
const outputPath = process.argv[2];
fs.writeFileSync(outputPath, JSON.stringify({
  schema: "remote-admin-cors-evidence/v1",
  remoteAdminOriginConfigured: true,
  semanticReadbackPassed: true,
}, null, 2), { mode: 0o600 });
NODE
chmod 600 "$CORS_EVIDENCE_DIR/remote-admin-cors-evidence.json"
```

To roll back in this same operator shell, first read current CORS into `$CORS_SCRATCH_DIR/mail-cors-current.json` and semantically compare it to `$CORS_APPLIED`; only an exact match may restore `$CORS_BEFORE`, followed by the same immediate semantic readback. A mismatch means another operator changed CORS: stop and preserve the scratch snapshots for this shell. All raw CORS responses stay in `CORS_SCRATCH_DIR` and its EXIT trap deletes them; persistent `CORS_EVIDENCE_DIR` retains only the sanitized boolean receipt. If the shell already exited, do not reconstruct a prior raw snapshot from evidence—stop and coordinate with the operator who owns the change.

Only Task 5 may:

```bash
aws elbv2 register-targets --region "$AWS_REGION" \
  --target-group-arn "$TARGET_GROUP_ARN" --targets Id="$INSTANCE_ID",Port=8443
aws elbv2 create-rule --region "$AWS_REGION" --listener-arn "$LISTENER_ARN" \
  --priority 10 \
  --conditions Field=host-header,Values="$REMOTE_ADMIN_HOST" \
  --actions Type=forward,TargetGroupArn="$TARGET_GROUP_ARN"
```

Then require `REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=1` readiness, exact fixed-404 listener fallback, exact host-forward rule, healthy target, Task 4's already-proven bounded log delivery, and no direct target path.

## Resize / downgrade

RDS class is cheap to change later:

```bash
aws rds modify-db-instance --region af-south-1 --db-instance-identifier nava-zero-mail-pilot --db-instance-class db.t4g.small --apply-immediately
```

Use `db.t4g.small` only if tests show memory/pool waits are fine. Use `db.t4g.large` if CPU credits, memory, or pool waits fail under load.

## Tear-down (when pilot ends)

```bash
aws rds delete-db-instance --region af-south-1 --db-instance-identifier nava-zero-mail-pilot --skip-final-snapshot
aws rds delete-db-subnet-group --region af-south-1 --db-subnet-group-name nava-zero-mail
aws ec2 delete-security-group --region af-south-1 --group-id sg-0fbe865a67165678c
aws secretsmanager delete-secret --region af-south-1 --secret-id nava-zero/server-pilot/database-url --force-delete-without-recovery
aws s3 rb --region af-south-1 s3://nava-zero-mail-845242190536-af-south-1 --force
```
