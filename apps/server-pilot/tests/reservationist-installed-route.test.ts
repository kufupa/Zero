import { afterEach, expect, it, vi } from 'vitest';
import { createDraftModelRoute } from '../src/ai/reservationist-installed-route.js';

afterEach(() => vi.unstubAllEnvs());

it('composes the Azure reservationist provider without creating a release', () => {
  vi.stubEnv('AZURE_OPENAI_BASE_URL', 'https://example.invalid/openai/v1');
  vi.stubEnv('AZURE_FOUNDRY_API_KEY', 'synthetic-test-key');
  const route = createDraftModelRoute();
  expect(route.route).toMatchObject({ routeId: 'azure_luna_max', modelId: 'gpt-6-luna' });
  expect(route.reservationist).toBeTypeOf('function');
  expect(route.release).toBeUndefined();
});
