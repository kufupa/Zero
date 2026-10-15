/**
 * Production HMS runtime composition — Playwright is a hard runtime dependency.
 * No fetch/mock browser factory fallback. Role-proof revalidated per context.
 * Consumes role schemas from release-kernel (no reverse import).
 * Task 13: active registry v2 + per-context HmsSessionAuthorization own
 * production activation; process-wide Guest Stay manifest is never sole
 * live-session authority (requireSessionAuthorization + driver lease).
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
  revalidateEvidenceBindings,
  type HmsEvidenceHmacConfig,
  type HmsSecretVersionMetadata,
} from './evidence-runtime.js';
import {
  hmsReadRoleProofV1Schema,
  loadHmsReadRoleProof,
  loadHmsReadRoleProofV2,
  type HmsReadRoleProofV1,
  type HmsReadRoleProofV2,
} from './release-kernel.js';
import { READ_TOOLS, HMS_READ_TOOL_IDS, type HmsReadToolId } from './read-tools.js';
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

export type ProductionSecretLoadResult = {
  secret: unknown;
  versionId: string;
  versionStages: string[];
};

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
    if (!res.VersionId) {
      throw new HmsRuntimeError(
        'CREDENTIAL_VERSION_MISSING',
        'Secrets Manager VersionId missing',
      );
    }
    // Preserve VersionId for credentialVersionHmacSha256; never persist raw secret.
    // Do not invent AWSCURRENT when SDK omits VersionStages — empty stages fail-closed
    // when evidence bindings are required.
    return {
      secret: JSON.parse(res.SecretString),
      versionId: res.VersionId,
      versionStages: res.VersionStages ?? [],
    };
  };
}

/** Normalize injectable loader payloads: plain secret or { secret, versionId, stages }. */
export function normalizeLoadedSecret(raw: unknown): {
  secret: unknown;
  version: HmsSecretVersionMetadata | null;
} {
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'secret' in raw &&
    typeof (raw as { versionId?: unknown }).versionId === 'string'
  ) {
    const record = raw as {
      secret: unknown;
      versionId: string;
      versionStages?: string[];
    };
    // Missing VersionStages stay empty — never fake AWSCURRENT.
    return {
      secret: record.secret,
      version: {
        versionId: record.versionId,
        versionStages: record.versionStages ?? [],
      },
    };
  }
  return { secret: raw, version: null };
}

function evidenceKeyByteLength(key: string | Buffer): number {
  return Buffer.isBuffer(key) ? key.byteLength : Buffer.byteLength(key, 'utf8');
}

/**
 * Resolve evidence HMAC config. When ARN/version are configured, child key must
 * be present and ≥32 bytes — never silently skip with Buffer.alloc(0).
 */
function requireEvidenceHmacForProduction(
  config: HmsWorkerRuntimeConfig,
  options: ProductionHmsRuntimeOptions | undefined,
): HmsEvidenceHmacConfig | undefined {
  const arn = config.evidenceHmacSecretArn?.trim();
  const keyVersion = config.evidenceHmacKeyVersion?.trim();
  const arnConfigured = Boolean(arn && keyVersion);
  const evidence = options?.evidenceHmac;

  if (!evidence) {
    if (arnConfigured) {
      throw new HmsRuntimeError(
        'EVIDENCE_KEY_MISSING',
        'evidence HMAC child key required when ARN/version configured',
      );
    }
    return undefined;
  }

  const keyLen = evidenceKeyByteLength(evidence.key);
  if (keyLen < 32) {
    throw new HmsRuntimeError(
      keyLen === 0 ? 'EVIDENCE_KEY_MISSING' : 'EVIDENCE_KEY_INVALID',
      keyLen === 0
        ? 'evidence HMAC child key required when ARN/version configured'
        : 'evidence HMAC key must be at least 32 bytes',
    );
  }
  return evidence;
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
 * Load role proof — v1 path stays for Phase A find; v2 when schemaVersion=2
 * or path ends with `.v2.json` (toolId inferred from filename / override).
 */
export async function loadProductionRoleProof(
  path: string,
  options?: { toolId?: HmsReadToolId; now?: Date },
): Promise<HmsReadRoleProofV1 | HmsReadRoleProofV2> {
  const now = options?.now ?? new Date();
  const isV2Path = /\.v2\.json$/i.test(path);
  if (isV2Path) {
    const toolId =
      options?.toolId ??
      (path.match(/([a-z0-9_]+)\.v2\.json$/i)?.[1] as HmsReadToolId | undefined);
    if (!toolId || !(toolId in READ_TOOLS) || !HMS_READ_TOOL_IDS.includes(toolId as HmsReadToolId)) {
      throw new HmsRuntimeError(
        'ROLE_SCOPE_INVALID',
        'role proof v2 requires HmsReadToolId',
      );
    }
    return loadHmsReadRoleProofV2(path, READ_TOOLS[toolId as HmsReadToolId], now);
  }
  // Peek schemaVersion without failing v1 loaders on unknown keys.
  const { readFile } = await import('node:fs/promises');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new HmsRuntimeError('ROLE_PROOF_MISSING', `role proof missing at ${path}`);
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as { schemaVersion?: unknown }).schemaVersion === 2
  ) {
    const toolId =
      options?.toolId ??
      ((parsed as { toolId?: unknown }).toolId as HmsReadToolId | undefined);
    if (!toolId || !(toolId in READ_TOOLS) || !HMS_READ_TOOL_IDS.includes(toolId)) {
      throw new HmsRuntimeError(
        'ROLE_SCOPE_INVALID',
        'role proof v2 requires HmsReadToolId',
      );
    }
    return loadHmsReadRoleProofV2(path, READ_TOOLS[toolId], now);
  }
  return loadHmsReadRoleProof(path, now);
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
  /** Child-only evidence HMAC config — inject fakes in tests; no AWS reads. */
  evidenceHmac?: HmsEvidenceHmacConfig;
  /** When set, revalidate credential HMAC against this expected digest. */
  expectedCredentialVersionHmacSha256?: string;
  expectedRuntimeFingerprintSha256?: string;
};

async function createProductionHmsRuntimeInternal(
  config: HmsWorkerRuntimeConfig,
  options: ProductionHmsRuntimeOptions | undefined,
  liveProof: boolean,
): Promise<HmsRuntime> {
  const sourceRevision = resolveHmsSourceRevision(options?.sourceRevision);
  await loadProductionRoleProof(config.roleProofPath);

  const loadSecret =
    options?.loadSecret ?? createSecretsManagerLoader(options?.region);
  const rawLoaded = await loadSecret({ secretArn: config.secretArn });
  const { secret: rawSecret, version } = normalizeLoadedSecret(rawLoaded);
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

  // Worker injects child key via options.evidenceHmac; ARN/version alone must not
  // silently skip bindings (live-proof must not carry VersionId without revalidation).
  const evidenceHmac = requireEvidenceHmacForProduction(config, options);

  let credentialHmac: string | undefined;
  let runtimeFp: string | undefined;
  if (evidenceHmac && version) {
    // Create-time VersionStages snapshot: session revalidation reuses this
    // metadata — Secrets Manager is not re-fetched for stage drift mid-process.
    // Fail-closed here if stages omit AWSCURRENT; mid-life rotation requires restart.
    const bindings = revalidateEvidenceBindings({
      secretVersion: version,
      evidence: evidenceHmac,
      expectedCredentialVersionHmacSha256:
        options?.expectedCredentialVersionHmacSha256,
      expectedRuntimeFingerprintSha256:
        options?.expectedRuntimeFingerprintSha256,
      runtimeFingerprint: {
        sourceRevision,
        playwrightRevision: '1.52.0',
        chromiumRevision: '1169',
      },
      hmsSecretArn: config.secretArn,
    });
    credentialHmac = bindings.credentialVersionHmacSha256;
    runtimeFp = bindings.runtimeFingerprintSha256 ?? undefined;
  } else if (evidenceHmac && !version) {
    throw new HmsRuntimeError(
      'CREDENTIAL_VERSION_MISSING',
      'Secrets Manager VersionId required for evidence binding',
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
    credentialUsername: secret.username,
    loadSecret: async () => ({
      secret,
      versionId: version?.versionId,
      versionStages: version?.versionStages,
    }),
    browserFactory,
    executablePath: config.chromiumExecutablePath,
    healthStatusPath: config.healthPath,
    circuitCooldownMs: config.circuitCooldownMs,
    defaultTimeoutMs: Math.min(15_000, config.runDeadlineMs),
    requireViewOnly: true,
    expectedOrigin: CENTURION_HMS_PRODUCTION_ORIGIN,
    roleProofPath: config.roleProofPath,
    loadRoleProof: async (path, now) => {
      const proof = await loadProductionRoleProof(path, { now });
      // Runtime v1 loader shape expects v1 fields; v2 is validated above.
      if (proof.schemaVersion === 2) {
        return {
          schemaVersion: 1 as const,
          propertyCode: 'HRCEN' as const,
          allowedSurfaces: ['Guest Stay'] as const,
          deniedActions: [
            'new_record',
            'save',
            'delete',
            'duplicate',
            'check_in',
            'check_out',
            'document_generate',
            'document_send',
          ] as const,
          issuedAt: proof.issuedAt,
          expiresAt: proof.expiresAt,
          evidenceRef: `role-proof-v2:${proof.toolId}`,
          evidenceSha256: proof.evidenceSha256,
        };
      }
      return proof;
    },
    healthHeartbeatMs: 10_000,
    healthStaleAfterMs: 30_000,
    runStartupCanary: false,
    artifactStore,
    requireAuditCapture: true,
    // Live opens must carry per-tool HmsSessionAuthorization.
    requireSessionAuthorization: true,
    sourceRevision,
    playwrightRevision: '1.52.0',
    chromiumRevision: '1169',
    evidenceBindings:
      evidenceHmac && version
        ? {
            evidence: evidenceHmac,
            // Create-time VersionStages snapshot — see comment above revalidate.
            secretVersion: version,
            expectedCredentialVersionHmacSha256: credentialHmac,
            expectedRuntimeFingerprintSha256: runtimeFp,
          }
        : undefined,
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
