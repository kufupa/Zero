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
| S3 lifecycle | `raw-mime/*` expire 30d, `attachments/*` expire 90d, incomplete multipart abort 1d |
| S3 CORS | Cutover overlap: canonical + legacy + localhost GET/HEAD. Final after 24h: canonical + localhost GET/HEAD; legacy removed. No wildcard origins. |
| Bootstrap bucket (Task 1) | `nava-zero-bootstrap-845242190536` |

## EC2 instance profile inline policies

| Policy name | Grants |
|-------------|-------|
| `NavaZeroBootstrapBundleRead` (Task 1) | `s3:GetObject` on `nava-zero-bootstrap-845242190536/git-bundles/*`, `vpn-nava/*`, and `mail-navaai/*`; `s3:ListBucket` on bootstrap bucket (prefixes `git-bundles/*`, `vpn-nava/*`, `mail-navaai/*`) |
| `NavaZeroMailBucketAccess` | `s3:ListBucket` / `s3:GetBucketLocation` / `s3:ListBucketMultipartUploads` on mail bucket; `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` / `s3:AbortMultipartUpload` / `s3:ListMultipartUploadParts` on mail bucket `/*` |
| `NavaZeroSecretsRead` | `secretsmanager:GetSecretValue` / `secretsmanager:DescribeSecret` on `nava-zero/server-pilot/database-url-*` and `nava-zero/server-pilot/infor-hms-read-*` |
| `NavaZeroRDSConnect` | `rds-db:connect` on `dbuser:nava-zero-mail-pilot/zero_admin` (for future IAM DB auth; password auth used today via SG routing) |
| `NavaZeroBedrockInvoke` | `bedrock:InvokeModel` on `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0`; optional `bedrock:ApplyGuardrail` when guardrail env vars set |

## Provisioning commands (re-runnable, idempotent-ish)

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
aws s3api put-bucket-lifecycle-configuration --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --lifecycle-configuration '{"Rules":[{"ID":"expire-raw-mime-30d","Status":"Enabled","Filter":{"Prefix":"raw-mime/"},"Expiration":{"Days":30}},{"ID":"expire-attachments-90d","Status":"Enabled","Filter":{"Prefix":"attachments/"},"Expiration":{"Days":90}},{"ID":"abort-incomplete-multipart-1d","Status":"Enabled","Filter":{"Prefix":""},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'
# Browser attachment fetch during cutover overlap. Origin allowlist only — never *.
aws s3api put-bucket-cors --region "$AWS_REGION" --bucket "$NAVA_MAIL_BUCKET" --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://nava.legacyhotels.co.za","https://nava.legacy.local","http://localhost:3000","https://localhost:3000"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Disposition","Content-Type","Content-Length"],"MaxAgeSeconds":300}]}'

# 6. EC2 instance role inline policies
ROLE=nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroMailBucketAccess --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation","s3:ListBucketMultipartUploads"],"Resource":"arn:aws:s3:::'"$NAVA_MAIL_BUCKET"'"},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":"arn:aws:s3:::'"$NAVA_MAIL_BUCKET"'/*"}]}'
aws iam put-role-policy --region "$AWS_REGION" --role-name "$ROLE" --policy-name NavaZeroSecretsRead --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"],"Resource":["arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/database-url-*","arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/infor-hms-read-*"]}]}'
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
