/**
 * Seed a thread + inbound message so listThreads({ folder: 'inbox' }) includes it.
 * Inbox listing requires at least one inbound message per thread (mail.ts).
 */
import { mailThread, message } from '../../src/db/schema/mail.js';
import type { DB } from '../../src/db/client.js';

export type SeedInboxThreadOpts = {
  threadId: string;
  transportId: string;
  transportEmail: string;
  subject?: string;
  snippet?: string;
  threadRootId?: string;
  isRead?: boolean;
  isStarred?: boolean;
  snoozedUntil?: Date | null;
  messageId?: string;
  fromAddress?: string;
  textBody?: string;
  messageIdHeader?: string;
  references?: string[];
  isMessageRead?: boolean;
};

export async function seedInboxThread(db: DB, opts: SeedInboxThreadOpts): Promise<void> {
  const subject = opts.subject ?? `Thread ${opts.threadId}`;
  const snippet = opts.snippet ?? subject;
  const now = new Date();

  await db
    .insert(mailThread)
    .values({
      id: opts.threadId,
      transportId: opts.transportId,
      threadRootId: opts.threadRootId ?? `root-${opts.threadId}`,
      subject,
      snippet,
      isArchived: false,
      isStarred: opts.isStarred ?? false,
      isRead: opts.isRead ?? false,
      labelIds: [],
      snoozedUntil: opts.snoozedUntil ?? null,
      latestMessageAt: now,
    })
    .onConflictDoNothing({ target: mailThread.id });

  await db
    .insert(message)
    .values({
      id: opts.messageId ?? `msg-${opts.threadId}`,
      transportId: opts.transportId,
      threadId: opts.threadId,
      direction: 'inbound',
      fromAddress: opts.fromAddress ?? 'guest@example.com',
      toAddresses: [opts.transportEmail],
      ccAddresses: [],
      bccAddresses: [],
      subject,
      textBody: opts.textBody ?? snippet,
      ownerHeaderValue: opts.transportEmail,
      messageIdHeader: opts.messageIdHeader ?? `${opts.threadId}@example.com`,
      references: opts.references ?? [],
      isRead: opts.isMessageRead ?? opts.isRead ?? false,
      isStarred: false,
      receivedAt: now,
    })
    .onConflictDoNothing({ target: message.id });
}
