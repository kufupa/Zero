import { getDemoSession } from '@/lib/demo/session';
import type { AuthApi, LoginProvidersResult } from '../contract';

export function createDemoAuthAdapter(): AuthApi {
  return {
    mode: 'demo',
    getSession: async () => ({
      data: getDemoSession(),
      error: null,
    }),
    linkSocialSafe: async () => undefined,
    getLoginProviders: async ({ isProd }): Promise<LoginProvidersResult> => ({
      isProd,
      providers: [
        {
          id: 'zero',
          name: 'Continue to Demo',
          enabled: true,
          required: false,
          envVarStatus: [],
          isCustom: true,
          customRedirectPath: '/mail/inbox',
        },
      ],
    }),
  };
}
