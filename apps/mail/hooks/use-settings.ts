import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSession } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { getFrontendApi } from '@/lib/api/client';
import { resolveMailMode } from '@/lib/runtime/mail-mode';
import { settingsGetQueryOptions, type ApiQueryContext } from '@/lib/api/query-options';
import type { MailSettings } from '@/lib/domain/settings';

const DEMO_SETTINGS: any = {
  settings: {
    language: 'en',
    timezone: 'UTC',
    dynamicContent: false,
    colorTheme: 'system',
    externalImages: true,
    trustedSenders: [] as string[],
    customPrompt: '',
    zeroSignature: false,
    categories: [],
    defaultEmailAlias: 'centurion@legacyhotels.co.za',
    undoSendEnabled: true,
    imageCompression: 'medium',
    autoRead: true,
    animations: false,
  },
};

export function useSettings() {
  const { data: session } = useSession();
  const demoMode = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );
  const liveSettingsEnabled =
    !demoMode && queryCtx.mode === 'legacy' && Boolean(session?.user?.id);
  const currentUserEmail = session?.user?.email?.trim().toLowerCase() || '';
  const demoUserEmail = currentUserEmail || 'centurion@legacyhotels.co.za';

  const demoSettingsQuery = useQuery({
    queryKey: ['demo', 'settings', demoUserEmail],
    queryFn: async () => ({
      ...DEMO_SETTINGS,
      settings: {
        ...DEMO_SETTINGS.settings,
        defaultEmailAlias: demoUserEmail,
        zeroSignature: false,
        undoSendEnabled: true,
      },
    }),
    enabled: demoMode,
    staleTime: Infinity,
  });

  const settingsQuery = useQuery({
    ...settingsGetQueryOptions(getFrontendApi(), queryCtx),
    enabled: liveSettingsEnabled,
    staleTime: Infinity,
  });

  const normalizedSettings = useMemo(() => {
    const raw = settingsQuery.data as MailSettings | { settings?: MailSettings } | undefined;
    if (!raw) return raw;

    const base: MailSettings =
      typeof raw === 'object' && raw && 'settings' in raw && raw.settings
        ? (raw as { settings: MailSettings }).settings
        : (raw as MailSettings);

    return {
      settings: {
        ...base,
        defaultEmailAlias: currentUserEmail || base.defaultEmailAlias || '',
        zeroSignature: false,
        undoSendEnabled: true,
      },
    };
  }, [settingsQuery.data, currentUserEmail]);

  return demoMode
    ? (demoSettingsQuery as typeof settingsQuery)
    : { ...settingsQuery, data: normalizedSettings };
}
