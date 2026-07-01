import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getSocialProviders } from './auth-providers.js';

/**
 * Pilot auth builder.
 * TODO(task-5): wire drizzle adapter, real DB, plugins (jwt, bearer, phoneNumber),
 * session/cookie config, account-linking, hooks. This stub returns a minimal
 * better-auth instance so `Auth` type resolves and `apps/mail` typechecks.
 */
export const createAuth = (opts?: Partial<BetterAuthOptions>): ReturnType<typeof betterAuth> => {
  const env = process.env as Record<string, string | undefined>;
  return betterAuth({
    secret:
      env.BETTER_AUTH_SECRET?.trim() ||
      (env.NODE_ENV === 'production'
        ? undefined
        : 'local-dev-better-auth-secret-min-32-characters-long'),
    baseURL: env.BETTER_AUTH_URL,
    socialProviders: getSocialProviders(env as Record<string, string>),
    emailAndPassword: { enabled: false },
    ...opts,
  });
};

export type Auth = ReturnType<typeof createAuth>;
export type SimpleAuth = Auth;
