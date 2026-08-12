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
  permission.IpProtocol === "tcp" &&
  Number(permission.FromPort) <= 8443 &&
  Number(permission.ToPort) >= 8443;
if (groups.some((group) => (group.IpPermissions ?? []).some(opens8443))) {
  process.exit(2);
}
NODE
```

DNS control is not an AWS fact. A Lovable DNS operator must confirm ability to save both required CNAME records before continuing:

```bash
: "${LOVABLE_DNS_CONTROL_CONFIRMED:?set only after operator confirms Lovable DNS control}"
test "$LOVABLE_DNS_CONTROL_CONFIRMED" = 1
```

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

Stop and report **BLOCKED** when any preflight assertion, DNS-control attestation, or required action fails. Do not compensate with broad policies, alternate subnets, or guessed IDs.

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

Create or read each deterministic resource by name. If existing resource differs from this contract, stop; do not replace it.

```bash
ALB_SG_ID="$(aws ec2 describe-security-groups --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$REMOTE_ALB_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text)"
if [ -z "$ALB_SG_ID" ] || [ "$ALB_SG_ID" = None ]; then
  ALB_SG_ID="$(aws ec2 create-security-group --region "$AWS_REGION" \
    --vpc-id "$VPC_ID" --group-name "$REMOTE_ALB_NAME" \
    --description "NAVA remote admin ALB ingress only" \
    --query GroupId --output text)"
fi

TARGET_SG_ID="$(aws ec2 describe-security-groups --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$REMOTE_TARGET_SECURITY_GROUP_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text)"
if [ -z "$TARGET_SG_ID" ] || [ "$TARGET_SG_ID" = None ]; then
  TARGET_SG_ID="$(aws ec2 create-security-group --region "$AWS_REGION" \
    --vpc-id "$VPC_ID" --group-name "$REMOTE_TARGET_SECURITY_GROUP_NAME" \
    --description "NAVA remote admin ALB target only" \
    --query GroupId --output text)"
fi
```

Read both SGs before each write. Required final shape: ALB SG inbound TCP/443 only from `0.0.0.0/0`; ALB SG outbound TCP/8443 only to `$TARGET_SG_ID`; target SG inbound TCP/8443 only from `$ALB_SG_ID`. Revoke the new-SG default all-egress rule before adding the single ALB egress rule. Use `describe-security-groups` semantic readback after every authorization/revocation and stop on any CIDR, IPv6, prefix-list, or second SG source for TCP/8443.

```bash
# Run each authorization only after the required permission is absent in readback.
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" \
  --group-id "$ALB_SG_ID" --ip-permissions \
  "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]"
aws ec2 revoke-security-group-egress --region "$AWS_REGION" \
  --group-id "$ALB_SG_ID" --ip-permissions \
  "IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]"
aws ec2 authorize-security-group-egress --region "$AWS_REGION" \
  --group-id "$ALB_SG_ID" --ip-permissions \
  "IpProtocol=tcp,FromPort=8443,ToPort=8443,UserIdGroupPairs=[{GroupId=$TARGET_SG_ID}]"
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" \
  --group-id "$TARGET_SG_ID" --ip-permissions \
  "IpProtocol=tcp,FromPort=8443,ToPort=8443,UserIdGroupPairs=[{GroupId=$ALB_SG_ID}]"
```

Attach target SG without replacing existing groups, then read every attached SG and enforce that all TCP/8443 permissions are ALB-SG-only:

```bash
CURRENT_INSTANCE_SGS="$(aws ec2 describe-instances --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)"
case " $CURRENT_INSTANCE_SGS " in *" $TARGET_SG_ID "*) ;; *)
  aws ec2 modify-instance-attribute --region "$AWS_REGION" \
    --instance-id "$INSTANCE_ID" --groups $CURRENT_INSTANCE_SGS "$TARGET_SG_ID"
esac
aws ec2 describe-security-groups --region "$AWS_REGION" \
  --group-ids $CURRENT_INSTANCE_SGS "$TARGET_SG_ID" --output json \
  >"$EVIDENCE_DIR/attached-security-groups-after-target.json"
```

Create target group and ALB only when absent. Target group uses HTTP `:8443`, `/health`, matcher `200`, and 30-second deregistration. Public ALB uses only the two pinned public subnets.

```bash
TARGET_GROUP_ARN="$(aws elbv2 describe-target-groups --region "$AWS_REGION" \
  --names "$REMOTE_TARGET_GROUP_NAME" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
if [ -z "$TARGET_GROUP_ARN" ] || [ "$TARGET_GROUP_ARN" = None ]; then
  TARGET_GROUP_ARN="$(aws elbv2 create-target-group --region "$AWS_REGION" \
    --name "$REMOTE_TARGET_GROUP_NAME" --protocol HTTP --port 8443 --vpc-id "$VPC_ID" \
    --health-check-protocol HTTP --health-check-path /health \
    --matcher HttpCode=200 --target-type instance \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
fi
aws elbv2 modify-target-group-attributes --region "$AWS_REGION" \
  --target-group-arn "$TARGET_GROUP_ARN" \
  --attributes Key=deregistration_delay.timeout_seconds,Value=30

ALB_ARN="$(aws elbv2 describe-load-balancers --region "$AWS_REGION" \
  --names "$REMOTE_ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)"
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = None ]; then
  ALB_ARN="$(aws elbv2 create-load-balancer --region "$AWS_REGION" \
    --name "$REMOTE_ALB_NAME" --scheme internet-facing --type application \
    --ip-address-type ipv4 \
    --subnets "$REMOTE_ALB_SUBNET_A" "$REMOTE_ALB_SUBNET_B" \
    --security-groups "$ALB_SG_ID" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
fi
```

Create remote log bucket in `af-south-1`, then enforce exact controls. Never use SSE-KMS for ALB logs.

```bash
aws s3api head-bucket --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" >/dev/null 2>&1 ||
  aws s3api create-bucket --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION"
aws s3api put-public-access-block --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
  --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'
aws s3api put-bucket-encryption --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-lifecycle-configuration --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-remote-alb-logs-365d","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":365}}]}'
cat >"$EVIDENCE_DIR/remote-alb-log-bucket-policy.json" <<JSON
{"Version":"2012-10-17","Statement":[
  {"Sid":"AllowAlbLogDeliveryWrite","Effect":"Allow","Principal":{"Service":"logdelivery.elasticloadbalancing.amazonaws.com"},"Action":"s3:PutObject","Resource":"arn:aws:s3:::$REMOTE_LOG_BUCKET/AWSLogs/$AWS_ACCOUNT_ID/*","Condition":{"StringEquals":{"aws:SourceAccount":"$AWS_ACCOUNT_ID"},"ArnLike":{"aws:SourceArn":"$ALB_ARN"}}},
  {"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::$REMOTE_LOG_BUCKET","arn:aws:s3:::$REMOTE_LOG_BUCKET/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}
]}
JSON
aws s3api put-bucket-policy --region "$AWS_REGION" --bucket "$REMOTE_LOG_BUCKET" \
  --policy "file://$EVIDENCE_DIR/remote-alb-log-bucket-policy.json"
aws elbv2 modify-load-balancer-attributes --region "$AWS_REGION" \
  --load-balancer-arn "$ALB_ARN" \
  --attributes Key=access_logs.s3.enabled,Value=true Key=access_logs.s3.bucket,Value="$REMOTE_LOG_BUCKET"
```

Create regional WAF with AWS managed baseline groups, source-IP 25/300-second `POST /api/auth/sign-in/email` rule, and source-IP 1000/300-second whole-remote-plane rule. Attach only to `$ALB_ARN`.

```bash
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
WAF_ID="$(aws wafv2 list-web-acls --region "$AWS_REGION" --scope REGIONAL \
  --query "WebACLs[?Name=='$REMOTE_WAF_NAME'].Id | [0]" --output text)"
if [ -z "$WAF_ID" ] || [ "$WAF_ID" = None ]; then
  WAF_ARN="$(aws wafv2 create-web-acl --region "$AWS_REGION" \
    --cli-input-json "file://$EVIDENCE_DIR/remote-admin-waf.json" \
    --query Summary.ARN --output text)"
else
  WAF_ARN="$(aws wafv2 get-web-acl --region "$AWS_REGION" --scope REGIONAL \
    --name "$REMOTE_WAF_NAME" --id "$WAF_ID" --query WebACL.ARN --output text)"
fi
CURRENT_WAF_ARN="$(aws wafv2 get-web-acl-for-resource --region "$AWS_REGION" \
  --resource-arn "$ALB_ARN" --query WebACL.ARN --output text 2>/dev/null || true)"
if [ "$CURRENT_WAF_ARN" != "$WAF_ARN" ]; then
  test -z "$CURRENT_WAF_ARN" || test "$CURRENT_WAF_ARN" = None
  aws wafv2 associate-web-acl --region "$AWS_REGION" \
    --web-acl-arn "$WAF_ARN" --resource-arn "$ALB_ARN"
fi
```

Create one HTTPS listener only after ACM is `ISSUED`. Its sole default action is fixed `404`; no port-80 listener. Do not call `register-targets` or `create-rule` in Task 4.

```bash
LISTENER_ARN="$(aws elbv2 describe-listeners --region "$AWS_REGION" \
  --load-balancer-arn "$ALB_ARN" \
  --query 'Listeners[?Protocol==`HTTPS` && Port==`443`].ListenerArn | [0]' \
  --output text)"
if [ -z "$LISTENER_ARN" ] || [ "$LISTENER_ARN" = None ]; then
  LISTENER_ARN="$(aws elbv2 create-listener --region "$AWS_REGION" \
    --load-balancer-arn "$ALB_ARN" --protocol HTTPS --port 443 \
    --certificates CertificateArn="$CERTIFICATE_ARN" \
    --default-actions Type=fixed-response,FixedResponseConfig='{StatusCode=404,ContentType=text/plain,MessageBody=Not\ Found}' \
    --query 'Listeners[0].ListenerArn' --output text)"
fi
```

Use SSM only after target SG attach to add exact host-firewall rules. Preserve exact `tun0:443`; accept ALB subnet traffic only on `ens5:8443`.

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'set -euo pipefail
   sudo ufw allow in on ens5 from 172.31.0.0/20 to any port 8443 proto tcp
   sudo ufw allow in on ens5 from 172.31.32.0/20 to any port 8443 proto tcp
   sudo ufw status numbered
   sudo ufw show added
   ss -ltnH "( sport = :443 or sport = :8443 or sport = :8788 or sport = :8789 )"
   bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'
```

Capture only parsed booleans plus expected listener interfaces in evidence. `vpn-health-assert.sh` must keep default route off `tun0`.

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
if (rules.length === 0 || rules.some((rule) =>
  !Array.isArray(rule?.AllowedOrigins) ||
  rule.AllowedOrigins.some((origin) => typeof origin !== "string" || origin.includes("*")) ||
  !Array.isArray(rule?.AllowedMethods),
)) {
  process.exit(2);
}
const target = rules.find((rule) =>
  rule.AllowedMethods.includes("GET") && rule.AllowedMethods.includes("HEAD"),
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
const valid = [intended, applied].every((value) =>
  Array.isArray(value?.CORSRules) &&
  value.CORSRules.some((rule) =>
    Array.isArray(rule?.AllowedOrigins) &&
    Array.isArray(rule?.AllowedMethods) &&
    !rule.AllowedOrigins.some((origin) => origin.includes("*")) &&
    rule.AllowedOrigins.includes(remoteOrigin) &&
    rule.AllowedMethods.includes("GET") &&
    rule.AllowedMethods.includes("HEAD"),
  ),
);
if (!valid) process.exit(2);
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

Then require `REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=1` readiness, exact fixed-404 listener fallback, exact host-forward rule, healthy target, log delivery after harmless remote-host request within 15 minutes, and no direct target path.

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
