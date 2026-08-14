const REMOTE_ADMIN_HOST = 'nava-admin.trynava.io';
const REMOTE_TARGET_PORT = 8443;

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactStrings = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value) => typeof value === 'string') &&
  [...actual].sort().every((value, index) => value === [...expected].sort()[index]);

function hasFixed404DefaultRule(rules) {
  const defaults = rules.filter((rule) => rule?.IsDefault === true);
  return (
    defaults.length === 1 &&
    Array.isArray(defaults[0]?.Actions) &&
    defaults[0].Actions.length === 1 &&
    defaults[0].Actions[0]?.Type === 'fixed-response' &&
    defaults[0].Actions[0]?.FixedResponseConfig?.StatusCode === '404'
  );
}

function hasExactHostForwardRule({ rule, targetGroupArn, remoteHost }) {
  return (
    isRecord(rule) &&
    rule.IsDefault !== true &&
    rule.Priority === '10' &&
    Array.isArray(rule.Conditions) &&
    rule.Conditions.length === 1 &&
    rule.Conditions[0]?.Field === 'host-header' &&
    hasExactStrings(rule.Conditions[0]?.Values, [remoteHost]) &&
    Array.isArray(rule.Actions) &&
    rule.Actions.length === 1 &&
    rule.Actions[0]?.Type === 'forward' &&
    rule.Actions[0]?.TargetGroupArn === targetGroupArn
  );
}

function hasExactHealthyTarget({ target, instanceId, targetPort }) {
  return (
    isRecord(target) &&
    typeof target.Target?.Id === 'string' &&
    (instanceId === undefined || target.Target.Id === instanceId) &&
    Number(target.Target?.Port) === targetPort &&
    target.TargetHealth?.State === 'healthy'
  );
}

/**
 * Classify only safe lifecycle shapes. All partial, broad, or malformed
 * listener/target arrangements produce "unknown" and must not be mutated.
 */
export function classifyRemoteAdminLifecycle({
  targetGroupArn,
  listenerRules,
  targetHealth,
  remoteHost = REMOTE_ADMIN_HOST,
  instanceId,
  targetPort = REMOTE_TARGET_PORT,
}) {
  const rules = Array.isArray(listenerRules?.Rules) ? listenerRules.Rules : null;
  const targets = Array.isArray(targetHealth?.TargetHealthDescriptions)
    ? targetHealth.TargetHealthDescriptions
    : null;
  const targetGroupValid = typeof targetGroupArn === 'string' && targetGroupArn.length > 0;

  if (
    !targetGroupValid ||
    rules === null ||
    targets === null ||
    !hasFixed404DefaultRule(rules)
  ) {
    return { state: 'unknown', ruleArn: null };
  }

  const nonDefaultRules = rules.filter((rule) => rule?.IsDefault !== true);
  const noNonDefaultRules = nonDefaultRules.length === 0;
  const exactHostForward =
    nonDefaultRules.length === 1 &&
    hasExactHostForwardRule({
      rule: nonDefaultRules[0],
      targetGroupArn,
      remoteHost,
    });
  const exactHealthyTarget =
    targets.length === 1 &&
    hasExactHealthyTarget({
      target: targets[0],
      instanceId,
      targetPort,
    });

  if (noNonDefaultRules && targets.length === 0) {
    return { state: 'pre-registration', ruleArn: null };
  }
  if (exactHostForward && exactHealthyTarget) {
    return {
      state: 'active',
      ruleArn: typeof nonDefaultRules[0]?.RuleArn === 'string' ? nonDefaultRules[0].RuleArn : null,
    };
  }
  if (noNonDefaultRules && exactHealthyTarget) {
    return { state: 'rollback', ruleArn: null };
  }
  return { state: 'unknown', ruleArn: null };
}

export function expectedRemoteAdminLifecycleAfter(state, action) {
  const transitions = {
    'pre-registration': { cutover: 'active' },
    active: { rollback: 'rollback' },
    rollback: { restore: 'active' },
  };
  const next = transitions[state]?.[action];
  if (!next) {
    throw new Error(`refusing remote-admin lifecycle transition: ${state} -> ${action}`);
  }
  return next;
}
