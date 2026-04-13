import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import {
  getCenturionCategoryTitle,
  shouldShowCenturionCategoryPill,
} from '@/lib/demo/folder-map';
import type { CenturionMailCategory } from '@/types';
import type { CSSProperties } from 'react';

const CENTURION_CATEGORY_PILL_STYLES: Record<
  CenturionMailCategory,
  {
    bg: string;
    text: string;
    darkBg: string;
    darkText: string;
  }
> = {
  /**
   * Internal mail: blue conveys clarity, professionalism, and reliability.
   */
  internal: {
    bg: '#DBEAFE',
    text: '#1E3A8A',
    darkBg: '#1E3A8A',
    darkText: '#DBEAFE',
  },
  /**
   * Individual room bookings: green suggests trust, calm handling, and action-ready support.
   */
  individual: {
    bg: '#DCFCE7',
    text: '#166534',
    darkBg: '#14532D',
    darkText: '#DCFCE7',
  },
  /**
   * Group bookings: orange suggests activity, coordination, and urgency for events.
   */
  group: {
    bg: '#FFEDD5',
    text: '#9A3412',
    darkBg: '#7C2D12',
    darkText: '#FED7AA',
  },
  /**
   * Travel agents: purple implies partnership, exploration, and strategic coordination.
   */
  'travel-agents': {
    bg: '#EDE9FE',
    text: '#4C1D95',
    darkBg: '#5B21B6',
    darkText: '#EDE9FE',
  },
};

const getPillStyle = (category: CenturionMailCategory) => CENTURION_CATEGORY_PILL_STYLES[category];

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
  const palette = getPillStyle(slug);

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
