export type AuthSessionProfile = 'legacy' | 'remote';

export type AuthProfilePolicy = {
  baseURL: string | undefined;
  trustedOrigins: string[];
  cookiePrefix: string;
  cookieDomain?: undefined;
  sessionModelName: 'session' | 'remoteSession';
  expiresIn: number;
  updateAge: number;
  disableSessionRefresh: boolean;
  cookieCache: { enabled: boolean; maxAge?: number };
};

const LEGACY_SESSION_TTL_SEC = 86_400;
const LEGACY_SESSION_UPDATE_AGE_SEC = 0;
const REMOTE_SESSION_TTL_SEC = 43_200;

export function resolveAuthSessionProfile(
  env: Record<string, string | undefined> = process.env,
): AuthSessionProfile {
  const value = env.NAVA_AUTH_SESSION_PROFILE?.trim();
  if (!value || value === 'legacy') return 'legacy';
  if (value === 'remote') return 'remote';
  throw new Error(`Invalid NAVA_AUTH_SESSION_PROFILE: ${value}`);
}

export function resolveAuthProfilePolicy(
  env: Record<string, string | undefined> = process.env,
): AuthProfilePolicy {
  const profile = resolveAuthSessionProfile(env);
  const baseURL = env.BETTER_AUTH_URL?.trim() || undefined;
  const trustedOrigins = baseURL ? [new URL(baseURL).origin] : [];

  if (profile === 'remote') {
    return {
      baseURL,
      trustedOrigins,
      cookiePrefix: 'better-auth-remote',
      sessionModelName: 'remoteSession',
      expiresIn: REMOTE_SESSION_TTL_SEC,
      updateAge: 0,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    };
  }

  return {
    baseURL,
    trustedOrigins,
    cookiePrefix: env.NODE_ENV === 'development' ? 'better-auth-dev' : 'better-auth',
    sessionModelName: 'session',
    expiresIn: LEGACY_SESSION_TTL_SEC,
    updateAge: LEGACY_SESSION_UPDATE_AGE_SEC,
    disableSessionRefresh: true,
    cookieCache: { enabled: false },
  };
}

export function resolveDatabasePoolMax(profile: AuthSessionProfile): 3 | 10 {
  return profile === 'remote' ? 3 : 10;
}

export const SESSION_TTL_SEC = LEGACY_SESSION_TTL_SEC;
export const SESSION_COOKIE_CACHE_MAX_AGE_SEC = 0;
export const SESSION_UPDATE_AGE_SEC = LEGACY_SESSION_UPDATE_AGE_SEC;
