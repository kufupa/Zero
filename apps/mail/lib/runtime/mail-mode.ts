export type MailApiMode = 'legacy' | 'hosted' | 'demo';

export type MailModeEnv = {
  VITE_PUBLIC_MAIL_API_MODE?: string;
  VITE_ZERO_DEMO_MODE?: string;
  VITE_FRONTEND_ONLY?: string;
};

const CANONICAL: ReadonlySet<string> = new Set(['legacy', 'hosted', 'demo']);

export function resolveMailMode(env: MailModeEnv = import.meta.env as MailModeEnv): MailApiMode {
  const raw = String(env.VITE_PUBLIC_MAIL_API_MODE ?? '')
    .trim()
    .toLowerCase();
  if (CANONICAL.has(raw)) {
    return raw as MailApiMode;
  }
  if (raw) {
    return 'legacy';
  }
  if (env.VITE_ZERO_DEMO_MODE === '1' || env.VITE_FRONTEND_ONLY === '1') {
    return 'demo';
  }
  return 'legacy';
}

export function isDemoMode(env: MailModeEnv = import.meta.env as MailModeEnv): boolean {
  return resolveMailMode(env) === 'demo';
}

export function isFrontendOnlyDemo(env: MailModeEnv = import.meta.env as MailModeEnv): boolean {
  return resolveMailMode(env) === 'demo';
}
