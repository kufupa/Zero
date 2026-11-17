import { z } from 'zod';
import { htmlToPlainText } from '../../../server-pilot/src/mail/inbound-reaction-parser';
import { threadInputSchema, type ThreadInput } from './wire';

const addressSchema = z.object({ name: z.string().optional(), email: z.string() });
const messageSchema = z.object({
  id: z.string(), threadId: z.string().optional(), messageId: z.string().optional(),
  isDraft: z.boolean().optional(), direction: z.enum(['inbound', 'outbound']).optional(),
  sender: addressSchema, to: z.array(addressSchema), cc: z.array(addressSchema).nullable(),
  receivedOn: z.string(), subject: z.string(), body: z.string(), processedHtml: z.string(),
  attachments: z.array(z.unknown()).optional(),
  attachmentStatus: z.enum(['complete', 'unknown', 'has_unread']).optional(),
});
const webThreadSchema = z.object({
  id: z.string(), transportId: z.string(), conversationId: z.string(),
  linkedThreadIds: z.array(z.string()), conversationMessageCount: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
});

type WebAddress = z.infer<typeof addressSchema>;
type WebInputResult =
  | { status: 'ready'; input: ThreadInput }
  | { status: 'unavailable'; reason: string };

const unavailable = (reason: string): WebInputResult => ({ status: 'unavailable', reason });

export function webMessageBody(body: string, processedHtml: string): { text: string; html: string | null } {
  if (body === processedHtml && /<[a-z][\s\S]*>/i.test(body)) {
    return { text: htmlToPlainText(body), html: processedHtml };
  }
  return { text: body, html: null };
}

// mail.get invents a display name from the local part when no name was supplied.
function address(value: WebAddress): { name: string | null; email: string } {
  const localPart = value.email.trim().split('@')[0];
  return { name: value.name === localPart ? null : value.name ?? null, email: value.email };
}

/** Convert the live useThread payload only when the full selected conversation is available. */
export function webThreadInput({
  thread, requestedThreadId, selectedMessageId, connectionId, isDemo,
}: {
  thread: unknown;
  requestedThreadId: string;
  selectedMessageId: string;
  connectionId: string;
  isDemo: boolean;
}): WebInputResult {
  if (isDemo !== false) return unavailable('Demo mail cannot start a live Nava session. Open a live mailbox.');
  if (!requestedThreadId.trim() || !selectedMessageId.trim() || !connectionId.trim()) {
    return unavailable('Select a message in an active mailbox and reload the thread.');
  }
  const parsed = webThreadSchema.safeParse(thread);
  if (!parsed.success) return unavailable('Live thread identity or message data is missing. Reload the mailbox.');
  const data = parsed.data;
  if (data.id !== requestedThreadId || data.transportId !== connectionId || !data.conversationId.trim()) {
    return unavailable('The loaded thread does not match the selected mailbox. Reload the thread.');
  }
  if (data.conversationMessageCount !== data.messages.length || data.messages.length === 0) {
    return unavailable('The full conversation has not loaded. Reload the thread.');
  }
  const threadIds = new Set([data.id, ...data.linkedThreadIds]);
  const messageIds = new Set<string>();
  for (const message of data.messages) {
    if (!message.id.trim() || messageIds.has(message.id) || !message.threadId || !threadIds.has(message.threadId) || message.isDraft) {
      return unavailable('The conversation contains an invalid or duplicate message. Reload the thread.');
    }
    messageIds.add(message.id);
    if (!message.direction) return unavailable('Message direction is missing. Reload the thread after mailbox sync.');
    if (!message.receivedOn || Number.isNaN(Date.parse(message.receivedOn))) {
      return unavailable('A message timestamp is missing. Reload the thread after mailbox sync.');
    }
    if ([message.sender, ...message.to, ...(message.cc ?? [])].some((entry) => !entry.email.trim())) {
      return unavailable('A message address is missing. Reload the thread after mailbox sync.');
    }
  }
  if (!messageIds.has(selectedMessageId)) return unavailable('The selected message is no longer in this conversation. Select it again.');
  const result = threadInputSchema.safeParse({
    source: 'webmail', source_thread_id: data.conversationId,
    mailbox_id: connectionId, selected_message_id: selectedMessageId,
    property_code: null, mode: 'live',
    messages: data.messages.map((message) => {
      const body = webMessageBody(message.body, message.processedHtml);
      return {
        id: message.id, rfc_message_id: message.messageId ?? null, direction: message.direction,
        from: address(message.sender), to: message.to.map(address), cc: (message.cc ?? []).map(address),
        received_at: message.receivedOn, subject: message.subject,
        body_text: body.text, body_html: body.html, attachment_status: message.attachmentStatus ?? 'unknown', attachments: [],
      };
    }),
  });
  return result.success
    ? { status: 'ready', input: result.data }
    : unavailable('The conversation is missing required Nava fields. Reload the thread.');
}
