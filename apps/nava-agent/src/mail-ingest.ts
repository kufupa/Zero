import { z } from 'zod';
import { threadInput, type ThreadInput } from './schema.js';

const id = z.string().min(1).refine(value => value.trim().length > 0);
const person = z.object({ email: z.string().min(1), name: z.string().nullish() });
const attachment = z.object({
  attachmentId: id, filename: z.string(), mimeType: z.string(), size: z.number().int().nonnegative(),
});
const hostMessage = z.object({
  id, threadId: id, messageId: z.string().nullish(), direction: z.enum(['inbound', 'outbound']),
  sender: person, to: z.array(person), cc: z.array(person).nullish(), receivedOn: z.string().datetime({ offset: true }),
  subject: z.string(), body: z.string(), processedHtml: z.string().nullish(), attachments: z.array(attachment),
});
const hostThread = z.object({ id, transportId: id, messages: z.array(hostMessage) });

type Email = ThreadInput['messages'][number];

const preStayFields = new Set([
  'address', 'postal code', 'city', 'country', 'nationality', 'passport', 'date of birth',
  'mobile', 'email', 'arrival time', 'transfer', 'lifestyle member', 'email marketing opt-in',
]);

function isRoutinePreStay(body: string): boolean {
  const [guest, arrival, departure, room, confirmation, ...fields] = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!guest || !/^Arrival\s*:\s*\d/i.test(arrival ?? '') || !/^Departure\s*:\s*\d/i.test(departure ?? '')
    || !/^Room Type\s*:\s*\w/i.test(room ?? '') || !/^Confirmation No\s*:\s*\w/i.test(confirmation ?? '')
    || !fields.length) return false;
  return fields.every(line => {
    const field = /^([^>]+?)\s*-->\s*(.*)$/.exec(line);
    if (!field) return false;
    const label = field[1].trim().toLowerCase();
    return preStayFields.has(label) || field[2].trim() === '';
  });
}

export function mailPrefilterRule(message: Email): string | null {
  if (message.direction !== 'inbound') return null;
  const email = message.from.email.trim().toLowerCase();
  const host = /^[^@\s]+@([a-z0-9.-]+)$/.exec(email)?.[1];
  if (!host) return null;
  const from = (domain: string) => host === domain || host.endsWith('.' + domain);
  const subject = message.subject.trim();
  if (from('tiket.com')) return 'owner_tiket';
  if (['ratetiger.com', 'erevmax.com', 'erevmax.co.uk', 'erevmax.net'].some(from)) {
    return /\btbo\b/i.test(subject) ? null : 'owner_ratetiger';
  }
  if (from('hospitality.cloud')) return 'owner_hospitality_cloud';
  if (from('profitroom.com')) return /\bdefault contact form\b/i.test(subject) ? null : 'owner_profitroom';
  if (from('booking.com') && /^(?:action needed:\s*your email\b|booking\.com\s*-\s*modified booking\b|(?:your )?guest needs something\b)/i.test(subject)) {
    return 'owner_booking_notice';
  }
  if (from('legacyhotels.co.za') && /^pre[ -]stay\s*:\s*property\b/i.test(subject)
    && message.attachments.length === 0 && isRoutinePreStay(message.body_text)) return 'owner_prestay_form_only';
  if (from('grfeedback-b.com') && /\b(?:daily|weekly|monthly) summary for\b/i.test(subject)) return 'corpus_guest_feedback_digest';
  return null;
}

/** Dedupe identical deliveries; never choose between conflicting versions of the same source message. */
export function uniqueMessages(messages: Email[]): Email[] {
  const byId = new Map<string, Email>();
  for (const message of messages) {
    const previous = byId.get(message.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(message)) throw new Error('MESSAGE_CONFLICT');
    if (!previous) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at) || a.id.localeCompare(b.id));
}

/** Normalize the mailbox-scoped result of mail.get({ id, mergeLinked: false }). */
export function normalizeWebmailThread(args: {
  thread: unknown; mailboxId: string; threadId: string; selectedMessageId: string; propertyCode: string | null;
}): ThreadInput {
  const mailboxId = id.parse(args.mailboxId);
  const threadId = id.parse(args.threadId);
  const selectedMessageId = id.parse(args.selectedMessageId);
  const thread = hostThread.parse(args.thread);
  if (thread.id !== threadId || thread.transportId !== mailboxId || thread.messages.some(m => m.threadId !== threadId)) {
    throw new Error('HOST_THREAD_SCOPE_MISMATCH');
  }
  const messages = uniqueMessages(thread.messages.map(m => ({
    id: m.id, rfc_message_id: m.messageId ?? null, direction: m.direction,
    from: { name: m.sender.name ?? null, email: m.sender.email },
    to: m.to.map(p => ({ name: p.name ?? null, email: p.email })),
    cc: (m.cc ?? []).map(p => ({ name: p.name ?? null, email: p.email })),
    received_at: m.receivedOn, subject: m.subject, body_text: m.body, body_html: m.processedHtml ?? null,
    attachments: m.attachments.map(a => ({
      id: a.attachmentId, name: a.filename, mime_type: a.mimeType, size: a.size,
      handle: JSON.stringify({ source: 'webmail', mailbox_id: mailboxId, message_id: m.id, attachment_id: a.attachmentId }),
      extracted_text: null,
    })),
  })));
  if (messages.find(m => m.id === selectedMessageId)?.direction !== 'inbound') throw new Error('SELECTED_INBOUND_MISSING');
  return threadInput.parse({ source: 'webmail', source_thread_id: threadId, mailbox_id: mailboxId,
    selected_message_id: selectedMessageId, property_code: args.propertyCode, mode: 'live', messages });
}

/** Host provides its already-authorized, single-thread reader; no old processing pipeline is invoked. */
export async function readWebmailThread(args: {
  mailboxId: string; threadId: string; selectedMessageId: string; propertyCode: string | null;
  readThread: (input: { id: string; mergeLinked: false }) => Promise<unknown>;
}): Promise<ThreadInput> {
  const thread = await args.readThread({ id: id.parse(args.threadId), mergeLinked: false });
  return normalizeWebmailThread({ ...args, thread });
}
