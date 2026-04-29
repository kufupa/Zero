import {
  differenceInCalendarDays,
  isValid,
  parseISO,
  startOfDay,
  startOfMonth,
  subMonths,
} from 'date-fns';
import type { ParsedMessage } from '@/types';

export type MailDateBucket =
  | 'pinned'
  | 'today'
  | 'yesterday'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'older';

/** Render order; `pinned` only shown when it has threads. */
export const MAIL_DATE_BUCKET_ORDER: MailDateBucket[] = [
  'pinned',
  'today',
  'yesterday',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'older',
];

/**
 * Rolling windows (not strict ISO calendar week): today → yesterday → prior 5 days
 * as "last week", then current month, previous month, older.
 */
export function getDateBucket(receivedOnIso: string | undefined | null, now: Date): MailDateBucket {
  if (!receivedOnIso) return 'older';
  const received = parseISO(receivedOnIso);
  if (!isValid(received)) return 'older';

  const d0 = startOfDay(received);
  const n0 = startOfDay(now);
  const dayDiff = differenceInCalendarDays(n0, d0);

  if (dayDiff === 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff > 1 && dayDiff < 7) return 'lastWeek';

  const startThisMonth = startOfMonth(n0);
  if (d0 >= startThisMonth) return 'thisMonth';

  const startPrevMonth = startOfMonth(subMonths(n0, 1));
  if (d0 >= startPrevMonth && d0 < startThisMonth) return 'lastMonth';

  return 'older';
}

export function isThreadStarredForPin(message: Pick<ParsedMessage, 'tags'>): boolean {
  return message.tags?.some((t) => t.name === 'STARRED') ?? false;
}
