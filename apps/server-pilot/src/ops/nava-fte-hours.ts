/**
 * First-response latency from a connected-mailbox markdown dump.
 *
 *  dump lines
 *    ├─ inFence? skip
 *    ├─ ## Message N:  start record
 *    ├─ **Message ID** / **Thread ID** / **Direction** / **Received|Sent|Created**
 *    └─ compute per threadKey
 */

export type NavaHoursMessage = {
  messageId: string;
  threadKey: string;
  direction: 'inbound' | 'outbound';
  timestamp: Date | null;
};

export type NavaHoursStats = {
  asOf: string;
  threadCount: number;
  threadsWithOutbound: number;
  inboundOnlyThreads: number;
  nEligibleFirstResponse: number;
  medianFirstResponseMinutes: number | null;
  p90FirstResponseMinutes: number | null;
  droppedNegativeOrMissing: number;
  caveat: string;
};

export const NAVA_HOURS_CAVEAT =
  'Inbound-only is a retained-outbound gap, not proof of no reply elsewhere.';

type DraftMessage = {
  messageId: string | null;
  threadIdRaw: string | null;
  unthreaded: boolean;
  direction: string | null;
  received: string;
  sent: string;
  created: string;
};

const MESSAGE_HEAD = /^## Message \d+:/;
const FIELD_MESSAGE_ID = /^- \*\*Message ID:\*\* `([^`]*)`\s*$/;
const FIELD_THREAD_ID = /^- \*\*Thread ID:\*\* (?:`([^`]*)`|\(unthreaded\))\s*$/;
const FIELD_DIRECTION = /^- \*\*Direction:\*\* (.+)$/;
const FIELD_RECEIVED = /^- \*\*Received:\*\* (.*)$/;
const FIELD_SENT = /^- \*\*Sent:\*\* (.*)$/;
const FIELD_CREATED = /^- \*\*Created:\*\* (.*)$/;
const SNAPSHOT_AS_OF = /^- Snapshot as of:\s*(.+)$/m;

function emptyDraft(): DraftMessage {
  return {
    messageId: null,
    threadIdRaw: null,
    unthreaded: false,
    direction: null,
    received: '',
    sent: '',
    created: '',
  };
}

function isFenceOpen(trimmed: string): boolean {
  return trimmed === '```text' || trimmed === '```html';
}

function isFenceClose(trimmed: string): boolean {
  return trimmed === '```';
}

function parseIso(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function finalizeDraft(draft: DraftMessage): NavaHoursMessage | null {
  if (!draft.messageId) return null;
  const direction = (draft.direction ?? '').trim().toLowerCase();
  if (direction !== 'inbound' && direction !== 'outbound') return null;
  const timestamp =
    direction === 'inbound'
      ? parseIso(draft.received) ?? parseIso(draft.created)
      : parseIso(draft.sent) ?? parseIso(draft.created);
  const threadKey = draft.unthreaded
    ? `unthreaded:${draft.messageId}`
    : draft.threadIdRaw && draft.threadIdRaw.trim()
      ? draft.threadIdRaw.trim()
      : `unthreaded:${draft.messageId}`;
  return {
    messageId: draft.messageId,
    threadKey,
    direction,
    timestamp,
  };
}

export function parseAsOfFromDump(markdown: string): string | null {
  const match = markdown.match(SNAPSHOT_AS_OF);
  const value = match?.[1]?.trim();
  return value || null;
}

export function parseConnectedMailboxDump(markdown: string): NavaHoursMessage[] {
  const messages: NavaHoursMessage[] = [];
  let inFence = false;
  let draft: DraftMessage | null = null;

  const flush = () => {
    if (!draft) return;
    const parsed = finalizeDraft(draft);
    if (parsed) messages.push(parsed);
    draft = null;
  };

  for (const line of markdown.split(/\n/)) {
    const trimmed = line.trim();
    if (!inFence && isFenceOpen(trimmed)) {
      inFence = true;
      continue;
    }
    if (inFence) {
      if (isFenceClose(trimmed)) inFence = false;
      continue;
    }
    if (MESSAGE_HEAD.test(trimmed)) {
      flush();
      draft = emptyDraft();
      continue;
    }
    if (!draft) continue;

    const messageId = line.match(FIELD_MESSAGE_ID);
    if (messageId) {
      draft.messageId = messageId[1] ?? null;
      continue;
    }
    const threadId = line.match(FIELD_THREAD_ID);
    if (threadId) {
      if (threadId[1]) {
        draft.threadIdRaw = threadId[1];
        draft.unthreaded = false;
      } else {
        draft.unthreaded = true;
        draft.threadIdRaw = null;
      }
      continue;
    }
    const direction = line.match(FIELD_DIRECTION);
    if (direction) {
      draft.direction = direction[1] ?? null;
      continue;
    }
    const received = line.match(FIELD_RECEIVED);
    if (received) {
      draft.received = received[1] ?? '';
      continue;
    }
    const sent = line.match(FIELD_SENT);
    if (sent) {
      draft.sent = sent[1] ?? '';
      continue;
    }
    const created = line.match(FIELD_CREATED);
    if (created) {
      draft.created = created[1] ?? '';
    }
  }
  flush();
  return messages;
}

function medianSorted(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[mid] ?? null;
  const left = values[mid - 1];
  const right = values[mid];
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
}

function p90NearestRank(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const rank = Math.round(0.9 * values.length);
  const index = Math.min(values.length - 1, Math.max(0, rank - 1));
  return values[index] ?? null;
}

export function computeNavaHoursStats(
  messages: readonly NavaHoursMessage[],
  asOf: string,
): NavaHoursStats {
  const byThread = new Map<
    string,
    { inbound: Date[]; outbound: Date[]; inboundCount: number; outboundCount: number }
  >();

  for (const message of messages) {
    let bucket = byThread.get(message.threadKey);
    if (!bucket) {
      bucket = { inbound: [], outbound: [], inboundCount: 0, outboundCount: 0 };
      byThread.set(message.threadKey, bucket);
    }
    if (message.direction === 'inbound') bucket.inboundCount += 1;
    if (message.direction === 'outbound') bucket.outboundCount += 1;
    if (message.timestamp) {
      if (message.direction === 'inbound') bucket.inbound.push(message.timestamp);
      else bucket.outbound.push(message.timestamp);
    }
  }

  const latencies: number[] = [];
  let droppedNegativeOrMissing = 0;
  let threadsWithOutbound = 0;
  let inboundOnlyThreads = 0;

  for (const bucket of byThread.values()) {
    if (bucket.outboundCount > 0) threadsWithOutbound += 1;
    if (bucket.inboundCount > 0 && bucket.outboundCount === 0) inboundOnlyThreads += 1;

    if (bucket.inboundCount > 0 && bucket.outboundCount > 0) {
      if (bucket.inbound.length === 0 || bucket.outbound.length === 0) {
        droppedNegativeOrMissing += 1;
        continue;
      }
      const minInbound = Math.min(...bucket.inbound.map((date) => date.getTime()));
      const minOutbound = Math.min(...bucket.outbound.map((date) => date.getTime()));
      const minutes = (minOutbound - minInbound) / 60_000;
      if (minutes < 0) droppedNegativeOrMissing += 1;
      else latencies.push(minutes);
    }
  }

  latencies.sort((left, right) => left - right);

  return {
    asOf,
    threadCount: byThread.size,
    threadsWithOutbound,
    inboundOnlyThreads,
    nEligibleFirstResponse: latencies.length,
    medianFirstResponseMinutes: medianSorted(latencies),
    p90FirstResponseMinutes: p90NearestRank(latencies),
    droppedNegativeOrMissing,
    caveat: NAVA_HOURS_CAVEAT,
  };
}
