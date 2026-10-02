import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getSocialProviders } from './auth-providers.js';
import {
  resolveAuthProfilePolicy,
  resolveAuthSessionProfile,
  SESSION_COOKIE_CACHE_MAX_AGE_SEC,
  SESSION_TTL_SEC,
  SESSION_UPDATE_AGE_SEC,
} from './auth-profile.js';
import { getDb } from '../db/client.js';
import * as schema from '../db/schema/index.js';

export {
  resolveAuthProfilePolicy,
  resolveAuthSessionProfile,
  SESSION_COOKIE_CACHE_MAX_AGE_SEC,
  SESSION_TTL_SEC,
  SESSION_UPDATE_AGE_SEC,
} from './auth-profile.js';

export type PilotSignupEnv = {
  PILOT_OPEN_SIGNUP?: string;
  PILOT_SIGNUP_ALLOWLIST?: string;
};

/** Comma-separated allowlist entries, normalized to lowercase. */
export function parsePilotSignupAllowlist(
  allowlist: string | undefined,
): string[] {
  if (!allowlist?.trim()) return [];
  return allowlist
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isPilotSignupEmailAllowed(
  email: string | undefined,
  env: PilotSignupEnv,
): boolean {
  if (env.PILOT_OPEN_SIGNUP === '0') return false;
  if (env.PILOT_OPEN_SIGNUP === '1') return true;
  if (!email) return false;
  const allow = parsePilotSignupAllowlist(env.PILOT_SIGNUP_ALLOWLIST);
  return allow.includes(email.trim().toLowerCase());
}

export function assertPilotSignupAllowed(
  email: string | undefined,
  env: PilotSignupEnv,
): void {
  if (isPilotSignupEmailAllowed(email, env)) return;
  throw new APIError('FORBIDDEN', { message: 'signup disabled for pilot' });
}

/** Pure helper for Better Auth trustedOrigins (unit-testable without DB). */
export function resolvePilotTrustedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return resolveAuthProfilePolicy(env).trustedOrigins;
}

/**
 * Pilot Better Auth instance.
 *
 * Wired against the RDS Postgres schema via the drizzle adapter, using
 * BETTER_AUTH_URL + BETTER_AUTH_SECRET from env. Email/password is enabled
 * for pilot users; Google social is enabled only for legacy processes when both
 * GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are present (pilot may omit them
 * and the server still boots).
 */
export const createAuth = (): ReturnType<typeof betterAuth> => {
  const env = process.env as Record<string, string | undefined>;
  const secret =
    env.BETTER_AUTH_SECRET?.trim() ||
    (env.NODE_ENV === 'production'
      ? undefined
      : 'local-dev-better-auth-secret-min-32-characters-long');
  const profile = resolveAuthSessionProfile(env);
  const policy = resolveAuthProfilePolicy(env);
  const socialProviders = getSocialProviders(env, profile);
  const db = getDb();

  const emailAndPasswordEnabled = env.PILOT_EMAIL_PASSWORD_DISABLED !== '1';

  const options: BetterAuthOptions = {
    secret,
    baseURL: policy.baseURL,
    trustedOrigins: policy.trustedOrigins,
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
      cookiePrefix: policy.cookiePrefix,
    },
    session: {
      modelName: policy.sessionModelName,
      cookieCache: policy.cookieCache,
      expiresIn: policy.expiresIn,
      updateAge: policy.updateAge,
      disableSessionRefresh: policy.disableSessionRefresh,
    },
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: false,
        trustedProviders: profile === 'remote' ? [] : ['google'],
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.path.startsWith('/sign-up')) return;
        const email =
          typeof ctx.body?.email === 'string' ? ctx.body.email : undefined;
        assertPilotSignupAllowed(email, env);
      }),
    },
  };

  return betterAuth(options);
};

export type Auth = ReturnType<typeof createAuth>;
export type SimpleAuth = Auth;
