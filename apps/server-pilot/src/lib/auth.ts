import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getSocialProviders } from './auth-providers.js';
import { getDb } from '../db/client.js';
import * as schema from '../db/schema/index.js';

/**
 * Pilot Better Auth instance.
 *
 * Wired against the RDS Postgres schema via the drizzle adapter, using
 * BETTER_AUTH_URL + BETTER_AUTH_SECRET from env. Email/password is enabled
 * for pilot users; Google social is enabled only when both
 * GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are present (pilot may omit them
 * and the server still boots).
 */
export const createAuth = (
  opts?: Partial<BetterAuthOptions>,
): ReturnType<typeof betterAuth> => {
  const env = process.env as Record<string, string | undefined>;
  const secret =
    env.BETTER_AUTH_SECRET?.trim() ||
    (env.NODE_ENV === 'production'
      ? undefined
      : 'local-dev-better-auth-secret-min-32-characters-long');
  const baseURL = env.BETTER_AUTH_URL;
  const socialProviders = getSocialProviders(env as Record<string, string>);
  const db = getDb();

  const emailAndPasswordEnabled = env.PILOT_EMAIL_PASSWORD_DISABLED !== '1';

  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: schema as Record<string, unknown>,
    }),
    socialProviders,
    emailAndPassword: {
      enabled: emailAndPasswordEnabled,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    emailVerification: {
      sendOnSignUp: false,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async () => {
        // Pilot: no email transport. Verification skipped via requireEmailVerification=false.
      },
    },
    advanced: {
      ipAddress: { disableIpTracking: true },
      cookiePrefix:
        env.NODE_ENV === 'development' ? 'better-auth-dev' : 'better-auth',
    },
    session: {
      cookieCache: { enabled: true, maxAge: 60 * 60 * 24 * 30 },
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24 * 3,
    },
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: true,
        trustedProviders: ['google'],
      },
    },
    ...opts,
  });
};

export type Auth = ReturnType<typeof createAuth>;
export type SimpleAuth = Auth;
