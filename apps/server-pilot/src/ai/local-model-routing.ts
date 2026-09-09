import {
  createLocalModelAdapter,
  LocalModelRouteUnavailableError,
  type LocalModelRouteEvidence,
  type LocalModelTransport,
} from './bedrock/local.js';
import type { ModelAdapter } from './bedrock/adapter.js';

export {
  LocalModelRouteUnavailableError,
  LocalModelRouteUnavailableError as ModelRouteUnavailableError,
};

export type ModelRoutePurpose = 'draft' | 'extraction' | 'shadow' | 'judge';

export type ModelRouteRequest = {
  purpose: ModelRoutePurpose;
  route?: LocalModelRouteEvidence;
  transport?: LocalModelTransport;
};

/**
 * Resolve only the explicitly injected, approved local route. There is no
 * hosted/Bedrock/fake fallback: a missing route is a safe activation refusal.
 */
export function resolveModelRoute(input: ModelRouteRequest): ModelAdapter {
  if (!input.route || !input.transport) {
    throw new LocalModelRouteUnavailableError(
      `approved local model route unavailable for ${input.purpose}`,
    );
  }
  return createLocalModelAdapter({
    route: input.route,
    transport: input.transport,
  });
}

export function resolvePurposeModelAdapter(input: ModelRouteRequest): ModelAdapter {
  return resolveModelRoute(input);
}

export const resolveDraftModelAdapter = (input: Omit<ModelRouteRequest, 'purpose'>) =>
  resolveModelRoute({ ...input, purpose: 'draft' });
export const resolveExtractionModelAdapter = (input: Omit<ModelRouteRequest, 'purpose'>) =>
  resolveModelRoute({ ...input, purpose: 'extraction' });
export const resolveShadowModelAdapter = (input: Omit<ModelRouteRequest, 'purpose'>) =>
  resolveModelRoute({ ...input, purpose: 'shadow' });
export const resolveJudgeModelAdapter = (input: Omit<ModelRouteRequest, 'purpose'>) =>
  resolveModelRoute({ ...input, purpose: 'judge' });

export function isApprovedLocalRouteEvidence(
  route: LocalModelRouteEvidence | undefined,
): route is LocalModelRouteEvidence {
  return Boolean(
    route &&
      route.routeId &&
      route.protocol === 'in_process' &&
      route.access === 'current_app' &&
      route.egress === 'none' &&
      route.retention === 'bounded' &&
      route.usage === 'reported' &&
      route.modelId,
  );
}
