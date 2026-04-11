import { DEMO_FEATURES, type DemoFeatureKey } from './config';

/**
 * When true, app always behaves as frontend-only demo (no env required).
 * Set false before shipping production builds that need real auth/backend.
 */
export const FORCE_FRONTEND_ONLY_DEMO = true;

type DemoEnv = {
  ZERO_DEMO_MODE?: string;
  VITE_ZERO_DEMO_MODE?: string;
  VITE_FRONTEND_ONLY?: string;
  VITE_ZERO_DEMO_FRONTEND_ONLY?: string;
  ZERO_DEMO_FRONTEND_ONLY?: string;
};

export function isDemoMode(env: DemoEnv = import.meta.env as unknown as DemoEnv): boolean {
  const demoMode = env.ZERO_DEMO_MODE ?? env.VITE_ZERO_DEMO_MODE;
  return demoMode === '1';
}

export function isFrontendOnlyDemo(env: DemoEnv = import.meta.env as unknown as DemoEnv): boolean {
  if (FORCE_FRONTEND_ONLY_DEMO) return true;
  const frontendOnlyEnv =
    env.VITE_FRONTEND_ONLY ?? env.VITE_ZERO_DEMO_FRONTEND_ONLY ?? env.ZERO_DEMO_FRONTEND_ONLY;
  return isDemoMode(env) && frontendOnlyEnv === '1';
}

export function isDemoFeatureEnabled(key: DemoFeatureKey): boolean {
  return DEMO_FEATURES[key];
}
