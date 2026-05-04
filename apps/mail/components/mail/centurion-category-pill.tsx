import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { isFrontendOnlyDemo } from '@/lib/runtime/mail-mode';
import {
  getCenturionCategoryColorStyle,
  getCenturionCategoryTitle,
  shouldShowCenturionCategoryPill,
} from '@/lib/demo/folder-map';
import type { CenturionMailCategory } from '@/types';
import type { CSSProperties } from 'react';

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
  const palette = getCenturionCategoryColorStyle(slug);

  return (
    <Link
      to={`/mail/${slug}`}
      onClick={(e) => e.stopPropagation()}
      style={
        palette
          ? ({
              '--centurion-pill-bg': palette.bg,
              '--centurion-pill-text': palette.text,
              '--centurion-pill-bg-dark': palette.darkBg,
              '--centurion-pill-text-dark': palette.darkText,
            } as CSSProperties)
          : undefined
      }
      className={cn(
        'inline-block max-w-[14ch] truncate rounded px-1.5 py-0.5 text-xs font-medium no-underline hover:opacity-90',
        palette
          ? 'bg-[var(--centurion-pill-bg)] text-[var(--centurion-pill-text)] dark:bg-[var(--centurion-pill-bg-dark)] dark:text-[var(--centurion-pill-text-dark)]'
          : 'bg-[#E8DEFD] text-[#2C2241] dark:bg-[#2C2241] dark:text-[#E8DEFD]',
        className,
      )}
    >
      {title}
    </Link>
  );
}
