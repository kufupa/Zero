import demoCorpus from './centurion-threads.json' with { type: 'json' };
import type { IGetThreadResponse, IGetThreadsResponse } from '../../server/src/lib/driver/types';
import { CenturionCorpusFileSchema, type CenturionCorpusThread } from './schema';

function corpusThreadHasUnread(thread: CenturionCorpusThread): boolean {
  return thread.messages.some((message) => message.unread && message.isDraft !== true);
}

function labelNames(thread: CenturionCorpusThread): string[] {
  return (thread.labels ?? []).map((l) => l.name.toUpperCase());
}

/** Interprets Gmail-style category strings from the views dropdown (see use-categories). */
function threadSatisfiesLabelId(thread: CenturionCorpusThread, labelId: string): boolean {
  const trimmed = labelId.trim();
  if (!trimmed) return true;
  const s = trimmed.toLowerCase();

  if (s.includes('is:unread') || trimmed === 'UNREAD') {
    return corpusThreadHasUnread(thread);
  }
  if (s.includes('is:important')) {
    return labelNames(thread).includes('IMPORTANT');
  }
  if (s.includes('is:personal')) {
    return labelNames(thread).includes('PERSONAL');
  }
  if (s.includes('is:promotions')) {
    return labelNames(thread).includes('PROMOTIONS');
  }
  if (s.includes('is:updates')) {
    return labelNames(thread).includes('UPDATES');
  }
  // "All mail" / inbox composite queries — demo corpus is inbox, non-draft
  if (s.includes('is:inbox') || (s.includes('not is:draft') && s.includes('inbox'))) {
    return true;
  }
  return true;
}

const DEMO_CONNECTION_ID = 'demo-connection';
const INBOX_EMAIL = 'centurion@legacyhotels.com';
const INBOX_NAME = 'The Centurion — Reservations';

type ParsedCorpus = ReturnType<typeof CenturionCorpusFileSchema.parse>;

let cachedCorpus: ParsedCorpus | null = null;

function loadCorpus(): ParsedCorpus {
  if (!cachedCorpus) {
    cachedCorpus = CenturionCorpusFileSchema.parse(demoCorpus);
  }
  return cachedCorpus;
}

function threadLatestTs(thread: CenturionCorpusThread): number {
  return Math.max(...thread.messages.map((message) => new Date(message.receivedOn).getTime()));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toHtmlBody(text: string, isHtml: boolean): string {
  if (isHtml) return text;
  const trimmed = text.trim();
  if (!trimmed) return '<p></p>';
  const lines = trimmed.split('\n');
  return `<p>${lines.map((line) => escapeHtml(line) || '<br />').join('</p><p>')}</p>`;
}

function toParsedMessage(threadId: string, message: CenturionCorpusThread['messages'][number]): {
  id: string;
  connectionId: string;
  title: string;
  subject: string;
  tags: { id: string; name: string; type: string }[];
  sender: { name?: string; email: string };
  to: { name?: string; email: string }[];
  cc: { name?: string; email: string }[] | null;
  bcc: { name?: string; email: string }[] | null;
  tls: true;
  receivedOn: string;
  unread: boolean;
  body: string;
  processedHtml: string;
  blobUrl: string;
  decodedBody: string;
  threadId: string;
  isDraft?: true;
  messageId: string;
  inReplyTo?: string;
  references?: string;
} {
  const html = toHtmlBody(message.bodyText, message.bodyIsHtml);
  return {
    id: message.id,
    connectionId: DEMO_CONNECTION_ID,
    title: message.subject,
    subject: message.subject,
    tags: [],
    sender: { name: message.from.name, email: message.from.email },
    to: message.to.map((person) => ({ name: person.name, email: person.email })),
    cc: message.cc?.map((person) => ({ name: person.name, email: person.email })) ?? null,
    bcc: null,
    tls: true,
    receivedOn: message.receivedOn,
    unread: message.unread,
    body: message.bodyText,
    processedHtml: html,
    blobUrl: '',
    decodedBody: html,
    threadId,
    isDraft: message.isDraft === true ? true : undefined,
    messageId: `<demo-${message.id}@legacyhotels.com>`,
  };
}

function syntheticDraftMessage(
  thread: CenturionCorpusThread,
  lastInbound: ReturnType<typeof toParsedMessage>,
): ReturnType<typeof toParsedMessage> {
  const replySubject = lastInbound.subject.startsWith('Re:')
    ? lastInbound.subject
    : `Re: ${lastInbound.subject}`;
  const html = toHtmlBody(thread.draft.bodyText, thread.draft.bodyIsHtml);
  const references = [lastInbound.references, lastInbound.messageId].filter(Boolean).join(' ');
  return {
    ...lastInbound,
    id: `${thread.id}-draft`,
    title: replySubject,
    subject: replySubject,
    sender: { name: INBOX_NAME, email: INBOX_EMAIL },
    to: [{ email: lastInbound.sender.email, name: lastInbound.sender.name }],
    cc: null,
    bcc: null,
    receivedOn: lastInbound.receivedOn,
    unread: false,
    body: thread.draft.bodyText,
    processedHtml: html,
    decodedBody: html,
    threadId: thread.id,
    inReplyTo: lastInbound.messageId,
    references,
    isDraft: true,
    messageId: `<draft-${thread.id}@legacyhotels.com>`,
    connectionId: DEMO_CONNECTION_ID,
    tags: [],
  };
}

function centurionThreadToGetResponse(thread: CenturionCorpusThread): IGetThreadResponse {
  const inboundMessages = thread.messages.filter((message) => !message.isDraft);
  const parsedInbound = inboundMessages.map((message) => toParsedMessage(thread.id, message));
  const latest = parsedInbound[parsedInbound.length - 1];
  const draftMessage =
    thread.draft.bodyText.trim().length > 0 ? syntheticDraftMessage(thread, latest) : null;
  const messages = draftMessage ? [...parsedInbound, draftMessage] : [...parsedInbound];
  messages.forEach((msg, idx) => {
    if (!msg.decodedBody) {
      console.error(`[centurionThreadToGetResponse] Message ${idx} missing decodedBody!`);
    }
  });
  const hasUnread = messages.some((message) => message.unread && message.isDraft !== true);

  return {
    messages,
    latest,
    hasUnread,
    totalReplies: parsedInbound.length,
    labels: thread.labels?.length ? thread.labels : [{ id: 'INBOX', name: 'INBOX' }],
  };
}

export function listDemoThreads({
  folder = 'inbox',
  q = '',
  cursor = '',
  maxResults = 50,
  labelIds = [],
}: {
  folder?: string;
  q?: string;
  cursor?: string;
  maxResults?: number;
  labelIds?: string[];
}): IGetThreadsResponse {
  if (folder !== 'inbox') return { threads: [], nextPageToken: null };

  const normalizedQuery = q.trim().toLowerCase();
  const sortedThreads = [...loadCorpus().threads].sort(
    (first, second) => threadLatestTs(second) - threadLatestTs(first),
  );

  const activeLabelIds = labelIds ?? [];

  const rows = sortedThreads
    .filter((corpusThread) => {
      if (activeLabelIds.length > 0) {
        const matchesAll = activeLabelIds.every((id) => threadSatisfiesLabelId(corpusThread, id));
        if (!matchesAll) return false;
      }
      if (!normalizedQuery) return true;
      const inbound = corpusThread.messages.filter((m) => m.isDraft !== true);
      const latest = inbound[inbound.length - 1];
      if (!latest) return false;
      const searchTarget =
        `${latest.subject} ${latest.from.email} ${latest.bodyText}`.toLowerCase();
      return searchTarget.includes(normalizedQuery);
    })
    .map((thread) => ({ id: thread.id, historyId: null as string | null }));

  const start = Number.parseInt(cursor, 10);
  const offset = Number.isNaN(start) ? 0 : Math.max(0, start);
  const end = offset + maxResults;
  const sliced = rows.slice(offset, end);
  const nextPageToken = end < rows.length ? String(end) : null;

  return {
    threads: sliced,
    nextPageToken,
  };
}

export function getDemoThread(id: string): IGetThreadResponse {
  const thread = loadCorpus().threads.find((thread) => thread.id === id);
  if (!thread) {
    console.error(`[getDemoThread] Thread not found: ${id}`);
    console.error(
      `[getDemoThread] Available thread IDs:`,
      loadCorpus().threads.map((mockThread) => mockThread.id),
    );
    throw new Error(`Demo thread not found: ${id}`);
  }
  const result = centurionThreadToGetResponse(thread);

  console.log(`[getDemoThread] Thread ID: ${id}`);
  console.log(`[getDemoThread] Latest body:`, result.latest?.body);
  console.log(`[getDemoThread] Latest decodedBody:`, result.latest?.decodedBody);
  console.log(`[getDemoThread] Messages count:`, result.messages.length);

  return result;
}
