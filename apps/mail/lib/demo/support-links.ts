import { isFrontendOnlyDemo } from './runtime';

type SupportLinksEnv = {
  ZERO_DEMO_MODE?: string;
  VITE_ZERO_DEMO_MODE?: string;
  VITE_FRONTEND_ONLY?: string;
};

export function shouldShowSupportLinks(
  env: SupportLinksEnv = import.meta.env as unknown as SupportLinksEnv,
): boolean {
  if (isFrontendOnlyDemo(env)) return false;
  // Pilot honesty: no wired support provider → hide
  return false;
}
