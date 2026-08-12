const ACCOUNT_ID = '845242190536';
const REGION = 'af-south-1';
const VPC_ID = 'vpc-0f078e17a5f0f8599';
const INSTANCE_ID = 'i-008f737974a9ba9b3';
const TARGET_PRIVATE_IP = '172.31.12.112';
const ALB_SUBNET_IDS = ['subnet-0e6446aaaeaa8762e', 'subnet-094bf8643d98c22f6'];
const REMOTE_HOST = 'nava-admin.trynava.io';
const ALB_NAME = 'nava-remote-admin-alb';
const TARGET_GROUP_NAME = 'nava-remote-admin';
const TARGET_SECURITY_GROUP_NAME = 'nava-remote-admin-target';
const WAF_NAME = 'nava-remote-admin-waf';
const LOG_BUCKET = 'nava-zero-remote-alb-logs-845242190536-af-south-1';
const MAIL_BUCKET = 'nava-zero-mail-845242190536-af-south-1';

export const ACTION_BY_STAGE = Object.freeze({
  FRESH: 'CREATE_ALB_SECURITY_GROUP',
  ALB_SG_CREATED: 'CREATE_TARGET_SECURITY_GROUP',
  SGS_CREATED: 'AUTHORIZE_ALB_HTTPS_INGRESS',
  ALB_INGRESS_READY: 'REVOKE_ALB_DEFAULT_EGRESS',
  ALB_EGRESS_REVOKED: 'AUTHORIZE_ALB_TARGET_EGRESS',
  ALB_EGRESS_READY: 'AUTHORIZE_TARGET_ALB_INGRESS',
  SG_FINAL_UNATTACHED: 'ATTACH_TARGET_SECURITY_GROUP',
  TARGET_SG_ATTACHED: 'CREATE_TARGET_GROUP',
  TARGET_GROUP_CREATED: 'SET_TARGET_GROUP_DEREGISTRATION_DELAY',
  TARGET_GROUP_READY: 'CREATE_ALB',
  ALB_CREATED: 'CREATE_LOG_BUCKET',
  LOG_BUCKET_CREATED: 'BLOCK_LOG_BUCKET_PUBLIC_ACCESS',
  LOG_BUCKET_PUBLIC_BLOCKED: 'ENFORCE_LOG_BUCKET_OWNERSHIP',
  LOG_BUCKET_OWNERSHIP_ENFORCED: 'SET_LOG_BUCKET_AES256',
  LOG_BUCKET_ENCRYPTED: 'SET_LOG_BUCKET_LIFECYCLE',
  LOG_BUCKET_LIFECYCLE_READY: 'SET_LOG_BUCKET_POLICY',
  LOG_BUCKET_POLICY_READY: 'ENABLE_ALB_LOGGING',
  ALB_LOGGING_READY: 'CREATE_WAF',
  WAF_CREATED: 'ASSOCIATE_WAF',
  WAF_ASSOCIATED: 'CREATE_FIXED_404_LISTENER',
  LISTENER_FIXED_404: 'ALLOW_UFW_SUBNET_A',
  UFW_SUBNET_A_READY: 'ALLOW_UFW_SUBNET_B',
  TASK4_PRE_GATE_B_READY: 'STOP',
});

export const NEXT_STAGE_BY_STAGE = Object.freeze({
  FRESH: 'ALB_SG_CREATED',
  ALB_SG_CREATED: 'SGS_CREATED',
  SGS_CREATED: 'ALB_INGRESS_READY',
  ALB_INGRESS_READY: 'ALB_EGRESS_REVOKED',
  ALB_EGRESS_REVOKED: 'ALB_EGRESS_READY',
  ALB_EGRESS_READY: 'SG_FINAL_UNATTACHED',
  SG_FINAL_UNATTACHED: 'TARGET_SG_ATTACHED',
  TARGET_SG_ATTACHED: 'TARGET_GROUP_CREATED',
  TARGET_GROUP_CREATED: 'TARGET_GROUP_READY',
  TARGET_GROUP_READY: 'ALB_CREATED',
  ALB_CREATED: 'LOG_BUCKET_CREATED',
  LOG_BUCKET_CREATED: 'LOG_BUCKET_PUBLIC_BLOCKED',
  LOG_BUCKET_PUBLIC_BLOCKED: 'LOG_BUCKET_OWNERSHIP_ENFORCED',
  LOG_BUCKET_OWNERSHIP_ENFORCED: 'LOG_BUCKET_ENCRYPTED',
  LOG_BUCKET_ENCRYPTED: 'LOG_BUCKET_LIFECYCLE_READY',
  LOG_BUCKET_LIFECYCLE_READY: 'LOG_BUCKET_POLICY_READY',
  LOG_BUCKET_POLICY_READY: 'ALB_LOGGING_READY',
  ALB_LOGGING_READY: 'WAF_CREATED',
  WAF_CREATED: 'WAF_ASSOCIATED',
  WAF_ASSOCIATED: 'LISTENER_FIXED_404',
  LISTENER_FIXED_404: 'UFW_SUBNET_A_READY',
  UFW_SUBNET_A_READY: 'TASK4_PRE_GATE_B_READY',
});

export class RemoteEdgeStateError extends Error {
  constructor() {
    super('invalid remote edge state');
  }
}

function fail() {
  throw new RemoteEdgeStateError();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value) {
  if (!isObject(value)) fail();
  return value;
}

function array(value) {
  if (!Array.isArray(value)) fail();
  return value;
}

function text(value) {
  if (typeof value !== 'string' || value.length === 0) fail();
  return value;
}

function boolean(value) {
  if (typeof value !== 'boolean') fail();
  return value;
}

function integer(value) {
  if (!Number.isInteger(value)) fail();
  return value;
}

function exactKeys(value, expected) {
  const actual = Object.keys(object(value)).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail();
  }
}

function unique(values) {
  return new Set(values).size === values.length;
}

function exactStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value) => typeof value === 'string') &&
    unique(actual) &&
    expected.every((value) => actual.includes(value))
  );
}

function arrays(value, key) {
  const found = value[key];
  return found === undefined ? [] : array(found);
}

function oneNamed(items, key, name) {
  const matches = array(items).filter(
    (item) => isObject(item) && item[key] === name,
  );
  if (matches.length > 1) fail();
  return matches[0] ?? null;
}

function safeReference(value, prefix) {
  const result = text(value);
  if (!result.startsWith(prefix) || /\s/.test(result)) fail();
  return result;
}

function optionalControl(value) {
  if (value === undefined) fail();
  if (isObject(value) && Object.keys(value).length === 1 && value.absent === true) {
    return null;
  }
  return object(value);
}

function permissionParts(permission) {
  const value = object(permission);
  const protocol = text(value.IpProtocol);
  const ports =
    protocol === 'tcp'
      ? { from: integer(value.FromPort), to: integer(value.ToPort) }
      : { from: value.FromPort, to: value.ToPort };
  if (
    protocol !== 'tcp' &&
    (ports.from !== undefined || ports.to !== undefined)
  ) {
    fail();
  }
  return {
    protocol,
    ...ports,
    ipRanges: arrays(value, 'IpRanges'),
    ipv6Ranges: arrays(value, 'Ipv6Ranges'),
    prefixListIds: arrays(value, 'PrefixListIds'),
    groupPairs: arrays(value, 'UserIdGroupPairs'),
  };
}

function exactCidrRanges(ranges, cidrs) {
  return (
    ranges.length === cidrs.length &&
    ranges.every((range) => {
      const item = object(range);
      return Object.keys(item).length === 1 && cidrs.includes(item.CidrIp);
    }) &&
    unique(ranges.map((range) => object(range).CidrIp))
  );
}

function exactGroupPairs(pairs, groupIds) {
  return (
    pairs.length === groupIds.length &&
    pairs.every((pair) => {
      const item = object(pair);
      const keys = Object.keys(item);
      return (
        keys.every((key) => key === 'GroupId' || key === 'UserId') &&
        typeof item.GroupId === 'string' &&
        groupIds.includes(item.GroupId) &&
        (item.UserId === undefined || item.UserId === ACCOUNT_ID)
      );
    }) &&
    unique(pairs.map((pair) => object(pair).GroupId))
  );
}

function exactPermission(permission, expected) {
  const actual = permissionParts(permission);
  return (
    actual.protocol === expected.protocol &&
    actual.from === expected.from &&
    actual.to === expected.to &&
    exactCidrRanges(actual.ipRanges, expected.cidrs ?? []) &&
    exactCidrRanges(actual.ipv6Ranges, []) &&
    actual.prefixListIds.length === 0 &&
    exactGroupPairs(actual.groupPairs, expected.groupIds ?? [])
  );
}

function exactPermissions(actual, expected) {
  return (
    actual.length === expected.length &&
    expected.every((rule) =>
      actual.some((permission) => exactPermission(permission, rule)),
    )
  );
}

function opensPort8443(permission) {
  const actual = permissionParts(permission);
  return (
    actual.protocol === '-1' ||
    (actual.protocol === 'tcp' && actual.from <= 8443 && actual.to >= 8443)
  );
}

function groupPermissionArrays(group) {
  const value = object(group);
  return {
    ingress: arrays(value, 'IpPermissions'),
    egress: arrays(value, 'IpPermissionsEgress'),
  };
}

function expectedDefaultEgress() {
  return [{ protocol: '-1', from: undefined, to: undefined, cidrs: ['0.0.0.0/0'] }];
}

function expectedPublicHttpsIngress() {
  return [{ protocol: 'tcp', from: 443, to: 443, cidrs: ['0.0.0.0/0'] }];
}

function expectedAlbTargetEgress(targetGroupId) {
  return [{ protocol: 'tcp', from: 8443, to: 8443, groupIds: [targetGroupId] }];
}

function expectedTargetAlbIngress(albGroupId) {
  return [{ protocol: 'tcp', from: 8443, to: 8443, groupIds: [albGroupId] }];
}

function hasPermissions(group, ingress, egress) {
  const actual = groupPermissionArrays(group);
  return (
    exactPermissions(actual.ingress, ingress) &&
    exactPermissions(actual.egress, egress)
  );
}

function findAttribute(attributes, key) {
  const matches = array(attributes).filter(
    (attribute) => isObject(attribute) && attribute.Key === key,
  );
  if (matches.length !== 1 || typeof matches[0].Value !== 'string') fail();
  return matches[0].Value;
}

function exactSubnets(subnets) {
  return (
    subnets.length === 2 &&
    exactStrings(
      subnets.map((subnet) => object(subnet).SubnetId),
      ALB_SUBNET_IDS,
    ) &&
    subnets.every((subnet) => object(subnet).VpcId === VPC_ID)
  );
}

function hasPublicRoutes(routeTables) {
  const tables = array(routeTables);
  const main = tables.filter((table) =>
    arrays(object(table), 'Associations').some(
      (association) => object(association).Main === true,
    ),
  );
  if (main.length !== 1) return false;
  return ALB_SUBNET_IDS.every((subnetId) => {
    const explicit = tables.filter((table) =>
      arrays(object(table), 'Associations').some(
        (association) => object(association).SubnetId === subnetId,
      ),
    );
    if (explicit.length > 1) return false;
    const selected = explicit[0] ?? main[0];
    return arrays(object(selected), 'Routes').some(
      (route) =>
        object(route).DestinationCidrBlock === '0.0.0.0/0' &&
        typeof object(route).GatewayId === 'string' &&
        object(route).GatewayId.startsWith('igw-'),
    );
  });
}

function primaryInstance(projections) {
  const reservations = array(object(projections.instance).Reservations);
  if (reservations.length !== 1) fail();
  const instances = array(object(reservations[0]).Instances);
  if (instances.length !== 1) fail();
  const instance = object(instances[0]);
  const interfaces = arrays(instance, 'NetworkInterfaces');
  const primary = interfaces.filter(
    (networkInterface) =>
      object(object(networkInterface).Attachment).DeviceIndex === 0,
  );
  if (primary.length !== 1) fail();
  return { instance, primary: object(primary[0]) };
}

function referencesFromBase(projections) {
  const identity = object(projections.identity);
  const { instance } = primaryInstance(projections);
  const securityGroups = array(object(projections.securityGroups).SecurityGroups);
  const albs = array(object(projections.albs).LoadBalancers);
  const targetGroups = array(object(projections.targetGroups).TargetGroups);
  const wafs = array(object(projections.wafs).WebACLs);
  const buckets = array(object(projections.buckets).Buckets);
  const certificates = array(
    object(projections.certificates).CertificateSummaryList,
  );

  const albSecurityGroup = oneNamed(securityGroups, 'GroupName', ALB_NAME);
  const targetSecurityGroup = oneNamed(
    securityGroups,
    'GroupName',
    TARGET_SECURITY_GROUP_NAME,
  );
  const alb = oneNamed(albs, 'LoadBalancerName', ALB_NAME);
  const targetGroup = oneNamed(targetGroups, 'TargetGroupName', TARGET_GROUP_NAME);
  const waf = oneNamed(wafs, 'Name', WAF_NAME);
  const bucket = oneNamed(buckets, 'Name', LOG_BUCKET);
  const certificate = oneNamed(certificates, 'DomainName', REMOTE_HOST);

  if (!certificate) fail();
  const instanceGroupIds = arrays(instance, 'SecurityGroups').map((group) =>
    safeReference(object(group).GroupId, 'sg-'),
  );
  if (instanceGroupIds.length === 0 || !unique(instanceGroupIds)) fail();

  return {
    identity,
    instance,
    albSecurityGroup,
    targetSecurityGroup,
    alb,
    targetGroup,
    waf,
    bucket,
    certificate,
    albSecurityGroupId: albSecurityGroup
      ? safeReference(albSecurityGroup.GroupId, 'sg-')
      : null,
    targetSecurityGroupId: targetSecurityGroup
      ? safeReference(targetSecurityGroup.GroupId, 'sg-')
      : null,
    albArn: alb ? safeReference(alb.LoadBalancerArn, 'arn:aws:') : null,
    targetGroupArn: targetGroup
      ? safeReference(targetGroup.TargetGroupArn, 'arn:aws:')
      : null,
    wafArn: waf ? safeReference(waf.ARN, 'arn:aws:') : null,
    wafId: waf ? safeReference(waf.Id, '') : null,
    certificateArn: safeReference(certificate.CertificateArn, 'arn:aws:'),
    instanceGroupIds,
  };
}

export function deriveReferences(projections) {
  const references = referencesFromBase(object(projections));
  const listeners = projections.listeners;
  if (listeners === undefined) return references;
  const list = array(object(listeners).Listeners);
  if (list.length > 1) fail();
  return {
    ...references,
    listenerArn:
      list.length === 0 ? null : safeReference(object(list[0]).ListenerArn, 'arn:aws:'),
  };
}

function deriveSecurity(projections, references) {
  const securityGroups = array(object(projections.securityGroups).SecurityGroups);
  const networkInterfaces = array(
    object(projections.networkInterfaces).NetworkInterfaces,
  );
  const groupsById = new Map(
    securityGroups.map((group) => {
      const value = object(group);
      return [safeReference(value.GroupId, 'sg-'), value];
    }),
  );
  if (groupsById.size !== securityGroups.length) fail();

  const namedIds = [
    references.albSecurityGroupId,
    references.targetSecurityGroupId,
  ].filter(Boolean);
  if (!unique(namedIds)) fail();
  if (
    [references.albSecurityGroup, references.targetSecurityGroup]
      .filter(Boolean)
      .some((group) => object(group).VpcId !== VPC_ID)
  ) {
    fail();
  }

  const attachmentIds = (groupId) =>
    networkInterfaces.filter((networkInterface) =>
      arrays(object(networkInterface), 'Groups').some(
        (group) => object(group).GroupId === groupId,
      ),
    );
  const attachedTarget = references.targetSecurityGroupId
    ? attachmentIds(references.targetSecurityGroupId)
    : [];
  const attachedAlb = references.albSecurityGroupId
    ? attachmentIds(references.albSecurityGroupId)
    : [];
  const targetInInstance = references.targetSecurityGroupId
    ? references.instanceGroupIds.includes(references.targetSecurityGroupId)
    : false;
  const albInInstance = references.albSecurityGroupId
    ? references.instanceGroupIds.includes(references.albSecurityGroupId)
    : false;
  const targetAttachmentExact =
    Boolean(references.targetSecurityGroupId) &&
    targetInInstance &&
    attachedTarget.length === 1 &&
    object(object(attachedTarget[0]).Attachment).InstanceId === INSTANCE_ID &&
    object(object(attachedTarget[0]).Attachment).DeviceIndex === 0;
  const targetUnexpected =
    references.targetSecurityGroupId === null
      ? false
      : targetInInstance
        ? !targetAttachmentExact
        : attachedTarget.length !== 0;
  const albUnexpected =
    references.albSecurityGroupId === null
      ? false
      : albInInstance ||
        (!references.alb && attachedAlb.length !== 0) ||
        attachedAlb.some((networkInterface) =>
          Boolean(object(networkInterface).Attachment?.InstanceId),
        );
  const legacyIngressSafe = references.instanceGroupIds.every((groupId) => {
    const group = groupsById.get(groupId);
    if (!group) return false;
    if (groupId === references.targetSecurityGroupId) {
      return hasPermissions(
        group,
        expectedTargetAlbIngress(references.albSecurityGroupId),
        expectedDefaultEgress(),
      );
    }
    return !groupPermissionArrays(group).ingress.some(opensPort8443);
  });

  let stage = 'fresh';
  if (!references.albSecurityGroup && !references.targetSecurityGroup) {
    stage = 'fresh';
  } else if (
    references.albSecurityGroup &&
    !references.targetSecurityGroup &&
    hasPermissions(
      references.albSecurityGroup,
      [],
      expectedDefaultEgress(),
    )
  ) {
    stage = 'alb-created';
  } else if (references.albSecurityGroup && references.targetSecurityGroup) {
    const alb = references.albSecurityGroup;
    const target = references.targetSecurityGroup;
    if (
      hasPermissions(alb, [], expectedDefaultEgress()) &&
      hasPermissions(target, [], expectedDefaultEgress())
    ) {
      stage = 'both-created';
    } else if (
      hasPermissions(alb, expectedPublicHttpsIngress(), expectedDefaultEgress()) &&
      hasPermissions(target, [], expectedDefaultEgress())
    ) {
      stage = 'alb-ingress';
    } else if (
      hasPermissions(alb, expectedPublicHttpsIngress(), []) &&
      hasPermissions(target, [], expectedDefaultEgress())
    ) {
      stage = 'alb-egress-revoked';
    } else if (
      hasPermissions(
        alb,
        expectedPublicHttpsIngress(),
        expectedAlbTargetEgress(references.targetSecurityGroupId),
      ) &&
      hasPermissions(target, [], expectedDefaultEgress())
    ) {
      stage = 'alb-egress-ready';
    } else if (
      hasPermissions(
        alb,
        expectedPublicHttpsIngress(),
        expectedAlbTargetEgress(references.targetSecurityGroupId),
      ) &&
      hasPermissions(
        target,
        expectedTargetAlbIngress(references.albSecurityGroupId),
        expectedDefaultEgress(),
      )
    ) {
      stage = 'final';
    } else {
      stage = 'invalid';
    }
  } else {
    stage = 'invalid';
  }
  if (
    !legacyIngressSafe ||
    targetUnexpected ||
    albUnexpected ||
    stage === 'invalid'
  ) {
    fail();
  }

  return {
    stage,
    targetAttached: targetInInstance,
    targetAttachmentExact,
    legacyIngressSafe,
    unexpectedAttachment: false,
    unexpectedPermission: false,
  };
}

function deriveTargetGroupStage(projections, references) {
  if (!references.targetGroup) return 'absent';
  const targetGroup = references.targetGroup;
  if (
    targetGroup.VpcId !== VPC_ID ||
    targetGroup.Protocol !== 'HTTP' ||
    targetGroup.Port !== 8443 ||
    targetGroup.TargetType !== 'instance' ||
    targetGroup.HealthCheckProtocol !== 'HTTP' ||
    targetGroup.HealthCheckPath !== '/health' ||
    object(targetGroup.Matcher).HttpCode !== '200'
  ) {
    fail();
  }
  const attributes = array(
    object(projections.targetGroupAttributes).Attributes,
  );
  const health = array(
    object(projections.targetHealth).TargetHealthDescriptions,
  );
  if (health.length !== 0) fail();
  const delay = findAttribute(attributes, 'deregistration_delay.timeout_seconds');
  if (delay === '300') return 'created';
  if (delay === '30') return 'ready';
  fail();
}

function deriveAlbStage(projections, references) {
  if (!references.alb) return 'absent';
  const alb = references.alb;
  const availabilityZones = arrays(alb, 'AvailabilityZones');
  if (
    alb.VpcId !== VPC_ID ||
    alb.Scheme !== 'internet-facing' ||
    alb.Type !== 'application' ||
    alb.IpAddressType !== 'ipv4' ||
    alb.State?.Code !== 'active' ||
    !exactStrings(arrays(alb, 'SecurityGroups'), [references.albSecurityGroupId]) ||
    !exactStrings(
      availabilityZones.map((zone) => object(zone).SubnetId),
      ALB_SUBNET_IDS,
    )
  ) {
    fail();
  }
  const attributes = array(object(projections.albAttributes).Attributes);
  const accessLogsEnabled = findAttribute(attributes, 'access_logs.s3.enabled');
  const accessLogsBucket = findAttribute(attributes, 'access_logs.s3.bucket');
  if (accessLogsEnabled === 'false' && accessLogsBucket === '') return 'created';
  if (accessLogsEnabled === 'true' && accessLogsBucket === LOG_BUCKET) {
    return 'logging-ready';
  }
  fail();
}

function fixed404Action(action) {
  const value = object(action);
  return (
    value.Type === 'fixed-response' &&
    isObject(value.FixedResponseConfig) &&
    value.FixedResponseConfig.StatusCode === '404'
  );
}

function deriveListenerStage(projections, references) {
  if (!references.alb) return 'absent';
  const listeners = array(object(projections.listeners).Listeners);
  if (listeners.length === 0) return 'absent';
  if (listeners.length !== 1) fail();
  const listener = object(listeners[0]);
  if (
    listener.Protocol !== 'HTTPS' ||
    listener.Port !== 443 ||
    !exactStrings(
      arrays(listener, 'Certificates').map(
        (certificate) => object(certificate).CertificateArn,
      ),
      [references.certificateArn],
    ) ||
    !exactStrings(
      arrays(listener, 'DefaultActions').map((action) =>
        fixed404Action(action) ? 'fixed-404' : 'other',
      ),
      ['fixed-404'],
    )
  ) {
    fail();
  }
  const rules = array(object(projections.listenerRules).Rules);
  if (
    rules.length !== 1 ||
    object(rules[0]).IsDefault !== true ||
    !exactStrings(
      arrays(object(rules[0]), 'Actions').map((action) =>
        fixed404Action(action) ? 'fixed-404' : 'other',
      ),
      ['fixed-404'],
    )
  ) {
    fail();
  }
  return 'fixed-404';
}

function isExactPublicBlock(value) {
  const configuration = object(value).PublicAccessBlockConfiguration;
  return (
    isObject(configuration) &&
    Object.keys(configuration).length === 4 &&
    configuration.BlockPublicAcls === true &&
    configuration.IgnorePublicAcls === true &&
    configuration.BlockPublicPolicy === true &&
    configuration.RestrictPublicBuckets === true
  );
}

function isExactOwnership(value) {
  const response = object(value);
  if (
    Object.keys(response).length !== 1 ||
    !isObject(response.OwnershipControls) ||
    Object.keys(response.OwnershipControls).length !== 1
  ) {
    return false;
  }
  const rules = arrays(response.OwnershipControls, 'Rules');
  return (
    rules.length === 1 &&
    isObject(rules[0]) &&
    Object.keys(rules[0]).length === 1 &&
    rules[0].ObjectOwnership === 'BucketOwnerEnforced'
  );
}

function isExactEncryption(value) {
  const configuration = object(value).ServerSideEncryptionConfiguration;
  const rules = arrays(configuration, 'Rules');
  if (rules.length !== 1) return false;
  const defaultEncryption = object(rules[0]).ApplyServerSideEncryptionByDefault;
  return (
    isObject(defaultEncryption) &&
    Object.keys(defaultEncryption).length === 1 &&
    defaultEncryption.SSEAlgorithm === 'AES256'
  );
}

function isExactLifecycle(value) {
  const rules = arrays(value, 'Rules');
  if (rules.length !== 1) return false;
  const rule = object(rules[0]);
  return (
    rule.ID === 'expire-remote-alb-logs-365d' &&
    rule.Status === 'Enabled' &&
    isObject(rule.Filter) &&
    rule.Filter.Prefix === '' &&
    isObject(rule.Expiration) &&
    rule.Expiration.Days === 365
  );
}

function isExactBucketPolicy(value, references) {
  let policy;
  try {
    policy = JSON.parse(text(object(value).Policy));
  } catch {
    fail();
  }
  const statements = arrays(object(policy), 'Statement');
  if (statements.length !== 2) return false;
  const allow = statements.find(
    (statement) => object(statement).Sid === 'AllowAlbLogDeliveryWrite',
  );
  const deny = statements.find(
    (statement) => object(statement).Sid === 'DenyInsecureTransport',
  );
  if (!allow || !deny) return false;
  const allowValue = object(allow);
  const denyValue = object(deny);
  return (
    allowValue.Effect === 'Allow' &&
    isObject(allowValue.Principal) &&
    allowValue.Principal.Service === 'logdelivery.elasticloadbalancing.amazonaws.com' &&
    allowValue.Action === 's3:PutObject' &&
    allowValue.Resource === `arn:aws:s3:::${LOG_BUCKET}/AWSLogs/${ACCOUNT_ID}/*` &&
    isObject(allowValue.Condition) &&
    isObject(allowValue.Condition.StringEquals) &&
    allowValue.Condition.StringEquals['aws:SourceAccount'] === ACCOUNT_ID &&
    isObject(allowValue.Condition.ArnLike) &&
    allowValue.Condition.ArnLike['aws:SourceArn'] === references.albArn &&
    denyValue.Effect === 'Deny' &&
    denyValue.Principal === '*' &&
    denyValue.Action === 's3:*' &&
    exactStrings(denyValue.Resource, [
      `arn:aws:s3:::${LOG_BUCKET}`,
      `arn:aws:s3:::${LOG_BUCKET}/*`,
    ]) &&
    isObject(denyValue.Condition) &&
    isObject(denyValue.Condition.Bool) &&
    denyValue.Condition.Bool['aws:SecureTransport'] === 'false'
  );
}

function deriveBucketStage(projections, references) {
  if (!references.bucket) return 'absent';
  const location = object(projections.bucketLocation);
  if (location.LocationConstraint !== REGION) fail();
  const publicBlock = optionalControl(projections.bucketPublicAccess);
  const ownership = optionalControl(projections.bucketOwnership);
  const encryption = optionalControl(projections.bucketEncryption);
  const lifecycle = optionalControl(projections.bucketLifecycle);
  const policy = optionalControl(projections.bucketPolicy);
  if (!publicBlock && !ownership && !encryption && !lifecycle && !policy) {
    return 'created';
  }
  if (
    publicBlock &&
    isExactPublicBlock(publicBlock) &&
    !ownership &&
    !encryption &&
    !lifecycle &&
    !policy
  ) {
    return 'public-blocked';
  }
  if (
    publicBlock &&
    ownership &&
    isExactPublicBlock(publicBlock) &&
    isExactOwnership(ownership) &&
    !encryption &&
    !lifecycle &&
    !policy
  ) {
    return 'ownership-enforced';
  }
  if (
    publicBlock &&
    ownership &&
    encryption &&
    isExactPublicBlock(publicBlock) &&
    isExactOwnership(ownership) &&
    isExactEncryption(encryption) &&
    !lifecycle &&
    !policy
  ) {
    return 'encrypted';
  }
  if (
    publicBlock &&
    ownership &&
    encryption &&
    lifecycle &&
    isExactPublicBlock(publicBlock) &&
    isExactOwnership(ownership) &&
    isExactEncryption(encryption) &&
    isExactLifecycle(lifecycle) &&
    !policy
  ) {
    return 'lifecycle-ready';
  }
  if (
    publicBlock &&
    ownership &&
    encryption &&
    lifecycle &&
    policy &&
    isExactPublicBlock(publicBlock) &&
    isExactOwnership(ownership) &&
    isExactEncryption(encryption) &&
    isExactLifecycle(lifecycle) &&
    isExactBucketPolicy(policy, references)
  ) {
    return 'policy-ready';
  }
  fail();
}

function isExactTransformation(value) {
  const list = array(value);
  return (
    list.length === 1 &&
    isObject(list[0]) &&
    list[0].Priority === 0 &&
    list[0].Type === 'NONE'
  );
}

function isExactByteMatch(statement, field, search) {
  const value = object(statement).ByteMatchStatement;
  return (
    isObject(value) &&
    value.SearchString === search &&
    isObject(value.FieldToMatch) &&
    Object.keys(value.FieldToMatch).length === 1 &&
    isObject(value.FieldToMatch[field]) &&
    Object.keys(value.FieldToMatch[field]).length === 0 &&
    value.PositionalConstraint === 'EXACTLY' &&
    isExactTransformation(value.TextTransformations)
  );
}

function exactManagedRule(rule, name, priority, groupName) {
  const value = object(rule);
  const managed = object(object(value.Statement).ManagedRuleGroupStatement);
  return (
    value.Name === name &&
    value.Priority === priority &&
    isObject(value.OverrideAction) &&
    Object.keys(value.OverrideAction).length === 1 &&
    isObject(value.OverrideAction.None) &&
    Object.keys(value.OverrideAction.None).length === 0 &&
    managed.VendorName === 'AWS' &&
    managed.Name === groupName
  );
}

function exactSigninRateRule(rule) {
  const value = object(rule);
  const rate = object(object(value.Statement).RateBasedStatement);
  const statements = arrays(object(rate.ScopeDownStatement).AndStatement, 'Statements');
  return (
    value.Name === 'signin-25-per-5m' &&
    value.Priority === 40 &&
    isObject(value.Action) &&
    isObject(value.Action.Block) &&
    Object.keys(value.Action).length === 1 &&
    rate.Limit === 25 &&
    rate.AggregateKeyType === 'IP' &&
    rate.EvaluationWindowSec === 300 &&
    statements.length === 2 &&
    statements.some((statement) =>
      isExactByteMatch(statement, 'UriPath', '/api/auth/sign-in/email'),
    ) &&
    statements.some((statement) => isExactByteMatch(statement, 'Method', 'POST'))
  );
}

function exactPlaneRateRule(rule) {
  const value = object(rule);
  const rate = object(object(value.Statement).RateBasedStatement);
  return (
    value.Name === 'remote-plane-1000-per-5m' &&
    value.Priority === 50 &&
    isObject(value.Action) &&
    isObject(value.Action.Block) &&
    Object.keys(value.Action).length === 1 &&
    rate.Limit === 1000 &&
    rate.AggregateKeyType === 'IP' &&
    rate.EvaluationWindowSec === 300 &&
    rate.ScopeDownStatement === undefined
  );
}

function deriveWafStage(projections, references) {
  if (!references.waf) return 'absent';
  const webAcl = object(object(projections.waf).WebACL);
  const rules = arrays(webAcl, 'Rules');
  const required = [
    exactManagedRule(
      rules.find((rule) => object(rule).Name === 'AWS-AmazonIpReputation'),
      'AWS-AmazonIpReputation',
      10,
      'AWSManagedRulesAmazonIpReputationList',
    ),
    exactManagedRule(
      rules.find((rule) => object(rule).Name === 'AWS-Common'),
      'AWS-Common',
      20,
      'AWSManagedRulesCommonRuleSet',
    ),
    exactManagedRule(
      rules.find((rule) => object(rule).Name === 'AWS-KnownBadInputs'),
      'AWS-KnownBadInputs',
      30,
      'AWSManagedRulesKnownBadInputsRuleSet',
    ),
    exactSigninRateRule(rules.find((rule) => object(rule).Name === 'signin-25-per-5m')),
    exactPlaneRateRule(
      rules.find((rule) => object(rule).Name === 'remote-plane-1000-per-5m'),
    ),
  ];
  if (
    webAcl.Name !== WAF_NAME ||
    webAcl.Scope !== 'REGIONAL' ||
    !isObject(webAcl.DefaultAction) ||
    !isObject(webAcl.DefaultAction.Allow) ||
    rules.length !== 5 ||
    required.some((valid) => !valid)
  ) {
    fail();
  }
  const resources = arrays(
    object(projections.wafResources),
    'ResourceArns',
  );
  if (resources.length === 0) return 'created';
  if (exactStrings(resources, [references.albArn])) return 'associated';
  fail();
}

function markedSection(output, start, end) {
  const first = output.indexOf(start);
  const last = end ? output.indexOf(end) : output.length;
  if (first < 0 || last < 0 || first >= last || output.indexOf(start, first + 1) >= 0) {
    fail();
  }
  return output.slice(first + start.length, last).trim();
}

function deriveHostFacts(projections) {
  const host = object(projections.host);
  if (
    host.Status !== 'Success' ||
    typeof host.StandardOutputContent !== 'string' ||
    host.StandardErrorContent !== ''
  ) {
    fail();
  }
  const output = host.StandardOutputContent.replace(/\r/g, '');
  const status = markedSection(
    output,
    '__REMOTE_EDGE_UFW_STATUS__',
    '__REMOTE_EDGE_UFW_ADDED__',
  );
  const added = markedSection(
    output,
    '__REMOTE_EDGE_UFW_ADDED__',
    '__REMOTE_EDGE_SOCKETS__',
  );
  const sockets = markedSection(
    output,
    '__REMOTE_EDGE_SOCKETS__',
    '__REMOTE_EDGE_ROUTE__',
  );
  const route = markedSection(output, '__REMOTE_EDGE_ROUTE__');
  const statusActive = /^Status: active$/m.test(status);
  const defaultDeny = /^Default: deny \(incoming\),/m.test(status);
  const rules = added
    .split('\n')
    .map((rule) => rule.trim())
    .filter(Boolean);
  const port443 = rules.filter((rule) => /\bport 443\b/.test(rule));
  const port8443 = rules.filter((rule) => /\bport 8443\b/.test(rule));
  const intendedTunnel = 'ufw allow in on tun0 to any port 443 proto tcp';
  const subnetA =
    'ufw allow in on ens5 from 172.31.0.0/20 to any port 8443 proto tcp';
  const subnetB =
    'ufw allow in on ens5 from 172.31.32.0/20 to any port 8443 proto tcp';
  const legacyTunnel443Exact = exactStrings(port443, [intendedTunnel]);
  let ufwStage = 'invalid';
  if (exactStrings(port8443, [])) ufwStage = 'none';
  if (exactStrings(port8443, [subnetA])) ufwStage = 'subnet-a';
  if (exactStrings(port8443, [subnetA, subnetB])) ufwStage = 'ready';
  const defaultRouteOffTun0 =
    /^default\b/m.test(route) && !/^default\b.*\bdev tun0\b/m.test(route);
  const listenerSafe =
    sockets.length > 0 &&
    !/\bUDP\b/i.test(sockets) &&
    !/\[::\]:8443\b/.test(sockets);
  if (
    !statusActive ||
    !defaultDeny ||
    !legacyTunnel443Exact ||
    ufwStage === 'invalid' ||
    !defaultRouteOffTun0 ||
    !listenerSafe
  ) {
    fail();
  }
  return {
    ufwStage,
    ufwSafe: true,
    legacyTunnel443Exact,
    defaultRouteOffTun0,
    listenerSafe,
  };
}

function deriveCorsFacts(projections) {
  const cors = array(object(projections.mailCors).CORSRules);
  const origins = cors.flatMap((rule) => arrays(object(rule), 'AllowedOrigins'));
  if (origins.some((origin) => typeof origin !== 'string')) fail();
  const remoteOriginAbsent = !origins.includes(`https://${REMOTE_HOST}`);
  const noWildcard = !origins.includes('*');
  if (!remoteOriginAbsent || !noWildcard) fail();
  return { remoteOriginAbsent, noWildcard };
}

function hasNoPublicTargetAddress(instance) {
  return (
    instance.PublicIpAddress === undefined &&
    arrays(instance, 'Ipv6Addresses').length === 0 &&
    arrays(instance, 'NetworkInterfaces').every((networkInterface) => {
      const value = object(networkInterface);
      return (
        (value.Association === undefined ||
          (isObject(value.Association) &&
            value.Association.PublicIp === undefined)) &&
        arrays(value, 'Ipv6Addresses').length === 0
      );
    })
  );
}

export function deriveFacts(projections) {
  const value = object(projections);
  const references = deriveReferences(value);
  const { instance, primary } = primaryInstance(value);
  const subnets = array(object(value.subnets).Subnets);
  const certificate = object(value.certificate).Certificate;
  const primaryPrivateIp =
    primary.PrivateIpAddress ?? instance.PrivateIpAddress;
  const baseline = {
    account: references.identity.Account === ACCOUNT_ID,
    region: true,
    vpc: instance.VpcId === VPC_ID,
    instance: instance.InstanceId === INSTANCE_ID,
    targetPrivateIp: primaryPrivateIp === TARGET_PRIVATE_IP,
    subnets: exactSubnets(subnets),
    publicSubnetRoutes: hasPublicRoutes(object(value.routeTables).RouteTables),
    certificateIssued:
      certificate.CertificateArn === references.certificateArn &&
      certificate.DomainName === REMOTE_HOST &&
      certificate.Status === 'ISSUED' &&
      references.certificateArn.includes(`:${REGION}:${ACCOUNT_ID}:`),
    noPublicTargetAddress: hasNoPublicTargetAddress(instance),
  };
  const security = deriveSecurity(value, references);
  const targetGroupStage = deriveTargetGroupStage(value, references);
  const albStage = deriveAlbStage(value, references);
  const bucketStage = deriveBucketStage(value, references);
  const wafStage = deriveWafStage(value, references);
  const listenerStage = deriveListenerStage(value, references);
  const host = deriveHostFacts(value);
  const cors = deriveCorsFacts(value);
  return {
    version: 1,
    baseline,
    counts: {
      alb: references.alb ? 1 : 0,
      targetGroup: references.targetGroup ? 1 : 0,
      albSecurityGroup: references.albSecurityGroup ? 1 : 0,
      targetSecurityGroup: references.targetSecurityGroup ? 1 : 0,
      waf: references.waf ? 1 : 0,
      logBucket: references.bucket ? 1 : 0,
    },
    security,
    targetGroupStage,
    albStage,
    bucketStage,
    wafStage,
    listenerStage,
    host,
    cors,
  };
}

const SECURITY_STAGES = new Set([
  'fresh',
  'alb-created',
  'both-created',
  'alb-ingress',
  'alb-egress-revoked',
  'alb-egress-ready',
  'final',
]);
const TARGET_GROUP_STAGES = new Set(['absent', 'created', 'ready']);
const ALB_STAGES = new Set(['absent', 'created', 'logging-ready']);
const BUCKET_STAGES = new Set([
  'absent',
  'created',
  'public-blocked',
  'ownership-enforced',
  'encrypted',
  'lifecycle-ready',
  'policy-ready',
]);
const WAF_STAGES = new Set(['absent', 'created', 'associated']);
const LISTENER_STAGES = new Set(['absent', 'fixed-404']);
const UFW_STAGES = new Set(['none', 'subnet-a', 'ready']);

export function validateFacts(facts) {
  exactKeys(facts, [
    'version',
    'baseline',
    'counts',
    'security',
    'targetGroupStage',
    'albStage',
    'bucketStage',
    'wafStage',
    'listenerStage',
    'host',
    'cors',
  ]);
  if (facts.version !== 1) fail();
  exactKeys(facts.baseline, [
    'account',
    'region',
    'vpc',
    'instance',
    'targetPrivateIp',
    'subnets',
    'publicSubnetRoutes',
    'certificateIssued',
    'noPublicTargetAddress',
  ]);
  Object.values(facts.baseline).forEach(boolean);
  exactKeys(facts.counts, [
    'alb',
    'targetGroup',
    'albSecurityGroup',
    'targetSecurityGroup',
    'waf',
    'logBucket',
  ]);
  Object.values(facts.counts).forEach((value) => {
    const count = integer(value);
    if (count < 0 || count > 1) fail();
  });
  exactKeys(facts.security, [
    'stage',
    'targetAttached',
    'targetAttachmentExact',
    'legacyIngressSafe',
    'unexpectedAttachment',
    'unexpectedPermission',
  ]);
  if (!SECURITY_STAGES.has(facts.security.stage)) fail();
  [
    facts.security.targetAttached,
    facts.security.targetAttachmentExact,
    facts.security.legacyIngressSafe,
    facts.security.unexpectedAttachment,
    facts.security.unexpectedPermission,
  ].forEach(boolean);
  if (!TARGET_GROUP_STAGES.has(facts.targetGroupStage)) fail();
  if (!ALB_STAGES.has(facts.albStage)) fail();
  if (!BUCKET_STAGES.has(facts.bucketStage)) fail();
  if (!WAF_STAGES.has(facts.wafStage)) fail();
  if (!LISTENER_STAGES.has(facts.listenerStage)) fail();
  exactKeys(facts.host, [
    'ufwStage',
    'ufwSafe',
    'legacyTunnel443Exact',
    'defaultRouteOffTun0',
    'listenerSafe',
  ]);
  if (!UFW_STAGES.has(facts.host.ufwStage)) fail();
  [
    facts.host.ufwSafe,
    facts.host.legacyTunnel443Exact,
    facts.host.defaultRouteOffTun0,
    facts.host.listenerSafe,
  ].forEach(boolean);
  exactKeys(facts.cors, ['remoteOriginAbsent', 'noWildcard']);
  [facts.cors.remoteOriginAbsent, facts.cors.noWildcard].forEach(boolean);
  return facts;
}

function matches(facts, expected) {
  return (
    facts.counts.alb === expected.counts[0] &&
    facts.counts.targetGroup === expected.counts[1] &&
    facts.counts.albSecurityGroup === expected.counts[2] &&
    facts.counts.targetSecurityGroup === expected.counts[3] &&
    facts.counts.waf === expected.counts[4] &&
    facts.counts.logBucket === expected.counts[5] &&
    facts.security.stage === expected.securityStage &&
    facts.security.targetAttached === expected.targetAttached &&
    facts.security.targetAttachmentExact === expected.targetAttachmentExact &&
    facts.targetGroupStage === expected.targetGroupStage &&
    facts.albStage === expected.albStage &&
    facts.bucketStage === expected.bucketStage &&
    facts.wafStage === expected.wafStage &&
    facts.listenerStage === expected.listenerStage &&
    facts.host.ufwStage === expected.ufwStage
  );
}

export function classifyFacts(input) {
  const facts = validateFacts(object(input));
  const safe =
    Object.values(facts.baseline).every(Boolean) &&
    facts.security.legacyIngressSafe &&
    !facts.security.unexpectedAttachment &&
    !facts.security.unexpectedPermission &&
    facts.host.ufwSafe &&
    facts.host.legacyTunnel443Exact &&
    facts.host.defaultRouteOffTun0 &&
    facts.host.listenerSafe &&
    facts.cors.remoteOriginAbsent &&
    facts.cors.noWildcard;
  if (!safe) fail();

  const prefixes = [
    ['FRESH', [0, 0, 0, 0, 0, 0], 'fresh', false, false, 'absent', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['ALB_SG_CREATED', [0, 0, 1, 0, 0, 0], 'alb-created', false, false, 'absent', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['SGS_CREATED', [0, 0, 1, 1, 0, 0], 'both-created', false, false, 'absent', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['ALB_INGRESS_READY', [0, 0, 1, 1, 0, 0], 'alb-ingress', false, false, 'absent', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['ALB_EGRESS_REVOKED', [0, 0, 1, 1, 0, 0], 'alb-egress-revoked', false, false, 'absent', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['ALB_EGRESS_READY', [0, 0, 1, 1, 0, 0], 'alb-egress-ready', false, false, 'absent', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['SG_FINAL_UNATTACHED', [0, 0, 1, 1, 0, 0], 'final', false, false, 'absent', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['TARGET_SG_ATTACHED', [0, 0, 1, 1, 0, 0], 'final', true, true, 'absent', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['TARGET_GROUP_CREATED', [0, 1, 1, 1, 0, 0], 'final', true, true, 'created', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['TARGET_GROUP_READY', [0, 1, 1, 1, 0, 0], 'final', true, true, 'ready', 'absent', 'absent', 'absent', 'absent', 'none'],
    ['ALB_CREATED', [1, 1, 1, 1, 0, 0], 'final', true, true, 'ready', 'created', 'absent', 'absent', 'absent', 'none'],
    ['LOG_BUCKET_CREATED', [1, 1, 1, 1, 0, 1], 'final', true, true, 'ready', 'created', 'created', 'absent', 'absent', 'none'],
    ['LOG_BUCKET_PUBLIC_BLOCKED', [1, 1, 1, 1, 0, 1], 'final', true, true, 'ready', 'created', 'public-blocked', 'absent', 'absent', 'none'],
    ['LOG_BUCKET_OWNERSHIP_ENFORCED', [1, 1, 1, 1, 0, 1], 'final', true, true, 'ready', 'created', 'ownership-enforced', 'absent', 'absent', 'none'],
    ['LOG_BUCKET_ENCRYPTED', [1, 1, 1, 1, 0, 1], 'final', true, true, 'ready', 'created', 'encrypted', 'absent', 'absent', 'none'],
    ['LOG_BUCKET_LIFECYCLE_READY', [1, 1, 1, 1, 0, 1], 'final', true, true, 'ready', 'created', 'lifecycle-ready', 'absent', 'absent', 'none'],
    ['LOG_BUCKET_POLICY_READY', [1, 1, 1, 1, 0, 1], 'final', true, true, 'ready', 'created', 'policy-ready', 'absent', 'absent', 'none'],
    ['ALB_LOGGING_READY', [1, 1, 1, 1, 0, 1], 'final', true, true, 'ready', 'logging-ready', 'policy-ready', 'absent', 'absent', 'none'],
    ['WAF_CREATED', [1, 1, 1, 1, 1, 1], 'final', true, true, 'ready', 'logging-ready', 'policy-ready', 'created', 'absent', 'none'],
    ['WAF_ASSOCIATED', [1, 1, 1, 1, 1, 1], 'final', true, true, 'ready', 'logging-ready', 'policy-ready', 'associated', 'absent', 'none'],
    ['LISTENER_FIXED_404', [1, 1, 1, 1, 1, 1], 'final', true, true, 'ready', 'logging-ready', 'policy-ready', 'associated', 'fixed-404', 'none'],
    ['UFW_SUBNET_A_READY', [1, 1, 1, 1, 1, 1], 'final', true, true, 'ready', 'logging-ready', 'policy-ready', 'associated', 'fixed-404', 'subnet-a'],
    ['TASK4_PRE_GATE_B_READY', [1, 1, 1, 1, 1, 1], 'final', true, true, 'ready', 'logging-ready', 'policy-ready', 'associated', 'fixed-404', 'ready'],
  ].map(
    ([
      stage,
      counts,
      securityStage,
      targetAttached,
      targetAttachmentExact,
      targetGroupStage,
      albStage,
      bucketStage,
      wafStage,
      listenerStage,
      ufwStage,
    ]) => ({
      stage,
      counts,
      securityStage,
      targetAttached,
      targetAttachmentExact,
      targetGroupStage,
      albStage,
      bucketStage,
      wafStage,
      listenerStage,
      ufwStage,
    }),
  );
  const found = prefixes.filter((prefix) => matches(facts, prefix));
  if (found.length !== 1) fail();
  const stage = found[0].stage;
  return { stage, action: ACTION_BY_STAGE[stage] };
}

export function nextStage(stage) {
  if (typeof stage !== 'string' || !(stage in ACTION_BY_STAGE)) fail();
  return NEXT_STAGE_BY_STAGE[stage] ?? null;
}

export const REMOTE_EDGE_CONSTANTS = Object.freeze({
  ACCOUNT_ID,
  REGION,
  VPC_ID,
  INSTANCE_ID,
  TARGET_PRIVATE_IP,
  ALB_SUBNET_IDS,
  REMOTE_HOST,
  ALB_NAME,
  TARGET_GROUP_NAME,
  TARGET_SECURITY_GROUP_NAME,
  WAF_NAME,
  LOG_BUCKET,
  MAIL_BUCKET,
});
