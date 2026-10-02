import type { AuthSessionProfile } from './auth-profile.js';

export interface EnvVarInfo {
  name: string;
  source: string;
  defaultValue?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  requiredEnvVars: string[];
  envVarInfo?: EnvVarInfo[];
  config: unknown;
  required?: boolean;
  isCustom?: boolean;
  customRedirectPath?: string;
}

export interface PublicAuthProvider {
  id: string;
  name: string;
  enabled: boolean;
  required?: boolean;
  isCustom?: boolean;
  customRedirectPath?: string;
  envVarInfo?: EnvVarInfo[];
  envVarStatus: Array<EnvVarInfo & { set: boolean }>;
}

type AuthEnv = Record<string, string | undefined>;

/** Pilot email/password entry — Google OAuth optional on EC2. */
export const customProviders: ProviderConfig[] = [
  {
    id: 'zero',
    name: 'Email / Password',
    requiredEnvVars: [],
    config: {},
    isCustom: true,
    customRedirectPath: '/zero/login',
  },
];

export const authProviders = (env: AuthEnv): ProviderConfig[] => [
  {
    id: 'google',
    name: 'Google',
    requiredEnvVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    envVarInfo: [
      { name: 'GOOGLE_CLIENT_ID', source: 'Google Cloud Console' },
      { name: 'GOOGLE_CLIENT_SECRET', source: 'Google Cloud Console' },
    ],
    config: {
      prompt: env.FORCE_GOOGLE_AUTH ? 'consent' : undefined,
      // Better Auth's /sign-up hook does not run for OAuth callbacks. An
      // allowlist cannot vet that callback, so only explicit open signup may
      // create Google accounts; linked users can still sign in.
      disableSignUp: env.PILOT_OPEN_SIGNUP !== '1',
      accessType: 'offline',
      scope: [
        'https://mail.google.com/',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    // Pilot: do not block /login when Google creds absent (email/password is the path).
    required: false,
  },
];

export function isProviderEnabled(
  provider: ProviderConfig,
  env: AuthEnv,
): boolean {
  if (provider.isCustom) return true;
  const hasEnvVars = provider.requiredEnvVars.every((envVar) => !!env[envVar]);
  if (provider.required && !hasEnvVars) {
    console.error(`Required provider "${provider.id}" is not configured properly.`);
    console.error(
      `Missing environment variables: ${provider.requiredEnvVars
        .filter((envVar) => !env[envVar])
        .join(', ')}`,
    );
  }
  return hasEnvVars;
}

export function getSocialProviders(
  env: AuthEnv,
  profile: AuthSessionProfile = 'legacy',
): Record<string, unknown> {
  if (profile === 'remote') return {};

  const socialProviders = Object.fromEntries(
    authProviders(env)
      .map((provider) => {
        if (isProviderEnabled(provider, env)) {
          return [provider.id, provider.config] as [string, unknown];
        } else if (provider.required) {
          // Pilot: do not throw on missing provider config; return null so server can boot
          // without Google credentials. Task 5 will re-enable strict behavior when auth is wired.
          console.warn(
            `Required provider "${provider.id}" not configured; pilot mode skips it.`,
          );
          return null;
        } else {
          console.warn(`Provider "${provider.id}" is not configured properly. Skipping.`);
          return null;
        }
      })
      .filter((provider) => provider !== null),
  );
  return socialProviders;
}

export function getPublicAuthProviders(
  env: AuthEnv,
  profile: AuthSessionProfile,
): PublicAuthProvider[] {
  const customProviderStatus: PublicAuthProvider[] = customProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    enabled: true,
    isCustom: provider.isCustom,
    customRedirectPath: provider.customRedirectPath,
    envVarStatus: [],
  }));

  if (profile === 'remote') return customProviderStatus;

  const authProviderStatus: PublicAuthProvider[] = authProviders(env).map((provider) => {
    const envVarStatus = (provider.envVarInfo ?? []).map((envVar) => ({
      ...envVar,
      set: Boolean(env[envVar.name]),
    }));
    return {
      id: provider.id,
      name: provider.name,
      enabled: isProviderEnabled(provider, env),
      required: provider.required,
      envVarInfo: provider.envVarInfo,
      envVarStatus,
    };
  });

  return [...customProviderStatus, ...authProviderStatus];
}
