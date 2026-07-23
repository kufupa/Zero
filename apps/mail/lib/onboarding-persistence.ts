/**
 * Persist onboarding dismiss so remounting mail layout (e.g. settings → inbox)
 * does not re-show "Welcome to Nava AI".
 */

export const ONBOARDING_DISMISSED_KEY = 'nava-onboarding-dismissed';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** @returns true when tour should open (never dismissed). */
export function shouldShowOnboarding(storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(ONBOARDING_DISMISSED_KEY) !== '1';
  } catch {
    return true;
  }
}

export function markOnboardingDismissed(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(ONBOARDING_DISMISSED_KEY, '1');
  } catch {
    return;
  }
}
