import { DEMO_FEATURES, type DemoFeatureKey } from './config';

type DemoEnv = {
  ZERO_DEMO_MODE?: string;
  VITE_ZERO_DEMO_MODE?: string;
  VITE_FRONTEND_ONLY?: string;
};

export function isDemoMode(env: DemoEnv = import.meta.env as unknown as DemoEnv): boolean {
  const demoMode = env.ZERO_DEMO_MODE ?? env.VITE_ZERO_DEMO_MODE;
  return demoMode === '1';
}

export function isFrontendOnlyDemo(env: DemoEnv = import.meta.env as unknown as DemoEnv): boolean {
  return isDemoMode(env) && env.VITE_FRONTEND_ONLY === '1';
}

export function isDemoFeatureEnabled(key: DemoFeatureKey): boolean {
  return DEMO_FEATURES[key];
}
