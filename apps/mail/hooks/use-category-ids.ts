import { useCallback, useMemo } from 'react';
import { useQueryState } from 'nuqs';
import { parseCategoryIdsParam, toggleCategoryChip } from '@/lib/mail/route-filter';

/** URL `categoryIds` (comma-separated category ids) — not `labels` / labelIds. */
const useCategoryIds = () => {
  const [data, setData] = useQueryState('categoryIds');

  const categoryIds = useMemo(() => parseCategoryIdsParam(data), [data]);

  const setCategoryIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) {
        setData(null);
        return;
      }
      setData(ids.join(','));
    },
    [setData],
  );

  const toggleCategoryId = useCallback(
    (categoryId: string) => {
      setCategoryIds(toggleCategoryChip(categoryIds, categoryId));
    },
    [categoryIds, setCategoryIds],
  );

  return { categoryIds, setCategoryIds, toggleCategoryId };
};

export default useCategoryIds;
