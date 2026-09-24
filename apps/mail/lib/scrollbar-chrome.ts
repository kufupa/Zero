/**
 * Visible scrollbar chrome for mail shell panes.
 * Use fixed px (not rem) so `html { font-size: 80% }` does not shrink the grab target.
 * Target ~Outlook classic list bar (~12–16px).
 *
 * Width class strings must be full static literals so Tailwind can emit them.
 */
export const SCROLLBAR_GRAB_WIDTH_PX = 14 as const;

/** Native overflow + tailwind-scrollbar width utility. */
export const NATIVE_SCROLLBAR_WIDTH_CLASS = 'scrollbar-w-[14px]';

/** Shared visible native scrollbar class set (list + sidebar). */
export const NATIVE_VISIBLE_SCROLLBAR_CLASSES = [
  'scrollbar',
  NATIVE_SCROLLBAR_WIDTH_CLASS,
  'scrollbar-thumb-accent/40',
  'scrollbar-track-transparent',
  'hover:scrollbar-thumb-accent',
  'scrollbar-thumb-rounded-full',
].join(' ');

/** Radix ScrollBar vertical track width. */
export const RADIX_SCROLLBAR_VERTICAL_SIZE_CLASS = 'w-[14px]';

/** Radix ScrollBar horizontal track height. */
export const RADIX_SCROLLBAR_HORIZONTAL_SIZE_CLASS = 'h-[14px]';
