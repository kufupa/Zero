import type { MailCacheScope } from '@/lib/mail/mail-cache-scope';

export function previousScopeBeforeSwitch(args: {
  current: MailCacheScope;
  nextTransportId: string;
}): MailCacheScope {
  return { ...args.current };
}
