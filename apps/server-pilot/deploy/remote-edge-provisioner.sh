#!/usr/bin/env bash
set -euo pipefail
set +x

readonly AWS_REGION='af-south-1'
readonly AWS_ACCOUNT_ID='845242190536'
readonly VPC_ID='vpc-0f078e17a5f0f8599'
readonly INSTANCE_ID='i-008f737974a9ba9b3'
readonly TARGET_PRIVATE_IP='172.31.12.112'
readonly ALB_SUBNET_A='subnet-0e6446aaaeaa8762e'
readonly ALB_SUBNET_B='subnet-094bf8643d98c22f6'
readonly REMOTE_HOST='nava-admin.trynava.io'
readonly ALB_NAME='nava-remote-admin-alb'
readonly TARGET_GROUP_NAME='nava-remote-admin'
readonly TARGET_SECURITY_GROUP_NAME='nava-remote-admin-target'
readonly WAF_NAME='nava-remote-admin-waf'
readonly LOG_BUCKET='nava-zero-remote-alb-logs-845242190536-af-south-1'
readonly MAIL_BUCKET='nava-zero-mail-845242190536-af-south-1'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly STATE_MODULE="$SCRIPT_DIR/remote-edge-state.mjs"

die() {
  printf '%s\n' 'remote-edge: blocked' >&2
  exit 2
}

usage() {
  printf '%s\n' \
    'usage: remote-edge-provisioner.sh inspect [--evidence-root DIR]' \
    '       remote-edge-provisioner.sh apply-one --action ACTION [--evidence-root DIR]' >&2
  exit 2
}

require_safe_binary() {
  local value="$1"
  if [[ "$value" == 'aws' ]]; then
    return 0
  fi
  [[ -f "$value" && -x "$value" ]] || die
}

parse_cli() {
  [[ $# -ge 1 ]] || usage
  COMMAND="$1"
  shift
  EVIDENCE_ROOT="$HOME/.nava-remote-edge-evidence"
  ACTION=''
  case "$COMMAND" in
    inspect)
      if [[ $# -eq 0 ]]; then
        return 0
      fi
      [[ $# -eq 2 && "$1" == '--evidence-root' && -n "$2" ]] || usage
      EVIDENCE_ROOT="$2"
      ;;
    apply-one)
      [[ $# -ge 2 && "$1" == '--action' && -n "$2" ]] || usage
      ACTION="$2"
      shift 2
      if [[ $# -eq 0 ]]; then
        return 0
      fi
      [[ $# -eq 2 && "$1" == '--evidence-root' && -n "$2" ]] || usage
      EVIDENCE_ROOT="$2"
      ;;
    *)
      usage
      ;;
  esac
}

parse_cli "$@"
require_safe_binary "${REMOTE_EDGE_AWS_BIN:-aws}"
require_safe_binary "${REMOTE_EDGE_SSM_BIN:-${REMOTE_EDGE_AWS_BIN:-aws}}"
AWS_BIN="${REMOTE_EDGE_AWS_BIN:-aws}"
SSM_BIN="${REMOTE_EDGE_SSM_BIN:-$AWS_BIN}"
AWS=("$AWS_BIN")
SSM=("$SSM_BIN")

[[ -f "$STATE_MODULE" ]] || die
umask 077
mkdir -p -- "$EVIDENCE_ROOT"
chmod 700 -- "$EVIDENCE_ROOT"
SCRATCH_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/nava-remote-edge.XXXXXX")"
chmod 700 -- "$SCRATCH_ROOT"
trap 'rm -rf -- "$SCRATCH_ROOT"' EXIT

capture() {
  local scratch="$1"
  local file="$2"
  shift 2
  "${AWS[@]}" --no-cli-pager "$@" >"$scratch/$file" 2>/dev/null || die
  chmod 600 -- "$scratch/$file"
}

capture_optional() {
  local scratch="$1"
  local file="$2"
  local expected_error="$3"
  local error_file="$scratch/.optional-error"
  shift 3
  if "${AWS[@]}" --no-cli-pager "$@" >"$scratch/$file" 2>"$error_file"; then
    chmod 600 -- "$scratch/$file"
    return 0
  fi
  if [[ "$( < "$error_file" )" == *"$expected_error"* ]]; then
    printf '%s\n' '{"absent":true}' >"$scratch/$file"
    chmod 600 -- "$scratch/$file"
    return 0
  fi
  die
}

state_bridge() {
  local scratch="$1"
  local mode="$2"
  REMOTE_EDGE_SCRATCH="$scratch" \
    REMOTE_EDGE_BRIDGE_MODE="$mode" \
    REMOTE_EDGE_STATE_MODULE="$STATE_MODULE" \
    node --input-type=module <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const scratch = process.env.REMOTE_EDGE_SCRATCH;
const mode = process.env.REMOTE_EDGE_BRIDGE_MODE;
const moduleUrl = pathToFileURL(process.env.REMOTE_EDGE_STATE_MODULE).href;
const state = await import(moduleUrl);
const names = [
  'identity',
  'instance',
  'networkInterfaces',
  'securityGroups',
  'subnets',
  'routeTables',
  'certificates',
  'certificate',
  'albs',
  'targetGroups',
  'targetGroupAttributes',
  'targetHealth',
  'wafs',
  'waf',
  'wafResources',
  'buckets',
  'bucketLocation',
  'bucketPublicAccess',
  'bucketOwnership',
  'bucketEncryption',
  'bucketLifecycle',
  'bucketPolicy',
  'listeners',
  'listenerRules',
  'albAttributes',
  'mailCors',
  'host',
];
const projections = Object.fromEntries(
  names.map((name) => {
    const path = `${scratch}/${name}.json`;
    return [name, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined];
  }),
);
if (mode === 'refs') {
  process.stdout.write(JSON.stringify(state.deriveReferences(projections)));
} else if (mode === 'result') {
  process.stdout.write(JSON.stringify(state.classifyFacts(state.deriveFacts(projections))));
} else if (mode === 'next') {
  process.stdout.write(state.nextStage(process.env.REMOTE_EDGE_STAGE) ?? '');
} else {
  process.exit(2);
}
NODE
}

write_refs() {
  local scratch="$1"
  state_bridge "$scratch" refs >"$scratch/refs.json" 2>/dev/null || die
  chmod 600 -- "$scratch/refs.json"
}

reference() {
  local scratch="$1"
  local field="$2"
  node - "$scratch/refs.json" "$field" <<'NODE'
const fs = require('fs');
const [path, field] = process.argv.slice(2);
const allowed = new Set([
  'albSecurityGroupId',
  'targetSecurityGroupId',
  'albArn',
  'targetGroupArn',
  'wafArn',
  'wafId',
  'certificateArn',
  'listenerArn',
]);
if (!allowed.has(field)) process.exit(2);
const value = JSON.parse(fs.readFileSync(path, 'utf8'))[field];
if (value === null || value === undefined) process.exit(0);
if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) process.exit(2);
process.stdout.write(value);
NODE
}

instance_group_ids() {
  local scratch="$1"
  node - "$scratch/refs.json" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).instanceGroupIds;
if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string' || !/^sg-[A-Za-z0-9-]+$/.test(id))) {
  process.exit(2);
}
process.stdout.write(value.join('\n'));
NODE
}

command_id() {
  local path="$1"
  node - "$path" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))?.Command?.CommandId;
if (typeof value !== 'string' || !/^[A-Za-z0-9-]+$/.test(value)) process.exit(2);
process.stdout.write(value);
NODE
}

assert_ssm_success() {
  local path="$1"
  node - "$path" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value?.Status !== 'Success' || typeof value?.StandardOutputContent !== 'string' || value?.StandardErrorContent !== '') {
  process.exit(2);
}
NODE
}

observe_host() {
  local scratch="$1"
  local command_id_value
  local parameters
  parameters='{"commands":["set -eu; printf \"__REMOTE_EDGE_UFW_STATUS__\\n\"; ufw status numbered; printf \"__REMOTE_EDGE_UFW_ADDED__\\n\"; ufw show added; printf \"__REMOTE_EDGE_SOCKETS__\\n\"; ss -ltnH; printf \"__REMOTE_EDGE_ROUTE__\\n\"; ip route show default"]}'
  "${SSM[@]}" --no-cli-pager ssm send-command \
    --document-name AWS-RunShellScript \
    --instance-ids "$INSTANCE_ID" \
    --parameters "$parameters" \
    --output json >"$scratch/host-command.json" 2>/dev/null || die
  chmod 600 -- "$scratch/host-command.json"
  command_id_value="$(command_id "$scratch/host-command.json")" || die
  "${SSM[@]}" --no-cli-pager ssm get-command-invocation \
    --command-id "$command_id_value" \
    --instance-id "$INSTANCE_ID" \
    --output json >"$scratch/host.json" 2>/dev/null || die
  chmod 600 -- "$scratch/host.json"
}

collect_current() {
  local scratch="$1"
  local certificate_arn
  local alb_arn
  local target_group_arn
  local waf_arn
  local waf_id
  local listener_arn
  mkdir -m 700 -- "$scratch"
  capture "$scratch" identity.json sts get-caller-identity --output json
  capture "$scratch" instance.json ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" --output json
  capture "$scratch" networkInterfaces.json ec2 describe-network-interfaces --region "$AWS_REGION" --filters "Name=vpc-id,Values=$VPC_ID" --output json
  capture "$scratch" securityGroups.json ec2 describe-security-groups --region "$AWS_REGION" --filters "Name=vpc-id,Values=$VPC_ID" --output json
  capture "$scratch" subnets.json ec2 describe-subnets --region "$AWS_REGION" --subnet-ids "$ALB_SUBNET_A" "$ALB_SUBNET_B" --output json
  capture "$scratch" routeTables.json ec2 describe-route-tables --region "$AWS_REGION" --filters "Name=vpc-id,Values=$VPC_ID" --output json
  capture "$scratch" certificates.json acm list-certificates --region "$AWS_REGION" --certificate-statuses ISSUED --output json
  capture "$scratch" albs.json elbv2 describe-load-balancers --region "$AWS_REGION" --output json
  capture "$scratch" targetGroups.json elbv2 describe-target-groups --region "$AWS_REGION" --output json
  capture "$scratch" wafs.json wafv2 list-web-acls --region "$AWS_REGION" --scope REGIONAL --output json
  capture "$scratch" buckets.json s3api list-buckets --output json
  capture "$scratch" mailCors.json s3api get-bucket-cors --region "$AWS_REGION" --bucket "$MAIL_BUCKET" --output json
  write_refs "$scratch"

  certificate_arn="$(reference "$scratch" certificateArn)" || die
  capture "$scratch" certificate.json acm describe-certificate --region "$AWS_REGION" --certificate-arn "$certificate_arn" --output json

  target_group_arn="$(reference "$scratch" targetGroupArn)" || die
  if [[ -n "$target_group_arn" ]]; then
    capture "$scratch" targetGroupAttributes.json elbv2 describe-target-group-attributes --region "$AWS_REGION" --target-group-arn "$target_group_arn" --output json
    capture "$scratch" targetHealth.json elbv2 describe-target-health --region "$AWS_REGION" --target-group-arn "$target_group_arn" --output json
  fi

  alb_arn="$(reference "$scratch" albArn)" || die
  if [[ -n "$alb_arn" ]]; then
    capture "$scratch" albAttributes.json elbv2 describe-load-balancer-attributes --region "$AWS_REGION" --load-balancer-arn "$alb_arn" --output json
    capture "$scratch" listeners.json elbv2 describe-listeners --region "$AWS_REGION" --load-balancer-arn "$alb_arn" --output json
    write_refs "$scratch"
    listener_arn="$(reference "$scratch" listenerArn)" || die
    if [[ -n "$listener_arn" ]]; then
      capture "$scratch" listenerRules.json elbv2 describe-rules --region "$AWS_REGION" --listener-arn "$listener_arn" --output json
    fi
  fi

  waf_arn="$(reference "$scratch" wafArn)" || die
  waf_id="$(reference "$scratch" wafId)" || die
  if [[ -n "$waf_arn" ]]; then
    capture "$scratch" waf.json wafv2 get-web-acl --region "$AWS_REGION" --scope REGIONAL --name "$WAF_NAME" --id "$waf_id" --output json
    capture "$scratch" wafResources.json wafv2 list-resources-for-web-acl --region "$AWS_REGION" --web-acl-arn "$waf_arn" --output json
  fi

  if [[ -n "$(node - "$scratch/refs.json" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).bucket;
process.stdout.write(value ? '1' : '');
NODE
)" ]]; then
    capture "$scratch" bucketLocation.json s3api get-bucket-location --region "$AWS_REGION" --bucket "$LOG_BUCKET" --output json
    capture_optional "$scratch" bucketPublicAccess.json 'NoSuchPublicAccessBlockConfiguration' s3api get-public-access-block --region "$AWS_REGION" --bucket "$LOG_BUCKET" --output json
    capture_optional "$scratch" bucketOwnership.json 'OwnershipControlsNotFoundError' s3api get-bucket-ownership-controls --region "$AWS_REGION" --bucket "$LOG_BUCKET" --output json
    capture_optional "$scratch" bucketEncryption.json 'ServerSideEncryptionConfigurationNotFoundError' s3api get-bucket-encryption --region "$AWS_REGION" --bucket "$LOG_BUCKET" --output json
    capture_optional "$scratch" bucketLifecycle.json 'NoSuchLifecycleConfiguration' s3api get-bucket-lifecycle-configuration --region "$AWS_REGION" --bucket "$LOG_BUCKET" --output json
    capture_optional "$scratch" bucketPolicy.json 'NoSuchBucketPolicy' s3api get-bucket-policy --region "$AWS_REGION" --bucket "$LOG_BUCKET" --output json
  fi

  observe_host "$scratch"
  state_bridge "$scratch" result >"$scratch/result.json" 2>/dev/null || die
  chmod 600 -- "$scratch/result.json"
}

result_stage() {
  local result_path="$1"
  node - "$result_path" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (typeof value?.stage !== 'string' || !/^[A-Z0-9_]+$/.test(value.stage)) process.exit(2);
process.stdout.write(value.stage);
NODE
}

result_action() {
  local result_path="$1"
  node - "$result_path" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (typeof value?.action !== 'string' || !/^[A-Z0-9_]+$/.test(value.action)) process.exit(2);
process.stdout.write(value.action);
NODE
}

write_bucket_policy() {
  local scratch="$1"
  node - "$scratch/refs.json" "$scratch/log-bucket-policy.json" <<'NODE'
const fs = require('fs');
const [refsPath, outputPath] = process.argv.slice(2);
const refs = JSON.parse(fs.readFileSync(refsPath, 'utf8'));
if (typeof refs.albArn !== 'string' || !refs.albArn.startsWith('arn:aws:')) process.exit(2);
const bucket = 'nava-zero-remote-alb-logs-845242190536-af-south-1';
const account = '845242190536';
const policy = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowAlbLogDeliveryWrite',
      Effect: 'Allow',
      Principal: { Service: 'logdelivery.elasticloadbalancing.amazonaws.com' },
      Action: 's3:PutObject',
      Resource: `arn:aws:s3:::${bucket}/AWSLogs/${account}/*`,
      Condition: {
        StringEquals: { 'aws:SourceAccount': account },
        ArnLike: { 'aws:SourceArn': refs.albArn },
      },
    },
    {
      Sid: 'DenyInsecureTransport',
      Effect: 'Deny',
      Principal: '*',
      Action: 's3:*',
      Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    },
  ],
};
fs.writeFileSync(outputPath, JSON.stringify(policy), { mode: 0o600 });
NODE
  chmod 600 -- "$scratch/log-bucket-policy.json"
}

write_waf_definition() {
  local scratch="$1"
  cat >"$scratch/waf.json" <<'JSON'
{"Name":"nava-remote-admin-waf","Scope":"REGIONAL","DefaultAction":{"Allow":{}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemoteAdmin"},"Rules":[{"Name":"AWS-AmazonIpReputation","Priority":10,"OverrideAction":{"None":{}},"Statement":{"ManagedRuleGroupStatement":{"VendorName":"AWS","Name":"AWSManagedRulesAmazonIpReputationList"}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemoteIpReputation"}},{"Name":"AWS-Common","Priority":20,"OverrideAction":{"None":{}},"Statement":{"ManagedRuleGroupStatement":{"VendorName":"AWS","Name":"AWSManagedRulesCommonRuleSet"}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemoteCommon"}},{"Name":"AWS-KnownBadInputs","Priority":30,"OverrideAction":{"None":{}},"Statement":{"ManagedRuleGroupStatement":{"VendorName":"AWS","Name":"AWSManagedRulesKnownBadInputsRuleSet"}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemoteKnownBadInputs"}},{"Name":"signin-25-per-5m","Priority":40,"Action":{"Block":{}},"Statement":{"RateBasedStatement":{"Limit":25,"AggregateKeyType":"IP","EvaluationWindowSec":300,"ScopeDownStatement":{"AndStatement":{"Statements":[{"ByteMatchStatement":{"SearchString":"/api/auth/sign-in/email","FieldToMatch":{"UriPath":{}},"TextTransformations":[{"Priority":0,"Type":"NONE"}],"PositionalConstraint":"EXACTLY"}},{"ByteMatchStatement":{"SearchString":"POST","FieldToMatch":{"Method":{}},"TextTransformations":[{"Priority":0,"Type":"NONE"}],"PositionalConstraint":"EXACTLY"}}]}}}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemoteSigninRate"}},{"Name":"remote-plane-1000-per-5m","Priority":50,"Action":{"Block":{}},"Statement":{"RateBasedStatement":{"Limit":1000,"AggregateKeyType":"IP","EvaluationWindowSec":300}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"navaRemotePlaneRate"}}]}
JSON
  chmod 600 -- "$scratch/waf.json"
}

run_ssm_ufw_mutation() {
  local scratch="$1"
  local cidr="$2"
  local command_id_value
  local parameters
  parameters="{\"commands\":[\"set -eu; ufw allow in on ens5 from $cidr to any port 8443 proto tcp; printf \\\"__REMOTE_EDGE_UFW_STATUS__\\\\n\\\"; ufw status numbered; printf \\\"__REMOTE_EDGE_UFW_ADDED__\\\\n\\\"; ufw show added; printf \\\"__REMOTE_EDGE_SOCKETS__\\\\n\\\"; ss -ltnH; printf \\\"__REMOTE_EDGE_ROUTE__\\\\n\\\"; ip route show default\"]}"
  "${SSM[@]}" --no-cli-pager ssm send-command \
    --document-name AWS-RunShellScript \
    --instance-ids "$INSTANCE_ID" \
    --parameters "$parameters" \
    --output json >"$scratch/ufw-mutation-command.json" 2>/dev/null || die
  chmod 600 -- "$scratch/ufw-mutation-command.json"
  command_id_value="$(command_id "$scratch/ufw-mutation-command.json")" || die
  "${SSM[@]}" --no-cli-pager ssm get-command-invocation \
    --command-id "$command_id_value" \
    --instance-id "$INSTANCE_ID" \
    --output json >"$scratch/ufw-mutation-result.json" 2>/dev/null || die
  chmod 600 -- "$scratch/ufw-mutation-result.json"
  assert_ssm_success "$scratch/ufw-mutation-result.json" || die
}

mutate_one() {
  local stage="$1"
  local scratch="$2"
  local alb_sg
  local target_sg
  local target_group_arn
  local alb_arn
  local waf_arn
  local groups
  case "$stage" in
    FRESH)
      "${AWS[@]}" --no-cli-pager ec2 create-security-group --region "$AWS_REGION" --vpc-id "$VPC_ID" --group-name "$ALB_NAME" --description 'Nava remote admin ALB ingress only' >/dev/null 2>/dev/null || die
      ;;
    ALB_SG_CREATED)
      "${AWS[@]}" --no-cli-pager ec2 create-security-group --region "$AWS_REGION" --vpc-id "$VPC_ID" --group-name "$TARGET_SECURITY_GROUP_NAME" --description 'Nava remote admin target only' >/dev/null 2>/dev/null || die
      ;;
    SGS_CREATED)
      alb_sg="$(reference "$scratch" albSecurityGroupId)" || die
      "${AWS[@]}" --no-cli-pager ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$alb_sg" --ip-permissions 'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null 2>/dev/null || die
      ;;
    ALB_INGRESS_READY)
      alb_sg="$(reference "$scratch" albSecurityGroupId)" || die
      "${AWS[@]}" --no-cli-pager ec2 revoke-security-group-egress --region "$AWS_REGION" --group-id "$alb_sg" --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null 2>/dev/null || die
      ;;
    ALB_EGRESS_REVOKED)
      alb_sg="$(reference "$scratch" albSecurityGroupId)" || die
      target_sg="$(reference "$scratch" targetSecurityGroupId)" || die
      "${AWS[@]}" --no-cli-pager ec2 authorize-security-group-egress --region "$AWS_REGION" --group-id "$alb_sg" --ip-permissions "IpProtocol=tcp,FromPort=8443,ToPort=8443,UserIdGroupPairs=[{GroupId=$target_sg}]" >/dev/null 2>/dev/null || die
      ;;
    ALB_EGRESS_READY)
      alb_sg="$(reference "$scratch" albSecurityGroupId)" || die
      target_sg="$(reference "$scratch" targetSecurityGroupId)" || die
      "${AWS[@]}" --no-cli-pager ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$target_sg" --ip-permissions "IpProtocol=tcp,FromPort=8443,ToPort=8443,UserIdGroupPairs=[{GroupId=$alb_sg}]" >/dev/null 2>/dev/null || die
      ;;
    SG_FINAL_UNATTACHED)
      target_sg="$(reference "$scratch" targetSecurityGroupId)" || die
      mapfile -t groups < <(instance_group_ids "$scratch") || die
      [[ " ${groups[*]} " != *" $target_sg "* ]] || die
      "${AWS[@]}" --no-cli-pager ec2 modify-instance-attribute --region "$AWS_REGION" --instance-id "$INSTANCE_ID" --groups "${groups[@]}" "$target_sg" >/dev/null 2>/dev/null || die
      ;;
    TARGET_SG_ATTACHED)
      "${AWS[@]}" --no-cli-pager elbv2 create-target-group --region "$AWS_REGION" --name "$TARGET_GROUP_NAME" --protocol HTTP --port 8443 --vpc-id "$VPC_ID" --health-check-protocol HTTP --health-check-path /health --matcher HttpCode=200 --target-type instance >/dev/null 2>/dev/null || die
      ;;
    TARGET_GROUP_CREATED)
      target_group_arn="$(reference "$scratch" targetGroupArn)" || die
      "${AWS[@]}" --no-cli-pager elbv2 modify-target-group-attributes --region "$AWS_REGION" --target-group-arn "$target_group_arn" --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null 2>/dev/null || die
      ;;
    TARGET_GROUP_READY)
      alb_sg="$(reference "$scratch" albSecurityGroupId)" || die
      "${AWS[@]}" --no-cli-pager elbv2 create-load-balancer --region "$AWS_REGION" --name "$ALB_NAME" --scheme internet-facing --type application --ip-address-type ipv4 --subnets "$ALB_SUBNET_A" "$ALB_SUBNET_B" --security-groups "$alb_sg" >/dev/null 2>/dev/null || die
      ;;
    ALB_CREATED)
      "${AWS[@]}" --no-cli-pager s3api create-bucket --region "$AWS_REGION" --bucket "$LOG_BUCKET" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null 2>/dev/null || die
      ;;
    LOG_BUCKET_CREATED)
      "${AWS[@]}" --no-cli-pager s3api put-public-access-block --region "$AWS_REGION" --bucket "$LOG_BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null 2>/dev/null || die
      ;;
    LOG_BUCKET_PUBLIC_BLOCKED)
      "${AWS[@]}" --no-cli-pager s3api put-bucket-ownership-controls --region "$AWS_REGION" --bucket "$LOG_BUCKET" --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}' >/dev/null 2>/dev/null || die
      ;;
    LOG_BUCKET_OWNERSHIP_ENFORCED)
      "${AWS[@]}" --no-cli-pager s3api put-bucket-encryption --region "$AWS_REGION" --bucket "$LOG_BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null 2>/dev/null || die
      ;;
    LOG_BUCKET_ENCRYPTED)
      "${AWS[@]}" --no-cli-pager s3api put-bucket-lifecycle-configuration --region "$AWS_REGION" --bucket "$LOG_BUCKET" --lifecycle-configuration '{"Rules":[{"ID":"expire-remote-alb-logs-365d","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":365}}]}' >/dev/null 2>/dev/null || die
      ;;
    LOG_BUCKET_LIFECYCLE_READY)
      write_bucket_policy "$scratch"
      "${AWS[@]}" --no-cli-pager s3api put-bucket-policy --region "$AWS_REGION" --bucket "$LOG_BUCKET" --policy "file://$scratch/log-bucket-policy.json" >/dev/null 2>/dev/null || die
      ;;
    LOG_BUCKET_POLICY_READY)
      alb_arn="$(reference "$scratch" albArn)" || die
      "${AWS[@]}" --no-cli-pager elbv2 modify-load-balancer-attributes --region "$AWS_REGION" --load-balancer-arn "$alb_arn" --attributes Key=access_logs.s3.enabled,Value=true Key=access_logs.s3.bucket,Value="$LOG_BUCKET" >/dev/null 2>/dev/null || die
      ;;
    ALB_LOGGING_READY)
      write_waf_definition "$scratch"
      "${AWS[@]}" --no-cli-pager wafv2 create-web-acl --region "$AWS_REGION" --cli-input-json "file://$scratch/waf.json" >/dev/null 2>/dev/null || die
      ;;
    WAF_CREATED)
      alb_arn="$(reference "$scratch" albArn)" || die
      waf_arn="$(reference "$scratch" wafArn)" || die
      "${AWS[@]}" --no-cli-pager wafv2 associate-web-acl --region "$AWS_REGION" --web-acl-arn "$waf_arn" --resource-arn "$alb_arn" >/dev/null 2>/dev/null || die
      ;;
    WAF_ASSOCIATED)
      alb_arn="$(reference "$scratch" albArn)" || die
      "${AWS[@]}" --no-cli-pager elbv2 create-listener --region "$AWS_REGION" --load-balancer-arn "$alb_arn" --protocol HTTPS --port 443 --certificates "CertificateArn=$(reference "$scratch" certificateArn)" --default-actions 'Type=fixed-response,FixedResponseConfig={StatusCode=404,ContentType=text/plain,MessageBody=Not Found}' >/dev/null 2>/dev/null || die
      ;;
    LISTENER_FIXED_404)
      run_ssm_ufw_mutation "$scratch" '172.31.0.0/20'
      ;;
    UFW_SUBNET_A_READY)
      run_ssm_ufw_mutation "$scratch" '172.31.32.0/20'
      ;;
    *)
      die
      ;;
  esac
}

write_evidence() {
  local result_path="$1"
  local temporary
  temporary="$(mktemp "$EVIDENCE_ROOT/.remote-edge.XXXXXX")"
  chmod 600 -- "$temporary"
  node - "$result_path" "$temporary" <<'NODE'
const fs = require('fs');
const [resultPath, outputPath] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
if (
  typeof result?.stage !== 'string' ||
  typeof result?.action !== 'string' ||
  !/^[A-Z0-9_]+$/.test(result.stage) ||
  !/^[A-Z0-9_]+$/.test(result.action) ||
  Object.keys(result).length !== 2
) {
  process.exit(2);
}
fs.writeFileSync(outputPath, JSON.stringify(result) + '\n', { mode: 0o600 });
NODE
  mv -f -- "$temporary" "$EVIDENCE_ROOT/latest.json"
  chmod 600 -- "$EVIDENCE_ROOT/latest.json"
}

if [[ "$COMMAND" == 'inspect' ]]; then
  INSPECT_SCRATCH="$SCRATCH_ROOT/inspect"
  collect_current "$INSPECT_SCRATCH"
  write_evidence "$INSPECT_SCRATCH/result.json"
  cat "$INSPECT_SCRATCH/result.json"
  exit 0
fi

PRE_SCRATCH="$SCRATCH_ROOT/pre"
POST_SCRATCH="$SCRATCH_ROOT/post"
collect_current "$PRE_SCRATCH"
PRE_STAGE="$(result_stage "$PRE_SCRATCH/result.json")" || die
PRE_ACTION="$(result_action "$PRE_SCRATCH/result.json")" || die
[[ "$ACTION" == "$PRE_ACTION" && "$PRE_ACTION" != 'STOP' ]] || die
EXPECTED_NEXT="$(REMOTE_EDGE_STAGE="$PRE_STAGE" state_bridge "$PRE_SCRATCH" next 2>/dev/null)" || die
[[ -n "$EXPECTED_NEXT" ]] || die
mutate_one "$PRE_STAGE" "$PRE_SCRATCH"
collect_current "$POST_SCRATCH"
POST_STAGE="$(result_stage "$POST_SCRATCH/result.json")" || die
[[ "$POST_STAGE" == "$EXPECTED_NEXT" ]] || die
write_evidence "$POST_SCRATCH/result.json"
cat "$POST_SCRATCH/result.json"
