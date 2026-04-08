import { isDemoMode } from './demo-session';

export function isFrontendOnlyDemo(
  env: { ZERO_DEMO_MODE?: string; VITE_FRONTEND_ONLY?: string } = import.meta.env,
) {
  return (env.ZERO_DEMO_MODE ?? (isDemoMode() ? '1' : '0')) === '1' && env.VITE_FRONTEND_ONLY === '1';
}
