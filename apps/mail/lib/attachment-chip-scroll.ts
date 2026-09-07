/**
 * Outlook-like attachment chip H-scroll class contract.
 *
 * Do NOT put `flex-nowrap` and `overflow-x-auto` on the same node —
 * flex `min-width: auto` prevents the scrollport from shrinking.
 * Outer scrollport scrolls; inner track is `w-max`.
 */

export const ATTACHMENT_CHIP_SCROLLPORT_CLASS =
  'w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain';

export const ATTACHMENT_CHIP_TRACK_CLASS = 'flex w-max flex-nowrap items-center gap-2';

/** MailDisplay root: clip x without overflow-hidden eating chip scrollbar. */
export const MAIL_DISPLAY_ROOT_CLASS = 'relative min-w-0 flex-1 overflow-x-clip';

/** Vertical message body scroller under MailDisplay root. */
export const MAIL_DISPLAY_BODY_SHELL_CLASS =
  'relative h-full min-w-0 overflow-y-auto overflow-x-clip';

/** Advertise shrink so nested chip scrollports work inside flex ScrollArea. */
export const SCROLL_AREA_FLEX_MIN_W_CLASS = 'min-w-0';

/**
 * Radix ScrollArea Viewport injects a child with `display: table; min-width: 100%`.
 * That table sizes to content min-width and inflates the whole thread pane
 * (wide HTML mail / banner images). Force block + shrink on that child.
 */
export const SCROLL_AREA_VIEWPORT_CONTENT_CLASS =
  '[&>div]:!block [&>div]:min-w-0 [&>div]:max-w-full [&>div]:w-full';
