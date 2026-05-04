import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { listDemoLabels } from '@/lib/demo/local-store';
import { getFrontendApi } from '@/lib/api/client';
import { resolveMailMode } from '@/lib/runtime/mail-mode';
import { labelsListQueryOptions, type ApiQueryContext } from '@/lib/api/query-options';

const desiredSystemLabels = new Set([
  'IMPORTANT',
  'FORUMS',
  'PROMOTIONS',
  'SOCIAL',
  'UPDATES',
  'STARRED',
  'UNREAD',
]);

export function useLabels() {
  const demoMode = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );
  const liveLabelsEnabled = !demoMode && queryCtx.mode === 'legacy';
  const demoLabelQuery = useQuery({
    queryKey: ['demo', 'labels'],
    queryFn: async () => listDemoLabels(),
    enabled: demoMode,
    staleTime: Infinity,
  });
  const labelQuery = useQuery({
    ...labelsListQueryOptions(getFrontendApi(), queryCtx),
    enabled: liveLabelsEnabled,
    staleTime: 1000 * 60 * 60, // 1 hour
  });

  const activeQuery = demoMode ? demoLabelQuery : labelQuery;

  const { userLabels, systemLabels } = useMemo(() => {
    if (!activeQuery.data) return { userLabels: [], systemLabels: [] };
    const cleanedName = activeQuery.data
      .filter((label) => label.type === 'system')
      .map((label) => {
        return {
          ...label,
          name: label.name.replace('CATEGORY_', ''),
        };
      });
    const cleanedSystemLabels = cleanedName.filter((label) => desiredSystemLabels.has(label.name));
    return {
      userLabels: activeQuery.data.filter((label) => label.type === 'user'),
      systemLabels: cleanedSystemLabels,
    };
  }, [activeQuery.data]);

  return { userLabels, systemLabels, ...activeQuery };
}

export function useThreadLabels(ids: string[]) {
  const { userLabels: labels = [] } = useLabels();

  const threadLabels = useMemo(() => {
    if (!labels) return [];
    return labels.filter((label) => (label.id ? ids.includes(label.id) : false));
  }, [labels, ids]);

  return { labels: threadLabels };
}
