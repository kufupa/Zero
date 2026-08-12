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

function fail() {
  throw new Error('invalid remote edge state');
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
    albDnsName: alb ? safeReference(alb.DNSName, '') : null,
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

function isExactAlbNetworkInterface(networkInterface, references) {
  const value = object(networkInterface);
  const marker = ':loadbalancer/';
  const arn = safeReference(references.albArn, 'arn:aws:');
  const resource = arn.slice(arn.indexOf(marker) + marker.length);
  if (!resource.startsWith(`app/${ALB_NAME}/`)) fail();
  if (
    value.Description !== `ELB ${resource}` ||
    value.RequesterManaged !== true ||
    value.RequesterId !== 'amazon-elb' ||
    !exactStrings(
      arrays(value, 'Groups').map((group) => object(group).GroupId),
      [references.albSecurityGroupId],
    )
  ) {
    return false;
  }
  return (
    value.Attachment === undefined ||
    (isObject(value.Attachment) && value.Attachment.InstanceId === undefined)
  );
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
  const instanceInterfaces = networkInterfaces.filter((networkInterface) => {
    const attachment = object(networkInterface).Attachment;
    return isObject(attachment) && attachment.InstanceId === INSTANCE_ID;
  });
  const primaryInstanceInterfaces = instanceInterfaces.filter(
    (networkInterface) =>
      object(object(networkInterface).Attachment).DeviceIndex === 0,
  );
  if (primaryInstanceInterfaces.length !== 1) fail();
  const instanceAttachedGroupIds = instanceInterfaces.flatMap((networkInterface) =>
    arrays(object(networkInterface), 'Groups').map((group) =>
      safeReference(object(group).GroupId, 'sg-'),
    ),
  );
  const primaryInstanceGroupIds = arrays(
    object(primaryInstanceInterfaces[0]),
    'Groups',
  ).map((group) => safeReference(object(group).GroupId, 'sg-'));
  if (
    instanceAttachedGroupIds.length === 0 ||
    !exactStrings(primaryInstanceGroupIds, references.instanceGroupIds)
  ) {
    fail();
  }
  const attachedTarget = references.targetSecurityGroupId
    ? attachmentIds(references.targetSecurityGroupId)
    : [];
  const attachedAlb = references.albSecurityGroupId
    ? attachmentIds(references.albSecurityGroupId)
    : [];
  const targetInInstance = references.targetSecurityGroupId
    ? instanceAttachedGroupIds.includes(references.targetSecurityGroupId)
    : false;
  const albInInstance = references.albSecurityGroupId
    ? instanceAttachedGroupIds.includes(references.albSecurityGroupId)
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
        (!references.alb
          ? attachedAlb.length !== 0
          : attachedAlb.length < 2 ||
            attachedAlb.some((networkInterface) =>
              !isExactAlbNetworkInterface(networkInterface, references),
            ));
  const legacyIngressSafe = instanceAttachedGroupIds.every((groupId) => {
    const group = groupsById.get(groupId);
    if (!group) return false;
    if (groupId === references.targetSecurityGroupId) {
      return hasPermissions(
        group,
        expectedTargetAlbIngress(references.albSecurityGroupId),
        expectedDefaultEgress(),
      );
    }
    return groupPermissionArrays(group).ingress.length === 0;
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
  const accessLogsPrefix = findAttribute(attributes, 'access_logs.s3.prefix');
  if (accessLogsEnabled === 'false' && accessLogsBucket === '') return 'created';
  if (
    accessLogsEnabled === 'true' &&
    accessLogsBucket === LOG_BUCKET &&
    accessLogsPrefix === ''
  ) {
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
  exactKeys(policy, ['Version', 'Statement']);
  if (policy.Version !== '2012-10-17') return false;
  const statements = arrays(policy, 'Statement');
  if (statements.length !== 2) return false;
  const allowMatches = statements.filter(
    (statement) => object(statement).Sid === 'AllowAlbLogDeliveryWrite',
  );
  const denyMatches = statements.filter(
    (statement) => object(statement).Sid === 'DenyInsecureTransport',
  );
  if (allowMatches.length !== 1 || denyMatches.length !== 1) return false;
  const allow = allowMatches[0];
  const deny = denyMatches[0];
  if (!allow || !deny) return false;
  const allowValue = object(allow);
  const denyValue = object(deny);
  if (
    Object.keys(allowValue).length !== 6 ||
    Object.keys(denyValue).length !== 6 ||
    !['Sid', 'Effect', 'Principal', 'Action', 'Resource', 'Condition'].every(
      (key) => key in allowValue,
    ) ||
    !['Sid', 'Effect', 'Principal', 'Action', 'Resource', 'Condition'].every(
      (key) => key in denyValue,
    )
  ) {
    return false;
  }
  const allowPrincipal = object(allowValue.Principal);
  const allowCondition = object(allowValue.Condition);
  const allowAccount = object(allowCondition.StringEquals);
  const allowSource = object(allowCondition.ArnLike);
  const denyCondition = object(denyValue.Condition);
  const denyTransport = object(denyCondition.Bool);
  return (
    allowValue.Effect === 'Allow' &&
    Object.keys(allowPrincipal).length === 1 &&
    allowPrincipal.Service === 'logdelivery.elasticloadbalancing.amazonaws.com' &&
    allowValue.Action === 's3:PutObject' &&
    allowValue.Resource === `arn:aws:s3:::${LOG_BUCKET}/AWSLogs/${ACCOUNT_ID}/*` &&
    Object.keys(allowCondition).length === 2 &&
    Object.keys(allowAccount).length === 1 &&
    allowAccount['aws:SourceAccount'] === ACCOUNT_ID &&
    Object.keys(allowSource).length === 1 &&
    allowSource['aws:SourceArn'] === references.albArn &&
    denyValue.Effect === 'Deny' &&
    denyValue.Principal === '*' &&
    denyValue.Action === 's3:*' &&
    exactStrings(denyValue.Resource, [
      `arn:aws:s3:::${LOG_BUCKET}`,
      `arn:aws:s3:::${LOG_BUCKET}/*`,
    ]) &&
    Object.keys(denyCondition).length === 1 &&
    Object.keys(denyTransport).length === 1 &&
    denyTransport['aws:SecureTransport'] === 'false'
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
  const verbose = markedSection(
    output,
    '__REMOTE_EDGE_UFW_VERBOSE__',
    '__REMOTE_EDGE_UFW_STATUS__',
  );
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
  const statusActive = /^Status: active$/m.test(verbose);
  const defaultDeny = /^Default: deny \(incoming\),/m.test(verbose);
  const addedLines = added
    .split('\n')
    .map((rule) => rule.trim())
    .filter(Boolean);
  const addedHeader = "Added user rules (see 'ufw status numbered'):";
  if (
    addedLines.filter((line) => line === addedHeader).length > 1 ||
    addedLines.some(
      (line) => line !== addedHeader && !/^ufw(?:\s|$)/.test(line),
    )
  ) {
    fail();
  }
  const rules = addedLines.filter((line) => /^ufw(?:\s|$)/.test(line));
  const intendedTunnel = 'ufw allow in on tun0 to any port 443 proto tcp';
  const subnetA =
    'ufw allow in on ens5 from 172.31.0.0/20 to any port 8443 proto tcp';
  const subnetB =
    'ufw allow in on ens5 from 172.31.32.0/20 to any port 8443 proto tcp';
  const allowedRules = new Set([intendedTunnel, subnetA, subnetB]);
  if (!unique(rules) || rules.some((rule) => !allowedRules.has(rule))) {
    fail();
  }
  const legacyTunnel443Exact = rules.includes(intendedTunnel);
  let ufwStage = 'invalid';
  if (exactStrings(rules, [intendedTunnel])) ufwStage = 'none';
  if (exactStrings(rules, [intendedTunnel, subnetA])) ufwStage = 'subnet-a';
  if (exactStrings(rules, [intendedTunnel, subnetA, subnetB])) ufwStage = 'ready';
  const statusRules = status
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^Status: active$/.test(line) &&
        !line.startsWith('Default: deny (incoming),') &&
        !/^To\s+Action\s+From$/.test(line) &&
        !/^-+\s+-+\s+-+$/.test(line),
    )
    .map((line) =>
      line.replace(/^\[\s*\d+\]\s*/, '').replace(/\s+/g, ' ').trim(),
    );
  const tunnelIpv6Display =
    '443/tcp (v6) on tun0 ALLOW IN Anywhere (v6)';
  const tunnelIpv6Displays = statusRules.filter(
    (line) => line === tunnelIpv6Display,
  );
  const normalizedStatusRules = statusRules.filter(
    (line) => line !== tunnelIpv6Display,
  );
  const expectedStatusRules = {
    none: ['443/tcp on tun0 ALLOW IN Anywhere'],
    'subnet-a': [
      '443/tcp on tun0 ALLOW IN Anywhere',
      '8443/tcp on ens5 ALLOW IN 172.31.0.0/20',
    ],
    ready: [
      '443/tcp on tun0 ALLOW IN Anywhere',
      '8443/tcp on ens5 ALLOW IN 172.31.0.0/20',
      '8443/tcp on ens5 ALLOW IN 172.31.32.0/20',
    ],
  };
  if (
    ufwStage === 'invalid' ||
    tunnelIpv6Displays.length > 1 ||
    !exactStrings(normalizedStatusRules, expectedStatusRules[ufwStage])
  ) {
    fail();
  }
  const defaultRouteOffTun0 =
    /^default\b/m.test(route) && !/^default\b.*\bdev tun0\b/m.test(route);
  const socketLines = sockets
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const tcpSocketLines = socketLines.filter((line) => /\bLISTEN\b/.test(line));
  const udpSocketLines = socketLines.filter((line) => !/\bLISTEN\b/.test(line));
  const listenAddresses = (lines, port) =>
    lines.flatMap((line) => {
      const suffix = `:${port}`;
      const local = line.split(/\s+/).find((field) => field.endsWith(suffix));
      return local ? [local.slice(0, -suffix.length)] : [];
    });
  const loopbackOnly = (port) => {
    const addresses = listenAddresses(tcpSocketLines, port);
    return (
      addresses.length > 0 &&
      addresses.every(
        (address) =>
          address === '127.0.0.1' ||
          address === '::1' ||
          address === '[::1]',
      )
    );
  };
  const target8443 = listenAddresses(tcpSocketLines, 8443);
  const udp8443 = listenAddresses(udpSocketLines, 8443);
  const listenerSafe =
    tcpSocketLines.length > 0 &&
    loopbackOnly(8788) &&
    loopbackOnly(8789) &&
    exactStrings(target8443, [TARGET_PRIVATE_IP]) &&
    udp8443.length === 0;
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

function deriveLogDeliveryProof(projections) {
  if (projections.logProof === undefined) return false;
  const proof = object(projections.logProof);
  exactKeys(proof, ['accessLogDelivered']);
  return boolean(proof.accessLogDelivered);
}

function publicAddressPresence(instance) {
  const interfaces = arrays(instance, 'NetworkInterfaces').map(object);
  return {
    ipv4:
      instance.PublicIpAddress !== undefined ||
      interfaces.some(
        (networkInterface) =>
          isObject(networkInterface.Association) &&
          networkInterface.Association.PublicIp !== undefined,
      ),
    ipv6:
      arrays(instance, 'Ipv6Addresses').length > 0 ||
      interfaces.some(
        (networkInterface) =>
          arrays(networkInterface, 'Ipv6Addresses').length > 0,
      ),
  };
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
    publicAddressPresence: publicAddressPresence(instance),
  };
  const security = deriveSecurity(value, references);
  const targetGroupStage = deriveTargetGroupStage(value, references);
  const albStage = deriveAlbStage(value, references);
  const bucketStage = deriveBucketStage(value, references);
  const wafStage = deriveWafStage(value, references);
  const listenerStage = deriveListenerStage(value, references);
  const host = deriveHostFacts(value);
  const logDeliveryProof = deriveLogDeliveryProof(value);
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
    logDeliveryProof,
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
    'logDeliveryProof',
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
    'publicAddressPresence',
  ]);
  const { publicAddressPresence: addressPresence, ...baselineControls } =
    facts.baseline;
  Object.values(baselineControls).forEach(boolean);
  exactKeys(addressPresence, ['ipv4', 'ipv6']);
  Object.values(addressPresence).forEach(boolean);
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
  boolean(facts.logDeliveryProof);
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
    facts.host.ufwStage === expected.ufwStage &&
    facts.logDeliveryProof === expected.logDeliveryProof
  );
}

const STAGE_TABLE = Object.freeze([
  {
    stage: 'FRESH',
    action: 'CREATE_ALB_SECURITY_GROUP',
    next: 'ALB_SG_CREATED',
    shape: { counts: [0, 0, 0, 0, 0, 0], securityStage: 'fresh', targetAttached: false, targetAttachmentExact: false, targetGroupStage: 'absent', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'ALB_SG_CREATED',
    action: 'CREATE_TARGET_SECURITY_GROUP',
    next: 'SGS_CREATED',
    shape: { counts: [0, 0, 1, 0, 0, 0], securityStage: 'alb-created', targetAttached: false, targetAttachmentExact: false, targetGroupStage: 'absent', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'SGS_CREATED',
    action: 'AUTHORIZE_ALB_HTTPS_INGRESS',
    next: 'ALB_INGRESS_READY',
    shape: { counts: [0, 0, 1, 1, 0, 0], securityStage: 'both-created', targetAttached: false, targetAttachmentExact: false, targetGroupStage: 'absent', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'ALB_INGRESS_READY',
    action: 'REVOKE_ALB_DEFAULT_EGRESS',
    next: 'ALB_EGRESS_REVOKED',
    shape: { counts: [0, 0, 1, 1, 0, 0], securityStage: 'alb-ingress', targetAttached: false, targetAttachmentExact: false, targetGroupStage: 'absent', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'ALB_EGRESS_REVOKED',
    action: 'AUTHORIZE_ALB_TARGET_EGRESS',
    next: 'ALB_EGRESS_READY',
    shape: { counts: [0, 0, 1, 1, 0, 0], securityStage: 'alb-egress-revoked', targetAttached: false, targetAttachmentExact: false, targetGroupStage: 'absent', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'ALB_EGRESS_READY',
    action: 'AUTHORIZE_TARGET_ALB_INGRESS',
    next: 'SG_FINAL_UNATTACHED',
    shape: { counts: [0, 0, 1, 1, 0, 0], securityStage: 'alb-egress-ready', targetAttached: false, targetAttachmentExact: false, targetGroupStage: 'absent', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'SG_FINAL_UNATTACHED',
    action: 'ATTACH_TARGET_SECURITY_GROUP',
    next: 'TARGET_SG_ATTACHED',
    shape: { counts: [0, 0, 1, 1, 0, 0], securityStage: 'final', targetAttached: false, targetAttachmentExact: false, targetGroupStage: 'absent', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'TARGET_SG_ATTACHED',
    action: 'CREATE_TARGET_GROUP',
    next: 'TARGET_GROUP_CREATED',
    shape: { counts: [0, 0, 1, 1, 0, 0], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'absent', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'TARGET_GROUP_CREATED',
    action: 'SET_TARGET_GROUP_DEREGISTRATION_DELAY',
    next: 'TARGET_GROUP_READY',
    shape: { counts: [0, 1, 1, 1, 0, 0], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'created', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'TARGET_GROUP_READY',
    action: 'CREATE_ALB',
    next: 'ALB_CREATED',
    shape: { counts: [0, 1, 1, 1, 0, 0], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'absent', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'ALB_CREATED',
    action: 'CREATE_LOG_BUCKET',
    next: 'LOG_BUCKET_CREATED',
    shape: { counts: [1, 1, 1, 1, 0, 0], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'created', bucketStage: 'absent', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'LOG_BUCKET_CREATED',
    action: 'BLOCK_LOG_BUCKET_PUBLIC_ACCESS',
    next: 'LOG_BUCKET_PUBLIC_BLOCKED',
    shape: { counts: [1, 1, 1, 1, 0, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'created', bucketStage: 'created', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'LOG_BUCKET_PUBLIC_BLOCKED',
    action: 'ENFORCE_LOG_BUCKET_OWNERSHIP',
    next: 'LOG_BUCKET_OWNERSHIP_ENFORCED',
    shape: { counts: [1, 1, 1, 1, 0, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'created', bucketStage: 'public-blocked', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'LOG_BUCKET_OWNERSHIP_ENFORCED',
    action: 'SET_LOG_BUCKET_AES256',
    next: 'LOG_BUCKET_ENCRYPTED',
    shape: { counts: [1, 1, 1, 1, 0, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'created', bucketStage: 'ownership-enforced', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'LOG_BUCKET_ENCRYPTED',
    action: 'SET_LOG_BUCKET_LIFECYCLE',
    next: 'LOG_BUCKET_LIFECYCLE_READY',
    shape: { counts: [1, 1, 1, 1, 0, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'created', bucketStage: 'encrypted', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'LOG_BUCKET_LIFECYCLE_READY',
    action: 'SET_LOG_BUCKET_POLICY',
    next: 'LOG_BUCKET_POLICY_READY',
    shape: { counts: [1, 1, 1, 1, 0, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'created', bucketStage: 'lifecycle-ready', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'LOG_BUCKET_POLICY_READY',
    action: 'ENABLE_ALB_LOGGING',
    next: 'ALB_LOGGING_READY',
    shape: { counts: [1, 1, 1, 1, 0, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'created', bucketStage: 'policy-ready', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'ALB_LOGGING_READY',
    action: 'CREATE_WAF',
    next: 'WAF_CREATED',
    shape: { counts: [1, 1, 1, 1, 0, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'logging-ready', bucketStage: 'policy-ready', wafStage: 'absent', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'WAF_CREATED',
    action: 'ASSOCIATE_WAF',
    next: 'WAF_ASSOCIATED',
    shape: { counts: [1, 1, 1, 1, 1, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'logging-ready', bucketStage: 'policy-ready', wafStage: 'created', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'WAF_ASSOCIATED',
    action: 'CREATE_FIXED_404_LISTENER',
    next: 'LISTENER_FIXED_404',
    shape: { counts: [1, 1, 1, 1, 1, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'logging-ready', bucketStage: 'policy-ready', wafStage: 'associated', listenerStage: 'absent', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'LISTENER_FIXED_404',
    action: 'ALLOW_UFW_SUBNET_A',
    next: 'UFW_SUBNET_A_READY',
    shape: { counts: [1, 1, 1, 1, 1, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'logging-ready', bucketStage: 'policy-ready', wafStage: 'associated', listenerStage: 'fixed-404', ufwStage: 'none', logDeliveryProof: false },
  },
  {
    stage: 'UFW_SUBNET_A_READY',
    action: 'ALLOW_UFW_SUBNET_B',
    next: 'UFW_READY',
    shape: { counts: [1, 1, 1, 1, 1, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'logging-ready', bucketStage: 'policy-ready', wafStage: 'associated', listenerStage: 'fixed-404', ufwStage: 'subnet-a', logDeliveryProof: false },
  },
  {
    stage: 'UFW_READY',
    action: 'PROVE_ALB_LOG_DELIVERY',
    next: 'TASK4_PRE_GATE_B_READY',
    shape: { counts: [1, 1, 1, 1, 1, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'logging-ready', bucketStage: 'policy-ready', wafStage: 'associated', listenerStage: 'fixed-404', ufwStage: 'ready', logDeliveryProof: false },
  },
  {
    stage: 'TASK4_PRE_GATE_B_READY',
    action: 'STOP',
    next: null,
    shape: { counts: [1, 1, 1, 1, 1, 1], securityStage: 'final', targetAttached: true, targetAttachmentExact: true, targetGroupStage: 'ready', albStage: 'logging-ready', bucketStage: 'policy-ready', wafStage: 'associated', listenerStage: 'fixed-404', ufwStage: 'ready', logDeliveryProof: true },
  },
]);

export function classifyFacts(input) {
  const facts = validateFacts(object(input));
  const { publicAddressPresence: _addressPresence, ...baselineControls } =
    facts.baseline;
  const safe =
    Object.values(baselineControls).every(Boolean) &&
    facts.security.legacyIngressSafe &&
    !facts.security.unexpectedAttachment &&
    !facts.security.unexpectedPermission &&
    facts.host.ufwSafe &&
    facts.host.legacyTunnel443Exact &&
    facts.host.defaultRouteOffTun0 &&
    facts.host.listenerSafe;
  if (!safe) fail();

  const found = STAGE_TABLE.filter((entry) => matches(facts, entry.shape));
  if (found.length !== 1) fail();
  return { stage: found[0].stage, action: found[0].action };
}

export function nextStage(stage) {
  if (typeof stage !== 'string') fail();
  const entry = STAGE_TABLE.find((candidate) => candidate.stage === stage);
  if (!entry) fail();
  return entry.next;
}
