import { useSettings } from './use-settings';
import { resolveEffectiveTimezone } from '@/lib/utils';
import { useMemo } from 'react';

export function useTimezone(): string {
  const { data: userSettings } = useSettings();
  const configuredTz = userSettings?.settings?.timezone;

  return useMemo(() => {
    return resolveEffectiveTimezone(configuredTz, { fallbackIfUtc: true });
  }, [configuredTz]);
}
