import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isFrontendOnlyDemo } from '@/lib/demo-frontonly';

const EMPTY_DEMO_DATA: [] = [];
const EMPTY_USER_LABELS: [] = [];
const EMPTY_SYSTEM_LABELS: [] = [];
const DEMO_LABEL_QUERY_OVERRIDES = {
  data: EMPTY_DEMO_DATA,
  userLabels: EMPTY_USER_LABELS,
  systemLabels: EMPTY_SYSTEM_LABELS,
  isLoading: false,
  isFetching: false,
};

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
  const trpc = useTRPC();
  const isDemoOnly = isFrontendOnlyDemo();
  const labelQuery = useQuery(
    trpc.labels.list.queryOptions(void 0, {
      staleTime: 1000 * 60 * 60, // 1 hour
      enabled: !isDemoOnly,
    }),
  );

  if (isDemoOnly) {
    return {
      ...labelQuery,
      ...DEMO_LABEL_QUERY_OVERRIDES,
    };
  }

  const { userLabels, systemLabels } = useMemo(() => {
    if (!labelQuery.data) return { userLabels: [], systemLabels: [] };
    const cleanedName = labelQuery.data
      .filter((label) => label.type === 'system')
      .map((label) => {
        return {
          ...label,
          name: label.name.replace('CATEGORY_', ''),
        };
      });
    const cleanedSystemLabels = cleanedName.filter((label) => desiredSystemLabels.has(label.name));
    return {
      userLabels: labelQuery.data.filter((label) => label.type === 'user'),
      systemLabels: cleanedSystemLabels,
    };
  }, [labelQuery.data]);

  return { userLabels, systemLabels, ...labelQuery };
}

export function useThreadLabels(ids: string[]) {
  const { userLabels: labels = [] } = useLabels();

  const threadLabels = useMemo(() => {
    if (!labels) return [];
    return labels.filter((label) => (label.id ? ids.includes(label.id) : false));
  }, [labels, ids]);

  return { labels: threadLabels };
}
