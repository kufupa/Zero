import { env } from '../env';

/**
 * Temporary demo-mode shim for Task 1.
 * Demo mode is intentionally opt-in and only active when ZERO_DEMO_MODE === "1".
 */
const getDemoModeValue = (): string | undefined => {
  if (env.ZERO_DEMO_MODE) {
    return env.ZERO_DEMO_MODE;
  }

  if (typeof process !== 'undefined') {
    return process.env.ZERO_DEMO_MODE;
  }

  return undefined;
};

export const isDemoMode = (): boolean => getDemoModeValue() === '1';

export const getDemoUser = () => ({
  id: 'demo-user',
  email: 'centurion@legacyhotels.com',
  name: 'The Centurion',
});
