#!/usr/bin/env bash
# Deliberate Task 5 host-forward lifecycle. Separate from Task 4 provisioning.
set -euo pipefail
set +x

readonly EXPECTED_AWS_REGION="af-south-1"
readonly EXPECTED_AWS_ACCOUNT_ID="845242190536"
readonly EXPECTED_INSTANCE_ID="i-008f737974a9ba9b3"
readonly EXPECTED_REMOTE_ADMIN_HOST="nava-admin.trynava.io"
readonly EXPECTED_REMOTE_ALB_NAME="nava-remote-admin-alb"
readonly EXPECTED_REMOTE_TARGET_GROUP_NAME="nava-remote-admin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-}"

fail() {
  echo "remote-admin-cutover: $*" >&2
  exit 1
}

lock_identifier() {
  local name="$1"
  local expected="$2"
  local supplied="${!name-}"
  if [ -v "$name" ] && [ "$supplied" != "$expected" ]; then
    fail "refusing unexpected ${name}"
  fi
  printf -v "$name" '%s' "$expected"
  readonly "$name"
}

lock_identifier AWS_REGION "$EXPECTED_AWS_REGION"
lock_identifier INSTANCE_ID "$EXPECTED_INSTANCE_ID"
lock_identifier REMOTE_ADMIN_HOST "$EXPECTED_REMOTE_ADMIN_HOST"
lock_identifier REMOTE_ALB_NAME "$EXPECTED_REMOTE_ALB_NAME"
lock_identifier REMOTE_TARGET_GROUP_NAME "$EXPECTED_REMOTE_TARGET_GROUP_NAME"

case "$ACTION" in
  cutover|rollback|restore) ;;
  *)
    echo "usage: $0 {cutover|rollback|restore}" >&2
    exit 2
    ;;
esac

if [ "${CONFIRM_REMOTE_ADMIN_CUTOVER:-}" != "1" ]; then
  fail "set CONFIRM_REMOTE_ADMIN_CUTOVER=1 after reviewed approval"
fi
for required_command in aws node bash; do
  command -v "$required_command" >/dev/null 2>&1 ||
    fail "missing required command: $required_command"
done

assert_account_context() {
  local account_id
  account_id="$(aws sts get-caller-identity \
    --region "$AWS_REGION" --query Account --output text)" ||
    fail "cannot read AWS account context"
  [ "$account_id" = "$EXPECTED_AWS_ACCOUNT_ID" ] ||
    fail "refusing unexpected AWS account context"
}

read_single_field() {
  local raw="$1"
  local collection="$2"
  local field="$3"
  local expected_prefix="${4:-}"
  node - "$raw" "$collection" "$field" "$expected_prefix" <<'NODE'
try {
  const [raw, collection, field, expectedPrefix] = process.argv.slice(2);
  const parsed = JSON.parse(raw);
  const values = Array.isArray(parsed?.[collection]) ? parsed[collection] : [];
  const value = values.length === 1 ? values[0]?.[field] : null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (expectedPrefix && !value.startsWith(expectedPrefix))
  ) process.exit(1);
  process.stdout.write(value);
} catch {
  process.exit(1);
}
NODE
}

resolve_resources() {
  local albs target_groups listeners
  albs="$(aws elbv2 describe-load-balancers \
    --region "$AWS_REGION" --names "$REMOTE_ALB_NAME" --output json)" ||
    fail "cannot read named ALB"
  REMOTE_ALB_ARN="$(read_single_field \
    "$albs" LoadBalancers LoadBalancerArn \
    "arn:aws:elasticloadbalancing:${AWS_REGION}:${EXPECTED_AWS_ACCOUNT_ID}:loadbalancer/app/${REMOTE_ALB_NAME}/")" ||
    fail "named ALB response is not exact"

  target_groups="$(aws elbv2 describe-target-groups \
    --region "$AWS_REGION" --names "$REMOTE_TARGET_GROUP_NAME" --output json)" ||
    fail "cannot read named target group"
  REMOTE_TARGET_GROUP_ARN="$(read_single_field \
    "$target_groups" TargetGroups TargetGroupArn \
    "arn:aws:elasticloadbalancing:${AWS_REGION}:${EXPECTED_AWS_ACCOUNT_ID}:targetgroup/${REMOTE_TARGET_GROUP_NAME}/")" ||
    fail "named target-group response is not exact"

  listeners="$(aws elbv2 describe-listeners \
    --region "$AWS_REGION" --load-balancer-arn "$REMOTE_ALB_ARN" --output json)" ||
    fail "cannot read ALB listeners"
  REMOTE_LISTENER_ARN="$(
    node - "$listeners" "$AWS_REGION" "$EXPECTED_AWS_ACCOUNT_ID" "$REMOTE_ALB_NAME" <<'NODE'
try {
  const [raw, region, accountId, albName] = process.argv.slice(2);
  const listeners = JSON.parse(raw)?.Listeners;
  const matches = Array.isArray(listeners)
    ? listeners.filter((listener) => listener?.Protocol === "HTTPS" && listener?.Port === 443)
    : [];
  const arn = matches.length === 1 ? matches[0]?.ListenerArn : null;
  const expectedPrefix =
    `arn:aws:elasticloadbalancing:${region}:${accountId}:listener/app/${albName}/`;
  if (typeof arn !== "string" || !arn.startsWith(expectedPrefix)) process.exit(1);
  process.stdout.write(arn);
} catch {
  process.exit(1);
}
NODE
  )" || fail "HTTPS :443 listener response is not exact"
}

read_lifecycle_state() {
  local listener_rules target_health result
  listener_rules="$(aws elbv2 describe-rules \
    --region "$AWS_REGION" --listener-arn "$REMOTE_LISTENER_ARN" --output json)" ||
    fail "cannot read listener rules"
  target_health="$(aws elbv2 describe-target-health \
    --region "$AWS_REGION" --target-group-arn "$REMOTE_TARGET_GROUP_ARN" --output json)" ||
    fail "cannot read target health"

  result="$(
    MODULE_PATH="${SCRIPT_DIR}/remote-admin-lifecycle.mjs" \
      TARGET_GROUP_ARN="$REMOTE_TARGET_GROUP_ARN" \
      LISTENER_RULES_JSON="$listener_rules" \
      TARGET_HEALTH_JSON="$target_health" \
      EXPECTED_INSTANCE_ID="$INSTANCE_ID" \
      REMOTE_ADMIN_HOST="$REMOTE_ADMIN_HOST" \
      node --input-type=module --eval '
        import { pathToFileURL } from "node:url";
        const { classifyRemoteAdminLifecycle } = await import(
          pathToFileURL(process.env.MODULE_PATH).href,
        );
        const result = classifyRemoteAdminLifecycle({
          targetGroupArn: process.env.TARGET_GROUP_ARN,
          listenerRules: JSON.parse(process.env.LISTENER_RULES_JSON),
          targetHealth: JSON.parse(process.env.TARGET_HEALTH_JSON),
          instanceId: process.env.EXPECTED_INSTANCE_ID,
          remoteHost: process.env.REMOTE_ADMIN_HOST,
        });
        process.stdout.write(`${result.state}\t${result.ruleArn ?? ""}`);
      '
  )" || fail "cannot classify listener/target readback"

  IFS=$'\t' read -r REMOTE_LIFECYCLE_STATE REMOTE_HOST_RULE_ARN <<<"$result"
  case "$REMOTE_LIFECYCLE_STATE" in
    pre-registration|active|rollback) ;;
    *) fail "refusing unknown, broad, or mixed listener/target state" ;;
  esac
}

assert_state() {
  local expected="$1"
  read_lifecycle_state
  [ "$REMOTE_LIFECYCLE_STATE" = "$expected" ] ||
    fail "expected ${expected}, found ${REMOTE_LIFECYCLE_STATE}"
}

run_readiness() {
  local lifecycle_mode="$1"
  REMOTE_ADMIN_MODE=1 \
    REMOTE_TARGET_HEALTH_REQUIRED=1 \
    REMOTE_ADMIN_LIFECYCLE_MODE="$lifecycle_mode" \
    bash "${SCRIPT_DIR}/launch-readiness.sh"
}

create_exact_host_forward_rule() {
  aws elbv2 create-rule \
    --region "$AWS_REGION" \
    --listener-arn "$REMOTE_LISTENER_ARN" \
    --priority 10 \
    --conditions "Field=host-header,Values=$REMOTE_ADMIN_HOST" \
    --actions "Type=forward,TargetGroupArn=$REMOTE_TARGET_GROUP_ARN" \
    --output json >/dev/null
}

assert_account_context
resolve_resources
case "$ACTION" in
  cutover)
    assert_state pre-registration
    run_readiness pre-registration
    aws elbv2 register-targets \
      --region "$AWS_REGION" \
      --target-group-arn "$REMOTE_TARGET_GROUP_ARN" \
      --targets "Id=$INSTANCE_ID,Port=8443"
    aws elbv2 wait target-in-service \
      --region "$AWS_REGION" \
      --target-group-arn "$REMOTE_TARGET_GROUP_ARN" \
      --targets "Id=$INSTANCE_ID,Port=8443"
    assert_state rollback
    run_readiness rollback
    create_exact_host_forward_rule
    assert_state active
    run_readiness active
    ;;
  rollback)
    assert_state active
    run_readiness active
    [ -n "$REMOTE_HOST_RULE_ARN" ] || fail "exact host rule ARN missing"
    aws elbv2 delete-rule --region "$AWS_REGION" --rule-arn "$REMOTE_HOST_RULE_ARN"
    assert_state rollback
    run_readiness rollback
    ;;
  restore)
    assert_state rollback
    run_readiness rollback
    create_exact_host_forward_rule
    assert_state active
    run_readiness active
    ;;
esac

echo "remote-admin-cutover: ${ACTION} complete; state=${REMOTE_LIFECYCLE_STATE}"
