import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { READ_TOOL_IDS } from './read-tools.js';
import { hmsReadRoleProofV1Schema } from './production-runtime.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const toolId = z.enum(READ_TOOL_IDS);

export const hmsReadRoleProofV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    actorDigest: sha,
    propertyCode: z.string().min(1).max(32),
    currency: z.string().regex(/^[A-Z]{3}$/),
    credentialMode: z.literal('view_only'),
    allowedSurfaces: z.array(z.string().min(1)).min(1),
    deniedActions: z.array(z.string().min(1)).min(1),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    evidenceSha256: sha,
  })
  .strict();

export const hmsReadRoleProofSchema = z.union([
  hmsReadRoleProofV1Schema,
  hmsReadRoleProofV2Schema,
]);

export const hmsBrowserArtifactReceiptV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    artifactId: uuid,
    operationId: uuid,
    toolId,
    toolVersion: z.string().min(1),
    candidateHash: sha,
    scopeHash: sha,
    resultHash: sha,
    sourceHash: sha,
    roleProofSha256: sha,
    discoverySha256: sha,
    sourceRevision: z.string().min(1),
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
  toolId: z.infer<typeof toolId>;
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
