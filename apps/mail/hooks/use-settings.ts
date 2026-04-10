import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
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
    zeroSignature: true,
    categories: [],
    defaultEmailAlias: 'demo@centurion.local',
    undoSendEnabled: false,
    imageCompression: 'medium',
    autoRead: true,
    animations: false,
  },
};

export function useSettings() {
  const { data: session } = useSession();
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();

  const demoSettingsQuery = useQuery({
    queryKey: ['demo', 'settings'],
    queryFn: async () => DEMO_SETTINGS,
    enabled: demoMode,
    staleTime: Infinity,
  });

  const settingsQuery = useQuery(
    trpc.settings.get.queryOptions(void 0, {
      enabled: !demoMode && !!session?.user.id,
      staleTime: Infinity,
    }),
  );

  return demoMode ? (demoSettingsQuery as typeof settingsQuery) : settingsQuery;
}
