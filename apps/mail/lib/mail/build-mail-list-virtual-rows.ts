import type { MailListThreadRow } from '@/types';
import {
  getDateBucket,
  MAIL_DATE_BUCKET_ORDER,
  type MailDateBucket,
} from './thread-date-bucket';

export type QueueSlug = 'at-risk' | 'new-bookings' | 'groups-events' | 'ops';

export type BuildMailListVirtualRowsOptions = {
  groupByDate: boolean;
  groupByQueue?: boolean;
  queueOrder?: readonly QueueSlug[];
  queueLabels?: Record<QueueSlug, string>;
  resolveQueue?: (message: MailListThreadRow) => {
    primarySlug: QueueSlug | null;
    isUrgent: boolean;
  };
};

export type MailListVirtualRow =
  | { type: 'header'; bucket: MailDateBucket; key: string }
  | { type: 'queue-header'; slug: QueueSlug; label: string; key: string }
  | { type: 'thread'; key: string; message: MailListThreadRow; threadIndex: number };

const DEFAULT_QUEUE_ORDER: readonly QueueSlug[] = [
  'at-risk',
  'new-bookings',
  'groups-events',
  'ops',
];

function listRowReceivedOn(message: MailListThreadRow): string | Date | undefined {
  return message.receivedOn ?? message.latestMessageAt ?? undefined;
}

function threadRecencyMs(message: MailListThreadRow): number {
  const at = message.latestMessageAt ?? message.receivedOn;
  if (!at) return 0;
  const t = typeof at === 'string' ? Date.parse(at) : at.getTime();
  return Number.isNaN(t) ? 0 : t;
}

function isThreadStarredForPin(message: MailListThreadRow): boolean {
  if (message.isStarred) return true;
  return message.tags?.some((tag) => tag.name === 'STARRED') ?? false;
}

function compareQueueThreads(a: MailListThreadRow, b: MailListThreadRow, resolveQueue: NonNullable<BuildMailListVirtualRowsOptions['resolveQueue']>): number {
  const qa = resolveQueue(a);
  const qb = resolveQueue(b);
  if (qa.isUrgent !== qb.isUrgent) return qa.isUrgent ? -1 : 1;
  const aStarred = isThreadStarredForPin(a);
  const bStarred = isThreadStarredForPin(b);
  if (aStarred !== bStarred) return aStarred ? -1 : 1;
  return threadRecencyMs(b) - threadRecencyMs(a);
}

function buildQueueGroupedRows(
  threads: MailListThreadRow[],
  options: BuildMailListVirtualRowsOptions,
): MailListVirtualRow[] {
  const queueOrder = options.queueOrder ?? DEFAULT_QUEUE_ORDER;
  const queueLabels = options.queueLabels ?? ({} as Record<QueueSlug, string>);
  const resolveQueue =
    options.resolveQueue ??
    (() => ({ primarySlug: null as QueueSlug | null, isUrgent: false }));

  const byQueue = new Map<QueueSlug, MailListThreadRow[]>();
  for (const slug of queueOrder) {
    byQueue.set(slug, []);
  }

  for (const message of threads) {
    const { primarySlug } = resolveQueue(message);
    const bucket = primarySlug && byQueue.has(primarySlug) ? primarySlug : 'ops';
    byQueue.get(bucket)!.push(message);
  }

  for (const list of byQueue.values()) {
    list.sort((a, b) => compareQueueThreads(a, b, resolveQueue));
  }

  const idToIndex = new Map<string, number>();
  threads.forEach((message, i) => {
    idToIndex.set(message.id, i);
  });

  const rows: MailListVirtualRow[] = [];

  for (const slug of queueOrder) {
    const label = queueLabels[slug] ?? slug;
    rows.push({ type: 'queue-header', slug, label, key: `queue-header:${slug}` });
    for (const message of byQueue.get(slug)!) {
      rows.push({
        type: 'thread',
        key: `thread:${message.id}`,
        message,
        threadIndex: idToIndex.get(message.id) ?? 0,
      });
    }
  }

  return rows;
}

export function buildMailListVirtualRows(
  threads: MailListThreadRow[],
  now: Date,
  collapsedBuckets: ReadonlySet<MailDateBucket>,
  options: BuildMailListVirtualRowsOptions,
): MailListVirtualRow[] {
  if (options.groupByQueue) {
    return buildQueueGroupedRows(threads, options);
  }

  if (!options.groupByDate) {
    return threads.map((message, threadIndex) => ({
      type: 'thread' as const,
      key: `thread:${message.id}`,
      message,
      threadIndex,
    }));
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
