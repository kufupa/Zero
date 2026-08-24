import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CENTURION_THREAD_CORPUS_READINESS_CONFIG_VERSION =
  'centurion-thread-corpus-readiness-config-v1';
export const CENTURION_THREAD_CORPUS_CONTRACT_ID = 'centurion-thread-corpus-v2';
export const CENTURION_THREAD_CORPUS_READINESS_REPORT_VERSION =
  'centurion-thread-corpus-readiness-report-v1';
export const CENTURION_THREAD_CORPUS_READINESS_ATTESTATION_VERSION =
  'centurion-thread-corpus-readiness-attestation-v1';

const nonEmptyString = z.string().trim().min(1);
const rdsInstanceArn = z
  .string()
  .trim()
  .regex(/^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:\d{12}:db:[A-Za-z0-9][A-Za-z0-9-]{0,62}$/);

export const centurionThreadCorpusReadinessConfigSchema = z
  .object({
    version: z.literal(CENTURION_THREAD_CORPUS_READINESS_CONFIG_VERSION),
    expectedEc2: z
      .object({
        instanceId: nonEmptyString,
        revision: nonEmptyString,
        worktree: nonEmptyString,
      })
      .strict(),
    designatedSourceScope: z
      .object({
        centurionTransportId: nonEmptyString,
        designatedTransportId: nonEmptyString,
        mailboxIds: z.array(nonEmptyString).min(1),
        addresses: z.array(nonEmptyString).min(1),
      })
      .strict(),
    approvedExportTarget: z
      .object({
        region: nonEmptyString,
        bucket: nonEmptyString,
        prefix: nonEmptyString,
      })
      .strict(),
    minimumSourceDiskHeadroomBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    corpusContractId: z.literal(CENTURION_THREAD_CORPUS_CONTRACT_ID),
    privateDestination: z
      .object({
        localTarget: nonEmptyString,
      })
      .strict(),
    readOnlyCapabilityProbe: z
      .object({
        policySourceArn: nonEmptyString,
        kmsKeyId: nonEmptyString,
        dbInstanceArn: rdsInstanceArn,
      })
      .strict(),
  })
  .strict();

export const centurionThreadCorpusReadinessObservationsSchema = z
  .object({
    exactEc2RevisionWorktree: z.boolean(),
    imdsV2Identity: z.boolean(),
    protectedConfig: z.boolean(),
    designatedMailboxScope: z.boolean(),
    regionBucketPrefixAllowlist: z.boolean(),
    readOnlyDbS3KmsCapabilities: z.boolean(),
    sourceDiskHeadroom: z.boolean(),
    privateDestinationIgnored: z.boolean(),
    windowsLocalAclTarget: z.boolean(),
    v2Semantics: z.boolean(),
  })
  .strict();

const centurionThreadCorpusReadinessChecksSchema = z
  .object({
    exactEc2RevisionWorktree: z.boolean(),
    imdsV2Identity: z.boolean(),
    protectedConfig: z.boolean(),
    designatedMailboxScope: z.boolean(),
    regionBucketPrefixAllowlist: z.boolean(),
    readOnlyDbS3KmsCapabilities: z.boolean(),
    sourceDiskHeadroom: z.boolean(),
    privateDestinationIgnored: z.boolean(),
    windowsLocalAclTarget: z.boolean(),
    v2Semantics: z.boolean(),
  })
  .strict();

export const centurionThreadCorpusReadinessReportSchema = z
  .object({
    schemaVersion: z.literal(CENTURION_THREAD_CORPUS_READINESS_REPORT_VERSION),
    outcome: z.enum(['ready', 'blocked']),
    code: z.enum(['CENTURION_THREAD_CORPUS_READY', 'CENTURION_THREAD_CORPUS_BLOCKED']),
    ready: z.boolean(),
    checks: centurionThreadCorpusReadinessChecksSchema,
  })
  .strict();

export const centurionThreadCorpusReadinessAttestationSchema = z
  .object({
    schemaVersion: z.literal(CENTURION_THREAD_CORPUS_READINESS_ATTESTATION_VERSION),
    corpusContractId: z.literal(CENTURION_THREAD_CORPUS_CONTRACT_ID),
    readinessReportVersion: z.literal(CENTURION_THREAD_CORPUS_READINESS_REPORT_VERSION),
    bindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type CenturionThreadCorpusReadinessConfig = z.infer<
  typeof centurionThreadCorpusReadinessConfigSchema
>;
export type CenturionThreadCorpusReadinessObservations = z.infer<
  typeof centurionThreadCorpusReadinessObservationsSchema
>;
export type CenturionThreadCorpusReadinessReport = z.infer<
  typeof centurionThreadCorpusReadinessReportSchema
>;
export type CenturionThreadCorpusReadinessAttestationV1 = z.infer<
  typeof centurionThreadCorpusReadinessAttestationSchema
>;
export type CapabilityExpectation =
  | { action: string; resource: string; requiredDecision: 'allowed' }
  | { action: string; resource: string; requiredDecision: 'not_allowed' };
export type ReadinessAttestationBindingInputV1 = {
  corpusContractId: typeof CENTURION_THREAD_CORPUS_CONTRACT_ID;
  expectedInstanceId: string;
  expectedRevision: string;
  expectedWorktree: string;
  designatedSourceScope: {
    centurionTransportId: string;
    designatedTransportId: string;
    mailboxIds: readonly string[];
    addresses: readonly string[];
  };
};

const invalidJson = Symbol('invalid-json');

/**
 * Parses JSON while rejecting duplicate object keys before normalization can
 * erase them. Protected configs use this instead of JSON.parse.
 */
export function parseJsonWithoutDuplicateKeys(value: string): unknown | null {
  let offset = 0;
  const skipWhitespace = (): void => {
    while (offset < value.length && /[\t\n\r ]/.test(value[offset]!)) offset += 1;
  };
  const parseString = (): string | typeof invalidJson => {
    if (value[offset] !== '"') return invalidJson;
    const start = offset;
    offset += 1;
    while (offset < value.length) {
      const character = value[offset]!;
      if (character === '"') {
        offset += 1;
        try {
          const parsed = JSON.parse(value.slice(start, offset));
          return typeof parsed === 'string' ? parsed : invalidJson;
        } catch {
          return invalidJson;
        }
      }
      if (character.charCodeAt(0) <= 0x1f) return invalidJson;
      if (character !== '\\') {
        offset += 1;
        continue;
      }
      offset += 1;
      const escape = value[offset];
      if (escape === undefined || !'"\\/bfnrtu'.includes(escape)) return invalidJson;
      if (escape !== 'u') {
        offset += 1;
        continue;
      }
      const hex = value.slice(offset + 1, offset + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return invalidJson;
      offset += 5;
    }
    return invalidJson;
  };
  const parseValue = (): unknown | typeof invalidJson => {
    skipWhitespace();
    const character = value[offset];
    if (character === '"') return parseString();
    if (character === '{') {
      offset += 1;
      skipWhitespace();
      const object = Object.create(null) as Record<string, unknown>;
      if (value[offset] === '}') {
        offset += 1;
        return object;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (key === invalidJson || Object.hasOwn(object, key)) return invalidJson;
        skipWhitespace();
        if (value[offset] !== ':') return invalidJson;
        offset += 1;
        const entry = parseValue();
        if (entry === invalidJson) return invalidJson;
        Object.defineProperty(object, key, {
          configurable: true,
          enumerable: true,
          value: entry,
          writable: true,
        });
        skipWhitespace();
        if (value[offset] === '}') {
          offset += 1;
          return object;
        }
        if (value[offset] !== ',') return invalidJson;
        offset += 1;
      }
    }
    if (character === '[') {
      offset += 1;
      skipWhitespace();
      const array: unknown[] = [];
      if (value[offset] === ']') {
        offset += 1;
        return array;
      }
      while (true) {
        const entry = parseValue();
        if (entry === invalidJson) return invalidJson;
        array.push(entry);
        skipWhitespace();
        if (value[offset] === ']') {
          offset += 1;
          return array;
        }
        if (value[offset] !== ',') return invalidJson;
        offset += 1;
      }
    }
    if (value.startsWith('true', offset)) {
      offset += 4;
      return true;
    }
    if (value.startsWith('false', offset)) {
      offset += 5;
      return false;
    }
    if (value.startsWith('null', offset)) {
      offset += 4;
      return null;
    }
    const number = value.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number?.[0]) return invalidJson;
    offset += number[0].length;
    const parsed = Number(number[0]);
    return Number.isFinite(parsed) ? parsed : invalidJson;
  };

  const parsed = parseValue();
  skipWhitespace();
  return parsed === invalidJson || offset !== value.length ? null : parsed;
}

function blockedReport(): CenturionThreadCorpusReadinessReport {
  return {
    schemaVersion: CENTURION_THREAD_CORPUS_READINESS_REPORT_VERSION,
    outcome: 'blocked',
    code: 'CENTURION_THREAD_CORPUS_BLOCKED',
    ready: false,
    checks: {
      exactEc2RevisionWorktree: false,
      imdsV2Identity: false,
      protectedConfig: false,
      designatedMailboxScope: false,
      regionBucketPrefixAllowlist: false,
      readOnlyDbS3KmsCapabilities: false,
      sourceDiskHeadroom: false,
      privateDestinationIgnored: false,
      windowsLocalAclTarget: false,
      v2Semantics: false,
    },
  };
}

function parseConfig(config: unknown): CenturionThreadCorpusReadinessConfig | null {
  try {
    const result = centurionThreadCorpusReadinessConfigSchema.safeParse(config);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseObservations(
  observations: unknown,
): CenturionThreadCorpusReadinessObservations | null {
  try {
    const result = centurionThreadCorpusReadinessObservationsSchema.safeParse(observations);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function reportFor(
  observations: CenturionThreadCorpusReadinessObservations,
): CenturionThreadCorpusReadinessReport {
  const checks = {
    exactEc2RevisionWorktree: observations.exactEc2RevisionWorktree,
    imdsV2Identity: observations.imdsV2Identity,
    protectedConfig: observations.protectedConfig,
    designatedMailboxScope: observations.designatedMailboxScope,
    regionBucketPrefixAllowlist: observations.regionBucketPrefixAllowlist,
    readOnlyDbS3KmsCapabilities: observations.readOnlyDbS3KmsCapabilities,
    sourceDiskHeadroom: observations.sourceDiskHeadroom,
    privateDestinationIgnored: observations.privateDestinationIgnored,
    windowsLocalAclTarget: observations.windowsLocalAclTarget,
    v2Semantics: observations.v2Semantics,
  };
  const ready = Object.values(checks).every((value) => value);

  return {
    schemaVersion: CENTURION_THREAD_CORPUS_READINESS_REPORT_VERSION,
    outcome: ready ? 'ready' : 'blocked',
    code: ready ? 'CENTURION_THREAD_CORPUS_READY' : 'CENTURION_THREAD_CORPUS_BLOCKED',
    ready,
    checks,
  };
}

function canonicalNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
}

function normalizedAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function canonicalReadinessBinding(binding: ReadinessAttestationBindingInputV1): string | null {
  const expectedInstanceId = canonicalNonEmptyString(binding.expectedInstanceId);
  const expectedRevision = canonicalNonEmptyString(binding.expectedRevision);
  const expectedWorktree = canonicalNonEmptyString(binding.expectedWorktree);
  const centurionTransportId = canonicalNonEmptyString(
    binding.designatedSourceScope.centurionTransportId,
  );
  const designatedTransportId = canonicalNonEmptyString(
    binding.designatedSourceScope.designatedTransportId,
  );
  if (
    binding.corpusContractId !== CENTURION_THREAD_CORPUS_CONTRACT_ID ||
    expectedInstanceId === null ||
    expectedRevision === null ||
    expectedWorktree === null ||
    centurionTransportId === null ||
    designatedTransportId === null ||
    !Array.isArray(binding.designatedSourceScope.mailboxIds) ||
    !Array.isArray(binding.designatedSourceScope.addresses)
  ) {
    return null;
  }
  const mailboxIds = binding.designatedSourceScope.mailboxIds.map(canonicalNonEmptyString);
  const addresses = binding.designatedSourceScope.addresses.map(normalizedAddress);
  if (
    mailboxIds.length === 0 ||
    addresses.length === 0 ||
    !mailboxIds.every((mailboxId): mailboxId is string => mailboxId !== null) ||
    !addresses.every((address): address is string => address !== null)
  ) {
    return null;
  }
  return JSON.stringify({
    corpusContractId: CENTURION_THREAD_CORPUS_CONTRACT_ID,
    expectedInstanceId,
    expectedRevision,
    expectedWorktree,
    designatedSourceScope: {
      centurionTransportId,
      designatedTransportId,
      mailboxIds: [...mailboxIds].sort(),
      addresses: [...addresses].sort(),
    },
  });
}

function allGreenReport(
  report: CenturionThreadCorpusReadinessReport,
): report is CenturionThreadCorpusReadinessReport & { ready: true; outcome: 'ready' } {
  return (
    report.schemaVersion === CENTURION_THREAD_CORPUS_READINESS_REPORT_VERSION &&
    report.outcome === 'ready' &&
    report.code === 'CENTURION_THREAD_CORPUS_READY' &&
    report.ready === true &&
    Object.values(report.checks).every((check) => check === true)
  );
}

export function buildCenturionThreadCorpusReadinessAttestation(
  report: CenturionThreadCorpusReadinessReport,
  binding: ReadinessAttestationBindingInputV1,
): CenturionThreadCorpusReadinessAttestationV1 | null {
  const parsedReport = centurionThreadCorpusReadinessReportSchema.safeParse(report);
  const canonicalBinding = canonicalReadinessBinding(binding);
  if (!parsedReport.success || !allGreenReport(parsedReport.data) || canonicalBinding === null) {
    return null;
  }
  return {
    schemaVersion: CENTURION_THREAD_CORPUS_READINESS_ATTESTATION_VERSION,
    corpusContractId: CENTURION_THREAD_CORPUS_CONTRACT_ID,
    readinessReportVersion: CENTURION_THREAD_CORPUS_READINESS_REPORT_VERSION,
    bindingSha256: createHash('sha256').update(canonicalBinding, 'utf8').digest('hex'),
  };
}

export function matchesCenturionThreadCorpusReadinessAttestation(
  attestation: unknown,
  binding: ReadinessAttestationBindingInputV1,
): boolean {
  const parsedAttestation = centurionThreadCorpusReadinessAttestationSchema.safeParse(attestation);
  const canonicalBinding = canonicalReadinessBinding(binding);
  return (
    parsedAttestation.success &&
    canonicalBinding !== null &&
    parsedAttestation.data.bindingSha256 ===
      createHash('sha256').update(canonicalBinding, 'utf8').digest('hex')
  );
}

/**
 * Evaluates supplied, already-sanitized readiness gates without reading any
 * runtime capability or returning private configuration data.
 */
export function evaluateCenturionThreadCorpusReadiness(
  config: unknown,
  observations: unknown,
): CenturionThreadCorpusReadinessReport {
  if (parseConfig(config) === null) return blockedReport();

  const parsedObservations = parseObservations(observations);
  if (parsedObservations === null) return blockedReport();

  const result = centurionThreadCorpusReadinessReportSchema.safeParse(
    reportFor(parsedObservations),
  );
  return result.success ? result.data : blockedReport();
}
