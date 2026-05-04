import { authClient } from '../better-auth-instance';
import type { AuthApi, LoginProvidersResult } from '../contract';

export function createLegacyBetterAuthAdapter(client: typeof authClient): AuthApi {
  return {
    mode: 'legacy',
    getSession: () =>
      client.getSession({
        fetchOptions: {
          credentials: 'include',
        },
      }) as Promise<{ data: unknown; error: unknown }>,
    linkSocialSafe: (payload) =>
      client.linkSocial(payload as Parameters<typeof authClient.linkSocial>[0]) as Promise<unknown>,
    getLoginProviders: async ({ isProd }): Promise<LoginProvidersResult> => {
      try {
        const response = await fetch(import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/public/providers');
        if (!response.ok) {
          return { isProd, providers: [], loadError: 'http_error' };
        }
        const data = (await response.json()) as { allProviders?: LoginProvidersResult['providers'] };
        return {
          isProd,
          providers: (data.allProviders ?? []) as LoginProvidersResult['providers'],
        };
      } catch {
        return { isProd, providers: [], loadError: 'unreachable' };
      }
    },
  };
}
