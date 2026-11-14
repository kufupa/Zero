import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { propertyCodeSchema } from './property-registry.js';
import { discoveryOperationIdSchema, hmsReadToolIdSchema, roleSurfaceIdSchema, READ_TOOLS } from './read-tools.js';
import { hmsReadRoleProofV2Schema, validateRoleProofV2ForTool, roleProofV2Path } from './release-kernel.js';
import { hmacSha256PrivateValue, sha256Integrity } from './private-digests.js';
import { credentialVersionHmacSha256, runtimeFingerprintSha256 } from './evidence-runtime.js';

/** Native permission evidence is distinct from a client guard aborting a write. */
export const cloudReadRoleObservationSchema = z.object({
  propertyCode: propertyCodeSchema,
  tenantId: z.string().min(1),
  landingPropertyCode: propertyCodeSchema,
  origin: z.string().url(),
  toolId: hmsReadToolIdSchema,
  discoveryOperationId: discoveryOperationIdSchema,
  operationId: z.string().uuid(),
  observedAt: z.string().datetime(),
  observedSurfaces: z.array(roleSurfaceIdSchema).min(1),
  deniedActions: z.array(z.object({
    action: z.string().min(1),
    basis: z.enum(['native_role_permission', 'native_role_refusal']),
    evidenceRef: z.string().min(1),
  }).strict()).min(1),
}).strict();

export function captureCloudReadRoleProof(input: {
  observation: unknown;
  credential: { secretArn: string; versionId: string; versionStages: readonly string[]; mode: 'view_only'; actor: string };
  evidence: { key: Buffer; keyVersion: string };
  sourceRevision: string;
  playwrightRevision: string;
  chromiumRevision: string;
  expiresAt: string;
  now?: Date;
}) {
  const observation = cloudReadRoleObservationSchema.parse(input.observation);
  const property = getPropertyRegistration(observation.propertyCode);
  const now = input.now ?? new Date();
  if (!property || observation.tenantId !== property.expectedTenant ||
      observation.landingPropertyCode !== property.landingPropertyCode || observation.origin !== property.origin ||
      input.credential.secretArn !== property.credentialSecretRef || input.credential.mode !== 'view_only' ||
      !input.credential.versionStages.includes('AWSCURRENT') || !input.credential.actor.trim() ||
      !input.sourceRevision.trim() || !Number.isFinite(now.getTime()) ||
      Date.parse(observation.observedAt) > now.getTime() || now.getTime() - Date.parse(observation.observedAt) > 5 * 60_000) {
    throw new Error('cloud read role observation identity or freshness mismatch');
  }
  const tool = READ_TOOLS[observation.toolId];
  const surfaces = new Set(tool.requestBranches.flatMap(branch => branch.requiredRoleSurfaces));
  if (observation.observedSurfaces.length !== surfaces.size ||
      observation.observedSurfaces.some(surface => !surfaces.has(surface)) ||
      new Set(observation.observedSurfaces).size !== observation.observedSurfaces.length ||
      new Set(observation.deniedActions.map(item => item.action)).size !== observation.deniedActions.length ||
      tool.deniedActions.some(action => !observation.deniedActions.some(item => item.action === action))) {
    throw new Error('cloud read role observation lacks required native surface or denial evidence');
  }
  const digest = (purpose: 'actor' | 'scope' | 'result', value: string) => hmacSha256PrivateValue({
    key: input.evidence.key, keyVersion: input.evidence.keyVersion, purpose, value,
  }).hmacSha256;
  const proof = hmsReadRoleProofV2Schema.parse({
    schemaVersion: 2, attestationKind: 'operator_observed_runtime',
    toolId: observation.toolId, discoveryOperationId: observation.discoveryOperationId,
    operationId: observation.operationId, observerSourceRevision: input.sourceRevision,
    evidenceArtifactId: randomUUID(), privateDigestKeyVersion: input.evidence.keyVersion,
    actorHmacSha256: digest('actor', input.credential.actor),
    credentialVersionHmacSha256: credentialVersionHmacSha256({
      evidenceKey: input.evidence.key, evidenceKeyVersion: input.evidence.keyVersion,
      hmsSecretArn: input.credential.secretArn, hmsSecretVersionId: input.credential.versionId,
    }),
    runtimeFingerprintSha256: runtimeFingerprintSha256(input),
    roleFingerprintSha256: digest('scope', JSON.stringify({ propertyCode: observation.propertyCode,
      tenantId: observation.tenantId, landingPropertyCode: observation.landingPropertyCode,
      origin: observation.origin, surfaces: [...surfaces].sort(), deniedActions: [...tool.deniedActions].sort() })),
    propertyCode: observation.propertyCode, tenantId: observation.tenantId,
    landingPropertyCode: observation.landingPropertyCode, origin: observation.origin,
    currency: 'ZAR', credentialMode: 'view_only', allowedSurfaces: observation.observedSurfaces,
    deniedActions: observation.deniedActions.map(item => item.action), issuedAt: observation.observedAt,
    expiresAt: input.expiresAt, evidenceSha256: digest('result', JSON.stringify(observation)),
  });
  validateRoleProofV2ForTool(proof, tool, now);
  return { proof, proofSha256: sha256Integrity(`${JSON.stringify(proof, null, 2)}\n`) };
}

/** Install only a fully validated proof, outside any checkout and within its own partition. */
export async function installCloudReadRoleProof(input: { root: string; proof: unknown; now?: Date }) {
  const proof = hmsReadRoleProofV2Schema.parse(input.proof);
  validateRoleProofV2ForTool(proof, READ_TOOLS[proof.toolId], input.now ?? new Date());
  const root = resolve(input.root);
  for (let parent = root; ; parent = dirname(parent)) {
    try { await lstat(join(parent, '.git')); throw new Error('read role proofs cannot be installed in Git'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (dirname(parent) === parent) break;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const directory of [root, join(root, proof.propertyCode)]) {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o022)) throw new Error('unsafe read role proof directory');
  }
  const path = roleProofV2Path(root, proof.toolId, proof.propertyCode);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return path;
}
