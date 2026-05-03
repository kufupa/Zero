import { isFrontendOnlyDemo } from './runtime';

type SupportLinksEnv = {
  VITE_PUBLIC_MAIL_API_MODE?: string;
  VITE_ZERO_DEMO_MODE?: string;
  VITE_FRONTEND_ONLY?: string;
};

export function shouldShowSupportLinks(
  env: SupportLinksEnv = import.meta.env as unknown as SupportLinksEnv,
): boolean {
  return !isFrontendOnlyDemo(env);
}
