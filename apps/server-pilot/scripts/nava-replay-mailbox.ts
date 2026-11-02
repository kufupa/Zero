/** Current mailbox evidence for replay. Historical case data never establishes sync. */
import type { APIRequestContext } from 'playwright';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export type CurrentReplayEmail = {
  entryId: string;
  storeId: string;
  folderEntryId: string;
  subject: string;
  senderEmail: string;
  senderName: string;
  to?: string;
  cc?: string;
  receivedTime: string;
  bodyText: string;
  bodyHtml: string;
  internetMessageId: string;
  /** Current attachment metadata only; not proof that file bytes were read. */
  sourceAttachment?: { id: string; filename: string; mimeType: string; sizeBytes: number };
};

/** Select the exact inbound stored row, never the most recent row in the thread. */
export function selectedReplayEmail(input: {
  thread: unknown;
  threadId: string;
  messageId: string;
  transportId: string;
  fakeStoreId: string;
}): CurrentReplayEmail | null {
  const thread = record(input.thread);
  if (!input.threadId || !input.messageId || !input.transportId || !input.fakeStoreId ||
    !thread || thread.id !== input.threadId || thread.transportId !== input.transportId ||
    !Array.isArray(thread.messages)) return null;
  const matches = thread.messages.map(record).filter((message) => message?.id === input.messageId);
  if (matches.length !== 1) return null;
  const message = matches[0]!;
  const sender = record(message.sender);
  const internetMessageId = text(message.messageId).trim();
  const senderEmail = text(sender?.email).trim();
  const addresses = (value: unknown) => Array.isArray(value)
    ? value.map((item) => text(record(item)?.email).trim()).filter(Boolean).join('; ') : '';
  const to = addresses(message.to), cc = addresses(message.cc);
  if (message.threadId !== input.threadId || message.direction !== 'inbound' || message.isDraft !== false ||
    !internetMessageId || !senderEmail || typeof message.subject !== 'string' ||
    typeof message.receivedOn !== 'string' || typeof message.body !== 'string' ||
    typeof message.processedHtml !== 'string') return null;
  return {
    entryId: input.messageId,
    storeId: input.fakeStoreId,
    folderEntryId: 'fake-inbox',
    subject: message.subject,
    senderEmail,
    senderName: text(sender?.name).trim() || senderEmail,
    ...(to ? { to } : {}),
    ...(cc ? { cc } : {}),
    receivedTime: message.receivedOn,
    bodyText: message.body,
    bodyHtml: message.processedHtml,
    internetMessageId,
  };
}

/** Use the authenticated application read; do not connect to its database directly. */
export async function loadReplayEmail(input: {
  request: APIRequestContext;
  origin: string;
  transportId: string;
  threadId: string;
  messageId: string;
  fakeStoreId: string;
  requireVoucherAttachment?: boolean;
}): Promise<CurrentReplayEmail | null> {
  let origin: URL;
  try { origin = new URL(input.origin); } catch { return null; }
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.origin !== input.origin ||
    origin.username || origin.password || !input.transportId || !input.threadId || !input.messageId) return null;
  try {
    const response = await input.request.post(`${origin.origin}/api/trpc/mail.get?batch=1`, {
      headers: { 'x-zero-active-transport': input.transportId, 'content-type': 'application/json' },
      data: { 0: { json: { id: input.threadId } } },
      timeout: 15_000,
      maxRedirects: 0,
    });
    if (!response.ok()) return null;
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || payload.length !== 1) return null;
    const item = record(payload[0]);
    const result = record(item?.result);
    const data = record(result?.data);
    const email = selectedReplayEmail({ ...input, thread: data?.json });
    if (!email) return null;
    // This app read refuses duplicate Message-IDs across the mailbox and returns the exact row.
    const sourceResponse = await input.request.post(`${origin.origin}/api/trpc/workstation.staffQuoteSource?batch=1`, {
      headers: { 'x-zero-active-transport': input.transportId, 'content-type': 'application/json' },
      data: { 0: { json: { internetMessageId: email.internetMessageId } } },
      timeout: 15_000,
      maxRedirects: 0,
    });
    if (!sourceResponse.ok()) return null;
    const sourcePayload: unknown = await sourceResponse.json();
    if (!Array.isArray(sourcePayload) || sourcePayload.length !== 1) return null;
    const sourceItem = record(sourcePayload[0]);
    const sourceResult = record(sourceItem?.result);
    const sourceData = record(sourceResult?.data);
    const source = record(sourceData?.json);
    if (source?.status !== 'ready' || source.messageId !== input.messageId || source.threadId !== input.threadId) return null;
    if (!input.requireVoucherAttachment) return email;
    const attachment = await loadReplayVoucherAttachment({ ...input, internetMessageId: email.internetMessageId });
    return attachment ? { ...email, sourceAttachment: attachment } : null;
  } catch {
    return null;
  }
}


/** Current selected-message file metadata only. It is not proof of stored bytes or HMS filing. */
export async function loadReplayVoucherAttachment(input: {
  request: APIRequestContext;
  origin: string;
  transportId: string;
  threadId: string;
  messageId: string;
  internetMessageId: string;
}): Promise<NonNullable<CurrentReplayEmail['sourceAttachment']> | null> {
  let origin: URL;
  try { origin = new URL(input.origin); } catch { return null; }
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.origin !== input.origin ||
    origin.username || origin.password || !input.transportId || !input.threadId || !input.messageId || !input.internetMessageId) return null;
  try {
    const response = await input.request.post(`${origin.origin}/api/trpc/quoteWorkflow.voucherFind?batch=1`, {
      headers: { 'x-zero-active-transport': input.transportId, 'content-type': 'application/json' },
      data: { 0: { json: { internetMessageId: input.internetMessageId } } },
      timeout: 20_000,
      maxRedirects: 0,
    });
    if (!response.ok()) return null;
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || payload.length !== 1) return null;
    const item = record(payload[0]);
    const result = record(item?.result);
    const data = record(result?.data);
    const voucher = record(data?.json);
    const file = record(voucher?.file);
    if (voucher?.status !== 'voucher' || voucher.messageId !== input.messageId || voucher.threadId !== input.threadId || !file ||
      !text(file.id).trim() || !text(file.filename).trim() || !text(file.mimeType).trim() ||
      typeof file.sizeBytes !== 'number' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) return null;
    return { id: text(file.id), filename: text(file.filename), mimeType: text(file.mimeType), sizeBytes: file.sizeBytes };
  } catch {
    return null;
  }
}
