import { useSettings } from '@/hooks/use-settings';
import { isFrontendOnlyDemo } from '@/lib/demo-frontonly';
import { useMemo } from 'react';

export interface CategorySetting {
  id: string;
  name: string;
  searchValue: string;
  order: number;
  icon?: string;
  isDefault: boolean;
}

/** Mirrors server DB defaults (see settings migrations) so inbox views match production when settings are unavailable. */
export const DEMO_MAIL_CATEGORY_DEFAULTS: CategorySetting[] = [
  {
    id: 'Important',
    name: 'Important',
    searchValue: 'is:important NOT is:sent NOT is:draft',
    order: 0,
    icon: 'Lightning',
    isDefault: false,
  },
  {
    id: 'All Mail',
    name: 'All Mail',
    searchValue: 'NOT is:draft (is:inbox OR (is:sent AND to:me))',
    order: 1,
    icon: 'Mail',
    isDefault: true,
  },
  {
    id: 'Personal',
    name: 'Personal',
    searchValue: 'is:personal NOT is:sent NOT is:draft',
    order: 2,
    icon: 'User',
    isDefault: false,
  },
  {
    id: 'Promotions',
    name: 'Promotions',
    searchValue: 'is:promotions NOT is:sent NOT is:draft',
    order: 3,
    icon: 'Tag',
    isDefault: false,
  },
  {
    id: 'Updates',
    name: 'Updates',
    searchValue: 'is:updates NOT is:sent NOT is:draft',
    order: 4,
    icon: 'Bell',
    isDefault: false,
  },
  {
    id: 'Unread',
    name: 'Unread',
    searchValue: 'is:unread NOT is:sent NOT is:draft',
    order: 5,
    icon: 'ScanEye',
    isDefault: false,
  },
];

export function useCategorySettings(): CategorySetting[] {
  const { data } = useSettings();
  const demoOnly = isFrontendOnlyDemo();

  const merged = useMemo(() => {
    if (demoOnly) {
      return [...DEMO_MAIL_CATEGORY_DEFAULTS].sort((a, b) => a.order - b.order);
    }

    const overrides = (data?.settings.categories as CategorySetting[] | undefined) ?? [];

    const sorted = overrides.sort((a, b) => a.order - b.order);

    // If no categories are defined, provide default ones
    if (sorted.length === 0) {
      return [
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
    }

    return sorted;
  }, [data?.settings.categories, demoOnly]);

  return merged;
}

export function useDefaultCategoryId(): string {
  const categories = useCategorySettings();
  const defaultCat = categories.find((c) => c.isDefault) ?? categories[0];
  return defaultCat?.id ?? 'All Mail';
}
