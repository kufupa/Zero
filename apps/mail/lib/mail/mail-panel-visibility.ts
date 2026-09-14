export function shouldShowDesktopThreadPanel(args: {
  isDesktop: boolean;
  isWideSplit: boolean;
  threadId: string | null;
}): boolean {
  if (!args.isDesktop) return false;
  if (args.isWideSplit) return true;
  return Boolean(args.threadId);
}

export function shouldShowDesktopListPanel(args: {
  isDesktop: boolean;
  isWideSplit: boolean;
  threadId: string | null;
}): boolean {
  if (!args.isDesktop) return false;
  if (args.isWideSplit) return true;
  return !args.threadId;
}

export function shouldShowMailSplitHandle(args: {
  isWideSplit: boolean;
  listCollapsed: boolean;
  threadMounted: boolean;
  listMounted: boolean;
}): boolean {
  if (!args.isWideSplit) return false;
  if (args.listCollapsed) return false;
  return args.threadMounted && args.listMounted;
}

export type MailActiveScope = 'mail-list' | 'thread-display';

export function resolveActiveMailScope(args: {
  hasBulkSelection: boolean;
  threadId: string | null;
  isWideSplit: boolean;
  listCollapsed: boolean;
}): MailActiveScope {
  if (args.hasBulkSelection) {
    return 'mail-list';
  }
  const listHidden = Boolean(args.threadId) || (args.isWideSplit && args.listCollapsed);
  return listHidden ? 'thread-display' : 'mail-list';
}

