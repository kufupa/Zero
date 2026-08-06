/**
 * Production HMS runtime composition — Playwright is a hard runtime dependency.
 * No fetch/mock browser factory fallback. Role-proof revalidated per context.
 */
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { HmsWorkerRuntimeConfig } from '../env.js';
import { buildLiveGuestStayReadManifest } from './live-read-manifest.js';
import {
  CENTURION_HMS_PRODUCTION_ORIGIN,
  createHmsBrowserArtifactStore,
  ensureHmsBrowserArtifactRoot,
} from './browser-artifacts.js';
import {
  hmsReadRoleProofV1Schema,
  loadHmsReadRoleProof,
  type HmsReadRoleProofV1,
} from './release-kernel.js';
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
export { hmsReadRoleProofV1Schema, loadHmsReadRoleProof };
export type { HmsReadRoleProofV1 };

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
