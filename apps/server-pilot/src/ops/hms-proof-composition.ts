/**
 * Proof-only composition for the Phase-A HMS find lease.
 *
 * This module deliberately does not load or fabricate an active registry
 * release.  It joins the real mailbox issuer/current-app proof to the
 * unpromoted Phase-A session identity, while the normal worker/read-service
 * active-release gate remains unchanged.
 */
import {
  assertCurrentAppAccessProof,
  issueCurrentAppAccessProof,
  type CurrentAppAccessProof,
} from '../hms/requester-authorization.js';
import {
  createProductionHmsProofRuntime,
  normalizeLoadedSecret,
  type ProductionSecretLoadResult,
} from '../hms/production-runtime.js';
import {
  parseChildOnlyEvidenceHmacKey,
  revalidateEvidenceBindings,
  type HmsEvidenceHmacConfig,
} from '../hms/evidence-runtime.js';
import {
  issueReadAdmissionFromMailbox,
  type IssuedMailboxReadAdmission,
} from '../hms/read-admission-issuer.js';
import {
  buildHmsFindSessionAuthorization,
  PHASE_A_FIND_LEASE_RELEASE_ID,
} from '../hms/active-read-runtime.js';
import { assertReadAdmissionIssuer, type ReadAdmissionIssuer } from '../hms/read-admission.js';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { ReservationSearchCandidate } from '../hms/live-read-manifest.js';
import type { HmsSessionAuthorization } from '../hms/release-kernel.js';
import type { PropertyReadLock } from '../hms/property-read-lock.js';
import type { HmsRuntime, HmsSecretLoader } from '../hms/runtime.js';
import { chmod, link, lstat, open, unlink } from 'node:fs/promises';
import type { RequestPolicyManifest } from '../hms/contracts.js';
import type { HmsWorkerRuntimeConfig } from '../env.js';
import { createHash, randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import type { DB } from '../db/client.js';

const PROOF_TOOL_ID = 'hms_find_reservation' as const;
const PROOF_TOOL_VERSION = '1.2.0' as const;
const PROOF_BRANCH_ID = 'guest_stay_search' as const;
const PROOF_PROPERTY_CODE = 'HRCEN' as const;
const PROOF_PLAYWRIGHT_REVISION = '1.52.0' as const;
const PROOF_CHROMIUM_REVISION = '1169' as const;

export const PHASE_A_PROOF_MILESTONE_ORDER = [
  'loginStartedAt',
  'traceStartedAt',
  'toolStartedAt',
  'toolFinishedAt',
  'traceStoppedAt',
  'contextClosedAt',
] as const;

type PhaseAProofMilestone = (typeof PHASE_A_PROOF_MILESTONE_ORDER)[number];

export class HmsProofCompositionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HmsProofCompositionError';
    this.code = code;
  }
}

function requiredString(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new HmsProofCompositionError('PROOF_CONFIG_INVALID', `${label} is required`);
  }
  return trimmed;
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new HmsProofCompositionError(
      'PROOF_BINDING_INVALID',
      `${label} must be a SHA-256 digest`,
    );
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export type PhaseAProofIssuedScope = {
  accessId: string;
  triggerMessageId: string;
  candidateId: string | null;
  issuer: Pick<
    ReadAdmissionIssuer,
    'userId' | 'mailboxAccessId' | 'transportId' | 'threadId' | 'triggerMessageId'
  >;
};

/**
 * Check the exact server-owned scope returned by issueReadAdmissionFromMailbox.
 * No caller-authored grant, trigger, candidate, property, or user is accepted.
 */
export function assertPhaseAProofScope(input: {
  requestedUserId: string;
  expectedTransportId: string;
  expectedThreadId: string;
  expectedTriggerMessageId: string;
  expectedCandidateId: string;
  propertyCode: string;
  expectedPropertyCode: string;
  issued: PhaseAProofIssuedScope;
  expiresAt: string;
  now: Date;
  /** Wave 0b: surname+dates search reuses a mail row for admission only. */
  allowCandidateIdMismatch?: boolean;
}): void {
  if (
    input.expectedPropertyCode !== PROOF_PROPERTY_CODE ||
    input.propertyCode !== input.expectedPropertyCode
  ) {
    throw new HmsProofCompositionError(
      'PROPERTY_MISMATCH',
      'Phase-A proof property is not the configured HRCEN property',
    );
  }
  const values = [
    input.requestedUserId,
    input.expectedTransportId,
    input.expectedThreadId,
    input.expectedTriggerMessageId,
    input.expectedCandidateId,
    input.issued.accessId,
    input.issued.triggerMessageId,
    input.issued.issuer.userId,
    input.issued.issuer.mailboxAccessId,
    input.issued.issuer.transportId,
    input.issued.issuer.threadId,
    input.issued.issuer.triggerMessageId,
  ];
  if (values.some((value) => !value || !value.trim())) {
    throw new HmsProofCompositionError(
      'PROOF_SCOPE_INVALID',
      'Phase-A proof scope contains an empty server-owned reference',
    );
  }
  if (
    input.issued.candidateId !== input.expectedCandidateId &&
    !input.allowCandidateIdMismatch
  ) {
    throw new HmsProofCompositionError(
      'CANDIDATE_SCOPE_MISMATCH',
      'mailbox trigger candidate does not match the selected exact candidate',
    );
  }
  if (input.issued.accessId !== input.issued.issuer.mailboxAccessId) {
    throw new HmsProofCompositionError(
      'MAILBOX_GRANT_SCOPE_MISMATCH',
      'mailbox access issuer does not match the current grant',
    );
  }
  if (input.issued.issuer.userId !== input.requestedUserId) {
    throw new HmsProofCompositionError(
      'MAILBOX_GRANT_SCOPE_MISMATCH',
      'current mailbox grant belongs to a different server user',
    );
  }
  if (
    input.issued.issuer.transportId !== input.expectedTransportId ||
    input.issued.issuer.threadId !== input.expectedThreadId ||
    input.issued.issuer.triggerMessageId !== input.expectedTriggerMessageId ||
    input.issued.triggerMessageId !== input.expectedTriggerMessageId
  ) {
    throw new HmsProofCompositionError(
      'MAILBOX_SCOPE_MISMATCH',
      'current mailbox trigger is outside the selected transport/thread scope',
    );
  }
  const expiresAt = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(input.now.getTime()) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= input.now.getTime()
  ) {
    throw new HmsProofCompositionError(
      'PROOF_EXPIRED',
      'Phase-A proof authorization must expire in the future',
    );
  }
}

/** The direct proof driver must receive the real advisory-lock object. */
export function assertPhaseAProofPropertyReadLock(
  value: unknown,
): asserts value is PropertyReadLock {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { key?: unknown }).key !== 'string' ||
    !(value as { key: string }).key.trim() ||
    typeof (value as { withLock?: unknown }).withLock !== 'function'
  ) {
    throw new HmsProofCompositionError(
      'PROPERTY_READ_LOCK_REQUIRED',
      'proof driver requires a real Postgres property read lock',
    );
  }
}

/** True only for the actual unrecorded-auth -> recorded-capture order. */
export function validatePhaseAProofMilestones(
  milestones: Partial<Record<PhaseAProofMilestone, string>> | null | undefined,
): boolean {
  if (!milestones) return false;
  const times = PHASE_A_PROOF_MILESTONE_ORDER.map((key) => Date.parse(milestones[key] ?? ''));
  return (
    times.every(Number.isFinite) &&
    times.every((value, index) => index === 0 || value >= times[index - 1]!)
  );
}

export type PhaseAProofRuntimeOptions = {
  sourceRevision: string;
  /** Raw child-process-only key; never returned or persisted. */
  evidenceKeyRaw?: string;
  region?: string;
  artifactRoot?: string;
  loadSecret?: HmsSecretLoader;
};

export type PhaseAProofRuntime = {
  runtime: HmsRuntime;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  privateDigestKeyVersion: string;
};

async function loadHmsSecretFromSecretsManager(input: {
  secretArn: string;
  region?: string;
}): Promise<ProductionSecretLoadResult> {
  const client = new SecretsManagerClient({
    region: input.region ?? process.env.AWS_REGION ?? 'af-south-1',
  });
  const response = await client.send(new GetSecretValueCommand({ SecretId: input.secretArn }));
  if (!response.SecretString) {
    throw new HmsProofCompositionError('SECRET_LOAD_FAILED', 'HMS secret is empty');
  }
  if (!response.VersionId) {
    throw new HmsProofCompositionError(
      'CREDENTIAL_VERSION_MISSING',
      'HMS secret VersionId is missing',
    );
  }
  return {
    secret: JSON.parse(response.SecretString),
    versionId: response.VersionId,
    versionStages: response.VersionStages ?? [],
  };
}

/**
 * Build the production proof runtime with the current secret version and
 * child-only evidence key. The loader is called once; the raw secret/key stay
 * in this process memory and are never part of the returned binding.
 */
export async function createPhaseAProofRuntime(
  config: HmsWorkerRuntimeConfig,
  options: PhaseAProofRuntimeOptions,
): Promise<PhaseAProofRuntime> {
  const sourceRevision = requiredString(options.sourceRevision, 'sourceRevision');
  if (sourceRevision === 'unknown' || sourceRevision === 'undefined') {
    throw new HmsProofCompositionError(
      'SOURCE_REVISION_INVALID',
      'proof source revision must be concrete',
    );
  }
  const evidenceSecretArn = requiredString(config.evidenceHmacSecretArn, 'evidenceHmacSecretArn');
  const evidenceKeyVersion = requiredString(
    config.evidenceHmacKeyVersion,
    'evidenceHmacKeyVersion',
  );
  const evidenceKey = parseChildOnlyEvidenceHmacKey(
    options.evidenceKeyRaw ?? process.env.HMS_EVIDENCE_HMAC_KEY,
  );
  const evidenceHmac: HmsEvidenceHmacConfig = {
    secretArn: evidenceSecretArn,
    keyVersion: evidenceKeyVersion,
    key: evidenceKey,
  };
  const loadSecret =
    options.loadSecret ??
    ((input) =>
      loadHmsSecretFromSecretsManager({
        secretArn: input.secretArn,
        region: options.region,
      }));
  const loaded = await loadSecret({ secretArn: config.secretArn });
  const normalized = normalizeLoadedSecret(loaded);
  if (!normalized.version) {
    throw new HmsProofCompositionError(
      'CREDENTIAL_VERSION_MISSING',
      'HMS secret loader did not return VersionId metadata',
    );
  }
  const runtimeFingerprintInput = {
    sourceRevision,
    playwrightRevision: PROOF_PLAYWRIGHT_REVISION,
    chromiumRevision: PROOF_CHROMIUM_REVISION,
  } as const;
  const bindings = revalidateEvidenceBindings({
    secretVersion: normalized.version,
    evidence: evidenceHmac,
    runtimeFingerprint: runtimeFingerprintInput,
    hmsSecretArn: config.secretArn,
  });
  const runtime = await createProductionHmsProofRuntime(config, {
    sourceRevision,
    artifactRoot: options.artifactRoot,
    region: options.region,
    loadSecret: async () => loaded,
    evidenceHmac,
    expectedCredentialVersionHmacSha256: bindings.credentialVersionHmacSha256,
    expectedRuntimeFingerprintSha256: bindings.runtimeFingerprintSha256 ?? undefined,
  });
  if (!bindings.runtimeFingerprintSha256) {
    throw new HmsProofCompositionError(
      'RUNTIME_FINGERPRINT_INVALID',
      'proof runtime fingerprint was not produced',
    );
  }
  return {
    runtime,
    credentialVersionHmacSha256: bindings.credentialVersionHmacSha256,
    runtimeFingerprintSha256: bindings.runtimeFingerprintSha256,
    privateDigestKeyVersion: evidenceKeyVersion,
  };
}

export type PhaseAProofAuthorizationInput = {
  db: DB;
  userId: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  candidate: ReservationSearchCandidate;
  manifest: RequestPolicyManifest;
  operationId: string;
  propertyCode: string;
  sourceRevision: string;
  roleProofPath: string;
  roleProofSha256: string;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  privateDigestKeyVersion: string;
  expiresAt: string;
  now?: Date;
};

export type PhaseAProofAuthorization = {
  issuedAdmission: IssuedMailboxReadAdmission;
  currentAppAccessProof: CurrentAppAccessProof;
  sessionAuthorization: HmsSessionAuthorization;
  manifestSha256: string;
  expiresAt: string;
};

/** Re-check the server-owned ticket immediately before each runtime open. */
export function assertPhaseAProofAuthorizationForDispatch(input: {
  authorization: PhaseAProofAuthorization;
  userId: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  candidateId: string;
  propertyCode: string;
  now?: Date;
  /** Wave 0b: surname+dates search reuses a mail row for admission only. */
  allowCandidateIdMismatch?: boolean;
}): void {
  const now = input.now ?? new Date();
  assertPhaseAProofScope({
    requestedUserId: input.userId,
    expectedTransportId: input.transportId,
    expectedThreadId: input.threadId,
    expectedTriggerMessageId: input.triggerMessageId,
    expectedCandidateId: input.candidateId,
    propertyCode: input.propertyCode,
    expectedPropertyCode: PROOF_PROPERTY_CODE,
    issued: input.authorization.issuedAdmission,
    expiresAt: input.authorization.expiresAt,
    now,
    allowCandidateIdMismatch: input.allowCandidateIdMismatch,
  });
  assertReadAdmissionIssuer({
    issuer: input.authorization.issuedAdmission.issuer,
    admission: input.authorization.issuedAdmission.admission,
    request: input.authorization.issuedAdmission.readRequest,
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
  });
  assertCurrentAppAccessProof({
    proof: input.authorization.currentAppAccessProof,
    requesterAuthorizationId: input.authorization.issuedAdmission.accessId,
    context: {
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
    },
    now,
  });
  if (
    input.authorization.sessionAuthorization.releaseId !== PHASE_A_FIND_LEASE_RELEASE_ID ||
    input.authorization.sessionAuthorization.requestBranchId !== PROOF_BRANCH_ID ||
    input.authorization.sessionAuthorization.manifestSha256 !==
      input.authorization.manifestSha256 ||
    input.authorization.issuedAdmission.admission.manifestSha256 !==
      input.authorization.manifestSha256 ||
    input.authorization.issuedAdmission.admission.captureBindingRef !==
      input.authorization.sessionAuthorization.operationId ||
    Date.parse(input.authorization.sessionAuthorization.expiresAt) <= now.getTime()
  ) {
    throw new HmsProofCompositionError(
      'PROOF_SESSION_AUTH_INVALID',
      'Phase-A session authorization is stale or not bound to the proof lease',
    );
  }
}

/**
 * Mint and immediately verify the real current mailbox issuer + app proof for
 * one exact trigger. The Phase-A lease is used only as an unpromoted proof
 * identity; this function never reads or writes the active registry.
 */
export async function issuePhaseAProofAuthorization(
  input: PhaseAProofAuthorizationInput,
): Promise<PhaseAProofAuthorization> {
  const now = input.now ?? new Date();
  const userId = requiredString(input.userId, 'userId');
  const transportId = requiredString(input.transportId, 'transportId');
  const threadId = requiredString(input.threadId, 'threadId');
  const triggerMessageId = requiredString(input.triggerMessageId, 'triggerMessageId');
  const operationId = requiredString(input.operationId, 'operationId');
  const sourceRevision = requiredString(input.sourceRevision, 'sourceRevision');
  const roleProofPath = requiredString(input.roleProofPath, 'roleProofPath');
  assertDigest(input.roleProofSha256, 'roleProofSha256');
  assertDigest(input.credentialVersionHmacSha256, 'credentialVersionHmacSha256');
  assertDigest(input.runtimeFingerprintSha256, 'runtimeFingerprintSha256');
  const privateDigestKeyVersion = requiredString(
    input.privateDigestKeyVersion,
    'privateDigestKeyVersion',
  );
  requiredString(input.candidate.id, 'candidate.id');
  if (input.propertyCode !== PROOF_PROPERTY_CODE) {
    throw new HmsProofCompositionError(
      'PROPERTY_MISMATCH',
      'Phase-A proof property is not the configured HRCEN property',
    );
  }
  const requestedExpiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now.getTime()) {
    throw new HmsProofCompositionError(
      'PROOF_EXPIRED',
      'Phase-A proof authorization must expire in the future',
    );
  }
  const manifestSha256 = sha256Hex(JSON.stringify(input.manifest));
  const issued = await issueReadAdmissionFromMailbox({
    db: input.db,
    userId,
    transportId,
    threadId,
    toolId: PROOF_TOOL_ID,
    releaseId: PHASE_A_FIND_LEASE_RELEASE_ID,
    requestBranchId: PROOF_BRANCH_ID,
    manifestSha256,
    propertyCode: input.propertyCode,
    sourceRevision,
    // A UUID operation is a private, stable capture binding before the
    // artifact store allocates its random artifact id.
    captureBindingRef: operationId,
    now,
  });
  assertPhaseAProofScope({
    requestedUserId: userId,
    expectedTransportId: transportId,
    expectedThreadId: threadId,
    expectedTriggerMessageId: triggerMessageId,
    expectedCandidateId: input.candidate.id,
    propertyCode: input.propertyCode,
    expectedPropertyCode: PROOF_PROPERTY_CODE,
    issued,
    expiresAt: input.expiresAt,
    now,
    allowCandidateIdMismatch:
      input.candidate.kind === 'surname_dates' ||
      process.env.HMS_PROOF_ALLOW_CANDIDATE_ID_MISMATCH === '1',
  });
  if (
    issued.admission.releaseId !== PHASE_A_FIND_LEASE_RELEASE_ID ||
    issued.admission.requestBranchId !== PROOF_BRANCH_ID ||
    issued.admission.manifestSha256 !== manifestSha256 ||
    issued.admission.captureBindingRef !== operationId
  ) {
    throw new HmsProofCompositionError(
      'PROOF_ADMISSION_BINDING_INVALID',
      'Phase-A admission is not bound to the proof operation and manifest',
    );
  }
  assertReadAdmissionIssuer({
    issuer: issued.issuer,
    admission: issued.admission,
    request: issued.readRequest,
    transportId,
    threadId,
    triggerMessageId,
  });
  const currentAppAccessProof = issueCurrentAppAccessProof({
    userId: issued.issuer.userId,
    mailboxAccessId: issued.accessId,
    transportId,
    threadId,
    triggerMessageId: issued.triggerMessageId,
    expiresAt: input.expiresAt,
    now,
  });
  assertCurrentAppAccessProof({
    proof: currentAppAccessProof,
    requesterAuthorizationId: issued.accessId,
    context: { transportId, threadId, triggerMessageId },
    now,
  });
  const sessionAuthorization = buildHmsFindSessionAuthorization({
    operationId,
    requestBranchId: PROOF_BRANCH_ID,
    manifest: input.manifest,
    roleProofPath,
    roleProofSha256: input.roleProofSha256,
    credentialVersionHmacSha256: input.credentialVersionHmacSha256,
    runtimeFingerprintSha256: input.runtimeFingerprintSha256,
    privateDigestKeyVersion,
    sourceRevision,
    expiresAt: input.expiresAt,
    // Deliberately null: Phase-A is not a promoted active release.
    release: null,
  });
  const authorization = {
    issuedAdmission: issued,
    currentAppAccessProof,
    sessionAuthorization,
    manifestSha256,
    expiresAt: input.expiresAt,
  };
  assertPhaseAProofAuthorizationForDispatch({
    authorization,
    userId,
    transportId,
    threadId,
    triggerMessageId,
    candidateId: input.candidate.id,
    propertyCode: input.propertyCode,
    now,
    allowCandidateIdMismatch:
      input.candidate.kind === 'surname_dates' ||
      process.env.HMS_PROOF_ALLOW_CANDIDATE_ID_MISMATCH === '1',
  });
  return authorization;
}

export type HmsProofResultSidecarInput = {
  artifactRoot: string;
  artifactId: string;
  /**
   * Optional on-disk directory name under artifactRoot. Soft incomplete
   * captures live at `.incomplete-<artifactId>` while receipt.artifactId
   * stays the UUID.
   */
  artifactDirName?: string;
  operationId: string;
  sourceRevision: string;
  receiptSha256: string;
  expiresAt: string;
  roleProofSha256: string;
  roleProofExpiresAt: string;
  sessionAuthorization: HmsSessionAuthorization;
  issuedAdmission: Pick<
    IssuedMailboxReadAdmission,
    'accessId' | 'triggerMessageId' | 'candidateId' | 'admission' | 'issuer'
  >;
  currentAppAccessProof: CurrentAppAccessProof;
  input: { candidateId: string };
  result: unknown;
};

export type HmsProofResultSidecar = {
  relativePath: string;
  sha256: string;
  bytes: number;
};

function assertPrivateCaptureDirectory(path: string, label: string): Promise<void> {
  return lstat(path)
    .then((info) => {
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new HmsProofCompositionError(
          'RESULT_SIDECAR_STORAGE',
          `${label} must be a real directory`,
        );
      }
    })
    .catch((error) => {
      if (error instanceof HmsProofCompositionError) throw error;
      throw new HmsProofCompositionError('RESULT_SIDECAR_STORAGE', `${label} is unavailable`);
    });
}

/**
 * Write only the private, typed result/provenance sidecar. The artifact
 * directory is created and owned by the native capture store; this helper
 * never creates or copies browser artifacts.
 */
export async function writeHmsProofResultSidecar(
  input: HmsProofResultSidecarInput,
): Promise<HmsProofResultSidecar> {
  assertDigest(input.receiptSha256, 'receiptSha256');
  assertDigest(input.roleProofSha256, 'roleProofSha256');
  const artifactRoot = resolve(input.artifactRoot);
  const dirName = input.artifactDirName?.trim() || input.artifactId;
  const artifactDir = resolve(artifactRoot, dirName);
  const relativeArtifactDir = relative(artifactRoot, artifactDir);
  if (
    !relativeArtifactDir ||
    relativeArtifactDir.startsWith('..') ||
    relativeArtifactDir.includes('/') ||
    relativeArtifactDir.includes('\\')
  ) {
    throw new HmsProofCompositionError(
      'RESULT_SIDECAR_STORAGE',
      'artifact id escapes the private root',
    );
  }
  await assertPrivateCaptureDirectory(artifactRoot, 'artifact root');
  await assertPrivateCaptureDirectory(artifactDir, 'artifact directory');
  const result = JSON.parse(JSON.stringify(input.result)) as unknown;
  const body = `${JSON.stringify(
    {
      schemaVersion: 1,
      artifactId: input.artifactId,
      operationId: input.operationId,
      sourceRevision: input.sourceRevision,
      tool: { id: PROOF_TOOL_ID, version: PROOF_TOOL_VERSION },
      request: input.input,
      result,
      provenance: {
        releaseId: input.sessionAuthorization.releaseId,
        requestBranchId: input.sessionAuthorization.requestBranchId,
        manifestSha256: input.sessionAuthorization.manifestSha256,
        roleProofSha256: input.roleProofSha256,
        roleProofExpiresAt: input.roleProofExpiresAt,
        credentialVersionHmacSha256: input.sessionAuthorization.credentialVersionHmacSha256,
        runtimeFingerprintSha256: input.sessionAuthorization.runtimeFingerprintSha256,
        privateDigestKeyVersion: input.sessionAuthorization.privateDigestKeyVersion,
        sourceRevision: input.sessionAuthorization.sourceRevision,
        issuerId: input.issuedAdmission.issuer.issuerId,
        userId: input.issuedAdmission.issuer.userId,
        mailboxAccessId: input.issuedAdmission.accessId,
        transportId: input.issuedAdmission.issuer.transportId,
        threadId: input.issuedAdmission.issuer.threadId,
        triggerMessageId: input.issuedAdmission.triggerMessageId,
        admissionInputDigest: input.issuedAdmission.admission.inputDigest,
        captureBindingRef: input.issuedAdmission.admission.captureBindingRef,
        currentAppAccessExpiresAt: input.currentAppAccessProof.expiresAt,
      },
      receiptSha256: input.receiptSha256,
      expiresAt: input.expiresAt,
    },
    null,
    2,
  )}\n`;
  const bodyBuffer = Buffer.from(body, 'utf8');
  const targetPath = join(artifactDir, 'result.v1.json');
  const tempPath = join(artifactDir, `.result.v1.${randomUUID()}.tmp`);
  let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    tempHandle = await open(tempPath, 'wx', 0o600);
    await tempHandle.writeFile(bodyBuffer);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;
    await chmod(tempPath, 0o600);
    // link() gives the final path no-overwrite semantics; rename() would allow
    // a stale artifact to be silently replaced.
    await link(tempPath, targetPath);
    await unlink(tempPath);
    await chmod(targetPath, 0o600);
  } catch (error) {
    try {
      await tempHandle?.close();
    } catch {
      // Preserve the storage failure below.
    }
    await unlink(tempPath).catch(() => undefined);
    if (error instanceof HmsProofCompositionError) throw error;
    throw new HmsProofCompositionError(
      'RESULT_SIDECAR_STORAGE',
      'private proof result sidecar could not be written exclusively',
    );
  }
  return {
    relativePath: join(relativeArtifactDir, 'result.v1.json'),
    sha256: sha256Hex(body),
    bytes: bodyBuffer.byteLength,
  };
}

export {
  PROOF_BRANCH_ID,
  PROOF_CHROMIUM_REVISION,
  PROOF_PROPERTY_CODE,
  PROOF_TOOL_ID,
  PROOF_TOOL_VERSION,
};
