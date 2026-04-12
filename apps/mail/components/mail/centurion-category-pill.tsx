import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import {
  getCenturionCategoryTitle,
  shouldShowCenturionCategoryPill,
} from '@/lib/demo/folder-map';
import type { CenturionMailCategory } from '@/types';

export function CenturionCategoryPill({
  routeFolder,
  category,
  className,
}: {
  routeFolder: string | undefined;
  category: CenturionMailCategory | undefined;
  className?: string;
}) {
  if (!isFrontendOnlyDemo()) return null;
  if (!shouldShowCenturionCategoryPill({ routeFolder, category })) return null;

  const slug = category!;
  const title = getCenturionCategoryTitle(slug);

  return (
    <Link
      to={`/mail/${slug}`}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-block max-w-[14ch] truncate rounded bg-[#E8DEFD] px-1.5 py-0.5 text-xs font-medium text-[#2C2241] no-underline hover:opacity-90 dark:bg-[#2C2241] dark:text-[#E8DEFD]',
        className,
      )}
    >
      {title}
    </Link>
  );
}
