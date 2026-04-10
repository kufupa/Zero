import centurionThreads from './centurion-threads.json';
import { parseDemoCorpus, type DemoMessage, type DemoThread } from './schema';
import { filterRemovedDemoLabels } from './label-filter';
import { threadMatchesWorkQueue, type WorkQueueSlug } from './work-queue';
import type { IGetThreadResponse, IGetThreadsResponse } from '../../../server/src/lib/driver/types';

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
  workQueue?: WorkQueueSlug;
};

export function listDemoThreads(input: DemoListInput = {}): IGetThreadsResponse {
  const folder = (input.folder ?? 'inbox').toLowerCase();
  const cursor = normalizeCursor(input.cursor);
  const maxResults = normalizeMaxResults(input.maxResults);
  const query = input.q?.trim().toLowerCase();
  const labelIds = (input.labelIds ?? []).filter((label) => label.trim().length > 0);

  const matches = parsedThreads.filter((entry) => {
    const visibleLabels = filterRemovedDemoLabels(entry.thread.labels);

    if (folder !== 'inbox' && entry.thread.folder && entry.thread.folder !== folder) {
      if (!labelsContain(visibleLabels, [folder])) {
        return false;
      }
    }

    if (query && !entry.searchText.includes(query)) {
      return false;
    }

    if (input.workQueue && !threadMatchesWorkQueue(entry.thread, input.workQueue)) {
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
    threads: page.map((entry) => ({
      id: entry.thread.id,
      historyId: null,
    })),
    nextPageToken,
  };
}

export function getDemoThread(id: string): IGetThreadResponse {
  const entry = threadLookup.get(id);
  if (!entry) {
    throw new Error(`Demo thread not found: ${id}`);
  }
  const visibleLabels = filterRemovedDemoLabels(entry.thread.labels);

  const parsedMessages = entry.messages.map((message, index) =>
    mapDemoMessageToParsed(entry.thread, visibleLabels, entry.messages, message, index),
  );
  const nonDraftMessages = parsedMessages.filter((message) => message.isDraft !== true);
  const latest = nonDraftMessages[nonDraftMessages.length - 1];

  return {
    messages: parsedMessages,
    latest,
    hasUnread: nonDraftMessages.some((message) => message.unread),
    totalReplies: nonDraftMessages.length,
    labels: visibleLabels.map((label) => ({ id: label.id, name: label.name })),
    isLatestDraft: parsedMessages[parsedMessages.length - 1]?.isDraft === true,
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
    processedHtml: toHtml(message.body),
    blobUrl: '',
    decodedBody: toHtml(message.body),
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

      return `${thread.demoCategory} ${message.id} ${recipientText} ${message.sender.name ?? ''} ${message.sender.email} ${
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

function toHtml(input: string): string {
  const safe = input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return safe
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p>${line}</p>`)
    .join('');
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
