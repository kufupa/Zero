import type { AttachmentAdmission } from './reservationist-attachment-input.js';
import type { DB } from '../db/client.js';
import type { AiRunFence } from './run-ledger.js';
import type { DraftArtifactStorage, GeneratedDraftArtifact } from './drafts.js';
import type { ReservationistRuntimeInput, runReservationistRuntime } from './reservationist-runtime.js';
import type { LocalModelAdapterConfig, LocalModelRouteEvidence, LocalModelTransport } from './bedrock/local.js';
import { AzureLunaModelAdapter } from './bedrock/luna.js';
import { createRequire } from 'node:module';

/** Server-owned release identity for the configured draft-purpose route. */
export type DraftRouteReleaseDescriptor = {
  releaseId: string;
  releaseVersion: string;
  sourceRevision: string;
  fingerprint: string;
  purpose: 'draft';
  capabilityFamilyVersions: Record<string, string>;
  issuedAt: string;
  expiresAt: string;
  withdrawn: boolean;
};

export type DraftRouteAuthority = {
  route: DraftModelRouteConfig['route'];
  release: DraftRouteReleaseDescriptor;
};
/** Explicit installed hosted route; this does not confer a release or source grant. */
export type AzureDraftModelRouteEvidence = Omit<LocalModelRouteEvidence,'purpose'|'protocol'|'egress'> & {purpose:'draft';protocol:'azure-foundry-responses';egress:'azure-foundry'};

export const AZURE_DRAFT_ROUTE: AzureDraftModelRouteEvidence = {
  routeId: 'azure_luna_max',
  purpose: 'draft',
  protocol: 'azure-foundry-responses',
  access: 'current_app',
  egress: 'azure-foundry',
  retention: 'bounded',
  usage: 'reported',
  modelId: 'gpt-6-luna',
};

export type ReservationistProviderContext = {
  db: DB; transportId: string; threadId: string; requestedByUserId: string;
  generationId: string; admissions: readonly AttachmentAdmission[]; input: ReservationistRuntimeInput; signal: AbortSignal; fence: AiRunFence;
  /** Recheck the active claim, mailbox grant and admitted source identities. */
  revalidateSources: () => Promise<boolean>;
};
export type ReservationistProvider = (context: ReservationistProviderContext) => Promise<{
  dependencies: Parameters<typeof runReservationistRuntime>[1];
  collectGeneratedArtifacts: () => GeneratedDraftArtifact[];
  collectUsage?: () => {known:boolean;inputTokens:number|null;outputTokens:number|null;estimatedCostUsd:number|null;rateTableVersions:string[]};
  artifactStorage?: DraftArtifactStorage;
}>;

/** Explicitly configured lower edge for the normal draft-purpose route. */
export type DraftModelRouteConfig = {
  route: (LocalModelRouteEvidence & { purpose: 'draft' }) | AzureDraftModelRouteEvidence;
  transport: LocalModelTransport;
  /** Optional real call-budget seam; required by task-first reservationist extraction. */
  reserveCalls?: LocalModelAdapterConfig['reserveCalls'];
  /** Trusted installed services; enabled only by matching release capability. */
  reservationist?: ReservationistProvider;
  /** Present on the normal configured factory; test-only injected routes may omit it. */
  release?: DraftRouteReleaseDescriptor;
};

export type DraftModelRouteFactory = () => DraftModelRouteConfig | undefined;

type ConfiguredDraftRouteModule = {
  default?: unknown;
  createDraftModelRoute?: () => unknown;
  createApprovedLocalDraftRoute?: () => unknown;
};

type ConfiguredDraftRouteDescriptor = {
  module: string;
  route: DraftModelRouteConfig['route'];
  release: DraftRouteReleaseDescriptor;
};

export function isDraftRouteReleaseDescriptor(
  value: unknown,
): value is DraftRouteReleaseDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const release = value as Partial<DraftRouteReleaseDescriptor>;
  const capabilityVersions = release.capabilityFamilyVersions;
  return (
    typeof release.releaseId === 'string' &&
    release.releaseId.trim().length > 0 &&
    typeof release.releaseVersion === 'string' &&
    release.releaseVersion.trim().length > 0 &&
    typeof release.sourceRevision === 'string' &&
    release.sourceRevision.trim().length > 0 &&
    typeof release.fingerprint === 'string' &&
    release.fingerprint.trim().length > 0 &&
    release.purpose === 'draft' &&
    typeof capabilityVersions === 'object' &&
    capabilityVersions !== null &&
    !Array.isArray(capabilityVersions) &&
    Object.keys(capabilityVersions).length > 0 &&
    Object.values(capabilityVersions).every(
      (version) => typeof version === 'string' && version.trim().length > 0,
    ) &&
    typeof release.issuedAt === 'string' &&
    !Number.isNaN(Date.parse(release.issuedAt)) &&
    typeof release.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(release.expiresAt)) &&
    typeof release.withdrawn === 'boolean'
  );
}

function isActiveDraftRouteRelease(
  release: DraftRouteReleaseDescriptor,
  now = new Date(),
): boolean {
  return (
    !release.withdrawn &&
    Date.parse(release.issuedAt) <= now.getTime() &&
    Date.parse(release.expiresAt) > now.getTime()
  );
}

function sameDraftRouteRelease(
  left: DraftRouteReleaseDescriptor,
  right: DraftRouteReleaseDescriptor,
): boolean {
  return (
    left.releaseId === right.releaseId &&
    left.releaseVersion === right.releaseVersion &&
    left.sourceRevision === right.sourceRevision &&
    left.fingerprint === right.fingerprint &&
    left.purpose === right.purpose &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt &&
    left.withdrawn === right.withdrawn &&
    JSON.stringify(left.capabilityFamilyVersions) === JSON.stringify(right.capabilityFamilyVersions)
  );
}

export function isDraftRouteEvidence(value: unknown): value is DraftModelRouteConfig['route'] {
  if (typeof value !== 'object' || value === null) return false;
  const route = value as Partial<DraftModelRouteConfig['route']>;
  return (
    typeof route.routeId === 'string' &&
    route.routeId.trim().length > 0 &&
    route.purpose === 'draft' &&
    (route.protocol === 'in_process' && route.egress === 'none' || route.protocol === 'azure-foundry-responses' && route.egress === 'azure-foundry') &&
    route.access === 'current_app' &&
    route.retention === 'bounded' &&
    route.usage === 'reported' &&
    typeof route.modelId === 'string' &&
    route.modelId.trim().length > 0
  );
}

function isDraftRouteConfig(value: unknown): value is DraftModelRouteConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Partial<DraftModelRouteConfig>;
  return isDraftRouteEvidence(config.route) && typeof config.transport === 'function' && (config.reserveCalls === undefined || typeof config.reserveCalls === 'function') && (config.reservationist === undefined || typeof config.reservationist === 'function');
}

function sameRouteEvidence(
  left: DraftModelRouteConfig['route'],
  right: DraftModelRouteConfig['route'],
): boolean {
  return (
    left.routeId === right.routeId &&
    left.purpose === right.purpose &&
    left.protocol === right.protocol &&
    left.access === right.access &&
    left.egress === right.egress &&
    left.retention === right.retention &&
    left.usage === right.usage &&
    left.modelId === right.modelId
  );
}

function parseConfiguredDraftRouteDescriptor(): ConfiguredDraftRouteDescriptor | undefined {
  const raw = process.env.AI_APPROVED_LOCAL_DRAFT_CONFIG?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      module?: unknown;
      route?: unknown;
      release?: unknown;
    };
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.module !== 'string' ||
      parsed.module.trim().length === 0 ||
      !isDraftRouteEvidence(parsed.route) ||
      !isDraftRouteReleaseDescriptor(parsed.release)
    ) {
      return undefined;
    }
    return { module: parsed.module.trim(), route: parsed.route, release: parsed.release };
  } catch {
    return undefined;
  }
}

function createAzureDraftModelRoute(): DraftModelRouteConfig {
  const adapter = new AzureLunaModelAdapter();
  return {
    route: AZURE_DRAFT_ROUTE,
    async transport(request) {
      const result = await adapter.invoke({
        modelId: request.modelId,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        ...(request.files?.length ? { files: request.files } : {}),
        ...(request.images?.length ? { images: request.images } : {}),
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.maxInputBytes ? { maxInputBytes: request.maxInputBytes } : {}),
        responseSchema: request.responseSchema,
        signal: request.signal,
      });
      return {
        output: result.output,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs: result.usage.latencyMs,
        },
      };
    },
  };
}

/**
 * Load an explicitly installed in-process route, else Azure GPT-6 Luna.
 * Missing Azure env fails loud; it never falls back to a playbook or Bedrock.
 */
export function loadConfiguredDraftModelRoute(): DraftModelRouteConfig | undefined {
  if (process.env.AI_MODEL_ROUTE === 'approved-local') {
    const descriptor = parseConfiguredDraftRouteDescriptor();
    if (descriptor && isActiveDraftRouteRelease(descriptor.release)) {
      try {
        const loaded = createRequire(import.meta.url)(descriptor.module) as ConfiguredDraftRouteModule;
        const configured = loaded.createDraftModelRoute
          ? loaded.createDraftModelRoute()
          : loaded.createApprovedLocalDraftRoute
            ? loaded.createApprovedLocalDraftRoute()
            : (loaded.default ?? loaded);
        if (isDraftRouteConfig(configured) && sameRouteEvidence(configured.route, descriptor.route)) {
          if (!configured.release || sameDraftRouteRelease(configured.release, descriptor.release)) {
            return { ...configured, release: descriptor.release };
          }
        }
      } catch {
        // Fall through to the Azure default rather than a silent playbook.
      }
    }
  }
  return createAzureDraftModelRoute();
}

/** Enqueue labels only — does not construct a client. */
export function draftRouteEnqueueLabels(): { modelId: string } {
  if (process.env.AI_MODEL_ROUTE === 'approved-local') {
    const descriptor = parseConfiguredDraftRouteDescriptor();
    if (descriptor && isActiveDraftRouteRelease(descriptor.release)) {
      return { modelId: descriptor.route.modelId };
    }
  }
  return { modelId: AZURE_DRAFT_ROUTE.modelId };
}

/** Current server-owned authority used when revalidating a reviewed draft. */
export function resolveCurrentDraftRouteAuthority(): DraftRouteAuthority | undefined {
  if (process.env.AI_MODEL_ROUTE !== 'approved-local') return undefined;
  const descriptor = parseConfiguredDraftRouteDescriptor();
  if (!descriptor || !isActiveDraftRouteRelease(descriptor.release)) return undefined;
  // Approval revalidation must not initialize a provider/model or invoke the
  // route factory. Resolve only the explicitly configured local module path;
  // a removed module means current authority is unavailable and fails closed.
  try {
    createRequire(import.meta.url).resolve(descriptor.module);
  } catch {
    return undefined;
  }
  return { route: descriptor.route, release: descriptor.release };
}

export function createDraftModelRouteFactory(
  config?: DraftModelRouteConfig | DraftModelRouteFactory,
): DraftModelRouteFactory {
  return () => (typeof config === 'function' ? config() : config);
}

/** Normal daemon/CLI composition. */
export function createProductionDraftModelRouteFactory(): DraftModelRouteFactory {
  return createDraftModelRouteFactory(loadConfiguredDraftModelRoute);
}
