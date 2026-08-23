import { z } from 'zod';

export const CENTURION_THREAD_CORPUS_READINESS_CONFIG_VERSION =
  'centurion-thread-corpus-readiness-config-v1';
export const CENTURION_THREAD_CORPUS_CONTRACT_ID =
  'centurion-thread-corpus-v2';
export const CENTURION_THREAD_CORPUS_READINESS_REPORT_VERSION =
  'centurion-thread-corpus-readiness-report-v1';

const nonEmptyString = z.string().trim().min(1);

export const centurionThreadCorpusReadinessConfigSchema = z
  .object({
    version: z.literal(CENTURION_THREAD_CORPUS_READINESS_CONFIG_VERSION),
    expectedEc2: z
      .object({
        revision: nonEmptyString,
        worktree: nonEmptyString,
      })
      .strict(),
    designatedSourceScope: z
      .object({
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
    minimumSourceDiskHeadroomBytes: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    corpusContractId: z.literal(CENTURION_THREAD_CORPUS_CONTRACT_ID),
    privateDestination: z
      .object({
        localTarget: nonEmptyString,
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
    code: z.enum([
      'CENTURION_THREAD_CORPUS_READY',
      'CENTURION_THREAD_CORPUS_BLOCKED',
    ]),
    ready: z.boolean(),
    checks: centurionThreadCorpusReadinessChecksSchema,
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

function parseConfig(
  config: unknown,
): CenturionThreadCorpusReadinessConfig | null {
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
    const result =
      centurionThreadCorpusReadinessObservationsSchema.safeParse(observations);
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
    code: ready
      ? 'CENTURION_THREAD_CORPUS_READY'
      : 'CENTURION_THREAD_CORPUS_BLOCKED',
    ready,
    checks,
  };
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
