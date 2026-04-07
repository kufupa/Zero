import type { IGetThreadResponse } from '../driver/types';
import type { ParsedMessage } from '../../types';
import type { CenturionCorpusThread } from './centurion-corpus.schema';

const DEMO_CONNECTION_ID = 'demo-connection';
const INBOX_EMAIL = 'centurion@legacyhotels.com';
const INBOX_NAME = 'The Centurion — Reservations';

function escapeHtml(s: string): string {
  return s
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
  return `<p>${lines.map((l) => escapeHtml(l) || '<br />').join('</p><p>')}</p>`;
}

function toParsedMessage(
  threadId: string,
  m: CenturionCorpusThread['messages'][number],
): ParsedMessage {
  const html = toHtmlBody(m.bodyText, m.bodyIsHtml);
  return {
    id: m.id,
    connectionId: DEMO_CONNECTION_ID,
    title: m.subject,
    subject: m.subject,
    tags: [],
    sender: { name: m.from.name, email: m.from.email },
    to: m.to.map((t) => ({ name: t.name, email: t.email })),
    cc: m.cc?.map((t) => ({ name: t.name, email: t.email })) ?? null,
    bcc: null,
    tls: true,
    receivedOn: m.receivedOn,
    unread: m.unread,
    body: m.bodyText,
    processedHtml: html,
    blobUrl: '',
    decodedBody: html,
    threadId,
    isDraft: m.isDraft === true ? true : undefined,
    messageId: `<demo-${m.id}@legacyhotels.com>`,
  };
}

function syntheticDraftMessage(
  thread: CenturionCorpusThread,
  lastInbound: ParsedMessage,
): ParsedMessage {
  const reSubject = lastInbound.subject.startsWith('Re:')
    ? lastInbound.subject
    : `Re: ${lastInbound.subject}`;
  const html = toHtmlBody(thread.draft.bodyText, thread.draft.bodyIsHtml);
  return {
    id: `${thread.id}-draft`,
    connectionId: DEMO_CONNECTION_ID,
    title: reSubject,
    subject: reSubject,
    tags: [],
    sender: { name: INBOX_NAME, email: INBOX_EMAIL },
    to: [{ email: lastInbound.sender.email, name: lastInbound.sender.name }],
    cc: null,
    bcc: null,
    tls: true,
    receivedOn: lastInbound.receivedOn,
    unread: false,
    body: thread.draft.bodyText,
    processedHtml: html,
    blobUrl: '',
    decodedBody: html,
    threadId: thread.id,
    isDraft: true,
    messageId: `<draft-${thread.id}@legacyhotels.com>`,
    inReplyTo: lastInbound.messageId,
  };
}

export function centurionThreadToGetResponse(thread: CenturionCorpusThread): IGetThreadResponse {
  const nonDraftSource = thread.messages.filter((m) => !m.isDraft);
  const parsedNonDraft = nonDraftSource.map((m) => toParsedMessage(thread.id, m));

  const lastInbound = parsedNonDraft[parsedNonDraft.length - 1];
  const draftMsg =
    thread.draft.bodyText.trim().length > 0 ? syntheticDraftMessage(thread, lastInbound) : null;

  const messages: ParsedMessage[] = draftMsg ? [...parsedNonDraft, draftMsg] : [...parsedNonDraft];

  const hasUnread = messages.some((m) => m.unread && !m.isDraft);

  return {
    messages,
    latest: lastInbound,
    hasUnread,
    totalReplies: parsedNonDraft.length,
    labels: thread.labels?.length ? thread.labels : [{ id: 'INBOX', name: 'INBOX' }],
  };
}

export function centurionThreadToListRow(thread: CenturionCorpusThread): {
  id: string;
  historyId: string | null;
} {
  return { id: thread.id, historyId: null };
}
