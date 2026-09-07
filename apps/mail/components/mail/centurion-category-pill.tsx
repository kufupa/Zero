import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import {
  getHotelFolderPresentation,
  getHotelPillColorStyle,
  isHotelManagedCategorySlug,
  isHotelPrimaryCategorySlug,
  resolveThreadCategoryPresentation,
  shouldShowHotelCategoryPill,
  type HotelManagedSlug,
} from '@/lib/mail/hotel-folder-presentation';
import type { CenturionMailCategory } from '@/types';
import type { CSSProperties } from 'react';

export function CenturionCategoryPill({
  routeFolder,
  category,
  categoryIds,
  idToSlug,
  className,
}: {
  routeFolder: string | undefined;
  /** Demo / legacy fallback when categoryIds empty */
  category?: CenturionMailCategory | undefined;
  categoryIds?: string[];
  idToSlug?: Map<string, string>;
  className?: string;
}) {
  const resolved =
    categoryIds && idToSlug
      ? resolveThreadCategoryPresentation(categoryIds, idToSlug)
      : { primarySlug: null, isUrgent: false, pillSlug: null as HotelManagedSlug | null };

  let pillSlug = resolved.pillSlug;
  let isUrgent = resolved.isUrgent;

  if (!pillSlug && category && isHotelPrimaryCategorySlug(category)) {
    pillSlug = category;
  }

  if (!shouldShowHotelCategoryPill({ routeFolder, pillSlug })) return null;
  if (!pillSlug || !isHotelManagedCategorySlug(pillSlug)) return null;

  const title = getHotelFolderPresentation(pillSlug)?.title ?? pillSlug;
  const palette = getHotelPillColorStyle(pillSlug);

  return (
    <Link
      to={`/mail/${pillSlug}`}
      onClick={(e) => e.stopPropagation()}
      style={
        {
          '--centurion-pill-bg': palette.bg,
          '--centurion-pill-text': palette.text,
          '--centurion-pill-bg-dark': palette.darkBg,
          '--centurion-pill-text-dark': palette.darkText,
        } as CSSProperties
      }
      className={cn(
        'inline-block max-w-full truncate rounded px-1.5 py-0.5 text-xs font-medium no-underline hover:opacity-90',
        'bg-[var(--centurion-pill-bg)] text-[var(--centurion-pill-text)] dark:bg-[var(--centurion-pill-bg-dark)] dark:text-[var(--centurion-pill-text-dark)]',
        isUrgent &&
          pillSlug !== 'urgent' &&
          "relative after:absolute after:inset-y-0.5 after:right-0 after:w-0.5 after:rounded-l-sm after:bg-red-500/90 after:content-['']",
        className,
      )}
      title={title}
    >
      {title}
    </Link>
  );
}
