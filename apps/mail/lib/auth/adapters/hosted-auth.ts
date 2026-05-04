import type { AuthApi, LoginProvidersResult } from '../contract';

export function createHostedAuthAdapter(): AuthApi {
  return {
    mode: 'hosted',
    getSession: async () => ({ data: null, error: null }),
    linkSocialSafe: async () => undefined,
    getLoginProviders: async ({ isProd }): Promise<LoginProvidersResult> => ({
      isProd,
      providers: [],
      loadError: 'hosted_unavailable',
    }),
  };
}
