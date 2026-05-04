import { DEMO_FEATURES, type DemoFeatureKey } from './config';
import {
  isDemoMode as isDemoModeFromMode,
  isFrontendOnlyDemo as isFrontendOnlyDemoFromMode,
  resolveMailMode,
  type MailApiMode,
  type MailModeEnv,
} from '../runtime/mail-mode';

/**
 * Legacy export. Demo vs full-stack is controlled by `VITE_PUBLIC_MAIL_API_MODE` and dev scripts.
 * Keep false so production builds never hard-force demo.
 */
export const FORCE_FRONTEND_ONLY_DEMO = false;

export type { MailApiMode, MailModeEnv };
export { resolveMailMode };

type DemoEnv = MailModeEnv;

export function isDemoMode(env: DemoEnv = import.meta.env as unknown as DemoEnv): boolean {
  return isDemoModeFromMode(env);
}

export function isFrontendOnlyDemo(env: DemoEnv = import.meta.env as unknown as DemoEnv): boolean {
  return isFrontendOnlyDemoFromMode(env);
}

export function isDemoFeatureEnabled(key: DemoFeatureKey): boolean {
  return DEMO_FEATURES[key];
}
