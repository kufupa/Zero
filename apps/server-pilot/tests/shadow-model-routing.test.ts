import { ModelRouteUnavailableError, resolveModelRoute } from '../src/ai/local-model-routing.js';
import { resolveApprovedLocalModelAdapter } from '../src/ai/bedrock/factory.js';
import type { LocalModelRouteEvidence } from '../src/ai/bedrock/local.js';
import { describe, expect, it } from 'vitest';

const routeEvidence: LocalModelRouteEvidence = {
  routeId: 'shadow-test-route',
  protocol: 'in_process',
  access: 'current_app',
  egress: 'none',
  retention: 'bounded',
  usage: 'reported',
  modelId: 'shadow-test-model',
};

describe('draft, extraction, shadow, and judge model routing', () => {
  it.each(['draft', 'extraction', 'shadow', 'judge'] as const)(
    'refuses %s when approved local route is unavailable',
    (purpose) => {
      expect(() => resolveModelRoute({ purpose })).toThrow(ModelRouteUnavailableError);
    },
  );

  it('factory guard refuses before transport initialization when the route is not approved', () => {
    let transportInitialized = false;
    expect(() =>
      resolveApprovedLocalModelAdapter(
        { AI_MODEL_ROUTE: 'unavailable' },
        {
          purpose: 'draft',
          route: routeEvidence,
          transport: async () => {
            transportInitialized = true;
            return {
              output: {},
              usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
            };
          },
        },
      ),
    ).toThrow(ModelRouteUnavailableError);
    expect(transportInitialized).toBe(false);
  });
});
