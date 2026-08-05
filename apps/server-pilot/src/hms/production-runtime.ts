/**
 * Production HMS runtime composition — Playwright is a hard runtime dependency.
 * No fetch/mock browser factory fallback. Role-proof revalidated per context.
 */
import { readFile } from 'node:fs/promises';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import type { HmsWorkerRuntimeConfig } from '../env.js';
import { buildLiveGuestStayReadManifest } from './live-read-manifest.js';
import {
  CENTURION_HMS_PRODUCTION_ORIGIN,
  createHmsBrowserArtifactStore,
  ensureHmsBrowserArtifactRoot,
} from './browser-artifacts.js';
import {
  createHmsLiveProofRuntime,
  createHmsRuntime,
  createPlaywrightBrowserFactory,
  hmsSecretSchema,
  HmsRuntimeError,
  type HmsRuntime,
  type HmsSecretLoader,
} from './runtime.js';

export { CENTURION_HMS_PRODUCTION_ORIGIN };

const DENIED_ACTIONS = [
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
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

export type HmsReadRoleProofV1 = z.infer<typeof hmsReadRoleProofV1Schema>;

const MAX_PROOF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  for (const action of DENIED_ACTIONS) {
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

function createSecretsManagerLoader(region?: string): HmsSecretLoader {
  return async ({ secretArn, signal: _signal }) => {
    void _signal;
    const client = new SecretsManagerClient({
      region: region ?? process.env.AWS_REGION ?? 'af-south-1',
    });
    const res = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!res.SecretString) {
      throw new HmsRuntimeError('secret_load_failed', 'secret empty');
    }
    return hmsSecretSchema.parse(JSON.parse(res.SecretString));
  };
}

export function resolveHmsSourceRevision(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const revision = explicit?.trim() || env.NAVA_BUILD_COMMIT?.trim();
  if (
    !revision ||
    revision.toLowerCase() === 'production' ||
    revision.toLowerCase() === 'unknown'
  ) {
    throw new HmsRuntimeError(
      'AUDIT_CAPTURE',
      'concrete HMS source revision required',
    );
  }
  return revision;
}

/**
 * Production composition: Playwright Chromium required; role-proof path wired;
 * live Guest Stay manifest from secret login origin; mandatory private capture.
 */
type ProductionHmsRuntimeOptions = {
  loadSecret?: HmsSecretLoader;
  region?: string;
  artifactRoot?: string;
  sourceRevision?: string;
};

async function createProductionHmsRuntimeInternal(
  config: HmsWorkerRuntimeConfig,
  options: ProductionHmsRuntimeOptions | undefined,
  liveProof: boolean,
): Promise<HmsRuntime> {
  const sourceRevision = resolveHmsSourceRevision(options?.sourceRevision);
  await loadHmsReadRoleProof(config.roleProofPath);

  const loadSecret =
    options?.loadSecret ?? createSecretsManagerLoader(options?.region);
  const rawSecret = await loadSecret({ secretArn: config.secretArn });
  const secret = hmsSecretSchema.parse(rawSecret);
  const origin = new URL(secret.loginUrl).origin;

  if (origin !== CENTURION_HMS_PRODUCTION_ORIGIN) {
    throw new HmsRuntimeError(
      'PRODUCTION_ORIGIN_MISMATCH',
      'secret login origin is not Centurion production HMS',
    );
  }

  if (secret.expectedPropertyCode !== config.expectedPropertyCode) {
    throw new HmsRuntimeError(
      'PROPERTY_MISMATCH',
      'secret property does not match worker config',
    );
  }
  if (secret.expectedTenant !== config.expectedTenant) {
    throw new HmsRuntimeError(
      'PROPERTY_MISMATCH',
      'secret tenant does not match worker config',
    );
  }
  if (secret.mailboxTransportId !== config.expectedTransportId) {
    throw new HmsRuntimeError(
      'transport_mismatch',
      'secret transport does not match worker config',
    );
  }

  const manifest = buildLiveGuestStayReadManifest(origin);
  for (const rule of manifest.rules) {
    if (rule.origin !== CENTURION_HMS_PRODUCTION_ORIGIN) {
      throw new HmsRuntimeError(
        'PRODUCTION_ORIGIN_MISMATCH',
        'manifest rule origin is not Centurion production HMS',
      );
    }
  }

  const artifactRoot =
    options?.artifactRoot ??
    process.env.HMS_BROWSER_ARTIFACT_ROOT ??
    '/opt/nava/shared/hms-browser-artifacts';
  await ensureHmsBrowserArtifactRoot(artifactRoot);
  const artifactStore = await createHmsBrowserArtifactStore({
    root: artifactRoot,
  });
  await artifactStore.purgeExpired();

  const browserFactory = createPlaywrightBrowserFactory();

  // Legacy /reservations canary is fixture-shaped and POLICY_BLOCK on live
  // OSRESS-only manifest. Readiness = LiveGuestStayDriver.runNotFoundCanary.
  const createRuntime = liveProof
    ? createHmsLiveProofRuntime
    : createHmsRuntime;
  return createRuntime({
    manifest,
    secretArn: config.secretArn,
    loadSecret: async () => secret,
    browserFactory,
    executablePath: config.chromiumExecutablePath,
    healthStatusPath: config.healthPath,
    circuitCooldownMs: config.circuitCooldownMs,
    defaultTimeoutMs: Math.min(15_000, config.runDeadlineMs),
    requireViewOnly: true,
    expectedOrigin: CENTURION_HMS_PRODUCTION_ORIGIN,
    roleProofPath: config.roleProofPath,
    loadRoleProof: loadHmsReadRoleProof,
    healthHeartbeatMs: 10_000,
    healthStaleAfterMs: 30_000,
    runStartupCanary: false,
    artifactStore,
    requireAuditCapture: true,
    sourceRevision,
    playwrightRevision: '1.52.0',
    chromiumRevision: '1169',
  });
}

export function createProductionHmsRuntime(
  config: HmsWorkerRuntimeConfig,
  options?: ProductionHmsRuntimeOptions,
): Promise<HmsRuntime> {
  return createProductionHmsRuntimeInternal(config, options, false);
}

/** Proof CLI only. Normal workers must use createProductionHmsRuntime. */
export function createProductionHmsProofRuntime(
  config: HmsWorkerRuntimeConfig,
  options?: ProductionHmsRuntimeOptions,
): Promise<HmsRuntime> {
  return createProductionHmsRuntimeInternal(config, options, true);
}
