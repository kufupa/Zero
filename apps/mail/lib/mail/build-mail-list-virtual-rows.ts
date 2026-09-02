import type { MailListThreadRow } from '@/types';
import {
  getDateBucket,
  MAIL_DATE_BUCKET_ORDER,
  type MailDateBucket,
} from './thread-date-bucket';

export type BuildMailListVirtualRowsOptions = {
  groupByDate: boolean;
};

export type MailListLinkedStubRow = NonNullable<MailListThreadRow['linkedStubs']>[number];

export type MailListVirtualRow =
  | { type: 'header'; bucket: MailDateBucket; key: string }
  | { type: 'thread'; key: string; message: MailListThreadRow; threadIndex: number }
  | {
      type: 'linked-stub';
      key: string;
      stub: MailListLinkedStubRow;
      parentThreadIndex: number;
    };

function listRowReceivedOn(message: MailListThreadRow): string | Date | undefined {
  return message.receivedOn ?? message.latestMessageAt ?? undefined;
}

function isThreadStarredForPin(message: MailListThreadRow): boolean {
  if (message.isStarred) return true;
  return message.tags?.some((tag) => tag.name === 'STARRED') ?? false;
}

export function buildMailListVirtualRows(
  threads: MailListThreadRow[],
  now: Date,
  collapsedBuckets: ReadonlySet<MailDateBucket>,
  options: BuildMailListVirtualRowsOptions,
): MailListVirtualRow[] {
  if (!options.groupByDate) {
    const rows: MailListVirtualRow[] = [];
    threads.forEach((message, threadIndex) => {
      rows.push({
        type: 'thread',
        key: `thread:${message.id}`,
        message,
        threadIndex,
      });
      for (const stub of message.linkedStubs ?? []) {
        rows.push({
          type: 'linked-stub',
          key: `linked-stub:${message.id}:${stub.threadId}`,
          stub,
          parentThreadIndex: threadIndex,
        });
      }
    });
    return rows;
  }

  const byBucket = new Map<MailDateBucket, MailListThreadRow[]>();
  for (const b of MAIL_DATE_BUCKET_ORDER) {
    byBucket.set(b, []);
  }

  for (const message of threads) {
    if (isThreadStarredForPin(message)) {
      byBucket.get('pinned')!.push(message);
    } else {
      const bucket = getDateBucket(listRowReceivedOn(message), now);
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
        const threadIndex = idToIndex.get(message.id) ?? 0;
        rows.push({
          type: 'thread',
          key: `thread:${message.id}`,
          message,
          threadIndex,
        });
        for (const stub of message.linkedStubs ?? []) {
          rows.push({
            type: 'linked-stub',
            key: `linked-stub:${message.id}:${stub.threadId}`,
            stub,
            parentThreadIndex: threadIndex,
          });
        }
      }
    }
  }

  return rows;
}
