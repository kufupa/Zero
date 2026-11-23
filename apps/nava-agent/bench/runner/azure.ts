import { setTimeout as sleep } from 'node:timers/promises';
import { callAzureResponses } from '../../src/agent-runtime/azure.js';
import type { ModelCall } from '../../src/agent-runtime/loop.js';

export function azureReplayModel(model: string, effort: string, options: { fetcher?: typeof fetch; wait?: typeof sleep } = {}): ModelCall {
  const base = (process.env.AZURE_OPENAI_BASE_URL ?? 'https://nava.openai.azure.com/openai/v1').replace(/\/$/, '');
  const key = process.env.AZURE_FOUNDRY_API_KEY ?? process.env.AZURE_OPENAI_API_KEY;
  if (!key) throw new Error('AZURE_FOUNDRY_API_KEY_REQUIRED');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('INVALID_REASONING_EFFORT');
  const wait = options.wait ?? sleep;
  return request => callAzureResponses(request, {
    baseURL: base,
    apiKey: key,
    deployment: model,
    effort,
    maxTokens: 16384,
    fetcher: options.fetcher,
    wait: ms => wait(ms),
  });
}
