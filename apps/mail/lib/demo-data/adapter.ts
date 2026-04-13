import centurionThreads from './centurion-threads.json';
import { parseDemoCorpus, type DemoMessage, type DemoThread, type DemoThreadInput } from './schema';
import { normalizeDemoMessageBody } from './normalize-demo-message-body';
import { filterRemovedDemoLabels } from './label-filter';
import { getDemoDeletedDraftIds, listDemoDrafts } from '../demo/local-store';
import { parseRecipientToken, splitRecipientField } from '../demo/recipient-parsing';
import type {
  CenturionMailCategory,
  IGetThreadResponse,
  IGetThreadsResponse,
} from '../../../server/src/lib/driver/types';

const DEMO_CONNECTION_ID = 'demo-connection';
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 100;

type DemoThreadRecord = {
  thread: DemoThread;
  messages: DemoMessage[];
  latestReceivedAt: number;
  searchText: string;
};

const parsedThreads: DemoThreadRecord[] = parseDemoCorpus(centurionThreads as unknown).threads
  .map((thread) => {
    const messages = [...thread.messages].sort((a, b) => parseDate(a.receivedOn) - parseDate(b.receivedOn));
    const searchText = buildThreadSearchText(thread, messages);
    const latestReceivedAt = parseDate(getLatestThreadMessage(messages).receivedOn);
    return { thread, messages, latestReceivedAt, searchText };
  })
  .sort((a, b) => b.latestReceivedAt - a.latestReceivedAt);

const threadLookup = new Map(parsedThreads.map((entry) => [entry.thread.id, entry]));

type DemoListInput = {
  folder?: string;
  q?: string;
  cursor?: string;
  maxResults?: number;
  labelIds?: string[];
};

function toCenturionCategory(folder: DemoThread['folder']): CenturionMailCategory | undefined {
  if (
    folder === 'internal' ||
    folder === 'individual' ||
    folder === 'group' ||
    folder === 'travel-agents'
  ) {
    return folder;
  }
  return undefined;
}

/** Demo list views: inbox = all non-spam; category slugs = primary folder; urgent = flag; spam = quarantine only. */
export function threadMatchesDemoListFolder(thread: DemoThreadInput, folderSlug: string): boolean {
  switch (folderSlug) {
    case 'inbox':
      return thread.folder !== 'spam';
    case 'spam':
      return thread.folder === 'spam';
    case 'urgent':
      return thread.urgent === true;
    case 'internal':
    case 'individual':
    case 'group':
    case 'travel-agents':
      return thread.folder === folderSlug;
    default:
      return false;
  }
}

export function listDemoThreads(input: DemoListInput = {}): IGetThreadsResponse {
  const folder = (input.folder ?? 'inbox').toLowerCase();
  const cursor = normalizeCursor(input.cursor);
  const maxResults = normalizeMaxResults(input.maxResults);
  const query = input.q?.trim().toLowerCase();
  const labelIds = (input.labelIds ?? []).filter((label) => label.trim().length > 0);

  const matches = parsedThreads.filter((entry) => {
    const visibleLabels = filterRemovedDemoLabels(entry.thread.labels);

    if (!threadMatchesDemoListFolder(entry.thread, folder)) {
      return false;
    }

    if (query && !entry.searchText.includes(query)) {
      return false;
    }

    if (labelIds.length > 0 && !labelsContain(visibleLabels, labelIds)) {
      return false;
    }

    return true;
  });

  const page = matches.slice(cursor, cursor + maxResults);
  const nextPageToken = page.length + cursor < matches.length ? String(cursor + page.length) : null;

  return {
    threads: page.map((entry) => {
      const centurionCategory = toCenturionCategory(entry.thread.folder);
      return {
        id: entry.thread.id,
        historyId: null,
        ...(centurionCategory ? { centurionCategory } : {}),
      };
    }),
    nextPageToken,
  };
}

function mergeDemoStoreDraftsIntoParsedMessages(
  parsed: IGetThreadResponse['messages'][number][],
  threadId: string,
): IGetThreadResponse['messages'][number][] {
  const storeDrafts = listDemoDrafts().filter((d) => d.threadId === threadId);
  if (storeDrafts.length === 0) return parsed;

  const next = [...parsed];
  for (const d of storeDrafts) {
    const normalizedBody = normalizeDemoMessageBody({ body: d.body, bodyFormat: 'text' });
    const to = splitRecipientField(d.to)
      .map((t) => parseRecipientToken(t))
      .filter(
        (x): x is NonNullable<ReturnType<typeof parseRecipientToken>> => x !== null,
      )
      .map((x) => ({ name: x.name, email: x.email }));

    const idx = next.findIndex((m) => m.id === d.id);
    if (idx >= 0) {
      const prev = next[idx]!;
      const subj = d.subject?.trim();
      next[idx] = {
        ...prev,
        subject: subj || prev.subject,
        title: subj || prev.title,
        body: d.body,
        decodedBody: normalizedBody,
        processedHtml: normalizedBody,
        to: to.length > 0 ? to : prev.to,
      };
    }
  }
  return next;
}

export function getDemoThread(id: string): IGetThreadResponse {
  const entry = threadLookup.get(id);
  if (!entry) {
    throw new Error(`Demo thread not found: ${id}`);
  }
  const visibleLabels = filterRemovedDemoLabels(entry.thread.labels);

  let parsedMessages = entry.messages.map((message, index) =>
    mapDemoMessageToParsed(entry.thread, visibleLabels, entry.messages, message, index),
  );
  parsedMessages = mergeDemoStoreDraftsIntoParsedMessages(parsedMessages, entry.thread.id);
  const deletedIds = new Set(getDemoDeletedDraftIds());
  parsedMessages = parsedMessages.filter((message) => !deletedIds.has(message.id));
  const nonDraftMessages = parsedMessages.filter((message) => message.isDraft !== true);
  const latest = nonDraftMessages[nonDraftMessages.length - 1];

  const centurionCategory = toCenturionCategory(entry.thread.folder);

  return {
    messages: parsedMessages,
    latest,
    hasUnread: nonDraftMessages.some((message) => message.unread),
    totalReplies: nonDraftMessages.length,
    labels: visibleLabels.map((label) => ({ id: label.id, name: label.name })),
    isLatestDraft: parsedMessages[parsedMessages.length - 1]?.isDraft === true,
    ...(centurionCategory ? { centurionCategory } : {}),
  };
}

function mapDemoMessageToParsed(
  thread: DemoThread,
  threadLabels: DemoThread['labels'],
  messages: DemoMessage[],
  message: DemoMessage,
  index: number,
): IGetThreadResponse['messages'][number] {
  const messageId = `<${message.id}@demo.centurion.local>`;
  const inReplyTo = findPreviousInboundMessageId(messages, index);
  const threadTags = threadLabels.map((label) => ({ id: label.id, name: label.name, type: 'system' }));
  const isDraft = message.isDraft === true;
  const normalizedBody = normalizeDemoMessageBody({
    body: message.body,
    bodyFormat: message.bodyFormat,
  });

  return {
    id: message.id,
    connectionId: DEMO_CONNECTION_ID,
    title: message.subject,
    subject: message.subject,
    tags: threadTags,
    sender: { name: message.sender.name, email: message.sender.email },
    to: message.to.map((recipient) => ({ name: recipient.name, email: recipient.email })),
    cc: message.cc?.length ? message.cc.map((recipient) => ({ name: recipient.name, email: recipient.email })) : null,
    bcc: message.bcc?.length
      ? message.bcc.map((recipient) => ({ name: recipient.name, email: recipient.email }))
      : null,
    tls: true,
    receivedOn: message.receivedOn,
    unread: message.unread,
    body: message.body,
    processedHtml: normalizedBody,
    blobUrl: '',
    decodedBody: normalizedBody,
    threadId: thread.id,
    isDraft,
    ...(inReplyTo ? { inReplyTo } : {}),
    messageId,
  };
}

function buildThreadSearchText(thread: DemoThread, messages: DemoMessage[]): string {
  const labelText = filterRemovedDemoLabels(thread.labels)
    .map((label) => `${label.id} ${label.name}`)
    .join(' ');
  const messageText = messages
    .map((message) => {
      const recipientText = [
        ...message.to,
        ...(message.cc ?? []),
        ...(message.bcc ?? []),
      ]
        .map((recipient) => `${recipient.name ?? ''} ${recipient.email}`)
        .join(' ');

      return `${thread.folder} ${message.id} ${recipientText} ${message.sender.name ?? ''} ${message.sender.email} ${
        message.subject
      } ${message.body}`;
    })
    .join(' ');

  return `${labelText} ${messageText}`.toLowerCase();
}

function parseDate(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLatestThreadMessage(messages: DemoMessage[]): DemoMessage {
  const latestNonDraft = [...messages].findLast((message) => message.isDraft !== true);
  if (latestNonDraft) return latestNonDraft;
  return messages[messages.length - 1]!;
}

function labelsContain(threadLabels: DemoThread['labels'], targetLabels: string[]): boolean {
  return targetLabels.some((target) => {
    const normalized = target.toLowerCase();
    return threadLabels.some((label) => label.id.toLowerCase() === normalized || label.name.toLowerCase() === normalized);
  });
}

function normalizeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeMaxResults(maxResults?: number): number {
  const parsed = maxResults ?? DEFAULT_MAX_RESULTS;
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_RESULTS;
  if (parsed < 1) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(parsed), MAX_RESULTS);
}

function findPreviousInboundMessageId(messages: DemoMessage[], index: number): string | undefined {
  for (let current = index - 1; current >= 0; current -= 1) {
    const previous = messages[current];
    if (!previous) continue;
    if (previous.isDraft !== true) {
      return previous.id;
    }
  }

  return undefined;
}
