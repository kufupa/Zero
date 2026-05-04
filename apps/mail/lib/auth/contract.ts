import type { MailApiMode } from '../runtime/mail-mode';

export type LoginProviderDTO = {
  id: string;
  name: string;
  enabled: boolean;
  required?: boolean;
  envVarStatus: Array<{ name: string; set: boolean; source: string; defaultValue?: string }>;
  isCustom?: boolean;
  customRedirectPath?: string;
};

export type LoginProvidersResult = {
  providers: LoginProviderDTO[];
  isProd: boolean;
  /** Set when legacy/hosted could not load providers (no demo fallback). */
  loadError?: 'unreachable' | 'http_error' | 'hosted_unavailable';
};

export type AuthApi = {
  readonly mode: MailApiMode;
  getSession: () => Promise<{ data: unknown; error: unknown }>;
  linkSocialSafe: (payload: unknown) => Promise<unknown>;
  getLoginProviders: (input: { isProd: boolean }) => Promise<LoginProvidersResult>;
};
