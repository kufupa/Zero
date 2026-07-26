import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { listDemoLabels } from '@/lib/demo/local-store';

const desiredSystemLabels = new Set([
  'IMPORTANT',
  'FORUMS',
  'PROMOTIONS',
  'SOCIAL',
  'UPDATES',
  'STARRED',
  'UNREAD',
]);

export function isVisibleUserLabel(label: { name: string }): boolean {
  return label.name.toUpperCase() !== 'SPAM';
}

export function resolveThreadLabels<T extends { id?: string; name: string }>(
  labels: T[],
  ids: string[],
): T[] {
  return labels.filter(
    (label) =>
      isVisibleUserLabel(label) && (label.id ? ids.includes(label.id) : false),
  );
}

export function useLabels() {
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();
  const demoLabelQuery = useQuery({
    queryKey: ['demo', 'labels'],
    queryFn: async () => listDemoLabels(),
    enabled: demoMode,
    staleTime: Infinity,
  });
  const labelQuery = useQuery(
    trpc.labels.list.queryOptions(void 0, {
      enabled: !demoMode,
      staleTime: 1000 * 60 * 60, // 1 hour
    }),
  );

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
      userLabels: activeQuery.data.filter(
        (label) => label.type === 'user' && isVisibleUserLabel(label),
      ),
      systemLabels: cleanedSystemLabels,
    };
  }, [activeQuery.data]);

  return { userLabels, systemLabels, ...activeQuery };
}

export function useThreadLabels(ids: string[]) {
  const { userLabels: labels = [] } = useLabels();

  const threadLabels = useMemo(() => {
    if (!labels) return [];
    return resolveThreadLabels(labels, ids);
  }, [labels, ids]);

  return { labels: threadLabels };
}
