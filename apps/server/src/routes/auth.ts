import { authProviders, customProviders, isProviderEnabled } from '../lib/auth-providers';
import type { HonoContext } from '../ctx';
import { Hono } from 'hono';
import { getDemoUser, isDemoMode } from '../lib/auth';

const publicRouter = new Hono<HonoContext>();
const authSessionRouter = new Hono<HonoContext>();

publicRouter.get('/providers', async (c) => {
  if (isDemoMode()) {
    return c.json({
      allProviders: [],
      isProd: c.env.NODE_ENV === 'production',
    });
  }

  const env = c.env as unknown as Record<string, string>;
  const isProd = env.NODE_ENV === 'production';

  const authProviderStatus = authProviders(env).map((provider) => {
    const envVarStatus =
      provider.envVarInfo?.map((envVar) => {
        const envVarName = envVar.name as keyof typeof env;
        return {
          name: envVar.name,
          set: !!env[envVarName],
          source: envVar.source,
          defaultValue: envVar.defaultValue,
        };
      }) || [];

    return {
      id: provider.id,
      name: provider.name,
      enabled: isProviderEnabled(provider, env),
      required: provider.required,
      envVarInfo: provider.envVarInfo,
      envVarStatus,
    };
  });

  const customProviderStatus = customProviders.map((provider) => {
    return {
      id: provider.id,
      name: provider.name,
      enabled: true,
      isCustom: provider.isCustom,
      customRedirectPath: provider.customRedirectPath,
      envVarStatus: [],
    };
  });

  const allProviders = [...customProviderStatus, ...authProviderStatus];

  return c.json({
    allProviders,
    isProd,
  });
});

authSessionRouter.get('/session', (c) => {
  return c.json({ user: getDemoUser() });
});

export { publicRouter, authSessionRouter };
