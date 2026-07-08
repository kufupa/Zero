import { useSettings } from '@/hooks/use-settings';
import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useMemo } from 'react';

export interface CategorySetting {
  id: string;
  name: string;
  searchValue: string;
  order: number;
  icon?: string;
  isDefault: boolean;
  slug?: string;
  color?: string | null;
}

const DEFAULT_DEMO_CATEGORIES: CategorySetting[] = [
  {
    id: 'All Mail',
    name: 'All Mail',
    searchValue: '',
    order: 0,
    isDefault: true,
  },
  {
    id: 'Unread',
    name: 'Unread',
    searchValue: 'UNREAD',
    order: 1,
    isDefault: false,
  },
];

export function useCategorySettings(): CategorySetting[] {
  const { categories } = useCategorySettingsQueryState();
  return categories;
}

export function useCategorySettingsQueryState() {
  const { data } = useSettings();
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();
  const liveCategoriesQuery = useQuery(
    trpc.categories.list.queryOptions(undefined, {
      enabled: !demoMode,
      staleTime: 60_000,
    }),
  );

  const categories = useMemo(() => {
    if (demoMode) {
      const overrides = (data?.settings.categories as CategorySetting[] | undefined) ?? [];
      const sorted = [...overrides].sort((a, b) => a.order - b.order);
      return sorted.length === 0 ? DEFAULT_DEMO_CATEGORIES : sorted;
    }

    const liveCategories =
      liveCategoriesQuery.data?.map((category, index) => ({
        id: category.id,
        name: category.name,
        searchValue: category.id,
        slug: category.slug,
        color: category.color,
        order: category.sortOrder ?? index,
        isDefault: index === 0,
      })) ?? [];

    if (liveCategories.length > 0) {
      return liveCategories;
    }

    const overrides = (data?.settings.categories as CategorySetting[] | undefined) ?? [];
    const sorted = [...overrides].sort((a, b) => a.order - b.order);
    return sorted.length === 0 ? DEFAULT_DEMO_CATEGORIES : sorted;
  }, [data?.settings.categories, demoMode, liveCategoriesQuery.data]);

  return {
    categories,
    isLoadingLiveCategories: !demoMode && liveCategoriesQuery.isLoading,
    hasSettledLiveCategories:
      demoMode || liveCategoriesQuery.isFetched || liveCategoriesQuery.isError,
  };
}

export function useDefaultCategoryId(): string {
  const categories = useCategorySettings();
  const defaultCat = categories.find((c) => c.isDefault) ?? categories[0];
  return defaultCat?.id ?? 'All Mail';
}
