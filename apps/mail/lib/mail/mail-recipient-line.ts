/**
 * Message-header To/Cc/Bcc layout.
 *
 * MailDisplay roots use overflow-x-clip. A column flex item with default
 * min-width:auto sizes to the unwrapped recipient string, so names clip
 * instead of wrapping. Bound this header to the pane; wrap each mailbox
 * as its own flex item so long To/Cc lists break at recipient boundaries.
 */

export const MAIL_RECIPIENT_HEADER_CLASS =
  'flex w-full min-w-0 max-w-full flex-col gap-2';

export const MAIL_RECIPIENT_FIELDS_CLASS =
  'flex w-full min-w-0 max-w-full flex-col gap-1';

export const MAIL_RECIPIENT_LINE_CLASS =
  'text-muted-foreground flex w-full min-w-0 max-w-full flex-wrap items-baseline gap-x-1 text-sm font-medium dark:text-[#8C8C8C]';

export const MAIL_RECIPIENT_ITEM_CLASS = 'min-w-0 max-w-full break-all';
