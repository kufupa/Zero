import type { ParsedMessage } from '@/types';
import {
  getDateBucket,
  isThreadStarredForPin,
  MAIL_DATE_BUCKET_ORDER,
  type MailDateBucket,
} from './thread-date-bucket';

export type MailListVirtualRow =
  | { type: 'header'; bucket: MailDateBucket; key: string }
  | { type: 'thread'; key: string; message: ParsedMessage; threadIndex: number };

export type BuildMailListVirtualRowsOptions = {
  groupByDate: boolean;
};

export function buildMailListVirtualRows(
  threads: ParsedMessage[],
  now: Date,
  collapsedBuckets: ReadonlySet<MailDateBucket>,
  options: BuildMailListVirtualRowsOptions,
): MailListVirtualRow[] {
  if (!options.groupByDate) {
    return threads.map((message, threadIndex) => ({
      type: 'thread' as const,
      key: `thread:${message.id}`,
      message,
      threadIndex,
    }));
  }

  const byBucket = new Map<MailDateBucket, ParsedMessage[]>();
  for (const b of MAIL_DATE_BUCKET_ORDER) {
    byBucket.set(b, []);
  }

  for (const message of threads) {
    if (isThreadStarredForPin(message)) {
      byBucket.get('pinned')!.push(message);
    } else {
      const bucket = typeof message.receivedOn === 'string' ? getDateBucket(message.receivedOn, now) : 'older';
      byBucket.get(bucket)!.push(message);
    }
  }

  const idToIndex = new Map<string, number>();
  threads.forEach((message, i) => {
    idToIndex.set(message.id, i);
  });

  const rows: MailListVirtualRow[] = [];

  for (const bucket of MAIL_DATE_BUCKET_ORDER) {
    const list = byBucket.get(bucket)!;
    if (list.length === 0) continue;

    rows.push({ type: 'header', bucket, key: `header:${bucket}` });
    if (!collapsedBuckets.has(bucket)) {
      for (const message of list) {
        rows.push({
          type: 'thread',
          key: `thread:${message.id}`,
          message,
          threadIndex: idToIndex.get(message.id) ?? 0,
        });
      }
    }
  }

  return rows;
}
