import { resolveMailMode } from '../runtime/mail-mode';
import { api } from '../trpc';
import type { FrontendApi } from './contract';
import { createDemoLocalAdapter } from './adapters/demo-local';
import { createHostedHttpAdapter } from './adapters/hosted-http';
import { createLegacyTrpcAdapter } from './adapters/legacy-trpc';

let cached: { mode: ReturnType<typeof resolveMailMode>; api: FrontendApi } | null = null;

export function getFrontendApi(): FrontendApi {
  const mode = resolveMailMode();
  if (cached?.mode === mode) {
    return cached.api;
  }
  const next =
    mode === 'hosted'
      ? createHostedHttpAdapter()
      : mode === 'demo'
        ? createDemoLocalAdapter()
        : createLegacyTrpcAdapter(api);
  cached = { mode, api: next };
  return next;
}
