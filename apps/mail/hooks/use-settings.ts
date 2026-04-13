import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSession } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

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
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();
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

  const settingsQuery = useQuery(
    trpc.settings.get.queryOptions(void 0, {
      enabled: !demoMode && !!session?.user.id,
      staleTime: Infinity,
    }),
  );

  const normalizedSettings = useMemo(() => {
    if (!settingsQuery.data?.settings) return settingsQuery.data;

    return {
      ...settingsQuery.data,
      settings: {
        ...settingsQuery.data.settings,
        defaultEmailAlias: currentUserEmail || settingsQuery.data.settings.defaultEmailAlias || '',
        zeroSignature: false,
        undoSendEnabled: true,
      },
    };
  }, [settingsQuery.data, currentUserEmail]);

  return demoMode
    ? (demoSettingsQuery as typeof settingsQuery)
    : { ...settingsQuery, data: normalizedSettings };
}
