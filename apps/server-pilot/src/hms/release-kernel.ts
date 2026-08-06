/**
 * Phase B release / role-proof / receipt evidence schemas + role-proof loaders.
 * production-runtime consumes these; do not reverse-import from production-runtime.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  DISCOVERY_OPERATION_IDS,
  HMS_READ_TOOL_IDS,
  READ_TOOL_IDS,
  ROLE_SURFACE_IDS,
  type HmsReadToolId,
  type ReadToolDefinition,
  type ReadToolId,
} from './read-tools.js';
import { HmsRuntimeError } from './runtime.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const toolId = z.enum(READ_TOOL_IDS);
const hmsToolId = z.enum(HMS_READ_TOOL_IDS);
const discoveryOperationId = z.enum(DISCOVERY_OPERATION_IDS);
const roleSurfaceId = z.enum(ROLE_SURFACE_IDS);

const MAX_PROOF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Phase A v1 denied-action floor; kept for loader parity with schema tuple. */
const V1_DENIED_ACTIONS = [
  'new_record',
  'save',
  'delete',
  'duplicate',
  'check_in',
  'check_out',
  'document_generate',
  'document_send',
] as const;

export const hmsReadRoleProofV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    propertyCode: z.literal('HRCEN'),
    allowedSurfaces: z.tuple([z.literal('Guest Stay')]),
    deniedActions: z.tuple([
      z.literal('new_record'),
      z.literal('save'),
      z.literal('delete'),
      z.literal('duplicate'),
      z.literal('check_in'),
      z.literal('check_out'),
      z.literal('document_generate'),
      z.literal('document_send'),
    ]),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    evidenceRef: z.string().min(1),
    evidenceSha256: sha,
  })
  .strict();

export type HmsReadRoleProofV1 = z.infer<typeof hmsReadRoleProofV1Schema>;

export const hmsReadRoleProofV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    attestationKind: z.literal('operator_observed_runtime'),
    toolId: hmsToolId,
    discoveryOperationId,
    operationId: uuid,
    observerSourceRevision: z.string().min(1),
    evidenceArtifactId: uuid,
    privateDigestKeyVersion: z.string().min(1),
    actorHmacSha256: sha,
    credentialVersionHmacSha256: sha,
    runtimeFingerprintSha256: sha,
    roleFingerprintSha256: sha,
    propertyCode: z.literal('HRCEN'),
    currency: z.literal('ZAR'),
    credentialMode: z.literal('view_only'),
    allowedSurfaces: z.array(roleSurfaceId).min(1),
    deniedActions: z.array(z.string().min(1)).min(1),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    evidenceSha256: sha,
  })
  .strict();

export type HmsReadRoleProofV2 = z.infer<typeof hmsReadRoleProofV2Schema>;

export const hmsReadRoleProofSchema = z.union([
  hmsReadRoleProofV1Schema,
  hmsReadRoleProofV2Schema,
]);

export type HmsReadRoleProof = z.infer<typeof hmsReadRoleProofSchema>;

const hmsArtifactReceiptCommonV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    artifactId: uuid,
    operationId: uuid,
    toolId: hmsToolId,
    discoveryOperationId,
    toolVersion: z.string().min(1),
    sourceRevision: z.string().min(1),
    credentialVersionHmacSha256: sha,
    runtimeFingerprintSha256: sha,
    privateDigestKeyVersion: z.string().min(1),
    traceSha256: sha,
    videoSha256: sha.nullable(),
    operationOutcome: z.enum([
      'succeeded',
      'unverified_negative',
      'failed',
      'timed_out',
      'aborted',
      'policy_blocked',
    ]),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const hmsBrowserArtifactReceiptV2Schema = z.discriminatedUnion(
  'executionClass',
  [
    hmsArtifactReceiptCommonV2Schema.extend({
      executionClass: z.literal('discovery'),
      structuralSignatureSha256: sha,
      candidateSnapshotSha256: sha.nullable(),
    }),
    hmsArtifactReceiptCommonV2Schema.extend({
      executionClass: z.literal('proof'),
      requestBranchId: z.string().min(1),
      candidateSnapshotSha256: sha,
      candidateHmacSha256: sha,
      scopeHmacSha256: sha,
      resultHmacSha256: sha,
      sourceRefHmacSha256: sha,
      roleProofSha256: sha,
      discoveryReceiptSha256: sha,
      oracleArtifactSha256: sha,
    }),
  ],
);

export type HmsBrowserArtifactReceiptV2 = z.infer<
  typeof hmsBrowserArtifactReceiptV2Schema
>;

export const hmsEvidenceBindingV1Schema = z
  .object({
    toolId: hmsToolId,
    toolVersion: z.string().min(1),
    operationId: uuid,
    discoveryOperationId,
    candidateSnapshotSha256: sha,
    propertyCode: z.literal('HRCEN'),
    credentialVersionHmacSha256: sha,
    runtimeFingerprintSha256: sha,
    privateDigestKeyVersion: z.string().min(1),
    roleProofSha256: sha,
    requestBranchId: z.string().min(1),
    sourceRevision: z.string().min(1),
    verifierVersion: z.string().min(1).max(64),
  })
  .strict();

export type HmsEvidenceBindingV1 = z.infer<typeof hmsEvidenceBindingV1Schema>;

const releaseBaseFields = {
  schemaVersion: z.literal(2),
  releaseId: uuid,
  toolsetVersion: z.string().min(1),
  toolsetFingerprint: sha,
  sourceRevision: z.string().min(1),
  phaseAPlanSha256: sha,
  phaseBPlanSha256: sha,
  gateSha256: sha,
  runtimeAbiVersion: z.string().min(1),
  runtimeFingerprintSha256: sha,
  implementationSha256: sha,
  requesterPolicySha256: sha,
  privateDigestKeyVersion: z.string().min(1),
  liveProofSha256: sha,
  receiptSha256: sha,
  rollbackAction: z.enum(['restore_predecessor', 'disable']),
} as const;

const liveVerifiedFields = {
  qualification: z.literal('live_verified'),
  shadowSha256: z.null(),
  predecessorReleaseId: uuid.nullable(),
} as const;

const shadowEnabledFields = {
  qualification: z.literal('shadow_enabled'),
  shadowSha256: sha,
  predecessorReleaseId: uuid,
} as const;

const hmsEvidenceFields = {
  evidenceKind: z.literal('hms'),
  toolId: hmsToolId,
  toolVersion: z.string().min(1),
  requestBranches: z
    .array(
      z
        .object({
          id: z.string().min(1),
          discoveryOperationId,
          manifestSha256: sha,
          discoverySha256: sha,
          parserSchemaSha256: sha,
        })
        .strict(),
    )
    .min(1),
  credentialVersionHmacSha256: sha,
  roleProofSha256: sha,
} as const;

const mailEvidenceFields = {
  evidenceKind: z.literal('mail'),
  toolId: z.literal('mail_read_artifact'),
  toolVersion: z.literal('2'),
  grantPolicySha256: sha,
  s3IdentitySha256: sha,
  parserSandboxSha256: sha,
} as const;

export const hmsPortfolioToolReleaseV2Schema = z.union([
  z.object({ ...releaseBaseFields, ...liveVerifiedFields, ...hmsEvidenceFields }).strict(),
  z.object({ ...releaseBaseFields, ...shadowEnabledFields, ...hmsEvidenceFields }).strict(),
  z.object({ ...releaseBaseFields, ...liveVerifiedFields, ...mailEvidenceFields }).strict(),
  z.object({ ...releaseBaseFields, ...shadowEnabledFields, ...mailEvidenceFields }).strict(),
]);

export type HmsPortfolioToolReleaseV2 = z.infer<
  typeof hmsPortfolioToolReleaseV2Schema
>;

export const hmsPortfolioToolReleaseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    releaseId: uuid,
    toolId,
    toolVersion: z.string().min(1),
    toolsetVersion: z.string().min(1),
    toolsetFingerprint: sha,
    sourceSha256: sha,
    planSha256: sha,
    gateSha256: sha,
    requestManifestSha256: sha,
    roleProofSha256: sha,
    discoverySha256: sha,
    liveProofSha256: sha,
    receiptSha256: sha,
    shadowSha256: sha,
    predecessorReleaseId: uuid.nullable(),
    rollbackAction: z.enum(['restore_predecessor', 'disable']),
  })
  .strict();

export const hmsPortfolioWaveV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    waveId: z.string().min(1),
    releaseIds: z.array(uuid).min(1),
  })
  .strict();

export const hmsActiveRegistryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().nonnegative(),
    active: z.record(toolId, uuid),
    retainedPredecessors: z.record(toolId, z.array(uuid)),
  })
  .strict();

export type HmsPortfolioToolReleaseV1 = z.infer<
  typeof hmsPortfolioToolReleaseV1Schema
>;
export type HmsActiveRegistryV1 = z.infer<typeof hmsActiveRegistryV1Schema>;

export function roleProofV2Path(root: string, toolId: HmsReadToolId): string {
  return join(root, 'role-proofs', `${toolId}.v2.json`);
}

export function validateRoleProofV2ForTool(
  proof: HmsReadRoleProofV2,
  tool: ReadToolDefinition,
  now: Date,
): void {
  const parsed = hmsReadRoleProofV2Schema.parse(proof);
  if (tool.id === 'mail_read_artifact') {
    throw new Error('mail_read_artifact cannot enter HMS role proof v2');
  }
  if (parsed.toolId !== tool.id) {
    throw new Error('role proof toolId mismatch');
  }
  if (!tool.discoveryOperationIds.includes(parsed.discoveryOperationId)) {
    throw new Error('role proof discoveryOperationId not enabled for tool');
  }
  const issued = Date.parse(parsed.issuedAt);
  const expires = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) {
    throw new Error('role proof dates invalid');
  }
  if (issued > now.getTime()) {
    throw new Error('role proof issued in the future');
  }
  if (expires <= issued) {
    throw new Error('role proof TTL must be > 0');
  }
  if (expires <= now.getTime()) {
    throw new Error('role proof expired');
  }
  const ttl = expires - issued;
  if (ttl > MAX_PROOF_TTL_MS) {
    throw new Error('role proof TTL exceeds 30d');
  }
  const requiredSurfaces = new Set(
    tool.requestBranches.flatMap((branch) => branch.requiredRoleSurfaces),
  );
  if (
    parsed.allowedSurfaces.length !== requiredSurfaces.size ||
    parsed.allowedSurfaces.some((surface) => !requiredSurfaces.has(surface))
  ) {
    throw new Error('role proof allowedSurfaces must match branch surfaces');
  }
  for (const action of tool.deniedActions) {
    if (!parsed.deniedActions.includes(action)) {
      throw new Error(`role proof missing denied action ${action}`);
    }
  }
}

/** Phase A v1 role-proof loader — path + TTL + denied-action floor. */
export async function loadHmsReadRoleProof(
  path: string,
  now: Date = new Date(),
): Promise<HmsReadRoleProofV1> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new HmsRuntimeError(
      'ROLE_PROOF_MISSING',
      `role proof missing at ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof JSON invalid');
  }
  let proof: HmsReadRoleProofV1;
  try {
    proof = hmsReadRoleProofV1Schema.parse(parsed);
  } catch {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof schema invalid');
  }
  const issued = Date.parse(proof.issuedAt);
  const expires = Date.parse(proof.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof dates invalid');
  }
  if (issued > now.getTime() || expires <= issued) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'role proof date order invalid',
    );
  }
  if (expires < now.getTime()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'role proof expired');
  }
  if (expires - issued > MAX_PROOF_TTL_MS) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof TTL exceeds 30d');
  }
  if (proof.propertyCode !== 'HRCEN') {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof property mismatch');
  }
  for (const action of V1_DENIED_ACTIONS) {
    if (!proof.deniedActions.includes(action)) {
      throw new HmsRuntimeError(
        'ROLE_SCOPE_INVALID',
        'role proof deniedActions incomplete',
      );
    }
  }
  if (!proof.allowedSurfaces.includes('Guest Stay')) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof surface invalid');
  }
  return proof;
}

/**
 * Phase B v2 role-proof loader. Validates via `validateRoleProofV2ForTool`.
 * Prefer `loadHmsReadRoleProofV2ForTool` when loading from the standard root path.
 */
export async function loadHmsReadRoleProofV2(
  path: string,
  tool: ReadToolDefinition,
  now: Date = new Date(),
): Promise<HmsReadRoleProofV2> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new HmsRuntimeError(
      'ROLE_PROOF_MISSING',
      `role proof v2 missing at ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof v2 JSON invalid');
  }
  let proof: HmsReadRoleProofV2;
  try {
    proof = hmsReadRoleProofV2Schema.parse(parsed);
  } catch {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'role proof v2 schema invalid',
    );
  }
  try {
    validateRoleProofV2ForTool(proof, tool, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'role proof v2 invalid';
    if (/expired/i.test(message)) {
      throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', message);
    }
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', message);
  }
  return proof;
}

export async function loadHmsReadRoleProofV2ForTool(
  root: string,
  tool: ReadToolDefinition,
  now: Date = new Date(),
): Promise<HmsReadRoleProofV2> {
  if (tool.id === 'mail_read_artifact') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'mail_read_artifact cannot enter HMS role proof v2',
    );
  }
  return loadHmsReadRoleProofV2(
    roleProofV2Path(root, tool.id),
    tool,
    now,
  );
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function loadActiveReadRegistry(path: string): Promise<HmsActiveRegistryV1> {
  try {
    return hmsActiveRegistryV1Schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { schemaVersion: 1, generation: 0, active: {}, retainedPredecessors: {} };
  }
}

export async function promoteReadTool(input: {
  path: string;
  release: HmsPortfolioToolReleaseV1;
}): Promise<HmsActiveRegistryV1> {
  const release = hmsPortfolioToolReleaseV1Schema.parse(input.release);
  const current = await loadActiveReadRegistry(input.path);
  if (current.active[release.toolId] === release.releaseId) return current;
  const predecessor = current.active[release.toolId];
  if (release.predecessorReleaseId !== (predecessor ?? null)) {
    throw new Error('release predecessor mismatch');
  }
  const retained = [...(current.retainedPredecessors[release.toolId] ?? [])];
  if (predecessor && !retained.includes(predecessor)) retained.push(predecessor);
  const next = hmsActiveRegistryV1Schema.parse({
    ...current,
    generation: current.generation + 1,
    active: { ...current.active, [release.toolId]: release.releaseId },
    retainedPredecessors: {
      ...current.retainedPredecessors,
      [release.toolId]: retained,
    },
  });
  await atomicWrite(input.path, next);
  return next;
}

export async function rollbackReadTool(input: {
  path: string;
  toolId: ReadToolId;
}): Promise<HmsActiveRegistryV1> {
  const current = await loadActiveReadRegistry(input.path);
  const retained = [...(current.retainedPredecessors[input.toolId] ?? [])];
  const predecessor = retained.pop();
  const active = { ...current.active };
  if (predecessor) active[input.toolId] = predecessor;
  else delete active[input.toolId];
  if (current.active[input.toolId] === active[input.toolId]) return current;
  const next = hmsActiveRegistryV1Schema.parse({
    ...current,
    generation: current.generation + 1,
    active,
    retainedPredecessors: {
      ...current.retainedPredecessors,
      [input.toolId]: retained,
    },
  });
  await atomicWrite(input.path, next);
  return next;
}

/** Integrity digest helper for tests and callers hashing public artifacts. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
