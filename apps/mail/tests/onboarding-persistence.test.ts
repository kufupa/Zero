import { beforeEach, describe, expect, it } from 'vitest';
import {
  ONBOARDING_DISMISSED_KEY,
  markOnboardingDismissed,
  shouldShowOnboarding,
} from '@/lib/onboarding-persistence';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe('onboarding persistence', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it('shows onboarding when never dismissed (fresh login path)', () => {
    expect(shouldShowOnboarding(storage)).toBe(true);
  });

  it('hides onboarding after dismiss so remount (settings→mail) does not re-show', () => {
    markOnboardingDismissed(storage);

    // Simulates OnboardingWrapper remount when leaving /settings back to /mail
    expect(shouldShowOnboarding(storage)).toBe(false);
    expect(storage.getItem(ONBOARDING_DISMISSED_KEY)).toBe('1');
  });
});
