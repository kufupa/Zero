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
| S3 lifecycle | `raw-mime/*` expire 30d, `attachments/*` expire 90d, incomplete multipart abort 1d, `hms-browser-proof-transfer/v1/*` expire 1d |
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
aws s3api put-bucket-lifecycle-configuration --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --lifecycle-configuration '{"Rules":[{"ID":"expire-raw-mime-30d","Status":"Enabled","Filter":{"Prefix":"raw-mime/"},"Expiration":{"Days":30}},{"ID":"expire-attachments-90d","Status":"Enabled","Filter":{"Prefix":"attachments/"},"Expiration":{"Days":90}},{"ID":"abort-incomplete-multipart-1d","Status":"Enabled","Filter":{"Prefix":""},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}},{"ID":"HmsBrowserProofTransferExpire1Day","Status":"Enabled","Filter":{"Prefix":"hms-browser-proof-transfer/v1/"},"Expiration":{"Days":1}}]}'
# Proof wrappers semantically merge/read back this named rule; never replace
# unrelated lifecycle rules during ordinary proof operation.
# Browser attachment fetch during cutover overlap. Origin allowlist only — never *.
aws s3api put-bucket-cors --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://nava.legacyhotels.co.za","https://nava.legacy.local","http://localhost:3000","https://localhost:3000"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Disposition","Content-Type","Content-Length"],"MaxAgeSeconds":300}]}'

# 6. EC2 instance role inline policies
ROLE=nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroMailBucketAccess --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation","s3:ListBucketMultipartUploads"],"Resource":"arn:aws:s3:::'"$NAVA_MAIL_BUCKET"'"},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":"arn:aws:s3:::'"$NAVA_MAIL_BUCKET"'/*"}]}'
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroSecretsRead --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"],"Resource":["arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/database-url-*","arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/infor-hms-read-*","arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/hms-evidence-hmac-*"]}]}'
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroRDSConnect --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["rds-db:connect"],"Resource":"arn:aws:rds:af-south-1:845242190536:dbuser:nava-zero-mail-pilot/zero_admin"}]}'
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroBedrockInvoke --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel"],"Resource":"arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0"}]}'
```

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
EVIDENCE_DIR="$(mktemp -d)"
trap 'rm -rf "$EVIDENCE_DIR"' EXIT
```

Before any mutation, run only these read calls. Save their sanitized resource metadata in the evidence directory; do not save command environments, credentials, mail data, or secret values.

```bash
aws sts get-caller-identity --output json >"$EVIDENCE_DIR/identity.json"
aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --output json >"$EVIDENCE_DIR/instance.json"
aws ec2 describe-subnets --region "$AWS_REGION" \
  --subnet-ids "$REMOTE_ALB_SUBNET_A" "$REMOTE_ALB_SUBNET_B" \
  --output json >"$EVIDENCE_DIR/subnets.json"
aws ec2 describe-route-tables --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --output json >"$EVIDENCE_DIR/routes.json"

node - \
  "$EVIDENCE_DIR/identity.json" \
  "$EVIDENCE_DIR/instance.json" \
  "$EVIDENCE_DIR/subnets.json" \
  "$EVIDENCE_DIR/routes.json" \
  "$EVIDENCE_DIR/remote-admin-preflight-evidence.json" <<'NODE'
const fs = require("fs");
const [identityPath, instancePath, subnetsPath, routesPath, outputPath] =
  process.argv.slice(2);
const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
const instance = JSON.parse(fs.readFileSync(instancePath, "utf8"))
  .Reservations?.[0]?.Instances?.[0];
const subnets = JSON.parse(fs.readFileSync(subnetsPath, "utf8")).Subnets ?? [];
const tables = JSON.parse(fs.readFileSync(routesPath, "utf8")).RouteTables ?? [];
const expectedSubnets = new Set([
  "subnet-0e6446aaaeaa8762e",
  "subnet-094bf8643d98c22f6",
]);
const attachedGroups = instance?.SecurityGroups?.map((group) => group.GroupId) ?? [];
const primaryPrivateIp =
  instance?.NetworkInterfaces?.find((eni) => eni.Attachment?.DeviceIndex === 0)
    ?.PrivateIpAddress ?? instance?.PrivateIpAddress;
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
  primaryPrivateIp !== "172.31.12.112" ||
  subnets.length !== 2 ||
  new Set(subnets.map((subnet) => subnet.SubnetId)).size !== 2 ||
  !subnets.every((subnet) => expectedSubnets.has(subnet.SubnetId) &&
    subnet.VpcId === "vpc-0f078e17a5f0f8599") ||
  !hasInternetGatewayRoute ||
  attachedGroups.length === 0
) {
  process.exit(2);
}
fs.writeFileSync(outputPath, JSON.stringify({
  account: identity.Account,
  region: "af-south-1",
  vpcId: instance.VpcId,
  instanceId: instance.InstanceId,
  primaryPrivateIp,
  attachedSecurityGroupIds: attachedGroups,
  albSubnetIds: subnets.map((subnet) => subnet.SubnetId).sort(),
  publicAlbSubnetRoutesConfirmed: true,
}, null, 2), { mode: 0o600 });
NODE
chmod 600 "$EVIDENCE_DIR/remote-admin-preflight-evidence.json"
```

Read every attached EC2 security group before creating the target SG. Stop if any current SG exposes TCP `8443` through an IPv4/IPv6 CIDR, prefix list, or non-ALB SG source. This blocks an accidental direct target path before it exists.

```bash
ATTACHED_SG_IDS="$(node - "$EVIDENCE_DIR/remote-admin-preflight-evidence.json" <<'NODE'
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(value.attachedSecurityGroupIds.join(" "));
NODE
)"
aws ec2 describe-security-groups --region "$AWS_REGION" --group-ids $ATTACHED_SG_IDS \
  --output json >"$EVIDENCE_DIR/attached-security-groups.json"
node - "$EVIDENCE_DIR/attached-security-groups.json" <<'NODE'
const fs = require("fs");
const groups = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).SecurityGroups ?? [];
const opens8443 = (permission) =>
  permission.IpProtocol === "-1" ||
  (
    permission.IpProtocol === "tcp" &&
    Number(permission.FromPort) <= 8443 &&
    Number(permission.ToPort) >= 8443
  );
if (groups.some((group) => (group.IpPermissions ?? []).some(opens8443))) {
  process.exit(2);
}
NODE
```

Lovable is already confirmed as authoritative DNS provider with edit access. No pre-ACM DNS attestation variable exists. Gate A begins only after ACM returns its exact validation CNAME for the operator to save.

Confirm permissions read-only with IAM simulation. When STS returns an assumed-role ARN, the IAM owner must supply the corresponding role ARN as `IAM_POLICY_SOURCE_ARN`; do not infer or substitute one.

```bash
: "${IAM_POLICY_SOURCE_ARN:?IAM role/user ARN required for read-only permission simulation}"
cat >"$EVIDENCE_DIR/required-actions.json" <<'JSON'
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
mapfile -t REQUIRED_ACTIONS < <(node -e 'for (const action of require(process.argv[1])) console.log(action)' "$EVIDENCE_DIR/required-actions.json")
aws iam simulate-principal-policy --policy-source-arn "$IAM_POLICY_SOURCE_ARN" \
  --action-names "${REQUIRED_ACTIONS[@]}" --output json \
  >"$EVIDENCE_DIR/permission-simulation.json"
node - "$EVIDENCE_DIR/permission-simulation.json" <<'NODE'
const fs = require("fs");
const evaluations = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).EvaluationResults ?? [];
if (evaluations.length === 0 || evaluations.some((result) => result.EvalDecision !== "allowed")) {
  process.exit(2);
}
NODE
```

Stop and report **BLOCKED** when any preflight assertion or required action fails. Do not compensate with broad policies, alternate subnets, or guessed IDs.

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
    --secret-id "$REMOTE_SECRET_ARN" --secret-string "file://$SECRET_FILE" >/dev/null
else
  REMOTE_SECRET_ARN="$(aws secretsmanager create-secret --region "$AWS_REGION" \
    --name "$REMOTE_AUTH_SECRET_NAME" \
    --description "NAVA Zero remote-admin Better Auth signing secret" \
    --secret-string "file://$SECRET_FILE" \
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
  --policy-name NavaZeroSecretsRead --policy-document "file://$UPDATED_POLICY"
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

Re-runs are a strict, live-readback-derived prefix state machine. The Task 4 report, prior shell output, checkpoint files, and a human-supplied stage label are evidence only; none is an input to the next mutation. Every invocation reads current AWS/EC2/host facts again, classifies exactly one known prefix, performs exactly one state-changing command, then performs semantic readback of the required next prefix. The classifier must reject divergence: a read error, malformed response, duplicate named resource, unexpected named-SG attachment, unexpected rule/permission, or no exact prefix match is `unknown/non-prefix remote edge state` and exits before mutation.

No transition invokes `register-targets`, `create-rule`, HTTP `:80`, or DNS mutation. Task 4 creates only a public HTTPS listener whose sole default action is fixed `404`; it never creates a public target path. Legacy `tun0:443` and zero legacy SG ingress stay outside this state machine.

Start every invocation with fresh list/read calls; do not use `--query ... [0]` as a duplicate-name shortcut and do not convert an AWS read failure into absence:

```bash
REMOTE_EDGE_LIVE_DIR="$EVIDENCE_DIR/remote-edge-live"
mkdir -p "$REMOTE_EDGE_LIVE_DIR"

aws elbv2 describe-load-balancers --region "$AWS_REGION" --output json \
  >"$REMOTE_EDGE_LIVE_DIR/albs.json"
aws elbv2 describe-target-groups --region "$AWS_REGION" --output json \
  >"$REMOTE_EDGE_LIVE_DIR/target-groups.json"
aws ec2 describe-security-groups --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" --output json \
  >"$REMOTE_EDGE_LIVE_DIR/security-groups.json"
aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --output json >"$REMOTE_EDGE_LIVE_DIR/instance.json"
aws ec2 describe-network-interfaces --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" --output json \
  >"$REMOTE_EDGE_LIVE_DIR/network-interfaces.json"
aws wafv2 list-web-acls --region "$AWS_REGION" --scope REGIONAL --output json \
  >"$REMOTE_EDGE_LIVE_DIR/wafs.json"
aws s3api list-buckets --output json >"$REMOTE_EDGE_LIVE_DIR/buckets.json"
```

For a named resource which exists, collect its exact read-only child state before classifying it: target-group attributes; ALB attributes, listeners, and listener rules; WAF definition and association; bucket location, public-access block, ownership controls, encryption, lifecycle, and policy; and sanitized exact UFW/VPN facts. A missing optional bucket/WAF control is a valid *only* when AWS returns its documented not-configured error; any other error is fatal. The fresh collector writes only sanitized resource IDs/ARNs and booleans to `$REMOTE_EDGE_LIVE_DIR/facts.json`, mode `0600`; it never reads a secret value or consumes historical evidence.

`classify_remote_edge_stage` validates JSON types, cardinality, VPC/account/instance identity, all named-SG ENI attachments, every SG rule, every child control, and returns one stage only. Its final predicate is an exclusive match: zero or two matching predicates fail closed.

```bash
classify_remote_edge_stage() {
  node - "$REMOTE_EDGE_LIVE_DIR/facts.json" <<'NODE'
const fs = require("fs");
const facts = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const fail = () => process.exit(2);
const exact = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  expected.every((value) => actual.includes(value));
if (
  facts?.account !== "845242190536" ||
  facts?.region !== "af-south-1" ||
  facts?.vpcId !== "vpc-0f078e17a5f0f8599" ||
  facts?.instanceId !== "i-008f737974a9ba9b3" ||
  !Array.isArray(facts?.namedResourceCounts) ||
  facts.namedResourceCounts.length !== 6 ||
  facts.namedResourceCounts.some((value) => !Number.isInteger(value) || value < 0 || value > 1) ||
  facts?.malformed === true ||
  facts?.unexpectedAttachment === true ||
  facts?.unexpectedPermission === true
) fail();
const [alb, targetGroup, albSg, targetSg, waf, bucket] = facts.namedResourceCounts;
const vector = `[ALB=${alb},TG=${targetGroup},ALB-SG=${albSg},target-SG=${targetSg},WAF=${waf},bucket=${bucket}]`;
const matches = [
  ["FRESH", vector === "[ALB=0,TG=0,ALB-SG=0,target-SG=0,WAF=0,bucket=0]"],
  ["ALB_SG_CREATED", facts.sgStage === "alb-created" && vector === "[ALB=0,TG=0,ALB-SG=1,target-SG=0,WAF=0,bucket=0]"],
  ["SGS_CREATED", facts.sgStage === "both-created" && vector === "[ALB=0,TG=0,ALB-SG=1,target-SG=1,WAF=0,bucket=0]"],
  ["ALB_INGRESS_READY", facts.sgStage === "alb-ingress" && vector === "[ALB=0,TG=0,ALB-SG=1,target-SG=1,WAF=0,bucket=0]"],
  ["ALB_EGRESS_REVOKED", facts.sgStage === "alb-egress-revoked" && vector === "[ALB=0,TG=0,ALB-SG=1,target-SG=1,WAF=0,bucket=0]"],
  ["ALB_EGRESS_READY", facts.sgStage === "alb-egress-ready" && vector === "[ALB=0,TG=0,ALB-SG=1,target-SG=1,WAF=0,bucket=0]"],
  ["SG_FINAL_UNATTACHED", facts.sgStage === "final" && facts.targetAttached === false && vector === "[ALB=0,TG=0,ALB-SG=1,target-SG=1,WAF=0,bucket=0]"],
  ["TARGET_SG_ATTACHED", facts.sgStage === "final" && facts.targetAttached === true && facts.targetAttachmentExact === true && vector === "[ALB=0,TG=0,ALB-SG=1,target-SG=1,WAF=0,bucket=0]"],
  ["TARGET_GROUP_CREATED", facts.targetGroupStage === "created" && vector === "[ALB=0,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=0]"],
  ["TARGET_GROUP_READY", facts.targetGroupStage === "ready" && vector === "[ALB=0,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=0]"],
  ["ALB_CREATED", facts.albStage === "created" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=0]"],
  ["LOG_BUCKET_CREATED", facts.bucketStage === "created" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=1]"],
  ["LOG_BUCKET_PUBLIC_BLOCKED", facts.bucketStage === "public-blocked" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=1]"],
  ["LOG_BUCKET_OWNERSHIP_ENFORCED", facts.bucketStage === "ownership-enforced" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=1]"],
  ["LOG_BUCKET_ENCRYPTED", facts.bucketStage === "encrypted" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=1]"],
  ["LOG_BUCKET_LIFECYCLE_READY", facts.bucketStage === "lifecycle-ready" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=1]"],
  ["LOG_BUCKET_POLICY_READY", facts.bucketStage === "policy-ready" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=1]"],
  ["ALB_LOGGING_READY", facts.albStage === "logging-ready" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=0,bucket=1]"],
  ["WAF_CREATED", facts.wafStage === "created" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=1,bucket=1]"],
  ["WAF_ASSOCIATED", facts.wafStage === "associated" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=1,bucket=1]"],
  ["LISTENER_FIXED_404", facts.listenerStage === "fixed-404" && facts.ufwStage === "none" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=1,bucket=1]"],
  ["UFW_SUBNET_A_READY", facts.listenerStage === "fixed-404" && facts.ufwStage === "subnet-a" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=1,bucket=1]"],
  ["TASK4_PRE_GATE_B_READY", facts.listenerStage === "fixed-404" && facts.ufwStage === "ready" && vector === "[ALB=1,TG=1,ALB-SG=1,target-SG=1,WAF=1,bucket=1]"],
].filter(([, valid]) => valid);
if (matches.length !== 1 || !exact(matches.map(([stage]) => stage), [matches[0][0]])) fail();
process.stdout.write(matches[0][0]);
NODE
}

assert_remote_edge_stage() {
  local expected="$1"
  local actual
  actual="$(classify_remote_edge_stage)" || {
    echo "malformed remote edge readback or unknown/non-prefix remote edge state" >&2
    return 2
  }
  test "$actual" = "$expected" || {
    echo "unknown/non-prefix remote edge state; expected $expected, found $actual" >&2
    return 2
  }
}
```

The fresh collector derives the semantic facts above only from live API/SSM output. It rejects a duplicate named remote resource, any all-protocol permission (`permission.IpProtocol === "-1"`), any public/IPv6/prefix-list/non-ALB `8443` source, an ALB SG attached to the EC2 instance, a target SG attached anywhere except the exact EC2 primary ENI once attachment is expected, non-exact default egress, a non-`ipv4` ALB (`IpAddressType === "ipv4"` is required), non-`404` listener/default rule, pre-registration target/rule, non-exact WAF/log controls, or non-exact UFW/VPN state. These are predicates, not operator assertions.

Known safe prefixes and their sole allowed state-changing transition:

```text
FRESH -> ALB_SG_CREATED
ALB_SG_CREATED -> SGS_CREATED
SGS_CREATED -> ALB_INGRESS_READY
ALB_INGRESS_READY -> ALB_EGRESS_REVOKED
ALB_EGRESS_REVOKED -> ALB_EGRESS_READY
ALB_EGRESS_READY -> SG_FINAL_UNATTACHED
SG_FINAL_UNATTACHED -> TARGET_SG_ATTACHED
TARGET_SG_ATTACHED -> TARGET_GROUP_CREATED
TARGET_GROUP_CREATED -> TARGET_GROUP_READY
TARGET_GROUP_READY -> ALB_CREATED
ALB_CREATED -> LOG_BUCKET_CREATED
LOG_BUCKET_CREATED -> LOG_BUCKET_PUBLIC_BLOCKED
LOG_BUCKET_PUBLIC_BLOCKED -> LOG_BUCKET_OWNERSHIP_ENFORCED
LOG_BUCKET_OWNERSHIP_ENFORCED -> LOG_BUCKET_ENCRYPTED
LOG_BUCKET_ENCRYPTED -> LOG_BUCKET_LIFECYCLE_READY
LOG_BUCKET_LIFECYCLE_READY -> LOG_BUCKET_POLICY_READY
LOG_BUCKET_POLICY_READY -> ALB_LOGGING_READY
ALB_LOGGING_READY -> WAF_CREATED
WAF_CREATED -> WAF_ASSOCIATED
WAF_ASSOCIATED -> LISTENER_FIXED_404
LISTENER_FIXED_404 -> UFW_SUBNET_A_READY
UFW_SUBNET_A_READY -> TASK4_PRE_GATE_B_READY
```

`SG_FINAL_UNATTACHED` is a safe resume prefix: both named SGs have their exact final rule shapes, no named ALB/target group/WAF/bucket exists, and neither named SG is attached to the target instance. This is the current live shape. It advances only by attaching the already-validated target SG, followed by a fresh attachment readback.

`facts.json` includes only IDs resolved after duplicate rejection. Read them through this strict helper; it exits for a missing/wrong-typed field instead of falling back to an AWS `[0]` result:

```bash
remote_edge_fact() {
  node - "$REMOTE_EDGE_LIVE_DIR/facts.json" "$1" <<'NODE'
const fs = require("fs");
const [path, field] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, "utf8"))?.[field];
if (typeof value !== "string" || value.length === 0) process.exit(2);
process.stdout.write(value);
NODE
}

remote_edge_instance_group_ids() {
  node - "$REMOTE_EDGE_LIVE_DIR/facts.json" <<'NODE'
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(value?.instanceSecurityGroupIds) || value.instanceSecurityGroupIds.length === 0 ||
  value.instanceSecurityGroupIds.some((id) => typeof id !== "string" || id.length === 0)) process.exit(2);
process.stdout.write(value.instanceSecurityGroupIds.join(" "));
NODE
}

transition_security_group_prefix_once() {
  local stage="$1"
  local next=""
  local ALB_SG_ID TARGET_SG_ID CURRENT_INSTANCE_SGS

  case "$stage" in
    FRESH)
      aws ec2 create-security-group --region "$AWS_REGION" \
        --vpc-id "$VPC_ID" --group-name "$REMOTE_ALB_NAME" \
        --description "NAVA remote admin ALB ingress only" >/dev/null
      next=ALB_SG_CREATED
      ;;
    ALB_SG_CREATED)
      aws ec2 create-security-group --region "$AWS_REGION" \
        --vpc-id "$VPC_ID" --group-name "$REMOTE_TARGET_SECURITY_GROUP_NAME" \
        --description "NAVA remote admin ALB target only" >/dev/null
      next=SGS_CREATED
      ;;
    SGS_CREATED)
      ALB_SG_ID="$(remote_edge_fact albSecurityGroupId)"
      aws ec2 authorize-security-group-ingress --region "$AWS_REGION" \
        --group-id "$ALB_SG_ID" --ip-permissions \
        "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]"
      next=ALB_INGRESS_READY
      ;;
    ALB_INGRESS_READY)
      ALB_SG_ID="$(remote_edge_fact albSecurityGroupId)"
      aws ec2 revoke-security-group-egress --region "$AWS_REGION" \
        --group-id "$ALB_SG_ID" --ip-permissions \
        "IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]"
      next=ALB_EGRESS_REVOKED
      ;;
    ALB_EGRESS_REVOKED)
      ALB_SG_ID="$(remote_edge_fact albSecurityGroupId)"
      TARGET_SG_ID="$(remote_edge_fact targetSecurityGroupId)"
      aws ec2 authorize-security-group-egress --region "$AWS_REGION" \
        --group-id "$ALB_SG_ID" --ip-permissions \
        "IpProtocol=tcp,FromPort=8443,ToPort=8443,UserIdGroupPairs=[{GroupId=$TARGET_SG_ID}]"
      next=ALB_EGRESS_READY
      ;;
    ALB_EGRESS_READY)
      ALB_SG_ID="$(remote_edge_fact albSecurityGroupId)"
      TARGET_SG_ID="$(remote_edge_fact targetSecurityGroupId)"
      aws ec2 authorize-security-group-ingress --region "$AWS_REGION" \
        --group-id "$TARGET_SG_ID" --ip-permissions \
        "IpProtocol=tcp,FromPort=8443,ToPort=8443,UserIdGroupPairs=[{GroupId=$ALB_SG_ID}]"
      next=SG_FINAL_UNATTACHED
      ;;
    SG_FINAL_UNATTACHED)
      TARGET_SG_ID="$(remote_edge_fact targetSecurityGroupId)"
      CURRENT_INSTANCE_SGS="$(remote_edge_instance_group_ids)"
      case " $CURRENT_INSTANCE_SGS " in
        *" $TARGET_SG_ID "*) exit 2 ;;
      esac
      aws ec2 modify-instance-attribute --region "$AWS_REGION" \
        --instance-id "$INSTANCE_ID" --groups $CURRENT_INSTANCE_SGS "$TARGET_SG_ID"
      next=TARGET_SG_ATTACHED
      ;;
    *)
      return 3
      ;;
  esac

  REMOTE_EDGE_NEXT_STAGE="$next"
  assert_remote_edge_stage "$REMOTE_EDGE_NEXT_STAGE"
}
```

Create target group and ALB only through their matching prefixes. Target group stays HTTP `:8443`, `/health`, matcher `200`, and 30-second deregistration. Public ALB uses only pinned public subnets and the dedicated ALB SG. The availability waiter is read-only polling after the single create mutation.

```bash
transition_edge_service_prefix_once() {
  local stage="$1"
  local next=""
  local TARGET_GROUP_ARN ALB_SG_ID ALB_ARN

  case "$stage" in
    TARGET_SG_ATTACHED)
      aws elbv2 create-target-group --region "$AWS_REGION" \
        --name "$REMOTE_TARGET_GROUP_NAME" --protocol HTTP --port 8443 --vpc-id "$VPC_ID" \
        --health-check-protocol HTTP --health-check-path /health \
        --matcher HttpCode=200 --target-type instance >/dev/null
      next=TARGET_GROUP_CREATED
      ;;
    TARGET_GROUP_CREATED)
      TARGET_GROUP_ARN="$(remote_edge_fact targetGroupArn)"
      aws elbv2 modify-target-group-attributes --region "$AWS_REGION" \
        --target-group-arn "$TARGET_GROUP_ARN" \
        --attributes Key=deregistration_delay.timeout_seconds,Value=30
      next=TARGET_GROUP_READY
      ;;
    TARGET_GROUP_READY)
      ALB_SG_ID="$(remote_edge_fact albSecurityGroupId)"
      ALB_ARN="$(aws elbv2 create-load-balancer --region "$AWS_REGION" \
        --name "$REMOTE_ALB_NAME" --scheme internet-facing --type application \
        --ip-address-type ipv4 \
        --subnets "$REMOTE_ALB_SUBNET_A" "$REMOTE_ALB_SUBNET_B" \
        --security-groups "$ALB_SG_ID" \
        --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
      test -n "$ALB_ARN" && test "$ALB_ARN" != None
      aws elbv2 wait load-balancer-available --region "$AWS_REGION" \
        --load-balancer-arns "$ALB_ARN"
      next=ALB_CREATED
      ;;
    *)
      return 3
      ;;
  esac

  REMOTE_EDGE_NEXT_STAGE="$next"
  assert_remote_edge_stage "$REMOTE_EDGE_NEXT_STAGE"
}
```

Create remote log bucket in `af-south-1` through one control at a time. Never use SSE-KMS for ALB logs. A list/read failure must never be mistaken for bucket absence.

```bash
transition_log_bucket_prefix_once() {
  local stage="$1"
  local next=""
  local ALB_ARN

  case "$stage" in
    ALB_CREATED)
      aws s3api create-bucket --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
        --create-bucket-configuration LocationConstraint="$AWS_REGION"
      next=LOG_BUCKET_CREATED
      ;;
    LOG_BUCKET_CREATED)
      aws s3api put-public-access-block --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
        --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
      next=LOG_BUCKET_PUBLIC_BLOCKED
      ;;
    LOG_BUCKET_PUBLIC_BLOCKED)
      aws s3api put-bucket-ownership-controls --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
        --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'
      next=LOG_BUCKET_OWNERSHIP_ENFORCED
      ;;
    LOG_BUCKET_OWNERSHIP_ENFORCED)
      aws s3api put-bucket-encryption --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
        --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
      next=LOG_BUCKET_ENCRYPTED
      ;;
    LOG_BUCKET_ENCRYPTED)
      aws s3api put-bucket-lifecycle-configuration --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
        --lifecycle-configuration '{"Rules":[{"ID":"expire-remote-alb-logs-365d","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":365}}]}'
      next=LOG_BUCKET_LIFECYCLE_READY
      ;;
    LOG_BUCKET_LIFECYCLE_READY)
      ALB_ARN="$(remote_edge_fact albArn)"
      cat >"$EVIDENCE_DIR/remote-alb-log-bucket-policy.json" <<JSON
{"Version":"2012-10-17","Statement":[
  {"Sid":"AllowAlbLogDeliveryWrite","Effect":"Allow","Principal":{"Service":"logdelivery.elasticloadbalancing.amazonaws.com"},"Action":"s3:PutObject","Resource":"arn:aws:s3:::$REMOTE_LOG_BUCKET/AWSLogs/$AWS_ACCOUNT_ID/*","Condition":{"StringEquals":{"aws:SourceAccount":"$AWS_ACCOUNT_ID"},"ArnLike":{"aws:SourceArn":"$ALB_ARN"}}},
  {"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::$REMOTE_LOG_BUCKET","arn:aws:s3:::$REMOTE_LOG_BUCKET/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}
]}
JSON
      aws s3api put-bucket-policy --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
        --policy "file://$EVIDENCE_DIR/remote-alb-log-bucket-policy.json"
      next=LOG_BUCKET_POLICY_READY
      ;;
    LOG_BUCKET_POLICY_READY)
      ALB_ARN="$(remote_edge_fact albArn)"
      aws elbv2 modify-load-balancer-attributes --region "$AWS_REGION" \
        --load-balancer-arn "$ALB_ARN" \
        --attributes Key=access_logs.s3.enabled,Value=true Key=access_logs.s3.bucket,Value="$REMOTE_LOG_BUCKET"
      next=ALB_LOGGING_READY
      ;;
    *)
      return 3
      ;;
  esac

  REMOTE_EDGE_NEXT_STAGE="$next"
  assert_remote_edge_stage "$REMOTE_EDGE_NEXT_STAGE"
}
```

Create regional WAF with AWS managed baseline groups, source-IP 25/300-second `POST /api/auth/sign-in/email` rule, and source-IP 1000/300-second whole-remote-plane rule. The `WAF_CREATED` readback requires exact definition before its one allowed association mutation.

```bash
write_remote_admin_waf_definition() {
cat >"$EVIDENCE_DIR/remote-admin-waf.json" <<'JSON'
{
  "Name": "nava-remote-admin-waf",
  "Scope": "REGIONAL",
  "DefaultAction": {"Allow": {}},
  "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "navaRemoteAdmin"},
  "Rules": [
    {"Name":"AWS-AmazonIpReputation","Priority":10,"OverrideAction":{"None":{}},"Statement":{"ManagedRuleGroupStatement":{"VendorName":"AWS","Name":"AWSManagedRulesAmazonIpReputationList"}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemoteIpReputation"}},
    {"Name":"AWS-Common","Priority":20,"OverrideAction":{"None":{}},"Statement":{"ManagedRuleGroupStatement":{"VendorName":"AWS","Name":"AWSManagedRulesCommonRuleSet"}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemoteCommon"}},
    {"Name":"AWS-KnownBadInputs","Priority":30,"OverrideAction":{"None":{}},"Statement":{"ManagedRuleGroupStatement":{"VendorName":"AWS","Name":"AWSManagedRulesKnownBadInputsRuleSet"}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemoteKnownBad"}},
    {"Name":"signin-25-per-5m","Priority":40,"Action":{"Block":{}},"Statement":{"RateBasedStatement":{"Limit":25,"AggregateKeyType":"IP","EvaluationWindowSec":300,"ScopeDownStatement":{"AndStatement":{"Statements":[{"ByteMatchStatement":{"SearchString":"/api/auth/sign-in/email","FieldToMatch":{"UriPath":{}},"TextTransformations":[{"Priority":0,"Type":"NONE"}],"PositionalConstraint":"EXACTLY"}},{"ByteMatchStatement":{"SearchString":"POST","FieldToMatch":{"Method":{}},"TextTransformations":[{"Priority":0,"Type":"NONE"}],"PositionalConstraint":"EXACTLY"}}]}}}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemoteSigninRate"}},
    {"Name":"remote-plane-1000-per-5m","Priority":50,"Action":{"Block":{}},"Statement":{"RateBasedStatement":{"Limit":1000,"AggregateKeyType":"IP","EvaluationWindowSec":300}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemotePlaneRate"}}
  ]
}
JSON
}

transition_waf_prefix_once() {
  local stage="$1"
  local next=""
  local ALB_ARN WAF_ARN

  case "$stage" in
    ALB_LOGGING_READY)
      write_remote_admin_waf_definition
      aws wafv2 create-web-acl --region "$AWS_REGION" \
        --cli-input-json "file://$EVIDENCE_DIR/remote-admin-waf.json" >/dev/null
      next=WAF_CREATED
      ;;
    WAF_CREATED)
      ALB_ARN="$(remote_edge_fact albArn)"
      WAF_ARN="$(remote_edge_fact wafArn)"
      aws wafv2 associate-web-acl --region "$AWS_REGION" \
        --web-acl-arn "$WAF_ARN" --resource-arn "$ALB_ARN"
      next=WAF_ASSOCIATED
      ;;
    *)
      return 3
      ;;
  esac

  REMOTE_EDGE_NEXT_STAGE="$next"
  assert_remote_edge_stage "$REMOTE_EDGE_NEXT_STAGE"
}
```

Create one HTTPS listener only after live ACM readback proves the exact certificate `ISSUED`. Its sole default action is fixed `404`; no port-80 listener. Then add UFW subnet rules one at a time. Each SSM call has one `ufw allow` mutation followed by only readback commands; `vpn-health-assert.sh` must keep default route off `tun0`.

```bash
transition_listener_and_ufw_prefix_once() {
  local stage="$1"
  local next=""
  local ALB_ARN CERTIFICATE_ARN

  case "$stage" in
    WAF_ASSOCIATED)
      ALB_ARN="$(remote_edge_fact albArn)"
      CERTIFICATE_ARN="$(remote_edge_fact certificateArn)"
      aws elbv2 create-listener --region "$AWS_REGION" \
        --load-balancer-arn "$ALB_ARN" --protocol HTTPS --port 443 \
        --certificates CertificateArn="$CERTIFICATE_ARN" \
        --default-actions Type=fixed-response,FixedResponseConfig='{StatusCode=404,ContentType=text/plain,MessageBody=Not\ Found}' \
        >/dev/null
      next=LISTENER_FIXED_404
      ;;
    LISTENER_FIXED_404)
      bash apps/server-pilot/deploy/ssm-run-command.sh \
        'set -euo pipefail
         sudo ufw allow in on ens5 from 172.31.0.0/20 to any port 8443 proto tcp
         sudo ufw status numbered
         sudo ufw show added
         ss -ltnH "( sport = :443 or sport = :8443 or sport = :8788 or sport = :8789 )"
         bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'
      next=UFW_SUBNET_A_READY
      ;;
    UFW_SUBNET_A_READY)
      bash apps/server-pilot/deploy/ssm-run-command.sh \
        'set -euo pipefail
         sudo ufw allow in on ens5 from 172.31.32.0/20 to any port 8443 proto tcp
         sudo ufw status numbered
         sudo ufw show added
         ss -ltnH "( sport = :443 or sport = :8443 or sport = :8788 or sport = :8789 )"
         bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'
      next=TASK4_PRE_GATE_B_READY
      ;;
    *)
      return 3
      ;;
  esac

  REMOTE_EDGE_NEXT_STAGE="$next"
  assert_remote_edge_stage "$REMOTE_EDGE_NEXT_STAGE"
}

advance_remote_edge_once() {
  local stage
  stage="$(classify_remote_edge_stage)" || {
    echo "unknown/non-prefix remote edge state; reject before mutation" >&2
    return 2
  }

  case "$stage" in
    FRESH|ALB_SG_CREATED|SGS_CREATED|ALB_INGRESS_READY|ALB_EGRESS_REVOKED|ALB_EGRESS_READY|SG_FINAL_UNATTACHED)
      transition_security_group_prefix_once "$stage"
      ;;
    TARGET_SG_ATTACHED|TARGET_GROUP_CREATED|TARGET_GROUP_READY)
      transition_edge_service_prefix_once "$stage"
      ;;
    ALB_CREATED|LOG_BUCKET_CREATED|LOG_BUCKET_PUBLIC_BLOCKED|LOG_BUCKET_OWNERSHIP_ENFORCED|LOG_BUCKET_ENCRYPTED|LOG_BUCKET_LIFECYCLE_READY|LOG_BUCKET_POLICY_READY)
      transition_log_bucket_prefix_once "$stage"
      ;;
    ALB_LOGGING_READY|WAF_CREATED)
      transition_waf_prefix_once "$stage"
      ;;
    WAF_ASSOCIATED|LISTENER_FIXED_404|UFW_SUBNET_A_READY)
      transition_listener_and_ufw_prefix_once "$stage"
      ;;
    TASK4_PRE_GATE_B_READY)
      echo "Task 4 pre-Gate-B edge complete; stop for Gate B" >&2
      return 0
      ;;
    *)
      echo "unknown/non-prefix remote edge state; reject before mutation" >&2
      return 2
      ;;
  esac
}
```

Run `advance_remote_edge_once` once per invocation. Never loop it or paste several transition bodies into one shell. After Gate B has established remote CORS, `verify_remote_edge_state` is final semantic readback:

```bash
verify_remote_edge_state() {
  REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0 \
    bash apps/server-pilot/deploy/launch-readiness.sh
}
```

### Gate B and Task 5 handoff

After ALB DNS is known, stop at Gate B. Operator saves `nava-admin.trynava.io CNAME → ALB DNS name`, replies **“nava-admin CNAME saved”**, then operator polls DNS for at most 45 minutes. Never use a wildcard origin.

Only after DNS settles, use this additive mail-bucket CORS protocol. It preserves all existing valid rules, adds remote origin only to one GET/HEAD rule, validates immediate readback, and refuses rollback when another operator changed state.

```bash
export MAIL_BUCKET=nava-zero-mail-845242190536-af-south-1
CORS_BEFORE="$EVIDENCE_DIR/mail-cors-before.json"
CORS_INTENDED="$EVIDENCE_DIR/mail-cors-intended.json"
CORS_APPLIED="$EVIDENCE_DIR/mail-cors-applied.json"

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
  --cors-configuration "file://$CORS_INTENDED"
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
```

To roll back, first read current CORS into a new evidence file and semantically compare it to `$CORS_APPLIED`; only an exact match may restore `$CORS_BEFORE`, followed by the same immediate semantic readback. A mismatch means another operator changed CORS: stop and preserve both snapshots.

Only Task 5 may:

```bash
aws elbv2 register-targets --region "$AWS_REGION" \
  --target-group-arn "$TARGET_GROUP_ARN" --targets Id="$INSTANCE_ID",Port=8443
aws elbv2 create-rule --region "$AWS_REGION" --listener-arn "$LISTENER_ARN" \
  --priority 10 \
  --conditions Field=host-header,Values="$REMOTE_ADMIN_HOST" \
  --actions Type=forward,TargetGroupArn="$TARGET_GROUP_ARN"
```

Prove ALB log delivery with one harmless body-discarding request and bounded polling. This emits only a boolean result: no request headers, response body, S3 key, secret, or PII.

```bash
: "${ALB_DNS_NAME:?ALB DNS name required}"
LOG_PROOF_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG_PROOF_DEADLINE=$(( $(date +%s) + 900 ))

curl --silent --show-error --output /dev/null --max-time 10 \
  --connect-to "${REMOTE_ADMIN_HOST}:443:${ALB_DNS_NAME}:443" \
  "https://${REMOTE_ADMIN_HOST}/"

LOG_DELIVERED=false
while [ "$(date +%s)" -lt "$LOG_PROOF_DEADLINE" ]; do
  if aws s3api list-objects-v2 --region "$AWS_REGION" \
    --bucket "$REMOTE_LOG_BUCKET" \
    --prefix "AWSLogs/$AWS_ACCOUNT_ID/" \
    --output json |
    node -e '
      const chunks = [];
      process.stdin.on("data", (chunk) => chunks.push(chunk));
      process.stdin.on("end", () => {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const started = Date.parse(process.argv[1]);
        const found = (value.Contents ?? []).some((item) =>
          typeof item?.LastModified === "string" &&
          Date.parse(item.LastModified) >= started,
        );
        process.exit(found ? 0 : 1);
      });
    ' "$LOG_PROOF_STARTED_AT"; then
    LOG_DELIVERED=true
    break
  fi
  sleep 15
done
test "$LOG_DELIVERED" = true
printf '%s\n' '{"accessLogDelivered":true}'
```

Then require `REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=1` readiness, exact fixed-404 listener fallback, exact host-forward rule, healthy target, proven bounded log delivery, and no direct target path.

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
