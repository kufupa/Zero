import { resolveMailMode } from '../runtime/mail-mode';
import { authClient } from './better-auth-instance';
import type { AuthApi } from './contract';
import { createDemoAuthAdapter } from './adapters/demo-auth';
import { createHostedAuthAdapter } from './adapters/hosted-auth';
import { createLegacyBetterAuthAdapter } from './adapters/legacy-better-auth';

let cached: { mode: ReturnType<typeof resolveMailMode>; api: AuthApi } | null = null;

/** Clears memoized adapter when env mode changes (e.g. Vitest stubs). */
export function resetAuthApiCache(): void {
  cached = null;
}

export function getAuthApi(): AuthApi {
  const mode = resolveMailMode();
  if (cached?.mode === mode) {
    return cached.api;
  }
  const api =
    mode === 'demo'
      ? createDemoAuthAdapter()
      : mode === 'hosted'
        ? createHostedAuthAdapter()
        : createLegacyBetterAuthAdapter(authClient);
  cached = { mode, api };
  return api;
}
